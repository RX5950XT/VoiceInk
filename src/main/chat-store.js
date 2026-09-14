/**
 * VoiceInk - 聊天會話持久化（Main Process）
 *
 * 獨立於設定用的 electron-store，寫在 `<userData>/chats.json`。
 * 設定的 store 有 key allowlist，不適合塞大量對話資料 → 另開一個實例。
 *
 * 兩個 key：`conversations`（陣列順序＝側欄順序）與 `folders`（側欄的分類資料夾）。
 * 上限刻意寫死：JSON 是整檔讀寫，沒有上限就會隨使用無限膨脹並拖慢每次存檔。
 */

const chatImages = require('./chat-images')
const chatParams = require('./chat-params')

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
const MAX_FOLDERS = 50
const MAX_FOLDER_NAME = 40
const MAX_MODEL_NAME = 200

const DEFAULT_TITLE = '新對話'
const VALID_ROLES = new Set(['user', 'assistant'])
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/

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
 * @param {string} prefix
 * @returns {string}
 */
function newId(prefix = 'c') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeId(value) {
  return typeof value === 'string' && ID_RE.test(value) ? value : ''
}

/**
 * @typedef {{ id: string, name: string, collapsed: boolean }} Folder
 * @param {unknown} raw
 * @returns {Folder[]}
 */
function sanitizeFolders(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const item of raw) {
    const id = sanitizeId(item?.id)
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({ id, name: sanitizeFolderName(item.name), collapsed: item.collapsed === true })
    if (out.length >= MAX_FOLDERS) break
  }
  return out
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeFolderName(value) {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
  return text ? text.slice(0, MAX_FOLDER_NAME) : '新資料夾'
}

/**
 * 讀檔後正規化：chats.json 可能被手動改壞或版本不符。
 * 舊版的 `projectId`（對話歸屬專案）已拿掉，讀到直接忽略，下次寫入就消失。
 * @typedef {{ id: string, title: string, createdAt: number, updatedAt: number, folderId: string,
 *   params: import('./chat-params').ChatParams, messages: Message[] }} Conversation
 * @param {unknown} raw
 * @param {Set<string>} folderIds
 * @returns {Conversation[]}
 */
function sanitizeAll(raw, folderIds) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const id = typeof item.id === 'string' && item.id ? item.id : newId()
    if (seen.has(id)) continue
    seen.add(id)
    const folderId = sanitizeId(item.folderId)
    out.push({
      id,
      title: sanitizeTitle(item.title),
      createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
      updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : Date.now(),
      folderId: folderIds.has(folderId) ? folderId : '',
      params: chatParams.sanitize(item.params),
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
  return text ? text.slice(0, MAX_TITLE) : DEFAULT_TITLE
}

/**
 * 第一則使用者訊息自動定出來的暫定標題（AI 取標題靠它判斷「使用者有沒有改過名」）
 * @param {string} content
 * @returns {string}
 */
function autoTitleOf(content) {
  return sanitizeTitle(String(content || '').slice(0, 30))
}

/**
 * @typedef {{ role: 'user'|'assistant', content: string, images?: string[], reasoning?: string,
 *   model?: string, ms?: number, tokens?: number }} Message
 * @param {unknown} m
 * @returns {Message | null}
 */
function sanitizeMessage(m) {
  if (!m || typeof m !== 'object') return null
  // system 一律由 chat.js 依當下設定現組，不落盤
  if (!VALID_ROLES.has(m.role) || typeof m.content !== 'string') return null
  /** @type {Message} */
  const msg = { role: m.role, content: m.content.slice(0, MAX_CONTENT) }
  const images = Array.isArray(m.images)
    ? m.images.filter((n) => chatImages.isValidName(n)).slice(0, chatImages.MAX_IMAGES_PER_MESSAGE)
    : []
  if (images.length) msg.images = images
  if (typeof m.reasoning === 'string' && m.reasoning) msg.reasoning = m.reasoning.slice(0, MAX_REASONING)
  // 回覆的來源資訊（哪顆模型、花多久、幾個 token），只有助理訊息有
  if (m.role === 'assistant') {
    if (typeof m.model === 'string' && m.model) msg.model = m.model.slice(0, MAX_MODEL_NAME)
    if (Number.isFinite(m.ms) && m.ms >= 0) msg.ms = Math.min(Math.round(m.ms), 86_400_000)
    if (Number.isInteger(m.tokens) && m.tokens > 0) msg.tokens = Math.min(m.tokens, 10_000_000)
  }
  return msg
}

/**
 * @param {unknown} raw
 * @returns {Message[]}
 */
function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) return []
  return raw.map(sanitizeMessage).filter(Boolean).slice(-MAX_MESSAGES)
}

