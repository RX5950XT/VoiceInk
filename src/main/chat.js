/**
 * VoiceInk - 雲端聊天（Main Process）
 *
 * OpenAI 相容 `/chat/completions` + `stream: true`。
 * 訊息歷史與 model 的所有權都在 main：renderer 只送
 * `{ reqId, conversationId, text, images?, regenerate? }`，
 * 其餘一律從 store / chat-store 讀 → renderer（或 XSS）無法指定任意 model、
 * 也無法繞過上下文上限塞任意 history。
 */

const chatStore = require('./chat-store')
const chatImages = require('./chat-images')

const DEFAULT_CHAT_API_URL = 'https://openrouter.ai/api/v1'
const DEFAULT_CHAT_MODEL = 'google/gemini-3-flash-preview'

/** 單則輸入上限（與 chat-store.MAX_CONTENT 一致） */
const MAX_INPUT_CHARS = 32000
/** 送出上下文總量上限，超過從最舊丟起 */
const MAX_CONTEXT_CHARS = 24000
/** 首個 token 逾時：連上了但模型一直不吐字 */
const FIRST_TOKEN_TIMEOUT_MS = 60000
/** 閒置逾時：串流中斷但連線沒關 */
const IDLE_TIMEOUT_MS = 120000
/** 只把最近幾則訊息的圖片送進 API：長對話每次重傳全部圖片會爆 token 與頻寬 */
const IMAGE_CONTEXT_MESSAGES = 6
/** thinking 開啟時帶的強度（OpenAI／OpenRouter／xAI 等相容欄位） */
const REASONING_EFFORT = 'medium'

/** 系統提示 preset 上限 */
const MAX_PROMPTS = 20
const MAX_PROMPT_NAME = 40
const MAX_PROMPT_CONTENT = 4000

/** @type {import('electron-store') | null} */
let store = null

/** 同時只允許一個請求 @type {{ reqId: string, controller: AbortController, reason: string } | null} */
let inflight = null

/**
 * @param {import('electron-store')} value
 */
function setStore(value) {
  store = value
}

/**
 * 從設定 store 取聊天設定（store:set 已校驗過，這裡是縱深防禦）
 * @returns {{ apiUrl: string, apiKey: string, modelId: string, systemPrompt: string, thinking: boolean }}
 */
function readConfig() {
  const rawUrl = String(store?.get('chatApiUrl', DEFAULT_CHAT_API_URL) || '').trim()
  const apiUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : DEFAULT_CHAT_API_URL
  const models = sanitizeModels(store?.get('chatModels', [DEFAULT_CHAT_MODEL]))
  const wanted = String(store?.get('chatModelId', '') || '').trim()
  return {
    apiUrl,
    apiKey: String(store?.get('chatApiKey', '') || '').trim(),
    modelId: models.includes(wanted) ? wanted : '',
    systemPrompt: readSystemPrompt(),
    thinking: store?.get('chatThinking', false) === true
  }
}

/**
 * 系統提示改為多組 preset 擇一：`chatPromptId` 為空或找不到 → 不帶 system。
 * @returns {string}
 */
function readSystemPrompt() {
  const prompts = sanitizePrompts(store?.get('chatPrompts', []))
  const id = String(store?.get('chatPromptId', '') || '')
  return prompts.find((p) => p.id === id)?.content || ''
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function sanitizeModels(raw) {
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.filter((m) => typeof m === 'string').map((m) => m.trim()).filter(Boolean))]
}

/**
 * 系統提示清單正規化：id 走 allowlist 字元、內容非空、限量
 * @param {unknown} raw
 * @returns {Array<{ id: string, name: string, content: string }>}
 */
function sanitizePrompts(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const id = typeof item.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(item.id) ? item.id : ''
    const content =
      typeof item.content === 'string' ? item.content.trim().slice(0, MAX_PROMPT_CONTENT) : ''
    if (!id || !content || seen.has(id)) continue
    seen.add(id)
    const name =
      typeof item.name === 'string'
        ? item.name.trim().replace(/\s+/g, ' ').slice(0, MAX_PROMPT_NAME)
        : ''
    out.push({ id, name: name || '未命名提示', content })
    if (out.length >= MAX_PROMPTS) break
  }
  return out
}

/**
 * 組送出的 messages：system（若有）＋ 裁切後的歷史。
 * 從最舊丟起；最後一則（使用者剛送出的）永遠保留，即使自己就超標。
 * @param {Array<{role: string, content: string, imageUrls?: string[]}>} history
 * @param {string} systemPrompt
 */
