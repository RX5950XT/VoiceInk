import { electronAPI, showToast } from './app.js'
import {
  animateFlip,
  capturePositions,
  mergeVisibleOrder,
  moveProvider as reorderProvider
} from './usage-reorder.js'

const PROVIDERS = [
  ['claude-code', 'Claude Code', '#c87955'],
  ['codex', 'Codex', '#46a5ff'],
  ['antigravity', 'Antigravity', '#59c889'],
  ['opencode-go', 'OpenCode', '#f0bd4f'],
  ['grok', 'Grok', '#a8a8b3']
]
const PROVIDER_META = new Map(PROVIDERS.map(([id, label, accent]) => [id, { label, accent }]))
const STATUS_LABELS = {
  available: '可用',
  warning: '注意',
  limited: '已用盡',
  connected: '已連線',
  disconnected: '未連線'
}
const ACCURACY_LABELS = {
  official: '官方 API',
  local: '本機估算',
  estimated: '快取／推估'
}
const WINDOW_LABELS = {
  'rolling-5h': '5 小時視窗',
  weekly: '每週視窗',
  monthly: '每月視窗'
}

let initialized = false
let state = null
let countdownTimer = null
let sortSession = null
let pointerGrab = null
let syncing = false

const DRAG_THRESHOLD = 4

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
      opencodeWeeklyReset: { day: 1, hour: 7, minute: 0 },
      opencodeMonthlyReset: { day: 29, hour: 0, minute: 0 }
    },
    lastSyncedAt: null,
    diagnostics: []
  }
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

