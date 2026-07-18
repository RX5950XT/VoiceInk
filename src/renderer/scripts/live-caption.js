/**
 * VoiceInk - 即時字幕功能（本地 Qwen3-ASR）
 *
 * - ASR 與翻譯管線分離
 * - openBatch 累積 → seal → translatePump
 * - 開始時 engine.acquire 預熱模型；停止時 release 卸載
 * - 雙語／僅翻譯顯示模式
 */

import {
  showToast,
  getSettings,
  electronAPI,
  cleanIpcError,
  ASR_MODEL_KEY,
  TRANSLATE_MODEL_KEY
} from './app.js'

// ===== DOM 元素 =====
let liveLanguage
let startLiveBtn
let stopLiveBtn
let liveStatus
let statusText
let liveEngine
let levelFill
let liveError
let liveTranslatorHint

// ===== 狀態 =====
let isCapturing = false
let mediaStream = null
let mediaRecorder = null
let settings = null
let consecutiveFailures = 0
let engineAcquired = false
/** 進入分頁時背景預熱所持有的引擎 owner（與 engineAcquired 互斥：擷取開始即轉交） */
let prewarmed = false
/** 作廢 in-flight prewarm（切頁／失敗／開始擷取時遞增） */
let prewarmGen = 0
/** 防止並行兩次 prewarm */
let prewarmInFlight = false

let levelAudioCtx = null
let levelRaf = null

let pendingChunks = null
let isProcessing = false
let isStarting = false

/** @type {{ source: string, translation: string }[]} 原文/譯文成對，避免單邊過濾錯位 */
let history = []
const MAX_HISTORY_COUNT = 10
const CONTEXT_SEGMENTS = 2
const CONTEXT_MAX_CHARS = 320
const MIN_TRANSLATE_CHARS = 2
const MAX_BATCH_SEGMENTS = 2
const MAX_BATCH_CHARS = 120
const MAX_TRANSLATE_QUEUE = 5

let targetLanguage = 'zh-TW'

let sessionEpoch = 0
let batchSeq = 0

/** @type {{ id: string, sources: string[], epoch: number } | null} */
let openBatch = null
/** @type {{ id: string, sources: string[], epoch: number }[]} */
let translateQueue = []
let isTranslating = false

const CHUNK_DURATION = 2000
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
  liveTranslatorHint = document.getElementById('liveTranslatorHint')

  startLiveBtn.addEventListener('click', startCapture)
  stopLiveBtn.addEventListener('click', () => stopCapture())

  electronAPI.subtitle.onClosed(() => {
    if (isCapturing) stopCapture({ closeWindow: false })
  })

  refreshLiveTranslatorHint()
  document.addEventListener('settings-changed', async () => {
    // 擷取中改設定也要刷新快照，否則 renderer 判斷與 main 即時讀取的 store 脫鉤
    settings = await getSettings()
    refreshLiveTranslatorHint()
  })
}

/**
 * 進入即時字幕分頁時背景預熱模型，讓「開始字幕」近乎秒開。
 * 只在未擷取且未持有引擎時做；失敗（如模型未下載）僅記 log，不打擾使用者。
 * acquire 成功後才設 prewarmed，並以 prewarmGen 作廢過期的 in-flight 結果（防洩漏）。
 */
export async function prewarmEngine() {
  if (isCapturing || isStarting || prewarmed || prewarmInFlight || !electronAPI.engine) return
  const gen = ++prewarmGen
  prewarmInFlight = true
  if (statusText && !isCapturing) statusText.textContent = '準備模型…'
  try {
    const s = await getSettings()
    const r = await electronAPI.engine.acquire('live', {
      asr: true,
      llm: s.translator === 'local'
    })
    // 擷取已接手（或即將接手）同一個 live owner：不可 release
    if (isCapturing || engineAcquired || isStarting) {
      return
    }
    // 已作廢（切離分頁）：成功佔了 owner 要立刻放掉，避免無人 release
    if (gen !== prewarmGen) {
      if (r && r.ok) {
        await electronAPI.engine.release('live').catch(() => {})
      }
      return
    }
    prewarmed = !!(r && r.ok)
  } catch (e) {
    console.warn('[預熱] 失敗:', e)
    if (gen === prewarmGen) prewarmed = false
  } finally {
    prewarmInFlight = false
    // 預熱完成後若尚未開始擷取，還原狀態文字（勿覆蓋 startCapture 已設的文字）
    if (statusText && !isCapturing && !engineAcquired) statusText.textContent = '未啟動'
  }
}

