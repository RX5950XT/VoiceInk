/**
 * VoiceInk - 雲端 ASR（OpenRouter / OpenAI 相容 /audio/transcriptions）
 */

const { Buffer } = require('buffer')

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

/**
 * @param {unknown} store
 * @returns {{ apiUrl: string, apiKey: string, modelId: string }}
 */
function readConfig(store) {
  if (!store) throw new Error('尚未初始化設定儲存')
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
 * @param {number} status
 * @returns {Error}
 */
function classifyHttpError(status) {
  if (status === 401 || status === 403) {
    return new Error('雲端 ASR 認證失敗，請檢查 API Key')
  }
  if (status === 404) {
    return new Error('找不到雲端 ASR 端點，請檢查 API URL')
  }
  if (status === 429) {
    return new Error('雲端 ASR 請求過於頻繁，請稍後再試')
  }
  if (status >= 500) {
    return new Error(`雲端 ASR 服務異常（HTTP ${status}）`)
  }
  return new Error(`雲端 ASR 失敗（HTTP ${status}），請檢查模型名稱與音訊格式`)
}

/**
 * 呼叫 /audio/transcriptions
 * @param {{ buffer: Buffer, format: string, language?: string, store: object }} opts
 * @returns {Promise<string>}
 */
async function transcribeAudio(opts) {
  const { buffer, format, language, store } = opts
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('音訊資料為空')
  }
  if (buffer.length > MAX_AUDIO_BYTES) {
    throw new Error(`音訊片段過大（${Math.round(buffer.length / 1024 / 1024)} MB），請縮短後再試`)
  }

  const cfg = readConfig(store)
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
    throw classifyHttpError(res.status)
  }

  let json
  try {
    json = JSON.parse(raw)
  } catch {
    throw new Error('雲端 ASR 回應不是有效 JSON')
  }
  const text = typeof json?.text === 'string' ? json.text.trim() : ''
  return text
}

/**
 * 即時／短段：Float32 16k → WAV → 雲端
 * @param {{ samples: unknown, sampleRate?: number, lang?: string }} req
 * @param {object} store
 * @returns {Promise<string>}
 */
async function transcribeSamples(req, store) {
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
    store
  })
}

/**
 * 已是編碼音訊（mp3 等）的 buffer
 * @param {{ buffer: Buffer, format: string, language?: string }} req
 * @param {object} store
 * @returns {Promise<string>}
 */
async function transcribeEncoded(req, store) {
  return transcribeAudio({
    buffer: req.buffer,
    format: req.format || 'mp3',
    language: req.language,
    store
  })
}

module.exports = {
  classifyHttpError,
  DEFAULT_ASR_API_URL,
  DEFAULT_ASR_MODEL,
  float32ToWav,
  normalizeSamples,
  transcribeSamples,
  transcribeEncoded,
  transcribeAudio,
  readConfig,
  toWhisperLang
}
