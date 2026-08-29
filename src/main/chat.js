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
/** 生圖模型要送的 modalities（OpenAI 相容端點共用的欄位） */
const IMAGE_MODALITIES = Object.freeze(['image', 'text'])
/** 送出上下文總量上限，超過從最舊丟起 */
const MAX_CONTEXT_CHARS = 24000
/** 首個 token 逾時：連上了但模型一直不吐字 */
const FIRST_TOKEN_TIMEOUT_MS = 60000
/** 閒置逾時：串流中斷但連線沒關 */
const IDLE_TIMEOUT_MS = 120000
/** 單行尚未切完的 SSE buffer 上限，防止失控上游把 main 撐爆 */
const MAX_SSE_BUFFER = 512 * 1024
/**
 * 生圖時的 SSE buffer 上限：一張 1024px PNG 的 base64 是好幾 MB，
 * 而且整張圖就塞在**同一行** `data:` 裡——沿用 512KB 會在收到第一張圖時
 * 直接把串流砍掉，症狀是「文字有、圖沒有」。
 */
const MAX_SSE_BUFFER_IMAGE = 24 * 1024 * 1024
/** 只把最近幾則訊息的圖片送進 API：長對話每次重傳全部圖片會爆 token 與頻寬 */
const IMAGE_CONTEXT_MESSAGES = 6
/** thinking 開啟時帶的強度（OpenAI／OpenRouter／xAI 等相容欄位） */
const REASONING_EFFORT = 'medium'

/** 系統提示 preset 上限 */
const MAX_PROVIDERS = 10
const MAX_PROVIDER_NAME = 40
const MAX_PROVIDER_URL = 500
const MAX_PROVIDER_MODELS = 30
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
 * 取目前選中的供應商。`chatProviderId` 失效時退回第一筆，一筆都沒有就是 null。
 * @returns {Provider | null}
 */
function readProvider() {
  return pickProvider(store?.get('chatProviderId', ''))
}

/**
 * @param {unknown} wantedId
 * @returns {Provider | null}
 */
function pickProvider(wantedId) {
  const providers = sanitizeProviders(store?.get('chatProviders', []))
  if (!providers.length) return null
  const wanted = String(wantedId || '').trim()
  return providers.find((p) => p.id === wanted) || providers[0]
}

/**
 * 雲端翻譯的端點設定。與聊天共用同一份供應商清單——兩邊都是 OpenAI 相容的
 * `/chat/completions`，沒有理由讓使用者把同一組網址與金鑰填兩次。
 * 用哪一顆模型在「翻譯與 TTS」頁上方選（`translateModelId`）。
 * @returns {{ apiUrl: string, apiKey: string, modelId: string, providerName: string }}
 */
function readTranslateConfig() {
  const provider = pickProvider(store?.get('translateProviderId', ''))
  const wanted = String(store?.get('translateModelId', '') || '').trim()
  return {
    apiUrl: provider?.apiUrl || '',
    apiKey: provider?.apiKey || '',
    modelId: provider?.models.includes(wanted) ? wanted : (provider?.models[0] || ''),
    providerName: provider?.name || ''
  }
}

/**
 * 從設定 store 取聊天設定（store:set 已校驗過，這裡是縱深防禦）。
 *
 * model 一定要對「目前這個供應商」的清單驗證，不能只看在不在任何清單裡——
 * 否則切換供應商後會拿 A 的模型名打 B 的端點。
 * @returns {{ apiUrl: string, apiKey: string, providerId: string, providerName: string,
 *            modelId: string, image: boolean, systemPrompt: string, thinking: boolean }}
 */
function readConfig() {
  const provider = readProvider()
  const wantedModel = String(store?.get('chatModelId', '') || '').trim()
  const modelId = provider?.models.includes(wantedModel) ? wantedModel : ''
  return {
    apiUrl: provider?.apiUrl || '',
    apiKey: provider?.apiKey || '',
    providerId: provider?.id || '',
    providerName: provider?.name || '',
    modelId,
    image: !!modelId && !!provider?.imageModels.includes(modelId),
    systemPrompt: readSystemPrompt(),
    thinking: store?.get('chatThinking', false) === true
  }
}

/**
 * 供應商清單正規化。形狀沿用 sanitizePrompts：id 走字元 allowlist、去重、限量。
 *
 * apiUrl 不合法時**保留這筆但清空 url**，不整筆丟掉：
 * 這個函式同時跑在 store:set 的存檔路徑上，直接丟掉等於使用者打錯一個字
 * 就把整組供應商（含 API Key 與整份模型清單）刪了。留著空 url，
 * readConfig 會判定成未設定並回可讀的錯誤，資料還在。
 * `imageModels` 是 `models` 的子集：哪幾顆是生圖模型。不另開一份清單／一個欄位，
 * 因為它們走的是同一個端點、同一組金鑰，差別只在請求要不要帶 `modalities`。
 * @typedef {{ id: string, name: string, apiUrl: string, apiKey: string,
 *             models: string[], imageModels: string[] }} Provider
 * @param {unknown} raw
 * @returns {Provider[]}
 */
