const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')
const http = require('http')

const PORT = 9241
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
    await this.send('Page.enable')
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

  close() {
    try { this.ws.close() } catch {}
  }
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

async function getPages() {
  return getJson(`http://127.0.0.1:${PORT}/json/list`)
    .then((items) => items.filter((item) => item.type === 'page'))
    .catch(() => [])
}

async function main() {
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA_DIR}`], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let processLog = ''
  child.stdout.on('data', (chunk) => { processLog += chunk })
  child.stderr.on('data', (chunk) => { processLog += chunk })
  let cdp = null
  let originalSettings = null
  let assertions = 0
  const pass = (message) => {
    assertions++
    console.log(`PASS  ${message}`)
  }

  try {
    const target = await waitFor(async () => {
      const pages = await getPages()
      return pages.find((page) => /index\.html/.test(page.url)) || null
    }, 30_000, '主視窗')
    cdp = new Cdp(target.webSocketDebuggerUrl)
    await cdp.connect()
    await waitFor(
      () => cdp.eval(`document.readyState === 'complete' && typeof window.electronAPI?.usage?.load === 'function'`),
      15_000,
      '額度 preload 初始化'
    )
    // 預設頁是聊天，額度頁的模組要進頁才 dynamic import
    await cdp.eval(`document.querySelector('[data-page="usage"]').click(), 'ok'`)
    await waitFor(
      () => cdp.eval(`document.querySelectorAll('#usageGrid .usage-card').length >= 1`),
      15_000,
      '額度初始卡片'
    )

    originalSettings = await cdp.eval(`(async () => (await window.electronAPI.usage.load()).data.settings)()`)
    await cdp.eval(`(async () => {
      document.querySelector('[data-page="usage"]').click()
      document.getElementById('usageSettingsBtn').click()
      document.querySelectorAll('#usageProviderToggles input').forEach((input) => { input.checked = true })
      document.getElementById('usageSettingsSave').click()
    })()`)
    await waitFor(
      () => cdp.eval(`document.querySelectorAll('#usageGrid .usage-card').length === 7`),
      5000,
      '顯示全部 provider'
    )

    const structure = await cdp.eval(`(() => {
      document.querySelector('[data-page="usage"]').click()
      return {
        order: [...document.querySelectorAll('.header-nav .nav-tab')].map((item) => item.dataset.page),
        active: document.getElementById('page-usage').classList.contains('active'),
        cards: document.querySelectorAll('#usageGrid .usage-card').length
      }
    })()`)
    if (JSON.stringify(structure.order) !== JSON.stringify(EXPECTED_ORDER) || !structure.active || structure.cards !== 7) {
      throw new Error(`額度頁結構錯誤：${JSON.stringify(structure)}`)
    }
    pass('額度位於聊天右側，七張卡片可見')

    const setVisibleCount = async (count) => {
      await cdp.eval(`(() => {
        document.getElementById('usageSettingsBtn').click()
        document.querySelectorAll('#usageProviderToggles input').forEach((input, index) => {
          input.checked = index < ${count}
        })
        document.getElementById('usageSettingsSave').click()
      })()`)
      return waitFor(
        () => cdp.eval(`document.querySelectorAll('#usageGrid .usage-card').length === ${count}`),
        5000,
        `${count} 張額度卡片`
      )
    }
    const readGridLayout = () => cdp.eval(`(() => {
      const grid = document.getElementById('usageGrid')
      const cards = [...grid.querySelectorAll('.usage-card')]
      const rows = new Set(cards.map((card) => Math.round(card.getBoundingClientRect().top)))
      return {
        count: cards.length,
        columns: getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length,
        rows: rows.size,
        cardWidth: cards[0]?.getBoundingClientRect().width || 0
      }
    })()`)
    const expectedColumns = new Map([[2, 2], [3, 3], [4, 2], [5, 3], [6, 3], [7, 4]])
    const layoutMatrix = []
    for (const [count, columns] of expectedColumns) {
      await setVisibleCount(count)
      const layout = await readGridLayout()
      const expectedRows = Math.ceil(count / columns)
      if (layout.columns !== columns || layout.rows !== expectedRows) {
        throw new Error(`額度卡片 ${count} 張排版錯誤：${JSON.stringify(layout)}`)
      }
      layoutMatrix.push(layout)
    }
    await setVisibleCount(7)
    const wideLayout = await readGridLayout()
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 560,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false
    })
    const narrowLayout = await readGridLayout()
    await cdp.send('Emulation.clearDeviceMetricsOverride')
    if (narrowLayout.columns !== wideLayout.columns || narrowLayout.rows !== wideLayout.rows ||
        narrowLayout.cardWidth >= wideLayout.cardWidth) {
      throw new Error(`視窗縮放不應改變額度排版：${JSON.stringify({ wideLayout, narrowLayout })}`)
    }
    pass(`勾選數量決定排版（${layoutMatrix.map(({ count, columns, rows }) => `${count}=${columns}欄/${rows}列`).join('、')}），縮放只改卡片大小`)

    const visibility = await cdp.eval(`(async () => {
      document.getElementById('usageSettingsBtn').click()
      const dialog = document.getElementById('usageSettingsDialog')
      const grok = dialog.querySelector('input[value="grok"]')
      grok.checked = false
      document.getElementById('usageSettingsSave').click()
      await new Promise((resolve) => setTimeout(resolve, 500))
      const chips = () => document.querySelectorAll('#usageProviderSummary .usage-provider-chip').length
      const afterSave = document.querySelectorAll('#usageGrid .usage-card').length
      const chipsAfterSave = chips()
      document.querySelector('[data-page="chat"]').click()
      document.querySelector('[data-page="usage"]').click()
      const afterSwitch = document.querySelectorAll('#usageGrid .usage-card').length
      const chipsAfterSwitch = chips()
      return { afterSave, afterSwitch, chipsAfterSave, chipsAfterSwitch, dialogClosed: !dialog.open }
    })()`)
    if (visibility.afterSave !== 6 || visibility.afterSwitch !== 6 || !visibility.dialogClosed) {
      throw new Error(`顯示設定未持久：${JSON.stringify(visibility)}`)
    }
    pass('provider 顯示設定儲存並跨頁保留')

    // 頂部橫條要跟卡片同一份 visibleAccounts()，關掉的 provider 不該還掛在上面
    if (visibility.chipsAfterSave !== 6 || visibility.chipsAfterSwitch !== 6) {
      throw new Error(`頂部橫條未跟隨顯示設定：${JSON.stringify(visibility)}`)
    }
    pass('頂部 provider 橫條只顯示勾選的項目')

    await cdp.eval(`(async () => {
      document.getElementById('usageSettingsBtn').click()
      document.querySelector('#usageSettingsDialog input[value="grok"]').checked = true
      document.getElementById('usageSettingsSave').click()
    })()`)
    await waitFor(
      () => cdp.eval(`document.querySelectorAll('#usageGrid .usage-card').length === 7`),
      5000,
      '恢復顯示設定'
    )

    const ordering = await cdp.eval(`(async () => {
      const before = (await window.electronAPI.usage.load()).data.settings.providerOrder
      const first = before[0]
      const card = document.querySelector('[data-provider="' + first + '"]')
      const sendKey = (key) => card.dispatchEvent(new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true
      }))
      card.focus()
      sendKey(' ')
      sendKey('ArrowRight')
      const preview = [...document.querySelectorAll('#usageGrid .usage-card')]
        .map((item) => item.dataset.provider)
      sendKey('Enter')
      await new Promise((resolve) => setTimeout(resolve, 500))
      const after = (await window.electronAPI.usage.load()).data.settings.providerOrder
      const cancelCard = document.querySelector('[data-provider="' + after[0] + '"]')
      const cancelKey = (key) => cancelCard.dispatchEvent(new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true
      }))
      cancelCard.focus()
      cancelKey(' ')
      cancelKey('ArrowRight')
      const cancelPreview = [...document.querySelectorAll('#usageGrid .usage-card')]
        .map((item) => item.dataset.provider)
      cancelKey('Escape')
      await new Promise((resolve) => setTimeout(resolve, 100))
      const afterCancel = (await window.electronAPI.usage.load()).data.settings.providerOrder
      const cancelRestored = [...document.querySelectorAll('#usageGrid .usage-card')]
        .map((item) => item.dataset.provider)
      return {
        before,
        preview,
        after,
        cancelPreview,
        cancelRestored,
        afterCancel,
        orderButtons: document.querySelectorAll('.usage-order-btn').length,
        announcement: document.getElementById('usageSortStatus')?.textContent || ''
      }
    })()`)
    if (ordering.orderButtons !== 0 || ordering.preview[1] !== ordering.before[0] ||
        ordering.after[1] !== ordering.before[0] || !ordering.announcement ||
        JSON.stringify(ordering.cancelPreview) === JSON.stringify(ordering.cancelRestored) ||
        JSON.stringify(ordering.cancelRestored) !== JSON.stringify(ordering.after) ||
        JSON.stringify(ordering.afterCancel) !== JSON.stringify(ordering.after)) {
      throw new Error(`無按鈕鍵盤排序失敗：${JSON.stringify(ordering)}`)
    }
    pass('無可見按鈕，卡片鍵盤排序可持久化並報讀')

    await cdp.eval(`window.electronAPI.usage.saveSettings(${JSON.stringify(originalSettings)})`)
    const dragPreview = await cdp.eval(`(async () => {
      document.querySelector('[data-page="chat"]').click()
      document.querySelector('[data-page="usage"]').click()
      // 進頁的 render() 是非同步的，會 replaceChildren 整個 grid；
      // 不等它跑完就抓 card，拿到的是已經脫離文件的節點（getComputedStyle 全回空字串）
      await new Promise((resolve) => setTimeout(resolve, 500))
      const cards = [...document.querySelectorAll('#usageGrid .usage-card')]
      const source = cards[0]
      const target = cards[2]
      const before = cards.map((card) => card.dataset.provider)
      const columns = getComputedStyle(document.getElementById('usageGrid'))
        .gridTemplateColumns.split(' ').length
      const point = (type, x, y) => source.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        isPrimary: true,
        button: type === 'pointerdown' ? 0 : -1,
        buttons: type === 'pointerdown' ? 1 : 0,
        clientX: x,
        clientY: y
      }))
      const visualOrder = (nodes) => [...nodes].sort((a, b) => {
        const ra = a.getBoundingClientRect()
        const rb = b.getBoundingClientRect()
        if (Math.abs(ra.top - rb.top) > 12) return ra.top - rb.top
        return ra.left - rb.left
      }).map((card) => card.dataset.provider)
      const origin = source.getBoundingClientRect()
      point('pointerdown', origin.left + 24, origin.top + 24)
      point('pointermove', origin.left + 44, origin.top + 30)
      const rect = target.getBoundingClientRect()
      point('pointermove', rect.left + rect.width * 0.75, rect.top + rect.height / 2)
      await new Promise((resolve) => requestAnimationFrame(resolve))
      const liveCards = [...document.querySelectorAll('#usageGrid .usage-card')]
      const preview = visualOrder(liveCards)
      const domUnchanged = liveCards.map((card) => card.dataset.provider)
      const shifted = liveCards.some((card) => getComputedStyle(card).transform !== 'none')
      const overlay = document.querySelector('.usage-card-overlay')
      const overlayStyle = overlay ? getComputedStyle(overlay) : null
      const ghostStyle = getComputedStyle(source)
      const dragged = {
        ghostOpacity: ghostStyle.opacity,
        overlayExists: Boolean(overlay),
        overlayOpacity: overlayStyle?.opacity || '',
        overlayFollows: overlayStyle ? overlayStyle.transform !== 'none' : false,
        overlayInGrid: Boolean(overlay?.closest('#usageGrid')),
        overlayCursor: overlayStyle?.cursor || '',
        shifted,
        head: source.querySelector('.usage-card-head').children.length,
        plan: source.querySelectorAll('.usage-plan-name, .usage-provider-mark').length
      }
      point('pointercancel', rect.left + 10, rect.top + 10)
      await new Promise((resolve) => requestAnimationFrame(resolve))
      const restored = [...document.querySelectorAll('#usageGrid .usage-card')]
        .map((card) => card.dataset.provider)
      const leftover = Boolean(document.querySelector('.usage-card-overlay'))
      return { before, preview, domUnchanged, restored, leftover, columns, dragged }
    })()`)
    if (JSON.stringify(dragPreview.preview) === JSON.stringify(dragPreview.before) ||
        JSON.stringify(dragPreview.domUnchanged) !== JSON.stringify(dragPreview.before) ||
        dragPreview.columns !== 4 ||
        dragPreview.leftover ||
        !dragPreview.dragged.shifted ||
        Number(dragPreview.dragged.ghostOpacity) > 0.3 ||
        Number(dragPreview.dragged.overlayOpacity) < 0.9 ||
        !dragPreview.dragged.overlayExists ||
        !dragPreview.dragged.overlayFollows ||
        dragPreview.dragged.overlayInGrid ||
        dragPreview.dragged.overlayCursor !== 'grabbing' ||
        dragPreview.dragged.head !== 2 ||
        dragPreview.dragged.plan !== 0 ||
        JSON.stringify(dragPreview.restored) !== JSON.stringify(dragPreview.before)) {
      throw new Error(`拖曳 overlay／鬼影預覽／取消還原失敗：${JSON.stringify(dragPreview)}`)
    }
    pass('4 欄版面，跟手 overlay 不透明、格子裡半透明預覽，拖曳中不改 DOM，取消後還原')

    await cdp.eval(`window.electronAPI.usage.saveSettings(${JSON.stringify(originalSettings)})`)
    const diagnostics = await cdp.eval(`(async () => {
      document.getElementById('usageDiagnosticsBtn').click()
      await new Promise((resolve) => setTimeout(resolve, 400))
      const text = document.getElementById('usageDiagnosticsText').textContent
      document.getElementById('usageDiagnosticsClose').click()
      return text
    })()`)
    if (/Bearer\s+[A-Za-z0-9._-]{8,}|refresh_token|client_secret|sk-[A-Za-z0-9]/i.test(diagnostics)) {
      throw new Error('診斷內容疑似含憑證')
    }
    pass('診斷內容已去敏')

    const startedBusy = await cdp.eval(`(() => {
      document.getElementById('usageSyncBtn').click()
      return document.getElementById('usageSyncBtn').getAttribute('aria-busy') === 'true'
    })()`)
    if (!startedBusy) throw new Error('同步按鈕未進入 busy')
    const synced = await waitFor(
      () => cdp.eval(`(async () => {
        const button = document.getElementById('usageSyncBtn')
        if (button.hasAttribute('aria-busy')) return null
        const response = await window.electronAPI.usage.load()
        return {
          cards: document.querySelectorAll('#usageGrid .usage-card').length,
          last: document.getElementById('usageLastSync').textContent,
          error: document.getElementById('usageError').textContent,
          providers: response.data.accounts.map((account) => ({
            provider: account.provider,
            status: account.status,
            windows: account.windows.length,
            resetWindows: account.windows.filter((window) => window.resetAt).length
          })),
          ollamaResetText: document.querySelector('[data-provider="ollama"] .usage-reset-label')?.textContent || ''
        }
      })()`),
      150_000,
      '七家 provider 同步'
    )
    // opencode-go 沒訂閱時回 403、commandcode 沒跑過 cmd login 時根本沒有金鑰，
    // 這兩家的「未連線」是正確結果，不是程式壞掉
    const allConnected = synced.providers.length === 7 &&
      synced.providers.every((provider) => (
        provider.status !== 'disconnected' || provider.provider === 'opencode-go' || provider.provider === 'commandcode'
      ))
    const antigravity = synced.providers.find((provider) => provider.provider === 'antigravity')
    const ollama = synced.providers.find((provider) => provider.provider === 'ollama')
    // Antigravity 走**真上游**（這支測試不打 mock）。暫存 user-data-dir 的環境下沒有
    // 上一次的快取可併，401 就回空窗——「windows === 4」只有在讀到使用者本機
    // usage.json 的快取時才會成立（舊版測試沒有暫存資料夾，是靠那個撐著的）。
    // 所以這裡只驗「結構與窗數一致」，數字本身由 test-usage.js 的純函式斷言守。
    const antigravityConsistent = antigravity &&
      antigravity.windows === antigravity.resetWindows &&
      (antigravity.status === 'connected' ? antigravity.windows >= 0 : true)
    if (synced.cards !== originalSettings.visibleProviders.length ||
        !/上次同步/.test(synced.last) || synced.error ||
        !allConnected || !antigravityConsistent ||
        // Ollama 上游不給重置時間，補一個假的就是這裡會抓到
        (ollama?.windows > 0 && (ollama.resetWindows !== 0 || synced.ollamaResetText !== '上游未提供重置時間'))) {
      throw new Error(`同步後 UI 異常：${JSON.stringify(synced)}`)
    }
    pass('手動同步 busy／完成狀態與七家真實來源')

    const themes = await cdp.eval(`(() => {
      const root = document.documentElement
      const original = root.getAttribute('data-theme')
      const results = []
      for (const theme of ['dark', 'light']) {
        root.setAttribute('data-theme', theme)
        const page = document.getElementById('page-usage')
        const card = document.querySelector('.usage-card')
        results.push({
          theme,
          pageDisplay: getComputedStyle(page).display,
          cardBackground: getComputedStyle(card).backgroundColor,
          bodyOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
        })
      }
      root.setAttribute('data-theme', original || 'dark')
      return results
    })()`)
    if (themes.some((item) => item.pageDisplay === 'none' || item.bodyOverflow || item.cardBackground === 'rgba(0, 0, 0, 0)')) {
      throw new Error(`主題/RWD 異常：${JSON.stringify(themes)}`)
    }
    pass('深淺主題可見且無水平溢出')

    // ===== 用量統計子分頁 =====
    // 只驗「切得過去、面板都在、統計讀得出來」。**刻意不按「掃描本機記錄」**：
    // 那會讀滿 GB 等級的 session 記錄，是使用者自己決定要不要跑的動作，不該由測試代按。
    await cdp.eval("document.querySelector('#usageSubtabs .subtab[data-subtab=\"stats\"]').click()")
    await waitFor(
      () => cdp.eval("document.getElementById('usage-stats').classList.contains('active')"),
      10_000,
      '用量統計子分頁'
    )
    pass('用量統計子分頁切得過去')

    const statsPanels = await cdp.eval("document.querySelectorAll('#usage-stats .cc-panel').length")
    if (statsPanels !== 3) throw new Error(`用量統計應有三個面板，實際 ${statsPanels}`)
    pass('用量統計三個面板都在')

    // 額度那組操作鈕在統計子分頁沒有意義，要收起來
    const quotaBtnHidden = await cdp.eval("document.getElementById('usageSyncBtn').classList.contains('hidden')")
    if (!quotaBtnHidden) throw new Error('統計子分頁沒有收起額度的同步鈕')
    pass('統計子分頁收起額度操作鈕')

    const cuStats = await cdp.eval("window.electronAPI.codeusage.stats({ range: '7d' })")
    if (!cuStats?.ok) throw new Error(`用量統計 IPC 失敗：${JSON.stringify(cuStats?.error || {})}`)
    if (cuStats.data.range !== '7d') throw new Error('range 沒有照送出去的 key')
    if (cuStats.data.providers.length !== 5) throw new Error('用量統計應涵蓋五家')
    pass('用量統計 IPC 回得出五家')

    const badRange = await cdp.eval("window.electronAPI.codeusage.stats({ range: 'rm -rf' })")
    if (badRange?.data?.range !== '7d') throw new Error('未知 range 沒有退回預設')
    pass('未知的時間範圍退回預設')

    // 趨勢與分佈都要帶 token 明細：只回一個總數的話，使用者看到「幾百億 token」
    // 無從判斷那是真的在打模型還是在讀快取（價差 10 倍）
    const PARTS = ['input', 'output', 'cacheRead', 'cacheWrite']
    const point = cuStats.data.series?.[0] || {}
    const missing = PARTS.filter((key) => typeof point[key] !== 'number')
    if (missing.length) throw new Error(`序列缺 token 明細：${missing.join(',')}`)
    const distMissing = PARTS.filter((key) => typeof cuStats.data.providers?.[0]?.[key] !== 'number')
    if (distMissing.length) throw new Error(`分佈缺 token 明細：${distMissing.join(',')}`)
    pass('趨勢與分佈都帶輸入／輸出／快取讀／快取寫')

    // 四種顏色一定要有對照，否則畫面上只是四種不明色塊
    const legend = await cdp.eval(
      "[...document.querySelectorAll('#cuChartLegend .cu-legend-label')].map((el) => el.textContent)"
    )
    if (legend.join(',') !== '輸入,輸出,快取讀,快取寫') {
      throw new Error(`圖例不對：${JSON.stringify(legend)}`)
    }
    pass('趨勢圖有四種 token 的顏色圖例')

    // 滑鼠移上去要浮出數字。**要真的派滑鼠事件並量 opacity**——只檢查節點在不在的話，
    // CSS 沒接上（`:hover` 選擇器打錯、被 overflow 裁掉）照樣是綠的
    // 視窗還沒被 show 出來（ready-to-show 慢的機器上）Chromium 不會更新 :hover 狀態，
    // 所以先把 page 帶到前景；這對 CDP 派的合成事件一樣有效。
    await cdp.send('Page.bringToFront', {})
    const barBox = await cdp.eval(`(() => {
      const col = document.querySelector('#cuChart .cu-bar-col')
      if (!col) return null
      const r = col.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height - 4, tip: Boolean(col.querySelector('.cu-bar-tip')) }
    })()`)
    if (!barBox?.tip) throw new Error('趨勢長條沒有掛數字提示')
    const tipBefore = await cdp.eval(
      "getComputedStyle(document.querySelector('#cuChart .cu-bar-tip')).opacity"
    )
    if (tipBefore !== '0') throw new Error(`沒 hover 時提示就已經露出來了（${tipBefore}）`)
    // **不要睡固定時間**：opacity 有 0.12s transition，而機器忙的時候（同時在打包／掃毒）
    // 那一格 frame 可能好幾百毫秒才來，`sleep(250)` 會量到還在 0 的中間狀態。
    // 每一輪都重派一次 mouseMoved：合成事件不會像真滑鼠那樣停在原地持續產生 hover。
    const readTip = () => cdp.eval(`(() => {
      const tip = document.querySelector('#cuChart .cu-bar-tip')
      if (!tip) return null
      return { opacity: getComputedStyle(tip).opacity, height: tip.offsetHeight, text: tip.textContent }
    })()`)
    let tipAfter = null
    const hoverDeadline = Date.now() + 8000
    while (Date.now() < hoverDeadline) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: Math.round(barBox.x), y: Math.round(barBox.y)
      })
      await sleep(200)
      tipAfter = await readTip()
      if (tipAfter && Number(tipAfter.opacity) >= 0.9 && tipAfter.height > 0) break
    }
    if (!tipAfter || Number(tipAfter.opacity) < 0.9 || tipAfter.height === 0) {
      throw new Error(`hover 後提示沒浮出來：${JSON.stringify(tipAfter)}`)
    }
    if (!/次/.test(tipAfter.text) || !/tokens/.test(tipAfter.text)) {
      throw new Error(`提示沒有數字：${JSON.stringify(tipAfter.text)}`)
    }
    pass('滑鼠移到趨勢長條上會顯示數字')

    await cdp.eval("document.getElementById('cuPricesBtn').click()")
    const priceRows = await cdp.eval("document.querySelectorAll('#cuPriceRows .cu-price-row').length")
    if (!priceRows) throw new Error('單價彈窗沒有列出模型')
    pass(`單價彈窗列出 ${priceRows} 個模型`)

    // 長對話有九成 token 走快取，只有輸入／輸出兩格算不出真正的錢
    const priceFields = await cdp.eval(
      "[...document.querySelectorAll('#cuPriceRows .cu-price-row[data-model] input')]"
      + ".slice(0, 4).map((el) => el.dataset.field)"
    )
    if (JSON.stringify(priceFields) !== JSON.stringify(['input', 'output', 'cacheRead', 'cacheWrite'])) {
      throw new Error(`單價欄位不對：${JSON.stringify(priceFields)}`)
    }
    pass('單價每一列有輸入／輸出／快取讀／快取寫四格')

    const anthropicPrice = await cdp.eval(`(() => {
      const row = document.querySelector('#cuPriceRows .cu-price-row[data-model="claude-opus-5"]')
      if (!row) return null
      const get = (f) => row.querySelector('[data-field="' + f + '"]').value
      return { input: get('input'), cacheRead: get('cacheRead'), cacheWrite: get('cacheWrite') }
    })()`)
    if (anthropicPrice && !(anthropicPrice.cacheRead && anthropicPrice.cacheWrite)) {
      throw new Error(`內建快取單價沒填：${JSON.stringify(anthropicPrice)}`)
    }
    pass('內建單價含快取讀寫價')

    const cuCards = await cdp.eval(
      "[...document.querySelectorAll('#cuSummary .cu-stat-label')].map((el) => el.textContent)"
    )
    if (!cuCards.includes('快取寫入')) throw new Error(`摘要缺快取寫入卡：${JSON.stringify(cuCards)}`)
    pass('摘要有「快取寫入」卡（那也是要付錢的）')
    await cdp.eval("document.getElementById('cuPricesCancelBtn').click()")
    if (await cdp.eval("document.getElementById('cuPricesDialog').open")) {
      throw new Error('單價彈窗關不掉')
    }
    pass('單價彈窗取消關得掉')

    // 切回訂閱額度，讓後面的檢查與收尾在原本的狀態下進行
    await cdp.eval("document.querySelector('#usageSubtabs .subtab[data-subtab=\"quota\"]').click()")

    if (process.env.VOICEINK_USAGE_SCREENSHOT) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false
      })
      const capture = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true
      })
      fs.writeFileSync(process.env.VOICEINK_USAGE_SCREENSHOT, capture.data, 'base64')
    }

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
    console.error('Process log:', processLog.slice(-8000))
    process.exitCode = 1
  } finally {
    if (cdp && originalSettings) {
      try {
        await cdp.eval(`window.electronAPI.usage.saveSettings(${JSON.stringify(originalSettings)})`)
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
