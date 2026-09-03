'use strict'

/**
 * 管理員終端機（Main Process 這一端）。
 *
 * ConPTY 沒有「用管理員身分開」這個選項：CreateProcess 一律繼承呼叫者的 token，
 * 而唯一拿得到管理員 token 的 `ShellExecute runas`（UAC）又沒辦法把 pty 的 handle
 * 交接過去。所以提權的那份自己開 pty（`admin-host.js`），這裡只負責：
 * 起一顆 host、把位元組轉來轉去、把它偽裝成一個 node-pty 的 `IPty`，
 * 讓 `pty.js` 其餘的邏輯（scrollback／忙碌判定／flush）一行都不用改。
 *
 * **一顆 host 服務所有管理員工作階段**：UAC 只在第一個管理員終端機時跳一次。
 * 管道名是 128-bit 亂數（比照 `sysmon/sensors.js`），且只收第一個連線。
 */

const net = require('net')
const crypto = require('crypto')
const path = require('path')
const { spawn } = require('child_process')

/** UAC 對話框要等使用者按，給寬一點 */
const CONNECT_TIMEOUT_MS = 90 * 1000
/** 累積到這麼多還沒看到換行就丟掉 */
const MAX_BUFFER = 4 * 1024 * 1024

/** @typedef {{ onData: ((d: string) => void) | null, onExit: ((e: { exitCode: number }) => void) | null, meta: object, cols: number, rows: number, spawned: boolean }} AdminTerm */

/** @type {Map<string, AdminTerm>} */
const terms = new Map()

/** @type {import('net').Server | null} */
let server = null
/** @type {import('net').Socket | null} */
let socket = null
/** @type {Promise<void> | null} */
let starting = null
/** @type {NodeJS.Timeout | null} */
let connectTimer = null
let buf = ''

/**
 * PowerShell 的 `-ArgumentList`：陣列元素含空白時不會自己加引號，而這段字串又
 * **不可以含雙引號**（會變成單一 argv，內嵌跳脫規則很容易出錯，CLAUDE.md 有記），
 * 所以用 `[char]34` 把雙引號兜出來。
 * @param {string[]} args
 * @returns {string}
 */
function psArgList(args) {
  return args
    .map((a) => `[char]34 + '${String(a).replace(/'/g, "''")}' + [char]34`)
    .join(" + ' ' + ")
}

/**
 * @param {object} msg
 */
function post(msg) {
  if (!socket) return
  try {
    socket.write(`${JSON.stringify(msg)}\n`)
  } catch {
    // 斷線由 close 處理
  }
}

/**
 * host 沒了：把所有工作階段收掉，順便讓使用者在終端機裡看到原因。
 * @param {string} reason
 */
function failAll(reason) {
  for (const [id, term] of [...terms]) {
    terms.delete(id)
    if (reason && term.onData) term.onData(`\r\n\x1b[31m${reason}\x1b[0m\r\n`)
    if (term.onExit) term.onExit({ exitCode: 1 })
  }
}

function cleanup() {
  if (connectTimer) {
    clearTimeout(connectTimer)
    connectTimer = null
  }
  try {
    socket?.destroy()
  } catch {
    // 已經斷了
  }
  socket = null
  try {
    server?.close()
  } catch {
    // 已經關了
  }
  server = null
  starting = null
  buf = ''
}

/**
 * @param {string} line
 */
function handleLine(line) {
  let msg = null
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg?.ev === 'ready') return
  const term = terms.get(typeof msg?.id === 'string' ? msg.id : '')
  if (!term) return
  if (msg.ev === 'data' && typeof msg.data === 'string') term.onData?.(msg.data)
  else if (msg.ev === 'exit') {
    terms.delete(msg.id)
    term.onExit?.({ exitCode: Number.isFinite(msg.code) ? msg.code : 0 })
  }
}

/**
 * 自己的執行檔與 app 路徑。開發模式跑的是 electron.exe，要另外帶 app 目錄。
 * @returns {{ execPath: string, appPath: string, isPackaged: boolean }}
 */
function hostEnv() {
  const { app } = require('electron')
  // 開發模式一律指專案根（有 package.json 的那一層），不用 app.getAppPath()——
  // 用 electron 直接跑單一腳本時它會是腳本所在的目錄，host 就載不到 main.js
  return {
    execPath: process.execPath,
    appPath: path.join(__dirname, '../../..'),
    isPackaged: app.isPackaged
  }
}

/**
 * 起一顆提權 host（已經有就直接沿用）。
 * @returns {Promise<void>}
 */
