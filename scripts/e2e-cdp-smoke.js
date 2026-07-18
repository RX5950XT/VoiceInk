/**
 * 打包版 CDP 煙霧測試：分頁、設定、字幕窗
 * 用法：先啟動 dist/win-unpacked/VoiceInk.exe --remote-debugging-port=9229
 *      再 node scripts/e2e-cdp-smoke.js
 * 或本腳本自動啟動。
 */
const { spawn } = require('child_process')
const path = require('path')
const http = require('http')

const PORT = 9235
const EXE = path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => {
        try { resolve(JSON.parse(d)) } catch (e) { reject(e) }
      })
    }).on('error', reject)
  })
}

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.ws = null
    this.id = 0
    this.pending = new Map()
  }
  async connect() {
    const WebSocket = globalThis.WebSocket
    this.ws = new WebSocket(this.wsUrl)
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res)
      this.ws.addEventListener('error', rej)
    })
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.text || 'eval error')
    }
    return r.result?.value
  }
  close() {
    try { this.ws.close() } catch {}
  }
}

async function waitTargets(timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json/list`)
      const pages = list.filter((t) => t.type === 'page')
      if (pages.length) return pages
    } catch {}
    await sleep(400)
  }
  throw new Error('timeout waiting for CDP targets')
}

async function main() {
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    detached: false
  })

  const results = []
  const ok = (name, pass, detail = '') => {
    results.push({ name, pass: !!pass, detail })
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  }

  try {
    await sleep(2500)
    const pages = await waitTargets()
    const mainPage = pages.find((p) => /index\.html|VoiceInk/i.test(p.url + p.title)) || pages[0]
    ok('main page target', !!mainPage, mainPage?.url)

    const cdp = new Cdp(mainPage.webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Runtime.enable')

    // sandbox + preload：electronAPI 必須存在
    const hasApi = await cdp.eval('typeof window.electronAPI === "object"')
    ok('electronAPI exposed (sandbox ok)', hasApi === true)

    const hasStore = await cdp.eval('typeof window.electronAPI.store?.get === "function"')
    ok('store API', hasStore === true)

    // store allowlist：非法 key 應 reject
    const badKey = await cdp.eval(`
      (async () => {
        try {
          await window.electronAPI.store.get('__evil__', null)
          return 'no-throw'
        } catch (e) {
          return String(e.message || e)
        }
      })()
    `)
    ok('store reject unknown key', /不允許/.test(String(badKey)), String(badKey))

    // 切到 live 分頁
    await cdp.eval(`document.querySelector('[data-page="live"]')?.click()`)
    await sleep(500)
    const liveActive = await cdp.eval(
      `document.getElementById('page-live')?.classList.contains('active')`
    )
    ok('switch to live page', liveActive === true)

    // 即時頁無舊的 display mode segmented（已搬到字幕窗）
    const noSeg = await cdp.eval(
      `!document.querySelector('#page-live .segmented, #captionDisplayMode, #displayModeSegment')`
    )
    ok('live page no display-mode segment', noSeg === true)

    // 設定面板文案
    await cdp.eval(`document.getElementById('settingsBtn')?.click()`)
    await sleep(300)
    const hint = await cdp.eval(`
      document.querySelector('#settingsPanel')?.innerText || ''
    `)
    ok(
      'settings hint mentions subtitle window',
      /字幕視窗/.test(String(hint)) && !/請在「即時字幕」頁切換/.test(String(hint)),
      String(hint).includes('雙／譯') ? 'has 雙／譯' : 'check text'
    )
    await cdp.eval(`document.getElementById('closeSettingsBtn')?.click()`)

    // 模型 status IPC
    const status = await cdp.eval(`(async () => {
      const s = await window.electronAPI.models.status()
      return { keys: Object.keys(s.models||{}), asr: !!s.models?.qwen3asr?.downloaded }
    })()`)
    ok('models.status', Array.isArray(status?.keys) && status.keys.includes('qwen3asr'), JSON.stringify(status))

    cdp.close()
  } catch (e) {
    ok('suite', false, e.message || String(e))
  } finally {
    try { child.kill() } catch {}
    // Windows 強制
    try {
      spawn('taskkill', ['/F', '/IM', 'VoiceInk.exe'], { stdio: 'ignore' })
    } catch {}
  }

  const failed = results.filter((r) => !r.pass)
  console.log('\n=== summary ===')
  console.log(`total=${results.length} pass=${results.length - failed.length} fail=${failed.length}`)
  process.exit(failed.length ? 1 : 0)
}

main()
