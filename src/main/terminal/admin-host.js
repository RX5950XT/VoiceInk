'use strict'

/**
 * 管理員終端機的提權宿主（Host）。
 *
 * 跑的是**同一支 VoiceInk.exe**，只是帶了 `--terminal-admin-host=<管道名>`：
 * main.js 開頭看到這個旗標就直接進來這裡，不建視窗、不搶 single instance lock、
 * 不註冊任何 IPC。
 *
 * 為什麼要另外一顆程序：Windows 的 ConPTY 沒有「提權」這個選項，CreateProcess 一律
 * 繼承呼叫者的 token；要拿到管理員 token 只能走 ShellExecute 的 `runas`（UAC），
 * 而那條路又沒辦法把 pty 的 handle 交接過去。所以只能讓提權的那份自己開 pty，
 * 再把位元組透過具名管道轉回來。
 *
 * 一顆 host 服務所有管理員工作階段（UAC 只跳一次）；主程序斷線就把 shell 全部收掉
 * 再自己結束——留一顆管理員 shell 在背景沒人看是最糟的結果。
 *
 * **信任邊界**：管道名是 128-bit 亂數，而且對面送過來的東西一律重新收斂
 * （shell 只認 key、cwd 一定要是存在的目錄），host 不會照著執行任意路徑。
 */

const net = require('net')
const store = require('./store')

/** 累積到這麼多還沒看到換行就丟掉（正常一行遠小於此） */
const MAX_BUFFER = 1024 * 1024

/**
 * @param {string} pipeName 主程序建好的具名管道
 */
function run(pipeName) {
  if (typeof pipeName !== 'string' || !pipeName.startsWith('\\\\.\\pipe\\')) {
    process.exit(1)
    return
  }
  const pty = require('@lydell/node-pty')
  const { shellCommand, _clampDim: clampDim } = require('./pty')

  /** @type {Map<string, import('@lydell/node-pty').IPty>} */
  const terms = new Map()
  let buf = ''

  const socket = net.connect(pipeName)
  socket.setEncoding('utf8')

  /** @param {object} msg */
  const send = (msg) => {
    try {
      socket.write(`${JSON.stringify(msg)}\n`)
    } catch {
      // 對面已經走了；close 會收尾
    }
  }

  const bye = () => {
    for (const term of terms.values()) {
      try {
        term.kill()
      } catch {
        // 已經死了
      }
    }
    terms.clear()
    process.exit(0)
  }

  /** @param {any} msg */
  const handle = (msg) => {
    const id = typeof msg?.id === 'string' ? msg.id : ''
    if (!id) return
    if (msg.op === 'spawn') {
      if (terms.has(id) || terms.size >= store.MAX_SESSIONS) return
      const { exe, args } = shellCommand(store.normalizeShell(msg.shell))
      let term
      try {
        term = pty.spawn(exe, args, {
          name: 'xterm-256color',
          cols: clampDim(msg.cols, 1000, 80),
          rows: clampDim(msg.rows, 500, 24),
          cwd: store.normalizeCwd(msg.cwd),
          env: { ...process.env, TERM: 'xterm-256color' }
        })
      } catch {
        send({ ev: 'exit', id, code: 1 })
        return
      }
      terms.set(id, term)
      term.onData((data) => send({ ev: 'data', id, data }))
      term.onExit(({ exitCode }) => {
        terms.delete(id)
        send({ ev: 'exit', id, code: exitCode })
      })
      return
    }
    const term = terms.get(id)
    if (!term) return
    try {
      if (msg.op === 'write' && typeof msg.data === 'string') term.write(msg.data)
      else if (msg.op === 'resize') term.resize(clampDim(msg.cols, 1000, 80), clampDim(msg.rows, 500, 24))
      else if (msg.op === 'kill') term.kill()
    } catch {
      // pty 剛好在這瞬間結束；onExit 會通知對面
    }
  }

  socket.on('connect', () => send({ ev: 'ready' }))
  socket.on('data', (chunk) => {
    buf += chunk
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      let msg = null
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      handle(msg)
    }
    if (buf.length > MAX_BUFFER) buf = ''
  })
  socket.on('error', bye)
  socket.on('close', bye)
}

module.exports = { run }
