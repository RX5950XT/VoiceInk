/**
 * VoiceInk - 聊天取樣參數（Main Process）
 *
 * 形狀：只有「使用者勾選的」參數才出現在物件裡，沒出現＝不送。
 * **不送是刻意的**：OpenAI 官方端點遇到 `top_k`／`min_p` 這類不認得的欄位會直接 400，
 * 所以不能一律帶預設值，只能使用者明確打開的才帶。
 *
 * 每個對話各存一份（`chats.json` 的 `params`），`chatParams`（設定 store）是新對話的預設值。
 * renderer 的面板有一份同樣的範圍表，但那只是 UI；真正的邊界在這裡。
 */

/** @typedef {{ min: number, max: number, int?: boolean }} NumberSpec */

/**
 * 只留幾乎每一家 OpenAI 相容端點都吃的：temperature、top_p、max_tokens、stop。
 * top_k／min_p／repeat／presence／frequency penalty／seed 各家支援不一（有的直接 400、有的靜靜忽略），
 * 刻意不收——舊資料裡有這些欄位時 sanitize 會丟掉，不會再送出去。
 * @type {Record<string, NumberSpec>}
 */
const NUMBER_SPECS = Object.freeze({
  temperature: { min: 0, max: 2 },
  topP: { min: 0, max: 1 },
  maxTokens: { min: 1, max: 1_000_000, int: true },
  /** 只帶最近幾則訊息當上下文（不送上游，是組 messages 時用的，所以任何端點都適用） */
  contextCount: { min: 1, max: 500, int: true }
})

const MAX_STOP = 4
const MAX_STOP_LENGTH = 64

/**
 * @typedef {{ temperature?: number, topP?: number, maxTokens?: number, contextCount?: number,
 *   stop?: string[] }} ChatParams
 */

/**
 * 不合法的值直接丟掉（等於沒勾），超出範圍的夾回邊界。
 * @param {unknown} raw
 * @returns {ChatParams}
 */
function sanitize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  /** @type {ChatParams} */
  const out = {}
  for (const [key, spec] of Object.entries(NUMBER_SPECS)) {
    const value = raw[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    const clamped = Math.min(spec.max, Math.max(spec.min, value))
    out[key] = spec.int ? Math.round(clamped) : Math.round(clamped * 1000) / 1000
  }
  if (Array.isArray(raw.stop)) {
    const stop = [...new Set(raw.stop.filter((s) => typeof s === 'string' && s.length)
      .map((s) => s.slice(0, MAX_STOP_LENGTH)))].slice(0, MAX_STOP)
    if (stop.length) out.stop = stop
  }
  return out
}

/**
 * 轉成 chat completions 的欄位（`contextCount` 不送上游）
 * @param {ChatParams} params
 * @returns {Record<string, unknown>}
 */
function toRequestFields(params) {
  const p = sanitize(params)
  /** @type {Record<string, unknown>} */
  const body = {}
  if (p.temperature !== undefined) body.temperature = p.temperature
  if (p.topP !== undefined) body.top_p = p.topP
  if (p.maxTokens !== undefined) body.max_tokens = p.maxTokens
  if (p.stop) body.stop = p.stop
  return body
}

module.exports = { sanitize, toRequestFields, NUMBER_SPECS }
