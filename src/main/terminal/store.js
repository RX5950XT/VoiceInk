'use strict'

/**
 * 終端機工作階段的側欄 metadata 持久化（Main Process）。
 *
 * 寫在 `<userData>/terminals.json`，比照 `chat-store.js`：獨立 electron-store 實例、
 * 所有讀寫走同一條 chain，避免並行 IPC 互相覆蓋整份檔案。
 *
 * **只存 metadata，不存畫面內容**：scrollback 是暫時的（重開 App 之後那個 pty 早就沒了），
 * 塞進 JSON 只會讓每次改名都重寫好幾 MB。重開後階段還在側欄，點下去才在記住的 cwd 重開 shell。
 *
 * shell 與啟動指令都是這裡的固定表，renderer 只送 key——這是整個終端機功能的信任邊界，
 * 讓 renderer 指定執行檔路徑等於把 App 變成「幫你執行任意程式」的跳板。
 */

const fs = require('fs')
const path = require('path')
const os = require('os')

/** 最多幾個工作階段（每個都是一顆真的 conhost，沒有上限會把機器吃光） */
const MAX_SESSIONS = 20
/** 標題長度上限 */
const MAX_TITLE = 60

/** 可用的 shell。renderer 只送 key，執行檔在這裡解析。 */
const SHELLS = {
  pwsh: { label: 'PowerShell 7', exe: 'pwsh.exe' },
  powershell: { label: 'Windows PowerShell', exe: 'powershell.exe' },
  cmd: { label: '命令提示字元', exe: 'cmd.exe' }
}

/** 開好之後自動送出的第一行指令。同樣只收 key。 */
const PRESETS = {
  shell: { label: '純 shell', command: '' },
  claude: { label: 'Claude Code', command: 'claude' },
  codex: { label: 'Codex CLI', command: 'codex' },
  opencode: { label: 'OpenCode', command: 'opencode' },
  agy: { label: 'Antigravity CLI', command: 'agy' },
  grok: { label: 'Grok CLI', command: 'grok' }
}

const DEFAULT_SHELL = 'pwsh'
const DEFAULT_PRESET = 'shell'

/** @type {Map<string, string>} */
const exeCache = new Map()

/**
 * 在 PATH 上找執行檔。找不到回空字串，讓呼叫端能退回別的 shell。
 * @param {string} name
 * @returns {string}
 */
function resolveExe(name) {
  const cached = exeCache.get(name)
  if (cached !== undefined) return cached
  let found = ''
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    try {
      if (fs.statSync(candidate).isFile()) {
        found = candidate
        break
      }
    } catch {
      // 這個目錄沒有，繼續找
    }
  }
  exeCache.set(name, found)
  return found
}

/**
 * 目前這台機器裝了哪些 shell（給 renderer 填下拉選單）。
 * @returns {Array<{ key: string, label: string, available: boolean }>}
 */
function availableShells() {
  return Object.entries(SHELLS).map(([key, def]) => ({
    key,
    label: def.label,
    available: Boolean(resolveExe(def.exe))
  }))
}

/**
 * @returns {Array<{ key: string, label: string }>}
 */
function availablePresets() {
  return Object.entries(PRESETS).map(([key, def]) => ({ key, label: def.label }))
}

/**
 * 把 renderer 給的 shell key 收斂成「這台機器真的有」的一個。
 * @param {unknown} key
 * @returns {string}
 */
function normalizeShell(key) {
  if (typeof key === 'string' && SHELLS[key] && resolveExe(SHELLS[key].exe)) return key
  for (const candidate of [DEFAULT_SHELL, 'powershell', 'cmd']) {
    if (resolveExe(SHELLS[candidate].exe)) return candidate
  }
  return 'cmd'
}

/**
 * @param {unknown} key
 * @returns {string}
 */
function normalizePreset(key) {
  return typeof key === 'string' && PRESETS[key] ? key : DEFAULT_PRESET
}

