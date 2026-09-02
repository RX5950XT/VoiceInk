'use strict'

/**
 * Ollama Cloud 額度。
 *
 *   GET https://ollama.com/api/usage
 *   Authorization: Bearer <API key>
 *   → { activity: { cost: "0.00000", period: { type, starting_at, ending_at }, models: [] },
 *       limits: { monthly: { usage, models[] } } }
 *
 * 第一方但沒寫進文件的路由，實測 2026-09-01（`scripts/probe-usage-endpoints.js`）。三個要點：
 *
 * - `usage` 是 **0～1 的比例**（0.98＝98%），不是百分比。上游若哪天改成百分比，
 *   `>1` 的值照原樣當百分比用（`toPercent`），這樣兩種都不會顯示成 0。
 * - **沒有重置時間**：上游目前只回 monthly，且不給重置時間。
 *   不要自己算一個假的填進去，卡片顯示「未提供重置時間」就好。
 * - `activity.cost` 是最近四週的實際花費（美元字串），跟訂閱額度是兩件事，只拿來寫在卡片說明裡。
 */

const { ENDPOINTS, OLLAMA_WINDOWS } = require('./constants')
const { resolveApiKey } = require('./api-key')
const {
  createBaseAccount,
  createWindow,
  fetchJson,
  normalizeAccount
} = require('./shared')

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function toPercent(value) {
  const raw = Number(value)
  if (!Number.isFinite(raw) || raw < 0 || raw > 100) return null
  return Math.round((raw <= 1 ? raw * 100 : raw) * 100) / 100
}

/**
 * 最近四週花費。上游給的是字串（`"0.00000"`），只在能解析成有限數字時才寫進說明。
 * @param {unknown} activity
 * @returns {string}
 */
function formatActivity(activity) {
  const cost = Number(activity && typeof activity === 'object' ? activity.cost : NaN)
  if (!Number.isFinite(cost) || cost <= 0) return ''
  return `最近四週花費約 US$${cost.toFixed(2)}。`
}

/**
 * @param {unknown} payload
 * @param {number} nowMs
 * @returns {object}
 */
function applyOllamaUsage(payload, nowMs = Date.now()) {
  const account = createBaseAccount('ollama', nowMs)
  const limits = payload && typeof payload === 'object' ? payload.limits : null
  if (limits && typeof limits === 'object') {
    for (const definition of OLLAMA_WINDOWS) {
      const percent = toPercent(limits[definition.key]?.usage)
      if (percent === null) continue
      account.windows.push(createWindow(definition.id, '', definition.kind, percent, 100, ''))
    }
  }
  account.status = account.windows.length ? 'available' : 'connected'
  account.accuracy = 'official'
  const activity = formatActivity(payload?.activity)
  account.notes = account.windows.length
    ? `已從 Ollama Cloud 官方端點讀取每月用量；上游不提供重置時間。${activity}`
    : `Ollama Cloud 已連線，但沒有回傳用量上限。${activity}`
  return normalizeAccount(account)
}

async function syncOllama({
  homeDir,
  env = process.env,
  nowMs = Date.now(),
  fetchImpl,
  log = () => {}
}) {
  const account = createBaseAccount('ollama', nowMs)
  const { key, source } = await resolveApiKey({
    homeDir,
    env,
    envVar: 'OLLAMA_API_KEY',
    serviceId: 'ollama-cloud',
    presetId: 'ollama-cloud'
  })
  if (!key) {
    account.status = 'disconnected'
    account.notes = '找不到 Ollama Cloud 金鑰，請設定 OLLAMA_API_KEY 或在 CC 代理頁填入。'
    return normalizeAccount(account)
  }

  try {
    const payload = await fetchJson(ENDPOINTS.ollama, {
      fetchImpl,
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }
    })
    const result = applyOllamaUsage(payload, nowMs)
    log(`ollama: API OK key=${source} windows=${result.windows.length}`)
    return result
  } catch (error) {
    log(`ollama: API failed ${error.status ? `HTTP ${error.status}` : error.code || 'unknown'}`)
    if (error?.status === 401 || error?.status === 403) {
      account.status = 'disconnected'
      account.notes = 'Ollama Cloud 金鑰被拒絕，請重新產生金鑰。'
    } else {
      account.status = 'connected'
      account.accuracy = 'estimated'
      account.notes = error?.status
        ? `Ollama Cloud 額度端點暫時無法使用（HTTP ${error.status}）。`
        : 'Ollama Cloud 額度端點暫時無法使用。'
    }
    return normalizeAccount(account)
  }
}

module.exports = {
  applyOllamaUsage,
  formatActivity,
  syncOllama,
  toPercent
}
