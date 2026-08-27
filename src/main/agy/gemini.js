'use strict'

/**
 * cloudcode-pa（Gemini）側的共用工具：信封拆解、usage 萃取、parts 分類。
 *
 * OpenAI 與 Anthropic 兩套轉換器都要用同一份，別各寫一份——
 * usage 的新舊格式判斷只要有一邊漏掉，統計就會悄悄少算 thinking token。
 */

/** 上游 SSE 每一格都包一層 `response`，非串流則直接是本體 */
function unwrapEnvelope(payload) {
  if (!payload || typeof payload !== 'object') return null
  const inner = payload.response
  if (inner && typeof inner === 'object') return inner
  return payload
}

/**
 * Gemini usageMetadata → 統一的 token 計數。
 *
 * 語意差異（照抄上游行為，不要「簡化」）：
 * - 舊格式 candidatesTokenCount 已含 thinking 與 tool-use
 * - 新格式 total_output_tokens 只含文字與 tool 輸出，thought 要自己加回去
 * 判斷依據是「有沒有 total_output_tokens 這個欄位」，不是看值。
 *
 * @returns {{ input: number, output: number, thought: number, cached: number, total: number }}
 */
function extractUsage(usageMetadata) {
  const u = usageMetadata && typeof usageMetadata === 'object' ? usageMetadata : {}
  const num = (...keys) => {
    for (const key of keys) {
      const value = Number(u[key])
      if (Number.isFinite(value) && value >= 0) return Math.floor(value)
    }
    return 0
  }

  const input = num('total_input_tokens', 'promptTokenCount')
  const rawOutput = num('total_output_tokens', 'candidatesTokenCount')
  const thought = num('total_thought_tokens', 'totalThoughtTokens', 'thoughtsTokenCount')
  const toolUse = num('total_tool_use_tokens')
  const cached = num('total_cached_tokens', 'cachedContentTokenCount', 'cachedTokens')

  const isNewFormat = Object.prototype.hasOwnProperty.call(u, 'total_output_tokens')
  const output = isNewFormat ? rawOutput + thought + toolUse : rawOutput

  const declaredTotal = num('total_tokens', 'totalTokenCount')
  return {
    input,
    output,
    thought,
    cached,
    total: declaredTotal || input + output
  }
}

/** 有 usageMetadata 才回傳，避免用空值蓋掉稍早收到的真實計數 */
function usageFrom(inner) {
  if (!inner || typeof inner !== 'object') return null
  if (!inner.usageMetadata || typeof inner.usageMetadata !== 'object') return null
  return extractUsage(inner.usageMetadata)
}

function firstCandidate(inner) {
  const candidates = inner && Array.isArray(inner.candidates) ? inner.candidates : []
  return candidates.length ? candidates[0] : null
}

/**
 * 把一個 candidate 的 parts 拆成三類。
 * thought part 帶 `thought: true`，一定要跟正文分開，否則思考過程會混進答案。
 * @returns {{ text: string, reasoning: string, calls: Array<{name: string, args: object}> }}
 */
function splitParts(candidate) {
  const parts = candidate && Array.isArray(candidate.content?.parts) ? candidate.content.parts : []
  let text = ''
  let reasoning = ''
  const calls = []

  for (const part of parts) {
    if (!part || typeof part !== 'object') continue
    if (part.functionCall && typeof part.functionCall === 'object') {
      const name = typeof part.functionCall.name === 'string' ? part.functionCall.name : ''
      if (name) {
        const args = part.functionCall.args
        calls.push({ name, args: args && typeof args === 'object' ? args : {} })
      }
      continue
    }
    if (typeof part.text !== 'string' || !part.text) continue
    if (part.thought === true) reasoning += part.text
    else text += part.text
  }

  return { text, reasoning, calls }
}

/** Gemini finishReason → 兩套協議各自的終止原因由呼叫端再翻譯 */
function finishReasonOf(candidate) {
  const raw = candidate && typeof candidate.finishReason === 'string' ? candidate.finishReason : ''
  return raw.toUpperCase()
}

/**
 * Gemini 的 function declaration schema 只吃 OpenAPI 子集。
 * 客戶端（尤其 MCP 工具）送來的完整 JSON Schema 帶著 $schema／additionalProperties／
 * oneOf 這些關鍵字，原樣轉送上游會直接 400 INVALID_ARGUMENT，所以走白名單。
 */
const SCHEMA_KEYS = Object.freeze([
  'type', 'description', 'enum', 'nullable', 'required', 'minimum', 'maximum',
  'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'example'
])
const SCHEMA_FORMATS = Object.freeze(new Set(['date-time', 'enum', 'int32', 'int64', 'float', 'double']))
const SCHEMA_MAX_DEPTH = 12

