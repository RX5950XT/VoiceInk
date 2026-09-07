/**
 * 打包版 CDP 探針：終端機右鍵貼上只能送出一次。
 *
 * 用法：node scripts/probe-terminal-paste.js
 */
const { spawn, execFileSync } = require('child_process')
const path = require('path')
const http = require('http')
const os = require('os')
const fs = require('fs')

const PORT = 9251
const BRACKETED = process.env.PROBE_BRACKETED === '1'
const SELECTED = process.env.PROBE_SELECTED === '1'
const ON_TEXTAREA = process.env.PROBE_ON_TEXTAREA === '1'
const CLI = process.env.PROBE_CLI === '1'
const MOUSE = process.env.PROBE_MOUSE !== '0'
const REAL_CLI = process.env.PROBE_REAL_CLI || ''
const DROP = process.env.PROBE_DROP === '1'
const PASTE_TEXT = process.env.PROBE_LONG === '1' ? 'PASTEPROBE-' + 'x'.repeat(180) : 'PASTEPROBE'
const EXE = process.env.VOICEINK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
const USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-probe-paste-'))
fs.writeFileSync(path.join(USER_DATA_DIR, 'config.json'), JSON.stringify({ sysmonSensors: false }))
const PROJECT_DIR = path.join(USER_DATA_DIR, 'project')
fs.mkdirSync(PROJECT_DIR)
const dropFiles = [path.join(PROJECT_DIR, 'PASTEPROBE 圖片.png'), path.join(PROJECT_DIR, "文字 it's.txt")]
if (DROP) for (const file of dropFiles) fs.writeFileSync(file, '')
fs.writeFileSync(path.join(USER_DATA_DIR, 'workspaces.json'), JSON.stringify({
  projects: [{ id: 'w_paste', name: '貼上測試', path: process.env.PROBE_PROJECT_DIR || PROJECT_DIR, createdAt: Date.now() }]
}))

const ESC = String.fromCharCode(27)
// 模擬 AI CLI（Ink）：自己開 bracketed paste，然後把收到的每一段 stdin 原樣印出來
fs.writeFileSync(path.join(PROJECT_DIR, 'echo-stdin.js'), [
  // 跟 Claude Code／Codex 一樣：開 bracketed paste ＋ SGR 滑鼠回報
  "process.stdout.write('" + ESC + "[?2004h' + '" + ESC + "[?1000h' + '" + ESC + "[?1006h')",
  'process.stdin.setRawMode(true)',
  "process.stdin.on('data', (d) => {",
  "  const s = d.toString('utf8')",
  "  if (s === String.fromCharCode(3)) process.exit(0)",
  "  process.stdout.write('CHUNK' + JSON.stringify(s) + String.fromCharCode(13) + String.fromCharCode(10))",
  '})'
].join(String.fromCharCode(10)))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => { try { resolve(JSON.parse(d)) } catch (e) { reject(e) } })
    }).on('error', reject)
  })
}

class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map() }
  async connect() {
    this.ws = new globalThis.WebSocket(this.wsUrl)
    await new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej) })
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result?.value
  }
  close() { try { this.ws.close() } catch { /* 已斷線 */ } }
}

async function waitTargets(timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const pages = (await getJson(`http://127.0.0.1:${PORT}/json/list`)).filter((t) => t.type === 'page')
      if (pages.length) return pages
    } catch { /* 還沒起來 */ }
    await sleep(400)
  }
  throw new Error('timeout waiting for CDP targets')
}

async function waitInPage(cdp, expression, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cdp.eval(`(() => { try { return !!(${expression}) } catch { return false } })()`)) return true
    await sleep(300)
  }
  return false
}

