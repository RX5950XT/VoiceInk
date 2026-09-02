'use strict'

const path = require('path')
const { syncAntigravity, mergeExpectedWindows } = require('./antigravity')
const { syncClaude } = require('./claude')
const { syncCommandCode } = require('./commandcode')
const { syncCodex } = require('./codex')
const { CACHE_TTL_MS, MAX_DIAGNOSTICS, PROVIDER_IDS } = require('./constants')
const { syncGrok } = require('./grok')
const { syncOllama } = require('./ollama')
const { syncOpenCode } = require('./opencode')
const {
  createBaseAccount,
  normalizeAccount,
  publicError
} = require('./shared')
const usageStore = require('./store')

let syncInFlight = null

function coalesceSync(work) {
  if (syncInFlight) return syncInFlight
  let current
  try {
    current = Promise.resolve(work())
  } catch (error) {
    current = Promise.reject(error)
  }
  syncInFlight = current
  const clear = () => {
    if (syncInFlight === current) syncInFlight = null
  }
  current.then(clear, clear)
  return current
}

function appendCacheNote(notes) {
  const base = typeof notes === 'string' ? notes.trim().replace(/。+$/, '') : ''
  return `${base ? `${base}；` : ''}顯示上次成功同步的資料。`
}

function mergeAccountState(currentRaw, previousRaw, nowMs = Date.now()) {
  const current = normalizeAccount(currentRaw)
  let previous = null
  try { previous = previousRaw ? normalizeAccount(previousRaw) : null } catch { /* invalid cache */ }

  let restoredAntigravity = false
  // 只在上游真的回了至少一個視窗時才補齊缺槽。空陣列代表 API 失敗或沒給額度，
  // 這時 mergeExpectedWindows 會用 100/100 填滿四條，看起來像「官方已用盡」。
  // 空窗交給下面的 6h soft cache；沒快取就維持空，跟其他家同一套降級。
  if (
    current.provider === 'antigravity' &&
    current.status !== 'disconnected' &&
    current.windows.length > 0
  ) {
    const present = new Set(current.windows.map((window) => window.id))
    const merged = mergeExpectedWindows(current.windows, previous)
    restoredAntigravity = merged.some((window) => !present.has(window.id))
    current.windows = merged
  }

  const previousTime = Date.parse(previous?.lastUpdated || '')
  const cacheIsFresh = Number.isFinite(previousTime) && nowMs - previousTime < CACHE_TTL_MS
  const canUseSoftCache = current.windows.length === 0 &&
    previous?.windows?.length > 0 &&
    current.status === 'connected'

  if (canUseSoftCache && cacheIsFresh) {
    current.windows = previous.windows.map((window) => ({ ...window }))
    current.accuracy = 'estimated'
    current.notes = appendCacheNote(current.notes)
  } else if (restoredAntigravity && current.accuracy === 'official') {
    current.accuracy = 'estimated'
    current.notes = '部分 Antigravity 額度未回傳，已保留上次資料或顯示為已用盡。'
  }
  return normalizeAccount(current)
}

function resolveHomeDir(env = process.env) {
  const candidate = env.USERPROFILE || env.HOME || ''
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
    throw new Error('home directory unavailable')
  }
  return candidate
}

function orderAccounts(accounts, settings) {
  const order = settings.providerOrder
  return [...accounts]
    .sort((a, b) => order.indexOf(a.provider) - order.indexOf(b.provider))
    .map((account, index) => ({ ...account, order: index }))
}

function createLogger(lines) {
  return (message) => {
    const safe = typeof message === 'string' ? message.slice(0, 450) : 'usage event'
    lines.push(`[${new Date().toISOString()}] ${safe}`)
    while (lines.length > MAX_DIAGNOSTICS) lines.shift()
    console.log(`[usage] ${safe}`)
  }
}

async function runProviders({ previousAccounts, diagnostics, nowMs }) {
  const homeDir = resolveHomeDir()
  const log = createLogger(diagnostics)
  const args = { homeDir, nowMs, log }
  const jobs = [
    () => syncClaude(args),
    () => syncCodex(args),
    () => syncAntigravity({ nowMs, log }),
    () => syncOpenCode({ ...args, env: process.env }),
    () => syncGrok({ ...args, env: process.env }),
    () => syncOllama({ ...args, env: process.env }),
    // 順序必須跟 PROVIDER_IDS 一致：下面是拿 index 去對 provider 名字的
    () => syncCommandCode({ ...args, env: process.env })
  ]
  const results = await Promise.allSettled(jobs.map((job) => job()))
  return results.map((result, index) => {
    const provider = PROVIDER_IDS[index]
    let account
    if (result.status === 'fulfilled') {
      account = result.value
    } else {
      log(`${provider}: unexpected provider failure`)
      account = createBaseAccount(provider, nowMs)
      account.status = 'disconnected'
      account.notes = '額度來源處理失敗。'
    }
    const previous = previousAccounts.find((item) => item.provider === provider)
    return mergeAccountState(account, previous, nowMs)
  })
}

async function performSync() {
  const previous = await usageStore.loadState()
  const nowMs = Date.now()
  const diagnostics = [...previous.diagnostics]
  const accounts = await runProviders({
    previousAccounts: previous.accounts,
    diagnostics,
    nowMs
  })
  return usageStore.saveState({
    accounts: orderAccounts(accounts, previous.settings),
    settings: previous.settings,
    lastSyncedAt: nowMs,
    diagnostics
  })
}

async function load() {
  const state = await usageStore.loadState()
  return { ...state, accounts: orderAccounts(state.accounts, state.settings) }
}

function sync() {
  return coalesceSync(performSync)
}

async function saveSettings(raw) {
  const current = await usageStore.loadState()
  const settings = usageStore.sanitizeSettings(raw)
  return usageStore.saveState({
    ...current,
    settings,
    accounts: orderAccounts(current.accounts, settings)
  })
}

async function getDiagnostics() {
  return (await usageStore.loadState()).diagnostics
}

function resetForTests() {
  syncInFlight = null
  usageStore.resetStoreForTests()
}

module.exports = {
  coalesceSync,
  getDiagnostics,
  load,
  mergeAccountState,
  publicError,
  resetForTests,
  saveSettings,
  sync
}
