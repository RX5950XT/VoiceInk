/**
 * VoiceInk - 聊天頁（雲端串流 + 多會話）
 *
 * 純雲端，不佔用 ASR／LLM 引擎，所以不做 engine.acquire。
 * 訊息與 model 的所有權在 main：這裡只送 conversationId、文字與圖片 data URL，
 * 串流結束後重新向 main 取整份會話，確保畫面與 chats.json 一致。
 */

import { showToast, electronAPI, cleanIpcError, openSettingsPage, setChatPaneMode } from './app.js'
import { renderMarkdown } from './markdown.js'
import { mergeVisibleOrder } from './usage-reorder.js'
import { createListReorder } from './list-reorder.js'

const DEFAULT_CHAT_API_URL = 'https://openrouter.ai/api/v1'
const DEFAULT_CHAT_MODEL = 'google/gemini-3-flash-preview'
/** 與 main 的 chat.MAX_PROVIDERS 對齊；這裡只是提早擋下、真正的上限在 main */
const MAX_PROVIDERS = 10
const MAX_PROVIDER_MODELS = 30

/** 串流重繪節流；每次重繪整則訊息 */
const RENDER_THROTTLE_MS = 60
/** 捲到底的判定容差 */
const BOTTOM_SLACK_PX = 48
/** 刪除鈕按下後等待二次確認的時間，逾時自動復原 */
const DELETE_ARM_MS = 3000
/** 輸入框自動長高的上限（超過就內部捲動） */
const INPUT_MAX_RATIO = 0.4
/** 送出前先把圖片縮到長邊這個像素；再大對辨識沒幫助，只會吃 token 與磁碟 */
const MAX_IMAGE_EDGE = 1568
const IMAGE_QUALITY = 0.85
/** 單則訊息的圖片數上限（與 main 的 chat-images 一致） */
const MAX_ATTACHMENTS = 4

// ===== DOM =====
let listEl = null
let searchInput = null
let messagesEl = null
let inputEl = null
let composerEl = null
let attachmentsEl = null
let fileInput = null
let attachBtn = null
let thinkBtn = null
let sendBtn = null
let newBtn = null
let modelSelect = null
let promptSelect = null
let promptManageBtn = null
let bannerEl = null
let bannerTextEl = null
let errorEl = null
// 設定頁
let providerSelect = null
let providerNameInput = null
let addProviderBtn = null
let deleteProviderBtn = null
let providerHintEl = null
let apiUrlInput = null
let apiKeyInput = null
let modelListEl = null
let addModelBtn = null
let scanModelsBtn = null

/**
 * 設定頁的供應商草稿。
 *
 * 表單一次只顯示一組供應商，但儲存是整批寫回，所以編輯中的內容得留在記憶體裡：
 * 切換下拉時先把畫面上的欄位收回草稿，再把新選的那組畫上去。
 * 直接每次讀寫 store 會讓「改到一半切走再切回來」的內容消失。
 * @type {Array<{ id: string, name: string, apiUrl: string, apiKey: string, models: string[], imageModels: string[] }>}
 */
let providerDraft = []
let draftId = ''

// 掃描彈窗
let scanDialog = null
let scanDescEl = null
let scanSearchInput = null
let scanListEl = null
let scanCountEl = null
/** @type {string[]} */
let scanResults = []
/** @type {Set<string>} */
let scanSelected = new Set()
/** @type {Set<string>} */
let scanExisting = new Set()
// 提示管理彈窗
let promptDialog = null
let promptListEl = null
let promptNameInput = null
let promptContentInput = null

// ===== 狀態 =====
/** @type {Array<{ id: string, title: string, updatedAt: number, messageCount: number, projectId?: string }>} */
let conversations = []
let currentId = ''
let searchTerm = ''
/**
 * 側欄現在選著哪個專案（由 workspace-page 發 `ws:project` 事件推過來，
 * 用事件而不是互相 import——兩個模組誰先載入不固定）。
 */
let activeProject = { id: '', name: '' }
/** projectId → 專案名稱，只為了在列上標一下歸屬 */
let projectNames = new Map()
/** @type {{ reqId: string, raw: string, reasoning: string, contentEl: HTMLElement, bodyEl: HTMLElement, thinkBody: HTMLElement | null, dirty: boolean, timer: number } | null} */
let streaming = null
/** 待送出的圖片 @type {Array<{ id: string, dataUrl: string }>} */
let attachments = []
/** 圖片檔名 → data URL，避免每次重畫都跟 main 要一次 */
const imageCache = new Map()
/** 提示管理彈窗的草稿 @type {Array<{ id: string, name: string, content: string }>} */
let promptDraft = []
let promptDraftId = ''
/** 處於「再按一次確認刪除」狀態的按鈕 @type {HTMLButtonElement | null} */
let armedDeleteBtn = null
let inited = false

/**
 * 初始化聊天頁（只綁一次）
 */
export function initChatPage() {
  if (inited) return
  listEl = document.getElementById('chatList')
  searchInput = document.getElementById('chatSearchInput')
  messagesEl = document.getElementById('chatMessages')
  inputEl = document.getElementById('chatInput')
  composerEl = document.getElementById('chatComposer')
  attachmentsEl = document.getElementById('chatAttachments')
  fileInput = document.getElementById('chatFileInput')
  attachBtn = document.getElementById('chatAttachBtn')
  thinkBtn = document.getElementById('chatThinkBtn')
  sendBtn = document.getElementById('chatSendBtn')
  newBtn = document.getElementById('chatNewBtn')
  modelSelect = document.getElementById('chatModelSelect')
  promptSelect = document.getElementById('chatPromptSelect')
  promptManageBtn = document.getElementById('chatPromptManageBtn')
  bannerEl = document.getElementById('chatBanner')
  bannerTextEl = document.getElementById('chatBannerText')
  errorEl = document.getElementById('chatError')
  providerSelect = document.getElementById('chatProviderSelect')
  providerNameInput = document.getElementById('chatProviderNameInput')
  addProviderBtn = document.getElementById('chatAddProviderBtn')
  deleteProviderBtn = document.getElementById('chatDeleteProviderBtn')
  providerHintEl = document.getElementById('chatProviderHint')
  apiUrlInput = document.getElementById('chatApiUrlInput')
  apiKeyInput = document.getElementById('chatApiKeyInput')
  modelListEl = document.getElementById('chatModelList')
  addModelBtn = document.getElementById('chatAddModelBtn')
  scanModelsBtn = document.getElementById('chatScanModelsBtn')
  scanDialog = document.getElementById('chatScanDialog')
  scanDescEl = document.getElementById('chatScanDesc')
  scanSearchInput = document.getElementById('chatScanSearch')
  scanListEl = document.getElementById('chatScanList')
  scanCountEl = document.getElementById('chatScanCount')
  promptDialog = document.getElementById('chatPromptDialog')
  promptListEl = document.getElementById('promptList')
  promptNameInput = document.getElementById('promptNameInput')
  promptContentInput = document.getElementById('promptContentInput')
  if (!messagesEl) return
  inited = true

  sendBtn?.addEventListener('click', handleSend)
  newBtn?.addEventListener('click', handleNew)
  modelSelect?.addEventListener('change', handleModelChange)
  promptSelect?.addEventListener('change', handlePromptChange)
  promptManageBtn?.addEventListener('click', openPromptDialog)
  searchInput?.addEventListener('input', onSearchInput)
  messagesEl.addEventListener('click', onMessagesClick)
  addModelBtn?.addEventListener('click', () => appendModelRow('', { focus: true }))
  providerSelect?.addEventListener('change', handleProviderSwitch)
  addProviderBtn?.addEventListener('click', handleAddProvider)
  deleteProviderBtn?.addEventListener('click', handleDeleteProvider)
  providerNameInput?.addEventListener('input', syncProviderName)
  scanModelsBtn?.addEventListener('click', handleScanModels)
  scanSearchInput?.addEventListener('input', renderScanList)
  document.getElementById('chatScanAllBtn')?.addEventListener('click', () => toggleScanAll(true))
  document.getElementById('chatScanNoneBtn')?.addEventListener('click', () => toggleScanAll(false))
  document.getElementById('chatScanCancelBtn')?.addEventListener('click', () => scanDialog?.close())
  document.getElementById('chatScanApplyBtn')?.addEventListener('click', applyScanSelection)
  document.getElementById('chatOpenSettingsBtn')?.addEventListener('click', () => openSettingsPage('cloud'))
  document.getElementById('toggleChatApiKeyVisibility')?.addEventListener('click', toggleKeyVisibility)

  initComposer()
  initPromptDialog()
  initProjectScope()

  // 工作區把「選取的那幾行」或「整包審閱意見」丟過來（`ws-review.js` 發的事件）
  document.addEventListener('chat:insert', (event) => {
    const detail = /** @type {CustomEvent<{ text: string }>} */ (event).detail
    insertIntoComposer(detail?.text || '')
  })

  document.addEventListener('settings-changed', () => {
    refreshModelSelect()
    refreshBanner()
  })

  electronAPI.chat.onDelta(onDelta)
}

