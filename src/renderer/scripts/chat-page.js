/**
 * VoiceInk - 聊天頁（雲端串流 + 多會話）
 *
 * 純雲端，不佔用 ASR／LLM 引擎，所以不做 engine.acquire。
 * 訊息與 model 的所有權在 main：這裡只送 conversationId、文字與圖片 data URL，
 * 串流結束後重新向 main 取整份會話，確保畫面與 chats.json 一致。
 *
 * 不同對話可以同時回應：串流狀態照 conversationId 各存一份，畫面只畫「目前看著的」那一條；
 * 側欄（`chat-sidebar.js`）顯示每個對話是回應中、已完成（還沒看）還是失敗。
 */

import { showToast, electronAPI, cleanIpcError, openSettingsPage, setChatPaneMode } from './app.js'
import { renderMarkdown } from './markdown.js'
import { askConfirm } from './app-dialog.js'
import { createChatSidebar } from './chat-sidebar.js'
import { openParamsDialog, countParams } from './chat-params-panel.js'
import { openImageViewer } from './image-viewer.js'

const DEFAULT_CHAT_API_URL = 'https://openrouter.ai/api/v1'
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
let paramsBtn = null
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
let currentId = ''
/** @type {ReturnType<typeof createChatSidebar> | null} */
let sidebar = null
/**
 * 進行中的串流，照對話分開。
 * `regenerate` 的那條在 chats.json 裡還留著舊回覆（上游成功前不刪），切回來畫面時要藏掉。
 * @typedef {{ reqId: string, raw: string, reasoning: string, dirty: boolean, regenerate: boolean }} Stream
 * @type {Map<string, Stream>}
 */
const streams = new Map()
/** 在背景跑完、還沒被看過的對話 @type {Map<string, { state: 'done'|'error', error: string }>} */
const finished = new Map()
/** 畫面上那顆「回應中」泡泡屬於哪個對話 @type {{ id: string, contentEl: HTMLElement, bodyEl: HTMLElement, thinkBody: HTMLElement | null } | null} */
let liveView = null
let flushTimer = 0
/** 連點兩個對話時只認最後一次 */
let openSeq = 0
/** 待送出的圖片 @type {Array<{ id: string, dataUrl: string }>} */
let attachments = []
/** 圖片檔名 → data URL，避免每次重畫都跟 main 要一次 */
const imageCache = new Map()
/** 提示管理彈窗的草稿 @type {Array<{ id: string, name: string, content: string }>} */
let promptDraft = []
let promptDraftId = ''
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
  paramsBtn = document.getElementById('chatParamsBtn')
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
  if (!messagesEl || !listEl) return
  inited = true

  sidebar = createChatSidebar({
    listEl,
    searchInput,
    getCurrentId: () => currentId,
    statusOf,
    onOpen: (id) => void openConversation(id),
    onNew: (folderId) => void handleNew(folderId),
    onDeleted
  })

  sendBtn?.addEventListener('click', handleSend)
  newBtn?.addEventListener('click', () => void handleNew())
  document.getElementById('chatNewFolderBtn')?.addEventListener('click', () => void sidebar.createFolder())
  paramsBtn?.addEventListener('click', () => void handleParams())
  modelSelect?.addEventListener('change', handleModelChange)
  promptSelect?.addEventListener('change', handlePromptChange)
  promptManageBtn?.addEventListener('click', openPromptDialog)
  messagesEl.addEventListener('click', onMessagesClick)
  addModelBtn?.addEventListener('click', () => appendModelRow('', { focus: true }))
  providerSelect?.addEventListener('change', handleProviderSwitch)
  addProviderBtn?.addEventListener('click', handleAddProvider)
  deleteProviderBtn?.addEventListener('click', () => void handleDeleteProvider())
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
  // AI 取好標題：側欄重讀一次（重畫本身會避開正在改名的輸入框）
  electronAPI.chat.onTitle?.(() => void sidebar.reload())
}

/**
 * 切到聊天頁時呼叫
 */
export async function refreshChatPage() {
  initChatPage()
  if (!inited) return
  await Promise.all([refreshModelSelect(), refreshPromptSelect(), refreshThinkToggle(), refreshBanner()])
  await sidebar.reload()
  const list = sidebar.list()
  if (!currentId || !list.some((c) => c.id === currentId)) {
    if (list.length) await openConversation(list[0].id)
    else await handleNew()
  }
  autoGrowInput()
}

