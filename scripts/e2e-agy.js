'use strict'

/**
 * AGY 反代 main 端 e2e：`npx electron scripts/e2e-agy.js`
 *
 * 用 mock cloudcode-pa，不打真 API、不碰真憑證。
 * 驗證：串流拼接／非串流／Anthropic 事件序列／401 refresh 重試／鑑權／Host 檢查／
 *       body 上限／日誌落盤與統計／錯誤不外洩上游 body／429 retry-after。
 */

const { app } = require('electron')
const http = require('http')
const os = require('os')
const path = require('path')
const fs = require('fs')

const AGY = path.join(__dirname, '..', 'src', 'main', 'agy')
const credential = require(path.join(AGY, 'credential'))
const logs = require(path.join(AGY, 'logs'))
const server = require(path.join(AGY, 'server'))
const upstream = require(path.join(AGY, 'upstream'))
const catalog = require(path.join(AGY, 'catalog'))

const API_KEY = 'agy-test-key-0123456789'
let passed = 0
const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}

// ===== mock cloudcode-pa =====

/** 可切換的上游行為，讓單一 mock 覆蓋所有錯誤情境 */
const upstreamState = {
  mode: 'ok',
  authFailuresLeft: 0,
  seenAuthHeaders: [],
  lastBody: null,
  lastHeaders: null,
  lastCountTokensBody: null,
  catalogFails: false
}

function sseFrame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function startMockUpstream() {
  return new Promise((resolve) => {
    const instance = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => { raw += chunk })
      req.on('end', () => {
        upstreamState.seenAuthHeaders.push(String(req.headers.authorization || ''))
        upstreamState.lastHeaders = { ...req.headers }
        try { upstreamState.lastBody = JSON.parse(raw) } catch { upstreamState.lastBody = null }
        if (String(req.url || '').includes(':countTokens')) upstreamState.lastCountTokensBody = upstreamState.lastBody

        if (upstreamState.authFailuresLeft > 0) {
          upstreamState.authFailuresLeft -= 1
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'token expired', internalTrace: 'SECRET-TRACE-42' }))
          return
        }
        if (upstreamState.mode === 'rate-limited') {
          res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '37' })
          res.end(JSON.stringify({ error: 'quota exhausted for account nobody@example.com' }))
          return
        }
        if (upstreamState.mode === 'server-error') {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'LEAKY-UPSTREAM-DETAIL', token: 'ya29.SECRET' } }))
          return
        }

        const url = String(req.url || '')
        if (url.includes(':fetchAvailableModels')) {
          if (upstreamState.catalogFails) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'catalog down' }))
            return
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            models: {
              'mock-chat-a': { maxTokens: 1000000, maxOutputTokens: 65536, modelProvider: 'MODEL_PROVIDER_GOOGLE', quotaInfo: { remainingFraction: 0.9 } },
              'mock-chat-b': { maxTokens: 250000, maxOutputTokens: 64000, modelProvider: 'MODEL_PROVIDER_ANTHROPIC', quotaInfo: { remainingFraction: 0.05 } },
              'mock-tab-internal': { maxTokens: 16384, maxOutputTokens: 4096, modelProvider: 'MODEL_PROVIDER_GOOGLE' },
              'mock-old': { maxTokens: 1000000, maxOutputTokens: 65536, modelProvider: 'MODEL_PROVIDER_GOOGLE' }
            },
            defaultAgentModelId: 'mock-chat-a',
            deprecatedModelIds: { 'mock-old': { newModelId: 'mock-chat-a' } }
          }))
          return
        }
        if (url.includes(':countTokens')) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ totalTokens: 123 }))
          return
        }
        if (url.includes(':streamGenerateContent')) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.write(sseFrame({ response: { candidates: [{ content: { parts: [{ text: '嗯…', thought: true }], role: 'model' } }] } }))
          res.write(sseFrame({ response: { candidates: [{ content: { parts: [{ text: '哈' }], role: 'model' } }] } }))
          res.write(sseFrame({ response: { candidates: [{ content: { parts: [{ text: '囉' }], role: 'model' }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 4, thoughtsTokenCount: 2, cachedContentTokenCount: 1, totalTokenCount: 15 } } }))
          res.end()
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          response: {
            candidates: [{ content: { parts: [{ text: '非串流答案' }], role: 'model' }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 }
          }
        }))
      })
    })
    instance.listen(0, '127.0.0.1', () => resolve(instance))
  })
}

// ===== 測試工具 =====

let proxyPort = 0

function proxyUrl(pathname) {
  return `http://127.0.0.1:${proxyPort}${pathname}`
}

