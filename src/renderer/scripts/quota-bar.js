/**
 * 訂閱額度條：工作區主區最下面那一條（renderer）。
 *
 * 以前是獨立的「額度」頁，現在收成一條：一家一顆，顆上是每個視窗的小量表；
 * 點一下開精簡詳情（名字＋方案、一個視窗一行；Codex 另有重置次數可以直接用），拖曳或 Alt+←→ 排序，
 * 「顯示設定」決定哪幾家、每家顯示哪些東西。資料、同步、排序都跟以前同一套 IPC（`usage:*`）。
 *
 * **自動同步**：條看得到的時候每分鐘同步一次（main 那邊會合併同時的請求）；視窗被藏起來、
 * 或切到聊天時不打。Claude 的 token 快過期時 main 會自己續（`usage/claude-auth.js`），
 * 不用再去終端機開一次 claude。
 *
 * DOM 全程 `createElement` ＋ `textContent`，零 innerHTML（備註、方案名是外部字串）。
 */

import { electronAPI, showToast } from './app.js'
import { askConfirm } from './app-dialog.js'
import { createListReorder } from './list-reorder.js'

const PROVIDERS = [
  ['claude-code', 'Claude Code', '#c87955'],
  ['codex', 'Codex', '#46a5ff'],
  ['antigravity', 'Antigravity', '#59c889'],
  ['opencode-go', 'OpenCode', '#f0bd4f'],
  ['grok', 'Grok', '#a8a8b3'],
  ['ollama', 'Ollama Cloud', '#5fc9c9'],
  ['commandcode', 'Command Code', '#b078e8']
]
const PROVIDER_META = new Map(PROVIDERS.map(([id, label, accent]) => [id, { label, accent }]))
const STATUS_LABELS = {
  available: '可用',
  warning: '注意',
  limited: '已用盡',
  connected: '已連線',
  disconnected: '未連線'
}
const WINDOW_LABELS = {
  'rolling-5h': '5 小時視窗',
  weekly: '每週視窗',
  monthly: '每月視窗'
}
/** 詳情一行一個視窗，名字要短 */
const WINDOW_NAMES = { 'rolling-5h': '5 小時', weekly: '每週', monthly: '每月' }
/** 用掉重置之後 Codex 回的結果 */
const RESET_OUTCOMES = {
  reset: ['Codex 額度已重置', 'success'],
  nothingToReset: ['目前沒有需要重置的額度，次數沒有扣', 'info'],
  noCredit: ['已經沒有可用的重置次數', 'error'],
  alreadyRedeemed: ['這次重置已經用過了', 'info']
}
/** 條上的短名：寬度只有一點點 */
const WINDOW_SHORT = { 'rolling-5h': '5h', weekly: '週', monthly: '月' }

/** 「每一家顯示」的勾選項：key 對應 settings.bar 的欄位 */
const BAR_TOGGLES = [
  ['kind:rolling-5h', '5 小時視窗'],
  ['kind:weekly', '每週視窗'],
  ['kind:monthly', '每月視窗'],
  ['showReset', '重置倒數'],
  ['showPlan', '方案名稱'],
  ['compact', '只顯示用得最多的那一條'],
  ['hideDisconnected', '隱藏未連線的工具'],
  ['showLastSync', '上次同步時間']
]
const DEFAULT_BAR = Object.freeze({
  kinds: ['rolling-5h', 'weekly', 'monthly'],
  showReset: true,
  showPlan: false,
  compact: false,
  hideDisconnected: true,
  showLastSync: true
})

/** 條看得到時多久同步一次 */
const AUTO_SYNC_MS = 60_000

let initialized = false
let state = null
let syncing = false
let lastError = ''
let tickTimer = null
let syncTimer = null
/** 拖曳放開之後那一下 click 不算「點開詳情」 */
let suppressClickUntil = 0
/** 詳情開著的是哪一家（重畫之後要接著畫同一家） */
let popoverProvider = ''

