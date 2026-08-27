/**
 * VoiceInk - 聊天會話持久化（Main Process）
 *
 * 獨立於設定用的 electron-store，寫在 `<userData>/chats.json`。
 * 設定的 store 有 key allowlist，不適合塞大量對話資料 → 另開一個實例。
 *
 * 上限刻意寫死：JSON 是整檔讀寫，沒有上限就會隨使用無限膨脹並拖慢每次存檔。
 */

/** 最多保留幾個會話（超過砍 updatedAt 最舊的） */
const MAX_CONVERSATIONS = 100
/** 每個會話最多幾則訊息（超過砍最舊的，成對砍以免留下孤兒 user） */
const MAX_MESSAGES = 500
/** 標題長度上限 */
const MAX_TITLE = 60
/** 單則訊息長度上限（與 chat.js 的輸入驗證一致） */
const MAX_CONTENT = 32000
/** 思考過程長度上限（只為呈現，超過截斷不影響正確性） */
const MAX_REASONING = 16000

const VALID_ROLES = new Set(['user', 'assistant'])

const chatImages = require('./chat-images')

/** @type {import('electron-store') | null} */
let store = null
/** @type {Promise<import('electron-store')> | null} */
let storeReady = null
/** 所有讀寫走同一條 chain，避免並行 IPC 互相覆蓋整份 chats.json */
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
      if (!store) store = new mod.default({ name: 'chats' })
      return store
    })
  }
  return storeReady
}

/**
 * 產生會話 id（不用 crypto.randomUUID 以外的相依）
 * @returns {string}
 */
function newId() {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 讀檔後正規化：chats.json 可能被手動改壞或版本不符
 * @param {unknown} raw
 * @returns {Array<{ id: string, title: string, createdAt: number, updatedAt: number, messages: Array<{role: string, content: string}> }>}
 */
function sanitizeAll(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const id = typeof item.id === 'string' && item.id ? item.id : newId()
    if (seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      title: sanitizeTitle(item.title),
      createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
      updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : Date.now(),
      messages: sanitizeMessages(item.messages)
    })
  }
  return out
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeTitle(value) {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
  return text ? text.slice(0, MAX_TITLE) : '新對話'
}

/**
 * @param {unknown} raw
 */
function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue
    // system 一律由 chat.js 依當下設定現組，不落盤
    if (!VALID_ROLES.has(m.role)) continue
    if (typeof m.content !== 'string') continue
    const msg = { role: m.role, content: m.content.slice(0, MAX_CONTENT) }
    const images = Array.isArray(m.images)
      ? m.images.filter((n) => chatImages.isValidName(n)).slice(0, chatImages.MAX_IMAGES_PER_MESSAGE)
      : []
    if (images.length) msg.images = images
    if (typeof m.reasoning === 'string' && m.reasoning) {
      msg.reasoning = m.reasoning.slice(0, MAX_REASONING)
    }
    out.push(msg)
  }
  return out.slice(-MAX_MESSAGES)
}

async function readAll() {
  const s = await getStore()
  return sanitizeAll(s.get('conversations', []))
}

/**
 * 陣列順序就是側欄顯示順序（使用者可拖曳）。
 * 超過上限時仍然砍 updatedAt 最舊的，但**不能**拿排序後的結果落盤——那會把手動順序洗掉。
 * @param {ReturnType<typeof sanitizeAll>} list
 */
async function writeAll(list) {
  const s = await getStore()
  let trimmed = list
  if (list.length > MAX_CONVERSATIONS) {
    const keep = new Set(
      [...list].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_CONVERSATIONS).map((c) => c.id)
    )
    trimmed = list.filter((c) => keep.has(c.id))
  }
  s.set('conversations', trimmed)
  // 整個對話被淘汰時，它引用的圖片就沒人要了
  if (trimmed.length < list.length) await pruneImages(trimmed)
  return trimmed
}

/**
 * 側欄用：不回傳訊息內容，避免每次列表都搬整包對話。
 * 順序＝陣列順序（使用者拖曳的結果），不再依 updatedAt 重排。
 * @returns {Promise<Array<{ id: string, title: string, updatedAt: number, messageCount: number }>>}
 */
async function list() {
  return withStore(async () => {
    const all = await readAll()
    return all.map((c) => ({
      id: c.id,
      title: c.title,
      updatedAt: c.updatedAt,
      messageCount: c.messages.length
    }))
  })
}

/**
 * 依 renderer 給的 id 順序重排；沒被提到的（例如同時新開的對話）維持原相對位置附在後面。
 * 只接受既有 id，不會新增或刪除任何對話。
 * @param {unknown} ids
 * @returns {Promise<boolean>}
 */
