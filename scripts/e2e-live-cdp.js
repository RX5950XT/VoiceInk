/**
 * 打包版即時字幕端到端：系統 loopback → AudioContext 16k PCM → VAD → 本地 ASR → 字幕窗。
 * 用法：node scripts/e2e-live-cdp.js（需先 npm run electron:pack）
 */
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const http = require('http')

const PORT = 9238
const EXE = path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => {
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
    this.consoleMessages = []
  }

  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve)
      this.ws.addEventListener('error', reject)
    })
    this.ws.addEventListener('message', event => {
      const message = JSON.parse(event.data)
      if (message.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(message.params?.exceptionDetails?.exception?.description || 'runtime exception')
      }
      if (message.method === 'Runtime.consoleAPICalled') {
        this.consoleMessages.push({
          type: message.params?.type,
          text: (message.params?.args || []).map(arg => arg.value ?? arg.description ?? '').join(' ')
        })
      }
      if (!message.id || !this.pending.has(message.id)) return
      const { resolve, reject } = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.error) reject(new Error(message.error.message))
      else resolve(message.result)
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

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await fn()
    if (result) return result
    await sleep(400)
  }
  throw new Error(`等待逾時：${label}`)
}

async function listPages() {
  return getJson(`http://127.0.0.1:${PORT}/json/list`)
    .then(items => items.filter(item => item.type === 'page'))
    .catch(() => [])
}