/**
 * 切到聊天頁時呼叫
 */
/**
 * 對話歸屬：接側欄的專案切換（新對話要記到哪個專案、列上標誰的）。
 * **不做「只看這個專案」的過濾**——清單本來就短，多一顆開關只是雜訊。
 */
function initProjectScope() {
  document.addEventListener('ws:project', (event) => {
    const detail = /** @type {CustomEvent<{ id: string, name: string }>} */ (event).detail
    activeProject = { id: detail?.id || '', name: detail?.name || '' }
    renderList()
  })
}

async function reloadProjectNames() {
  try {
    const res = await electronAPI.workspace.listProjects()
    const list = res?.ok ? res.data : []
    projectNames = new Map((list || []).map((one) => [one.id, one.name]))
  } catch {
    // 讀不到就不標歸屬，不是錯誤
  }
}

export async function refreshChatPage() {
  initChatPage()
  if (!inited) return
  await Promise.all([refreshModelSelect(), refreshPromptSelect(), refreshThinkToggle(), refreshBanner()])
  await reloadProjectNames()
  await reloadList()
  if (!currentId || !conversations.some((c) => c.id === currentId)) {
    if (conversations.length) await openConversation(conversations[0].id)
    else await handleNew()
  }
  autoGrowInput()
}

// ===== 會話 =====

async function reloadList() {
  try {
    conversations = await electronAPI.chat.list()
  } catch (e) {
    conversations = []
    showError(cleanIpcError(e))
  }
  renderList()
}

function onSearchInput() {
  searchTerm = (searchInput?.value || '').trim().toLowerCase()
  renderList()
}

function renderList() {
  if (!listEl) return
  // 重畫會把待確認的刪除鈕整顆換掉，計時器得先收乾淨
  disarmDelete()
  listEl.replaceChildren()
  const visible = searchTerm
    ? conversations.filter((c) => c.title.toLowerCase().includes(searchTerm))
    : conversations
  if (!visible.length) {
    const empty = document.createElement('p')
    empty.className = 'prompt-list-empty'
    empty.textContent = searchTerm ? '沒有符合的對話' : '還沒有對話'
    listEl.appendChild(empty)
    return
  }
  for (const conv of visible) listEl.appendChild(buildListItem(conv))
}

/**
 * 側欄的一列：開啟鈕 ＋ 改名／刪除，整列可拖曳排序
 * @param {{ id: string, title: string, messageCount: number }} conv
 * @returns {HTMLElement}
 */
function buildListItem(conv) {
  const item = document.createElement('div')
  item.className = conv.id === currentId ? 'chat-list-item active' : 'chat-list-item'
  item.dataset.id = conv.id

  const open = document.createElement('button')
  open.type = 'button'
  open.className = 'chat-list-open'
  const title = document.createElement('span')
  title.className = 'chat-list-title'
  title.textContent = conv.title
  const meta = document.createElement('span')
  meta.className = 'chat-list-meta'
  meta.textContent = `${conv.messageCount} 則`
  const owner = conv.projectId ? projectNames.get(conv.projectId) : ''
  if (owner) {
    const tag = document.createElement('span')
    tag.className = 'chat-list-proj'
    tag.textContent = owner
    meta.append(document.createTextNode(' · '), tag)
  }
  open.append(title, meta)
  open.addEventListener('click', () => openConversation(conv.id))

  const actions = document.createElement('span')
  actions.className = 'chat-list-actions'
  const trash = listActionButton(ICON_TRASH, '刪除對話', () => armDelete(trash, conv))
  actions.append(listActionButton(ICON_PENCIL, '重新命名', () => startRename(item, conv)), trash)
  // 選著專案時多一顆「歸到這個專案／取消歸屬」
  if (activeProject.id) {
    const owned = conv.projectId === activeProject.id
    const btn = listActionButton(
      ICON_FOLDER,
      owned ? `取消歸屬（目前屬於 ${activeProject.name}）` : `歸到 ${activeProject.name}`,
      () => void assignProject(conv, owned ? '' : activeProject.id)
    )
    if (owned) btn.classList.add('is-on')
    actions.insertBefore(btn, actions.firstChild)
  }

  item.append(open, actions)
  // 拖曳與 Alt+方向鍵排序；搜尋中不排序，否則存回去的順序會缺少被過濾掉的那些
  item.addEventListener('pointerdown', onItemPointerDown)
  item.addEventListener('keydown', onItemKeydown)
  return item
}

/** 側欄圖示：跟 composer 的按鈕同一套線條風格，不用 emoji（Segoe 下的 🗑 會縮成一條細線） */
const ICON_PENCIL = ['M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3Z', 'M14.5 6.5l3 3']
const ICON_TRASH = ['M5 7h14', 'M10 5h4', 'M7 7l1 12h8l1-12', 'M10.5 10.5v6', 'M13.5 10.5v6']
const ICON_CHECK = ['M5 12.5l4.5 4.5L19 7.5']
/** 資料夾：對話歸屬用 */
const ICON_FOLDER = ['M4 7.5h5l1.6 2H20v8.5H4Z']

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * @param {HTMLElement} btn
 * @param {string[]} paths SVG path 的 d
 */
