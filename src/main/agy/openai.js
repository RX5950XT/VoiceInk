'use strict'

const { randomUUID } = require('crypto')
const {
  finishReasonOf,
  firstCandidate,
  sanitizeSchema,
  splitParts,
  unwrapEnvelope,
  usageFrom
} = require('./gemini')
const { allowsZeroThinkingBudget, supportsThinking } = require('./model-map')

const MAX_OUTPUT_TOKENS = 65536
const DATA_URI = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/

/** Gemini → OpenAI 的終止原因 */
const FINISH_REASONS = Object.freeze({
  STOP: 'stop',
  MAX_TOKENS: 'length',
  SAFETY: 'content_filter',
  RECITATION: 'content_filter',
  PROHIBITED_CONTENT: 'content_filter',
  BLOCKLIST: 'content_filter'
})

// ===== 請求：OpenAI → Gemini =====

/**
 * content 可以是字串或 multi-part 陣列。
 * 圖片只收 data: URI——讓反代去下載客戶端指定的 http URL 等於開一個 SSRF 跳板。
 */
function contentToParts(content) {
  if (typeof content === 'string') {
    return content ? [{ text: content }] : []
  }
  if (!Array.isArray(content)) return []

  const parts = []
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    if (item.type === 'text' && typeof item.text === 'string' && item.text) {
      parts.push({ text: item.text })
      continue
    }
    if (item.type === 'image_url') {
      const url = typeof item.image_url?.url === 'string' ? item.image_url.url : ''
      const match = DATA_URI.exec(url)
      if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } })
    }
  }
  return parts
}

function parseArguments(raw) {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function toolsToDeclarations(tools) {
  if (!Array.isArray(tools)) return null
  const declarations = []
  for (const tool of tools) {
    const fn = tool?.function
    if (!fn || typeof fn.name !== 'string' || !fn.name) continue
    const declaration = { name: fn.name }
    if (typeof fn.description === 'string' && fn.description) {
      declaration.description = fn.description.slice(0, 4000)
    }
    const parameters = sanitizeSchema(fn.parameters)
    if (parameters) declaration.parameters = parameters
    declarations.push(declaration)
  }
  return declarations.length ? [{ functionDeclarations: declarations }] : null
}

/**
 * 把 OpenAI messages 攤平成 Gemini contents。
 * tool 角色要對應到前一則 assistant 發出的 functionCall 名稱，所以邊走邊記 id→name。
 */
function messagesToContents(messages) {
  const contents = []
  const systemTexts = []
  const toolNames = new Map()

  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue
    const role = typeof message.role === 'string' ? message.role : ''

    if (role === 'system' || role === 'developer') {
      for (const part of contentToParts(message.content)) {
        if (part.text) systemTexts.push(part.text)
      }
      continue
    }

    if (role === 'tool' || role === 'function') {
      const id = typeof message.tool_call_id === 'string' ? message.tool_call_id : ''
      const name = toolNames.get(id) || (typeof message.name === 'string' ? message.name : 'tool')
      const text = typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content ?? '')
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { name, response: { content: text } } }]
      })
      continue
    }

    if (role === 'assistant') {
      const parts = contentToParts(message.content)
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        const name = typeof call?.function?.name === 'string' ? call.function.name : ''
        if (!name) continue
        if (typeof call.id === 'string') toolNames.set(call.id, name)
        parts.push({ functionCall: { name, args: parseArguments(call.function?.arguments) } })
      }
      if (parts.length) contents.push({ role: 'model', parts })
      continue
    }

    const parts = contentToParts(message.content)
    if (parts.length) contents.push({ role: 'user', parts })
  }

  return { contents, systemTexts }
}

function buildGenerationConfig(body, mapped) {
  const config = {}
  const num = (value, min, max) => {
    const n = Number(value)
    return Number.isFinite(n) && n >= min && n <= max ? n : null
  }

  const temperature = num(body.temperature, 0, 2)
  if (temperature !== null) config.temperature = temperature
  const topP = num(body.top_p, 0, 1)
  if (topP !== null) config.topP = topP

  const maxTokens = num(body.max_completion_tokens ?? body.max_tokens, 1, MAX_OUTPUT_TOKENS)
  if (maxTokens !== null) config.maxOutputTokens = Math.floor(maxTokens)

  const stop = typeof body.stop === 'string' ? [body.stop] : body.stop
  if (Array.isArray(stop)) {
    const sequences = stop.filter((s) => typeof s === 'string' && s).slice(0, 5)
    if (sequences.length) config.stopSequences = sequences
  }

  // 沒明講就關掉思考：多數客戶端不會顯示 reasoning，開著只是白燒 token
  const wantsThinking = body.reasoning_effort !== undefined
    ? body.reasoning_effort !== 'none'
    : mapped.endsWith('-thinking')
  if (supportsThinking(mapped)) {
    // 關 thinking 時才送 thinkingBudget: 0（省 thinking token）；
    // 只能思考的模型收到 budget 0 會回 400，那些只送 includeThoughts:false。
    config.thinkingConfig = wantsThinking
      ? { includeThoughts: true }
      : allowsZeroThinkingBudget(mapped)
        ? { includeThoughts: false, thinkingBudget: 0 }
        : { includeThoughts: false }
  }

  return config
}

