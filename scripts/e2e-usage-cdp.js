const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const http = require('http')

const PORT = 9241
const EXE = path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
const EXPECTED_ORDER = ['chat', 'usage', 'transcribe', 'live', 'translate', 'settings']
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
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], {
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
      () => cdp.eval(`document.querySelectorAll('#usageGrid .usage-card').length === 5`),
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
    if (JSON.stringify(structure.order) !== JSON.stringify(EXPECTED_ORDER) || !structure.active || structure.cards !== 5) {
      throw new Error(`額度頁結構錯誤：${JSON.stringify(structure)}`)
    }
    pass('額度位於聊天右側，五張卡片可見')

    const visibility = await cdp.eval(`(async () => {
      document.getElementById('usageSettingsBtn').click()
      const dialog = document.getElementById('usageSettingsDialog')
      const grok = dialog.querySelector('input[value="grok"]')
      grok.checked = false
      document.getElementById('usageSettingsSave').click()
      await new Promise((resolve) => setTimeout(resolve, 500))
      const afterSave = document.querySelectorAll('#usageGrid .usage-card').length
      document.querySelector('[data-page="chat"]').click()
      document.querySelector('[data-page="usage"]').click()
      const afterSwitch = document.querySelectorAll('#usageGrid .usage-card').length
      return { afterSave, afterSwitch, dialogClosed: !dialog.open }
    })()`)
    if (visibility.afterSave !== 4 || visibility.afterSwitch !== 4 || !visibility.dialogClosed) {
      throw new Error(`顯示設定未持久：${JSON.stringify(visibility)}`)
    }
    pass('provider 顯示設定儲存並跨頁保留')

    await cdp.eval(`(async () => {
      document.getElementById('usageSettingsBtn').click()
      document.querySelector('#usageSettingsDialog input[value="grok"]').checked = true
      document.getElementById('usageSettingsSave').click()
    })()`)
    await waitFor(
      () => cdp.eval(`document.querySelectorAll('#usageGrid .usage-card').length === 5`),
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
      const origin = source.getBoundingClientRect()
      point('pointerdown', origin.left + 24, origin.top + 24)
      point('pointermove', origin.left + 44, origin.top + 30)
      const rect = target.getBoundingClientRect()
      point('pointermove', rect.left + rect.width * 0.75, rect.top + rect.height / 2)
      await new Promise((resolve) => requestAnimationFrame(resolve))
      const preview = [...document.querySelectorAll('#usageGrid .usage-card')]
        .map((card) => card.dataset.provider)
      const animations = [...document.querySelectorAll('#usageGrid .usage-card')]
        .reduce((count, card) => count + card.getAnimations().length, 0)
      const dragStyle = getComputedStyle(source)
      const dragged = {
        opacity: dragStyle.opacity,
        cursor: dragStyle.cursor,
        follows: dragStyle.transform !== 'none',
        head: source.querySelector('.usage-card-head').children.length,
        plan: source.querySelectorAll('.usage-plan-name, .usage-provider-mark').length
      }
      point('pointercancel', rect.left + 10, rect.top + 10)
      await new Promise((resolve) => requestAnimationFrame(resolve))
      const restored = [...document.querySelectorAll('#usageGrid .usage-card')]
        .map((card) => card.dataset.provider)
      return { before, preview, restored, animations, columns, dragged }
    })()`)
    if (JSON.stringify(dragPreview.preview) === JSON.stringify(dragPreview.before) ||
        dragPreview.animations < 1 ||
        dragPreview.columns !== 2 ||
        dragPreview.dragged.opacity !== '1' ||
        dragPreview.dragged.cursor !== 'grabbing' ||
        !dragPreview.dragged.follows ||
        dragPreview.dragged.head !== 2 ||
        dragPreview.dragged.plan !== 0 ||
        JSON.stringify(dragPreview.restored) !== JSON.stringify(dragPreview.before)) {
      throw new Error(`拖曳 FLIP preview／取消還原失敗：${JSON.stringify(dragPreview)}`)
    }
    pass('2 欄版面，拖曳中卡片不透明並平滑推開，取消後不寫入並還原')

    await cdp.eval(`window.electronAPI.usage.saveSettings(${JSON.stringify(originalSettings)})`)
    const reset = await cdp.eval(`(async () => {
      document.getElementById('usageSettingsBtn').click()
      document.getElementById('usageMonthlyDay').value = '31'
      document.getElementById('usageMonthlyTime').value = '23:59'
      document.getElementById('usageSettingsSave').click()
      await new Promise((resolve) => setTimeout(resolve, 500))
      return (await window.electronAPI.usage.load()).data.settings.opencodeMonthlyReset
    })()`)
    if (reset.day !== 31 || reset.hour !== 23 || reset.minute !== 59) {
      throw new Error(`OpenCode reset 未保存：${JSON.stringify(reset)}`)
    }
    pass('OpenCode reset 設定 round-trip')

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
          }))
        }
      })()`),
      150_000,
      '五家 provider 同步'
    )
    const allConnected = synced.providers.length === 5 &&
      synced.providers.every((provider) => provider.status !== 'disconnected')
    const antigravity = synced.providers.find((provider) => provider.provider === 'antigravity')
    if (synced.cards !== originalSettings.visibleProviders.length ||
        !/上次同步/.test(synced.last) || synced.error ||
        !allConnected || antigravity?.windows !== 4 || antigravity.resetWindows !== 4) {
      throw new Error(`同步後 UI 異常：${JSON.stringify(synced)}`)
    }
    pass('手動同步 busy／完成狀態與五家真實來源')

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
