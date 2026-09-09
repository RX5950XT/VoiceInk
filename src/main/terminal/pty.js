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
/** 已結束的畫面也留著，直到使用者明確關掉該終端機。 */
const finished = new Map()

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
  const session = live.get(id) || finished.get(id)
  if (!emit) return
  emit('terminal:status', {
    id,
    state: session ? session.tracker.state : 'exited',
    exitCode: session ? session.tracker.exitCode : null,
    // 前景程式自己報的（OSC 0/2 與 OSC 7）：分頁標題要跟著跑什麼變，
    // 連結解析要跟著 `cd` 走。沒報過就是空字串，呼叫端自己退回原本的值。
    title: session ? session.tracker.title : '',
    cwd: session ? session.tracker.cwd : ''
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
  const t = session.tracker
  const before = `${t.state}|${t.title}|${t.cwd}`
  status.onOutput(t, chunk, Date.now())
  // **不要每個 chunk 都 `slice(-上限)`**：那是每個小封包都複製一份 256KB 字串。
  // AI CLI 串流一秒上百個封包，實測 2 萬個 chunk 要 1912ms；留到超過兩倍才砍一次
  // 是 3.4ms。回放時 `trimBuffer` 再砍回上限，對外的量沒有變多。
  session.buffer += chunk
  if (session.buffer.length > SCROLLBACK_CHARS * 2) session.buffer = trimBuffer(session.buffer)
  session.pendingOut += chunk
  if (!session.flushTimer) session.flushTimer = setTimeout(() => flush(session), FLUSH_MS)
  if (`${t.state}|${t.title}|${t.cwd}` !== before) publishStatus(session.id)
}

/**
 * 砍到 scrollback 上限。**從最近的換行砍**：從字串中間切下去有機會切在跳脫序列
 * 中間，回放的第一行就會冒出半截 `[38;5;12m`。
 * @param {string} text
 * @returns {string}
 */
function trimBuffer(text) {
  if (text.length <= SCROLLBACK_CHARS) return text
  const cut = text.length - SCROLLBACK_CHARS
  const nl = text.indexOf('\n', cut)
  // 找不到換行（或遠得離譜，例如一整段沒斷行的進度條）就照原本的位置砍
  return text.slice(nl >= 0 && nl - cut < 4096 ? nl + 1 : cut)
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
function spawnSession(meta, cols, rows, editor) {
  const { exe, args, integrated } = shellCommand(meta.shell)

  // 管理員：ConPTY 開不出提權的 shell，交給提權的 host 程序去開（admin.js）
  const term = meta.admin
    ? require('./admin').spawnAdmin(meta, cols, rows)
    : loadPty().spawn(exe, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: meta.cwd,
      env: shellEnvironment(editor)
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
    if (!session.forgotten) finished.set(meta.id, session)
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
    const session = live.get(item.id) || finished.get(item.id)
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
  forgetSession(id)
  await store.remove(String(id || ''))
  return true
}

/**
 * 掛上分頁：沒開過就開一顆，已經在跑就把目前畫面整份給回去。
 *
 * `seq` 讓 renderer 丟掉「快照已經含進去、但監聽器也收到一次」的重複片段。
 * @param {string} id
 * @param {number} cols
 * @param {number} rows
 */
async function openSession(id, cols, rows, editor) {
  const key = String(id || '')
  const meta = await store.get(key)
  if (!meta) {
    const error = new Error('NO_SESSION')
    error.code = 'NO_SESSION'
    error.userMessage = '找不到這個工作階段'
    throw error
  }
  return openSessionWithMeta(meta, cols, rows, editor)
}

/**
 * 背景宿主使用 main 已讀取的 metadata，不另外開 electron-store。
 *
 * `editor` 是 App 那邊算好的「Ctrl+G 要跑什麼」（見 `editor-bridge.js`）；只有這一次
 * 真的要 spawn 新 shell 時用得到，接回既有階段時忽略。
 */
function openSessionWithMeta(meta, cols, rows, editor) {
  const key = meta.id
  const c = clampDim(cols, MAX_COLS, 80)
  const r = clampDim(rows, MAX_ROWS, 24)
  let session = live.get(key) || finished.get(key)
  if (!session) {
    session = spawnSession(meta, c, r, editor)
    publishStatus(key)
  } else if (session.cols !== c || session.rows !== r) {
    resizeSession(key, c, r)
  }
  // 快照已含 pendingOut，先派送並增加 seq，接回的 renderer 才不會重複那一段。
  if (session.flushTimer) {
    clearTimeout(session.flushTimer)
    flush(session)
  }
  return {
    id: key,
    pid: session.term.pid || null,
    state: session.tracker.state,
    exitCode: session.tracker.exitCode,
    title: session.tracker.title,
    cwd: session.tracker.cwd,
    seq: session.seq,
    buffer: trimBuffer(session.buffer)
  }
}

/**
 * 宿主的 Node 模式只給宿主自己用，不污染使用者啟動的程式。
 *
 * `editor` 有值時順便把 `EDITOR`／`VISUAL` 指到 App 的編輯器橋接（Claude Code 按
 * Ctrl+G 就會開 App 內的分頁，而不是記事本）。**使用者自己設過就不覆蓋**——已經
 * 習慣 vim 的人按下去本來就該進 vim。
 *
 * @param {string} [editor]
 */
function shellEnvironment(editor) {
  const env = { ...process.env, TERM: 'xterm-256color' }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ASAR
  if (editor && !env.EDITOR && !env.VISUAL) env.EDITOR = editor
  return env
}

function sessionStates() {
  return [...live.values(), ...finished.values()].map((session) => ({
    id: session.id, state: session.tracker.state, exitCode: session.tracker.exitCode,
    title: session.tracker.title, cwd: session.tracker.cwd,
    pid: session.term.pid || null
  }))
}

function forgetSession(id) {
  const session = live.get(id) || finished.get(id)
  if (!session) return false
  session.forgotten = true
  killSession(id)
  live.delete(id)
  finished.delete(id)
  return true
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
  for (const id of [...live.keys(), ...finished.keys()]) forgetSession(id)
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
  openSession,
  openSessionWithMeta,
  shellEnvironment,
  sessionStates,
  forgetSession,
  writeSession,
  resizeSession,
  killSession,
  killAll,
  // 測試用
  trimBuffer,
  _live: live,
  _clampDim: clampDim
}
