/**
 * VoiceInk — 「檔案」分頁：本機檔案總管 + UFFS 整機檔名搜尋。
 *
 * DOM 一律 createElement + textContent（零 innerHTML）。路徑是外部輸入。
 */

import { electronAPI, showToast } from './app.js'
import { askConfirm, askInput } from './app-dialog.js'
import { showMenu } from './ws-menu.js'
import { createListReorder } from './list-reorder.js'
import { paintDetail as paintDetailPane } from './explorer-detail.js'
import {
  RECYCLE_CWD,
  pathKey,
  readDragPaths,
  writeDragPaths,
  dropMode,
  hasExplorerDrag,
  bindDropTarget,
  clearDrop,
  showExplorerMenu
} from './explorer-dnd.js'

const SEARCH_DEBOUNCE_MS = 180
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg'])

let started = false
let cwd = ''
let view = 'list'
let sortBy = 'name'
let sortDesc = false
/** @type {string[]} */
let history = []
let histIndex = -1
/** @type {Set<string>} */
let selected = new Set()
let anchor = ''
/** @type {Array<{ name: string, path: string, dir: boolean, size: number, mtimeMs: number, ext?: string }>} */
let entries = []
/** @type {Array<{ name: string, path: string, dir: boolean, size: number, mtimeMs: number }>} */
let hits = []
let searching = false
let searchSeq = 0
let navSeq = 0
/** @type {ReturnType<typeof setTimeout> | 0} */
let searchTimer = 0
let truncated = false
let searchSort = 'rank'
let editingPath = false
let watching = false
/** @type {ReturnType<typeof createListReorder> | null} */
let placeReorder = null
/** @type {(() => void) | null} */
let unsubChanged = null
/** @type {(() => void) | null} */
let unsubProgress = null
/** @type {object | null} */
let uffs = null
let ensuring = false
/** @type {Array<{ id: string, label: string, path: string }>} */
let places = []
/** @type {Array<{ letter: string, path: string, total: number, free: number }>} */
let disks = []

const $ = (id) => document.getElementById(id)

/**
 * @param {Promise<{ ok: boolean, data?: any, error?: { message: string } }>} promise
 * @param {string} fallback
 */
async function call(promise, fallback) {
  const result = await promise
  if (result && result.ok) return result.data
  showToast(result?.error?.message || fallback, 'error')
  throw new Error(result?.error?.message || fallback)
}

function formatSize(bytes) {
  const n = Number(bytes) || 0
  if (n <= 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function formatTime(ms) {
  const n = Number(ms) || 0
  if (!n) return '—'
  try {
    return new Date(n).toLocaleString('zh-TW', { hour12: false })
  } catch {
    return '—'
  }
}

function iconFor(entry) {
  if (entry.dir) return '📁'
  const ext = (entry.ext || '').toLowerCase()
  if (IMAGE_EXT.has(ext)) return '🖼'
  return '📄'
}

function inSearch() {
  const input = /** @type {HTMLInputElement | null} */ ($('exSearch'))
  return Boolean(input && input.value.trim())
}

function listed() {
  return inSearch() ? hits : entries
}

function bindOnce() {
  if (started) return
  started = true
  $('exBackBtn')?.addEventListener('click', () => goHistory(-1))
  $('exForwardBtn')?.addEventListener('click', () => goHistory(1))
  $('exUpBtn')?.addEventListener('click', goUp)
  $('exNewFolderBtn')?.addEventListener('click', newFolder)
  $('exNewFileBtn')?.addEventListener('click', newFile)
  $('exEmptyBinBtn')?.addEventListener('click', () => void emptyBin())
  $('exViewListBtn')?.addEventListener('click', () => setView('list'))
  $('exViewGridBtn')?.addEventListener('click', () => setView('grid'))
  $('exListHead')?.addEventListener('click', onSortClick)
  $('exList')?.addEventListener('contextmenu', onListContext)
  $('exList')?.addEventListener('dragover', onListDragOver)
  $('exList')?.addEventListener('drop', onListDrop)
  $('exList')?.addEventListener('dragleave', clearDrop)
  $('exSearch')?.addEventListener('input', onSearchInput)
  $('exSearch')?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      clearSearch()
    }
  })
  $('exUffsEnableBtn')?.addEventListener('click', () => void ensureUffs({ force: true }))
  $('exPathBar')?.addEventListener('click', (e) => {
    if (e.target.closest('.ex-crumb')) return
    beginEditPath()
  })
  $('exPathInput')?.addEventListener('keydown', onPathKey)
  $('exPathInput')?.addEventListener('blur', () => {
    if (editingPath) endEditPath()
  })
  $('exPlaceAddBtn')?.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    openPlaceAddMenu(e)
  })
  placeReorder = createListReorder({
    getList: () => $('exPlaces'),
    itemSelector: '.ex-side-item',
    ignoreSelector: '.ex-side-meta, .btn-icon',
    onCommit: () => void commitPlaceOrder()
  })
  document.addEventListener('keydown', onPageKey)
  unsubChanged = electronAPI.explorer.onChanged((payload) => {
    if (!payload || payload.path !== cwd || inSearch()) return
    void loadDir(cwd, { silent: true, keepSelection: true })
  })
  unsubProgress = electronAPI.explorer.onUffsProgress((info) => {
    if (!info) return
    const text = $('exUffsText')
    if (!text) return
    const total = Number(info.total) || 0
    const received = Number(info.received) || 0
    text.textContent = total
      ? `下載中 ${Math.min(100, Math.round((received / total) * 100))}%`
      : `下載中 ${formatSize(received)}`
  })
}

