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
const DEFAULT_MAX_TOKENS = 8192

/** Gemini → Anthropic 的 stop_reason */
const STOP_REASONS = Object.freeze({
  STOP: 'end_turn',
  MAX_TOKENS: 'max_tokens',
  SAFETY: 'refusal',
  RECITATION: 'refusal',
  PROHIBITED_CONTENT: 'refusal',
  BLOCKLIST: 'refusal'
})

// ===== 請求：Anthropic → Gemini =====

function systemToText(system) {
  if (typeof system === 'string') return system
  if (!Array.isArray(system)) return ''
  return system
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n\n')
}

function toolResultText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return JSON.stringify(content ?? '')
  return content
    .map((block) => (block?.type === 'text' && typeof block.text === 'string'
      ? block.text
      : JSON.stringify(block)))
    .join('\n')
}

/**
 * 一則 Anthropic message 的 content blocks → Gemini parts。
 * tool_result 出現在 user 訊息裡，但 Gemini 的 functionResponse 需要工具「名稱」而非 id，
 * 所以要靠 toolNames（前面 assistant 的 tool_use 記下來的 id→name）補齊。
 */
function blocksToParts(content, toolNames) {
  if (typeof content === 'string') return content ? [{ text: content }] : []
  if (!Array.isArray(content)) return []

  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue

    if (block.type === 'text' && typeof block.text === 'string' && block.text) {
      parts.push({ text: block.text })
      continue
    }
    if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
      // 歷史思考內容不回送上游：沒有原始 signature，送回去只會被拒
      continue
    }
    if (block.type === 'image') {
      const source = block.source
      if (source?.type === 'base64' && typeof source.data === 'string' && typeof source.media_type === 'string') {
        parts.push({ inlineData: { mimeType: source.media_type, data: source.data } })
      }
      continue
    }
    if (block.type === 'tool_use' && typeof block.name === 'string' && block.name) {
      if (typeof block.id === 'string') toolNames.set(block.id, block.name)
      const args = block.input && typeof block.input === 'object' ? block.input : {}
      parts.push({ functionCall: { name: block.name, args } })
      continue
    }
    if (block.type === 'tool_result') {
      const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
      const name = toolNames.get(id) || 'tool'
      parts.push({
        functionResponse: { name, response: { content: toolResultText(block.content) } }
      })
    }
  }
  return parts
}

function toolsToDeclarations(tools) {
  if (!Array.isArray(tools)) return null
  const declarations = []
  for (const tool of tools) {
    if (!tool || typeof tool.name !== 'string' || !tool.name) continue
    // server 端內建工具（web_search 之類）沒有 input_schema，跳過
    if (typeof tool.type === 'string' && tool.type.startsWith('web_')) continue
    const declaration = { name: tool.name }
    if (typeof tool.description === 'string' && tool.description) {
      declaration.description = tool.description.slice(0, 4000)
    }
    const parameters = sanitizeSchema(tool.input_schema)
    if (parameters) declaration.parameters = parameters
    declarations.push(declaration)
  }
  return declarations.length ? [{ functionDeclarations: declarations }] : null
}

function buildGenerationConfig(body, mapped) {
  const config = {}
  const temperature = Number(body.temperature)
  if (Number.isFinite(temperature) && temperature >= 0 && temperature <= 2) {
    config.temperature = temperature
  }
  const topP = Number(body.top_p)
  if (Number.isFinite(topP) && topP >= 0 && topP <= 1) config.topP = topP

  const maxTokens = Number(body.max_tokens)
  config.maxOutputTokens = Number.isFinite(maxTokens) && maxTokens >= 1
    ? Math.min(Math.floor(maxTokens), MAX_OUTPUT_TOKENS)
    : DEFAULT_MAX_TOKENS

  if (Array.isArray(body.stop_sequences)) {
    const sequences = body.stop_sequences.filter((s) => typeof s === 'string' && s).slice(0, 5)
    if (sequences.length) config.stopSequences = sequences
  }

  if (supportsThinking(mapped)) {
    const enabled = body.thinking?.type === 'enabled' || mapped.endsWith('-thinking')
    if (enabled) {
      const budget = Number(body.thinking?.budget_tokens)
      config.thinkingConfig = Number.isFinite(budget) && budget > 0
        ? { includeThoughts: true, thinkingBudget: Math.floor(budget) }
        : { includeThoughts: true }
    } else {
      // 同 openai.js：thinking-only 模型收到 budget 0 會 400
      config.thinkingConfig = allowsZeroThinkingBudget(mapped)
        ? { includeThoughts: false, thinkingBudget: 0 }
        : { includeThoughts: false }
    }
  }
  return config
}

/**
 * @param {object} body Anthropic /v1/messages 請求
 * @param {string} mapped 映射後的上游模型
 */
