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
import { clearFileIconWork, paintFileIcons } from './explorer-icons.js'
import { openImageViewer, imageViewerOpen } from './image-viewer.js'
import { openPreview as openFilePreview, closePreview as closeFilePreview, previewKind, previewOpen } from './explorer-preview.js'
import { mountExplorerOperations } from './explorer-operations.js'
import { nextZoomState } from './explorer-zoom.js'
import {
  BROWSE_PAGE_SIZE as BROWSE_PAGE_SIZE_IMPORT,
  normalizeBrowseState as normalizeBrowseStateImport,
  normalizeBrowseTab as normalizeBrowseTabImport,
  mergeBrowsePage as mergeBrowsePageImport,
  visibleBrowseRange as visibleBrowseRangeImport,
  pageOffsetsForRange as pageOffsetsForRangeImport,
  selectBrowseRange as selectBrowseRangeImport
} from './explorer-browse.js'
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
const TILE_SIZES = [48, 64, 96, 128, 180, 256]
const DEFAULT_TILE = 96
const BROWSE_PAGE_SIZE = typeof BROWSE_PAGE_SIZE_IMPORT === 'number' ? BROWSE_PAGE_SIZE_IMPORT : 500

function normalizeBrowseState(raw = {}) {
  if (typeof normalizeBrowseStateImport === 'function') return normalizeBrowseStateImport(raw)
  const value = raw && typeof raw === 'object' ? raw : {}
  return {
    view: value.view === 'grid' ? 'grid' : 'list',
    tile: Number(value.tile) || DEFAULT_TILE,
    sort: ['date', 'size'].includes(value.sort) ? value.sort : 'name',
    sortDesc: value.sortDesc === true,
    showHidden: value.showHidden === true,
    search: String(value.search || '').trim(),
    searchSort: value.searchSort || 'rank',
    searchFilters: value.searchFilters || {},
    selected: Array.isArray(value.selected) ? value.selected : [],
    anchor: String(value.anchor || ''),
    cursor: String(value.cursor || ''),
    scrollTop: Number(value.scrollTop) || 0,
    scrollLeft: Number(value.scrollLeft) || 0
  }
}

function normalizeBrowseTab(raw = {}, fallbackId = 't1') {
  const value = raw && typeof raw === 'object' ? raw : {}
  const stateValue = value.state && typeof value.state === 'object' ? value.state : value
  const rightRaw = value.rightPane || stateValue.rightPane
  if (typeof normalizeBrowseTabImport === 'function') {
    const normalized = normalizeBrowseTabImport(raw, fallbackId)
    return {
      ...normalized,
      state: rightRaw
        ? { ...normalized.state, rightPane: normalizeRightPaneState(rightRaw) }
        : normalized.state
    }
  }
  return {
    id: value.id || fallbackId,
    cwd: value.cwd || THIS_PC,
    history: Array.isArray(value.history) && value.history.length ? value.history : [value.cwd || THIS_PC],
    histIndex: Number(value.histIndex) || 0,
    state: {
      ...normalizeBrowseState(stateValue),
      ...(rightRaw ? { rightPane: normalizeRightPaneState(rightRaw) } : {})
    }
  }
}

function mergeBrowsePage(current, page, fallbackOffset = 0) {
  if (typeof mergeBrowsePageImport === 'function') return mergeBrowsePageImport(current, page, fallbackOffset)
  const value = page && typeof page === 'object' ? page : {}
  const offset = Number(value.offset) || fallbackOffset
  const source = Array.isArray(current) ? current.slice() : []
  const list = Array.isArray(value.entries) ? value.entries : []
  const total = Math.max(source.length, offset + list.length, Number(value.total) || 0)
  source.length = total
  list.forEach((entry, index) => { source[offset + index] = entry })
  return { entries: source, total, loaded: list.length }
}

function visibleBrowseRange(options = {}) {
  if (typeof visibleBrowseRangeImport === 'function') return visibleBrowseRangeImport(options)
  const total = Math.max(0, Number(options.total) || 0)
  const rowHeight = Number(options.rowHeight) || 34
  const start = Math.max(0, Math.floor((Number(options.scrollTop) || 0) / rowHeight) - 12)
  const end = Math.min(total, Math.ceil(((Number(options.scrollTop) || 0) + (Number(options.viewportHeight) || 600)) / rowHeight) + 12)
  return { start, end, before: start * rowHeight, after: Math.max(0, total - end) * rowHeight }
}

function pageOffsetsForRange(start, end, pageSize = BROWSE_PAGE_SIZE) {
  if (typeof pageOffsetsForRangeImport === 'function') return pageOffsetsForRangeImport(start, end, pageSize)
  const first = Math.floor(Math.max(0, Number(start) || 0) / pageSize) * pageSize
  const last = Math.max(first, Math.ceil(Math.max(0, Number(end) || 0) / pageSize) * pageSize)
  const out = []
  for (let offset = first; offset < last; offset += pageSize) out.push(offset)
  return out
}

function selectBrowseRange(rows, anchorId, targetId, selected = [], additive = false) {
  if (typeof selectBrowseRangeImport === 'function') {
    return selectBrowseRangeImport(rows, anchorId, targetId, selected, additive)
  }
  const list = (Array.isArray(rows) ? rows : []).filter(Boolean)
  const ids = list.map((entry) => entry.recycleKey || entry.path || entry.name)
  const first = ids.indexOf(anchorId)
  const last = ids.indexOf(targetId)
  if (first < 0 || last < 0) return [...new Set(selected)]
  const next = new Set(additive ? selected : [])
  for (const id of ids.slice(Math.min(first, last), Math.max(first, last) + 1)) next.add(id)
  return [...next]
}

function normalizeRightPaneState(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const history = Array.isArray(value.history) && value.history.length
    ? value.history.filter((item) => typeof item === 'string' && item).slice(0, 64)
    : [value.cwd || THIS_PC]
  const cwd = typeof value.cwd === 'string' && value.cwd ? value.cwd : THIS_PC
  return {
    cwd,
    history,
    histIndex: Math.max(0, Math.min(history.length - 1, Number(value.histIndex) | 0)),
    search: String(value.search || '').trim().slice(0, 200),
    sortBy: value.sortBy === 'date' || value.sortBy === 'size' ? value.sortBy : 'name',
    sortDesc: value.sortDesc === true,
    selected: Array.isArray(value.selected) ? value.selected.filter(Boolean).slice(0, 10000) : [],
    anchor: String(value.anchor || ''),
    scrollTop: Math.max(0, Number(value.scrollTop) || 0),
    scrollLeft: Math.max(0, Number(value.scrollLeft) || 0)
  }
}
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg'])

