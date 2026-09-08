/**
 * 應用內彈窗（app-dialog.js）的 CDP 回歸：確認、輸入、告知三種都必須是
 * `<dialog class="app-dialog">`，而且真的長得像這個 App（玻璃底＋blur），
 * 不是瀏覽器／系統內建那三支。
 *
 * 用法：node scripts/e2e-app-dialog-cdp.js
 * 自己開 vite（5173）與 electron，收尾只殺自己 spawn 的那兩棵。
 */
const { spawn } = require('child_process')
const path = require('path')
const os = require('os')
const fs = require('fs')
const http = require('http')

const PORT = 9241
const ROOT = path.join(__dirname, '..')
const USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-dialog-'))
const IS_WIN = process.platform === 'win32'

const results = []
const ok = (name, pass, detail = '') => {
  results.push({ name, pass: !!pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function stopTree(child) {
  if (!child?.pid) return
  try {
    if (IS_WIN) spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' })
    else process.kill(-child.pid, 'SIGKILL')
  } catch { /* 已經自己收掉了 */ }
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => { try { resolve(JSON.parse(d)) } catch (e) { reject(e) } })
    }).on('error', reject)
  })
}

async function waitHttp(url, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise((res, rej) => http.get(url, (r) => { r.resume(); res() }).on('error', rej))
      return true
    } catch { await sleep(400) }
  }
  throw new Error(`timeout waiting ${url}`)
}

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
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
      const slot = msg.id && this.pending.get(msg.id)
      if (!slot) return
      this.pending.delete(msg.id)
      if (msg.error) slot.reject(new Error(msg.error.message))
      else slot.resolve(msg.result)
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  /** 每一次求值都要有逾時：彈窗沒關就 await 下去，整支腳本會安靜地卡住 */
  async eval(expression) {
    const r = await Promise.race([
      this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
      sleep(30000).then(() => { throw new Error('eval timeout: ' + expression.trim().slice(0, 60)) })
    ])
    if (r.exceptionDetails) {
      const d = r.exceptionDetails
      throw new Error(d.exception?.description || d.exception?.value || d.text || 'eval error')
    }
    return r.result?.value
  }
  async key(key, code, keyCode) {
    for (const type of ['rawKeyDown', 'keyUp']) {
      // eslint-disable-next-line no-await-in-loop
      await this.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode })
    }
  }
  close() { try { this.ws.close() } catch { /* 已斷 */ } }
}

/** [A] 原始碼裡不可以再有那三支——這條在修好之前一定是紅的 */
function checkNoNativeDialogs() {
  const dir = path.join(ROOT, 'src', 'renderer')
  const hits = []
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name)
      if (fs.statSync(full).isDirectory()) walk(full)
      else if (name.endsWith('.js')) {
        const text = fs.readFileSync(full, 'utf-8')
        for (const line of text.split('\n')) {
          if (/window\.(alert|confirm|prompt)\s*\(/.test(line)) hits.push(`${name}: ${line.trim().slice(0, 60)}`)
        }
      }
    }
  }
  walk(dir)
  ok('[A] renderer 沒有原生 alert／confirm／prompt', hits.length === 0, hits.join(' | '))
}