const byId = (id) => document.getElementById(id)

function initialState() {
  return {
    accounts: PROVIDERS.map(([provider, label], order) => ({
      id: provider,
      provider,
      accountName: label,
      planName: label,
      status: 'disconnected',
      accuracy: 'estimated',
      lastUpdated: new Date(0).toISOString(),
      windows: [],
      notes: '尚未同步',
      order
    })),
    settings: {
      visibleProviders: PROVIDERS.map(([id]) => id),
      providerOrder: PROVIDERS.map(([id]) => id),
      bar: { ...DEFAULT_BAR }
    },
    lastSyncedAt: null,
    diagnostics: []
  }
}

function barSettings() {
  return { ...DEFAULT_BAR, ...(state?.settings?.bar || {}) }
}

function unwrap(response) {
  if (!response?.ok) {
    throw new Error(response?.error?.message || '額度資料讀取失敗')
  }
  return response.data
}

function percentage(window) {
  const value = Number(window.used) / Number(window.limit) * 100
  return Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : 0
}

function deriveStatus(account) {
  if (account.status === 'disconnected') return 'disconnected'
  if (!account.windows.length) return 'connected'
  const maximum = Math.max(...account.windows.map(percentage))
  if (maximum >= 100) return 'limited'
  if (maximum >= 80) return 'warning'
  return 'available'
}

function formatWindowTitle(window) {
  const kind = WINDOW_LABELS[window.kind] || '額度視窗'
  return window.label ? `${window.label} · ${kind}` : kind
}

