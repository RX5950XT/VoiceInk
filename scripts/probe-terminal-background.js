/**
 * 打包版 CDP 實測：終端機的配色與桌布。
 *
 * 這件事的重點不是「圖有沒有貼上去」，是**貼了圖之後一般文字有沒有被影響**——
 * 使用者要的就是這句話。所以量的是：
 *
 *  [A] 桌布那一層真的畫得出來（`.term-host::before` 有 `background-image`、有寬高）。
 *  [B] 有桌布時 xterm 的底才變透明（`#00000000` ＋ `allowTransparency`），
 *      **沒有桌布時必須是不透明的**（半透明的底會讓捲動殘影疊在一起，CLAUDE.md 的地雷）。
 *  [C] **文字那一層一個字都沒動**：前景色還是配色表給的那個，而且畫面上的字元
 *      真的是不透明的顏色（不是被 opacity 壓掉的灰）。
 *  [D] 濃度滑桿只作用在桌布那一層。
 *  [E] 換配色（全黑 ⇄ Dracula）會即時套到已經開著的分頁上。
 *
 * 系統對話框那一步（選圖）測不到，所以圖片是先擺進 `<userData>/terminal-bg/` 的——
 * 從 store 存的檔名往後那整條路（main 讀檔 → data: URI → CSS）都是真的。
 *
 * 用法：node scripts/probe-terminal-background.js
 *      VOICEINK_EXE=... node scripts/probe-terminal-background.js
 */
const { spawn, execFileSync } = require('child_process')
const path = require('path')
const http = require('http')
const os = require('os')
const fs = require('fs')

const PORT = 9257
const EXE = process.env.VOICEINK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
const USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-probe-bg-'))

