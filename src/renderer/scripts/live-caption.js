/**
 * VoiceInk - 即時字幕功能（本地 Qwen3-ASR）
 */

import { showToast, getSettings, electronAPI, cleanIpcError, ASR_MODEL_KEY } from './app.js'

// ===== DOM 元素 =====
let liveLanguage
let startLiveBtn
let stopLiveBtn
let liveStatus
let statusText
let liveEngine
let levelFill
let liveError

// ===== 狀態 =====
let isCapturing = false
let mediaStream = null
let mediaRecorder = null
let settings = null
let consecutiveFailures = 0

// 音量指示
let levelAudioCtx = null
let levelRaf = null

// 處理佇列：只保留最新一筆待處理，處理完立即接手（不丟棄、不堆積）
let pendingChunks = null
let isProcessing = false

// 歷史轉錄記錄
let transcriptHistory = []
const MAX_HISTORY_COUNT = 10

// 音訊分段時間（毫秒）
const CHUNK_DURATION = 2000

// 靜音門檻（放寬版：先做增益補償再檢測）
const RMS_THRESHOLD = 0.01
const SPEECH_RATIO_THRESHOLD = 0.05
const SPEECH_SAMPLE_THRESHOLD = 0.01

/**
 * 初始化即時字幕功能
 */
export function initLiveCaption() {
  liveLanguage = document.getElementById('liveLanguage')
  startLiveBtn = document.getElementById('startLiveBtn')
  stopLiveBtn = document.getElementById('stopLiveBtn')
  liveStatus = document.getElementById('liveStatus')
  statusText = liveStatus.querySelector('.status-text')
  liveEngine = document.getElementById('liveEngine')
  levelFill = document.getElementById('levelFill')
  liveError = document.getElementById('liveError')

  startLiveBtn.addEventListener('click', startCapture)
  stopLiveBtn.addEventListener('click', () => stopCapture())

  // 字幕視窗上的關閉按鈕觸發
  electronAPI.subtitle.onClosed(() => {
    if (isCapturing) stopCapture({ closeWindow: false })
  })
}

/**
 * 開始擷取系統音訊
 */
async function startCapture() {
  settings = await getSettings()

  const status = await electronAPI.models.status()
  if (!status.models[ASR_MODEL_KEY]?.downloaded) {
    showToast('本地 ASR 模型尚未下載，請先到設定下載', 'error')
    return
  }

  try {
    mediaStream = await navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: { width: 1, height: 1, frameRate: 1 }
    })

    const audioTracks = mediaStream.getAudioTracks()
    if (audioTracks.length === 0) {
      throw new Error('無法取得系統音訊')
    }
    mediaStream.getVideoTracks().forEach(track => track.stop())
    const audioStream = new MediaStream(audioTracks)

    isCapturing = true
    consecutiveFailures = 0
    setError(null)
    updateUI()
    startLevelMeter(audioStream)

    await electronAPI.subtitle.show()
    startRecording(audioStream)
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
 * 循環錄製：每輪產生完整 WebM（含檔頭），結束即進佇列
 */
function startRecording(stream) {
  function startNewRecording() {
    if (!isCapturing || !stream) return

    try {
      mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
    } catch {
      mediaRecorder = new MediaRecorder(stream)
    }

    const chunks = []
    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    }
    mediaRecorder.onstop = () => {
      if (chunks.length > 0 && isCapturing) enqueueChunks(chunks)
      if (isCapturing) startNewRecording()
    }

    mediaRecorder.start()
    setTimeout(() => {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop()
      }
    }, CHUNK_DURATION)
  }

  startNewRecording()
}

/**
 * 佇列：保留最新待處理片段，處理器空下來立即接手
 */
function enqueueChunks(chunks) {
  pendingChunks = chunks
  pumpQueue()
}

