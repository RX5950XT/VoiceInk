/**
 * VoiceInk - 即時字幕功能
 */

import { transcribeLive, transcribeLiveWithContext } from './api.js'
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
let isProcessing = false // 防止重複請求

// 歷史轉錄記錄（用於上下文連貫）
let transcriptHistory = []
// 最大保留的歷史記錄數量（避免 token 過多）
const MAX_HISTORY_COUNT = 10

// 音訊分段時間（毫秒）- 3 秒以避免 API 請求過於頻繁
const CHUNK_DURATION = 3000

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

  // 監聽字幕視窗關閉事件（從懸浮視窗的關閉按鈕觸發）
  electronAPI.subtitle.onClosed(() => {
    // 只有在擷取中時才需要停止
    if (isCapturing) {
      stopCaptureFromSubtitle()
    }
  })
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
  // 每次錄製都使用完整的 MediaRecorder 實例，確保 WebM header 完整
  function startNewRecording() {
    if (!isCapturing || !stream) return
    
    const options = { mimeType: 'audio/webm;codecs=opus' }
    
    try {
      mediaRecorder = new MediaRecorder(stream, options)
    } catch (e) {
      mediaRecorder = new MediaRecorder(stream)
    }
    
    const chunks = []
    
    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data)
      }
    }
    
    mediaRecorder.onstop = () => {
      // 異步處理音訊（不阻塞下一次錄製）
      if (chunks.length > 0 && isCapturing) {
        processAudioChunkData(chunks, apiKey, modelId).catch(e => {
          console.error('處理音訊失敗:', e)
        })
      }
      
      // 如果還在擷取，開始下一輪錄製
      if (isCapturing) {
        startNewRecording()
      }
    }
    
    // 開始錄製（不使用 timeslice，確保產生完整的 WebM）
    mediaRecorder.start()
    
    // 設定在 CHUNK_DURATION 後停止
    setTimeout(() => {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop()
      }
    }, CHUNK_DURATION)
  }
  
  // 開始第一輪錄製
  startNewRecording()
}

/**
 * 處理音訊片段
 * @param {Blob[]} chunks - 當前音訊片段陣列
 * @param {string} apiKey 
 * @param {string} modelId 
 */
async function processAudioChunkData(chunks, apiKey, modelId) {
  if (chunks.length === 0) return
  
  // 如果正在處理中，跳過此片段以避免請求過於頻繁
  if (isProcessing) return
  isProcessing = true

  try {
    // 只使用當前完整的 chunks（不合併前一片段，因為 WebM 需要完整檔案頭）
    const webmBlob = new Blob(chunks, { type: 'audio/webm' })
    
    // 如果音訊太小，跳過
    if (webmBlob.size < 1000) {
      isProcessing = false
      return
    }
    
    // 將 WebM 轉換為 WAV 格式（包含音量檢測，靜音時返回 null）
    let wavBlob
    try {
      wavBlob = await webmToWav(webmBlob)
    } catch (e) {
      // 格式轉換失敗，跳過此片段
      isProcessing = false
      return
    }
    
    // 如果是靜音片段，跳過 API 呼叫
    if (!wavBlob) {
      isProcessing = false
      return
    }
    
    // 轉換為 Base64
    const base64 = await blobToBase64(wavBlob)
    
    // 取得目標語言
    const targetLanguage = liveLanguage.value

    // 呼叫 API，傳入完整歷史作為上下文
    const historyText = transcriptHistory.join(' ')
    const text = await transcribeLiveWithContext(
      apiKey, 
      base64, 
      'wav', 
      targetLanguage, 
      modelId,
      historyText
    )
    
    // 更新字幕
    if (text && text.trim()) {
      // 移除與前一句明顯重複的部分
      const lastTranscript = transcriptHistory.length > 0 
        ? transcriptHistory[transcriptHistory.length - 1] 
        : ''
      let cleanedText = removeOverlappingText(lastTranscript, text.trim())
      
      // 過濾 AI 無中生有的輸出
      cleanedText = filterInvalidOutput(cleanedText)
      
      if (cleanedText) {
        await electronAPI.subtitle.update(cleanedText)
        // 累積到歷史記錄
        transcriptHistory.push(cleanedText)
        // 限制歷史記錄數量
        if (transcriptHistory.length > MAX_HISTORY_COUNT) {
          transcriptHistory.shift()
        }
      }
    }

  } catch (error) {
    console.error('處理音訊片段失敗:', error)
  } finally {
    isProcessing = false
  }
}

/**
 * 移除與前一句重複的文字
 * @param {string} previous - 前一句轉錄
 * @param {string} current - 當前轉錄
 * @returns {string} 清理後的文字
 */
function removeOverlappingText(previous, current) {
  if (!previous || !current) return current
  
  // 嘗試找出重疊部分
  // 從前一句的後半部開始比對
  const prevWords = previous.split('')
  const currWords = current.split('')
  
  // 嘗試不同長度的重疊
  for (let overlapLen = Math.min(prevWords.length, 20); overlapLen >= 3; overlapLen--) {
    const prevEnd = prevWords.slice(-overlapLen).join('')
    if (current.startsWith(prevEnd)) {
      return current.slice(prevEnd.length).trim()
    }
  }
  
  // 如果當前文字完全包含在前一句中，可能是重複的
  if (previous.includes(current)) {
    return ''
  }
  
  return current
}

/**
 * 過濾 AI 無中生有的無效輸出
 * @param {string} text - AI 回應的文字
 * @returns {string} 過濾後的文字（無效則返回空字串）
 */
