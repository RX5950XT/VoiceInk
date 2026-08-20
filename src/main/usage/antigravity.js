'use strict'

const { execFile } = require('child_process')
const path = require('path')
const { promisify } = require('util')
const { ENDPOINTS, API_MAX_BYTES } = require('./constants')
const {
  createBaseAccount,
  createWindow,
  fetchJson,
  normalizeAccount
} = require('./shared')

const execFileAsync = promisify(execFile)
const USER_AGENT = 'vscode/1.X.X (Antigravity/4.2.1)'
const EXPECTED_WINDOWS = Object.freeze([
  ['antigravity-claude-5h', 'Claude', 'rolling-5h'],
  ['antigravity-claude-weekly', 'Claude', 'weekly'],
  ['antigravity-gemini-5h', 'Gemini', 'rolling-5h'],
  ['antigravity-gemini-weekly', 'Gemini', 'weekly']
])

function parseCredential(text) {
  try {
    const raw = JSON.parse(text)
    const token = raw?.token
    const accessToken = typeof token?.access_token === 'string' ? token.access_token.trim() : ''
    const refreshToken = typeof token?.refresh_token === 'string' ? token.refresh_token.trim() : ''
    if (!accessToken || !refreshToken) return null
    return {
      accessToken,
      refreshToken,
      expiry: typeof token.expiry === 'string' ? token.expiry : ''
    }
  } catch {
    return null
  }
}

function resolveCredentialScriptPath(baseDir = __dirname) {
  const script = path.join(baseDir, 'read-windows-credential.ps1')
  const asarSegment = `${path.sep}app.asar${path.sep}`
  return script.replace(asarSegment, `${path.sep}app.asar.unpacked${path.sep}`)
}