let started = false
let cwd = ''
let view = 'list'
/** 目前的方格圖示大小（Ctrl+滾輪改它，存進 `explorer.json`） */
let tile = DEFAULT_TILE
let sortBy = 'name'
let sortDesc = false
/** 要不要把隱藏／系統項目也列出來（跟檔案總管的「顯示隱藏的項目」同一件事）*/
let showHidden = false
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
let directoryTotal = 0
let loadedOffsets = new Set()
let pageRequestSeq = 0
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
/** @type {(() => void) | null} */
let disposeOperations = null
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
/** 右欄是獨立狀態；左欄沿用上面的既有單欄流程。 */
const secondPane = {
  cwd: THIS_PC,
  history: [THIS_PC],
  histIndex: 0,
  entries: [],
  total: 0,
  loadedOffsets: new Set(),
  pendingOffsets: new Set(),
  selected: new Set(),
  anchor: '',
  search: '',
  sortBy: 'name',
  sortDesc: false,
  scrollTop: 0,
  scrollLeft: 0,
  loading: false,
  seq: 0
}
let dualPane = false
let virtualPaintTimer = 0
let secondVirtualTimer = 0
const paneStates = new Map()
let restoreSearch = ''
let restoreScrollTop = 0

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
  disposeOperations = mountExplorerOperations({ root: $('page-explorer'), api: electronAPI.explorer })
  $('exTabAddBtn')?.addEventListener('click', () => void newTab())
  $('exBackBtn')?.addEventListener('click', () => goHistory(-1))
  $('exForwardBtn')?.addEventListener('click', () => goHistory(1))
  $('exUpBtn')?.addEventListener('click', goUp)
  $('exNewFolderBtn')?.addEventListener('click', newFolder)
  $('exNewFileBtn')?.addEventListener('click', newFile)
  $('exEmptyBinBtn')?.addEventListener('click', () => void emptyBin())
  $('exViewListBtn')?.addEventListener('click', () => setView('list'))
  $('exViewGridBtn')?.addEventListener('click', () => setView('grid'))
  $('exDualBtn')?.addEventListener('click', () => void toggleDualPane())
  $('exDetailToggleBtn')?.addEventListener('click', toggleDetailPane)
  $('exListHead')?.addEventListener('click', onSortClick)
  $('exList')?.addEventListener('mousedown', onListMouseDown)
  $('exList')?.addEventListener('click', onListClick)
  $('exList')?.addEventListener('contextmenu', onListContext)
  $('exList')?.addEventListener('dragover', onListDragOver)
  $('exList')?.addEventListener('drop', onListDrop)
  $('exList')?.addEventListener('dragleave', clearDrop)
  // Ctrl+滾輪換圖示大小。`passive: false` 不能省——預設的 wheel 監聽是被動的，
  // `preventDefault()` 會被忽略，畫面就變成整頁縮放（側欄跟著一起縮）。
  $('exList')?.addEventListener('wheel', onListWheel, { passive: false })
  $('exList')?.addEventListener('scroll', onListScroll, { passive: true })
  $('exSearch')?.addEventListener('input', onSearchInput)
  for (const id of ['exSearchType', 'exSearchMinSize', 'exSearchMaxSize', 'exSearchFrom', 'exSearchTo', 'exSearchLocation']) {
    $(id)?.addEventListener('input', onSearchFilterChange)
    $(id)?.addEventListener('change', onSearchFilterChange)
  }
  $('exSecondBack')?.addEventListener('click', () => void secondHistory(-1))
  $('exSecondForward')?.addEventListener('click', () => void secondHistory(1))
  $('exSecondUp')?.addEventListener('click', () => void secondGoUp())
  $('exSecondPath')?.addEventListener('click', () => void secondChoosePath())
  $('exSecondSearch')?.addEventListener('input', (e) => {
    secondPane.search = String(e.target.value || '')
    saveSecondPaneState()
    paintSecondPane()
  })
  $('exSecondSort')?.addEventListener('change', (e) => {
    secondPane.sortBy = e.target.value === 'date' || e.target.value === 'size' ? e.target.value : 'name'
    saveSecondPaneState()
    void loadSecond(secondPane.cwd, { pushHistory: false })
  })
  $('exSecondSortDir')?.addEventListener('click', () => {
    secondPane.sortDesc = !secondPane.sortDesc
    saveSecondPaneState()
    void loadSecond(secondPane.cwd, { pushHistory: false })
  })
  $('exSecondList')?.addEventListener('scroll', () => {
    const list = $('exSecondList')
    if (list) {
      secondPane.scrollTop = list.scrollTop
      secondPane.scrollLeft = list.scrollLeft
    }
    saveSecondPaneState()
    if (!secondVirtualTimer && secondPane.entries.length > 250) {
      secondVirtualTimer = window.setTimeout(() => {
        secondVirtualTimer = 0
        void loadSecondVisiblePages()
      }, 40)
    }
  }, { passive: true })
  $('exSecondList')?.addEventListener('click', onSecondListClick)
  $('exSecondList')?.addEventListener('dblclick', (e) => void onSecondDoubleClick(e))
  $('exCopyToSecond')?.addEventListener('click', () => void copyBetweenPanes('left-to-right', 'copy'))
  $('exMoveToSecond')?.addEventListener('click', () => void copyBetweenPanes('left-to-right', 'move'))
  $('exCopyFromSecond')?.addEventListener('click', () => void copyBetweenPanes('right-to-left', 'copy'))
  $('exMoveFromSecond')?.addEventListener('click', () => void copyBetweenPanes('right-to-left', 'move'))
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
    if (!payload) return
    if (payload.path === cwd && !inSearch()) void loadDir(cwd, { silent: true, keepSelection: true })
    if (dualPane && payload.path === secondPane.cwd) void loadSecond(secondPane.cwd, { pushHistory: false, keepSelection: true })
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
  applyTile()
  paintSortHead()
  void electronAPI.explorer.saveState({ view })
  syncTab()
  persistTabs()
}

/**
 * 把目前的圖示大小寫上去：CSS 變數給版面（格子寬度、字級、留白都是從它算的），
 * `data-tile` 給 `explorer-icons.js` 決定要跟殼層要多大的縮圖。
 */
function applyTile() {
  const host = $('exList')
  if (!host) return
  host.style.setProperty('--ex-tile', `${tile}px`)
  host.dataset.tile = String(tile)
}

/**
 * Ctrl+滾輪：跟檔案總管一樣一級一級換大小。級距在 `explorer-zoom.js`
 * （清單 → 小圖示 → … → 特大圖示），所以在最小的方格往下滾會掉回清單檢視、
 * 在清單往上滾會跳進最小的方格——不用先去按檢視鈕。
 *
 * @param {number} delta 滾輪方向：負的是往上滾（放大）
 */
