'use strict'

/**
 * 終端機工作階段（Main Process）。
 *
 * 每個工作階段 = 一顆 ConPTY。metadata 在 `store.js`、忙碌判定在 `status.js`，
 * 這裡只負責生命週期、scrollback 與往 renderer 推資料。
 *
 * node-pty 是原生模組，第一次真的要開終端機才 require（比照 ASR／LLM 的做法，
 * 不拖慢啟動）。`@lydell/node-pty` 是 N-API prebuilt，Electron 43 直接可用、不需 rebuild。
 */

const store = require('./store')
const status = require('./status')

/** 每個階段留多少輸出，供切回分頁時重畫（整段字串，超過從頭砍） */
const SCROLLBACK_CHARS = 256 * 1024
/** 單次 write 上限：renderer 只是鍵盤與貼上，正常遠低於此 */
const MAX_WRITE_CHARS = 8192
const MAX_COLS = 1000
const MAX_ROWS = 500
/** 輸出合併視窗：一次按鍵可能觸發好幾個小 chunk，逐個過 IPC 太貴 */
const FLUSH_MS = 16
/** 靜默判定的巡檢頻率 */
const TICK_MS = 1000
/** 啟動指令等 shell 準備好再送 */
const PRESET_DELAY_MS = 400

/**
 * PowerShell 系列的 shell integration 注入。
 *
 * 刻意**完全不含雙引號**：這整串會變成 `-Command` 的單一 argv，Windows 命令列裡
 * 的內嵌雙引號跳脫規則很容易出錯，用字串相接就沒這個問題。
 *
 * `$ok = $?` 必須是第一句，否則會被後面的敘述蓋掉；history id 用來讓 renderer 端
 * 分辨「真的跑完一條」與「PSReadLine 重繪」（見 status.js）。
 */
const PS_INTEGRATION = [
  '$global:__viPrompt = $function:prompt',
  'function global:prompt {',
  '$ok = $?',
  '$h = (Get-History -Count 1).Id',
  'if ($null -eq $h) { $h = 0 }',
  '$c = 0',
  'if (-not $ok) { $c = 1 }',
  '$e = [char]27',
  '$b = [char]7',
  '($e + \']133;D;\' + $c + \';\' + $h + $b) + (& $global:__viPrompt)',
  '}'
].join('; ')

/** @type {import('@lydell/node-pty') | null} */
let ptyModule = null

/** @type {((channel: string, payload: object) => void) | null} */
let emit = null

/**
 * @typedef {{
 *   id: string,
 *   term: import('@lydell/node-pty').IPty,
 *   tracker: ReturnType<typeof status.createTracker>,
 *   buffer: string,
 *   seq: number,
 *   pendingOut: string,
 *   flushTimer: NodeJS.Timeout | null,
 *   cols: number,
 *   rows: number,
 *   integrated: boolean
 * }} LiveSession
 */

/** @type {Map<string, LiveSession>} */
const live = new Map()

/** @type {NodeJS.Timeout | null} */
let tickTimer = null

/**
 * @param {(channel: string, payload: object) => void} fn
 */
function setEmitter(fn) {
  emit = typeof fn === 'function' ? fn : null
}

function loadPty() {
  if (!ptyModule) ptyModule = require('@lydell/node-pty')
  return ptyModule
}

/**
 * @param {unknown} value
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clampDim(value, max, fallback) {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.min(n, max)
}

/**
 * @param {string} id
 */
function publishStatus(id) {
  const session = live.get(id)
  if (!emit) return
  emit('terminal:status', {
    id,
    state: session ? session.tracker.state : 'exited',
    exitCode: session ? session.tracker.exitCode : null
  })
}

/**
 * @param {LiveSession} session
 */
function flush(session) {
  session.flushTimer = null
  if (!session.pendingOut) return
  const data = session.pendingOut
  session.pendingOut = ''
  session.seq += 1
  if (emit) emit('terminal:data', { id: session.id, seq: session.seq, data })
}

