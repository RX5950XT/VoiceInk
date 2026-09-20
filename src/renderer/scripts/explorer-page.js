/**
 * VoiceInk — 「檔案」分頁：本機檔案總管 + UFFS 整機檔名搜尋。
 *
 * DOM 一律 createElement + textContent（零 innerHTML）。路徑是外部輸入。
 */

import { electronAPI, showToast, switchPage, setSidebarMode } from './app.js'
import { askConfirm, askInput } from './app-dialog.js'
import { showMenu } from './ws-menu.js'
import { createListReorder } from './list-reorder.js'
import { paintDetail as paintDetailPane } from './explorer-detail.js'
import { paintHomePane } from './explorer-home.js'
import { paintTabStrip } from './explorer-tabs.js'
import { paintFileIcons } from './explorer-icons.js'
import {
  RECYCLE_CWD,
  pathKey,
  readDragPaths,
  setDropEffect,
  dropMode,
  hasExplorerDrag,
  bindDropTarget,
  clearDrop,
  showExplorerMenu
} from './explorer-dnd.js'

const SEARCH_DEBOUNCE_MS = 180
/** 虛擬位置：Windows 那樣的「本機」首頁（跟 recyclebin 同一種，不是真路徑）。 */
const THIS_PC = 'thispc'
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
/** 方向鍵的游標位置。跟 `anchor`（Shift 連選的錨點）是兩件事 */
let cursor = ''
/** 上一次剪下／複製了什麼——貼上要復原時得知道是搬過去還是拷過去的 */
let lastClip = { mode: 'copy', paths: [] }
/** @type {Array<{ name: string, path: string, dir: boolean, size: number, mtimeMs: number, ext?: string }>} */
let entries = []
/** @type {Array<{ name: string, path: string, dir: boolean, size: number, mtimeMs: number }>} */
let hits = []
let searching = false
let searchSeq = 0
let navSeq = 0
let contextMenuSeq = 0
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
/** @type {Array<{ letter: string, path: string, label: string, fs: string, total: number, free: number, type: number }>} */
let diskInfo = []
/** 分頁：一頁一條路徑與自己的上／下一頁歷史。切 nav 分頁回來要留著。 */
/** @type {Array<{ id: string, cwd: string, history: string[], histIndex: number }>} */
let tabs = []
let activeId = ''
let tabSeq = 0

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
  $('exTabAddBtn')?.addEventListener('click', () => void newTab())
  $('exBackBtn')?.addEventListener('click', () => goHistory(-1))
  $('exForwardBtn')?.addEventListener('click', () => goHistory(1))
  $('exUpBtn')?.addEventListener('click', goUp)
  $('exNewFolderBtn')?.addEventListener('click', newFolder)
  $('exNewFileBtn')?.addEventListener('click', newFile)
  $('exEmptyBinBtn')?.addEventListener('click', () => void emptyBin())
  $('exViewListBtn')?.addEventListener('click', () => setView('list'))
  $('exViewGridBtn')?.addEventListener('click', () => setView('grid'))
  $('exListHead')?.addEventListener('click', onSortClick)
  $('exList')?.addEventListener('mousedown', onListMouseDown)
  $('exList')?.addEventListener('click', onListClick)
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
  for (const type of ['mousedown', 'mouseup', 'auxclick']) document.addEventListener(type, onSideButton, true)
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
  if (pathKey(full) === THIS_PC) return [{ label: '本機', path: THIS_PC }]
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
  input.value = inHome() ? '本機' : inRecycle() ? '資源回收筒' : cwd
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
  paintSortHead()
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
  // 「本機」首頁的資料夾那一區畫的就是側欄釘選的位置：釘上／移除／改名／排序之後
  // 只重畫側欄的話，站在首頁時看到的是舊的那一份（要切走再切回來才會更新）。
  // 收在這裡而不是每個呼叫點各補一次：places 變動的六個地方都走這支。
  if (inHome() && !inSearch()) paintHome()
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
      void (e.ctrlKey ? newTab(item.path) : navigate(item.path))
    })
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      openPlaceMenu(e, item)
    })
    if (pathKey(item.path) !== THIS_PC) bindDropTarget(btn, () => item.path, (event, dest) => void handleDrop(event, dest))
    host.appendChild(btn)
  }
}