function crumbsOf(full) {
  if (!full) return []
  if (pathKey(full) === RECYCLE_CWD) return [{ label: '資源回收筒', path: RECYCLE_CWD }]
  const norm = full.replace(/\//g, '\\')
  if (norm.startsWith('\\\\')) {
    const parts = norm.replace(/^\\+/, '').split('\\').filter(Boolean)
    if (parts.length < 2) return [{ label: full, path: full }]
    const share = `\\\\${parts[0]}\\${parts[1]}`
    const out = [{ label: share, path: share }]
    let acc = share
    for (const part of parts.slice(2)) {
      acc += `\\${part}`
      out.push({ label: part, path: acc })
    }
    return out
  }
  const m = /^([A-Za-z]:\\)(.*)$/.exec(norm)
  if (!m) return [{ label: full, path: full }]
  const out = [{ label: m[1].slice(0, 2), path: m[1] }]
  if (!m[2]) return out
  const parts = m[2].split('\\').filter(Boolean)
  let acc = m[1]
  for (const part of parts) {
    acc = acc.endsWith('\\') ? acc + part : `${acc}\\${part}`
    out.push({ label: part, path: acc })
  }
  return out
}

function beginEditPath() {
  const input = /** @type {HTMLInputElement | null} */ ($('exPathInput'))
  const crumbs = $('exCrumbs')
  if (!input || !crumbs) return
  editingPath = true
  crumbs.hidden = true
  input.hidden = false
  input.value = pathKey(cwd) === RECYCLE_CWD ? '資源回收筒' : cwd
  input.focus()
  input.select()
}

function endEditPath() {
  const input = /** @type {HTMLInputElement | null} */ ($('exPathInput'))
  const crumbs = $('exCrumbs')
  editingPath = false
  if (input) input.hidden = true
  if (crumbs) crumbs.hidden = false
}

function onPathKey(e) {
  if (e.key === 'Escape') {
    e.preventDefault()
    endEditPath()
    return
  }
  if (e.key !== 'Enter') return
  e.preventDefault()
  const input = /** @type {HTMLInputElement} */ (e.target)
  const value = input.value.trim()
  endEditPath()
  void goToTyped(value)
}

async function goToTyped(raw) {
  if (!raw) return
  try {
    const data = await call(electronAPI.explorer.resolvePath(raw), '找不到這個路徑')
    if (data.dir) {
      await navigate(data.path)
      return
    }
    await navigate(data.parent)
    selectOnly(data.path)
    anchor = data.path
    paintList()
  } catch {
    // toast 已顯示
  }
}

function paintCrumbs() {
  const host = $('exCrumbs')
  if (!host) return
  if (editingPath) return
  host.hidden = false
  host.replaceChildren()
  const parts = crumbsOf(cwd)
  parts.forEach((part, i) => {
    if (i > 0) {
      const sep = document.createElement('span')
      sep.className = 'ex-crumb-sep'
      sep.textContent = '▸'
      host.appendChild(sep)
    }
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'ex-crumb'
    btn.textContent = part.label
    btn.title = part.path
    btn.addEventListener('click', () => void navigate(part.path))
    host.appendChild(btn)
  })
}

function paintNav() {
  const back = /** @type {HTMLButtonElement | null} */ ($('exBackBtn'))
  const fwd = /** @type {HTMLButtonElement | null} */ ($('exForwardBtn'))
  if (back) back.disabled = histIndex <= 0
  if (fwd) fwd.disabled = histIndex < 0 || histIndex >= history.length - 1
}

function setView(next) {
  view = next === 'grid' ? 'grid' : 'list'
  $('exViewListBtn')?.setAttribute('aria-pressed', view === 'list' ? 'true' : 'false')
  $('exViewGridBtn')?.setAttribute('aria-pressed', view === 'grid' ? 'true' : 'false')
  $('exList')?.classList.toggle('is-grid', view === 'grid')
  void electronAPI.explorer.saveState({ view })
}

function inRecycle() {
  return pathKey(cwd) === RECYCLE_CWD
}

function entryId(entry) {
  return (entry && (entry.recycleKey || entry.path)) || ''
}

function paintSidebar(nextPlaces, nextDisks) {
  const here = pathKey(cwd)
  paintSideList($('exPlaces'), (nextPlaces || []).map((p) => ({
    id: p.id,
    label: p.label,
    path: p.path,
    meta: '',
    active: here === pathKey(p.path),
    reorder: true,
    custom: Boolean(p.custom)
  })))
  paintSideList($('exDrives'), (nextDisks || []).map((d) => ({
    id: `drive-${d.letter}`,
    label: `${d.letter}:`,
    path: d.path,
    meta: d.total ? `${Math.round(((d.total - d.free) / d.total) * 100)}%` : '',
    active: here === pathKey(d.path) || here.startsWith(pathKey(d.path) + '\\'),
    reorder: false,
    custom: false
  })))
}

function paintSideList(host, items) {
  if (!host) return
  host.replaceChildren()
  for (const item of items) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'ex-side-item'
    btn.dataset.id = item.id
    btn.dataset.path = item.path
    btn.classList.toggle('is-active', Boolean(item.active))
    if (item.reorder) {
      const grip = document.createElement('span')
      grip.className = 'ex-side-grip'
      grip.textContent = '⋮⋮'
      grip.setAttribute('aria-hidden', 'true')
      btn.appendChild(grip)
    }
    const name = document.createElement('span')
    name.textContent = item.label
    btn.appendChild(name)
    if (item.meta) {
      const meta = document.createElement('span')
      meta.className = 'ex-side-meta'
      meta.textContent = item.meta
      btn.appendChild(meta)
    }
    let down = null
    btn.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY }
      if (item.reorder && placeReorder && e.button === 0) placeReorder.onPointerDown(e)
    })
    btn.addEventListener('keydown', (e) => {
      if (item.reorder && placeReorder) placeReorder.onKeydown(e)
    })
    btn.addEventListener('click', (e) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return
      void navigate(item.path)
    })
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      openPlaceMenu(e, item)
    })
    bindDropTarget(btn, () => item.path, (event, dest) => void handleDrop(event, dest))
    host.appendChild(btn)
  }
}