function setIconPaths(btn, paths) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.appendChild(path)
  }
  btn.querySelector('svg')?.remove()
  btn.appendChild(svg)
}

/**
 * @param {string[]} paths SVG path 的 d
 * @param {string} label
 * @param {() => void} onClick
 * @returns {HTMLButtonElement}
 */
function listActionButton(paths, label, onClick) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'chat-list-btn'
  btn.title = label
  btn.setAttribute('aria-label', label)
  setIconPaths(btn, paths)
  btn.addEventListener('click', (event) => {
    event.stopPropagation()
    onClick()
  })
  return btn
}

/**
 * 就地改名：標題換成輸入框，Enter／失焦送出，Esc 取消。
 * @param {HTMLElement} item
 * @param {{ id: string, title: string }} conv
 */
function startRename(item, conv) {
  const title = item.querySelector('.chat-list-title')
  if (!title || item.querySelector('.chat-list-rename')) return
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'chat-list-rename'
  input.value = conv.title
  input.maxLength = 60
  input.setAttribute('aria-label', '對話標題')
  let done = false
  const finish = async (commit) => {
    if (done) return
    done = true
    const next = input.value.trim()
    if (commit && next && next !== conv.title) {
      await electronAPI.chat.rename(conv.id, next)
      await reloadList()
    } else {
      input.replaceWith(title)
    }
  }
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); void finish(true) }
    else if (event.key === 'Escape') { event.preventDefault(); void finish(false) }
  })
  input.addEventListener('blur', () => void finish(true))
  // 輸入框裡的拖曳／點擊不該被當成排序或切換對話
  input.addEventListener('pointerdown', (event) => event.stopPropagation())
  title.replaceWith(input)
  input.focus()
  input.select()
}

/**
 * 刪除的二次確認：按鈕就地變成紅色的勾，再按一次才真的刪，逾時自動復原。
 * 不用 `window.confirm`——原生彈窗會擋住整個 App，樣式也跟 Aurora 完全不搭。
 * @param {HTMLButtonElement} btn
 * @param {{ id: string, title: string }} conv
 */
function armDelete(btn, conv) {
  if (btn.dataset.armed === '1') {
    clearTimeout(Number(btn.dataset.timer))
    void deleteConversation(conv)
    return
  }
  disarmDelete()
  btn.dataset.armed = '1'
  btn.classList.add('is-armed')
  btn.title = '再按一次確認刪除'
  btn.setAttribute('aria-label', `再按一次確認刪除「${conv.title}」`)
  setIconPaths(btn, ICON_CHECK)
  btn.dataset.timer = String(setTimeout(disarmDelete, DELETE_ARM_MS))
  armedDeleteBtn = btn
}

/** 復原目前處於「待確認」的刪除鈕（同時只會有一顆） */
function disarmDelete() {
  const btn = armedDeleteBtn
  armedDeleteBtn = null
  if (!btn) return
  clearTimeout(Number(btn.dataset.timer))
  delete btn.dataset.armed
  delete btn.dataset.timer
  btn.classList.remove('is-armed')
  btn.title = '刪除對話'
  btn.setAttribute('aria-label', '刪除對話')
  setIconPaths(btn, ICON_TRASH)
}

/**
 * @param {{ id: string, title: string }} conv
 */
async function deleteConversation(conv) {
  disarmDelete()
  if (streaming && conv.id === currentId) {
    showToast('串流進行中，無法刪除這個對話', 'error')
    return
  }
  await electronAPI.chat.delete(conv.id)
  if (conv.id === currentId) {
    currentId = ''
    await refreshChatPage()
  } else {
    await reloadList()
  }
}

// ===== 側欄排序 =====

/**
 * 目前 DOM 上的完整順序（被搜尋藏起來的維持原相對位置，不會被拖曳順序洗掉）。
 *
 * 只回 `shown` 的話 `persistOrder` 會把沒顯示的對話從記憶體與 `chats.json` 的
 * 順序裡整批擠到後面。沒有過濾時 `mergeVisibleOrder` 的結果就等於 `shown`，所以一律走它。
 */
function currentOrder() {
  const shown = [...listEl.querySelectorAll('.chat-list-item')].map((el) => el.dataset.id)
  return mergeVisibleOrder(conversations.map((c) => c.id), shown)
}

async function persistOrder() {
  const ids = currentOrder()
  conversations = ids
    .map((id) => conversations.find((c) => c.id === id))
    .filter(Boolean)
  await electronAPI.chat.reorder(ids)
}

// 拖曳與 Alt+方向鍵的實作與終端機側欄完全一樣 → 共用 list-reorder.js，不各寫一份
const reorder = createListReorder({
  getList: () => listEl,
  itemSelector: '.chat-list-item',
  ignoreSelector: '.chat-list-btn, .chat-list-rename',
  onCommit: () => void persistOrder()
})
const onItemPointerDown = reorder.onPointerDown
const onItemKeydown = reorder.onKeydown

/**
 * @param {string} id
 */
async function openConversation(id) {
  if (streaming) return
  // 聊天與終端機同頁：點對話就是切回對話主區
  setChatPaneMode('chat')
  const conv = await electronAPI.chat.get(id)
  if (!conv) {
    await reloadList()
    return
  }
  currentId = conv.id
  renderMessages(conv.messages)
  renderList()
  hideError()
}

/**
 * 把一段對話掛到某個專案（空字串＝收回未分類）。
 * @param {{ id: string }} conv
 * @param {string} projectId
 */
async function assignProject(conv, projectId) {
  try {
    await electronAPI.chat.setProject(conv.id, projectId)
  } catch (e) {
    showError(cleanIpcError(e))
    return
  }
  await reloadList()
}

async function handleNew() {
  if (streaming) return
  setChatPaneMode('chat')
  // 在專案裡開的新對話就掛在那個專案底下（沒選專案就是未分類）
  const conv = await electronAPI.chat.create(activeProject.id)
  currentId = conv.id
  renderMessages([])
  await reloadList()
  inputEl?.focus()
}

// ===== 訊息渲染 =====

/**
 * @param {Array<{ role: string, content: string, images?: string[], reasoning?: string }>} messages
 */
function renderMessages(messages) {
  if (!messagesEl) return
  messagesEl.replaceChildren()
  if (!messages.length) {
    const empty = document.createElement('p')
    empty.className = 'chat-empty'
    empty.textContent = '開始新的對話吧。'
    messagesEl.appendChild(empty)
    return
  }
  const lastAssistant = findLastAssistantIndex(messages)
  messages.forEach((msg, i) => {
    appendBubble(msg, { canRegenerate: i === lastAssistant })
  })
  scrollToBottom()
}

/**
 * @param {Array<{ role: string }>} messages
 * @returns {number}
 */
function findLastAssistantIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return i
  }
  return -1
}

