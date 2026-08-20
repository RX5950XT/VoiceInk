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

function applyClaudeUsage(raw, nowMs) {
  const account = createBaseAccount('claude-code', nowMs)
  account.status = 'available'
  account.accuracy = 'official'
  account.planName = raw?.extra_usage?.is_enabled ? 'Claude Pro / Max' : 'Claude'
  account.notes = '已從 Anthropic OAuth API 讀取真實額度。'

  const definitions = [
    ['claude-5h', 'rolling-5h', raw?.five_hour],
    ['claude-weekly', 'weekly', raw?.seven_day]
  ]
  for (const [id, kind, source] of definitions) {
    const used = Number(source?.utilization)
    if (!Number.isFinite(used)) continue
    account.windows.push(createWindow(
      id,
      '',
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
    log(`claude: API OK windows=${Number(!!usage.five_hour) + Number(!!usage.seven_day)}`)
    return applyClaudeUsage(usage, nowMs)
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
