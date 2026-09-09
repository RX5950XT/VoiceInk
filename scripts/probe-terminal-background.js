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
 *  [H] **圖真的載得進來**：computed style 說得出 `url(...)` 不代表瀏覽器讀得到它
 *      （CSS 值太長會被靜靜丟掉、URL 失效也不會報錯），要把那個 URL 丟給 `Image`
 *      解碼過才算數——使用者的 3.2MB 桌布就是卡在這裡。
 *  [G] **桌布真的看得到**：量那個點上疊了哪幾層、各自的底色。`options.theme` 是
 *      自己剛塞進去的值，讀回來永遠對得上——`xterm.css` 寫死黑底的 `.xterm-viewport`
 *      曾經整片蓋在桌布上面，選項全對而畫面全黑，只有數圖層才抓得到。
 *
 * 系統對話框那一步（選圖）測不到，所以圖片是先擺進 `<userData>/terminal-bg/` 的——
 * 從 store 存的檔名往後那整條路（main 讀檔 → data: URI → blob: → CSS）都是真的，
 * 而且用的是**真實尺寸**的圖（2.5MB，見 `inflateToSize`）。
 *
 * 用法：node scripts/probe-terminal-background.js
 *      VOICEINK_EXE=... node scripts/probe-terminal-background.js
 */
const { spawn, execFileSync } = require('child_process')
const path = require('path')
const http = require('http')
const os = require('os')
const fs = require('fs')
const zlib = require('zlib')

const PORT = 9257
const EXE = process.env.VOICEINK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
const USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-probe-bg-'))

/** 8×8 的純紅 PNG（夠大到量得出 background-image，夠小到寫死在這裡） */
const RED_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHUlEQVQoU2P8z8Dwn4ECwDiqgWE0'
  + 'DBhGw4BhOIQBAF9lB/2Bd1PGAAAAAElFTkSuQmCC',
  'base64'
)

/**
 * 把那張 8×8 撐成 2.5MB 的 PNG（塞一個合法的 `tEXt` 附註 chunk 進去，圖還是 8×8 紅色）。
 *
 * **測試圖一定要夠大**：使用者的桌布是 3.2MB，base64 之後 4.3M 字元，而 Chromium 的
 * CSS 值大約 2M 字元就滿了——`setProperty` 超過就靜靜不做事，`--term-bg-image` 變空的，
 * 畫面上什麼都沒有。原本這支用 8×8（base64 才 130 字元）全綠了好幾版，卻完全沒碰到
 * 那條線。回歸就是要壓在真實尺寸上。
 *
 * @param {Buffer} png
 * @param {number} bytes 附註 chunk 的大小
 * @returns {Buffer}
 */
function inflateToSize(png, bytes) {
  const iend = png.length - 12 // IEND 這一段（長度 4 ＋ 型別 4 ＋ CRC 4）
  const payload = Buffer.concat([Buffer.from('Comment\0'), Buffer.alloc(bytes, 0x61)])
  const chunk = Buffer.alloc(payload.length + 12)
  chunk.writeUInt32BE(payload.length, 0)
  chunk.write('tEXt', 4, 'latin1')
  payload.copy(chunk, 8)
  chunk.writeUInt32BE(zlib.crc32(chunk.subarray(4, 8 + payload.length)) >>> 0, 8 + payload.length)
  return Buffer.concat([png.subarray(0, iend), chunk, png.subarray(iend)])
}

const BIG_PNG = inflateToSize(RED_PNG, 2_500_000)
const BG_NAME = 'bg-1738888888.png'
fs.mkdirSync(path.join(USER_DATA_DIR, 'terminal-bg'))
fs.writeFileSync(path.join(USER_DATA_DIR, 'terminal-bg', BG_NAME), BIG_PNG)
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

/**
 * 終端機中段那一個點上，`.term-host` 以上疊了哪幾層、各自的背景色。
 * 桌布畫在 `.term-host::before`，只要中間有一層不透明，畫面上就看不到圖。
 */
const LAYERS = `JSON.stringify((() => {
  const host = document.getElementById('termHost')
  const r = host.getBoundingClientRect()
  const x = Math.round(r.x + r.width / 2)
  const y = Math.round(r.y + r.height * 0.7)
  const layers = []
  for (const el of document.elementsFromPoint(x, y)) {
    if (el === host) break
    layers.push({ cls: String(el.className || el.tagName), bg: getComputedStyle(el).backgroundColor })
  }
  return layers
})())`

/**
 * @param {string} css `getComputedStyle` 給的 `rgb()`／`rgba()`
 * @returns {boolean} 完全透明才算 true
 */
function isTransparent(css) {
  if (css === 'transparent') return true
  const alpha = /rgba\([^)]*,\s*([\d.]+)\s*\)/.exec(css)
  return alpha ? Number(alpha[1]) === 0 : false
}

