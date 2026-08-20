'use strict'

const {
  DEFAULT_USAGE_SETTINGS,
  MAX_DIAGNOSTICS,
  PROVIDER_IDS
} = require('./constants')
const {
  createInitialAccounts,
  normalizeAccount
} = require('./shared')

let storePromise = null

function cloneDefaults() {
  return {
    visibleProviders: [...DEFAULT_USAGE_SETTINGS.visibleProviders],
    providerOrder: [...DEFAULT_USAGE_SETTINGS.providerOrder],
    opencodeWeeklyReset: { ...DEFAULT_USAGE_SETTINGS.opencodeWeeklyReset },
    opencodeMonthlyReset: { ...DEFAULT_USAGE_SETTINGS.opencodeMonthlyReset }
  }
}

function uniqueProviders(raw) {
  if (!Array.isArray(raw)) return null
  const seen = new Set()
  return raw.filter((id) => {
    if (!PROVIDER_IDS.includes(id) || seen.has(id)) return false
    seen.add(id)
    return true
  })
}

function boundedInteger(value, min, max, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number >= min && number <= max
    ? number
    : fallback
}

function sanitizeReset(raw, fallback, dayMin, dayMax) {
  return {
    day: boundedInteger(raw?.day, dayMin, dayMax, fallback.day),
    hour: boundedInteger(raw?.hour, 0, 23, fallback.hour),
    minute: boundedInteger(raw?.minute, 0, 59, fallback.minute)
  }
}

function sanitizeSettings(raw) {
  const defaults = cloneDefaults()
  const visible = uniqueProviders(raw?.visibleProviders)
  const suppliedOrder = uniqueProviders(raw?.providerOrder)
  const providerOrder = suppliedOrder
    ? [...suppliedOrder, ...PROVIDER_IDS.filter((id) => !suppliedOrder.includes(id))]
    : defaults.providerOrder
  return {
    visibleProviders: visible || defaults.visibleProviders,
    providerOrder,
    opencodeWeeklyReset: sanitizeReset(
      raw?.opencodeWeeklyReset,
      defaults.opencodeWeeklyReset,
      0,
      6
    ),
    opencodeMonthlyReset: sanitizeReset(
      raw?.opencodeMonthlyReset,
      defaults.opencodeMonthlyReset,
      1,
      31
    )
  }
}

function sanitizeDiagnostics(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((line) => typeof line === 'string')
    .map((line) => line.slice(0, 500))
    .slice(-MAX_DIAGNOSTICS)
}

function sanitizeState(raw, nowMs = Date.now()) {
  const settings = sanitizeSettings(raw?.settings)
  const byProvider = new Map()
  if (Array.isArray(raw?.accounts)) {
    for (const account of raw.accounts) {
      try {
        const normalized = normalizeAccount(account)
        if (!byProvider.has(normalized.provider)) byProvider.set(normalized.provider, normalized)
      } catch { /* invalid stored account */ }
    }
  }
  const initial = createInitialAccounts(nowMs)
  const accounts = PROVIDER_IDS.map((provider) => byProvider.get(provider) || initial.find((item) => item.provider === provider))
  const lastSyncedAt = Number(raw?.lastSyncedAt)
  return {
    accounts,
    settings,
    lastSyncedAt: Number.isFinite(lastSyncedAt) && lastSyncedAt > 0 ? lastSyncedAt : null,
    diagnostics: sanitizeDiagnostics(raw?.diagnostics)
  }
}

async function getStore() {
  if (!storePromise) {
    storePromise = import('electron-store').then(({ default: Store }) => new Store({ name: 'usage' }))
  }
  return storePromise
}

async function loadState() {
  const store = await getStore()
  return sanitizeState(store.get('state', null))
}

async function saveState(state) {
  const store = await getStore()
  const sanitized = sanitizeState(state)
  store.set('state', sanitized)
  return sanitized
}

function resetStoreForTests() {
  storePromise = null
}

module.exports = {
  cloneDefaults,
  loadState,
  resetStoreForTests,
  sanitizeSettings,
  sanitizeState,
  saveState
}
