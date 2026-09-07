/**
 * 打包版 CDP 實測：終端機的輸入法組字。
 *
 * mock 證明不了輸入法長什麼樣子——這支走真的 Chromium 輸入法路徑
 * （CDP 的 `Input.imeSetComposition`，跟注音在打字時送的是同一條），
 * 然後量三件事：
 *
 *  [A] 組字中的字有沒有**畫在游標那一格**（`.composition-view`）——
 *      沒有的話，使用者看到的中文就會跑到系統自己畫的那個小框裡（螢幕右下角）。
 *  [B] 那個隱形 `<textarea>` 在不在游標上——候選字視窗的位置是 OS 依它算的，
 *      留在 `left: -9999em` 就會被夾到螢幕角落。
 *  [C] 組完字（commit）之後，字有沒有真的送進 pty。
 *
 * 用法：node scripts/probe-terminal-ime.js
 *      VOICEINK_EXE=... node scripts/probe-terminal-ime.js
 */
const { spawn, execFileSync } = require('child_process')
const path = require('path')
const http = require('http')
const os = require('os')
const fs = require('fs')

const PORT = 9251
const EXE = process.env.VOICEINK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
const USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-probe-ime-'))
fs.writeFileSync(path.join(USER_DATA_DIR, 'config.json'), JSON.stringify({ sysmonSensors: false }))
const PROJECT_DIR = path.join(USER_DATA_DIR, 'project')
fs.mkdirSync(PROJECT_DIR)
fs.writeFileSync(path.join(USER_DATA_DIR, 'workspaces.json'), JSON.stringify({
  projects: [{ id: 'w_ime_probe', name: '輸入法測試', path: PROJECT_DIR, createdAt: Date.now() }]
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
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) {
      const d = r.exceptionDetails
      throw new Error(d.exception?.description || d.exception?.value || d.text || 'eval error')
    }
    return r.result?.value
  }
  close() { try { this.ws.close() } catch { /* 已斷線 */ } }
}

