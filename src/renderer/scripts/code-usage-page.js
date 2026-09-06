/**
 * 額度頁的「用量統計」子分頁（renderer）。
 *
 * 跟同一頁的「訂閱額度」看的是兩件事：那邊是**還剩多少**（官方 API），
 * 這邊是**實際用掉多少 token、跑幾次、大概多少錢**（本機 session 記錄）。
 *
 * 圖表沿用 AGY 統計那套純 CSS 長條，不引任何圖表套件。
 * DOM 全程 `createElement` ＋ `textContent`，零 innerHTML。
 */

const electronAPI = window.electronAPI

let bound = false
let range = '7d'
/** @type {object | null} */
let latest = null
let syncing = false

// ===== 小工具 =====

/**
 * @param {string} tag
 * @param {string} className
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/**
 * @param {number} value
 * @returns {string}
 */
function formatTokens(value) {
  const n = Number(value) || 0
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return String(n)
}

/**
 * @param {number} value
 * @returns {string}
 */
function formatMoney(value) {
  const n = Number(value) || 0
  if (n === 0) return '$0'
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`
}

/**
 * @param {number} ts
 * @param {'hour'|'day'} bucket
 * @returns {string}
 */
function formatBucket(ts, bucket) {
  const date = new Date(ts)
  return bucket === 'hour'
    ? `${String(date.getMonth() + 1)}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:00`
    : `${String(date.getMonth() + 1)}/${date.getDate()}`
}

/**
 * @template T
 * @param {Promise<{ ok: boolean, data?: T, error?: { message: string } }>} promise
 * @param {string} fallback
 * @returns {Promise<T>}
 */
async function call(promise, fallback) {
  const result = await promise
  const errorEl = document.getElementById('cuError')
  if (!result?.ok) {
    const message = result?.error?.message || fallback
    if (errorEl) {
      errorEl.textContent = message
      errorEl.classList.remove('hidden')
    }
    throw new Error(message)
  }
  errorEl?.classList.add('hidden')
  return result.data
}

// ===== 渲染 =====

function renderSummary() {
  const host = document.getElementById('cuSummary')
  if (!host || !latest) return
  const s = latest.summary
  host.replaceChildren()

  const cards = [
    { label: '請求數', value: String(s.requests) },
    { label: '輸入', value: formatTokens(s.input) },
    { label: '輸出', value: formatTokens(s.output) },
    { label: '快取讀取', value: formatTokens(s.cacheRead) },
    // 快取寫入是真的要付錢的（而且比一般輸入貴），不列出來使用者會以為金額算錯
    { label: '快取寫入', value: formatTokens((s.cacheWrite || 0) + (s.cacheWrite1h || 0)) },
    { label: '花費（估）', value: formatMoney(s.costUsd) }
  ]
  for (const card of cards) {
    const node = el('div', 'cu-stat')
    node.append(el('span', 'cu-stat-label', card.label))
    node.append(el('span', 'cu-stat-value', card.value))
    host.append(node)
  }

  const note = document.getElementById('cuUncosted')
  if (note) {
    const models = latest.uncostedModels || []
    // 沒有單價的模型不能當成 0 塊，否則總花費會少一截而且看不出來
    const show = models.length > 0
    note.classList.toggle('hidden', !show)
    if (show) {
      note.textContent = `${models.length} 個模型未設單價（${s.uncostedRequests} 次請求未計費）：${models.join('、')}（點擊設定單價）`
      note.style.cursor = 'pointer'
    }
  }

  const syncedAt = document.getElementById('cuSyncedAt')
  if (syncedAt) {
    syncedAt.textContent = latest.syncedAt
      ? `上次掃描：${new Date(latest.syncedAt).toLocaleString()}`
      : '尚未掃描'
  }
}

/**
 * 四種 token 的顯示順序＝長條由下往上堆疊的順序，也是圖例與明細那一行的順序。
 * 只顯示一個總數的話，「幾十億 token」看不出是真的在打模型還是在讀快取（價差 10 倍）。
 */
const TOKEN_PARTS = Object.freeze([
  { key: 'input', label: '輸入' },
  { key: 'output', label: '輸出' },
  { key: 'cacheRead', label: '快取讀' },
  { key: 'cacheWrite', label: '快取寫' }
])

/**
 * 一格的 token 明細文字（`輸入 1.2M · 輸出 30K · …`）。沒有量的那一項不列。
 * @param {object} item
 * @returns {string}
 */
function partsText(item) {
  const bits = TOKEN_PARTS
    .filter((part) => (item[part.key] || 0) > 0)
    .map((part) => `${part.label} ${formatTokens(item[part.key])}`)
  return bits.join(' · ')
}

function renderChart() {
  const host = document.getElementById('cuChart')
  if (!host || !latest) return
  host.replaceChildren()
  const series = latest.series || []
  const max = Math.max(1, ...series.map((item) => item.tokens))

  for (const item of series) {
    const col = el('div', 'cu-bar-col')
    const bar = el('div', 'cu-bar')
    bar.style.height = `${Math.round((item.tokens / max) * 100)}%`
    // 分段堆疊：段高用 flex-grow 給比例，不必自己算百分比（四段加起來一定填滿）
    for (const part of TOKEN_PARTS) {
      const value = item[part.key] || 0
      if (!value) continue
      const seg = el('div', `cu-bar-seg is-${part.key}`)
      seg.style.flexGrow = String(value)
      bar.append(seg)
    }
    col.append(bar)

    // 滑鼠移上去顯示實際數字。純 CSS 顯隱（`:hover`），不掛 JS 事件——
    // 原生 `title` 要等一秒才浮出來，而且沒辦法排版成多行
    const tip = el('div', 'cu-bar-tip')
    tip.append(el('span', 'cu-bar-tip-time', formatBucket(item.ts, latest.bucket)))
    tip.append(el('span', 'cu-bar-tip-main',
      `${item.requests} 次 · ${formatTokens(item.tokens)} tokens · ${formatMoney(item.costUsd)}`))
    const detail = partsText(item)
    if (detail) tip.append(el('span', 'cu-bar-tip-parts', detail))
    col.append(tip)
    // 讀螢幕與觸控裝置沒有 hover，同一份數字也放進 aria-label
    col.setAttribute('aria-label',
      `${formatBucket(item.ts, latest.bucket)}：${item.requests} 次，${formatTokens(item.tokens)} tokens${detail ? `（${detail}）` : ''}`)
    host.append(col)
  }
  if (!series.length) host.append(el('p', 'cc-empty', '這段時間沒有資料。'))
}

/** 長條顏色對照哪一種 token；沒有它使用者只會看到四種不明色塊 */
function renderChartLegend() {
  const host = document.getElementById('cuChartLegend')
  if (!host) return
  host.replaceChildren()
  for (const part of TOKEN_PARTS) {
    const item = el('span', 'cu-legend-item')
    item.append(el('span', `cu-legend-dot is-${part.key}`))
    item.append(el('span', 'cu-legend-label', part.label))
    host.append(item)
  }
}

/**
 * @param {string} hostId
 * @param {Array<object>} rows
 * @param {(row: object) => string} labelOf
 */
function renderDistribution(hostId, rows, labelOf) {
  const host = document.getElementById(hostId)
  if (!host) return
  host.replaceChildren()
  const max = Math.max(1, ...rows.map((row) => row.tokens))

  for (const row of rows) {
    const item = el('div', 'cu-dist-row')
    const head = el('div', 'cu-dist-head')
    head.append(el('span', 'cu-dist-name', labelOf(row)))
    const value = row.uncosted && !row.costUsd
      ? `${formatTokens(row.tokens)} · 未設單價`
      : `${formatTokens(row.tokens)} · ${formatMoney(row.costUsd)}`
    head.append(el('span', 'cu-dist-value', value))
    item.append(head)

    // 條子也分段：同一列裡看得出這些 token 有多少是快取
    const track = el('div', 'cu-dist-track')
    for (const part of TOKEN_PARTS) {
      const amount = row[part.key] || 0
      if (!amount) continue
      const fill = el('div', `cu-dist-fill is-${part.key}`)
      fill.style.width = `${(amount / max) * 100}%`
      fill.title = `${part.label} ${formatTokens(amount)}`
      track.append(fill)
    }
    item.append(track)
    const detail = partsText(row)
    if (detail) item.append(el('span', 'cu-dist-parts', detail))
    host.append(item)
  }
  if (!rows.length) host.append(el('p', 'cc-empty', '沒有資料。'))
}

function render() {
  if (!latest) return
  renderSummary()
  renderChart()
  renderChartLegend()
  renderDistribution('cuProviders', (latest.providers || []).filter((row) => row.requests > 0), (row) => row.label)
  renderDistribution('cuModels', latest.models || [], (row) => row.key)

  document.querySelectorAll('#cuRangeGroup .agy-range-btn').forEach((btn) => {
    const on = btn.dataset.cuRange === range
    btn.classList.toggle('is-active', on)
    btn.setAttribute('aria-pressed', on ? 'true' : 'false')
  })
}

// ===== 單價彈窗 =====

function openPricesDialog() {
  const dialog = /** @type {HTMLDialogElement} */ (document.getElementById('cuPricesDialog'))
  const host = document.getElementById('cuPriceRows')
  if (!dialog || !host || !latest) return
  host.replaceChildren()

  const head = el('div', 'cu-price-row')
  head.append(el('span', 'cu-price-head', ''))
  for (const label of ['輸入', '輸出', '快取讀', '快取寫']) {
    head.append(el('span', 'cu-price-head', label))
  }
  host.append(head)

  for (const entry of latest.prices || []) {
    host.append(priceRow(entry.model, entry.price, entry.source))
  }
  /** @type {HTMLInputElement} */ (document.getElementById('cuNewModel')).value = ''
  dialog.showModal()
}

/**
 * @param {string} model
 * @param {{ input: number, output: number, cacheRead?: number, cacheWrite?: number } | null} price
 * @param {string} source
 * @returns {HTMLElement}
 */
function priceRow(model, price, source) {
  const row = el('div', 'cu-price-row')
  row.dataset.model = model
  row.dataset.source = source
  if (price) {
    row.dataset.origInput = price.input !== undefined ? String(price.input) : ''
    row.dataset.origOutput = price.output !== undefined ? String(price.output) : ''
    row.dataset.origCacheRead = price.cacheRead !== undefined ? String(price.cacheRead) : ''
    row.dataset.origCacheWrite = price.cacheWrite !== undefined ? String(price.cacheWrite) : ''
  }
  row.append(el('span', 'cu-price-name', model))

  // 四格都是「每 100 萬 token 的美金」。快取那兩格留空＝照 Anthropic 的公開規則推
  // （讀 = 輸入 × 0.1、寫 = 輸入 × 1.25，1 小時快取再 × 1.6）
  const fields = [
    { key: 'input', label: '輸入' },
    { key: 'output', label: '輸出' },
    { key: 'cacheRead', label: '快取讀' },
    { key: 'cacheWrite', label: '快取寫' }
  ]
  for (const field of fields) {
    const box = /** @type {HTMLInputElement} */ (el('input', 'input cu-price-input'))
    box.type = 'number'
    box.min = '0'
    box.step = '0.01'
    box.placeholder = field.label
    box.setAttribute('aria-label', `${model} ${field.label}單價`)
    box.dataset.field = field.key
    const value = price ? price[field.key] : undefined
    if (Number.isFinite(value)) box.value = String(value)
    row.append(box)
  }

  row.append(el('span', 'cu-price-source', source === 'custom' ? '自訂' : (source === 'builtin' ? '內建' : '未設')))
  return row
}

async function savePrices() {
  const host = document.getElementById('cuPriceRows')
  const dialog = /** @type {HTMLDialogElement} */ (document.getElementById('cuPricesDialog'))
  if (!host) return
  /** @type {Record<string, object>} */
  const prices = {}
  for (const row of host.querySelectorAll('.cu-price-row')) {
    const model = row.dataset.model
    if (!model) continue
    const source = row.dataset.source
    const value = (field) => row.querySelector(`[data-field="${field}"]`)?.value ?? ''
    const input = value('input')
    const output = value('output')
    const cacheRead = value('cacheRead')
    const cacheWrite = value('cacheWrite')

    // 輸入與輸出都要填才算數；留空＝這顆模型沒有單價（不是 0 元）
    if (input === '' || output === '') continue

    // 原本是內建且數值完全未修改時，不寫入自訂單價，避免覆蓋官方配置與丟失 1h 快取倍率
    if (source === 'builtin') {
      const origInput = row.dataset.origInput || ''
      const origOutput = row.dataset.origOutput || ''
      const origCacheRead = row.dataset.origCacheRead || ''
      const origCacheWrite = row.dataset.origCacheWrite || ''
      if (input === origInput && output === origOutput && cacheRead === origCacheRead && cacheWrite === origCacheWrite) {
        continue
      }
    }

    prices[model] = { input: Number(input), output: Number(output) }
    // 快取那兩格可以留空：空的話 main 會照公開規則從輸入價推
    if (cacheRead !== '') prices[model].cacheRead = Number(cacheRead)
    if (cacheWrite !== '') prices[model].cacheWrite = Number(cacheWrite)
  }
  try {
    await call(electronAPI.codeusage.savePrices(prices), '儲存單價失敗')
    dialog?.close()
    await refresh()
  } catch {
    // call() 已經顯示訊息
  }
}

function addPriceRow() {
  const field = /** @type {HTMLInputElement} */ (document.getElementById('cuNewModel'))
  const host = document.getElementById('cuPriceRows')
  const model = field?.value.trim().toLowerCase()
  if (!model || !host) return
  if (host.querySelector(`.cu-price-row[data-model="${CSS.escape(model)}"]`)) {
    field.value = ''
    return
  }
  host.append(priceRow(model, null, 'none'))
  field.value = ''
}

// ===== 生命週期 =====

async function refresh() {
  try {
    latest = await call(electronAPI.codeusage.stats({ range }), '讀取用量統計失敗')
    render()
    if (latest?.needsRescan && !syncing) {
      void runSync()
    }
  } catch {
    // call() 已經顯示訊息
  }
}

/**
 * 只有一顆按鈕：增量掃描。「整份重讀」不另外給鈕——統計規則改版時 main 的
 * `sync()` 會自己先 reset 再重讀（`pricing.needsFullRescan`），使用者不必知道有這件事。
 */
async function runSync() {
  if (syncing) return
  syncing = true
  const btn = /** @type {HTMLButtonElement} */ (document.getElementById('cuSyncBtn'))
  const label = btn?.textContent || '掃描本機記錄'
  if (btn) {
    btn.disabled = true
    btn.textContent = '掃描中…'
  }
  try {
    await call(electronAPI.codeusage.sync(), '掃描本機記錄失敗')
    await refresh()
  } catch {
    // call() 已經顯示訊息
  } finally {
    syncing = false
    if (btn) {
      btn.disabled = false
      btn.textContent = label
    }
  }
}

function bindOnce() {
  if (bound) return
  bound = true

  document.querySelectorAll('#cuRangeGroup .agy-range-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      range = btn.dataset.cuRange || '7d'
      void refresh()
    })
  })
  document.getElementById('cuSyncBtn')?.addEventListener('click', () => void runSync())
  document.getElementById('cuUncosted')?.addEventListener('click', openPricesDialog)
  document.getElementById('cuPricesBtn')?.addEventListener('click', openPricesDialog)
  document.getElementById('cuPricesSaveBtn')?.addEventListener('click', () => void savePrices())
  document.getElementById('cuPricesCancelBtn')?.addEventListener('click', () => {
    /** @type {HTMLDialogElement} */ (document.getElementById('cuPricesDialog')).close()
  })
  document.getElementById('cuNewModel')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      addPriceRow()
    }
  })
}

export function refreshCodeUsagePage() {
  bindOnce()
  void refresh()
}