function paintList() {
  const host = $('exList')
  const empty = $('exEmpty')
  if (!host) return
  const home = inHome() && !inSearch()
  paintSortHead()
  $('exDetail')?.classList.toggle('is-home', home)
  const homeHost = $('exHome')
  if (homeHost) homeHost.hidden = !home
  host.hidden = home
  if (home) {
    host.replaceChildren()
    paintFileIcons(host, (target) => electronAPI.explorer.fileIcon(target))
    paintHome()
    if (empty) empty.hidden = true
    paintStatus()
    paintCmdBar()
    void paintDetail()
    return
  }
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
  paintFileIcons(host, (target) => electronAPI.explorer.fileIcon(target))
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
  icon.setAttribute('aria-hidden', 'true')
  icon.classList.toggle('is-shortcut', entry.ext === 'lnk')
  if (!inRecycle() && entry.path) {
    icon.dataset.path = entry.path
    icon.dataset.iconKey = `${entry.path}:${entry.mtimeMs || 0}:${entry.dir ? 'd' : 'f'}`
  }
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
  row.addEventListener('auxclick', (e) => {
    if (e.button === 1 && entry.dir && !inRecycle()) {
      e.preventDefault()
      void newTab(entry.path)
    }
  })
  row.addEventListener('dblclick', () => void openEntry(entry))
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (!selected.has(entryId(entry))) selectOnly(entryId(entry))
    paintList()
    openContextMenu(e, selectedEntries())
  })
  row.addEventListener('dragstart', (e) => onDragStart(e, entry))
  if (entry.dir) {
    bindDropTarget(row, () => entry.path, (event, dest) => void handleDrop(event, dest), (dest) => {
      // 拖著檔案停在資料夾上就進去，才有辦法丟到深層路徑
      if (!inSearch() && !inRecycle()) void navigate(dest)
    })
  }
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
    cursor = id
  } else {
    selectOnly(id)
    anchor = id
  }
  cursor = id
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
  if (inHome() && !inSearch()) {
    const list = diskInfo.length ? diskInfo : disks
    el.textContent = `${list.length} 個磁碟`
    return
  }
  if (inSearch()) {
    el.textContent = searching ? '搜尋中…' : `${rows.length} 筆結果${extra}`
    return
  }
  const dirs = rows.filter((r) => r.dir).length
  const picked = selectedEntries()
  // 資料夾的大小要遞迴走完整棵樹才算得出來，這裡不算——跟 Windows 一樣只在全是檔案時報大小
  const bytes = picked.length && picked.every((p) => !p.dir)
    ? `，${formatSize(picked.reduce((n, p) => n + (Number(p.size) || 0), 0))}`
    : ''
  const picks = picked.length ? ` · 已選取 ${picked.length} 個${bytes}` : ''
  el.textContent = `${rows.length} 個項目 · ${dirs} 個資料夾${extra}${picks}`
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
  addCmd(bar, '貼上', () => void pasteHere(), { disabled: inHome() })
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

function inHome() {
  return pathKey(cwd) === THIS_PC
}

function currentTab() {
  return tabs.find((t) => t.id === activeId) || null
}

/** 把目前這頁的位置與歷史寫回它自己那一格。 */
function syncTab() {
  const tab = currentTab()
  if (!tab) return
  tab.cwd = cwd
  tab.history = history
  tab.histIndex = histIndex
}

function tabTitle(target) {
  const key = pathKey(target)
  if (key === THIS_PC) return '本機'
  if (key === RECYCLE_CWD) return '資源回收筒'
  const norm = String(target || '').replace(/\\+$/, '')
  if (/^[A-Za-z]:$/.test(norm)) return norm
  return norm.split('\\').filter(Boolean).pop() || norm || '本機'
}

function paintTabs() {
  const host = $('exTabStrip')
  if (!host) return
  paintTabStrip({
    host,
    tabs,
    activeId,
    titleOf: tabTitle,
    onSelect: (id) => void switchTab(id),
    onClose: (id) => void closeTab(id)
  })
}

