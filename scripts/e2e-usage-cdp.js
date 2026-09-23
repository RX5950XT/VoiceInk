const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const { tempDir } = require('./lib/test-temp')
const os = require('os')
const http = require('http')

const PORT = 9241
// Windows 偶爾會有別的東西鎖住 dist/win-unpacked（打包失敗、防毒掃描中），
// 這時可以打包到別的資料夾再用 VOICEINK_EXE 指過去，測試不必等鎖放掉
const EXE = process.env.VOICEINK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
// 暫存 user-data-dir：使用者開著的正式實例佔 single-instance lock，
// 沒有自己的資料夾會被擋掉（second-instance 轉交後退出，CDP 等不到主視窗）
const USER_DATA_DIR = tempDir('voiceink-cdp-')
const EXPECTED_ORDER = ['chat', 'explorer', 'ccswitch', 'agy', 'stt', 'translate', 'sysmon', 'hfmodels', 'settings']
/** 條上每一家把東西全打開（含未連線的那幾家），結構斷言才有固定的七顆 */
const BAR_ALL = { kinds: ['rolling-5h', 'weekly', 'monthly'], showReset: true, showPlan: true, compact: false, hideDisconnected: false, showLastSync: true }
// 額度條長在工作區主區裡：種一個專案讓主區切得過去；感測器關掉免得跳 UAC
fs.writeFileSync(path.join(USER_DATA_DIR, 'config.json'), JSON.stringify({ sysmonSensors: false }))
fs.mkdirSync(path.join(USER_DATA_DIR, 'quota-project'))
fs.writeFileSync(path.join(USER_DATA_DIR, 'workspaces.json'), JSON.stringify({
  projects: [{ id: 'w_quota_test', name: '額度測試', path: path.join(USER_DATA_DIR, 'quota-project'), createdAt: Date.now() }]
}))
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
  // 額度條只在看得到的時候自動同步（document.hidden 也代表「被別的視窗整個蓋住」）：
  // 測試視窗常被蓋在後面，不關掉遮蔽偵測的話自動同步那條會隨機等不到
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA_DIR}`,
    '--disable-backgrounding-occluded-windows'], {
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
    // 額度條長在工作區主區最下面：先開一個專案讓主區切成工作區
    await cdp.eval(`document.querySelector('[data-page="chat"]').click(), 'ok'`)
    await cdp.eval(`document.getElementById('sidebarModeProjects').click(), 'ok'`)
    await waitFor(
      () => cdp.eval(`!!document.querySelector('#projList [data-id="w_quota_test"] .chat-list-open')`),
      15_000,
      '測試專案出現在側欄'
    )
    await cdp.eval(`document.querySelector('#projList [data-id="w_quota_test"] .chat-list-open').click(), 'ok'`)
    await waitFor(
      () => cdp.eval(`(() => { const bar = document.getElementById('quotaBar'); return !!bar && bar.offsetParent !== null })()`),
      15_000,
      '工作區底下的額度條'
    )

    originalSettings = await cdp.eval(`(async () => (await window.electronAPI.usage.load()).data.settings)()`)
    // 走真的 UI：彈窗是照畫面上那份狀態填的，直接打 IPC 存的設定會被下一次「儲存」蓋回去
    const applyAllOn = () => cdp.eval(`(async () => {
      document.getElementById('quotaSettingsBtn').click()
      document.querySelectorAll('#usageProviderToggles input').forEach((input) => { input.checked = true })
      const bar = ${JSON.stringify(BAR_ALL)}
      document.querySelectorAll('#usageBarToggles input').forEach((input) => {
        const key = input.value
        input.checked = key.startsWith('kind:') ? bar.kinds.includes(key.slice(5)) : Boolean(bar[key])
      })
      document.getElementById('usageSettingsSave').click()
      await new Promise((resolve) => setTimeout(resolve, 400))
    })()`)
    await applyAllOn()
    const chipCount = () => cdp.eval(`document.querySelectorAll('#quotaItems .quota-item').length`)
    await waitFor(async () => (await chipCount()) === 7, 8000, '七顆額度')

    const structure = await cdp.eval(`(() => {
      const bar = document.getElementById('quotaBar')
      const surfaces = document.getElementById('wsSurfaces').getBoundingClientRect()
      const rect = bar.getBoundingClientRect()
      return {
        order: [...document.querySelectorAll('.header-nav .nav-tab')].map((item) => item.dataset.page),
        noPage: !document.getElementById('page-usage'),
        inTermMain: bar.closest('#termMain') !== null,
        belowSurfaces: rect.top >= surfaces.bottom - 1,
        height: rect.height,
        chips: document.querySelectorAll('#quotaItems .quota-item').length
      }
    })()`)
    if (JSON.stringify(structure.order) !== JSON.stringify(EXPECTED_ORDER) || !structure.noPage ||
        !structure.inTermMain || !structure.belowSurfaces || structure.height > 30 || structure.chips !== 7) {
      throw new Error(`額度條結構錯誤：${JSON.stringify(structure)}`)
    }
    pass(`額度頁拿掉了；額度條在終端機下面、高 ${Math.round(structure.height)}px、七顆都在`)

    // ===== 顯示設定：哪幾家 =====
    const visibility = await cdp.eval(`(async () => {
      document.getElementById('quotaSettingsBtn').click()
      const dialog = document.getElementById('usageSettingsDialog')
      dialog.querySelector('#usageProviderToggles input[value="grok"]').checked = false
      document.getElementById('usageSettingsSave').click()
      await new Promise((resolve) => setTimeout(resolve, 500))
      const afterSave = document.querySelectorAll('#quotaItems .quota-item').length
      const hasGrok = !!document.querySelector('#quotaItems .quota-item[data-id="grok"]')
      document.querySelector('[data-page="ccswitch"]').click()
      document.querySelector('[data-page="chat"]').click()
      await new Promise((resolve) => setTimeout(resolve, 400))
      const saved = (await window.electronAPI.usage.load()).data.settings.visibleProviders
      return { afterSave, hasGrok, saved, dialogClosed: !dialog.open,
        afterSwitch: document.querySelectorAll('#quotaItems .quota-item').length }
    })()`)
    if (visibility.afterSave !== 6 || visibility.hasGrok || visibility.afterSwitch !== 6 ||
        visibility.saved.includes('grok') || !visibility.dialogClosed) {
      throw new Error(`顯示設定未生效或未持久：${JSON.stringify(visibility)}`)
    }
    pass('取消勾選的工具從條上拿掉，存進設定，切頁回來還是一樣')

    // 進工作區時快取太舊就該自己同步一次（不用按）
    const autoSynced = await waitFor(
      () => cdp.eval(`(async () => (await window.electronAPI.usage.load()).data.lastSyncedAt)()`),
      150_000,
      '進工作區後自動同步'
    )
    pass(`進工作區後自己同步了一次（${new Date(autoSynced).toLocaleTimeString('zh-TW')}）`)
    // 等畫面接到同步結果（量表要有資料才畫得出來）
    await waitFor(() => cdp.eval(`!document.getElementById('quotaSyncBtn').hasAttribute('aria-busy')`), 150_000, '自動同步收尾')
    const accountsWithWindows = await cdp.eval(`(async () => (await window.electronAPI.usage.load()).data.accounts.filter((a) => a.windows.length).length)()`)

    // ===== 顯示設定：每一家顯示什麼 =====
    await applyAllOn()
    const toggles = await cdp.eval(`(async () => {
      const applyBar = async (changes) => {
        document.getElementById('quotaSettingsBtn').click()
        for (const [key, on] of Object.entries(changes)) {
          document.querySelector('#usageBarToggles input[value="' + key + '"]').checked = on
        }
        document.getElementById('usageSettingsSave').click()
        await new Promise((resolve) => setTimeout(resolve, 400))
      }
      const meters = () => [...document.querySelectorAll('#quotaItems .quota-meter-label')].map((el) => el.textContent)
      const perChip = () => [...document.querySelectorAll('#quotaItems .quota-item')]
        .map((el) => el.querySelectorAll('.quota-meter').length)
      await applyBar({})
      const all = { meters: meters(), resets: document.querySelectorAll('#quotaItems .quota-meter-reset').length, perChip: perChip() }
      await applyBar({ 'kind:weekly': false, 'kind:monthly': false })
      const onlyFive = meters()
      await applyBar({ 'kind:weekly': true, 'kind:monthly': true, compact: true, showReset: false })
      const compact = { perChip: perChip(), resets: document.querySelectorAll('#quotaItems .quota-meter-reset').length }
      await applyBar({ compact: false, showReset: true, showLastSync: false })
      const lastSyncText = document.getElementById('quotaLastSync').textContent
      await applyBar({ showLastSync: true })
      return { all, onlyFive, compact, lastSyncText, saved: (await window.electronAPI.usage.load()).data.settings.bar }
    })()`)
    if (accountsWithWindows > 0 && toggles.all.meters.length === 0) {
      throw new Error(`有 ${accountsWithWindows} 家有額度視窗，條上卻一條量表都沒有：${JSON.stringify(toggles)}`)
    }
    if (toggles.onlyFive.some((label) => /週|月/.test(label))) {
      throw new Error(`只勾 5 小時仍畫出週／月：${JSON.stringify(toggles)}`)
    }
    if (toggles.compact.perChip.some((count) => count > 1) || toggles.compact.resets !== 0) {
      throw new Error(`精簡模式／關倒數沒生效：${JSON.stringify(toggles)}`)
    }
    if (toggles.lastSyncText !== '' || !toggles.saved.showLastSync || toggles.saved.compact) {
      throw new Error(`「上次同步時間」開關或存檔不對：${JSON.stringify(toggles)}`)
    }
    pass(`每一家顯示的項目照勾選畫（量表 ${toggles.all.meters.length} 條、精簡後每顆最多 1 條）`)

    // ===== 排序：鍵盤 Alt+→ 與拖曳 =====
    const keyboard = await cdp.eval(`(async () => {
      const before = [...document.querySelectorAll('#quotaItems .quota-item')].map((el) => el.dataset.id)
      const first = document.querySelector('#quotaItems .quota-item')
      first.querySelector('.quota-item-open').focus()
      first.querySelector('.quota-item-open').dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowRight', altKey: true, bubbles: true, cancelable: true
      }))
      await new Promise((resolve) => setTimeout(resolve, 500))
      const after = [...document.querySelectorAll('#quotaItems .quota-item')].map((el) => el.dataset.id)
      const saved = (await window.electronAPI.usage.load()).data.settings.providerOrder
      return {
        before, after, saved,
        focused: document.activeElement?.closest('.quota-item')?.dataset.id || '',
        announcement: document.getElementById('quotaSortStatus').textContent
      }
    })()`)
    if (keyboard.after[1] !== keyboard.before[0] || keyboard.after[0] !== keyboard.before[1] ||
        keyboard.saved.indexOf(keyboard.before[0]) <= keyboard.saved.indexOf(keyboard.before[1]) ||
        keyboard.focused !== keyboard.before[0] || !keyboard.announcement) {
      throw new Error(`鍵盤排序失敗：${JSON.stringify(keyboard)}`)
    }
    pass('Alt+→ 把那一顆往後搬、存起來、焦點留在原本那顆、有報讀')

    const drag = await cdp.eval(`(async () => {
      const items = () => [...document.querySelectorAll('#quotaItems .quota-item')]
      const before = items().map((el) => el.dataset.id)
      const source = items()[0]
      const target = items()[2]
      const point = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 1, isPrimary: true,
        button: type === 'pointerdown' ? 0 : -1, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y
      }))
      const a = source.getBoundingClientRect()
      const b = target.getBoundingClientRect()
      point(source.querySelector('.quota-item-open'), 'pointerdown', a.left + 6, a.top + a.height / 2)
      point(window, 'pointermove', a.left + 14, a.top + a.height / 2)
      point(window, 'pointermove', b.left + b.width * 0.75, b.top + b.height / 2)
      const dragging = source.classList.contains('is-dragging')
      point(window, 'pointerup', b.left + b.width * 0.75, b.top + b.height / 2)
      // 拖完緊接著的 click 不可以開詳情
      source.querySelector('.quota-item-open').click()
      await new Promise((resolve) => setTimeout(resolve, 500))
      const after = items().map((el) => el.dataset.id)
      const saved = (await window.electronAPI.usage.load()).data.settings.providerOrder
      const popoverOpen = document.getElementById('quotaPopover').matches(':popover-open')
      return { before, after, saved, dragging, popoverOpen }
    })()`)
    if (!drag.dragging || drag.after.indexOf(drag.before[0]) !== 2 ||
        drag.saved.indexOf(drag.before[0]) <= drag.saved.indexOf(drag.before[2]) || drag.popoverOpen) {
      throw new Error(`拖曳排序失敗：${JSON.stringify(drag)}`)
    }
    pass('拖曳排序會搬、會存，放開那一下不會誤開詳情')

    // ===== 詳情：點一下看完整那張卡 =====
    const popover = await cdp.eval(`(async () => {
      const chip = document.querySelector('#quotaItems .quota-item .quota-item-open')
      chip.click()
      await new Promise((resolve) => setTimeout(resolve, 200))
      const pop = document.getElementById('quotaPopover')
      const card = pop.querySelector('.usage-card')
      const popRect = pop.getBoundingClientRect()
      const barRect = document.getElementById('quotaBar').getBoundingClientRect()
      const result = {
        open: pop.matches(':popover-open'),
        card: !!card,
        provider: card?.dataset.provider || '',
        chip: chip.closest('.quota-item').dataset.id,
        above: popRect.bottom <= barRect.top + 1,
        inViewport: popRect.left >= 0 && popRect.right <= innerWidth,
        background: card ? getComputedStyle(card).backgroundColor : ''
      }
      chip.click()
      await new Promise((resolve) => setTimeout(resolve, 200))
      result.closedAgain = !pop.matches(':popover-open')
      return result
    })()`)
    if (!popover.open || !popover.card || popover.provider !== popover.chip || !popover.above ||
        !popover.inViewport || popover.background === 'rgba(0, 0, 0, 0)' || !popover.closedAgain) {
      throw new Error(`額度詳情異常：${JSON.stringify(popover)}`)
    }
    pass('點一下開那一家的完整卡片（在條的上方、不透明），再點一下收起來')

    await applyAllOn()
    const diagnostics = await cdp.eval(`(async () => {
      document.getElementById('quotaDiagnosticsBtn').click()
      await new Promise((resolve) => setTimeout(resolve, 400))
      const text = document.getElementById('usageDiagnosticsText').textContent
      document.getElementById('usageDiagnosticsClose').click()
      return text
    })()`)
    if (/Bearer\s+[A-Za-z0-9._-]{8,}|refresh_token|client_secret|sk-[A-Za-z0-9]/i.test(diagnostics)) {
      throw new Error('診斷內容疑似含憑證')
    }
    pass('診斷內容已去敏')

    const startedBusy = await cdp.eval(`(async () => {
      // 自動同步還在跑的話先等它跑完，這裡要量的是「按下去那一次」
      for (let i = 0; i < 300 && document.getElementById('quotaSyncBtn').hasAttribute('aria-busy'); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      document.getElementById('quotaSyncBtn').click()
      return document.getElementById('quotaSyncBtn').getAttribute('aria-busy') === 'true'
    })()`)
    if (!startedBusy) throw new Error('同步按鈕未進入 busy')
    const synced = await waitFor(
      () => cdp.eval(`(async () => {
        const button = document.getElementById('quotaSyncBtn')
        if (button.hasAttribute('aria-busy')) return null
        const response = await window.electronAPI.usage.load()
        let ollamaResetText = ''
        const ollamaChip = document.querySelector('#quotaItems .quota-item[data-id="ollama"] .quota-item-open')
        if (ollamaChip) {
          ollamaChip.click()
          ollamaResetText = document.querySelector('#quotaPopover .usage-reset-label')?.textContent || ''
          document.getElementById('quotaPopover').hidePopover()
        }
        return {
          chips: document.querySelectorAll('#quotaItems .quota-item').length,
          last: document.getElementById('quotaLastSync').textContent,
          error: document.getElementById('quotaLastSync').classList.contains('is-error'),
          providers: response.data.accounts.map((account) => ({
            provider: account.provider,
            status: account.status,
            windows: account.windows.length,
            resetWindows: account.windows.filter((window) => window.resetAt).length
          })),
          ollamaResetText
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
    const antigravityConsistent = antigravity && antigravity.windows === antigravity.resetWindows
    if (synced.chips !== 7 || !/^\d{1,2}:\d{2}$/.test(synced.last) || synced.error ||
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
        const bar = document.getElementById('quotaBar')
        const name = document.querySelector('#quotaItems .quota-item-name')
        results.push({
          theme,
          barDisplay: getComputedStyle(bar).display,
          nameColor: name ? getComputedStyle(name).color : '',
          bodyOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
        })
      }
      root.setAttribute('data-theme', original || 'dark')
      return results
    })()`)
    if (themes.some((item) => item.barDisplay === 'none' || item.bodyOverflow || !item.nameColor) ||
        themes[0].nameColor === themes[1].nameColor) {
      throw new Error(`主題/RWD 異常：${JSON.stringify(themes)}`)
    }
    pass('深淺主題都看得到、字色跟著主題換、沒有水平溢出')

    // ===== 用量統計子分頁 =====
    // 只驗「切得過去、面板都在、統計讀得出來」。**刻意不按「掃描本機記錄」**：
    // 那會讀滿 GB 等級的 session 記錄，是使用者自己決定要不要跑的動作，不該由測試代按。
    // 用量統計搬到 CC代理頁的子分頁
    await cdp.eval("document.querySelector('[data-page=\"ccswitch\"]').click()")
    await cdp.eval("document.querySelector('#ccSubtabs .subtab[data-subtab=\"stats\"]').click()")
    await waitFor(
      () => cdp.eval("document.getElementById('cc-stats').classList.contains('active') && document.querySelectorAll('#cuChart .cu-bar-col').length > 0"),
      15_000,
      'CC代理的用量統計子分頁'
    )
    pass('CC代理頁的「用量統計」子分頁切得過去')

    const statsPanels = await cdp.eval("document.querySelectorAll('#cc-stats .cc-panel').length")
    if (statsPanels !== 3) throw new Error(`用量統計應有三個面板，實際 ${statsPanels}`)
    pass('用量統計三個面板都在')

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