async function call(pathname, { body, headers = {}, method = 'POST', raw = false } = {}) {
  const response = await fetch(proxyUrl(pathname), {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}`, ...headers },
    body: body === undefined ? undefined : (raw ? body : JSON.stringify(body))
  })
  const text = await response.text()
  return { status: response.status, text, headers: response.headers }
}

function sseData(text) {
  return text.split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6))
    .filter((value) => value !== '[DONE]')
    .map((value) => { try { return JSON.parse(value) } catch { return null } })
    .filter(Boolean)
}

async function main() {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-e2e-'))
  const mock = await startMockUpstream()
  const mockPort = mock.address().port

  logs.init({ userDataPath })
  server.configureUpstream({
    baseUrl: `http://127.0.0.1:${mockPort}/v1internal`,
    readCredential: async () => JSON.stringify({
      token: {
        access_token: 'fresh-access-token',
        refresh_token: 'refresh-token',
        expiry: new Date(Date.now() + 60 * 60 * 1000).toISOString()
      }
    }),
    refresh: async () => 'refreshed-access-token',
    loadCodeAssist: async () => ({ project: 'test-project', tier: 'Ultra' })
  })

  const started = await server.start({ port: 0, apiKey: API_KEY, logBodies: false })
  proxyPort = server.status().port || 0
  // port 0 由 OS 指派，start() 回的是設定值，實際要從 listen 後的 server 取
  if (!proxyPort) {
    console.log('  INFO  以固定埠重試')
    await server.stop()
    await server.start({ port: 18788, apiKey: API_KEY, logBodies: false })
    proxyPort = 18788
  }
  check('server 啟動', started.ok !== false && proxyPort > 0, JSON.stringify(started))

  console.log('\n鑑權與連線邊界')

  {
    const response = await fetch(proxyUrl('/health'))
    check('/health 不需鑑權', response.status === 200)
  }
  {
    const { status } = await call('/v1/chat/completions', { body: {}, headers: { Authorization: '' } })
    check('沒有 API key → 401', status === 401)
  }
  {
    const { status, text } = await call('/v1/chat/completions', { body: {}, headers: { Authorization: 'Bearer wrong-key-xxxxxxxxxxxx' } })
    check('錯誤 API key → 401，且回 OpenAI 錯誤形狀', status === 401 && JSON.parse(text).error?.code === 'UNAUTHORIZED')
  }
  {
    const { status, text } = await call('/v1/messages', {
      body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] },
      headers: { Authorization: '', 'x-api-key': API_KEY }
    })
    check('Anthropic 的 x-api-key 也能通過', status === 200, text.slice(0, 120))
  }
  {
    const { status, text } = await call('/v1/messages', { body: {}, headers: { Authorization: 'Bearer nope' } })
    const payload = JSON.parse(text)
    check('Anthropic 錯誤形狀為 {type:error}', status === 401 && payload.type === 'error' && payload.error?.type === 'authentication_error')
  }
  {
    // fetch 不讓設定 Host（forbidden header），要驗這條只能走原始 http.request
    const status = await new Promise((resolve) => {
      const request = http.request({
        host: '127.0.0.1',
        port: proxyPort,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          Host: 'evil.example.com',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_KEY}`
        }
      }, (response) => {
        response.resume()
        resolve(response.statusCode)
      })
      request.on('error', () => resolve(0))
      request.end('{}')
    })
    check('非本機 Host → 403（擋 DNS rebinding）', status === 403, `status=${status}`)
  }
  {
    const { status } = await call('/v1/nope', { body: {} })
    check('未知端點 → 404', status === 404)
  }

  console.log('\nOpenAI 協議')

  {
    const { status, text } = await call('/v1/chat/completions', {
      body: { model: 'gpt-4o', stream: true, messages: [{ role: 'user', content: '你好' }] }
    })
    const frames = sseData(text)
    const content = frames.map((f) => f.choices?.[0]?.delta?.content || '').join('')
    const reasoning = frames.map((f) => f.choices?.[0]?.delta?.reasoning_content || '').join('')
    const last = frames.at(-1)
    check('串流拼接正確且以 [DONE] 收尾', status === 200 && content === '哈囉' && text.trimEnd().endsWith('data: [DONE]'), content)
    check('思考內容走 reasoning_content', reasoning === '嗯…')
    check('收尾帶 usage（thinking 不重複計）', last?.usage?.prompt_tokens === 11 && last?.usage?.completion_tokens === 4, JSON.stringify(last?.usage))
    check('finish_reason 為 stop', last?.choices?.[0]?.finish_reason === 'stop')
  }
  {
    const { status, text } = await call('/v1/chat/completions', {
      body: { model: 'gpt-4o', messages: [{ role: 'user', content: '你好' }] }
    })
    const payload = JSON.parse(text)
    check('非串流回應完整', status === 200 && payload.choices[0].message.content === '非串流答案' && payload.usage.total_tokens === 10)
  }
  {
    catalog.reset()
    const { status, text } = await call('/v1/models', { method: 'GET' })
    const payload = JSON.parse(text)
    const ids = (payload.data || []).map((m) => m.id)
    check('/v1/models 回模型清單', status === 200 && ids.length > 0, ids.join(','))
    // 靜態表列過會 404 的模型，所以這裡一定要是上游的即時清單
    check('/v1/models 用的是上游即時清單', ids.includes('mock-chat-a'), ids.join(','))
    check('/v1/models 濾掉 IDE 內部模型', !ids.includes('mock-tab-internal'), ids.join(','))
    check('/v1/models 濾掉已淘汰的模型', !ids.includes('mock-old'), ids.join(','))
    check('/v1/models 標出模型提供者',
      payload.data.find((m) => m.id === 'mock-chat-b')?.owned_by === 'anthropic',
      JSON.stringify(payload.data.find((m) => m.id === 'mock-chat-b')))

    // 型錄掛掉時要退回靜態表，不能回空清單——客戶端下拉會整個空掉
    catalog.reset()
    upstreamState.catalogFails = true
    const fallback = await call('/v1/models', { method: 'GET' })
    const fallbackIds = (JSON.parse(fallback.text).data || []).map((m) => m.id)
    check('型錄失敗時退回靜態表', fallback.status === 200 && fallbackIds.length > 0, fallbackIds.join(','))
    check('退回的不是上游即時清單', !fallbackIds.includes('mock-chat-a'))
    upstreamState.catalogFails = false
    catalog.reset()
  }
  {
    await call('/v1/chat/completions', {
      body: { model: 'claude-sonnet-4-5-20250929', messages: [{ role: 'user', content: 'x' }] }
    })
    check('模型映射有送到上游', upstreamState.lastBody?.model === 'claude-sonnet-4-6', String(upstreamState.lastBody?.model))
    check('上游 body 帶 project 與 request 信封', upstreamState.lastBody?.project === 'test-project' && !!upstreamState.lastBody?.request?.contents)
  }

  console.log('\nAnthropic 協議')

  {
    const { status, text } = await call('/v1/messages', {
      body: { model: 'claude-sonnet-4-5-20250929', max_tokens: 100, stream: true, messages: [{ role: 'user', content: '你好' }] }
    })
    const events = text.split('\n').filter((line) => line.startsWith('event: ')).map((line) => line.slice(7))
    const payloads = sseData(text)
    const textOut = payloads.filter((p) => p.delta?.type === 'text_delta').map((p) => p.delta.text).join('')
    check('事件序列以 message_start 起、message_stop 收', status === 200 && events[0] === 'message_start' && events.at(-1) === 'message_stop', events.join(','))
    check('thinking 與 text 各自成 block', events.filter((e) => e === 'content_block_start').length === 2)
    check('文字內容正確', textOut === '哈囉', textOut)
    const messageDelta = payloads.find((p) => p.type === 'message_delta')
    check('stop_reason 為 end_turn', messageDelta?.delta?.stop_reason === 'end_turn')
  }
  {
    const { status, text } = await call('/v1/messages/count_tokens', {
      body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] }
    })
    check('count_tokens 代理到上游', status === 200 && JSON.parse(text).input_tokens === 123)
  }

  console.log('\n錯誤處理')

  {
    credential.reset()
    upstreamState.seenAuthHeaders.length = 0
    upstreamState.authFailuresLeft = 1
    const { status, text } = await call('/v1/chat/completions', {
      body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }] }
    })
    check('上游 401 → 換 token 重試一次後成功', status === 200, `${status} ${text.slice(0, 100)}`)
    check('重試確實換了 token', upstreamState.seenAuthHeaders.length >= 2 &&
      upstreamState.seenAuthHeaders[0] !== upstreamState.seenAuthHeaders.at(-1),
    upstreamState.seenAuthHeaders.join(' | ').slice(0, 120))
  }
  {
    upstreamState.mode = 'server-error'
    const { status, text } = await call('/v1/chat/completions', {
      body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }] }
    })
    check('上游 500 → 502', status === 502)
    check('不外洩上游 body／token', !text.includes('LEAKY-UPSTREAM-DETAIL') && !text.includes('ya29.'), text.slice(0, 160))
  }
  {
    // count_tokens 的錯誤路徑要跟另外兩個端點同一套：上游狀態碼不透傳。
    // 原本它是 `error.status >= 400 ? error.status : 502`，上游 401 會原樣回給客戶端，
    // 而 Claude Code CLI 正是靠 count_tokens 估上下文——它會誤判成自己的 API key 壞了。
    upstreamState.mode = 'server-error'
    const body = { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'x' }] }
    const err500 = await call('/v1/messages/count_tokens', { body })
    check('count_tokens 上游 500 → 502', err500.status === 502, `status=${err500.status}`)
    check('count_tokens 不外洩上游 body／token',
      !err500.text.includes('LEAKY-UPSTREAM-DETAIL') && !err500.text.includes('ya29.'),
      err500.text.slice(0, 160))

    upstreamState.authFailuresLeft = 99 // 兩次嘗試都 401
    const err401 = await call('/v1/messages/count_tokens', { body })
    check('count_tokens 上游 401 → 502（不讓客戶端以為自己 key 壞了）',
      err401.status === 502, `status=${err401.status}`)
    upstreamState.authFailuresLeft = 0
    upstreamState.mode = 'ok'
  }
  {
    upstreamState.mode = 'rate-limited'
    const { status, headers: rateHeaders } = await call('/v1/messages/count_tokens', {
      body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'x' }] }
    })
    check('count_tokens 的 429 仍原樣透傳並帶 retry-after',
      status === 429 && rateHeaders.get('retry-after') === '37',
      `status=${status} retry-after=${rateHeaders.get('retry-after')}`)
    upstreamState.mode = 'ok'
  }
  {
    upstreamState.mode = 'rate-limited'
    const { status, text, headers } = await call('/v1/chat/completions', {
      body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }] }
    })
    check('上游 429 原樣透傳', status === 429)
    check('retry-after 有帶回客戶端', headers.get('retry-after') === '37', String(headers.get('retry-after')))
    check('429 也不外洩帳號資訊', !text.includes('example.com'))
    upstreamState.mode = 'ok'
  }
  {
    const { status, text } = await call('/v1/chat/completions', { body: undefined, raw: true, headers: {} })
    check('空 body → 400 INVALID_JSON', status === 400 && JSON.parse(text).error?.code === 'INVALID_JSON')
  }
  {
    upstreamState.mode = 'server-error'
    const { status, text } = await call('/v1/chat/completions', {
      body: { model: 'gpt-4o', stream: true, messages: [{ role: 'user', content: 'x' }] }
    })
    // 串流模式：頭已送出前就失敗，仍應是 502（尚未 writeHead）
    check('串流請求的上游錯誤也不外洩內容', !text.includes('LEAKY-UPSTREAM-DETAIL'), `${status} ${text.slice(0, 120)}`)
    upstreamState.mode = 'ok'
  }

  console.log('\n日誌與統計')

  {
    const { logs: rows, total } = logs.list({ limit: 100 })
    check('請求都有落盤', total >= 8, `total=${total}`)
    const ok = rows.find((row) => row.status === 200 && row.protocol === 'openai' && row.inputTokens > 0)
    check('成功列記到 token 數與映射後模型', !!ok && ok.mappedModel.length > 0, JSON.stringify(ok || {}).slice(0, 160))
    const failed = rows.find((row) => row.status === 502)
    check('失敗列記到錯誤代碼', !!failed && failed.errorCode.startsWith('UPSTREAM_'), failed?.errorCode)
    check('logBodies=false 時不存 body', rows.every((row) => !row.requestBody && !row.responseBody))
  }
  {
    const onlyErrors = logs.list({ limit: 100, onlyErrors: true })
    check('可只篩錯誤', onlyErrors.logs.length > 0 && onlyErrors.logs.every((row) => row.status >= 400))
    const anthropicOnly = logs.list({ limit: 100, protocol: 'anthropic' })
    check('可依協議篩選', anthropicOnly.logs.length > 0 && anthropicOnly.logs.every((row) => row.protocol === 'anthropic'))
  }
  {
    const stats = logs.stats()
    check('統計 summary 對得上', stats.summary.requests >= 8 && stats.summary.success >= 4 && stats.summary.errors >= 3, JSON.stringify(stats.summary))
    check('統計有時間序列與模型分佈', stats.series.length > 0 && stats.models.length > 0)
    check('token 總量有累加', stats.summary.input > 0 && stats.summary.output > 0)

    // 序列要補零：只回「有資料的桶」會把 3 個小時的量攤成整條時間軸
    check('24h 序列補滿 24 個小時桶', stats.range === '24h' && stats.bucket === 'hour'
      && stats.series.length >= 24 && stats.series.some((row) => row.requests === 0),
    `range=${stats.range} bucket=${stats.bucket} len=${stats.series.length}`)
    check('序列桶間隔為一小時', stats.series.length < 2
      || stats.series[1].start - stats.series[0].start === 3600000)

    const daily = logs.stats({ range: '7d' })
    check('7d 改用天桶', daily.bucket === 'day' && daily.series.length >= 7
      && daily.series.every((row) => !row.period.includes(':')), `${daily.bucket}/${daily.series.length}`)

    // range 是白名單：renderer 送什麼進來都不該影響 SQL
    const injected = logs.stats({ range: "1 UNION SELECT" })
    check('未知 range 退回預設 24h', injected.range === '24h' && injected.bucket === 'hour')
    const noRows = logs.stats({ range: '6h' })
    check('6h 範圍也套在 summary 與 models 上', noRows.range === '6h'
      && noRows.summary.requests <= stats.summary.requests
      && noRows.models.every((row) => typeof row.model === 'string'))
  }
  {
    // 開啟除錯模式後才會存 body
    server.applySettings({ port: proxyPort, apiKey: API_KEY, logBodies: true })
    await call('/v1/chat/completions', { body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'DEBUG-MARKER' }] } })
    const { logs: rows } = logs.list({ limit: 5 })
    check('除錯模式會存截斷後的 body', rows.some((row) => row.requestBody.includes('DEBUG-MARKER')))
    server.applySettings({ port: proxyPort, apiKey: API_KEY, logBodies: false })
  }
  {
    const removed = logs.cleanup(1)
    check('保留天數清理可執行', Number.isInteger(removed))
    logs.clear()
    check('清空日誌', logs.list({ limit: 5 }).total === 0)
  }

  console.log('\n上游請求合約（真實環境實測回來的規則）')

  {
    // x-goog-user-project 帶上去，每個端點都會回 403 SERVICE_DISABLED
    const headerNames = Object.keys(upstreamState.lastHeaders || {}).map((k) => k.toLowerCase())
    check('不送 x-goog-user-project', !headerNames.includes('x-goog-user-project'),
      headerNames.filter((n) => n.startsWith('x-goog')).join(',') || '(無 x-goog-*)')

    // countTokens 的信封跟 generateContent 不同：多送 project/model 會 400 Unknown name
    await call('/v1/messages/count_tokens', {
      body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: '你好' }] }
    })
    const ctBody = upstreamState.lastCountTokensBody
    check('countTokens 只送 { request }',
      !!ctBody && !!ctBody.request && !('project' in ctBody) && !('model' in ctBody) && !('userAgent' in ctBody),
      JSON.stringify(Object.keys(ctBody || {})))
    check('countTokens 的 model 放在 request 裡', ctBody?.request?.model === 'claude-sonnet-4-6',
      String(ctBody?.request?.model))
  }

  {
    // 端點輪替：prod 實測會回 429，必須自動往下一個端點走
    const tried = []
    const fetchImpl = async (url) => {
      tried.push(String(url))
      if (tried.length < 3) {
        return new Response(JSON.stringify({ error: 'quota' }), {
          status: 429, headers: { 'Content-Type': 'application/json' }
        })
      }
      return new Response(JSON.stringify({
        response: {
          candidates: [{ content: { parts: [{ text: 'ok' }], role: 'model' }, finishReason: 'STOP' }]
        }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    const credentialStub = {
      readCredential: async () => JSON.stringify({
        token: {
          access_token: 'tok', refresh_token: 'r',
          expiry: new Date(Date.now() + 3600_000).toISOString()
        }
      }),
      refresh: async () => 'tok2',
      loadCodeAssist: async () => ({ project: 'p', tier: 'Ultra' })
    }
    credential.reset()
    const result = await upstream.once({
      inner: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      model: 'gemini-3-flash',
      options: { ...credentialStub, fetchImpl }
    })
    check('429 會往下一個端點重試', tried.length === 3, `試了 ${tried.length} 次`)
    check('第一個試的是 sandbox', tried[0]?.includes('sandbox'), tried[0] || '')
    check('最後才輪到 prod', tried.at(-1)?.startsWith('https://cloudcode-pa.googleapis.com'), tried.at(-1) || '')
    check('輪替成功後仍回得到內容', !!result?.response?.candidates?.length)

    // 400 這種換網域也沒用的錯誤不該浪費三次往返
    const tried400 = []
    credential.reset()
    let thrown = null
    try {
      await upstream.once({
        inner: { contents: [] },
        model: 'gemini-3-flash',
        options: {
          ...credentialStub,
          fetchImpl: async (url) => {
            tried400.push(String(url))
            return new Response('{"error":"bad"}', { status: 400 })
          }
        }
      })
    } catch (error) { thrown = error }
    check('400 不做端點輪替', tried400.length === 1, `試了 ${tried400.length} 次`)
    check('400 仍拋出對應錯誤', thrown?.status === 400, String(thrown?.code))
    credential.reset()
  }

  console.log('\n憑證過期判定')

  {
    const iso = (deltaMs) => new Date(Date.now() + deltaMs).toISOString()
    const credFor = (expiry, token = 'live-token') => JSON.stringify({
      token: { access_token: token, refresh_token: 'r', expiry }
    })
    // 假的 LOCALAPPDATA：讓 agyCliPath 找得到「CLI」，才會走到續期路徑。
    // 沒有它的話測試會依開發機上有沒有裝 agy.exe 而時好時壞。
    const cliEnv = { LOCALAPPDATA: path.join(userDataPath, 'nudge-localappdata') }
    fs.mkdirSync(path.join(cliEnv.LOCALAPPDATA, 'agy', 'bin'), { recursive: true })
    fs.writeFileSync(path.join(cliEnv.LOCALAPPDATA, 'agy', 'bin', 'agy.exe'), 'stub')
    const deps = (expiry, extra = {}) => ({
      env: cliEnv,
      readCredential: async () => credFor(expiry),
      refresh: async () => null, // 沒有 client id／secret，refresh 一定拿不到
      loadCodeAssist: async () => ({ project: 'p', tier: 'Pro' }),
      runCli: async () => { throw new Error('CLI 不可用') }, // 預設：續期不成功
      ...extra
    })

    // tokenIsStale 的 15 分鐘是「該去續期了」的提前量。refresh 拿不到時把它當成
    // 「已經不能用了」，等於每個 token 的最後 15 分鐘都被自己作廢（實測踩過）。
    credential.reset()
    const nearExpiry = await credential.acquire(deps(iso(7 * 60 * 1000)))
    check('refresh 不可用時，還沒過期的 token 照樣能用', nearExpiry.token === 'live-token')

    credential.reset()
    let expiredError = null
    try {
      await credential.acquire(deps(iso(-60 * 1000)))
    } catch (error) {
      expiredError = error
    }
    check('真的過期才拋 TOKEN_EXPIRED', expiredError?.code === 'TOKEN_EXPIRED', String(expiredError?.code))
    check('過期訊息指向重新登入，不是「隨便跑個指令」',
      /重新登入/.test(expiredError?.message || ''), expiredError?.message)

    // 上游說過 401 就代表這個 token 真的死了，本機 expiry 寫什麼都不算數
    credential.reset()
    credential.invalidateToken()
    let after401 = null
    try {
      await credential.acquire(deps(iso(7 * 60 * 1000)))
    } catch (error) {
      after401 = error
    }
    check('401 之後不得復用未過期的舊 token', after401?.code === 'TOKEN_EXPIRED', String(after401?.code))

    // 這是「用一下就斷線」的修法：我們沒有 client id／secret，refresh 一定拿不到，
    // 但 Antigravity CLI 自己有，跑一次任何要連上游的子指令就會續期並寫回
    // Credential Manager。以前得使用者手動下指令，現在由我們代跑。
    credential.reset()
    let cliRuns = 0
    let renewed = false
    const selfHealing = deps(iso(-60 * 1000), {
      readCredential: async () => (renewed
        ? credFor(iso(55 * 60 * 1000), 'renewed-token')
        : credFor(iso(-60 * 1000))),
      runCli: async () => { cliRuns += 1; renewed = true }
    })
    const healed = await credential.acquire(selfHealing)
    check('token 過期時自動跑一次 CLI 續期', cliRuns === 1, `跑了 ${cliRuns} 次`)
    check('續期後直接拿到新 token，不必使用者手動下指令', healed.token === 'renewed-token', healed.token)

    // 續期失敗（CLI 沒裝／登出）仍要拋錯，不能把同一顆死 token 再送一次
    credential.reset()
    const staleAfterCli = deps(iso(-60 * 1000), { runCli: async () => {} })
    let stillDead = null
    try {
      await credential.acquire(staleAfterCli)
    } catch (error) { stillDead = error }
    check('CLI 續期後還是同一顆過期 token → 照樣拋 TOKEN_EXPIRED',
      stillDead?.code === 'TOKEN_EXPIRED', String(stillDead?.code))

    // 還沒過期但已進入「該續期」區間：背景叫 CLI 去換，這次照常用舊 token，不擋使用者
    credential.reset()
    let bgRuns = 0
    const warmup = deps(iso(7 * 60 * 1000), { runCli: async () => { bgRuns += 1 } })
    const served = await credential.acquire(warmup)
    check('快過期時照常回舊 token（不擋這次請求）', served.token === 'live-token', served.token)
    check('同時在背景請 CLI 續期', bgRuns === 1, `跑了 ${bgRuns} 次`)

    // 冷卻：token 尾聲每個請求都會走到這裡，不能每次都開一個程序
    credential.reset()
    let burst = 0
    const bursty = deps(iso(7 * 60 * 1000), { runCli: async () => { burst += 1 } })
    for (let i = 0; i < 5; i += 1) {
      credential.invalidateToken() // 逼每一輪都重走 loadToken
      try { await credential.acquire(bursty) } catch { /* 401 情境下會拋，這裡只看 CLI 次數 */ }
    }
    check('連續請求不會連開一堆 agy.exe', burst === 1, `跑了 ${burst} 次`)
    credential.reset()

    // 代跑 CLI 一定要用 spawn 且 stdin=ignore。改回 execFile（三個 stdio 都是 pipe，
    // 而且 stdin 那條永遠不會關）會讓 agy.exe 卡在等輸入，使用者的請求整整卡滿逾時
    // 才拿到 TOKEN_EXPIRED——同一支指令從主控台跑只要 2～3 秒。實測矩陣見
    // scripts/probe-agy-nudge.js。
    check('代跑 CLI 的 stdin 是 ignore（不能留一條開著的 pipe）',
      credential.CLI_SPAWN_OPTIONS.stdio === 'ignore' ||
      credential.CLI_SPAWN_OPTIONS.stdio?.[0] === 'ignore',
      JSON.stringify(credential.CLI_SPAWN_OPTIONS))
    check('代跑 CLI 不開視窗', credential.CLI_SPAWN_OPTIONS.windowsHide === true)

    // 暫時性失敗（PowerShell 讀憑證逾時、loadCodeAssist 網路抖動）**不可以**設 mustRefresh。
    // 設了的話：之後每一輪都強制 refresh，而沒有 CLIENT_ID／SECRET 時 refresh 一定回 null，
    // loadToken 就一律拋 TOKEN_EXPIRED —— CLI 明明登入著、憑證也沒過期，
    // 頁面卻永遠紅字卡住，重登 CLI 也救不了（旗標在記憶體），只有重開 App 才會好。
    credential.reset()
    let flaky = true
    const flakyDeps = {
      readCredential: async () => {
        if (flaky) { flaky = false; return null } // 第一次模擬讀不到
        return credFor(iso(7 * 60 * 1000))        // 之後正常，但已進入「該續期」區間
      },
      refresh: async () => null,
      loadCodeAssist: async () => ({ project: 'p', tier: 'Pro' })
    }
    const firstTry = await credential.status(flakyDeps)
    const secondTry = await credential.status(flakyDeps)
    check('讀憑證暫時失敗 → NO_CREDENTIAL', firstTry.connected === false && firstTry.code === 'NO_CREDENTIAL',
      JSON.stringify(firstTry))
    check('暫時性失敗不設 mustRefresh：下一輪自己好起來',
      secondTry.connected === true, JSON.stringify(secondTry))
    credential.reset()
  }

  console.log('\n連線自我測試')

  {
    const service = require(path.join(AGY, 'index'))
    const fakeStore = new Map([['agyApiKey', API_KEY], ['agyPort', proxyPort]])
    service.configure({
      userDataPath,
      store: { get: (key, fallback) => (fakeStore.has(key) ? fakeStore.get(key) : fallback), set: (key, value) => fakeStore.set(key, value) }
    })

    credential.reset()
    catalog.reset()
    upstreamState.mode = 'ok'
    const ok = await service.selfTest()
    check('自我測試成功並回報模型與回覆', ok.ok === true && !!ok.model && ok.reply === '非串流答案', JSON.stringify(ok))
    check('自我測試挑的是還有額度的對話模型', ok.model === 'mock-chat-a', String(ok.model))

    upstreamState.mode = 'server-error'
    credential.reset()
    const bad = await service.selfTest()
    check('上游失敗時回 ok:false 與代碼', bad.ok === false && bad.status === 502, JSON.stringify(bad))
    check('自我測試不外洩上游 body／token',
      !JSON.stringify(bad).includes('LEAKY-UPSTREAM-DETAIL') && !JSON.stringify(bad).includes('ya29.'),
      JSON.stringify(bad))
    upstreamState.mode = 'ok'
    credential.reset()
    catalog.reset()
  }

  console.log('\n憑證來源偵測')

  {
    const fakeLocal = path.join(userDataPath, 'fake-localappdata')
    const cliDir = path.join(fakeLocal, 'agy', 'bin')
    const ideDir = path.join(fakeLocal, 'Programs', 'Antigravity')

    check('什麼都沒裝時兩者皆 false', (() => {
      const s = credential.detectSources({ LOCALAPPDATA: fakeLocal })
      return s.cli === false && s.ide === false
    })())

    fs.mkdirSync(cliDir, { recursive: true })
    fs.writeFileSync(path.join(cliDir, 'agy.exe'), 'stub')
    check('偵測得到 Antigravity CLI', credential.detectSources({ LOCALAPPDATA: fakeLocal }).cli === true)

    // 解除安裝會留下空目錄；只看資料夾存不存在會誤判成已安裝（本機實測就是這狀況）
    fs.mkdirSync(ideDir, { recursive: true })
    check('空的 Antigravity 目錄不算裝了 IDE', credential.detectSources({ LOCALAPPDATA: fakeLocal }).ide === false)

    fs.writeFileSync(path.join(ideDir, 'Antigravity.exe'), 'stub')
    check('目錄裡有執行檔才算裝了 IDE', credential.detectSources({ LOCALAPPDATA: fakeLocal }).ide === true)

    check('沒有 LOCALAPPDATA 時不炸', (() => {
      const s = credential.detectSources({})
      return s.cli === false && s.ide === false
    })())

    const credentialStatus = await credential.status({
      readCredential: async () => JSON.stringify({
        token: {
          access_token: 'tok', refresh_token: 'r',
          expiry: new Date(Date.now() + 3600_000).toISOString()
        }
      }),
      refresh: async () => 'tok2',
      loadCodeAssist: async () => ({ project: 'p', tier: 'Ultra' }),
      env: { LOCALAPPDATA: fakeLocal }
    })
    check('status 會帶 sources', typeof credentialStatus.sources?.cli === 'boolean' &&
      typeof credentialStatus.sources?.ide === 'boolean', JSON.stringify(credentialStatus.sources))
    check('sources 不外洩任何路徑', !JSON.stringify(credentialStatus.sources).includes('LOCALAPPDATA') &&
      !JSON.stringify(credentialStatus.sources).toLowerCase().includes('appdata'),
    JSON.stringify(credentialStatus.sources))
    credential.reset()
  }

  console.log('\nIPC 錯誤訊息白名單')

  {
    const { registerAgyIpc } = require(path.join(AGY, 'ipc'))
    const handlers = new Map()
    const fakeIpcMain = { handle: (channel, fn) => handlers.set(channel, fn) }
    let thrower = () => {}

    registerAgyIpc({
      ipcMain: fakeIpcMain,
      service: { listModels: () => thrower(), status: () => ({}) },
      isMainSender: (event) => event?.main === true
    })
    const models = (event) => handlers.get('agy:models')(event, false)

    // 我們自己寫的固定字串可以外送——狀態面板本來就在顯示同一句
    thrower = () => {
      throw new credential.CredentialError('TOKEN_EXPIRED', 'Antigravity token 已過期，請執行一次 agy 指令續期。')
    }
    const credFail = await models({ main: true })
    check('憑證錯誤把代碼與訊息帶給 renderer',
      credFail.ok === false && credFail.error.code === 'TOKEN_EXPIRED' &&
      credFail.error.message.includes('agy 指令'), JSON.stringify(credFail))

    // 上游錯誤沒有 userMessage：message 一律被通用訊息取代，代碼仍保留供分流
    thrower = () => {
      const error = new Error('LEAKY-UPSTREAM-DETAIL ya29.token-in-message')
      error.code = 'UPSTREAM_429'
      throw error
    }
    const upFail = await models({ main: true })
    check('上游錯誤訊息不外洩', upFail.error.message === '反向代理操作失敗' &&
      !JSON.stringify(upFail).includes('LEAKY-UPSTREAM-DETAIL') &&
      !JSON.stringify(upFail).includes('ya29.'), JSON.stringify(upFail))
    check('上游錯誤仍保留代碼', upFail.error.code === 'UPSTREAM_429')

    // userMessage 是白名單，不是「有 message 就送」：偽造欄位以外的錯誤全被擋
    thrower = () => { throw new Error('SOME-INTERNAL-PATH-D:\secret') }
    const plainFail = await models({ main: true })
    check('無標記的錯誤收斂成通用訊息',
      plainFail.error.message === '反向代理操作失敗' && plainFail.error.code === 'AGY_ERROR',
      JSON.stringify(plainFail))

    const forbidden = await models({ main: false })
    check('非主視窗一律 FORBIDDEN', forbidden.ok === false && forbidden.error.code === 'FORBIDDEN')
  }

  await server.stop()

  console.log('\n服務停止中的狀態')

  {
    const service = require(path.join(AGY, 'index'))
    const stopped = await service.status()
    check('停止中不做憑證 acquire', stopped.credential.code === 'NOT_RUNNING')
    // 模型查詢不需要服務跑著；憑證壞掉時 renderer 要靠 sources 決定給哪一種指引
    check('停止中仍帶 sources', typeof stopped.credential.sources?.cli === 'boolean' &&
      typeof stopped.credential.sources?.ide === 'boolean', JSON.stringify(stopped.credential))
  }

  logs.close()
  mock.close()
  fs.rmSync(userDataPath, { recursive: true, force: true })

  console.log(`\n${passed} passed, ${failures.length} failed\n`)
  if (failures.length) console.log(`失敗項目：\n  - ${failures.join('\n  - ')}\n`)
  app.exit(failures.length ? 1 : 0)
}

app.whenReady().then(() => {
  main().catch((error) => {
    console.error('e2e 崩潰:', error)
    app.exit(1)
  })
})
