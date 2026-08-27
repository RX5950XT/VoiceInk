'use strict'

const http = require('http')
const { randomUUID, timingSafeEqual } = require('crypto')
const anthropic = require('./anthropic')
const catalog = require('./catalog')
const logs = require('./logs')
const openai = require('./openai')
const upstream = require('./upstream')
const { listModels, resolveModel } = require('./model-map')

const HOST = '127.0.0.1'
const MAX_BODY_BYTES = 32 * 1024 * 1024
/** 只接受指向本機的 Host，擋 DNS rebinding（惡意網域解析到 127.0.0.1） */
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

const ADAPTERS = Object.freeze({
  openai: { protocol: 'openai', mapper: openai, contentType: 'application/json' },
  anthropic: { protocol: 'anthropic', mapper: anthropic, contentType: 'application/json' }
})

let server = null
let settings = { port: 0, apiKey: '', logBodies: false }
let startedAt = 0
let activeRequests = 0

/**
 * 上游注入點：正式執行時是空物件（走真的 cloudcode-pa 與本機憑證），
 * e2e 用它把 baseUrl 與憑證鏈指向 mock。不經過 IPC，renderer 碰不到。
 */
let upstreamOptions = {}

function configureUpstream(options) {
  upstreamOptions = options && typeof options === 'object' ? options : {}
}

// ===== 共用小工具 =====

function safeEqual(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function hostAllowed(req) {
  const host = String(req.headers.host || '')
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return ALLOWED_HOSTS.has(name)
}

/** Anthropic 客戶端送 x-api-key，OpenAI 客戶端送 Authorization: Bearer */
function presentedKey(req) {
  const header = String(req.headers.authorization || '')
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim()
  const apiKey = req.headers['x-api-key']
  return typeof apiKey === 'string' ? apiKey.trim() : ''
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

/** 錯誤回應要長成各協議自己的形狀，否則客戶端會解析失敗 */
function sendError(res, protocol, status, code, message) {
  if (protocol === 'anthropic') {
    sendJson(res, status, {
      type: 'error',
      error: { type: status === 401 ? 'authentication_error' : 'api_error', message: message || code }
    })
    return
  }
  sendJson(res, status, {
    error: { message: message || code, type: 'invalid_request_error', code }
  })
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('BODY_TOO_LARGE'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => reject(new Error('BODY_READ_FAILED')))
  })
}

/**
 * 上游狀態碼 → 回給客戶端的狀態碼。
 * 只有 429 值得原樣透傳（客戶端知道要等）；其餘一律收斂成 502，
 * 直接把上游的 401／403 丟回去會讓客戶端誤判成自己的 API key 有問題。
 */
function statusFor(error, code) {
  if (code === 'BODY_TOO_LARGE') return 413
  if (code === 'NO_CREDENTIAL' || code === 'TOKEN_EXPIRED') return 503
  if (code === 'CLIENT_ABORTED') return 499
  if (error?.status === 429) return 429
  return 502
}

// ===== 請求管線 =====

/**
 * 兩個協議共用：讀 body → 轉 Gemini → 呼叫上游 → 轉回目標協議 → 記日誌。
 * 差別只在傳進來的 adapter。
 */