// ===== 會話 =====

/**
 * @param {string} id
 * @param {{ streaming?: boolean }} [conv] main 回報的狀態（renderer 重載後自己的 streams 是空的）
 * @returns {'running'|'done'|'error'|''}
 */
function statusOf(id, conv) {
  if (streams.has(id) || conv?.streaming) return 'running'
  return finished.get(id)?.state || ''
}

/**
 * @param {string} id
 */
async function onDeleted(id) {
  finished.delete(id)
  if (id !== currentId) {
    await sidebar.reload()
    return
  }
  currentId = ''
  liveView = null
  await refreshChatPage()
}

/**
 * @param {string} id
 */
async function openConversation(id) {
  // 聊天與終端機同頁：點對話就是切回對話主區
  setChatPaneMode('chat')
  const seq = ++openSeq
  const conv = await electronAPI.chat.get(id)
  if (seq !== openSeq) return
  if (!conv) {
    await sidebar.reload()
    return
  }
  currentId = conv.id
  showConversation(conv)
  const seen = finished.get(conv.id)
  finished.delete(conv.id)
  sidebar.render()
  if (seen?.state === 'error' && seen.error) showError(seen.error)
  else hideError()
}

/**
 * 把一個對話畫到主區；它還在回應的話接上那條串流。
 * @param {{ id: string, messages: Array<object>, params?: Record<string, unknown> }} conv
 */
function showConversation(conv) {
  const stream = streams.get(conv.id)
  liveView = null
  renderMessages(stream?.regenerate ? withoutTrailingAssistant(conv.messages) : conv.messages)
  if (stream) attachLiveView(conv.id, stream)
  paintParamsBtn(conv.params)
  syncComposer()
}

/**
 * @param {Array<{ role: string }>} messages
 */
function withoutTrailingAssistant(messages) {
  let end = messages.length
  while (end > 0 && messages[end - 1].role === 'assistant') end -= 1
  return messages.slice(0, end)
}

/**
 * @param {string} [folderId] 從資料夾選單開的就放進那個資料夾
 */
async function handleNew(folderId = '') {
  setChatPaneMode('chat')
  openSeq += 1
  const conv = await electronAPI.chat.create(folderId)
  currentId = conv.id
  showConversation(conv)
  hideError()
  await sidebar.reload()
  inputEl?.focus()
}

async function handleParams() {
  if (!currentId) return
  const params = await openParamsDialog(currentId)
  if (params) paintParamsBtn(params)
}

/**
 * @param {Record<string, unknown> | undefined} params
 */
function paintParamsBtn(params) {
  if (!paramsBtn) return
  const count = countParams(params)
  paramsBtn.classList.toggle('is-on', count > 0)
  const label = paramsBtn.querySelector('span')
  if (label) label.textContent = count ? `參數 ${count}` : '參數'
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
  const last = messages.length - 1
  messages.forEach((msg, i) => {
    appendBubble(msg, {
      index: i,
      // 最後一則是助理＝可以重新生成；是還沒有回覆的使用者訊息（上次失敗）＝可以重新送出
      canRegenerate: i === last
    })
  })
  scrollToBottom()
}

/**
 * 建一則訊息泡泡
 * @param {{ role: string, content: string, images?: string[], imageUrls?: string[], reasoning?: string,
 *   model?: string, ms?: number, tokens?: number }} msg
 * @param {{ index?: number, canRegenerate?: boolean, pending?: boolean }} [opts]
 * @returns {{ wrap: HTMLElement, body: HTMLElement, content: HTMLElement }}
 */