/**
 * 建一則訊息泡泡
 * @param {{ role: string, content: string, images?: string[], imageUrls?: string[], reasoning?: string }} msg
 * @param {{ canRegenerate?: boolean, pending?: boolean }} [opts]
 * @returns {{ wrap: HTMLElement, body: HTMLElement, content: HTMLElement }}
 */
function appendBubble(msg, opts = {}) {
  messagesEl.querySelector('.chat-empty')?.remove()
  const isUser = msg.role === 'user'
  const wrap = document.createElement('div')
  wrap.className = `chat-msg chat-msg-${isUser ? 'user' : 'assistant'}`
  // 複製鈕要拿原文，掛成屬性即可（不進 DOM，不必擔心 XSS 或 dataset 爆長）
  wrap.__rawText = msg.content || ''

  const body = document.createElement('div')
  body.className = 'chat-msg-body'

  const urls = msg.imageUrls || []
  if (urls.length || msg.images?.length) {
    body.appendChild(buildImageRow(urls, msg.images || []))
  }
  if (msg.reasoning) body.appendChild(buildThinkBlock(msg.reasoning, false))

  const content = document.createElement('div')
  content.className = 'chat-msg-content'
  if (isUser) {
    // 使用者輸入不走 markdown：原樣顯示才不會被自己打的符號改寫
    content.textContent = msg.content || ''
  } else if (msg.content) {
    content.appendChild(renderMarkdown(msg.content))
  } else if (opts.pending) {
    const dot = document.createElement('span')
    dot.className = 'chat-typing'
    dot.textContent = '…'
    content.appendChild(dot)
  }
  body.appendChild(content)
  wrap.appendChild(body)

  if (!opts.pending) wrap.appendChild(buildActions(msg, opts.canRegenerate === true))
  messagesEl.appendChild(wrap)
  return { wrap, body, content }
}

/**
 * @param {string[]} urls 已知的 data URL（樂觀顯示用）
 * @param {string[]} names 存檔的圖片檔名（跟 main 要）
 * @returns {HTMLElement}
 */
function buildImageRow(urls, names) {
  const row = document.createElement('div')
  row.className = 'chat-msg-images'
  for (const url of urls) row.appendChild(buildImage(url))
  for (const name of names) {
    const img = buildImage(imageCache.get(name) || '')
    if (!imageCache.has(name)) {
      loadImage(name).then((dataUrl) => {
        if (dataUrl) img.src = dataUrl
        else img.remove()
      })
    }
    row.appendChild(img)
  }
  return row
}

/**
 * @param {string} src
 * @returns {HTMLImageElement}
 */
function buildImage(src) {
  const img = document.createElement('img')
  img.alt = '附加圖片'
  img.loading = 'lazy'
  if (src) img.src = src
  return img
}

/**
 * @param {string} name
 * @returns {Promise<string>}
 */
async function loadImage(name) {
  if (imageCache.has(name)) return imageCache.get(name)
  let url = ''
  try {
    url = (await electronAPI.chat.image?.(name)) || ''
  } catch {
    url = ''
  }
  imageCache.set(name, url)
  return url
}

/**
 * @param {string} text
 * @param {boolean} open
 * @returns {HTMLDetailsElement}
 */
function buildThinkBlock(text, open) {
  const details = document.createElement('details')
  details.className = 'chat-think'
  details.open = open
  const summary = document.createElement('summary')
  summary.textContent = '思考過程'
  const bodyEl = document.createElement('div')
  bodyEl.className = 'chat-think-body'
  bodyEl.textContent = text
  details.appendChild(summary)
  details.appendChild(bodyEl)
  return details
}

/**
 * @param {{ role: string }} msg
 * @param {boolean} canRegenerate
 * @returns {HTMLElement}
 */
function buildActions(msg, canRegenerate) {
  const row = document.createElement('div')
  row.className = 'chat-msg-actions'
  row.appendChild(actionButton('複製', 'copy'))
  if (msg.role === 'assistant' && canRegenerate) {
    row.appendChild(actionButton('重新生成', 'regenerate'))
  }
  return row
}

/**
 * @param {string} label
 * @param {string} action
 * @returns {HTMLButtonElement}
 */
function actionButton(label, action) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'chat-msg-action'
  btn.dataset.action = action
  btn.textContent = label
  return btn
}

function isAtBottom() {
  if (!messagesEl) return true
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < BOTTOM_SLACK_PX
}

function scrollToBottom() {
  if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight
}

/**
 * 碼塊複製鈕與每則訊息的操作（事件委派，markdown.js 不綁任何 listener）
 * @param {MouseEvent} event
 */
function onMessagesClick(event) {
  const target = event.target
  const copyCode = target.closest?.('.md-copy')
  if (copyCode) {
    const code = copyCode.closest('.md-code')?.querySelector('code')
    if (code) {
      copyText(code.textContent)
      const prev = copyCode.textContent
      copyCode.textContent = '✓ 已複製'
      copyCode.classList.add('is-copied')
      setTimeout(() => {
        copyCode.textContent = prev
        copyCode.classList.remove('is-copied')
      }, 1500)
    }
    return
  }
  const action = target.closest?.('.chat-msg-action')
  if (!action) return
  const wrap = action.closest('.chat-msg')
  if (action.dataset.action === 'copy') {
    copyText(wrap?.__rawText || '')
    const prev = action.textContent
    action.textContent = '✓ 已複製'
    setTimeout(() => { action.textContent = prev }, 1500)
  } else if (action.dataset.action === 'regenerate') {
    handleRegenerate()
  }
}

/**
 * @param {string} text
 */
function copyText(text) {
  if (!text) return
  navigator.clipboard.writeText(text).then(
    () => showToast('已複製'),
    () => showToast('複製失敗', 'error')
  )
}

// ===== 輸入區 =====

function initComposer() {
  if (!inputEl) return
  inputEl.addEventListener('keydown', onInputKeydown)
  inputEl.addEventListener('input', autoGrowInput)
  inputEl.addEventListener('paste', onPaste)
  inputEl.addEventListener('focus', () => composerEl?.classList.add('is-focused'))
  inputEl.addEventListener('blur', () => composerEl?.classList.remove('is-focused'))
  attachBtn?.addEventListener('click', () => fileInput?.click())
  fileInput?.addEventListener('change', onFilePicked)
  thinkBtn?.addEventListener('click', toggleThinking)
  if (composerEl) {
    composerEl.addEventListener('dragover', onDragOver)
    composerEl.addEventListener('dragleave', onDragLeave)
    composerEl.addEventListener('drop', onDrop)
  }
  autoGrowInput()
}

/**
 * textarea 依內容長高，超過視窗 40% 才內部捲動。
 * 原本 rows=3 + resize:vertical 的拉桿在 flex 版面裡會跟訊息串搶高度。
 */
/**
 * 把一段文字塞進輸入框（不送出——要不要送、要補什麼話由使用者決定）。
 * 已經打了一半的內容不會被蓋掉，接在後面。
 * @param {string} text
 */