function paintList() {
  const host = $('exList')
  const empty = $('exEmpty')
  if (!host) return
  host.replaceChildren()
  host.classList.toggle('is-grid', view === 'grid')
  const rows = listed()
  if (empty) {
    empty.hidden = rows.length > 0
    empty.textContent = inSearch() ? '沒有符合的檔案' : inRecycle() ? '資源回收筒是空的' : '這個資料夾是空的'
  }
  for (const entry of rows) {
    host.appendChild(rowEl(entry))
  }
  paintStatus()
  paintCmdBar()
  paintDetail()
  focusSelectedRow()
}

function focusSelectedRow() {
  const host = $('exList')
  if (!host) return
  const active = document.activeElement
  if (active) {
    const tag = active.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || active.isContentEditable) return
    if (typeof active.closest === 'function' && active.closest('.ws-menu, .app-dialog, dialog')) return
  }
  const row = host.querySelector('.ex-row.is-selected')
  if (row && typeof row.focus === 'function') {
    row.focus({ preventScroll: true })
    return
  }
  if (active === host) host.focus()
}

function rowEl(entry) {
  const row = document.createElement('div')
  row.className = 'ex-row'
  row.dataset.id = entry.recycleKey || (inSearch() ? entry.path : entry.name)
  row.dataset.name = entry.name
  row.dataset.path = entry.path
  if (entry.recycleKey) row.dataset.key = entry.recycleKey
  row.setAttribute('role', 'option')
  row.tabIndex = -1
  if (selected.has(entryId(entry))) row.classList.add('is-selected')
  const name = document.createElement('div')
  name.className = 'ex-row-name'
  const icon = document.createElement('span')
  icon.className = 'ex-row-icon'
  icon.textContent = iconFor(entry)
  const label = document.createElement('span')
  label.textContent = inSearch() ? entry.path : entry.name
  name.append(icon, label)
  const size = document.createElement('div')
  size.className = 'ex-row-size'
  size.textContent = entry.dir ? '—' : formatSize(entry.size)
  const mtime = document.createElement('div')
  mtime.className = 'ex-row-mtime'
  mtime.textContent = formatTime(entry.mtimeMs)
  row.append(name, size, mtime)
  row.draggable = !inSearch() && !inRecycle()
  row.addEventListener('click', (e) => onRowClick(entry, e))
  row.addEventListener('dblclick', () => void openEntry(entry))
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (!selected.has(entryId(entry))) selectOnly(entryId(entry))
    paintList()
    openContextMenu(e, selectedEntries())
  })
  row.addEventListener('dragstart', (e) => onDragStart(e, entry))
  if (entry.dir) bindDropTarget(row, () => entry.path, (event, dest) => void handleDrop(event, dest))
  return row
}

function onRowClick(entry, e) {
  const rows = listed()
  const id = entryId(entry)
  if (e.shiftKey && anchor) {
    const i1 = rows.findIndex((r) => entryId(r) === anchor)
    const i2 = rows.findIndex((r) => entryId(r) === id)
    if (i1 >= 0 && i2 >= 0) {
      const lo = Math.min(i1, i2)
      const hi = Math.max(i1, i2)
      selected = new Set(rows.slice(lo, hi + 1).map((r) => entryId(r)))
    }
  } else if (e.ctrlKey || e.metaKey) {
    if (selected.has(id)) selected.delete(id)
    else selected.add(id)
    anchor = id
  } else {
    selectOnly(id)
    anchor = id
  }
  paintList()
  const row = $('exList')?.querySelector('.ex-row.is-selected')
  if (row && typeof row.focus === 'function') row.focus({ preventScroll: true })
}