function sanitizeProviders(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const id = typeof item.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(item.id) ? item.id : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    const rawUrl = typeof item.apiUrl === 'string' ? item.apiUrl.trim().slice(0, MAX_PROVIDER_URL) : ''
    const name = typeof item.name === 'string'
      ? item.name.trim().replace(/\s+/g, ' ').slice(0, MAX_PROVIDER_NAME)
      : ''
    const models = sanitizeModels(item.models).slice(0, MAX_PROVIDER_MODELS)
    out.push({
      id,
      name: name || '未命名供應商',
      apiUrl: /^https?:\/\//i.test(rawUrl) ? rawUrl : '',
      apiKey: typeof item.apiKey === 'string' ? item.apiKey.trim() : '',
      models,
      // 標記只在清單內有意義：模型被刪掉後留著標記，之後同名新增會莫名其妙變生圖
      imageModels: sanitizeModels(item.imageModels).filter((m) => models.includes(m))
    })
    if (out.length >= MAX_PROVIDERS) break
  }
  return out
}

/**
 * 舊版的單組設定 → 一筆名為「預設」的供應商。
 * 呼叫端負責在寫入成功後才刪舊 key。
 * @param {unknown} apiUrl
 * @param {unknown} apiKey
 * @param {unknown} models
 * @returns {{ id: string, name: string, apiUrl: string, apiKey: string, models: string[] } | null}
 */