async function pumpQueue() {
  if (isProcessing || !pendingChunks) return
  isProcessing = true
  const chunks = pendingChunks
  pendingChunks = null
  try {
    await processAudioChunkData(chunks)
    consecutiveFailures = 0
    setError(null)
  } catch (error) {
    console.error('處理音訊片段失敗:', error)
    consecutiveFailures++
    setError(cleanIpcError(error))
    if (consecutiveFailures >= 3) {
      showToast('連續轉錄失敗，已停止字幕', 'error')
      stopCapture()
      return
    }
  } finally {
    isProcessing = false
  }
  pumpQueue()
}

/**
 * 處理一段音訊：解碼 → 靜音檢測（含增益補償）→ 本地 ASR → 翻譯 → 上字幕
 */
async function processAudioChunkData(chunks) {
  const webmBlob = new Blob(chunks, { type: 'audio/webm' })
  if (webmBlob.size < 1000) return

  const audioBuffer = await decodeAudio(webmBlob)
  if (!audioBuffer) return

  // 增益補償：loopback 音量偏低時放大（上限 8 倍），再做靜音檢測
  applyGain(audioBuffer)
  const { rms, speechRatio } = analyzeAudio(audioBuffer)
  if (rms < RMS_THRESHOLD || speechRatio < SPEECH_RATIO_THRESHOLD) return

  const targetLanguage = liveLanguage.value
  const samples = await resampleTo16kMono(audioBuffer)
  let text = await electronAPI.localAsr.transcribe({
    samples,
    sampleRate: 16000,
    lang: targetLanguage,
    modelKey: ASR_MODEL_KEY
  })
  text = (text || '').trim()

  // 翻譯（依設定，目標語言與內容語言不同時才翻）
  if (text && settings.translator !== 'none' && targetLanguage !== 'auto' &&
      needsTranslation(text, targetLanguage)) {
    try {
      text = await electronAPI.translate(text, targetLanguage)
    } catch (error) {
      // 翻譯失敗降級顯示原文
      setError(`翻譯失敗，顯示原文：${cleanIpcError(error)}`)
    }
  }

  // ASR 對音樂/雜訊可能輸出短語重複循環（如「我，我，我…」），直接丟棄
  if (text && isRepetitionLoop(text)) {
    console.log('[過濾] 重複循環輸出:', text.slice(0, 30))
    return
  }

  if (text) {
    await electronAPI.subtitle.update(text)
    transcriptHistory.push(text)
    if (transcriptHistory.length > MAX_HISTORY_COUNT) transcriptHistory.shift()
  }
}

/**
 * 偵測短單位連續重複 8 次以上（ASR 重複循環）
 */
function isRepetitionLoop(text) {
  return /(.{1,6}?)(?:[，,、。.\s]*\1){7,}/.test(text)
}

/**
 * 是否需要翻譯（粗略語言偵測，避免同語言白翻一趟）
 */
function needsTranslation(text, targetLang) {
  const cjkCount = (text.match(/[一-鿿]/g) || []).length
  const cjkRatio = cjkCount / text.length
  if (targetLang.startsWith('zh')) return cjkRatio < 0.3
  if (targetLang === 'en') return cjkRatio > 0.1 || /[぀-ヿ가-힯]/.test(text)
  if (targetLang === 'ja') return !/[぀-ヿ]/.test(text)
  if (targetLang === 'ko') return !/[가-힯]/.test(text)
  return true
}

/**
 * 停止擷取
 * @param {{closeWindow?: boolean}} options - closeWindow 為 false 時不再關閉字幕視窗（由視窗端觸發）
 */
async function stopCapture({ closeWindow = true } = {}) {
  isCapturing = false
  transcriptHistory = []
  pendingChunks = null
  stopLevelMeter()

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try {
      mediaRecorder.stop()
    } catch (e) {
      console.error('停止錄製失敗:', e)
    }
  }
  mediaRecorder = null

  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop())
    mediaStream = null
  }

  if (closeWindow) {
    await electronAPI.subtitle.close()
  }
  updateUI()
}

