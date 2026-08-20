/**
 * VoiceInk - 聊天頁（雲端串流 + 多會話）
 *
 * 純雲端，不佔用 ASR／LLM 引擎，所以不做 engine.acquire。
 * 訊息與 model 的所有權在 main：這裡只送 conversationId、文字與圖片 data URL，
 * 串流結束後重新向 main 取整份會話，確保畫面與 chats.json 一致。
 */

import { showToast, electronAPI, cleanIpcError, openSettingsPage } from './app.js'
import { renderMarkdown } from './markdown.js'

const DEFAULT_CHAT_API_URL = 'https://openrouter.ai/api/v1'
const DEFAULT_CHAT_MODEL = 'google/gemini-3-flash-preview'

/** 串流重繪節流；每次重繪整則訊息 */
const RENDER_THROTTLE_MS = 60
/** 捲到底的判定容差 */
const BOTTOM_SLACK_PX = 48
/** 刪除鈕二次確認的回復時間 */
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
let deleteBtn = null
let titleInput = null
let modelSelect = null
let promptSelect = null
let promptManageBtn = null
let bannerEl = null
let bannerTextEl = null
let errorEl = null
// 設定頁
let apiUrlInput = null
let apiKeyInput = null
let modelListEl = null
let addModelBtn = null
// 提示管理彈窗
let promptDialog = null
let promptListEl = null
let promptNameInput = null
let promptContentInput = null

// ===== 狀態 =====
/** @type {Array<{ id: string, title: string, updatedAt: number, messageCount: number }>} */
let conversations = []
let currentId = ''
let searchTerm = ''
/** @type {{ reqId: string, raw: string, reasoning: string, contentEl: HTMLElement, bodyEl: HTMLElement, thinkBody: HTMLElement | null, dirty: boolean, timer: number } | null} */
let streaming = null
/** 待送出的圖片 @type {Array<{ id: string, dataUrl: string }>} */
let attachments = []
/** 圖片檔名 → data URL，避免每次重畫都跟 main 要一次 */
const imageCache = new Map()
/** 提示管理彈窗的草稿 @type {Array<{ id: string, name: string, content: string }>} */
let promptDraft = []
let promptDraftId = ''
let deleteArmed = false
let deleteTimer = 0
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
  deleteBtn = document.getElementById('chatDeleteBtn')
  titleInput = document.getElementById('chatTitleInput')
  modelSelect = document.getElementById('chatModelSelect')
  promptSelect = document.getElementById('chatPromptSelect')
  promptManageBtn = document.getElementById('chatPromptManageBtn')
  bannerEl = document.getElementById('chatBanner')
  bannerTextEl = document.getElementById('chatBannerText')
  errorEl = document.getElementById('chatError')
  apiUrlInput = document.getElementById('chatApiUrlInput')
  apiKeyInput = document.getElementById('chatApiKeyInput')
  modelListEl = document.getElementById('chatModelList')
  addModelBtn = document.getElementById('chatAddModelBtn')
  promptDialog = document.getElementById('chatPromptDialog')
  promptListEl = document.getElementById('promptList')
  promptNameInput = document.getElementById('promptNameInput')
  promptContentInput = document.getElementById('promptContentInput')
  if (!messagesEl) return
  inited = true

  sendBtn?.addEventListener('click', handleSend)
  newBtn?.addEventListener('click', handleNew)
  deleteBtn?.addEventListener('click', handleDelete)
  titleInput?.addEventListener('change', handleRename)
  modelSelect?.addEventListener('change', handleModelChange)
  promptSelect?.addEventListener('change', handlePromptChange)
  promptManageBtn?.addEventListener('click', openPromptDialog)
  searchInput?.addEventListener('input', onSearchInput)
  messagesEl.addEventListener('click', onMessagesClick)
  addModelBtn?.addEventListener('click', () => appendModelRow(''))
  document.getElementById('chatOpenSettingsBtn')?.addEventListener('click', openSettingsPage)
  document.getElementById('toggleChatApiKeyVisibility')?.addEventListener('click', toggleKeyVisibility)

  initComposer()
  initPromptDialog()

  document.addEventListener('settings-changed', () => {
    refreshModelSelect()
    refreshBanner()
  })

  electronAPI.chat.onDelta(onDelta)
}

/**
 * 切到聊天頁時呼叫
 */
export async function refreshChatPage() {
  initChatPage()
  if (!inited) return
  await Promise.all([refreshModelSelect(), refreshPromptSelect(), refreshThinkToggle(), refreshBanner()])
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
  for (const conv of visible) {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = conv.id === currentId ? 'chat-list-item active' : 'chat-list-item'
    const title = document.createElement('span')
    title.className = 'chat-list-title'
    title.textContent = conv.title
    const meta = document.createElement('span')
    meta.className = 'chat-list-meta'
    meta.textContent = `${conv.messageCount} 則`
    item.appendChild(title)
    item.appendChild(meta)
    item.addEventListener('click', () => openConversation(conv.id))
    listEl.appendChild(item)
  }
}

/**
 * @param {string} id
 */
