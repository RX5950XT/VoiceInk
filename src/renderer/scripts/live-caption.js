/**
 * VoiceInk - 即時字幕功能
 *
 * - 音訊：AudioContext(16kHz) 直接取 PCM → VAD 在停頓處切句 → ASR
 * - ASR 與翻譯管線分離
 * - openBatch 累積 → seal → translatePump
 * - 開始時 engine.acquire 預熱模型；停止時 release 卸載
 * - 雙語／僅翻譯顯示模式
 */

import { createVad } from './vad.js'
import {
  showToast,
  getSettings,
  electronAPI,
  cleanIpcError,
  ASR_MODEL_KEY,
  resolveTranslateModelKey
} from './app.js'
import { readScope, parseAsrValue, parseLlmValue, resolveScopedCloud } from './model-picker.js'

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
let settings = null
/** 這次擷取用的 ASR 是本地還是雲端（狀態列顯示用；來源是 `liveAsr`） */
let liveAsrEngine = 'local'
/** 雲端 ASR 時用的是哪一顆模型（顯示用） */
let liveAsrModelId = ''
let consecutiveFailures = 0
let engineAcquired = false
/** 進入分頁時背景預熱所持有的引擎 owner（與 engineAcquired 互斥：擷取開始即轉交） */
let prewarmed = false
/** 作廢 in-flight prewarm（切頁／失敗／開始擷取時遞增） */
let prewarmGen = 0
/** 防止並行兩次 prewarm */
let prewarmInFlight = false

/** @type {AudioContext | null} */
let audioCtx = null
/** @type {{ source: MediaStreamAudioSourceNode, processor: ScriptProcessorNode, mute: GainNode } | null} */
let audioGraph = null
/** @type {ReturnType<typeof createVad> | null} */
let vad = null

/** @type {Float32Array[]} 已切好、等待 ASR 的語句 */
let pendingUtterances = []
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

