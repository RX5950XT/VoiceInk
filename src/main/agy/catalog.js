'use strict'

const upstream = require('./upstream')

/**
 * 上游模型型錄：解析、過濾、快取。
 *
 * 為什麼需要這層：`model-map.js` 是「客戶端寫死的名字 → 上游名字」的翻譯表，
 * 它不知道上游現在到底有哪些模型。實測過那張靜態表裡有 404／500 的模型，
 * 而上游新出的整個 3.7／3.6／3.5 家族它一個都沒有。型錄才是權威來源。
 */

const CACHE_TTL_MS = 10 * 60 * 1000

/**
 * 「能拿來對話」的門檻。
 *
 * 型錄裡混著 IDE 內部用的模型（tab 補全、指令列、圖片生成），
 * 拿去對話會直接失敗或行為古怪。用 context 與有沒有輸出上限來判斷，
 * 而不是列一份黑名單——黑名單會隨上游新增而過期。
 */
const CHAT_MIN_CONTEXT = 100_000

let cache = { at: 0, models: [], defaultModelId: '' }

function reset() {
  cache = { at: 0, models: [], defaultModelId: '' }
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function num(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

/**
 * 上游的 `models` 是**以 model id 為 key 的物件**，不是陣列。
 * 拿 Array.isArray 判斷會靜默得到空清單。
 * @param {object} payload
 * @returns {{ models: Array<object>, defaultModelId: string }}
 */
function parseCatalog(payload) {
  const raw = payload && typeof payload.models === 'object' && !Array.isArray(payload.models)
    ? payload.models
    : {}
  const deprecated = payload && typeof payload.deprecatedModelIds === 'object' && payload.deprecatedModelIds
    ? payload.deprecatedModelIds
    : {}

  const models = Object.keys(raw).map((id) => {
    const entry = raw[id] || {}
    const quota = entry.quotaInfo && typeof entry.quotaInfo === 'object' ? entry.quotaInfo : {}
    const remaining = Number(quota.remainingFraction)
    const replacement = deprecated[id]
    return {
      id,
      maxTokens: num(entry.maxTokens),
      maxOutputTokens: num(entry.maxOutputTokens),
      provider: typeof entry.modelProvider === 'string'
        ? entry.modelProvider.replace(/^MODEL_PROVIDER_/, '')
        : '',
      remainingFraction: Number.isFinite(remaining) ? remaining : null,
      resetTime: typeof quota.resetTime === 'string' ? quota.resetTime : '',
      deprecated: Boolean(replacement),
      replacedBy: typeof replacement?.newModelId === 'string' ? replacement.newModelId : '',
      chatCapable: false
    }
  })

  for (const model of models) model.chatCapable = isChatCapable(model)
  models.sort((a, b) => compareModelIds(a.id, b.id))

  return {
    models,
    defaultModelId: typeof payload?.defaultAgentModelId === 'string' ? payload.defaultAgentModelId : ''
  }
}

/**
 * @param {{ maxTokens: number, maxOutputTokens: number }} model
 * @returns {boolean}
 */
function isChatCapable(model) {
  return model.maxTokens >= CHAT_MIN_CONTEXT && model.maxOutputTokens > 0
}

const FAMILY_RE = /^(gemini|claude|gpt-oss|gpt_oss)[-_]?(.*)$/i

/**
 * 額度池：Claude（含 GPT OSS）與 Gemini 分開。
 * GPT OSS 跟 Claude 共用同一池，不能只按字母排到 Gemini 後面。
 * @param {string} family
 * @returns {number}
 */
function poolRank(family) {
  if (family === 'claude' || family === 'gpt-oss') return 0
  if (family === 'gemini') return 1
  return 2
}

/**
 * extra-low 必須排在 low 前面，否則 `low` 會先命中。
 * 分數愈高愈前面：同世代依思考強度由高到低。
 */
const INTENSITY_TOKENS = [
  ['extra-low', 20],
  ['high', 100],
  ['medium', 80],
  ['tiered', 70],
  ['thinking', 65],
  ['agent', 60],
  ['low', 50],
  ['lite', 10]
]
const INTENSITY_DEFAULT = 40

/**
 * @param {string} rest
 * @returns {number}
 */
function intensityRank(rest) {
  const text = String(rest || '')
  for (const [token, rank] of INTENSITY_TOKENS) {
    if (text.includes(token)) return rank
  }
  return INTENSITY_DEFAULT
}

/**
 * @param {string} id
 * @returns {{ pool: number, family: string, version: number[] | null, rest: string, intensity: number }}
 */
function parseModelId(id) {
  const lower = String(id || '').toLowerCase()
  const matched = FAMILY_RE.exec(lower)
  if (!matched) {
    return { pool: 2, family: lower, version: null, rest: lower, intensity: intensityRank(lower) }
  }
  const family = matched[1].replace('_', '-')
  let rest = matched[2]
  let version = null
  const ver = /(\d+(?:[.-]\d+)*)/.exec(rest)
  if (ver) {
    version = ver[1].split(/[.-]/).map(Number)
    rest = `${rest.slice(0, ver.index)}${rest.slice(ver.index + ver[1].length)}`
      .replace(/^[-_]+|[-_]+$/g, '')
      .replace(/[-_]{2,}/g, '-')
  }
  return {
    pool: poolRank(family),
    family,
    version,
    rest,
    intensity: intensityRank(rest)
  }
}

/**
 * @param {number[] | null} a
 * @param {number[] | null} b
 * @returns {number}
 */
function compareVersionDesc(a, b) {
  if (a && b) {
    const n = Math.max(a.length, b.length)
    for (let i = 0; i < n; i++) {
      const da = a[i] || 0
      const db = b[i] || 0
      if (da !== db) return db - da
    }
    return 0
  }
  if (a && !b) return -1
  if (!a && b) return 1
  return 0
}

/**
 * 額度池分開後，世代由新到舊；Gemini 同代再依思考強度高→低。
 * `3.10` 必須排在 `3.2` 前面，`gemini-pro-agent` 沒有世代號放最後。
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareModelIds(a, b) {
  const pa = parseModelId(a)
  const pb = parseModelId(b)
  if (pa.pool !== pb.pool) return pa.pool - pb.pool
  if (pa.family !== pb.family) return pa.family.localeCompare(pb.family)
  const version = compareVersionDesc(pa.version, pb.version)
  if (version) return version
  if (pa.intensity !== pb.intensity) return pb.intensity - pa.intensity
  return pa.rest.localeCompare(pb.rest, 'en', { numeric: true })
}

/**
 * 取型錄，預設走 10 分鐘快取。
 * @param {{ force?: boolean, options?: object, now?: () => number }} [params]
 * @returns {Promise<{ models: Array<object>, defaultModelId: string, cached: boolean, fetchedAt: number }>}
 */
async function list({ force = false, options, now = Date.now } = {}) {
  const nowMs = now()
  if (!force && cache.at && nowMs - cache.at < CACHE_TTL_MS) {
    return { models: cache.models, defaultModelId: cache.defaultModelId, cached: true, fetchedAt: cache.at }
  }
  const payload = await upstream.fetchAvailableModels({ options })
  const parsed = parseCatalog(payload)
  cache = { at: nowMs, models: parsed.models, defaultModelId: parsed.defaultModelId }
  return { ...parsed, cached: false, fetchedAt: nowMs }
}

/**
 * 給反代的 `/v1/models` 用：只列對話可用的，並回 OpenAI 形狀。
 * 型錄拿不到時回 null，呼叫端自己決定要不要退回靜態表。
 * @param {{ options?: object }} [params]
 * @returns {Promise<Array<{ id: string, object: string, created: number, owned_by: string }> | null>}
 */
async function listForApi({ options } = {}) {
  try {
    const { models, fetchedAt } = await list({ options })
    const created = Math.floor(fetchedAt / 1000)
    const rows = models
      .filter((model) => model.chatCapable && !model.deprecated)
      .map((model) => ({
        id: model.id,
        object: 'model',
        created,
        owned_by: model.provider ? model.provider.toLowerCase() : 'antigravity'
      }))
    // 空清單比舊清單更糟：客戶端的模型下拉會整個空掉，使用者連手打都沒得參考。
    // 一個都撈不到就當作沒有即時資料，讓呼叫端退回靜態表。
    return rows.length ? rows : null
  } catch {
    return null
  }
}

module.exports = {
  list,
  listForApi,
  parseCatalog,
  compareModelIds,
  isChatCapable,
  reset,
  CACHE_TTL_MS,
  CHAT_MIN_CONTEXT
}
