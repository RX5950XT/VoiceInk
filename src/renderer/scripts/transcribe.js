/**
 * VoiceInk - 檔案轉錄功能（本地 Qwen3-ASR）
 *
 * 長檔走 main 端 ffmpeg 串流切段（≥2 小時／≥100MB），
 * 不再整檔 decodeAudioData 進 renderer RAM。
 */

import { showToast, getSettings, electronAPI, cleanIpcError, ASR_MODEL_KEY, resolveTranslateModelKey } from './app.js'
import { readScope, parseAsrValue, parseLlmValue, resolveScopedCloud } from './model-picker.js'

// ===== DOM 元素 =====
let dropZone
let fileInput
let selectFileBtn
let fileInfo
let clearFileBtn
let transcribeOptions
let outputLanguage
let startTranscribeBtn
let transcribeProgress
let progressBar
let progressFill
let progressText
let progressPercent
let transcribeResult
let resultText
let copyResultBtn
let saveResultBtn

// ===== 狀態 =====
let selectedFile = null
/** 重入鎖：避免連點開始轉錄導致雙重 release 卸載進行中模型 */
let isTranscribing = false
/** 清除檔案／重開時作廢未完成的 UI 更新 */
let transcribeEpoch = 0
/** @type {null | (() => void)} */
let unsubFileProgress = null

/**
 * 支援的音訊格式
 */
const SUPPORTED_FORMATS = ['mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac', 'wma', 'aiff', 'aif']

/** 原始檔案上限（與 main file-transcribe 對齊；保證 ≥100MB） */
const MAX_FILE_BYTES = 200 * 1024 * 1024

/**
 * 等瀏覽器畫完一幀（隱藏選項／顯示進度後必須，否則 main 忙載模型時看起來像黑屏）
 *
 * **一定要有逾時**：視窗被遮住或縮到系統匣時 `requestAnimationFrame` 根本不會觸發，
 * 沒有逾時的話整條轉錄流程就永遠卡在「準備中… 1%」（CDP 實測：`document.hidden` 為 true
 * 時 rAF 3 秒內完全沒回呼）。畫面只是好看，卡住的是使用者的工作。
 * @returns {Promise<void>}
 */
function waitForPaint() {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(done, 200)
    requestAnimationFrame(() => requestAnimationFrame(done))
  })
}

/**
 * 初始化檔案轉錄功能
 */
export function initTranscribe() {
  dropZone = document.getElementById('dropZone')
  fileInput = document.getElementById('fileInput')
  selectFileBtn = document.getElementById('selectFileBtn')
  fileInfo = document.getElementById('fileInfo')
  clearFileBtn = document.getElementById('clearFileBtn')
  transcribeOptions = document.getElementById('transcribeOptions')
  outputLanguage = document.getElementById('outputLanguage')
  startTranscribeBtn = document.getElementById('startTranscribeBtn')
  transcribeProgress = document.getElementById('transcribeProgress')
  // 限定在進度面板內，避免日後其他 .progress-fill 搶到
  progressBar = transcribeProgress.querySelector('.progress-bar')
  progressFill = transcribeProgress.querySelector('.progress-fill')
  progressText = transcribeProgress.querySelector('.progress-text')
  progressPercent = transcribeProgress.querySelector('.progress-percent')
  transcribeResult = document.getElementById('transcribeResult')
  resultText = document.getElementById('resultText')
  copyResultBtn = document.getElementById('copyResultBtn')
  saveResultBtn = document.getElementById('saveResultBtn')

  setupDragAndDrop()
  setupFileSelection()
  setupTranscription()
  setupResultActions()
}

/**
 * 設定拖放功能
 */
function setupDragAndDrop() {
  ;['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault()
      e.stopPropagation()
    })
  })

  ;['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, () => {
      dropZone.classList.add('dragover')
    })
  })

  ;['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, () => {
      dropZone.classList.remove('dragover')
    })
  })

  dropZone.addEventListener('drop', handleFileDrop)

  dropZone.addEventListener('click', (e) => {
    if (e.target === dropZone || e.target.closest('.drop-zone-content')) {
      if (!e.target.closest('button')) {
        fileInput.click()
      }
    }
  })
}

