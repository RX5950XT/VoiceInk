const { spawn } = require('child_process')
const fs = require('fs')
const http = require('http')
const path = require('path')

const PORT = 9243
const EXE = path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
const PAGES = ['chat', 'usage', 'transcribe', 'live', 'translate', 'settings']
const VIEWPORTS = [
  { width: 1440, height: 1000 },
  { width: 900, height: 900 },
  { width: 560, height: 900 }
]
const SIGNATURES = {
  chat: ['.chat-sidebar', '.chat-main', '.chat-composer'],
  usage: ['.usage-card', '.usage-summary-strip'],
  transcribe: ['.drop-zone', '.options-panel', '.result-panel'],
  live: ['.live-status', '.live-content'],
  translate: ['.translate-pane', '.translate-banner'],
  settings: ['.settings-card', '.settings-nav', '.settings-save-bar']
}
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
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], {
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
      () => cdp.eval(`document.readyState === 'complete' && document.querySelectorAll('.nav-tab').length === 6`),
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
          const result = await cdp.eval(`(async () => {
            document.querySelector('[data-page=${JSON.stringify(page)}]').click()
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
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
    try { child.kill() } catch {}
    if (child.pid) {
      try { spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' }) } catch {}
    }
  }
}

main()
