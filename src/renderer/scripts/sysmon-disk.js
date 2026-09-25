/**
 * 系統監控 ▸ 磁碟空間。掃描跑在 main，離開子分頁只停畫面、不取消。
 * 檔名與路徑一律 textContent。
 */

import { electronAPI } from './app.js'
import { askConfirm, showAlert } from './app-dialog.js'
import {
  baseName, categorize, chainTo, findChain, formatBytes, fullPath, isReclaimable,
  labelInk, largestFiles, layoutTree, nameMatches, removePath
} from './disk-treemap.js'

const state = {
  inited: false,
  visible: false,
  drives: null,
  rootPath: '',
  scanning: false,
  scanGen: 0,
  progress: { bytes: 0, files: 0, dirs: 0 },
  error: '',
  result: null,
  stack: [],
  selected: null,
  mode: 'size',
  filter: '',
  marked: new Map(),
  cells: [],
  hover: null,
  observer: null,
  raf: 0,
  trashing: false
}

const hatchCache = new Map()
const $ = (id) => document.getElementById(id)

function el(tag, className, text = '') {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}

function fmtInt(n) {
  return Math.max(0, Math.round(Number(n) || 0)).toLocaleString('zh-TW')
}

function valueOf(node) {
  if (!node) return 0
  return state.mode === 'count' ? (Number(node.f) || 0) : (Number(node.s) || 0)
}

function current() {
  return state.stack[state.stack.length - 1] || null
}

function pctText(part, whole) {
  if (!(whole > 0)) return '0%'
  const p = (part / whole) * 100
  if (p >= 10) return `${Math.round(p)}%`
  if (p >= 1) return `${p.toFixed(1)}%`
  return `${p.toFixed(2)}%`
}

function summaryText() {
  if (state.scanning) {
    const p = state.progress || {}
    return `已掃 ${formatBytes(p.bytes)} · ${fmtInt(p.files)} 個檔案 · ${fmtInt(p.dirs)} 個資料夾`
  }
  const tree = state.result?.tree
  if (!tree) return ''
  const sec = state.result.ms ? ` · ${(state.result.ms / 1000).toFixed(1)} 秒` : ''
  return `${formatBytes(tree.s || 0)} · ${fmtInt(tree.f)} 個檔案${sec}`
}

function noteText() {
  if (state.error) return state.error
  const result = state.result
  if (!result?.incomplete) return ''
  if (result.reason === 'time') return '時間到，先顯示掃到的部分。'
  if (result.reason === 'read') return '有些資料夾讀不到。'
  return '這份結果不完整。'
}

function emptyText() {
  if (state.scanning && !state.result) return '掃描中'
  if (state.result) return '沒有內容'
  return '還沒掃描'
}

function paintProgress() {
  const progress = $('diskProgress')
  if (progress) progress.textContent = summaryText()
  const note = $('diskNote')
  if (note) {
    const text = noteText()
    note.textContent = text
    note.classList.toggle('hidden', !text)
  }
  const cancel = $('diskCancel')
  if (cancel) cancel.hidden = !state.scanning
}

function paintDrives() {
  const host = $('diskDrives')
  if (!host) return
  host.replaceChildren()
  const list = state.drives || []
  if (!list.length) {
    host.append(el('p', 'disk-empty-inline', state.drives ? '沒有磁碟' : '讀取中'))
    return
  }
  const root = state.rootPath.toLowerCase()
  for (const disk of list) {
    host.append(driveButton(disk, root))
  }
}

function driveButton(disk, root) {
  const btn = el('button', 'disk-drive')
  btn.type = 'button'
  const path = disk.path || `${disk.letter}:\\`
  const on = root && (root === path.toLowerCase() || root.startsWith(path.toLowerCase()))
  btn.classList.toggle('is-on', Boolean(on))
  const used = Math.max(0, (disk.total || 0) - (disk.free || 0))
  const tight = disk.total > 0 && used / disk.total >= 0.9
  btn.classList.toggle('is-tight', tight)
  const title = disk.label ? `${disk.letter}: ${disk.label}` : `${disk.letter || path}`
  const track = el('span', 'disk-drive-track')
  const bar = el('span', 'disk-drive-bar')
  bar.style.width = disk.total > 0 ? `${Math.round(used / disk.total * 100)}%` : '0%'
  track.append(bar)
  btn.append(
    el('span', 'disk-drive-name', title),
    el('span', 'disk-drive-meta', disk.total ? `${formatBytes(disk.free)} 可用` : '讀不到容量'),
    track
  )
  btn.addEventListener('click', () => { void scan(path) })
  return btn
}