/**
 * 設定檔案選擇功能
 */
function setupFileSelection() {
  selectFileBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    fileInput.click()
  })

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleFileSelect(e.target.files[0])
    }
  })

  clearFileBtn.addEventListener('click', clearFile)
}

/**
 * 處理拖放的檔案
 * @param {DragEvent} e
 */
function handleFileDrop(e) {
  const files = e.dataTransfer.files
  if (files.length > 0) {
    handleFileSelect(files[0])
  }
}

/**
 * 處理選擇的檔案
 * @param {File} file
 */
function handleFileSelect(file) {
  const extension = file.name.split('.').pop().toLowerCase()
  if (!SUPPORTED_FORMATS.includes(extension)) {
    showToast(`不支援的格式: ${extension}`, 'error')
    return
  }

  if (file.size > MAX_FILE_BYTES) {
    showToast(
      `檔案過大（${formatFileSize(file.size)}），上限 ${formatFileSize(MAX_FILE_BYTES)}`,
      'error'
    )
    return
  }

  selectedFile = file

  const fileName = fileInfo.querySelector('.file-name')
  const fileSize = fileInfo.querySelector('.file-size')

  fileName.textContent = file.name
  fileName.title = file.name
  fileSize.textContent = formatFileSize(file.size)

  dropZone.classList.add('hidden')
  fileInfo.classList.remove('hidden')
  transcribeOptions.classList.remove('hidden')
  transcribeResult.classList.add('hidden')
}

/**
 * 清除選擇的檔案
 */
function clearFile() {
  if (isTranscribing) return
  selectedFile = null
  fileInput.value = ''
  transcribeEpoch++
  electronAPI.localAsr.cancelFileTranscribe?.().catch(() => {})

  dropZone.classList.remove('hidden')
  fileInfo.classList.add('hidden')
  transcribeOptions.classList.add('hidden')
  transcribeProgress.classList.add('hidden')
  transcribeResult.classList.add('hidden')
}

/**
 * 格式化檔案大小
 * @param {number} bytes
 * @returns {string}
 */
function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

/**
 * 設定轉錄功能
 */
function setupTranscription() {
  startTranscribeBtn.addEventListener('click', startTranscription)
}

/**
 * 解析本機絕對路徑
 * @param {File} file
 * @returns {string}
 */
function resolveLocalPath(file) {
  if (!file) return ''
  if (typeof electronAPI.getPathForFile === 'function') {
    const p = electronAPI.getPathForFile(file)
    if (p) return p
  }
  // 舊 Electron 後援
  if (typeof file.path === 'string' && file.path) return file.path
  return ''
}

/**
 * 訂閱 main 端串流進度
 * @param {number} epoch
 */
function subscribeFileProgress(epoch) {
  unsubscribeFileProgress()
  if (typeof electronAPI.localAsr.onFileProgress !== 'function') return
  unsubFileProgress = electronAPI.localAsr.onFileProgress((p) => {
    if (epoch !== transcribeEpoch || !p) return
    // main 回報 0–88；翻譯階段 renderer 接 90–100
    const pct = typeof p.percent === 'number' ? Math.min(88, p.percent) : 10
    updateProgress(pct, p.text || '轉錄中…')
  })
}

function unsubscribeFileProgress() {
  if (typeof unsubFileProgress === 'function') {
    try { unsubFileProgress() } catch { /* ignore */ }
  }
  unsubFileProgress = null
}

/**
 * 開始轉錄
 */
