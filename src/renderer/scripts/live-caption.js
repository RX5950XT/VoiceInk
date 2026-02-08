/**
 * VoiceInk - 即時字幕功能
 */

import { transcribeLive } from './api.js'
import { showToast, getApiKey, getModelId } from './app.js'

// ===== Electron API Fallback =====
const electronAPI = window.electronAPI || {
  subtitle: {
    show: async () => console.log('[Dev Mode] subtitle:show'),
    hide: async () => console.log('[Dev Mode] subtitle:hide'),
    close: async () => console.log('[Dev Mode] subtitle:close'),
    update: async (text) => console.log('[Dev Mode] subtitle:update', text),
    onTextUpdate: (callback) => {}
  }
}

// ===== DOM 元素 =====
let liveLanguage
let startLiveBtn
let stopLiveBtn
let liveStatus
let statusText

// ===== 狀態 =====
let isCapturing = false
let mediaStream = null
let mediaRecorder = null
let audioChunks = []
let captureInterval = null

// 音訊分段時間（毫秒）
const CHUNK_DURATION = 4000

/**
 * 初始化即時字幕功能
 */
export function initLiveCaption() {
  // 取得 DOM 元素
  liveLanguage = document.getElementById('liveLanguage')
  startLiveBtn = document.getElementById('startLiveBtn')
  stopLiveBtn = document.getElementById('stopLiveBtn')
  liveStatus = document.getElementById('liveStatus')
  statusText = liveStatus.querySelector('.status-text')

  // 綁定事件
  startLiveBtn.addEventListener('click', startCapture)
  stopLiveBtn.addEventListener('click', stopCapture)
}

/**
 * 開始擷取系統音訊
 */
async function startCapture() {
  const apiKey = await getApiKey()
  if (!apiKey) {
    showToast('請先設定 API Key', 'error')
    return
  }

  try {
    // 請求媒體權限（透過 Electron 的 setDisplayMediaRequestHandler）
    mediaStream = await navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: {
        width: 1,
        height: 1,
        frameRate: 1
      }
    })

    // 檢查是否有音訊軌道
    const audioTracks = mediaStream.getAudioTracks()
    if (audioTracks.length === 0) {
      throw new Error('無法取得系統音訊')
    }

    // 停止視訊軌道（我們只需要音訊）
    mediaStream.getVideoTracks().forEach(track => track.stop())

    // 只保留音訊
    const audioStream = new MediaStream(audioTracks)

    isCapturing = true
    updateUI()

    // 顯示字幕視窗
    await electronAPI.subtitle.show()

    // 開始錄製
    // 取得模型 ID
    const modelId = await getModelId()

    // 開始錄製
    startRecording(audioStream, apiKey, modelId)

  } catch (error) {
    console.error('開始擷取失敗:', error)
    if (error.name === 'NotAllowedError') {
      showToast('使用者取消了權限請求', 'error')
    } else {
      showToast(`開始失敗: ${error.message}`, 'error')
    }
    stopCapture()
  }
}

/**
 * 開始錄製音訊
 * @param {MediaStream} stream 
 * @param {string} apiKey 
 * @param {string} modelId 
 */
function startRecording(stream, apiKey, modelId) {
  // 建立 MediaRecorder
  const options = { mimeType: 'audio/webm;codecs=opus' }
  
  try {
    mediaRecorder = new MediaRecorder(stream, options)
  } catch (e) {
    // 如果不支援 webm，嘗試其他格式
    mediaRecorder = new MediaRecorder(stream)
  }

  audioChunks = []

  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      audioChunks.push(event.data)
    }
  }

  mediaRecorder.onstop = async () => {
    if (audioChunks.length > 0 && isCapturing) {
      await processAudioChunk(apiKey, modelId)
    }
  }

  // 開始錄製
  mediaRecorder.start()

  // 定期分段處理
  captureInterval = setInterval(() => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop()
      audioChunks = []
      
      // 短暫延遲後重新開始錄製
      setTimeout(() => {
        if (isCapturing && mediaRecorder) {
          try {
            mediaRecorder.start()
          } catch (e) {
            console.error('重新開始錄製失敗:', e)
          }
        }
      }, 100)
    }
  }, CHUNK_DURATION)
}

/**
 * 處理音訊片段
 * @param {string} apiKey 
 * @param {string} modelId 
 */
async function processAudioChunk(apiKey, modelId) {
  if (audioChunks.length === 0) return

  try {
    // 合併音訊片段
    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' })
    
    // 轉換為 Base64
    const base64 = await blobToBase64(audioBlob)
    
    // 取得目標語言
    const targetLanguage = liveLanguage.value

    // 呼叫 API
    const text = await transcribeLive(apiKey, base64, 'webm', targetLanguage, modelId)
    
    // 更新字幕
    if (text && text.trim()) {
      await electronAPI.subtitle.update(text.trim())
    }

  } catch (error) {
    console.error('處理音訊片段失敗:', error)
    // 不顯示 toast，避免干擾使用者
  }
}

/**
 * 停止擷取
 */
async function stopCapture() {
  isCapturing = false

  // 清除定時器
  if (captureInterval) {
    clearInterval(captureInterval)
    captureInterval = null
  }

  // 停止 MediaRecorder
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try {
      mediaRecorder.stop()
    } catch (e) {
      console.error('停止錄製失敗:', e)
    }
  }
  mediaRecorder = null

  // 停止媒體串流
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop())
    mediaStream = null
  }

  // 關閉字幕視窗
  await electronAPI.subtitle.close()

  audioChunks = []
  updateUI()
}

/**
 * 更新 UI 狀態
 */
function updateUI() {
  if (isCapturing) {
    startLiveBtn.classList.add('hidden')
    stopLiveBtn.classList.remove('hidden')
    liveStatus.classList.add('active')
    statusText.textContent = '擷取中...'
  } else {
    startLiveBtn.classList.remove('hidden')
    stopLiveBtn.classList.add('hidden')
    liveStatus.classList.remove('active')
    statusText.textContent = '未啟動'
  }
}

/**
 * 將 Blob 轉換為 Base64
 * @param {Blob} blob 
 * @returns {Promise<string>}
 */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const base64 = reader.result.split(',')[1]
      resolve(base64)
    }
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}
