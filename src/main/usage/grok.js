'use strict'

const path = require('path')
const { ENDPOINTS } = require('./constants')
const {
  createBaseAccount,
  createWindow,
  fetchJson,
  normalizeAccount,
  readJsonFile,
  readJwtClaims
} = require('./shared')

function parseGrokSession(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  for (const entry of Object.values(raw)) {
    const key = typeof entry?.key === 'string' ? entry.key.trim() : ''
    if (!key) continue
    // billing API 不回方案名稱，access token 的 tier claim 是 x.ai 唯一給的方案標示（數字）
    const tier = readJwtClaims(key)?.tier
    return {
      accessToken: key,
      userId: typeof entry.user_id === 'string' ? entry.user_id.slice(0, 200) : '',
      email: typeof entry.email === 'string' ? entry.email.slice(0, 320) : '',
      tier: Number.isInteger(tier) ? `Tier ${tier}` : ''
    }
  }
  return null
}

function resolveGrokConfig(raw) {
  if (raw?.config && typeof raw.config === 'object') return raw.config
  if (Number.isFinite(Number(raw?.creditUsagePercent))) return raw
  return null
}

function applyGrokBilling(raw, nowMs) {
  const account = createBaseAccount('grok', nowMs)
  const config = resolveGrokConfig(raw)
  const used = Number(config?.creditUsagePercent)
  if (!config || !Number.isFinite(used)) {
    account.status = 'connected'
    account.accuracy = 'official'
    account.notes = 'Grok billing 已連線，但沒有回傳 weekly credit。'
    return normalizeAccount(account)
  }

  const tier = typeof config.subscriptionTier === 'string'
    ? config.subscriptionTier.trim().slice(0, 120)
    : ''
  account.status = 'available'
  account.accuracy = 'official'
  account.planName = tier ? `Grok ${tier}` : 'Grok'
  account.notes = '已從 Grok CLI billing API 讀取每週額度。'
  account.windows.push(createWindow(
    'grok-weekly',
    '',
    'weekly',
    used,
    100,
    typeof config?.currentPeriod?.end === 'string'
      ? config.currentPeriod.end
      : typeof config.billingPeriodEnd === 'string'
        ? config.billingPeriodEnd
        : ''
  ))
  return normalizeAccount(account)
}

function resolveAuthPath(homeDir, env) {
  const configured = typeof env?.GROK_HOME === 'string' ? env.GROK_HOME.trim() : ''
  const root = configured && path.isAbsolute(configured)
    ? configured
    : path.join(homeDir, '.grok')
  return path.join(root, 'auth.json')
}

async function syncGrok({ homeDir, env = process.env, nowMs = Date.now(), fetchImpl, log = () => {} }) {
  const account = createBaseAccount('grok', nowMs)
  let auth
  try {
    auth = await readJsonFile(resolveAuthPath(homeDir, env))
  } catch {
    account.status = 'disconnected'
    account.notes = '找不到 Grok 登入憑證，請先執行 grok login。'
    return normalizeAccount(account)
  }

  const session = parseGrokSession(auth)
  if (!session) {
    account.status = 'disconnected'
    account.notes = 'Grok auth.json 沒有有效 access token。'
    return normalizeAccount(account)
  }
  if (session.email) account.accountName = session.email
  else if (session.userId) account.accountName = session.userId

  const headers = {
    Authorization: `Bearer ${session.accessToken}`,
    'X-XAI-Token-Auth': 'xai-grok-cli',
    Accept: 'application/json'
  }
  if (session.userId) headers['x-userid'] = session.userId

  try {
    const billing = await fetchJson(ENDPOINTS.grok, { fetchImpl, headers })
    const result = applyGrokBilling(billing, nowMs)
    result.accountName = account.accountName
    // billing 有回 subscriptionTier 就用它；沒有才退回 token 裡的數字 tier
    if (result.planName === 'Grok' && session.tier) result.planName = `Grok ${session.tier}`
    log(`grok: API OK windows=${result.windows.length}`)
    return normalizeAccount(result)
  } catch (error) {
    log(`grok: API failed ${error.status ? `HTTP ${error.status}` : error.code || 'unknown'}`)
    account.status = 'connected'
    account.accuracy = 'estimated'
    account.notes = error.status
      ? `Grok billing API 暫時無法使用（HTTP ${error.status}）。`
      : 'Grok billing API 暫時無法使用。'
    return normalizeAccount(account)
  }
}

module.exports = {
  applyGrokBilling,
  parseGrokSession,
  resolveGrokConfig,
  syncGrok
}
