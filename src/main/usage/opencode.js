'use strict'

/**
 * OpenCode Go 訂閱額度。
 *
 * 以前這裡是把 `~/.local/share/opencode/opencode.db` 的 `step-finish` 成本加總，
 * 再套文件上的 $12／$30／$60 上限「推估」——那個數字包含所有經 OpenCode 的供應商，
 * 跟 Go 訂閱的實際計費視窗不是同一件事。現在改讀官方端點：
 *
 *   GET https://opencode.ai/zen/go/v1/usage
 *   Authorization: Bearer <API key>
 *   → { usage: { rolling|weekly|monthly: { status: 'ok'|'rate-limited',
 *                                          percent: 0-100 已用, resetsAt: ISO8601 } } }
 *
 * 這條路由是第一方但沒寫進文件，實測（2026-09-01）：
 * 401＝金鑰不對、403 `EntitlementError`＝金鑰有效但沒有 Go 訂閱。兩者是不同的事，訊息要分開，
 * 不然沒訂閱的人會被送去檢查一把從頭到尾正確的金鑰。
 */

const { ENDPOINTS, OPENCODE_WINDOWS } = require('./constants')
const { resolveApiKey } = require('./api-key')
const {
  createBaseAccount,
  createWindow,
  fetchJson,
  normalizeAccount
} = require('./shared')

/**
 * 單一視窗。上游曾改過一次形狀，所以每格各自驗；壞掉的那格跳過而不是整份丟掉。
 * @param {{ id: string, kind: string }} definition
 * @param {unknown} raw
 * @returns {object | null}
 */
function buildWindow(definition, raw) {
  if (!raw || typeof raw !== 'object') return null
  const percent = Number(raw.percent)
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null
  if (raw.status !== 'ok' && raw.status !== 'rate-limited') return null
  const resetsAt = typeof raw.resetsAt === 'string' ? raw.resetsAt : ''
  return createWindow(definition.id, '', definition.kind, percent, 100, resetsAt)
}

/**
 * @param {unknown} payload
 * @param {number} nowMs
 * @returns {object}
 */
function applyOpenCodeUsage(payload, nowMs = Date.now()) {
  const account = createBaseAccount('opencode-go', nowMs)
  const usage = payload && typeof payload === 'object' ? payload.usage : null
  if (!usage || typeof usage !== 'object') {
    account.status = 'connected'
    account.accuracy = 'official'
    account.notes = 'OpenCode Go 已連線，但沒有回傳額度視窗。'
    return normalizeAccount(account)
  }
  for (const definition of OPENCODE_WINDOWS) {
    const window = buildWindow(definition, usage[definition.key])
    if (window) account.windows.push(window)
  }
  account.status = account.windows.length ? 'available' : 'connected'
  account.accuracy = 'official'
  account.notes = account.windows.length
    ? '已從 OpenCode Go 官方端點讀取三個計費視窗（百分比由上游計算）。'
    : 'OpenCode Go 已連線，但沒有回傳額度視窗。'
  return normalizeAccount(account)
}

/**
 * 403 是「沒有 Go 訂閱」，401 是「金鑰不對」，其餘（含逾時、5xx）都當暫時性失敗，
 * 讓 index.js 的 6 小時 soft cache 接手。
 * @param {object} account
 * @param {{ status?: number, code?: string }} error
 */
function applyFailure(account, error) {
  if (error?.status === 403) {
    // 沒有訂閱就沒有 Go 額度可顯示。刻意用 disconnected：這樣 6 小時 soft cache 不會把
    // 訂閱到期前的舊視窗撈回來，讓人以為還有額度。
    account.status = 'disconnected'
    account.notes = '這把 OpenCode 金鑰沒有 Go 訂閱，額度端點回 403。'
    return
  }
  if (error?.status === 401) {
    account.status = 'disconnected'
    account.notes = 'OpenCode 金鑰被拒絕（401），請重新登入或更新金鑰。'
    return
  }
  account.status = 'connected'
  account.accuracy = 'estimated'
  account.notes = error?.status
    ? `OpenCode Go 額度端點暫時無法使用（HTTP ${error.status}）。`
    : 'OpenCode Go 額度端點暫時無法使用。'
}

async function syncOpenCode({
  homeDir,
  env = process.env,
  nowMs = Date.now(),
  fetchImpl,
  log = () => {}
}) {
  const account = createBaseAccount('opencode-go', nowMs)
  const { key, source } = await resolveApiKey({
    homeDir,
    env,
    envVar: 'OPENCODE_API_KEY',
    serviceId: 'opencode-go',
    presetId: 'opencode-go'
  })
  if (!key) {
    account.status = 'disconnected'
    account.notes = '找不到 OpenCode 金鑰，請執行 opencode auth login 或在 CC 代理頁填入。'
    return normalizeAccount(account)
  }

  try {
    const payload = await fetchJson(ENDPOINTS.opencodeGo, {
      fetchImpl,
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }
    })
    const result = applyOpenCodeUsage(payload, nowMs)
    log(`opencode: API OK key=${source} windows=${result.windows.length}`)
    return result
  } catch (error) {
    log(`opencode: API failed ${error.status ? `HTTP ${error.status}` : error.code || 'unknown'}`)
    applyFailure(account, error)
    return normalizeAccount(account)
  }
}

module.exports = {
  applyOpenCodeUsage,
  buildWindow,
  syncOpenCode
}