function stepZoom(delta) {
  const next = nextZoomState({ view, tile }, delta)
  if (next.view === view && next.tile === tile) return
  const sameView = next.view === view
  tile = next.tile
  if (!sameView) {
    // `setView` 自己會把新的 `--ex-tile` 寫進去
    setView(next.view)
  } else {
    applyTile()
  }
  void electronAPI.explorer.saveState({ tile, view: next.view })
  // 圖示變大就得跟殼層要一張更大的縮圖，不然放大只是把 96px 那張拉糊。
  paintList()
}

/** @param {WheelEvent} e */
function onListWheel(e) {
  if (!e.ctrlKey || e.altKey || e.metaKey) return
  // 不擋的話 Chromium 會把整個畫面縮放（連側欄、工具列一起變小）
  e.preventDefault()
  stepZoom(e.deltaY)
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
  // replaceChildren() 會把 scrollTop 清成 0，所以要先把位置記下來再重畫。
  const scrollTop = host.scrollTop
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
  const canVirtualize = !inSearch() && rows.length > 250
  if (canVirtualize) {
    const range = visibleBrowseRange({
      total: rows.length,
      scrollTop,
      viewportHeight: host.clientHeight || 600,
      rowHeight: 34,
      overscan: 14
    })
    const before = document.createElement('div')
    before.className = 'ex-virtual-spacer'
    before.style.height = `${range.before}px`
    host.appendChild(before)
    for (let i = range.start; i < range.end; i += 1) {
      const entry = rows[i]
      if (entry) host.appendChild(rowEl(entry))
    }
    const after = document.createElement('div')
    after.className = 'ex-virtual-spacer'
    after.style.height = `${range.after}px`
    host.appendChild(after)
    host.scrollTop = scrollTop
  } else {
    for (const entry of rows) host.appendChild(rowEl(entry))
  }
  paintFileIcons(host, (target) => electronAPI.explorer.fileIcon(target))
  paintStatus()
  paintCmdBar()
  paintDetail()
  focusSelectedRow()
}

function toggleDetailPane() {
  const detail = $('exDetail')
  const button = $('exDetailToggleBtn')
  if (!detail || !button) return
  const collapsed = detail.classList.toggle('is-collapsed')
  button.setAttribute('aria-pressed', collapsed ? 'false' : 'true')
  button.textContent = collapsed ? '顯示詳情' : '收合詳情'
}

function onListScroll() {
  const host = $('exList')
  if (!host || inSearch() || entries.length <= 250 || virtualPaintTimer) return
  syncTab()
  persistTabs()
  virtualPaintTimer = window.setTimeout(() => {
    virtualPaintTimer = 0
    void loadVisiblePages()
  }, 40)
}

function secondRows() {
  const query = secondPane.search.trim().toLocaleLowerCase()
  if (!query) return secondPane.entries
  return secondPane.entries.filter((entry) => (
    String(entry.name || '').toLocaleLowerCase().includes(query)
  ))
}

function secondPathLabel() {
  if (pathKey(secondPane.cwd) === THIS_PC) return '本機'
  if (pathKey(secondPane.cwd) === RECYCLE_CWD) return '資源回收筒'
  return secondPane.cwd || '本機'
}

function paneStateKey(tabId = activeId) {
  return `${tabId || 'default'}:right`
}

function rightPaneSnapshot(state = secondPane) {
  return {
    cwd: state.cwd,
    history: [...state.history],
    histIndex: state.histIndex,
    selected: [...state.selected],
    anchor: state.anchor,
    search: state.search,
    sortBy: state.sortBy,
    sortDesc: state.sortDesc,
    scrollTop: state.scrollTop,
    scrollLeft: state.scrollLeft || 0
  }
}

function saveSecondPaneState() {
  // 雙欄沒開過就沒有右欄狀態可存；先存了預設值，下次按「雙欄」會還原成空的本機。
  if (!dualPane) return
  const snapshot = rightPaneSnapshot()
  paneStates.set(paneStateKey(), {
    cwd: secondPane.cwd,
    history: [...secondPane.history],
    histIndex: secondPane.histIndex,
    entries: [...secondPane.entries],
    total: secondPane.total,
    loadedOffsets: new Set(secondPane.loadedOffsets),
    selected: [...secondPane.selected],
    anchor: secondPane.anchor,
    search: secondPane.search,
    sortBy: secondPane.sortBy,
    sortDesc: secondPane.sortDesc,
    scrollTop: secondPane.scrollTop,
    scrollLeft: secondPane.scrollLeft
  })
  const tab = currentTab()
  if (tab) {
    tab.state = {
      ...normalizeBrowseState(tab.state || tab),
      rightPane: snapshot
    }
  }
}

function restoreSecondPaneState() {
  const state = paneStates.get(paneStateKey())
  if (!state) return false
  secondPane.cwd = state.cwd
  secondPane.history = [...state.history]
  secondPane.histIndex = state.histIndex
  secondPane.entries = [...state.entries]
  secondPane.total = state.total
  secondPane.loadedOffsets = new Set(state.loadedOffsets)
  secondPane.selected = new Set(state.selected)
  secondPane.anchor = state.anchor
  secondPane.search = state.search
  secondPane.sortBy = state.sortBy
  secondPane.sortDesc = state.sortDesc
  secondPane.scrollTop = state.scrollTop
  secondPane.scrollLeft = state.scrollLeft || 0
  secondPane.pendingOffsets = new Set()
  secondPane.seq += 1
  return true
}