async function readState() {
  const s = await getStore()
  const folders = sanitizeFolders(s.get('folders', []))
  const conversations = sanitizeAll(s.get('conversations', []), new Set(folders.map((f) => f.id)))
  return { folders, conversations }
}

async function readAll() {
  return (await readState()).conversations
}

/**
 * 陣列順序就是側欄顯示順序（使用者可拖曳）。
 * 超過上限時仍然砍 updatedAt 最舊的，但**不能**拿排序後的結果落盤——那會把手動順序洗掉。
 * @param {Conversation[]} list
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
 * @returns {Promise<Array<{ id: string, title: string, updatedAt: number, folderId: string, messageCount: number }>>}
 */
async function list() {
  return withStore(async () => {
    const all = await readAll()
    return all.map((c) => ({
      id: c.id,
      title: c.title,
      updatedAt: c.updatedAt,
      folderId: c.folderId,
      messageCount: c.messages.length
    }))
  })
}

/**
 * 依 renderer 給的順序重排；沒被提到的維持原相對位置附在後面。
 * 項目可以是 id，或 `{ id, folderId }`（拖進／拖出資料夾時順便改歸屬）。
 * 只接受既有 id 與既有資料夾，不會新增或刪除任何對話。
 * @param {unknown} items
 * @returns {Promise<boolean>}
 */