function toGeminiRequest(body, mapped) {
  const inner = {}
  const toolNames = new Map()

  const system = systemToText(body.system)
  if (system) inner.systemInstruction = { role: 'user', parts: [{ text: system }] }

  const tools = toolsToDeclarations(body.tools)
  if (tools) {
    inner.tools = tools
    const choice = body.tool_choice?.type
    if (choice === 'none') inner.toolConfig = { functionCallingConfig: { mode: 'NONE' } }
    else if (choice === 'any' || choice === 'tool') {
      inner.toolConfig = { functionCallingConfig: { mode: 'ANY' } }
    }
  }

  inner.generationConfig = buildGenerationConfig(body, mapped)

  const contents = []
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (!message || typeof message !== 'object') continue
    const parts = blocksToParts(message.content, toolNames)
    if (!parts.length) continue
    contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts })
  }
  inner.contents = contents.length ? contents : [{ role: 'user', parts: [{ text: '' }] }]
  return inner
}

// ===== 回應：Gemini → Anthropic =====

function createCollector(model) {
  return {
    id: `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    model,
    text: '',
    reasoning: '',
    calls: [],
    usage: null,
    finish: '',
    started: false,
    blockIndex: -1,
    blockType: ''
  }
}

function event(type, payload) {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`
}

function closeBlock(collector) {
  if (collector.blockType === '') return ''
  const out = event('content_block_stop', {
    type: 'content_block_stop',
    index: collector.blockIndex
  })
  collector.blockType = ''
  return out
}

function openBlock(collector, type, block) {
  let out = closeBlock(collector)
  collector.blockIndex += 1
  collector.blockType = type
  out += event('content_block_start', {
    type: 'content_block_start',
    index: collector.blockIndex,
    content_block: block
  })
  return out
}

function messageStart(collector) {
  collector.started = true
  return event('message_start', {
    type: 'message_start',
    message: {
      id: collector.id,
      type: 'message',
      role: 'assistant',
      model: collector.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: collector.usage?.input ?? 0, output_tokens: 0 }
    }
  })
}

/** 吃一格上游 SSE，回傳要往客戶端寫的 Anthropic 事件（可能是空字串） */
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
  if (!collector.started && (text || reasoning || calls.length)) out += messageStart(collector)

  if (reasoning) {
    if (collector.blockType !== 'thinking') {
      out += openBlock(collector, 'thinking', { type: 'thinking', thinking: '' })
    }
    collector.reasoning += reasoning
    out += event('content_block_delta', {
      type: 'content_block_delta',
      index: collector.blockIndex,
      delta: { type: 'thinking_delta', thinking: reasoning }
    })
  }

  if (text) {
    if (collector.blockType !== 'text') {
      out += openBlock(collector, 'text', { type: 'text', text: '' })
    }
    collector.text += text
    out += event('content_block_delta', {
      type: 'content_block_delta',
      index: collector.blockIndex,
      delta: { type: 'text_delta', text }
    })
  }

  for (const call of calls) {
    const id = `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`
    collector.calls.push({ id, name: call.name, args: call.args })
    // Gemini 一次給完整 args，不需要拆成多格 input_json_delta
    out += openBlock(collector, 'tool_use', {
      type: 'tool_use', id, name: call.name, input: {}
    })
    out += event('content_block_delta', {
      type: 'content_block_delta',
      index: collector.blockIndex,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.args) }
    })
  }

  return out
}

function stopReasonFor(collector) {
  if (collector.calls.length) return 'tool_use'
  return STOP_REASONS[collector.finish] || 'end_turn'
}

function closeStream(collector) {
  let out = collector.started ? '' : messageStart(collector)
  out += closeBlock(collector)
  out += event('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReasonFor(collector), stop_sequence: null },
    usage: { output_tokens: collector.usage?.output ?? 0 }
  })
  out += event('message_stop', { type: 'message_stop' })
  return out
}

function toResponse(collector) {
  const content = []
  if (collector.reasoning) content.push({ type: 'thinking', thinking: collector.reasoning })
  if (collector.text) content.push({ type: 'text', text: collector.text })
  for (const call of collector.calls) {
    content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args })
  }
  if (!content.length) content.push({ type: 'text', text: '' })

  return {
    id: collector.id,
    type: 'message',
    role: 'assistant',
    model: collector.model,
    content,
    stop_reason: stopReasonFor(collector),
    stop_sequence: null,
    usage: {
      input_tokens: collector.usage?.input ?? 0,
      output_tokens: collector.usage?.output ?? 0,
      ...(collector.usage?.cached ? { cache_read_input_tokens: collector.usage.cached } : {})
    }
  }
}

/**
 * 串流中途出錯：Anthropic 的錯誤事件型別是 `error`。
 * 先把開著的 content block 收掉——已經送出 `content_block_start` 卻沒有對應的
 * `content_block_stop`，會讓照著協議追蹤區塊狀態的客戶端停在半開狀態。
 */
function errorStream(collector, code) {
  return closeBlock(collector) +
    event('error', { type: 'error', error: { type: 'api_error', message: code } })
}

module.exports = {
  closeStream,
  consume,
  createCollector,
  errorStream,
  toGeminiRequest,
  toResponse
}
