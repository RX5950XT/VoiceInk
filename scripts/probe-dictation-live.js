/**
 * 語音輸入的真實端到端實測：`node scripts/probe-dictation-live.js`
 *
 * 這支不是回歸測試，是「這條路真的通嗎」的實測：
 *   Edge TTS 合成一句已知的話 → 當成假麥克風餵給打包版
 *   → 從這個程序送出真的右 Alt（uiohook）→ App 錄音 → 本地 ASR → 插入
 *
 * 安全設計（很重要）：
 *   - 插入是模擬 Ctrl+V，會貼進**當下的前景視窗**。所以開始前先把焦點放進
 *     VoiceInk 自己的字典輸入框，並確認 `document.hasFocus()`；不成立就中止，
 *     絕不亂送按鍵。
 *   - 整理模型設成「不整理」，不打任何雲端端點、不花使用者的額度。
 *   - 用使用者的真實 profile（本機 ASR 模型在那裡），所以動到的三個 store key
 *     開頭先備份、finally 一定寫回。
 */
const { spawn } = require('child_process')
const path = require('path')
const http = require('http')
const os = require('os')
const fs = require('fs')

const PORT = 9248
// Windows 偶爾會有別的東西鎖住 dist/win-unpacked（打包失敗、防毒掃描中），
// 這時可以打包到別的資料夾再用 VOICEINK_EXE 指過去，測試不必等鎖放掉
const EXE = process.env.VOICEINK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
const SENTENCE = '今天天氣很好，我們一起去公園散步吧。'
const RIGHT_ALT = 3640
const HOLD_MS = 4000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = ''
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (error) { reject(error) }
      })
    })
    request.setTimeout(3000, () => request.destroy(new Error('CDP HTTP 逾時')))
    request.on('error', reject)
  })
}

class Cdp {
  constructor(url) {
    this.url = url
    this.id = 0
    this.pending = new Map()
  }

  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve)
      this.ws.addEventListener('error', reject)
    })
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
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
      expression, awaitPromise: true, returnByValue: true
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    }
    return result.result?.value
  }

  close() { try { this.ws.close() } catch { /* ignore */ } }
}

/**
 * Edge TTS 合成 → ffmpeg 轉成 Chromium 假麥克風吃得下的 16k mono WAV
 * @param {string} outPath
 */
async function makeAudio(outPath) {
  const edgeTts = require('../src/main/edge-tts')
  const result = await edgeTts.synthesize({
    text: SENTENCE,
    voice: 'zh-TW-HsiaoChenNeural',
    rate: '+0%'
  })
  const mp3 = Buffer.from(result.data)
  const ffmpeg = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked')
  await new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', 'pipe:0',
      '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '16000',
      outPath
    ])
    proc.on('error', reject)
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))))
    proc.stdin.on('error', () => {})
    proc.stdin.end(mp3)
  })
  return outPath
}