function paintCrumbs() {
  const host = $('diskCrumbs')
  if (!host) return
  host.replaceChildren()
  state.stack.forEach((node, index) => {
    if (index) host.append(el('span', 'disk-crumb-sep', '›'))
    const btn = el('button', 'disk-crumb', node.n || '')
    btn.type = 'button'
    const last = index === state.stack.length - 1
    btn.disabled = last
    if (last) btn.setAttribute('aria-current', 'page')
    btn.addEventListener('click', () => {
      if (last) return
      choose(state.stack[index], state.stack.slice(0, index + 1))
    })
    host.append(btn)
  })
}

function paintSelected() {
  const empty = $('diskSelEmpty')
  const body = $('diskSelBody')
  const node = state.selected
  if (!empty || !body) return
  if (!node) {
    empty.classList.remove('hidden')
    body.classList.add('hidden')
    return
  }
  empty.classList.add('hidden')
  body.classList.remove('hidden')
  const chain = chainOf(node)
  const path = fullPath(chain)
  const name = $('diskSelName')
  const meta = $('diskSelMeta')
  const pathEl = $('diskSelPath')
  if (name) name.textContent = baseName(node.n)
  if (meta) meta.textContent = `${formatBytes(node.s)} · ${fmtInt(node.f)} 個檔案`
  if (pathEl) pathEl.textContent = path || '沒有路徑'
  paintSelectedExtra(node, path)
}

function paintSelectedExtra(node, path) {
  const extra = $('diskSelExtra')
  const reveal = $('diskReveal')
  const mark = $('diskMark')
  const rescan = $('diskRescan')
  const real = Boolean(path) && node.k !== 'o'
  if (reveal) reveal.hidden = !real
  if (mark) {
    mark.hidden = !real
    mark.textContent = state.marked.has(path) ? '取消標記' : '標記刪除'
  }
  if (rescan) rescan.hidden = !(real && node.k === 'd' && node.t === 1)
  if (!extra) return
  const bits = []
  if (node.k === 'o') bits.push('小項目併在一起')
  if (node.t === 1 && node.k === 'd') bits.push('子項目被省略')
  if (node.k === 'd' && isReclaimable(node.n)) bits.push('可回收的快取')
  extra.textContent = bits.join(' · ')
  extra.classList.toggle('hidden', bits.length === 0)
}

function chainOf(node) {
  return chainTo(state.result?.tree, node) || []
}

function paintLargest() {
  const host = $('diskLargest')
  if (!host) return
  host.replaceChildren()
  const view = current()
  if (!view) {
    host.append(el('p', 'disk-empty-inline', '還沒掃描'))
    return
  }
  const rows = largestFiles(view, 15)
  if (!rows.length) {
    host.append(el('p', 'disk-empty-inline', '沒有檔案'))
    return
  }
  for (const entry of rows) host.append(fileRow(entry))
}

function fileRow(entry) {
  const btn = el('button', 'disk-row')
  btn.type = 'button'
  btn.classList.toggle('is-on', entry.node === state.selected)
  btn.title = fullPath(entry.chain)
  const parent = entry.chain[entry.chain.length - 2]
  const where = parent ? baseName(parent.n) : ''
  const meta = `${formatBytes(entry.node.s)}${where ? ` · ${where}` : ''}`
  btn.append(el('span', 'disk-row-name', baseName(entry.node.n)), el('span', 'disk-row-meta', meta))
  btn.addEventListener('click', () => focusFile(entry))
  return btn
}

function paintMarked() {
  const host = $('diskMarked')
  const sum = $('diskMarkedSum')
  const trash = $('diskTrash')
  if (!host) return
  host.replaceChildren()
  const items = [...state.marked.values()]
  const total = items.reduce((s, item) => s + (Number(item.bytes) || 0), 0)
  if (sum) sum.textContent = items.length ? formatBytes(total) : ''
  if (trash) trash.hidden = items.length === 0
  if (!items.length) {
    host.append(el('p', 'disk-empty-inline', '尚未標記'))
    return
  }
  for (const item of items) host.append(markedRow(item))
}

