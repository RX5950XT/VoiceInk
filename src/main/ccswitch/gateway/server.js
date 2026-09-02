'use strict'

/**
 * Claude Code 專用的本機轉換閘道（Main Process）。
 *
 * Claude Code 只會講 Anthropic Messages 協議，而上游可選 Responses 或 Chat Completions。
 * 這支就是中間那一層：
 *
 *     Claude Code → http://127.0.0.1:<port>/<供應商>/v1/messages → 上游
 *
 * 防護寫法沿用 AGY 的 `agy/server.js`：**只綁 127.0.0.1**、`Host` 必須是本機
 * （擋 DNS rebinding）、強制帶金鑰、請求本體有上限。上游的狀態碼一律收斂成 502
 * （429 除外），錯誤訊息只留我們自己寫的字，不透傳上游 body。
 */

const http = require('http')
const { timingSafeEqual } = require('crypto')
const convert = require('./convert')
const credential = require('./credential')

const HOST = '127.0.0.1'
const MAX_BODY_BYTES = 32 * 1024 * 1024
/** 只接受指向本機的 Host */
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
/** cli-chat-proxy 只驗「有沒有帶、夠不夠新」，不比對本機真的裝了哪一版 */
const GROK_CLI_VERSION = '1.0.13'
/** 首個 token 的等待上限；之後改看閒置 */
const FIRST_TOKEN_MS = 120_000
const IDLE_MS = 180_000

/**
 * 支援的路由。key 對應 `presets.js` 的 preset id。
 *
 * `wire` 決定送上游哪一種形狀；`auth` 決定 token 從哪來。
 * 這是舊呼叫與測試用的固定表；正式請求會先由 main 依供應商選擇解析動態路由。
 */
const ROUTES = Object.freeze({
  codex: {
    wire: 'responses',
    auth: 'codex',
    url: 'https://chatgpt.com/backend-api/codex/responses',
    // ChatGPT 後端要這兩個標頭才認得是 Codex 客戶端
    headers: (ctx) => ({
      'chatgpt-account-id': ctx.accountId || '',
      originator: 'codex_cli_rs',
      'OpenAI-Beta': 'responses=experimental'
    })
  },
  'grok-build': {
    wire: 'responses',
    auth: 'grok',
    // api.x.ai 是 API 金鑰那條（OAuth token 過去一律 403 spending-limit）；
    // 訂閱制走 CLI 的代理，而它會擋沒帶版本的請求（426 outdated）
    url: 'https://cli-chat-proxy.grok.com/v1/responses',
    headers: () => ({ 'x-grok-client-version': GROK_CLI_VERSION })
  },
  'ollama-cloud': {
    wire: 'responses',
    auth: 'key',
    url: 'https://ollama.com/v1/responses',
    headers: () => ({})
  },
  'opencode-go': {
    wire: 'responses',
    auth: 'key',
    url: 'https://opencode.ai/zen/go/v1/responses',
    headers: () => ({})
  },
  commandcode: {
    wire: 'chat',
    auth: 'key',
    url: 'https://api.commandcode.ai/provider/v1/chat/completions',
    headers: () => ({})
  }
})

let server = null
let settings = {
  port: 0,
  apiKey: '',
  getProviderKey: () => '',
  getAccountId: () => '',
  // 自訂供應商的上游位址與形狀由 main 從 store 查（見 providers.resolveRoute）；
  // 回 null 就是「沒這個端點」，一律 404，不會有人能靠路徑指定要打哪裡
  resolveRoute: async () => null
}
let startedAt = 0

/** 測試用的注入點：正式執行時是空物件（走真的上游與本機憑證） */
let deps = {}

/**
 * @param {object} options
 */
function configure(options = {}) {
  deps = options && typeof options === 'object' ? options : {}
}

// ===== 共用小工具 =====

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * @param {import('http').IncomingMessage} req
 * @returns {boolean}
 */
function hostAllowed(req) {
  const host = String(req.headers.host || '')
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return ALLOWED_HOSTS.has(name)
}

/**
 * Claude Code 送 `x-api-key`；有些客戶端送 Bearer。
 * @param {import('http').IncomingMessage} req
 * @returns {string}
 */
function presentedKey(req) {
  const header = String(req.headers.authorization || '')
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim()
  const apiKey = req.headers['x-api-key']
  return typeof apiKey === 'string' ? apiKey.trim() : ''
}

/**
 * @param {import('http').ServerResponse} res
 * @param {number} status
 * @param {object} payload
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

/**
 * 錯誤要長成 Anthropic 的形狀，否則 Claude Code 解析不了。
 * @param {import('http').ServerResponse} res
 * @param {number} status
 * @param {string} message
 */
function sendError(res, status, message) {
  sendJson(res, status, {
    type: 'error',
    error: { type: status === 401 ? 'authentication_error' : 'api_error', message }
  })
}