function insertIntoComposer(text) {
  if (!inputEl || !text) return
  setChatPaneMode('chat')
  const current = inputEl.value.replace(/\s+$/, '')
  inputEl.value = current ? `${current}\n\n${text}` : text
  autoGrowInput()
  inputEl.focus()
  inputEl.selectionStart = inputEl.value.length
  inputEl.selectionEnd = inputEl.value.length
}

function autoGrowInput() {
  if (!inputEl) return
  inputEl.style.height = 'auto'
  const max = Math.round(window.innerHeight * INPUT_MAX_RATIO)
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, max)}px`
}

/**
 * @param {KeyboardEvent} event
 */
function onInputKeydown(event) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  handleSend()
}

/**
 * @param {ClipboardEvent} event
 */
function onPaste(event) {
  const files = [...(event.clipboardData?.items || [])]
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter(Boolean)
  if (!files.length) return
  event.preventDefault()
  addAttachments(files)
}

/**
 * @param {DragEvent} event
 */
function onDragOver(event) {
  if (![...(event.dataTransfer?.types || [])].includes('Files')) return
  event.preventDefault()
  composerEl?.classList.add('is-dragover')
}

function onDragLeave() {
  composerEl?.classList.remove('is-dragover')
}

/**
 * @param {DragEvent} event
 */
function onDrop(event) {
  const files = [...(event.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'))
  composerEl?.classList.remove('is-dragover')
  if (!files.length) return
  event.preventDefault()
  addAttachments(files)
}

function onFilePicked() {
  const files = [...(fileInput?.files || [])]
  if (fileInput) fileInput.value = ''
  addAttachments(files)
}

/**
 * @param {File[]} files
 */
async function addAttachments(files) {
  const room = MAX_ATTACHMENTS - attachments.length
  if (room <= 0) {
    showToast(`一次最多 ${MAX_ATTACHMENTS} 張圖片`, 'error')
    return
  }
  for (const file of files.slice(0, room)) {
    try {
      const dataUrl = await shrinkImage(file)
      attachments.push({ id: `a_${Date.now().toString(36)}_${attachments.length}`, dataUrl })
    } catch (e) {
      showToast(`圖片讀取失敗：${e?.message || e}`, 'error')
    }
  }
  renderAttachments()
}

/**
 * 縮圖後轉 JPEG data URL（原圖直送會讓 chats.json 的圖片資料夾爆掉，也吃 token）
 * @param {File} file
 * @returns {Promise<string>}
 */
async function shrinkImage(file) {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  // JPEG 沒有透明色，先鋪白底免得透明區變黑
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close?.()
  return canvas.toDataURL('image/jpeg', IMAGE_QUALITY)
}

function renderAttachments() {
  if (!attachmentsEl) return
  attachmentsEl.replaceChildren()
  attachmentsEl.classList.toggle('hidden', !attachments.length)
  for (const item of attachments) {
    const cell = document.createElement('div')
    cell.className = 'chat-attachment'
    cell.appendChild(buildImage(item.dataUrl))
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'chat-attachment-remove'
    remove.textContent = '✕'
    remove.title = '移除'
    remove.setAttribute('aria-label', '移除圖片')
    remove.addEventListener('click', () => {
      attachments = attachments.filter((a) => a.id !== item.id)
      renderAttachments()
    })
    cell.appendChild(remove)
    attachmentsEl.appendChild(cell)
  }
}

function clearAttachments() {
  attachments = []
  renderAttachments()
}

async function toggleThinking() {
  if (!thinkBtn) return
  const next = thinkBtn.getAttribute('aria-pressed') !== 'true'
  thinkBtn.setAttribute('aria-pressed', String(next))
  await electronAPI.store.set('chatThinking', next)
}

async function refreshThinkToggle() {
  if (!thinkBtn) return
  const on = await electronAPI.store.get('chatThinking', false)
  thinkBtn.setAttribute('aria-pressed', String(on === true))
}

// ===== 送出與串流 =====

async function handleSend() {
  if (streaming) {
    await electronAPI.chat.abort(streaming.reqId)
    return
  }
  const text = (inputEl?.value || '').trim()
  const images = attachments.map((a) => a.dataUrl)
  if (!text && !images.length) return
  await startStream({ text, images })
}

async function handleRegenerate() {
  if (streaming) return
  await startStream({ regenerate: true })
}

/**
 * @param {{ text?: string, images?: string[], regenerate?: boolean }} payload
 */
async function startStream({ text = '', images = [], regenerate = false }) {
  if (!currentId) await handleNew()
  hideError()
  if (regenerate) {
    // 舊回覆先從畫面拿掉，串流結束會以 main 的存檔為準重畫
    messagesEl.querySelector('.chat-msg-assistant:last-child')?.remove()
  } else {
    inputEl.value = ''
    autoGrowInput()
    appendBubble({ role: 'user', content: text, imageUrls: images })
    clearAttachments()
  }
  const holder = appendBubble({ role: 'assistant', content: '' }, { pending: true })
  scrollToBottom()

  const reqId = `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  streaming = {
    reqId,
    raw: '',
    reasoning: '',
    contentEl: holder.content,
    bodyEl: holder.body,
    thinkBody: null,
    dirty: false,
    timer: setInterval(flushStream, RENDER_THROTTLE_MS)
  }
  setSendingState(true)
  let result
  try {
    result = await electronAPI.chat.send({
      reqId,
      conversationId: currentId,
      text,
      images,
      regenerate
    })
  } catch (e) {
    result = { ok: false, error: cleanIpcError(e) }
  }
  await finishStream(result)
}

/**
 * @param {{ reqId: string, text: string, kind?: string }} payload
 */
function onDelta(payload) {
  if (!streaming || payload?.reqId !== streaming.reqId) return
  if (payload.kind === 'reasoning') streaming.reasoning += payload.text || ''
  else streaming.raw += payload.text || ''
  streaming.dirty = true
}

function flushStream() {
  if (!streaming || !streaming.dirty) return
  const stick = isAtBottom()
  if (streaming.reasoning) {
    if (!streaming.thinkBody) {
      const block = buildThinkBlock('', true)
      streaming.thinkBody = block.querySelector('.chat-think-body')
      streaming.bodyEl.insertBefore(block, streaming.contentEl)
    }
    streaming.thinkBody.textContent = streaming.reasoning
  }
  if (streaming.raw) streaming.contentEl.replaceChildren(renderMarkdown(streaming.raw))
  streaming.dirty = false
  if (stick) scrollToBottom()
}

/**
 * @param {{ ok: boolean, content?: string, aborted?: boolean, error?: string }} result
 */
async function finishStream(result) {
  if (streaming) {
    clearInterval(streaming.timer)
    streaming.dirty = true
    flushStream()
    streaming = null
  }
  setSendingState(false)
  if (!result?.ok && result?.error) showError(result.error)
  // 以 main 的實際存檔為準重畫，避免樂觀更新與 chats.json 不同步
  if (currentId) {
    const conv = await electronAPI.chat.get(currentId)
    if (conv) renderMessages(conv.messages)
  }
  await reloadList()
  inputEl?.focus()
}

