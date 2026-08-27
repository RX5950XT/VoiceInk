'use strict'

const { randomUUID } = require('crypto')
const credential = require('./credential')
const { USER_AGENT } = require('../usage/antigravity')

/**
 * cloudcode-pa 上游呼叫。
 *
 * 端點順序 sandbox → daily → prod 是實測結果，不是抄來的偏好：
 * 同一組憑證同一個請求，prod 回 429 RESOURCE_EXHAUSTED，sandbox 回 200。
 * （驗證：scripts/probe-agy-upstream.js）
 */
const BASE_URLS = Object.freeze([
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal',
  'https://daily-cloudcode-pa.googleapis.com/v1internal',
  'https://cloudcode-pa.googleapis.com/v1internal'
])

/** 換下一個端點才有意義的狀態；0 代表連不上。400/401 換幾個網域都一樣。 */
const RETRYABLE_STATUSES = new Set([0, 403, 429, 500, 502, 503, 504])

/** 首 token 與閒置各一個計時器；不能用 AbortSignal.timeout，那會砍掉正常的長連線 */
const FIRST_TOKEN_TIMEOUT_MS = 60_000
const IDLE_TIMEOUT_MS = 120_000
const MAX_ONCE_BYTES = 32 * 1024 * 1024

class UpstreamError extends Error {
  constructor(code, status = 0) {
    super(code)
    this.name = 'UpstreamError'
    this.code = code
    this.status = status
  }
}

function buildBody({ inner, model, project }) {
  const body = {
    project: project || '',
    request: inner,
    model,
    userAgent: USER_AGENT,
    requestId: randomUUID()
  }
  if (!body.project) delete body.project
  return body
}

/**
 * 刻意不送 x-goog-user-project。
 * loadCodeAssist 回的 project 沒有啟用 Cloud Code Private API，帶上去每一個端點都回
 * 403 SERVICE_DISABLED；project 走 body 就正常。實測：帶 header→403／不帶→200。
 */
function buildHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: '*/*',
    'User-Agent': USER_AGENT
  }
}

/**
 * 非 2xx 的 body 不讀。不 cancel 的話 undici 會佔住連線直到 GC。
 * @param {Response} response
 */
function discardResponse(response) {
  try {
    const body = response?.body
    if (body && typeof body.cancel === 'function') {
      body.cancel().catch(() => {})
      return
    }
    if (typeof response?.arrayBuffer === 'function') {
      response.arrayBuffer().catch(() => {})
    }
  } catch {
    /* ignore */
  }
}

/**
 * 發一次上游請求。兩層重試：401 換新 token 再試一次（同端點），
 * 該端點仍不通就換下一個端點。
 * 全部發生在讀 body 之前——一旦開始往客戶端寫串流就沒有回頭路。
 */
async function send(method, { inner, model, signal, options = {} }) {
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const bases = options.baseUrl ? [options.baseUrl] : BASE_URLS
  const suffix = method === 'streamGenerateContent' ? '?alt=sse' : ''
  let lastError = new UpstreamError('UPSTREAM_UNREACHABLE')

  for (const base of bases) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { token, project } = await credential.acquire(options)
      let response
      try {
        // 三個端點三種信封：
        //   generateContent／streamGenerateContent → { project, request, model, userAgent }
        //   countTokens                           → { request }（多送會 400 Unknown name）
        //   fetchAvailableModels                  → {}（型錄不吃任何參數）
        let payload
        if (method === 'countTokens') payload = { request: { model, ...inner } }
        else if (method === 'fetchAvailableModels') payload = {}
        else payload = buildBody({ inner, model, project })
        response = await fetchImpl(`${base}:${method}${suffix}`, {
          method: 'POST',
          headers: buildHeaders(token),
          body: JSON.stringify(payload),
          signal
        })
      } catch (error) {
        if (error?.name === 'AbortError') throw new UpstreamError('CLIENT_ABORTED')
        lastError = new UpstreamError('UPSTREAM_UNREACHABLE')
        break
      }

      if (response.status === 401 && attempt === 0) {
        discardResponse(response)
        credential.invalidateToken()
        continue
      }
      if (response.ok) return response

      // 只留狀態碼；上游 body 可能含 token 或帳號資訊，一律不外洩
      const retryAfter = response.headers?.get?.('retry-after') || ''
      lastError = new UpstreamError(`UPSTREAM_${response.status}`, response.status)
      if (retryAfter) lastError.retryAfter = retryAfter
      discardResponse(response)
      break
    }
    if (!RETRYABLE_STATUSES.has(lastError.status)) break
  }
  throw lastError
}