async function main() {
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let processLog = ''
  child.stdout.on('data', chunk => { processLog += chunk })
  child.stderr.on('data', chunk => { processLog += chunk })
  let mainCdp = null
  let subtitleCdp = null
  try {
    const mainPage = await waitFor(async () => {
      const pages = await listPages()
      return pages.find(page => /index\.html/.test(page.url)) || null
    }, 30000, '主視窗')
    mainCdp = new Cdp(mainPage.webSocketDebuggerUrl)
    await mainCdp.connect()
    // 即時頁改成進分頁才載入腳本；先點進 live，再用 hint 當 readiness gate。
    await waitFor(
      () => mainCdp.eval(`document.readyState === 'complete' && !!document.querySelector('[data-page="live"]')`),
      15000,
      'renderer 初始化'
    )
    await mainCdp.eval(`document.querySelector('[data-page="live"]').click()`)
    await waitFor(
      () => mainCdp.eval(`(() => {
        const hint = document.getElementById('liveTranslatorHint')?.textContent || ''
        return hint && !hint.includes('檢查中')
      })()`),
      15000,
      '即時字幕頁初始化'
    )

    await mainCdp.eval(`(() => {
      document.querySelector('[data-page="live"]').click()
      document.getElementById('liveLanguage').value = 'auto'
      document.getElementById('startLiveBtn').click()
    })()`)

    const running = await waitFor(
      () => mainCdp.eval(`(() => ({
        status: document.querySelector('#liveStatus .status-text')?.textContent || '',
        engine: document.getElementById('liveEngine')?.textContent || '',
        stopped: !document.getElementById('stopLiveBtn')?.classList.contains('hidden')
      }))()`).then(value => value?.stopped ? value : null),
      90000,
      'PCM 擷取啟動'
    )
    console.log(`PASS  PCM 擷取已啟動 — ${running.status} ${running.engine}`)

    const subtitlePage = await waitFor(async () => {
      const pages = await listPages()
      return pages.find(page => /subtitle\.html/.test(page.url)) || null
    }, 15000, '字幕視窗')
    subtitleCdp = new Cdp(subtitlePage.webSocketDebuggerUrl)
    await subtitleCdp.connect()

    const subtitleVisual = await subtitleCdp.eval(`(() => {
      const container = getComputedStyle(document.querySelector('.subtitle-container'))
      const control = getComputedStyle(document.querySelector('.control-btn'))
      return {
        font: getComputedStyle(document.body).fontFamily,
        radius: container.borderRadius,
        background: container.backgroundColor,
        controlRadius: control.borderRadius,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
      }
    })()`)
    if (!/Segoe UI/.test(subtitleVisual.font) || subtitleVisual.radius !== '12px' ||
        subtitleVisual.controlRadius !== '10px' || subtitleVisual.overflow ||
        subtitleVisual.background === 'rgba(0, 0, 0, 0)') {
      throw new Error(`字幕視覺驗證失敗：${JSON.stringify(subtitleVisual)}`)
    }
    console.log('PASS  字幕窗 Token Anxiety surface')

    const playback = await mainCdp.eval(`(async () => {
      const result = await window.electronAPI.tts.synthesize(
        '今天天氣很好，我們一起去公園散步吧。',
        'zh-TW'
      )
      const url = URL.createObjectURL(new Blob([result.data], { type: result.mime }))
      const audio = new Audio(url)
      window.__liveTest = { audio, url, done: false, error: '' }
      audio.addEventListener('ended', () => {
        window.__liveTest.done = true
        URL.revokeObjectURL(url)
      }, { once: true })
      audio.addEventListener('error', () => {
        window.__liveTest.done = true
        window.__liveTest.error = 'TTS 音訊播放失敗'
      }, { once: true })
      await audio.play()
      return { mime: result.mime, bytes: result.data.byteLength }
    })()`)
    let maxLevel = 0
    await waitFor(async () => {
      const state = await mainCdp.eval(`({
        done: window.__liveTest?.done === true,
        error: window.__liveTest?.error || '',
        level: parseFloat(document.getElementById('levelFill')?.style.width || '0')
      })`)
      maxLevel = Math.max(maxLevel, state.level || 0)
      if (state.error) throw new Error(state.error)
      return state.done
    }, 15000, 'TTS 播放結束')
    console.log(`PASS  TTS 經系統輸出播放 — ${playback.mime}, ${playback.bytes} bytes, 音量峰值 ${maxLevel.toFixed(1)}%`)

    const recognized = await waitFor(
      () => subtitleCdp.eval(`document.getElementById('subtitleHistory')?.textContent || ''`)
        // 系統 loopback 會混入其他應用程式音訊；精準度另由 e2e-live-pipeline 的隔離音訊驗證。
        .then(text => /天[氣气]|公[園园]|散步/.test(text) ? text : ''),
      30000,
      'loopback 字幕關鍵字'
    )
    console.log(`PASS  loopback → VAD → ASR → 字幕 — ${recognized.trim()}`)

    if (process.env.VOICEINK_VISUAL_DIR) {
      fs.mkdirSync(process.env.VOICEINK_VISUAL_DIR, { recursive: true })
      const capture = await subtitleCdp.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true
      })
      fs.writeFileSync(
        path.join(process.env.VOICEINK_VISUAL_DIR, 'dark-subtitle.png'),
        capture.data,
        'base64'
      )
    }

    // 補 55 行確認上限淘汰、增量渲染、XSS 純文字與使用者上捲不被搶回底部。
    await mainCdp.eval(`(async () => {
      for (let i = 0; i < 55; i++) {
        await window.electronAPI.subtitle.update({
          id: 'qa-' + i,
          source: i === 54 ? '<img src=x onerror=alert(1)> 測試字幕' : '測試字幕 ' + i,
          translation: i === 54 ? '<img src=x onerror=alert(1)> translated' : 'translation ' + i,
          action: 'upsert'
        })
      }
    })()`)
    await sleep(600)
    const dom = await subtitleCdp.eval(`(() => {
      const history = document.getElementById('subtitleHistory')
      history.scrollTop = 0
      return {
        rows: history.querySelectorAll('.subtitle-line').length,
        images: history.querySelectorAll('img').length,
        rawText: history.textContent.includes('<img src=x onerror=alert(1)>'),
        overflow: history.scrollHeight > history.clientHeight,
        scrollTop: history.scrollTop
      }
    })()`)
    if (!(dom.rows === 50 && dom.images === 0 && dom.rawText && dom.overflow && dom.scrollTop === 0)) {
      throw new Error(`字幕 DOM 驗證失敗：${JSON.stringify(dom)}`)
    }
    await mainCdp.eval(`window.electronAPI.subtitle.update({
      id: 'qa-54', source: '最後一行更新', translation: 'updated', action: 'upsert'
    })`)
    await sleep(300)
    const scrollTop = await subtitleCdp.eval(`document.getElementById('subtitleHistory').scrollTop`)
    if (scrollTop !== 0) throw new Error(`增量更新搶走捲動位置：scrollTop=${scrollTop}`)
    console.log('PASS  字幕增量 DOM — 50 行上限、零 innerHTML 注入、上捲位置保留')

    await mainCdp.eval(`document.getElementById('stopLiveBtn').click()`)
    await waitFor(
      () => mainCdp.eval(`document.querySelector('#liveStatus .status-text')?.textContent === '未啟動'`),
      30000,
      '停止並釋放引擎'
    )
    if (mainCdp.exceptions.length || subtitleCdp.exceptions.length) {
      throw new Error(`renderer exception: ${[...mainCdp.exceptions, ...subtitleCdp.exceptions].join('; ')}`)
    }
    console.log('PASS  停止擷取並釋放 AudioContext／模型')
    console.log('\nALL PASS  6 passed, 0 failed\n')
  } catch (error) {
    let uiState = null
    try {
      uiState = await mainCdp?.eval(`(() => ({
        status: document.querySelector('#liveStatus .status-text')?.textContent || '',
        engine: document.getElementById('liveEngine')?.textContent || '',
        error: document.getElementById('liveError')?.textContent || '',
        toast: document.querySelector('#toast .toast-message')?.textContent || '',
        startDisabled: document.getElementById('startLiveBtn')?.disabled,
        startHidden: document.getElementById('startLiveBtn')?.classList.contains('hidden'),
        stopHidden: document.getElementById('stopLiveBtn')?.classList.contains('hidden')
      }))()`)
    } catch {}
    console.error(`\nFAILED  ${error.stack || error}`)
    let configState = null
    try {
      configState = await mainCdp?.eval(`(async () => {
        const [asrEngine, asrKey, translator, translateKey, models] = await Promise.all([
          window.electronAPI.store.get('asrEngine', 'local'),
          window.electronAPI.store.get('asrApiKey', ''),
          window.electronAPI.store.get('translator', 'local'),
          window.electronAPI.store.get('apiKey', ''),
          window.electronAPI.models.status()
        ])
        return {
          asrEngine,
          hasAsrKey: !!asrKey,
          translator,
          hasTranslateKey: !!translateKey,
          asrDownloaded: !!models.models?.qwen3asr?.downloaded
        }
      })()`)
    } catch {}
    console.error('UI state:', JSON.stringify(uiState))
    let subtitleState = null
    try {
      subtitleState = await subtitleCdp?.eval(`({
        text: document.getElementById('subtitleHistory')?.textContent || '',
        rows: document.querySelectorAll('.subtitle-line').length
      })`)
    } catch {}
    console.error('Config state:', JSON.stringify(configState))
    console.error('Subtitle state:', JSON.stringify(subtitleState))
    console.error('Renderer exceptions:', JSON.stringify(mainCdp?.exceptions || []))
    console.error('Renderer console:', JSON.stringify(mainCdp?.consoleMessages || []))
    console.error('Process log:', processLog.slice(-8000), '\n')
    process.exitCode = 1
  } finally {
    mainCdp?.close()
    subtitleCdp?.close()
    try { child.kill() } catch {}
    try { spawn('taskkill', ['/F', '/IM', 'VoiceInk.exe'], { stdio: 'ignore' }) } catch {}
  }
}

main()