async function readAntigravityCredential() {
  const windowsRoot = process.env.SystemRoot || 'C:\\Windows'
  const executable = path.join(
    windowsRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  const script = resolveCredentialScriptPath()
  try {
    const { stdout } = await execFileAsync(executable, [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      'gemini:antigravity'
    ], {
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: API_MAX_BYTES
    })
    return stdout || null
  } catch {
    return null
  }
}

function tokenIsStale(expiry, nowMs) {
  const expiryMs = Date.parse(expiry)
  return !Number.isFinite(expiryMs) || nowMs + 15 * 60 * 1000 >= expiryMs
}

function familyFor(groupName, bucketId) {
  const group = String(groupName || '').toLowerCase()
  if (group.includes('gemini')) return 'gemini'
  if (group.includes('claude') || group.includes('gpt') || group.includes('third')) return 'claude'
  const bucket = String(bucketId || '').toLowerCase()
  if (bucket.includes('gemini')) return 'gemini'
  if (bucket.includes('claude') || bucket.includes('3p')) return 'claude'
  return ''
}

function slotFor(windowName) {
  const value = String(windowName || '').trim().toLowerCase()
  if (value === '5h') return '5h'
  if (value === 'weekly') return 'weekly'
  return ''
}

function upsertSlot(slots, family, slot, remaining, resetAt) {
  const key = `${family}:${slot}`
  const safeRemaining = Math.max(0, Math.min(1, Number.isFinite(remaining) ? remaining : 0))
  const previous = slots.get(key)
  if (!previous || safeRemaining < previous.remaining) {
    slots.set(key, {
      remaining: safeRemaining,
      resetAt: typeof resetAt === 'string' ? resetAt : ''
    })
  }
}

function parseQuotaSummary(summary, slots = new Map()) {
  if (!Array.isArray(summary?.groups)) return slots
  for (const group of summary.groups) {
    const buckets = Array.isArray(group?.buckets) ? group.buckets : []
    for (const bucket of buckets) {
      const family = familyFor(group?.displayName, bucket?.bucketId)
      const slot = slotFor(bucket?.window)
      if (!family || !slot) continue
      const remaining = Number(bucket?.remainingFraction)
      upsertSlot(slots, family, slot, Number.isFinite(remaining) ? remaining : 0, bucket?.resetTime)
    }
  }
  return slots
}

function parseModelsFallback(modelsResponse, slots = new Map()) {
  const models = modelsResponse?.models
  if (!models || typeof models !== 'object' || Array.isArray(models)) return slots
  const fallback = new Map()
  for (const [name, model] of Object.entries(models)) {
    const family = name.startsWith('claude')
      ? 'claude'
      : name.startsWith('gemini')
        ? 'gemini'
        : ''
    if (!family) continue
    const remaining = Number(model?.quotaInfo?.remainingFraction)
    upsertSlot(
      fallback,
      family,
      '5h',
      Number.isFinite(remaining) ? remaining : 0,
      model?.quotaInfo?.resetTime
    )
  }
  for (const [key, value] of fallback) {
    if (!slots.has(key)) slots.set(key, value)
  }
  return slots
}

function windowsFromSlots(slots) {
  return EXPECTED_WINDOWS.flatMap(([id, label, kind]) => {
    const family = id.includes('-claude-') ? 'claude' : 'gemini'
    const slot = id.endsWith('-5h') ? '5h' : 'weekly'
    const value = slots.get(`${family}:${slot}`)
    if (!value) return []
    const used = Math.round((1 - value.remaining) * 100_000) / 1000
    return [createWindow(id, label, kind, used, 100, value.resetAt)]
  })
}

function applyAntigravityQuota({ summary, models, tier, nowMs }) {
  const account = createBaseAccount('antigravity', nowMs)
  const slots = parseQuotaSummary(summary)
  parseModelsFallback(models, slots)
  account.status = 'available'
  account.accuracy = 'official'
  account.planName = tier ? `Antigravity ${String(tier).slice(0, 120)}` : 'Antigravity'
  account.notes = '已從 Google cloudcode-pa API（Antigravity）讀取真實額度。'
  account.windows = windowsFromSlots(slots)
  if (!account.windows.length) {
    account.status = 'connected'
    account.notes = 'Antigravity 已連線，但沒有回傳 Claude／Gemini 額度。'
  }
  return normalizeAccount(account)
}

function mergeExpectedWindows(current, previous) {
  return EXPECTED_WINDOWS.map(([id, label, kind]) => {
    const fresh = current.find((window) => window.id === id)
    if (fresh) return { ...fresh }
    const cached = previous?.windows?.find((window) => window.id === id)
    if (cached) return { ...cached, id, label, kind }
    return createWindow(id, label, kind, 100, 100, '')
  })
}

function antigravityHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': USER_AGENT
  }
}

async function refreshAccessToken(refreshToken, env, fetchImpl) {
  const clientId = typeof env?.ANTIGRAVITY_CLIENT_ID === 'string'
    ? env.ANTIGRAVITY_CLIENT_ID.trim()
    : ''
  const clientSecret = typeof env?.ANTIGRAVITY_CLIENT_SECRET === 'string'
    ? env.ANTIGRAVITY_CLIENT_SECRET.trim()
    : ''
  if (!clientId || !clientSecret) return ''
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  })
  const response = await fetchJson(ENDPOINTS.googleOauth, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
    body,
    fetchImpl,
    stopStatuses: [400, 401, 403]
  })
  return typeof response.access_token === 'string' ? response.access_token.trim() : ''
}

async function fetchLoadCodeAssist(token, fetchImpl, log) {
  for (const base of ENDPOINTS.antigravityBases) {
    try {
      const data = await fetchJson(`${base}/v1internal:loadCodeAssist`, {
        method: 'POST',
        headers: antigravityHeaders(token),
        body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
        fetchImpl
      })
      const project = typeof data.cloudaicompanionProject === 'string'
        ? data.cloudaicompanionProject.split('/').filter(Boolean).at(-1) || ''
        : ''
      const tier = data?.paidTier?.name || data?.paidTier?.id || data?.currentTier?.name || ''
      return { project, tier: typeof tier === 'string' ? tier : '' }
    } catch (error) {
      log(`antigravity: loadCodeAssist ${base} failed ${error.status ? `HTTP ${error.status}` : error.code}`)
    }
  }
  return { project: '', tier: '' }
}