async function openConversation(id) {
  if (streaming) return
  const conv = await electronAPI.chat.get(id)
  if (!conv) {
    await reloadList()
    return
  }
  currentId = conv.id
  if (titleInput) titleInput.value = conv.title
  renderMessages(conv.messages)
  renderList()
  hideError()
}

async function handleNew() {
  if (streaming) return
  const conv = await electronAPI.chat.create()
  currentId = conv.id
  if (titleInput) titleInput.value = conv.title
  renderMessages([])
  await reloadList()
  inputEl?.focus()
}

async function handleRename() {
  if (!currentId || !titleInput) return
  await electronAPI.chat.rename(currentId, titleInput.value)
  await reloadList()
}

async function handleDelete() {
  if (!currentId || streaming || !deleteBtn) return
  if (!deleteArmed) {
    deleteArmed = true
    deleteBtn.textContent = '確認刪除'
    deleteBtn.classList.add('chat-delete-armed')
    clearTimeout(deleteTimer)
    deleteTimer = setTimeout(disarmDelete, DELETE_ARM_MS)
    return
  }
  disarmDelete()
  await electronAPI.chat.delete(currentId)
  currentId = ''
  await refreshChatPage()
}

function disarmDelete() {
  clearTimeout(deleteTimer)
  deleteArmed = false
  if (!deleteBtn) return
  deleteBtn.textContent = '刪除'
  deleteBtn.classList.remove('chat-delete-armed')
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
    if (code) copyText(code.textContent)
    return
  }
  const action = target.closest?.('.chat-msg-action')
  if (!action) return
  const wrap = action.closest('.chat-msg')
  if (action.dataset.action === 'copy') copyText(wrap?.__rawText || '')
  else if (action.dataset.action === 'regenerate') handleRegenerate()
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
    if (conv) {
      if (titleInput) titleInput.value = conv.title
      renderMessages(conv.messages)
    }
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
  if (deleteBtn) deleteBtn.disabled = sending
  if (modelSelect) modelSelect.disabled = sending
  if (promptSelect) promptSelect.disabled = sending
  if (attachBtn) attachBtn.disabled = sending
  if (thinkBtn) thinkBtn.disabled = sending
}

// ===== 模型與系統提示 =====

async function refreshModelSelect() {
  if (!modelSelect) return
  const models = await electronAPI.store.get('chatModels', [DEFAULT_CHAT_MODEL])
  const current = await electronAPI.store.get('chatModelId', models[0] || DEFAULT_CHAT_MODEL)
  modelSelect.replaceChildren()
  for (const model of models) {
    const option = document.createElement('option')
    option.value = model
    option.textContent = model
    modelSelect.appendChild(option)
  }
  modelSelect.value = current
}

async function handleModelChange() {
  if (!modelSelect) return
  await electronAPI.store.set('chatModelId', modelSelect.value)
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
  const apiKey = await electronAPI.store.get('chatApiKey', '')
  const missing = !String(apiKey || '').trim()
  bannerEl.classList.toggle('hidden', !missing)
  if (missing && bannerTextEl) bannerTextEl.textContent = '尚未設定聊天 API Key'
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
function appendModelRow(value) {
  if (!modelListEl) return
  const row = document.createElement('div')
  row.className = 'chat-model-row'
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'input'
  input.value = value
  input.placeholder = DEFAULT_CHAT_MODEL
  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'btn-icon'
  remove.title = '移除'
  remove.setAttribute('aria-label', '移除模型')
  remove.textContent = '−'
  remove.addEventListener('click', () => row.remove())
  row.appendChild(input)
  row.appendChild(remove)
  modelListEl.appendChild(row)
}

function readModelRows() {
  if (!modelListEl) return []
  return [...modelListEl.querySelectorAll('input')].map((i) => i.value.trim()).filter(Boolean)
}

/**
 * 從 store 重灌聊天設定表單（系統提示已移到聊天頁，不在這裡）
 */
export async function loadChatSettings() {
  initChatPage()
  if (!apiUrlInput) return
  const [apiUrl, apiKey, models] = await Promise.all([
    electronAPI.store.get('chatApiUrl', DEFAULT_CHAT_API_URL),
    electronAPI.store.get('chatApiKey', ''),
    electronAPI.store.get('chatModels', [DEFAULT_CHAT_MODEL])
  ])
  apiUrlInput.value = apiUrl || DEFAULT_CHAT_API_URL
  apiKeyInput.value = apiKey || ''
  modelListEl?.replaceChildren()
  const list = models.length ? models : [DEFAULT_CHAT_MODEL]
  for (const model of list) appendModelRow(model)
}

/**
 * 寫回聊天設定（chatModelId 由 main 在 chatModels 變更時自動收斂）
 */
export async function saveChatSettings() {
  if (!apiUrlInput) return
  const models = readModelRows()
  await Promise.all([
    electronAPI.store.set('chatApiUrl', apiUrlInput.value.trim() || DEFAULT_CHAT_API_URL),
    electronAPI.store.set('chatApiKey', apiKeyInput.value.trim()),
    electronAPI.store.set('chatModels', models.length ? models : [DEFAULT_CHAT_MODEL])
  ])
  await refreshModelSelect()
  await refreshBanner()
}