/**
 * 讀 SSE，逐格回呼。
 * @param {Response} response
 * @param {(payload: object) => void} onFrame
 */
async function pumpSse(response, onFrame) {
  const body = response.body
  if (!body) throw new UpstreamError('UPSTREAM_EMPTY_BODY')

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let firstFrame = false

  let timer = null
  const arm = (ms) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { void reader.cancel().catch(() => {}) }, ms)
  }
  arm(FIRST_TOKEN_TIMEOUT_MS)

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      arm(firstFrame ? IDLE_TIMEOUT_MS : FIRST_TOKEN_TIMEOUT_MS)
      buffer += decoder.decode(value, { stream: true })

      let index = buffer.indexOf('\n')
      while (index !== -1) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
        if (!line.startsWith('data:')) continue
        const raw = line.slice(5).trim()
        if (!raw || raw === '[DONE]') continue
        try {
          onFrame(JSON.parse(raw))
          firstFrame = true
        } catch {
          // 單格壞掉不該中斷整串；上游偶爾會塞入非 JSON 的 keep-alive
        }
      }
    }
  } finally {
    if (timer) clearTimeout(timer)
    reader.releaseLock?.()
  }
}

/** 串流：每收到一格就回呼 */
async function stream({ inner, model, signal, onFrame, options }) {
  const response = await send('streamGenerateContent', { inner, model, signal, options })
  await pumpSse(response, onFrame)
}

/** 非串流：讀完整包 JSON */
async function once({ inner, model, signal, options }) {
  const response = await send('generateContent', { inner, model, signal, options })
  const text = await response.text()
  if (text.length > MAX_ONCE_BYTES) throw new UpstreamError('UPSTREAM_BODY_TOO_LARGE')
  try {
    return JSON.parse(text)
  } catch {
    throw new UpstreamError('UPSTREAM_INVALID_JSON')
  }
}

/**
 * 上游的模型型錄。
 *
 * 這是唯一的權威清單：`model-map.js` 那張表是給「客戶端寫死、上游不存在」的名字用的，
 * 真正有哪些模型可用只有這裡說了算（實測發現靜態表裡有好幾個會 404／500 的）。
 * @returns {Promise<object>} 原始回應，解析交給 catalog.js
 */
async function fetchAvailableModels({ signal, options } = {}) {
  const response = await send('fetchAvailableModels', { inner: null, model: '', signal, options })
  const text = await response.text()
  if (text.length > MAX_ONCE_BYTES) throw new UpstreamError('UPSTREAM_BODY_TOO_LARGE')
  try {
    return JSON.parse(text)
  } catch {
    throw new UpstreamError('UPSTREAM_INVALID_JSON')
  }
}

/** Anthropic 的 /v1/messages/count_tokens 需要，上游有對應端點 */
async function countTokens({ inner, model, signal, options }) {
  const response = await send('countTokens', { inner, model, signal, options })
  const text = await response.text()
  try {
    const parsed = JSON.parse(text)
    const total = Number(parsed?.totalTokens ?? parsed?.response?.totalTokens)
    return Number.isFinite(total) && total >= 0 ? Math.floor(total) : 0
  } catch {
    throw new UpstreamError('UPSTREAM_INVALID_JSON')
  }
}

module.exports = {
  BASE_URLS,
  UpstreamError,
  buildBody,
  countTokens,
  fetchAvailableModels,
  once,
  stream
}
