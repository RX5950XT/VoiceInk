'use strict'

/**
 * 遞迴加總資料夾大小（Main Process）。
 *
 * 不跟著 symlink／junction 走；同一時間只算一個，新請求會取消舊的。
 * 路徑過 `paths.resolveExisting`，讀檔用 `raw-fs`。
 *
 * 呼叫端給 `exe`（voiceink-probe.exe）就走原生版 `dir-size`（native/voiceink-probe/src/dirsize.rs）：
 * Windows 列目錄本身就帶大小，不必每個檔案 lstat 一次。實測 node_modules 1.6 萬檔 2.6s → 0.2s，
 * `C:\Program Files` JS 8 秒逾時只算到 4.5 萬檔 → 原生 3.5 秒算完 21.5 萬檔。規則跟這裡的 `walk` 一樣。
 */

const { spawn } = require('child_process')
const fs = require('../raw-fs')
const fsp = require('../raw-fs').promises
const path = require('path')
const paths = require('./paths')

/** 超過就停：約等於一個中型 node_modules，再大的只報「至少」。 */
const MAX_FILES = 50_000
/** 原生版的上限：實際上由 MAX_MS 決定停在哪 */
const NATIVE_MAX_FILES = 10_000_000
/** 32 層已超過一般專案；再深多半是循環或異常巢狀。 */
const MAX_DEPTH = 32
/** 詳情面板不該空轉十幾秒；SSD 上 5 萬筆約 1–2 秒，8 秒是 HDD／網路的上限。 */
const MAX_MS = 8_000
const PROGRESS_MS = 200
const YIELD_EVERY = 32

/** @type {{ token: string, cancelled: boolean } | null} */
let current = null

/**
 * @param {unknown} raw
 * @returns {string}
 */
function sanitizeToken(raw) {
  const text = String(raw || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)
  return text || 'sz'
}

/**
 * @param {unknown} raw
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 */
function clamp(raw, fallback, min, max) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

function pause() {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * @param {{
 *   path: string,
 *   job: { token: string, cancelled: boolean },
 *   bytes: number,
 *   files: number,
 *   dirs: number,
 *   incomplete: boolean,
 *   reason: string
 * }} state
 */
function snapshot(state) {
  const cancelled = Boolean(state.job.cancelled)
  return {
    path: state.path,
    token: state.job.token,
    bytes: state.bytes,
    files: state.files,
    dirs: state.dirs,
    incomplete: Boolean(state.incomplete) || cancelled,
    cancelled,
    reason: cancelled ? (state.reason || 'cancel') : (state.reason || '')
  }
}

/**
 * @param {any} state
 * @param {boolean} done
 */
function emitProgress(state, done) {
  if (typeof state.onProgress !== 'function') return
  const now = Date.now()
  if (!done && now - state.lastEmit < PROGRESS_MS) return
  state.lastEmit = now
  state.onProgress({ ...snapshot(state), done: Boolean(done) })
}

function markIncomplete(state, reason) {
  state.incomplete = true
  if (!state.reason) state.reason = reason
}

/**
 * @param {any} state
 * @param {number} depth
 * @returns {boolean}
 */
function hitLimit(state, depth) {
  if (state.job.cancelled) {
    state.incomplete = true
    state.reason = 'cancel'
    return true
  }
  if (Date.now() - state.started > state.maxMs) {
    state.incomplete = true
    state.reason = 'time'
    return true
  }
  if (depth > state.maxDepth) {
    state.incomplete = true
    state.reason = 'depth'
    return true
  }
  if (state.files >= state.maxFiles) {
    state.incomplete = true
    state.reason = 'files'
    return true
  }
  return false
}

/**
 * @param {string} full
 * @param {number} depth
 * @param {any} state
 */
async function walk(full, depth, state) {
  if (hitLimit(state, depth)) return
  let entries
  try {
    entries = await fsp.readdir(full, { withFileTypes: true })
  } catch {
    if (depth === 0) throw paths.fail('READ_FAILED', '沒有權限讀這個資料夾')
    markIncomplete(state, 'read')
    return
  }
  if (hitLimit(state, depth)) return
  for (const ent of entries) {
    if (hitLimit(state, depth)) return
    state.seen += 1
    if (state.seen % YIELD_EVERY === 0) await pause()
    if (hitLimit(state, depth)) return
    const child = path.join(full, ent.name)
    let st
    try {
      st = await fsp.lstat(child)
    } catch {
      markIncomplete(state, 'read')
      continue
    }
    if (st.isSymbolicLink()) continue
    if (st.isDirectory()) {
      state.dirs += 1
      await walk(child, depth + 1, state)
      continue
    }
    state.files += 1
    state.bytes += Number(st.size) || 0
    emitProgress(state, false)
  }
}

/**
 * 原生版：`P bytes files dirs` 進度、`D bytes files dirs incomplete reason` 結束、`E read` 根目錄讀不到。
 * 取消＝砍程序（`job.kill`）。回 false ＝ 根本沒跑起來（例如 exe 被刪），交回 JS `walk`。
 * @param {string} exe
 * @param {string} full
 * @param {any} state
 * @returns {Promise<boolean>}
 */
function walkNative(exe, full, state) {
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      state.job.kill = null
      fn(value)
    }
    let child
    try {
      child = spawn(exe, ['dir-size', full, String(state.maxFiles), String(state.maxDepth), String(state.maxMs)], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      })
    } catch {
      resolve(false)
      return
    }
    state.job.kill = () => child.kill()
    let finished = false
    let rootFailed = false
    let pending = ''
    const apply = (line) => {
      const [tag, bytes, files, dirs, incomplete, reason] = line.trim().split(' ')
      if (tag === 'E') rootFailed = true
      if (tag !== 'P' && tag !== 'D') return
      state.bytes = Number(bytes) || 0
      state.files = Number(files) || 0
      state.dirs = Number(dirs) || 0
      if (tag === 'P') return emitProgress(state, false)
      finished = true
      if (incomplete === '1') {
        state.incomplete = true
        state.reason = reason || 'read'
      }
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      pending += chunk
      let index
      while ((index = pending.indexOf('\n')) >= 0) {
        apply(pending.slice(0, index))
        pending = pending.slice(index + 1)
      }
    })
    child.on('error', () => settle(resolve, finished))
    child.on('close', () => {
      if (rootFailed) return settle(reject, paths.fail('READ_FAILED', '沒有權限讀這個資料夾'))
      // 被取消或中途當掉：已經數到的留著，標成不完整
      if (!finished) markIncomplete(state, state.job.cancelled ? 'cancel' : 'read')
      return settle(resolve, true)
    })
  })
}