/**
 * @param {string} [target]
 */
async function newTab(target) {
  syncTab()
  const tab = { id: `t${++tabSeq}`, cwd: target || THIS_PC, history: [target || THIS_PC], histIndex: 0 }
  tabs.push(tab)
  activeId = tab.id
  history = tab.history
  histIndex = 0
  cwd = tab.cwd
  entries = []
  selected = new Set()
  endEditPath()
  clearSearchInput()
  paintTabs()
  paintList()
  await loadDir(tab.cwd)
}

async function switchTab(id) {
  if (id === activeId) return
  const tab = tabs.find((t) => t.id === id)
  if (!tab) return
  syncTab()
  activeId = id
  history = tab.history
  histIndex = tab.histIndex
  cwd = tab.cwd
  entries = []
  selected = new Set()
  endEditPath()
  clearSearchInput()
  paintTabs()
  paintList()
  await loadDir(tab.cwd, { silent: true })
}

async function closeTab(id) {
  const i = tabs.findIndex((t) => t.id === id)
  if (i < 0 || tabs.length <= 1) return
  const wasActive = id === activeId
  tabs.splice(i, 1)
  if (!wasActive) {
    paintTabs()
    return
  }
  activeId = ''
  await switchTab(tabs[Math.min(i, tabs.length - 1)].id)
}

/** 「本機」首頁：沒有檔案清單，改畫磁碟卡片。 */
async function loadHome(opts = {}) {
  const seq = ++navSeq
  cwd = THIS_PC
  entries = []
  truncated = false
  selected = new Set()
  anchor = ''
  watching = false
  void electronAPI.explorer.unwatch()
  paintCrumbs()
  paintNav()
  paintSidebar(places, disks)
  paintSortHead()
  paintList()
  paintRecycleChrome()
  syncTab()
  paintTabs()
  if (!opts.silent) void electronAPI.explorer.saveState({ lastPath: THIS_PC, sort: sortBy, sortDesc })
  void electronAPI.explorer.driveInfo().then((fresh) => {
    if (seq !== navSeq) return
    if (fresh && fresh.ok) {
      diskInfo = fresh.data || []
      paintList()
    }
  }).catch(() => {
    if (seq === navSeq) showToast('讀不到磁碟容量', 'error')
  })
  return true
}

function paintHome() {
  const host = $('exHome')
  if (!host) return
  const fallback = disks.map((d) => ({ ...d, label: '', fs: '', type: 3 }))
  paintHomePane({
    host,
    folders: places.filter((p) => {
      const key = pathKey(p.path)
      return key !== THIS_PC && key !== RECYCLE_CWD
    }),
    disks: diskInfo.length ? diskInfo : fallback,
    formatSize,
    onOpen: (target, newPage) => void (newPage ? newTab(target) : navigate(target)),
    bindDrop: (el, target) => bindDropTarget(el, () => target, (event, dest) => void handleDrop(event, dest))
  })
}

async function loadDir(dirPath, opts = {}) {
  if (pathKey(dirPath) === THIS_PC) return loadHome(opts)
  const seq = ++navSeq
  let result
  try {
    result = await electronAPI.explorer.listDir(dirPath, { sort: sortBy, desc: sortDesc })
  } catch {
    result = null
  }
  if (seq !== navSeq) return false
  if (!result?.ok) {
    showToast(result?.error?.message || '讀不到這個資料夾', 'error')
    return false
  }
  const data = result.data
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
  syncTab()
  paintTabs()
  void electronAPI.explorer.watch(cwd).then((watch) => {
    if (seq === navSeq) watching = Boolean(watch?.ok && watch.data?.watching)
  }).catch(() => {
    if (seq === navSeq) watching = false
  })
  if (!opts.silent) void electronAPI.explorer.saveState({ lastPath: cwd, sort: sortBy, sortDesc })
  return true
}

async function navigate(dirPath, opts = {}) {
  const tabId = activeId
  clearSearchInput()
  if (!await loadDir(dirPath) || tabId !== activeId) return
  if (opts.skipHistory) return
  history = history.slice(0, histIndex + 1)
  history.push(cwd)
  histIndex = history.length - 1
  syncTab()
  paintNav()
}