async function waitTargets(timeoutMs = 40000) {
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

/** 游標那一格現在畫在視窗的哪裡（用來對答案） */
const CARET_CELL = `(() => {
  const pane = document.querySelector('.term-pane.is-active')
  const screen = pane?.querySelector('.xterm-screen')
  const term = window.__testTerminals?.get(pane?.dataset.id)
  if (!screen || !term) return null
  const box = screen.getBoundingClientRect()
  const cellW = screen.clientWidth / term.cols
  const cellH = screen.clientHeight / term.rows
  const b = term.buffer.active
  return {
    x: box.left + Math.min(b.cursorX, term.cols - 1) * cellW,
    y: box.top + b.cursorY * cellH,
    cellW, cellH
  }
})()`

async function main() {
  const results = []
  const ok = (name, pass, detail = '') => {
    results.push({ name, pass: !!pass })
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  }

  const child = spawn(EXE, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DATA_DIR}`,
    // 不搶使用者的焦點：整支測試都在背景視窗裡跑（CDP 的輸入法事件不需要 OS 焦點）
    '--hidden',
    '--disable-backgrounding-occluded-windows'
  ], { stdio: 'ignore' })
  let cdp = null
  let createdId = ''

  try {
    const pages = await waitTargets()
    const mainPage = pages.find((p) => /index\.html/i.test(p.url)) || pages[0]
    cdp = new Cdp(mainPage.webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Runtime.enable')
    await cdp.eval(`(() => {
      window.__probeErrors = []
      window.addEventListener('error', (e) => window.__probeErrors.push(String(e.message)))
      window.addEventListener('unhandledrejection', (e) => window.__probeErrors.push('reject: ' + String(e.reason && e.reason.message || e.reason)))
    })()`)
    await sleep(1500)

    await cdp.eval(`(async () => {
      const { Terminal } = await import('../../node_modules/@xterm/xterm/lib/xterm.mjs')
      const originalOpen = Terminal.prototype.open
      Terminal.prototype.open = function (...args) {
        window.__testTerminals ||= new Map()
        window.__testTerminals.set(args[0].dataset.id, this)
        return originalOpen.apply(this, args)
      }
    })()`)

    await cdp.eval(`document.querySelector('.nav-tab[data-page="chat"]').click()`)
    await waitInPage(cdp, `!!document.getElementById('wsTabStrip')`)
    await cdp.eval(`document.getElementById('sidebarModeProjects').click()`)
    await waitInPage(cdp, `!!document.querySelector('#projList [data-id="w_ime_probe"] .chat-list-open')`)
    await cdp.eval(`document.querySelector('#projList [data-id="w_ime_probe"] .chat-list-open').click()`)
    await sleep(800)

    const created = await cdp.eval(`(async () => {
      const r = await window.electronAPI.terminal.create({ preset: 'shell', cwd: ${JSON.stringify(PROJECT_DIR)}, projectId: 'w_ime_probe' })
      return r.ok ? r.data : null
    })()`)
    if (!created) throw new Error('建立終端機失敗')
    createdId = created.id
    await cdp.eval(`import('./scripts/terminal-page.js').then((m) => m.openTerminalSession(${JSON.stringify(createdId)}))`)
    // 第一次跑會先把終端機宿主的執行環境（248MB）複製到 userData，暫存 userData 每次都要重來
    const drawn = await waitInPage(cdp, `!!document.querySelector('.term-pane.is-active .xterm-screen')`, 90000)
    ok('終端機畫出來了', drawn,
      drawn ? '' : String(await cdp.eval(`document.getElementById('termError')?.textContent || '(termError 空的)'`)))
    if (!drawn) {
      console.log('診斷：', await cdp.eval(`JSON.stringify({
        strip: !!document.getElementById('wsTabStrip'),
        panes: document.querySelectorAll('.term-pane').length,
        tabs: [...document.querySelectorAll('.ws-tab')].map((t) => t.dataset.id),
        errors: window.__probeErrors || []
      })`))
      throw new Error('終端機沒開起來，後面的量測沒有意義')
    }
    // 等提示字元落地，游標才會停在一個有意義的位置
    await sleep(4000)

    await cdp.eval(`document.querySelector('.term-pane.is-active .xterm-helper-textarea').focus()`)
    await sleep(400)

    const beforeCaret = await cdp.eval(`JSON.stringify({
      caret: ${CARET_CELL},
      area: document.querySelector('.term-pane.is-active .xterm-helper-textarea').getBoundingClientRect().toJSON()
    })`)
    const before = JSON.parse(String(beforeCaret))
    const paint = JSON.parse(String(await cdp.eval(`JSON.stringify((() => {
      const cs = getComputedStyle(document.querySelector('.term-pane.is-active .xterm-helper-textarea'))
      return { opacity: cs.opacity, color: cs.color, bg: cs.backgroundColor, caret: cs.caretColor }
    })())`)))
    // `opacity: 0` 的東西不會被畫，Windows 就問不到游標方框，組字視窗會掉到視窗右下角。
    // 所以要「照樣看不見、但確實被畫」：opacity 留 1，靠透明的文字／底色藏起來。
    ok('[B] 隱形輸入框是被畫出來的（不是 opacity:0），底色與文字都透明',
      paint.opacity === '1' && /rgba\(0, 0, 0, 0\)|transparent/.test(paint.bg)
        && /rgba\(0, 0, 0, 0\)|transparent/.test(paint.color),
      JSON.stringify(paint))
    const offBefore = Math.hypot(before.area.left - before.caret.x, before.area.top - before.caret.y)
    ok('[B] 還沒開始組字，隱形輸入框就已經在游標上（候選字視窗的位置靠它）',
      offBefore <= Math.max(before.caret.cellW, before.caret.cellH) + 2,
      `偏移 ${offBefore.toFixed(1)}px，area=${before.area.left.toFixed(0)},${before.area.top.toFixed(0)} caret=${before.caret.x.toFixed(0)},${before.caret.y.toFixed(0)}`)

    // 真的送一次 IME 組字（注音打「ㄓㄨˋ」時 Chromium 收到的就是這個）
    await cdp.send('Input.imeSetComposition', {
      text: '注音', selectionStart: 2, selectionEnd: 2
    })
    await sleep(600)

    const during = JSON.parse(String(await cdp.eval(`JSON.stringify((() => {
      const view = document.querySelector('.term-pane.is-active .composition-view')
      const area = document.querySelector('.term-pane.is-active .xterm-helper-textarea')
      const cs = view ? getComputedStyle(view) : null
      return {
        caret: ${CARET_CELL},
        text: view?.textContent || '',
        active: !!view?.classList.contains('active'),
        display: cs?.display || '',
        visible: view ? view.offsetWidth > 0 && view.offsetHeight > 0 : false,
        viewRect: view?.getBoundingClientRect().toJSON() || null,
        areaRect: area?.getBoundingClientRect().toJSON() || null
      }
    })())`)))
    ok('[A] 組字中的字畫在畫面上（不是丟給系統畫在右下角）',
      during.text === '注音' && during.active && during.visible,
      JSON.stringify({ text: during.text, active: during.active, display: during.display, visible: during.visible }))
    if (during.viewRect && during.caret) {
      const off = Math.hypot(during.viewRect.left - during.caret.x, during.viewRect.top - during.caret.y)
      ok('[A] 而且就畫在游標那一格上',
        off <= Math.max(during.caret.cellW, during.caret.cellH) + 2, `偏移 ${off.toFixed(1)}px`)
    }
    if (during.areaRect && during.caret) {
      const off = Math.hypot(during.areaRect.left - during.caret.x, during.areaRect.top - during.caret.y)
      ok('[B] 組字時隱形輸入框仍在游標上', off <= Math.max(during.caret.cellW, during.caret.cellH) + 2,
        `偏移 ${off.toFixed(1)}px`)
    }

    await cdp.send('Input.insertText', { text: '注音' })
    await sleep(1200)
    const committed = await cdp.eval(`(() => {
      const pane = document.querySelector('.term-pane.is-active')
      const term = window.__testTerminals?.get(pane?.dataset.id)
      if (!term) return ''
      const b = term.buffer.active
      return b.getLine(b.cursorY)?.translateToString(true) || ''
    })()`)
    ok('[C] 組完字之後，中文真的進了終端機那一行', String(committed).includes('注音'), JSON.stringify(committed))
  } finally {
    if (cdp && createdId) {
      try { await cdp.eval(`window.electronAPI.terminal.delete(${JSON.stringify(createdId)})`) } catch { /* 收尾 */ }
    }
    cdp?.close()
    if (child?.pid) {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 已結束 */ }
    }
    await sleep(600)
    try { fs.rmSync(USER_DATA_DIR, { recursive: true, force: true }) } catch { /* 佔用中就留著 */ }
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
  process.exitCode = failed.length ? 1 : 0
}

main().catch((err) => {
  console.error('probe 失敗：', err.message)
  process.exitCode = 1
})
