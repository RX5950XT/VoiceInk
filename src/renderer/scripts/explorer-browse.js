/**
 * 檔案總管分頁狀態與大目錄的純函式工具。
 *
 * Main 端分頁 API 回傳一頁資料；這裡只保留狀態、合併頁面與計算可見範圍，
 * 不碰 DOM。integration 可在 list/grid 共用同一套流程，也能把每個 panel 自己的
 * state 放進 tab，不把雙欄重新綁成全域變數。
 */

export const BROWSE_PAGE_SIZE = 500
export const VIRTUAL_OVERSCAN_ROWS = 12
export const BROWSE_VIEW_MODES = new Set(['list', 'grid'])
export const BROWSE_SORT_KEYS = new Set(['name', 'date', 'size'])
export const BROWSE_SEARCH_SORTS = new Set(['rank', 'name', 'date', 'size'])
export const BROWSE_TILE_SIZES = [48, 64, 96, 128, 180, 256]
export const BROWSE_DEFAULT_TILE = 96

const MAX_TAB_SEARCH = 200
const MAX_TAB_SELECTION = 10000
const MAX_SCROLL = 50_000_000

function numberOr(raw, fallback = 0) {
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

function clamp(raw, min, max, fallback = min) {
  const value = numberOr(raw, fallback)
  return Math.max(min, Math.min(max, value))
}

function sanitizeTile(raw) {
  const value = numberOr(raw, BROWSE_DEFAULT_TILE)
  return BROWSE_TILE_SIZES.reduce((best, tile) => (
    Math.abs(tile - value) < Math.abs(best - value) ? tile : best
  ), BROWSE_DEFAULT_TILE)
}

function sanitizeFilters(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const type = typeof value.type === 'string' ? value.type : 'all'
  return {
    type,
    minSize: value.minSize ?? null,
    maxSize: value.maxSize ?? null,
    fromMs: value.fromMs ?? null,
    toMs: value.toMs ?? null,
    location: typeof value.location === 'string' ? value.location.slice(0, 32767) : ''
  }
}

function sanitizeIds(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 32767)
    .slice(0, MAX_TAB_SELECTION)
}

/**
 * @param {object} [raw]
 * @param {object} [fallback]
 * @returns {object}
 */
export function normalizeBrowseState(raw = {}, fallback = {}) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const base = fallback && typeof fallback === 'object' ? fallback : {}
  const merged = { ...base, ...value }
  return {
    view: BROWSE_VIEW_MODES.has(merged.view) ? merged.view : 'list',
    tile: sanitizeTile(merged.tile),
    sort: BROWSE_SORT_KEYS.has(merged.sort) ? merged.sort : 'name',
    sortDesc: merged.sortDesc === true,
    showHidden: merged.showHidden === true,
    search: typeof merged.search === 'string' ? merged.search.trim().slice(0, MAX_TAB_SEARCH) : '',
    searchSort: BROWSE_SEARCH_SORTS.has(merged.searchSort) ? merged.searchSort : 'rank',
    searchFilters: sanitizeFilters(merged.searchFilters || merged.filters),
    selected: sanitizeIds(merged.selected),
    anchor: typeof merged.anchor === 'string' ? merged.anchor.slice(0, 32767) : '',
    cursor: typeof merged.cursor === 'string' ? merged.cursor.slice(0, 32767) : '',
    scrollTop: clamp(merged.scrollTop, 0, MAX_SCROLL),
    scrollLeft: clamp(merged.scrollLeft, 0, MAX_SCROLL)
  }
}

/**
 * @param {object} raw
 * @param {string} fallbackId
 * @returns {object}
 */
export function normalizeBrowseTab(raw = {}, fallbackId = 't1') {
  const value = raw && typeof raw === 'object' ? raw : {}
  const state = value.state && typeof value.state === 'object' ? value.state : value
  const cwd = typeof value.cwd === 'string' && value.cwd ? value.cwd : 'thispc'
  const history = Array.isArray(value.history) && value.history.length
    ? value.history.filter((item) => typeof item === 'string' && item).slice(0, 64)
    : [cwd]
  const histIndex = Math.floor(clamp(value.histIndex, 0, history.length - 1))
  return {
    id: typeof value.id === 'string' && value.id ? value.id : fallbackId,
    cwd,
    history,
    histIndex,
    state: normalizeBrowseState(state)
  }
}

/**
 * @param {unknown} page
 * @param {number} fallbackOffset
 * @returns {{ entries: object[], offset: number, total: number, hasMore: boolean, truncated: boolean }}
 */
