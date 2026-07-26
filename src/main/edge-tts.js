/**
 * VoiceInk - Edge TTS facade（Main Process）
 * MIT 套件 node-edge-tts；對外只暴露記憶體 bytes
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { randomBytes } = require('crypto')
const {
  isAllowedVoice,
  langToEdgeLocale,
  sanitizeTtsVoices,
  DEFAULT_TTS_VOICES,
  listVoices
} = require('./tts-voices')

const MAX_CHUNK_CHARS = 1800
const MAX_TOTAL_CHARS = 8000
const TTS_TIMEOUT_MS = 20000

/** @type {number} 作廢 in-flight 合成 */
let ttsGen = 0

/**
 * 錯誤分類
 * @param {unknown} err
 * @returns {{ code: string, message: string }}
 */
function classifyError(err) {
  const msg = (err && /** @type {Error} */ (err).message) || String(err || '未知錯誤')
  const lower = msg.toLowerCase()
  if (
    lower.includes('enotfound') ||
    lower.includes('econnrefused') ||
    lower.includes('enetunreach') ||
    lower.includes('offline') ||
    lower.includes('getaddrinfo') ||
    lower.includes('network')
  ) {
    return { code: 'OFFLINE', message: '朗讀需要連上網路（Edge TTS）' }
  }
  if (
    lower.includes('timeout') ||
    lower.includes('etimedout') ||
    lower.includes('aborted')
  ) {
    return { code: 'TIMEOUT', message: '語音合成逾時，請稍後再試' }
  }
  if (
    lower.includes('403') ||
    lower.includes('429') ||
    lower.includes('401') ||
    lower.includes('forbidden') ||
    lower.includes('too many')
  ) {
    return { code: 'REJECTED', message: '語音服務暫時無法使用，請稍後再試' }
  }
  return { code: 'REJECTED', message: `語音合成失敗：${msg.slice(0, 120)}` }
}

/**
 * 依句界切塊
 * @param {string} text
 * @param {number} maxLen
 * @returns {string[]}
 */
function splitChunks(text, maxLen = MAX_CHUNK_CHARS) {
  const t = (text || '').trim()
  if (!t) return []
  if (t.length <= maxLen) return [t]

  const parts = []
  let rest = t
  const breakRe = /[。．.!?！？\n]+/g

  while (rest.length > maxLen) {
    const slice = rest.slice(0, maxLen)
    let cut = -1
    breakRe.lastIndex = 0
    let m
    while ((m = breakRe.exec(slice)) !== null) {
      cut = m.index + m[0].length
    }
    if (cut < maxLen * 0.3) {
      // 找不到句界：退到空白
      const sp = slice.lastIndexOf(' ')
      cut = sp > maxLen * 0.3 ? sp + 1 : maxLen
    }
    parts.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) parts.push(rest)
  return parts.filter(Boolean)
}

/**
 * 語速百分比偏移 → Edge TTS rate 字串
 * @param {unknown} raw
 * @returns {string} 如 'default'、'+20%'、'-30%'
 */
function formatTtsRate(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n === 0) return 'default'
  const clamped = Math.max(-50, Math.min(100, Math.round(n)))
  if (clamped === 0) return 'default'
  return clamped > 0 ? `+${clamped}%` : `${clamped}%`
}

/**
 * 從 store 解析並正規化 ttsRate（-50…100）
 * @param {import('electron-store').default | null} store
 * @returns {number}
 */
function resolveTtsRate(store) {
  if (!store) return 0
  return sanitizeTtsRate(store.get('ttsRate', 0))
}

/**
 * @param {unknown} val
 * @returns {number}
 */
function sanitizeTtsRate(val) {
  const n = Number(val)
  if (!Number.isFinite(n)) return 0
  return Math.max(-50, Math.min(100, Math.round(n)))
}

/**
 * 單塊合成 → Uint8Array
 * @param {string} text
 * @param {string} voice
 * @param {string} [rate] Edge rate 字串
 * @returns {Promise<Uint8Array>}
 */