function projectBodies(project) {
  return project ? [{ project }, {}] : [{}]
}

async function fetchAcrossBases(endpoint, token, project, fetchImpl, log, required) {
  let lastError = null
  for (const base of ENDPOINTS.antigravityBases) {
    for (const body of projectBodies(project)) {
      try {
        return await fetchJson(`${base}/v1internal:${endpoint}`, {
          method: 'POST',
          headers: antigravityHeaders(token),
          body: JSON.stringify(body),
          fetchImpl
        })
      } catch (error) {
        lastError = error
        log(`antigravity: ${endpoint} ${base} failed ${error.status ? `HTTP ${error.status}` : error.code}`)
        if (error.status === 401) throw error
        if (error.status !== 403) break
      }
    }
  }
  if (required) throw lastError || new Error(`${endpoint} unavailable`)
  return null
}

async function syncQuota(token, fetchImpl, log) {
  const { project, tier } = await fetchLoadCodeAssist(token, fetchImpl, log)
  const summary = await fetchAcrossBases(
    'retrieveUserQuotaSummary', token, project, fetchImpl, log, false
  )
  const models = await fetchAcrossBases(
    'fetchAvailableModels', token, project, fetchImpl, log, true
  )
  return { summary, models, tier }
}

async function syncAntigravity({
  env = process.env,
  nowMs = Date.now(),
  fetchImpl,
  log = () => {},
  readCredential = readAntigravityCredential
}) {
  const account = createBaseAccount('antigravity', nowMs)
  const rawCredential = await readCredential()
  const credential = parseCredential(rawCredential || '')
  if (!credential) {
    account.status = 'disconnected'
    account.notes = '找不到 Antigravity 登入憑證，請先在 Antigravity 登入。'
    return normalizeAccount(account)
  }

  let token = credential.accessToken
  let refreshed = false
  if (tokenIsStale(credential.expiry, nowMs)) {
    try {
      const fresh = await refreshAccessToken(credential.refreshToken, env, fetchImpl)
      if (fresh) {
        token = fresh
        refreshed = true
        log('antigravity: access token refreshed')
      } else {
        log('antigravity: refresh unavailable')
      }
    } catch (error) {
      log(`antigravity: refresh failed ${error.status ? `HTTP ${error.status}` : error.code}`)
    }
  }

  try {
    let quota
    try {
      quota = await syncQuota(token, fetchImpl, log)
    } catch (error) {
      if (error.status !== 401 || refreshed) throw error
      const fresh = await refreshAccessToken(credential.refreshToken, env, fetchImpl)
      if (!fresh) throw error
      refreshed = true
      quota = await syncQuota(fresh, fetchImpl, log)
    }
    const result = applyAntigravityQuota({ ...quota, nowMs })
    result.windows = mergeExpectedWindows(result.windows, null)
    return normalizeAccount(result)
  } catch (error) {
    log(`antigravity: quota failed ${error.status ? `HTTP ${error.status}` : error.code || 'unknown'}`)
    account.status = 'connected'
    account.accuracy = 'estimated'
    account.notes = error.status
      ? `Antigravity 額度 API 暫時無法使用（HTTP ${error.status}）。`
      : tokenIsStale(credential.expiry, nowMs) && !refreshed
        ? 'Antigravity token 已過期，且未提供 OAuth refresh 環境變數。'
        : 'Antigravity 額度 API 暫時無法使用。'
    return normalizeAccount(account)
  }
}

module.exports = {
  applyAntigravityQuota,
  mergeExpectedWindows,
  parseCredential,
  parseModelsFallback,
  parseQuotaSummary,
  readAntigravityCredential,
  resolveCredentialScriptPath,
  syncAntigravity,
  tokenIsStale
}
