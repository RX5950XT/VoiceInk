/**
 * VoiceInk - 翻譯（Main Process）
 * 雲端 chat completions / 本地 node-llama-cpp + Qwen3.5-0.8B
 * 支援上下文、live tokens、serial mutex、warm/unload（可 dispose）
 */

const path = require('path')
const { modelDir, isDownloaded } = require('./models')
const { s2twp } = require('./opencc')

const LANGUAGE_NAMES = {
  'zh-TW': '繁體中文（台灣）',
  'zh-CN': '簡體中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어'
}

const TRANSLATE_MODEL_KEY = 'qwen35translate'
// live 段落原文上限 120 字（MAX_BATCH_CHARS），256 tokens 足以容納中譯而不截斷半句
const MAX_TOKENS_LIVE = 256
const MAX_TOKENS_FILE = 1024
const CLOUD_TIMEOUT_MS = 20000

/**
 * 已載入資源（需保留參考才能 dispose）
 * @type {{ session: object, context: object, model: object, llama: object } | null}
 */
let resources = null
let loadPromise = null
/** unload 時遞增；in-flight load 完成後 gen 不符則 dispose 丟棄 */
let loadGen = 0

/** 翻譯 serial lock */
let translateChain = Promise.resolve()

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withTranslateLock(fn) {
  const run = translateChain.then(fn, fn)
  translateChain = run.then(() => {}, () => {})
  return run
}

/**
 * @param {object | null} obj
 * @param {string} name
 * @param {string[]} warnings
 */
async function tryDispose(obj, name, warnings) {
  if (!obj) return
  try {
    if (typeof obj.dispose === 'function') await obj.dispose()
  } catch (e) {
    warnings.push(`${name}: ${e.message || e}`)
  }
}

/**
 * @param {{ session?: object, context?: object, model?: object }} res
 * @param {string[]} warnings
 */
async function disposeResources(res, warnings) {
  if (!res) return
  // 順序：session → context → model
  await tryDispose(res.session, 'session', warnings)
  await tryDispose(res.context, 'context', warnings)
  await tryDispose(res.model, 'model', warnings)
}

/**
 * 載入本地 LLM（含 generation 檢查）
 */
async function getSession() {
  if (resources?.session) return resources.session
  if (!isDownloaded(TRANSLATE_MODEL_KEY)) {
    throw new Error('本地翻譯模型尚未下載，請先到設定下載')
  }

  if (loadPromise) return loadPromise

  const myGen = loadGen
  loadPromise = (async () => {
    const { getLlama, LlamaChatSession } = await import('node-llama-cpp')
    const llama = await getLlama()
    const model = await llama.loadModel({
      modelPath: path.join(modelDir(TRANSLATE_MODEL_KEY), 'Qwen3.5-0.8B-Q4_K_M.gguf')
    })
    const context = await model.createContext({ contextSize: 2048 })
    const session = new LlamaChatSession({ contextSequence: context.getSequence() })
    const built = { session, context, model, llama }

    if (myGen !== loadGen) {
      await disposeResources(built, [])
      throw new Error('LLM load cancelled')
    }
    resources = built
    return session
  })()

  try {
    return await loadPromise
  } catch (e) {
    if (myGen === loadGen) resources = null
    throw e
  } finally {
    if (loadPromise) loadPromise = null
  }
}

/**
 * 預熱本地翻譯模型
 * @returns {Promise<{ ok: boolean, warnings: string[] }>}
 */
async function warm() {
  const warnings = []
  try {
    await getSession()
    return { ok: true, warnings }
  } catch (e) {
    return { ok: false, warnings: [e.message || String(e)] }
  }
}

/**
 * 卸載本地 LLM：等翻譯佇列結束 → bump gen → dispose
 * @returns {Promise<{ ok: boolean, warnings: string[] }>}
 */
async function unload() {
  const warnings = []
  loadGen += 1

  // 等進行中的翻譯跑完再卸
  await withTranslateLock(async () => {})

  if (loadPromise) {
    try { await loadPromise } catch { /* cancelled */ }
  }

  await disposeResources(resources, warnings)
  resources = null
  return { ok: true, warnings }
}

/** @returns {boolean} */
function isLoaded() {
  return !!resources?.session
}

function stripThink(text) {
  const lastClose = text.lastIndexOf('</think>')
  if (lastClose !== -1) return text.slice(lastClose + 8).trim()
  return text.replace(/<think>[\s\S]*/g, '').trim()
}

/**
 * 指令走 system prompt、前文走真實對話輪（chat template 原生結構）。
 * 0.8B 小模型看到「【前文】【本段】」括號式 meta-prompt 會整段複誦而不翻譯。
 * @param {string} targetLang
 * @param {'live' | 'file' | undefined} mode
 */
