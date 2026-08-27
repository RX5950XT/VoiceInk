'use strict'

/**
 * AGY 反代轉換器測試（純函式，node 直跑，無 electron 依賴）
 *   node scripts/test-agy-mappers.js
 */

const assert = require('assert')
const path = require('path')

const AGY = path.join(__dirname, '..', 'src', 'main', 'agy')
const catalog = require(path.join(AGY, 'catalog'))
const gemini = require(path.join(AGY, 'gemini'))
const modelMap = require(path.join(AGY, 'model-map'))
const openai = require(path.join(AGY, 'openai'))
const anthropic = require(path.join(AGY, 'anthropic'))

let passed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  FAIL  ${name}\n        ${error.message}`)
  }
}

/** 把 SSE 字串拆成 data payload 陣列（略過 [DONE]） */
function dataFrames(sse) {
  return sse.split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6))
    .filter((raw) => raw !== '[DONE]')
    .map((raw) => JSON.parse(raw))
}

/** 把 SSE 字串拆成 event 名稱序列 */
function eventNames(sse) {
  return sse.split('\n')
    .filter((line) => line.startsWith('event: '))
    .map((line) => line.slice(7))
}

/** 上游一格：包 response 信封 */
function frame(parts, extra = {}) {
  return {
    response: {
      candidates: [{ content: { parts, role: 'model' }, ...extra.candidate }],
      ...(extra.usageMetadata ? { usageMetadata: extra.usageMetadata } : {})
    }
  }
}

console.log('\n模型映射')

test('精確表命中（Claude Code CLI 送的死模型名）', () => {
  // 不是 -thinking：那個上游回 404（實測 sandbox／daily 皆然）
  assert.strictEqual(modelMap.resolveModel('claude-sonnet-4-5-20250929').mapped, 'claude-sonnet-4-6')
  assert.strictEqual(modelMap.resolveModel('claude-3-5-sonnet-20241022').mapped, 'claude-sonnet-4-6')
  assert.strictEqual(modelMap.resolveModel('gemini-3-pro-high').mapped, 'gemini-pro-agent')
})

// 映射表只翻譯「上游沒有的名字」；真實存在的 id 一律透傳，不可覆蓋使用者的明確選擇
test('上游真實 ID 原樣保留', () => {
  const result = modelMap.resolveModel('gemini-3-flash')
  assert.strictEqual(result.mapped, 'gemini-3-flash')
  assert.strictEqual(result.known, true)
})

test('前綴規則涵蓋 gpt-* 與舊 gemini', () => {
  assert.strictEqual(modelMap.resolveModel('gpt-4o-mini').mapped, 'gemini-pro-agent')
  assert.strictEqual(modelMap.resolveModel('gemini-2.5-flash-002').mapped, 'gemini-3.7-flash-medium')
  assert.strictEqual(modelMap.resolveModel('claude-opus-4-1-20250805').mapped, 'claude-opus-4-6-thinking')
})

test('表外名稱透傳，且標記 known=false', () => {
  const result = modelMap.resolveModel('gemini-4-experimental')
  assert.strictEqual(result.mapped, 'gemini-4-experimental')
  assert.strictEqual(result.known, false)
})

test('不安全字元退回預設模型（擋路徑穿越與 header 注入）', () => {
  assert.strictEqual(modelMap.resolveModel('../../etc/passwd').mapped, modelMap.DEFAULT_MODEL)
  assert.strictEqual(modelMap.resolveModel('gemini\r\nX-Injected: 1').mapped, modelMap.DEFAULT_MODEL)
  assert.strictEqual(modelMap.resolveModel('a b').mapped, modelMap.DEFAULT_MODEL)
  assert.strictEqual(modelMap.resolveModel('').mapped, modelMap.DEFAULT_MODEL)
  assert.strictEqual(modelMap.resolveModel(null).mapped, modelMap.DEFAULT_MODEL)
})

/**
 * 這條是這批 bug 的總防線：整張表只要有一個目標指到上游不存在的模型，
 * 對應的客戶端就是直接 404／500。清單依實測（scripts/probe-agy-upstream.js）維護。
 */
test('映射目標都在實測可用的模型清單內', () => {
  const VERIFIED_OK = new Set([
    'gemini-3.7-flash-high', 'gemini-3.7-flash-medium', 'gemini-3.7-flash-low',
    'gemini-3-flash', 'gemini-pro-agent', 'gemini-3.1-pro-low',
    'gemini-2.5-flash', 'claude-sonnet-4-6', 'claude-opus-4-6-thinking'
  ])
  const names = [
    'gpt-4o', 'gpt-5', 'o1-preview', 'o3-mini', 'gpt-3.5-turbo',
    'claude-sonnet-4-5-20250929', 'claude-sonnet-4-6-thinking', 'claude-opus-4-6',
    'claude-3-5-sonnet-20241022', 'claude-haiku-4-5-20251001',
    'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3-pro', 'gemini-3.1-pro',
    'gemini-3-pro-high', 'gemini-3.1-pro-high'
  ]
  for (const name of names) {
    const { mapped } = modelMap.resolveModel(name)
    assert.ok(VERIFIED_OK.has(mapped), `${name} → ${mapped} 不在實測可用清單`)
  }
  assert.ok(VERIFIED_OK.has(modelMap.DEFAULT_MODEL), 'DEFAULT_MODEL 必須是實測可用的模型')
})

test('拒絕 budget 0 的模型不得收到 thinkingBudget: 0', () => {
  assert.strictEqual(modelMap.allowsZeroThinkingBudget('gemini-pro-agent'), false)
  assert.strictEqual(modelMap.allowsZeroThinkingBudget('gemini-3.1-pro-low'), false)
  // 3.6 系列回的是 "Request contains an invalid argument"，跟別人不同訊息，實測才抓得到
  assert.strictEqual(modelMap.allowsZeroThinkingBudget('gemini-3.6-flash-medium'), false)
  assert.strictEqual(modelMap.allowsZeroThinkingBudget('gpt-oss-120b-medium'), false)
  // 名字有 thinking 但實測接受 budget 0，不能只看名字
  assert.strictEqual(modelMap.allowsZeroThinkingBudget('claude-opus-4-6-thinking'), true)
  assert.strictEqual(modelMap.allowsZeroThinkingBudget('gemini-3.7-flash-medium'), true)

  const off = openai.toGeminiRequest(
    { model: 'gemini-3.7-flash-medium', messages: [{ role: 'user', content: 'hi' }] },
    'gemini-3.7-flash-medium'
  )
  assert.strictEqual(off.generationConfig.thinkingConfig.thinkingBudget, 0)

  const forced = openai.toGeminiRequest(
    { model: 'gemini-pro-agent', messages: [{ role: 'user', content: 'hi' }] }, 'gemini-pro-agent'
  )
  assert.ok(!('thinkingBudget' in forced.generationConfig.thinkingConfig))
})

test('OpenRouter 風格的斜線模型名可以透傳', () => {
  assert.strictEqual(modelMap.resolveModel('google/gemini-3-flash').mapped, 'google/gemini-3-flash')
})

test('listModels 回 OpenAI 形狀', () => {
  const list = modelMap.listModels(1_700_000_000_000)
  assert.ok(list.length >= 5)
  assert.strictEqual(list[0].object, 'model')
  assert.strictEqual(list[0].created, 1_700_000_000)
})

console.log('\nGemini 共用工具')

test('unwrapEnvelope 拆掉 response 信封，非串流原樣回', () => {
  assert.deepStrictEqual(gemini.unwrapEnvelope({ response: { candidates: [] } }), { candidates: [] })
  assert.deepStrictEqual(gemini.unwrapEnvelope({ candidates: [1] }), { candidates: [1] })
  assert.strictEqual(gemini.unwrapEnvelope(null), null)
})

test('舊格式 usage：candidatesTokenCount 已含 thinking，不重複加', () => {
  const usage = gemini.extractUsage({
    promptTokenCount: 100,
    candidatesTokenCount: 50,
    thoughtsTokenCount: 20,
    totalTokenCount: 150
  })
  assert.strictEqual(usage.input, 100)
  assert.strictEqual(usage.output, 50)
  assert.strictEqual(usage.thought, 20)
  assert.strictEqual(usage.total, 150)
})

test('新格式 usage：total_output_tokens 不含 thought/tool，要加回', () => {
  const usage = gemini.extractUsage({
    total_input_tokens: 100,
    total_output_tokens: 50,
    total_thought_tokens: 20,
    total_tool_use_tokens: 5
  })
  assert.strictEqual(usage.output, 75, 'output 應為 50+20+5')
  assert.strictEqual(usage.total, 175)
})

test('新格式判斷看欄位存在與否，不是看值', () => {
  const usage = gemini.extractUsage({
    total_input_tokens: 10,
    total_output_tokens: 0,
    total_thought_tokens: 30
  })
  assert.strictEqual(usage.output, 30, 'total_output_tokens=0 仍是新格式')
})

test('usageFrom 沒有 usageMetadata 時回 null（不覆蓋先前計數）', () => {
  assert.strictEqual(gemini.usageFrom({ candidates: [] }), null)
  assert.ok(gemini.usageFrom({ usageMetadata: { promptTokenCount: 1 } }))
})

test('splitParts 把 thought 與正文分開', () => {
  const result = gemini.splitParts({
    content: {
      parts: [
        { text: '想一下', thought: true },
        { text: '答案' },
        { functionCall: { name: 'get_weather', args: { city: 'Taipei' } } }
      ]
    }
  })
  assert.strictEqual(result.reasoning, '想一下')
  assert.strictEqual(result.text, '答案')
  assert.strictEqual(result.calls.length, 1)
  assert.strictEqual(result.calls[0].name, 'get_weather')
})

console.log('\nJSON Schema 清理')

test('剝掉 Gemini 會拒絕的關鍵字', () => {
  const cleaned = gemini.sanitizeSchema({
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    additionalProperties: false,
    properties: { city: { type: 'string', description: '城市' } },
    required: ['city']
  })
  assert.strictEqual(cleaned.$schema, undefined)
  assert.strictEqual(cleaned.additionalProperties, undefined)
  assert.deepStrictEqual(cleaned.required, ['city'])
  assert.strictEqual(cleaned.properties.city.description, '城市')
})

test('const → enum、oneOf → anyOf', () => {
  const cleaned = gemini.sanitizeSchema({
    type: 'object',
    properties: {
      mode: { const: 'fast' },
      value: { oneOf: [{ type: 'string' }, { type: 'number' }] }
    }
  })
  assert.deepStrictEqual(cleaned.properties.mode.enum, ['fast'])
  assert.strictEqual(cleaned.properties.value.anyOf.length, 2)
  assert.strictEqual(cleaned.properties.value.oneOf, undefined)
})

test('非字串 enum 一律剝掉（Gemini 只接受 type:string 的字串 enum）', () => {
  // MCP 工具常見的判別欄位：{type:'boolean', enum:[true]}。
  // 原樣送上去會 400 Invalid value at ...properties[0].value.enum[0]，整個工具連帶不能用。
  const cleaned = gemini.sanitizeSchema({
    type: 'object',
    properties: {
      enabled: { type: 'boolean', enum: [true] },
      level: { type: 'number', enum: [1, 2] },
      mode: { type: 'string', enum: ['all', 'preview'] },
      flag: { const: false }
    }
  })
  assert.strictEqual(cleaned.properties.enabled.enum, undefined)
  assert.strictEqual(cleaned.properties.enabled.type, 'boolean')
  assert.strictEqual(cleaned.properties.level.enum, undefined)
  assert.deepStrictEqual(cleaned.properties.mode.enum, ['all', 'preview'])
  assert.strictEqual(cleaned.properties.flag.enum, undefined)
})

test('type 陣列收斂成單一型別（Gemini 的 type 不是 repeated 欄位）', () => {
  const cleaned = gemini.sanitizeSchema({
    type: 'object',
    properties: {
      name: { type: ['string', 'null'] },
      count: { type: ['null', 'integer'] }
    }
  })
  assert.strictEqual(cleaned.properties.name.type, 'string')
  assert.strictEqual(cleaned.properties.name.nullable, true)
  assert.strictEqual(cleaned.properties.count.type, 'integer')
})

test('anyOf 的 null 變體改成 nullable，只剩一支就攤平', () => {
  const cleaned = gemini.sanitizeSchema({
    type: 'object',
    properties: {
      framework: { description: '框架', anyOf: [{ type: 'string' }, { type: 'null' }] },
      value: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] }
    }
  })
  const framework = cleaned.properties.framework
  assert.strictEqual(framework.anyOf, undefined, '單一變體要攤平')
  assert.strictEqual(framework.type, 'string')
  assert.strictEqual(framework.nullable, true)
  assert.strictEqual(framework.description, '框架', '父層描述不可被變體蓋掉')
  assert.strictEqual(cleaned.properties.value.anyOf.length, 2)
  assert.strictEqual(cleaned.properties.value.nullable, true)
})

test('空 object 補 properties，避免上游 400', () => {
  assert.deepStrictEqual(gemini.sanitizeSchema({ type: 'object' }).properties, {})
})

test('遞迴深度有上限（擋惡意深層 schema）', () => {
  let deep = { type: 'string' }
  for (let i = 0; i < 40; i += 1) deep = { type: 'object', properties: { next: deep } }
  const cleaned = gemini.sanitizeSchema(deep)
  assert.ok(cleaned, '不應拋例外')
})

console.log('\nOpenAI → Gemini')

test('system 抽成 systemInstruction，assistant → model', () => {
  const inner = openai.toGeminiRequest({
    messages: [
      { role: 'system', content: '你是助理' },
      { role: 'user', content: '哈囉' },
      { role: 'assistant', content: '你好' }
    ]
  }, 'gemini-3-flash')
  assert.strictEqual(inner.systemInstruction.parts[0].text, '你是助理')
  assert.strictEqual(inner.contents.length, 2)
  assert.strictEqual(inner.contents[1].role, 'model')
})

test('tool 訊息接回 functionResponse，名稱取自先前的 tool_call', () => {
  const inner = openai.toGeminiRequest({
    messages: [
      { role: 'assistant', tool_calls: [{ id: 'call_1', function: { name: 'get_weather', arguments: '{"city":"TPE"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '晴天' }
    ]
  }, 'gemini-3-flash')
  assert.strictEqual(inner.contents[0].parts[0].functionCall.name, 'get_weather')
  assert.deepStrictEqual(inner.contents[0].parts[0].functionCall.args, { city: 'TPE' })
  assert.strictEqual(inner.contents[1].parts[0].functionResponse.name, 'get_weather')
})

test('圖片只收 data: URI，遠端 URL 一律丟掉（防 SSRF）', () => {
  const inner = openai.toGeminiRequest({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '看這張' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAB' } },
        { type: 'image_url', image_url: { url: 'http://169.254.169.254/latest/meta-data/' } }
      ]
    }]
  }, 'gemini-3-flash')
  const parts = inner.contents[0].parts
  assert.strictEqual(parts.length, 2)
  assert.strictEqual(parts[1].inlineData.mimeType, 'image/png')
})

test('非 thinking 模型明確關閉思考預算', () => {
  const inner = openai.toGeminiRequest({ messages: [], max_tokens: 100 }, 'gemini-3-flash')
  assert.strictEqual(inner.generationConfig.thinkingConfig.thinkingBudget, 0)
  assert.strictEqual(inner.generationConfig.maxOutputTokens, 100)
})

test('-thinking 模型預設開啟思考', () => {
  const inner = openai.toGeminiRequest({ messages: [] }, 'claude-opus-4-6-thinking')
  assert.strictEqual(inner.generationConfig.thinkingConfig.includeThoughts, true)
})

test('tools 轉成 functionDeclarations 並清理 schema', () => {
  const inner = openai.toGeminiRequest({
    messages: [],
    tools: [{
      type: 'function',
      function: {
        name: 'search',
        parameters: { type: 'object', additionalProperties: false, properties: { q: { type: 'string' } } }
      }
    }]
  }, 'gemini-3-flash')
  const declaration = inner.tools[0].functionDeclarations[0]
  assert.strictEqual(declaration.name, 'search')
  assert.strictEqual(declaration.parameters.additionalProperties, undefined)
})

test('contents 排在 generationConfig 之後（有利上游前綴快取）', () => {
  const inner = openai.toGeminiRequest({ messages: [{ role: 'user', content: 'x' }] }, 'gemini-3-flash')
  const keys = Object.keys(inner)
  assert.ok(keys.indexOf('contents') > keys.indexOf('generationConfig'))
})

console.log('\nGemini → OpenAI')

test('串流拼接：role chunk 只發一次，文字逐格', () => {
  const collector = openai.createCollector('gpt-4o', 1_700_000_000_000)
  const a = openai.consume(collector, frame([{ text: '你' }]))
  const b = openai.consume(collector, frame([{ text: '好' }]))
  const first = dataFrames(a)
  assert.strictEqual(first[0].choices[0].delta.role, 'assistant')
  assert.strictEqual(first[1].choices[0].delta.content, '你')
  assert.strictEqual(dataFrames(b).length, 1, '第二格不該重發 role')
  assert.strictEqual(collector.text, '你好')
  assert.strictEqual(collector.created, 1_700_000_000)
})

test('思考內容走 reasoning_content，不混進正文', () => {
  const collector = openai.createCollector('m', 0)
  const out = openai.consume(collector, frame([{ text: '嗯…', thought: true }, { text: '答案' }]))
  const frames = dataFrames(out)
  assert.strictEqual(frames[1].choices[0].delta.reasoning_content, '嗯…')
  assert.strictEqual(frames[2].choices[0].delta.content, '答案')
  assert.strictEqual(collector.text, '答案')
})

test('functionCall → tool_calls，finish_reason 變 tool_calls', () => {
  const collector = openai.createCollector('m', 0)
  const out = openai.consume(collector, frame([{ functionCall: { name: 'ls', args: { path: '/' } } }]))
  const call = dataFrames(out).at(-1).choices[0].delta.tool_calls[0]
  assert.strictEqual(call.index, 0)
  assert.strictEqual(call.function.name, 'ls')
  assert.strictEqual(JSON.parse(call.function.arguments).path, '/')
  const close = dataFrames(openai.closeStream(collector))
  assert.strictEqual(close[0].choices[0].finish_reason, 'tool_calls')
})

test('收尾帶 usage，且以 [DONE] 結束', () => {
  const collector = openai.createCollector('m', 0)
  openai.consume(collector, frame([{ text: 'hi' }], {
    usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 }
  }))
  const out = openai.closeStream(collector)
  assert.ok(out.endsWith('data: [DONE]\n\n'))
  const chunk = dataFrames(out)[0]
  assert.strictEqual(chunk.usage.prompt_tokens, 7)
  assert.strictEqual(chunk.usage.total_tokens, 10)
})

test('MAX_TOKENS → length', () => {
  const collector = openai.createCollector('m', 0)
  openai.consume(collector, frame([{ text: 'x' }], { candidate: { finishReason: 'MAX_TOKENS' } }))
  assert.strictEqual(dataFrames(openai.closeStream(collector))[0].choices[0].finish_reason, 'length')
})

test('非串流回應組裝完整', () => {
  const collector = openai.createCollector('m', 0)
  openai.consume(collector, frame([{ text: '嗯', thought: true }, { text: '答' }], {
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 }
  }))
  const response = openai.toResponse(collector)
  assert.strictEqual(response.object, 'chat.completion')
  assert.strictEqual(response.choices[0].message.content, '答')
  assert.strictEqual(response.choices[0].message.reasoning_content, '嗯')
  assert.strictEqual(response.usage.prompt_tokens, 5)
})

test('錯誤 chunk 只帶代碼，不含上游訊息', () => {
  const collector = openai.createCollector('m', 0)
  const payload = dataFrames(openai.errorStream(collector, 'UPSTREAM_502'))[0]
  assert.strictEqual(payload.error.code, 'UPSTREAM_502')
  assert.ok(!JSON.stringify(payload).includes('googleapis'))
})

console.log('\nAnthropic → Gemini')

test('system 陣列合併、tool_use/tool_result 用名稱配對', () => {
  const inner = anthropic.toGeminiRequest({
    system: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }],
    max_tokens: 256,
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'grep', input: { q: 'x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '找到了' }] }
    ]
  }, 'claude-sonnet-4-6')
  assert.strictEqual(inner.systemInstruction.parts[0].text, 'A\n\nB')
  assert.strictEqual(inner.contents[0].parts[0].functionCall.name, 'grep')
  assert.strictEqual(inner.contents[1].parts[0].functionResponse.name, 'grep')
  assert.strictEqual(inner.generationConfig.maxOutputTokens, 256)
})

test('歷史 thinking block 不回送上游（沒有 signature 會被拒）', () => {
  const inner = anthropic.toGeminiRequest({
    messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: '之前想的' }, { type: 'text', text: '答' }] }]
  }, 'claude-sonnet-4-6')
  const parts = inner.contents[0].parts
  assert.strictEqual(parts.length, 1)
  assert.strictEqual(parts[0].text, '答')
})

test('圖片 base64 source → inlineData', () => {
  const inner = anthropic.toGeminiRequest({
    messages: [{
      role: 'user',
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAB' } }]
    }]
  }, 'claude-sonnet-4-6')
  assert.strictEqual(inner.contents[0].parts[0].inlineData.mimeType, 'image/jpeg')
})

test('沒給 max_tokens 時有預設上限', () => {
  const inner = anthropic.toGeminiRequest({ messages: [] }, 'claude-sonnet-4-6')
  assert.strictEqual(inner.generationConfig.maxOutputTokens, 8192)
})

test('thinking.budget_tokens 會傳給上游', () => {
  const inner = anthropic.toGeminiRequest({
    messages: [],
    thinking: { type: 'enabled', budget_tokens: 4096 }
  }, 'claude-opus-4-6-thinking')
  assert.strictEqual(inner.generationConfig.thinkingConfig.thinkingBudget, 4096)
})

console.log('\nGemini → Anthropic')

test('事件序列符合 Anthropic 規格', () => {
  const collector = anthropic.createCollector('claude-sonnet-4-6')
  const a = anthropic.consume(collector, frame([{ text: '你' }]))
  const b = anthropic.consume(collector, frame([{ text: '好' }]))
  const close = anthropic.closeStream(collector)
  assert.deepStrictEqual(eventNames(a), ['message_start', 'content_block_start', 'content_block_delta'])
  assert.deepStrictEqual(eventNames(b), ['content_block_delta'])
  assert.deepStrictEqual(eventNames(close), ['content_block_stop', 'message_delta', 'message_stop'])
  assert.strictEqual(collector.text, '你好')
})

test('thinking → text 切換時關掉舊 block 再開新的', () => {
  const collector = anthropic.createCollector('m')
  const out = anthropic.consume(collector, frame([{ text: '想', thought: true }, { text: '答' }]))
  assert.deepStrictEqual(eventNames(out), [
    'message_start',
    'content_block_start', 'content_block_delta',
    'content_block_stop', 'content_block_start', 'content_block_delta'
  ])
  const blocks = out.split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
  assert.strictEqual(blocks[1].content_block.type, 'thinking')
  assert.strictEqual(blocks[4].content_block.type, 'text')
  assert.strictEqual(blocks[4].index, 1, 'block index 必須遞增')
})

test('tool_use block 帶完整 input_json_delta，stop_reason 為 tool_use', () => {
  const collector = anthropic.createCollector('m')
  const out = anthropic.consume(collector, frame([{ functionCall: { name: 'read', args: { file: 'a.txt' } } }]))
  const payloads = out.split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
  const start = payloads.find((p) => p.type === 'content_block_start')
  const delta = payloads.find((p) => p.type === 'content_block_delta')
  assert.strictEqual(start.content_block.type, 'tool_use')
  assert.strictEqual(start.content_block.name, 'read')
  assert.strictEqual(JSON.parse(delta.delta.partial_json).file, 'a.txt')

  const closing = anthropic.closeStream(collector).split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
  assert.strictEqual(closing.find((p) => p.type === 'message_delta').delta.stop_reason, 'tool_use')
})

test('空回應也要送出合法的 message_start/stop', () => {
  const collector = anthropic.createCollector('m')
  const names = eventNames(anthropic.closeStream(collector))
  assert.deepStrictEqual(names, ['message_start', 'message_delta', 'message_stop'])
})

test('SAFETY → refusal', () => {
  const collector = anthropic.createCollector('m')
  anthropic.consume(collector, frame([{ text: 'x' }], { candidate: { finishReason: 'SAFETY' } }))
  assert.strictEqual(anthropic.toResponse(collector).stop_reason, 'refusal')
})

test('非串流回應：thinking 在前、usage 帶快取讀取數', () => {
  const collector = anthropic.createCollector('m')
  anthropic.consume(collector, frame([{ text: '想', thought: true }, { text: '答' }], {
    usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4, cachedContentTokenCount: 3 }
  }))
  const response = anthropic.toResponse(collector)
  assert.strictEqual(response.content[0].type, 'thinking')
  assert.strictEqual(response.content[1].text, '答')
  assert.strictEqual(response.usage.input_tokens, 9)
  assert.strictEqual(response.usage.cache_read_input_tokens, 3)
})

console.log('\n型錄排序')

test('Claude 池（含 GPT OSS）在 Gemini 之前，Gemini 由新到舊', () => {
  const shuffled = [
    'gemini-pro-agent',
    'gemini-3.6-flash-low',
    'gpt-oss-120b-medium',
    'gemini-3-flash',
    'claude-sonnet-4-6',
    'gemini-3.1-flash-lite',
    'gemini-3.10-flash',
    'gemini-3.2-flash',
    'claude-opus-4-6-thinking',
    'gemini-3.6-flash-high',
    'gemini-2.5-flash'
  ]
  const models = {}
  for (const id of shuffled) {
    models[id] = { maxTokens: 1_000_000, maxOutputTokens: 65536, modelProvider: 'MODEL_PROVIDER_GOOGLE' }
  }
  const ids = catalog.parseCatalog({ models }).models.map((row) => row.id)
  assert.deepStrictEqual(ids, [
    'claude-opus-4-6-thinking',
    'claude-sonnet-4-6',
    'gpt-oss-120b-medium',
    'gemini-3.10-flash',
    'gemini-3.6-flash-high',
    'gemini-3.6-flash-low',
    'gemini-3.2-flash',
    'gemini-3.1-flash-lite',
    'gemini-3-flash',
    'gemini-2.5-flash',
    'gemini-pro-agent'
  ])
})

test('Gemini 同代依思考強度高到低，較舊世代放後面', () => {
  const ids = [
    'gemini-3.6-flash-tiered',
    'gemini-3-flash-agent',
    'gemini-3.6-flash-medium',
    'gemini-3-flash',
    'gemini-3.1-pro-low'
  ]
  ids.sort(catalog.compareModelIds)
  assert.deepStrictEqual(ids, [
    'gemini-3.6-flash-medium',
    'gemini-3.6-flash-tiered',
    'gemini-3.1-pro-low',
    'gemini-3-flash-agent',
    'gemini-3-flash'
  ])
})

test('Gemini 思考強度：high > medium > tiered > low > extra-low > lite', () => {
  const ids = [
    'gemini-3.7-flash-lite',
    'gemini-3.7-flash-low',
    'gemini-3.7-flash-high',
    'gemini-3.7-flash-extra-low',
    'gemini-3.7-flash-tiered',
    'gemini-3.7-flash-medium'
  ]
  ids.sort(catalog.compareModelIds)
  assert.deepStrictEqual(ids, [
    'gemini-3.7-flash-high',
    'gemini-3.7-flash-medium',
    'gemini-3.7-flash-tiered',
    'gemini-3.7-flash-low',
    'gemini-3.7-flash-extra-low',
    'gemini-3.7-flash-lite'
  ])
})

console.log(`\n${passed} passed, ${failures.length} failed\n`)
if (failures.length) process.exit(1)
