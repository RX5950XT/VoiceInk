#!/usr/bin/env node
/**
 * VoiceInk — Claude Code 轉換閘道的純函式回歸（node 直跑）
 *
 * Claude Code 只會講 Anthropic Messages；上游可用 Responses 或 Chat Completions。
 * 這裡把兩個方向的轉換釘住：
 *   - 送出去：訊息／工具／圖片要變成上游吃得下的形狀，thinking block **不可以回送**
 *   - 收回來：上游的串流事件要變成合法的 Anthropic SSE（區塊有開就要有關）
 */

'use strict'

const path = require('path')

const ROOT = path.join(__dirname, '..')
const convert = require(path.join(ROOT, 'src/main/ccswitch/gateway/convert.js'))
const credential = require(path.join(ROOT, 'src/main/ccswitch/gateway/credential.js'))
const server = require(path.join(ROOT, 'src/main/ccswitch/gateway/server.js'))

let passed = 0
let failed = 0
function ok(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  PASS ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/**
 * 把 SSE 文字拆成 [{ event, data }]
 * @param {string} sse
 */
function parseSse(sse) {
  return sse.split('\n\n').filter(Boolean).map((frame) => {
    const lines = frame.split('\n')
    const event = lines.find((line) => line.startsWith('event: '))?.slice(7) || ''
    const data = lines.find((line) => line.startsWith('data: '))?.slice(6) || '{}'
    return { event, data: JSON.parse(data) }
  })
}

// ===== 送出去 =====
console.log('\n[A] Anthropic → Responses')
{
  const body = {
    model: 'gpt-5.6-sol',
    system: [{ type: 'text', text: '你是助理' }],
    max_tokens: 1024,
    temperature: 0.5,
    messages: [
      { role: 'user', content: '你好' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '想一下' },
          { type: 'text', text: '好的' },
          { type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'a.txt' } }
        ]
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '檔案內容' }] }
    ],
    tools: [{
      name: 'read',
      description: '讀檔',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        $schema: 'https://json-schema.org/draft-07/schema#'
      }
    }]
  }

  const request = convert.toResponsesRequest(body, 'gpt-5.6-sol')
  ok('system 變成 instructions', request.instructions === '你是助理')
  ok('max_tokens 轉成 max_output_tokens', request.max_output_tokens === 1024)
  ok('temperature 帶過去', request.temperature === 0.5)
  ok('stream 固定開著（我們自己收）', request.stream === true)

  const json = JSON.stringify(request)
  // 沒有原始 signature 的 thinking 回送上游會被拒
  ok('thinking block 不回送上游', !json.includes('想一下'))
  ok('tool_use 變成 function_call',
    request.input.some((item) => item.type === 'function_call' && item.call_id === 'toolu_1'))
  ok('tool_result 變成 function_call_output',
    request.input.some((item) => item.type === 'function_call_output' && item.output === '檔案內容'))
  ok('使用者訊息用 input_text',
    request.input.some((item) => item.content?.[0]?.type === 'input_text'))
  ok('助理訊息用 output_text',
    request.input.some((item) => item.role === 'assistant' && item.content?.[0]?.type === 'output_text'))

  // 客戶端／MCP 給的完整 JSON Schema 帶 $schema，原樣轉送會 400
  ok('schema 的 $schema 被剝掉', !json.includes('$schema'))
  ok('schema 的 properties 保留', request.tools[0].parameters.properties.path.type === 'string')
  ok('工具名稱保留', request.tools[0].name === 'read')

  // 圖片只收 data URI；讓閘道去下載客戶端指定的 http URL 等於開一個 SSRF 跳板
  const withImage = convert.toResponsesRequest({
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
        { type: 'image', source: { type: 'url', url: 'http://169.254.169.254/latest' } }
      ]
    }]
  }, 'm')
  const parts = withImage.input[0].content
  ok('base64 圖片轉成 data URI', parts.some((p) => p.type === 'input_image' && p.image_url.startsWith('data:image/png;base64,')))
  ok('http 圖片被丟掉（不當 SSRF 跳板）', !JSON.stringify(withImage).includes('169.254'))

  const thinking = convert.toResponsesRequest({ messages: [], thinking: { type: 'enabled' } }, 'm')
  ok('thinking 開關轉成 reasoning', thinking.reasoning?.effort === 'medium')
  const noThinking = convert.toResponsesRequest({ messages: [] }, 'm')
  ok('沒開 thinking 就完全不帶 reasoning', !('reasoning' in noThinking))
}