function selectOnly(full) {
  selected = new Set(full ? [full] : [])
}

function paintStatus() {
  const el = $('exStatusText')
  if (!el) return
  const rows = listed()
  const extra = truncated ? '（已截斷）' : ''
  if (inSearch()) {
    el.textContent = searching ? '搜尋中…' : `${rows.length} 筆結果${extra}`
    return
  }
  const dirs = rows.filter((r) => r.dir).length
  el.textContent = `${rows.length} 個項目 · ${dirs} 個資料夾${extra}`
}

function selectedEntries() {
  const rows = listed()
  return rows.filter((r) => selected.has(entryId(r)))
}

async function paintDetail() {
  const host = $('exDetail')
  if (!host) return
  const items = selectedEntries()
  await paintDetailPane({
    host,
    items,
    inRecycle: inRecycle(),
    inspect: async (filePath) => {
      const result = await electronAPI.explorer.inspect(filePath)
      if (result && result.ok) return result.data
      throw new Error('inspect')
    },
    formatSize,
    formatTime
  })
}

function paintCmdBar() {
  const bar = $('exCmdBar')
  if (!bar) return
  bar.replaceChildren()
  const items = selectedEntries()
  const has = items.length > 0
  const one = items.length === 1
  if (inRecycle()) {
    addCmd(bar, '還原', () => void restoreItems(items), { disabled: !has })
    addCmd(bar, '永久刪除', () => void deleteItems(items, { permanent: true }), { disabled: !has, danger: true })
    addCmd(bar, '清空', () => void emptyBin())
    return
  }
  addCmd(bar, '開啟', () => void openEntry(items[0]), { disabled: !one })
  addCmd(bar, '顯示位置', () => void revealItems(items), { disabled: !has })
  addCmd(bar, '複製路徑', () => copyPaths(items), { disabled: !has })
  addCmd(bar, '複製', () => void clipboard(items, 'copy'), { disabled: !has })
  addCmd(bar, '剪下', () => void clipboard(items, 'cut'), { disabled: !has })
  addCmd(bar, '貼上', () => void pasteHere())
  addCmd(bar, '重新命名', () => void renameItem(items[0]), { disabled: !one })
  addCmd(bar, '刪除', () => void deleteItems(items), { disabled: !has, danger: true })
}

function addCmd(bar, label, fn, opts = {}) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = opts.danger ? 'btn btn-danger btn-sm' : 'btn btn-secondary btn-sm'
  btn.textContent = label
  btn.disabled = Boolean(opts.disabled)
  btn.addEventListener('click', fn)
  bar.appendChild(btn)
}

async function loadDir(dirPath, opts = {}) {
  const seq = ++navSeq
  const data = await call(
    electronAPI.explorer.listDir(dirPath, { sort: sortBy, desc: sortDesc }),
    '讀不到這個資料夾'
  )
  if (seq !== navSeq) return
  cwd = data.path
  entries = data.entries || []
  truncated = Boolean(data.truncated)
  if (!opts.keepSelection) {
    selected = new Set()
    anchor = ''
  } else {
    const live = new Set(listed().map((row) => entryId(row)))
    selected = new Set([...selected].filter((id) => live.has(id)))
    if (anchor && !live.has(anchor)) anchor = ''
  }
  paintCrumbs()
  paintNav()
  paintSidebar(places, disks)
  paintSortHead()
  paintList()
  paintRecycleChrome()
  const watch = await electronAPI.explorer.watch(cwd)
  watching = Boolean(watch && watch.ok && watch.data && watch.data.watching)
  if (!opts.silent) void electronAPI.explorer.saveState({ lastPath: cwd, sort: sortBy, sortDesc })
}

async function navigate(dirPath, opts = {}) {
  clearSearchInput()
  await loadDir(dirPath)
  if (opts.skipHistory) return
  history = history.slice(0, histIndex + 1)
  history.push(cwd)
  histIndex = history.length - 1
  paintNav()
}

async function goHistory(delta) {
  const next = histIndex + delta
  if (next < 0 || next >= history.length) return
  histIndex = next
  clearSearchInput()
  await loadDir(history[histIndex], { silent: true })
  paintNav()
}

async function goUp() {
  if (!cwd) return
  if (inRecycle()) {
    const home = places[0] && places[0].path
    if (home) await navigate(home)
    return
  }
  if (cwd.startsWith('\\\\')) {
    const parts = cwd.replace(/\\+$/, '').replace(/^\\\\/, '').split('\\').filter(Boolean)
    if (parts.length <= 2) return
    await navigate(`\\\\${parts.slice(0, -1).join('\\')}`)
    return
  }
  const parent = cwd.replace(/\\+$/, '').replace(/\\[^\\]+$/, '')
  const up = /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent
  if (!up || up === cwd) return
  await navigate(up)
}

