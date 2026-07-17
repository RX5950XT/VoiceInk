/**
 * VoiceInk - 翻譯（Main Process）
 * 依設定走雲端 LLM（文字請求）或本地 LLM（node-llama-cpp + Qwen3.5-0.8B）
 */

const path = require('path')
const { modelDir, isDownloaded } = require('./models')

const LANGUAGE_NAMES = {
  'zh-TW': '繁體中文（台灣）',
  'zh-CN': '簡體中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어'
}

const TRANSLATE_MODEL_KEY = 'qwen35translate'

// 本地 LLM 狀態（lazy init 常駐）
let sessionPromise = null

/**
 * 初始化本地 LLM session（node-llama-cpp 為 ESM，需動態 import）
 */
function getSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const { getLlama, LlamaChatSession } = await import('node-llama-cpp')
      const llama = await getLlama()
      const model = await llama.loadModel({
        modelPath: path.join(modelDir(TRANSLATE_MODEL_KEY), 'Qwen3.5-0.8B-Q4_K_M.gguf')
      })
      const context = await model.createContext({ contextSize: 2048 })
      return new LlamaChatSession({ contextSequence: context.getSequence() })
    })()
    sessionPromise.catch(() => { sessionPromise = null })
  }
  return sessionPromise
}

/**
 * 去除思考標籤（含未閉合的 think 區塊；有 </think> 時取其後內容）
 */
function stripThink(text) {
  const lastClose = text.lastIndexOf('</think>')
  if (lastClose !== -1) return text.slice(lastClose + 8).trim()
  return text.replace(/<think>[\s\S]*/g, '').trim()
}

/**
 * 本地 LLM 翻譯
 */
async function translateLocal(text, targetLang) {
  if (!isDownloaded(TRANSLATE_MODEL_KEY)) {
    throw new Error('本地翻譯模型尚未下載，請先到設定下載')
  }
  const langName = LANGUAGE_NAMES[targetLang] || targetLang
  const session = await getSession()
  session.resetChatHistory()
  const out = await session.prompt(
    `將以下內容翻譯成${langName}，只輸出譯文，不要任何解釋。\n\n${text}`,
    { maxTokens: 1024, temperature: 0.2, budgets: { thoughtTokens: 0 } }
  )
  return stripThink(out)
}

/**
 * 雲端 LLM 翻譯（純文字 chat completions）
 */
async function translateCloud(text, targetLang, { apiUrl, apiKey, modelId }) {
  if (!apiKey) throw new Error('尚未設定 API Key')
  const langName = LANGUAGE_NAMES[targetLang] || targetLang
  const res = await fetch(`${apiUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: modelId,
      messages: [
        {
          role: 'user',
          content: `將以下內容翻譯成${langName}，只輸出譯文，不要任何解釋。\n\n${text}`
        }
      ]
    })
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error?.message || `翻譯 API 錯誤: ${res.status}`)
  }
  const data = await res.json()
  return stripThink(data.choices[0]?.message?.content || '')
}

/**
 * 依設定分流翻譯
 * @param {import('electron-store').default} store
 */
async function translate(store, text, targetLang) {
  const translator = store.get('translator', 'none')
  if (translator === 'none' || !text.trim()) return text

  if (translator === 'local') return translateLocal(text, targetLang)

  return translateCloud(text, targetLang, {
    apiUrl: store.get('apiUrl', 'https://openrouter.ai/api/v1'),
    apiKey: store.get('apiKey', ''),
    modelId: store.get('modelId', 'google/gemini-3-flash-preview')
  })
}

module.exports = { translate }
