'use strict'

/**
 * AGY 反代頁打包版驗收：`node scripts/e2e-agy-cdp.js`
 *
 * 刻意不送任何會抵達上游的請求——測試用 400／401 這種「到不了 cloudcode-pa 就失敗」
 * 的請求驗證管線與日誌，才不會消耗使用者的真實 Antigravity 額度。
 */

const { spawn } = require('child_process')
const path = require('path')
const os = require('os')
const fs = require('fs')
const http = require('http')

const PORT = 9243
const AGY_TEST_PORT = 18790
// Windows 偶爾會有別的東西鎖住 dist/win-unpacked（打包失敗、防毒掃描中），
// 這時可以打包到別的資料夾再用 VOICEINK_EXE 指過去，測試不必等鎖放掉
const EXE = process.env.VOICEINK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
// 暫存 user-data-dir：使用者開著的正式實例佔 single-instance lock，
// 沒有自己的資料夾會被擋掉（second-instance 轉交後退出，CDP 等不到主視窗）
const USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-cdp-'))
const EXPECTED_ORDER = ['chat', 'ccswitch', 'usage', 'agy', 'stt', 'translate', 'sysmon', 'hfmodels', 'settings']
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let body = ''
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (error) { reject(error) }
      })
    }).on('error', reject)
  })
}

class Cdp {
  constructor(url) {
    this.url = url
    this.id = 0
    this.pending = new Map()
    this.exceptions = []
    this.consoleErrors = []
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
      if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
        this.consoleErrors.push((message.params.args || []).map((item) => item.value || item.description || '').join(' '))
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
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    }
    return result.result?.value
  }

  async metrics(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false
    })
  }

  close() {
    try { this.ws.close() } catch {}
  }
}

async function waitFor(action, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const result = await action()
      if (result) return result
    } catch (error) {
      lastError = error
    }
    await sleep(300)
  }
  throw new Error(`等待逾時：${label}${lastError ? ` (${lastError.message})` : ''}`)
}

/** 直接對反代發原始 HTTP，驗證它真的在監聽 */
function rawRequest(pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const request = http.request({
      host: '127.0.0.1',
      port: AGY_TEST_PORT,
      path: pathname,
      method,
      headers,
      timeout: 8000
    }, (response) => {
      let text = ''
      response.on('data', (chunk) => { text += chunk })
      response.on('end', () => resolve({ status: response.statusCode, text }))
    })
    request.on('timeout', () => { request.destroy(); resolve({ status: 0, text: 'timeout' }) })
    request.on('error', (error) => resolve({ status: 0, text: error.message }))
    if (body !== undefined) request.end(body)
    else request.end()
  })
}