function paintSecondPane() {
  const pane = $('exSecondPane')
  const list = $('exSecondList')
  if (!pane || !list) return
  pane.hidden = !dualPane
  if (!dualPane) return
  const pathButton = $('exSecondPath')
  if (pathButton) pathButton.textContent = secondPathLabel()
  const back = $('exSecondBack')
  const forward = $('exSecondForward')
  if (back) back.disabled = secondPane.histIndex <= 0 || secondPane.loading
  if (forward) forward.disabled = secondPane.histIndex >= secondPane.history.length - 1 || secondPane.loading
  const up = $('exSecondUp')
  if (up) up.disabled = pathKey(secondPane.cwd) === THIS_PC || secondPane.loading
  const search = /** @type {HTMLInputElement | null} */ ($('exSecondSearch'))
  if (search && search.value !== secondPane.search) search.value = secondPane.search
  const sort = /** @type {HTMLSelectElement | null} */ ($('exSecondSort'))
  if (sort && sort.value !== secondPane.sortBy) sort.value = secondPane.sortBy
  const sortDir = $('exSecondSortDir')
  if (sortDir) sortDir.textContent = secondPane.sortDesc ? '↓' : '↑'
  const scrollTop = secondPane.scrollTop
  const scrollLeft = secondPane.scrollLeft || 0
  list.replaceChildren()
  const rows = secondRows()
  const virtual = rows.length > 250
  const range = virtual ? visibleBrowseRange({
    total: rows.length,
    scrollTop,
    viewportHeight: list.clientHeight || 500,
    rowHeight: 34,
    overscan: 14
  }) : { start: 0, end: rows.length, before: 0, after: 0 }
  if (virtual) {
    const before = document.createElement('div')
    before.className = 'ex-virtual-spacer'
    before.style.height = `${range.before}px`
    list.appendChild(before)
  }
  for (let i = range.start; i < range.end; i += 1) {
    const entry = rows[i]
    if (entry) list.appendChild(secondRowEl(entry))
  }
  if (virtual) {
    const after = document.createElement('div')
    after.className = 'ex-virtual-spacer'
    after.style.height = `${range.after}px`
    list.appendChild(after)
  }
  const empty = $('exSecondEmpty')
  if (empty) {
    empty.hidden = rows.length > 0
    empty.textContent = secondPane.search ? '沒有符合的檔案' : '這個資料夾是空的'
  }
  const selectedIds = new Set([...secondPane.selected])
  secondPane.selected = new Set(rows.map((item) => item.path).filter((id) => selectedIds.has(id)))
  for (const row of list.querySelectorAll('.ex-row')) {
    row.classList.toggle('is-selected', secondPane.selected.has(row.dataset.path))
  }
  list.scrollTop = scrollTop
  list.scrollLeft = scrollLeft
}

function refreshExplorerWatches() {
  const dirs = [cwd]
  if (dualPane && secondPane.cwd && pathKey(secondPane.cwd) !== THIS_PC) dirs.push(secondPane.cwd)
  if (typeof electronAPI.explorer.watchDirs === 'function') {
    void electronAPI.explorer.watchDirs(dirs)
  } else if (cwd && !inHome() && !inRecycle()) {
    void electronAPI.explorer.watch(cwd)
  }
}

function secondRowEl(entry) {
  const row = document.createElement('div')
  row.className = 'ex-row'
  row.dataset.path = entry.path
  row.dataset.name = entry.name
  row.setAttribute('role', 'option')
  row.tabIndex = -1
  row.classList.toggle('is-selected', secondPane.selected.has(entry.path))
  const name = document.createElement('div')
  name.className = 'ex-row-name'
  const icon = document.createElement('span')
  icon.className = 'ex-row-icon'
  icon.textContent = iconFor(entry)
  icon.setAttribute('aria-hidden', 'true')
  const label = document.createElement('span')
  label.className = 'ex-row-label'
  label.textContent = entry.name
  label.title = entry.name
  name.append(icon, label)
  const size = document.createElement('div')
  size.className = 'ex-row-size'
  size.textContent = entry.dir ? '—' : formatSize(entry.size)
  const mtime = document.createElement('div')
  mtime.className = 'ex-row-mtime'
  mtime.textContent = formatTime(entry.mtimeMs)
  row.append(name, size, mtime)
  return row
}

async function loadSecondVisiblePages() {
  if (!dualPane || pathKey(secondPane.cwd) === THIS_PC || !secondPane.entries.length) return
  const list = $('exSecondList')
  if (!list) return
  const range = visibleBrowseRange({
    total: secondPane.total || secondPane.entries.length,
    scrollTop: list.scrollTop,
    viewportHeight: list.clientHeight || 500,
    rowHeight: 34,
    overscan: 18
  })
  const offsets = pageOffsetsForRange(range.start, range.end, BROWSE_PAGE_SIZE)
  const pending = offsets.filter((offset) => !secondPane.loadedOffsets.has(offset)
    && !secondPane.pendingOffsets.has(offset))
  if (!pending.length) return
  pending.forEach((offset) => secondPane.pendingOffsets.add(offset))
  const seq = secondPane.seq
  await Promise.all(pending.map(async (offset) => {
    try {
      const data = await listDirectoryPage(secondPane.cwd, {
        sort: secondPane.sortBy,
        desc: secondPane.sortDesc,
        showHidden
      }, offset)
      if (seq !== secondPane.seq || pathKey(data.path) !== pathKey(secondPane.cwd)) return
      secondPane.entries = mergeBrowsePage(secondPane.entries, data, offset).entries
      secondPane.total = Math.max(secondPane.total, Number(data.total) || secondPane.entries.length)
      secondPane.loadedOffsets.add(offset)
    } catch {
      // 下一次捲動可以重試
    } finally {
      secondPane.pendingOffsets.delete(offset)
    }
  }))
  if (seq === secondPane.seq) {
    saveSecondPaneState()
    paintSecondPane()
  }
}

async function loadSecond(dirPath, opts = {}) {
  const seq = ++secondPane.seq
  secondPane.loading = true
  paintSecondPane()
  if (pathKey(dirPath) === THIS_PC) {
    secondPane.cwd = THIS_PC
    secondPane.entries = []
    secondPane.total = 0
    secondPane.loadedOffsets = new Set()
    secondPane.pendingOffsets = new Set()
  } else {
    let data
    try {
      data = await listDirectoryPage(dirPath, {
        sort: secondPane.sortBy,
        desc: secondPane.sortDesc,
        showHidden
      }, 0)
    } catch {
      data = null
    }
    if (seq !== secondPane.seq) return false
    if (!data) {
      showToast('右欄讀不到這個資料夾', 'error')
      secondPane.loading = false
      paintSecondPane()
      return false
    }
    secondPane.cwd = data.path
    secondPane.entries = mergeBrowsePage([], data, 0).entries
    secondPane.total = Number(data.total) || secondPane.entries.filter(Boolean).length
    secondPane.loadedOffsets = new Set([Number(data.offset) || 0])
    secondPane.pendingOffsets = new Set()
  }
  if (!opts.keepSelection) {
    secondPane.selected = new Set()
    secondPane.anchor = ''
  } else {
    const live = new Set(secondPane.entries.map((entry) => entry.path))
    secondPane.selected = new Set([...secondPane.selected].filter((id) => live.has(id)))
    if (secondPane.anchor && !live.has(secondPane.anchor)) secondPane.anchor = ''
  }
  secondPane.loading = false
  paintSecondPane()
  if (opts.pushHistory !== false) {
    secondPane.history = secondPane.history.slice(0, secondPane.histIndex + 1)
    if (pathKey(secondPane.history.at(-1)) !== pathKey(secondPane.cwd)) secondPane.history.push(secondPane.cwd)
    secondPane.histIndex = secondPane.history.length - 1
  }
  saveSecondPaneState()
  refreshExplorerWatches()
  return true
}

async function secondNavigate(dirPath) {
  if (!dualPane) return
  await loadSecond(dirPath)
}

