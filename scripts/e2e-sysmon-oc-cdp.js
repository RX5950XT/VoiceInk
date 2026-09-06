/**
 * 打包版 CDP：系統監控 ▸ 效能調整
 * 用法：node scripts/e2e-sysmon-oc-cdp.js
 *
 * **不按套用**（會改到使用者正在用的機器）。只驗第五 tab、兩欄卡片、空狀態說明、
 * IPC 守衛。真的改時脈是以後 `probe-sysmon-oc.js` 的職責。
 */
const { spawn } = require('child_process')
const path = require('path')
const os = require('os')
const fs = require('fs')
const http = require('http')

const PORT = 9249
const EXE = process.env.VOICEINK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
const USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-oc-cdp-'))
fs.writeFileSync(path.join(USER_DATA_DIR, 'config.json'), JSON.stringify({ sysmonSensors: false }))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let body = ''
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => { try { resolve(JSON.parse(body)) } catch (error) { reject(error) } })
    }).on('error', reject)
  })
}

class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.exceptions = [] }
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
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    }
    return result.result?.value
  }
  close() { try { this.ws.close() } catch { /* ignore */ } }
}

async function waitFor(action, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await action()) return true
    await sleep(300)
  }
  throw new Error(`等待逾時：${label}`)
}

async function main() {
  const child = spawn(EXE, ['--hidden', `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA_DIR}`], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let cdp = null
  let originalSensors = null
  let passed = 0
  let failed = 0
  const ok = (name, cond, extra = '') => {
    if (cond) { passed++; console.log(`PASS  ${name}`) }
    else { failed++; console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`) }
  }

  try {
    const target = await (async () => {
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        const pages = await getJson(`http://127.0.0.1:${PORT}/json/list`).catch(() => [])
        const page = pages.filter((p) => p.type === 'page').find((p) => /index\.html/.test(p.url))
        if (page) return page
        await sleep(400)
      }
      throw new Error('等不到主視窗')
    })()
    cdp = new Cdp(target.webSocketDebuggerUrl)
    await cdp.connect()
    await waitFor(
      () => cdp.eval(`document.readyState === 'complete' && typeof window.electronAPI?.sysmon?.ocStatus === 'function'`),
      15000, 'preload 初始化（ocStatus 要在 preload 白名單裡）'
    )

    originalSensors = await cdp.eval(`window.electronAPI.store.get('sysmonSensors', null)`)
    await cdp.eval(`window.electronAPI.store.set('sysmonSensors', false)`)

    await cdp.eval(`document.querySelector('[data-page="sysmon"]').click()`)
    ok('效能調整子分頁存在',
      await cdp.eval(`Boolean(document.querySelector('#sysmonTabs .sysmon-tab[data-subtab="oc"]')` +
        `&& document.getElementById('sysmon-oc'))`))
    ok('排在風扇控制右邊',
      await cdp.eval(`(() => {
        const tabs = [...document.querySelectorAll('#sysmonTabs .sysmon-tab')].map((t) => t.dataset.subtab)
        return tabs.indexOf('oc') === tabs.indexOf('fans') + 1
      })()`))

    await waitFor(async () => {
      await cdp.eval(`document.querySelector('#sysmonTabs .sysmon-tab[data-subtab="oc"]').click()`)
      return cdp.eval(`document.getElementById('sysmon-oc').classList.contains('active')`)
    }, 15000, '切到效能調整').catch(() => {})
    ok('切過去之後面板是 active',
      await cdp.eval(`document.getElementById('sysmon-oc').classList.contains('active')`))
    ok('面板真的佔版面',
      await cdp.eval(`document.getElementById('sysmon-oc').offsetHeight > 0`))
    ok('其他面板是隱藏的（不會疊頁）',
      await cdp.eval(`document.getElementById('sysmon-overview').offsetHeight === 0`))

    await waitFor(() => cdp.eval(`(document.getElementById('ocNotices')?.textContent || '').length > 8`), 5000, '空狀態說明')
    ok('沒啟用感測器時顯示說明而不是留白',
      await cdp.eval(`(document.getElementById('ocNotices')?.textContent || '').includes('感測器')`))

    const bar = await cdp.eval(`(() => ({
      apply: Boolean(document.getElementById('ocApplyBtn')),
      reset: Boolean(document.getElementById('ocResetBtn')),
      cpu: Boolean(document.getElementById('ocCpuCard')),
      gpu: Boolean(document.getElementById('ocGpuCard')),
      dash: Boolean(document.getElementById('ocDash')),
      cpuGauges: Boolean(document.getElementById('ocCpuGauges')),
      gpuGauges: Boolean(document.getElementById('ocGpuGauges')),
      cores: Boolean(document.getElementById('ocCpuCores')),
      cpuSpark: Boolean(document.getElementById('ocCpuSpark')),
      gpuSpark: Boolean(document.getElementById('ocGpuSpark')),
      vf: Boolean(document.getElementById('ocVfHost'))
    }))()`)
    ok('套用／還原與兩欄卡片都在', bar.apply && bar.reset && bar.cpu && bar.gpu, JSON.stringify(bar))
    ok('即時儀表區在', bar.dash && bar.cpuGauges && bar.gpuGauges && bar.cores && bar.cpuSpark && bar.gpuSpark, JSON.stringify(bar))
    ok('V/F 曲線容器在', bar.vf, JSON.stringify(bar))
    ok('走勢線有時脈／溫度說明',
      await cdp.eval(`(document.querySelector('.oc-spark-legend')?.textContent || '').includes('時脈')
        && (document.querySelector('.oc-spark-legend')?.textContent || '').includes('溫度')`))

    // 兩側留白處要真的有畫東西＝上下限＋單位（只斷言「有 canvas」抓不到沒畫軸的版本）
    // 感測器沒開時 CPU 那條沒有讀數（不拿 0 佔位），所以兩張圖有一張畫出來就算數
    const inkExpr = `(() => {
      const axis = (id) => {
        const c = document.getElementById(id)
        if (!c || !c.width) return false
        const ctx = c.getContext('2d')
        // 只看兩側留白的最上緣：曲線畫在中間那塊，這裡有墨水就是上限標籤
        const w = Math.round(c.width * 0.05)
        const h = Math.max(6, Math.round(c.height * 0.25))
        const ink = (x) => ctx.getImageData(x, 0, w, h).data.some((v, i) => i % 4 === 3 && v > 0)
        return ink(0) && ink(c.width - w)
      }
      return { cpu: axis('ocCpuSpark'), gpu: axis('ocGpuSpark') }
    })()`
    await waitFor(async () => {
      const g = await cdp.eval(inkExpr)
      return Boolean(g && (g.cpu || g.gpu))
    }, 12000, '走勢圖畫出兩側 Y 軸').catch(() => {})
    const gutters = await cdp.eval(inkExpr)
    ok('走勢圖兩側有畫出 Y 軸上下限',
      Boolean(gutters && (gutters.cpu || gutters.gpu)), JSON.stringify(gutters))

    const guards = await cdp.eval(`(async () => {
      const api = window.electronAPI.sysmon
      return {
        status: await api.ocStatus(),
        apply: await api.ocApply(),
        draft: await api.ocSetDraft({ gpu: { coreMHz: 9999 } })
      }
    })()`)
    ok('ocStatus 回 ok', guards.status.ok === true, JSON.stringify(guards.status).slice(0, 160))
    ok('感測器沒開時套用會失敗（不寫硬體）',
      guards.apply.ok === false, JSON.stringify(guards.apply).slice(0, 160))
    ok('草稿偏移會被夾住',
      guards.draft.ok === true && guards.draft.data?.draft?.gpu?.coreMHz === 200,
      JSON.stringify(guards.draft.data?.draft?.gpu))

    const paint = await cdp.eval(`(() => {
      const cs = (sel, prop) => getComputedStyle(document.querySelector(sel))[prop]
      const dash = document.querySelector('.oc-dash-group')
      return {
        bar: cs('.oc-bar', 'backgroundColor'),
        card: cs('.oc-card', 'backgroundColor'),
        dash: dash ? getComputedStyle(dash).backgroundColor : '',
        dashH: document.getElementById('ocDash')?.offsetHeight || 0
      }
    })()`)
    const painted = (value) => Boolean(value) && value !== 'rgba(0, 0, 0, 0)' && value !== 'transparent'
    ok('面板底色有畫出來（CSS 變數名沒打錯）',
      painted(paint.bar) && painted(paint.card), JSON.stringify(paint))
    ok('即時儀表區有佔版面',
      paint.dashH > 80 && painted(paint.dash), JSON.stringify(paint))

    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width: 760, height: 900, deviceScaleFactor: 1, mobile: false })
    await sleep(400)
    const narrow = await cdp.eval(`(() => {
      const layout = document.querySelector('.oc-layout')
      const dash = document.getElementById('ocDash')
      return { layout: layout ? layout.offsetHeight : 0, dash: dash ? dash.offsetHeight : 0 }
    })()`)
    ok('900px 以下版面存在', narrow.layout > 80 && narrow.dash > 40, JSON.stringify(narrow))
    await cdp.send('Emulation.clearDeviceMetricsOverride', {})

    ok('renderer 無未處理例外', cdp.exceptions.length === 0, JSON.stringify(cdp.exceptions))
  } catch (error) {
    failed++
    console.error(`\n未預期例外：${error.stack || error}`)
  } finally {
    if (cdp && originalSensors !== null) {
      try {
        await cdp.eval(`window.electronAPI.store.set('sysmonSensors', ${JSON.stringify(originalSensors)})`)
      } catch { /* 視窗已關就算了 */ }
    }
    cdp?.close()
    try { child.kill() } catch { /* ignore */ }
    if (child.pid) {
      try { spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' }) } catch { /* ignore */ }
    }
    for (let i = 0; i < 5; i += 1) {
      try { fs.rmSync(USER_DATA_DIR, { recursive: true, force: true }); break } catch { await sleep(600) }
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