function paintSortHead() {
  const head = $('exListHead')
  if (!head) return
  head.hidden = view === 'grid'
  const active = inSearch() ? searchSort : sortBy
  for (const btn of head.querySelectorAll('.ex-sort')) {
    const key = btn.getAttribute('data-sort')
    btn.classList.toggle('is-active', key === active)
    btn.textContent = key === 'name' ? '名稱' : key === 'size' ? '大小' : '修改'
    if (key === active) btn.textContent += sortDesc ? ' ↓' : ' ↑'
  }
}

function paintRecycleChrome() {
  const rec = inRecycle()
  const folderBtn = $('exNewFolderBtn')
  const fileBtn = $('exNewFileBtn')
  const emptyBtn = $('exEmptyBinBtn')
  if (folderBtn) folderBtn.hidden = rec
  if (fileBtn) fileBtn.hidden = rec
  if (emptyBtn) emptyBtn.hidden = !rec
}

function onSortClick(e) {
  const btn = e.target.closest('.ex-sort')
  if (!btn) return
  const key = btn.getAttribute('data-sort')
  if (key !== 'name' && key !== 'date' && key !== 'size') return
  if (inSearch()) {
    if (searchSort === key) sortDesc = !sortDesc
    else {
      searchSort = key
      sortDesc = false
    }
    sortHits()
    paintSortHead()
    paintList()
    return
  }
  if (sortBy === key) sortDesc = !sortDesc
  else {
    sortBy = key
    sortDesc = false
  }
  void loadDir(cwd, { silent: true, keepSelection: true })
}

function sortHits() {
  if (searchSort === 'rank') return
  const by = searchSort
  const desc = sortDesc
  hits = hits.slice().sort((a, b) => {
    if (Boolean(a.dir) !== Boolean(b.dir)) return a.dir ? -1 : 1
    let cmp = 0
    if (by === 'size') cmp = (Number(a.size) || 0) - (Number(b.size) || 0)
    else if (by === 'date') cmp = (Number(a.mtimeMs) || 0) - (Number(b.mtimeMs) || 0)
    else cmp = String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hant', { numeric: true, sensitivity: 'base' })
    return desc ? -cmp : cmp
  })
}

function clearSearchInput() {
  const input = /** @type {HTMLInputElement | null} */ ($('exSearch'))
  if (input) input.value = ''
  hits = []
  searching = false
  $('exSearchHint') && ($('exSearchHint').textContent = '')
}

function clearSearch() {
  clearSearchInput()
  paintList()
}

function onSearchInput() {
  const input = /** @type {HTMLInputElement | null} */ ($('exSearch'))
  const q = input ? input.value.trim() : ''
  if (searchTimer) clearTimeout(searchTimer)
  if (!q) {
    void electronAPI.explorer.uffsCancel()
    hits = []
    searching = false
    const hint = $('exSearchHint')
    if (hint) hint.textContent = ''
    paintList()
    return
  }
  if (ensuring) {
    const hint = $('exSearchHint')
    if (hint) hint.textContent = '準備中'
    return
  }
  if (!uffs || !uffs.installed) {
    const hint = $('exSearchHint')
    if (hint) hint.textContent = '尚未啟用'
    return
  }
  searchTimer = setTimeout(() => void runSearch(q), SEARCH_DEBOUNCE_MS)
}

async function runSearch(q) {
  const seq = ++searchSeq
  searching = true
  paintStatus()
  try {
    const data = await call(electronAPI.explorer.uffsSearch(q), '搜尋失敗')
    if (seq !== searchSeq) return
    if (data.warming) {
      $('exSearchHint') && ($('exSearchHint').textContent = '索引中')
      hits = []
    } else {
      $('exSearchHint') && ($('exSearchHint').textContent = '')
      hits = data.hits || []
      searchSort = 'rank'
      truncated = Boolean(data.truncated)
    }
  } catch {
    if (seq !== searchSeq) return
    hits = []
  } finally {
    if (seq === searchSeq) {
      searching = false
      selected = new Set()
      paintList()
    }
  }
}

async function openEntry(entry) {
  if (!entry) return
  if (inRecycle()) {
    await restoreItems([entry])
    return
  }
  if (entry.dir) {
    await navigate(entry.path)
    return
  }
  try {
    await call(electronAPI.explorer.openPath(entry.path), '打不開')
  } catch {
    // toast 已顯示
  }
}

async function revealItems(items) {
  const first = items[0]
  if (!first) return
  try {
    await call(electronAPI.explorer.reveal(first.path), '找不到這個檔案')
  } catch {
    // toast 已顯示
  }
}

function copyPaths(items) {
  const text = items.map((i) => i.path).join('\r\n')
  void navigator.clipboard.writeText(text).then(
    () => showToast('已複製路徑'),
    () => showToast('複製失敗', 'error')
  )
}

