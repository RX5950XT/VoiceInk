'use strict'

/**
 * 檔案總管的偏好（Main Process）。
 *
 * 寫在 `<userData>/explorer.json`：上次路徑、檢視模式。獨立 electron-store，
 * 不走 `store:*` allowlist（跟 chats／terminals／workspaces 同一種）。
 */

const paths = require('./paths')
const places = require('./places')
const { sanitizeSearchFilters } = require('./search-filter')

const VIEW_MODES = new Set(['list', 'grid'])
const SORT_KEYS = new Set(['name', 'date', 'size'])
/**
 * 方格檢視的圖示邊長（px）。Ctrl+滾輪一次跳一級，像檔案總管的
 * 小圖示→中圖示→大圖示→特大圖示。renderer 也認同一份（`explorer-page.js`）。
 */
const TILE_SIZES = [48, 64, 96, 128, 180, 256]
const DEFAULT_TILE = 96
const RECYCLE_CWD = 'recyclebin'
const THIS_PC = 'thispc'
const MAX_TABS = 24
const MAX_HISTORY = 64
const MAX_SELECTED = 10000
const MAX_SEARCH = 200
const TAB_ID_RE = /^[A-Za-z0-9_-]{1,40}$/

/** @type {import('electron-store') | null} */
let store = null
/** @type {Promise<import('electron-store')> | null} */
let storeReady = null
let chain = Promise.resolve()

/**
 * @template T
 * @param {() => Promise<T>|T} fn
 * @returns {Promise<T>}
 */
function withStore(fn) {
  const run = chain.then(fn, fn)
  chain = run.then(() => {}, () => {})
  return run
}