async function main() {
  const child = spawn(EXE, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA_DIR}`, '--hidden',
    '--disable-backgrounding-occluded-windows'
  ], { stdio: 'ignore' })
  let cdp = null
  let createdId = ''
  let pass = false
  try {
    const pages = await waitTargets()
    const mainPage = pages.find((p) => /index\.html/i.test(p.url)) || pages[0]
    cdp = new Cdp(mainPage.webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Runtime.enable')
    await sleep(1200)
    await cdp.eval('window.electronAPI.window.minimize()')
    await cdp.eval(`(async () => {
      const { Terminal } = await import('../../node_modules/@xterm/xterm/lib/xterm.mjs')
      const originalOpen = Terminal.prototype.open
      Terminal.prototype.open = function (...args) {
        window.__probeTerm = this
        return originalOpen.apply(this, args)
      }
    })()`)
    await cdp.eval(`document.querySelector('.nav-tab[data-page="chat"]').click()`)
    await waitInPage(cdp, `!!document.getElementById('wsTabStrip')`)
    await cdp.eval(`document.getElementById('sidebarModeProjects').click()`)
    await waitInPage(cdp, `!!document.querySelector('#projList [data-id="w_paste"]')`)
    await cdp.eval(`document.querySelector('#projList [data-id="w_paste"] .chat-list-open').click()`)
    await sleep(1000)
    await cdp.eval(`(async () => {
      document.getElementById('wsNewBtn').click()
      await new Promise((r) => setTimeout(r, 300))
      document.getElementById('wsNewCustomTerm').click()
      await new Promise((r) => setTimeout(r, 400))
      document.getElementById('termNewCreateBtn').click()
      await new Promise((r) => setTimeout(r, 2500))
    })()`)
    createdId = await cdp.eval(`(async () => {
      const list = await window.electronAPI.terminal.list()
      return list.data[list.data.length - 1].id
    })()`)
    if (REAL_CLI) {
      // 真的開一個 AI CLI 的 REPL（不送出任何訊息，只貼上）
      await cdp.eval(`window.electronAPI.terminal.write(${JSON.stringify(createdId)}, ${JSON.stringify(REAL_CLI)} + String.fromCharCode(13))`)
      await sleep(20000)
      // Claude Code 會把上一次沒送出的草稿留在輸入框：先 Esc 清掉，才數得準
      await cdp.eval(`window.electronAPI.terminal.write(${JSON.stringify(createdId)}, String.fromCharCode(27))`)
      await sleep(1500)
    }
    if (CLI) {
      await cdp.eval(`window.electronAPI.terminal.write(${JSON.stringify(createdId)}, 'node echo-stdin.js' + String.fromCharCode(13))`)
      await sleep(3000)
    }
    const box = await cdp.eval(`(() => {
      const BRACKETED = ${BRACKETED}
      const SELECTED = ${SELECTED}
      const ON_TEXTAREA = ${ON_TEXTAREA}
      const MOUSE = ${MOUSE}
      const PASTE_TEXT = ${JSON.stringify(PASTE_TEXT)}
      const pane = document.querySelector('.term-pane')
      window.__probeWrites = []
      window.__probeSub = window.__probeTerm.onData((d) => window.__probeWrites.push(d))
      window.__probeReads = 0
      navigator.clipboard.readText = async () => { window.__probeReads += 1; return PASTE_TEXT }
      // 真實情境：PSReadLine／AI CLI 會開 bracketed paste（DECSET 2004）
      if (BRACKETED) window.__probeTerm.write('\x1b[?2004h')
      // AI CLI（Claude Code／Codex）會開 SGR 滑鼠回報，右鍵就會被轉給它
      if (MOUSE) window.__probeTerm.write('\x1b[?1000h' + '\x1b[?1006h')
      window.__probeTerm.focus()
      window.__probeModes = () => JSON.stringify(window.__probeTerm.modes)
      // 真實情境：使用者常常是「選了字（順手複製）之後才右鍵貼上」
      if (SELECTED) window.__probeTerm.select(0, 0, 5)
      // 輸入法對位後，那個隱形 textarea 就疊在游標上——真實的右鍵常常正好點在它身上
      const target = ON_TEXTAREA ? window.__probeTerm.textarea : pane
      const r = target.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), rect: [r.left, r.top, r.width, r.height] }
    })()`)
    await sleep(600)
    if (DROP) {
      for (const type of ['dragEnter', 'dragOver', 'drop']) {
        await cdp.send('Input.dispatchDragEvent', {
          type, x: box.x, y: box.y, data: { items: [], files: dropFiles, dragOperationsMask: 1 }
        })
      }
    } else for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', {
        type, x: box.x, y: box.y, button: 'right', buttons: type === 'mousePressed' ? 2 : 0, clickCount: 1
      })
    }
    await sleep(3000)
    // 右鍵之後鍵盤還要能打得進去（攔滑鼠事件不可以把焦點弄丟）
    await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: 'z' })
    await sleep(500)
    const out = await cdp.eval(`(() => {
      window.__probeSub.dispose()
      const buf = window.__probeTerm.buffer.active
      let screen = ''
      for (let i = 0; i < buf.length; i += 1) screen += buf.getLine(i).translateToString(true) + ' '
      return {
        writes: window.__probeWrites, reads: window.__probeReads,
        hits: (screen.match(/PASTEPROBE/g) || []).length,
        tail: screen.slice(-600),
        chunks: (screen.match(/CHUNK/g) || []).length,
        textarea: window.__probeTerm.textarea.value,
        modes: window.__probeModes()
      }
    })()`)
    const typed = out.writes.includes('z')
    const pasteWrites = out.writes.filter((w) => String(w).includes('PASTEPROBE'))
    // 右鍵屬於終端機（貼上），不可以同時當成滑鼠事件送給 CLI——
    // AI CLI 收到右鍵會自己再貼一次系統剪貼簿，使用者看到的就是貼了兩份
    const mouseReports = out.writes.filter((w) => /\x1b\[</.test(String(w)))
    const expectedDrop = dropFiles.map(p => `'${p.replace(/'/g, "''")}'`).join(' ') + ' '
    pass = out.reads === (DROP ? 0 : 1) && pasteWrites.length === 1 && mouseReports.length === 0 && typed
      && (!DROP || pasteWrites[0].replace(/\x1b\[(200|201)~/g, '') === expectedDrop)
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${DROP ? '圖片與多檔拖入路徑' : '右鍵貼上'}只送一次、鍵盤還在 — ${JSON.stringify(out)}`)
  } finally {
    if (createdId && cdp) { try { await cdp.eval(`window.electronAPI.terminal.forget(${JSON.stringify(createdId)})`) } catch { /* 已收掉 */ } }
    cdp?.close()
    if (child.pid) { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 已結束 */ } }
    try { fs.rmSync(USER_DATA_DIR, { recursive: true, force: true }) } catch { /* 佔用中 */ }
  }
  process.exit(pass ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