/** 桌布那一層、xterm 的選項、以及畫面上真正的字，一次全量回來 */
const SNAPSHOT = `JSON.stringify((() => {
  const host = document.getElementById('termHost')
  const pane = document.querySelector('.term-pane.is-active')
  const term = window.__testTerminals?.get(pane?.dataset.id)
  const before = host ? getComputedStyle(host, '::before') : null
  // WebGL renderer 把字畫在 canvas 上，.xterm-rows 整個不存在——「字有沒有被桌布的
  // opacity 一起壓掉」就不能再讀 span 的顏色。改成量分層：壓暗只准作用在
  // .term-host 的 ::before 那一層，字所在的那一層必須完全不透明。
  const screen = pane?.querySelector('.xterm-screen')
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
    screenOpacity: screen ? getComputedStyle(screen).opacity : '',
    paneOpacity: pane ? getComputedStyle(pane).opacity : '',
    canvases: screen ? screen.querySelectorAll('canvas').length : 0
  }
})())`

/**
 * 把 CSS 上那個桌布 URL 丟給 `Image` 真的解一次。
 * computed style 讀得到 `url(...)` 只代表「宣告」還在，載不載得進來是另一回事。
 */
const DECODE = `(async () => {
  const host = document.getElementById('termHost')
  // 這一段在樣板字串裡，反斜線要寫兩次才傳得到頁面上
  const m = /url\\("([^"]+)"\\)/.exec(getComputedStyle(host, '::before').backgroundImage || '')
  if (!m) return JSON.stringify({ error: 'CSS 上沒有 url()' })
  const r = await new Promise((res) => {
    const img = new Image()
    img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight, scheme: m[1].slice(0, 5) })
    img.onerror = () => res({ error: 'decode failed', scheme: m[1].slice(0, 5) })
    setTimeout(() => res({ error: 'timeout' }), 8000)
    img.src = m[1]
  })
  return JSON.stringify(r)
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
      on.hasClass && /^url\("blob:/.test(on.image) && on.hostW > 0 && on.hostH > 0,
      JSON.stringify({ hasClass: on.hasClass, image: on.image.slice(0, 40), w: on.hostW, h: on.hostH }))
    ok('[A] 圖鋪滿整格', on.size === 'cover', on.size)
    ok('[D] 濃度滑桿的值套到桌布那一層（35% → 0.35）',
      Math.abs(Number(on.opacity) - 0.35) < 0.01, on.opacity)
    ok('[B] 有桌布時 xterm 的底是透明的（圖才透得出來）',
      on.themeBg === '#00000000' && on.transparent === true,
      JSON.stringify({ bg: on.themeBg, transparent: on.transparent }))
    ok('[C] 文字的前景色還是配色表給的那個（全黑主題的 #e6e6e6）',
      on.themeFg.toLowerCase() === '#e6e6e6', on.themeFg)
    ok('[C] 字那一層完全不透明（壓暗只作用在桌布那一層）',
      on.screenOpacity === '1' && on.paneOpacity === '1',
      JSON.stringify({ screen: on.screenOpacity, pane: on.paneOpacity }))
    ok('[C] 字真的畫得出來（WebGL 的 canvas 在位子上）', on.canvases > 0, String(on.canvases))

    // ===== 桌布到底看不看得到：問「這個點上真正疊了哪幾層、各自什麼底色」 =====
    // `options.theme` 是自己剛塞進去的值，讀回來永遠對得上（恆真的斷言）。
    // 桌布畫在 `.term-host::before`，所以它上面的每一層都必須是透明的；
    // `xterm.css` 給 `.xterm-viewport` 寫死的黑底就是這樣把整張圖蓋掉的。
    const layers = JSON.parse(String(await cdp.eval(LAYERS)))
    const opaque = layers.filter((l) => !isTransparent(l.bg))
    ok('[G] 桌布上面每一層都是透明的（不然圖被蓋掉，選了等於沒選）',
      layers.length > 0 && opaque.length === 0,
      opaque.length ? opaque.map((l) => `${l.cls}=${l.bg}`).join('、') : `${layers.length} 層都透明`)

    // ===== 圖真的載得進來（computed style 說有，不代表瀏覽器讀得到）=====
    const decoded = JSON.parse(String(await cdp.eval(DECODE)))
    ok('[H] 桌布的 URL 真的解碼得出一張圖（大圖不會被 CSS 靜靜丟掉）',
      decoded.w > 0 && decoded.h > 0, JSON.stringify(decoded))

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
    ok('[E] 換配色不會把桌布弄掉', dracula.hasClass && /^url\("blob:/.test(dracula.image),
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
    const offLayers = JSON.parse(String(await cdp.eval(LAYERS)))
    ok('[B] 沒有桌布時終端機底下有一層是不透明的（半透明的底會讓捲動殘影疊在一起）',
      offLayers.some((l) => !isTransparent(l.bg)),
      offLayers.map((l) => `${l.cls}=${l.bg}`).join('、'))

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