async function getStore() {
  if (store) return store
  if (!storeReady) {
    storeReady = import('electron-store').then((mod) => {
      if (!store) store = new mod.default({ name: 'explorer' })
      return store
    })
  }
  return storeReady
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
function sanitizePath(raw) {
  if (typeof raw !== 'string' || !raw) return ''
  const compact = raw.replace(/[\\/]+$/, '').toLowerCase()
  if (compact === RECYCLE_CWD || compact === THIS_PC) return compact
  try {
    return paths.resolveAbs(raw)
  } catch {
    return ''
  }
}

/**
 * @param {unknown} raw
 * @returns {'list'|'grid'}
 */
function sanitizeView(raw) {
  return typeof raw === 'string' && VIEW_MODES.has(raw) ? raw : 'list'
}

/**
 * 方格圖示大小。只收清單裡的那幾級，別的值（包括舊版寫進去的）一律靠回最接近的一級，
 * 免得殼層被要一張沒人要的尺寸。
 * @param {unknown} raw
 * @returns {number}
 */
function sanitizeTile(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_TILE
  if (TILE_SIZES.includes(n)) return n
  return TILE_SIZES.reduce((best, size) => (
    Math.abs(size - n) < Math.abs(best - n) ? size : best
  ), DEFAULT_TILE)
}

/**
 * @param {unknown} raw
 * @returns {'name'|'date'|'size'}
 */
function sanitizeSortKey(raw) {
  return typeof raw === 'string' && SORT_KEYS.has(raw) ? raw : 'name'
}

/**
 * 只有明示 `false` 才關掉自動授權。缺值／別的型別都當開。
 * @param {unknown} raw
 * @returns {boolean}
 */
function sanitizeAuto(raw) {
  return raw !== false
}

function boundedNumber(raw, fallback = 0) {
  const n = Number(raw)
  return Number.isFinite(n) ? Math.max(0, Math.min(50_000_000, n)) : fallback
}

function sanitizeId(raw, fallback) {
  return typeof raw === 'string' && TAB_ID_RE.test(raw) ? raw : fallback
}

function sanitizeSelected(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((value) => typeof value === 'string' && value.length > 0 && value.length <= 32767)
    .slice(0, MAX_SELECTED)
}

/**
 * 右欄只保存可恢復的瀏覽狀態，不把已載入的檔案列與分頁偏移寫進 explorer.json。
 * @param {unknown} raw
 * @returns {object|null}
 */
function sanitizeRightPane(raw) {
  if (!raw || typeof raw !== 'object') return null
  const value = raw
  const cwd = sanitizePath(value.cwd) || THIS_PC
  const history = Array.isArray(value.history)
    ? value.history.map(sanitizePath).filter(Boolean).slice(0, MAX_HISTORY)
    : []
  const nextHistory = history.length ? history : [cwd]
  return {
    cwd,
    history: nextHistory,
    histIndex: Math.max(0, Math.min(nextHistory.length - 1, Number(value.histIndex) | 0)),
    search: typeof value.search === 'string' ? value.search.trim().slice(0, MAX_SEARCH) : '',
    sortBy: sanitizeSortKey(value.sortBy),
    sortDesc: value.sortDesc === true,
    selected: sanitizeSelected(value.selected),
    anchor: typeof value.anchor === 'string' ? value.anchor.slice(0, 32767) : '',
    scrollTop: boundedNumber(value.scrollTop),
    scrollLeft: boundedNumber(value.scrollLeft)
  }
}

/**
 * 每個檔案總管分頁的可恢復狀態。缺路徑／離線 NAS 只保留資料，真正列目錄時由 renderer
 * 各自處理錯誤，避免啟動時被單一壞分頁卡住。
 * @param {unknown} raw
 * @param {string} fallbackId
 * @returns {object}
 */
function sanitizeTab(raw, fallbackId = 't1') {
  const value = raw && typeof raw === 'object' ? raw : {}
  const state = value.state && typeof value.state === 'object' ? value.state : value
  const cwd = sanitizePath(value.cwd) || THIS_PC
  const history = Array.isArray(value.history)
    ? value.history.map(sanitizePath).filter(Boolean).slice(0, MAX_HISTORY)
    : []
  const nextHistory = history.length ? history : [cwd]
  const histIndex = Math.max(0, Math.min(nextHistory.length - 1, Number(value.histIndex) | 0))
  const search = typeof state.search === 'string' ? state.search.trim().slice(0, MAX_SEARCH) : ''
  return {
    id: sanitizeId(value.id, fallbackId),
    cwd,
    history: nextHistory,
    histIndex,
    view: sanitizeView(state.view),
    tile: sanitizeTile(state.tile),
    sort: sanitizeSortKey(state.sort),
    sortDesc: state.sortDesc === true,
    showHidden: state.showHidden === true,
    search,
    searchSort: state.searchSort === 'date' || state.searchSort === 'size' || state.searchSort === 'name'
      ? state.searchSort
      : 'rank',
    searchFilters: sanitizeSearchFilters(state.searchFilters || state.filters),
    selected: sanitizeSelected(state.selected),
    anchor: typeof state.anchor === 'string' ? state.anchor.slice(0, 32767) : '',
    cursor: typeof state.cursor === 'string' ? state.cursor.slice(0, 32767) : '',
    scrollTop: boundedNumber(state.scrollTop),
    scrollLeft: boundedNumber(state.scrollLeft),
    rightPane: sanitizeRightPane(state.rightPane || value.rightPane)
  }
}

/** @param {unknown} raw @returns {object[]} */
function sanitizeTabs(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const value of raw.slice(0, MAX_TABS)) {
    const tab = sanitizeTab(value, `t${out.length + 1}`)
    if (seen.has(tab.id)) continue
    seen.add(tab.id)
    out.push(tab)
  }
  return out
}

function sanitizeActiveTab(raw, tabs) {
  if (typeof raw === 'string' && tabs.some((tab) => tab.id === raw)) return raw
  return tabs[0]?.id || ''
}

/**
 * @returns {Promise<{ lastPath: string, view: 'list'|'grid', tile: number, sort: string, sortDesc: boolean, showHidden: boolean, dualPane: boolean, uffsAuto: boolean, places: object[], tabs: object[], activeTabId: string }>}
 */
