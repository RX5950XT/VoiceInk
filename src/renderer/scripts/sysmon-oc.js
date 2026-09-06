/**
 * VoiceInk — 系統監控 ▸ 效能調整。
 *
 * 上面即時儀表（負載／時脈／電壓／功耗／溫度／每核），下面兩欄滑桿。
 * 套用是按鈕（SMU／NVAPI 不該每秒灌一次）。偵測不到可寫路徑時卡片改說明，不留白。
 */

import { electronAPI } from './app.js'

const POLL_MS = 1000
const HISTORY = 60

const state = {
  inited: false,
  timer: 0,
  /** @type {any} */
  data: null,
  /** @type {any} */
  feed: null,
  vfDrag: false,
  /** @type {Set<string>} */
  folds: new Set(),
  foldsTouched: false,
  cpuSig: '',
  gpuSig: ''
}

/** @type {Array<{ fill: HTMLElement, text: HTMLElement }>} */
const cpuGaugeSlots = []
/** @type {Array<{ fill: HTMLElement, text: HTMLElement }>} */
const gpuGaugeSlots = []
/** @type {Array<{ fill: HTMLElement, text: HTMLElement }>} */
const coreSlots = []
const hist = {
  cpuClock: /** @type {number[]} */ ([]),
  cpuTemp: /** @type {number[]} */ ([]),
  cpuPower: /** @type {number[]} */ ([]),
  gpuClock: /** @type {number[]} */ ([]),
  gpuPower: /** @type {number[]} */ ([]),
  gpuTemp: /** @type {number[]} */ ([])
}
let lastHistAt = 0

const $ = (id) => document.getElementById(id)

/**
 * @param {string} tag
 * @param {string} className
 * @param {string} [text]
 */
function el(tag, className, text = '') {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}

/** @param {number|null|undefined} value @param {string} unit */
function fmt(value, unit) {
  if (value == null || !Number.isFinite(Number(value))) return '—'
  return `${Math.round(Number(value))}${unit}`
}

/**
 * @param {HTMLElement} host
 * @param {{ key: string, label: string, min: number, max: number, step?: number, unit: string, value: number, disabled?: boolean }} spec
 */
function sliderRow(host, spec) {
  const row = el('label', 'oc-slider')
  const head = el('span', 'oc-slider-head')
  head.append(el('span', 'oc-slider-label', spec.label))
  const format = (n) => {
    if (spec.key.endsWith('scalarX100')) return `${(Number(n) / 100).toFixed(2)}${spec.unit}`
    if (spec.key.includes('freqCores.') || spec.key.endsWith('freqMhz')) {
      return Number(n) <= 0 ? (spec.key.includes('freqCores.') ? '跟全核' : 'PBO（自動加速）') : `${n}${spec.unit}`
    }
    if (spec.key === 'cpu.socMv') {
      const v = Number(n)
      return v < 900 ? '自動' : `${(v / 1000).toFixed(3)} V`
    }
    if (spec.key.includes('coAll') || spec.key.includes('cores.')) {
      const v = Number(n)
      return v > 0 ? `+${v}` : `${v}`
    }
    if (spec.key === 'cpu.voltMv') {
      const v = Number(n)
      return v < 800 ? '自動（PBO）' : `${(v / 1000).toFixed(3)} V`
    }
    if (spec.key.endsWith('voltMv')) return `${n} mV`
    return `${n}${spec.unit}`
  }
  const out = el('span', 'oc-slider-out', format(spec.value))
  head.append(out)
  const input = /** @type {HTMLInputElement} */ (el('input', 'oc-range'))
  input.type = 'range'
  input.min = String(spec.min)
  input.max = String(spec.max)
  input.step = String(spec.step || 1)
  input.value = String(spec.value)
  input.dataset.key = spec.key
  input.disabled = spec.disabled === true
  input.setAttribute('aria-label', spec.label)
  input.addEventListener('input', () => {
    out.textContent = format(input.value)
  })
  input.addEventListener('change', () => {
    const n = Number(input.value)
    let patch
    if (spec.key.startsWith('cpu.cores.')) {
      const index = Number(spec.key.slice(10))
      const cores = [...(state.data?.draft?.cpu?.cores || [])]
      cores[index] = n
      patch = { cpu: { cores } }
    } else if (spec.key.startsWith('cpu.freqCores.')) {
      const index = Number(spec.key.slice(14))
      const freqCores = [...(state.data?.draft?.cpu?.freqCores || [])]
      freqCores[index] = n
      patch = { cpu: { freqCores } }
    } else if (spec.key.startsWith('cpu.')) {
      patch = { cpu: { [spec.key.slice(4)]: n } }
    } else {
      patch = { gpu: { [spec.key.slice(4)]: n } }
    }
    electronAPI.sysmon.ocSetDraft(patch).then((res) => { if (res?.ok) render(res.data) })
  })
  row.append(head, input)
  host.append(row)
}