function appendBubble(msg, opts = {}) {
  messagesEl.querySelector('.chat-empty')?.remove()
  const isUser = msg.role === 'user'
  const wrap = document.createElement('div')
  wrap.className = `chat-msg chat-msg-${isUser ? 'user' : 'assistant'}`
  if (Number.isInteger(opts.index)) wrap.dataset.index = String(opts.index)
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

  if (!opts.pending) wrap.appendChild(buildActions(msg, opts))
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
  // 訊息裡只有縮圖，點了要看得到原圖（src 是非同步補上的，點的當下再讀）
  img.addEventListener('click', () => {
    const url = img.currentSrc || img.src
    if (!url) return
    openImageViewer({
      items: [{ path: url, name: '圖片' }],
      mediaUrl: async (path) => ({ ok: true, data: { url: path } })
    })
  })
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
 * 會改到訊息串的操作（編輯、刪除、重新生成）標 `data-busy-hide`：
 * 那個對話回應中時由 CSS 藏起來（main 那邊也會拒絕）。
 * @param {{ role: string, model?: string, ms?: number, tokens?: number }} msg
 * @param {{ canRegenerate?: boolean }} opts
 * @returns {HTMLElement}
 */
function buildActions(msg, opts) {
  const row = document.createElement('div')
  row.className = 'chat-msg-actions'
  row.appendChild(actionButton('複製', 'copy'))
  if (msg.role === 'user') row.appendChild(actionButton('編輯', 'edit', true))
  if (opts.canRegenerate) {
    row.appendChild(actionButton(msg.role === 'user' ? '重新送出' : '重新生成', 'regenerate', true))
  }
  row.appendChild(actionButton('分叉', 'fork'))
  row.appendChild(actionButton('刪除', 'delete', true))
  const meta = msg.role === 'assistant' ? replyMeta(msg) : ''
  if (meta) {
    const info = document.createElement('span')
    info.className = 'chat-msg-meta'
    info.textContent = meta
    row.appendChild(info)
  }
  return row
}

/**
 * 「模型 · 3.2 秒 · 120 tokens · 37.5 tok/s」
 * @param {{ model?: string, ms?: number, tokens?: number }} msg
 * @returns {string}
 */
function replyMeta(msg) {
  const parts = []
  if (msg.model) parts.push(msg.model)
  if (msg.ms) parts.push(`${(msg.ms / 1000).toFixed(1)} 秒`)
  if (msg.tokens) {
    parts.push(`${msg.tokens} tokens`)
    if (msg.ms) parts.push(`${(msg.tokens / (msg.ms / 1000)).toFixed(1)} tok/s`)
  }
  return parts.join(' · ')
}

/**
 * @param {string} label
 * @param {string} action
 * @param {boolean} [busyHide]
 * @returns {HTMLButtonElement}
 */
function actionButton(label, action, busyHide = false) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'chat-msg-action'
  btn.dataset.action = action
  if (busyHide) btn.dataset.busyHide = '1'
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
  const index = Number(wrap?.dataset.index)
  const kind = action.dataset.action
  if (kind === 'copy') {
    copyText(wrap?.__rawText || '')
    const prev = action.textContent
    action.textContent = '✓ 已複製'
    setTimeout(() => { action.textContent = prev }, 1500)
  } else if (kind === 'regenerate') {
    void handleRegenerate()
  } else if (kind === 'edit') {
    startEdit(wrap, index)
  } else if (kind === 'fork') {
    void handleFork(index)
  } else if (kind === 'delete') {
    armMessageDelete(action, index)
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

// ===== 訊息操作 =====

/**
 * 就地編輯一則使用者訊息：送出後，這則之後的訊息全部拿掉、重新生成回覆。
 * @param {HTMLElement} wrap
 * @param {number} index
 */
function startEdit(wrap, index) {
  const convId = currentId
  const contentEl = wrap.querySelector('.chat-msg-content')
  const actions = /** @type {HTMLElement | null} */ (wrap.querySelector('.chat-msg-actions'))
  if (streams.has(convId) || !contentEl || wrap.querySelector('.chat-edit')) return
  const box = document.createElement('div')
  box.className = 'chat-edit'
  const area = document.createElement('textarea')
  area.className = 'chat-edit-input'
  area.value = wrap.__rawText || ''
  area.setAttribute('aria-label', '編輯訊息')
  const bar = document.createElement('div')
  bar.className = 'chat-edit-bar'
  const hint = document.createElement('span')
  hint.className = 'composer-hint'
  hint.textContent = '送出後，這則之後的訊息會被取代'
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'btn btn-secondary btn-sm'
  cancel.textContent = '取消'
  const save = document.createElement('button')
  save.type = 'button'
  save.className = 'btn btn-primary btn-sm'
  save.textContent = '送出'
  bar.append(hint, cancel, save)
  box.append(area, bar)

  const close = () => {
    box.replaceWith(contentEl)
    if (actions) actions.hidden = false
  }
  const submit = async () => {
    save.disabled = true
    const conv = await electronAPI.chat.editMessage(convId, index, area.value)
    if (!conv) {
      save.disabled = false
      showToast('這則訊息現在不能編輯', 'error')
      return
    }
    if (convId !== currentId) return
    showConversation(conv)
    await startStream({ regenerate: true })
  }
  cancel.addEventListener('click', close)
  save.addEventListener('click', () => void submit())
  area.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); close() }
    else if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void submit() }
  })
  area.addEventListener('input', () => {
    area.style.height = 'auto'
    area.style.height = `${Math.min(area.scrollHeight, Math.round(window.innerHeight * INPUT_MAX_RATIO))}px`
  })
  contentEl.replaceWith(box)
  if (actions) actions.hidden = true
  area.dispatchEvent(new Event('input'))
  area.focus()
}

