/**
 * VoiceInk - 檔案轉錄功能（本地 Qwen3-ASR）
 */

import { showToast, getSettings, electronAPI, cleanIpcError, ASR_MODEL_KEY } from './app.js'
import { resampleTo16kMono } from './live-caption.js'

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
let progressFill
let progressText
let transcribeResult
let resultText
let copyResultBtn
let saveResultBtn

// ===== 狀態 =====
let selectedFile = null

/**
 * 支援的音訊格式
 */
const SUPPORTED_FORMATS = ['mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac', 'wma', 'aiff']

// 本地轉錄的每段長度（秒）
const LOCAL_CHUNK_SECONDS = 28

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
  progressFill = document.querySelector('.progress-fill')
  progressText = document.querySelector('.progress-text')
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

  selectedFile = file

  const fileName = fileInfo.querySelector('.file-name')
  const fileSize = fileInfo.querySelector('.file-size')

  fileName.textContent = file.name
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
  selectedFile = null
  fileInput.value = ''

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
 * 開始轉錄
 */
async function startTranscription() {
  if (!selectedFile) {
    showToast('請先選擇檔案', 'error')
    return
  }

  const settings = await getSettings()
  const status = await electronAPI.models.status()
  if (!status.models[ASR_MODEL_KEY]?.downloaded) {
    showToast('本地 ASR 模型尚未下載，請先到設定下載', 'error')
    return
  }

  transcribeOptions.classList.add('hidden')
  transcribeProgress.classList.remove('hidden')
  transcribeResult.classList.add('hidden')

  try {
    const language = outputLanguage.value
    const result = await transcribeLocal(settings, language)

    updateProgress(100, '轉錄完成！')

    setTimeout(() => {
      transcribeProgress.classList.add('hidden')
      transcribeResult.classList.remove('hidden')
      resultText.textContent = result
    }, 500)
  } catch (error) {
    console.error('轉錄失敗:', error)
    showToast(`轉錄失敗: ${cleanIpcError(error)}`, 'error')
    transcribeProgress.classList.add('hidden')
    transcribeOptions.classList.remove('hidden')
  }
}

/**
 * 本地轉錄：解碼 → 16k 單聲道 → 28 秒切段逐段轉錄 → 依設定翻譯
 */
async function transcribeLocal(settings, language) {
  updateProgress(5, '正在解碼音訊...')
  const audioContext = new AudioContext()
  let audioBuffer
  try {
    audioBuffer = await audioContext.decodeAudioData(await selectedFile.arrayBuffer())
  } finally {
    audioContext.close()
  }

  updateProgress(10, '正在重採樣...')
  const samples = await resampleTo16kMono(audioBuffer)

  const chunkSize = LOCAL_CHUNK_SECONDS * 16000
  const chunkCount = Math.max(1, Math.ceil(samples.length / chunkSize))
  const parts = []

  for (let i = 0; i < chunkCount; i++) {
    const chunk = samples.subarray(i * chunkSize, (i + 1) * chunkSize)
    const text = await electronAPI.localAsr.transcribe({
      samples: new Float32Array(chunk),
      sampleRate: 16000,
      lang: language,
      modelKey: ASR_MODEL_KEY
    })
    if (text) parts.push(text)
    updateProgress(10 + ((i + 1) / chunkCount) * 75, `正在轉錄中... (${i + 1}/${chunkCount})`)
  }

  let result = parts.join('\n')

  // 翻譯（本地 ASR 僅原文轉錄）
  if (result && settings.translator !== 'none' && language !== 'auto') {
    updateProgress(88, '正在翻譯...')
    result = await translateLong(result, language)
  }
  return result
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
  for (const group of groups) {
    results.push(await electronAPI.translate(group, targetLang))
  }
  return results.join('\n')
}

/**
 * 更新進度
 * @param {number} percent
 * @param {string} text
 */
function updateProgress(percent, text) {
  progressFill.style.width = percent + '%'
  progressText.textContent = text
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
    showToast('已複製到剪貼簿', 'success')
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

  showToast('已儲存檔案', 'success')
}
