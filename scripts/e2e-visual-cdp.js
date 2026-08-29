const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

const PORT = 9243
const EXE = path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
const USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-e2e-visual-'))
const PAGES = ['chat', 'terminal', 'usage', 'agy', 'stt', 'translate', 'settings']
const VIEWPORTS = [
  { width: 1440, height: 1000 },
  { width: 900, height: 900 },
  { width: 560, height: 900 }
]
const SIGNATURES = {
  chat: ['.chat-sidebar', '.chat-main', '.chat-composer'],
  terminal: ['.term-sidebar', '.term-host'],
  usage: ['.usage-card', '.usage-summary-strip'],
  agy: ['.agy-control', '.agy-stats', '.agy-models', '.agy-logs'],
  stt: ['.drop-zone', '.result-panel'],
  translate: ['.translate-pane', '.translate-banner'],
  settings: ['.settings-card', '.settings-nav', '.settings-save-bar']
}
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

function stopTestApp(child) {
  if (!child?.pid) return
  try {
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } catch { /* 程序已結束 */ }
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
        this.consoleErrors.push((message.params.args || [])
          .map((item) => item.value || item.description || '')
          .join(' '))
      }
      if (!message.id || !this.pending.has(message.id)) return
      const pending = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
    this.ws.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('CDP 連線已關閉'))
      this.pending.clear()
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

function assertSurface(page, theme, viewport, result) {
  if (!result.active) throw new Error(`${page}/${theme}/${viewport.width}: page 未啟用`)
  if (result.overflow) {
    throw new Error(`${page}/${theme}/${viewport.width}: document 水平溢出 ${JSON.stringify(result.offenders)}`)
  }
  if (!result.items.length) throw new Error(`${page}/${theme}/${viewport.width}: 找不到 visual signature`)
  for (const item of result.items) {
    if (item.radius !== '12px') {
      throw new Error(`${page}/${theme}/${viewport.width}: ${item.selector} radius=${item.radius}`)
    }
    if (item.background === 'rgba(0, 0, 0, 0)') {
      throw new Error(`${page}/${theme}/${viewport.width}: ${item.selector} surface 透明`)
    }
    if (!/blur/.test(item.backdrop)) {
      throw new Error(`${page}/${theme}/${viewport.width}: ${item.selector} 缺 glass blur`)
    }
  }
}

async function capture(cdp, outputDir, theme, page, width) {
  if (!outputDir) return
  fs.mkdirSync(outputDir, { recursive: true })
  const result = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true
  })
  fs.writeFileSync(path.join(outputDir, `${theme}-${page}-${width}.png`), result.data, 'base64')
}