async function secondHistory(delta) {
  const next = secondPane.histIndex + delta
  if (next < 0 || next >= secondPane.history.length) return
  secondPane.histIndex = next
  await loadSecond(secondPane.history[next], { pushHistory: false })
}

async function secondGoUp() {
  if (!secondPane.cwd || pathKey(secondPane.cwd) === THIS_PC) return
  if (/^[A-Za-z]:\\?$/.test(secondPane.cwd)) {
    await secondNavigate(THIS_PC)
    return
  }
  if (secondPane.cwd.startsWith('\\\\')) {
    const parts = secondPane.cwd.replace(/\\+$/, '').replace(/^\\\\/, '').split('\\').filter(Boolean)
    if (parts.length <= 2) {
      await secondNavigate(THIS_PC)
      return
    }
  }
  await secondNavigate(parentOf(secondPane.cwd) || THIS_PC)
}

async function secondChoosePath() {
  const value = await askInput('右欄路徑', { value: secondPane.cwd === THIS_PC ? '本機' : secondPane.cwd })
  if (!value) return
  try {
    const resolved = await call(electronAPI.explorer.resolvePath(value), '找不到這個路徑')
    await secondNavigate(resolved.dir ? resolved.path : resolved.parent)
  } catch {
    // toast 已顯示
  }
}

function onSecondListClick(event) {
  const row = event.target.closest('.ex-row')
  if (!row) return
  const id = row.dataset.path
  if (!id) return
  if (event.shiftKey && secondPane.anchor) {
    secondPane.selected = new Set(selectBrowseRange(
      secondRows(), secondPane.anchor, id, [...secondPane.selected], false
    ))
  } else if (event.ctrlKey || event.metaKey) {
    if (secondPane.selected.has(id)) secondPane.selected.delete(id)
    else secondPane.selected.add(id)
    secondPane.anchor = id
  } else {
    secondPane.selected = new Set([id])
    secondPane.anchor = id
  }
  paintSecondPane()
  saveSecondPaneState()
}

async function onSecondDoubleClick(event) {
  const row = event.target.closest('.ex-row')
  const entry = secondRows().find((item) => item.path === row?.dataset.path)
  if (!entry) return
  if (entry.dir) {
    await secondNavigate(entry.path)
    return
  }
  try {
    const result = await call(electronAPI.explorer.openPath(entry.path), '打不開')
    if (result?.dir) await secondNavigate(result.path)
  } catch {
    // toast 已顯示
  }
}

async function copyBetweenPanes(direction, mode) {
  const fromRight = direction === 'right-to-left'
  const items = fromRight
    ? secondRows().filter((entry) => secondPane.selected.has(entry.path))
    : selectedEntries()
  const target = fromRight ? cwd : secondPane.cwd
  if (!items.length || !target || pathKey(target) === THIS_PC) return
  try {
    const done = await call(
      electronAPI.explorer.dropEntries(items.map((item) => item.path), target, mode),
      mode === 'copy' ? '複製失敗' : '搬移失敗'
    )
    if (done?.paths?.length) showToast(mode === 'copy' ? `已複製 ${done.paths.length} 個項目` : `已搬移 ${done.paths.length} 個項目`)
    if (fromRight) {
      await loadSecond(secondPane.cwd, { pushHistory: false })
      await loadDir(cwd, { silent: true, keepSelection: true })
    } else {
      await refreshAfterMutate()
      await loadSecond(secondPane.cwd, { pushHistory: false })
    }
  } catch {
    // toast 已顯示
  }
}

async function toggleDualPane() {
  if (dualPane) {
    saveSecondPaneState()
    persistTabs()
  }
  dualPane = !dualPane
  const button = $('exDualBtn')
  if (button) button.setAttribute('aria-pressed', dualPane ? 'true' : 'false')
  if (!dualPane) {
    const pane = $('exSecondPane')
    if (pane) pane.hidden = true
    refreshExplorerWatches()
    return
  }
  const restored = paneStates.has(paneStateKey())
  if (restored) {
    restoreSecondPaneState()
  } else {
    secondPane.cwd = inHome() ? (disks[0]?.path || THIS_PC) : cwd
    secondPane.history = [secondPane.cwd]
    secondPane.histIndex = 0
    secondPane.search = ''
    secondPane.selected = new Set()
  }
  await loadSecond(secondPane.cwd, { pushHistory: false, keepSelection: restored })
  paintSecondPane()
  persistTabs()
  refreshExplorerWatches()
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
  if (entry.hidden) row.classList.add('is-dim')
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
  label.className = 'ex-row-label'
  label.textContent = inSearch() ? entry.path : entry.name
  // 方格檢視的檔名只畫得下兩行，滑過去要看得到完整的那一條
  label.title = inSearch() ? entry.path : entry.name
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
    selected = new Set(selectBrowseRange(rows, anchor, id, selected, e.ctrlKey || e.metaKey))
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
  syncTab()
  persistTabs()
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
  const total = directoryTotal || rows.filter(Boolean).length
  el.textContent = `${total} 個項目 · ${dirs} 個資料夾${extra}${picks}`
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
    formatTime,
    // 側欄那張小預覽點下去＝開大預覽（游標也會變成放大鏡）
    onPreviewClick: isPreviewable(items[0]) ? () => openPreview(items[0]) : null
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
  addCmd(bar, '批次改名', () => void batchRenameItems(items), { disabled: items.length < 2 })
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
  tab.state = normalizeBrowseState({
    view,
    tile,
    sort: sortBy,
    sortDesc,
    showHidden,
    search: $('exSearch')?.value || '',
    searchSort,
    searchFilters: searchFilters(),
    selected: [...selected],
    anchor,
    cursor,
    scrollTop: $('exList')?.scrollTop || 0,
    scrollLeft: $('exList')?.scrollLeft || 0
  })
}

function persistTabs() {
  if (!tabs.length || !activeId) return
  syncTab()
  if (dualPane) saveSecondPaneState()
  void electronAPI.explorer.saveState({
    tabs: tabs.map((tab) => ({
      id: tab.id,
      cwd: tab.cwd,
      history: tab.history,
      histIndex: tab.histIndex,
      state: tab.state || {}
    })),
    activeTabId: activeId,
    lastPath: cwd,
    view,
    tile,
    sort: sortBy,
    sortDesc,
    showHidden,
    dualPane
  })
}