async function synthesizeChunk(text, voice, rate = 'default') {
  const trimmed = (text || '').trim()
  if (!trimmed) {
    const e = new Error('EMPTY')
    // @ts-ignore
    e.code = 'EMPTY'
    throw e
  }
  if (!isAllowedVoice(voice)) {
    throw new Error(`不允許的語音: ${voice}`)
  }
  if (trimmed.length > MAX_CHUNK_CHARS) {
    throw new Error(`單段文字過長（>${MAX_CHUNK_CHARS}）`)
  }

  const { EdgeTTS } = require('node-edge-tts')
  const locale = voice.split('-').slice(0, 2).join('-') // zh-TW / en-US
  const tmp = path.join(
    os.tmpdir(),
    `voiceink-tts-${process.pid}-${randomBytes(8).toString('hex')}.mp3`
  )

  const tts = new EdgeTTS({
    voice,
    lang: locale || langToEdgeLocale(voice.slice(0, 2)),
    outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
    rate: rate || 'default',
    timeout: TTS_TIMEOUT_MS
  })

  try {
    await tts.ttsPromise(trimmed, tmp)
    const buf = await fs.promises.readFile(tmp)
    if (!buf || buf.length === 0) {
      const e = new Error('EMPTY')
      // @ts-ignore
      e.code = 'EMPTY'
      throw e
    }
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  } catch (err) {
    if (/** @type {{ code?: string }} */ (err).code === 'EMPTY') throw err
    const c = classifyError(err)
    const e = new Error(c.message)
    // @ts-ignore
    e.code = c.code
    throw e
  } finally {
    fs.promises.unlink(tmp).catch(() => {})
  }
}

/**
 * 合成（可切塊；回傳第一塊 + 剩餘 chunks 元資料由 renderer 再請求）
 * MVP：一次 IPC 只合成「指定 chunk 索引」或整段（自動取第一塊）
 *
 * @param {{ text: string, voice: string, chunkIndex?: number, rate?: string }} req
 * @returns {Promise<{ mime: string, data: Uint8Array, chunkIndex: number, totalChunks: number, gen: number }>}
 */
async function synthesize(req) {
  const text = typeof req?.text === 'string' ? req.text.trim() : ''
  const voice = req?.voice
  if (!text) {
    const e = new Error('沒有可朗讀的文字')
    // @ts-ignore
    e.code = 'EMPTY'
    throw e
  }
  if (text.length > MAX_TOTAL_CHARS) {
    throw new Error(`文字過長（上限 ${MAX_TOTAL_CHARS} 字），請縮短後再朗讀`)
  }
  if (!isAllowedVoice(voice)) {
    throw new Error('無效的語音設定')
  }

  const rate = typeof req?.rate === 'string' && req.rate ? req.rate : 'default'
  const chunks = splitChunks(text)
  const idx = Math.max(0, Math.min(chunks.length - 1, Number(req.chunkIndex) || 0))
  const myGen = ++ttsGen

  const data = await synthesizeChunk(chunks[idx], voice, rate)
  if (myGen !== ttsGen) {
    const e = new Error('語音請求已取消')
    // @ts-ignore
    e.code = 'CANCELLED'
    throw e
  }
  return {
    mime: 'audio/mpeg',
    data,
    chunkIndex: idx,
    totalChunks: chunks.length,
    gen: myGen
  }
}

/**
 * 從 store 解析 voice
 * @param {import('electron-store').default | null} store
 * @param {string} lang
 * @returns {string}
 */
function resolveVoice(store, lang) {
  const voices = sanitizeTtsVoices(store ? store.get('ttsVoices', DEFAULT_TTS_VOICES) : DEFAULT_TTS_VOICES)
  const langKey = LANGS_HAS(lang) ? lang : 'en'
  return voices[langKey] || DEFAULT_TTS_VOICES[langKey] || DEFAULT_TTS_VOICES.en
}

function LANGS_HAS(lang) {
  return Object.prototype.hasOwnProperty.call(DEFAULT_TTS_VOICES, lang)
}

/**
 * 作廢 in-flight（離頁／停止）
 */
function cancelAll() {
  ttsGen++
}

module.exports = {
  synthesize,
  synthesizeChunk,
  splitChunks,
  resolveVoice,
  resolveTtsRate,
  formatTtsRate,
  sanitizeTtsRate,
  cancelAll,
  listVoices,
  sanitizeTtsVoices,
  DEFAULT_TTS_VOICES,
  MAX_TOTAL_CHARS,
  MAX_CHUNK_CHARS
}