/**
 * 可展開分類。第一次預設打開 PBO／GPU 時脈；之後只跟使用者點過的走。
 * @param {HTMLElement} host
 * @param {string} id
 * @param {string} title
 */
function foldBox(host, id, title) {
  const box = el('details', 'oc-fold')
  box.dataset.fold = id
  const first = !state.foldsTouched && (id === 'pbo' || id === 'gpu-clock')
  box.open = first || state.folds.has(id)
  if (box.open) state.folds.add(id)
  box.addEventListener('toggle', () => {
    state.foldsTouched = true
    if (box.open) state.folds.add(id)
    else state.folds.delete(id)
  })
  box.append(el('summary', 'oc-fold-sum', title), el('div', 'oc-fold-body'))
  host.append(box)
  return /** @type {HTMLElement} */ (box.lastElementChild)
}

/** @param {any} data */
function renderNotices(data) {
  const host = $('ocNotices')
  if (!host) return
  host.replaceChildren()
  const notes = []
  if (!data.available) {
    notes.push({ kind: 'warn', text: '請先啟用完整感測器。' })
  }
  if (data.dirtyLastRun && !data.applied) {
    notes.push({ kind: 'info', text: '上次可能沒還原；重開機或按「還原出廠」。' })
  }
  if (data.panic || data.lastError) {
    notes.push({ kind: 'warn', text: data.lastError || '過熱，已還原出廠。' })
  }
  for (const note of notes) {
    host.append(el('p', `oc-note oc-note-${note.kind}`, note.text))
  }
}