async function clipboard(items, mode) {
  try {
    await call(
      electronAPI.explorer.setClipboard(items.map((i) => i.path), mode),
      '無法放入剪貼簿'
    )
    showToast(mode === 'cut' ? '已剪下' : '已複製')
  } catch {
    // toast 已顯示
  }
}

async function refreshAfterMutate() {
  if (inSearch()) {
    const input = /** @type {HTMLInputElement | null} */ ($('exSearch'))
    const q = input ? input.value.trim() : ''
    if (q) {
      await runSearch(q)
      return
    }
  }
  await loadDir(cwd, { silent: true })
}

async function pasteHere() {
  if (!cwd) return
  try {
    await call(electronAPI.explorer.paste(cwd), '貼上失敗')
    await refreshAfterMutate()
  } catch {
    // toast 已顯示
  }
}

async function newFolder() {
  if (inRecycle()) return
  const name = await askInput('新增資料夾', { placeholder: '資料夾名稱' })
  if (!name) return
  try {
    await call(electronAPI.explorer.createEntry(cwd, name, true), '建不了資料夾')
    await refreshAfterMutate()
  } catch {
    // toast 已顯示
  }
}

async function newFile() {
  if (inRecycle()) return
  const name = await askInput('新增檔案', { placeholder: '檔案名稱' })
  if (!name) return
  try {
    await call(electronAPI.explorer.createEntry(cwd, name, false), '建不了檔案')
    await refreshAfterMutate()
  } catch {
    // toast 已顯示
  }
}

async function renameItem(item) {
  const name = await askInput('重新命名', { value: item.name })
  if (!name || name === item.name) return
  try {
    await call(electronAPI.explorer.renameEntry(item.path, name), '改名失敗')
    await refreshAfterMutate()
  } catch {
    // toast 已顯示
  }
}

async function deleteItems(items, opts = {}) {
  if (!items.length) return
  const permanent = Boolean(opts.permanent) || inRecycle()
  const desc = items.length === 1 ? items[0].name : `${items.length} 個項目`
  const title = permanent ? '永久刪除？無法還原' : '移到資源回收筒？'
  const ok = await askConfirm(title, { desc, confirmText: permanent ? '永久刪除' : '刪除', danger: true })
  if (!ok) return
  try {
    for (const item of items) {
      if (inRecycle() && item.recycleKey) {
        await call(electronAPI.explorer.purgeEntry(item.recycleKey), '刪不掉')
      } else {
        await call(electronAPI.explorer.removeEntry(item.path, { permanent }), '刪不掉')
      }
    }
    selected = new Set()
    await refreshAfterMutate()
  } catch {
    // toast 已顯示
  }
}

async function restoreItems(items) {
  try {
    for (const item of items) {
      if (!item.recycleKey) continue
      await call(electronAPI.explorer.restoreEntry(item.recycleKey), '還原失敗')
    }
    selected = new Set()
    await refreshAfterMutate()
    showToast('已還原')
  } catch {
    // toast 已顯示
  }
}

async function emptyBin() {
  if (!inRecycle()) return
  const ok = await askConfirm('清空資源回收筒？', { desc: '裡面的項目都會永久刪除。', confirmText: '清空', danger: true })
  if (!ok) return
  try {
    await call(electronAPI.explorer.emptyRecycle(), '清不掉')
    selected = new Set()
    await refreshAfterMutate()
  } catch {
    // toast 已顯示
  }
}

function openContextMenu(e, items) {
  showExplorerMenu({ x: e.clientX, y: e.clientY }, {
    recycle: inRecycle(),
    items,
    actions: {
      restore: () => void restoreItems(items),
      purge: () => void deleteItems(items, { permanent: true }),
      empty: () => void emptyBin(),
      open: () => void openEntry(items[0]),
      reveal: () => void revealItems(items),
      pin: () => void pinEntries(items),
      pinHere: () => void pinPath(cwd, ''),
      cut: () => void clipboard(items, 'cut'),
      copy: () => void clipboard(items, 'copy'),
      paste: () => void pasteHere(),
      copyPath: () => copyPaths(items),
      copyName: () => copyNames(items),
      shortcut: () => void makeShortcut(items),
      rename: () => void renameItem(items[0]),
      remove: () => void deleteItems(items),
      newFolder: () => void newFolder(),
      newFile: () => void newFile(),
      refresh: () => void refreshAfterMutate()
    }
  })
}

function copyNames(items) {
  const text = items.map((i) => i.name).join('\r\n')
  void navigator.clipboard.writeText(text).then(
    () => showToast('已複製名稱'),
    () => showToast('複製失敗', 'error')
  )
}

async function makeShortcut(items) {
  if (inRecycle() || !items.length) return
  try {
    for (const item of items.slice(0, 20)) {
      await call(electronAPI.explorer.createShortcut(item.path, cwd), '建不了捷徑')
    }
    await refreshAfterMutate()
    showToast('已建立捷徑')
  } catch {
    // toast 已顯示
  }
}

