'use strict'

/**
 * Claude Code hooks → 終端機忙碌狀態，以及重開後接回對話要用的 session id。
 *
 * hook 執行檔（`voiceink-probe.exe claude-hook`，複製成 userData 裡的
 * `voiceink-claude-hook.exe`）把事件寫進 `<userData>/claude-hook/events/`。
 * 這裡監看那個資料夾，歸約成每個終端機的 working／waiting／idle，有變才送
 * `terminal:agent`。宿主比 App 活得久，所以啟動時先把已經躺著的事件補處理。
 *
 * 歸約是純函式（`reduceAgent`／`applyInput`／`applyStatus`），node 直測、不碰檔案。
 */

const fs = require('node:fs')
const path = require('node:path')
const store = require('./store')
const claudeSettings = require('../ccswitch/claude-settings')
const { resolveProbeExe } = require('../native-probe')
const rawFs = require('../raw-fs')

const EVENTS = new Set(claudeSettings.HOOK_EVENT_NAMES)
const ASK_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])
const WAITING_NOTES = new Set(['permission_prompt', 'elicitation_dialog'])
const NAME_RE = /^(\d{13})-(\d+)\.json$/
const MAX_AGE_MS = 24 * 60 * 60 * 1000
const MAX_BATCH = 1000
const MAX_EVENT_BYTES = 1024 * 1024
const MAX_SHORT = 200
const MAX_PATH = 1024
const STAT_TIMEOUT_MS = 1500

/** @type {Map<string, { sessionId: string, state: 'working'|'waiting'|'idle' }>} */
const tracks = new Map()
/** @type {Map<string, number | null>} 上次看到的 shell 離開碼；沒看過當 null */
const exitCodes = new Map()

let userData = ''
let baseDir = ''
let emit = () => {}
let watcher = null
let booted = false
let writeSettings = true
let stopped = false
let scanning = null
let scanAgain = false

function log(code) {
  console.error(`[claude-hook] ${code}`)
}

/**
 * @param {string} dataDir `<userData>`
 * @returns {string} 空字串代表路徑裡有引號，不能寫進 settings
 */
function hookCommand(dataDir) {
  const exe = path.join(String(dataDir || ''), 'claude-hook', 'voiceink-claude-hook.exe').replace(/\\/g, '/')
  if (!exe || exe.includes('"') || /[\r\n]/.test(exe)) return ''
  return `"${exe}" claude-hook`
}

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {string | null} null＝這筆不能用
 */
function short(value, max) {
  if (value == null || value === '') return ''
  if (typeof value !== 'string' || value.length > max) return null
  if (/[\u0000-\u001f]/.test(value)) return null
  return value
}

/**
 * 事件檔是 hook 寫的，仍當不可信輸入。不過的整筆丟掉。
 * @param {unknown} raw
 * @returns {object | null}
 */
function parseEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.v !== 1) return null
  if (!store.isSessionId(raw.terminalId) || !store.isClaudeSessionId(raw.sessionId)) return null
  if (!EVENTS.has(raw.event)) return null
  const notificationType = short(raw.notificationType, MAX_SHORT)
  const toolName = short(raw.toolName, MAX_SHORT)
  const source = short(raw.source, MAX_SHORT)
  const reason = short(raw.reason, MAX_SHORT)
  const transcriptPath = short(raw.transcriptPath, MAX_PATH)
  if (notificationType === null || toolName === null || source === null || reason === null || transcriptPath === null) {
    return null
  }
  return {
    terminalId: raw.terminalId,
    event: raw.event,
    sessionId: raw.sessionId,
    notificationType,
    toolName,
    source,
    reason,
    transcriptPath
  }
}

/**
 * @param {{ sessionId: string, state: string } | null} current
 * @param {{ event: string, sessionId: string, source?: string }} ev
 * @returns {{ next: { sessionId: string, state: string } | null, changed: boolean, adopt: boolean }}
 */
function reduceStart(current, ev) {
  const same = Boolean(current && current.sessionId === ev.sessionId)
  const takeover = Boolean(current && !same && (ev.source === 'clear' || ev.source === 'resume'))
  // startup（以及 compact 之類）一律不切換：巢狀 `claude -p` 會繼承同一個環境變數。
  if (!current || same || takeover) {
    return {
      next: { sessionId: ev.sessionId, state: 'idle' },
      changed: !current || current.state !== 'idle',
      adopt: true
    }
  }
  return { next: current, changed: false, adopt: false }
}