/** @param {any} data */
function renderCpu(data) {
  const live = data.live?.cpu || {}
  const draft = data.draft?.cpu || {}
  const hint = $('ocCpuHint')
  const liveEl = $('ocCpuLive')
  const sliders = $('ocCpuSliders')
  if (hint) hint.textContent = live.name || ''
  if (liveEl) {
    liveEl.textContent = data.available
      ? `目前 ${fmt(live.clock, ' MHz')} · ${fmt(live.temp, ' °C')} · ${fmt(live.powerW, ' W')} / 牆 ${fmt(live.pptW, ' W')}`
      : '感測器尚未連線'
  }
  if (!sliders) return
  const sig = `${data.available}|${live.writable}|${live.coreCount}|${JSON.stringify(data.draft?.cpu || {})}`
  if (state.cpuSig === sig) return
  if (document.activeElement && sliders.contains(document.activeElement)) return
  state.cpuSig = sig
  sliders.replaceChildren()
  if (!data.available) return
  if (!live.writable) {
    sliders.append(el('p', 'oc-empty', live.reason || '這顆處理器還沒接（目前寫 Matisse／Vermeer：PBO、Curve Optimizer、全核鎖頻）。'))
    return
  }
  const lim = data.limits || {}
  const factoryPpt = live.factoryPpt || live.pptW || 88
  const factoryTdc = live.factoryTdc || live.tdcA || 60
  const factoryEdc = live.factoryEdc || live.edcA || 90
  const pbo = foldBox(sliders, 'pbo', '功耗與電流牆（PBO）')
  sliderRow(pbo, {
    key: 'cpu.pptW', label: 'PPT 功耗牆', unit: ' W',
    min: Math.max(15, Math.round(factoryPpt * 0.5)),
    max: Math.min(400, Math.round(factoryPpt * 1.5)),
    value: draft.pptW || factoryPpt
  })
  sliderRow(pbo, {
    key: 'cpu.tdcA', label: 'TDC 電流牆', unit: ' A',
    min: Math.max(10, Math.round(factoryTdc * 0.5)),
    max: Math.min(500, Math.round(factoryTdc * 1.5)),
    value: draft.tdcA || factoryTdc
  })
  sliderRow(pbo, {
    key: 'cpu.edcA', label: 'EDC 峰值電流', unit: ' A',
    min: Math.max(10, Math.round(factoryEdc * 0.5)),
    max: Math.min(500, Math.round(factoryEdc * 1.5)),
    value: draft.edcA || factoryEdc
  })
  sliderRow(pbo, {
    key: 'cpu.scalarX100', label: 'PBO scalar', unit: '×',
    min: lim.scalarMin ?? 100, max: lim.scalarMax ?? 200, step: 25,
    value: draft.scalarX100 || 100
  })
  sliderRow(pbo, {
    key: 'cpu.tctlC', label: 'Tctl 溫度牆', unit: ' °C',
    min: lim.tctlMin ?? 70, max: lim.tctlMax ?? 95,
    value: draft.tctlC || 90
  })
  const co = foldBox(sliders, 'co', 'Curve Optimizer（負值＝降壓）')
  sliderRow(co, {
    key: 'cpu.coAll', label: '全核', unit: '',
    min: lim.coMin ?? -30, max: lim.coMax ?? 30,
    value: draft.coAll || 0
  })
  const count = Math.max(1, Number(live.coreCount) || (draft.cores || []).length || 8)
  const cores = draft.cores || []
  const coreBox = el('div', 'oc-cores')
  for (let i = 0; i < count; i += 1) {
    sliderRow(coreBox, {
      key: `cpu.cores.${i}`, label: `核 ${i}`, unit: '',
      min: lim.coMin ?? -30, max: lim.coMax ?? 30,
      value: cores[i] || 0
    })
  }
  co.append(coreBox)
  const manual = foldBox(sliders, 'manual', '手動時脈與電壓')
  sliderRow(manual, {
    key: 'cpu.freqMhz', label: '全核鎖定（0＝走 PBO）', unit: ' MHz',
    min: 0, max: lim.freqMax ?? 5000, step: 25,
    value: draft.freqMhz || 0
  })
  const freqOn = draft.freqMhz > 0 || (draft.freqCores || []).some((v) => v > 0)
  sliderRow(manual, {
    key: 'cpu.voltMv', label: 'CPU 電壓（手動超頻才鎖得住）', unit: ' V',
    min: 775, max: lim.cpuVoltMax ?? 1400, step: 25,
    value: draft.voltMv || 775,
    disabled: !freqOn
  })
  sliderRow(manual, {
    key: 'cpu.socMv', label: 'SoC 電壓', unit: ' V',
    min: 875, max: lim.socMax ?? 1200, step: 25,
    value: draft.socMv || 875
  })
  const freqBox = el('div', 'oc-cores')
  const freqCores = draft.freqCores || []
  for (let i = 0; i < count; i += 1) {
    sliderRow(freqBox, {
      key: `cpu.freqCores.${i}`, label: `核 ${i} 時脈`, unit: ' MHz',
      min: 0, max: lim.freqMax ?? 5000, step: 25,
      value: freqCores[i] || 0
    })
  }
  manual.append(el('p', 'oc-empty', '每核時脈 0＝跟全核／PBO'), freqBox)
}