function buildMessages(history, systemPrompt) {
  const kept = []
  let total = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]
    const size = msg.content.length
    if (kept.length && total + size > MAX_CONTEXT_CHARS) break
    kept.unshift(msg)
    total += size
  }
  const messages = kept.map(toApiMessage)
  if (systemPrompt) messages.unshift({ role: 'system', content: systemPrompt })
  return messages
}

/**
 * 有圖片時走 OpenAI 多模態陣列格式，否則維持純字串（相容不支援陣列的端點）
 * @param {{role: string, content: string, imageUrls?: string[]}} m
 */
function toApiMessage(m) {
  if (!m.imageUrls?.length) return { role: m.role, content: m.content }
  const parts = m.imageUrls.map((url) => ({ type: 'image_url', image_url: { url } }))
  if (m.content) parts.unshift({ type: 'text', text: m.content })
  return { role: m.role, content: parts }
}

/**
 * 把最近幾則訊息的圖片檔名換成 data URL（更舊的不重傳）
 * @param {Array<{role: string, content: string, images?: string[]}>} history
 */
async function withImageUrls(history) {
  const from = Math.max(0, history.length - IMAGE_CONTEXT_MESSAGES)
  const out = []
  for (let i = 0; i < history.length; i++) {
    const msg = history[i]
    if (i < from || !msg.images?.length) {
      out.push(msg)
      continue
    }
    const imageUrls = []
    for (const name of msg.images) {
      const url = await chatImages.toDataUrl(name)
      if (url) imageUrls.push(url)
    }
    out.push(imageUrls.length ? { ...msg, imageUrls } : msg)
  }
  return out
}

/**
 * 讀 SSE 串流，逐塊回呼
 * @param {Response} res
 * @param {(piece: string, kind: 'content'|'reasoning') => void} onDelta
 * @param {() => void} onActivity 收到任何位元組時重置閒置計時
 * @returns {Promise<string>} 完整內容（不含思考過程）
 */
async function readSseStream(res, onDelta, onActivity) {
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    onActivity()
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]') return content
      const delta = extractDelta(payload)
      if (delta.reasoning) onDelta(delta.reasoning, 'reasoning')
      if (delta.content) {
        content += delta.content
        onDelta(delta.content, 'content')
      }
    }
  }
  return content
}

/**
 * @param {string} payload
 * @returns {{ content: string, reasoning: string }}
 */
function extractDelta(payload) {
  try {
    const data = JSON.parse(payload)
    const choice = data?.choices?.[0]
    const delta = choice?.delta || choice?.message || {}
    // reasoning_content：DeepSeek／Qwen；reasoning：OpenRouter。物件形式一律忽略
    const raw = delta.reasoning_content ?? delta.reasoning
    return {
      content: typeof delta.content === 'string' ? delta.content : '',
      reasoning: typeof raw === 'string' ? raw : ''
    }
  } catch {
    // 部分供應商會夾雜 keep-alive 註解或非 JSON 行，忽略即可
    return { content: '', reasoning: '' }
  }
}

/**
 * 送出一則訊息並串流回覆
 * @param {{ reqId: string, conversationId: string, text?: string, images?: string[], regenerate?: boolean }} req
 * @param {import('electron').WebContents} sender
 * @returns {Promise<{ ok: boolean, content?: string, aborted?: boolean, error?: string }>}
 */
