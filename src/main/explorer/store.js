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
const RECYCLE_CWD = 'recyclebin'

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
  if (raw.replace(/[\\/]+$/, '').toLowerCase() === RECYCLE_CWD) return RECYCLE_CWD
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
 * @returns {Promise<{ lastPath: string, view: 'list'|'grid', sort: string, sortDesc: boolean, uffsAuto: boolean, places: object[] }>}
 */
function readState() {
  return withStore(async () => {
    const s = await getStore()
    return {
      lastPath: sanitizePath(s.get('lastPath', '')),
      view: sanitizeView(s.get('view', 'list')),
      sort: sanitizeSortKey(s.get('sort', 'name')),
      sortDesc: s.get('sortDesc', false) === true,
      uffsAuto: sanitizeAuto(s.get('uffsAuto', true)),
      places: places.sanitizePlaces(s.get('places', []))
    }
  })
}

/**
 * @param {{ lastPath?: unknown, view?: unknown, sort?: unknown, sortDesc?: unknown, uffsAuto?: unknown, places?: unknown }} patch
 * @returns {Promise<{ lastPath: string, view: 'list'|'grid', sort: string, sortDesc: boolean, uffsAuto: boolean, places: object[] }>}
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
      sort: patch.sort !== undefined
        ? sanitizeSortKey(patch.sort)
        : sanitizeSortKey(s.get('sort', 'name')),
      sortDesc: patch.sortDesc !== undefined
        ? patch.sortDesc === true
        : s.get('sortDesc', false) === true,
      uffsAuto: patch.uffsAuto !== undefined
        ? sanitizeAuto(patch.uffsAuto)
        : sanitizeAuto(s.get('uffsAuto', true)),
      places: patch.places !== undefined
        ? places.sanitizePlaces(patch.places)
        : places.sanitizePlaces(s.get('places', []))
    }
    s.set('lastPath', next.lastPath)
    s.set('view', next.view)
    s.set('sort', next.sort)
    s.set('sortDesc', next.sortDesc)
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
  sanitizeSortKey,
  sanitizeAuto,
  readState,
  writeState
}