/**
 * @param {string} state
 * @param {{ event: string, toolName?: string, notificationType?: string }} ev
 * @returns {string}
 */
function nextState(state, ev) {
  if (ev.event === 'UserPromptSubmit') return 'working'
  if (ev.event === 'PermissionRequest') return 'waiting'
  if (ev.event === 'PreToolUse' && ASK_TOOLS.has(ev.toolName || '')) return 'waiting'
  if (ev.event === 'Notification' && WAITING_NOTES.has(ev.notificationType || '')) return 'waiting'
  if (ev.event === 'Notification' && ev.notificationType === 'idle_prompt') return 'idle'
  if (ev.event === 'Stop' || ev.event === 'StopFailure') return 'idle'
  return state
}

/**
 * @param {{ sessionId: string, state: string } | null} current
 * @param {object} ev
 * @returns {{ next: { sessionId: string, state: string } | null, changed: boolean, adopt: boolean }}
 */
function reduceAgent(current, ev) {
  if (ev.event === 'SessionStart') return reduceStart(current, ev)
  if (!current || current.sessionId !== ev.sessionId) return { next: current, changed: false, adopt: false }
  if (ev.event === 'SessionEnd') return { next: null, changed: true, adopt: false }
  const state = nextState(current.state, ev)
  if (state === current.state) return { next: current, changed: false, adopt: false }
  return { next: { sessionId: current.sessionId, state }, changed: true, adopt: false }
}

/** Esc／Ctrl+C：中斷這一輪。Claude 被中斷時**不送 Stop**，不在這裡收的話會一直卡在 working。 */
const INTERRUPT_KEYS = new Set(['\x1b', '\x03'])

/**
 * 算不算「回答了提問」：Enter、或選單的單鍵（數字／字母）。
 * 滑鼠回報與焦點進出（`ESC [ I`／`ESC [ < …M`）是 xterm 自己送的，不算人回答。
 * @param {string} data
 */
function isAnswer(data) {
  return data.includes('\r') || /^[0-9A-Za-z]$/.test(data)
}

/**
 * 使用者對終端機的輸入。waiting 時回答了＝權限問題答完，下一個 hook 要等工具跑完才來；
 * waiting／working 時按 Esc 或 Ctrl+C＝這一輪中斷了，回 idle。
 * @param {{ sessionId: string, state: string } | null} current
 * @param {string} data
 * @returns {{ next: { sessionId: string, state: string } | null, changed: boolean }}
 */
function applyInput(current, data) {
  if (!current || typeof data !== 'string') return { next: current, changed: false }
  let state = current.state
  if (INTERRUPT_KEYS.has(data) && (state === 'waiting' || state === 'working')) state = 'idle'
  else if (state === 'waiting' && isAnswer(data)) state = 'working'
  if (state === current.state) return { next: current, changed: false }
  return { next: { sessionId: current.sessionId, state }, changed: true }
}

/**
 * shell 離開碼從 null 變成數字，或階段 exited。沒看過的離開碼也當 null
 * （tracker 的初值就是 null：第一次報上數字＝提示字元回來了）。
 * @param {number | null} prevCode
 * @param {{ state?: string, exitCode?: unknown }} payload
 * @returns {{ code: number | null, clear: boolean, forget: boolean }}
 */
function statusClears(prevCode, payload) {
  const raw = payload && payload.exitCode
  const code = Number.isInteger(raw) ? raw : null
  if (payload && payload.state === 'exited') return { code: null, clear: true, forget: true }
  return { code, clear: prevCode === null && code !== null, forget: false }
}

/**
 * @param {{ sessionId: string, state: string } | null} current
 * @param {number | null} prevCode
 * @param {{ state?: string, exitCode?: unknown }} payload
 * @returns {{ next: { sessionId: string, state: string } | null, code: number | null, forget: boolean, changed: boolean }}
 */
function applyStatus(current, prevCode, payload) {
  const gate = statusClears(prevCode, payload)
  if (!gate.clear) return { next: current, code: gate.code, forget: gate.forget, changed: false }
  return { next: null, code: gate.code, forget: gate.forget, changed: current != null }
}

/**
 * @param {string} id
 * @returns {'working'|'waiting'|'idle'|null}
 */
function agentOf(id) {
  const track = tracks.get(id)
  return track ? track.state : null
}

/**
 * @param {string} id
 * @param {'working'|'waiting'|'idle'|null} state
 */
function emitAgent(id, state) {
  try { emit({ id, state }) } catch { /* renderer 已經走了 */ }
}