/**
 * 離開即時字幕分頁且未擷取時卸載預熱的模型，釋放記憶體。
 */
export async function cooldownEngine() {
  prewarmGen++ // 作廢 in-flight prewarm
  if (isCapturing || isStarting || !electronAPI.engine) return
  if (!prewarmed) return
  prewarmed = false
  try {
    await electronAPI.engine.release('live')
  } catch (e) {
    console.warn('[卸載] 失敗:', e)
  }
}

/**
 * 更新「翻譯：本地／雲端／未開啟」提示
 */
async function refreshLiveTranslatorHint() {
  const s = await getSettings()
  const translator = s.translator || 'none'
  let label = '翻譯：未開啟（設定 → 翻譯）'
  if (translator === 'local') label = '翻譯：本地 LLM'
  if (translator === 'cloud') label = '翻譯：雲端 LLM'
  if (liveTranslatorHint) liveTranslatorHint.textContent = label
}

/**
 * 開始擷取系統音訊
 */
async function startCapture() {
  // 重入防護：按鈕 disabled 遲至 getDisplayMedia 後才設，雙擊會起兩條錄音管線
  if (isCapturing || isStarting) return
  isStarting = true
  try {
    settings = await getSettings()
    targetLanguage = liveLanguage.value

    const status = await electronAPI.models.status()
    if (!status.models[ASR_MODEL_KEY]?.downloaded) {
      showToast('本地 ASR 模型尚未下載，請先到設定下載', 'error')
      return
    }
    if (settings.translator === 'local' && !status.models[TRANSLATE_MODEL_KEY]?.downloaded) {
      showToast('本地翻譯模型尚未下載，請先到設定下載', 'error')
      return
    }
    if (settings.translator === 'cloud' && !settings.apiKey) {
      showToast('雲端翻譯需要 API Key，請到設定填寫', 'error')
      return
    }

    try {
      // 1) 先要權限（取消則不載模型）
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
      // 音訊來源被系統收回（切換輸出裝置、藍牙斷線）時主動停止，避免殭屍 session
      audioTracks.forEach(t => t.addEventListener('ended', () => {
        if (isCapturing) stopCapture()
      }))

      // 2) 預熱模型
      statusText.textContent = '載入模型…'
      startLiveBtn.disabled = true
      const needLlm = settings.translator === 'local'
      const warm = await electronAPI.engine.acquire('live', { asr: true, llm: needLlm })
      if (!warm.ok) {
        throw new Error((warm.warnings && warm.warnings[0]) || '模型載入失敗')
      }
      engineAcquired = true
      prewarmed = false // 擷取接手引擎所有權；卸載改由 stopCapture 負責

      isCapturing = true
      consecutiveFailures = 0
      resetTranslateState()
      setError(null)
      updateUI()
      startLevelMeter(audioStream)

      await electronAPI.subtitle.show()
      startRecording(audioStream)
    } catch (error) {
      console.error('開始擷取失敗:', error)
      stopLevelMeter()
      // 只釋放本次擷取取得的引擎；保留背景 prewarm（取消權限不應拆掉預熱）
      if (engineAcquired) {
        await electronAPI.engine.release('live').catch(() => {})
        engineAcquired = false
      }
      if (mediaStream) {
        mediaStream.getTracks().forEach(t => t.stop())
        mediaStream = null
      }
      if (error.name === 'NotAllowedError') {
        showToast('使用者取消了權限請求', 'error')
      } else {
        showToast(`開始失敗: ${error.message}`, 'error')
      }
      isCapturing = false
      updateUI()
    }
  } finally {
    isStarting = false
    startLiveBtn.disabled = false
  }
}

function resetTranslateState() {
  sessionEpoch++
  batchSeq = 0
  openBatch = null
  translateQueue = []
  isTranslating = false
  history = []
}