function applyTabState(tab) {
  const raw = tab?.state || tab || {}
  const state = normalizeBrowseState(raw)
  view = state.view
  tile = state.tile
  sortBy = state.sort
  sortDesc = state.sortDesc
  showHidden = state.showHidden
  searchSort = state.searchSort
  selected = new Set(state.selected)
  anchor = state.anchor
  cursor = state.cursor
  restoreSearch = state.search
  restoreScrollTop = state.scrollTop
  const type = /** @type {HTMLSelectElement | null} */ ($('exSearchType'))
  if (type) type.value = state.searchFilters?.type || 'all'
  for (const [id, value] of [
    ['exSearchMinSize', state.searchFilters?.minSize],
    ['exSearchMaxSize', state.searchFilters?.maxSize],
    ['exSearchFrom', state.searchFilters?.fromMs ? new Date(state.searchFilters.fromMs).toISOString().slice(0, 10) : ''],
    ['exSearchTo', state.searchFilters?.toMs ? new Date(state.searchFilters.toMs).toISOString().slice(0, 10) : ''],
    ['exSearchLocation', state.searchFilters?.location || '']
  ]) {
    const input = $(id)
    if (input) input.value = value == null ? '' : String(value)
  }
  const rightRaw = raw.rightPane || tab?.rightPane
  if (rightRaw) {
    const right = normalizeRightPaneState(rightRaw)
    paneStates.set(paneStateKey(), {
      ...right,
      entries: [],
      total: 0,
      loadedOffsets: new Set(),
      pendingOffsets: new Set(),
      loading: false,
      seq: 0
    })
  }
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
  saveSecondPaneState()
  const tab = normalizeBrowseTab({
    id: `t${++tabSeq}`,
    cwd: target || THIS_PC,
    history: [target || THIS_PC],
    histIndex: 0,
    state: { view, tile, sort: sortBy, sortDesc, showHidden }
  }, `t${tabSeq}`)
  tabs.push(tab)
  activeId = tab.id
  history = tab.history
  histIndex = 0
  cwd = tab.cwd
  entries = []
  selected = new Set()
  anchor = ''
  restoreSearch = ''
  restoreScrollTop = 0
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
  saveSecondPaneState()
  activeId = id
  history = tab.history
  histIndex = tab.histIndex
  cwd = tab.cwd
  applyTabState(tab)
  restoreSecondPaneState()
  entries = []
  selected = new Set(selected)
  endEditPath()
  clearSearchInput()
  restoreSearch = normalizeBrowseState(tab.state || {}).search
  paintTabs()
  paintList()
  // 這裡不能讓 loadDir 清掉剛從 tab 還原回來的選取。
  await loadDir(tab.cwd, { silent: true, keepSelection: true })
}