export function normalizeBrowsePage(page, fallbackOffset = 0) {
  const value = page && typeof page === 'object' ? page : {}
  const entries = Array.isArray(value.entries) ? value.entries : []
  const offset = Math.max(0, Math.floor(numberOr(value.offset, fallbackOffset)))
  const total = Math.max(offset + entries.length, Math.floor(numberOr(value.total, offset + entries.length)))
  const hasMore = value.hasMore === true || offset + entries.length < total
  return {
    entries,
    offset,
    total,
    hasMore,
    truncated: value.truncated === true || hasMore
  }
}

/**
 * @param {object[]} current
 * @param {object} page
 * @param {number} [fallbackOffset]
 * @returns {{ entries: Array<object|undefined>, total: number, loaded: number }}
 */
export function mergeBrowsePage(current, page, fallbackOffset = 0) {
  const normalized = normalizeBrowsePage(page, fallbackOffset)
  const entries = Array.isArray(current) ? current.slice() : []
  const end = normalized.offset + normalized.entries.length
  if (entries.length < Math.max(end, normalized.total)) entries.length = Math.max(end, normalized.total)
  normalized.entries.forEach((entry, index) => { entries[normalized.offset + index] = entry })
  return { entries, total: normalized.total, loaded: entries.reduce((count, entry) => count + (entry ? 1 : 0), 0) }
}

/**
 * @param {{ total?: number, scrollTop?: number, viewportHeight?: number, rowHeight?: number, overscan?: number }} opts
 * @returns {{ start: number, end: number, before: number, after: number, height: number }}
 */
export function visibleBrowseRange(opts = {}) {
  const total = Math.max(0, Math.floor(numberOr(opts.total)))
  const rowHeight = Math.max(1, numberOr(opts.rowHeight, 36))
  const viewportHeight = Math.max(0, numberOr(opts.viewportHeight, rowHeight))
  const scrollTop = Math.max(0, numberOr(opts.scrollTop))
  const overscan = Math.max(0, Math.floor(numberOr(opts.overscan, VIRTUAL_OVERSCAN_ROWS)))
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const end = Math.min(total, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan)
  return { start, end, before: start * rowHeight, after: Math.max(0, total - end) * rowHeight, height: total * rowHeight }
}

/** @param {number} start @param {number} end @param {number} [pageSize] @returns {number[]} */
export function pageOffsetsForRange(start, end, pageSize = BROWSE_PAGE_SIZE) {
  const size = Math.max(1, Math.floor(numberOr(pageSize, BROWSE_PAGE_SIZE)))
  const first = Math.floor(Math.max(0, numberOr(start)) / size) * size
  const last = Math.max(first, Math.ceil(Math.max(0, numberOr(end)) / size) * size)
  const out = []
  for (let offset = Math.floor(first); offset < last; offset += size) out.push(offset)
  return out
}

/** @param {object} entry @returns {string} */
export function browseEntryId(entry) {
  if (!entry || typeof entry !== 'object') return ''
  return String(entry.recycleKey || entry.path || entry.name || '')
}

/**
 * 只檢查已載入頁面；未載入的選取保留在 Set 裡，換頁不會把使用者已選的項目清掉。
 * @param {Iterable<string>} selected
 * @param {object[]} entries
 * @returns {string[]}
 */
export function selectedLoadedIds(selected, entries) {
  const wanted = new Set(selected || [])
  return (Array.isArray(entries) ? entries : []).filter(Boolean).map(browseEntryId).filter((id) => wanted.has(id))
}

/**
 * 以已載入頁面的穩定 id 做 Shift 連選；未載入頁面的 id 不會被猜測或誤選。
 * @param {object[]} entries
 * @param {string} anchorId
 * @param {string} targetId
 * @param {Iterable<string>} [selected]
 * @param {boolean} [additive]
 * @returns {string[]}
 */
export function selectBrowseRange(entries, anchorId, targetId, selected = [], additive = false) {
  const rows = (Array.isArray(entries) ? entries : []).filter(Boolean)
  const ids = rows.map(browseEntryId)
  const first = ids.indexOf(anchorId)
  const last = ids.indexOf(targetId)
  if (first < 0 || last < 0) return [...new Set(selected || [])]
  const start = Math.min(first, last)
  const end = Math.max(first, last)
  const next = new Set(additive ? selected || [] : [])
  for (const id of ids.slice(start, end + 1)) if (id) next.add(id)
  return [...next]
}
