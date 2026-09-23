/**
 * 打包版 CDP：終端機的複製與 OSC 8 超連結（`node scripts/e2e-terminal-copy-cdp.js`）
 *
 * 在一般的 PowerShell（不是 AI CLI）裡用**真的滑鼠事件**選字，量的是 main 的剪貼簿：
 *  [A] 拖曳選取就複製（放開滑鼠那一下）
 *  [B] 有選取時 Ctrl+C＝複製，不送 ^C 給 shell，選取收掉
 *  [C] 沒選取時 Ctrl+C 照舊送 ^C（中斷不能被吃掉）
 *  [D] 有選取時右鍵＝複製，不貼上；沒選取時右鍵＝貼上
 *  [E] CLI 用 OSC 8 送的網址點下去：不跳 window.confirm、直接開內建瀏覽器分頁
 *
 * 剪貼簿是使用者的：開頭存起來，收尾放回去。暫存 user-data-dir，只殺自己 spawn 的那棵程序樹。
 * 用 VOICEINK_EXE 指到舊版（例如安裝版）跑一次，確認修之前是紅的。
 */
const { spawn, execFileSync } = require('child_process')
const path = require('path')
const { tempDir, removeTree } = require('./lib/test-temp')
const http = require('http')
const os = require('os')
const fs = require('fs')

const PORT = 9253
/** main 程序的 inspector：剪貼簿只能從那邊寫（renderer 的 navigator.clipboard 在沒有
 *  焦點的隱藏視窗上會被 Chromium 擋掉：Document is not focused） */
const MAIN_PORT = 9254
// Windows 偶爾會有別的東西鎖住 dist/win-unpacked（打包失敗、防毒掃描中），
// 這時可以打包到別的資料夾再用 VOICEINK_EXE 指過去，測試不必等鎖放掉
const EXE = process.env.VOICEINK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
const USER_DATA_DIR = tempDir('voiceink-e2e-terminal-')
fs.writeFileSync(path.join(USER_DATA_DIR, 'config.json'), JSON.stringify({ sysmonSensors: false }))
const PROJECT_DIR = path.join(USER_DATA_DIR, 'project')
fs.mkdirSync(PROJECT_DIR)
fs.mkdirSync(path.join(USER_DATA_DIR, 'other-project'))
fs.writeFileSync(path.join(USER_DATA_DIR, 'workspaces.json'), JSON.stringify({
  projects: [
    { id: 'w_status_test', name: '狀態測試', path: PROJECT_DIR, createdAt: Date.now() },
    { id: 'w_status_other', name: '另一個專案', path: path.join(USER_DATA_DIR, 'other-project'), createdAt: Date.now() }
  ]
}))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => {
        try { resolve(JSON.parse(d)) } catch (e) { reject(e) }
      })
    }).on('error', reject)
  })
}

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.ws = null
    this.id = 0
    this.pending = new Map()
  }
  async connect() {
    this.ws = new globalThis.WebSocket(this.wsUrl)
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res)
      this.ws.addEventListener('error', rej)
    })
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      }
    })
    this.ws.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('CDP 連線已關閉'))
      this.pending.clear()
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true
    })
    if (r.exceptionDetails) {
      const d = r.exceptionDetails
      throw new Error(d.exception?.description || d.exception?.value || d.text || 'eval error')
    }
    return r.result?.value
  }
  close() { try { this.ws.close() } catch { /* 已斷線 */ } }
}