/**
 * 從這一則（含）往前複製成新對話並切過去
 * @param {number} index
 */
async function handleFork(index) {
  const conv = await electronAPI.chat.fork(currentId, index)
  if (!conv) {
    showToast('分叉失敗', 'error')
    return
  }
  await openConversation(conv.id)
  await sidebar.reload()
}

/**
 * 刪除單則訊息：按鈕就地變「確認刪除」，再按一次才刪
 * @param {HTMLButtonElement} btn
 * @param {number} index
 */
function armMessageDelete(btn, index) {
  if (btn.dataset.armed !== '1') {
    btn.dataset.armed = '1'
    btn.classList.add('is-armed')
    btn.textContent = '確認刪除'
    btn.dataset.timer = String(setTimeout(() => {
      delete btn.dataset.armed
      btn.classList.remove('is-armed')
      btn.textContent = '刪除'
    }, DELETE_ARM_MS))
    return
  }
  clearTimeout(Number(btn.dataset.timer))
  const convId = currentId
  void (async () => {
    const ok = await electronAPI.chat.deleteMessage(convId, index)
    if (!ok) showToast('這則訊息現在不能刪除', 'error')
    const conv = await electronAPI.chat.get(convId)
    if (conv && convId === currentId) showConversation(conv)
    await sidebar.reload()
  })()
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
  // 回應中按 Enter 不當成「停止」：使用者多半是打好下一句想送，砍掉正在寫的回覆太意外。停止只走按鈕
  if (streams.has(currentId)) return
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
  const dropped = [...(event.dataTransfer?.files || [])]
  const files = dropped.filter((f) => f.type.startsWith('image/'))
  composerEl?.classList.remove('is-dragover')
  if (!files.length) {
    // 拖的時候框已經亮了，放開卻什麼都沒發生會像壞掉
    if (dropped.length) {
      event.preventDefault()
      showToast('只能附加圖片', 'error')
    }
    return
  }
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
  const running = streams.get(currentId)
  if (running) {
    await electronAPI.chat.abort(running.reqId)
    return
  }
  const text = (inputEl?.value || '').trim()
  const images = attachments.map((a) => a.dataUrl)
  if (!text && !images.length) return
  await startStream({ text, images })
}

async function handleRegenerate() {
  if (streams.has(currentId)) return
  await startStream({ regenerate: true })
}

/**
 * @param {{ text?: string, images?: string[], regenerate?: boolean }} payload
 */
