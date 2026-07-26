/**
 * VoiceInk - 本地模型下載與管理（Main Process）
 */

const { app, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')
const { Readable } = require('stream')
const { pipeline } = require('stream/promises')

/**
 * 模型 registry
 * files 為相對於模型資料夾的路徑，自 base URL 直接下載（免解壓）
 */
const MODELS = {
  qwen3asr: {
    label: 'Qwen3-ASR-0.6B',
    kind: 'asr',
    totalBytes: 987015347,
    base: 'https://huggingface.co/csukuangfj2/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25/resolve/main/',
    files: [
      'conv_frontend.onnx',
      'encoder.int8.onnx',
      'decoder.int8.onnx',
      'tokenizer/vocab.json',
      'tokenizer/merges.txt',
      'tokenizer/tokenizer_config.json'
    ]
  },
  qwen35translate: {
    label: 'Qwen3.5-0.8B（通用翻譯）',
    kind: 'llm',
    totalBytes: 532517120,
    base: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/',
    files: ['Qwen3.5-0.8B-Q4_K_M.gguf'],
    gguf: 'Qwen3.5-0.8B-Q4_K_M.gguf'
  },
  /** 微調：繁中／英文／日文三語翻譯（Q4_K_M）；hidden：模型待修，暫時屏蔽（改回 false 即恢復） */
  linguaforge08: {
    label: 'LinguaForge 0.8B（繁中/英/日）',
    kind: 'llm',
    hidden: true,
    totalBytes: 529296768,
    base: 'https://huggingface.co/RX5950XT/LinguaForge-Qwen3.5-0.8B-zhTW-en-ja/resolve/main/',
    files: ['gguf/linguaforge-v3-0.8b-Q4_K_M.gguf'],
    gguf: 'gguf/linguaforge-v3-0.8b-Q4_K_M.gguf'
  }
}

/** 本地翻譯模型 key 白名單（順序：推薦在前）；linguaforge08 屏蔽中，修好後加回 */
const LLM_MODEL_KEYS = ['qwen35translate']

/**
 * @param {unknown} key
 * @returns {boolean}
 */
function isLlmKey(key) {
  return typeof key === 'string' && LLM_MODEL_KEYS.includes(key)
}

/**
 * GGUF 相對路徑（相對 modelDir）
 * @param {string} key
 * @returns {string | null}
 */
function ggufRelativePath(key) {
  const def = MODELS[key]
  if (!def || def.kind !== 'llm') return null
  if (typeof def.gguf === 'string' && def.gguf) return def.gguf
  const first = def.files?.[0]
  return typeof first === 'string' ? first : null
}

// 進行中的下載（key → AbortController）
const activeDownloads = new Map()

/**
 * 模型存放根目錄
 */
function modelsRoot() {
  return path.join(app.getPath('userData'), 'models')
}

/**
 * 單一模型的資料夾
 */
function modelDir(key) {
  return path.join(modelsRoot(), key)
}

/**
 * 模型是否已完整下載（所有檔案存在）
 */
function isDownloaded(key) {
  const def = MODELS[key]
  if (!def) return false
  return def.files.every(f => fs.existsSync(path.join(modelDir(key), f)))
}

/**
 * 全部模型狀態
 */
function status() {
  const result = {}
  for (const [key, def] of Object.entries(MODELS)) {
    if (def.hidden) continue
    result[key] = {
      key,
      label: def.label,
      kind: def.kind,
      totalBytes: def.totalBytes,
      downloaded: isDownloaded(key),
      downloading: activeDownloads.has(key)
    }
  }
  return { models: result, root: modelsRoot() }
}

/**
 * 下載模型（逐檔下載，onProgress 回報累計進度）
 * @param {string} key
 * @param {(p: {key: string, receivedBytes: number, totalBytes: number}) => void} onProgress
 */
async function download(key, onProgress) {
  const def = MODELS[key]
  if (!def) throw new Error(`未知的模型: ${key}`)
  if (activeDownloads.has(key)) throw new Error('此模型正在下載中')

  const controller = new AbortController()
  activeDownloads.set(key, controller)

  let received = 0
  let lastEmit = 0
  const emit = (force) => {
    const now = Date.now()
    if (!force && now - lastEmit < 300) return
    lastEmit = now
    onProgress({ key, receivedBytes: received, totalBytes: def.totalBytes })
  }

  try {
    for (const file of def.files) {
      const dest = path.join(modelDir(key), file)
      await fsp.mkdir(path.dirname(dest), { recursive: true })

      if (fs.existsSync(dest)) {
        received += (await fsp.stat(dest)).size
        emit(true)
        continue
      }

      const res = await fetch(def.base + file, { signal: controller.signal })
      if (!res.ok) throw new Error(`下載失敗 (HTTP ${res.status}): ${file}`)

      const partPath = dest + '.part'
      const counter = new (require('stream').Transform)({
        transform(chunk, _enc, cb) {
          received += chunk.length
          emit()
          cb(null, chunk)
        }
      })
      await pipeline(
        Readable.fromWeb(res.body),
        counter,
        fs.createWriteStream(partPath)
      )
      await fsp.rename(partPath, dest)
      emit(true)
    }
  } catch (err) {
    // 清理半成品 .part 檔
    for (const file of def.files) {
      const part = path.join(modelDir(key), file + '.part')
      await fsp.rm(part, { force: true }).catch(() => {})
    }
    if (err.name === 'AbortError') throw new Error('下載已取消')
    throw err
  } finally {
    activeDownloads.delete(key)
  }

  return status()
}

/**
 * 取消下載
 */
function cancelDownload(key) {
  const controller = activeDownloads.get(key)
  if (controller) controller.abort()
  return true
}

/**
 * 刪除模型（先取消下載，避免寫入與 rm 競態）
 */
async function remove(key) {
  if (!MODELS[key]) throw new Error(`未知的模型: ${key}`)
  if (activeDownloads.has(key)) {
    cancelDownload(key)
    // 等 download 的 finally 清掉 activeDownloads（最多等幾秒）
    const deadline = Date.now() + 15000
    while (activeDownloads.has(key) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  await fsp.rm(modelDir(key), { recursive: true, force: true })
  return status()
}

/**
 * 路徑必須落在 models 根目錄內（防 openFolder 路徑遍歷）
 * @param {string} dir
 */
function assertUnderModelsRoot(dir) {
  const root = path.resolve(modelsRoot())
  const resolved = path.resolve(dir)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('非法路徑')
  }
}

/**
 * 在檔案總管中開啟模型資料夾
 * @param {string} [key] 省略則開 models 根目錄；否則必須是 registry 內 key
 */
async function openFolder(key) {
  if (key && !MODELS[key]) throw new Error(`未知的模型: ${key}`)
  const dir = key ? modelDir(key) : modelsRoot()
  assertUnderModelsRoot(dir)
  await fsp.mkdir(dir, { recursive: true })
  await shell.openPath(dir)
  return true
}

module.exports = {
  MODELS,
  LLM_MODEL_KEYS,
  isLlmKey,
  ggufRelativePath,
  modelDir,
  isDownloaded,
  status,
  download,
  cancelDownload,
  remove,
  openFolder
}
