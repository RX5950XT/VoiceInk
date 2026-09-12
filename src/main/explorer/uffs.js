'use strict'

/**
 * UFFS 客戶端（Main Process）。
 *
 * 不把 Rust 引擎 vendoring 進來：找本機 `uffs.exe`、代跑 CLI。進檔案頁自動
 * 從 GitHub Releases 下載 zip、一次 UAC 裝 Access Broker、拉起 daemon。
 * 關 App **不停** daemon。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')
const { fail, realOf } = require('./paths')

const MAX_PATTERN = 200
const SEARCH_LIMIT = 200
const SEARCH_TIMEOUT_MS = 90_000
const STATUS_TIMEOUT_MS = 8_000
const MAX_STDOUT = 8 * 1024 * 1024
const MAX_ZIP_BYTES = 64 * 1024 * 1024
const ZIP_NAME = 'uffs-windows-x64.zip'
const ZIP_URL = 'https://github.com/skyllc-ai/UltraFastFileSearch/releases/latest/download/uffs-windows-x64.zip'
const SUMS_URL = 'https://github.com/skyllc-ai/UltraFastFileSearch/releases/latest/download/CHECKSUMS.txt'

/** @type {string} */
let userDataPath = ''
/** @type {import('child_process').ChildProcess | null} */
let searchChild = null
/** @type {AbortController | null} */
let downloadCtl = null
/** @type {Promise<object> | null} */
let ensureInflight = null

/** @param {string} dir */
function configure(dir) {
  userDataPath = typeof dir === 'string' ? dir : ''
}

function installDir() {
  return userDataPath ? path.join(userDataPath, 'uffs') : ''
}

function system32(exe) {
  const root = process.env.SystemRoot || 'C:\\Windows'
  return path.join(root, 'System32', exe)
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
function sanitizePattern(raw) {
  if (typeof raw !== 'string') throw fail('BAD_QUERY', '搜尋條件不合法')
  const q = raw.trim()
  if (!q || q.length > MAX_PATTERN) throw fail('BAD_QUERY', '搜尋條件不合法')
  if (q.includes('\0') || q.startsWith('>') || q.startsWith('-')) {
    throw fail('BAD_QUERY', '搜尋條件不合法')
  }
  return q
}

/**
 * @param {string} file
 * @returns {boolean}
 */
function isFile(file) {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * 在目錄樹裡找 uffs.exe（下載解壓後層級不固定）。
 * @param {string} dir
 * @returns {string}
 */
function findExeIn(dir) {
  if (!dir) return ''
  const direct = path.join(dir, 'uffs.exe')
  if (isFile(direct)) return direct
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return ''
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const nested = path.join(dir, ent.name, 'uffs.exe')
    if (isFile(nested)) return nested
  }
  return ''
}

/** @returns {string} */
function findUffs() {
  return findExeIn(installDir())
}

function brokerPath(uffsExe) {
  if (!uffsExe) return ''
  const file = path.join(path.dirname(uffsExe), 'uffs-broker.exe')
  return isFile(file) ? file : ''
}

/**
 * CDP 暫存 userData 在 %TEMP%，自動授權會卡住測試。沒設定也當成暫存。
 * @returns {boolean}
 */
function inTempUserData() {
  if (!userDataPath) return true
  const tmp = String(os.tmpdir() || '').replace(/[\\/]+$/, '').toLowerCase()
  const dir = String(userDataPath).replace(/[\\/]+$/, '').toLowerCase()
  if (!tmp || !dir) return true
  return dir === tmp || dir.startsWith(tmp + path.sep)
}

/**
 * 進頁要不要自己把搜尋引擎拉起來。
 * @param {{ installed?: boolean, broker?: { present?: boolean, installed?: boolean }, daemon?: { running?: boolean } } | null} st
 * @param {{ auto?: boolean }} [opts]
 */
function needsEnsure(st, opts = {}) {
  if (opts.auto === false) return false
  if (!st || !st.installed) return true
  if (st.broker && st.broker.present && !st.broker.installed) return true
  if (!st.daemon || !st.daemon.running) return true
  return false
}

/**
 * @param {string} exe
 * @param {string[]} args
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function run(exe, args, opts = {}) {
  const timeoutMs = opts.timeoutMs || STATUS_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(exe, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsVerbatimArguments: false
      })
    } catch {
      reject(fail('UFFS_FAILED', '搜尋失敗'))
      return
    }
    let out = Buffer.alloc(0)
    let err = Buffer.alloc(0)
    let timed = false
    const timer = setTimeout(() => {
      timed = true
      try { child.kill() } catch { /* 已經停了 */ }
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      out = Buffer.concat([out, chunk])
      if (out.length > MAX_STDOUT) {
        try { child.kill() } catch { /* 已經停了 */ }
      }
    })
    child.stderr.on('data', (chunk) => {
      err = Buffer.concat([err, chunk], Math.min(err.length + chunk.length, 4096))
    })
    child.on('error', () => {
      clearTimeout(timer)
      reject(fail('UFFS_FAILED', '搜尋失敗'))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timed) {
        reject(fail('UFFS_TIMEOUT', '搜尋逾時'))
        return
      }
      resolve({
        code: Number(code) || 0,
        stdout: out.toString('utf8'),
        stderr: err.toString('utf8')
      })
    })
  })
}

