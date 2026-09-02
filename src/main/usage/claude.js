'use strict'

const path = require('path')
const { ENDPOINTS } = require('./constants')
const {
  createBaseAccount,
  createWindow,
  fetchJson,
  normalizeAccount,
  readJsonFile
} = require('./shared')

/** 真正的方案寫在本機憑證檔的 subscriptionType，usage API 不回這個欄位 */
const PLAN_LABELS = Object.freeze({
  free: 'Claude Free',
  pro: 'Claude Pro',
  max: 'Claude Max',
  team: 'Claude Team',
  enterprise: 'Claude Enterprise'
})

/**
 * @param {object} raw usage API 回應
 * @param {number} nowMs
 * @param {string} [subscriptionType] `.credentials.json` 的 claudeAiOauth.subscriptionType
 */
function applyClaudeUsage(raw, nowMs, subscriptionType = '') {
  const account = createBaseAccount('claude-code', nowMs)
  account.status = 'available'
  account.accuracy = 'official'
  // extra_usage.is_enabled 只代表「有沒有開額外用量」，拿它猜方案會把 Pro 講成「Pro / Max」；
  // 認得的 subscriptionType 一律優先，認不得才退回舊的粗略判斷。
  account.planName = PLAN_LABELS[String(subscriptionType || '').trim().toLowerCase()] ||
    (raw?.extra_usage?.is_enabled ? 'Claude Pro / Max' : 'Claude')
  account.notes = '已從 Anthropic OAuth API 讀取真實額度。'

  // seven_day_opus 只有 Max 方案有值（其餘方案回 null，迴圈自己會跳過）；
  // 那是跟「全模型每週」分開計的另一條上限，少畫一格等於使用者看不到自己是被哪一條擋住。
  // 其餘同層欄位（seven_day_sonnet、tangelo…）目前全機回 null，是上游未上線的實驗，不收。
  const definitions = [
    ['claude-5h', '', 'rolling-5h', raw?.five_hour],
    ['claude-weekly', '', 'weekly', raw?.seven_day],
    ['claude-weekly-opus', 'Opus', 'weekly', raw?.seven_day_opus]
  ]
  for (const [id, label, kind, source] of definitions) {
    const used = Number(source?.utilization)
    if (!Number.isFinite(used)) continue
    account.windows.push(createWindow(
      id,
      label,
      kind,
      used,
      100,
      typeof source.resets_at === 'string' ? source.resets_at : ''
    ))
  }
  if (!account.windows.length) {
    account.status = 'connected'
    account.notes = 'Anthropic API 已連線，但沒有回傳額度視窗。'
  }
  return normalizeAccount(account)
}

async function syncClaude({ homeDir, nowMs = Date.now(), fetchImpl, log = () => {} }) {
  const account = createBaseAccount('claude-code', nowMs)
  let credentials
  try {
    credentials = await readJsonFile(path.join(homeDir, '.claude', '.credentials.json'))
  } catch {
    account.status = 'disconnected'
    account.notes = '找不到 Claude Code OAuth 登入憑證。'
    return normalizeAccount(account)
  }

  const token = credentials?.claudeAiOauth?.accessToken
  if (typeof token !== 'string' || !token.trim()) {
    account.status = 'disconnected'
    account.notes = 'Claude Code 已安裝，但目前未登入 OAuth。'
    return normalizeAccount(account)
  }

  try {
    const usage = await fetchJson(ENDPOINTS.claude, {
      fetchImpl,
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        Accept: 'application/json'
      }
    })
    log(`claude: API OK windows=${Number(!!usage.five_hour) + Number(!!usage.seven_day) + Number(!!usage.seven_day_opus)}`)
    return applyClaudeUsage(usage, nowMs, credentials?.claudeAiOauth?.subscriptionType)
  } catch (error) {
    log(`claude: API failed ${error.status ? `HTTP ${error.status}` : error.code || 'unknown'}`)
    account.status = 'connected'
    account.accuracy = 'estimated'
    account.notes = error.status
      ? `Anthropic API 暫時無法使用（HTTP ${error.status}）。`
      : 'Anthropic API 暫時無法使用。'
    return normalizeAccount(account)
  }
}

module.exports = { applyClaudeUsage, syncClaude }