/**
 * @param {LiveSession} session
 * @param {string} chunk
 */
function absorb(session, chunk) {
  const before = session.tracker.state
  status.onOutput(session.tracker, chunk, Date.now())
  session.buffer = (session.buffer + chunk).slice(-SCROLLBACK_CHARS)
  session.pendingOut += chunk
  if (!session.flushTimer) session.flushTimer = setTimeout(() => flush(session), FLUSH_MS)
  if (session.tracker.state !== before) publishStatus(session.id)
}

function ensureTick() {
  if (tickTimer || live.size === 0) return
  tickTimer = setInterval(() => {
    const now = Date.now()
    for (const session of live.values()) {
      if (status.tick(session.tracker, now)) publishStatus(session.id)
    }
    if (live.size === 0 && tickTimer) {
      clearInterval(tickTimer)
      tickTimer = null
    }
  }, TICK_MS)
  // 巡檢不該讓 App 因此無法結束
  if (typeof tickTimer.unref === 'function') tickTimer.unref()
}

/**
 * shell key → 執行檔與參數。提權的 host 程序也用同一份（`admin-host.js`），
 * 兩邊各寫一份遲早會不一致。
 * @param {string} shellKey
 * @returns {{ exe: string, args: string[], integrated: boolean }}
 */
function shellCommand(shellKey) {
  const shell = store.SHELLS[shellKey] || store.SHELLS.cmd
  const integrated = shellKey === 'pwsh' || shellKey === 'powershell'
  return {
    exe: store.resolveExe(shell.exe) || shell.exe,
    args: integrated ? ['-NoLogo', '-NoExit', '-Command', PS_INTEGRATION] : [],
    integrated
  }
}

/**
 * 真的開一顆 pty。
 * @param {{ id: string, shell: string, preset: string, cwd: string, admin?: boolean }} meta
 * @param {number} cols
 * @param {number} rows
 * @returns {LiveSession}
 */
function spawnSession(meta, cols, rows) {
  const { exe, args, integrated } = shellCommand(meta.shell)

  // 管理員：ConPTY 開不出提權的 shell，交給提權的 host 程序去開（admin.js）
  const term = meta.admin
    ? require('./admin').spawnAdmin(meta, cols, rows)
    : loadPty().spawn(exe, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: meta.cwd,
      env: { ...process.env, TERM: 'xterm-256color' }
    })

  /** @type {LiveSession} */
  const session = {
    id: meta.id,
    term,
    tracker: status.createTracker(Date.now()),
    buffer: '',
    seq: 0,
    pendingOut: '',
    flushTimer: null,
    cols,
    rows,
    integrated
  }
  live.set(meta.id, session)

  const command = (store.PRESETS[meta.preset] || store.PRESETS.shell).command
  let presetSent = !command
  term.onData((chunk) => {
    absorb(session, chunk)
    if (!presetSent) {
      presetSent = true
      setTimeout(() => {
        if (live.get(meta.id) !== session) return
        writeSession(meta.id, `${command}\r`)
      }, PRESET_DELAY_MS)
    }
  })
  term.onExit(({ exitCode }) => {
    if (session.flushTimer) {
      clearTimeout(session.flushTimer)
      flush(session)
    }
    status.onExit(session.tracker, exitCode)
    live.delete(meta.id)
    publishStatus(meta.id)
  })

  ensureTick()
  return session
}

/**
 * 側欄清單：store 的順序 + 目前的即時狀態。
 * @returns {Promise<Array<object>>}
 */
async function listSessions() {
  const items = await store.list()
  return items.map((item) => {
    const session = live.get(item.id)
    return {
      ...item,
      state: session ? session.tracker.state : 'stopped',
      exitCode: session ? session.tracker.exitCode : null
    }
  })
}

/**
 * @param {{ shell?: string, preset?: string, cwd?: string, title?: string }} req
 */
async function createSession(req) {
  const meta = await store.create(req || {})
  return { ...meta, state: 'stopped', exitCode: null }
}