function filterInvalidOutput(text) {
  if (!text) return ''
  
  const trimmed = text.trim()
  
  // 長度異常檢測：3 秒內正常說話約 20-40 字，超過 60 字很可能是編造
  const MAX_CHARS_PER_CHUNK = 60
  if (trimmed.length > MAX_CHARS_PER_CHUNK) {
    console.log('[過濾] 輸出過長，可能是編造:', trimmed.length, '字')
    return ''
  }
  
  // 常見的 AI 編造模式
  const INVALID_PATTERNS = [
    /^謝謝(大家|觀看|收看|收聽)/,
    /^感謝(大家|觀看|收看|收聽)/,
    /^歡迎(訂閱|關注|按讚)/,
    /^(請|記得)(訂閱|關注|按讚)/,
    /^字幕(由|製作)/,
    /^本(影片|節目|視頻)/,
    /^(下集|下期|下次)再見/,
    /^(再見|拜拜|掰掰)$/,
    /^。+$/,  // 只有句號
    /^\.+$/,  // 只有點
    /^…+$/,  // 只有省略號
  ]
  
  // 檢查是否符合無效模式
  for (const pattern of INVALID_PATTERNS) {
    if (pattern.test(trimmed)) {
      console.log('[過濾] 偵測到無效輸出:', trimmed)
      return ''
    }
  }
  
  return trimmed
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
  
  // 清除狀態
  transcriptHistory = []
  isProcessing = false

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
 * 從字幕視窗關閉時停止擷取
 * 這個函式由 onClosed 事件呼叫，不需要再關閉字幕視窗
 */
function stopCaptureFromSubtitle() {
  isCapturing = false

  // 清除定時器
  if (captureInterval) {
    clearInterval(captureInterval)
    captureInterval = null
  }
  
  // 清除狀態
  transcriptHistory = []
  isProcessing = false

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

  // 不需要再關閉字幕視窗，因為已經由那邊關閉了

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

/**
 * 將 WebM 音訊轉換為 WAV 格式
 * @param {Blob} webmBlob - WebM 格式的音訊 Blob
 * @returns {Promise<Blob|null>} WAV 格式的音訊 Blob，如果音量太低則返回 null
 */
async function webmToWav(webmBlob) {
  // 建立 AudioContext
  const audioContext = new (window.AudioContext || window.webkitAudioContext)()
  
  try {
    // 將 Blob 轉換為 ArrayBuffer
    const arrayBuffer = await webmBlob.arrayBuffer()
    
    // 解碼音訊資料
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer)
    
    // 分析音訊 - 計算 RMS 和語音活動佔比
    const { rms, speechRatio } = analyzeAudio(audioBuffer)
    
    // 靜音或語音活動太少則跳過
    // RMS 閾值：0.025（整體音量，提高以過濾低音量雜訊）
    // 語音佔比閾值：0.12（至少 12% 的採樣超過語音門檻）
    const RMS_THRESHOLD = 0.025
    const SPEECH_RATIO_THRESHOLD = 0.12
    
    if (rms < RMS_THRESHOLD || speechRatio < SPEECH_RATIO_THRESHOLD) {
      // 音量太低或語音活動太少，視為靜音
      return null
    }
    
    // 編碼為 WAV
    const wavBuffer = encodeWav(audioBuffer)
    
    return new Blob([wavBuffer], { type: 'audio/wav' })
  } finally {
    audioContext.close()
  }
}

/**
 * 計算 AudioBuffer 的 RMS（均方根）音量和語音活動
 * @param {AudioBuffer} audioBuffer 
 * @returns {{rms: number, speechRatio: number}} RMS 音量值和語音活動佔比
 */
function analyzeAudio(audioBuffer) {
  const channelData = audioBuffer.getChannelData(0) // 使用第一個聲道
  let sumSquares = 0
  let speechSamples = 0
  const SPEECH_THRESHOLD = 0.02 // 單一樣本的語音門檻
  
  for (let i = 0; i < channelData.length; i++) {
    const sample = Math.abs(channelData[i])
    sumSquares += sample * sample
    
    // 計算語音活動佔比
    if (sample > SPEECH_THRESHOLD) {
      speechSamples++
    }
  }
  
  const rms = Math.sqrt(sumSquares / channelData.length)
  const speechRatio = speechSamples / channelData.length
  
  return { rms, speechRatio }
}

/**
 * 將 AudioBuffer 編碼為 WAV 格式
 * @param {AudioBuffer} audioBuffer
 * @returns {ArrayBuffer}
 */
function encodeWav(audioBuffer) {
  const numChannels = audioBuffer.numberOfChannels
  const sampleRate = audioBuffer.sampleRate
  const format = 1 // PCM
  const bitDepth = 16
  
  // 取得所有聲道的資料
  const channels = []
  for (let i = 0; i < numChannels; i++) {
    channels.push(audioBuffer.getChannelData(i))
  }
  
  // 交錯聲道資料
  const length = channels[0].length
  const interleaved = new Float32Array(length * numChannels)
  
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      interleaved[i * numChannels + ch] = channels[ch][i]
    }
  }
  
  // 轉換為 16-bit PCM
  const dataLength = interleaved.length * (bitDepth / 8)
  const buffer = new ArrayBuffer(44 + dataLength)
  const view = new DataView(buffer)
  
  // WAV 標頭
  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataLength, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, format, true)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * numChannels * (bitDepth / 8), true)
  view.setUint16(32, numChannels * (bitDepth / 8), true)
  view.setUint16(34, bitDepth, true)
  writeString(view, 36, 'data')
  view.setUint32(40, dataLength, true)
  
  // 寫入 PCM 資料
  floatTo16BitPCM(view, 44, interleaved)
  
  return buffer
}

/**
 * 寫入字串到 DataView
 */
function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i))
  }
}

/**
 * 將浮點數轉換為 16-bit PCM
 */
function floatTo16BitPCM(view, offset, input) {
  for (let i = 0; i < input.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, input[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true)
  }
}