async function main() {
  const wav = path.join(os.tmpdir(), `voiceink-dictation-probe-${process.pid}.wav`)
  console.log(`[1/5] 合成測試語音：「${SENTENCE}」`)
  await makeAudio(wav)
  console.log(`      → ${wav}（${(fs.statSync(wav).size / 1024).toFixed(0)} KB）`)

  console.log('[2/5] 啟動打包版（假麥克風餵剛才那段音訊）')
  const child = spawn(EXE, [
    `--remote-debugging-port=${PORT}`,
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${wav}`
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let processLog = ''
  child.stdout.on('data', (c) => { processLog += c })
  child.stderr.on('data', (c) => { processLog += c })

  let cdp = null
  let original = null
  let exitCode = 1
  try {
    const target = await (async () => {
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        const pages = await getJson(`http://127.0.0.1:${PORT}/json/list`).catch(() => [])
        const page = pages.filter((p) => p.type === 'page').find((p) => /index\.html/.test(p.url))
        if (page) return page
        await sleep(400)
      }
      throw new Error('等不到主視窗（使用者的 VoiceInk 是不是開著？單一實例鎖會擋掉這一份）')
    })()
    cdp = new Cdp(target.webSocketDebuggerUrl)
    await cdp.connect()
    await sleep(1500)

    original = await cdp.eval(`(async () => {
      const keys = ['dictationEnabled', 'dictationLlm', 'dictationLang']
      const out = {}
      for (const k of keys) out[k] = await window.electronAPI.store.get(k, null)
      return out
    })()`)
    console.log(`      已備份設定：${JSON.stringify(original)}`)

    console.log('[3/5] 設定：不整理（不打雲端）、繁中、啟用熱鍵')
    const setup = await cdp.eval(`(async () => {
      await window.electronAPI.store.set('dictationLlm', '')
      await window.electronAPI.store.set('dictationLang', 'zh-TW')
      await window.electronAPI.store.set('dictationEnabled', true)
      document.querySelector('[data-page="stt"]').click()
      await new Promise((r) => setTimeout(r, 500))
      document.querySelector('#sttSubtabs [data-subtab="dictation"]').click()
      await new Promise((r) => setTimeout(r, 800))
      const status = await window.electronAPI.dictation.status()
      return {
        listening: status?.data?.listening,
        asr: await window.electronAPI.store.get('dictationAsr', null)
      }
    })()`)
    console.log(`      熱鍵在聽：${setup.listening}／ASR：${setup.asr}`)
    if (!setup.listening) throw new Error('全域熱鍵沒掛上，後面不用試了')

    // 貼上會進「前景視窗」→ 先把焦點放進 VoiceInk 自己的字典輸入框
    await cdp.send('Page.enable').catch(() => {})
    await cdp.send('Page.bringToFront').catch(() => {})
    await sleep(800)
    const focus = await cdp.eval(`(() => {
      const el = document.getElementById('dictationTermFrom')
      el.value = ''
      el.focus()
      return { hasFocus: document.hasFocus(), active: document.activeElement?.id || '' }
    })()`)
    console.log(`      視窗焦點：${focus.hasFocus}／作用中元素：${focus.active}`)
    if (!focus.hasFocus || focus.active !== 'dictationTermFrom') {
      throw new Error('VoiceInk 沒拿到前景焦點，為了不把文字貼到別人的視窗，這裡中止')
    }

    console.log(`[4/5] 送出真的右 Alt（按住 ${HOLD_MS / 1000}s）`)
    const { uIOhook } = require('uiohook-napi')
    uIOhook.start()
    uIOhook.keyToggle(RIGHT_ALT, 'down')
    await sleep(HOLD_MS)
    uIOhook.keyToggle(RIGHT_ALT, 'up')
    uIOhook.stop()

    console.log('[5/5] 等待 ASR 與插入完成…')
    let outcome = null
    const deadline = Date.now() + 90000
    while (Date.now() < deadline) {
      outcome = await cdp.eval(`(async () => {
        const res = await window.electronAPI.dictation.records({ limit: 1 })
        return {
          record: res?.ok ? (res.data[0] || null) : null,
          pasted: document.getElementById('dictationTermFrom')?.value || '',
          status: document.querySelector('#dictationStatus .dict-status-text')?.textContent || ''
        }
      })()`)
      if (outcome.record) break
      await sleep(1000)
    }

    if (!outcome?.record) {
      console.log(`\n結果：沒有產生任何紀錄（狀態列：${outcome?.status}）`)
      console.log('App log 尾段：', processLog.slice(-2000))
    } else {
      console.log('\n===== 實測結果 =====')
      console.log(`  講的內容：${SENTENCE}`)
      console.log(`  ASR 原文：${outcome.record.raw}`)
      console.log(`  最終文字：${outcome.record.text}`)
      console.log(`  錄音長度：${(outcome.record.durationMs / 1000).toFixed(1)}s`)
      console.log(`  自動貼上：${outcome.record.inserted}`)
      console.log(`  貼進輸入框的內容：${JSON.stringify(outcome.pasted)}`)
      const pastedOk = outcome.pasted.trim() === outcome.record.text.trim()
      console.log(`  貼上內容與結果一致：${pastedOk}`)
      exitCode = outcome.record.text && pastedOk ? 0 : 1
    }

    // 把測試貼進去的字清掉，別留在使用者的輸入框裡
    await cdp.eval(`(() => { const el = document.getElementById('dictationTermFrom'); if (el) el.value = ''; return 'ok' })()`)
  } catch (error) {
    console.error(`\n失敗：${error.message}`)
    console.error('App log 尾段：', processLog.slice(-2000))
  } finally {
    if (cdp && original) {
      await cdp.eval(`(async () => {
        const orig = ${JSON.stringify(original)}
        for (const [k, v] of Object.entries(orig)) {
          if (v !== null) await window.electronAPI.store.set(k, v)
        }
        return 'ok'
      })()`).catch((e) => console.error('還原設定失敗：', e))
      console.log(`（已還原設定：${JSON.stringify(original)}）`)
    }
    cdp?.close()
    try { child.kill() } catch { /* ignore */ }
    if (child.pid) {
      try { spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' }) } catch { /* ignore */ }
    }
    try { fs.rmSync(wav, { force: true }) } catch { /* ignore */ }
  }
  process.exitCode = exitCode
}

main()