function ensureHost() {
  if (socket) return Promise.resolve()
  if (starting) return starting

  const env = hostEnv()
  const pipeName = `\\\\.\\pipe\\voiceink-term-${crypto.randomBytes(16).toString('hex')}`
  starting = new Promise((resolve, reject) => {
    const fail = (message) => {
      cleanup()
      reject(new Error(message))
    }

    server = net.createServer((conn) => {
      // 只收第一個連線：管道名就是密鑰，收完不再開門
      if (socket) {
        conn.destroy()
        return
      }
      socket = conn
      try {
        server?.close()
      } catch {
        // 已經關了
      }
      server = null
      if (connectTimer) {
        clearTimeout(connectTimer)
        connectTimer = null
      }
      conn.setEncoding('utf8')
      conn.on('data', (chunk) => {
        buf += chunk
        let idx
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx)
          buf = buf.slice(idx + 1)
          handleLine(line)
        }
        if (buf.length > MAX_BUFFER) buf = ''
      })
      conn.on('error', () => { /* 斷線由 close 處理 */ })
      conn.on('close', () => {
        socket = null
        starting = null
        buf = ''
        failAll('管理員終端機的背景程序已結束。')
      })
      starting = null
      resolve()
    })
    server.on('error', () => fail('無法建立管理員終端機的連線通道。'))

    server.listen(pipeName, () => {
      // Start-Process -Verb RunAs 才會彈 UAC；直接 spawn 只會拿到 ERROR_ELEVATION_REQUIRED。
      // 參數只有我們自己產生的管道名與自己的路徑，沒有任何 renderer 傳進來的字串。
      const args = env.isPackaged
        ? [`--terminal-admin-host=${pipeName}`]
        : [env.appPath, `--terminal-admin-host=${pipeName}`]
      let child
      try {
        child = spawn('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy', 'Bypass',
          '-Command',
          `Start-Process -FilePath '${env.execPath.replace(/'/g, "''")}' -ArgumentList (${psArgList(args)}) -Verb RunAs -WindowStyle Hidden`
        ], { windowsHide: true, stdio: 'ignore' })
      } catch {
        fail('無法啟動管理員終端機。')
        return
      }
      child.on('error', () => fail('無法啟動管理員終端機。'))
      child.on('close', (code) => {
        // 使用者在 UAC 按「否」時 Start-Process 會失敗；此時還沒有人連上來
        if (code !== 0 && !socket) fail('需要系統管理員權限，授權被取消了。')
      })
    })

    connectTimer = setTimeout(() => {
      if (socket) return
      fail('管理員終端機沒有回應。')
    }, CONNECT_TIMEOUT_MS)
  })
  return starting
}

/**
 * 開一個管理員工作階段，回傳一個「長得像 node-pty」的物件。
 *
 * 呼叫端是同步的（`pty.js` 的 spawnSession），而 UAC 要等使用者按，所以先把物件
 * 交回去、等 host 起來再補送 spawn；期間的輸入直接丟掉（shell 都還沒開）。
 *
 * @param {{ id: string, shell: string, cwd: string }} meta
 * @param {number} cols
 * @param {number} rows
 * @returns {{ onData: Function, onExit: Function, write: Function, resize: Function, kill: Function }}
 */
function spawnAdmin(meta, cols, rows) {
  /** @type {AdminTerm} */
  const term = { onData: null, onExit: null, meta, cols, rows, spawned: false }
  terms.set(meta.id, term)

  ensureHost().then(() => {
    if (terms.get(meta.id) !== term) return
    term.spawned = true
    term.onData?.('\x1b[90m已取得系統管理員權限。\x1b[0m\r\n')
    post({ op: 'spawn', id: meta.id, shell: meta.shell, cwd: meta.cwd, cols: term.cols, rows: term.rows })
  }, (err) => {
    if (terms.get(meta.id) !== term) return
    terms.delete(meta.id)
    term.onData?.(`\r\n\x1b[31m${err?.message || '無法啟動管理員終端機。'}\x1b[0m\r\n`)
    term.onExit?.({ exitCode: 1 })
  })

  return {
    onData(fn) { term.onData = fn },
    onExit(fn) { term.onExit = fn },
    write(data) {
      if (term.spawned) post({ op: 'write', id: meta.id, data })
    },
    resize(c, r) {
      term.cols = c
      term.rows = r
      if (term.spawned) post({ op: 'resize', id: meta.id, cols: c, rows: r })
    },
    kill() {
      if (term.spawned) post({ op: 'kill', id: meta.id })
      else {
        terms.delete(meta.id)
        term.onExit?.({ exitCode: 0 })
      }
    }
  }
}

/** `before-quit` 要呼叫：斷線之後 host 自己會把提權的 shell 收乾淨再結束 */
function shutdown() {
  terms.clear()
  cleanup()
}

module.exports = { spawnAdmin, shutdown, psArgList, _terms: terms }
