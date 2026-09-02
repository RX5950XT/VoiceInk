/**
 * VoiceInk - 雲端 ASR（OpenRouter / OpenAI 相容 /audio/transcriptions）
 */

const { Buffer } = require('buffer')
const { s2twp, shouldS2twpSource } = require('./opencc')

const DEFAULT_ASR_API_URL = 'https://openrouter.ai/api/v1'
const DEFAULT_ASR_MODEL = 'openai/whisper-1'
const REQUEST_TIMEOUT_MS = 55000
const MAX_AUDIO_BYTES = 24 * 1024 * 1024

/**
 * 正規化 samples（與 local-asr 對齊）
 * @param {unknown} samples
 * @returns {Float32Array}
 */
function normalizeSamples(samples) {
  if (samples instanceof Float32Array) return samples
  if (ArrayBuffer.isView(samples) && samples.buffer) {
    return new Float32Array(samples.buffer, samples.byteOffset, samples.byteLength / 4)
  }
  if (Array.isArray(samples)) return Float32Array.from(samples)
  if (samples && typeof samples === 'object' && samples.type === 'Float32Array' && Array.isArray(samples.data)) {
    return Float32Array.from(samples.data)
  }
  throw new Error('samples 必須是 Float32Array')
}

/**
 * Float32 mono PCM → 16-bit WAV Buffer
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @returns {Buffer}
 */
function float32ToWav(samples, sampleRate = 16000) {
  const numSamples = samples.length
  const dataSize = numSamples * 2
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20) // PCM
  buffer.writeUInt16LE(1, 22) // mono
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)
  for (let i = 0; i < numSamples; i++) {
    let s = samples[i]
    if (!Number.isFinite(s)) s = 0
    s = Math.max(-1, Math.min(1, s))
    const v = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff)
    buffer.writeInt16LE(v, 44 + i * 2)
  }
  return buffer
}

const MAX_ASR_CLOUDS = 20
const MAX_ASR_CLOUD_NAME = 24
const MAX_ASR_URL = 300
const MAX_ASR_KEY = 200
const MAX_ASR_MODEL_ID = 120

/** 一組設定底下最多幾顆模型 */
const MAX_ASR_MODELS = 30

/**
 * 多組雲端 ASR 設定（`asrClouds`）的正規化。形狀與守門跟聊天供應商同一套規矩：
 * id 走字元 allowlist、去重、限量；apiUrl 只放行 http(s)；**壞網址保留這筆但清空 url**——
 * 這個函式跑在 store:set 的存檔路徑上，整筆丟掉等於使用者打錯一個字就把金鑰刪了。
 *
 * **一組設定底下可以有多顆模型**（`models`），跟聊天供應商一樣：同一把金鑰、同一個端點，
 * 想換模型不必再開一組設定。舊檔只有單一 `modelId`，讀進來就變成只有一顆的清單。
 * @param {unknown} raw
 * @returns {Array<{ id: string, name: string, apiUrl: string, apiKey: string, models: string[] }>}
 */
function sanitizeAsrClouds(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const id = typeof item.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(item.id) ? item.id : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    const name = typeof item.name === 'string' ? item.name.trim().replace(/\s+/g, ' ') : ''
    const rawUrl = typeof item.apiUrl === 'string' ? item.apiUrl.trim().slice(0, MAX_ASR_URL) : ''
    // 舊檔的單一 modelId 也收進來（一次性升級，之後只看 models）
    const rawModels = Array.isArray(item.models)
      ? item.models
      : [typeof item.modelId === 'string' ? item.modelId : '']
    const models = []
    for (const model of rawModels) {
      const trimmed = typeof model === 'string' ? model.trim().slice(0, MAX_ASR_MODEL_ID) : ''
      if (trimmed && !models.includes(trimmed)) models.push(trimmed)
      if (models.length >= MAX_ASR_MODELS) break
    }
    out.push({
      id,
      name: name.slice(0, MAX_ASR_CLOUD_NAME) || `設定 ${out.length + 1}`,
      apiUrl: /^https?:\/\//i.test(rawUrl) ? rawUrl : '',
      apiKey: typeof item.apiKey === 'string' ? item.apiKey.trim().slice(0, MAX_ASR_KEY) : '',
      models
    })
    if (out.length >= MAX_ASR_CLOUDS) break
  }
  return out
}

