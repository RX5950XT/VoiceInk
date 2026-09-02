/**
 * VoiceInk - 語音輸入的錄音端（Renderer）
 *
 * main 那邊管熱鍵（右 Alt）、ASR、整理與貼上；這裡只負責一件事：把麥克風的
 * 16kHz mono PCM 錄下來，收到 stop 就整段送回 main。
 *
 * 為什麼錄音在 renderer：麥克風在 Chromium 這一側，既有的即時字幕也是走同一條
 * `AudioContext(16000)` + `ScriptProcessorNode`。視窗縮到系統匣（`document.hidden`）
 * 時 ScriptProcessor 照常觸發——它不是 rAF，不受可見度影響。
 *
 * 麥克風在「啟用語音輸入」時就一直開著：每次按鍵才 `getUserMedia` 要等 200～500ms，
 * 那段等待正好吃掉開頭第一個字。代價是麥克風指示燈會亮著，所以這是使用者自己按的開關。
 */

import { electronAPI, showToast } from './app.js'

/** ASR 要 16kHz mono */
const SAMPLE_RATE = 16000
/** ScriptProcessor 緩衝（2 的冪）：2048 @16kHz = 128ms */
const FRAME_SIZE = 2048
/** 太短的當誤觸（放開太快） */
const MIN_MS = 300
/**
 * 單次上限：切換模式忘了關的話，不能讓它一直錄下去。
 * 20 分鐘 @16kHz float32 約 77MB，main 會先切成 20 秒一段再逐段送進 ASR。
 */
const MAX_MS = 20 * 60 * 1000

let enabled = false
let recording = false
let startedAt = 0
/** @type {MediaStream | null} */
let stream = null
/** @type {AudioContext | null} */
let audioCtx = null
/** @type {{ source: MediaStreamAudioSourceNode, processor: ScriptProcessorNode, mute: GainNode } | null} */
let graph = null
/** @type {Float32Array[]} */
let chunks = []
let chunkSamples = 0
/** @type {number | null} */
let maxTimer = null
let bound = false

/**
 * 桌面指示器要顯示什麼，直接由這裡的狀態決定——它是唯一知道「真的在錄了沒」的地方
 * （main 只送得出熱鍵動作，麥克風開不開得成要試過才知道）。
 * @type {Record<string, string>}
 */
const HUD_STATE = {
  recording: 'recording',
  level: 'recording',
  processing: 'processing',
  error: 'error'
}

/**
 * @param {string} state
 * @param {object} [detail]
 */
function emit(state, detail = {}) {
  document.dispatchEvent(new CustomEvent('dictation-state', { detail: { state, ...detail } }))
  // 使用者按下右 Alt 的時候多半正在別的程式裡，看不到主視窗的 Toast；
  // 錯誤與降級提示要送到指示器上，否則等於什麼都沒說
  electronAPI.dictation?.hudState({
    state: HUD_STATE[state] || 'idle',
    level: Number(/** @type {{ level?: number }} */ (detail).level) || 0,
    message: /** @type {{ message?: string }} */ (detail).message || ''
  })
}

/**
 * 開始／結束的提示音。使用者多半正在別的程式裡打字，看不到 VoiceInk 的畫面，
 * 用聲音回饋比什麼都沒有好（音量很小，不會蓋掉自己的講話）。
 * @param {number} freq
 */
function beep(freq) {
  if (!audioCtx) return
  try {
    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    osc.frequency.value = freq
    gain.gain.value = 0.04
    osc.connect(gain)
    gain.connect(audioCtx.destination)
    osc.start()
    osc.stop(audioCtx.currentTime + 0.08)
  } catch { /* 提示音失敗不影響錄音 */ }
}

/**
 * 開麥克風（只在啟用時做一次）
 * @returns {Promise<boolean>}
 */
async function ensureMic() {
  // 麥克風是一直開著的，中途拔耳機／被別的程式搶走時 track 會變成 `ended`——
  // 這時 graph 還在，看起來一切正常，但錄下來是一整段靜音（按了沒反應的主因）。
  // 一併看 AudioContext 有沒有被系統中斷。
  if (graph && (
    !stream?.getAudioTracks().some((t) => t.readyState === 'live')
    || audioCtx?.state === 'closed'
  )) {
    await teardownMic()
  }
  if (graph) {
    // 系統休眠回來後 context 常停在 suspended，不 resume 就收不到任何 frame
    if (audioCtx?.state === 'suspended') await audioCtx.resume().catch(() => {})
    return true
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })
  } catch (err) {
    console.error('[語音輸入] 取得麥克風失敗:', err)
    emit('error', { message: err?.name === 'NotAllowedError' ? '沒有麥克風權限' : '找不到可用的麥克風' })
    return false
  }

  audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE })
  if (audioCtx.sampleRate !== SAMPLE_RATE) {
    const actual = audioCtx.sampleRate
    await audioCtx.close().catch(() => {})
    audioCtx = null
    stream.getTracks().forEach((t) => t.stop())
    stream = null
    emit('error', { message: `音訊取樣率初始化失敗（需要 ${SAMPLE_RATE}Hz，實際 ${actual}Hz）` })
    return false
  }

  const source = audioCtx.createMediaStreamSource(stream)
  const processor = audioCtx.createScriptProcessor(FRAME_SIZE, 1, 1)
  // ScriptProcessor 要接到 destination 才會持續觸發；gain=0 避免自己的聲音被放出來
  const mute = audioCtx.createGain()
  mute.gain.value = 0
  source.connect(processor)
  processor.connect(mute)
  mute.connect(audioCtx.destination)

  processor.onaudioprocess = (event) => {
    if (!recording) return
    // inputBuffer 由 Chromium 重用，必須複製
    const frame = new Float32Array(event.inputBuffer.getChannelData(0))
    chunks.push(frame)
    chunkSamples += frame.length
    let peak = 0
    for (let i = 0; i < frame.length; i++) peak = Math.max(peak, Math.abs(frame[i]))
    emit('level', { level: peak, ms: Date.now() - startedAt })
  }

  graph = { source, processor, mute }
  if (audioCtx.state === 'suspended') await audioCtx.resume()
  return true
}