async function handleCompletion(req, res, adapter) {
  const startedMs = Date.now()
  const { protocol, mapper } = adapter
  const entry = {
    id: randomUUID(),
    ts: startedMs,
    protocol,
    path: req.url.split('?')[0],
    status: 0,
    durationMs: 0,
    stream: false
  }

  let collector = null
  let wroteHeaders = false

  try {
    const raw = await readBody(req)
    if (settings.logBodies) entry.requestBody = raw

    let body
    try {
      body = JSON.parse(raw)
    } catch {
      entry.status = 400
      entry.errorCode = 'INVALID_JSON'
      sendError(res, protocol, 400, 'INVALID_JSON', '請求不是合法的 JSON')
      return
    }

    const { model, mapped } = resolveModel(body.model)
    entry.model = model
    entry.mappedModel = mapped
    entry.stream = body.stream === true

    const inner = mapper.toGeminiRequest(body, mapped)
    collector = mapper.createCollector(model || mapped)

    const controller = new AbortController()
    req.on('close', () => {
      if (!res.writableEnded) controller.abort()
    })

    if (!entry.stream) {
      const payload = await upstream.once({ inner, model: mapped, signal: controller.signal, options: upstreamOptions })
      mapper.consume(collector, payload)
      const response = mapper.toResponse(collector)
      entry.status = 200
      if (settings.logBodies) entry.responseBody = JSON.stringify(response)
      sendJson(res, 200, response)
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
    wroteHeaders = true
    entry.status = 200

    await upstream.stream({
      inner,
      model: mapped,
      signal: controller.signal,
      options: upstreamOptions,
      onFrame: (payload) => {
        const chunk = mapper.consume(collector, payload)
        if (chunk && !res.writableEnded) res.write(chunk)
      }
    })
    if (!res.writableEnded) res.write(mapper.closeStream(collector))
    if (settings.logBodies) entry.responseBody = collector.text
  } catch (error) {
    const code = error?.code || (error?.message === 'BODY_TOO_LARGE' ? 'BODY_TOO_LARGE' : 'INTERNAL_ERROR')
    entry.errorCode = code
    const status = statusFor(error, code)
    entry.status = status

    if (wroteHeaders) {
      // 已經回過 200，只能用串流內的錯誤格告知客戶端
      if (!res.writableEnded) res.write(mapper.errorStream(collector, code))
    } else if (!res.writableEnded) {
      const message = code === 'NO_CREDENTIAL' || code === 'TOKEN_EXPIRED'
        ? error.message
        : `上游請求失敗（${code}）`
      if (error?.retryAfter) res.setHeader('retry-after', error.retryAfter)
      sendError(res, protocol, status, code, message)
    }
  } finally {
    if (!res.writableEnded) res.end()
    entry.durationMs = Date.now() - startedMs
    if (collector?.usage) {
      entry.inputTokens = collector.usage.input
      entry.outputTokens = collector.usage.output
      entry.thoughtTokens = collector.usage.thought
      entry.cachedTokens = collector.usage.cached
    }
    logs.append(entry)
  }
}

async function handleCountTokens(req, res) {
  try {
    const body = JSON.parse(await readBody(req))
    const { model, mapped } = resolveModel(body.model)
    const inner = anthropic.toGeminiRequest(body, mapped)
    const total = await upstream.countTokens({ inner, model: mapped, options: upstreamOptions })
    sendJson(res, 200, { input_tokens: total })
  } catch (error) {
    // 走 statusFor，跟另外兩個端點同一套：上游狀態碼不透傳。
    // 原本 `error.status >= 400 ? error.status : 502` 會把上游的 401／403 原樣丟回去，
    // 客戶端（Claude Code CLI 就是靠 count_tokens 估上下文的）會誤判成自己的 API key 壞了。
    const code = error?.code || 'INTERNAL_ERROR'
    if (error?.retryAfter) res.setHeader('retry-after', error.retryAfter)
    sendError(res, 'anthropic', statusFor(error, code), code, `無法計算 token（${code}）`)
  }
}

function route(req, res) {
  const pathname = String(req.url || '').split('?')[0]

  // /health 不需鑑權：客戶端與本頁都靠它探測服務是否活著
  if (pathname === '/health' || pathname === '/healthz') {
    sendJson(res, 200, { ok: true, uptimeMs: startedAt ? Date.now() - startedAt : 0 })
    return
  }

  if (!hostAllowed(req)) {
    sendError(res, 'openai', 403, 'FORBIDDEN_HOST', '只接受本機連線')
    return
  }

  const protocol = pathname.startsWith('/v1/messages') ? 'anthropic' : 'openai'
  if (!settings.apiKey || !safeEqual(presentedKey(req), settings.apiKey)) {
    sendError(res, protocol, 401, 'UNAUTHORIZED', 'API key 不正確')
    return
  }

  if (req.method === 'GET' && (pathname === '/v1/models' || pathname === '/v1/models/claude')) {
    // 靜態表只是退路：它列過會 404／500 的模型，而且缺整個新世代。
    // 客戶端拿這份填下拉選單，給錯清單等於讓使用者選到不能用的模型。
    void catalog.listForApi({ options: upstreamOptions })
      .then((live) => sendJson(res, 200, { object: 'list', data: live || listModels() }))
      .catch(() => sendJson(res, 200, { object: 'list', data: listModels() }))
    return
  }
  if (req.method === 'POST' && pathname === '/v1/chat/completions') {
    void handleCompletion(req, res, ADAPTERS.openai)
    return
  }
  if (req.method === 'POST' && pathname === '/v1/messages') {
    void handleCompletion(req, res, ADAPTERS.anthropic)
    return
  }
  if (req.method === 'POST' && pathname === '/v1/messages/count_tokens') {
    void handleCountTokens(req, res)
    return
  }

  sendError(res, protocol, 404, 'NOT_FOUND', '端點不存在')
}

// ===== 生命週期 =====

/** @param {{ port: number, apiKey: string, logBodies: boolean }} next */
function applySettings(next) {
  settings = {
    port: Number(next.port) || settings.port,
    apiKey: typeof next.apiKey === 'string' ? next.apiKey : settings.apiKey,
    logBodies: next.logBodies === true
  }
}

function start(next) {
  applySettings(next)
  if (server) return Promise.resolve({ ok: true, port: settings.port })
  if (!settings.apiKey) {
    return Promise.resolve({ ok: false, error: 'NO_API_KEY' })
  }

  return new Promise((resolve) => {
    const instance = http.createServer((req, res) => {
      activeRequests += 1
      res.on('close', () => { activeRequests -= 1 })
      try {
        route(req, res)
      } catch {
        if (!res.writableEnded) sendError(res, 'openai', 500, 'INTERNAL_ERROR', '內部錯誤')
      }
    })
    // 單一請求可能跑很久（長回覆），關掉 Node 預設的 socket 逾時
    instance.requestTimeout = 0
    instance.headersTimeout = 60_000
    instance.keepAliveTimeout = 75_000

    instance.once('error', (error) => {
      server = null
      resolve({ ok: false, error: error?.code === 'EADDRINUSE' ? 'PORT_IN_USE' : 'LISTEN_FAILED' })
    })
    instance.listen(settings.port, HOST, () => {
      server = instance
      startedAt = Date.now()
      resolve({ ok: true, port: settings.port })
    })
  })
}

function stop() {
  if (!server) return Promise.resolve(true)
  const instance = server
  server = null
  startedAt = 0
  return new Promise((resolve) => {
    instance.closeAllConnections?.()
    instance.close(() => resolve(true))
    // close 在還有 keep-alive 連線時可能不回呼，給它一個上限
    setTimeout(() => resolve(true), 2000).unref?.()
  })
}

function status() {
  // 回實際監聽到的埠，不是設定值：port 0 由 OS 指派，兩者會不同
  const bound = server?.address?.()
  return {
    running: !!server,
    host: HOST,
    port: bound && typeof bound === 'object' ? bound.port : settings.port,
    uptimeMs: startedAt ? Date.now() - startedAt : 0,
    activeRequests
  }
}

/** e2e 注入的上游設定；型錄也要走同一份，否則測試會打到真實上游 */
function getUpstreamOptions() {
  return upstreamOptions
}

module.exports = {
  getUpstreamOptions,
  HOST,
  MAX_BODY_BYTES,
  applySettings,
  configureUpstream,
  start,
  status,
  stop
}