async function startTranscription() {
  if (!selectedFile || isTranscribing) {
    if (!selectedFile) showToast('請先選擇檔案', 'error')
    return
  }

  if (selectedFile.size > MAX_FILE_BYTES) {
    showToast(
      `檔案過大（${formatFileSize(selectedFile.size)}），上限 ${formatFileSize(MAX_FILE_BYTES)}`,
      'error'
    )
    return
  }

  const filePath = resolveLocalPath(selectedFile)
  if (!filePath) {
    showToast('無法取得檔案路徑，請改用「選擇檔案」從本機選取', 'error')
    return
  }

  isTranscribing = true
  startTranscribeBtn.disabled = true
  clearFileBtn.disabled = true
  const epoch = ++transcribeEpoch

  // 立刻切到進度 UI 並等一幀，避免 await 載模型時畫面還停在空白深色區
  transcribeOptions.classList.add('hidden')
  transcribeResult.classList.add('hidden')
  transcribeProgress.classList.remove('hidden')
  updateProgress(1, '準備中…')
  await waitForPaint()

  let acquired = false
  subscribeFileProgress(epoch)

  try {
    if (epoch !== transcribeEpoch) return

    updateProgress(2, '讀取設定…')
    const settings = await getSettings()
    const status = await electronAPI.models.status()
    // 這一頁自己的模型選擇（即時字幕與語音輸入各有各的）
    const scope = await readScope('file')
    const asrChoice = parseAsrValue(scope.asr)
    const llmChoice = parseLlmValue(scope.llm)
    const useCloudAsr = asrChoice.engine === 'cloud'

    if (!useCloudAsr) {
      const asrKey = asrChoice.modelKey || ASR_MODEL_KEY
      const asrDef = status.models?.[asrKey]
      if (!asrDef?.downloaded) {
        throw new Error(`本地語音模型（${asrDef?.label || asrKey}）尚未下載，請到設定 → 本地模型下載`)
      }
      // GPU 那顆要搭 llama.cpp 執行環境，缺了會在 warm 才失敗，這裡先講清楚
      if (asrDef.requires && !status.models?.[asrDef.requires]?.downloaded) {
        const runtimeLabel = status.models?.[asrDef.requires]?.label || asrDef.requires
        throw new Error(`還缺「${runtimeLabel}」，請到設定 → 本地模型下載`)
      }
    }
    if (useCloudAsr && !settings.asrApiKey) {
      throw new Error('雲端語音轉文字需要 API Key，請到設定填寫')
    }

    const language = outputLanguage.value
    const willTranslate = language !== 'auto'
    if (willTranslate && llmChoice.mode === 'local') {
      const llmKey = resolveTranslateModelKey({ localTranslateModel: llmChoice.modelKey }, status.models)
      if (!status.models?.[llmKey]?.downloaded) {
        throw new Error('本地翻譯模型尚未下載，請先到設定下載')
      }
    }
    if (willTranslate && llmChoice.mode === 'cloud' && !resolveScopedCloud(settings, scope.llm).ready) {
      throw new Error('雲端翻譯還沒選好供應商與模型，請在這一頁的「翻譯模型」挑一顆')
    }

    // 本地：先載 ASR；雲端 ASR 不載 sherpa（串流過程長，LLM 等 ASR 完再載）
    if (useCloudAsr) {
      updateProgress(8, '準備雲端轉錄…')
      await waitForPaint()
      const warm = await electronAPI.engine.acquire('file', { asr: false, llm: false })
      // 雲端可無模型；仍佔 owner 以便之後補 LLM
      if (!warm.ok && warm.asrLoaded === false && warm.llmLoaded === false) {
        // ok 在 asr/llm 皆不需時應為 true
      }
      acquired = true
    } else {
      updateProgress(8, '載入 ASR 模型…')
      await waitForPaint()
      const warmAsr = await electronAPI.engine.acquire('file', { asr: true, llm: false })
      if (!warmAsr.ok) {
        throw new Error((warmAsr.warnings && warmAsr.warnings[0]) || 'ASR 模型載入失敗')
      }
      acquired = true
    }
    if (epoch !== transcribeEpoch) return

    updateProgress(10, useCloudAsr ? '正在雲端轉錄…' : '正在解碼並轉錄…')
    await waitForPaint()

    // 模型由 main 讀 store 決定（這一頁的 `fileAsr`），renderer 不指定
    const asrResult = await electronAPI.localAsr.transcribeFile({
      filePath,
      lang: language
    })
    if (epoch !== transcribeEpoch) return

    let result = (asrResult && asrResult.text) || ''

    if (result && willTranslate) {
      if (llmChoice.mode === 'local') {
        updateProgress(90, '載入翻譯模型…')
        await waitForPaint()
        const warmLlm = await electronAPI.engine.acquire('file', {
          asr: !useCloudAsr,
          llm: true
        })
        if (!warmLlm.ok) {
          throw new Error((warmLlm.warnings && warmLlm.warnings[0]) || '翻譯模型載入失敗')
        }
      }
      updateProgress(92, '正在翻譯…')
      result = await translateLong(result, language)
    }

    if (epoch !== transcribeEpoch) return

    updateProgress(100, '轉錄完成！')
    await new Promise((r) => setTimeout(r, 350))
    if (epoch !== transcribeEpoch) return
    transcribeProgress.classList.add('hidden')
    transcribeResult.classList.remove('hidden')
    resultText.textContent = result || '（未辨識到語音內容）'
  } catch (error) {
    console.error('轉錄失敗:', error)
    if (epoch === transcribeEpoch) {
      const msg = cleanIpcError(error)
      // 取消不噴錯誤 toast
      if (!/取消|cancel/i.test(msg)) {
        showToast(`轉錄失敗: ${msg}`, 'error')
      }
      transcribeProgress.classList.add('hidden')
      transcribeOptions.classList.remove('hidden')
    }
  } finally {
    unsubscribeFileProgress()
    if (acquired) {
      await electronAPI.engine.release('file').catch(() => {})
    }
    isTranscribing = false
    startTranscribeBtn.disabled = false
    clearFileBtn.disabled = false
  }
}

