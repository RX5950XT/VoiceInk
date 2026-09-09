/**
 * 打包版 CDP 驗證：這次加的終端機功能。
 *
 * 為什麼要打包版：xterm 的三個新 addon（webgl／search／unicode11）是從
 * `node_modules` 直接 import 的 ESM——`build.files` 沒放行的話，開發版全綠、
 * 打包版靜靜地少一半功能。WebGL 更是只有真的跑起來才知道 context 拿不拿得到。
 *
 * 測完會把自己建立的工作階段刪掉，不留在你的 terminals.json 裡。
 *
 * 用法：node scripts/probe-terminal-upgrade.js
 * （先 `npm run electron:pack`；或用 `VOICEINK_EXE` 指到別處的 win-unpacked）
 */
const { spawn, execFileSync } = require('child_process')
const path = require('path')
const http = require('http')
const os = require('os')
const fs = require('fs')

const PORT = 9251
const EXE = process.env.VOICEINK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
const USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-probe-termup-'))
fs.writeFileSync(path.join(USER_DATA_DIR, 'config.json'), JSON.stringify({ sysmonSensors: false }))

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

async function waitInPage(cdp, expression, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cdp.eval(`(() => { try { return !!(${expression}) } catch { return false } })()`)) return true
    await sleep(300)
  }
  return false
}

/** 在終端機的 textarea 上打一顆鍵（xterm 的 keydown 掛在那裡） */
const pressKey = (init) => `(() => {
  const area = window.__vi.term().textarea
  area.focus()
  const opts = Object.assign({ bubbles: true, cancelable: true }, ${JSON.stringify(init)})
  area.dispatchEvent(new KeyboardEvent('keydown', opts))
  area.dispatchEvent(new KeyboardEvent('keyup', opts))
  return true
})()`