/**
 * @param {boolean} sending
 */
function setSendingState(sending) {
  if (sendBtn) {
    sendBtn.textContent = sending ? '停止' : '送出'
    sendBtn.classList.toggle('btn-danger', sending)
  }
  if (newBtn) newBtn.disabled = sending
  // 側欄的改名／刪除鈕在串流中一併鎖住（切換對話本來就被 openConversation 擋掉）
  listEl?.classList.toggle('is-busy', sending)
  if (modelSelect) modelSelect.disabled = sending
  if (promptSelect) promptSelect.disabled = sending
  if (attachBtn) attachBtn.disabled = sending
  if (thinkBtn) thinkBtn.disabled = sending
}

// ===== 模型與系統提示 =====

async function refreshModelSelect() {
  if (!modelSelect) return
  // 向 main 要選項而不是自己讀 store：「本機模型」那一組是 main 在 router 跑著時
  // 合成的（刻意不落盤），自己讀 `chatProviders` 永遠看不到它
  const options = await electronAPI.chat.providerOptions()
  const providers = Array.isArray(options?.providers) ? options.providers : []
  const activeProviderId = options?.providerId || ''
  const currentModel = options?.modelId || ''
  modelSelect.replaceChildren()

  // option.value 用流水號、真正的資料放 dataset：
  // 不同供應商可以有同名模型，拿模型名當 value 會選錯組。
  let index = 0
  for (const provider of providers) {
    const models = Array.isArray(provider?.models) ? provider.models : []
    if (!models.length) continue
    const imageSet = new Set(provider?.imageModels || [])
    const group = document.createElement('optgroup')
    group.label = provider.name || '未命名供應商'
    for (const model of models) {
      const option = document.createElement('option')
      option.value = String(index)
      index += 1
      option.dataset.providerId = provider.id
      option.dataset.model = model
      // 生圖模型在選單裡標出來，不然選到之後只會覺得「怎麼回了一張圖」
      option.textContent = imageSet.has(model) ? `🖼 ${model}` : model
      if (provider.id === activeProviderId && model === currentModel) option.selected = true
      group.appendChild(option)
    }
    modelSelect.appendChild(group)
  }
  modelSelect.disabled = index === 0
}

async function handleModelChange() {
  const option = modelSelect?.selectedOptions?.[0]
  if (!option) return
  // 順序不能反：main 會拿 chatProviderId 當基準驗證 chatModelId，
  // 先寫 model 的話它會對著舊供應商的清單檢查，然後被收斂成別的模型。
  await electronAPI.store.set('chatProviderId', option.dataset.providerId || '')
  await electronAPI.store.set('chatModelId', option.dataset.model || '')
  await refreshBanner()
}

async function refreshPromptSelect() {
  if (!promptSelect) return
  const [prompts, selected] = await Promise.all([
    electronAPI.store.get('chatPrompts', []),
    electronAPI.store.get('chatPromptId', '')
  ])
  promptSelect.replaceChildren()
  const none = document.createElement('option')
  none.value = ''
  none.textContent = '無系統提示'
  promptSelect.appendChild(none)
  for (const prompt of prompts) {
    const option = document.createElement('option')
    option.value = prompt.id
    option.textContent = prompt.name
    promptSelect.appendChild(option)
  }
  promptSelect.value = prompts.some((p) => p.id === selected) ? selected : ''
}

async function handlePromptChange() {
  if (!promptSelect) return
  await electronAPI.store.set('chatPromptId', promptSelect.value)
}

// ===== 系統提示管理彈窗 =====

function initPromptDialog() {
  if (!promptDialog) return
  document.getElementById('promptAddBtn')?.addEventListener('click', addPromptDraft)
  document.getElementById('promptDeleteBtn')?.addEventListener('click', deletePromptDraft)
  document.getElementById('promptCancelBtn')?.addEventListener('click', () => promptDialog.close())
  document.getElementById('promptSaveBtn')?.addEventListener('click', savePromptDraft)
  promptNameInput?.addEventListener('input', () => updateDraft('name', promptNameInput.value))
  promptContentInput?.addEventListener('input', () =>
    updateDraft('content', promptContentInput.value)
  )
}

async function openPromptDialog() {
  if (!promptDialog) return
  const [prompts, selected] = await Promise.all([
    electronAPI.store.get('chatPrompts', []),
    electronAPI.store.get('chatPromptId', '')
  ])
  promptDraft = prompts.map((p) => ({ id: p.id, name: p.name, content: p.content }))
  promptDraftId = promptDraft.some((p) => p.id === selected) ? selected : promptDraft[0]?.id || ''
  renderPromptDraft()
  promptDialog.showModal()
}

function renderPromptDraft() {
  if (!promptListEl) return
  promptListEl.replaceChildren()
  if (!promptDraft.length) {
    const empty = document.createElement('p')
    empty.className = 'prompt-list-empty'
    empty.textContent = '還沒有提示，按「＋ 新增」建立。'
    promptListEl.appendChild(empty)
  }
  for (const prompt of promptDraft) {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = prompt.id === promptDraftId ? 'prompt-list-item active' : 'prompt-list-item'
    item.textContent = prompt.name || '未命名提示'
    item.addEventListener('click', () => {
      promptDraftId = prompt.id
      renderPromptDraft()
    })
    promptListEl.appendChild(item)
  }
  const current = promptDraft.find((p) => p.id === promptDraftId)
  if (promptNameInput) {
    promptNameInput.value = current?.name || ''
    promptNameInput.disabled = !current
  }
  if (promptContentInput) {
    promptContentInput.value = current?.content || ''
    promptContentInput.disabled = !current
  }
  const deleteBtnEl = document.getElementById('promptDeleteBtn')
  if (deleteBtnEl) deleteBtnEl.disabled = !current
}

/**
 * @param {'name'|'content'} field
 * @param {string} value
 */
function updateDraft(field, value) {
  const current = promptDraft.find((p) => p.id === promptDraftId)
  if (!current) return
  current[field] = value
  if (field === 'name') renderPromptDraft()
}