/** sherpa 要 16kHz mono；AudioContext 直接開在這個取樣率就不必自己重採樣 */
const TARGET_SAMPLE_RATE = 16000
/** ScriptProcessor 緩衝大小（必須是 2 的冪）：2048 @16kHz = 128ms */
const FRAME_SIZE = 2048
const MAX_PENDING_UTTERANCES = 2
/** 送進 ASR 的最短語句（VAD 已擋過一次，這是防呆） */
const MIN_UTTERANCE_SAMPLES = TARGET_SAMPLE_RATE / 4

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
    // 未擷取且已預熱：重載以套用這一頁的 liveAsr / liveLlm 與全域的 llmGpu
    if (isCapturing || isStarting || !electronAPI.engine) return
    // 要「頁在前景」而且「停在即時字幕這個子分頁」才重新預熱
    const page = document.getElementById('page-stt')
    const livePanel = document.getElementById('stt-live')
    if (!page?.classList.contains('active') || !livePanel?.classList.contains('active')) return
    if (prewarmed || prewarmInFlight) {
      await cooldownEngine()
    }
    await prewarmEngine()
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
    const scope = await readScope('live')
    const r = await electronAPI.engine.acquire('live', {
      asr: parseAsrValue(scope.asr).engine === 'local',
      llm: parseLlmValue(scope.llm).mode === 'local'
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
 * 更新翻譯／ASR 後端提示
 */
async function refreshLiveTranslatorHint() {
  const scope = await readScope('live')
  const translator = parseLlmValue(scope.llm).mode === 'cloud' ? '雲端 LLM' : '本地 LLM'
  const asr = parseAsrValue(scope.asr).engine === 'cloud' ? '雲端 ASR' : '本地 ASR'
  if (liveTranslatorHint) {
    liveTranslatorHint.textContent = `語音轉文字：${asr}　翻譯：${translator}（目標語言選「自動偵測」則不翻譯）`
  }
}

/**
 * 開始擷取系統音訊
 */
async function startCapture() {
  // 重入防護：按鈕 disabled 遲至 getDisplayMedia 後才設，雙擊會起兩條錄音管線
  if (isCapturing || isStarting) return
  isStarting = true
  updateUI()
  try {
    settings = await getSettings()
    targetLanguage = liveLanguage.value
    const needsTranslationBackend = targetLanguage !== 'auto'

    // 這一頁自己的模型選擇（檔案轉錄與語音輸入各有各的）
    const scope = await readScope('live')
    const asrChoice = parseAsrValue(scope.asr)
    const llmChoice = parseLlmValue(scope.llm)
    liveAsrEngine = asrChoice.engine
    liveAsrModelId = asrChoice.modelId || ''

    const status = await electronAPI.models.status()
    if (asrChoice.engine !== 'cloud') {
      const asrKey = asrChoice.modelKey || ASR_MODEL_KEY
      const asrDef = status.models[asrKey]
      if (!asrDef?.downloaded) {
        showToast(`本地語音模型（${asrDef?.label || asrKey}）尚未下載，請到設定 → 本地模型下載`, 'error')
        return
      }
      if (asrDef.requires && !status.models[asrDef.requires]?.downloaded) {
        const runtimeLabel = status.models[asrDef.requires]?.label || asrDef.requires
        showToast(`還缺「${runtimeLabel}」，請到設定 → 本地模型下載`, 'error')
        return
      }
    }
    if (asrChoice.engine === 'cloud' && !settings.asrApiKey) {
      showToast('雲端語音轉文字需要 API Key，請到設定填寫', 'error')
      return
    }
    if (needsTranslationBackend && llmChoice.mode === 'local') {
      const llmKey = resolveTranslateModelKey({ localTranslateModel: llmChoice.modelKey }, status.models)
      if (!status.models[llmKey]?.downloaded) {
        showToast('本地翻譯模型未下載，請先到設定下載', 'error')
        return
      }
    }
    if (needsTranslationBackend && llmChoice.mode === 'cloud' && !resolveScopedCloud(settings, scope.llm).ready) {
      showToast('雲端翻譯未設定，請在這頁挑「翻譯模型」', 'error')
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

      // 2) 預熱模型（雲端 ASR 不載 sherpa）
      statusText.textContent = asrChoice.engine === 'cloud' && llmChoice.mode !== 'local'
        ? '準備中…'
        : '載入模型…'
      startLiveBtn.disabled = true
      const needAsr = asrChoice.engine !== 'cloud'
      const needLlm = needsTranslationBackend && llmChoice.mode === 'local'
      const warm = await electronAPI.engine.acquire('live', { asr: needAsr, llm: needLlm })
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

      await electronAPI.subtitle.show()
      await startPcmCapture(audioStream)
    } catch (error) {
      console.error('開始擷取失敗:', error)
      await stopPcmCapture()
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
    updateUI()
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

/**
 * 直接從 MediaStream 取 16kHz mono PCM，避免 MediaRecorder 的 opus 編碼／解碼、
 * 固定 2 秒硬切，以及 stop→restart 之間的音訊缺口。
 *
 * ScriptProcessorNode 雖已 deprecated，但仍是 Electron 35 內建、唯一不需額外 worklet
 * 檔案與 CSP 改動的同步 PCM 邊界；128ms/frame 的字幕場景沒有主執行緒負載問題。
 * @param {MediaStream} stream
 */
async function startPcmCapture(stream) {
  audioCtx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })
  if (audioCtx.sampleRate !== TARGET_SAMPLE_RATE) {
    const actualRate = audioCtx.sampleRate
    await audioCtx.close()
    audioCtx = null
    throw new Error(`音訊取樣率初始化失敗（需要 ${TARGET_SAMPLE_RATE}Hz，實際 ${actualRate}Hz）`)
  }

  const source = audioCtx.createMediaStreamSource(stream)
  const processor = audioCtx.createScriptProcessor(FRAME_SIZE, 1, 1)
  // ScriptProcessor 必須接到 destination 才會持續觸發；gain=0 確保系統音訊不回放造成重音。
  const mute = audioCtx.createGain()
  mute.gain.value = 0
  source.connect(processor)
  processor.connect(mute)
  mute.connect(audioCtx.destination)

  vad = createVad({ sampleRate: audioCtx.sampleRate })
  processor.onaudioprocess = (event) => {
    if (!isCapturing || !vad) return
    // inputBuffer 由 Chromium 重用；VAD 會保留 frame，必須複製。
    const frame = new Float32Array(event.inputBuffer.getChannelData(0))
    const result = vad.push(frame)
    levelFill.style.width = Math.min(100, result.level * 400) + '%'
    if (result.utterance) enqueueUtterance(result.utterance)
  }

  audioGraph = { source, processor, mute }
  if (audioCtx.state === 'suspended') await audioCtx.resume()
}

/** 停止 PCM callback 並釋放唯一的 AudioContext。 */
async function stopPcmCapture() {
  if (audioGraph) {
    audioGraph.processor.onaudioprocess = null
    for (const node of [audioGraph.source, audioGraph.processor, audioGraph.mute]) {
      try { node.disconnect() } catch { /* already disconnected */ }
    }
    audioGraph = null
  }
  if (vad) {
    vad.reset()
    vad = null
  }
  if (audioCtx) {
    const ctx = audioCtx
    audioCtx = null
    try { await ctx.close() } catch (e) { console.warn('關閉 AudioContext 失敗:', e) }
  }
}

/**
 * ASR 正在跑時最多保留兩句，若再塞入則丟最舊的未處理句，避免字幕越積越慢。
 * @param {Float32Array} samples
 */
function enqueueUtterance(samples) {
  if (!(samples instanceof Float32Array) || samples.length < MIN_UTTERANCE_SAMPLES) return
  applySampleGain(samples)
  pendingUtterances.push(samples)
  while (pendingUtterances.length > MAX_PENDING_UTTERANCES) pendingUtterances.shift()
  pumpQueue()
}

async function pumpQueue() {
  if (isProcessing || pendingUtterances.length === 0) return
  isProcessing = true
  const samples = pendingUtterances.shift()
  try {
    await transcribeUtterance(samples)
    consecutiveFailures = 0
    setError(null)
  } catch (error) {
    console.error('處理語句失敗:', error)
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
 * 低音量來源最多補 8×；VAD 在補增益前判斷，數位靜音不會被放大成語音。
 * @param {Float32Array} samples
 */
function applySampleGain(samples) {
  let peak = 0
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]))
  if (peak >= 0.3 || peak === 0) return
  const gain = Math.min(0.9 / peak, 8)
  for (let i = 0; i < samples.length; i++) samples[i] *= gain
}

/**
 * @param {Float32Array} samples
 */
async function transcribeUtterance(samples) {
  const epoch = sessionEpoch
  // 模型由 main 讀 store 決定（asrEngine ＋ asrModelKey），renderer 不指定
  const sourceText = (await electronAPI.localAsr.transcribe({
    samples,
    sampleRate: TARGET_SAMPLE_RATE,
    lang: targetLanguage
  }) || '').trim()

  // 停止／重開後才 resolve 的 stale ASR 結果不得再進管線（否則觸發翻譯並幽靈重載已卸載的 LLM）
  if (!isCapturing || epoch !== sessionEpoch || !sourceText) return

  if (isRepetitionLoop(sourceText)) {
    console.log('[過濾] 重複循環輸出:', sourceText.slice(0, 30))
    return
  }

  // 非語言性片段會讓小翻譯模型改走對話模式，進翻譯管線前丟棄。
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
      mode: 'live',
      scope: 'live'
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
  pendingUtterances = []
  await stopPcmCapture()

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
  startLiveBtn.disabled = isStarting
  stopLiveBtn.classList.toggle('hidden', !isCapturing)
  liveLanguage.disabled = isStarting || isCapturing
  liveStatus.classList.toggle('active', isCapturing)
  statusText.textContent = isCapturing ? '擷取中' : isStarting ? '準備中…' : '未啟動'

  if (isCapturing) {
    liveEngine.textContent = liveAsrEngine === 'cloud'
      ? `· 雲端 ASR${liveAsrModelId ? `（${liveAsrModelId}）` : ''}`
      : '· 本地 Qwen3-ASR'
  } else {
    liveEngine.textContent = ''
    levelFill.style.width = '0%'
  }
}

function setError(message) {
  liveError.classList.toggle('hidden', !message)
  liveError.textContent = message || ''
}