async function main() {
  checkNoNativeDialogs()

  // 直接指到 .js 入口與 electron 執行檔：Node 20+ 不讓 spawn 直接跑 .cmd（EINVAL）
  const vite = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')], {
    cwd: ROOT, stdio: 'ignore', shell: false
  })
  let electron = null
  let cdp = null
  try {
    await waitHttp('http://localhost:5173', 60000)
    electron = spawn(
      require('electron'),
      ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA_DIR}`],
      { cwd: ROOT, stdio: 'ignore', shell: false }
    )
    await waitHttp(`http://127.0.0.1:${PORT}/json/version`, 60000)

    let page = null
    for (let i = 0; i < 40 && !page; i++) {
      const list = await getJson(`http://127.0.0.1:${PORT}/json/list`)
      // HUD 也是一個 page target，只認主視窗
      page = list.find((t) => t.type === 'page' && /localhost:5173\/?$|index\.html/i.test(t.url))
      if (!page) await sleep(500)
    }
    if (!page) throw new Error('找不到主視窗 target')

    cdp = new Cdp(page.webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Runtime.enable')
    // 視窗被別的程式蓋住時 Chromium 會把計時器與事件派送節流到 ~19 秒
    // （CLAUDE.md 的 `document.hidden` 那條），`dialog.close()` 的 close 事件
    // 就慢到測不完。所以這支**會把視窗叫到最前面**。
    await cdp.send('Page.enable')
    await cdp.send('Page.bringToFront')
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})

    await cdp.eval(`(async () => { window.__dlg = await import('./scripts/app-dialog.js') })()`)

    // ===== [B] 確認彈窗：開出來的是 App 自己的 <dialog>，不是原生 =====
    const shown = await cdp.eval(`(async () => {
      window.__done = window.__dlg.askConfirm('確定要刪除嗎？', { desc: '救不回來。', confirmText: '刪除', danger: true })
      await new Promise((r) => setTimeout(r, 50))
      const d = document.querySelector('dialog.app-dialog[open]')
      if (!d) return { found: false }
      const cs = getComputedStyle(d)
      const btns = [...d.querySelectorAll('.dialog-actions .btn')].map((b) => b.textContent)
      return {
        found: true,
        modal: d.matches(':modal'),
        width: d.getBoundingClientRect().width,
        blur: cs.backdropFilter || cs.webkitBackdropFilter || '',
        bg: cs.backgroundColor,
        title: d.querySelector('.dialog-title')?.textContent,
        desc: d.querySelector('.dialog-desc')?.textContent,
        danger: !!d.querySelector('.btn-danger'),
        btns
      }
    })()`)
    ok(
      '[B] 確認彈窗是 app-dialog 且套到 Aurora 樣式',
      shown.found && shown.modal && /blur/.test(shown.blur) && shown.bg !== 'rgba(0, 0, 0, 0)' &&
        shown.width > 0 && shown.width <= 460 && shown.danger &&
        shown.title === '確定要刪除嗎？' && shown.btns.join('/') === '取消/刪除',
      JSON.stringify(shown)
    )

    // ===== [C] 取消 → false，而且節點要收乾淨（不能一直堆在 body 上）=====
    const cancelled = await cdp.eval(`(async () => {
      document.querySelector('dialog.app-dialog[open] .btn-secondary').click()
      const value = await window.__done
      return { value, left: document.querySelectorAll('dialog.app-dialog-compact').length }
    })()`)
    ok('[C] 取消回 false 且節點移除', cancelled.value === false && cancelled.left === 0, JSON.stringify(cancelled))

    // ===== [D] 輸入彈窗：帶預設值、按 Enter 直接送出 =====
    const primed = await cdp.eval(`(async () => {
      window.__done = window.__dlg.askInput('新的名稱', { value: 'old.txt' })
      await new Promise((r) => setTimeout(r, 50))
      const input = document.querySelector('dialog.app-dialog[open] input.input')
      if (!input) return { ready: false }
      input.value = 'new.txt'
      return { ready: true, focused: document.activeElement === input, seeded: 'old.txt' }
    })()`)
    ok('[D1] 輸入框帶預設值並自動聚焦', primed.ready && primed.focused, JSON.stringify(primed))

    await cdp.key('Enter', 'Enter', 13)
    const typed = await cdp.eval('window.__done')
    ok('[D2] Enter 送出並回傳輸入內容', typed === 'new.txt', String(typed))

    // ===== [E] Esc → null（跟 window.prompt 同一套約定）=====
    await cdp.eval(`(async () => {
      window.__done = window.__dlg.askInput('會被取消的輸入')
      await new Promise((r) => setTimeout(r, 50))
    })()`)
    await cdp.key('Escape', 'Escape', 27)
    await sleep(200)
    const escaped = await cdp.eval(`(async () => ({ value: await window.__done, left: document.querySelectorAll('dialog.app-dialog-compact').length }))()`)
    ok('[E] Esc 回 null 且節點移除', escaped.value === null && escaped.left === 0, JSON.stringify(escaped))

    // ===== [F] 訊息帶標記語言時只能是純文字（檔名／分支名／上游錯誤都是外部輸入）=====
    const escaping = await cdp.eval(`(async () => {
      window.__done = window.__dlg.showAlert('移不掉', { desc: '<img src=x onerror="window.__pwned=1">' })
      await new Promise((r) => setTimeout(r, 50))
      const d = document.querySelector('dialog.app-dialog[open]')
      const out = { imgs: d.querySelectorAll('img').length, pwned: window.__pwned === 1, text: d.querySelector('.dialog-desc').textContent }
      d.querySelector('.btn-primary').click()
      await window.__done
      return out
    })()`)
    ok(
      '[F] 訊息走 textContent 不會被當成 HTML',
      escaping.imgs === 0 && !escaping.pwned && escaping.text.includes('<img'),
      JSON.stringify(escaping)
    )
  } finally {
    cdp?.close()
    stopTree(electron)
    stopTree(vite)
    try { fs.rmSync(USER_DATA_DIR, { recursive: true, force: true }) } catch { /* 佔用中就留著 */ }
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
