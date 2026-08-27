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

/** 新版 auth.json 沒有頂層 plan_type，方案藏在 id_token 的這個自訂 claim 裡 */
const CHATGPT_AUTH_CLAIM = 'https://api.openai.com/auth'

function titleCase(value) {
  return String(value || '')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ')
}

/**
 * ChatGPT 方案代碼（plus／pro／team…）。頂層欄位優先，沒有才拆 id_token。
 * @param {object} auth
 * @returns {string}
 */
function planTypeFrom(auth) {
  const direct = typeof auth?.plan_type === 'string' ? auth.plan_type.trim() : ''
  if (direct) return direct
  const claim = readJwtClaims(auth?.tokens?.id_token)?.[CHATGPT_AUTH_CLAIM]
  const nested = typeof claim?.chatgpt_plan_type === 'string' ? claim.chatgpt_plan_type.trim() : ''
  return nested.slice(0, 60)
}

function applyCodexUsage(raw, auth, nowMs) {
  const account = createBaseAccount('codex', nowMs)
  account.status = 'available'
  account.accuracy = 'official'
  account.notes = '已從 ChatGPT API 讀取真實額度。'
  const plan = titleCase(planTypeFrom(auth))
  if (plan) account.planName = `ChatGPT ${plan}`

  const windows = [
    ['codex-5h', 'rolling-5h', raw?.rate_limit?.primary_window],
    ['codex-weekly', 'weekly', raw?.rate_limit?.secondary_window]
  ]
  for (const [id, kind, source] of windows) {
    const used = Number(source?.used_percent)
    const resetSeconds = Number(source?.reset_at)
    if (!Number.isFinite(used)) continue
    const resetAt = Number.isFinite(resetSeconds)
      ? new Date(resetSeconds * 1000).toISOString()
      : ''
    account.windows.push(createWindow(id, '', kind, used, 100, resetAt))
  }
  if (!account.windows.length) {
    account.status = 'connected'
    account.notes = 'ChatGPT API 已連線，但沒有回傳額度視窗。'
  }
  return normalizeAccount(account)
}

async function syncCodex({ homeDir, nowMs = Date.now(), fetchImpl, log = () => {} }) {
  const account = createBaseAccount('codex', nowMs)
  let auth
  try {
    auth = await readJsonFile(path.join(homeDir, '.codex', 'auth.json'))
  } catch {
    account.status = 'disconnected'
    account.notes = '找不到 Codex ChatGPT 登入憑證。'
    return normalizeAccount(account)
  }

  const token = auth?.tokens?.access_token
  if (typeof token !== 'string' || !token.trim()) {
    account.status = 'disconnected'
    account.notes = 'Codex 已安裝，但目前未登入 ChatGPT。'
    return normalizeAccount(account)
  }

  try {
    const usage = await fetchJson(ENDPOINTS.codex, {
      fetchImpl,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      }
    })
    log(`codex: API OK windows=${Number(!!usage?.rate_limit?.primary_window) + Number(!!usage?.rate_limit?.secondary_window)}`)
    return applyCodexUsage(usage, auth, nowMs)
  } catch (error) {
    log(`codex: API failed ${error.status ? `HTTP ${error.status}` : error.code || 'unknown'}`)
    account.status = 'connected'
    account.accuracy = 'estimated'
    account.notes = error.status
      ? `ChatGPT API 暫時無法使用（HTTP ${error.status}）。`
      : 'ChatGPT API 暫時無法使用。'
    return normalizeAccount(account)
  }
}

module.exports = { applyCodexUsage, syncCodex, titleCase }