async function teardownMic() {
  recording = false
  chunks = []
  chunkSamples = 0
  if (graph) {
    graph.processor.onaudioprocess = null
    for (const node of [graph.source, graph.processor, graph.mute]) {
      try { node.disconnect() } catch { /* already disconnected */ }
    }
    graph = null
  }
  if (stream) {
    stream.getTracks().forEach((t) => t.stop())
    stream = null
  }
  if (audioCtx) {
    const ctx = audioCtx
    audioCtx = null
    await ctx.close().catch(() => {})
  }
}

function clearMaxTimer() {
  if (maxTimer !== null) {
    clearTimeout(maxTimer)
    maxTimer = null
  }
}

async function startRecording() {
  if (recording) return
  if (!(await ensureMic())) return
  chunks = []
  chunkSamples = 0
  startedAt = Date.now()
  recording = true
  beep(880)
  emit('recording')
  clearMaxTimer()
  maxTimer = setTimeout(() => {
    if (recording) {
      showToast(`語音輸入已達 ${MAX_MS / 60000} 分鐘上限，自動送出`)
      stopRecording()
    }
  }, MAX_MS)
}

/**
 * 把收到的每一小段接成一整段
 * @returns {Float32Array}
 */
function mergeChunks() {
  const merged = new Float32Array(chunkSamples)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return merged
}

async function stopRecording() {
  if (!recording) return
  recording = false
  clearMaxTimer()
  const durationMs = Date.now() - startedAt
  const samples = mergeChunks()
  chunks = []
  chunkSamples = 0
  beep(660)

  if (durationMs < MIN_MS || samples.length < SAMPLE_RATE / 4) {
    emit('idle', { reason: 'too-short' })
    return
  }

  emit('processing')
  try {
    const res = await electronAPI.dictation.submit({ samples, sampleRate: SAMPLE_RATE, durationMs })
    if (!res?.ok) {
      const message = res?.error?.message || '語音輸入失敗'
      emit('error', { message })
      showToast(message, 'error')
      return
    }
    const data = res.data || {}
    if (!data.ok) {
      emit('error', { message: data.error || '語音輸入失敗' })
      showToast(data.error || '語音輸入失敗', 'error')
      return
    }
    emit('result', data)
    if (data.warning) {
      showToast(data.warning, 'error')
      // 文字有插入、只是降級了（例如整理模型連不上）。emit('result') 會把指示器收起來，
      // 所以降級提示要在它後面自己補一則，不然使用者永遠不知道整理沒跑
      electronAPI.dictation?.hudState({ state: 'error', message: data.warning })
    }
  } catch (err) {
    console.error('[語音輸入] 送出失敗:', err)
    emit('error', { message: '語音輸入失敗' })
  }
}

function cancelRecording() {
  if (!recording) {
    emit('idle')
    return
  }
  recording = false
  clearMaxTimer()
  chunks = []
  chunkSamples = 0
  beep(440)
  emit('idle', { reason: 'cancelled' })
}

/**
 * 依 store 的 `dictationEnabled` 開／關這一側的麥克風。
 * main 那邊的熱鍵由 `store:set` 直接觸發，不必在這裡管。
 */
export async function refreshDictationRuntime() {
  const want = (await electronAPI.store.get('dictationEnabled', false)) === true
  if (want === enabled) {
    if (want && !graph) await ensureMic()
    return
  }
  enabled = want
  if (want) {
    const ok = await ensureMic()
    emit(ok ? 'idle' : 'error')
  } else {
    await teardownMic()
    emit('off')
  }
}

/**
 * 啟動時掛一次：不論停在哪一頁都要能收熱鍵（使用者多半在別的程式裡按）
 */
export async function initDictation() {
  if (bound) return
  bound = true
  electronAPI.dictation?.onEvent((payload) => {
    const type = payload?.type
    if (type === 'start') startRecording()
    else if (type === 'stop') stopRecording()
    else if (type === 'cancel') cancelRecording()
    else if (type === 'busy') showToast('上一段還在處理中', 'error')
  })
  await refreshDictationRuntime()
}