function cancelSearch() {
  if (!searchChild) return
  try { searchChild.kill() } catch { /* 已經停了 */ }
  searchChild = null
}

/**
 * @param {string} stdout
 * @returns {object[]}
 */
function parseJsonRows(stdout) {
  const text = String(stdout || '').trim()
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) return parsed
    if (parsed && Array.isArray(parsed.rows)) return parsed.rows
    if (parsed && Array.isArray(parsed.results)) return parsed.results
  } catch {
    // 改走 NDJSON
  }
  const rows = []
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t[0] !== '{') continue
    try {
      rows.push(JSON.parse(t))
    } catch {
      // 跳過壞行
    }
  }
  return rows
}

/**
 * @param {object} row
 * @returns {{ name: string, path: string, dir: boolean, size: number, mtimeMs: number } | null}
 */
/**
 * `uffs --status --json` 的機器可讀狀態。欄位名跟 UFFS 走，缺的當沒裝／沒跑。
 * @param {string} stdout
 */
function parseStatusJson(stdout) {
  let parsed = {}
  try {
    parsed = JSON.parse(String(stdout || '{}'))
  } catch {
    parsed = {}
  }
  if (!parsed || typeof parsed !== 'object') parsed = {}
  const daemon = parsed.daemon && typeof parsed.daemon === 'object' ? parsed.daemon : parsed
  const broker = parsed.broker && typeof parsed.broker === 'object' ? parsed.broker : {}
  const state = String((daemon.status && daemon.status.state) || daemon.status || '').toLowerCase()
  const warming = state.includes('load') || state.includes('start')
    || (state.includes('warm') && state !== 'warm' && state !== 'hot')
  return {
    daemon: {
      running: daemon.running === true,
      warming,
      drives: Array.isArray(daemon.drives) ? daemon.drives.length : Number(daemon.drives) || 0,
      records: Number((daemon.stats && daemon.stats.total_records) || daemon.records) || 0
    },
    broker: {
      installed: broker.installed === true
    }
  }
}

/**
 * 搜尋失敗時只回固定 kind，stderr（含 uffsd 路徑）不准進 UI。
 * @param {unknown} code
 * @param {unknown} stderr
 * @returns {{ kind: 'ok'|'warming'|'broker'|'failed' }}
 */
function classifySearchError(code, stderr) {
  const text = String(stderr || '').toLowerCase()
  if (text.includes('warming') || text.includes('starting up') || text.includes('starting')) {
    return { kind: 'warming' }
  }
  if (!Number(code)) return { kind: 'ok' }
  if (/admin|elevat|privileg|broker|master file table/.test(text)) {
    return { kind: 'broker' }
  }
  return { kind: 'failed' }
}

function sanitizeHit(row) {
  if (!row || typeof row !== 'object') return null
  const full = typeof row.path === 'string'
    ? row.path
    : typeof row.Path === 'string' ? row.Path : ''
  if (!full) return null
  let abs
  try {
    abs = require('./paths').resolveAbs(full)
  } catch {
    return null
  }
  const name = typeof row.name === 'string' && row.name
    ? row.name
    : path.basename(abs)
  const type = String(row.type || row.Type || '').toLowerCase()
  const dir = type === 'dir' || type === 'directory' || row.directory === true
  const size = Number(row.size || row.Size) || 0
  const written = row.written || row.Written || row.modified || row.mtime
  const mtimeMs = written ? Date.parse(String(written)) || 0 : 0
  return { name, path: abs, dir, size, mtimeMs }
}

/**
 * @returns {Promise<{
 *   installed: boolean, version: string,
 *   daemon: { running: boolean, warming: boolean, drives: number, records: number },
 *   broker: { present: boolean }
 * }>}
 */
async function status() {
  const exe = findUffs()
  const empty = {
    installed: false,
    version: '',
    daemon: { running: false, warming: false, drives: 0, records: 0 },
    broker: { present: false, installed: false }
  }
  if (!exe) return empty
  empty.installed = true
  empty.broker.present = Boolean(brokerPath(exe))
  try {
    const ver = await run(exe, ['--version'], { timeoutMs: 4000 })
    empty.version = String(ver.stdout || '').trim().split(/\r?\n/)[0].slice(0, 80)
  } catch {
    empty.version = ''
  }
  try {
    const raw = await run(exe, ['--status', '--json'], { timeoutMs: STATUS_TIMEOUT_MS })
    const parsed = parseStatusJson(raw.stdout)
    empty.daemon = parsed.daemon
    empty.broker.installed = parsed.broker.installed
  } catch {
    // daemon 沒在跑不算錯誤
  }
  return empty
}

