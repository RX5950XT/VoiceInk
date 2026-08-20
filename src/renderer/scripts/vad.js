/**
 * VoiceInk - 能量式語音活動偵測（VAD）
 *
 * 把連續的 PCM frame 切成「語句」，取代固定時長硬切：
 * - 遲滯門檻（on/off 不同值）避免字與字之間的短停頓被誤判成句尾
 * - pre-roll 滾動預錄，語音起點往前補一段，避免吃掉第一個字
 * - 最短長度擋雜訊、最長長度擋「一直講不停頓」導致延遲無限增長
 *
 * 純資料進出，無 DOM／AudioContext 依賴 → `node scripts/test-vad.js` 可直測。
 */

/** 系統音訊擷取沒有麥克風底噪（沒播東西時是數位靜音），門檻可以壓得比麥克風場景低 */
export const DEFAULT_VAD_OPTIONS = {
  sampleRate: 16000,
  /** 進入語音的 RMS 門檻 */
  onThreshold: 0.004,
  /** 離開語音的 RMS 門檻（低於 onThreshold 形成遲滯） */
  offThreshold: 0.002,
  /** 連續靜音多久判定句尾 */
  hangoverMs: 360,
  /** 語句起點往前保留多久 */
  preRollMs: 250,
  /** 短於此長度視為雜訊丟棄 */
  minUtteranceMs: 500,
  /** 超過此長度強制切段（連續講話不能無限等停頓） */
  maxUtteranceMs: 6000
}

/**
 * @param {Float32Array} frame
 * @returns {number}
 */
export function frameRms(frame) {
  let sum = 0
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
  return Math.sqrt(sum / Math.max(1, frame.length))
}

/**
 * @param {Float32Array[]} frames
 * @param {number} length
 * @returns {Float32Array}
 */
function concatFrames(frames, length) {
  const out = new Float32Array(length)
  let at = 0
  for (const f of frames) {
    out.set(f, at)
    at += f.length
  }
  return out
}

/**
 * @param {Partial<typeof DEFAULT_VAD_OPTIONS>} [options]
 */
export function createVad(options = {}) {
  const o = { ...DEFAULT_VAD_OPTIONS, ...options }
  const toSamples = (msValue) => Math.max(1, Math.round((msValue * o.sampleRate) / 1000))
  const hangoverSamples = toSamples(o.hangoverMs)
  const preRollSamples = toSamples(o.preRollMs)
  const minSamples = toSamples(o.minUtteranceMs)
  const maxSamples = toSamples(o.maxUtteranceMs)

  let speaking = false
  /** 連續低於 offThreshold 的樣本數 */
  let silence = 0
  /** @type {Float32Array[]} */
  let frames = []
  let length = 0
  /** @type {Float32Array[]} 尚未進入語音時的滾動預錄 */
  let preRoll = []
  let preRollLength = 0
  /** 起音時帶入的 pre-roll 長度：判斷「夠不夠長」時要扣掉，否則靜音也算進語句長度 */
  let leadSamples = 0

  /**
   * @param {boolean} continuing 是否仍在同一段語音中（強制切段用）
   * @returns {Float32Array}
   */
  function cut(continuing) {
    const out = concatFrames(frames, length)
    frames = []
    length = 0
    silence = 0
    speaking = continuing
    leadSamples = 0
    if (!continuing) {
      preRoll = []
      preRollLength = 0
    }
    return out
  }

  return {
    /**
     * 餵入一個 frame。呼叫端必須保證 frame 之後不再被改寫
     * （ScriptProcessor 的 inputBuffer 會重用，需先複製）。
     * @param {Float32Array} frame
     * @returns {{ level: number, utterance: Float32Array | null }}
     */
    push(frame) {
      const level = frameRms(frame)

      if (!speaking) {
        if (level < o.onThreshold) {
          preRoll.push(frame)
          preRollLength += frame.length
          while (preRoll.length > 1 && preRollLength - preRoll[0].length >= preRollSamples) {
            preRollLength -= preRoll.shift().length
          }
          return { level, utterance: null }
        }
        // 起音：把預錄接到語句前面，第一個字才不會被切掉
        speaking = true
        silence = 0
        frames = preRoll
        length = preRollLength
        leadSamples = preRollLength
        preRoll = []
        preRollLength = 0
      }

      frames.push(frame)
      length += frame.length
      silence = level < o.offThreshold ? silence + frame.length : 0

      if (silence >= hangoverSamples) {
        // 只算真正的語音：扣掉頭的 pre-roll 與尾的 hangover 靜音
        const enough = length - leadSamples - silence >= minSamples
        const out = cut(false)
        return { level, utterance: enough ? out : null }
      }
      if (length >= maxSamples) {
        return { level, utterance: cut(true) }
      }
      return { level, utterance: null }
    },

    reset() {
      speaking = false
      silence = 0
      frames = []
      length = 0
      leadSamples = 0
      preRoll = []
      preRollLength = 0
    },

    get speaking() {
      return speaking
    }
  }
}