/**
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<object>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    /** @type {Buffer[]} */
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('BODY_TOO_LARGE'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        reject(new Error('INVALID_JSON'))
      }
    })
    req.on('error', () => reject(new Error('READ_FAILED')))
  })
}

// ===== 上游 =====

/**
 * 取這條路由要用的 Authorization。
 * @param {object} route
 * @param {string} presetId
 * @param {boolean} force 上游回過 401 就強制重換
 * @returns {Promise<{ token: string, accountId: string }>}
 */
async function authFor(route, presetId, force) {
  if (route.auth === 'key') {
    // 取金鑰是讀 electron-store，會回 Promise——沒 await 的話拿到的是 Promise 物件，
    // 它是 truthy，會被當成 token 原樣送出去
    const key = await settings.getProviderKey(presetId)
    if (!key) {
      const error = new Error('MISSING_API_KEY')
      error.userMessage = '這家需要 API 金鑰，請到 Claude Code 頁把金鑰填好'
      throw error
    }
    return { token: key, accountId: '' }
  }
  const provider = route.auth === 'codex' ? 'codex' : 'grok-build'
  // 使用者在本 App 自己登入過就用那組（`getAccountId` 回我們自己的帳號 id）；
  // 沒有的話退回讀已安裝 CLI 的憑證，只裝 CLI 不登入這裡也照樣能用
  const oauthAccountId = await settings.getAccountId(presetId)
  return (deps.credential || credential).acquire(provider, { force, oauthAccountId })
}

/**
 * 逐格讀上游 SSE。上游一定是 `text/event-stream`。
 * @param {Response} response
 * @param {(payload: object) => void} onPayload
 * @param {() => void} onActivity
 */
async function readSse(response, onPayload, onActivity) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      onActivity()
      buffer += decoder.decode(value, { stream: true })
      let index = buffer.indexOf('\n\n')
      while (index >= 0) {
        const frame = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (!data || data === '[DONE]') continue
          try {
            onPayload(JSON.parse(data))
          } catch {
            // 上游偶爾夾雜非 JSON 的心跳，跳過
          }
        }
        index = buffer.indexOf('\n\n')
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * 一次上游請求。401 會強制換 token 重試一次。
 * @param {object} route
 * @param {string} presetId
 * @param {object} upstreamBody
 * @returns {Promise<Response>}
 */