async function reorder(items) {
  if (!Array.isArray(items)) return false
  return withStore(async () => {
    const { folders, conversations: all } = await readState()
    const folderIds = new Set(folders.map((f) => f.id))
    const byId = new Map(all.map((c) => [c.id, c]))
    const seen = new Set()
    const next = []
    for (const item of items) {
      const id = typeof item === 'string' ? item : item?.id
      if (typeof id !== 'string' || seen.has(id)) continue
      const conv = byId.get(id)
      if (!conv) continue
      seen.add(id)
      if (item && typeof item === 'object' && 'folderId' in item) {
        const folderId = sanitizeId(item.folderId)
        conv.folderId = folderIds.has(folderId) ? folderId : ''
      }
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
 * @returns {Promise<Conversation | null>}
 */
async function get(id) {
  if (typeof id !== 'string' || !id) return null
  return withStore(async () => {
    const all = await readAll()
    return all.find((c) => c.id === id) || null
  })
}

/**
 * @param {{ folderId?: unknown, params?: unknown }} [opts] folderId 由 renderer 給、params 由 main 從預設值給
 * @returns {Promise<Conversation>}
 */
async function create(opts = {}) {
  return withStore(async () => {
    const { folders, conversations: all } = await readState()
    const folderId = sanitizeId(opts?.folderId)
    const now = Date.now()
    const conversation = {
      id: newId(),
      title: DEFAULT_TITLE,
      createdAt: now,
      updatedAt: now,
      folderId: folders.some((f) => f.id === folderId) ? folderId : '',
      params: chatParams.sanitize(opts?.params),
      messages: []
    }
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
 * @param {Conversation[]} list
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
 * 找到目標對話 → 交給 mutate 就地改 → 有改才寫回。
 * @param {string} id
 * @param {(target: Conversation, all: Conversation[]) => boolean} mutate 回傳是否有改動
 * @returns {Promise<Conversation | null>}
 */
function mutateConversation(id, mutate) {
  return withStore(async () => {
    const all = await readAll()
    const target = all.find((c) => c.id === id)
    if (!target) return null
    if (mutate(target, all)) await writeAll(all)
    return target
  })
}

/**
 * 丟掉結尾連續的助理訊息（重新生成用）
 * @param {string} id
 */
async function dropTrailingAssistant(id) {
  return mutateConversation(id, (target) => {
    let changed = false
    while (target.messages.length && target.messages[target.messages.length - 1].role === 'assistant') {
      target.messages.pop()
      changed = true
    }
    if (changed) target.updatedAt = Date.now()
    return changed
  })
}

/**
 * @param {string} id
 * @param {string} title
 */
async function rename(id, title) {
  return !!(await mutateConversation(id, (target) => {
    target.title = sanitizeTitle(title)
    target.updatedAt = Date.now()
    return true
  }))
}

/**
 * AI 取好的標題：只有標題**還是**暫定那份時才換（產生途中使用者改了名就不動）
 * @param {string} id
 * @param {string} expected
 * @param {unknown} title
 * @returns {Promise<boolean>}
 */
async function replaceAutoTitle(id, expected, title) {
  let ok = false
  await mutateConversation(id, (conv) => {
    if (conv.title !== expected) return false
    conv.title = sanitizeTitle(title)
    ok = true
    return true
  })
  return ok
}

/**
 * @param {string} id
 * @param {unknown} params
 * @returns {Promise<import('./chat-params').ChatParams | null>}
 */
async function setParams(id, params) {
  const target = await mutateConversation(id, (conv) => {
    conv.params = chatParams.sanitize(params)
    return true
  })
  return target ? target.params : null
}

/**
 * 附加一則訊息；第一則 user 訊息順便定標題
 * @param {string} id
 * @param {'user'|'assistant'} role
 * @param {string} content
 * @param {{ images?: string[], reasoning?: string, model?: string, ms?: number, tokens?: number }} [extra]
 * @returns {Promise<Conversation | null>}
 */
async function appendMessage(id, role, content, extra) {
  if (!VALID_ROLES.has(role) || typeof content !== 'string') return null
  const msg = sanitizeMessage({ ...extra, role, content })
  let trimmed = false
  const target = await mutateConversation(id, (conv) => {
    const isFirstUser = role === 'user' && !conv.messages.some((m) => m.role === 'user')
    conv.messages.push(msg)
    if (conv.messages.length > MAX_MESSAGES) {
      conv.messages = conv.messages.slice(-MAX_MESSAGES)
      trimmed = true
    }
    // 使用者在送出前就改過名的不蓋（預設名才換成暫定標題，之後 AI 取標題也靠這個判斷）
    if (isFirstUser && conv.title === DEFAULT_TITLE) conv.title = autoTitleOf(content)
    conv.updatedAt = Date.now()
    return true
  })
  if (trimmed) await withStore(async () => pruneImages(await readAll()))
  return target
}

/**
 * @param {Conversation} conv
 * @param {unknown} index
 * @returns {number} 不合法回 -1
 */
function messageIndex(conv, index) {
  return Number.isInteger(index) && index >= 0 && index < conv.messages.length ? index : -1
}

/**
 * 改寫一則使用者訊息，**之後的訊息全部丟掉**（接著由呼叫端重新生成）。
 * 圖片保留：改的是文字。
 * @param {string} id
 * @param {unknown} index
 * @param {unknown} content
 * @returns {Promise<Conversation | null>} 不合法時回 null
 */
async function editUserMessage(id, index, content) {
  const text = typeof content === 'string' ? content.trim().slice(0, MAX_CONTENT) : ''
  let ok = false
  const target = await mutateConversation(id, (conv) => {
    const i = messageIndex(conv, index)
    const msg = conv.messages[i]
    if (i < 0 || msg.role !== 'user' || (!text && !msg.images?.length)) return false
    conv.messages = conv.messages.slice(0, i).concat({ ...msg, content: text })
    conv.updatedAt = Date.now()
    ok = true
    return true
  })
  if (!ok) return null
  await withStore(async () => pruneImages(await readAll()))
  return target
}

/**
 * @param {string} id
 * @param {unknown} index
 * @returns {Promise<boolean>}
 */
async function deleteMessage(id, index) {
  let ok = false
  await mutateConversation(id, (conv) => {
    const i = messageIndex(conv, index)
    if (i < 0) return false
    conv.messages = conv.messages.filter((_, n) => n !== i)
    conv.updatedAt = Date.now()
    ok = true
    return true
  })
  if (ok) await withStore(async () => pruneImages(await readAll()))
  return ok
}

/**
 * 從某一則（含）往前複製成新對話，排在原對話正下方、同一個資料夾、同一組參數。
 * 圖片是用檔名引用的，兩邊共用同一份檔案（prune 會看所有對話的引用）。
 * @param {string} id
 * @param {unknown} index
 * @returns {Promise<Conversation | null>}
 */
async function fork(id, index) {
  return withStore(async () => {
    const all = await readAll()
    const at = all.findIndex((c) => c.id === id)
    if (at < 0) return null
    const source = all[at]
    const i = messageIndex(source, index)
    if (i < 0) return null
    const now = Date.now()
    const copy = {
      ...source,
      id: newId(),
      title: sanitizeTitle(`${source.title.slice(0, MAX_TITLE - 5)}（分叉）`),
      createdAt: now,
      updatedAt: now,
      messages: source.messages.slice(0, i + 1).map((m) => ({ ...m }))
    }
    all.splice(at + 1, 0, copy)
    await writeAll(all)
    return copy
  })
}

// ===== 資料夾 =====

async function listFolders() {
  return withStore(async () => (await readState()).folders)
}

/**
 * @param {(folders: Folder[]) => Folder[] | null} change 回 null ＝不寫
 * @returns {Promise<Folder[] | null>}
 */
function mutateFolders(change) {
  return withStore(async () => {
    const s = await getStore()
    const { folders } = await readState()
    const next = change(folders)
    if (!next) return null
    s.set('folders', sanitizeFolders(next))
    return next
  })
}

/**
 * 資料夾拖曳排序；沒提到的（搜尋中被藏起來的）維持原相對位置附在後面
 * @param {unknown} ids
 * @returns {Promise<boolean>}
 */
async function reorderFolders(ids) {
  if (!Array.isArray(ids)) return false
  const next = await mutateFolders((folders) => {
    const byId = new Map(folders.map((f) => [f.id, f]))
    const picked = [...new Set(ids.filter((id) => typeof id === 'string' && byId.has(id)))]
    return picked.map((id) => byId.get(id)).concat(folders.filter((f) => !picked.includes(f.id)))
  })
  return !!next
}

/**
 * @param {unknown} name
 * @returns {Promise<Folder | null>}
 */
async function createFolder(name) {
  const folder = { id: newId('f'), name: sanitizeFolderName(name), collapsed: false }
  const next = await mutateFolders((folders) => (folders.length >= MAX_FOLDERS ? null : folders.concat(folder)))
  return next ? folder : null
}

/**
 * @param {string} id
 * @param {{ name?: unknown, collapsed?: unknown }} patch
 * @returns {Promise<boolean>}
 */
async function updateFolder(id, patch) {
  const next = await mutateFolders((folders) => {
    if (!folders.some((f) => f.id === id)) return null
    return folders.map((f) => (f.id !== id ? f : {
      ...f,
      ...(patch && 'name' in patch ? { name: sanitizeFolderName(patch.name) } : {}),
      ...(patch && 'collapsed' in patch ? { collapsed: patch.collapsed === true } : {})
    }))
  })
  return !!next
}

/**
 * 刪資料夾**不刪裡面的對話**：它們回到未分類，順序不動。
 * @param {string} id
 * @returns {Promise<boolean>}
 */
async function removeFolder(id) {
  const next = await mutateFolders((folders) => (
    folders.some((f) => f.id === id) ? folders.filter((f) => f.id !== id) : null
  ))
  if (!next) return false
  // readAll 會把指到不存在資料夾的 folderId 收斂成空字串，寫回一次就落地
  await withStore(async () => writeAll(await readAll()))
  return true
}

/**
 * @param {string} id
 * @param {unknown} folderId 空字串＝移出資料夾
 * @returns {Promise<boolean>}
 */
async function moveToFolder(id, folderId) {
  return withStore(async () => {
    const { folders, conversations: all } = await readState()
    const target = all.find((c) => c.id === id)
    const wanted = sanitizeId(folderId)
    if (!target || (wanted && !folders.some((f) => f.id === wanted))) return false
    target.folderId = wanted
    await writeAll(all)
    return true
  })
}

/**
 * 匯出用：整段對話轉 Markdown（圖片只留檔名，思考過程收在 details 裡）
 * @param {Conversation} conv
 * @returns {string}
 */
function toMarkdown(conv) {
  const parts = [`# ${conv.title}`, '']
  for (const msg of conv.messages) {
    const who = msg.role === 'user' ? '使用者' : `助理${msg.model ? `（${msg.model}）` : ''}`
    parts.push(`## ${who}`, '')
    if (msg.reasoning) {
      parts.push('<details><summary>思考過程</summary>', '', msg.reasoning, '', '</details>', '')
    }
    if (msg.content) parts.push(msg.content, '')
    for (const name of msg.images || []) parts.push(`（圖片：${name}）`, '')
  }
  return parts.join('\n')
}

module.exports = {
  toMarkdown,
  autoTitleOf,
  replaceAutoTitle,
  reorderFolders,
  list,
  get,
  create,
  remove,
  rename,
  reorder,
  setParams,
  appendMessage,
  dropTrailingAssistant,
  editUserMessage,
  deleteMessage,
  fork,
  listFolders,
  createFolder,
  updateFolder,
  removeFolder,
  moveToFolder,
  pruneImages,
  MAX_CONVERSATIONS,
  MAX_MESSAGES,
  MAX_CONTENT,
  MAX_FOLDERS
}
