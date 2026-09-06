/**
 * 系統監控 ▸ 使用時長。應用／網站、日週月年、柱狀圖、最常使用、分類。
 * 使用者字串一律 textContent，零 innerHTML。
 */

import { electronAPI } from './app.js'

const state = {
  inited: false,
  kind: 'app',
  range: 'day',
  date: isoDate(new Date()),
  drillStamp: '',
  loading: false
}

const $ = (id) => document.getElementById(id)

function el(tag, className, text = '') {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}

function isoDate(d) {
  const p = (n) => (n < 10 ? `0${n}` : String(n))
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function parseIso(s) {
  const [y, m, d] = String(s).split('-').map(Number)
  return new Date(y, m - 1, d)
}

function shiftDate(delta) {
  const d = parseIso(state.date)
  if (state.range === 'week') d.setDate(d.getDate() + delta * 7)
  else if (state.range === 'month') d.setMonth(d.getMonth() + delta)
  else if (state.range === 'year') d.setFullYear(d.getFullYear() + delta)
  else d.setDate(d.getDate() + delta)
  state.date = isoDate(d)
}

function dateLabel() {
  const d = parseIso(state.date)
  if (state.range === 'year') return `${d.getFullYear()} 年`
  if (state.range === 'month') return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`
  if (state.range === 'week') {
    const day = d.getDay() || 7
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - (day - 1))
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6)
    return `${isoDate(start)} ～ ${isoDate(end)}`
  }
  return isoDate(d)
}

function markTabs(rootId, attr, value) {
  for (const btn of document.querySelectorAll(`#${rootId} .sysmon-tab`)) {
    const on = btn.dataset[attr] === value
    btn.classList.toggle('active', on)
    btn.setAttribute('aria-selected', on ? 'true' : 'false')
  }
}

async function refresh() {
  if (state.loading) return
  state.loading = true
  const label = $('stimeDateLabel')
  if (label) label.textContent = dateLabel()
  markTabs('stimeKind', 'kind', state.kind)
  markTabs('stimeRange', 'range', state.range)
  try {
    const [st, stats] = await Promise.all([
      electronAPI.screentime.status(),
      electronAPI.screentime.stats({ kind: state.kind, range: state.range, date: state.date })
    ])
    renderNote(st?.ok ? st.data : null)
    const data = stats?.ok ? stats.data : null
    renderCards(data)
    renderChart(data)
    renderList($('stimeList'), data?.list || [])
    renderList($('stimeCats'), data?.categories || [])
    if (state.drillStamp) await refreshDrill()
    else hideDrill()
  } finally {
    state.loading = false
  }
}

function renderNote(status) {
  const note = $('stimeNote')
  if (!note) return
  const lines = []
  if (!status) lines.push('讀取狀態失敗')
  else {
    if (status.webError === 'in-use') {
      lines.push('網站時長暫時沒進來：8908 埠被佔用。')
    }
    if (status.sleeping) lines.push('閒置中，已暫停計時。')
    else if (status.activeLabel) lines.push(`正在記 ${status.activeLabel}`)
  }
  note.textContent = lines.join(' ')
  note.classList.toggle('hidden', lines.length === 0)
}

function renderCards(data) {
  const host = $('stimeCards')
  if (!host) return
  host.replaceChildren()
  const cards = data?.cards || {}
  const isWeb = state.kind === 'web'
  const items = [
    { label: isWeb ? '瀏覽時長' : '總時長', value: cards.totalLabel || '0 秒' },
    { label: isWeb ? '站點數' : '應用數', value: String(cards.count || 0) },
    {
      label: isWeb ? '網頁數' : '最長使用',
      value: isWeb ? String(cards.pages || 0) : (cards.longestName || '—')
    }
  ]
  for (const item of items) {
    const card = el('div', 'stime-metric')
    card.append(el('p', 'stime-metric-label', item.label), el('p', 'stime-metric-value', item.value))
    host.append(card)
  }
}

function renderChart(data) {
  const host = $('stimeChart')
  if (!host) return
  const tip = $('stimeTip') || el('div', 'stime-tip')
  tip.id = 'stimeTip'
  tip.hidden = true
  tip.setAttribute('role', 'tooltip')
  host.replaceChildren()
  const series = (data?.series || []).map((n) => Math.max(0, Number(n) || 0))
  const labels = data?.labels || []
  const max = niceMax(Math.max(1, ...series))
  const plot = el('div', 'stime-plot')
  for (const frac of [1, 0.5, 0]) {
    const tick = el('div', 'stime-tick')
    tick.style.bottom = `${frac * 100}%`
    tick.append(el('span', '', frac === 0 ? '0' : axisLabel(max * frac, max)))
    plot.append(tick)
  }
  const showEvery = labels.length > 14 ? Math.ceil(labels.length / 12) : 1
  series.forEach((value, i) => {
    const btn = el('button', 'stime-col')
    btn.type = 'button'
    const bar = el('i')
    bar.style.height = `${Math.max(2, Math.round(value / max * 100))}%`
    btn.append(bar)
    if (i % showEvery === 0) btn.append(el('span', '', labels[i] || ''))
    const text = `${labels[i] || ''} ${formatHint(value)}`.trim()
    btn.setAttribute('aria-label', text)
    btn.addEventListener('pointerenter', () => showTip(host, tip, btn, text))
    btn.addEventListener('focus', () => showTip(host, tip, btn, text))
    btn.addEventListener('pointerleave', () => hideTip(tip))
    btn.addEventListener('blur', () => hideTip(tip))
    btn.addEventListener('click', () => onBarClick(data, i))
    plot.append(btn)
  })
  host.append(plot, tip)
}