/** `{type:'null'}` 或 `{type:['null']}`：JSON Schema 用來表示「可以是 null」的那一支 */
function isNullOnly(item) {
  if (!item || typeof item !== 'object') return false
  const type = item.type
  if (typeof type === 'string') return type.toLowerCase() === 'null'
  if (Array.isArray(type) && type.length) return type.every((t) => String(t).toLowerCase() === 'null')
  return false
}

function sanitizeSchema(raw, depth = 0) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (depth > SCHEMA_MAX_DEPTH) return { type: 'string' }

  const out = {}
  for (const key of SCHEMA_KEYS) {
    if (raw[key] !== undefined) out[key] = raw[key]
  }

  // JSON Schema 允許 `type: ['string','null']`，但 Gemini 的 Schema proto 的 type 是單一 enum，
  // 送陣列會 400 Unknown name "type" ... Proto field is not repeating, cannot start list。
  // 取第一個非 null 的型別，null 改用 nullable 表示。
  if (Array.isArray(out.type)) {
    const types = out.type.filter((t) => typeof t === 'string')
    if (types.some((t) => t.toLowerCase() === 'null')) out.nullable = true
    const primary = types.find((t) => t.toLowerCase() !== 'null')
    if (primary) out.type = primary
    else delete out.type
  }
  if (out.type !== undefined && typeof out.type !== 'string') delete out.type
  if (typeof out.type === 'string') out.type = out.type.toLowerCase()
  // Gemini 沒有 null 型別，改用 nullable 表示
  if (out.type === 'null') {
    out.nullable = true
    delete out.type
  }

  // const 是 Gemini 不認的關鍵字，語意上等同單值 enum
  if (raw.const !== undefined && out.enum === undefined) out.enum = [raw.const]
  // Gemini 的 enum 只吃「字串陣列 + type: string」。MCP 工具常見的 `{type:'boolean',enum:[true]}`
  // （anyOf 的判別欄位）原樣送上去會 400 Invalid value at ...properties[0].value.enum[0]，
  // 整個工具連帶不能用。約束丟掉還有 description 撐著，比整包請求被拒好。
  if (out.enum !== undefined) {
    const values = Array.isArray(out.enum) ? out.enum.filter((v) => typeof v === 'string' && v) : []
    if (values.length && (out.type === undefined || String(out.type).toLowerCase() === 'string')) {
      out.enum = values
      out.type = 'string'
    } else {
      delete out.enum
    }
  }
  if (typeof raw.format === 'string' && SCHEMA_FORMATS.has(raw.format)) out.format = raw.format

  if (raw.properties && typeof raw.properties === 'object') {
    const properties = {}
    for (const [name, value] of Object.entries(raw.properties)) {
      const child = sanitizeSchema(value, depth + 1)
      if (child) properties[name] = child
    }
    if (Object.keys(properties).length) {
      out.properties = properties
      if (!out.type) out.type = 'object'
    }
  }

  if (raw.items) {
    const items = sanitizeSchema(raw.items, depth + 1)
    if (items) {
      out.items = items
      if (!out.type) out.type = 'array'
    }
  }

  // Gemini 只支援 anyOf；oneOf/allOf 降級成 anyOf 比整個丟掉好
  const union = Array.isArray(raw.anyOf) ? raw.anyOf
    : Array.isArray(raw.oneOf) ? raw.oneOf
      : Array.isArray(raw.allOf) ? raw.allOf
        : null
  if (union) {
    // `anyOf: [X, {type:'null'}]`（optional 欄位的常見寫法）要把 null 那支拿掉：
    // Gemini 沒有 null 型別，留著會變成一支空殼 object 變體，語意跟著壞掉。
    const variants = []
    for (const item of union) {
      if (isNullOnly(item)) {
        out.nullable = true
        continue
      }
      const variant = sanitizeSchema(item, depth + 1)
      if (variant) variants.push(variant)
    }
    // 只剩一支就攤平，省掉沒有意義的 anyOf
    if (variants.length === 1) {
      for (const [key, value] of Object.entries(variants[0])) {
        if (out[key] === undefined) out[key] = value
      }
    } else if (variants.length) {
      out.anyOf = variants
    }
  }

  if (!out.type && !out.anyOf) out.type = 'object'
  if (out.type === 'object' && !out.properties && !out.anyOf) {
    // 沒有屬性的 object 會被上游拒絕，補一個空殼
    out.properties = {}
  }
  if (Array.isArray(out.required)) {
    out.required = out.required.filter((name) => typeof name === 'string')
    if (!out.required.length) delete out.required
  }
  return out
}

module.exports = {
  extractUsage,
  finishReasonOf,
  firstCandidate,
  sanitizeSchema,
  splitParts,
  unwrapEnvelope,
  usageFrom
}