async function callUpstream(route, presetId, upstreamBody) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch
  const url = deps.baseUrl ? `${deps.baseUrl}/${presetId}` : route.url

  for (let attempt = 0; attempt < 2; attempt++) {
    const auth = await authFor(route, presetId, attempt > 0)
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${auth.token}`,
        ...headersFor(route, { accountId: auth.accountId })
      },
      body: JSON.stringify(upstreamBody)
    })
    if (response.status !== 401 || attempt > 0 || route.auth === 'key') return response
    // 上游說 token 不能用了：清掉快取那顆，下一圈強制重換
    ;(deps.credential || credential).invalidate(route.auth === 'codex' ? 'codex' : 'grok-build')
    // 沒有消耗掉 body 的話 undici 的連線會卡到 GC
    try {
      await response.body?.cancel()
    } catch {
      // 已經關了
    }
  }
  throw new Error('UNREACHABLE')
}

/**
 * 動態路由只回傳格式與 URL；特殊 CLI 標頭仍由閘道集中管理。
 * @param {{ auth?: string, headers?: (ctx: object) => Record<string, string> }} route
 * @param {{ accountId?: string }} context
 * @returns {Record<string, string>}
 */
function headersFor(route, context) {
  if (typeof route.headers === 'function') return route.headers(context)
  if (route.auth === 'codex') {
    return {
      'chatgpt-account-id': context.accountId || '',
      originator: 'codex_cli_rs',
      'OpenAI-Beta': 'responses=experimental'
    }
  }
  if (route.auth === 'grok') return { 'x-grok-client-version': GROK_CLI_VERSION }
  return {}
}

// ===== 請求處理 =====

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
async function handle(req, res) {
  if (!hostAllowed(req)) {
    sendError(res, 400, '只接受本機請求')
    return
  }

  const url = new URL(req.url || '/', `http://${HOST}`)
  // `/health` 刻意不需鑑權：頁面與客戶端都靠它探測
  if (url.pathname === '/health') {
    sendJson(res, 200, { ok: true, uptimeMs: startedAt ? Date.now() - startedAt : 0 })
    return
  }

  // 自訂供應商的路由段是 provider id（`p_<base36>_<亂數>`），所以要收底線
  const match = url.pathname.match(/^\/([a-z0-9_-]+)\/v1\/messages$/)
  let route = null
  if (match) {
    // 先問 main，讓使用者選的上游格式覆蓋固定預設；測試與舊呼叫才退回固定表。
    const dynamic = await settings.resolveRoute(match[1]).catch(() => null)
    if (dynamic?.disabled) route = null
    else if (dynamic) route = dynamic
    else route = ROUTES[match[1]] || null
  }
  if (!route) {
    sendError(res, 404, '沒有這個端點')
    return
  }
  if (req.method !== 'POST') {
    sendError(res, 405, '只接受 POST')
    return
  }
  if (!settings.apiKey || !safeEqual(presentedKey(req), settings.apiKey)) {
    sendError(res, 401, '金鑰不正確')
    return
  }

  let body
  try {
    body = await readBody(req)
  } catch (error) {
    sendError(res, 400, error.message === 'BODY_TOO_LARGE' ? '請求太大' : '請求不是合法 JSON')
    return
  }

  const presetId = match[1]
  const model = typeof body.model === 'string' && body.model ? body.model : 'unknown'
  const wantsStream = body.stream !== false
  const collector = convert.createCollector(model)
  const state = convert.newConsumeState()
  const consume = route.wire === 'responses' ? convert.consumeResponses : convert.consumeChat
  const upstreamBody = route.wire === 'responses'
    ? convert.toResponsesRequest(body, model)
    : convert.toChatRequest(body, model)

  let response
  try {
    response = await callUpstream(route, presetId, upstreamBody)
  } catch (error) {
    sendError(res, 502, error?.userMessage || '無法連線上游')
    return
  }

  if (!response.ok) {
    // 上游狀態碼不透傳：429 帶 retry-after 原樣回，其餘一律 502。
    // 直接把上游的 401／403 丟回去，Claude Code 會誤判成自己的金鑰壞了。
    try {
      await response.body?.cancel()
    } catch {
      // 已經關了
    }
    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after')
      if (retryAfter) res.setHeader('retry-after', retryAfter)
      sendError(res, 429, '上游要求稍後再試')
      return
    }
    sendError(res, 502, `上游回應失敗（HTTP ${response.status}）`)
    return
  }

  if (!wantsStream) {
    try {
      await readSse(response, (payload) => {
        for (const delta of consume(payload, state)) convert.apply(collector, delta)
      }, () => {})
      sendJson(res, 200, convert.toResponse(collector))
    } catch {
      sendError(res, 502, '上游串流中斷')
    }
    return
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive'
  })

  // 串流不可以用 AbortSignal.timeout（會砍掉長連線）→ 首 token 與閒置各一個計時器
  let timer = setTimeout(() => {
    res.write(convert.errorStream(collector, 'UPSTREAM_TIMEOUT'))
    res.end()
    response.body?.cancel().catch(() => {})
  }, FIRST_TOKEN_MS)
  const bump = (ms) => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      res.write(convert.errorStream(collector, 'UPSTREAM_IDLE'))
      res.end()
      response.body?.cancel().catch(() => {})
    }, ms)
  }

  try {
    await readSse(response, (payload) => {
      for (const delta of consume(payload, state)) {
        const chunk = convert.apply(collector, delta)
        if (chunk) res.write(chunk)
      }
    }, () => bump(IDLE_MS))
    clearTimeout(timer)
    if (!res.writableEnded) {
      res.write(convert.closeStream(collector))
      res.end()
    }
  } catch {
    clearTimeout(timer)
    if (!res.writableEnded) {
      res.write(convert.errorStream(collector, 'UPSTREAM_STREAM_FAILED'))
      res.end()
    }
  }
}

// ===== 生命週期 =====

/**
 * @param {{ port: number, apiKey: string, getProviderKey: (presetId: string) => string, getAccountId?: (presetId: string) => string, resolveRoute?: (routeKey: string) => Promise<object|null|{disabled: boolean}> }} next
 * @returns {Promise<{ port: number }>}
 */
function start(next) {
  settings = { ...settings, ...next }
  if (server) return Promise.resolve({ port: server.address()?.port || settings.port })
  return new Promise((resolve, reject) => {
    const instance = http.createServer((req, res) => {
      handle(req, res).catch(() => {
        if (!res.headersSent) sendError(res, 500, '閘道內部錯誤')
        else if (!res.writableEnded) res.end()
      })
    })
    instance.on('error', (error) => {
      server = null
      reject(error)
    })
    instance.listen(settings.port, HOST, () => {
      server = instance
      startedAt = Date.now()
      resolve({ port: instance.address().port })
    })
  })
}

/** @returns {Promise<void>} */
function stop() {
  if (!server) return Promise.resolve()
  const instance = server
  server = null
  startedAt = 0
  return new Promise((resolve) => instance.close(() => resolve()))
}

/**
 * @returns {{ running: boolean, port: number, baseUrl: string }}
 */
function status() {
  const port = server?.address()?.port || 0
  return {
    running: Boolean(server),
    port,
    baseUrl: port ? `http://${HOST}:${port}` : ''
  }
}

module.exports = {
  HOST,
  ROUTES,
  MAX_BODY_BYTES,
  configure,
  start,
  stop,
  status
}
