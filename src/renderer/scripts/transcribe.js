/**
 * VoiceInk - 檔案轉錄功能
 */

import { transcribeAudio } from './api.js'
import { showToast, getApiKey, getModelId } from './app.js'

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

/**
 * 初始化檔案轉錄功能
 */
export function initTranscribe() {
  // 取得 DOM 元素
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

  // 綁定事件
  setupDragAndDrop()
  setupFileSelection()
  setupTranscription()
  setupResultActions()
}

/**
 * 設定拖放功能
 */
function setupDragAndDrop() {
  // 防止瀏覽器預設行為
  ;['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault()
      e.stopPropagation()
    })
  })

  // 拖曳視覺效果
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

  // 處理放下檔案
  dropZone.addEventListener('drop', handleFileDrop)

  // 點擊拖放區域也可選檔
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
  // 檢查格式
  const extension = file.name.split('.').pop().toLowerCase()
  if (!SUPPORTED_FORMATS.includes(extension)) {
    showToast(`不支援的格式: ${extension}`, 'error')
    return
  }

  selectedFile = file

  // 更新 UI
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

  const apiKey = await getApiKey()
  if (!apiKey) {
    showToast('請先設定 API Key', 'error')
    return
  }

  const modelId = await getModelId()

  // 顯示進度
  transcribeOptions.classList.add('hidden')
  transcribeProgress.classList.remove('hidden')
  transcribeResult.classList.add('hidden')
  
  updateProgress(10, '正在讀取檔案...')

  try {
    // 讀取檔案為 Base64
    const audioBase64 = await fileToBase64(selectedFile)
    updateProgress(30, '正在上傳至 AI...')

    // 取得格式
    const format = selectedFile.name.split('.').pop().toLowerCase()
    const language = outputLanguage.value

    // 呼叫 API
    updateProgress(50, '正在轉錄中...')
    
    const result = await transcribeAudio(apiKey, audioBase64, format, language, modelId)
    
    updateProgress(100, '轉錄完成！')
    
    // 顯示結果
    setTimeout(() => {
      transcribeProgress.classList.add('hidden')
      transcribeResult.classList.remove('hidden')
      resultText.textContent = result
    }, 500)

  } catch (error) {
    console.error('轉錄失敗:', error)
    showToast(`轉錄失敗: ${error.message}`, 'error')
    transcribeProgress.classList.add('hidden')
    transcribeOptions.classList.remove('hidden')
  }
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
 * 將檔案轉換為 Base64
 * @param {File} file 
 * @returns {Promise<string>}
 */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      // 移除 data URL 前綴，只保留 Base64 部分
      const base64 = reader.result.split(',')[1]
      resolve(base64)
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
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
  } catch (error) {
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
