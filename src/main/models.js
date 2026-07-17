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
    label: 'Qwen3.5-0.8B（本地翻譯）',
    kind: 'llm',
    totalBytes: 532517120,
    base: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/',
    files: ['Qwen3.5-0.8B-Q4_K_M.gguf']
  }
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
 * 刪除模型
 */
async function remove(key) {
  if (!MODELS[key]) throw new Error(`未知的模型: ${key}`)
  await fsp.rm(modelDir(key), { recursive: true, force: true })
  return status()
}

/**
 * 在檔案總管中開啟模型資料夾
 */
async function openFolder(key) {
  const dir = key ? modelDir(key) : modelsRoot()
  await fsp.mkdir(dir, { recursive: true })
  await shell.openPath(dir)
  return true
}

module.exports = { MODELS, modelDir, isDownloaded, status, download, cancelDownload, remove, openFolder }
