'use strict'

const fs = require('fs/promises')
const {
  PROVIDER_IDS,
  PROVIDER_META,
  FILE_MAX_BYTES,
  HTTP_TIMEOUT_MS,
  API_MAX_BYTES
} = require('./constants')

const PROVIDER_SET = new Set(PROVIDER_IDS)
const STATUS_SET = new Set([
  'available',
  'warning',
  'limited',
  'connected',
  'disconnected'
])
const ACCURACY_SET = new Set(['official', 'local', 'estimated'])
const WINDOW_KIND_SET = new Set(['rolling-5h', 'weekly', 'monthly'])

class UsageError extends Error {
  constructor(code, message, status) {
    super(message)
    this.name = 'UsageError'
    this.code = code
    if (status) this.status = status
  }
}

function safeString(value, fallback = '', maxLength = 1000) {
  if (typeof value !== 'string') return fallback
  return value.slice(0, maxLength)
}

function createBaseAccount(provider, nowMs = Date.now()) {
  if (!PROVIDER_SET.has(provider)) {
    throw new UsageError('INVALID_PROVIDER', '不支援的額度來源')
  }
  const meta = PROVIDER_META[provider]
  return {
    id: provider,
    provider,
    accountName: meta.accountName,
    planName: meta.planName,
    status: 'available',
    accuracy: 'estimated',
    lastUpdated: new Date(nowMs).toISOString(),
    windows: [],
    notes: '',
    order: PROVIDER_IDS.indexOf(provider)
  }
}

function createInitialAccounts(nowMs = Date.now()) {
  return PROVIDER_IDS.map((provider) => ({
    ...createBaseAccount(provider, nowMs),
    status: 'disconnected',
    notes: '尚未同步'
  }))
}

function createWindow(id, label, kind, used, limit, resetAt) {
  return { id, label, kind, used, limit, resetAt }
}

function normalizeWindow(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (!WINDOW_KIND_SET.has(raw.kind)) return null
  const used = Number(raw.used)
  const limit = Number(raw.limit)
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null
  const resetRaw = safeString(raw.resetAt, '', 100)
  const resetAt = resetRaw && Number.isFinite(Date.parse(resetRaw)) ? resetRaw : ''
  const id = safeString(raw.id, '', 100).trim()
  if (!id) return null
  return {
    id,
    label: safeString(raw.label, '', 80),
    kind: raw.kind,
    used,
    limit,
    resetAt
  }
}

function normalizeAccount(raw) {
  if (!raw || typeof raw !== 'object' || !PROVIDER_SET.has(raw.provider)) {
    throw new UsageError('INVALID_ACCOUNT', '額度帳戶資料格式錯誤')
  }
  const fallback = createBaseAccount(raw.provider)
  const order = Number(raw.order)
  const windows = Array.isArray(raw.windows)
    ? raw.windows.map(normalizeWindow).filter(Boolean).slice(0, 8)
    : []
  const lastRaw = safeString(raw.lastUpdated, '', 100)
  return {
    id: safeString(raw.id, fallback.id, 100) || fallback.id,
    provider: raw.provider,
    accountName: safeString(raw.accountName, fallback.accountName, 160),
    planName: safeString(raw.planName, fallback.planName, 160),
    status: STATUS_SET.has(raw.status) ? raw.status : fallback.status,
    accuracy: ACCURACY_SET.has(raw.accuracy) ? raw.accuracy : fallback.accuracy,
    lastUpdated: Number.isFinite(Date.parse(lastRaw)) ? lastRaw : fallback.lastUpdated,
    windows,
    notes: safeString(raw.notes, '', 1000),
    order: Number.isInteger(order) ? Math.max(0, Math.min(PROVIDER_IDS.length - 1, order)) : fallback.order
  }
}

async function readJsonFile(filePath, maxBytes = FILE_MAX_BYTES) {
  let stat
  try {
    stat = await fs.stat(filePath)
  } catch {
    throw new UsageError('FILE_NOT_FOUND', '找不到本機登入資料')
  }
  if (!stat.isFile()) {
    throw new UsageError('INVALID_FILE', '本機登入資料不是一般檔案')
  }
  if (stat.size > maxBytes) {
    throw new UsageError('FILE_TOO_LARGE', '本機登入資料超過大小上限')
  }
  let raw
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch {
    throw new UsageError('FILE_READ_FAILED', '無法讀取本機登入資料')
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') throw new Error('not object')
    return parsed
  } catch {
    throw new UsageError('INVALID_JSON', '本機登入資料格式錯誤')
  }
}

async function readResponseText(response, maxBytes) {
  const contentLength = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new UsageError('RESPONSE_TOO_LARGE', '額度服務回應超過大小上限')
  }
  if (!response.body?.getReader) {
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new UsageError('RESPONSE_TOO_LARGE', '額度服務回應超過大小上限')
    }
    return text
  }

  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        throw new UsageError('RESPONSE_TOO_LARGE', '額度服務回應超過大小上限')
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

async function fetchJson(url, options = {}) {
  let parsedUrl
  try {
    parsedUrl = new URL(url)
  } catch {
    throw new UsageError('INVALID_URL', '額度服務網址錯誤')
  }
  if (parsedUrl.protocol !== 'https:') {
    throw new UsageError('INVALID_URL', '額度服務只允許 HTTPS')
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch
  const retries = Math.max(1, Math.min(3, Number(options.retries) || 3))
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || HTTP_TIMEOUT_MS)
  const maxBytes = Math.max(1, Number(options.maxBytes) || API_MAX_BYTES)
  const stopStatuses = new Set(options.stopStatuses || [401, 403])
  let lastError = null

  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt))
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(parsedUrl.toString(), {
        method: options.method || 'GET',
        headers: options.headers || {},
        body: options.body,
        signal: controller.signal
      })
      if (!response?.ok) {
        const status = Number(response?.status) || 0
        throw new UsageError(
          'HTTP_ERROR',
          status ? `額度服務暫時無法使用（HTTP ${status}）` : '額度服務暫時無法使用',
          status
        )
      }
      const text = await readResponseText(response, maxBytes)
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new UsageError('INVALID_RESPONSE', '額度服務回應格式錯誤')
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new UsageError('INVALID_RESPONSE', '額度服務回應格式錯誤')
      }
      return parsed
    } catch (error) {
      const normalized = error?.name === 'AbortError'
        ? new UsageError('TIMEOUT', '額度服務回應逾時')
        : error instanceof UsageError
          ? error
          : new UsageError('NETWORK_ERROR', '無法連線額度服務')
      lastError = normalized
      if (stopStatuses.has(normalized.status) || attempt === retries - 1) throw normalized
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError || new UsageError('NETWORK_ERROR', '無法連線額度服務')
}

function publicError(error) {
  if (error instanceof UsageError) {
    return { code: error.code, message: error.message }
  }
  return { code: 'USAGE_FAILED', message: '額度資料處理失敗' }
}

module.exports = {
  UsageError,
  createBaseAccount,
  createInitialAccounts,
  createWindow,
  normalizeAccount,
  readJsonFile,
  fetchJson,
  publicError
}
