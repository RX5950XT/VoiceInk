/**
 * VoiceInk - 本地 ASR（sherpa-onnx，Main Process）
 * 固定使用 Qwen3-ASR-0.6B
 * 支援 warm / unload（generation 防幽靈載入 + serial lock 防並行雙載）
 */

const path = require('path')
const os = require('os')
const { modelDir, isDownloaded } = require('./models')

/** 固定 ASR 模型 key */
const ASR_MODEL_KEY = 'qwen3asr'

const { s2twp } = require('./opencc')

/** 單段音訊上限：略大於檔案 28s×16k，阻擋 IPC DoS */
const MAX_SAMPLES = 30 * 16000

let sherpa = null
let recognizer = null
let loadedKey = null

/** 世代：unload 時遞增，in-flight load 完成後若不符則丟棄 */
let loadGen = 0
let loadPromise = null
/**
 * 僅 warm()/transcribe 在引擎持有期間可載入。
 * unload 先設 false，避免 stop 後 in-flight 呼叫幽靈重載。
 */
let loadEnabled = false

/** 串列鎖：getRecognizer / transcribe / unload 不互踩、不雙載 */
let asrChain = Promise.resolve()

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withAsrLock(fn) {
  const run = asrChain.then(fn, fn)
  asrChain = run.then(() => {}, () => {})
  return run
}

/**
 * 修復 JSON 字串值內未跳脫的控制字元（0x00–0x1F）。
 * sherpa-onnx native 偶爾把原文控制字元原樣塞進 JSON → JSON.parse 丟
 * "Bad control character in string literal"。
 * @param {string} jsonStr
 * @returns {string}
 */
function repairJsonControlChars(jsonStr) {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < jsonStr.length; i++) {
    const c = jsonStr[i]
    const code = c.charCodeAt(0)
    if (!inString) {
      if (c === '"') inString = true
      out += c
      continue
    }
    if (escaped) {
      out += c
      escaped = false
      continue
    }
    if (c === '\\') {
      out += c
      escaped = true
      continue
    }
    if (c === '"') {
      out += c
      inString = false
      continue
    }
    if (code < 0x20) {
      if (c === '\n') out += '\\n'
      else if (c === '\r') out += '\\r'
      else if (c === '\t') out += '\\t'
      else out += '\\u' + code.toString(16).padStart(4, '0')
      continue
    }
    out += c
  }
  return out
}

/**
 * 安全解析 sherpa 結果 JSON
 * @param {string} jsonStr
 * @returns {{ text?: string, [k: string]: unknown }}
 */
function parseSherpaJson(jsonStr) {
  if (typeof jsonStr !== 'string' || !jsonStr.trim()) return { text: '' }
  try {
    return JSON.parse(jsonStr)
  } catch {
    /* continue */
  }
  try {
    return JSON.parse(repairJsonControlChars(jsonStr))
  } catch {
    /* continue */
  }
  // 最後手段：粗抽 "text" 欄位
  const m = /"text"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(repairJsonControlChars(jsonStr))
  if (m) {
    try {
      return { text: JSON.parse(`"${m[1]}"`) }
    } catch {
      return { text: m[1] }
    }
  }
  console.error('[local-asr] sherpa JSON 無法解析:', jsonStr.slice(0, 240))
  return { text: '' }
}

/**
 * 覆寫 OfflineRecognizer.decodeAsync / getResult，避免 native JSON 控制字元炸掉整段轉錄
 * @param {typeof import('sherpa-onnx-node')} sherpaMod
 */
function patchSherpaJsonSafety(sherpaMod) {
  const OR = sherpaMod && sherpaMod.OfflineRecognizer
  if (!OR || !OR.prototype || OR.prototype.__voiceinkJsonPatched) return

  let addon
  try {
    addon = require('sherpa-onnx-node/addon.js')
  } catch (e) {
    console.warn('[local-asr] 無法載入 sherpa addon 以套用 JSON 防護:', e.message || e)
    return
  }
  if (!addon || typeof addon.decodeOfflineStreamAsync !== 'function') {
    console.warn('[local-asr] sherpa addon 缺少 decodeOfflineStreamAsync')
    return
  }

  OR.prototype.decodeAsync = async function decodeAsyncSafe(stream) {
    const jsonStr = await addon.decodeOfflineStreamAsync(this.handle, stream.handle)
    return parseSherpaJson(jsonStr)
  }

  if (typeof addon.getOfflineStreamResultAsJson === 'function') {
    OR.prototype.getResult = function getResultSafe(stream) {
      const jsonStr = addon.getOfflineStreamResultAsJson(stream.handle)
      return parseSherpaJson(jsonStr)
    }
  }

  OR.prototype.__voiceinkJsonPatched = true
}

/**
 * 載入 sherpa-onnx-node（Windows 需先把 DLL 目錄加入 PATH）
 */
function loadSherpa() {
  if (sherpa) return sherpa
  if (process.platform === 'win32') {
    const pkgJson = require.resolve('sherpa-onnx-win-x64/package.json')
    const dllDir = path.dirname(pkgJson).replace('app.asar', 'app.asar.unpacked')
    process.env.PATH = dllDir + path.delimiter + process.env.PATH
  }
  sherpa = require('sherpa-onnx-node')
  patchSherpaJsonSafety(sherpa)
  return sherpa
}

/**
 * Qwen3-ASR 的 sherpa offlineRecognizer modelConfig
 */