async function main() {
  const results = []
  const ok = (name, pass, detail = '') => {
    results.push({ name, pass: !!pass })
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  }

  if (!fs.existsSync(EXE)) {
    console.error(`找不到打包版：${EXE}\n先跑 npm run electron:pack，或設 VOICEINK_EXE`)
    process.exit(1)
  }

  const child = spawn(EXE, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DATA_DIR}`,
    '--hidden',
    '--disable-backgrounding-occluded-windows'
  ], { stdio: 'ignore' })

  /** 自己建的工作階段，收尾一定要刪掉 */
  const created = []
  let cdp = null

  try {
    const pages = await waitTargets()
    const mainPage = pages.find((p) => /index\.html/i.test(p.url)) || pages[0]
    cdp = new Cdp(mainPage.webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Runtime.enable')
    await sleep(1200)

    await cdp.eval(`document.querySelector('.nav-tab[data-page="chat"]').click()`)
    ok('聊天／工作區那一頁開起來了',
      await waitInPage(cdp, `!!document.getElementById('wsTabStrip')`))

    // 每一格的 Terminal 實例抓下來（分頁 id → Terminal），後面幾條都要用
    await cdp.eval(`(async () => {
      const { Terminal } = await import('../../node_modules/@xterm/xterm/lib/xterm.mjs')
      const open = Terminal.prototype.open
      window.__vi = {
        terms: new Map(),
        term: () => window.__vi.terms.get(document.querySelector('.term-pane.is-active')?.dataset.id)
      }
      Terminal.prototype.open = function (host) {
        window.__vi.terms.set(host.dataset.id, this)
        return open.call(this, host)
      }
      window.__vi.mod = await import('./scripts/terminal-page.js')
    })()`)

    // ===== 開兩個終端機 =====
    for (let i = 0; i < 2; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const id = await cdp.eval(`(async () => {
        const r = await window.electronAPI.terminal.create({ shell: 'pwsh', preset: 'shell', title: 'probe-${i}' })
        if (!r.ok) throw new Error(r.error?.message || 'create failed')
        await window.__vi.mod.openTerminalSession(r.data.id)
        return r.data.id
      })()`)
      created.push(id)
      // eslint-disable-next-line no-await-in-loop
      await sleep(900)
    }
    const [firstId, secondId] = created
    ok('兩個終端機都開起來了', created.length === 2 && created.every(Boolean), created.join(', '))

    // ===== [A] WebGL renderer =====
    const renderer = await cdp.eval(`(() => {
      const pane = document.querySelector('.term-pane.is-active')
      const canvases = pane.querySelectorAll('.xterm-screen canvas').length
      const term = window.__vi.term()
      return { canvases, cols: term.cols, rows: term.rows, w: pane.offsetWidth, h: pane.offsetHeight }
    })()`)
    ok('[A] WebGL renderer 接上了（畫面畫在 canvas 上，不是一堆 span）',
      renderer.canvases > 0, JSON.stringify(renderer))
    ok('[A] 終端機不是 0×0（開在看得見的格子上）',
      renderer.cols > 10 && renderer.rows > 3 && renderer.w > 100, JSON.stringify(renderer))

    // ===== [B] Unicode 11 =====
    const unicode = await cdp.eval(`(() => {
      const term = window.__vi.term()
      term.write('\\u26a1\\r\\n')
      return { version: term.unicode.activeVersion, versions: term.unicode.versions }
    })()`)
    ok('[B] 字寬表切到 Unicode 11', unicode.version === '11', JSON.stringify(unicode))
    await sleep(300)
    // U+26A1（⚡）在 Unicode 6 的表是一格，11 才是兩格——AI CLI 的方框歪不歪就差這個。
    // **不可以用「游標上一行第 0 格」去讀**：shell 自己的提示字元隨時會再吐一段把游標推走，
    // 讀到的就是別人的字（實測一次綠一次紅）。改成整份緩衝區找那個字，位置就不會飄。
    const wide = await cdp.eval(`(() => {
      const buf = window.__vi.term().buffer.active
      for (let y = Math.max(0, buf.length - 40); y < buf.length; y += 1) {
        const line = buf.getLine(y)
        if (!line) continue
        for (let x = 0; x < line.length; x += 1) {
          const cell = line.getCell(x)
          if (cell && cell.getChars() === '\\u26a1') return cell.getWidth()
        }
      }
      return -1
    })()`)
    ok('[B] 寬字元真的算成兩格', wide === 2, `width=${wide}`)

    // ===== [C] 字級 =====
    const before = await cdp.eval(`window.__vi.term().options.fontSize`)
    await cdp.eval(`document.getElementById('termHost').dispatchEvent(
      new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true }))`)
    await sleep(300)
    const afterWheel = await cdp.eval(`window.__vi.term().options.fontSize`)
    ok('[C] Ctrl+滾輪放大字級', afterWheel === before + 1, `${before} → ${afterWheel}`)
    await cdp.eval(pressKey({ key: '-', ctrlKey: true }))
    await sleep(300)
    const afterMinus = await cdp.eval(`window.__vi.term().options.fontSize`)
    ok('[C] Ctrl+- 縮小字級', afterMinus === afterWheel - 1, `${afterWheel} → ${afterMinus}`)
    const stored = await cdp.eval(`window.electronAPI.store.get('termFontSize', 0)`)
    ok('[C] 字級存進 store（allowlist 有放行）', stored === afterMinus, `store=${stored}`)
    await cdp.eval(pressKey({ key: '0', ctrlKey: true }))
    await sleep(300)
    ok('[C] Ctrl+0 回到預設 17', await cdp.eval(`window.__vi.term().options.fontSize`) === 17)

    // ===== [D] 搜尋 =====
    await cdp.eval(`window.__vi.term().write('haystack VOICEINKNEEDLE haystack\\r\\nVOICEINKNEEDLE again\\r\\n')`)
    await sleep(400)
    await cdp.eval(pressKey({ key: 'f', ctrlKey: true }))
    ok('[D] Ctrl+F 開得出搜尋列',
      await waitInPage(cdp, `!document.getElementById('termFind').classList.contains('hidden')`))
    await cdp.eval(`(() => {
      const input = document.getElementById('termFindInput')
      input.value = 'VOICEINKNEEDLE'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    ok('[D] 找得到而且數得出幾筆',
      await waitInPage(cdp, `/^\\d+\\/2$/.test(document.getElementById('termFindCount').textContent)`),
      await cdp.eval(`document.getElementById('termFindCount').textContent`))
    await cdp.eval(`document.getElementById('termFindInput').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
    ok('[D] Esc 收得掉',
      await waitInPage(cdp, `document.getElementById('termFind').classList.contains('hidden')`))

    // ===== [E] 分割顯示 =====
    await cdp.eval(`window.__vi.mod.toggleTerminalSplit(${JSON.stringify(firstId)})`)
    await sleep(700)
    const split = await cdp.eval(`(() => {
      const host = document.getElementById('termHost')
      const panes = [...host.querySelectorAll('.term-pane.is-active')]
      return {
        isSplit: host.classList.contains('is-split'),
        count: panes.length,
        widths: panes.map((p) => p.offsetWidth),
        cols: panes.map((p) => window.__vi.terms.get(p.dataset.id)?.cols ?? 0),
        orders: panes.map((p) => p.style.order)
      }
    })()`)
    ok('[E] 兩格並排', split.isSplit && split.count === 2, JSON.stringify(split))
    ok('[E] 兩格都量得到寬度（不是被擠成 0）',
      split.widths.length === 2 && split.widths.every((w) => w > 100), JSON.stringify(split.widths))
    ok('[E] 兩格各自重新算過欄數（不是沿用整個寬度）',
      split.cols.length === 2 && split.cols.every((c) => c > 10), JSON.stringify(split.cols))
    await cdp.eval(`window.__vi.mod.toggleTerminalSplit(${JSON.stringify(firstId)})`)
    await sleep(500)
    const unsplit = await cdp.eval(`(() => {
      const host = document.getElementById('termHost')
      return {
        isSplit: host.classList.contains('is-split'),
        count: host.querySelectorAll('.term-pane.is-active').length
      }
    })()`)
    ok('[E] 取消並排回到一格', !unsplit.isSplit && unsplit.count === 1, JSON.stringify(unsplit))

    // ===== [F] OSC 0 標題與 OSC 7 工作目錄走完整條鏈 =====
    // 宿主解析 → main 轉手 → renderer 畫到分頁上。單元測試只驗得到第一段。
    const osc = `$e=[char]27; $b=[char]7; ` +
      `Write-Host -NoNewline ($e + ']0;VI-TITLE-OK' + $b); ` +
      `Write-Host -NoNewline ($e + ']7;file:///C:/Windows' + $b)`
    await cdp.eval(`window.electronAPI.terminal.write(${JSON.stringify(secondId)}, ${JSON.stringify(osc + '\r')})`)
    const titleSel = `document.querySelector('.ws-tab[data-id=' + CSS.escape(${JSON.stringify(secondId)}) + '] .ws-tab-label')`
    ok('[F] 分頁標題跟著前景程式報的標題變（OSC 0）',
      await waitInPage(cdp, `${titleSel}?.textContent === 'VI-TITLE-OK'`, 15000),
      await cdp.eval(`${titleSel}?.textContent || '(找不到分頁)'`))
    ok('[F] 工作目錄跟著 OSC 7 走（連結解析的基準）',
      await waitInPage(cdp, `(async () => {
        const r = await window.electronAPI.terminal.list()
        return r.ok && r.data.some((s) => s.id === ${JSON.stringify(secondId)} && s.liveCwd === 'C:\\\\Windows')
      })()`, 15000))

    // 使用者自己改過名字就不准被 OSC 0 蓋掉。
    // 一定要走 renderer 的改名路徑（它會重讀清單把 `renamed` 拿回來），
    // 直接打 IPC 的話 renderer 手上那份還是舊的，測到的不是使用者會遇到的情況。
    await cdp.eval(`window.__vi.mod.renameTerminalSession(${JSON.stringify(secondId)}, '我自己取的')`)
    await sleep(400)
    await cdp.eval(`window.electronAPI.terminal.write(${JSON.stringify(secondId)}, ${JSON.stringify(osc + '\r')})`)
    await sleep(1500)
    ok('[F] 改過名字的分頁不會被程式報的標題蓋掉',
      await cdp.eval(`${titleSel}?.textContent`) === '我自己取的',
      await cdp.eval(`${titleSel}?.textContent || '(找不到分頁)'`))

    ok('[G] 全程沒有 renderer 例外', await cdp.eval(`typeof window.__termLoadError === 'undefined'`))
  } catch (error) {
    ok('測試流程未拋例外', false, error.message)
  } finally {
    for (const id of created) {
      if (!cdp) break
      try {
        // eslint-disable-next-line no-await-in-loop
        await cdp.eval(`window.electronAPI.terminal.delete(${JSON.stringify(id)})`)
        console.log(`（已清掉測試建立的工作階段 ${id}）`)
      } catch { /* App 可能已經關了 */ }
    }
    cdp?.close()
    stopTestApp(child)
    try { fs.rmSync(USER_DATA_DIR, { recursive: true, force: true }) } catch { /* 稍後由系統清理 */ }
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
