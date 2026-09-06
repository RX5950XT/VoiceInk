/**
 * 打包版 CDP：系統監控 ▸ 使用時長
 * 用法：node scripts/e2e-screentime-cdp.js
 *
 * 暫存 userData，開機會從本機 Tai Data 拷一份進來。不斷言「第一列」。
 * 不關使用者的 Tai.exe，也不按任何會改硬體的鈕。
 */
const { spawn } = require('child_process')
const path = require('path')
const os = require('os')
const fs = require('fs')
const http = require('http')

const PORT = 9253
const EXE = process.env.VOICEINK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
const USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-screentime-cdp-'))
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
    await sleep(400)
  }
  throw new Error(`等待逾時：${label}`)
}

async function main() {
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA_DIR}`], { stdio: ['ignore', 'pipe', 'pipe'] })
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
      const deadline = Date.now() + 45000
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
      () => cdp.eval(`document.readyState === 'complete' && typeof window.electronAPI?.screentime?.stats === 'function'`),
      20000, 'preload 初始化（screentime.stats）'
    )

    originalSensors = await cdp.eval(`window.electronAPI.store.get('sysmonSensors', null)`)
    await cdp.eval(`window.electronAPI.store.set('sysmonSensors', false)`)

    await cdp.eval(`document.querySelector('[data-page="sysmon"]').click()`)
    ok('使用時長子分頁存在',
      await cdp.eval(`Boolean(document.querySelector('#sysmonTabs .sysmon-tab[data-subtab="screentime"]')` +
        `&& document.getElementById('sysmon-screentime'))`))
    ok('排在總覽與處理程序之間',
      await cdp.eval(`(() => {
        const tabs = [...document.querySelectorAll('#sysmonTabs .sysmon-tab')].map((t) => t.dataset.subtab)
        return tabs.indexOf('screentime') === tabs.indexOf('overview') + 1
          && tabs.indexOf('processes') === tabs.indexOf('screentime') + 1
      })()`))

    await waitFor(async () => {
      await cdp.eval(`document.querySelector('#sysmonTabs .sysmon-tab[data-subtab="screentime"]').click()`)
      return cdp.eval(`document.getElementById('sysmon-screentime').classList.contains('active')`)
    }, 20000, '切到使用時長').catch(() => {})
    ok('切過去之後面板是 active',
      await cdp.eval(`document.getElementById('sysmon-screentime').classList.contains('active')`))
    ok('面板真的佔版面',
      await cdp.eval(`document.getElementById('sysmon-screentime').offsetHeight > 0`))
    ok('總覽被藏起來',
      await cdp.eval(`document.getElementById('sysmon-overview').offsetHeight === 0`))

    let apps = null
    await waitFor(async () => {
      apps = await cdp.eval(`(async () => {
        const r = await window.electronAPI.screentime.stats({ kind: 'app', range: 'year', date: '2026-09-04' })
        return r && r.ok ? r.data : null
      })()`)
      return Boolean(apps && Array.isArray(apps.list) && apps.list.some((row) => row.name === 'msedge'))
    }, 30000, '年統計出現 msedge').catch(() => { apps = null })
    ok('讀得到 Tai 舊資料（應用 msedge）',
      Boolean(apps && apps.list.some((row) => row.name === 'msedge')),
      JSON.stringify(apps?.list?.slice(0, 3) || apps))
    ok('畫面上是 Microsoft Edge 不是 msedge',
      Boolean(apps && apps.list.some((row) => row.name === 'msedge' && row.display === 'Microsoft Edge')),
      JSON.stringify(apps?.list?.slice(0, 2)))

    // 上面那筆是直接打 IPC 問「年」的資料；畫面預設停在「日」，
    // 不先把範圍切過去，清單裡本來就不該有那一筆（假紅燈）。
    await cdp.eval(`document.querySelector('#stimeRange [data-range="year"]').click()`)
    await waitFor(
      () => cdp.eval(`(document.getElementById('stimeList')?.textContent || '').includes('Microsoft Edge')`),
      8000, '清單畫出 Microsoft Edge'
    ).catch(() => {})
    ok('清單用常見名稱',
      await cdp.eval(`(document.getElementById('stimeList')?.textContent || '').includes('Microsoft Edge')`))
    ok('清單沒有進度條',
      await cdp.eval(`document.querySelectorAll('#stimeList .stime-row-bar').length === 0`))
    ok('沒有用警告強調條當狀態',
      await cdp.eval(`!document.getElementById('stimeNote')?.classList.contains('sysmon-note')`))
    ok('外掛已連上不寫在狀態列',
      await cdp.eval(`!(document.getElementById('stimeNote')?.textContent || '').includes('已連上')`))
    ok('柱狀圖有即時提示層',
      await cdp.eval(`Boolean(document.getElementById('stimeTip'))`))
    ok('沒有「持續記錄」開關（開 App 就一直記）',
      await cdp.eval(`!document.getElementById('stimeEnabled')`))

    const axis = await cdp.eval(`(() => {
      const ticks = [...document.querySelectorAll('#stimeChart .stime-tick span')].map((n) => n.textContent)
      return { count: ticks.length, top: ticks[0] || '', zero: ticks[ticks.length - 1] || '' }
    })()`)
    ok('Y 軸有刻度而且帶單位',
      axis.count === 3 && /(小時|分|秒)$/.test(axis.top) && axis.zero === '0', JSON.stringify(axis))

    // 先確認這條斷言抓得到舊版（標籤在柱子裡 → 矮柱被字壓住），再驗修好的版面
    const overlap = await cdp.eval(`(() => {
      const measure = () => {
        const plot = document.querySelector('#stimeChart .stime-plot')
        if (!plot) return null
        const bottom = plot.getBoundingClientRect().bottom
        return [...document.querySelectorAll('#stimeChart .stime-col span')]
          .filter((n) => n.textContent)
          .every((n) => n.getBoundingClientRect().top >= bottom - 1)
      }
      const style = document.createElement('style')
      style.textContent = '#stimeChart .stime-col span { position: static !important; bottom: auto !important; }'
      document.head.append(style)
      const broken = measure()
      style.remove()
      return { broken, fixed: measure() }
    })()`)
    ok('矮柱不會被時間標籤壓住（標籤在繪圖區外）',
      overlap && overlap.broken === false && overlap.fixed === true, JSON.stringify(overlap))

    const webs = await cdp.eval(`(async () => {
      const r = await window.electronAPI.screentime.stats({ kind: 'web', range: 'year', date: '2026-09-04' })
      return r && r.ok ? r.data : null
    })()`)
    ok('讀得到 Tai 舊資料（網站 Youtube）',
      Boolean(webs && webs.list.some((row) => /youtube/i.test(row.domain || '') || /youtube/i.test(row.name || ''))),
      JSON.stringify(webs?.list?.slice(0, 3) || webs))

    await cdp.eval(`document.querySelector('#stimeKind [data-kind="web"]').click()`)
    await waitFor(
      () => cdp.eval(`(document.getElementById('stimeList')?.textContent || '').length > 4`),
      10000, '網站清單畫出來'
    ).catch(() => {})
    ok('網站清單有內容',
      await cdp.eval(`(document.getElementById('stimeList')?.textContent || '').length > 4`))

    const paint = await cdp.eval(`(() => {
      const cs = (sel, prop) => {
        const node = document.querySelector(sel)
        return node ? getComputedStyle(node)[prop] : ''
      }
      return { card: cs('.stime-card', 'backgroundColor'), chart: cs('.stime-chart', 'backgroundColor') }
    })()`)
    const painted = (value) => Boolean(value) && value !== 'rgba(0, 0, 0, 0)' && value !== 'transparent'
    ok('卡片與圖表底色有畫出來',
      painted(paint.card) && painted(paint.chart), JSON.stringify(paint))

    ok('renderer 無未處理例外', cdp.exceptions.length === 0, JSON.stringify(cdp.exceptions))
  } catch (error) {
    failed += 1
    console.error(`\n未預期例外：${error.stack || error}`)
  } finally {
    if (cdp && originalSensors !== null) {
      try {
        await cdp.eval(`window.electronAPI.store.set('sysmonSensors', ${JSON.stringify(originalSensors)})`)
      } catch { /* 視窗已關 */ }
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
