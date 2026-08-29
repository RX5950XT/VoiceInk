/**
 * VoiceInk - 本地模型下載與管理（Main Process）
 */

const { app, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')
const { Readable } = require('stream')
const { pipeline } = require('stream/promises')
const { spawn } = require('child_process')

/**
 * llama.cpp 執行環境版本（pin 住，不抓 latest：換版本要人看過 release note）
 * Windows Vulkan 版是自帶 CPU backend DLL 的完整包，任何有現代顯卡驅動的機器都能跑，
 * 不需要 CUDA／cuDNN。CUDA 版另外要 239MB＋373MB cudart，先不做第二套。
 */
const LLAMA_BUILD = 'b10666'

/**
 * 模型 registry
 * files 為相對於模型資料夾的路徑，自 base URL 直接下載（免解壓）
 * archive: true 表示下載到的是 zip，下載後解壓到模型資料夾根層
 * check: 有值時以「這些檔案都在」判定已安裝（archive 解壓後檔名跟下載名不同）
 */
const MODELS = {
  qwen3asr: {
    label: 'Qwen3-ASR 0.6B · INT8（CPU）',
    kind: 'asr',
    /** sherpa-onnx，只有 CPU；即時字幕的預設 */
    runtime: 'sherpa',
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
  /** 大顆的那個：走 llama-server（Vulkan GPU），需要 llamaruntime 一起裝 */
  qwen3asrgpu: {
    label: 'Qwen3-ASR 1.7B · Q8_0（GPU）',
    kind: 'asr',
    runtime: 'llama',
    totalBytes: 2520744288,
    base: 'https://huggingface.co/ggml-org/Qwen3-ASR-1.7B-GGUF/resolve/main/',
    files: ['Qwen3-ASR-1.7B-Q8_0.gguf', 'mmproj-Qwen3-ASR-1.7B-Q8_0.gguf'],
    gguf: 'Qwen3-ASR-1.7B-Q8_0.gguf',
    mmproj: 'mmproj-Qwen3-ASR-1.7B-Q8_0.gguf',
    requires: 'llamaruntime'
  },
  /** GPU ASR 的執行檔（llama-server）；zip 內是扁平結構，解壓即用 */
  llamaruntime: {
    label: `llama.cpp 執行環境 · Vulkan（${LLAMA_BUILD}）`,
    kind: 'runtime',
    totalBytes: 34478547,
    base: `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/`,
    files: [`llama-${LLAMA_BUILD}-bin-win-vulkan-x64.zip`],
    archive: true,
    check: ['llama-server.exe', 'ggml-vulkan.dll', 'mtmd.dll'],
    binary: 'llama-server.exe'
  },
  /** 微調：繁中／英文／日文三語翻譯（v5e Q4_K_M） */
  linguaforge08q4: {
    label: 'LinguaForge 0.8B · Q4_K_M（繁中/英/日）',
    kind: 'llm',
    totalBytes: 529296832,
    base: 'https://huggingface.co/RX5950XT/LinguaForge-Qwen3.5-0.8B-zhTW-en-ja/resolve/main/',
    files: ['gguf-v5e/linguaforge-v5e-0.8b-Q4_K_M.gguf'],
    gguf: 'gguf-v5e/linguaforge-v5e-0.8b-Q4_K_M.gguf'
  },
  qwen35translate: {
    label: 'Qwen3.5 0.8B · Q4_K_M（通用）',
    kind: 'llm',
    totalBytes: 532517120,
    base: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/',
    files: ['Qwen3.5-0.8B-Q4_K_M.gguf'],
    gguf: 'Qwen3.5-0.8B-Q4_K_M.gguf'
  },
  /** 同家族的大顆：CPU 也跑得動但很慢，建議搭 GPU 推論 */
  qwen354b: {
    label: 'Qwen3.5 4B · Q4_K_M（通用・建議 GPU）',
    kind: 'llm',
    totalBytes: 2740937888,
    base: 'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/',
    files: ['Qwen3.5-4B-Q4_K_M.gguf'],
    gguf: 'Qwen3.5-4B-Q4_K_M.gguf'
  }
}

/** 本地翻譯模型 key 白名單（順序：推薦在前） */
const LLM_MODEL_KEYS = ['linguaforge08q4', 'qwen35translate', 'qwen354b']

/** 本地 ASR 模型 key 白名單（順序：推薦在前） */
const ASR_MODEL_KEYS = ['qwen3asr', 'qwen3asrgpu']

/**
 * @param {unknown} key
 * @returns {boolean}
 */
function isLlmKey(key) {
  return typeof key === 'string' && LLM_MODEL_KEYS.includes(key)
}

/**
 * @param {unknown} key
 * @returns {boolean}
 */
function isAsrKey(key) {
  return typeof key === 'string' && ASR_MODEL_KEYS.includes(key)
}

/**
 * GGUF 相對路徑（相對 modelDir）
 * @param {string} key
 * @returns {string | null}
 */
function ggufRelativePath(key) {
  const def = MODELS[key]
  if (!def || !def.gguf) return null
  return def.gguf
}

/**
 * 檔案絕對路徑（modelDir + registry 內的相對路徑欄位）
 * @param {string} key
 * @param {'gguf'|'mmproj'|'binary'} field
 * @returns {string | null}
 */
function filePath(key, field) {
  const rel = MODELS[key]?.[field]
  return typeof rel === 'string' && rel ? path.join(modelDir(key), rel) : null
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
 * 模型是否已完整下載
 * archive 型別解壓後的檔名跟下載名不同，所以判定看 `check` 而不是 `files`
 */
function isDownloaded(key) {
  const def = MODELS[key]
  if (!def) return false
  const want = def.check || def.files
  return want.every(f => fs.existsSync(path.join(modelDir(key), f)))
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
      requires: def.requires || null,
      downloaded: isDownloaded(key),
      downloading: activeDownloads.has(key)
    }
  }
  return { models: result, root: modelsRoot() }
}

/**
 * PowerShell 單引號字串裡的 `'` 要寫成 `''`（使用者名稱含單引號時路徑會帶進來）
 * @param {string} s
 * @returns {string}
 */
function psQuote(s) {
  return s.replace(/'/g, "''")
}

/**
 * 解壓 zip 到模型資料夾根層，成功後刪掉 zip。
 * 用 PowerShell 的 Expand-Archive：Windows 內建，不必為了一次解壓加一個依賴。
 * @param {string} zipPath
 * @param {string} destDir
 * @returns {Promise<void>}
 */
function expandArchive(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-Command',
        `Expand-Archive -LiteralPath '${psQuote(zipPath)}' -DestinationPath '${psQuote(destDir)}' -Force`
      ],
      { windowsHide: true, stdio: 'ignore' }
    )
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`解壓失敗（結束碼 ${code}）`))
    })
  })
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

    if (def.archive) {
      onProgress({ key, receivedBytes: def.totalBytes, totalBytes: def.totalBytes, stage: '解壓中…' })
      for (const file of def.files) {
        const zipPath = path.join(modelDir(key), file)
        await expandArchive(zipPath, modelDir(key))
        await fsp.rm(zipPath, { force: true })
      }
      if (!isDownloaded(key)) throw new Error('解壓完成但缺少必要檔案')
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
  ASR_MODEL_KEYS,
  LLAMA_BUILD,
  isLlmKey,
  isAsrKey,
  ggufRelativePath,
  filePath,
  modelDir,
  isDownloaded,
  status,
  download,
  cancelDownload,
  remove,
  openFolder
}