/** @param {string} id */
function clearAgent(id) {
  if (!tracks.has(id)) return
  tracks.delete(id)
  emitAgent(id, null)
}

/** @param {string} id @param {string} data */
function noteInput(id, data) {
  if (!store.isSessionId(id)) return
  const result = applyInput(tracks.get(id) || null, data)
  if (!result.changed || !result.next) return
  tracks.set(id, result.next)
  emitAgent(id, result.next.state)
}

/** @param {{ id?: string, state?: string, exitCode?: unknown }} payload */
function noteStatus(payload) {
  if (!payload || !store.isSessionId(payload.id)) return
  const prev = exitCodes.has(payload.id) ? exitCodes.get(payload.id) : null
  const result = applyStatus(tracks.get(payload.id) || null, prev, payload)
  if (result.forget) exitCodes.delete(payload.id)
  else exitCodes.set(payload.id, result.code)
  if (!result.changed) return
  tracks.delete(payload.id)
  emitAgent(payload.id, null)
}

/** @param {{ terminalId: string, sessionId: string, transcriptPath: string }} ev */
function remember(ev) {
  if (!store.isClaudeTranscript(ev.transcriptPath, ev.sessionId)) return Promise.resolve()
  return store.setClaudeSession(ev.terminalId, ev.sessionId, ev.transcriptPath).catch((error) => {
    log(error.code || 'STORE')
  })
}

/** @param {object} ev */
async function applyEvent(ev) {
  const result = reduceAgent(tracks.get(ev.terminalId) || null, ev)
  if (result.next) tracks.set(ev.terminalId, result.next)
  else tracks.delete(ev.terminalId)
  if (result.adopt) await remember(ev)
  if (result.changed) emitAgent(ev.terminalId, result.next ? result.next.state : null)
}

/**
 * @param {Promise<unknown>} promise
 * @param {number} ms
 * @returns {Promise<unknown>}
 */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT' })), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) }
    )
  })
}

/**
 * 傳給宿主之前：對話檔不在就拿掉 id，避免 Claude 開到一半說找不到。
 * 路徑可能在網路磁碟上，只用非同步 stat，逾時就當沒有。
 * @param {object} meta
 * @returns {Promise<object>}
 */
async function prepareResume(meta) {
  if (!meta || meta.preset !== 'claude') return meta
  const sessionId = meta.claudeSessionId
  const transcript = meta.claudeTranscript
  if (!store.isClaudeSessionId(sessionId) || !store.isClaudeTranscript(transcript, sessionId)) return withoutClaude(meta)
  try {
    const st = await withTimeout(rawFs.promises.stat(transcript), STAT_TIMEOUT_MS)
    if (st && st.isFile()) return meta
  } catch { /* 不存在、逾時、或讀不到 */ }
  return withoutClaude(meta)
}

/** @param {object} meta */
function withoutClaude(meta) {
  if (meta.claudeSessionId === undefined && meta.claudeTranscript === undefined) return meta
  const next = { ...meta }
  delete next.claudeSessionId
  delete next.claudeTranscript
  return next
}

function eventsDir() {
  return path.join(baseDir, 'events')
}

function unlinkQuiet(file) {
  try { fs.unlinkSync(file) } catch { /* 下一輪再試 */ }
}

/**
 * @param {string} file
 * @returns {object | null | undefined} undefined＝這次讀不到，先留著
 */
function readEvent(file) {
  let raw
  try { raw = fs.readFileSync(file) } catch { return undefined }
  if (raw.length > MAX_EVENT_BYTES) return null
  try { return JSON.parse(raw.toString('utf8')) } catch { return null }
}

/** @param {string} file */
async function consume(file) {
  const raw = readEvent(file)
  if (raw === undefined) return
  unlinkQuiet(file)
  const ev = parseEvent(raw)
  if (ev) await applyEvent(ev)
}

/** @param {string} file @param {number} now */
function oldTmp(file, now) {
  try { return now - fs.statSync(file).mtimeMs > MAX_AGE_MS } catch { return false }
}