/**
 * @param {unknown} raw
 * @returns {Promise<{ hits: object[], truncated: boolean, warming: boolean }>}
 */
async function search(raw) {
  const pattern = sanitizePattern(raw)
  const exe = findUffs()
  if (!exe) throw fail('UFFS_MISSING', '尚未安裝快速搜尋')
  cancelSearch()
  const args = [
    pattern,
    '--format', 'json',
    '--limit', String(SEARCH_LIMIT),
    '--columns', 'path,name,size,written,type',
    '--hide-system',
    '--hide-ads'
  ]
  const result = await new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      reject(fail('UFFS_FAILED', '搜尋失敗'))
      return
    }
    searchChild = child
    let out = Buffer.alloc(0)
    let err = Buffer.alloc(0)
    let timed = false
    const timer = setTimeout(() => {
      timed = true
      try { child.kill() } catch { /* 已經停了 */ }
    }, SEARCH_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => {
      out = Buffer.concat([out, chunk])
      if (out.length > MAX_STDOUT) {
        try { child.kill() } catch { /* 已經停了 */ }
      }
    })
    child.stderr.on('data', (chunk) => {
      err = Buffer.concat([err, chunk], Math.min(err.length + chunk.length, 4096))
    })
    child.on('error', () => {
      clearTimeout(timer)
      if (searchChild === child) searchChild = null
      reject(fail('UFFS_FAILED', '搜尋失敗'))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (searchChild === child) searchChild = null
      if (timed) {
        reject(fail('UFFS_TIMEOUT', '搜尋逾時'))
        return
      }
      resolve({
        code: Number(code) || 0,
        stdout: out.toString('utf8'),
        stderr: err.toString('utf8')
      })
    })
  })
  const kind = classifySearchError(result.code, result.stderr).kind
  if (kind === 'warming') return { hits: [], truncated: false, warming: true }
  if (kind === 'broker') throw fail('UFFS_BROKER', '需要授權讀取磁碟')
  if (kind === 'failed') throw fail('UFFS_FAILED', '搜尋失敗')
  const rows = parseJsonRows(result.stdout)
  const hits = []
  for (const row of rows) {
    const hit = sanitizeHit(row)
    if (hit) hits.push(hit)
    if (hits.length >= SEARCH_LIMIT) break
  }
  return { hits: require('./rank').rankHits(pattern, hits), truncated: rows.length >= SEARCH_LIMIT, warming: false }
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * @param {string} zipPath
 * @param {string} dest
 */
async function unzip(zipPath, dest) {
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = `Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(dest)} -Force`
  const result = await run(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    timeoutMs: 120_000
  })
  if (result.code !== 0) throw fail('UFFS_INSTALL', '解壓失敗')
}

/**
 * @param {string} text
 * @param {string} fileName
 * @returns {string}
 */
function checksumFor(text, fileName) {
  const lower = fileName.toLowerCase()
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/([a-fA-F0-9]{64})\s+(\S+)/)
    if (m && m[2].toLowerCase().includes(lower)) return m[1].toLowerCase()
  }
  return ''
}

/**
 * checksum 缺或對不上都失敗（不可 fail-open）。
 * @param {string} file
 * @param {string} sumsText
 * @param {string} fileName
 */
function verifyZipHash(file, sumsText, fileName) {
  const expected = checksumFor(sumsText, fileName)
  if (!expected) throw fail('UFFS_INSTALL', '下載檔案驗證失敗')
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(file))
  if (hash.digest('hex') !== expected) throw fail('UFFS_INSTALL', '下載檔案驗證失敗')
}

/**
 * @param {(info: { received: number, total: number }) => void} [onProgress]
 */
