
const STATUS_TEXT = {
  running: '處理中',
  completed: '完成',
  partial: '部分完成',
  failed: '失敗',
  cancelled: '已取消'
}

const MODE_TEXT = { copy: '複製', move: '搬移', trash: '刪除' }

/** 同名時的三種處理，要跟 main 的 `operations.js` 對得起來 */
const COLLISIONS = new Set(['rename', 'overwrite', 'skip'])

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

function percent(operation) {
  const total = Number(operation.totalBytes)
  const bytes = Number(operation.bytes) || 0
  if (Number.isFinite(total) && total > 0) return `${Math.min(100, Math.floor(bytes / total * 100))}%`
  const done = (operation.completedItems || 0) + (operation.skippedItems || 0)
  return operation.totalItems ? `${done}/${operation.totalItems}` : '…'
}

function progressLabel(operation) {
  if (operation.status !== 'running') return STATUS_TEXT[operation.status] || '結束'
  return percent(operation)
}

/** 狀態列那顆鈕的字：正在做什麼就寫什麼，閒著就寫上一筆的結果。 */
function chipLabel(operations) {
  const running = operations.filter((operation) => operation.status === 'running')
  if (running.length) {
    const tail = running.length > 1 ? `（${running.length}）` : ''
    return `${MODE_TEXT[running[0].mode] || '處理'}中 ${percent(running[0])}${tail}`
  }
  const last = operations[0]
  return last ? `${MODE_TEXT[last.mode] || '操作'}${STATUS_TEXT[last.status] || ''}` : '檔案操作'
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
  title.textContent = `${MODE_TEXT[operation.mode] || '處理'} ${operation.totalItems} 個項目`
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

  // 只有還在跑的時候才需要看已經搬了多少；跑完了那行就是噪音
  if (operation.status === 'running' && operation.totalBytes != null) {
    const summary = document.createElement('p')
    summary.className = 'ex-ops-summary'
    summary.textContent = `${formatBytes(operation.bytes)} / ${formatBytes(operation.totalBytes)}`
    card.append(summary)
  }

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
 * 長在最下面那條狀態列裡：平常只是一顆寫著進度的鈕，點開才看得到每一筆的細節。
 * @param {{ root?: HTMLElement, before?: HTMLElement | null, api?: object }} options
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
  const toggle = button('檔案操作', 'ex-ops-toggle', () => {
    panel.toggleAttribute('hidden')
    toggle.setAttribute('aria-expanded', String(!panel.hidden))
  })
  toggle.setAttribute('aria-expanded', 'false')
  toggle.title = '複製／搬移／刪除的進度，點開可以取消、重試、復原'
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
  policy.title = '「覆蓋」會把目的地那份先丟進資源回收筒，再放新的'
  for (const [value, label] of [
    ['rename', '同名：保留兩份'],
    ['overwrite', '同名：覆蓋'],
    ['skip', '同名：略過']
  ]) {
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
  if (options.before && options.before.parentElement === root) root.insertBefore(host, options.before)
  else root.append(host)

  const open = (yes) => {
    panel.hidden = !yes
    toggle.setAttribute('aria-expanded', String(Boolean(yes)))
  }
  const render = () => {
    cards.replaceChildren()
    const operations = [...state.values()].slice(-8).reverse()
    for (const operation of operations) cards.append(operationCard(operation, api, render))
    toggle.textContent = chipLabel(operations)
    const bad = operations.some((operation) => operation.status === 'failed' || operation.status === 'partial')
    toggle.classList.toggle('is-running', operations.some((operation) => operation.status === 'running'))
    toggle.classList.toggle('is-failed', bad)
  }
  const update = (event) => {
    if (!event || !event.id) return
    state.set(event.id, event.type === 'finished' && event.result ? event.result : event)
    render()
    // 正常跑完不打擾：進度寫在狀態列那顆鈕上；只有出事才自己跳出來
    const result = event.type === 'finished' ? event.result || event : null
    if (result && (result.status === 'failed' || result.status === 'partial')) open(true)
  }
  const unsubscribe = typeof api.onOperation === 'function' ? api.onOperation(update) : () => {}
  void invoke(api, 'operationState').then((initial) => {
    policy.value = COLLISIONS.has(initial?.collision) ? initial.collision : 'rename'
    const active = initial?.active || []
    for (const operation of [...active, ...(initial?.recent || [])]) state.set(operation.id, operation)
    render()
  }).catch(() => {})

  return () => {
    unsubscribe()
    host.remove()
  }
}
