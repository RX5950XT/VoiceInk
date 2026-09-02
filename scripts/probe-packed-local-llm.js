'use strict'

/**
 * 打包版的本地 LLM 翻譯能不能真的跑起來。
 *
 * v1.8.0 把 `node_modules/node-llama-cpp/llama/**` 整包排出 asar 省體積，
 * 但 runtime 會去讀那底下的檔案定位 prebuilt binary——這條路徑壞掉時，
 * 雲端翻譯照樣好好的，所以完全看不出來。這支就是專門盯它。
 *
 * 用法：`node scripts/probe-packed-local-llm.js`
 * （要驗別的建置版：`VOICEINK_EXE=... node scripts/probe-packed-local-llm.js`）
 */

const { spawn, execFileSync } = require('child_process')
const path = require('path')
const os = require('os')
const fs = require('fs')
const http = require('http')

const PORT = 9261
const EXE = process.env.VOICEINK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
const USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-cdp-'))
// 模型放在 `<userData>/models`，換了 user-data-dir 就等於一顆都沒裝
{
  const real = path.join(process.env.APPDATA || os.homedir(), 'voiceink', 'models')
  if (fs.existsSync(real)) {
    try { fs.symlinkSync(real, path.join(USER_DATA_DIR, 'models'), 'junction') } catch { /* 沒有就當沒裝 */ }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = ''
      res.on('data', (d) => { body += d })
      res.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (error) { reject(error) }
      })
    }).on('error', reject)
  })
}

class Cdp {
  /** @param {string} url */
  constructor(url) {
    this.url = url
    this.id = 0
    this.pending = new Map()
  }

  async connect() {
    const { WebSocket } = require('ws')
    this.ws = new WebSocket(this.url, { maxPayload: 64 * 1024 * 1024 })
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve)
      this.ws.once('error', reject)
    })
    this.ws.on('message', (raw) => {
      let message
      try { message = JSON.parse(raw.toString()) } catch { return }
      const slot = this.pending.get(message.id)
      if (!slot) return
      this.pending.delete(message.id)
      if (message.error) slot.reject(new Error(JSON.stringify(message.error)))
      else slot.resolve(message.result)
    })
  }

  send(method, params) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params: params || {} }))
    })
  }

  /** @param {string} expression */
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true
    })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result?.value
  }
}

async function main() {
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA_DIR}`], {
    stdio: 'ignore'
  })
  let failed = false
  try {
    let target = null
    for (let i = 0; i < 40 && !target; i += 1) {
      await sleep(1000)
      const list = await getJson(`http://127.0.0.1:${PORT}/json/list`).catch(() => [])
      // 只認主視窗：語音輸入的指示器也是一個 page target
      target = list.find((item) => item.type === 'page' && /index\.html/i.test(item.url))
    }
    if (!target) throw new Error('等不到主視窗')

    const cdp = new Cdp(target.webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Runtime.enable')

    const installed = await cdp.eval(`(async () => {
      const status = await window.electronAPI.models.status()
      return Object.entries(status.models || {}).filter(([, v]) => v?.downloaded).map(([k]) => k)
    })()`)
    console.log('已安裝模型：', installed.join(', ') || '(無)')

    const key = ['linguaforge08q4', 'qwen35translate', 'qwen354b'].find((k) => installed.includes(k))
    if (!key) {
      console.log('SKIP：本機沒有裝任何本地翻譯模型，這支驗不了')
      return
    }

    console.log(`用 ${key} 翻一句話（第一次載入模型會花上一分鐘）…`)
    const out = await cdp.eval(`(async () => {
      await window.electronAPI.store.set('translator', 'local')
      await window.electronAPI.store.set('localTranslateModel', ${JSON.stringify(key)})
      try {
        const text = await window.electronAPI.translate('Hello, world.', 'zh-TW', {})
        return { ok: true, text: String(text || '').slice(0, 80) }
      } catch (error) {
        return { ok: false, error: String(error?.message || error).slice(0, 300) }
      }
    })()`)

    if (out?.ok && out.text) {
      console.log('PASS 本地 LLM 跑得起來 →', out.text)
    } else {
      failed = true
      console.error('FAIL 本地 LLM 起不來 →', out?.error || '(空譯文)')
    }
  } catch (error) {
    failed = true
    console.error('FAIL', error.message)
  } finally {
    // 只殺自己 spawn 的那棵樹；禁止 /IM VoiceInk.exe（會關掉使用者的安裝版）
    try { execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' }) } catch { /* 已結束 */ }
    process.exit(failed ? 1 : 0)
  }
}

main()
