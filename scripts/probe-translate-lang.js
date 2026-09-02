/**
 * 翻譯頁語言按鈕（來源 5 顆／目標 4 顆）：按下就選中、交換鈕會對調。
 * 直接跑原始碼（打包版被鎖住時也驗得了）：
 *   node scripts/probe-translate-lang.js
 */
const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

const PORT = 9251
const ROOT = path.join(__dirname, '..')
const EXE = process.env.VOICEINK_EXE ||
  path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const APP_ARGS = process.env.VOICEINK_EXE ? [] : [ROOT]
const USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-probe-lang-'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = ''
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (error) { reject(error) }
      })
    })
    request.setTimeout(2_000, () => request.destroy(new Error('CDP HTTP 逾時')))
    request.on('error', reject)
  })
}

class Cdp {
  constructor(url) {
    this.url = url
    this.id = 0
    this.pending = new Map()
    this.exceptions = []
  }

  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve)
      this.ws.addEventListener('error', reject)
    })
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(message.params?.exceptionDetails?.exception?.description || 'runtime exception')
      }
      if (!message.id || !this.pending.has(message.id)) return
      const pending = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
    await this.send('Runtime.enable')
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    }
    return result.result?.value
  }

  close() { try { this.ws.close() } catch { /* 已關 */ } }
}

async function waitFor(action, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await action()
    if (result) return result
    await sleep(300)
  }
  throw new Error(`等待逾時：${label}`)
}

async function main() {
  const child = spawn(EXE, [
    ...APP_ARGS,
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DATA_DIR}`,
    '--hidden'
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', (chunk) => { log += chunk })
  child.stderr.on('data', (chunk) => { log += chunk })

  let cdp = null
  try {
    const target = await waitFor(async () => {
      const pages = await getJson(`http://127.0.0.1:${PORT}/json/list`).catch(() => [])
      // 打包版是 index.html；開發模式是 vite 的根路徑（HUD／字幕視窗都有自己的路徑，不會誤中）
      return pages.find((item) => item.type === 'page' && /index\.html|:5173\/?$/.test(item.url))
    }, 40_000, '主視窗')
    cdp = new Cdp(target.webSocketDebuggerUrl)
    await cdp.connect()
    await waitFor(() => cdp.eval('!!document.getElementById("translateTargetLang")'), 20_000, '翻譯頁 DOM')

    // 啟動時還原上次分頁會蓋掉太早送出的點擊，所以每一輪都重按一次再量
    await waitFor(() => cdp.eval(`(() => {
      document.querySelector('[data-page="translate"]')?.click()
      // 分頁模組是動態載入的，量到 active 才代表 initTranslatePage 跑過了
      const btn = document.querySelector('#translateSourceLang .seg-btn.active')
      return !!btn && btn.getBoundingClientRect().height > 0
    })()`), 15_000, '語言按鈕排版')

    const shape = await cdp.eval(`(async () => {
      const read = (id) => {
        const root = document.getElementById(id)
        const btns = [...root.querySelectorAll('.seg-btn')]
        return {
          values: btns.map((b) => b.dataset.value),
          active: btns.filter((b) => b.classList.contains('active')).map((b) => b.dataset.value),
          visible: btns.every((b) => b.getBoundingClientRect().height > 0),
          selects: root.querySelectorAll('select').length
        }
      }
      return { source: read('translateSourceLang'), target: read('translateTargetLang') }
    })()`)

    const want = (a, b) => JSON.stringify(a) === JSON.stringify(b)
    if (!want(shape.source.values, ['auto', 'zh-TW', 'zh-CN', 'en', 'ja'])) {
      throw new Error(`來源語言選項不符：${JSON.stringify(shape.source.values)}`)
    }
    if (!want(shape.target.values, ['zh-TW', 'zh-CN', 'en', 'ja'])) {
      throw new Error(`目標語言選項不符：${JSON.stringify(shape.target.values)}`)
    }
    if (shape.source.selects || shape.target.selects) throw new Error('語言還留著下拉選單')
    if (!shape.source.visible || !shape.target.visible) {
      throw new Error(`語言按鈕量不到高度：${JSON.stringify(shape)}`)
    }
    if (!want(shape.source.active, ['auto']) || !want(shape.target.active, ['zh-TW'])) {
      throw new Error(`預設選中不符：${JSON.stringify([shape.source.active, shape.target.active])}`)
    }
    console.log('PASS  lang-buttons (5 + 4，無下拉，預設 auto / zh-TW)')

    const picked = await cdp.eval(`(() => {
      const active = (id) => [...document.getElementById(id).querySelectorAll('.seg-btn')]
        .filter((b) => b.classList.contains('active')).map((b) => b.dataset.value)
      const click = (id, value) => document.querySelector(
        '#' + id + ' .seg-btn[data-value="' + value + '"]').click()
      click('translateSourceLang', 'en')
      click('translateTargetLang', 'ja')
      const afterClick = [active('translateSourceLang'), active('translateTargetLang')]
      document.getElementById('translateSwapBtn').click()
      return { afterClick, afterSwap: [active('translateSourceLang'), active('translateTargetLang')] }
    })()`)
    if (!want(picked.afterClick, [['en'], ['ja']])) {
      throw new Error(`按下沒有選中：${JSON.stringify(picked.afterClick)}`)
    }
    if (!want(picked.afterSwap, [['ja'], ['en']])) {
      throw new Error(`交換不正確：${JSON.stringify(picked.afterSwap)}`)
    }
    console.log('PASS  lang-buttons (點選切換 / 交換鈕對調)')

    // 五顆中文按鈕排在一起最容易在窄視窗撐破版面
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 560, height: 900, deviceScaleFactor: 1, mobile: false
    })
    await sleep(300)
    const narrow = await cdp.eval(`(() => ({
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      wrapped: document.getElementById('translateSourceLang').getBoundingClientRect().height
    }))()`)
    await cdp.send('Emulation.clearDeviceMetricsOverride')
    if (narrow.overflow) throw new Error('560px 時 document 水平溢出')
    if (!(narrow.wrapped > 0)) throw new Error('560px 時語言列量不到高度')
    console.log('PASS  lang-buttons (560px 不溢出)')

    if (cdp.exceptions.length) throw new Error(`renderer 例外：${JSON.stringify(cdp.exceptions)}`)
    console.log('OK    3 項通過')
  } catch (error) {
    console.error('FAILED ', error.message)
    if (log.trim()) console.error('Process log:', log.trim().slice(0, 2000))
    process.exitCode = 1
  } finally {
    cdp?.close()
    if (child.pid) {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 已結束 */ }
    }
    await sleep(600)
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(USER_DATA_DIR, { recursive: true, force: true }); break } catch { await sleep(400) }
    }
  }
}

main()
