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
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0 || used < 0) return null
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

/**
 * Codex 的重置次數（其他家沒有這個欄位）。id 會被拿回來兌換，所以格式要卡：
 * 兌換前 main 還會比對它確實在這份清單裡。
 */
function normalizeResetCredits(raw) {
  if (!raw || typeof raw !== 'object') return undefined
  const available = Number(raw.available)
  if (!Number.isInteger(available) || available < 0 || available > 1000) return undefined
  const credits = Array.isArray(raw.credits)
    ? raw.credits
      .filter((credit) => typeof credit?.id === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(credit.id))
      .slice(0, 20)
      .map((credit) => {
        const expires = safeString(credit.expiresAt, '', 100)
        return {
          id: credit.id,
          title: safeString(credit.title, '', 120),
          expiresAt: expires && Number.isFinite(Date.parse(expires)) ? expires : ''
        }
      })
    : []
  return { available, credits }
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
  const resetCredits = normalizeResetCredits(raw.resetCredits)
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
    order: Number.isInteger(order) ? Math.max(0, Math.min(PROVIDER_IDS.length - 1, order)) : fallback.order,
    ...(resetCredits ? { resetCredits } : {})
  }
}

/**
 * 讀本機登入檔裡 JWT 的 payload（方案名稱這類標籤只有那裡有）。
 *
 * 刻意不驗簽：來源是使用者自己機器上的憑證檔，不是網路輸入，而且驗簽要拿供應商公鑰，
 * 對「取一個字串當標籤」沒有意義。但長度與型別照擋，壞資料一律回 null。
 * @param {unknown} token
 * @returns {object | null}
 */
function readJwtClaims(token) {
  if (typeof token !== 'string' || token.length > 8192) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return claims && typeof claims === 'object' && !Array.isArray(claims) ? claims : null
  } catch {
    return null
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

const COOLDOWN_BASE_MS = 2 * 60_000
const COOLDOWN_MAX_MS = 30 * 60_000
/** 被 429 的端點（origin＋path）→ { until, delay }：冷卻期間不出門，連續被擋就加倍 */
const rateLimitCooldowns = new Map()

/**
 * @param {string} key
 * @param {number} retryAfterSec 上游給的 Retry-After（Anthropic 給 0＝沒說，就用自己的退避）
 */
function noteRateLimited(key, retryAfterSec) {
  const previous = rateLimitCooldowns.get(key)?.delay || 0
  const delay = Number.isFinite(retryAfterSec) && retryAfterSec > 0
    ? Math.min(COOLDOWN_MAX_MS, retryAfterSec * 1000)
    : Math.min(COOLDOWN_MAX_MS, previous ? previous * 2 : COOLDOWN_BASE_MS)
  rateLimitCooldowns.set(key, { until: Date.now() + delay, delay })
}

function resetRateLimitsForTests() {
  rateLimitCooldowns.clear()
}

async function fetchJson(url, options = {}) {
  // 錯誤訊息裡的主詞。這支也被 ccswitch 的 CLI 版本檢查借去打 npm registry，
  // 全部寫死「額度服務」會讓使用者看到牛頭不對馬嘴的訊息。
  const label = typeof options.label === 'string' && options.label ? options.label : '額度服務'
  let parsedUrl
  try {
    parsedUrl = new URL(url)
  } catch {
    throw new UsageError('INVALID_URL', `${label}網址錯誤`)
  }
  if (parsedUrl.protocol !== 'https:') {
    throw new UsageError('INVALID_URL', `${label}只允許 HTTPS`)
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch
  const retries = Math.max(1, Math.min(3, Number(options.retries) || 3))
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || HTTP_TIMEOUT_MS)
  const maxBytes = Math.max(1, Number(options.maxBytes) || API_MAX_BYTES)
  // 429 不重試：連打只會把限流拉長（實測 Claude 的額度 API 被每分鐘同步＋重試打成一直 429）
  const stopStatuses = new Set([...(options.stopStatuses || [401, 403]), 429])
  const cooldownKey = parsedUrl.origin + parsedUrl.pathname
  const blockedUntil = rateLimitCooldowns.get(cooldownKey)?.until || 0
  if (Date.now() < blockedUntil) {
    throw new UsageError('RATE_LIMITED', `${label}查詢太頻繁，稍後自動再試`, 429)
  }
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
        if (status === 429) {
          noteRateLimited(cooldownKey, Number(response.headers?.get?.('retry-after')))
          throw new UsageError('RATE_LIMITED', `${label}查詢太頻繁，稍後自動再試`, 429)
        }
        throw new UsageError(
          'HTTP_ERROR',
          status ? `${label}暫時無法使用（HTTP ${status}）` : `${label}暫時無法使用`,
          status
        )
      }
      const text = await readResponseText(response, maxBytes)
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new UsageError('INVALID_RESPONSE', `${label}回應格式錯誤`)
      }
      // 預設擋掉頂層陣列（額度那幾家的回應都是物件，收到陣列就是打錯端點了）。
      // Hugging Face 的清單端點本來就回陣列，那幾支要自己指名 `allowArray`。
      const shapeOk = parsed && typeof parsed === 'object'
        && (options.allowArray ? true : !Array.isArray(parsed))
      if (!shapeOk) {
        throw new UsageError('INVALID_RESPONSE', `${label}回應格式錯誤`)
      }
      rateLimitCooldowns.delete(cooldownKey)
      return parsed
    } catch (error) {
      const normalized = error?.name === 'AbortError'
        ? new UsageError('TIMEOUT', `${label}回應逾時`)
        : error instanceof UsageError
          ? error
          : new UsageError('NETWORK_ERROR', `無法連線${label}`)
      lastError = normalized
      if (stopStatuses.has(normalized.status) || attempt === retries - 1) throw normalized
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError || new UsageError('NETWORK_ERROR', `無法連線${label}`)
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
  readResponseText,
  readJwtClaims,
  fetchJson,
  publicError,
  resetRateLimitsForTests
}