/**
 * @param {string} id
 * @param {string} title
 */
function renameSession(id, title) {
  return store.rename(String(id || ''), title)
}

/**
 * @param {string} id
 */
async function deleteSession(id) {
  killSession(id)
  await store.remove(String(id || ''))
  return true
}

/**
 * @param {string[]} ids
 */
function reorderSessions(ids) {
  return store.reorder(Array.isArray(ids) ? ids.map(String) : [])
}

/**
 * 掛上分頁：沒開過就開一顆，已經在跑就把目前畫面整份給回去。
 *
 * `seq` 讓 renderer 丟掉「快照已經含進去、但監聽器也收到一次」的重複片段。
 * @param {string} id
 * @param {number} cols
 * @param {number} rows
 */
async function openSession(id, cols, rows) {
  const key = String(id || '')
  const c = clampDim(cols, MAX_COLS, 80)
  const r = clampDim(rows, MAX_ROWS, 24)
  let session = live.get(key)
  if (!session) {
    const meta = await store.get(key)
    if (!meta) {
      const error = new Error('NO_SESSION')
      error.code = 'NO_SESSION'
      error.userMessage = '找不到這個工作階段'
      throw error
    }
    session = spawnSession(meta, c, r)
    publishStatus(key)
  } else if (session.cols !== c || session.rows !== r) {
    resizeSession(key, c, r)
  }
  return {
    id: key,
    state: session.tracker.state,
    exitCode: session.tracker.exitCode,
    seq: session.seq,
    buffer: session.buffer
  }
}

/**
 * @param {string} id
 * @param {string} data
 */
function writeSession(id, data) {
  const session = live.get(String(id || ''))
  if (!session) return false
  if (typeof data !== 'string' || !data) return false
  const text = data.length > MAX_WRITE_CHARS ? data.slice(0, MAX_WRITE_CHARS) : data
  const before = session.tracker.state
  status.onInput(session.tracker, text, Date.now())
  session.term.write(text)
  if (session.tracker.state !== before) publishStatus(session.id)
  return true
}

/**
 * @param {string} id
 * @param {number} cols
 * @param {number} rows
 */
function resizeSession(id, cols, rows) {
  const session = live.get(String(id || ''))
  if (!session) return false
  const c = clampDim(cols, MAX_COLS, session.cols)
  const r = clampDim(rows, MAX_ROWS, session.rows)
  if (c === session.cols && r === session.rows) return true
  session.cols = c
  session.rows = r
  try {
    session.term.resize(c, r)
  } catch {
    // pty 剛好在這瞬間結束；onExit 會處理狀態
    return false
  }
  return true
}

/**
 * 結束 pty 但保留側欄那一列（可以再點開重跑）。
 * @param {string} id
 */
function killSession(id) {
  const session = live.get(String(id || ''))
  if (!session) return false
  try {
    session.term.kill()
  } catch {
    // 已經死了
  }
  return true
}

/** `before-quit` 要呼叫，否則殘留 conhost／OpenConsole 程序 */
function killAll() {
  for (const id of [...live.keys()]) killSession(id)
  // 提權 host 是獨立程序，斷線它才會把管理員 shell 收乾淨再自己結束
  require('./admin').shutdown()
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
}

/** 給 renderer 填「新終端機」表單用 */
function catalog() {
  return {
    shells: store.availableShells(),
    presets: store.availablePresets(),
    maxSessions: store.MAX_SESSIONS,
    // 表單的預設工作目錄。renderer 沒有 os 模組，也不該自己猜路徑。
    homeDir: store.normalizeCwd('')
  }
}

module.exports = {
  PS_INTEGRATION,
  SCROLLBACK_CHARS,
  MAX_WRITE_CHARS,
  setEmitter,
  shellCommand,
  catalog,
  listSessions,
  createSession,
  renameSession,
  deleteSession,
  reorderSessions,
  openSession,
  writeSession,
  resizeSession,
  killSession,
  killAll,
  // 測試用
  _live: live,
  _clampDim: clampDim
}