async function reorder(ids) {
  if (!Array.isArray(ids)) return false
  return withStore(async () => {
    const all = await readAll()
    const byId = new Map(all.map((c) => [c.id, c]))
    const seen = new Set()
    const next = []
    for (const id of ids) {
      if (typeof id !== 'string' || seen.has(id)) continue
      const conv = byId.get(id)
      if (!conv) continue
      seen.add(id)
      next.push(conv)
    }
    for (const conv of all) {
      if (!seen.has(conv.id)) next.push(conv)
    }
    await writeAll(next)
    return true
  })
}

/**
 * @param {string} id
 */
async function get(id) {
  if (typeof id !== 'string' || !id) return null
  return withStore(async () => {
    const all = await readAll()
    return all.find((c) => c.id === id) || null
  })
}

async function create() {
  return withStore(async () => {
    const now = Date.now()
    const conversation = { id: newId(), title: '新對話', createdAt: now, updatedAt: now, messages: [] }
    const all = await readAll()
    all.unshift(conversation)
    await writeAll(all)
    return conversation
  })
}

/**
 * @param {string} id
 */
async function remove(id) {
  return withStore(async () => {
    const all = await readAll()
    const next = all.filter((c) => c.id !== id)
    if (next.length === all.length) return false
    await writeAll(next)
    await pruneImages(next)
    return true
  })
}

/**
 * 刪掉不再被任何對話引用的圖片檔
 * @param {ReturnType<typeof sanitizeAll>} list
 */
async function pruneImages(list) {
  const keep = new Set()
  for (const conv of list) {
    for (const msg of conv.messages) {
      for (const name of msg.images || []) keep.add(name)
    }
  }
  try {
    await chatImages.prune(keep)
  } catch (e) {
    console.warn('[chat-store] prune images failed:', e?.message || e)
  }
}

/**
 * 丟掉結尾連續的助理訊息（重新生成用）
 * @param {string} id
 * @returns {Promise<{ id: string, title: string, createdAt: number, updatedAt: number, messages: Array<{role: string, content: string}> } | null>}
 */
async function dropTrailingAssistant(id) {
  return withStore(async () => {
    const all = await readAll()
    const target = all.find((c) => c.id === id)
    if (!target) return null
    let changed = false
    while (target.messages.length && target.messages[target.messages.length - 1].role === 'assistant') {
      target.messages.pop()
      changed = true
    }
    if (changed) {
      target.updatedAt = Date.now()
      await writeAll(all)
    }
    return target
  })
}

/**
 * @param {string} id
 * @param {string} title
 */
async function rename(id, title) {
  return withStore(async () => {
    const all = await readAll()
    const target = all.find((c) => c.id === id)
    if (!target) return false
    target.title = sanitizeTitle(title)
    target.updatedAt = Date.now()
    await writeAll(all)
    return true
  })
}

/**
 * 附加一則訊息；第一則 user 訊息順便定標題
 * @param {string} id
 * @param {'user'|'assistant'} role
 * @param {string} content
 * @param {{ images?: string[], reasoning?: string }} [extra]
 * @returns {Promise<{ id: string, title: string, createdAt: number, updatedAt: number, messages: Array<{role: string, content: string, images?: string[], reasoning?: string}> } | null>}
 */
async function appendMessage(id, role, content, extra) {
  if (!VALID_ROLES.has(role) || typeof content !== 'string') return null
  return withStore(async () => {
    const all = await readAll()
    const target = all.find((c) => c.id === id)
    if (!target) return null
    const isFirstUser = role === 'user' && !target.messages.some((m) => m.role === 'user')
    const msg = { role, content: content.slice(0, MAX_CONTENT) }
    const images = Array.isArray(extra?.images)
      ? extra.images.filter((n) => chatImages.isValidName(n)).slice(0, chatImages.MAX_IMAGES_PER_MESSAGE)
      : []
    if (images.length) msg.images = images
    if (typeof extra?.reasoning === 'string' && extra.reasoning) {
      msg.reasoning = extra.reasoning.slice(0, MAX_REASONING)
    }
    target.messages.push(msg)
    let trimmed = false
    if (target.messages.length > MAX_MESSAGES) {
      target.messages = target.messages.slice(-MAX_MESSAGES)
      trimmed = true
    }
    if (isFirstUser) target.title = sanitizeTitle(content.slice(0, 30))
    target.updatedAt = Date.now()
    await writeAll(all)
    if (trimmed) await pruneImages(all)
    return target
  })
}

module.exports = {
  list,
  get,
  create,
  remove,
  rename,
  reorder,
  appendMessage,
  dropTrailingAssistant,
  pruneImages,
  MAX_CONVERSATIONS,
  MAX_MESSAGES,
  MAX_CONTENT
}