async function download(onProgress) {
  const destDir = installDir()
  if (!destDir) throw fail('UFFS_INSTALL', '找不到安裝位置')
  fs.mkdirSync(destDir, { recursive: true })
  if (downloadCtl) downloadCtl.abort()
  downloadCtl = new AbortController()
  const zipPath = path.join(destDir, ZIP_NAME)
  const tmp = `${zipPath}.part`
  const res = await fetch(ZIP_URL, { signal: downloadCtl.signal, redirect: 'follow' })
  if (!res.ok || !res.body) throw fail('UFFS_INSTALL', '下載失敗')
  const total = Number(res.headers.get('content-length')) || 0
  if (total > MAX_ZIP_BYTES) throw fail('UFFS_INSTALL', '下載失敗')
  const file = fs.createWriteStream(tmp)
  let received = 0
  const reader = res.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.length
      if (received > MAX_ZIP_BYTES) throw fail('UFFS_INSTALL', '下載失敗')
      file.write(Buffer.from(value))
      if (onProgress) onProgress({ received, total })
    }
  } catch (error) {
    try { file.destroy() } catch { /* 關掉寫入流 */ }
    try { fs.unlinkSync(tmp) } catch { /* 清掉半套 */ }
    throw error && error.code === 'UFFS_INSTALL' ? error : fail('UFFS_INSTALL', '下載失敗')
  }
  await new Promise((resolve, reject) => {
    file.end((err) => (err ? reject(err) : resolve()))
  })
  let sumsText = ''
  try {
    const sums = await fetch(SUMS_URL, { signal: downloadCtl.signal, redirect: 'follow' })
    if (sums.ok) sumsText = await sums.text()
  } catch {
    sumsText = ''
  }
  try {
    verifyZipHash(tmp, sumsText, ZIP_NAME)
  } catch (error) {
    try { fs.unlinkSync(tmp) } catch { /* 清掉壞檔 */ }
    throw error
  }
  fs.renameSync(tmp, zipPath)
  await unzip(zipPath, destDir)
  try { fs.unlinkSync(zipPath) } catch { /* 留著也沒關係 */ }
  const exe = findExeIn(destDir)
  if (!exe) throw fail('UFFS_INSTALL', '解壓後找不到 uffs')
  const destReal = path.resolve(destDir).toLowerCase()
  const exeReal = (realOf(exe) || path.resolve(exe)).toLowerCase()
  if (exeReal !== destReal && !exeReal.startsWith(destReal + path.sep)) {
    throw fail('UFFS_INSTALL', '解壓後找不到 uffs')
  }
  downloadCtl = null
  return status()
}

function cancelDownload() {
  if (downloadCtl) downloadCtl.abort()
  downloadCtl = null
  return true
}

/**
 * 安裝 Access Broker（一次 UAC）。
 */
async function installBroker() {
  const exe = findUffs()
  const broker = brokerPath(exe)
  if (!broker) throw fail('UFFS_MISSING', '尚未安裝快速搜尋')
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const encoded = Buffer.from(
    `Start-Process -FilePath ${psQuote(broker)} -ArgumentList '--install' -Verb RunAs -Wait`,
    'utf16le'
  ).toString('base64')
  const result = await run(ps, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded
  ], { timeoutMs: 120_000 })
  if (result.code !== 0) throw fail('UFFS_BROKER', '授權安裝已取消或失敗')
  return status()
}

/**
 * @param {{ elevate?: boolean }} [opts]
 */
async function startDaemon(opts = {}) {
  const exe = findUffs()
  if (!exe) throw fail('UFFS_MISSING', '尚未安裝快速搜尋')
  const args = ['--daemon', 'start']
  if (opts.elevate) args.push('--elevate')
  const result = await run(exe, args, { timeoutMs: 90_000 })
  const kind = classifySearchError(result.code, result.stderr).kind
  if (kind === 'warming') return true
  if (kind === 'broker') throw fail('UFFS_BROKER', '需要授權讀取磁碟')
  if (result.code !== 0) throw fail('UFFS_FAILED', '搜尋引擎啟動失敗')
  return true
}

/**
 * 下載（若缺）→ 一次 UAC 裝 broker → 拉起 daemon。進頁才呼叫。
 * @param {{ auto?: boolean, onProgress?: (info: { received: number, total: number }) => void }} [opts]
 */
async function ensureReady(opts = {}) {
  if (opts.auto === false) return status()
  if (ensureInflight) return ensureInflight
  ensureInflight = runEnsure(opts).finally(() => { ensureInflight = null })
  return ensureInflight
}

/**
 * @param {{ onProgress?: (info: { received: number, total: number }) => void }} opts
 */
async function runEnsure(opts) {
  let st = await status()
  if (!needsEnsure(st, { auto: true })) return st
  if (!st.installed) {
    st = await download(typeof opts.onProgress === 'function' ? opts.onProgress : undefined)
  }
  if (st.broker.present && !st.broker.installed) {
    st = await installBroker()
  }
  if (st.installed && !st.daemon.running) {
    await startDaemon({ elevate: !st.broker.installed })
    st = await status()
  }
  return st
}

module.exports = {
  MAX_PATTERN,
  SEARCH_LIMIT,
  MAX_ZIP_BYTES,
  sanitizePattern,
  configure,
  findUffs,
  inTempUserData,
  needsEnsure,
  status,
  search,
  cancelSearch,
  download,
  cancelDownload,
  installBroker,
  startDaemon,
  ensureReady,
  parseJsonRows,
  parseStatusJson,
  classifySearchError,
  sanitizeHit,
  checksumFor,
  verifyZipHash
}
