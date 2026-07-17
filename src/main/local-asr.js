/**
 * VoiceInk - 本地 ASR（sherpa-onnx，Main Process）
 * 固定使用 Qwen3-ASR-0.6B
 */

const path = require('path')
const os = require('os')
const { modelDir, isDownloaded } = require('./models')

/** 固定 ASR 模型 key */
const ASR_MODEL_KEY = 'qwen3asr'

let sherpa = null
let recognizer = null
let loadedKey = null
let toTraditional = null

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
 * 取得（必要時建立）recognizer；切換模型時重建
 */
async function getRecognizer(key) {
  if (recognizer && loadedKey === key) return recognizer
  if (!isDownloaded(key)) throw new Error('模型尚未下載，請先到設定下載')

  const s = loadSherpa()
  recognizer = await s.OfflineRecognizer.createAsync({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: buildModelConfig(key)
  })
  loadedKey = key
  return recognizer
}

/**
 * 簡體轉繁體（台灣用語）
 */
function s2twp(text) {
  if (!toTraditional) {
    const OpenCC = require('opencc-js')
    toTraditional = OpenCC.Converter({ from: 'cn', to: 'twp' })
  }
  return toTraditional(text)
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
  // 去除模型特殊符號（如 <sil> <unk>）並整理空白
  let text = (result.text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  if (text && lang === 'zh-TW') text = s2twp(text)
  return text
}

module.exports = { transcribe, ASR_MODEL_KEY }