/**
 * 舊版的單組設定（asrApiUrl／asrApiKey／asrModelId）→ 一筆名為「預設」的設定。
 * 呼叫端（main 的 initStore）負責只在 asrClouds 還沒有值時跑一次。
 * @param {unknown} apiUrl
 * @param {unknown} apiKey
 * @param {unknown} modelId
 * @returns {Array<{ id: string, name: string, apiUrl: string, apiKey: string, modelId: string }>}
 */
function asrCloudsFromLegacy(apiUrl, apiKey, modelId) {
  const url = typeof apiUrl === 'string' ? apiUrl.trim() : ''
  const key = typeof apiKey === 'string' ? apiKey.trim() : ''
  const model = typeof modelId === 'string' ? modelId.trim() : ''
  return sanitizeAsrClouds([{ id: 'legacy', name: '預設', apiUrl: url, apiKey: key, models: [model] }])
}

/**
 * 目前生效的雲端 ASR 設定。
 *
 * 有 scope 就用那一頁自己選的（`<scope>Asr` 存 `cloud:<設定 id>:<模型 id>`）；
 * 沒有就退回 `asrCloudId`／第一組。都沒有清單（舊版 config、手改設定檔、測試 mock）
 * 才讀舊的單組 key。
 *
 * @param {unknown} store
 * @param {string} [scope] `file`／`live`／`dictation`
 * @returns {{ apiUrl: string, apiKey: string, modelId: string }}
 */
function readConfig(store, scope) {
  if (!store) throw new Error('尚未初始化設定儲存')
  const list = sanitizeAsrClouds(store.get('asrClouds', []))
  // 延後 require：model-scope 會拉進 chat／models，而這條路徑也被測試單獨 require
  const picked = scope ? require('./model-scope').readAsr(store, scope) : null
  const id = String(picked?.cloudId || store.get('asrCloudId', '') || '')
  const cur = (id && list.find((c) => c.id === id)) || list[0]
  if (cur) {
    const modelId = (picked?.modelId && cur.models.includes(picked.modelId))
      ? picked.modelId
      : (cur.models[0] || DEFAULT_ASR_MODEL)
    return {
      apiUrl: cur.apiUrl || DEFAULT_ASR_API_URL,
      apiKey: cur.apiKey,
      modelId
    }
  }
  const apiUrl = String(store.get('asrApiUrl', DEFAULT_ASR_API_URL) || DEFAULT_ASR_API_URL).trim()
  const apiKey = String(store.get('asrApiKey', '') || '').trim()
  const modelId = String(store.get('asrModelId', DEFAULT_ASR_MODEL) || DEFAULT_ASR_MODEL).trim()
  return { apiUrl, apiKey, modelId }
}

/**
 * ISO-639-1 語言碼（Whisper 風格）；auto／未知則省略
 * @param {string} [lang]
 * @returns {string|undefined}
 */
function toWhisperLang(lang) {
  if (!lang || lang === 'auto') return undefined
  if (lang === 'zh-TW' || lang === 'zh-CN') return 'zh'
  if (lang === 'en' || lang === 'ja' || lang === 'ko') return lang
  if (/^[a-z]{2}$/i.test(lang)) return lang.toLowerCase()
  return undefined
}

/**
 * 分類雲端錯誤。
 * 只看狀態碼，**不把上游 body 放進訊息**：這個字串會直接顯示在使用者介面上，
 * 而 body 可能夾帶請求回音（含 Authorization）、代理插入的內容，
 * 或自訂端點刻意寫來誘導使用者的文字。
 *
 * **401 與 403 是兩件事，不可以合併**：401 才是金鑰壞掉；403 是「金鑰沒問題，
 * 但這顆模型不給你用」（實測 OpenRouter 對沒開通的轉錄模型回
 * `Provider returned 403`，同一把金鑰換 `openai/whisper-1` 立刻 200）。
 * 以前兩個都講「請檢查 API Key」，等於把人送去查一個根本正確的東西。
 * modelId 是使用者自己填的設定值、不是上游回來的內容，可以放進訊息。
 * @param {number} status
 * @param {string} [modelId]
 * @returns {Error}
 */