async function waitTargets(timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json/list`)
      const pages = list.filter((t) => t.type === 'page')
      if (pages.length) return pages
    } catch { /* 還沒起來 */ }
    await sleep(400)
  }
  throw new Error('timeout waiting for CDP targets')
}

function stopTestApp(child) {
  if (!child?.pid) return
  try {
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } catch { /* 程序已結束 */ }
}

/**
 * 在頁面裡等一個條件成立。
 * @param {Cdp} cdp
 * @param {string} expression 回傳布林的表達式
 */
async function waitInPage(cdp, expression, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cdp.eval(`(() => { try { return !!(${expression}) } catch { return false } })()`)) return true
    await sleep(300)
  }
  return false
}

async function main() {
  const results = []
  const ok = (name, pass, detail = '') => {
    results.push(!!pass)
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  }
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`, `--inspect=127.0.0.1:${MAIN_PORT}`,
    `--user-data-dir=${USER_DATA_DIR}`, '--hidden', '--disable-backgrounding-occluded-windows'], { stdio: 'ignore' })
  let cdp = null
  let mainCdp = null
  let createdId = ''
  let savedClipboard = null
  const clip = `process.mainModule.require('electron').clipboard`
  try {
    const pages = await waitTargets()
    const mainPage = pages.find((p) => /index\.html/i.test(p.url)) || pages[0]
    cdp = new Cdp(mainPage.webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    // 原生彈窗（window.confirm 那種）一跳出來就記下並關掉，不然整個 renderer 卡住
    const dialogs = []
    cdp.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.method === 'Page.javascriptDialogOpening') {
        dialogs.push(msg.params.message)
        void cdp.send('Page.handleJavaScriptDialog', { accept: false })
      }
    })
    const mainTarget = await (async () => {
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        try {
          const list = await getJson(`http://127.0.0.1:${MAIN_PORT}/json/list`)
          if (list[0]?.webSocketDebuggerUrl) return list[0]
        } catch { /* 還沒起來 */ }
        await sleep(400)
      }
      throw new Error('連不上 main 程序 inspector')
    })()
    mainCdp = new Cdp(mainTarget.webSocketDebuggerUrl)
    await mainCdp.connect()
    savedClipboard = await mainCdp.eval(`${clip}.readText()`)
    const readClip = () => mainCdp.eval(`${clip}.readText()`)
    const writeClip = (text) => mainCdp.eval(`${clip}.writeText(${JSON.stringify(text)})`)
    await sleep(1200)

    await cdp.eval(`(async () => {
      const { Terminal } = await import('../../node_modules/@xterm/xterm/lib/xterm.mjs')
      const open = Terminal.prototype.open
      Terminal.prototype.open = function (...args) { window.__t = this; return open.apply(this, args) }
    })()`)
    await cdp.eval(`document.querySelector('.nav-tab[data-page="chat"]').click()`)
    await cdp.eval(`document.getElementById('sidebarModeProjects').click()`)
    await waitInPage(cdp, `!!document.querySelector('#projList [data-id="w_status_test"]')`)
    await cdp.eval(`document.querySelector('#projList [data-id="w_status_test"] .chat-list-open').click()`)
    await sleep(1000)
    await cdp.eval(`(async () => {
      document.getElementById('wsNewBtn').click()
      await new Promise((r) => setTimeout(r, 300))
      ;[...document.querySelectorAll('.ws-new-item')].find((b) => b.textContent.trim() === '終端機').click()
    })()`)
    const promptExpr = `window.__t && /PS /.test([...Array(10)].map((_, i) => window.__t.buffer.active.getLine(i)?.translateToString(true) || '').join(' '))`
    ok('一般 PowerShell 開起來了', await waitInPage(cdp, promptExpr, 120000))
    createdId = await cdp.eval(`(async () => { const l = await window.electronAPI.terminal.list(); return l.data[l.data.length - 1].id })()`)

    const NEEDLE = 'COPY-NEEDLE-' + Date.now()
    await cdp.eval(`window.__t.input(${JSON.stringify(`echo ${NEEDLE}`)} + String.fromCharCode(13))`)
    await waitInPage(cdp, `[...Array(30)].some((_, i) => (window.__t.buffer.active.getLine(i)?.translateToString(true) || '').startsWith(${JSON.stringify(NEEDLE)}))`, 20000)
    const geo = await cdp.eval(`(() => {
      const t = window.__t
      const b = t.buffer.active
      let row = -1
      for (let i = 0; i < t.rows; i++) {
        if ((b.getLine(b.viewportY + i)?.translateToString(true) || '').startsWith(${JSON.stringify(NEEDLE)})) row = i
      }
      const r = t.element.querySelector('.xterm-screen').getBoundingClientRect()
      const cell = t._core._renderService.dimensions.css.cell
      return { row, left: r.left, top: r.top, cw: cell.width, ch: cell.height }
    })()`)
    const at = (col, row = geo.row) => ({ x: geo.left + (col + 0.5) * geo.cw, y: geo.top + (row + 0.5) * geo.ch })
    const mouse = (type, p, extra = {}) => cdp.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, ...extra })
    const drag = async (fromCol, toCol) => {
      const a = at(fromCol)
      const b = at(toCol)
      await mouse('mousePressed', { x: a.x - geo.cw * 0.4, y: a.y }, { button: 'left', buttons: 1, clickCount: 1 })
      for (let i = 1; i <= 5; i++) {
        await mouse('mouseMoved', { x: a.x + (b.x - a.x) * i / 5, y: a.y }, { button: 'left', buttons: 1 })
        await sleep(30)
      }
      await mouse('mouseReleased', b, { button: 'left', buttons: 0, clickCount: 1 })
      await sleep(300)
    }
    const want = NEEDLE.slice(0, 10)

    // [A] 拖曳選取就複製
    await writeClip('before-A')
    await drag(0, 10)
    const selA = await cdp.eval('window.__t.getSelection()')
    ok('[A] 拖曳真的選得起來', selA === want, JSON.stringify(selA))
    const clipA = await readClip()
    ok('[A] 放開滑鼠就進剪貼簿', clipA === want, JSON.stringify(clipA))

    // [B] 有選取時 Ctrl+C＝複製，不送 ^C
    await drag(0, 10)
    await writeClip('before-B')
    const ctrlC = () => cdp.eval(`(() => {
      const t = window.__t
      const sent = []
      const sub = t.onData((d) => sent.push(d))
      const opts = { key: 'c', code: 'KeyC', keyCode: 67, which: 67, ctrlKey: true, bubbles: true, cancelable: true }
      t.textarea.focus()
      t.textarea.dispatchEvent(new KeyboardEvent('keydown', opts))
      t.textarea.dispatchEvent(new KeyboardEvent('keyup', opts))
      sub.dispose()
      return { sent, has: t.hasSelection() }
    })()`)
    const b = await ctrlC()
    await sleep(300)
    ok('[B] 有選取的 Ctrl+C 不送 ^C', !b.sent.includes('\x03'), JSON.stringify(b))
    const clipB = await readClip()
    ok('[B] 有選取的 Ctrl+C 會複製', clipB === want, JSON.stringify(clipB))
    ok('[B] 複製完選取收掉', b.has === false, JSON.stringify(b))

    // [C] 沒選取時 Ctrl+C 照舊中斷
    await cdp.eval('window.__t.clearSelection()')
    const c = await ctrlC()
    ok('[C] 沒選取的 Ctrl+C 送 ^C', c.sent.includes('\x03'), JSON.stringify(c))
    await sleep(500)

    // [D] 右鍵：有選取＝複製，沒選取＝貼上
    const rightClick = async () => {
      await cdp.eval(`window.__sent = []; window.__sub = window.__t.onData((d) => window.__sent.push(d)); 0`)
      const p = at(4)
      await mouse('mousePressed', p, { button: 'right', buttons: 2, clickCount: 1 })
      await mouse('mouseReleased', p, { button: 'right', buttons: 0, clickCount: 1 })
      await sleep(700)
      return (await cdp.eval(`(() => { window.__sub.dispose(); return window.__sent })()`)).join('')
    }
    await drag(0, 10)
    await writeClip('PASTE-ME')
    const pastedWithSelection = await rightClick()
    ok('[D] 有選取時右鍵不貼上', !pastedWithSelection.includes('PASTE-ME'), JSON.stringify(pastedWithSelection))
    const clipD = await readClip()
    ok('[D] 有選取時右鍵＝複製', clipD === want, JSON.stringify(clipD))
    await cdp.eval('window.__t.clearSelection()')
    await writeClip('PASTE-ME')
    const pastedWithout = await rightClick()
    ok('[D] 沒選取時右鍵＝貼上', pastedWithout.includes('PASTE-ME'), JSON.stringify(pastedWithout))
    // 貼進提示字元的字清掉（Esc 清掉 PSReadLine 那一行）
    await cdp.eval(`window.__t.input(String.fromCharCode(27))`)
    await sleep(300)

    // [E] OSC 8 超連結：xterm 預設會先 confirm() 再 window.open()
    const tabsBefore = await cdp.eval(`document.querySelectorAll('.ws-tab[data-kind="browser"]').length`)
    await cdp.eval(`window.__confirms = 0; window.confirm = () => { window.__confirms += 1; return false }; 0`)
    await cdp.eval(`new Promise((r) => {
      const ESC = String.fromCharCode(27)
      const BEL = String.fromCharCode(7)
      const NL = String.fromCharCode(13, 10)
      window.__t.write(NL + ESC + ']8;;http://127.0.0.1:9/osc8-test' + BEL + 'OSC8LINK' + ESC + ']8;;' + BEL + NL, r)
    })`)
    const linkRow = await cdp.eval(`(() => {
      const t = window.__t
      const b = t.buffer.active
      for (let i = t.rows - 1; i >= 0; i--) {
        if ((b.getLine(b.viewportY + i)?.translateToString(true) || '').startsWith('OSC8LINK')) return i
      }
      return -1
    })()`)
    const lp = at(3, linkRow)
    await mouse('mouseMoved', { x: lp.x - 3, y: lp.y })
    await sleep(200)
    await mouse('mouseMoved', lp)
    await sleep(400)
    await mouse('mousePressed', lp, { button: 'left', buttons: 1, clickCount: 1 })
    await mouse('mouseReleased', lp, { button: 'left', buttons: 0, clickCount: 1 })
    const opened = await waitInPage(cdp, `document.querySelectorAll('.ws-tab[data-kind="browser"]').length > ${tabsBefore}`, 5000)
    const confirms = await cdp.eval('window.__confirms')
    ok('[E] OSC 8 連結不跳確認視窗', linkRow >= 0 && confirms === 0 && dialogs.length === 0, JSON.stringify({ confirms, dialogs, linkRow }))
    ok('[E] OSC 8 連結直接開內建瀏覽器分頁', opened)
  } catch (error) {
    ok('執行過程沒有例外', false, error.message)
  } finally {
    try { if (createdId && cdp) await cdp.eval(`window.electronAPI.terminal.delete(${JSON.stringify(createdId)})`) } catch { /* 已斷線 */ }
    try { if (mainCdp && savedClipboard !== null) await mainCdp.eval(`${clip}.writeText(${JSON.stringify(savedClipboard)})`) } catch { /* 已斷線 */ }
    mainCdp?.close()
    cdp?.close()
    stopTestApp(child)
    await sleep(800)
    try { removeTree(USER_DATA_DIR) } catch { /* 程序結束時 test-temp 會再清 */ }
  }
  const failed = results.filter((pass) => !pass).length
  console.log(`\n${results.length - failed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main()