async function main() {
  const child = spawn(EXE, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DATA_DIR}`,
    '--hidden',
    '--disable-backgrounding-occluded-windows'
  ], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let processLog = ''
  child.stdout.on('data', (chunk) => { processLog += chunk })
  child.stderr.on('data', (chunk) => { processLog += chunk })
  let cdp = null
  let checks = 0

  try {
    const target = await waitFor(async () => {
      const pages = await getPages()
      return pages.find((page) => /index\.html/.test(page.url)) || null
    }, 30_000, '主視窗')
    cdp = new Cdp(target.webSocketDebuggerUrl)
    await cdp.connect()
    await waitFor(
      () => cdp.eval(`document.readyState === 'complete' && document.querySelectorAll('.nav-tab').length === ${PAGES.length}`),
      15_000,
      'renderer 初始化'
    )

    const outputDir = process.env.VOICEINK_VISUAL_DIR || ''
    for (const viewport of VIEWPORTS) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        ...viewport,
        deviceScaleFactor: 1,
        mobile: false
      })
      for (const theme of ['dark', 'light']) {
        await cdp.eval(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)})`)
        for (const page of PAGES) {
          await cdp.eval(`document.querySelector('[data-page=${JSON.stringify(page)}]').click()`)
          // 測試視窗以 --hidden 啟動；背景頁不保證觸發 rAF 或 timer，等待放在 Node 端。
          await sleep(80)
          const result = await cdp.eval(`(() => {
            const host = document.getElementById(${JSON.stringify(`page-${page}`)})
            const selectors = ${JSON.stringify(SIGNATURES[page])}
            return {
              active: host.classList.contains('active'),
              overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
              offenders: [...document.querySelectorAll('body *')]
                .filter((element) => {
                  const rect = element.getBoundingClientRect()
                  return rect.width > 0 && (rect.right > document.documentElement.clientWidth + 1 || rect.left < -1)
                })
                .slice(0, 8)
                .map((element) => ({
                  selector: element.id ? '#' + element.id : '.' + [...element.classList].join('.'),
                  left: Math.round(element.getBoundingClientRect().left),
                  right: Math.round(element.getBoundingClientRect().right),
                  width: Math.round(element.getBoundingClientRect().width)
                })),
              items: selectors.map((selector) => {
                const element = host.querySelector(selector)
                if (!element) return null
                const style = getComputedStyle(element)
                return {
                  selector,
                  radius: style.borderRadius,
                  backdrop: style.backdropFilter || style.webkitBackdropFilter || '',
                  background: style.backgroundColor
                }
              }).filter(Boolean)
            }
          })()`)
          assertSurface(page, theme, viewport, result)
          await capture(cdp, outputDir, theme, page, viewport.width)
          checks++
          console.log(`PASS  ${page}/${theme}/${viewport.width}px`)
        }
      }
    }

    // 彈窗的標題／內容／按鈕列必須同一條左右邊界。`.term-new-body` 少寫 padding
    // 就讓欄位比標題往左突了 24px，只看截圖不一定注意得到。
    const dialogRows = await cdp.eval(`(() => {
      const rows = []
      for (const dialog of document.querySelectorAll('dialog.app-dialog')) {
        const wasOpen = dialog.open
        if (!wasOpen) dialog.show()
        const box = dialog.getBoundingClientRect()
        for (const child of dialog.children) {
          const rect = child.getBoundingClientRect()
          if (!rect.width) continue
          rows.push({
            dialog: dialog.id,
            cls: child.className,
            left: Math.round(rect.left - box.left),
            right: Math.round(box.right - rect.right)
          })
        }
        if (!wasOpen) dialog.close()
      }
      return rows
    })()`)
    for (const id of new Set(dialogRows.map((row) => row.dialog))) {
      const rows = dialogRows.filter((row) => row.dialog === id)
      const offEdge = rows.filter((row) => row.left !== rows[0].left || row.right !== rows[0].right)
      if (offEdge.length) {
        throw new Error(`彈窗 #${id} 左右邊界不一致：${JSON.stringify(offEdge)}`)
      }
      checks++
      console.log(`PASS  dialog-align #${id}`)
    }

    // 原生 option 仍保留作為資料層與後備呈現；沒明寫底色時 Chromium 會拿
    // <select> 的背景去畫，玻璃／transparent 都會退回系統白底，深色主題的近白文字
    // 就此消失（`.model-chip-select` 實際發生過）。
    for (const theme of ['dark', 'light']) {
      await cdp.eval(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)})`)
      const options = await cdp.eval(`(() => {
        const parse = (value) => (value.match(/[\\d.]+/g) || []).map(Number)
        const lum = ([r, g, b]) => {
          const ch = [r, g, b].map((v) => {
            const s = v / 255
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
          })
          return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
        }
        const seen = new Map()
        for (const option of document.querySelectorAll('option')) {
          const style = getComputedStyle(option)
          const bg = parse(style.backgroundColor)
          const fg = parse(style.color)
          const key = style.backgroundColor + '|' + style.color
          if (seen.has(key)) continue
          const light = Math.max(lum(bg), lum(fg))
          const dark = Math.min(lum(bg), lum(fg))
          seen.set(key, {
            owner: option.parentElement.id || option.parentElement.className,
            opaque: bg.length < 4 || bg[3] === 1,
            contrast: Math.round(((light + 0.05) / (dark + 0.05)) * 10) / 10
          })
        }
        return [...seen.values()]
      })()`)
      if (!options.length) throw new Error('找不到任何 <option> 可驗')
      const bad = options.filter((item) => !item.opaque || item.contrast < 4.5)
      if (bad.length) throw new Error(`option 在 ${theme} 主題不可讀：${JSON.stringify(bad)}`)
      checks++
      console.log(`PASS  option-contrast/${theme} (${options.length} 組配色)`)
    }

    const controlStyles = await cdp.eval(`(() => {
      const select = document.querySelector('.custom-select-trigger[data-select-id="chatModelSelect"]')
      const chip = document.querySelector('.model-chip')
      const think = document.getElementById('chatThinkBtn')
      if (!select || !chip || !think) return null
      const selectStyle = getComputedStyle(select)
      const chipStyle = getComputedStyle(chip)
      think.setAttribute('aria-pressed', 'false')
      const off = {
        backgroundColor: getComputedStyle(think).backgroundColor,
        borderColor: getComputedStyle(think).borderColor
      }
      think.setAttribute('aria-pressed', 'true')
      const on = {
        backgroundColor: getComputedStyle(think).backgroundColor,
        borderColor: getComputedStyle(think).borderColor
      }
      think.setAttribute('aria-pressed', 'false')
      return {
        selectAppearance: selectStyle.appearance || selectStyle.webkitAppearance,
        selectRadius: selectStyle.borderRadius,
        selectHeight: selectStyle.height,
        chipRadius: chipStyle.borderRadius,
        chipMinHeight: chipStyle.minHeight,
        thinkOffBackground: off.backgroundColor,
        thinkOnBackground: on.backgroundColor,
        thinkOnBorder: on.borderColor
      }
    })()`)
    if (!controlStyles ||
      controlStyles.selectRadius !== '10px' || controlStyles.selectHeight !== '36px' ||
      controlStyles.chipRadius !== '10px' || controlStyles.chipMinHeight !== '40px' ||
      controlStyles.thinkOffBackground === controlStyles.thinkOnBackground ||
      controlStyles.thinkOnBorder === 'rgba(0, 0, 0, 0)') {
      throw new Error(`控制項視覺狀態不符預期：${JSON.stringify(controlStyles)}`)
    }
    checks++
    console.log('PASS  control-states (select / model chip / thinking)')

    const customDropdown = await cdp.eval(`(async () => {
      document.querySelector('[data-page="translate"]')?.click()
      await new Promise((resolve) => setTimeout(resolve, 260))
      const trigger = document.querySelector('.custom-select-trigger[data-select-id="translateTargetLang"]')
      const native = document.getElementById('translateTargetLang')
      if (!trigger || !native) return null
      const before = native.value
      let changed = 0
      native.addEventListener('change', () => { changed += 1 })
      trigger.click()
      const menu = document.querySelector('.custom-select-menu.is-open')
      if (!menu) return { opened: false }
      await new Promise((resolve) => setTimeout(resolve, 180))
      const style = getComputedStyle(menu)
      const parse = (value) => (value.match(/[\\d.]+/g) || []).map(Number)
      const background = parse(style.backgroundColor)
      const triggerRect = trigger.getBoundingClientRect()
      const menuLeft = Number.parseFloat(menu.style.left)
      const menuWidth = Number.parseFloat(menu.style.width)
      const options = [...menu.querySelectorAll('.custom-select-option')]
      const selected = options.filter((item) => item.getAttribute('aria-selected') === 'true')
      const next = options.find((item) => item.dataset.value !== before && item.getAttribute('aria-disabled') !== 'true')
      if (!next) return { opened: true, optionCount: options.length, selectedCount: selected.length }
      const nowrap = options.every((item) => getComputedStyle(item).whiteSpace === 'nowrap')
      next.click()
      const after = native.value
      native.value = before
      native.dispatchEvent(new Event('change', { bubbles: true }))
      trigger.click()
      const reopened = document.querySelector('.custom-select-menu.is-open')
      const initialHighlight = reopened?.querySelector('[data-highlighted="true"]')?.dataset.value || ''
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      const movedHighlight = reopened?.querySelector('[data-highlighted="true"]')?.dataset.value || ''
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      return {
        opened: true,
        menuRadius: style.borderRadius,
        opaque: background.length < 4 || background[3] === 1,
        aligned: menuLeft <= triggerRect.left + 1 && menuLeft + menuWidth >= triggerRect.right - 1,
        optionCount: options.length,
        selectedCount: selected.length,
        nowrap,
        changed,
        selectedChanged: after !== before,
        closed: !document.querySelector('.custom-select-menu.is-open'),
        triggerExpanded: trigger.getAttribute('aria-expanded'),
        keyboardOpened: !!reopened,
        keyboardMoved: !!initialHighlight && !!movedHighlight && initialHighlight !== movedHighlight,
        keyboardClosed: !document.querySelector('.custom-select-menu.is-open')
      }
    })()`)
    if (!customDropdown || !customDropdown.opened || customDropdown.menuRadius !== '10px' ||
      !customDropdown.opaque || !customDropdown.aligned || customDropdown.optionCount < 5 || customDropdown.selectedCount !== 1 ||
      !customDropdown.nowrap || customDropdown.changed < 1 || !customDropdown.selectedChanged || !customDropdown.closed ||
      customDropdown.triggerExpanded !== 'false' || !customDropdown.keyboardOpened ||
      !customDropdown.keyboardMoved || !customDropdown.keyboardClosed) {
      throw new Error(`自訂下拉互動不符預期：${JSON.stringify(customDropdown)}`)
    }
    checks++
    console.log('PASS  custom-dropdown (shape / selection / change / close)')

    const modelDropdown = await cdp.eval(`(async () => {
      document.querySelector('[data-page="translate"]')?.click()
      await new Promise((resolve) => setTimeout(resolve, 260))
      const trigger = document.querySelector('.custom-select-trigger[data-select-id="translatePageModel"]')
      if (!trigger) return null
      trigger.click()
      const menu = document.querySelector('.custom-select-menu.is-open')
      if (!menu) return { opened: false }
      await new Promise((resolve) => setTimeout(resolve, 180))
      const triggerRect = trigger.getBoundingClientRect()
      const style = getComputedStyle(menu)
      const options = [...menu.querySelectorAll('.custom-select-option')]
      const selected = options.filter((item) => item.getAttribute('aria-selected') === 'true')
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      return {
        opened: true,
        optionCount: options.length,
        selectedCount: selected.length,
        radius: style.borderRadius,
        triggerLeft: triggerRect.left,
        triggerRight: triggerRect.right,
        menuLeft: Number.parseFloat(menu.style.left),
        menuRight: Number.parseFloat(menu.style.left) + Number.parseFloat(menu.style.width),
        aligned: Number.parseFloat(menu.style.left) <= triggerRect.left + 1 &&
          Number.parseFloat(menu.style.left) + Number.parseFloat(menu.style.width) >= triggerRect.right - 1,
        closed: !document.querySelector('.custom-select-menu.is-open')
      }
    })()`)
    if (!modelDropdown || !modelDropdown.opened || modelDropdown.optionCount < 2 ||
      modelDropdown.selectedCount !== 1 || modelDropdown.radius !== '10px' ||
      !modelDropdown.aligned || !modelDropdown.closed) {
      throw new Error(`模型自訂下拉互動不符預期：${JSON.stringify(modelDropdown)}`)
    }
    checks++
    console.log('PASS  model-dropdown (chip menu / alignment / close)')

    const chatModelDropdown = await cdp.eval(`(async () => {
      const provider = {
        id: 'visual_chat_provider',
        name: '視覺測試供應商',
        apiUrl: 'https://visual.test/v1',
        apiKey: '',
        models: ['z-ai/glm-5.3-flash'],
        imageModels: []
      }
      await window.electronAPI.store.set('chatProviders', [provider])
      await window.electronAPI.store.set('chatProviderId', provider.id)
      await window.electronAPI.store.set('chatModelId', provider.models[0])
      document.querySelector('[data-page="chat"]')?.click()
      await new Promise((resolve) => setTimeout(resolve, 320))
      const trigger = document.querySelector('.custom-select-trigger[data-select-id="chatModelSelect"]')
      const native = document.getElementById('chatModelSelect')
      if (!trigger || !native) return { opened: false, disabled: true }
      trigger.click()
      const menu = document.querySelector('.custom-select-menu.is-open')
      const result = {
        opened: !!menu,
        disabled: trigger.disabled,
        optionCount: menu?.querySelectorAll('.custom-select-option').length || 0,
        text: menu?.querySelector('.custom-select-option')?.textContent || ''
      }
      if (menu) trigger.click()
      await window.electronAPI.store.set('chatProviders', [])
      return result
    })()`)
    if (!chatModelDropdown || !chatModelDropdown.opened || chatModelDropdown.disabled ||
      chatModelDropdown.optionCount !== 1 || chatModelDropdown.text !== 'z-ai/glm-5.3-flash') {
      throw new Error(`聊天模型下拉點擊不符預期：${JSON.stringify(chatModelDropdown)}`)
    }
    checks++
    console.log('PASS  chat-model-dropdown (click / option)')

    const modelRowLayout = await cdp.eval(`(async () => {
      const provider = {
        id: 'visual_row_provider',
        name: '視覺測試供應商',
        apiUrl: 'https://visual.test/v1',
        apiKey: '',
        models: ['model-a'],
        imageModels: []
      }
      await window.electronAPI.store.set('chatProviders', [provider])
      await window.electronAPI.store.set('chatProviderId', provider.id)
      document.querySelector('[data-page="settings"]')?.click()
      await new Promise((resolve) => setTimeout(resolve, 320))
      document.querySelector('.settings-nav-item[data-section="cloud"]')?.click()
      await new Promise((resolve) => setTimeout(resolve, 420))
      const row = document.querySelector('#chatModelList .chat-model-row')
      const checkbox = row?.querySelector('.chat-model-flag input')
      const flagText = row?.querySelector('.chat-model-flag > span')
      const fields = row ? [
        row.querySelector('.input'),
        row.querySelector('.chat-model-flag'),
        row.querySelector('.btn-icon')
      ].filter(Boolean).map((item) => {
        const rect = item.getBoundingClientRect()
        return { top: rect.top, height: rect.height }
      }) : []
      const checkboxRect = checkbox?.getBoundingClientRect()
      const textRect = flagText?.getBoundingClientRect()
      await window.electronAPI.store.set('chatProviders', [])
      return {
        count: fields.length,
        sameTop: fields.length === 3 && Math.max(...fields.map((field) => field.top)) - Math.min(...fields.map((field) => field.top)) <= 1,
        sameHeight: fields.length === 3 && fields.every((field) => Math.abs(field.height - 40) <= 1),
        flagContentAligned: Boolean(checkboxRect && textRect) && Math.abs(
          (checkboxRect.top + checkboxRect.height / 2) - (textRect.top + textRect.height / 2)
        ) <= 1,
        fields
      }
    })()`)
    if (!modelRowLayout || modelRowLayout.count !== 3 || !modelRowLayout.sameTop || !modelRowLayout.sameHeight ||
      !modelRowLayout.flagContentAligned) {
      throw new Error(`模型列對齊不符預期：${JSON.stringify(modelRowLayout)}`)
    }
    checks++
    console.log('PASS  model-row-layout (same top / 40px controls)')

    const dialogDropdown = await cdp.eval(`(async () => {
      document.querySelector('[data-page="terminal"]')?.click()
      await new Promise((resolve) => setTimeout(resolve, 260))
      document.getElementById('termNewBtn')?.click()
      await new Promise((resolve) => setTimeout(resolve, 120))
      const dialog = document.getElementById('termNewDialog')
      const trigger = document.querySelector('.custom-select-trigger[data-select-id="termShellSelect"]')
      if (!dialog || !trigger || !dialog.open) return null
      trigger.click()
      await new Promise((resolve) => setTimeout(resolve, 120))
      const menu = document.querySelector('.custom-select-menu.is-open')
      const result = {
        opened: !!menu,
        inDialog: menu?.parentElement === dialog,
        overflowOpen: dialog.classList.contains('custom-select-portal-open'),
        optionCount: menu?.querySelectorAll('.custom-select-option').length || 0
      }
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      document.getElementById('termNewCancelBtn')?.click()
      return result
    })()`)
    if (!dialogDropdown || !dialogDropdown.opened || !dialogDropdown.inDialog ||
      !dialogDropdown.overflowOpen || dialogDropdown.optionCount < 1) {
      throw new Error(`彈窗內自訂下拉不符預期：${JSON.stringify(dialogDropdown)}`)
    }
    checks++
    console.log('PASS  dialog-dropdown (top-layer portal / close)')

    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    })
    const reduced = await cdp.eval(`(() => {
      document.querySelector('[data-page="usage"]').click()
      const style = getComputedStyle(document.querySelector('.usage-card'))
      return { animation: style.animationDuration, transition: style.transitionDuration }
    })()`)
    const durations = `${reduced.animation},${reduced.transition}`
      .split(',')
      .map((value) => value.trim())
    const hasLongMotion = durations.some((value) => {
      const amount = Number.parseFloat(value)
      if (!Number.isFinite(amount)) return false
      const milliseconds = value.endsWith('ms') ? amount : amount * 1000
      return milliseconds > 0.011
    })
    if (hasLongMotion) {
      throw new Error(`reduced motion 仍有長動畫：${JSON.stringify(reduced)}`)
    }
    checks++
    console.log('PASS  prefers-reduced-motion')

    if (cdp.exceptions.length || cdp.consoleErrors.length) {
      throw new Error(`renderer errors: ${[...cdp.exceptions, ...cdp.consoleErrors].join('; ')}`)
    }
    if (/UnhandledPromiseRejection|FATAL|SyntaxError/i.test(processLog)) {
      throw new Error('main process log contains fatal error')
    }
    console.log(`\nALL PASS  ${checks} visual checks\n`)
  } catch (error) {
    console.error(`\nFAILED  ${error.stack || error}`)
    console.error('Renderer exceptions:', JSON.stringify(cdp?.exceptions || []))
    console.error('Renderer console errors:', JSON.stringify(cdp?.consoleErrors || []))
    console.error('Process log:', processLog.slice(-8000))
    process.exitCode = 1
  } finally {
    cdp?.close()
    stopTestApp(child)
    fs.rmSync(USER_DATA_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}

main()
