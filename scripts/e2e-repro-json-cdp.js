/**
 * CDP：在打包版觸發檔案轉錄，捕捉 JSON SyntaxError
 */
const http = require('http')
const path = require('path')
const fs = require('fs')

const PORT = 9247
const SAMPLE = path.join(__dirname, 'test-sample.wav')

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
    this.logs = []
  }
  async connect() {
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
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args || []).map((a) => a.value ?? a.description).join(' ')
        this.logs.push(text)
        console.log('[console]', text)
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const t = msg.params.exceptionDetails?.exception?.description ||
          msg.params.exceptionDetails?.text
        this.logs.push('EXC ' + t)
        console.log('[exc]', t)
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
      throw new Error(
        r.exceptionDetails.exception?.description ||
        r.exceptionDetails.text ||
        'eval error'
      )
    }
    return r.result?.value
  }
}

async function main() {
  const pages = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = pages.find((p) => p.url && p.url.includes('index.html')) || pages[0]
  console.log('page', page.url)
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.connect()
  await cdp.send('Runtime.enable')
  await cdp.send('Console.enable')

  // Probe APIs
  const probe = await cdp.eval(`(async () => {
    const api = window.electronAPI
    return {
      hasApi: !!api,
      hasGetPath: typeof api?.getPathForFile,
      hasTranscribeFile: typeof api?.localAsr?.transcribeFile,
      hasTranscribe: typeof api?.localAsr?.transcribe,
      translator: await api.store.get('translator', 'none'),
    }
  })()`)
  console.log('probe', probe)

  // Direct main-style call via renderer IPC with sample path
  const samplePath = SAMPLE.replace(/\\/g, '\\\\')
  console.log('calling transcribeFile', SAMPLE)
  const result = await cdp.eval(`(async () => {
    try {
      const warm = await window.electronAPI.engine.acquire('file', { asr: true, llm: false })
      if (!warm.ok) return { stage: 'acquire', warm }
      const r = await window.electronAPI.localAsr.transcribeFile({
        filePath: ${JSON.stringify(SAMPLE)},
        lang: 'zh-TW',
        modelKey: 'qwen3asr'
      })
      await window.electronAPI.engine.release('file')
      return { stage: 'ok', r }
    } catch (e) {
      try { await window.electronAPI.engine.release('file') } catch {}
      return {
        stage: 'error',
        name: e?.name,
        message: String(e?.message || e),
        stack: String(e?.stack || '').slice(0, 800)
      }
    }
  })()`)
  console.log('result', JSON.stringify(result, null, 2))

  // Also try getSettings path like UI
  const settingsPath = await cdp.eval(`(async () => {
    try {
      const keys = ['translator','captionDisplayMode','apiUrl','apiKey','modelId']
      const out = {}
      for (const k of keys) out[k] = await window.electronAPI.store.get(k, null)
      const status = await window.electronAPI.models.status()
      return { out, asr: status.models?.qwen3asr?.downloaded }
    } catch (e) {
      return { err: String(e.message || e) }
    }
  })()`)
  console.log('settings', settingsPath)

  process.exit(result?.stage === 'error' ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
