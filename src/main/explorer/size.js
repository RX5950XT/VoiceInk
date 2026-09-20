'use strict'

/**
 * 遞迴加總資料夾大小（Main Process）。
 *
 * 不跟著 symlink／junction 走；同一時間只算一個，新請求會取消舊的。
 * 路徑過 `paths.resolveExisting`，讀檔用 `raw-fs`。
 */

const fs = require('../raw-fs')
const fsp = require('../raw-fs').promises
const path = require('path')
const paths = require('./paths')

/** 超過就停：約等於一個中型 node_modules，再大的只報「至少」。 */
const MAX_FILES = 50_000
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
 * @param {unknown} token
 * @returns {boolean}
 */
function folderSizeCancel(token) {
  if (!current) return true
  const tok = typeof token === 'string' ? sanitizeToken(token) : ''
  if (!tok || current.token === tok) current.cancelled = true
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
    maxFiles: clamp(input.maxFiles, MAX_FILES, 1, MAX_FILES),
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
 *   onProgress?: (info: object) => void
 * }} [opts]
 */
async function folderSize(dirPath, token, opts) {
  if (current) current.cancelled = true
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
    await walk(full, 0, state)
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