function formatCountdown(resetAt, nowMs = Date.now()) {
  if (!resetAt) return '未提供重置時間'
  const target = Date.parse(resetAt)
  if (!Number.isFinite(target)) return '未提供重置時間'
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

function createElement(tag, className, text) {
  const element = document.createElement(tag)
  if (className) element.className = className
  if (text !== undefined) element.textContent = text
  return element
}

function createQuotaRow(window) {
  const row = createElement('div', 'usage-quota-row')
  const head = createElement('div', 'usage-quota-head')
  head.appendChild(createElement('strong', '', formatWindowTitle(window)))
  const reset = createElement('span', 'usage-reset-label', formatCountdown(window.resetAt))
  reset.dataset.resetAt = window.resetAt || ''
  head.appendChild(reset)

  const value = percentage(window)
  const track = createElement('div', 'usage-progress-track')
  track.setAttribute('role', 'progressbar')
  track.setAttribute('aria-valuemin', '0')
  track.setAttribute('aria-valuemax', '100')
  track.setAttribute('aria-valuenow', String(value))
  const fill = createElement('span', 'usage-progress-fill')
  fill.style.width = `${value}%`
  track.appendChild(fill)

  const foot = createElement('div', 'usage-quota-foot')
  foot.appendChild(createElement('span', 'usage-percentage', `${value}%`))
  foot.appendChild(createElement('span', '', '已使用'))
  row.append(head, track, foot)
  return row
}

function createCard(account) {
  const meta = PROVIDER_META.get(account.provider) || { label: account.provider, accent: '#818cf8' }
  const status = deriveStatus(account)
  const card = createElement('article', `usage-card ${status}`)
  card.dataset.provider = account.provider
  card.tabIndex = 0
  card.setAttribute('aria-grabbed', 'false')
  card.setAttribute('aria-label', `${meta.label}額度卡；按空白鍵開始調整順序`)
  card.style.setProperty('--provider-accent', meta.accent)

  const header = createElement('header', 'usage-card-head')
  header.append(
    createElement('h2', 'usage-provider-name', meta.label),
    createElement('span', `usage-status ${status}`, STATUS_LABELS[status])
  )

  const quotaList = createElement('div', 'usage-quota-list')
  if (account.windows.length) {
    for (const window of account.windows) quotaList.appendChild(createQuotaRow(window))
  } else {
    quotaList.appendChild(createElement('p', 'usage-empty', account.notes || '尚未取得額度資料'))
  }

  const footer = createElement('footer', 'usage-card-footer')
  footer.append(
    createElement('span', '', `可信度 · ${ACCURACY_LABELS[account.accuracy] || '未知'}`),
    createElement('span', '', account.status === 'disconnected' ? '來源未偵測' : '來源已偵測')
  )
  if (account.notes && account.windows.length) {
    footer.appendChild(createElement('p', 'usage-card-note', account.notes))
  }
  card.append(header, quotaList, footer)
  bindCardSort(card)
  return card
}

function cardElements() {
  return [...byId('usageGrid').querySelectorAll('.usage-card')]
}

function visibleOrder(order) {
  const visible = new Set(cardElements().map((card) => card.dataset.provider))
  return order.filter((provider) => visible.has(provider))
}

function announceSort(provider, order, prefix = '') {
  const visible = visibleOrder(order)
  const index = visible.indexOf(provider)
  const label = PROVIDER_META.get(provider)?.label || provider
  const position = index >= 0 ? `目前第 ${index + 1} 個，共 ${visible.length} 個` : ''
  byId('usageSortStatus').textContent = `${prefix}${label}，${position}`
}

function settleDraggedCard(card) {
  const from = card.getBoundingClientRect()
  card.style.transform = ''
  const to = card.getBoundingClientRect()
  const dx = from.left - to.left
  const dy = from.top - to.top
  if (!dx && !dy) return
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  card.animate([
    { transform: `translate3d(${dx}px, ${dy}px, 0)` },
    { transform: 'translate3d(0, 0, 0)' }
  ], { duration: 150, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' })
}

function finishSortSession() {
  if (sortSession?.mode === 'drag') settleDraggedCard(sortSession.card)
  byId('usageGrid')?.classList.remove('is-sorting')
  document.querySelectorAll('.usage-card').forEach((card) => {
    card.classList.remove('dragging', 'keyboard-sorting')
    card.setAttribute('aria-grabbed', 'false')
  })
  sortSession = null
}

function startSort(mode, card) {
  if (sortSession) return false
  const provider = card.dataset.provider
  const originalOrder = [...state.settings.providerOrder]
  sortSession = {
    mode,
    provider,
    card,
    originalOrder,
    previewOrder: originalOrder,
    committing: false
  }
  byId('usageGrid').classList.add('is-sorting')
  card.classList.add(mode === 'drag' ? 'dragging' : 'keyboard-sorting')
  card.setAttribute('aria-grabbed', 'true')
  announceSort(provider, originalOrder, '已抓取')
  return true
}

function applyPreviewOrder(order, animate = true) {
  const grid = byId('usageGrid')
  const cards = cardElements()
  const before = animate ? capturePositions(cards) : null
  const cardByProvider = new Map(cards.map((card) => [card.dataset.provider, card]))
  for (const provider of order) {
    const card = cardByProvider.get(provider)
    if (card) grid.appendChild(card)
  }
  if (!animate) return
  const siblings = cardElements().filter((card) => card.dataset.provider !== sortSession?.provider)
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  animateFlip(siblings, before, reduced)
}

function previewVisibleOrder(nextVisible, animate) {
  if (!sortSession) return
  const next = mergeVisibleOrder(sortSession.previewOrder, nextVisible)
  sortSession.previewOrder = next
  applyPreviewOrder(next, animate)
  announceSort(sortSession.provider, next)
}

function moveKeyboardSort(delta) {
  if (!sortSession) return
  const visible = visibleOrder(sortSession.previewOrder)
  const from = visible.indexOf(sortSession.provider)
  const to = Math.max(0, Math.min(visible.length - 1, from + delta))
  if (from < 0 || from === to) return
  previewVisibleOrder(reorderProvider(visible, sortSession.provider, to), false)
}

function restoreSortSession(animate) {
  if (!sortSession || sortSession.committing) return
  const { provider, originalOrder } = sortSession
  applyPreviewOrder(originalOrder, animate)
  announceSort(provider, originalOrder, '已取消')
  finishSortSession()
}

async function commitSort() {
  if (!sortSession || sortSession.committing) return
  const session = sortSession
  const previous = state
  session.committing = true
  try {
    const settings = { ...state.settings, providerOrder: session.previewOrder }
    state = unwrap(await electronAPI.usage.saveSettings(settings))
    setError('')
    renderSummary()
    announceSort(session.provider, session.previewOrder, '已放置')
  } catch (error) {
    state = previous
    session.committing = false
    applyPreviewOrder(session.originalOrder, session.mode === 'drag')
    setError(error.message || '額度順序儲存失敗')
    announceSort(session.provider, session.originalOrder, '儲存失敗，已還原')
  } finally {
    finishSortSession()
  }
}

function pointerIsAfter(event, target) {
  const rect = target.getBoundingClientRect()
  const verticalDistance = Math.abs(event.clientY - (rect.top + rect.height / 2))
  if (verticalDistance > rect.height * 0.25) {
    return event.clientY > rect.top + rect.height / 2
  }
  return event.clientX > rect.left + rect.width / 2
}

function previewDrag(card, event) {
  if (!sortSession || sortSession.mode !== 'drag') return
  const visible = visibleOrder(sortSession.previewOrder)
  const sourceIndex = visible.indexOf(sortSession.provider)
  const targetIndex = visible.indexOf(card.dataset.provider)
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return
  let insertion = targetIndex + (pointerIsAfter(event, card) ? 1 : 0)
  if (sourceIndex < insertion) insertion--
  const next = reorderProvider(visible, sortSession.provider, insertion)
  if (next.every((provider, index) => provider === visible[index])) return
  previewVisibleOrder(next, true)
}

function cardUnderPointer(event) {
  return cardElements().find((card) => {
    if (card === sortSession?.card) return false
    const rect = card.getBoundingClientRect()
    return event.clientX >= rect.left && event.clientX <= rect.right &&
      event.clientY >= rect.top && event.clientY <= rect.bottom
  })
}

function followPointer(card, grab, event) {
  card.style.transform = 'none'
  const base = card.getBoundingClientRect()
  const x = Math.round(event.clientX - grab.offsetX - base.left)
  const y = Math.round(event.clientY - grab.offsetY - base.top)
  card.style.transform = `translate3d(${x}px, ${y}px, 0)`
}

function endPointerDrag() {
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('pointercancel', onPointerCancel)
  const active = Boolean(pointerGrab?.active)
  pointerGrab = null
  return active
}

function onPointerMove(event) {
  const grab = pointerGrab
  if (!grab || event.pointerId !== grab.pointerId) return
  if (grab.active && !sortSession) {
    endPointerDrag()
    return
  }
  if (!grab.active) {
    const moved = Math.hypot(event.clientX - grab.startX, event.clientY - grab.startY)
    if (moved < DRAG_THRESHOLD) return
    if (!startSort('drag', grab.card)) {
      endPointerDrag()
      return
    }
    const rect = grab.card.getBoundingClientRect()
    grab.offsetX = grab.startX - rect.left
    grab.offsetY = grab.startY - rect.top
    grab.active = true
  }
  event.preventDefault()
  const target = cardUnderPointer(event)
  if (target) previewDrag(target, event)
  followPointer(grab.card, grab, event)
}

function onPointerUp() {
  if (endPointerDrag()) void commitSort()
}

function onPointerCancel() {
  if (endPointerDrag()) restoreSortSession(true)
}

function bindCardDrag(card) {
  card.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || pointerGrab || sortSession) return
    if (event.target.closest('button, a, input, select, textarea')) return
    pointerGrab = {
      card,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: 0,
      offsetY: 0,
      active: false
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerCancel)
  })
}

