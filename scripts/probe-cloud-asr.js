/**
 * VoiceInk - 雲端 ASR 請求形狀實測
 *
 * 用途：確認使用者設定的端點到底吃哪一種請求（JSON input_audio ／ multipart ／
 * chat.completions 的 input_audio content part），以及各自回什麼狀態碼。
 *
 * 跑法：node_modules/electron/dist/electron.exe scripts/probe-cloud-asr.js
 * 注意：會用使用者真正的金鑰打真的上游，輸出只印狀態碼與**去識別化**的片段。
 */

const { app } = require('electron')
const { join } = require('path')
const { Buffer } = require('buffer')

const SENTENCE = '今天天氣很好，我們一起去公園散步吧。'

/** 把 body 裡看起來像金鑰的字串遮掉，避免回音時把自己的 key 印出來 */
function redact(s) {
  return String(s || '').replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***').slice(0, 400)
}

async function main() {
  app.setPath('userData', join(app.getPath('appData'), 'voiceink'))
  const Store = (await import('electron-store')).default
  const store = new Store()
  const cloudAsr = require('../src/main/cloud-asr')
  const edgeTts = require('../src/main/edge-tts')

  const cfg = cloudAsr.readConfig(store)
  console.log('base   =', cfg.apiUrl)
  console.log('model  =', cfg.modelId)
  console.log('key    =', cfg.apiKey ? `已設定（len ${cfg.apiKey.length}）` : '（空）')
  if (!cfg.apiKey) { console.log('沒有金鑰，中止'); app.exit(1); return }

  console.log('\n合成測試音訊…')
  const res = await edgeTts.synthesize({ text: SENTENCE, voice: 'zh-TW-HsiaoChenNeural' })
  const mp3 = Buffer.from(res?.data || res)
  console.log(`mp3 ${mp3.length} bytes`)

  const base = cfg.apiUrl.replace(/\/+$/, '')
  const auth = { Authorization: `Bearer ${cfg.apiKey}` }

  /** @param {string} label @param {string} url @param {RequestInit} init */
  async function shot(label, url, init) {
    process.stdout.write(`\n--- ${label}\n    POST ${url}\n`)
    try {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(60000) })
      const body = await r.text()
      console.log(`    HTTP ${r.status} ${r.headers.get('content-type') || ''}`)
      console.log('    body:', redact(body))
      return { status: r.status, body }
    } catch (e) {
      console.log('    連線失敗:', e?.name, redact(e?.message))
      return { status: 0, body: '' }
    }
  }

  // ① 目前程式碼在做的事：JSON + input_audio
  await shot('現行寫法：JSON input_audio', `${base}/audio/transcriptions`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.modelId,
      input_audio: { data: mp3.toString('base64'), format: 'mp3' },
      language: 'zh'
    })
  })

  // ② OpenAI 官方形狀：multipart/form-data
  const fd = new FormData()
  fd.append('model', cfg.modelId)
  fd.append('language', 'zh')
  fd.append('file', new Blob([mp3], { type: 'audio/mpeg' }), 'audio.mp3')
  await shot('OpenAI 官方：multipart/form-data', `${base}/audio/transcriptions`, {
    method: 'POST', headers: auth, body: fd
  })

  // ③ OpenRouter 的音訊輸入是走 chat/completions 的 input_audio content part
  await shot('chat/completions + input_audio', `${base}/chat/completions`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.modelId,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '請把這段語音逐字轉成文字，只輸出文字本身。' },
          { type: 'input_audio', input_audio: { data: mp3.toString('base64'), format: 'mp3' } }
        ]
      }]
    })
  })

  // ④ 換幾顆別的轉錄模型：分辨「請求形狀錯」還是「這一顆模型不給用」。
  //    OpenAI 那三顆走 OpenRouter 自己的額度；chirp-3（google-vertex）與 grok-stt（xai）
  //    是 BYOK-only，403 代表你自己那把上游金鑰沒有轉錄權限，不是我們送錯。
  for (const m of ['openai/whisper-large-v3-turbo', 'openai/whisper-1', 'openai/gpt-4o-transcribe',
    'openai/gpt-4o-mini-transcribe', 'google/chirp-3', 'x-ai/grok-stt-1.0']) {
    const f = new FormData()
    f.append('model', m)
    f.append('file', new Blob([mp3], { type: 'audio/mpeg' }), 'audio.mp3')
    await shot(`multipart × ${m}`, `${base}/audio/transcriptions`, {
      method: 'POST', headers: auth, body: f
    })
    await shot(`JSON input_audio × ${m}`, `${base}/audio/transcriptions`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: m, input_audio: { data: mp3.toString('base64'), format: 'mp3' } })
    })
  }

  // ⑤ 走真正的 cloud-asr：使用者現在的設定會看到什麼訊息，換一顆之後拿到什麼文字
  console.log('\n=== 走 src/main/cloud-asr.js ===')
  /** @param {string} modelId */
  const withModel = (modelId) => ({
    get: (k, d) => ({ asrApiUrl: cfg.apiUrl, asrApiKey: cfg.apiKey, asrModelId: modelId }[k] ?? d)
  })
  for (const m of ['openai/whisper-large-v3-turbo', cfg.modelId]) {
    try {
      const out = await cloudAsr.transcribeEncoded(
        { buffer: mp3, format: 'mp3', language: 'zh-TW' }, withModel(m)
      )
      console.log(`  ${m} → 「${out}」`)
    } catch (e) {
      console.log(`  ${m} → 錯誤訊息：${redact(e?.message)}`)
    }
  }

  app.exit(0)
}

app.whenReady().then(main).catch((e) => { console.error(e); app.exit(1) })