function buildModelConfig(key) {
  if (key !== ASR_MODEL_KEY) throw new Error(`未知的 ASR 模型: ${key}`)
  const dir = modelDir(key)
  const numThreads = Math.min(8, Math.max(2, Math.floor(os.cpus().length / 2)))
  return {
    tokens: '',
    numThreads,
    provider: 'cpu',
    debug: 0,
    qwen3Asr: {
      convFrontend: path.join(dir, 'conv_frontend.onnx'),
      encoder: path.join(dir, 'encoder.int8.onnx'),
      decoder: path.join(dir, 'decoder.int8.onnx'),
      tokenizer: path.join(dir, 'tokenizer'),
      hotwords: ''
    }
  }
}

/**
 * 嘗試釋放 recognizer native 資源
 * @param {object} rec
 * @param {string[]} warnings
 */
async function disposeRecognizer(rec, warnings) {
  if (!rec) return
  try {
    if (typeof rec.dispose === 'function') await rec.dispose()
    else if (typeof rec.free === 'function') rec.free()
    else if (typeof rec.delete === 'function') rec.delete()
  } catch (e) {
    warnings.push(`asr.dispose: ${e.message || e}`)
  }
}

/**
 * 取得（必要時建立）recognizer；須在 withAsrLock 內呼叫
 */
async function getRecognizer(key) {
  if (recognizer && loadedKey === key) return recognizer
  if (!loadEnabled) throw new Error('ASR 已卸載')
  if (!isDownloaded(key)) throw new Error('模型尚未下載，請先到設定下載')

  if (loadPromise) {
    await loadPromise
    if (recognizer && loadedKey === key) return recognizer
    if (!loadEnabled) throw new Error('ASR 已卸載')
  }

  const myGen = loadGen
  loadPromise = (async () => {
    const s = loadSherpa()
    // 若已有其他 key 的 recognizer，先卸
    if (recognizer && loadedKey !== key) {
      const w = []
      await disposeRecognizer(recognizer, w)
      recognizer = null
      loadedKey = null
    }
    const rec = await s.OfflineRecognizer.createAsync({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: buildModelConfig(key)
    })
    if (myGen !== loadGen || !loadEnabled) {
      await disposeRecognizer(rec, [])
      throw new Error('ASR load cancelled')
    }
    recognizer = rec
    loadedKey = key
    return recognizer
  })()

  try {
    return await loadPromise
  } finally {
    loadPromise = null
  }
}

/**
 * 預熱 ASR 模型（載入至記憶體）
 * @param {string} [key]
 * @returns {Promise<{ ok: boolean, warnings: string[] }>}
 */
async function warm(key = ASR_MODEL_KEY) {
  const warnings = []
  try {
    loadEnabled = true
    await withAsrLock(async () => {
      await getRecognizer(key || ASR_MODEL_KEY)
    })
    return { ok: true, warnings }
  } catch (e) {
    return { ok: false, warnings: [e.message || String(e)] }
  }
}

/**
 * 卸載 ASR（先禁載入 → 等 in-flight → dispose，避免幽靈重載）
 * @returns {Promise<{ ok: boolean, warnings: string[] }>}
 */
async function unload() {
  const warnings = []
  loadEnabled = false
  loadGen += 1
  return withAsrLock(async () => {
    if (loadPromise) {
      try { await loadPromise } catch { /* cancelled or failed */ }
    }
    await disposeRecognizer(recognizer, warnings)
    recognizer = null
    loadedKey = null
    return { ok: true, warnings }
  })
}

/** @returns {boolean} */
function isLoaded() {
  return !!recognizer
}

/**
 * 正規化 IPC 傳來的 samples（Structured Clone 可能變普通物件／Array）
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
 * 目標語為繁中時，僅對「像中文、非日韓」的來源做 s2twp。
 * 不可只看 lang===zh-TW：日文漢字會被 opencc 弄髒（国→國 等）。
 * @param {string} text
 * @param {string} lang
 */
function shouldS2twpSource(text, lang) {
  if (lang !== 'zh-TW' || !text) return false
  if (/[ぁ-ヿ가-힯]/.test(text)) return false
  const cjkCount = (text.match(/[一-鿿]/g) || []).length
  return cjkCount / Math.max(1, text.length) >= 0.3
}

/**
 * 轉錄一段音訊
 * @param {{samples: Float32Array, sampleRate: number, lang: string, modelKey?: string}} req
 * @returns {Promise<string>}
 */
async function transcribe({ samples, sampleRate, lang, modelKey = ASR_MODEL_KEY }) {
  return withAsrLock(async () => {
    if (!loadEnabled && !recognizer) {
      throw new Error('ASR 未載入，請先啟動引擎')
    }
    const rate = Number(sampleRate) || 16000
    if (rate !== 16000) throw new Error(`不支援的 sampleRate: ${rate}`)

    const floatSamples = normalizeSamples(samples)
    if (floatSamples.length === 0) return ''
    if (floatSamples.length > MAX_SAMPLES) {
      throw new Error(`音訊過長（${floatSamples.length} samples，上限 ${MAX_SAMPLES}）`)
    }

    const rec = await getRecognizer(modelKey || ASR_MODEL_KEY)
    if (!loadEnabled || !recognizer) throw new Error('ASR 已卸載')

    const stream = rec.createStream()
    stream.acceptWaveform({ sampleRate: rate, samples: floatSamples })
    const result = await rec.decodeAsync(stream)
    // 去掉 token 標記與 C0 控制字元（保留 \n\t 空白類，再統一壓成空白）
    let text = String(result?.text || '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (text && shouldS2twpSource(text, lang)) text = s2twp(text)
    return text
  })
}

module.exports = {
  transcribe,
  warm,
  unload,
  isLoaded,
  ASR_MODEL_KEY,
  // 測試／除錯用
  parseSherpaJson,
  repairJsonControlChars
}