function markedRow(item) {
  const btn = el('button', 'disk-row')
  btn.type = 'button'
  btn.title = item.path
  btn.append(
    el('span', 'disk-row-name', item.name || baseName(item.path)),
    el('span', 'disk-row-meta', formatBytes(item.bytes))
  )
  btn.addEventListener('click', () => focusMarked(item.path))
  return btn
}

function choose(node, nextStack) {
  state.selected = node
  if (nextStack) state.stack = nextStack
  if (nextStack) {
    paintCrumbs()
    paintLargest()
  }
  paintSelected()
  draw()
}

function focusFile(entry) {
  const prefix = state.stack.slice(0, -1)
  const full = prefix.concat(entry.chain)
  const parent = full.slice(0, -1)
  choose(entry.node, parent.length ? parent : full)
}

function focusMarked(target) {
  const chain = state.result?.tree ? findChain(state.result.tree, target) : null
  if (!chain) return
  const node = chain[chain.length - 1]
  const parent = chain.slice(0, -1)
  choose(node, parent.length ? parent : chain)
}

function goUp() {
  if (state.stack.length <= 1) return
  choose(state.stack[state.stack.length - 2], state.stack.slice(0, -1))
}

async function ensureDrives() {
  if (state.drives) {
    paintDrives()
    return
  }
  try {
    const res = await electronAPI.explorer?.driveInfo?.()
    state.drives = res?.ok && Array.isArray(res.data) ? res.data : []
  } catch {
    state.drives = []
  }
  if (state.visible) paintDrives()
}

async function pickFolder() {
  let res
  try { res = await electronAPI.explorer?.pickFolder?.() }
  catch { return }
  const picked = res?.ok ? res.data?.path : ''
  if (picked) void scan(picked)
}

async function scan(raw) {
  const target = String(raw || '')
  if (!target) return
  const gen = ++state.scanGen
  beginScan(target)
  if (typeof electronAPI.sysmon?.diskTree !== 'function') {
    finishScan(gen, { ok: false, error: { message: '掃描功能還沒準備好' } })
    return
  }
  let res
  try { res = await electronAPI.sysmon.diskTree(target) }
  catch { res = { ok: false, error: { message: '掃描失敗' } } }
  finishScan(gen, res)
}

function beginScan(target) {
  state.scanning = true
  state.error = ''
  state.progress = { bytes: 0, files: 0, dirs: 0 }
  const same = target === state.rootPath && state.result
  if (!same) {
    state.result = null
    state.stack = []
    state.selected = null
    state.cells = []
  }
  state.rootPath = target
  paint()
}

function finishScan(gen, res) {
  if (gen !== state.scanGen) return
  state.scanning = false
  if (!res?.ok) {
    if (res?.error?.code !== 'DISKTREE_CANCELLED') state.error = res?.error?.message || '掃描失敗'
    paint()
    return
  }
  if (!res.data?.tree) {
    state.error = '掃描結果是空的'
    paint()
    return
  }
  state.result = res.data
  state.stack = [res.data.tree]
  state.selected = res.data.tree
  paint()
}

function onEvent(payload) {
  if (payload?.type !== 'diskTreeProgress' || !state.scanning) return
  const data = payload.data || {}
  state.progress = {
    bytes: Number(data.bytes) || 0,
    files: Number(data.files) || 0,
    dirs: Number(data.dirs) || 0
  }
  if (state.visible) paintProgress()
}

function toggleMark() {
  const node = state.selected
  const path = fullPath(chainOf(node))
  if (!node || !path || node.k === 'o') return
  if (state.marked.has(path)) state.marked.delete(path)
  else state.marked.set(path, { path, name: baseName(node.n), bytes: node.s || 0, files: node.f || 0 })
  paintSelected()
  paintMarked()
}