/** @param {any} data */
function renderGpu(data) {
  const live = data.live?.gpu || {}
  const draft = data.draft?.gpu || {}
  const limits = data.limits || {}
  const hint = $('ocGpuHint')
  const liveEl = $('ocGpuLive')
  const sliders = $('ocGpuSliders')
  if (hint) hint.textContent = live.name || ''
  if (liveEl) {
    const card = data.feed?.gpu || {}
    const clock = live.clock ?? card.clockSm
    const temp = live.temp ?? card.temperature
    const power = live.powerW ?? card.power
    liveEl.textContent = data.available
      ? `目前 ${fmt(clock, ' MHz')} · ${fmt(temp, ' °C')} · ${fmt(power, ' W')} · 牆 ${fmt(live.powerPct, '%')}`
      : '感測器尚未連線'
  }
  if (!sliders) return
  const sig = `${data.available}|${live.writable}|${JSON.stringify(data.draft?.gpu || {})}`
  if (state.gpuSig === sig) {
    const fold = $('ocVfFold')
    if (fold) fold.hidden = !(data.available && live.writable)
    return
  }
  if (document.activeElement && sliders.contains(document.activeElement)) return
  state.gpuSig = sig
  sliders.replaceChildren()
  const vfFold = $('ocVfFold')
  if (vfFold) vfFold.hidden = !(data.available && live.writable)
  if (!data.available) return
  if (!live.writable) {
    sliders.append(el('p', 'oc-empty', live.reason || '這張顯示卡還沒接（NVIDIA：時脈、功耗、VID 電壓、溫度牆、V/F 曲線）。'))
    return
  }
  const clocks = foldBox(sliders, 'gpu-clock', '時脈與功耗')
  sliderRow(clocks, {
    key: 'gpu.coreMHz', label: '核心時脈偏移', unit: ' MHz',
    min: limits.coreMin ?? -200, max: limits.coreMax ?? 200,
    value: draft.coreMHz || 0
  })
  sliderRow(clocks, {
    key: 'gpu.memMHz', label: '記憶體時脈偏移', unit: ' MHz',
    min: limits.memMin ?? -500, max: limits.memMax ?? 1000,
    value: draft.memMHz || 0
  })
  sliderRow(clocks, {
    key: 'gpu.powerPct', label: '功耗上限', unit: '%',
    min: limits.powerMin ?? 50, max: limits.powerMax ?? 120,
    value: draft.powerPct || 100
  })
  const volt = foldBox(sliders, 'gpu-volt', '電壓與溫度')
  sliderRow(volt, {
    key: 'gpu.voltMv', label: '核心電壓偏移', unit: ' mV',
    min: limits.voltMin ?? -100, max: limits.voltMax ?? 100,
    value: draft.voltMv || 0
  })
  sliderRow(volt, {
    key: 'gpu.tempC', label: 'GPU 溫度牆', unit: ' °C',
    min: limits.gpuTempMin ?? 65, max: limits.gpuTempMax ?? 95,
    value: draft.tempC || 90
  })
}

const VF_W = 320
const VF_H = 140
const VF_PAD = 18

/** @param {any} data */
function vfPoints(data) {
  const live = data.live?.gpu?.vf || []
  const deltas = data.draft?.gpu?.vfDeltas || []
  const base = Number(data.draft?.gpu?.coreMHz) || 0
  return live.map((p, i) => {
    const extra = deltas[i] || 0
    const freq = Number(p.f) || 0
    const volt = Number(p.v) || 0
    return {
      index: i,
      v: volt,
      f: freq,
      extra,
      y: freq + base + extra
    }
  }).filter((p) => p.v > 0 && p.f > 0)
}

/**
 * @param {HTMLElement} svg
 * @param {Array<{ i: number, v: number|null, extra: number, y: number }>} points
 */