/** 同一條 Y 軸只用一種單位（看上限決定），不然上下兩格會一個「小時」一個「分」。 */
function axisLabel(sec, max) {
  if (max >= 3600) return `${(sec / 3600).toFixed(1)} 小時`
  if (max >= 60) return `${Math.round(sec / 60)} 分`
  return `${Math.round(sec)} 秒`
}

/** Y 軸上限取整成好讀的時間刻度，柱子才不會全部貼頂或矮到看不出來。 */
function niceMax(sec) {
  const steps = [60, 120, 300, 600, 900, 1800, 2700, 3600,
    7200, 10800, 14400, 21600, 28800, 43200, 57600, 86400]
  for (const s of steps) if (sec <= s) return s
  return Math.ceil(sec / 86400) * 86400
}

function showTip(host, tip, col, text) {
  if (!tip) return
  tip.textContent = text
  tip.hidden = false
  const hr = host.getBoundingClientRect()
  const cr = col.getBoundingClientRect()
  tip.style.left = `${cr.left - hr.left + cr.width / 2}px`
  tip.style.bottom = `${hr.bottom - cr.top + 6}px`
}

function hideTip(tip) {
  if (tip) tip.hidden = true
}

function formatHint(sec) {
  const n = Math.max(0, Math.floor(Number(sec) || 0))
  if (n >= 3600) return `${(n / 3600).toFixed(1)} 小時`
  if (n >= 60) return `${Math.round(n / 60)} 分`
  return `${n} 秒`
}

function onBarClick(data, index) {
  if (state.range !== 'day' || !data?.start) {
    state.drillStamp = ''
    hideDrill()
    return
  }
  const hour = String(index).padStart(2, '0')
  state.drillStamp = `${data.start.slice(0, 10)} ${hour}:00:00`
  refreshDrill()
}

async function refreshDrill() {
  const wrap = $('stimeDrillWrap')
  const title = $('stimeDrillTitle')
  if (title) title.textContent = state.drillStamp
  const res = await electronAPI.screentime.drill({ kind: state.kind, stamp: state.drillStamp })
  renderList($('stimeDrill'), res?.ok ? res.data : [])
  wrap?.classList.remove('hidden')
}

function hideDrill() {
  $('stimeDrillWrap')?.classList.add('hidden')
  const drill = $('stimeDrill')
  if (drill) drill.replaceChildren()
}

function renderList(host, rows) {
  if (!host) return
  host.replaceChildren()
  if (!rows.length) {
    host.append(el('p', 'stime-row-name', '這段時間沒有紀錄'))
    return
  }
  for (const row of rows) {
    const item = el('div', 'stime-row')
    const name = row.display || row.name || row.domain || '—'
    item.append(el('span', 'stime-row-name', name))
    item.append(el('span', 'stime-row-time', row.label || ''))
    item.title = `${name} ${row.label || ''}`.trim()
    host.append(item)
  }
}

function bind() {
  $('stimeKind')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-kind]')
    if (!btn) return
    state.kind = btn.dataset.kind
    state.drillStamp = ''
    refresh()
  })
  $('stimeRange')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-range]')
    if (!btn) return
    state.range = btn.dataset.range
    state.drillStamp = ''
    refresh()
  })
  $('stimePrev')?.addEventListener('click', () => { shiftDate(-1); refresh() })
  $('stimeNext')?.addEventListener('click', () => { shiftDate(1); refresh() })
  $('stimeExport')?.addEventListener('click', () => {
    electronAPI.screentime.exportCsv({
      kind: state.kind, range: state.range, date: state.date
    }).then((res) => {
      const note = $('stimeNote')
      if (!note) return
      if (res?.ok && res.data?.saved) {
        note.textContent = `已匯出 ${res.data.fileName}（${res.data.rows} 列）`
        note.classList.remove('hidden')
      }
    })
  })
  $('stimeFolder')?.addEventListener('click', () => {
    electronAPI.screentime.openFolder()
  })
}

export function initScreentimePanel() {
  if (state.inited) return
  state.inited = true
  bind()
}

export function showScreentimePanel() {
  initScreentimePanel()
  refresh()
}

export function hideScreentimePanel() {
  state.drillStamp = ''
}