/**
 * 長文翻譯：按行分組（每組 ≤1200 字）逐組翻譯
 */
async function translateLong(text, targetLang) {
  const groups = []
  let current = ''
  for (const line of text.split('\n')) {
    if (current && current.length + line.length > 1200) {
      groups.push(current)
      current = ''
    }
    current += (current ? '\n' : '') + line
  }
  if (current) groups.push(current)

  const results = []
  let prevSrc = ''
  let prevTr = ''
  const total = groups.length
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]
    if (total > 1) {
      updateProgress(92 + ((i + 1) / total) * 6, `正在翻譯… (${i + 1}/${total})`)
    }
    const translated = await electronAPI.translate(group, targetLang, {
      previousSource: prevSrc,
      previousTranslation: prevTr,
      mode: 'file',
      scope: 'file'
    })
    results.push(translated)
    // 下一組前文：僅在有非 identity 譯文時延續（與 live buildContextPair 一致）
    if (translated && translated.trim() !== group.trim()) {
      prevSrc = group
      prevTr = translated
    }
  }
  return results.join('\n')
}

/**
 * 更新進度
 * @param {number} percent
 * @param {string} text
 */
function updateProgress(percent, text) {
  const p = Math.max(0, Math.min(100, Math.round(percent)))
  if (progressFill) progressFill.style.width = p + '%'
  if (progressBar) progressBar.setAttribute('aria-valuenow', String(p))
  if (progressText) progressText.textContent = text
  if (progressPercent) progressPercent.textContent = p + '%'
}

/**
 * 設定結果操作
 */
function setupResultActions() {
  copyResultBtn.addEventListener('click', copyResult)
  saveResultBtn.addEventListener('click', saveResult)
}

/**
 * 複製結果
 */
async function copyResult() {
  try {
    await navigator.clipboard.writeText(resultText.textContent)
    showToast('已複製轉錄結果')
  } catch {
    showToast('複製失敗', 'error')
  }
}

/**
 * 儲存結果
 */
function saveResult() {
  const text = resultText.textContent
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)

  const a = document.createElement('a')
  a.href = url
  a.download = `${selectedFile?.name || 'transcription'}_逐字稿.txt`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
