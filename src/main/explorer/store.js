'use strict'

/**
 * 檔案總管的偏好（Main Process）。
 *
 * 寫在 `<userData>/explorer.json`：上次路徑、檢視模式。獨立 electron-store，
 * 不走 `store:*` allowlist（跟 chats／terminals／workspaces 同一種）。
 */

const paths = require('./paths')
const places = require('./places')

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

/**
 * @returns {Promise<{ lastPath: string, view: 'list'|'grid', tile: number, sort: string, sortDesc: boolean, showHidden: boolean, uffsAuto: boolean, places: object[] }>}
 */
function readState() {
  return withStore(async () => {
    const s = await getStore()
    return {
      lastPath: sanitizePath(s.get('lastPath', '')),
      view: sanitizeView(s.get('view', 'list')),
      tile: sanitizeTile(s.get('tile', DEFAULT_TILE)),
      sort: sanitizeSortKey(s.get('sort', 'name')),
      sortDesc: s.get('sortDesc', false) === true,
      showHidden: s.get('showHidden', false) === true,
      uffsAuto: sanitizeAuto(s.get('uffsAuto', true)),
      places: places.sanitizePlaces(s.get('places', []))
    }
  })
}

/**
 * @param {{ lastPath?: unknown, view?: unknown, tile?: unknown, sort?: unknown, sortDesc?: unknown, showHidden?: unknown, uffsAuto?: unknown, places?: unknown }} patch
 * @returns {Promise<{ lastPath: string, view: 'list'|'grid', tile: number, sort: string, sortDesc: boolean, showHidden: boolean, uffsAuto: boolean, places: object[] }>}
 */
function writeState(patch) {
  return withStore(async () => {
    const s = await getStore()
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
      uffsAuto: patch.uffsAuto !== undefined
        ? sanitizeAuto(patch.uffsAuto)
        : sanitizeAuto(s.get('uffsAuto', true)),
      places: patch.places !== undefined
        ? places.sanitizePlaces(patch.places)
        : places.sanitizePlaces(s.get('places', []))
    }
    s.set('lastPath', next.lastPath)
    s.set('view', next.view)
    s.set('tile', next.tile)
    s.set('sort', next.sort)
    s.set('sortDesc', next.sortDesc)
    s.set('showHidden', next.showHidden)
    s.set('uffsAuto', next.uffsAuto)
    s.set('places', next.places)
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
  readState,
  writeState
}