/** 8×8 的純紅 PNG（夠大到量得出 background-image，夠小到寫死在這裡） */
const RED_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHUlEQVQoU2P8z8Dwn4ECwDiqgWE0'
  + 'DBhGw4BhOIQBAF9lB/2Bd1PGAAAAAElFTkSuQmCC',
  'base64'
)
const BG_NAME = 'bg-1738888888.png'
fs.mkdirSync(path.join(USER_DATA_DIR, 'terminal-bg'))
fs.writeFileSync(path.join(USER_DATA_DIR, 'terminal-bg', BG_NAME), RED_PNG)
fs.writeFileSync(path.join(USER_DATA_DIR, 'config.json'), JSON.stringify({
  sysmonSensors: false,
  termTheme: 'black',
  termBgImage: BG_NAME,
  termBgOpacity: 35
}))
const PROJECT_DIR = path.join(USER_DATA_DIR, 'project')
fs.mkdirSync(PROJECT_DIR)
fs.writeFileSync(path.join(USER_DATA_DIR, 'workspaces.json'), JSON.stringify({
  projects: [{ id: 'w_bg_probe', name: '桌布測試', path: PROJECT_DIR, createdAt: Date.now() }]
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

/** 桌布那一層、xterm 的選項、以及畫面上真正的字，一次全量回來 */
const SNAPSHOT = `JSON.stringify((() => {
  const host = document.getElementById('termHost')
  const pane = document.querySelector('.term-pane.is-active')
  const term = window.__testTerminals?.get(pane?.dataset.id)
  const before = host ? getComputedStyle(host, '::before') : null
  const glyph = pane?.querySelector('.xterm-rows span')
  return {
    hasClass: !!host?.classList.contains('has-term-bg'),
    image: before?.backgroundImage || '',
    opacity: before?.opacity || '',
    size: before?.backgroundSize || '',
    hostW: host?.offsetWidth || 0,
    hostH: host?.offsetHeight || 0,
    themeBg: term?.options?.theme?.background || '',
    themeFg: term?.options?.theme?.foreground || '',
    transparent: term?.options?.allowTransparency === true,
    glyphColour: glyph ? getComputedStyle(glyph).color : '',
    glyphText: glyph?.textContent || ''
  }
})())`

async function main() {
  const results = []
  const ok = (name, pass, detail = '') => {
    results.push({ name, pass: !!pass })
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  }

  const child = spawn(EXE, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DATA_DIR}`,
    // 不搶使用者的焦點：computed style 不需要 OS 焦點
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
    await waitInPage(cdp, `!!document.querySelector('#projList [data-id="w_bg_probe"] .chat-list-open')`)
    await cdp.eval(`document.querySelector('#projList [data-id="w_bg_probe"] .chat-list-open').click()`)
    await sleep(800)

    const created = await cdp.eval(`(async () => {
      const r = await window.electronAPI.terminal.create({ preset: 'shell', cwd: ${JSON.stringify(PROJECT_DIR)}, projectId: 'w_bg_probe' })
      return r.ok ? r.data : null
    })()`)
    if (!created) throw new Error('建立終端機失敗')
    createdId = created.id
    await cdp.eval(`import('./scripts/terminal-page.js').then((m) => m.openTerminalSession(${JSON.stringify(createdId)}))`)
    // 第一次跑會先把終端機宿主的執行環境（248MB）複製到 userData，暫存 userData 每次都要重來
    const drawn = await waitInPage(cdp, `!!document.querySelector('.term-pane.is-active .xterm-screen')`, 90000)
    ok('終端機畫出來了', drawn,
      drawn ? '' : String(await cdp.eval(`document.getElementById('termError')?.textContent || '(termError 空的)'`)))
    if (!drawn) throw new Error('終端機沒開起來，後面的量測沒有意義')
    // 等提示字元落地，畫面上才有字可以量顏色
    await sleep(4000)

    const on = JSON.parse(String(await cdp.eval(SNAPSHOT)))
    ok('[A] 桌布那一層畫得出來（有圖、有寬高）',
      on.hasClass && on.image.startsWith('url("data:image/png') && on.hostW > 0 && on.hostH > 0,
      JSON.stringify({ hasClass: on.hasClass, image: on.image.slice(0, 40), w: on.hostW, h: on.hostH }))
    ok('[A] 圖鋪滿整格', on.size === 'cover', on.size)
    ok('[D] 濃度滑桿的值套到桌布那一層（35% → 0.35）',
      Math.abs(Number(on.opacity) - 0.35) < 0.01, on.opacity)
    ok('[B] 有桌布時 xterm 的底是透明的（圖才透得出來）',
      on.themeBg === '#00000000' && on.transparent === true,
      JSON.stringify({ bg: on.themeBg, transparent: on.transparent }))
    ok('[C] 文字的前景色還是配色表給的那個（全黑主題的 #e6e6e6）',
      on.themeFg.toLowerCase() === '#e6e6e6', on.themeFg)
    ok('[C] 畫面上的字是不透明的（沒有被桌布的 opacity 一起壓掉）',
      /^rgb\(/.test(on.glyphColour), JSON.stringify({ colour: on.glyphColour, text: on.glyphText.slice(0, 20) }))

    // ===== 換配色：Dracula 應該即時套到已經開著的分頁上 =====
    await cdp.eval(`(async () => {
      await window.electronAPI.store.set('termTheme', 'dracula')
      const m = await import('./scripts/terminal-page.js')
      await m.refreshTerminalAppearance()
    })()`)
    await sleep(600)
    const dracula = JSON.parse(String(await cdp.eval(SNAPSHOT)))
    ok('[E] 換配色即時套到已經開著的分頁（Dracula 的前景 #f8f8f2）',
      dracula.themeFg.toLowerCase() === '#f8f8f2', dracula.themeFg)
    ok('[E] 換配色不會把桌布弄掉', dracula.hasClass && dracula.image.startsWith('url("data:image/png'),
      JSON.stringify({ hasClass: dracula.hasClass, image: dracula.image.slice(0, 30) }))

    // ===== 移除桌布：底色必須回到不透明 =====
    await cdp.eval(`(async () => {
      await window.electronAPI.store.set('termBgImage', '')
      await window.electronAPI.store.set('termTheme', 'black')
      const m = await import('./scripts/terminal-page.js')
      await m.refreshTerminalAppearance()
    })()`)
    await sleep(600)
    const off = JSON.parse(String(await cdp.eval(SNAPSHOT)))
    ok('[B] 移掉桌布之後底色回到不透明的全黑（不然捲動殘影會疊在一起）',
      off.hasClass === false && off.themeBg === '#000000' && off.transparent === false,
      JSON.stringify({ hasClass: off.hasClass, bg: off.themeBg, transparent: off.transparent }))
    ok('[B] 桌布那一層也不再畫圖', off.image === 'none', off.image)

    // ===== store 只認得自己產的檔名 =====
    const bad = await cdp.eval(`(async () => {
      await window.electronAPI.store.set('termBgImage', '../../config.json')
      return await window.electronAPI.store.get('termBgImage', '')
    })()`)
    ok('[F] 路徑穿越的檔名進不了 store', bad === '', JSON.stringify(bad))
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
