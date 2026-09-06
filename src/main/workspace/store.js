'use strict'

/**
 * 專案清單的持久化（Main Process）。
 *
 * 寫在 `<userData>/workspaces.json`，比照 `terminal/store.js`：獨立 electron-store 實例、
 * 所有讀寫走同一條 chain，避免並行 IPC 互相覆蓋整份檔案。
 *
 * 一個「專案」就是本機的一個資料夾。**刻意不做 git worktree**——那是另一個量級的東西。
 *
 * 這裡是整個工作區的信任邊界起點：renderer 永遠只送 projectId，
 * 絕對路徑一律由這裡解析（見 `files.js` 的 `resolveIn`）。
 */

const fs = require('fs')
const path = require('path')

/** 最多幾個專案 */
const MAX_PROJECTS = 20
/** 名稱長度上限 */
const MAX_NAME = 60

/**
 * @param {unknown} value
 * @returns {string} 絕對路徑；不是字串就回空字串
 */
function normalizePath(value) {
  if (typeof value !== 'string' || !value.trim()) return ''
  try {
    return path.resolve(value)
  } catch {
    return ''
  }
}

/**
 * 這個路徑現在還在不在。**不存在不代表要刪掉那筆**（隨身碟拔掉、網路磁碟沒連上），
 * 只是標記起來讓 UI 講明白——整筆丟掉等於使用者插回硬碟後專案就沒了。
 * @param {string} full
 * @returns {boolean}
 */
function pathExists(full) {
  if (!full) return false
  try {
    return fs.statSync(full).isDirectory()
  } catch {
    return false
  }
}