async function startStream({ text = '', images = [], regenerate = false }) {
  if (!currentId) await handleNew()
  const convId = currentId
  if (streams.has(convId)) return
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

  const reqId = `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const stream = { reqId, raw: '', reasoning: '', dirty: false, regenerate }
  streams.set(convId, stream)
  finished.delete(convId)
  attachLiveView(convId, stream)
  scrollToBottom()
  if (!flushTimer) flushTimer = setInterval(flushStream, RENDER_THROTTLE_MS)
  syncComposer()
  sidebar.paintStatus(convId)

  let result
  try {
    result = await electronAPI.chat.send({ reqId, conversationId: convId, text, images, regenerate })
  } catch (e) {
    result = { ok: false, error: cleanIpcError(e) }
  }
  await finishStream(convId, result)
}

/**
 * 在主區尾端掛一顆「回應中」泡泡，接上那條串流目前收到的內容
 * @param {string} convId
 * @param {Stream} stream
 */
function attachLiveView(convId, stream) {
  const holder = appendBubble({ role: 'assistant', content: '' }, { pending: true })
  liveView = { id: convId, contentEl: holder.content, bodyEl: holder.body, thinkBody: null }
  stream.dirty = true
  flushStream()
}

/**
 * 背景的對話也照收，只是不畫；切回去時 `attachLiveView` 一次補齊
 * @param {{ reqId: string, conversationId: string, text: string, kind?: string }} payload
 */
function onDelta(payload) {
  const stream = streams.get(payload?.conversationId)
  if (!stream || payload.reqId !== stream.reqId) return
  if (payload.kind === 'reasoning') stream.reasoning += payload.text || ''
  else stream.raw += payload.text || ''
  stream.dirty = true
}

function flushStream() {
  const stream = liveView && liveView.id === currentId ? streams.get(liveView.id) : null
  if (!stream || !stream.dirty) return
  const stick = isAtBottom()
  if (stream.reasoning) {
    if (!liveView.thinkBody) {
      const block = buildThinkBlock('', true)
      liveView.thinkBody = block.querySelector('.chat-think-body')
      liveView.bodyEl.insertBefore(block, liveView.contentEl)
    }
    liveView.thinkBody.textContent = stream.reasoning
  }
  if (stream.raw) liveView.contentEl.replaceChildren(renderMarkdown(stream.raw))
  stream.dirty = false
  if (stick) scrollToBottom()
}

/**
 * @param {string} convId
 * @param {{ ok: boolean, content?: string, aborted?: boolean, error?: string }} result
 */
async function finishStream(convId, result) {
  if (liveView?.id === convId) {
    flushStream()
    liveView = null
  }
  streams.delete(convId)
  if (!streams.size && flushTimer) {
    clearInterval(flushTimer)
    flushTimer = 0
  }
  const error = !result?.ok && result?.error ? result.error : ''
  if (convId === currentId) {
    if (error) showError(error)
    // 以 main 的實際存檔為準重畫，避免樂觀更新與 chats.json 不同步
    const conv = await electronAPI.chat.get(convId)
    // 等 main 回來的期間使用者可能已經切走、或在這個對話又送出了新的一則
    if (conv && convId === currentId && !streams.has(convId)) showConversation(conv)
    // 使用者正在別處打字（改名、編輯訊息）時不搶焦點
    const active = document.activeElement
    if (!active || active === document.body || active === sendBtn || active === inputEl) inputEl?.focus()
  } else if (sidebar.list().some((c) => c.id === convId)) {
    finished.set(convId, { state: error ? 'error' : 'done', error })
  }
  syncComposer()
  await sidebar.reload()
}

/** 送出鈕與訊息操作只看「目前這個對話」有沒有在回應 */
function syncComposer() {
  const busy = streams.has(currentId)
  if (sendBtn) {
    sendBtn.textContent = busy ? '停止' : '送出'
    sendBtn.classList.toggle('btn-danger', busy)
  }
  const hint = document.getElementById('chatComposerHint')
  if (hint) hint.textContent = busy ? '回應中 · 按「停止」中斷' : 'Enter 送出 · Shift+Enter 換行'
  messagesEl?.classList.toggle('is-busy', busy)
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
  let matched = false
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
      if (provider.id === activeProviderId && model === currentModel) {
        option.selected = true
        matched = true
      }
      group.appendChild(option)
    }
    modelSelect.appendChild(group)
  }
  // 存的模型已不在清單裡（例如設定頁刪掉了）：main 會拒絕送出，
  // 別讓瀏覽器預設顯示第一顆、看起來像已經選好
  if (index > 0 && !matched) {
    const placeholder = document.createElement('option')
    placeholder.value = ''
    placeholder.textContent = '請選擇模型'
    placeholder.disabled = true
    placeholder.selected = true
    modelSelect.prepend(placeholder)
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

async function handleDeleteProvider() {
  const provider = providerDraft.find((p) => p.id === draftId)
  if (!provider) return
  const label = provider.name || '未命名供應商'
  const yes = await askConfirm(`刪除供應商「${label}」？`, {
    desc: 'API Key 與模型清單一併移除。',
    confirmText: '刪除',
    danger: true
  })
  if (!yes) return
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
  // 空白與重複的模型列略過幾筆，由呼叫端（設定頁的 saveSettings）併進「設定已儲存」那則提示
  await refreshModelSelect()
  await refreshBanner()
  return true
}