async function doScan() {
  let names = []
  try { names = fs.readdirSync(eventsDir()) } catch { return }
  const now = Date.now()
  /** @type {Array<{ name: string, millis: number, full: string }>} */
  const pending = []
  for (const name of names) {
    const full = path.join(eventsDir(), name)
    const match = NAME_RE.exec(name)
    if (!match) {
      if (name.endsWith('.json') || (name.endsWith('.tmp') && oldTmp(full, now))) unlinkQuiet(full)
      continue
    }
    const millis = Number(match[1])
    if (now - millis > MAX_AGE_MS) { unlinkQuiet(full); continue }
    pending.push({ name, millis, full })
  }
  pending.sort((a, b) => a.millis - b.millis || (a.name < b.name ? -1 : 1))
  for (const item of pending.slice(0, MAX_BATCH)) await consume(item.full)
  if (pending.length > MAX_BATCH) scanAgain = true
}

function scan() {
  if (stopped) return Promise.resolve()
  if (scanning) { scanAgain = true; return scanning }
  scanning = doScan().finally(() => {
    scanning = null
    if (scanAgain && !stopped) { scanAgain = false; scan() }
  })
  return scanning
}

function sameBytes(left, right) {
  try {
    const a = fs.readFileSync(left)
    const b = fs.readFileSync(right)
    return a.length === b.length && a.equals(b)
  } catch {
    return false
  }
}

/**
 * Windows 的 rename 蓋不掉既有檔。目標被 hook 抓著就留舊的，下次啟動再試。
 * @param {string} tmp
 * @param {string} dest
 * @returns {boolean}
 */
function replaceFile(tmp, dest) {
  try { fs.renameSync(tmp, dest); return true } catch { /* 目標已存在 */ }
  try { fs.unlinkSync(dest) } catch { return false }
  fs.renameSync(tmp, dest)
  return true
}

/**
 * @param {string} src
 * @param {string} dest
 * @returns {string} 可用的 exe；裝不起來回空字串
 */
function installExe(src, dest) {
  if (sameBytes(src, dest)) return dest
  const tmp = `${dest}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, fs.readFileSync(src))
    if (!replaceFile(tmp, dest)) {
      unlinkQuiet(tmp)
      log('EXE_LOCKED')
      return fs.existsSync(dest) ? dest : ''
    }
    return dest
  } catch (error) {
    unlinkQuiet(tmp)
    log(error.code || 'EXE_INSTALL')
    return fs.existsSync(dest) ? dest : ''
  }
}

function startWatch() {
  if (watcher || stopped) return
  try {
    const fsWatcher = fs.watch(eventsDir(), () => { scan() })
    const timer = setInterval(() => { scan() }, 5000)
    if (typeof timer.unref === 'function') timer.unref()
    watcher = { close() { fsWatcher.close(); clearInterval(timer) } }
  } catch (error) {
    log(error.code || 'WATCH')
  }
}

async function boot() {
  if (stopped) return
  try { fs.mkdirSync(eventsDir(), { recursive: true }) } catch (error) {
    log(error.code || 'MKDIR')
    return
  }
  await scan()
  const src = resolveProbeExe()
  const dest = path.join(baseDir, 'voiceink-claude-hook.exe')
  if (!src) log('PROBE_MISSING')
  else installExe(src, dest)
  if (writeSettings && fs.existsSync(dest)) {
    const command = hookCommand(userData)
    const result = command ? claudeSettings.applyHooks(command) : { ok: false, reason: 'BAD_COMMAND' }
    if (!result.ok) log(result.reason || 'SETTINGS')
  }
  startWatch()
  await scan()
}

/**
 * 不擋啟動：whenReady 裡呼叫，真正的複製與掃檔排到下一個 tick。
 * @param {string} dataDir
 * @param {(payload: { id: string, state: 'working'|'waiting'|'idle'|null }) => void} emitter
 * @param {{ writeSettings?: boolean }} [options] false＝只裝 exe、監看事件，不動 Claude 設定
 */
function start(dataDir, emitter, options = {}) {
  if (booted) return
  booted = true
  writeSettings = options.writeSettings !== false
  userData = String(dataDir || '')
  baseDir = path.join(userData, 'claude-hook')
  emit = typeof emitter === 'function' ? emitter : () => {}
  // stop() 若已經先跑過（啟動過程中就關掉），不要再把 hooks 寫回去。
  if (stopped) return
  setImmediate(() => { boot().catch((error) => log(error.code || 'BOOT')) })
}

function stop() {
  stopped = true
  try { watcher && watcher.close() } catch { /* 程序要結束了 */ }
  watcher = null
}

module.exports = {
  hookCommand,
  parseEvent,
  reduceAgent,
  applyInput,
  statusClears,
  applyStatus,
  agentOf,
  noteInput,
  noteStatus,
  prepareResume,
  start,
  stop
}