/**
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
function normalizeName(value, fallback) {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
  return (text || fallback || '專案').slice(0, MAX_NAME)
}

/** @returns {string} */
function newId() {
  return `w_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 讀檔後正規化：workspaces.json 可能被手改或版本不符。
 * @param {unknown} raw
 * @returns {Array<{ id: string, name: string, path: string, createdAt: number }>}
 */
function sanitizeAll(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const seenPath = new Set()
  const out = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const id = typeof item.id === 'string' ? item.id : ''
    if (!id || seen.has(id)) continue
    const full = normalizePath(item.path)
    if (!full) continue
    const key = process.platform === 'win32' ? full.toLowerCase() : full
    if (seenPath.has(key)) continue
    seen.add(id)
    seenPath.add(key)
    const entry = {
      id,
      name: normalizeName(item.name, path.basename(full)),
      path: full,
      createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now()
    }
    if (item.tabsState && typeof item.tabsState === 'object') {
      const sanitized = sanitizeTabsState(item.tabsState)
      if (sanitized) entry.tabsState = sanitized
    }
    out.push(entry)
    if (out.length >= MAX_PROJECTS) break
  }
  return out
}

const ALLOWED_TAB_KINDS = new Set(['terminal', 'editor', 'diff', 'browser', 'ai-session'])

/** 單一草稿的長度上限（＝`files.MAX_WRITE_CHARS`，renderer 那邊也用同一個數字） */
const MAX_DRAFT_CHARS = 4 * 1024 * 1024

/**
 * @param {unknown} raw
 * @returns {{ activeId: string, tabs: Array<object> } | null}
 */
function sanitizeTabsState(raw) {
  if (!raw || typeof raw !== 'object') return null
  const activeId = typeof raw.activeId === 'string'
    ? raw.activeId
    : typeof raw.activeTabId === 'string'
      ? raw.activeTabId
      : ''
  const rawTabs = Array.isArray(raw.tabs) ? raw.tabs : []
  const tabs = []
  for (const t of rawTabs) {
    if (!t || typeof t !== 'object') continue
    const id = typeof t.id === 'string' ? t.id : ''
    const kind = typeof t.kind === 'string' ? t.kind : ''
    const title = typeof t.title === 'string' ? t.title.slice(0, 100) : ''
    if (!id || !ALLOWED_TAB_KINDS.has(kind)) continue
    const tab = { id, kind, title }
    if (typeof t.relPath === 'string') tab.relPath = t.relPath
    if (typeof t.url === 'string') tab.url = /^https?:\/\//i.test(t.url) ? t.url : ''
    if (typeof t.dirty === 'boolean') tab.dirty = t.dirty
    if (typeof t.preview === 'boolean') tab.preview = t.preview
    if (typeof t.staged === 'boolean') tab.staged = t.staged
    if (typeof t.sessionId === 'string') tab.sessionId = t.sessionId
    if (typeof t.agent === 'string') tab.agent = t.agent
    if (t.sessionRow && typeof t.sessionRow === 'object') tab.sessionRow = t.sessionRow
    // 上限跟 `files.MAX_WRITE_CHARS` 同一條線：比編輯器能存的還小的話，
    // 會出現「打得下、存得了，但關掉分頁草稿就沒了」而且完全沒有訊息
    if (typeof t.draftContent === 'string' && t.draftContent.length <= MAX_DRAFT_CHARS) {
      tab.draftContent = t.draftContent
    }
    tabs.push(tab)
    if (tabs.length >= 30) break
  }
  return { activeId, tabs }
}

/** @type {import('electron-store') | null} */
let store = null
/** @type {Promise<import('electron-store')> | null} */
let storeReady = null
let storeChain = Promise.resolve()

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withStore(fn) {
  const run = storeChain.then(fn, fn)
  storeChain = run.then(() => {}, () => {})
  return run
}

async function getStore() {
  if (store) return store
  if (!storeReady) {
    storeReady = import('electron-store').then((mod) => {
      if (!store) store = new mod.default({ name: 'workspaces' })
      return store
    })
  }
  return storeReady
}

async function readAll() {
  const s = await getStore()
  return sanitizeAll(s.get('projects', []))
}

/**
 * @param {Array<object>} items
 */
async function writeAll(items) {
  const s = await getStore()
  s.set('projects', items)
  return items
}

/**
 * 給 renderer 的形狀：多一個 `missing`，UI 才講得出「這個資料夾找不到了」。
 * @param {{ id: string, name: string, path: string, createdAt: number }} item
 */
function toView(item) {
  return { ...item, missing: !pathExists(item.path) }
}

/** @returns {Promise<Array<object>>} */
function list() {
  return withStore(async () => (await readAll()).map(toView))
}

/**
 * @param {string} id
 * @returns {Promise<{ id: string, name: string, path: string } | null>}
 */
function get(id) {
  return withStore(async () => {
    const items = await readAll()
    return items.find((item) => item.id === id) || null
  })
}

/**
 * 加入一個資料夾。路徑由 ipc 那層的系統對話框給，不收 renderer 自己組的字串。
 * @param {{ path: string, name?: string }} req
 */
function create(req) {
  return withStore(async () => {
    const items = await readAll()
    if (items.length >= MAX_PROJECTS) {
      const error = new Error('PROJECT_LIMIT')
      error.code = 'PROJECT_LIMIT'
      error.userMessage = `專案最多 ${MAX_PROJECTS} 個，請先移除一些`
      throw error
    }
    const full = normalizePath(req?.path)
    if (!pathExists(full)) {
      const error = new Error('BAD_PATH')
      error.code = 'BAD_PATH'
      error.userMessage = '找不到這個資料夾'
      throw error
    }
    const key = process.platform === 'win32' ? full.toLowerCase() : full
    const existing = items.find((item) => (
      (process.platform === 'win32' ? item.path.toLowerCase() : item.path) === key
    ))
    if (existing) return toView(existing)
    const project = {
      id: newId(),
      name: normalizeName(req?.name, path.basename(full)),
      path: full,
      createdAt: Date.now()
    }
    await writeAll([...items, project])
    return toView(project)
  })
}

/**
 * 從拖放加入專案。路徑來自 OS 的 drop（preload 的 webUtils.getPathForFile），
 * 每一筆仍走 `create` 的全套驗證：解析成絕對路徑、必須是存在的目錄、
 * 已存在就略過、上限照樣拋。回 `{ added, skipped, firstId }` 給 UI 選中第一個新專案。
 * @param {unknown} paths
 */
async function addDropped(paths) {
  const list = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && p.trim())
  if (!list.length) {
    const error = new Error('BAD_PATH')
    error.code = 'BAD_PATH'
    error.userMessage = '沒有收到資料夾'
    throw error
  }
  const items = await readAll()
  const keyOf = (value) => (process.platform === 'win32' ? value.toLowerCase() : value)
  const known = new Set(items.map((item) => keyOf(item.path)))
  const added = []
  let skipped = 0
  for (const raw of list) {
    try {
      const view = await create({ path: raw })
      if (known.has(keyOf(view.path))) skipped += 1
      else added.push(view)
    } catch (error) {
      // 不是目錄、不存在 → 略過；上限是使用者要知道的事，照樣拋
      if (error && error.code === 'PROJECT_LIMIT') throw error
      skipped += 1
    }
  }
  return { added: added.length, skipped, firstId: added[0] ? added[0].id : '' }
}

/**
 * @param {string} id
 * @param {string} name
 */
function rename(id, name) {
  return withStore(async () => {
    const items = await readAll()
    const next = items.map((item) => (
      item.id === id ? { ...item, name: normalizeName(name, path.basename(item.path)) } : item
    ))
    await writeAll(next)
    const found = next.find((item) => item.id === id)
    return found ? toView(found) : null
  })
}

/**
 * 只從清單移除，**不碰磁碟上的資料夾**。
 * @param {string} id
 */
function remove(id) {
  return withStore(async () => {
    const items = await readAll()
    await writeAll(items.filter((item) => item.id !== id))
    return true
  })
}

/**
 * 側欄拖曳後的完整順序；只接受既有 id，漏掉的接在後面（不讓 renderer 有機會刪東西）。
 * @param {string[]} ids
 */
function reorder(ids) {
  return withStore(async () => {
    const items = await readAll()
    if (!Array.isArray(ids)) return items.map(toView)
    const byId = new Map(items.map((item) => [item.id, item]))
    const next = []
    for (const id of ids) {
      const item = byId.get(id)
      if (!item) continue
      byId.delete(id)
      next.push(item)
    }
    next.push(...byId.values())
    await writeAll(next)
    return next.map(toView)
  })
}

/**
 * 儲存專案的分頁與草稿狀態（Hot Exit 防護）
 * @param {string} id
 * @param {unknown} rawTabs
 */
function saveTabsState(id, rawTabs) {
  return withStore(async () => {
    const items = await readAll()
    const sanitized = sanitizeTabsState(rawTabs)
    const next = items.map((item) => (
      item.id === id ? { ...item, tabsState: sanitized } : item
    ))
    await writeAll(next)
    return true
  })
}

/**
 * 讀取專案的分頁與草稿狀態
 * @param {string} id
 */
function getTabsState(id) {
  return withStore(async () => {
    const items = await readAll()
    const found = items.find((item) => item.id === id)
    return found?.tabsState || null
  })
}

module.exports = {
  MAX_PROJECTS,
  MAX_NAME,
  MAX_DRAFT_CHARS,
  normalizePath,
  normalizeName,
  pathExists,
  sanitizeAll,
  list,
  get,
  create,
  addDropped,
  rename,
  remove,
  reorder,
  sanitizeTabsState,
  saveTabsState,
  getTabsState
}