/**
 * @param {object} body OpenAI /v1/chat/completions 請求
 * @param {string} mapped 映射後的上游模型
 * @returns {object} Gemini inner request
 */
function toGeminiRequest(body, mapped) {
  const { contents, systemTexts } = messagesToContents(body.messages)
  const inner = {}

  if (systemTexts.length) {
    inner.systemInstruction = { role: 'user', parts: [{ text: systemTexts.join('\n\n') }] }
  }
  const tools = toolsToDeclarations(body.tools)
  if (tools) {
    inner.tools = tools
    if (body.tool_choice === 'none') {
      inner.toolConfig = { functionCallingConfig: { mode: 'NONE' } }
    } else if (body.tool_choice === 'required') {
      inner.toolConfig = { functionCallingConfig: { mode: 'ANY' } }
    }
  }
  const generationConfig = buildGenerationConfig(body, mapped)
  if (Object.keys(generationConfig).length) inner.generationConfig = generationConfig

  // contents 放最後：前面都是穩定內容，有利上游前綴快取
  inner.contents = contents.length ? contents : [{ role: 'user', parts: [{ text: '' }] }]
  return inner
}

// ===== 回應：Gemini → OpenAI =====

function createCollector(model, nowMs = Date.now()) {
  return {
    id: `chatcmpl-${randomUUID().replace(/-/g, '')}`,
    created: Math.floor(nowMs / 1000),
    model,
    text: '',
    reasoning: '',
    calls: [],
    usage: null,
    finish: '',
    roleSent: false
  }
}

function chunkOf(collector, delta, finishReason) {
  return {
    id: collector.id,
    object: 'chat.completion.chunk',
    created: collector.created,
    model: collector.model,
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null }]
  }
}

function sse(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/**
 * 吃一格上游 SSE，回傳要往客戶端寫的 OpenAI chunk（可能是空字串）。
 * 同時把內容累積在 collector 上，非串流模式靠這份累積產出最終回應。
 */
function consume(collector, payload) {
  const inner = unwrapEnvelope(payload)
  if (!inner) return ''

  const usage = usageFrom(inner)
  if (usage) collector.usage = usage

  const candidate = firstCandidate(inner)
  if (!candidate) return ''

  const { text, reasoning, calls } = splitParts(candidate)
  const reason = finishReasonOf(candidate)
  if (reason) collector.finish = reason

  let out = ''
  if (!collector.roleSent && (text || reasoning || calls.length)) {
    collector.roleSent = true
    out += sse(chunkOf(collector, { role: 'assistant', content: '' }))
  }
  if (reasoning) {
    collector.reasoning += reasoning
    out += sse(chunkOf(collector, { reasoning_content: reasoning }))
  }
  if (text) {
    collector.text += text
    out += sse(chunkOf(collector, { content: text }))
  }
  for (const call of calls) {
    const index = collector.calls.length
    const id = `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`
    collector.calls.push({ id, name: call.name, args: call.args })
    out += sse(chunkOf(collector, {
      tool_calls: [{
        index,
        id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args) }
      }]
    }))
  }
  return out
}

function finishReasonFor(collector) {
  if (collector.calls.length) return 'tool_calls'
  return FINISH_REASONS[collector.finish] || 'stop'
}

function usagePayload(collector) {
  const usage = collector.usage
  if (!usage) return undefined
  const payload = {
    prompt_tokens: usage.input,
    completion_tokens: usage.output,
    total_tokens: usage.total
  }
  if (usage.cached) payload.prompt_tokens_details = { cached_tokens: usage.cached }
  if (usage.thought) payload.completion_tokens_details = { reasoning_tokens: usage.thought }
  return payload
}

/** 串流收尾：finish_reason chunk（帶 usage）＋ [DONE] */
function closeStream(collector) {
  const chunk = chunkOf(collector, {}, finishReasonFor(collector))
  const usage = usagePayload(collector)
  if (usage) chunk.usage = usage
  return `${sse(chunk)}data: [DONE]\n\n`
}

/** 非串流：把累積結果組成一個完整回應 */
function toResponse(collector) {
  const message = { role: 'assistant', content: collector.text || null }
  if (collector.reasoning) message.reasoning_content = collector.reasoning
  if (collector.calls.length) {
    message.tool_calls = collector.calls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.args) }
    }))
  }
  const response = {
    id: collector.id,
    object: 'chat.completion',
    created: collector.created,
    model: collector.model,
    choices: [{ index: 0, message, finish_reason: finishReasonFor(collector) }]
  }
  const usage = usagePayload(collector)
  if (usage) response.usage = usage
  return response
}

/** 串流中途出錯：客戶端已經收到 200，只能用一格 error chunk 告知 */
function errorStream(collector, code) {
  return `${sse({
    id: collector.id,
    object: 'chat.completion.chunk',
    created: collector.created,
    model: collector.model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    error: { message: code, type: 'upstream_error', code }
  })}data: [DONE]\n\n`
}

module.exports = {
  closeStream,
  consume,
  createCollector,
  errorStream,
  toGeminiRequest,
  toResponse
}