function providerFromLegacy(apiUrl, apiKey, models) {
  const url = typeof apiUrl === 'string' ? apiUrl.trim() : ''
  const key = typeof apiKey === 'string' ? apiKey.trim() : ''
  const list = sanitizeModels(models)
  if (!url && !key && !list.length) return null
  const [provider] = sanitizeProviders([{
    id: 'p_legacy',
    name: '預設',
    apiUrl: /^https?:\/\//i.test(url) ? url : DEFAULT_CHAT_API_URL,
    apiKey: key,
    models: list.length ? list : [DEFAULT_CHAT_MODEL]
  }])
  return provider || null
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
 *
 * 只送 user 的圖：生圖模型的回覆自己也帶圖，把它塞回 assistant 訊息的
 * content 陣列裡，嚴格一點的端點會直接 400（assistant 只收字串）。
 * 要拿生成的圖再編輯，重新附一次即可。
 * @param {Array<{role: string, content: string, images?: string[]}>} history
 */
async function withImageUrls(history) {
  const from = Math.max(0, history.length - IMAGE_CONTEXT_MESSAGES)
  const out = []
  for (let i = 0; i < history.length; i++) {
    const msg = history[i]
    if (i < from || msg.role !== 'user' || !msg.images?.length) {
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
 * @param {(piece: string, kind: 'content'|'reasoning'|'image') => void} onDelta
 * @param {() => void} onActivity 收到任何位元組時重置閒置計時
 * @param {number} [maxBuffer]
 * @returns {Promise<string>} 完整內容（不含思考過程）
 */
async function readSseStream(res, onDelta, onActivity, maxBuffer = MAX_SSE_BUFFER) {
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    onActivity()
    buffer += decoder.decode(value, { stream: true })
    if (buffer.length > maxBuffer) {
      await reader.cancel().catch(() => {})
      return content.slice(0, MAX_INPUT_CHARS)
    }
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]') return content
      const delta = extractDelta(payload)
      for (const url of delta.images) onDelta(url, 'image')
      if (delta.reasoning) onDelta(delta.reasoning, 'reasoning')
      if (delta.content) {
        content += delta.content
        onDelta(delta.content, 'content')
        if (content.length >= MAX_INPUT_CHARS) {
          await reader.cancel().catch(() => {})
          return content.slice(0, MAX_INPUT_CHARS)
        }
      }
    }
  }
  return content
}

/**
 * @param {string} payload
 * @returns {{ content: string, reasoning: string, images: string[] }}
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
      reasoning: typeof raw === 'string' ? raw : '',
      images: extractImages(delta)
    }
  } catch {
    // 部分供應商會夾雜 keep-alive 註解或非 JSON 行，忽略即可
    return { content: '', reasoning: '', images: [] }
  }
}

/**
 * 生圖模型的回傳：`delta.images = [{ image_url: { url: 'data:image/png;base64,…' } }]`。
 * 只收 data URI——讓 http URL 進來等於要 main 去下載上游指定的網址（AGY 同樣的理由）。
 * @param {{ images?: unknown }} delta
 * @returns {string[]}
 */
function extractImages(delta) {
  if (!Array.isArray(delta?.images)) return []
  const out = []
  for (const item of delta.images) {
    const url = typeof item === 'string' ? item : (item?.image_url?.url ?? item?.url)
    if (typeof url === 'string' && url.startsWith('data:image/')) out.push(url)
  }
  return out
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

  // 佔位一定要跟守衛在同一個同步區塊裡。中間只要有一個 await（讀對話、存圖片、
  // 寫使用者訊息都是），第二個請求就會在指派前先通過守衛：兩條串流同時開，
  // 兩則使用者訊息連在一起寫進同一個對話，先開的那條被後者覆蓋掉——
  // 「停止」按鈕再也找不到它，逾時計時器也會去改到別人的 reason。
  const controller = new AbortController()
  inflight = { reqId, controller, reason: '' }
  /** @type {{ clear: () => void, touch: () => void } | null} */
  let timers = null
  /** @type {{ id: string, messages: Array<object> } | null} */
  let conversation = null
  // 中斷／逾時時已收到的部分要存檔，所以累加器必須活在 try 之外
  let partial = ''
  let reasoning = ''
  /** 生圖模型吐回來的 data URL（尚未落檔） @type {string[]} */
  const generatedImages = []
  /** @type {string[]} */
  let heldImages = []
  let replaceTrailing = false
  try {
    const cfg = readConfig()
    if (!cfg.apiUrl) return { ok: false, error: '尚未設定聊天供應商，請到設定新增一組' }
    if (!cfg.apiKey) return { ok: false, error: `供應商「${cfg.providerName}」尚未填 API Key` }
    if (!cfg.modelId) return { ok: false, error: '目前的聊天模型不在模型清單內，請到設定重新選擇' }

    // 先確認對話存在再落圖片檔，否則失敗會留下沒人引用的圖
    const existing = await chatStore.get(req?.conversationId)
    if (!existing) return { ok: false, error: '找不到這個對話' }

    if (regenerate) {
      // 舊助理先不要落盤刪掉：上游失敗／尚未吐字就停止時必須能還原
      const msgs = existing.messages.slice()
      let dropped = false
      while (msgs.length && msgs[msgs.length - 1].role === 'assistant') {
        msgs.pop()
        dropped = true
      }
      if (!dropped) return { ok: false, error: '沒有可重新生成的訊息' }
      replaceTrailing = true
      conversation = { ...existing, messages: msgs }
    } else {
      heldImages = await chatImages.saveMany(rawImages)
      chatImages.hold(heldImages)
      conversation = await chatStore.appendMessage(req.conversationId, 'user', text, { images: heldImages })
      if (!conversation) return { ok: false, error: '找不到這個對話' }
    }

    timers = createTimers(controller)
    const body = {
      model: cfg.modelId,
      stream: true,
      messages: buildMessages(await withImageUrls(conversation.messages), cfg.systemPrompt)
    }
    // 關閉時完全不帶欄位：舊端點看到不認得的參數會直接 400
    if (cfg.thinking) body.reasoning_effort = REASONING_EFFORT
    if (cfg.image) body.modalities = IMAGE_MODALITIES

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
        if (kind === 'image') {
          // 圖不走 delta 事件（一張好幾 MB，逐塊丟給 renderer 沒有意義）：
          // 收齊後存檔，finishStream 會從 chats.json 重畫整串訊息。
          if (generatedImages.length < chatImages.MAX_IMAGES_PER_MESSAGE) generatedImages.push(piece)
          return
        }
        if (kind === 'reasoning') {
          if (reasoning.length >= chatStore.MAX_CONTENT) return
          reasoning += piece
        } else {
          if (partial.length >= MAX_INPUT_CHARS) return
          partial += piece
        }
        emitDelta(sender, reqId, piece, kind)
      },
      () => timers.touch(),
      cfg.image ? MAX_SSE_BUFFER_IMAGE : MAX_SSE_BUFFER
    )
    const savedImages = await chatImages.saveMany(generatedImages)
    if (savedImages.length) {
      chatImages.hold(savedImages)
      heldImages = heldImages.concat(savedImages)
    }
    if (content || reasoning || savedImages.length) {
      if (replaceTrailing) await chatStore.dropTrailingAssistant(conversation.id)
      await chatStore.appendMessage(conversation.id, 'assistant', content, {
        reasoning,
        images: savedImages
      })
    }
    return { ok: true, content }
  } catch (e) {
    if ((partial || reasoning) && replaceTrailing && conversation?.id) {
      await chatStore.dropTrailingAssistant(conversation.id)
    }
    return await handleStreamError(e, conversation?.id || '', partial, reasoning)
  } finally {
    if (heldImages.length) chatImages.release(heldImages)
    timers?.clear()
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
  sanitizeProviders,
  providerFromLegacy,
  readProvider,
  readTranslateConfig,
  extractDelta,
  DEFAULT_CHAT_API_URL,
  DEFAULT_CHAT_MODEL,
  MAX_INPUT_CHARS,
  MAX_CONTEXT_CHARS,
  MAX_PROMPTS,
  MAX_PROMPT_CONTENT,
  MAX_PROVIDERS,
  MAX_PROVIDER_MODELS
}
