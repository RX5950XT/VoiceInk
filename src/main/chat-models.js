'use strict'

/**
 * 供應商模型清單掃描：OpenAI 相容的 `GET {apiUrl}/models`。
 *
 * 放在 main 而不是 renderer 的理由：
 * 1. 目標 URL 只能來自 store 裡已存好的供應商，renderer 給的是 providerId 而不是網址，
 *    否則這個功能就等於開一個「叫 App 去打任意網址」的跳板。
 * 2. 錯誤要收斂成安全摘要——上游的 error body 可能整段回填 API Key。
 */

const TIMEOUT_MS = 15_000
const MAX_BODY_BYTES = 2 * 1024 * 1024
const MAX_MODELS = 500
const MAX_MODEL_ID = 200

class ScanError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ScanError'
    this.code = code
  }
}

/**
 * `https://x.com/api/v1` → `https://x.com/api/v1/models`
 * @param {string} apiUrl
 * @returns {string}
 */
function modelsUrl(apiUrl) {
  return `${String(apiUrl).replace(/\/+$/, '')}/models`
}

/**
 * 從各種常見形狀撈出 model id。
 * OpenAI／OpenRouter 是 `{data:[{id}]}`；有些相容實作直接回陣列。
 * @param {unknown} payload
 * @returns {string[]}
 */
function extractIds(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : (Array.isArray(payload?.data) ? payload.data : (Array.isArray(payload?.models) ? payload.models : []))
  const seen = new Set()
  const out = []
  for (const row of rows) {
    const id = typeof row === 'string'
      ? row
      : (typeof row?.id === 'string' ? row.id : (typeof row?.name === 'string' ? row.name : ''))
    const trimmed = id.trim().slice(0, MAX_MODEL_ID)
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
    if (out.length >= MAX_MODELS) break
  }
  return out
}

/**
 * 讀回應但不讓它無限長：相容實作回幾百 MB 也不該把 main 吃爆。
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function readBounded(response) {
  const reader = response.body?.getReader()
  if (!reader) return await response.text()
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {})
      throw new ScanError('TOO_LARGE', '模型清單回應過大')
    }
    text += decoder.decode(value, { stream: true })
  }
  return text
}

/**
 * @param {{ apiUrl: string, apiKey: string, fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ ok: true, models: string[] } | { ok: false, code: string, error: string }>}
 */
async function fetchModels({ apiUrl, apiKey, fetchImpl }) {
  const url = String(apiUrl || '').trim()
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, code: 'BAD_URL', error: '這個供應商的 API URL 不正確' }
  }

  const impl = fetchImpl || globalThis.fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const headers = { Accept: 'application/json' }
    const key = String(apiKey || '').trim()
    if (key) headers.Authorization = `Bearer ${key}`

    const response = await impl(modelsUrl(url), {
      method: 'GET',
      headers,
      signal: controller.signal
    })

    if (!response.ok) {
      // 只留狀態碼。上游的 error body 常常把送出去的 Authorization 原樣回填。
      const hint = response.status === 401 || response.status === 403
        ? '（API Key 可能不正確）'
        : (response.status === 404 ? '（這個端點可能不支援 /models）' : '')
      return { ok: false, code: `HTTP_${response.status}`, error: `模型清單讀取失敗：HTTP ${response.status}${hint}` }
    }

    const text = await readBounded(response)
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      return { ok: false, code: 'BAD_JSON', error: '模型清單不是合法的 JSON' }
    }

    const models = extractIds(payload)
    if (!models.length) return { ok: false, code: 'EMPTY', error: '這個端點沒有回傳任何模型' }
    return { ok: true, models }
  } catch (error) {
    if (error instanceof ScanError) return { ok: false, code: error.code, error: error.message }
    if (error?.name === 'AbortError') return { ok: false, code: 'TIMEOUT', error: '模型清單讀取逾時' }
    return { ok: false, code: 'NETWORK', error: '無法連線到這個供應商' }
  } finally {
    clearTimeout(timer)
  }
}

module.exports = {
  fetchModels,
  extractIds,
  modelsUrl,
  TIMEOUT_MS,
  MAX_MODELS
}
