
const STATUS_TEXT = {
  running: '處理中',
  completed: '完成',
  partial: '部分完成',
  failed: '失敗',
  cancelled: '已取消'
}

const ITEM_TEXT = {
  pending: '等待中',
  running: '處理中',
  completed: '完成',
  skipped: '已略過',
  failed: '失敗',
  cancelled: '已取消'
}

function text(value) {
  return String(value ?? '')
}

function basename(value) {
  return text(value).split(/[\\/]/).filter(Boolean).pop() || text(value)
}

function formatBytes(value) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let n = bytes
  let unit = -1
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024
    unit += 1
  }
  return `${n >= 100 ? n.toFixed(0) : n.toFixed(1)} ${units[unit]}`
}

function progressLabel(operation) {
  if (operation.status !== 'running') return STATUS_TEXT[operation.status] || '結束'
  const total = Number(operation.totalBytes)
  const bytes = Number(operation.bytes) || 0
  if (Number.isFinite(total) && total > 0) return `${Math.min(100, Math.floor(bytes / total * 100))}%`
  return '處理中…'
}

function invoke(api, method, ...args) {
  if (!api || typeof api[method] !== 'function') return Promise.reject(new Error('操作中心尚未接好'))
  return api[method](...args).then((result) => {
    if (!result || result.ok !== true) throw new Error(result?.error?.message || '操作失敗')
    return result.data
  })
}

function button(label, className, onClick) {
  const element = document.createElement('button')
  element.type = 'button'
  element.className = className
  element.textContent = label
  element.addEventListener('click', onClick)
  return element
}

function operationCard(operation, api, onChanged) {
  const card = document.createElement('article')
  card.className = 'ex-ops-card'
  card.dataset.operationId = text(operation.id)

  const head = document.createElement('div')
  head.className = 'ex-ops-card-head'
  const title = document.createElement('strong')
  title.textContent = `${operation.mode === 'copy' ? '複製' : operation.mode === 'move' ? '搬移' : '刪除'} ${operation.totalItems} 個項目`
  const status = document.createElement('span')
  status.className = `ex-ops-status is-${text(operation.status)}`
  status.textContent = progressLabel(operation)
  head.append(title, status)
  card.append(head)

  const meter = document.createElement('progress')
  meter.setAttribute('aria-label', '操作進度')
  meter.className = 'ex-ops-meter'
  if (Number.isFinite(Number(operation.totalBytes)) && Number(operation.totalBytes) > 0) {
    meter.max = 100
    meter.value = Math.min(100, Number(operation.bytes) / Number(operation.totalBytes) * 100)
  } else {
    meter.removeAttribute('value')
  }
  card.append(meter)

  const summary = document.createElement('p')
  summary.className = 'ex-ops-summary'
  summary.textContent = operation.totalBytes == null
    ? `${operation.completedItems + operation.skippedItems}/${operation.totalItems} 個項目`
    : `${formatBytes(operation.bytes)} / ${formatBytes(operation.totalBytes)}`
  card.append(summary)

  const list = document.createElement('ul')
  list.className = 'ex-ops-items'
  for (const item of operation.items || []) {
    const row = document.createElement('li')
    row.className = `ex-ops-item is-${text(item.status)}`
    const name = document.createElement('span')
    name.className = 'ex-ops-item-name'
    name.textContent = basename(item.source)
    name.title = text(item.source)
    const itemStatus = document.createElement('span')
    itemStatus.className = 'ex-ops-item-status'
    itemStatus.textContent = item.error?.userMessage || ITEM_TEXT[item.status] || '—'
    row.append(name, itemStatus)
    list.append(row)
  }
  card.append(list)

  const actions = document.createElement('div')
  actions.className = 'ex-ops-actions'
  if (operation.status === 'running') {
    actions.append(button('取消', 'btn btn-secondary btn-sm', () => {
      void invoke(api, 'operationCancel', operation.id).then(onChanged).catch(() => {})
    }))
  }
  if (operation.status === 'failed' || operation.status === 'partial' || operation.status === 'cancelled') {
    actions.append(button('重試失敗項目', 'btn btn-secondary btn-sm', () => {
      void invoke(api, 'operationRetry', operation.id).then(onChanged).catch(() => {})
    }))
  }
  if (operation.canUndo && operation.status === 'completed') {
    actions.append(button('復原', 'btn btn-secondary btn-sm', () => {
      void invoke(api, 'operationUndo', operation.id).then(onChanged).catch(() => {})
    }))
  }
  if (actions.childElementCount) card.append(actions)
  return card
}

/**
 * 建立整機檔案總管的操作中心。頁面只需在初始化時呼叫一次。
 * @param {{ root?: HTMLElement, api?: object }} options
 * @returns {() => void}
 */
export function mountExplorerOperations(options = {}) {
  const root = options.root || document.body
  const api = options.api || window.electronAPI?.explorer
  if (!root || !api || root.querySelector('.ex-ops-host')) return () => {}

  const state = new Map()
  const host = document.createElement('aside')
  host.className = 'ex-ops-host'
  host.setAttribute('aria-live', 'polite')
  const toggle = button('操作中心', 'ex-ops-toggle', () => {
    panel.toggleAttribute('hidden')
    toggle.setAttribute('aria-expanded', String(!panel.hidden))
  })
  toggle.setAttribute('aria-expanded', 'false')
  const badge = document.createElement('span')
  badge.className = 'ex-ops-badge'
  toggle.append(badge)
  const panel = document.createElement('section')
  panel.className = 'ex-ops-panel'
  panel.hidden = true
  panel.setAttribute('aria-label', '檔案操作中心')
  const header = document.createElement('div')
  header.className = 'ex-ops-panel-head'
  const heading = document.createElement('strong')
  heading.textContent = '檔案操作'
  const policy = document.createElement('select')
  policy.className = 'ex-ops-policy'
  policy.setAttribute('aria-label', '遇到同名檔案時')
  for (const [value, label] of [['rename', '同名時保留兩份'], ['skip', '同名時略過']]) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    policy.append(option)
  }
  policy.addEventListener('change', () => {
    void invoke(api, 'setOperationPolicy', { collision: policy.value }).catch(() => {})
  })
  header.append(heading, policy)
  const cards = document.createElement('div')
  cards.className = 'ex-ops-cards'
  panel.append(header, cards)
  host.append(toggle, panel)
  root.append(host)

  const render = () => {
    cards.replaceChildren()
    const operations = [...state.values()].slice(-8).reverse()
    for (const operation of operations) cards.append(operationCard(operation, api, render))
    const running = operations.filter((operation) => operation.status === 'running').length
    badge.textContent = running ? text(running) : ''
    badge.hidden = !running
  }
  const update = (event) => {
    if (!event || !event.id) return
    state.set(event.id, event.type === 'finished' && event.result ? event.result : event)
    render()
    if (event.type === 'started') {
      panel.hidden = false
      toggle.setAttribute('aria-expanded', 'true')
    }
  }
  const unsubscribe = typeof api.onOperation === 'function' ? api.onOperation(update) : () => {}
  void invoke(api, 'operationState').then((initial) => {
    policy.value = initial?.collision === 'skip' ? 'skip' : 'rename'
    const active = initial?.active || []
    for (const operation of [...active, ...(initial?.recent || [])]) state.set(operation.id, operation)
    if (active.length) {
      panel.hidden = false
      toggle.setAttribute('aria-expanded', 'true')
    }
    render()
  }).catch(() => {})

  return () => {
    unsubscribe()
    host.remove()
  }
}
