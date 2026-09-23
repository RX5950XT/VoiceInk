'use strict'

const path = require('path')
const { ensureFreshToken } = require('./claude-auth')
const { ENDPOINTS } = require('./constants')
const {
  createBaseAccount,
  createWindow,
  fetchJson,
  normalizeAccount,
  readJsonFile
} = require('./shared')

/**
 * 額度 API 的限流是看 User-Agent 分的（實測 2026-09-23，同一顆 token 連打）：
 * `claude-code/…` 穩定 200；Node 預設的 `node`、`VoiceInk/…` 或任何別的名字打兩三下就一直 429
 * （`retry-after: 0`）。這顆 token 本來就是發給 Claude Code 的（續期也照 CLI 的協定），
 * 所以照 CLI 報身分。看的是前綴，版本號舊了也照樣過（2.0.0 實測 200）。
 */
const CLAUDE_CODE_USER_AGENT = 'claude-code/2.1.280'

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

/**
 * @param {{ homeDir: string, nowMs?: number, fetchImpl?: Function, authFetchImpl?: Function, log?: Function }} args
 *   `authFetchImpl` 是續期那條（`claude-auth.js`）用的，測試要 mock 就兩個都給
 */
async function syncClaude({ homeDir, nowMs = Date.now(), fetchImpl, authFetchImpl, log = () => {} }) {
  const account = createBaseAccount('claude-code', nowMs)
  let credentials
  try {
    credentials = await readJsonFile(path.join(homeDir, '.claude', '.credentials.json'))
  } catch {
    account.status = 'disconnected'
    account.notes = '找不到 Claude Code OAuth 登入憑證。'
    return normalizeAccount(account)
  }

  let token = credentials?.claudeAiOauth?.accessToken
  if (typeof token !== 'string' || !token.trim()) {
    account.status = 'disconnected'
    account.notes = 'Claude Code 已安裝，但目前未登入 OAuth。'
    return normalizeAccount(account)
  }

  // 快過期就先續（沒開 CLI 的那幾個小時，額度才不會「跑掉」）。續不成就拿舊的那顆試，
  // 真的不能用會在下面的 401 再續一次
  const refresh = async (extra) => {
    try {
      const fresh = await ensureFreshToken(homeDir, { fetchImpl: authFetchImpl, log, nowMs, ...extra })
      if (fresh.token) {
        token = fresh.token
        credentials = fresh.credentials
      }
    } catch (error) {
      log(`claude: token refresh failed ${error.status ? `HTTP ${error.status}` : error.code || 'unknown'}`)
    }
  }
  await refresh({})

  const request = () => fetchJson(ENDPOINTS.claude, {
    fetchImpl,
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': CLAUDE_CODE_USER_AGENT,
      Accept: 'application/json'
    }
  })

  try {
    let usage
    try {
      usage = await request()
    } catch (error) {
      if (error.status !== 401) throw error
      // 還沒到期卻 401：多半是 CLI 那邊換過了，或者被撤銷——強制續一次再試
      const before = token
      await refresh({ force: true, usedToken: before })
      if (token === before) throw error
      usage = await request()
    }
    log(`claude: API OK windows=${Number(!!usage.five_hour) + Number(!!usage.seven_day) + Number(!!usage.seven_day_opus)}`)
    return applyClaudeUsage(usage, nowMs, credentials?.claudeAiOauth?.subscriptionType)
  } catch (error) {
    log(`claude: API failed ${error.status ? `HTTP ${error.status}` : error.code || 'unknown'}`)
    account.status = 'connected'
    account.accuracy = 'estimated'
    account.notes = error.status === 401
      ? 'Claude Code 登入已失效，請在終端機重新登入一次。'
      : error.status === 429
        ? 'Anthropic 限制查詢次數，稍後自動再試。'
        : error.status
        ? `Anthropic API 暫時無法使用（HTTP ${error.status}）。`
        : 'Anthropic API 暫時無法使用。'
    return normalizeAccount(account)
  }
}

module.exports = { applyClaudeUsage, syncClaude }
