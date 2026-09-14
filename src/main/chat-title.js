/**
 * VoiceInk - 對話 AI 自動取標題（Main Process）
 *
 * 第一輪回覆存好之後，用同一組供應商／模型補打一次非串流請求，換掉「截第一句前 30 字」的暫定標題。
 * 只在標題**還是暫定那份**時才換：使用者改過名（或產生途中改名）就不動。
 * 失敗一律安靜放棄——標題是錦上添花，不值得跳錯誤。
 */

const chatStore = require('./chat-store')

const TITLE_TIMEOUT_MS = 30_000
/** 送去取標題的內容只取開頭一段：夠判斷主題，也不白燒 token */
const MAX_EXCERPT = 1000
const MAX_TITLE = 30
const TITLE_PROMPT = '用一個簡短的標題（最多 12 個字）概括下面這段對話的主題。'
  + '使用對話本身的語言，只輸出標題本身，不要引號、標點或任何解釋。'

/**
 * 模型常見的多餘包裝：思考區塊、「標題：」前綴、引號、句尾標點。
 * @param {unknown} raw
 * @returns {string}
 */
function cleanTitle(raw) {
  const text = String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  const line = text.split('\n').map((s) => s.trim()).find(Boolean) || ''
  return line
    .replace(/^(標題|标题|title)\s*[:：]\s*/i, '')
    .replace(/^[\s"'`「『《【*#]+|[\s"'`」』》】*。．.!！?？，,]+$/g, '')
    .slice(0, MAX_TITLE)
    .trim()
}

/**
 * @param {string} conversationId
 * @param {{ apiUrl: string, apiKey: string, modelId: string }} cfg 送出那一輪當下的設定
 * @param {(id: string, title: string) => void} onTitle 換成功時通知（main 轉給 renderer）
 * @returns {Promise<boolean>}
 */
async function maybeGenerate(conversationId, cfg, onTitle) {
  try {
    const conv = await chatStore.get(conversationId)
    const [first, reply] = conv?.messages || []
    if (conv?.messages.length !== 2 || first?.role !== 'user' || reply?.role !== 'assistant' || !reply.content) {
      return false
    }
    const expected = chatStore.autoTitleOf(first.content)
    if (conv.title !== expected) return false
    const title = await requestTitle(cfg, first.content || '（圖片）', reply.content)
    if (!title || title === expected) return false
    const replaced = await chatStore.replaceAutoTitle(conversationId, expected, title)
    if (replaced) onTitle(conversationId, title)
    return replaced
  } catch (e) {
    console.warn(`[chat-title] skipped: ${e?.name || 'error'}`)
    return false
  }
}

/**
 * @param {{ apiUrl: string, apiKey: string, modelId: string }} cfg
 * @param {string} question
 * @param {string} answer
 * @returns {Promise<string>}
 */
async function requestTitle(cfg, question, answer) {
  const res = await fetch(`${cfg.apiUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.modelId,
      stream: false,
      messages: [
        { role: 'system', content: TITLE_PROMPT },
        { role: 'user', content: `使用者：${question.slice(0, MAX_EXCERPT)}\n\n助理：${answer.slice(0, MAX_EXCERPT)}` }
      ]
    }),
    signal: AbortSignal.timeout(TITLE_TIMEOUT_MS)
  })
  if (!res.ok) {
    // 只記狀態碼：上游 body 可能回音使用者自填的網址與金鑰
    await res.body?.cancel().catch(() => {})
    console.warn(`[chat-title] HTTP ${res.status}`)
    return ''
  }
  const data = await res.json().catch(() => null)
  const content = data?.choices?.[0]?.message?.content
  return typeof content === 'string' ? cleanTitle(content) : ''
}

module.exports = { maybeGenerate, cleanTitle }
