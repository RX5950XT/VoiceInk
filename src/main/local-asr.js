/**
 * VoiceInk - 本地 ASR（sherpa-onnx，Main Process）
 * 固定使用 Qwen3-ASR-0.6B
 * 支援 warm / unload（generation 防幽靈載入）
 */

const path = require('path')
const os = require('os')
const { modelDir, isDownloaded } = require('./models')

/** 固定 ASR 模型 key */
const ASR_MODEL_KEY = 'qwen3asr'

const { s2twp } = require('./opencc')

let sherpa = null
let recognizer = null
let loadedKey = null

/** 世代：unload 時遞增，in-flight load 完成後若不符則丟棄 */
let loadGen = 0
let loadPromise = null

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
 * 取得（必要時建立）recognizer；切換模型時重建
 */
async function getRecognizer(key) {
  if (recognizer && loadedKey === key) return recognizer
  if (!isDownloaded(key)) throw new Error('模型尚未下載，請先到設定下載')

  if (loadPromise) {
    await loadPromise
    if (recognizer && loadedKey === key) return recognizer
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
    if (myGen !== loadGen) {
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
    await getRecognizer(key || ASR_MODEL_KEY)
    return { ok: true, warnings }
  } catch (e) {
    return { ok: false, warnings: [e.message || String(e)] }
  }
}

/**
 * 卸載 ASR（bump generation，丟棄 in-flight load）
 * @returns {Promise<{ ok: boolean, warnings: string[] }>}
 */
async function unload() {
  const warnings = []
  loadGen += 1
  if (loadPromise) {
    try { await loadPromise } catch { /* cancelled or failed */ }
  }
  await disposeRecognizer(recognizer, warnings)
  recognizer = null
  loadedKey = null
  return { ok: true, warnings }
}

/** @returns {boolean} */
function isLoaded() {
  return !!recognizer
}

/**
 * 轉錄一段音訊
 * @param {{samples: Float32Array, sampleRate: number, lang: string, modelKey?: string}} req
 * @returns {Promise<string>}
 */
async function transcribe({ samples, sampleRate, lang, modelKey = ASR_MODEL_KEY }) {
  const rec = await getRecognizer(modelKey || ASR_MODEL_KEY)
  const stream = rec.createStream()
  stream.acceptWaveform({ sampleRate, samples })
  const result = await rec.decodeAsync(stream)
  let text = (result.text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  if (text && lang === 'zh-TW') text = s2twp(text)
  return text
}

module.exports = { transcribe, warm, unload, isLoaded, ASR_MODEL_KEY }