/** @param {{ cancelled: boolean, kill?: (() => void) | null }} job */
function cancelJob(job) {
  job.cancelled = true
  if (job.kill) job.kill()
}

/**
 * @param {unknown} token
 * @returns {boolean}
 */
function folderSizeCancel(token) {
  if (!current) return true
  const tok = typeof token === 'string' ? sanitizeToken(token) : ''
  if (!tok || current.token === tok) cancelJob(current)
  return true
}

function dropJob(job) {
  if (current === job) current = null
}

function doneEmpty(full, job, onProgress) {
  dropJob(job)
  const out = snapshot({
    path: full,
    job,
    bytes: 0,
    files: 0,
    dirs: 0,
    incomplete: false,
    reason: '',
    onProgress,
    lastEmit: 0
  })
  if (typeof onProgress === 'function') onProgress({ ...out, done: true })
  return out
}

function newState(full, job, input) {
  const fileCap = input.exe ? NATIVE_MAX_FILES : MAX_FILES
  return {
    path: full,
    job,
    bytes: 0,
    files: 0,
    dirs: 0,
    incomplete: false,
    reason: '',
    seen: 0,
    started: Date.now(),
    lastEmit: 0,
    maxFiles: clamp(input.maxFiles, fileCap, 1, fileCap),
    maxDepth: clamp(input.maxDepth, MAX_DEPTH, 0, 64),
    maxMs: clamp(input.maxMs, MAX_MS, 100, 60_000),
    onProgress: input.onProgress
  }
}

/**
 * @param {unknown} dirPath
 * @param {unknown} token
 * @param {{
 *   maxFiles?: number,
 *   maxDepth?: number,
 *   maxMs?: number,
 *   exe?: string,
 *   onProgress?: (info: object) => void
 * }} [opts] `exe` 給 voiceink-probe.exe 的路徑就走原生版
 */
async function folderSize(dirPath, token, opts) {
  if (current) cancelJob(current)
  const job = { token: sanitizeToken(token), cancelled: false }
  current = job
  const input = opts && typeof opts === 'object' ? opts : {}
  let full
  let st
  try {
    full = paths.resolveExisting(dirPath)
    st = fs.lstatSync(full)
  } catch (error) {
    dropJob(job)
    if (error && error.userMessage) throw error
    throw paths.fail('NOT_FOUND', '找不到這個檔案')
  }
  if (!st.isDirectory() && !st.isSymbolicLink()) {
    dropJob(job)
    throw paths.fail('BAD_PATH', '這不是資料夾')
  }
  if (st.isSymbolicLink()) return doneEmpty(full, job, input.onProgress)
  const state = newState(full, job, input)
  try {
    const native = input.exe ? await walkNative(input.exe, full, state) : false
    if (!native) await walk(full, 0, state)
  } finally {
    if (job.cancelled) {
      state.incomplete = true
      if (!state.reason) state.reason = 'cancel'
    }
    emitProgress(state, true)
    dropJob(job)
  }
  return snapshot(state)
}

module.exports = {
  folderSize,
  folderSizeCancel,
  MAX_FILES,
  MAX_DEPTH,
  MAX_MS,
  PROGRESS_MS
}