function readState() {
  return withStore(async () => {
    const s = await getStore()
    const tabs = sanitizeTabs(s.get('tabs', []))
    return {
      lastPath: sanitizePath(s.get('lastPath', '')),
      view: sanitizeView(s.get('view', 'list')),
      tile: sanitizeTile(s.get('tile', DEFAULT_TILE)),
      sort: sanitizeSortKey(s.get('sort', 'name')),
      sortDesc: s.get('sortDesc', false) === true,
      showHidden: s.get('showHidden', false) === true,
      dualPane: s.get('dualPane', false) === true,
      uffsAuto: sanitizeAuto(s.get('uffsAuto', true)),
      places: places.sanitizePlaces(s.get('places', [])),
      tabs,
      activeTabId: sanitizeActiveTab(s.get('activeTabId', ''), tabs)
    }
  })
}

/**
 * @param {{ lastPath?: unknown, view?: unknown, tile?: unknown, sort?: unknown, sortDesc?: unknown, showHidden?: unknown, dualPane?: unknown, uffsAuto?: unknown, places?: unknown, tabs?: unknown, activeTabId?: unknown }} patch
 * @returns {Promise<{ lastPath: string, view: 'list'|'grid', tile: number, sort: string, sortDesc: boolean, showHidden: boolean, dualPane: boolean, uffsAuto: boolean, places: object[], tabs: object[], activeTabId: string }>}
 */
function writeState(patch) {
  return withStore(async () => {
    const s = await getStore()
    const tabs = patch.tabs !== undefined
      ? sanitizeTabs(patch.tabs)
      : sanitizeTabs(s.get('tabs', []))
    const next = {
      lastPath: patch.lastPath !== undefined
        ? sanitizePath(patch.lastPath)
        : sanitizePath(s.get('lastPath', '')),
      view: patch.view !== undefined
        ? sanitizeView(patch.view)
        : sanitizeView(s.get('view', 'list')),
      tile: patch.tile !== undefined
        ? sanitizeTile(patch.tile)
        : sanitizeTile(s.get('tile', DEFAULT_TILE)),
      sort: patch.sort !== undefined
        ? sanitizeSortKey(patch.sort)
        : sanitizeSortKey(s.get('sort', 'name')),
      sortDesc: patch.sortDesc !== undefined
        ? patch.sortDesc === true
        : s.get('sortDesc', false) === true,
      showHidden: patch.showHidden !== undefined
        ? patch.showHidden === true
        : s.get('showHidden', false) === true,
      dualPane: patch.dualPane !== undefined
        ? patch.dualPane === true
        : s.get('dualPane', false) === true,
      uffsAuto: patch.uffsAuto !== undefined
        ? sanitizeAuto(patch.uffsAuto)
        : sanitizeAuto(s.get('uffsAuto', true)),
      places: patch.places !== undefined
        ? places.sanitizePlaces(patch.places)
        : places.sanitizePlaces(s.get('places', [])),
      tabs,
      activeTabId: sanitizeActiveTab(
        patch.activeTabId !== undefined ? patch.activeTabId : s.get('activeTabId', ''),
        tabs
      )
    }
    s.set('lastPath', next.lastPath)
    s.set('view', next.view)
    s.set('tile', next.tile)
    s.set('sort', next.sort)
    s.set('sortDesc', next.sortDesc)
    s.set('showHidden', next.showHidden)
    s.set('dualPane', next.dualPane)
    s.set('uffsAuto', next.uffsAuto)
    s.set('places', next.places)
    s.set('tabs', next.tabs)
    s.set('activeTabId', next.activeTabId)
    return next
  })
}

module.exports = {
  VIEW_MODES,
  SORT_KEYS,
  sanitizePath,
  sanitizeView,
  sanitizeTile,
  TILE_SIZES,
  DEFAULT_TILE,
  sanitizeSortKey,
  sanitizeAuto,
  MAX_TABS,
  MAX_HISTORY,
  MAX_SELECTED,
  sanitizeRightPane,
  sanitizeTab,
  sanitizeTabs,
  sanitizeActiveTab,
  readState,
  writeState
}