async function goHistory(delta) {
  const next = histIndex + delta
  if (next < 0 || next >= history.length) return
  clearSearchInput()
  const tabId = activeId
  if (!await loadDir(history[next], { silent: true }) || tabId !== activeId) return
  histIndex = next
  syncTab()
  paintNav()
}

async function goUp() {
  if (!cwd || inHome()) return
  if (inRecycle()) {
    await navigate(THIS_PC)
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
  // 磁碟根目錄再往上就是「本機」。
  if (!up || up === cwd) {
    await navigate(THIS_PC)
    return
  }
  await navigate(up)
}

function paintSortHead() {
  const head = $('exListHead')
  if (!head) return
  head.hidden = view === 'grid' || (inHome() && !inSearch())
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
  if (folderBtn) folderBtn.hidden = rec || inHome()
  if (fileBtn) fileBtn.hidden = rec || inHome()
  const up = $('exUpBtn')
  if (up) up.disabled = inHome()
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
  searchSeq++
  if (searchTimer) clearTimeout(searchTimer)
  void electronAPI.explorer.uffsCancel()
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
  searchSeq++
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
    const seq = navSeq
    const data = await call(electronAPI.explorer.openPath(entry.path), '打不開')
    if (data?.dir && seq === navSeq) await navigate(data.path)
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
    lastClip = { mode, paths: items.map((i) => i.path) }
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
  if (!cwd || inHome()) return
  try {
    const done = await call(electronAPI.explorer.paste(cwd), '貼上失敗')
    const landed = (done && done.paths) || []
    if (landed.length && lastClip.paths.length) {
      pushUndo(lastClip.mode === 'cut' ? '搬移' : '複製',
        lastClip.mode === 'cut' ? undoMove(landed, lastClip.paths) : undoCopy(landed))
    }
    await refreshAfterMutate()
  } catch {
    // toast 已顯示
  }
}

async function newFolder() {
  if (inRecycle() || inHome()) return
  const target = cwd
  const name = await askInput('新增資料夾', { placeholder: '資料夾名稱' })
  if (!name) return
  try {
    await call(electronAPI.explorer.createEntry(target, name, true), '建不了資料夾')
    await refreshAfterMutate()
  } catch {
    // toast 已顯示
  }
}

async function newFile() {
  if (inRecycle() || inHome()) return
  const target = cwd
  const name = await askInput('新增檔案', { placeholder: '檔案名稱' })
  if (!name) return
  try {
    await call(electronAPI.explorer.createEntry(target, name, false), '建不了檔案')
    await refreshAfterMutate()
  } catch {
    // toast 已顯示
  }
}

async function renameItem(item) {
  const name = await askInput('重新命名', { value: item.name })
  if (!name || name === item.name) return
  try {
    const done = await call(electronAPI.explorer.renameEntry(item.path, name), '改名失敗')
    if (done && done.path) {
      pushUndo(`改名「${item.name}」`, () => (
        call(electronAPI.explorer.renameEntry(done.path, item.name), '復原失敗')
      ))
    }
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
  const request = ++contextMenuSeq
  const navigation = navSeq
  const at = { x: e.clientX, y: e.clientY }
  const recycle = inRecycle()
  const extended = Boolean(e.shiftKey)
  const folder = cwd
  void (async () => {
    let shellItems = []
    let token = 0
    if (!recycle && folder && folder !== THIS_PC) {
      try {
        const res = await electronAPI.explorer.shellMenu({
          paths: items.map((item) => item.path).filter(Boolean),
          dir: folder,
          extended
        })
        if (res && res.ok && res.data) {
          shellItems = res.data.items || []
          token = Number(res.data.token) || 0
        }
      } catch {
        // sidecar 沒建置就只顯示 App 自己的項目
      }
    }
    if (request !== contextMenuSeq || navigation !== navSeq || !$('page-explorer')?.classList.contains('active')) {
      if (token) void electronAPI.explorer.shellRelease(token)
      return
    }
    showExplorerMenu(at, {
      recycle,
      items,
      shell: shellItems,
      invokeShell: (cmd) => {
        if (!token) return Promise.resolve()
        return electronAPI.explorer.shellInvoke(token, cmd, folder)
      },
      onClose: () => {
        if (token) void electronAPI.explorer.shellRelease(token)
      },
      actions: {
        restore: () => void restoreItems(items),
        purge: () => void deleteItems(items, { permanent: true }),
        empty: () => void emptyBin(),
        open: () => void openEntry(items[0]),
        openTab: () => void newTab(items[0].path),
        reveal: () => void revealItems(items),
        pin: () => void pinEntries(items),
        pinHere: () => void pinPath(cwd, ''),
        openProject: () => void openInWorkspace(items[0]?.path),
        openProjectHere: () => void openInWorkspace(cwd),
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
  })()
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

/**
 * 把這個資料夾加進聊天頁左側欄的專案清單，然後切過去選中它。
 * 虛擬位置（本機首頁、資源回收筒）不是真資料夾，擋掉。
 * @param {string} dirPath
 */
async function openInWorkspace(dirPath) {
  if (!dirPath || [RECYCLE_CWD, THIS_PC].includes(pathKey(dirPath))) return
  const workspace = await import('./workspace-page.js')
  switchPage('chat')
  setSidebarMode('projects')
  await workspace.openFolderAsProject(dirPath)
}

async function pinPath(dirPath, label) {
  if (!dirPath || [RECYCLE_CWD, THIS_PC].includes(pathKey(dirPath))) return
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
    { label: '在新分頁開啟', onSelect: () => void newTab(item.path) },
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

/** DOM 上那一列代表哪一筆（`dataset.id` 在一般資料夾裡只是檔名，對不上 `selected`）。 */
function rowId(row) {
  return (row && (row.dataset.key || row.dataset.path)) || ''
}

/** 方格檢視一列擺得下幾格——欄數跟著視窗寬度變，只能照實際版面量。 */
function gridColumns() {
  const host = $('exList')
  if (!host || !host.classList.contains('is-grid')) return 1
  const rows = [...host.querySelectorAll('.ex-row')]
  if (rows.length < 2) return 1
  const top = rows[0].offsetTop
  let n = 0
  for (const row of rows) {
    if (row.offsetTop !== top) break
    n += 1
  }
  return Math.max(1, n)
}

/**
 * 方向鍵移動選取。游標（`cursor`）跟連選錨點（`anchor`）是兩件事：
 * Shift 連選時錨點要釘在原地，只有游標在走。
 * @param {string} key
 * @param {boolean} extend 有沒有按著 Shift
 */
function moveSelection(key, extend) {
  const rows = listed()
  if (!rows.length) return
  const ids = rows.map((r) => entryId(r))
  const cols = gridColumns()
  const at = ids.indexOf(cursor)
  let next
  if (key === 'Home') next = 0
  else if (key === 'End') next = rows.length - 1
  else {
    const step = key === 'ArrowUp' ? -cols : key === 'ArrowDown' ? cols : key === 'ArrowLeft' ? -1 : 1
    if (at < 0) next = step > 0 ? 0 : rows.length - 1
    else next = at + step
  }
  next = Math.max(0, Math.min(rows.length - 1, next))
  cursor = ids[next]
  if (extend) {
    if (!anchor || !ids.includes(anchor)) anchor = at >= 0 ? ids[at] : cursor
    const lo = Math.min(ids.indexOf(anchor), next)
    const hi = Math.max(ids.indexOf(anchor), next)
    selected = new Set(ids.slice(lo, hi + 1))
  } else {
    anchor = cursor
    selected = new Set([cursor])
  }
  paintList()
  const host = $('exList')
  const row = [...(host ? host.querySelectorAll('.ex-row') : [])].find((el) => rowId(el) === cursor)
  if (row) {
    row.scrollIntoView({ block: 'nearest' })
    if (typeof row.focus === 'function') row.focus({ preventScroll: true })
  }
}

/**
 * 空白處按著拖＝框選（跟檔案總管一樣）。在列上按下是拖檔案，那條走原生拖放，
 * 所以這裡只接「按在空白」的情況。框選期間**不重畫清單**（`paintList` 會把框本身
 * 一起清掉，而且每動一像素重建整份 DOM 太貴），只就地 toggle class，放開才重畫一次。
 */
function onListMouseDown(e) {
  if (e.button !== 0 || e.target.closest('.ex-row')) return
  const host = $('exList')
  if (!host || host.hidden) return
  const startX = e.clientX
  const startY = e.clientY
  const base = e.ctrlKey || e.metaKey ? new Set(selected) : new Set()
  /** @type {HTMLElement | null} */
  let box = null

  const onMove = (ev) => {
    if (!box) {
      if (Math.abs(ev.clientX - startX) < 4 && Math.abs(ev.clientY - startY) < 4) return
      box = document.createElement('div')
      box.className = 'ex-marquee'
      host.appendChild(box)
    }
    const left = Math.min(startX, ev.clientX)
    const top = Math.min(startY, ev.clientY)
    const right = Math.max(startX, ev.clientX)
    const bottom = Math.max(startY, ev.clientY)
    const hostRect = host.getBoundingClientRect()
    box.style.left = `${left - hostRect.left + host.scrollLeft}px`
    box.style.top = `${top - hostRect.top + host.scrollTop}px`
    box.style.width = `${right - left}px`
    box.style.height = `${bottom - top}px`
    const next = new Set(base)
    for (const row of host.querySelectorAll('.ex-row')) {
      const r = row.getBoundingClientRect()
      const hit = r.right >= left && r.left <= right && r.bottom >= top && r.top <= bottom
      if (hit) next.add(rowId(row))
      row.classList.toggle('is-selected', next.has(rowId(row)))
    }
    selected = next
  }

  const onUp = () => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    if (!box) return
    box.remove()
    box = null
    anchor = ''
    cursor = ''
    paintList()
  }

  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

function onListClick(e) {
  if (e.target.closest('.ex-row') || !selected.size) return
  selected = new Set()
  anchor = ''
  cursor = ''
  paintList()
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
  const items = selectedEntries().map((i) => i.path).filter(Boolean)
  if (!items.length) return
  // 交給 Windows 自己的拖放，才拖得進別的程式（瀏覽器上傳框、桌面）。
  // 原生拖放一啟動，HTML5 那條就得讓位：兩邊一起來 Windows 只認先啟動的那個。
  e.preventDefault()
  void electronAPI.explorer.startDrag(items)
}

function onListDragOver(e) {
  if (e.target.closest('.ex-row')) return
  if (!hasExplorerDrag(e)) return
  e.preventDefault()
  setDropEffect(e, e.ctrlKey ? 'copy' : 'move')
}

function onListDrop(e) {
  if (e.target.closest('.ex-row')) return
  void handleDrop(e, cwd)
}

/** 復原堆疊只記「這次操作怎麼倒回去」，不記快照——檔案太大，快照不起。 */
const undoStack = []
const MAX_UNDO = 20

/**
 * @param {string} label 給 toast 用的人話
 * @param {() => Promise<unknown>} fn
 */
function pushUndo(label, fn) {
  undoStack.push({ label, fn })
  while (undoStack.length > MAX_UNDO) undoStack.shift()
}

/** 搬回原處。來源與結果同順序（main 的 `dropEntries`／`paste` 都是逐筆照順序回）。 */
function undoMove(newPaths, oldPaths) {
  return async () => {
    for (let i = 0; i < newPaths.length; i += 1) {
      const back = parentOf(oldPaths[i])
      if (!back) continue
      // eslint-disable-next-line no-await-in-loop
      await call(electronAPI.explorer.dropEntries([newPaths[i]], back, 'move'), '復原失敗')
    }
  }
}

/** 複製出來的東西丟進資源回收筒，不永久刪——復原自己也要能反悔。 */
function undoCopy(newPaths) {
  return () => call(electronAPI.explorer.dropEntries(newPaths, RECYCLE_CWD, 'move'), '復原失敗')
}

async function undoLast() {
  const job = undoStack.pop()
  if (!job) {
    showToast('沒有可以復原的動作')
    return
  }
  try {
    await job.fn()
    await refreshAfterMutate()
    showToast(`已復原：${job.label}`)
  } catch {
    // call() 已經跳過 toast
  }
}

async function handleDrop(e, toDir) {
  e.preventDefault()
  const paths = readDragPaths(e, electronAPI.getPathForFile)
  if (!paths.length || !toDir || pathKey(toDir) === THIS_PC) return
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
      const done = await call(electronAPI.explorer.dropEntries(paths, toDir, mode), '搬不過去')
      const landed = (done && done.paths) || []
      if (landed.length) {
        pushUndo(mode === 'copy' ? '複製' : '搬移',
          mode === 'copy' ? undoCopy(landed) : undoMove(landed, paths))
      }
    }
    await refreshAfterMutate()
  } catch {
    // toast 已顯示
  }
}

function onSideButton(e) {
  if (!$('page-explorer')?.classList.contains('active') || (e.button !== 3 && e.button !== 4)) return
  e.preventDefault()
  e.stopPropagation()
  if (e.type === 'mouseup' && !document.querySelector('.ws-menu, dialog[open]')) void goHistory(e.button === 3 ? -1 : 1)
}

function onPageKey(e) {
  if (!$('page-explorer')?.classList.contains('active')) return
  if (document.querySelector('.ws-menu, dialog[open]')) return
  const key = e.key.toLowerCase()
  if (e.ctrlKey && ['t', 'w', 'tab'].includes(key)) {
    e.preventDefault()
    if (key === 't') void newTab()
    else if (key === 'w') void closeTab(activeId)
    else {
      const i = tabs.findIndex((t) => t.id === activeId)
      void switchTab(tabs[(i + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length]?.id)
    }
    return
  }
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
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) && !e.altKey) {
    // 清單檢視只吃上下：左右留給之後可能的水平操作，方格檢視才四個方向都走
    const grid = $('exList')?.classList.contains('is-grid')
    if (grid || !['ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault()
      moveSelection(e.key, e.shiftKey)
      return
    }
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
  if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault()
    void undoLast()
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

/** 終端機點路徑過來時，先記著，等這一頁啟動完再導過去（避免 bootstrap 寫回上次路徑） */
let pendingOpen = null

/**
 * 終端機畫面上的路徑：資料夾就進這一層，檔案進上一層並選起來。
 * @param {string} full
 * @param {'file' | 'dir'} [kind]
 */
export async function openExplorerPath(full, kind = 'dir') {
  const raw = String(full || '')
  if (!raw) return
  const isFile = kind === 'file'
  const target = isFile ? parentOf(raw) : raw
  pendingOpen = { target, select: isFile ? raw : '' }
  switchPage('explorer')
}

/** @param {string} full */
function parentOf(full) {
  const s = full.replace(/[\\/]+$/, '')
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'))
  if (i <= 0) return s
  const parent = s.slice(0, i)
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent
}

async function consumePendingOpen() {
  const job = pendingOpen
  pendingOpen = null
  if (!job?.target) return
  await navigate(job.target)
  if (!job.select) return
  selected = new Set([job.select])
  anchor = job.select
  paintList()
  const row = [...(document.querySelectorAll('#exList .ex-row') || [])]
    .find((el) => el.dataset.path === job.select)
  row?.scrollIntoView({ block: 'nearest' })
}

export async function refreshExplorerPage() {
  bindOnce()
  const job = pendingOpen
  try {
    const boot = await call(electronAPI.explorer.bootstrap(), '打不開檔案總管')
    view = boot.view === 'grid' ? 'grid' : 'list'
    sortBy = boot.sort === 'date' || boot.sort === 'size' ? boot.sort : 'name'
    sortDesc = boot.sortDesc === true
    places = boot.places || []
    disks = boot.drives || []
    setView(view)
    paintSidebar(places, disks)
    if (!tabs.length) await newTab(boot.lastPath || THIS_PC)
    else if (!job) await loadDir(cwd, { silent: true, keepSelection: true })
  } catch {
    // toast 已顯示
  }
  if (job) await consumePendingOpen()
  void ensureUffs()
}

export function cooldownExplorerPage() {
  searchSeq++
  navSeq++
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