function forgetUnder(target) {
  const key = String(target || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  const prefix = `${key}\\`
  for (const itemPath of [...state.marked.keys()]) {
    const norm = itemPath.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
    if (norm === key || norm.startsWith(prefix)) state.marked.delete(itemPath)
  }
}

function applyRemoval(target) {
  const tree = state.result?.tree
  if (!tree) return
  const rootKey = String(tree.n || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  const key = String(target || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  if (key && key === rootKey) {
    state.result = null
    state.stack = []
    state.selected = null
    state.rootPath = ''
    return
  }
  removePath(tree, target)
  if (state.result) state.result.bytes = tree.s
  repairStack()
}

function repairStack() {
  const root = state.result?.tree
  if (!root) {
    state.stack = []
    state.selected = null
    return
  }
  const next = []
  for (const node of state.stack) {
    if (!chainTo(root, node)) break
    next.push(node)
  }
  state.stack = next.length ? next : [root]
  if (!state.selected || !chainTo(root, state.selected)) {
    state.selected = state.stack[state.stack.length - 1]
  }
}

async function trashMarked() {
  if (state.trashing || !state.marked.size) return
  const items = [...state.marked.values()].sort((a, b) => b.path.length - a.path.length)
  const total = items.reduce((s, item) => s + (Number(item.bytes) || 0), 0)
  const lines = items.map((item) => `${item.path}　${formatBytes(item.bytes)}`).join('\n')
  const ok = await askConfirm('丟到資源回收筒？', {
    desc: `${lines}\n\n合計 ${formatBytes(total)}。可從資源回收筒還原。`,
    confirmText: '丟到回收筒',
    danger: true
  })
  if (!ok || !state.marked.size) return
  state.trashing = true
  const fails = await trashEach(items)
  state.trashing = false
  paint()
  if (fails.length) await showAlert('有些沒丟掉', { desc: fails.join('\n') })
}

async function trashEach(items) {
  const fails = []
  for (const item of items) {
    if (!state.marked.has(item.path)) continue
    let res
    try { res = await electronAPI.explorer.removeEntry(item.path) }
    catch { res = { ok: false, error: { message: '刪不掉' } } }
    if (res?.ok) {
      forgetUnder(item.path)
      applyRemoval(item.path)
    } else {
      fails.push(`${item.name}：${res?.error?.message || '刪不掉'}`)
    }
  }
  return fails
}

async function revealSelected() {
  const path = fullPath(chainOf(state.selected))
  if (!path) return
  let res
  try { res = await electronAPI.explorer.reveal(path) }
  catch { res = { ok: false, error: { message: '開不了這個位置' } } }
  if (!res?.ok) await showAlert('開不了這個位置', { desc: res?.error?.message || '在檔案總管顯示失敗' })
}

function onMode(event) {
  const btn = event.target.closest('[data-disk-mode]')
  if (!btn) return
  state.mode = btn.dataset.diskMode === 'count' ? 'count' : 'size'
  for (const tab of document.querySelectorAll('#diskModes .sysmon-tab')) {
    const on = tab === btn
    tab.classList.toggle('active', on)
    tab.setAttribute('aria-selected', on ? 'true' : 'false')
  }
  draw()
}

function onKey(event) {
  if (!state.visible || event.key !== 'Backspace') return
  const tag = event.target?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
  if (event.target?.isContentEditable) return
  if (document.querySelector('dialog[open]')) return
  if (state.stack.length <= 1) return
  event.preventDefault()
  goUp()
}

function onContext(event) {
  event.preventDefault()
  goUp()
}

function pointOf(event) {
  const canvas = $('diskCanvas')
  const rect = canvas?.getBoundingClientRect()
  if (!rect) return null
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
}

function hit(point) {
  if (!point) return null
  for (let i = state.cells.length - 1; i >= 0; i--) {
    const cell = state.cells[i]
    if (point.x >= cell.x && point.y >= cell.y && point.x < cell.x + cell.w && point.y < cell.y + cell.h) {
      return cell
    }
  }
  return null
}

function onMove(event) {
  const cell = hit(pointOf(event))
  const tip = $('diskTip')
  if (!tip) return
  if (!cell) {
    tip.hidden = true
    state.hover = null
    return
  }
  if (state.hover !== cell.node) {
    state.hover = cell.node
    fillTip(tip, cell)
    draw()
  }
  placeTip(tip, event)
}

function fillTip(tip, cell) {
  const parent = cell.chain[cell.chain.length - 2]
  const whole = parent ? valueOf(parent) : valueOf(cell.node)
  tip.replaceChildren(
    el('p', 'disk-tip-name', baseName(cell.node.n)),
    el('p', 'disk-tip-path', fullPath(cell.chain) || '沒有路徑'),
    el('p', 'disk-tip-meta', `${formatBytes(cell.node.s)} · ${fmtInt(cell.node.f)} 個檔案 · 佔上層 ${pctText(valueOf(cell.node), whole)}`)
  )
}

function placeTip(tip, event) {
  const host = $('diskMapHost')
  if (!host) return
  const bounds = host.getBoundingClientRect()
  tip.hidden = false
  let x = event.clientX - bounds.left + 14
  let y = event.clientY - bounds.top + 16
  const tw = tip.offsetWidth
  const th = tip.offsetHeight
  if (x + tw > bounds.width - 8) x = Math.max(8, event.clientX - bounds.left - tw - 12)
  if (y + th > bounds.height - 8) y = Math.max(8, event.clientY - bounds.top - th - 12)
  tip.style.left = `${Math.round(x)}px`
  tip.style.top = `${Math.round(y)}px`
}

function hideTip() {
  const tip = $('diskTip')
  if (tip) tip.hidden = true
  if (state.hover) {
    state.hover = null
    draw()
  }
}

function onClick(event) {
  const cell = hit(pointOf(event))
  if (!cell) return
  if (cell.node.k === 'd') choose(cell.node, cell.chain.slice())
  else choose(cell.node)
}

function cssColor(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

function palette() {
  const keys = ['code', 'cache', 'video', 'image', 'audio', 'doc', 'archive', 'bin', 'other', 'dir']
  const colors = {}
  for (const key of keys) colors[key] = cssColor(`--disk-${key}`, '#888888')
  return {
    colors,
    gap: cssColor('--disk-gap', '#101416'),
    ink: cssColor('--disk-ink', '#142026'),
    paper: cssColor('--disk-paper', '#f4f1e8'),
    font: getComputedStyle(document.body).fontFamily || 'sans-serif'
  }
}

function hatch(ctx, color) {
  const cached = hatchCache.get(color)
  if (cached) return cached
  const tile = document.createElement('canvas')
  tile.width = 8
  tile.height = 8
  const g = tile.getContext('2d')
  g.strokeStyle = color
  g.globalAlpha = 0.38
  g.lineWidth = 1
  g.beginPath()
  g.moveTo(0, 8)
  g.lineTo(8, 0)
  g.stroke()
  const pattern = ctx.createPattern(tile, 'repeat')
  hatchCache.set(color, pattern)
  return pattern
}

function fitCanvas() {
  const canvas = $('diskCanvas')
  const host = $('diskMapHost')
  if (!canvas || !host) return null
  const w = host.clientWidth
  const h = host.clientHeight
  if (w < 2 || h < 2) return null
  const dpr = window.devicePixelRatio || 1
  const bw = Math.max(1, Math.round(w * dpr))
  const bh = Math.max(1, Math.round(h * dpr))
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw
    canvas.height = bh
  }
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return { ctx, w, h }
}

function draw() {
  const fitted = fitCanvas()
  const canvas = $('diskCanvas')
  const empty = $('diskEmpty')
  if (!fitted || !canvas) return
  const view = current()
  const pal = palette()
  const { ctx, w, h } = fitted
  state.cells = view ? layoutTree(view, { x: 0, y: 0, w, h }, valueOf, state.stack.slice()) : []
  canvas.hidden = state.cells.length === 0
  if (empty) {
    empty.textContent = emptyText()
    empty.classList.toggle('hidden', state.cells.length > 0)
  }
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = pal.gap
  ctx.fillRect(0, 0, w, h)
  paintCanvasHatch(ctx, view, pal, w, h)
  const query = state.filter.trim().toLowerCase()
  const memo = new Map()
  for (const cell of state.cells) drawCell(ctx, cell, pal, query ? !nameMatches(cell.node, query, memo) : false)
  strokeMark(ctx, state.hover, pal.paper, 1)
  strokeMark(ctx, state.selected, pal.ink, 2.5)
  strokeMark(ctx, state.selected, pal.paper, 1.25)
}

function paintCanvasHatch(ctx, view, pal, w, h) {
  if (!view || view.k !== 'd' || !isReclaimable(view.n)) return
  const pattern = hatch(ctx, labelInk(pal.colors.cache || pal.ink, pal.ink, pal.paper))
  if (!pattern) return
  ctx.save()
  ctx.fillStyle = pattern
  ctx.fillRect(0, 0, w, h)
  ctx.restore()
}

function drawCell(ctx, cell, pal, dim) {
  const key = categorize(cell.node)
  const fill = pal.colors[key] || pal.colors.other
  const label = labelInk(fill, pal.ink, pal.paper)
  const inset = 1
  const x = cell.x + inset
  const y = cell.y + inset
  const w = Math.max(0, cell.w - inset * 2)
  const h = Math.max(0, cell.h - inset * 2)
  ctx.save()
  ctx.globalAlpha = dim ? 0.34 : 1
  ctx.fillStyle = fill
  ctx.fillRect(x, y, w, h)
  if (cell.node.k === 'd' && isReclaimable(cell.node.n)) {
    const pattern = hatch(ctx, label)
    if (pattern) {
      ctx.fillStyle = pattern
      ctx.fillRect(x, y, w, h)
    }
  }
  drawLabel(ctx, cell, label, pal.font)
  ctx.restore()
}

function drawLabel(ctx, cell, color, font) {
  if (cell.w < 52 || cell.h < 18) return
  ctx.save()
  ctx.beginPath()
  ctx.rect(cell.x + 4, cell.y + 3, Math.max(0, cell.w - 8), 14)
  ctx.clip()
  ctx.fillStyle = color
  ctx.font = `600 12px ${font}`
  ctx.textBaseline = 'top'
  ctx.fillText(baseName(cell.node.n), cell.x + 6, cell.y + 4)
  ctx.restore()
}

function strokeMark(ctx, node, color, width) {
  if (!node) return
  const cell = state.cells.find((item) => item.node === node)
  if (!cell || cell.w < 2 || cell.h < 2) return
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = width
  const inset = width
  ctx.strokeRect(cell.x + inset, cell.y + inset, Math.max(0, cell.w - inset * 2), Math.max(0, cell.h - inset * 2))
  ctx.restore()
}

function ensureObserver() {
  const host = $('diskMapHost')
  if (!host || state.observer) return
  state.observer = new ResizeObserver(() => {
    if (!state.visible) return
    if (state.raf) cancelAnimationFrame(state.raf)
    state.raf = requestAnimationFrame(() => { state.raf = 0; draw() })
  })
  state.observer.observe(host)
}

function paint() {
  paintDrives()
  paintProgress()
  paintCrumbs()
  paintSelected()
  paintLargest()
  paintMarked()
  draw()
}

function bind() {
  $('diskPick')?.addEventListener('click', () => { void pickFolder() })
  $('diskCancel')?.addEventListener('click', () => { electronAPI.sysmon?.diskTreeCancel?.() })
  $('diskFilter')?.addEventListener('input', (event) => {
    state.filter = event.target.value
    draw()
  })
  $('diskModes')?.addEventListener('click', onMode)
  $('diskReveal')?.addEventListener('click', () => { void revealSelected() })
  $('diskMark')?.addEventListener('click', toggleMark)
  $('diskRescan')?.addEventListener('click', () => {
    const path = fullPath(chainOf(state.selected))
    if (path) void scan(path)
  })
  $('diskTrash')?.addEventListener('click', () => { void trashMarked() })
  $('diskMapHost')?.addEventListener('pointermove', onMove)
  $('diskMapHost')?.addEventListener('pointerleave', hideTip)
  $('diskCanvas')?.addEventListener('click', onClick)
  $('diskMapHost')?.addEventListener('contextmenu', onContext)
  document.addEventListener('keydown', onKey)
  electronAPI.sysmon?.onEvent?.(onEvent)
}

function init() {
  if (state.inited) return
  state.inited = true
  bind()
  // 打包版 CDP 開不了原生選資料夾對話框。跟 __viInsertText 一樣，測試走同一條 scan()。
  window.__diskScan = (raw) => scan(raw)
  window.__diskView = () => ({
    bytes: state.result?.tree?.s ?? null, files: state.result?.tree?.f ?? null,
    scanning: state.scanning, error: state.error,
    cells: state.cells.map((c) => ({
      n: baseName(c.node?.n), k: c.node?.k || '', x: c.x, y: c.y, w: c.w, h: c.h
    }))
  })
}

export function showDiskPanel() {
  init()
  state.visible = true
  void ensureDrives()
  ensureObserver()
  paint()
  requestAnimationFrame(() => { if (state.visible) draw() })
}

export function hideDiskPanel() {
  state.visible = false
  state.observer?.disconnect()
  state.observer = null
  hideTip()
}
