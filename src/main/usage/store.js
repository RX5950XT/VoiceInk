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

const WINDOW_KINDS = ['rolling-5h', 'weekly', 'monthly']

let storePromise = null

function cloneDefaults() {
  return {
    visibleProviders: [...DEFAULT_USAGE_SETTINGS.visibleProviders],
    providerOrder: [...DEFAULT_USAGE_SETTINGS.providerOrder],
    bar: { ...DEFAULT_USAGE_SETTINGS.bar, kinds: [...DEFAULT_USAGE_SETTINGS.bar.kinds] }
  }
}

/**
 * 工作區底下那條額度條要顯示什麼（來自 IPC，逐欄驗）。
 * 缺欄位就用預設；`kinds` 只收認得的視窗種類，全部取消也是合法的（只剩名字與狀態）。
 * @param {unknown} raw
 */
function sanitizeBar(raw) {
  const defaults = DEFAULT_USAGE_SETTINGS.bar
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const kinds = Array.isArray(source.kinds)
    ? WINDOW_KINDS.filter((kind) => source.kinds.includes(kind))
    : [...defaults.kinds]
  const flag = (key) => (typeof source[key] === 'boolean' ? source[key] : defaults[key])
  return {
    kinds,
    showReset: flag('showReset'),
    showPlan: flag('showPlan'),
    compact: flag('compact'),
    hideDisconnected: flag('hideDisconnected'),
    showLastSync: flag('showLastSync')
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
    bar: sanitizeBar(raw?.bar)
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

async function updateState(update) {
  const store = await getStore()
  // 讀取、合併與寫入之間不讓出執行權，避免同步與設定互相蓋掉。
  const sanitized = sanitizeState(update(sanitizeState(store.get('state', null))))
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
  updateState
}