/**
 * 更新 UI 狀態
 */
function updateUI() {
  startLiveBtn.classList.toggle('hidden', isCapturing)
  stopLiveBtn.classList.toggle('hidden', !isCapturing)
  liveStatus.classList.toggle('active', isCapturing)
  statusText.textContent = isCapturing ? '擷取中' : '未啟動'

  if (isCapturing) {
    liveEngine.textContent = '· 本地 Qwen3-ASR-0.6B'
  } else {
    liveEngine.textContent = ''
    levelFill.style.width = '0%'
  }
}

/**
 * 顯示/清除錯誤訊息
 */
function setError(message) {
  liveError.classList.toggle('hidden', !message)
  liveError.textContent = message || ''
}

// ===== 音量指示條 =====

function startLevelMeter(stream) {
  levelAudioCtx = new AudioContext()
  const source = levelAudioCtx.createMediaStreamSource(stream)
  const analyser = levelAudioCtx.createAnalyser()
  analyser.fftSize = 512
  source.connect(analyser)
  const data = new Uint8Array(analyser.frequencyBinCount)

  const tick = () => {
    if (!isCapturing) return
    analyser.getByteTimeDomainData(data)
    let sum = 0
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128
      sum += v * v
    }
    const rms = Math.sqrt(sum / data.length)
    levelFill.style.width = Math.min(100, rms * 400) + '%'
    levelRaf = requestAnimationFrame(tick)
  }
  tick()
}

function stopLevelMeter() {
  if (levelRaf) cancelAnimationFrame(levelRaf)
  levelRaf = null
  if (levelAudioCtx) {
    levelAudioCtx.close()
    levelAudioCtx = null
  }
}

// ===== 音訊處理工具 =====

/**
 * 解碼 WebM 為 AudioBuffer（失敗回 null）
 */
async function decodeAudio(webmBlob) {
  const audioContext = new AudioContext()
  try {
    const arrayBuffer = await webmBlob.arrayBuffer()
    return await audioContext.decodeAudioData(arrayBuffer)
  } catch {
    return null
  } finally {
    audioContext.close()
  }
}

/**
 * 增益補償：峰值過低時就地放大（上限 8 倍）
 */
function applyGain(audioBuffer) {
  let peak = 0
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    const data = audioBuffer.getChannelData(ch)
    for (let i = 0; i < data.length; i++) {
      const abs = Math.abs(data[i])
      if (abs > peak) peak = abs
    }
  }
  if (peak >= 0.3 || peak === 0) return
  const gain = Math.min(0.9 / peak, 8)
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    const data = audioBuffer.getChannelData(ch)
    for (let i = 0; i < data.length; i++) data[i] *= gain
  }
}

/**
 * 計算 RMS 音量與語音活動佔比
 */
function analyzeAudio(audioBuffer) {
  const channelData = audioBuffer.getChannelData(0)
  let sumSquares = 0
  let speechSamples = 0

  for (let i = 0; i < channelData.length; i++) {
    const sample = Math.abs(channelData[i])
    sumSquares += sample * sample
    if (sample > SPEECH_SAMPLE_THRESHOLD) speechSamples++
  }

  return {
    rms: Math.sqrt(sumSquares / channelData.length),
    speechRatio: speechSamples / channelData.length
  }
}

/**
 * 重採樣為 16kHz 單聲道 Float32Array（本地 ASR 輸入格式）
 */
export async function resampleTo16kMono(audioBuffer) {
  const targetLength = Math.ceil(audioBuffer.duration * 16000)
  const offlineCtx = new OfflineAudioContext(1, targetLength, 16000)
  const source = offlineCtx.createBufferSource()
  source.buffer = audioBuffer
  source.connect(offlineCtx.destination)
  source.start()
  const rendered = await offlineCtx.startRendering()
  // 複製一份，避免傳遞 detached buffer
  return new Float32Array(rendered.getChannelData(0))
}