function startRecording(stream) {
  function startNewRecording() {
    if (!isCapturing || !stream) return
    // 來源已失效（track ended）時不要在 inactive stream 上 start()，否則拋例外變殭屍
    if (!stream.active) {
      if (isCapturing) stopCapture()
      return
    }

    try {
      mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
    } catch {
      try {
        mediaRecorder = new MediaRecorder(stream)
      } catch (e) {
        console.error('建立 MediaRecorder 失敗:', e)
        if (isCapturing) stopCapture()
        return
      }
    }

    const chunks = []
    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    }
    mediaRecorder.onstop = () => {
      if (chunks.length > 0 && isCapturing) enqueueChunks(chunks)
      if (isCapturing) startNewRecording()
    }
    mediaRecorder.onerror = (event) => {
      console.error('MediaRecorder 錯誤:', event.error || event)
      if (isCapturing) stopCapture()
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

async function processAudioChunkData(chunks) {
  const webmBlob = new Blob(chunks, { type: 'audio/webm' })
  if (webmBlob.size < 1000) return

  const audioBuffer = await decodeAudio(webmBlob)
  if (!audioBuffer) return

  applyGain(audioBuffer)
  const { rms, speechRatio } = analyzeAudio(audioBuffer)
  if (rms < RMS_THRESHOLD || speechRatio < SPEECH_RATIO_THRESHOLD) return

  const samples = await resampleTo16kMono(audioBuffer)
  const epoch = sessionEpoch
  const sourceText = (await electronAPI.localAsr.transcribe({
    samples,
    sampleRate: 16000,
    lang: targetLanguage,
    modelKey: ASR_MODEL_KEY
  }) || '').trim()

  // 停止／重開後才 resolve 的 stale ASR 結果不得再進管線（否則觸發翻譯並幽靈重載已卸載的 LLM）
  if (!isCapturing || epoch !== sessionEpoch) return
  if (!sourceText) return

  if (isRepetitionLoop(sourceText)) {
    console.log('[過濾] 重複循環輸出:', sourceText.slice(0, 30))
    return
  }

  // 非語言性片段（純符號、♪音樂、雜訊、零寬/格式字元）會讓 0.8B 翻譯模型改走對話模式，
  // 吐出「你好，我是即時字幕翻譯引擎…請提供原文…」persona 問候而非譯文——進管線前直接丟棄
  if (!hasLinguisticContent(sourceText)) {
    console.log('[過濾] 無語言內容:', JSON.stringify(sourceText.slice(0, 20)))
    return
  }

  handleAsrResult(sourceText)
}

/**
 * @param {string} sourceText
 */
function handleAsrResult(sourceText) {
  const shouldTranslate =
    settings.translator !== 'none' &&
    targetLanguage !== 'auto' &&
    hasLinguisticContent(sourceText) &&
    needsTranslation(sourceText, targetLanguage)

  if (!shouldTranslate) {
    if (openBatch) {
      sealOpenBatch()
      pumpTranslate() // 必呼叫，避免佇列卡住
    }
    const id = nextBatchId()
    upsertSubtitle(id, sourceText, '')
    // 不 pushPair(原文,原文)：identity 前文會教 0.8B 模型「原樣輸出」，下一段日文被整段複誦（雙語變兩行日文）

    if (
      settings.translator !== 'none' &&
      targetLanguage !== 'auto' &&
      !needsTranslation(sourceText, targetLanguage)
    ) {
      console.log('[略過翻譯] 偵測已是目標語:', sourceText.slice(0, 40))
    }
    return
  }

  if (!openBatch) {
    openBatch = { id: nextBatchId(), sources: [sourceText], epoch: sessionEpoch }
  } else {
    openBatch.sources.push(sourceText)
  }

  upsertSubtitle(openBatch.id, openBatch.sources.join(' '), '')

  const joined = openBatch.sources.join(' ')
  const shouldSeal =
    openBatch.sources.length >= MAX_BATCH_SEGMENTS ||
    joined.length >= MAX_BATCH_CHARS ||
    !isTranslating

  if (shouldSeal) sealOpenBatch()
  pumpTranslate()
}

function nextBatchId() {
  batchSeq += 1
  return `b-${sessionEpoch}-${batchSeq}`
}

function sealOpenBatch() {
  if (!openBatch || openBatch.sources.length === 0) {
    openBatch = null
    return
  }
  translateQueue.push(openBatch)
  openBatch = null
  // 翻譯跟不上時丟最舊的未處理批次，避免佇列與延遲無限增長（原文已即時上屏）
  while (translateQueue.length > MAX_TRANSLATE_QUEUE) translateQueue.shift()
}

async function pumpTranslate() {
  if (isTranslating || translateQueue.length === 0) return
  isTranslating = true

  const batch = translateQueue.shift()
  const epoch = batch.epoch
  const joinedSource = batch.sources.join(' ').trim()

  try {
    if (epoch !== sessionEpoch || !joinedSource) return

    const context = buildTranslateContext(joinedSource)
    const translated = (await electronAPI.translate(joinedSource, targetLanguage, {
      previousSource: context.previousSource,
      previousTranslation: context.previousTranslation,
      mode: 'live'
    }) || '').trim()

    if (epoch !== sessionEpoch) return

    if (translated && translated !== joinedSource) {
      upsertSubtitle(batch.id, joinedSource, translated)
      pushPair(joinedSource, translated)
    } else {
      // 空白或模型複誦原文（echo）：顯示原文、不把 identity 譯文寫進 history（否則會持續教模型複誦）
      if (!translated) setError('翻譯回傳空白，顯示原文')
      pushPair(joinedSource, '')
    }
  } catch (error) {
    if (epoch !== sessionEpoch) return
    setError(`翻譯失敗，顯示原文：${cleanIpcError(error)}`)
    pushPair(joinedSource, '')
  } finally {
    // 舊 session 的翻譯晚回時不得清掉新 session 的鎖或觸發其 pump
    if (epoch === sessionEpoch) {
      isTranslating = false
      if (openBatch && openBatch.sources.length > 0) {
        sealOpenBatch()
      }
      pumpTranslate()
    }
  }
}

function upsertSubtitle(id, source, translation) {
  electronAPI.subtitle.update({
    id,
    source,
    translation,
    action: 'upsert'
  })
}

function pushPair(source, translation) {
  history.push({ source, translation })
  if (history.length > MAX_HISTORY_COUNT) history.shift()
}

function buildTranslateContext(currentBatchSource) {
  // 只取有譯文、且非當前批次的成對前文，原文/譯文永遠對齊
  const usable = history
    .filter(h => h.translation && h.source !== currentBatchSource)
    .slice(-CONTEXT_SEGMENTS)
  return {
    previousSource: trimContext(usable.map(h => h.source).join(' ')),
    previousTranslation: trimContext(usable.map(h => h.translation).join(' '))
  }
}

function trimContext(text) {
  const t = (text || '').trim()
  if (t.length <= CONTEXT_MAX_CHARS) return t
  return t.slice(-CONTEXT_MAX_CHARS)
}

function isRepetitionLoop(text) {
  return /(.{1,6}?)(?:[，,、。.\s]*\1){7,}/.test(text)
}

/**
 * 是否含足夠語言性字元（字母／漢字／假名／諺文）。
 * 純符號、♪音樂、數字、標點、零寬/格式字元不算——這類片段會讓小翻譯模型改用對話模式。
 * @param {string} text
 */
function hasLinguisticContent(text) {
  return text.replace(/[^\p{L}]/gu, '').length >= MIN_TRANSLATE_CHARS
}

function needsTranslation(text, targetLang) {
  const cjkCount = (text.match(/[一-鿿]/g) || []).length
  const cjkRatio = cjkCount / Math.max(1, text.length)
  // 有假名/諺文即為日/韓文，即使漢字比例高也需翻成中文
  if (targetLang.startsWith('zh')) return /[ぁ-ヿ가-힯]/.test(text) || cjkRatio < 0.3
  if (targetLang === 'en') return cjkRatio > 0.1 || /[ぁ-ヿ가-힯]/.test(text)
  if (targetLang === 'ja') return !/[ぁ-ヿ]/.test(text)
  if (targetLang === 'ko') return !/[가-힯]/.test(text)
  return true
}

/**
 * @param {{closeWindow?: boolean}} options
 */
async function stopCapture({ closeWindow = true } = {}) {
  isCapturing = false
  resetTranslateState()
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

  // 等 in-flight ASR 結束再 release，配合 main 側 loadEnabled 避免幽靈重載
  const waitStart = Date.now()
  while (isProcessing && Date.now() - waitStart < 15000) {
    await new Promise((r) => setTimeout(r, 50))
  }

  if (engineAcquired) {
    try {
      await electronAPI.engine.release('live')
    } catch (e) {
      console.error('engine.release failed:', e)
    }
    engineAcquired = false
  }
  prewarmed = false // 擷取結束後引擎已卸；重新進分頁才再預熱

  if (closeWindow) {
    await electronAPI.subtitle.close()
  }
  updateUI()
}

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

function setError(message) {
  liveError.classList.toggle('hidden', !message)
  liveError.textContent = message || ''
}

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
 * 重採樣為 16kHz 單聲道 Float32Array
 */
export async function resampleTo16kMono(audioBuffer) {
  const targetLength = Math.ceil(audioBuffer.duration * 16000)
  const offlineCtx = new OfflineAudioContext(1, targetLength, 16000)
  const source = offlineCtx.createBufferSource()
  source.buffer = audioBuffer
  source.connect(offlineCtx.destination)
  source.start()
  const rendered = await offlineCtx.startRendering()
  return new Float32Array(rendered.getChannelData(0))
}