async function closeTab(id) {
  const i = tabs.findIndex((t) => t.id === id)
  if (i < 0 || tabs.length <= 1) return
  const wasActive = id === activeId
  tabs.splice(i, 1)
  paneStates.delete(paneStateKey(id))
  if (!wasActive) {
    paintTabs()
    persistTabs()
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
  directoryTotal = 0
  loadedOffsets = new Set()
  pageRequestSeq += 1
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
  if (dualPane) refreshExplorerWatches()
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

/** @param {string} dirPath @param {object} options @param {number} offset */
async function listDirectoryPage(dirPath, options, offset = 0) {
  // 舊入口契約：listDir(dirPath, { sort: sortBy, desc: sortDesc, showHidden })；分頁只在同一組選項上加 offset。
  return call(
    electronAPI.explorer.listDir(dirPath, { ...options, offset, limit: BROWSE_PAGE_SIZE }),
    '讀不到這個資料夾'
  )
}

async function loadVisiblePages() {
  if (inHome() || inSearch() || !entries.length) return
  const host = $('exList')
  if (!host) return
  const range = visibleBrowseRange({
    total: directoryTotal || entries.length,
    scrollTop: host.scrollTop,
    viewportHeight: host.clientHeight || 600,
    rowHeight: view === 'grid' ? Math.max(112, tile + 32) : 34,
    overscan: 18
  })
  const offsets = pageOffsetsForRange(range.start, range.end, BROWSE_PAGE_SIZE)
  const requestSeq = pageRequestSeq
  const pending = offsets.filter((offset) => !loadedOffsets.has(offset))
  // 捲到的那幾頁已經在手上時也要重畫：虛擬清單只畫可見範圍，
  // 不重畫就會一直停在最初那幾列，後面全是空白。
  if (!pending.length) {
    paintList()
    return
  }
  await Promise.all(pending.map(async (offset) => {
    try {
      const data = await listDirectoryPage(cwd, { sort: sortBy, desc: sortDesc, showHidden }, offset)
      if (requestSeq !== pageRequestSeq || pathKey(data.path) !== pathKey(cwd)) return
      entries = mergeBrowsePage(entries, data, offset).entries
      loadedOffsets.add(offset)
      directoryTotal = Math.max(directoryTotal, Number(data.total) || entries.length)
    } catch {
      // 該頁失敗時保留已畫出的內容，下一次捲動可重試。
    }
  }))
  if (requestSeq === pageRequestSeq) {
    truncated = loadedOffsets.size * BROWSE_PAGE_SIZE < directoryTotal
    paintList()
  }
}

async function loadDir(dirPath, opts = {}) {
  if (pathKey(dirPath) === THIS_PC) return loadHome(opts)
  const seq = ++navSeq
  let data
  pageRequestSeq += 1
  loadedOffsets = new Set()
  try {
    data = await listDirectoryPage(dirPath, { sort: sortBy, desc: sortDesc, showHidden }, 0)
  } catch {
    data = null
  }
  if (seq !== navSeq) return false
  if (!data) {
    showToast('讀不到這個資料夾', 'error')
    return false
  }
  cwd = data.path
  entries = mergeBrowsePage([], data, 0).entries
  directoryTotal = Number(data.total) || entries.filter(Boolean).length
  loadedOffsets = new Set([Number(data.offset) || 0])
  truncated = Boolean(data.hasMore || data.truncated)
  if (!opts.keepSelection) {
    selected = new Set()
    anchor = ''
  } else if (!truncated) {
    // 分頁載入時清單裡只有已經載到的那幾頁；還沒載到的不能當成「這個檔不見了」。
    const live = new Set(listed().map((row) => entryId(row)))
    selected = new Set([...selected].filter((id) => live.has(id)))
    if (anchor && !live.has(anchor)) anchor = ''
  }
  paintCrumbs()
  paintNav()
  paintSidebar(places, disks)
  paintSortHead()
  paintList()
  // 一律照 tab 記下的位置擺：新資料夾就是 0，還原的分頁就是原本捲到的地方。
  // paintList() 現在會保留重畫前的捲動位置，這裡不補 0 的話會沿用上一個資料夾的位置。
  const listHost = $('exList')
  if (listHost) listHost.scrollTop = restoreScrollTop
  if (restoreSearch) {
    const input = /** @type {HTMLInputElement | null} */ ($('exSearch'))
    if (input) input.value = restoreSearch
    const query = restoreSearch
    restoreSearch = ''
    if (query && uffs?.installed) void runSearch(query)
  }
  restoreScrollTop = 0
  paintRecycleChrome()
  syncTab()
  persistTabs()
  paintTabs()
  if (dualPane && typeof electronAPI.explorer.watchDirs === 'function') {
    refreshExplorerWatches()
  } else {
    void electronAPI.explorer.watch(cwd).then((watch) => {
      if (seq === navSeq) watching = Boolean(watch?.ok && watch.data?.watching)
    }).catch(() => {
      if (seq === navSeq) watching = false
    })
  }
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

function searchFilters() {
  const number = (id) => {
    const value = Number($(id)?.value)
    return Number.isFinite(value) && value >= 0 ? value : null
  }
  const type = $('exSearchType')?.value
  const date = (id, end = false) => {
    const raw = String($(id)?.value || '')
    if (!raw) return null
    const value = Date.parse(`${raw}${end ? 'T23:59:59.999' : 'T00:00:00.000'}`)
    return Number.isFinite(value) ? value : null
  }
  return {
    type: ['file', 'folder', 'image', 'video', 'audio', 'document'].includes(type) ? type : 'all',
    minSize: number('exSearchMinSize'),
    maxSize: number('exSearchMaxSize'),
    fromMs: date('exSearchFrom'),
    toMs: date('exSearchTo', true),
    location: String($('exSearchLocation')?.value || '').trim()
  }
}

function onSearchFilterChange() {
  syncTab()
  persistTabs()
  const query = /** @type {HTMLInputElement | null} */ ($('exSearch'))?.value.trim()
  if (!query || !uffs?.installed) return
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void runSearch(query), SEARCH_DEBOUNCE_MS)
}

function onSearchInput() {
  searchSeq++
  const input = /** @type {HTMLInputElement | null} */ ($('exSearch'))
  const q = input ? input.value.trim() : ''
  syncTab()
  persistTabs()
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
    const data = await call(electronAPI.explorer.uffsSearch(q, searchFilters()), '搜尋失敗')
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

/**
 * 這一筆是不是開得了大預覽的圖片。`.svg` 也算——`vi-media://` 送得出它的 MIME。
 * @param {{ dir?: boolean, ext?: string, name?: string } | undefined} entry
 */
function isImage(entry) {
  if (!entry || entry.dir) return false
  const ext = String(entry.ext || entry.name?.split('.').pop() || '').toLowerCase()
  return IMAGE_EXT.has(ext)
}

function isPreviewable(entry) {
  return Boolean(previewKind(entry) || isImage(entry))
}

/**
 * 開大預覽。←／→ 走的是**目前這個資料夾裡的圖片**，跟檔案總管一樣。
 * @param {{ path: string, name: string }} entry
 */
function openPreview(entry) {
  if (!isPreviewable(entry) || inRecycle()) return false
  const candidates = listed().filter(isPreviewable).map((item) => ({
    path: item.path,
    name: item.name,
    ext: item.ext,
    dir: item.dir
  }))
  const list = candidates.length ? candidates : [entry]
  if (isImage(entry)) {
    const images = list.filter(isImage).map((item) => ({ path: item.path, name: item.name }))
    return openImageViewer({
      items: images.length ? images : [{ path: entry.path, name: entry.name }],
      index: Math.max(0, images.findIndex((item) => item.path === entry.path)),
      mediaUrl: (filePath) => electronAPI.explorer.mediaUrl(filePath)
    })
  }
  return openFilePreview({
    item: entry,
    list,
    mediaUrl: (filePath) => electronAPI.explorer.mediaUrl(filePath),
    readMarkdown: (filePath) => electronAPI.explorer.readMarkdown(filePath)
  })
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

function batchRenameItems(items) {
  if (!Array.isArray(items) || items.length < 2 || inRecycle()) return
  const dialog = document.createElement('dialog')
  dialog.className = 'app-dialog ex-batch-dialog'
  const title = document.createElement('h2')
  title.textContent = `批次重新命名（${items.length} 個）`
  const fields = document.createElement('div')
  fields.className = 'ex-batch-fields'
  const makeField = (labelText, value, type = 'text') => {
    const label = document.createElement('label')
    label.className = 'field'
    const caption = document.createElement('span')
    caption.textContent = labelText
    const input = document.createElement('input')
    input.className = 'input'
    input.type = type
    input.value = value
    label.append(caption, input)
    fields.appendChild(label)
    return input
  }
  const prefix = makeField('前綴', '')
  const suffix = makeField('後綴', '')
  const replaceFrom = makeField('取代文字', '')
  const replaceTo = makeField('換成', '')
  const start = makeField('流水號起始（可留空）', '', 'number')
  const width = makeField('流水號位數', '2', 'number')
  const preview = document.createElement('div')
  preview.className = 'ex-batch-preview'
  const status = document.createElement('p')
  status.className = 'ex-batch-status'
  const actions = document.createElement('div')
  actions.className = 'app-dialog-actions'
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'btn btn-secondary'
  cancel.textContent = '取消'
  const apply = document.createElement('button')
  apply.type = 'button'
  apply.className = 'btn btn-primary'
  apply.textContent = '套用'
  actions.append(cancel, apply)
  dialog.append(title, fields, preview, status, actions)
  document.body.appendChild(dialog)

  const nameFor = (item, i) => {
    const ext = item.ext ? `.${item.ext}` : ''
    const base = ext && item.name.endsWith(ext) ? item.name.slice(0, -ext.length) : item.name
    const changed = replaceFrom.value ? base.split(replaceFrom.value).join(replaceTo.value) : base
    const serial = start.value === '' ? '' : String(Number(start.value) + i).padStart(Math.max(1, Number(width.value) || 1), '0')
    return `${prefix.value}${changed}${suffix.value}${serial ? `-${serial}` : ''}${ext}`
  }
  const collect = () => {
    const names = items.map(nameFor)
    preview.replaceChildren()
    const table = document.createElement('div')
    table.className = 'ex-batch-table'
    const outside = new Set(entries.filter((entry) => !items.some((item) => entry.path === item.path)).map((entry) => entry.name.toLowerCase()))
    const selectedNames = new Map(items.map((item) => [item.name.toLowerCase(), item.path]))
    const seen = new Set()
    let invalid = false
    names.forEach((name, i) => {
      const row = document.createElement('div')
      row.className = 'ex-batch-row'
      const from = document.createElement('span')
      from.textContent = items[i].name
      const arrow = document.createElement('span')
      arrow.textContent = '→'
      const to = document.createElement('span')
      to.textContent = name
      const bad = !name || /[<>:"/\\|?*]/.test(name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(name)
        || seen.has(name.toLowerCase()) || outside.has(name.toLowerCase())
        || (selectedNames.has(name.toLowerCase()) && selectedNames.get(name.toLowerCase()) !== items[i].path)
      if (bad) {
        row.classList.add('is-invalid')
        invalid = true
      }
      row.append(from, arrow, to)
      table.appendChild(row)
      seen.add(name.toLowerCase())
    })
    preview.appendChild(table)
    status.textContent = invalid ? '有重複或不合法的名稱，請先修正。' : '送出前會逐筆檢查；撞名不會覆蓋。'
    status.classList.toggle('is-error', invalid)
    apply.disabled = invalid || names.every((name, i) => name === items[i].name)
    return { names, invalid }
  }
  for (const input of [prefix, suffix, replaceFrom, replaceTo, start, width]) input.addEventListener('input', collect)
  cancel.addEventListener('click', () => { dialog.close(); dialog.remove() })
  apply.addEventListener('click', () => {
    const plan = collect()
    if (!plan.invalid) {
      dialog.close()
      dialog.remove()
      void runBatchRename(items, plan.names)
    }
  })
  dialog.addEventListener('cancel', () => dialog.remove(), { once: true })
  dialog.showModal()
  collect()
}

async function runBatchRename(items, names) {
  const results = []
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]
    try {
      const done = await call(electronAPI.explorer.renameEntry(item.path, names[i]), '改名失敗')
      results.push({ oldPath: item.path, oldName: item.name, newPath: done.path, newName: names[i], ok: true })
    } catch (error) {
      results.push({ oldPath: item.path, oldName: item.name, newName: names[i], ok: false, error: error.message })
    }
  }
  const successful = results.filter((result) => result.ok)
  const revert = async () => {
    for (const result of successful.slice().reverse()) {
      await call(electronAPI.explorer.renameEntry(result.newPath, result.oldName), '復原失敗')
    }
    await refreshAfterMutate()
    showToast('已復原批次改名')
  }
  await refreshAfterMutate()
  showBatchRenameResult(results, successful.length ? revert : null)
}

function showBatchRenameResult(results, revert) {
  const dialog = document.createElement('dialog')
  dialog.className = 'app-dialog ex-batch-dialog'
  const title = document.createElement('h2')
  title.textContent = '批次改名結果'
  const list = document.createElement('div')
  list.className = 'ex-batch-result'
  for (const result of results) {
    const row = document.createElement('p')
    row.className = result.ok ? 'is-ok' : 'is-error'
    row.textContent = result.ok ? `✓ ${result.oldName} → ${result.newName}` : `✕ ${result.oldName}：${result.error || '失敗'}`
    list.appendChild(row)
  }
  const actions = document.createElement('div')
  actions.className = 'app-dialog-actions'
  if (revert) {
    const undo = document.createElement('button')
    undo.type = 'button'
    undo.className = 'btn btn-secondary'
    undo.textContent = '復原成功項目'
    undo.addEventListener('click', () => void revert().then(() => { dialog.close(); dialog.remove() }))
    actions.appendChild(undo)
  }
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'btn btn-primary'
  close.textContent = '關閉'
  close.addEventListener('click', () => { dialog.close(); dialog.remove() })
  actions.appendChild(close)
  dialog.append(title, list, actions)
  document.body.appendChild(dialog)
  dialog.addEventListener('cancel', () => dialog.remove(), { once: true })
  dialog.showModal()
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
      showHidden,
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
        preview: isPreviewable(items[0]) ? () => openPreview(items[0]) : null,
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
        batchRename: () => void batchRenameItems(items),
        remove: () => void deleteItems(items),
        newFolder: () => void newFolder(),
        newFile: () => void newFile(),
        toggleHidden: () => void toggleHidden(),
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

async function toggleHidden() {
  showHidden = !showHidden
  void electronAPI.explorer.saveState({ showHidden })
  await refreshAfterMutate()
  showToast(showHidden ? '已顯示隱藏項目' : '已隱藏系統項目')
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
  // 大預覽開著時，方向鍵／Esc／空白鍵都是它的（見 image-viewer.js）
  if (imageViewerOpen() || previewOpen()) return
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
  // 空白鍵＝大預覽（macOS 的 Quick Look 那個習慣）。Enter 仍然是「用系統預設程式開」，
  // 不動它——雙擊圖片還是跳出 Windows 的相片，跟以前一樣。
  if (e.key === ' ') {
    if (tag === 'BUTTON' || tag === 'A' || tag === 'SELECT') return
    const picked = selectedEntries()
    if (picked.length === 1 && isPreviewable(picked[0])) {
      e.preventDefault()
      openPreview(picked[0])
      return
    }
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
    tile = TILE_SIZES.includes(Number(boot.tile)) ? Number(boot.tile) : DEFAULT_TILE
    sortBy = boot.sort === 'date' || boot.sort === 'size' ? boot.sort : 'name'
    sortDesc = boot.sortDesc === true
    showHidden = boot.showHidden === true
    dualPane = boot.dualPane === true
    places = boot.places || []
    disks = boot.drives || []
    if (!tabs.length && Array.isArray(boot.tabs) && boot.tabs.length) {
      tabs = boot.tabs.map((tab, index) => normalizeBrowseTab(tab, `t${index + 1}`))
      const ids = new Set(tabs.map((tab) => tab.id))
      activeId = ids.has(boot.activeTabId) ? boot.activeTabId : tabs[0].id
      tabSeq = tabs.reduce((max, tab) => {
        const value = /^t(\d+)$/.exec(tab.id)
        return Math.max(max, value ? Number(value[1]) : 0)
      }, 0)
      const active = currentTab()
      if (active) {
        history = active.history
        histIndex = active.histIndex
        cwd = active.cwd
        applyTabState(active)
      }
    }
    setView(view)
    paintSidebar(places, disks)
    if (!tabs.length) await newTab(boot.lastPath || THIS_PC)
    else if (!job) await loadDir(cwd, { silent: true, keepSelection: true })
    if (dualPane && !job) {
      const restored = restoreSecondPaneState()
      await loadSecond(secondPane.cwd, { pushHistory: false, keepSelection: restored })
      paintSecondPane()
      persistTabs()
    }
  } catch {
    // toast 已顯示
  }
  if (job) await consumePendingOpen()
  void ensureUffs()
}

export function cooldownExplorerPage() {
  searchSeq++
  navSeq++
  clearFileIconWork()
  if (searchTimer) clearTimeout(searchTimer)
  void electronAPI.explorer.uffsCancel()
  void electronAPI.explorer.unwatch()
  closeFilePreview()
  watching = false
}

export function disposeExplorerPage() {
  cooldownExplorerPage()
  if (unsubChanged) unsubChanged()
  if (unsubProgress) unsubProgress()
  if (disposeOperations) disposeOperations()
  unsubChanged = null
  unsubProgress = null
  disposeOperations = null
}