/**
 * 工作目錄：必須真的是個目錄，否則退回家目錄。renderer 給什麼都不能直接信。
 * @param {unknown} value
 * @returns {string}
 */
function normalizeCwd(value) {
  if (typeof value === 'string' && value) {
    try {
      if (fs.statSync(value).isDirectory()) return path.resolve(value)
    } catch {
      // 不存在或沒權限 → 退回家目錄
    }
  }
  return os.homedir()
}

/**
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
function normalizeTitle(value, fallback) {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
  return (text || fallback).slice(0, MAX_TITLE)
}

/**
 * @param {string} preset
 * @param {string} cwd
 * @returns {string}
 */
function defaultTitle(preset, cwd) {
  const dir = path.basename(cwd) || cwd
  return preset === 'shell' ? dir : `${PRESETS[preset].label} · ${dir}`
}

/**
 * @returns {string}
 */
function newId() {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 讀檔後正規化：terminals.json 可能被手改或版本不符。
 * @param {unknown} raw
 * @returns {Array<{ id: string, title: string, shell: string, preset: string, cwd: string, createdAt: number }>}
 */
function sanitizeAll(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const id = typeof item.id === 'string' ? item.id : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    const shell = normalizeShell(item.shell)
    const preset = normalizePreset(item.preset)
    const cwd = normalizeCwd(item.cwd)
    out.push({
      id,
      title: normalizeTitle(item.title, defaultTitle(preset, cwd)),
      shell,
      preset,
      cwd,
      admin: item.admin === true,
      createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now()
    })
    if (out.length >= MAX_SESSIONS) break
  }
  return out
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
      if (!store) store = new mod.default({ name: 'terminals' })
      return store
    })
  }
  return storeReady
}

async function readAll() {
  const s = await getStore()
  return sanitizeAll(s.get('sessions', []))
}

/**
 * @param {Array<object>} items
 */
async function writeAll(items) {
  const s = await getStore()
  s.set('sessions', items)
  return items
}

/** @returns {Promise<Array<object>>} */
function list() {
  return withStore(readAll)
}

/**
 * @param {{ shell?: string, preset?: string, cwd?: string, title?: string }} req
 */
function create(req) {
  return withStore(async () => {
    const items = await readAll()
    if (items.length >= MAX_SESSIONS) {
      const error = new Error('SESSION_LIMIT')
      error.code = 'SESSION_LIMIT'
      error.userMessage = `工作階段最多 ${MAX_SESSIONS} 個，請先關掉一些`
      throw error
    }
    const shell = normalizeShell(req?.shell)
    const preset = normalizePreset(req?.preset)
    const cwd = normalizeCwd(req?.cwd)
    const session = {
      id: newId(),
      title: normalizeTitle(req?.title, defaultTitle(preset, cwd)),
      shell,
      preset,
      cwd,
      // 提權要走另一顆 host 程序（見 admin.js），renderer 只送這個布林
      admin: req?.admin === true,
      createdAt: Date.now()
    }
    await writeAll([...items, session])
    return session
  })
}

/**
 * @param {string} id
 * @param {string} title
 */
function rename(id, title) {
  return withStore(async () => {
    const items = await readAll()
    const next = items.map((item) => (
      item.id === id
        ? { ...item, title: normalizeTitle(title, defaultTitle(item.preset, item.cwd)) }
        : item
    ))
    await writeAll(next)
    return next.find((item) => item.id === id) || null
  })
}

/**
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
    if (!Array.isArray(ids)) return items
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
    return next
  })
}

/**
 * @param {string} id
 */
function get(id) {
  return withStore(async () => {
    const items = await readAll()
    return items.find((item) => item.id === id) || null
  })
}

module.exports = {
  MAX_SESSIONS,
  MAX_TITLE,
  SHELLS,
  PRESETS,
  availableShells,
  availablePresets,
  resolveExe,
  normalizeShell,
  normalizePreset,
  normalizeCwd,
  normalizeTitle,
  defaultTitle,
  sanitizeAll,
  list,
  get,
  create,
  rename,
  remove,
  reorder
}