function buildSystemPrompt(targetLang, mode) {
  const langName = LANGUAGE_NAMES[targetLang] || targetLang
  if (mode === 'live') {
    // 明確指出來源可能是與目標語共用漢字的日/韓文，並嚴禁原樣輸出——降低 0.8B 對漢字密集句的複誦傾向
    return `你是即時字幕翻譯引擎。使用者訊息可能是任何語言（含日文、韓文等與目標語共用文字的語言）。無論來源為何，一律翻譯成${langName}，嚴禁原樣輸出或複製輸入；只輸出${langName}譯文，不要解釋。`
  }
  return `你是翻譯引擎。將使用者訊息的內容翻譯成${langName}。口語可補全省略主語使譯文通順。只輸出譯文，不要解釋、不要重複原文。`
}

/**
 * 前文配對：source 與 translation 都有才成立（當成上一輪 user/assistant 對話）
 * @param {{ previousSource?: string, previousTranslation?: string }} [context]
 * @returns {{ prevSrc: string, prevTr: string } | null}
 */
function buildContextPair(context = {}) {
  const prevSrc = (context.previousSource || '').trim()
  const prevTr = (context.previousTranslation || '').trim()
  if (!prevSrc || !prevTr) return null
  // identity 前文（譯文==原文）會示範「原樣輸出」，教小模型複誦下一段 → 丟棄
  if (prevSrc === prevTr) return null
  return { prevSrc, prevTr }
}

function resolveMaxTokens(options = {}) {
  return options.mode === 'live' ? MAX_TOKENS_LIVE : MAX_TOKENS_FILE
}

async function translateLocal(text, targetLang, context = {}, options = {}) {
  if (!isDownloaded(TRANSLATE_MODEL_KEY)) {
    throw new Error('本地翻譯模型尚未下載，請先到設定下載')
  }
  const session = await getSession()
  const history = [{ type: 'system', text: buildSystemPrompt(targetLang, options.mode) }]
  const pair = buildContextPair(context)
  if (pair) {
    history.push({ type: 'user', text: pair.prevSrc })
    history.push({ type: 'model', response: [pair.prevTr] })
  }
  session.setChatHistory(history)
  const out = await session.prompt(text, {
    maxTokens: resolveMaxTokens(options),
    temperature: 0.2,
    budgets: { thoughtTokens: 0 }
  })
  return stripThink(out)
}

async function translateCloud(text, targetLang, cfg, context = {}, options = {}) {
  if (!cfg.apiKey) throw new Error('尚未設定 API Key')
  const messages = [{ role: 'system', content: buildSystemPrompt(targetLang, options.mode) }]
  const pair = buildContextPair(context)
  if (pair) {
    messages.push({ role: 'user', content: pair.prevSrc })
    messages.push({ role: 'assistant', content: pair.prevTr })
  }
  messages.push({ role: 'user', content: text })

  // 逾時保護：翻譯全走 serial chain，unload/engine 生命週期又 await 該 chain，
  // 沒有 timeout 的話 API 卡死會連帶鎖死「停止」與模型卸載
  let res
  try {
    res = await fetch(`${cfg.apiUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: cfg.modelId,
        max_tokens: resolveMaxTokens(options),
        messages
      }),
      signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS)
    })
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      throw new Error(`翻譯逾時（${CLOUD_TIMEOUT_MS / 1000}s）`)
    }
    throw e
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error?.message || `翻譯 API 錯誤: ${res.status}`)
  }
  const data = await res.json()
  return stripThink(data.choices[0]?.message?.content || '')
}

/**
 * @param {import('electron-store').default} store
 * @param {string} text
 * @param {string} targetLang
 * @param {{ previousSource?: string, previousTranslation?: string, mode?: 'live' | 'file' }} [opts]
 */
async function translate(store, text, targetLang, opts = {}) {
  const translator = store.get('translator', 'none')
  if (translator === 'none' || !text.trim()) return text

  return withTranslateLock(async () => {
    const context = {
      previousSource: opts.previousSource || '',
      previousTranslation: opts.previousTranslation || ''
    }
    const options = { mode: opts.mode || 'file' }

    const result = translator === 'local'
      ? await translateLocal(text, targetLang, context, options)
      : await translateCloud(
          text,
          targetLang,
          {
            apiUrl: store.get('apiUrl', 'https://openrouter.ai/api/v1'),
            apiKey: store.get('apiKey', ''),
            modelId: store.get('modelId', 'google/gemini-3-flash-preview')
          },
          context,
          options
        )

    // 模型自我複誦（含日文頑固句）：回原文、不轉繁——s2twp 會 mangle 使 renderer 的 echo 去重失效
    if (result.trim() === text.trim()) return result
    // 繁中目標：0.8B 偶爾吐簡體字，統一過 opencc 轉台灣繁體
    return targetLang === 'zh-TW' ? s2twp(result) : result
  })
}

module.exports = {
  translate,
  warm,
  unload,
  isLoaded,
  TRANSLATE_MODEL_KEY
}