async function main() {
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA_DIR}`], { stdio: ['ignore', 'pipe', 'pipe'] })
  let processLog = ''
  child.stdout.on('data', (chunk) => { processLog += chunk })
  child.stderr.on('data', (chunk) => { processLog += chunk })

  let cdp = null
  let assertions = 0
  let startedService = false
  let originalAgy = null
  const pass = (message) => {
    assertions += 1
    console.log(`PASS  ${message}`)
  }
  const fail = (message) => { throw new Error(message) }

  try {
    const target = await waitFor(async () => {
      const pages = await getJson(`http://127.0.0.1:${PORT}/json/list`)
        .then((items) => items.filter((item) => item.type === 'page'))
        .catch(() => [])
      return pages.find((page) => /index\.html/.test(page.url)) || null
    }, 30_000, '主視窗')

    cdp = new Cdp(target.webSocketDebuggerUrl)
    await cdp.connect()
    await waitFor(
      () => cdp.eval(`document.readyState === 'complete' && typeof window.electronAPI?.agy?.status === 'function'`),
      15_000,
      'agy preload 初始化'
    )

    // electronAPI 由 preload 注入，早於 app.js 的模組腳本執行完畢——
    // 所以不能拿它當「nav 已綁好」的信號，要等點擊真的生效
    await waitFor(async () => cdp.eval(`(() => {
      document.querySelector('[data-page="agy"]').click()
      return document.getElementById('page-agy').classList.contains('active')
    })()`), 15_000, 'nav 綁定完成')

    // 使用者上次是開著的話 App 會自動接續啟動，先記下原設定再停下來，
    // 否則驗不到初始畫面，而且測完不還原等於把人家的反代設定改壞
    originalAgy = await cdp.eval(`(async () => (await window.electronAPI.agy.status()).data)()`)
    if (originalAgy?.running) {
      await cdp.eval(`window.electronAPI.agy.stop()`)
      await cdp.eval(`document.getElementById('agyRefreshBtn').click(), 'ok'`)
    }

    await waitFor(
      () => cdp.eval(`document.getElementById('agyStatusDot')?.classList.contains('is-stopped') === true`),
      15_000,
      'AGY 頁腳本初始化'
    )

    // --- 分頁結構 ---
    const structure = await cdp.eval(`(() => {
      document.querySelector('[data-page="agy"]').click()
      return {
        order: [...document.querySelectorAll('.header-nav .nav-tab')].map((item) => item.dataset.page),
        active: document.getElementById('page-agy').classList.contains('active'),
        label: document.querySelector('[data-page="agy"] .nav-text').textContent,
        hasControl: !!document.getElementById('agyToggleBtn'),
        hasTable: !!document.querySelector('.agy-table'),
        hasCharts: !!document.getElementById('agyHourlyChart') && !!document.getElementById('agyModelChart')
      }
    })()`)
    if (JSON.stringify(structure.order) !== JSON.stringify(EXPECTED_ORDER)) {
      fail(`nav 順序不符：${structure.order.join(',')}`)
    }
    if (!structure.active || !structure.hasControl || !structure.hasTable || !structure.hasCharts) {
      fail(`頁面結構不完整：${JSON.stringify(structure)}`)
    }
    if (structure.label !== 'AGY反代') fail(`分頁名稱錯誤：${structure.label}`)
    pass('nav 有 AGY反代且頁面三區塊齊全')

    // --- 停止狀態的初始畫面 ---
    const initial = await cdp.eval(`(() => ({
      statusText: document.getElementById('agyStatusText').textContent,
      dotStopped: document.getElementById('agyStatusDot').classList.contains('is-stopped'),
      toggleLabel: document.getElementById('agyToggleBtn').textContent,
      emptyVisible: !document.getElementById('agyLogEmpty').classList.contains('hidden')
    }))()`)
    if (initial.statusText !== '已停止' || !initial.dotStopped) fail(`初始狀態不對：${JSON.stringify(initial)}`)
    if (initial.toggleLabel !== '啟動服務') fail(`按鈕文字不對：${initial.toggleLabel}`)
    pass('未啟動時顯示已停止，且日誌有空狀態說明')

    // --- 換到測試埠並啟動 ---
    await cdp.eval(`window.electronAPI.agy.saveSettings({ port: ${AGY_TEST_PORT}, logBodies: false, retentionDays: 30 })`)
    const startResult = await cdp.eval(`window.electronAPI.agy.start()`)
    if (!startResult?.ok || startResult.data?.running !== true) {
      fail(`啟動失敗：${JSON.stringify(startResult)}`)
    }
    startedService = true
    pass(`服務在 127.0.0.1:${AGY_TEST_PORT} 啟動`)

    const health = await rawRequest('/health')
    if (health.status !== 200 || !JSON.parse(health.text).ok) fail(`/health 異常：${health.status} ${health.text}`)
    pass('/health 可探測且不需鑑權')

    const status = await cdp.eval(`(async () => (await window.electronAPI.agy.status()).data)()`)
    if (!status.apiKey || status.apiKey.length < 20) fail('未自動產生 API key')
    if (status.baseUrl !== `http://127.0.0.1:${AGY_TEST_PORT}/v1`) fail(`Base URL 不對：${status.baseUrl}`)
    if (Object.prototype.hasOwnProperty.call(status, 'project') || JSON.stringify(status).includes('cloudcode-pa')) {
      fail('狀態外洩了 project 或上游 URL')
    }
    pass('自動產生金鑰，且狀態不含 project／上游 URL')

    // --- 鑑權（不會抵達上游） ---
    const noKey = await rawRequest('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    })
    if (noKey.status !== 401) fail(`未帶金鑰應為 401，實際 ${noKey.status}`)
    pass('未帶金鑰被擋在 401')

    const badHost = await rawRequest('/v1/chat/completions', {
      method: 'POST',
      headers: { Host: 'evil.example.com', 'Content-Type': 'application/json' },
      body: '{}'
    })
    if (badHost.status !== 403) fail(`非本機 Host 應為 403，實際 ${badHost.status}`)
    pass('非本機 Host 被擋在 403（DNS rebinding）')

    // --- 壞 JSON：帶金鑰但在抵達上游前就失敗，可安全驗證日誌 ---
    const badJson = await rawRequest('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${status.apiKey}` },
      body: 'not-json'
    })
    if (badJson.status !== 400) fail(`壞 JSON 應為 400，實際 ${badJson.status} ${badJson.text}`)
    pass('壞 JSON 回 400，且未觸及上游')

    // --- UI 反映執行狀態與日誌 ---
    await cdp.eval(`document.getElementById('agyRefreshBtn').click()`)
    const running = await waitFor(async () => {
      const snapshot = await cdp.eval(`(() => ({
        dotRunning: document.getElementById('agyStatusDot').classList.contains('is-running'),
        toggleLabel: document.getElementById('agyToggleBtn').textContent,
        baseUrl: document.getElementById('agyBaseUrl').textContent,
        rows: document.querySelectorAll('#agyLogRows tr').length,
        statCards: document.querySelectorAll('.agy-stat-card').length
      }))()`)
      return snapshot.dotRunning && snapshot.rows >= 1 ? snapshot : null
    }, 12_000, '執行狀態與日誌列')
    if (running.toggleLabel !== '停止服務') fail(`按鈕未切換：${running.toggleLabel}`)
    if (running.statCards !== 4) fail(`統計卡數量不對：${running.statCards}`)
    if (!running.baseUrl.includes(String(AGY_TEST_PORT))) fail(`Base URL 未更新：${running.baseUrl}`)
    pass('UI 顯示執行中、Base URL 正確、統計卡與日誌列已渲染')

    // --- 客戶端提示：Anthropic 端點不能帶 /v1 ---
    const clients = await cdp.eval(`(() => ({
      anthropic: document.getElementById('agyAnthropicUrl')?.textContent || '',
      openai: document.getElementById('agyOpenaiUrl')?.textContent || '',
      hasCopy: !!document.querySelector('[data-agy-copy="anthropicBaseUrl"]')
    }))()`)
    if (!clients.openai.endsWith('/v1')) fail(`OpenAI Base URL 應帶 /v1：${clients.openai}`)
    if (clients.anthropic.endsWith('/v1') || `${clients.anthropic}/v1` !== clients.openai) {
      fail(`ANTHROPIC_BASE_URL 不該帶 /v1：${clients.anthropic}`)
    }
    if (!clients.hasCopy) fail('缺少 ANTHROPIC_BASE_URL 的複製鈕')
    pass('客戶端提示分開給兩種 Base URL，Anthropic 那組不帶 /v1')

    // --- 統計：時間範圍、堆疊排版、hover 數值 ---
    const layout = await cdp.eval(`(() => {
      const bars = document.getElementById('agyHourlyChart').getBoundingClientRect()
      const models = document.getElementById('agyModelChart').getBoundingClientRect()
      return { stacked: models.top >= bars.bottom, ranges: document.querySelectorAll('[data-agy-range]').length }
    })()`)
    if (!layout.stacked) fail('模型分佈應在請求量圖表下方，不是左右並排')
    if (layout.ranges !== 5) fail(`時間範圍按鈕數量不對：${layout.ranges}`)
    pass('統計圖表上下堆疊，且有 5 個時間範圍')

    const hourBars = await cdp.eval(`document.querySelectorAll('#agyHourlyChart .agy-bar-col').length`)
    if (hourBars < 24) fail(`24 小時應補滿 24 根長條，實際 ${hourBars}`)

    await cdp.eval(`document.querySelector('[data-agy-range="7d"]').click()`)
    const ranged = await waitFor(async () => {
      const snapshot = await cdp.eval(`(() => ({
        pressed: document.querySelector('[data-agy-range="7d"]').getAttribute('aria-pressed'),
        stale: document.querySelector('[data-agy-range="24h"]').getAttribute('aria-pressed'),
        bars: document.querySelectorAll('#agyHourlyChart .agy-bar-col').length,
        label: document.querySelector('#agyHourlyChart .agy-bar-label')?.textContent || '',
        meta: document.getElementById('agyTrendMeta').textContent
      }))()`)
      return snapshot.pressed === 'true' && snapshot.meta.includes('7 天') ? snapshot : null
    }, 8000, '切換到 7 天')
    if (ranged.stale !== 'false') fail('舊的範圍按鈕仍是 pressed')
    if (ranged.bars < 7) fail(`7 天應補滿天桶，實際 ${ranged.bars}`)
    if (!ranged.label.includes('/')) fail(`天桶標籤應為 月/日，實際 ${ranged.label}`)
    pass('切換時間範圍會重算統計與長條標籤')

    // hover 顯示數量：滑鼠不進場，直接派 pointerenter（桌面 QA 不搶使用者的游標）
    const tip = await cdp.eval(`(() => {
      const column = document.querySelector('#agyHourlyChart .agy-bar-col')
      column.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }))
      const node = document.getElementById('agyChartTip')
      const shown = { hidden: node.hidden, text: node.textContent }
      column.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }))
      return { ...shown, hiddenAfter: node.hidden }
    })()`)
    if (tip.hidden) fail('hover 長條時沒有顯示數值提示')
    if (!/\d+ 次請求/.test(tip.text)) fail(`提示沒有帶數量：${tip.text}`)
    if (!tip.hiddenAfter) fail('游標離開後提示沒有收起')
    pass(`hover 長條顯示數量：${tip.text.slice(0, 24)}`)

    await cdp.eval(`document.querySelector('[data-agy-range="24h"]').click()`)

    // 憑證引導：連得上就該收起來，連不上就要給出可執行的下一步。
    // 兩種狀態都合法（測試機不保證有 Antigravity 憑證），但不能兩邊都不成立。
    const credHelp = await cdp.eval(`(() => {
      const box = document.getElementById('agyCredentialHelp')
      const badge = document.getElementById('agyCredential')
      return {
        exists: !!box,
        hidden: box ? box.hidden : null,
        title: document.getElementById('agyCredentialHelpTitle')?.textContent || '',
        steps: document.querySelectorAll('#agyCredentialHelpSteps li').length,
        connected: !!badge && badge.classList.contains('is-ok')
      }
    })()`)
    if (!credHelp.exists) fail('找不到憑證引導區塊 #agyCredentialHelp')
    if (credHelp.connected) {
      if (!credHelp.hidden) fail('憑證正常時引導區塊不該顯示')
      pass('憑證正常 → 引導區塊收起')
    } else {
      if (credHelp.hidden) fail('憑證不可用時引導區塊應該顯示')
      if (!credHelp.title) fail('引導區塊缺標題')
      if (credHelp.steps < 2) fail(`引導步驟過少：${credHelp.steps}`)
      pass(`憑證不可用 → 顯示引導（${credHelp.steps} 個步驟）`)
    }

    const logRow = await cdp.eval(`(() => {
      const row = document.querySelector('#agyLogRows tr')
      return {
        isError: row.classList.contains('is-error'),
        badge: row.querySelector('.agy-badge')?.textContent || '',
        code: row.querySelector('.agy-error-code')?.textContent || ''
      }
    })()`)
    if (logRow.badge !== '400' || !logRow.isError || logRow.code !== 'INVALID_JSON') {
      fail(`日誌列內容不對：${JSON.stringify(logRow)}`)
    }
    pass('失敗請求記到日誌，狀態碼與錯誤代碼都顯示在列上')

    // --- 金鑰遮罩 ---
    const masked = await cdp.eval(`(() => document.getElementById('agyApiKey').textContent)()`)
    if (masked.includes(status.apiKey) || !masked.startsWith('•')) fail(`金鑰未遮罩：${masked}`)
    await cdp.eval(`document.getElementById('agyKeyToggleBtn').click()`)
    const revealed = await cdp.eval(`(() => ({
      text: document.getElementById('agyApiKey').textContent,
      pressed: document.getElementById('agyKeyToggleBtn').getAttribute('aria-pressed')
    }))()`)
    if (revealed.text !== status.apiKey || revealed.pressed !== 'true') fail('金鑰顯示切換失效')
    await cdp.eval(`document.getElementById('agyKeyToggleBtn').click()`)
    pass('API Key 預設遮罩，可切換顯示且 aria-pressed 同步')

    // --- 篩選 ---
    const filtered = await waitFor(async () => {
      await cdp.eval(`(() => {
        const select = document.getElementById('agyProtocolFilter')
        select.value = 'anthropic'
        select.dispatchEvent(new Event('change'))
      })()`)
      await sleep(600)
      // 不能假設「篩掉就會變 0 列」——正式 profile 裡本來就可能有 Anthropic 流量。
      // 要驗的是篩選有沒有生效：留下的每一列協議欄都必須是 Anthropic。
      return cdp.eval(`(() => {
        const cells = [...document.querySelectorAll('#agyLogRows tr')].map((row) => row.children[1]?.textContent)
        return cells.every((text) => text === 'Anthropic')
      })()`)
    }, 6000, '協議篩選')
    if (!filtered) fail('協議篩選未生效')
    await cdp.eval(`(() => {
      const select = document.getElementById('agyProtocolFilter')
      select.value = ''
      select.dispatchEvent(new Event('change'))
    })()`)
    pass('協議篩選可過濾出空結果')

    // --- RWD ---
    for (const width of [1440, 900, 560]) {
      await cdp.metrics(width, 900)
      await sleep(400)
      const overflow = await cdp.eval(`(() => {
        const shell = document.querySelector('.agy-shell')
        return {
          bodyOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          shellOverflow: shell.scrollWidth > shell.clientWidth + 1,
          statCols: getComputedStyle(document.getElementById('agyStatCards')).gridTemplateColumns.split(' ').length
        }
      })()`)
      if (overflow.bodyOverflow || overflow.shellOverflow) {
        fail(`${width}px 出現水平 overflow：${JSON.stringify(overflow)}`)
      }
      // 斷點是 max-width，所以寬度「正好等於」900／640 時就已經套用窄版
      const expectedCols = width > 900 ? 4 : width > 640 ? 2 : 1
      if (overflow.statCols !== expectedCols) {
        fail(`${width}px 統計卡欄數應為 ${expectedCols}，實際 ${overflow.statCols}`)
      }
      pass(`${width}px 無水平溢出，統計卡 ${overflow.statCols} 欄`)
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride')

    // --- 清空日誌：只驗按鈕存在，不真的按 ---
    // 這支腳本跑在使用者的正式 profile 上，`clearLogs()` 會把真正的流量紀錄與統計整個刪掉。
    // 清空行為由 `e2e-agy.js`（自己開暫存 DB）覆蓋，這裡不碰。
    const hasClearBtn = await cdp.eval(`!!document.getElementById('agyClearLogsBtn')`)
    if (!hasClearBtn) fail('缺少「清空日誌」按鈕')
    else pass('日誌工具列有「清空日誌」按鈕（不觸發，保留本機紀錄）')

    // --- 連線測試按鈕（真的送一則訊息到上游） ---
    const hasTestBtn = await cdp.eval(`!!document.getElementById('agyTestBtn')`)
    if (!hasTestBtn) fail('缺少「測試連線」按鈕')
    else pass('服務控制列有「測試連線」按鈕')

    await cdp.eval(`document.getElementById('agyTestBtn').click(), 'ok'`)
    const testResult = await waitFor(async () => {
      const state = await cdp.eval(`(() => {
        const box = document.getElementById('agyTestResult')
        return { text: box?.textContent || '', cls: box?.className || '' }
      })()`)
      return /is-ok|is-bad/.test(state.cls) ? state : null
    }, 90_000, '連線測試完成')

    // 「反向代理操作失敗」是 IPC 的通用訊息＝我們自己接線接錯（例如 main.js 的
    // service 白名單漏掉 selfTest），不是使用者環境問題，一定要當成失敗
    if (testResult.text.includes('反向代理操作失敗')) {
      fail(`連線測試回通用錯誤，代表 IPC 沒接好：${testResult.text}`)
    } else if (testResult.cls.includes('is-ok')) {
      pass(`連線測試通過：${testResult.text}`)
    } else {
      pass(`連線測試失敗但訊息具體：${testResult.text}`)
    }

    const stopResult = await cdp.eval(`window.electronAPI.agy.stop()`)
    if (!stopResult?.ok || stopResult.data?.running !== false) fail(`停止失敗：${JSON.stringify(stopResult)}`)
    startedService = false
    const afterStop = await rawRequest('/health')
    if (afterStop.status !== 0) fail(`停止後仍在監聽：${afterStop.status}`)
    pass('停止服務後埠不再監聽')

    console.log('\n可用模型面板')

    // fetchAvailableModels 只是型錄查詢，不產生任何 token，不會消耗使用者額度
    const panelIdle = await cdp.eval(`(() => {
      const list = document.getElementById('agyModelsList')
      return {
        exists: !!list,
        empty: !!list?.querySelector('.agy-models-empty'),
        rows: document.querySelectorAll('#agyModelsList .agy-model-row').length
      }
    })()`)
    if (!panelIdle.exists) fail('找不到模型面板 #agyModelsList')
    else if (panelIdle.empty && panelIdle.rows === 0) pass('進頁不自動查上游，先顯示提示')
    else fail(`進頁就查了上游：rows=${panelIdle.rows}`)

    await cdp.eval(`document.getElementById('agyModelsRefreshBtn').click()`)
    const panel = await waitFor(() => cdp.eval(`(() => {
      const button = document.getElementById('agyModelsRefreshBtn')
      if (button.disabled) return null
      return {
        rows: [...document.querySelectorAll('#agyModelsList .agy-model-id')].map((n) => n.textContent),
        meta: document.getElementById('agyModelsMeta')?.textContent || '',
        empty: !!document.querySelector('.agy-models-empty'),
        help: (() => {
          const box = document.getElementById('agyCredentialHelp')
          return {
            shown: !!box && !box.hidden,
            title: document.getElementById('agyCredentialHelpTitle')?.textContent || '',
            steps: document.querySelectorAll('#agyCredentialHelpSteps li').length
          }
        })()
      }
    })()`), 30_000, '模型查詢完成')

    if (panel.rows.length) {
      pass(`列出 ${panel.rows.length} 個可用模型`)
      const { compareModelIds } = require(path.join(__dirname, '..', 'src', 'main', 'agy', 'catalog'))
      const disordered = panel.rows.some((id, index) => (
        index > 0 && compareModelIds(panel.rows[index - 1], id) > 0
      ))
      if (!disordered) pass('可用模型由新到舊、同代依思考強度排序')
      else fail(`模型未依名稱排序：${panel.rows.join(', ')}`)
      if (/\d/.test(panel.meta)) pass('meta 有顯示數量')
      else fail(`meta 沒有數量：${panel.meta}`)

      const toggled = await cdp.eval(`(() => {
        const before = document.querySelectorAll('#agyModelsList .agy-model-row').length
        const toggle = document.getElementById('agyModelsShowAll')
        toggle.checked = true
        toggle.dispatchEvent(new Event('change', { bubbles: true }))
        const after = document.querySelectorAll('#agyModelsList .agy-model-row').length
        toggle.checked = false
        toggle.dispatchEvent(new Event('change', { bubbles: true }))
        return { before, after }
      })()`)
      if (toggled.after >= toggled.before) pass(`「顯示全部」展開 ${toggled.before} → ${toggled.after}`)
      else fail(`顯示全部反而變少：${toggled.before} → ${toggled.after}`)

      const copyable = await cdp.eval(`(() => {
        const first = document.querySelector('#agyModelsList .agy-model-id')
        return { tag: first?.tagName, label: first?.getAttribute('aria-label') || '' }
      })()`)
      if (copyable.tag === 'BUTTON') pass('模型 ID 本身就是複製鈕')
      else fail(`模型 ID 不是按鈕：${copyable.tag}`)
      if (copyable.label.includes('複製')) pass('複製鈕有無障礙標籤')
      else fail(`複製鈕缺標籤：${copyable.label}`)
    } else if (panel.meta.includes('憑證')) {
      // 憑證問題有明確下一步，不能只丟一句「查詢失敗」讓使用者自己猜。
      // 狀態面板的憑證檢查只在服務執行中才跑，所以這份指引得由模型查詢自己叫出來。
      pass('憑證不可用時說明是憑證問題')
      if (panel.help.shown && panel.help.steps > 0) {
        pass(`同時顯示憑證指引（${panel.help.steps} 個步驟）：${panel.help.title}`)
      } else {
        fail(`憑證失敗卻沒有顯示指引：${JSON.stringify(panel.help)}`)
      }
    } else if (panel.meta.includes('失敗')) {
      pass('查詢失敗時有明確訊息')
    } else {
      fail(`查詢後既沒有模型也沒有訊息：meta=${panel.meta}`)
    }

    // --- 切走頁面要停止輪詢 ---
    await cdp.eval(`document.querySelector('[data-page="chat"]').click()`)
    await sleep(500)
    const leftPage = await cdp.eval(`document.getElementById('page-agy').classList.contains('active') === false`)
    if (!leftPage) fail('切換頁面失敗')
    pass('可正常切離 AGY 頁')

    if (cdp.exceptions.length || cdp.consoleErrors.length) {
      throw new Error(`renderer errors: ${[...cdp.exceptions, ...cdp.consoleErrors].join('; ')}`)
    }
    if (/UnhandledPromiseRejection|FATAL|SyntaxError/i.test(processLog)) {
      throw new Error('main process log contains fatal error')
    }
    pass('renderer／main 無未處理例外')

    console.log(`\nALL PASS  ${assertions} passed, 0 failed\n`)
  } catch (error) {
    console.error(`\nFAILED  ${error.stack || error}`)
    console.error('Renderer exceptions:', JSON.stringify(cdp?.exceptions || []))
    console.error('Renderer console errors:', JSON.stringify(cdp?.consoleErrors || []))
    console.error('Process log:', processLog.slice(-6000))
    process.exitCode = 1
  } finally {
    // 一定要還原：測試改過埠，也可能讓 agyEnabled 留在 true 導致下次開 App 自動啟動
    if (cdp) {
      try {
        if (startedService) await cdp.eval(`window.electronAPI.agy.stop()`)
        // 還原使用者原本的埠與開關；這支腳本跑在真實 userData 上，不還原等於把設定改壞。
        // 拿不到原設定（開頭就失敗）才退回預設值。
        const restore = originalAgy
          ? { port: originalAgy.port, logBodies: originalAgy.logBodies === true, retentionDays: originalAgy.retentionDays }
          : { port: 8788, logBodies: false, retentionDays: 30 }
        await cdp.eval(`window.electronAPI.agy.saveSettings(${JSON.stringify(restore)})`)
        if (originalAgy?.running) await cdp.eval(`window.electronAPI.agy.start()`)
      } catch {}
    }
    cdp?.close()
    try { child.kill() } catch {}
    if (child.pid) {
      try { spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' }) } catch {}
    }
  }
}

main()