async function pinEntries(items) {
  const first = items[0]
  if (!first) return
  const target = first.dir ? first.path : first.path.replace(/\\[^\\]+$/, '')
  await pinPath(target, first.dir ? first.name : '')
}

async function pinPath(dirPath, label) {
  if (!dirPath || pathKey(dirPath) === RECYCLE_CWD) return
  try {
    places = await call(electronAPI.explorer.addPlace({ path: dirPath, label }), '釘不上側欄')
    paintSidebar(places, disks)
    showToast('已釘到側欄')
  } catch {
    // toast 已顯示
  }
}

async function commitPlaceOrder() {
  const host = $('exPlaces')
  if (!host) return
  const ids = [...host.querySelectorAll('.ex-side-item')].map((el) => el.dataset.id)
  const byId = new Map(places.map((p) => [p.id, p]))
  const next = ids.map((id) => byId.get(id)).filter(Boolean)
  try {
    places = await call(electronAPI.explorer.savePlaces(next), '排不了序')
    paintSidebar(places, disks)
  } catch {
    paintSidebar(places, disks)
  }
}

function openPlaceMenu(e, item) {
  const menu = [
    { label: '開啟', onSelect: () => void navigate(item.path) },
    { label: '重新命名', onSelect: () => void renamePlace(item) },
    { label: '從側欄移除', onSelect: () => void dropPlace(item.id) }
  ]
  showMenu({ x: e.clientX, y: e.clientY }, menu)
}

function openPlaceAddMenu(e) {
  showMenu({ x: e.clientX, y: e.clientY }, [
    { label: '選擇資料夾', onSelect: () => void addFolderPlace() },
    { label: '新增網路磁碟', onSelect: () => void addNasPlace() },
    { label: '釘上目前位置', onSelect: () => void pinPath(cwd, '') }
  ])
}

async function renamePlace(item) {
  const name = await askInput('重新命名位置', { value: item.label })
  if (!name || name === item.label) return
  const next = places.map((p) => (p.id === item.id ? { ...p, label: name } : p))
  try {
    places = await call(electronAPI.explorer.savePlaces(next), '改不了名字')
    paintSidebar(places, disks)
  } catch {
    // toast 已顯示
  }
}

async function dropPlace(id) {
  try {
    places = await call(electronAPI.explorer.removePlace(id), '移不掉')
    paintSidebar(places, disks)
  } catch {
    // toast 已顯示
  }
}

async function addFolderPlace() {
  try {
    const picked = await call(electronAPI.explorer.pickFolder(), '選不到資料夾')
    if (!picked || !picked.path) return
    await pinPath(picked.path, '')
  } catch {
    // toast 已顯示
  }
}

async function addNasPlace() {
  const unc = await askInput('新增網路磁碟', {
    desc: '例如 \\\\nas\\share，可再填磁碟代號對應成網路磁碟。',
    placeholder: '\\\\伺服器\\分享'
  })
  if (!unc) return
  const letter = await askInput('磁碟代號（可留空）', {
    desc: '留空只加到側欄。填 D–Z 會用 net use 對應成磁碟。',
    placeholder: '例如 Z'
  })
  try {
    places = await call(
      electronAPI.explorer.connectShare({ unc, letter: letter || '' }),
      '連不上這個網路磁碟'
    )
    const nextDisks = await electronAPI.explorer.listDrives()
    if (nextDisks && nextDisks.ok) disks = nextDisks.data || disks
    paintSidebar(places, disks)
    showToast('已加入網路位置')
  } catch {
    // toast 已顯示
  }
}

function onListContext(e) {
  if (e.target.closest('.ex-row')) return
  e.preventDefault()
  selected = new Set()
  paintList()
  openContextMenu(e, [])
}

function onDragStart(e, entry) {
  if (!selected.has(entryId(entry))) selectOnly(entryId(entry))
  const items = selectedEntries()
  writeDragPaths(e, items.map((i) => i.path), items[0] ? items[0].name : 'files')
}

function onListDragOver(e) {
  if (e.target.closest('.ex-row')) return
  if (!hasExplorerDrag(e)) return
  e.preventDefault()
}

function onListDrop(e) {
  if (e.target.closest('.ex-row')) return
  void handleDrop(e, cwd)
}

async function handleDrop(e, toDir) {
  e.preventDefault()
  const paths = readDragPaths(e)
  if (!paths.length || !toDir) return
  if (paths.some((p) => pathKey(p) === pathKey(toDir))) return
  const mode = dropMode(e, paths[0], toDir)
  try {
    if (mode === 'trash') {
      const ok = await askConfirm('移到資源回收筒？', {
        desc: paths.length === 1
          ? String(paths[0]).split(/[\\/]/).filter(Boolean).pop()
          : `${paths.length} 個項目`,
        confirmText: '刪除',
        danger: true
      })
      if (!ok) return
      await call(electronAPI.explorer.dropEntries(paths, RECYCLE_CWD, 'move'), '刪不掉')
    } else {
      await call(electronAPI.explorer.dropEntries(paths, toDir, mode), '搬不過去')
    }
    await refreshAfterMutate()
  } catch {
    // toast 已顯示
  }
}