async function send(req, sender) {
  const reqId = typeof req?.reqId === 'string' ? req.reqId : ''
  const regenerate = req?.regenerate === true
  const text = typeof req?.text === 'string' ? req.text.trim() : ''
  const rawImages = Array.isArray(req?.images) ? req.images : []
  if (!reqId) return { ok: false, error: '缺少請求識別碼' }
  if (!regenerate && !text && !rawImages.length) return { ok: false, error: '訊息不可為空' }
  if (text.length > MAX_INPUT_CHARS) {
    return { ok: false, error: `訊息過長（上限 ${MAX_INPUT_CHARS} 字）` }
  }
  if (rawImages.length > chatImages.MAX_IMAGES_PER_MESSAGE) {
    return { ok: false, error: `一次最多 ${chatImages.MAX_IMAGES_PER_MESSAGE} 張圖片` }
  }
  if (inflight) return { ok: false, error: '仍在回應中，請先停止' }

  const cfg = readConfig()
  if (!cfg.apiKey) return { ok: false, error: '尚未設定聊天 API Key' }
  if (!cfg.modelId) return { ok: false, error: '目前的聊天模型不在模型清單內，請到設定重新選擇' }

  // 先確認對話存在再落圖片檔，否則失敗會留下沒人引用的圖
  if (!(await chatStore.get(req?.conversationId))) return { ok: false, error: '找不到這個對話' }

  let conversation
  if (regenerate) {
    conversation = await chatStore.dropTrailingAssistant(req.conversationId)
    if (!conversation?.messages.length) return { ok: false, error: '沒有可重新生成的訊息' }
  } else {
    const images = await chatImages.saveMany(rawImages)
    conversation = await chatStore.appendMessage(req.conversationId, 'user', text, { images })
    if (!conversation) return { ok: false, error: '找不到這個對話' }
  }

  const controller = new AbortController()
  inflight = { reqId, controller, reason: '' }
  const timers = createTimers(controller)
  // 中斷／逾時時已收到的部分要存檔，所以累加器必須活在 try 之外
  let partial = ''
  let reasoning = ''
  try {
    const body = {
      model: cfg.modelId,
      stream: true,
      messages: buildMessages(await withImageUrls(conversation.messages), cfg.systemPrompt)
    }
    // 關閉時完全不帶欄位：舊端點看到不認得的參數會直接 400
    if (cfg.thinking) body.reasoning_effort = REASONING_EFFORT

    const res = await fetch(`${cfg.apiUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    })
    if (!res.ok || !res.body) {
      if (res.body) await res.body.cancel().catch(() => {})
      console.error(`[chat] API error: HTTP ${res.status}`)
      return { ok: false, error: `API 錯誤（${res.status}）` }
    }
    const content = await readSseStream(
      res,
      (piece, kind) => {
        if (kind === 'reasoning') reasoning += piece
        else partial += piece
        emitDelta(sender, reqId, piece, kind)
      },
      () => timers.touch()
    )
    if (content || reasoning) {
      await chatStore.appendMessage(conversation.id, 'assistant', content, { reasoning })
    }
    return { ok: true, content }
  } catch (e) {
    return await handleStreamError(e, conversation.id, partial, reasoning)
  } finally {
    timers.clear()
    inflight = null
  }
}

/**
 * 首 token / 閒置雙逾時
 * @param {AbortController} controller
 */
function createTimers(controller) {
  let timer = setTimeout(() => {
    if (inflight) inflight.reason = 'timeout'
    controller.abort()
  }, FIRST_TOKEN_TIMEOUT_MS)
  return {
    touch() {
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (inflight) inflight.reason = 'timeout'
        controller.abort()
      }, IDLE_TIMEOUT_MS)
    },
    clear() {
      clearTimeout(timer)
    }
  }
}

/**
 * @param {import('electron').WebContents} sender
 * @param {string} reqId
 * @param {string} piece
 * @param {'content'|'reasoning'} [kind]
 */
function emitDelta(sender, reqId, piece, kind) {
  if (!sender || sender.isDestroyed?.()) return
  sender.send('chat:delta', { reqId, text: piece, kind: kind === 'reasoning' ? 'reasoning' : 'content' })
}

/**
 * 中斷／逾時／網路錯誤；已收到的部分內容仍要存檔
 * @param {any} error
 * @param {string} conversationId
 * @param {string} partial 中斷前已累積的內容
 * @param {string} reasoning 中斷前已累積的思考過程
 */
async function handleStreamError(error, conversationId, partial, reasoning) {
  if (partial || reasoning) {
    await chatStore.appendMessage(conversationId, 'assistant', partial, { reasoning })
  }
  if (error?.name === 'AbortError') {
    if (inflight?.reason === 'timeout') return { ok: false, error: '回應逾時', aborted: true }
    return { ok: true, content: partial, aborted: true }
  }
  console.error('[chat] stream request failed')
  return { ok: false, error: '連線失敗：請檢查 API 設定與網路狀態' }
}

/**
 * 中斷目前請求
 * @param {string} [reqId] 不給則中斷任何進行中的請求
 */
function abort(reqId) {
  if (!inflight) return false
  if (reqId && inflight.reqId !== reqId) return false
  inflight.reason = 'user'
  inflight.controller.abort()
  return true
}

/** 目前是否有請求進行中 */
function isBusy() {
  return !!inflight
}

module.exports = {
  setStore,
  send,
  abort,
  isBusy,
  buildMessages,
  sanitizeModels,
  sanitizePrompts,
  DEFAULT_CHAT_API_URL,
  DEFAULT_CHAT_MODEL,
  MAX_INPUT_CHARS,
  MAX_CONTEXT_CHARS,
  MAX_PROMPTS,
  MAX_PROMPT_CONTENT
}