function formatCountdown(resetAt, nowMs = Date.now(), kind = '', used = NaN) {
  if (!resetAt) return kind === 'rolling-5h' && Number(used) === 0 ? '尚未啟動' : '上游未提供重置時間'
  const target = Date.parse(resetAt)
  if (!Number.isFinite(target)) return '上游未提供重置時間'
  const remaining = target - nowMs
  if (remaining <= 0) return '可重新整理'
  const totalMinutes = Math.floor(remaining / 60_000)
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor(totalMinutes % 1440 / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days}天 ${hours}小時後重置`
  if (hours > 0) return `${hours}小時 ${minutes}分後重置`
  if (minutes > 0) return `${minutes}分後重置`
  return `${Math.max(1, Math.ceil(remaining / 1000))}秒後重置`
}

/** 條上用的短倒數：`2天3時`／`4時12分`／`8分` */
function shortCountdown(resetAt, nowMs = Date.now()) {
  const target = Date.parse(resetAt || '')
  if (!Number.isFinite(target)) return ''
  const remaining = target - nowMs
  if (remaining <= 0) return '已重置'
  const totalMinutes = Math.floor(remaining / 60_000)
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor(totalMinutes % 1440 / 60)
  if (days > 0) return `${days}天${hours}時`
  if (hours > 0) return `${hours}時${totalMinutes % 60}分`
  return `${Math.max(1, totalMinutes)}分`
}

function createElement(tag, className, text) {
  const element = document.createElement(tag)
  if (className) element.className = className
  if (text !== undefined) element.textContent = text
  return element
}

// ===== 詳情卡 =====

/** 詳情那一格的倒數：沒有重置時間就講清楚是哪一種沒有（完整句子放 title） */
function rowCountdown(resetAt, nowMs, kind, used) {
  if (!resetAt) return kind === 'rolling-5h' && Number(used) === 0 ? '未啟動' : '未提供'
  return shortCountdown(resetAt, nowMs)
}

function createQuotaRow(window) {
  const row = createElement('div', 'usage-quota-row')
  const value = percentage(window)
  const name = WINDOW_NAMES[window.kind] || '額度'
  row.appendChild(createElement('span', 'usage-quota-name', window.label ? `${window.label} ${name}` : name))

  const track = createElement('div', 'usage-progress-track')
  track.setAttribute('role', 'progressbar')
  track.setAttribute('aria-label', `${formatWindowTitle(window)} 已使用`)
  track.setAttribute('aria-valuemin', '0')
  track.setAttribute('aria-valuemax', '100')
  track.setAttribute('aria-valuenow', String(value))
  const fill = createElement('span', 'usage-progress-fill')
  fill.style.width = `${value}%`
  track.appendChild(fill)

  const reset = createElement('span', 'usage-reset-label', rowCountdown(window.resetAt, Date.now(), window.kind, window.used))
  reset.title = formatCountdown(window.resetAt, Date.now(), window.kind, window.used)
  reset.dataset.resetAt = window.resetAt || ''
  reset.dataset.windowKind = window.kind
  reset.dataset.windowUsed = String(window.used)
  row.append(track, createElement('span', 'usage-percentage', `${value}%`), reset)
  return row
}

/** `10/23 到期`；不是今年的帶年份 */
function formatExpiry(expiresAt) {
  const time = Date.parse(expiresAt || '')
  if (!Number.isFinite(time)) return '不會過期'
  const date = new Date(time)
  const sameYear = date.getFullYear() === new Date().getFullYear()
  const text = date.toLocaleDateString('zh-TW', sameYear ? { month: 'numeric', day: 'numeric' } : undefined)
  return `${text} 到期`
}

async function redeemReset(creditId, button) {
  const ok = await askConfirm('用掉一次 Codex 重置？', {
    desc: '5 小時與每週額度會立刻歸零重算，這一次用掉就沒了。',
    confirmText: '用掉一次'
  })
  if (!ok) return
  button.disabled = true
  button.textContent = '重置中…'
  button.setAttribute('aria-busy', 'true')
  try {
    const { outcome, state: next } = unwrap(await electronAPI.usage.redeemCodexReset(creditId))
    if (next) state = next
    const [message, type] = RESET_OUTCOMES[outcome] || ['Codex 回了看不懂的結果', 'error']
    showToast(message, type)
  } catch (error) {
    showToast(error.message || 'Codex 重置失敗', 'error')
  } finally {
    render()
  }
}

/** Codex 的重置次數：還有幾次、每一次什麼時候到期，旁邊直接用 */
function createResetSection(resetCredits) {
  const section = createElement('section', 'usage-resets')
  const head = createElement('div', 'usage-resets-head')
  head.append(createElement('span', '', '重置次數'), createElement('strong', '', String(resetCredits.available)))
  section.appendChild(head)
  if (!resetCredits.available) return section
  const list = createElement('ul', 'usage-resets-list')
  for (const credit of resetCredits.credits) {
    const item = createElement('li', 'usage-resets-item')
    const expiry = createElement('span', 'usage-resets-expiry', formatExpiry(credit.expiresAt))
    if (credit.title) expiry.title = credit.title
    const use = createElement('button', 'btn btn-secondary btn-sm', '使用')
    use.type = 'button'
    use.setAttribute('aria-label', `使用一次 Codex 重置（${formatExpiry(credit.expiresAt)}）`)
    use.addEventListener('click', () => void redeemReset(credit.id, use))
    item.append(expiry, use)
    list.appendChild(item)
  }
  section.appendChild(list)
  return section
}

/**
 * 訂閱方案文字。同步後 main 會把真實方案寫進 planName；沒同步過時它等於 provider 名稱，不顯示。
 * @param {{ provider: string, planName: string, status: string }} account
 * @param {string} label
 * @returns {string}
 */
function planLabel(account, label) {
  if (account.status === 'disconnected') return ''
  const plan = String(account.planName || '').trim()
  if (!plan || plan === label) return ''
  // 標題已經寫著 provider 名字，`Antigravity Google AI Pro` 只留後半段
  return plan.startsWith(`${label} `) ? plan.slice(label.length + 1) : plan
}

function createCard(account) {
  const meta = PROVIDER_META.get(account.provider) || { label: account.provider, accent: '#818cf8' }
  const status = deriveStatus(account)
  const card = createElement('article', `usage-card ${status}`)
  card.dataset.provider = account.provider
  card.style.setProperty('--provider-accent', meta.accent)

  const header = createElement('header', 'usage-card-head')
  header.appendChild(createElement('h2', 'usage-provider-name', meta.label))
  const plan = planLabel(account, meta.label)
  if (plan) header.appendChild(createElement('span', 'usage-card-plan', plan))
  card.appendChild(header)

  if (account.windows.length) {
    const quotaList = createElement('div', 'usage-quota-list')
    for (const window of account.windows) quotaList.appendChild(createQuotaRow(window))
    card.appendChild(quotaList)
  } else {
    card.appendChild(createElement('p', 'usage-empty', account.notes || '尚未取得額度資料'))
  }
  if (account.resetCredits) card.appendChild(createResetSection(account.resetCredits))
  // 只有「這是舊資料」要講；平常的「已從某某 API 讀取」不佔位子
  if (account.windows.length && account.accuracy === 'estimated' && account.notes) {
    card.appendChild(createElement('p', 'usage-card-note', account.notes))
  }
  return card
}

// ===== 條上的一顆 =====

/**
 * 這一家在條上要畫哪幾個視窗。
 * @param {object} account
 * @param {typeof DEFAULT_BAR} bar
 */
function barWindows(account, bar) {
  const kinds = new Set(bar.kinds)
  const picked = account.windows.filter((window) => kinds.has(window.kind))
  if (!bar.compact || picked.length < 2) return picked
  // 精簡：只留最緊的那一條（同分取先出現的，通常是 5 小時）
  return [picked.reduce((best, window) => (percentage(window) > percentage(best) ? window : best))]
}

function createMeter(window, bar) {
  const value = percentage(window)
  const level = value >= 100 ? 'limited' : value >= 80 ? 'warning' : 'available'
  const meter = createElement('span', `quota-meter ${level}`)
  const short = WINDOW_SHORT[window.kind] || ''
  meter.appendChild(createElement('span', 'quota-meter-label', window.label ? `${window.label} ${short}` : short))
  const track = createElement('span', 'quota-meter-track')
  const fill = createElement('span', 'quota-meter-fill')
  fill.style.width = `${value}%`
  track.appendChild(fill)
  meter.append(track, createElement('span', 'quota-meter-value', `${value}%`))
  if (bar.showReset && window.resetAt) {
    const reset = createElement('span', 'quota-meter-reset', shortCountdown(window.resetAt))
    reset.dataset.shortResetAt = window.resetAt
    meter.appendChild(reset)
  }
  return meter
}

function describeAccount(account, windows) {
  const meta = PROVIDER_META.get(account.provider)
  const parts = [meta?.label || account.provider, STATUS_LABELS[deriveStatus(account)]]
  for (const window of windows) parts.push(`${formatWindowTitle(window)} 已用 ${percentage(window)}%`)
  return `${parts.join('，')}。按 Enter 看詳情，Alt+左右鍵調整順序`
}

function createChip(account, bar, reorder) {
  const meta = PROVIDER_META.get(account.provider) || { label: account.provider, accent: '#818cf8' }
  const status = deriveStatus(account)
  const item = createElement('div', `quota-item ${status}`)
  item.dataset.id = account.provider
  item.setAttribute('role', 'listitem')
  item.style.setProperty('--provider-accent', meta.accent)

  const open = createElement('button', 'quota-item-open')
  open.type = 'button'
  open.setAttribute('aria-haspopup', 'dialog')
  open.appendChild(createElement('span', 'quota-item-dot'))
  open.appendChild(createElement('span', 'quota-item-name', meta.label))
  const windows = barWindows(account, bar)
  if (windows.length) {
    for (const window of windows) open.appendChild(createMeter(window, bar))
  } else {
    open.appendChild(createElement('span', 'quota-item-state', STATUS_LABELS[status]))
  }
  const plan = bar.showPlan ? planLabel(account, meta.label) : ''
  if (plan) open.appendChild(createElement('span', 'quota-item-plan', plan))
  open.setAttribute('aria-label', describeAccount(account, windows))
  open.title = account.notes || meta.label
  open.addEventListener('click', () => {
    if (performance.now() < suppressClickUntil) return
    togglePopover(account.provider, open)
  })
  item.appendChild(open)
  item.addEventListener('pointerdown', reorder.onPointerDown)
  item.addEventListener('keydown', reorder.onKeydown)
  return item
}

function visibleAccounts() {
  const visible = new Set(state.settings.visibleProviders)
  const hideDisconnected = barSettings().hideDisconnected
  const accountByProvider = new Map(state.accounts.map((account) => [account.provider, account]))
  return state.settings.providerOrder
    .filter((provider) => visible.has(provider))
    .map((provider) => accountByProvider.get(provider))
    .filter((account) => account && !(hideDisconnected && account.status === 'disconnected'))
}

// ===== 排序 =====

const reorder = createListReorder({
  getList: () => byId('quotaItems'),
  itemSelector: '.quota-item',
  ignoreSelector: 'input',
  axis: 'x',
  onCommit: () => void commitOrder()
})

async function commitOrder() {
  suppressClickUntil = performance.now() + 250
  const host = byId('quotaItems')
  if (!host || !state) return
  const shown = [...host.querySelectorAll('.quota-item')].map((el) => el.dataset.id)
  // 條上只有看得到的那幾家；藏起來的保持原位（跟以前卡片排序同一套規則）
  const shownSet = new Set(shown)
  let index = 0
  const providerOrder = state.settings.providerOrder.map((provider) => (
    shownSet.has(provider) ? shown[index++] : provider
  ))
  const previous = state
  try {
    state = unwrap(await electronAPI.usage.saveSettings({ ...state.settings, providerOrder }))
    const label = PROVIDER_META.get(shown[0])?.label || ''
    byId('quotaSortStatus').textContent = label ? `順序已儲存，第一個是 ${label}` : '順序已儲存'
  } catch (error) {
    state = previous
    showToast(error.message || '額度順序儲存失敗', 'error')
  }
  render()
}

// ===== 詳情 =====

function placePopover(pop, anchor) {
  const rect = anchor.getBoundingClientRect()
  const width = pop.offsetWidth
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
  pop.style.left = `${Math.round(left)}px`
  pop.style.bottom = `${Math.round(window.innerHeight - rect.top + 6)}px`
}

function fillPopover(provider) {
  const pop = byId('quotaPopover')
  const account = state?.accounts.find((item) => item.provider === provider)
  if (!pop || !account) return false
  pop.replaceChildren(createCard(account))
  return true
}

function togglePopover(provider, anchor) {
  const pop = byId('quotaPopover')
  if (!pop?.showPopover) return
  if (pop.matches(':popover-open') && popoverProvider === provider) {
    pop.hidePopover()
    return
  }
  if (!fillPopover(provider)) return
  popoverProvider = provider
  if (!pop.matches(':popover-open')) pop.showPopover()
  placePopover(pop, anchor)
}

// ===== 畫面 =====

function renderLastSync() {
  const element = byId('quotaLastSync')
  if (!element) return
  const bar = barSettings()
  element.classList.toggle('is-error', Boolean(lastError))
  element.title = lastError || ''
  if (syncing) {
    element.textContent = '同步中…'
  } else if (lastError) {
    element.textContent = '同步失敗'
  } else if (!bar.showLastSync) {
    element.textContent = ''
  } else {
    element.textContent = state?.lastSyncedAt
      ? new Date(state.lastSyncedAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      : '尚未同步'
  }
}

function render() {
  const host = byId('quotaItems')
  if (!state || !host) return
  const bar = barSettings()
  const hadFocus = host.contains(document.activeElement) ? document.activeElement.closest('.quota-item')?.dataset.id : ''
  const fragment = document.createDocumentFragment()
  for (const account of visibleAccounts()) fragment.appendChild(createChip(account, bar, reorder))
  if (!fragment.childNodes.length) {
    fragment.appendChild(createElement('span', 'quota-empty', '沒有要顯示的工具'))
  }
  host.replaceChildren(fragment)
  paintOverflow()
  if (hadFocus) host.querySelector(`.quota-item[data-id="${CSS.escape(hadFocus)}"] .quota-item-open`)?.focus()
  renderLastSync()
  const pop = byId('quotaPopover')
  if (pop?.matches?.(':popover-open') && popoverProvider) fillPopover(popoverProvider)
}

/** 右邊還有看不到的顆就淡出邊緣（捲到底就拿掉） */
function paintOverflow() {
  const host = byId('quotaItems')
  if (!host) return
  host.classList.toggle('has-more', host.scrollLeft + host.clientWidth < host.scrollWidth - 1)
}

function updateCountdowns() {
  const now = Date.now()
  document.querySelectorAll('#quotaItems [data-short-reset-at]').forEach((element) => {
    element.textContent = shortCountdown(element.dataset.shortResetAt, now)
  })
  document.querySelectorAll('#quotaPopover [data-reset-at]').forEach((element) => {
    const { resetAt, windowKind, windowUsed } = element.dataset
    element.textContent = rowCountdown(resetAt, now, windowKind, windowUsed)
    element.title = formatCountdown(resetAt, now, windowKind, windowUsed)
  })
}

function isBarVisible() {
  const bar = byId('quotaBar')
  return Boolean(bar && bar.offsetParent !== null && !document.hidden)
}

// ===== 同步 =====

/**
 * @param {{ manual?: boolean }} [options]
 */
async function runSync({ manual = false } = {}) {
  if (syncing) return
  syncing = true
  const button = byId('quotaSyncBtn')
  button?.setAttribute('aria-busy', 'true')
  renderLastSync()
  try {
    state = unwrap(await electronAPI.usage.sync())
    lastError = ''
    if (manual) showToast('額度同步完成', 'success')
  } catch (error) {
    lastError = error.message || '額度同步失敗'
    if (manual) showToast(lastError, 'error')
  } finally {
    syncing = false
    button?.removeAttribute('aria-busy')
    render()
  }
}

function isStale() {
  const last = Number(state?.lastSyncedAt) || 0
  return Date.now() - last >= AUTO_SYNC_MS
}

function startTimers() {
  if (!tickTimer) {
    tickTimer = window.setInterval(() => { if (isBarVisible()) updateCountdowns() }, 1000)
  }
  if (!syncTimer) {
    syncTimer = window.setInterval(() => {
      if (isBarVisible() && isStale()) void runSync()
    }, 5000)
  }
}

// ===== 設定與診斷 =====

function populateSettingsDialog() {
  const visible = new Set(state.settings.visibleProviders)
  const fragment = document.createDocumentFragment()
  for (const [provider, label] of PROVIDERS) {
    const row = createElement('label', 'usage-provider-toggle')
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.value = provider
    checkbox.checked = visible.has(provider)
    row.append(checkbox, createElement('span', '', label))
    fragment.appendChild(row)
  }
  byId('usageProviderToggles').replaceChildren(fragment)

  const bar = barSettings()
  const barFragment = document.createDocumentFragment()
  for (const [key, label] of BAR_TOGGLES) {
    const row = createElement('label', 'usage-provider-toggle')
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.value = key
    checkbox.checked = key.startsWith('kind:') ? bar.kinds.includes(key.slice(5)) : Boolean(bar[key])
    row.append(checkbox, createElement('span', '', label))
    barFragment.appendChild(row)
  }
  byId('usageBarToggles').replaceChildren(barFragment)
}

function readDialogSettings() {
  const visibleProviders = [...byId('usageProviderToggles').querySelectorAll('input:checked')]
    .map((input) => input.value)
  const checked = new Set([...byId('usageBarToggles').querySelectorAll('input:checked')].map((input) => input.value))
  const bar = {
    kinds: ['rolling-5h', 'weekly', 'monthly'].filter((kind) => checked.has(`kind:${kind}`)),
    showReset: checked.has('showReset'),
    showPlan: checked.has('showPlan'),
    compact: checked.has('compact'),
    hideDisconnected: checked.has('hideDisconnected'),
    showLastSync: checked.has('showLastSync')
  }
  return { ...state.settings, visibleProviders, bar }
}

async function saveUsageSettings(settings) {
  try {
    state = unwrap(await electronAPI.usage.saveSettings(settings))
    render()
    return true
  } catch (error) {
    showToast(error.message || '額度設定儲存失敗', 'error')
    return false
  }
}

async function openDiagnostics() {
  const dialog = byId('usageDiagnosticsDialog')
  const text = byId('usageDiagnosticsText')
  text.textContent = '讀取中…'
  dialog.showModal()
  try {
    const lines = unwrap(await electronAPI.usage.getDiagnostics())
    text.textContent = Array.isArray(lines) && lines.length ? lines.join('\n') : '尚無診斷資料'
  } catch (error) {
    text.textContent = error.message || '診斷資料讀取失敗'
  }
}

function bindControls() {
  byId('quotaSyncBtn')?.addEventListener('click', () => void runSync({ manual: true }))
  const settingsDialog = byId('usageSettingsDialog')
  byId('quotaSettingsBtn')?.addEventListener('click', () => {
    populateSettingsDialog()
    settingsDialog.showModal()
  })
  byId('usageSettingsCancel')?.addEventListener('click', () => settingsDialog.close())
  byId('usageSettingsSave')?.addEventListener('click', async () => {
    if (await saveUsageSettings(readDialogSettings())) settingsDialog.close()
  })

  const diagnosticsDialog = byId('usageDiagnosticsDialog')
  byId('quotaDiagnosticsBtn')?.addEventListener('click', openDiagnostics)
  byId('usageDiagnosticsClose')?.addEventListener('click', () => diagnosticsDialog.close())
  byId('usageDiagnosticsCopy')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(byId('usageDiagnosticsText').textContent)
      showToast('診斷已複製', 'success')
    } catch {
      showToast('無法複製診斷', 'error')
    }
  })
  // 條很窄、顆數多時會超出去：直向滾輪也拿來左右捲
  byId('quotaItems')?.addEventListener('wheel', (event) => {
    const host = event.currentTarget
    if (host.scrollWidth <= host.clientWidth || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
    host.scrollLeft += event.deltaY
    event.preventDefault()
  }, { passive: false })
  byId('quotaItems')?.addEventListener('scroll', paintOverflow, { passive: true })
  if (typeof ResizeObserver === 'function' && byId('quotaItems')) {
    new ResizeObserver(paintOverflow).observe(byId('quotaItems'))
  }
  byId('quotaPopover')?.addEventListener('toggle', (event) => {
    if (event.newState === 'closed') popoverProvider = ''
  })
  // 條被藏起來的期間沒同步；一回來就補（不等下一個 5 秒）
  document.addEventListener('visibilitychange', () => {
    if (isBarVisible() && isStale()) void runSync()
  })
}

export async function initQuotaBar() {
  if (initialized || !byId('quotaBar')) return
  initialized = true
  state = initialState()
  bindControls()
  render()
  try {
    state = unwrap(await electronAPI.usage.load())
  } catch (error) {
    lastError = error.message || '額度快取讀取失敗'
  }
  render()
  startTimers()
}

/** 工作區主區剛顯示出來時叫：先把快取畫上去，太舊就馬上同步一次 */
export function refreshQuotaBar() {
  void (async () => {
    await initQuotaBar()
    render()
    if (isBarVisible() && isStale()) void runSync()
  })()
}