console.log('\n[B] Anthropic → Chat Completions')
{
  const request = convert.toChatRequest({
    system: '系統提示',
    messages: [
      { role: 'user', content: '嗨' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'ls', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'a b c' }] }
    ],
    tools: [{ name: 'ls', input_schema: { type: 'object' } }],
    max_tokens: 512
  }, 'qwen3-coder')

  ok('system 變成第一則 system 訊息', request.messages[0].role === 'system')
  ok('tool_use 變成 tool_calls',
    request.messages.some((m) => m.tool_calls?.[0]?.function?.name === 'ls'))
  ok('tool_result 變成 role=tool',
    request.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'c1'))
  ok('tools 包一層 function', request.tools[0].type === 'function' && request.tools[0].function.name === 'ls')
  ok('max_tokens 用 Chat 的名字', request.max_tokens === 512)
}

// ===== 收回來 =====
console.log('\n[C] Responses 串流 → Anthropic SSE')
{
  const collector = convert.createCollector('gpt-5.6-sol')
  const state = convert.newConsumeState()
  let sse = ''
  const feed = (payload) => {
    for (const delta of convert.consumeResponses(payload, state)) {
      sse += convert.apply(collector, delta)
    }
  }

  feed({ type: 'response.reasoning_summary_text.delta', delta: '先想' })
  feed({ type: 'response.output_text.delta', delta: '你' })
  feed({ type: 'response.output_text.delta', delta: '好' })
  feed({ type: 'response.output_item.added', output_index: 0, item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'read' } })
  feed({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"path":' })
  feed({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"a.txt"}' })
  feed({ type: 'response.output_item.done', output_index: 0, item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' } })
  feed({ type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 40 } } } })
  sse += convert.closeStream(collector)

  const events = parseSse(sse)
  const types = events.map((item) => item.event)
  ok('第一個事件是 message_start', types[0] === 'message_start')
  ok('最後一個事件是 message_stop', types[types.length - 1] === 'message_stop')
  ok('有 thinking 區塊', events.some((e) => e.data.content_block?.type === 'thinking'))
  ok('有 text 區塊', events.some((e) => e.data.content_block?.type === 'text'))
  ok('有 tool_use 區塊', events.some((e) => e.data.content_block?.type === 'tool_use'))
  ok('文字有拼起來', collector.text === '你好')

  // 每個 content_block_start 都要有對應的 stop，否則客戶端會停在半開狀態
  const starts = types.filter((t) => t === 'content_block_start').length
  const stops = types.filter((t) => t === 'content_block_stop').length
  ok('區塊開關數量相等', starts === stops, `${starts} vs ${stops}`)

  const delta = events.find((e) => e.event === 'message_delta')
  ok('有工具呼叫時 stop_reason 是 tool_use', delta.data.delta.stop_reason === 'tool_use')
  ok('output_tokens 回報正確', delta.data.usage.output_tokens === 20)

  const response = convert.toResponse(collector)
  ok('非串流回應帶 tool_use', response.content.some((b) => b.type === 'tool_use' && b.input.path === 'a.txt'))
  ok('非串流回應帶 cache 讀取量', response.usage.cache_read_input_tokens === 40)
  ok('非串流回應 input_tokens 正確', response.usage.input_tokens === 100)
}

console.log('\n[D] Chat 串流 → Anthropic SSE')
{
  const collector = convert.createCollector('qwen3-coder')
  const state = convert.newConsumeState()
  let sse = ''
  const feed = (payload) => {
    for (const delta of convert.consumeChat(payload, state)) sse += convert.apply(collector, delta)
  }

  feed({ choices: [{ delta: { content: 'Hel' } }] })
  feed({ choices: [{ delta: { content: 'lo' } }] })
  feed({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'ls', arguments: '{"a"' } }] } }] })
  feed({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }] })
  feed({ usage: { prompt_tokens: 30, completion_tokens: 8 } })
  feed({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
  sse += convert.closeStream(collector)

  const events = parseSse(sse)
  ok('文字拼起來', collector.text === 'Hello')
  ok('tool_call 收尾才吐出（args 是一路累加的）', collector.calls[0]?.args.a === 1)
  const starts = events.filter((e) => e.event === 'content_block_start').length
  const stops = events.filter((e) => e.event === 'content_block_stop').length
  ok('區塊開關數量相等', starts === stops, `${starts} vs ${stops}`)
  ok('stop_reason 是 tool_use',
    events.find((e) => e.event === 'message_delta').data.delta.stop_reason === 'tool_use')

  // 上游吐的 arguments 不是合法 JSON 時不可以讓整條串流掛掉
  const c2 = convert.createCollector('m')
  const bad = convert.apply(c2, { toolCall: { id: 'x', name: 'f', args: '{broken' } })
  ok('壞掉的工具參數不炸，退回空物件', bad.includes('tool_use') && c2.calls[0].args && Object.keys(c2.calls[0].args).length === 0)
}

console.log('\n[E] 沒有內容時仍要是合法串流')
{
  const collector = convert.createCollector('m')
  const events = parseSse(convert.closeStream(collector))
  ok('空回應也有 message_start', events[0].event === 'message_start')
  ok('空回應也有 message_stop', events[events.length - 1].event === 'message_stop')

  const withError = convert.createCollector('m')
  convert.apply(withError, { text: 'x' })
  const errorSse = parseSse(convert.errorStream(withError, 'UPSTREAM_TIMEOUT'))
  ok('出錯前先把開著的區塊收掉', errorSse[0].event === 'content_block_stop')
  ok('錯誤事件型別是 error', errorSse[errorSse.length - 1].event === 'error')
  ok('錯誤訊息只有我們自己的代碼',
    errorSse[errorSse.length - 1].data.error.message === 'UPSTREAM_TIMEOUT')
}

// ===== 路由與憑證 =====
console.log('\n[F] 路由與憑證')
{
  ok('固定表包含需要閘道的內建路由',
    Object.keys(server.ROUTES).join(',') === 'codex,grok-build,ollama-cloud,opencode-go,commandcode')
  ok('Codex 走 Responses', server.ROUTES.codex.wire === 'responses')
  ok('Ollama 預設走 Responses', server.ROUTES['ollama-cloud'].wire === 'responses')
  ok('Codex 端點固定在 main', server.ROUTES.codex.url.startsWith('https://chatgpt.com/'))
  // 訂閱制走 CLI 的代理，不是 api.x.ai（那條是 API 金鑰用的，OAuth token 過去一律 403）
  ok('Grok 端點固定在 main',
    server.ROUTES['grok-build'].url.startsWith('https://cli-chat-proxy.grok.com/'))
  ok('Codex 帶 chatgpt-account-id 標頭',
    'chatgpt-account-id' in server.ROUTES.codex.headers({ accountId: 'a' }))

  // client_id 是公開的桌面 client（沒有 secret）；secret 一律不可以進原始碼
  const source = require('fs').readFileSync(
    path.join(ROOT, 'src/main/ccswitch/gateway/credential.js'), 'utf8'
  )
  ok('原始碼裡沒有 client secret', !/GOCSPX-|client_secret/i.test(source))

  const claims = credential.jwtClaims(
    `x.${Buffer.from(JSON.stringify({ exp: 123 })).toString('base64url')}.y`
  )
  ok('讀得出 JWT 的 exp', claims.exp === 123)
  ok('不是 JWT 就回空物件', Object.keys(credential.jwtClaims('nope')).length === 0)
  ok('壞掉的 payload 回空物件', Object.keys(credential.jwtClaims('a.!!!.c')).length === 0)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