function paintVf(svg, points) {
  const xs = points.map((p) => p.v)
  const ys = points.map((p) => p.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys) - 80
  const maxY = Math.max(...ys) + 80
  const spanX = Math.max(1, maxX - minX)
  const spanY = Math.max(1, maxY - minY)
  svg.dataset.minY = String(minY)
  svg.dataset.maxY = String(maxY)
  const toX = (x) => VF_PAD + 8 + ((x - minX) / spanX) * (VF_W - VF_PAD * 2 - 8)
  const toY = (mhz) => VF_H - VF_PAD - ((mhz - minY) / spanY) * (VF_H - VF_PAD * 2)
  const screen = points.map((p) => [toX(p.v), toY(p.y)])
  svg.querySelector('.oc-vf-line')?.setAttribute('points', screen.map((p) => p.join(',')).join(' '))
  const xLabel = svg.querySelector('.oc-vf-x')
  const yLabel = svg.querySelector('.oc-vf-y')
  if (xLabel) xLabel.textContent = `${Math.round(minX)}–${Math.round(maxX)} mV`
  if (yLabel) yLabel.textContent = `${Math.round(minY)}–${Math.round(maxY)} MHz`
  const step = points.length > 36 ? 3 : 1
  const want = points.map((_, i) => i === 0 || i === points.length - 1 || i % step === 0)
  const old = [...svg.querySelectorAll('.oc-vf-point')]
  if (old.length !== want.filter(Boolean).length) {
    old.forEach((n) => n.remove())
    points.forEach((p, i) => {
      if (!want[i]) return
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
      c.setAttribute('class', 'oc-vf-point')
      c.setAttribute('r', '3')
      c.setAttribute('data-index', String(p.index))
      c.setAttribute('cx', String(screen[i][0]))
      c.setAttribute('cy', String(screen[i][1]))
      svg.appendChild(c)
    })
    return
  }
  let k = 0
  points.forEach((p, i) => {
    if (!want[i]) return
    const node = old[k]
    k += 1
    if (!node) return
    node.setAttribute('data-index', String(p.index))
    node.setAttribute('cx', String(screen[i][0]))
    node.setAttribute('cy', String(screen[i][1]))
  })
}

/** @param {any} data */
function renderVf(data) {
  const host = $('ocVfHost')
  if (!host || state.vfDrag) return
  const points = vfPoints(data)
  if (!points.length) {
    if (host.dataset.empty !== '1') {
      host.replaceChildren()
      host.append(el('p', 'oc-empty', '這張卡沒給電壓／時脈對照點，曲線畫不出來。請用「時脈與功耗」裡的核心滑桿。'))
      host.dataset.empty = '1'
    }
    return
  }
  if (host.dataset.empty || !host.querySelector('svg')) {
    host.replaceChildren()
    delete host.dataset.empty
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', `0 0 ${VF_W} ${VF_H}`)
    svg.setAttribute('class', 'oc-vf')
    svg.setAttribute('role', 'img')
    svg.setAttribute('aria-label', '電壓對時脈曲線')
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline')
    line.setAttribute('class', 'oc-vf-line')
    const yText = document.createElementNS('http://www.w3.org/2000/svg', 'text')
    yText.setAttribute('class', 'oc-vf-axis oc-vf-y')
    yText.setAttribute('x', '8')
    yText.setAttribute('y', '12')
    const xText = document.createElementNS('http://www.w3.org/2000/svg', 'text')
    xText.setAttribute('class', 'oc-vf-axis oc-vf-x')
    xText.setAttribute('x', String(VF_W - 8))
    xText.setAttribute('y', String(VF_H - 4))
    xText.setAttribute('text-anchor', 'end')
    svg.append(line, yText, xText)
    const read = el('p', 'oc-vf-read', '橫：電壓　直：時脈。往上拖＝那一檔加快。')
    read.id = 'ocVfRead'
    host.append(svg, read)
    svg.addEventListener('pointerdown', onVfDown)
  }
  const svg = host.querySelector('svg')
  if (svg) paintVf(svg, points)
}