function onPageKey(e) {
  if (!$('page-explorer')?.classList.contains('active')) return
  const tag = /** @type {HTMLElement} */ (e.target).tagName
  if ((e.ctrlKey && (e.key === 'l' || e.key === 'L')) || (e.altKey && (e.key === 'd' || e.key === 'D'))) {
    if (e.target && /** @type {HTMLElement} */ (e.target).id === 'exSearch') return
    e.preventDefault()
    beginEditPath()
    return
  }
  if (tag === 'INPUT' || tag === 'TEXTAREA') return
  if (document.querySelector('.ws-menu, dialog[open]')) return
  if (e.key === 'F5') {
    e.preventDefault()
    void refreshAfterMutate()
    return
  }
  if (e.key === 'Enter') {
    if (tag === 'BUTTON' || tag === 'A' || tag === 'SELECT') return
    e.preventDefault()
    const items = selectedEntries()
    if (items[0]) void openEntry(items[0])
    return
  }
  if (e.key === 'Backspace' || (e.altKey && e.key === 'ArrowUp')) {
    e.preventDefault()
    void goUp()
  }
  if (e.key === 'F2') {
    const items = selectedEntries()
    if (items.length === 1 && !inRecycle()) void renameItem(items[0])
  }
  if (e.key === 'Delete') void deleteItems(selectedEntries(), { permanent: e.shiftKey })
  if (e.ctrlKey && (e.key === 'a' || e.key === 'A')) {
    e.preventDefault()
    selected = new Set(listed().map((r) => entryId(r)))
    paintList()
  }
  if (e.ctrlKey && e.key === 'c') void clipboard(selectedEntries(), 'copy')
  if (e.ctrlKey && e.key === 'x') void clipboard(selectedEntries(), 'cut')
  if (e.ctrlKey && e.key === 'v') void pasteHere()
}

function paintUffs() {
  const text = $('exUffsText')
  const dot = $('exUffsDot')
  const enableBtn = $('exUffsEnableBtn')
  if (!text || !dot) return
  const brokerOn = Boolean(uffs && uffs.broker && uffs.broker.installed)
  const daemonOn = Boolean(uffs && uffs.daemon && uffs.daemon.running)
  const warming = Boolean(uffs && uffs.daemon && uffs.daemon.warming)
  const needAuth = !uffs || !uffs.installed || (!brokerOn && !daemonOn)
  if (enableBtn) enableBtn.hidden = ensuring || !needAuth
  if (ensuring) {
    text.textContent = '準備中…'
    dot.classList.remove('is-on')
    return
  }
  if (!uffs || !uffs.installed) {
    text.textContent = '尚未啟用快速搜尋'
    dot.classList.remove('is-on')
    return
  }
  if (warming) {
    text.textContent = '索引建置中'
    dot.classList.remove('is-on')
    return
  }
  if (daemonOn) {
    const n = uffs.daemon.records ? ` · ${uffs.daemon.records.toLocaleString('zh-TW')} 筆` : ''
    text.textContent = `搜尋就緒${n}`
    dot.classList.add('is-on')
    return
  }
  if (!brokerOn) {
    text.textContent = '需要授權讀取磁碟'
    dot.classList.remove('is-on')
    return
  }
  text.textContent = uffs.version ? `UFFS ${uffs.version}` : 'UFFS 已安裝'
  dot.classList.remove('is-on')
}

async function ensureUffs(opts = {}) {
  if (ensuring) return
  ensuring = true
  paintUffs()
  try {
    uffs = await call(
      electronAPI.explorer.uffsEnsure(opts.force ? { force: true } : undefined),
      '無法啟用搜尋'
    )
  } catch {
    // toast 已顯示；UAC 按否之後只留啟用鈕
  } finally {
    ensuring = false
    paintUffs()
  }
}

export async function refreshExplorerPage() {
  bindOnce()
  try {
    const boot = await call(electronAPI.explorer.bootstrap(), '打不開檔案總管')
    view = boot.view === 'grid' ? 'grid' : 'list'
    sortBy = boot.sort === 'date' || boot.sort === 'size' ? boot.sort : 'name'
    sortDesc = boot.sortDesc === true
    places = boot.places || []
    disks = boot.drives || []
    setView(view)
    paintSidebar(places, disks)
    history = []
    histIndex = -1
    await navigate(boot.lastPath)
  } catch {
    // toast 已顯示
  }
  void ensureUffs()
}

export function cooldownExplorerPage() {
  if (searchTimer) clearTimeout(searchTimer)
  void electronAPI.explorer.uffsCancel()
  void electronAPI.explorer.unwatch()
  watching = false
}

export function disposeExplorerPage() {
  cooldownExplorerPage()
  if (unsubChanged) unsubChanged()
  if (unsubProgress) unsubProgress()
  unsubChanged = null
  unsubProgress = null
}