function classifyHttpError(status, modelId = '') {
  const named = modelId ? `「${modelId}」` : '目前的模型'
  if (status === 401) {
    return new Error('雲端語音辨識認證失敗，請檢查 API Key')
  }
  if (status === 403) {
    return new Error(`雲端語音辨識模型${named}無法使用（HTTP 403）。金鑰本身沒問題，`
      + '請到設定→雲端模型換一個轉錄模型，或先到供應商後台開通這一顆')
  }
  if (status === 404) {
    return new Error(`找不到雲端語音辨識端點或模型${named}，請檢查 API URL 與模型 ID`)
  }
  if (status === 429) {
    return new Error('雲端語音辨識請求過於頻繁，請稍後再試')
  }
  if (status >= 500) {
    return new Error(`雲端語音辨識服務異常（HTTP ${status}）`)
  }
  return new Error(`雲端語音辨識失敗（HTTP ${status}），請檢查模型${named}是否為轉錄模型`)
}

/**
 * 呼叫 /audio/transcriptions
 * @param {{ buffer: Buffer, format: string, language?: string, store: object }} opts
 * @returns {Promise<string>}
 */
async function transcribeAudio(opts) {
  const { buffer, format, language, store, scope } = opts
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('音訊資料為空')
  }
  if (buffer.length > MAX_AUDIO_BYTES) {
    throw new Error(`音訊片段過大（${Math.round(buffer.length / 1024 / 1024)} MB），請縮短後再試`)
  }

  const cfg = readConfig(store, scope)
  if (!cfg.apiKey) throw new Error('尚未設定雲端 ASR 的 API Key')

  const base = cfg.apiUrl.replace(/\/+$/, '')
  const url = `${base}/audio/transcriptions`
  const body = {
    model: cfg.modelId,
    input_audio: {
      data: buffer.toString('base64'),
      format: format || 'wav'
    }
  }
  const lang = toWhisperLang(language)
  if (lang) body.language = lang

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    })
  } catch (e) {
    if (e && /** @type {{ name?: string }} */ (e).name === 'AbortError') {
      throw new Error('雲端 ASR 逾時，請稍後再試或縮短音訊')
    }
    const msg = (e && /** @type {Error} */ (e).message) || String(e)
    throw new Error(`雲端 ASR 連線失敗：${msg.slice(0, 120)}`)
  } finally {
    clearTimeout(timer)
  }

  const raw = await res.text()
  if (!res.ok) {
    console.error(`[cloud-asr] API error: HTTP ${res.status}`)
    throw classifyHttpError(res.status, cfg.modelId)
  }

  let json
  try {
    json = JSON.parse(raw)
  } catch {
    throw new Error('雲端語音辨識回應不是有效 JSON')
  }
  let text = typeof json?.text === 'string' ? json.text.trim() : ''
  // 雲端轉錄模型講中文一樣會吐簡體（實測 openai/gpt-4o-transcribe 全簡體），
  // 跟兩支本地 ASR 走同一份判斷，不在這裡另寫一套
  if (text && shouldS2twpSource(text, language || '')) text = s2twp(text)
  return text
}

/**
 * 即時／短段：Float32 16k → WAV → 雲端
 * @param {{ samples: unknown, sampleRate?: number, lang?: string }} req
 * @param {object} store
 * @param {string} [scope] 哪一頁在用（決定要用那一頁選的設定與模型）
 * @returns {Promise<string>}
 */
async function transcribeSamples(req, store, scope) {
  const rate = Number(req?.sampleRate) || 16000
  if (rate !== 16000) throw new Error(`雲端 ASR 僅支援 16k sampleRate（收到 ${rate}）`)
  const samples = normalizeSamples(req?.samples)
  if (samples.length === 0) return ''
  // 約 2 分鐘上限（即時每段遠短於此）
  if (samples.length > 16000 * 120) {
    throw new Error('音訊過長，請縮短後再送雲端')
  }
  const wav = float32ToWav(samples, rate)
  return transcribeAudio({
    buffer: wav,
    format: 'wav',
    language: req?.lang,
    store,
    scope
  })
}

/**
 * 已是編碼音訊（mp3 等）的 buffer
 * @param {{ buffer: Buffer, format: string, language?: string }} req
 * @param {object} store
 * @param {string} [scope]
 * @returns {Promise<string>}
 */
async function transcribeEncoded(req, store, scope) {
  return transcribeAudio({
    buffer: req.buffer,
    format: req.format || 'mp3',
    language: req.language,
    store,
    scope
  })
}

module.exports = {
  classifyHttpError,
  DEFAULT_ASR_API_URL,
  DEFAULT_ASR_MODEL,
  asrCloudsFromLegacy,
  sanitizeAsrClouds,
  float32ToWav,
  normalizeSamples,
  transcribeSamples,
  transcribeEncoded,
  transcribeAudio,
  readConfig,
  toWhisperLang
}