/** @param {PointerEvent} event */
function onVfDown(event) {
  const target = /** @type {Element} */ (event.target)
  const dot = target.closest?.('.oc-vf-point')
  if (!dot) return
  const index = Number(dot.getAttribute('data-index'))
  const svg = /** @type {SVGElement} */ (dot.ownerSVGElement)
  state.vfDrag = true
  svg.classList.add('is-dragging')
  const move = (ev) => {
    const rect = svg.getBoundingClientRect()
    const y = ((ev.clientY - rect.top) / rect.height) * VF_H
    const t = 1 - (y - VF_PAD) / (VF_H - VF_PAD * 2)
    const minY = Number(svg.dataset.minY) || 0
    const maxY = Number(svg.dataset.maxY) || 3000
    const mhz = Math.round(minY + Math.max(0, Math.min(1, t)) * (maxY - minY))
    const live = state.data?.live?.gpu?.vf || []
    const point = live[index] || {}
    const base = Number(state.data?.draft?.gpu?.coreMHz) || 0
    const extra = mhz - (Number(point.f) || 0) - base
    const vfDeltas = [...(state.data?.draft?.gpu?.vfDeltas || [])]
    while (vfDeltas.length < live.length) vfDeltas.push(0)
    vfDeltas[index] = extra
    const read = $('ocVfRead')
    if (read) read.textContent = `${Math.round(point.v || 0)} mV → ${mhz} MHz（${extra > 0 ? '+' : ''}${extra}）`
    const next = { ...state.data, draft: { ...state.data.draft, gpu: { ...state.data.draft.gpu, vfDeltas } } }
    state.data = next
    paintVf(svg, vfPoints(next))
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    svg.classList.remove('is-dragging')
    state.vfDrag = false
    const vfDeltas = state.data?.draft?.gpu?.vfDeltas || []
    electronAPI.sysmon.ocSetDraft({ gpu: { vfDeltas } }).then((res) => { if (res?.ok) render(res.data) })
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  event.preventDefault()
}

/**
 * @param {any} data
 */
function render(data) {
  if (data?.feed) state.feed = data.feed
  state.data = data
  const status = $('ocStatus')
  if (status) {
    status.textContent = data.applied
      ? '已套用（這次開機有效）'
      : (data.available ? '尚未套用' : '感測器未連線')
  }
  const apply = /** @type {HTMLButtonElement|null} */ ($('ocApplyBtn'))
  if (apply) apply.disabled = !data.available
  renderNotices(data)
  renderDash(data)
  renderCpu(data)
  renderGpu(data)
  renderVf(data)
}

/** @param {...unknown} values */
function pick(...values) {
  for (const value of values) {
    if (value == null) continue
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return null
}

/** @param {string} text */
function dashText(value, unit, digits = 0) {
  if (value == null || !Number.isFinite(Number(value))) return '—'
  const n = Number(value)
  return `${digits ? n.toFixed(digits) : Math.round(n)}${unit}`
}

/**
 * 結構固定時只改文字與長條，不重建 DOM（跟壓力測試儀表同一套）。
 * @param {HTMLElement|null} host
 * @param {Array<{ label: string, value: number, max: number, text: string }>} items
 * @param {Array<{ fill: HTMLElement, text: HTMLElement }>} slots
 */
function renderGaugeRow(host, items, slots) {
  if (!host) return
  if (!slots.length || slots.length !== items.length) {
    host.replaceChildren()
    slots.length = 0
    for (const item of items) {
      const cell = el('span', 'sysmon-metercell')
      const label = el('i', '', item.label)
      label.title = item.label
      const track = el('span', 'sysmon-track')
      const fill = el('b', '')
      track.appendChild(fill)
      const text = el('em', '', item.text)
      cell.append(label, track, text)
      host.appendChild(cell)
      slots.push({ fill, text })
    }
    return
  }
  items.forEach((item, i) => {
    const slot = slots[i]
    if (!slot) return
    const ratio = item.max > 0 ? Math.max(0, Math.min(1, item.value / item.max)) : 0
    slot.fill.style.width = `${ratio * 100}%`
    slot.fill.classList.toggle('is-hot', ratio >= 0.85)
    slot.text.textContent = item.text
  })
}

/**
 * @param {HTMLElement|null} host
 * @param {number[]} clocks
 */
function renderCores(host, clocks) {
  if (!host) return
  if (!clocks.length) {
    if (coreSlots.length) {
      host.replaceChildren()
      coreSlots.length = 0
    }
    return
  }
  if (coreSlots.length !== clocks.length) {
    host.replaceChildren()
    coreSlots.length = 0
    clocks.forEach((mhz, i) => {
      const cell = el('span', 'sysmon-corecell')
      const label = el('i', '', `${i}`)
      const track = el('span', 'sysmon-track')
      const fill = el('b', '')
      track.appendChild(fill)
      const text = el('em', '', dashText(mhz, ' MHz'))
      cell.append(label, track, text)
      host.appendChild(cell)
      coreSlots.push({ fill, text })
    })
    return
  }
  clocks.forEach((mhz, i) => {
    const slot = coreSlots[i]
    if (!slot) return
    const ratio = Math.max(0, Math.min(1, (mhz || 0) / 5000))
    slot.fill.style.width = `${ratio * 100}%`
    slot.fill.classList.toggle('is-hot', ratio >= 0.9)
    slot.text.textContent = dashText(mhz, ' MHz')
  })
}

/**
 * @param {number[]} series
 * @param {number|null} value
 */
function pushHist(series, value) {
  if (value == null || !Number.isFinite(value)) {
    // 還沒有真值就不要拿 0 佔位：曲線是自動縮放的，一顆 0 會把整條線壓在頂上一整分鐘
    if (!series.length) return
    series.push(series[series.length - 1])
  } else series.push(value)
  if (series.length > HISTORY) series.shift()
}

/**
 * 兩條線各自縮放，所以 Y 軸也各標各的：左邊是第一條、右邊是第二條，
 * 只標上下限＋單位（沒有單位的曲線等於在猜數量級）。
 * @param {HTMLCanvasElement|null} canvas
 * @param {Array<{ values: number[], color: string, unit: string }>} lines
 */
function drawSpark(canvas, lines) {
  if (!canvas) return
  const dpr = window.devicePixelRatio || 1
  const cssW = Math.max(1, canvas.clientWidth || 640)
  const cssH = Math.max(1, canvas.clientHeight || 56)
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr)
    canvas.height = Math.round(cssH * dpr)
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssW, cssH)
  ctx.font = '10px system-ui, sans-serif'
  const gutter = Math.min(58, Math.max(34, cssW * 0.09))
  const plotW = Math.max(1, cssW - gutter * 2)
  lines.forEach((line, idx) => {
    const nums = line.values.filter((n) => Number.isFinite(n))
    if (nums.length < 2) return
    const min = Math.min(...nums)
    const max = Math.max(...nums)
    const span = max - min
    // 這一分鐘都同一個值時，線走中間、只標一次；貼底再標兩個一樣的數字看起來像壞掉
    const flat = span < 1e-9
    ctx.beginPath()
    ctx.strokeStyle = line.color
    ctx.lineWidth = 1.4
    line.values.forEach((v, i) => {
      const x = gutter + (i / Math.max(1, HISTORY - 1)) * plotW
      const y = flat ? cssH / 2 : cssH - 3 - ((v - min) / span) * (cssH - 6)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.stroke()
    ctx.fillStyle = line.color
    ctx.textAlign = idx === 0 ? 'right' : 'left'
    const tx = idx === 0 ? gutter - 6 : cssW - gutter + 6
    if (flat) {
      ctx.textBaseline = 'middle'
      ctx.fillText(axisText(max, line.unit), tx, cssH / 2)
      return
    }
    ctx.textBaseline = 'top'
    ctx.fillText(axisText(max, line.unit), tx, 1)
    ctx.textBaseline = 'bottom'
    ctx.fillText(axisText(min, line.unit), tx, cssH - 1)
  })
}

/**
 * @param {number} v
 * @param {string} unit
 */
function axisText(v, unit) {
  const n = Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10
  return `${n}${unit}`
}

/** @param {any} data */
function renderDash(data) {
  const live = data.live || {}
  const cpu = live.cpu || {}
  const gpu = live.gpu || {}
  const feed = data.feed || state.feed || {}
  const card = feed.gpu || {}
  const cpuLoad = pick(cpu.load, feed.cpuTotal)
  const cpuClock = pick(cpu.clock)
  const cpuTemp = pick(cpu.temp)
  const cpuPower = pick(cpu.powerW)
  const cpuVolt = pick(cpu.volt)
  const pptWall = pick(cpu.pptW, data.draft?.cpu?.pptW)
  const gpuLoad = pick(gpu.load, card.utilization)
  const gpuClock = pick(gpu.clock, card.clockSm)
  const gpuMem = pick(gpu.mem, card.clockMem)
  const gpuTemp = pick(gpu.temp, card.temperature)
  const gpuPower = pick(gpu.powerW, card.power)
  const gpuVolt = pick(gpu.volt)

  renderGaugeRow($('ocCpuGauges'), [
    { label: '負載', value: cpuLoad || 0, max: 100, text: dashText(cpuLoad, '%') },
    { label: '時脈', value: cpuClock || 0, max: 5000, text: dashText(cpuClock, ' MHz') },
    { label: '電壓', value: cpuVolt || 0, max: 1.5, text: cpuVolt != null ? `${cpuVolt.toFixed(3)} V` : '—' },
    { label: '功耗', value: cpuPower || 0, max: Math.max(pptWall || 0, cpuPower || 1, 1), text: cpuPower != null && pptWall != null ? `${Math.round(cpuPower)} / ${Math.round(pptWall)} W` : dashText(cpuPower, ' W') },
    { label: '溫度', value: cpuTemp || 0, max: 100, text: dashText(cpuTemp, ' °C') }
  ], cpuGaugeSlots)

  renderGaugeRow($('ocGpuGauges'), [
    { label: '負載', value: gpuLoad || 0, max: 100, text: dashText(gpuLoad, '%') },
    { label: '核心', value: gpuClock || 0, max: 3200, text: dashText(gpuClock, ' MHz') },
    { label: '記憶體', value: gpuMem || 0, max: 30000, text: dashText(gpuMem, ' MHz') },
    { label: '功耗', value: gpuPower || 0, max: 400, text: dashText(gpuPower, ' W') },
    { label: '溫度', value: gpuTemp || 0, max: 100, text: dashText(gpuTemp, ' °C') },
    { label: '電壓', value: gpuVolt || 0, max: 1.2, text: gpuVolt != null ? `${gpuVolt.toFixed(3)} V` : '—' }
  ], gpuGaugeSlots)

  renderCores($('ocCpuCores'), Array.isArray(cpu.cores) ? cpu.cores : [])

  const now = Date.now()
  if (now - lastHistAt >= 400) {
    lastHistAt = now
    pushHist(hist.cpuClock, cpuClock)
    pushHist(hist.cpuTemp, cpuTemp)
    pushHist(hist.cpuPower, cpuPower)
    pushHist(hist.gpuClock, gpuClock)
    pushHist(hist.gpuPower, gpuPower)
    pushHist(hist.gpuTemp, gpuTemp)
  }
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent-primary').trim() || '#6ea8ff'
  const warn = getComputedStyle(document.documentElement).getPropertyValue('--warning').trim() || '#e8b84a'
  drawSpark(/** @type {HTMLCanvasElement|null} */ ($('ocCpuSpark')), [
    { values: hist.cpuClock, color: accent, unit: ' MHz' },
    { values: hist.cpuTemp, color: warn, unit: ' °C' }
  ])
  drawSpark(/** @type {HTMLCanvasElement|null} */ ($('ocGpuSpark')), [
    { values: hist.gpuClock, color: accent, unit: ' MHz' },
    { values: hist.gpuPower, color: warn, unit: ' W' }
  ])
}

/** 系統監控取樣進來時立刻更新儀表，不必等 ocStatus 下一輪。 */
export function onOcSample(sample) {
  state.feed = {
    cpuTotal: sample?.cpu?.total ?? null,
    gpu: (sample?.gpu?.cards || [])[0] || null
  }
  if (!state.data) return
  state.data = { ...state.data, feed: state.feed }
  renderDash(state.data)
}

/** 每秒拉一次狀態；套用與否由 main 決定，這裡不寫硬體。 */
function poll() {
  electronAPI.sysmon.ocStatus().then((res) => {
    if (res?.ok) render(res.data)
  })
}

/** 綁套用／還原一次。 */
function initOcPanel() {
  if (state.inited) return
  state.inited = true
  $('ocApplyBtn')?.addEventListener('click', () => {
    electronAPI.sysmon.ocApply().then((res) => {
      if (res?.ok) render(res.data)
      else renderNotices({ ...state.data, lastError: res?.error?.message || '套用失敗' })
    })
  })
  $('ocResetBtn')?.addEventListener('click', () => {
    electronAPI.sysmon.ocReset().then((res) => { if (res?.ok) render(res.data) })
  })
}

export function showOcPanel() {
  initOcPanel()
  poll()
  if (!state.timer) state.timer = window.setInterval(poll, POLL_MS)
}

export function hideOcPanel() {
  if (!state.timer) return
  window.clearInterval(state.timer)
  state.timer = 0
}