function addPromptDraft() {
  const id = `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  promptDraft.push({ id, name: '新提示', content: '' })
  promptDraftId = id
  renderPromptDraft()
  promptNameInput?.focus()
  promptNameInput?.select()
}

function deletePromptDraft() {
  promptDraft = promptDraft.filter((p) => p.id !== promptDraftId)
  promptDraftId = promptDraft[0]?.id || ''
  renderPromptDraft()
}

async function savePromptDraft() {
  // 內容留空的不存（main 也會擋，這裡先給使用者一致的結果）
  const cleaned = promptDraft.filter((p) => p.content.trim())
  await electronAPI.store.set('chatPrompts', cleaned)
  if (cleaned.some((p) => p.id === promptDraftId)) {
    await electronAPI.store.set('chatPromptId', promptDraftId)
  }
  await refreshPromptSelect()
  promptDialog?.close()
  showToast('系統提示已儲存')
}

// ===== 狀態列 =====

async function refreshBanner() {
  if (!bannerEl) return
  const [providers, activeId] = await Promise.all([
    electronAPI.store.get('chatProviders', []),
    electronAPI.store.get('chatProviderId', '')
  ])
  const active = providers.find((p) => p.id === activeId) || providers[0] || null
  let message = ''
  if (!providers.length) message = '尚未設定聊天供應商，請到設定新增'
  else if (!active?.apiUrl) message = `供應商「${active?.name || '?'}」的 API URL 不正確`
  else if (!String(active.apiKey || '').trim()) message = `供應商「${active.name}」尚未填 API Key`
  else if (!active.models?.length) message = `供應商「${active.name}」沒有任何模型`
  bannerEl.classList.toggle('hidden', !message)
  if (message && bannerTextEl) bannerTextEl.textContent = message
}

/**
 * @param {string} message
 */
function showError(message) {
  if (!errorEl) return
  errorEl.textContent = message
  errorEl.classList.remove('hidden')
}

function hideError() {
  errorEl?.classList.add('hidden')
}

// ===== 設定頁區塊（由 app.js 的 loadSettingsForm / saveSettings 呼叫）=====

function toggleKeyVisibility() {
  if (!apiKeyInput) return
  const hidden = apiKeyInput.type === 'password'
  apiKeyInput.type = hidden ? 'text' : 'password'
  const btn = document.getElementById('toggleChatApiKeyVisibility')
  if (btn) btn.textContent = hidden ? '🙈' : '👁️'
}

/**
 * @param {string} value
 */
/**
 * @param {string} value
 * @param {{ focus?: boolean }} [options]
 */
function appendModelRow(value, options = {}) {
  if (!modelListEl) return
  const row = document.createElement('div')
  row.className = 'chat-model-row'
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'input'
  input.value = value
  // 生圖與文字走同一個端點、同一組金鑰，差別只在請求要不要帶 modalities，
  // 所以標記就掛在模型那一列，不另開一份「圖片模型」清單
  const flag = document.createElement('label')
  flag.className = 'chat-model-flag'
  flag.title = '這顆是生圖模型（呼叫時帶 modalities: image）'
  const flagBox = document.createElement('input')
  flagBox.type = 'checkbox'
  flagBox.checked = options.image === true
  flagBox.dataset.imageFlag = '1'
  const flagText = document.createElement('span')
  flagText.textContent = '生圖'
  flag.append(flagBox, flagText)
  // placeholder 不可以是 DEFAULT_CHAT_MODEL：新增出來的空列會跟上一列文字一模一樣，
  // 只差在灰色，看起來像重複項而不是「等你填」。
  input.placeholder = '模型 ID'
  input.setAttribute('aria-label', '模型 ID')
  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'btn-icon'
  remove.title = '移除'
  remove.setAttribute('aria-label', '移除模型')
  remove.textContent = '−'
  remove.addEventListener('click', () => row.remove())
  row.append(input, flag, remove)
  modelListEl.appendChild(row)
  if (options.focus) input.focus()
}

/**
 * @returns {{ models: string[], imageModels: string[], dropped: number }} dropped 是空白與重複的總數
 */
function readModelRows() {
  if (!modelListEl) return { models: [], imageModels: [], dropped: 0 }
  const rows = [...modelListEl.querySelectorAll('.chat-model-row')].map((row) => ({
    id: row.querySelector('input[type="text"]')?.value.trim() || '',
    image: row.querySelector('input[data-image-flag]')?.checked === true
  }))
  const seen = new Set()
  const models = []
  const imageModels = []
  for (const row of rows) {
    if (!row.id || seen.has(row.id)) continue
    seen.add(row.id)
    models.push(row.id)
    if (row.image) imageModels.push(row.id)
  }
  return { models, imageModels, dropped: rows.length - models.length }
}

// ===== 供應商草稿 =====

function newProviderId() {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** 把畫面上的欄位收回草稿。切換供應商與儲存前都要先做，否則編輯中的內容會掉。 */
function captureProviderFields() {
  const provider = providerDraft.find((p) => p.id === draftId)
  if (!provider) return 0
  provider.name = providerNameInput?.value.trim() || ''
  provider.apiUrl = apiUrlInput?.value.trim() || ''
  provider.apiKey = apiKeyInput?.value.trim() || ''
  const { models, imageModels, dropped } = readModelRows()
  provider.models = models
  provider.imageModels = imageModels
  return dropped
}

function renderProviderSelect() {
  if (!providerSelect) return
  providerSelect.replaceChildren()
  for (const provider of providerDraft) {
    const option = document.createElement('option')
    option.value = provider.id
    option.textContent = provider.name || '未命名供應商'
    providerSelect.appendChild(option)
  }
  providerSelect.value = draftId
  providerSelect.disabled = providerDraft.length === 0
}

function renderProviderFields() {
  const provider = providerDraft.find((p) => p.id === draftId) || null
  const has = Boolean(provider)
  for (const el of [providerNameInput, apiUrlInput, apiKeyInput, addModelBtn, scanModelsBtn, deleteProviderBtn]) {
    if (el) el.disabled = !has
  }
  if (providerNameInput) providerNameInput.value = provider?.name || ''
  if (apiUrlInput) apiUrlInput.value = provider?.apiUrl || ''
  if (apiKeyInput) apiKeyInput.value = provider?.apiKey || ''
  modelListEl?.replaceChildren()
  const imageSet = new Set(provider?.imageModels || [])
  for (const model of provider?.models || []) appendModelRow(model, { image: imageSet.has(model) })
  if (providerHintEl) {
    providerHintEl.textContent = has
      ? '以下欄位屬於目前選取的供應商，按下方「儲存設定」才會寫入。'
      : '還沒有供應商，按「＋ 新增」建立。'
  }
}

function handleProviderSwitch() {
  captureProviderFields()
  draftId = providerSelect?.value || ''
  renderProviderFields()
}

function handleAddProvider() {
  captureProviderFields()
  if (providerDraft.length >= MAX_PROVIDERS) {
    showToast(`最多 ${MAX_PROVIDERS} 組供應商`, 'error')
    return
  }
  const provider = {
    id: newProviderId(),
    name: '新供應商',
    apiUrl: DEFAULT_CHAT_API_URL,
    apiKey: '',
    models: [],
    imageModels: []
  }
  providerDraft.push(provider)
  draftId = provider.id
  renderProviderSelect()
  renderProviderFields()
  providerNameInput?.focus()
  providerNameInput?.select()
}

function handleDeleteProvider() {
  const provider = providerDraft.find((p) => p.id === draftId)
  if (!provider) return
  const label = provider.name || '未命名供應商'
  if (!window.confirm(`刪除供應商「${label}」？API Key 與模型清單一併移除。`)) return
  providerDraft = providerDraft.filter((p) => p.id !== draftId)
  draftId = providerDraft[0]?.id || ''
  renderProviderSelect()
  renderProviderFields()
}

// ===== 模型掃描 =====

async function handleScanModels() {
  if (!draftId || !scanModelsBtn) return
  captureProviderFields()
  const provider = providerDraft.find((p) => p.id === draftId)
  if (!provider?.apiUrl) {
    showToast('請先填好這個供應商的 API URL', 'error')
    return
  }

  // 掃描是由 main 拿著網址與金鑰出去打的，所以草稿得先落地。
  // renderer 不能直接把網址交給 main——那等於開一個「幫你打任意網址」的代理。
  await electronAPI.store.set('chatProviders', providerDraft)
  await electronAPI.store.set('chatProviderId', draftId)

  const label = scanModelsBtn.textContent
  scanModelsBtn.disabled = true
  scanModelsBtn.textContent = '掃描中…'
  try {
    const result = await electronAPI.chat.scanModels(draftId)
    if (!result?.ok) {
      showToast(result?.error || '掃描失敗', 'error')
      return
    }
    openScanDialog(result.models, provider)
  } catch (error) {
    showToast(cleanIpcError(error), 'error')
  } finally {
    scanModelsBtn.disabled = false
    scanModelsBtn.textContent = label
  }
}

/**
 * @param {string[]} models
 * @param {{ name: string }} provider
 */
function openScanDialog(models, provider) {
  scanResults = models
  scanExisting = new Set(readModelRows().models)
  // 預設一個都不勾：OpenRouter 一次回 300+，全勾等於幫使用者亂塞
  scanSelected = new Set()
  if (scanDescEl) {
    scanDescEl.textContent =
      `掃到 ${models.length} 個模型，勾選要加入的。`
  }
  if (scanSearchInput) scanSearchInput.value = ''
  renderScanList()
  scanDialog?.showModal()
}

function renderScanCount(visible = scanResults.length) {
  if (!scanCountEl) return
  scanCountEl.textContent = `已勾選 ${scanSelected.size} 個・顯示 ${visible} / ${scanResults.length}`
}

/** 全程 createElement + textContent，維持整頁零 innerHTML */
function renderScanList() {
  if (!scanListEl) return
  const query = (scanSearchInput?.value || '').trim().toLowerCase()
  const rows = query ? scanResults.filter((id) => id.toLowerCase().includes(query)) : scanResults

  const items = rows.map((id) => {
    const label = document.createElement('label')
    label.className = 'chat-scan-item'
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = scanSelected.has(id)
    box.addEventListener('change', () => {
      if (box.checked) scanSelected.add(id)
      else scanSelected.delete(id)
      // 只更新計數、不重畫清單：重畫會把捲動位置與搜尋焦點一起弄丟
      renderScanCount(rows.length)
    })
    const text = document.createElement('span')
    text.className = 'chat-scan-id'
    text.textContent = id
    label.append(box, text)
    if (scanExisting.has(id)) {
      const badge = document.createElement('span')
      badge.className = 'chat-scan-badge'
      badge.textContent = '已在清單'
      label.appendChild(badge)
    }
    return label
  })

  scanListEl.replaceChildren(...items)
  renderScanCount(rows.length)
}

/** 只作用在目前搜尋結果上，避免搜尋後按全選卻連沒看到的也一起勾 */
function toggleScanAll(selected) {
  const query = (scanSearchInput?.value || '').trim().toLowerCase()
  const rows = query ? scanResults.filter((id) => id.toLowerCase().includes(query)) : scanResults
  for (const id of rows) {
    if (selected) scanSelected.add(id)
    else scanSelected.delete(id)
  }
  renderScanList()
}

function applyScanSelection() {
  const chosen = [...scanSelected]
  if (!chosen.length) {
    scanDialog?.close()
    return
  }
  const before = readModelRows()
  const imageSet = new Set(before.imageModels)
  const merged = [...new Set([...before.models, ...chosen])]
  const limited = merged.slice(0, MAX_PROVIDER_MODELS)
  modelListEl?.replaceChildren()
  for (const model of limited) appendModelRow(model, { image: imageSet.has(model) })
  scanDialog?.close()
  const skipped = merged.length - limited.length
  showToast(skipped > 0
    ? `已加入模型（超過 ${MAX_PROVIDER_MODELS} 個上限，略過 ${skipped} 個）`
    : `已加入 ${chosen.length} 個模型，記得按儲存設定`)
}

/** 名稱邊打邊反映到下拉，不用等儲存 */
function syncProviderName() {
  const provider = providerDraft.find((p) => p.id === draftId)
  if (!provider) return
  provider.name = providerNameInput?.value.trim() || ''
  const option = [...(providerSelect?.options || [])].find((o) => o.value === draftId)
  if (option) option.textContent = provider.name || '未命名供應商'
}

/**
 * 從 store 重灌聊天設定表單（系統提示已移到聊天頁，不在這裡）
 */
export async function loadChatSettings() {
  initChatPage()
  if (!apiUrlInput) return
  const [providers, activeId] = await Promise.all([
    electronAPI.store.get('chatProviders', []),
    electronAPI.store.get('chatProviderId', '')
  ])
  // 深拷貝一份草稿：直接改 IPC 回來的物件不會有任何效果，反而容易誤以為已經存好了
  providerDraft = (Array.isArray(providers) ? providers : []).map((p) => ({
    id: p.id,
    name: p.name || '',
    apiUrl: p.apiUrl || '',
    apiKey: p.apiKey || '',
    models: Array.isArray(p.models) ? [...p.models] : [],
    imageModels: Array.isArray(p.imageModels) ? [...p.imageModels] : []
  }))
  draftId = providerDraft.find((p) => p.id === activeId)?.id || providerDraft[0]?.id || ''
  renderProviderSelect()
  renderProviderFields()
}

/**
 * 在任何設定落盤前先驗證聊天草稿，避免其他設定已寫入後才發現聊天欄位錯誤。
 * @returns {{ ok: boolean, dropped: number }}
 */
export function validateChatSettings() {
  if (!apiUrlInput) return { ok: true, dropped: 0 }
  const dropped = captureProviderFields()

  const bad = providerDraft.find((p) => p.apiUrl && !/^https?:\/\//i.test(p.apiUrl))
  if (bad) {
    showToast(`供應商「${bad.name || '未命名'}」的 API URL 要以 http:// 或 https:// 開頭`, 'error')
    return { ok: false, dropped }
  }
  return { ok: true, dropped }
}

/**
 * 寫回聊天設定（chatModelId 由 main 在 chatModels 變更時自動收斂）
 * @param {{ ok: boolean, dropped: number } | null} [validation]
 */
export async function saveChatSettings(validation = null) {
  if (!apiUrlInput) return true
  const checked = validation || validateChatSettings()
  if (!checked.ok) return false

  await electronAPI.store.set('chatProviders', providerDraft)
  await electronAPI.store.set('chatProviderId', draftId)
  // 空白與重複的模型列以前是靜默消失的，使用者只會看到自己打的東西不見
  if (checked.dropped > 0) showToast(`已略過 ${checked.dropped} 個空白或重複的模型`)
  await refreshModelSelect()
  await refreshBanner()
  return true
}