function bindCardKeyboard(card) {
  card.addEventListener('keydown', (event) => {
    const isSpace = event.key === ' ' || event.key === 'Spacebar'
    if (!sortSession) {
      if (!isSpace) return
      event.preventDefault()
      startSort('keyboard', card)
      return
    }
    if (sortSession.mode === 'drag') {
      if (event.key !== 'Escape') return
      event.preventDefault()
      restoreSortSession(true)
      return
    }
    if (sortSession.mode !== 'keyboard' || sortSession.provider !== card.dataset.provider) return
    if (['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(event.key)) {
      event.preventDefault()
      moveKeyboardSort(['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1)
    } else if (event.key === 'Enter' || isSpace) {
      event.preventDefault()
      void commitSort()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      restoreSortSession(false)
    }
  })
}

function bindCardSort(card) {
  bindCardDrag(card)
  bindCardKeyboard(card)
}

function visibleAccounts() {
  const visible = new Set(state.settings.visibleProviders)
  const accountByProvider = new Map(state.accounts.map((account) => [account.provider, account]))
  return state.settings.providerOrder
    .filter((provider) => visible.has(provider))
    .map((provider) => accountByProvider.get(provider))
    .filter(Boolean)
}

function renderSummary() {
  const host = byId('usageProviderSummary')
  const fragment = document.createDocumentFragment()
  for (const account of state.accounts) {
    const meta = PROVIDER_META.get(account.provider)
    const chip = createElement('span', `usage-provider-chip ${deriveStatus(account)}`)
    chip.append(
      createElement('span', 'usage-chip-dot'),
      createElement('span', '', meta?.label || account.provider)
    )
    fragment.appendChild(chip)
  }
  host.replaceChildren(fragment)
  const lastSync = byId('usageLastSync')
  lastSync.textContent = state.lastSyncedAt
    ? `上次同步 ${new Date(state.lastSyncedAt).toLocaleString('zh-TW')}`
    : '尚未同步'
}

function render() {
  if (!state || !byId('usageGrid')) return
  if (sortSession) finishSortSession()
  const fragment = document.createDocumentFragment()
  for (const account of visibleAccounts()) fragment.appendChild(createCard(account))
  if (!fragment.childNodes.length) {
    fragment.appendChild(createElement('p', 'usage-grid-empty', '所有項目都已隱藏，可從「顯示設定」重新開啟。'))
  }
  byId('usageGrid').replaceChildren(fragment)
  renderSummary()
  updateCountdowns()
}

function updateCountdowns() {
  document.querySelectorAll('#usageGrid [data-reset-at]').forEach((element) => {
    element.textContent = formatCountdown(element.dataset.resetAt)
  })
}

function startCountdown() {
  stopCountdown()
  if (!byId('page-usage')?.classList.contains('active')) return
  countdownTimer = window.setInterval(updateCountdowns, 1000)
}

function stopCountdown() {
  if (countdownTimer !== null) window.clearInterval(countdownTimer)
  countdownTimer = null
}

function setError(message) {
  const element = byId('usageError')
  element.textContent = message || ''
  element.classList.toggle('hidden', !message)
}

async function saveUsageSettings(settings) {
  const previous = state
  try {
    state = unwrap(await electronAPI.usage.saveSettings(settings))
    setError('')
    render()
    return true
  } catch (error) {
    state = previous
    setError(error.message || '額度設定儲存失敗')
    render()
    return false
  }
}

function formatTime(config) {
  return `${String(config.hour).padStart(2, '0')}:${String(config.minute).padStart(2, '0')}`
}

function parseTime(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(value || '')
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : { hour: 0, minute: 0 }
}

function populateSettingsDialog() {
  const visible = new Set(state.settings.visibleProviders)
  const toggles = byId('usageProviderToggles')
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
  toggles.replaceChildren(fragment)
  const weekly = state.settings.opencodeWeeklyReset
  const monthly = state.settings.opencodeMonthlyReset
  byId('usageWeeklyDay').value = String(weekly.day)
  byId('usageWeeklyTime').value = formatTime(weekly)
  byId('usageMonthlyDay').value = String(monthly.day)
  byId('usageMonthlyTime').value = formatTime(monthly)
}

function readDialogSettings() {
  const visibleProviders = [...byId('usageProviderToggles').querySelectorAll('input:checked')]
    .map((input) => input.value)
  const weeklyTime = parseTime(byId('usageWeeklyTime').value)
  const monthlyTime = parseTime(byId('usageMonthlyTime').value)
  return {
    ...state.settings,
    visibleProviders,
    opencodeWeeklyReset: {
      day: Number(byId('usageWeeklyDay').value),
      ...weeklyTime
    },
    opencodeMonthlyReset: {
      day: Number(byId('usageMonthlyDay').value),
      ...monthlyTime
    }
  }
}

async function onSync() {
  if (syncing) return
  syncing = true
  const button = byId('usageSyncBtn')
  button.disabled = true
  button.setAttribute('aria-busy', 'true')
  try {
    state = unwrap(await electronAPI.usage.sync())
    setError('')
    render()
    showToast('額度同步完成', 'success')
  } catch (error) {
    setError(error.message || '額度同步失敗')
  } finally {
    syncing = false
    button.disabled = false
    button.removeAttribute('aria-busy')
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

function bindDialogs() {
  const settingsDialog = byId('usageSettingsDialog')
  byId('usageSettingsBtn').addEventListener('click', () => {
    populateSettingsDialog()
    settingsDialog.showModal()
  })
  byId('usageSettingsCancel').addEventListener('click', () => settingsDialog.close())
  byId('usageSettingsSave').addEventListener('click', async () => {
    if (await saveUsageSettings(readDialogSettings())) settingsDialog.close()
  })

  const diagnosticsDialog = byId('usageDiagnosticsDialog')
  byId('usageDiagnosticsBtn').addEventListener('click', openDiagnostics)
  byId('usageDiagnosticsClose').addEventListener('click', () => diagnosticsDialog.close())
  byId('usageDiagnosticsCopy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(byId('usageDiagnosticsText').textContent)
      showToast('診斷已複製', 'success')
    } catch {
      showToast('無法複製診斷', 'error')
    }
  })
}

function populateMonthlyDays() {
  const select = byId('usageMonthlyDay')
  const fragment = document.createDocumentFragment()
  for (let day = 1; day <= 31; day++) {
    const option = createElement('option', '', `${day} 日`)
    option.value = String(day)
    fragment.appendChild(option)
  }
  select.replaceChildren(fragment)
}

export async function initUsagePage() {
  if (initialized || !byId('page-usage')) return
  initialized = true
  state = initialState()
  populateMonthlyDays()
  byId('usageSyncBtn').addEventListener('click', onSync)
  bindDialogs()
  render()
  try {
    state = unwrap(await electronAPI.usage.load())
    setError('')
  } catch (error) {
    setError(error.message || '額度快取讀取失敗')
  }
  render()
}

export function refreshUsagePage() {
  render()
  startCountdown()
}

export function cooldownUsagePage() {
  endPointerDrag()
  if (sortSession && !sortSession.committing) restoreSortSession(false)
  stopCountdown()
}
