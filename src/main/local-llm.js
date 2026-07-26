/**
 * VoiceInk - 翻譯（Main Process）
 * 雲端 chat completions / 本地 node-llama-cpp（多 GGUF + 可選 CUDA）
 * 支援上下文、live tokens、serial mutex、warm/unload（可 dispose）
 */

const path = require('path')
const {
  MODELS,
  LLM_MODEL_KEYS,
  isLlmKey,
  ggufRelativePath,
  modelDir,
  isDownloaded
} = require('./models')
const { s2twp } = require('./opencc')
const { detectGpuCapability } = require('./gpu-capability')
const { prependCudaBinToPath } = require('./cuda-env')

const LANGUAGE_NAMES = {
  'zh-TW': '繁體中文（台灣）',
  'zh-CN': '簡體中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어'
}

/** 舊程式／e2e 相容別名（通用模型） */
const TRANSLATE_MODEL_KEY = 'qwen35translate'
const FALLBACK_LLM_KEY = 'qwen35translate'
const DEFAULT_LLM_KEY = 'qwen35translate'

// live 段落原文上限 120 字（MAX_BATCH_CHARS），256 tokens 足以容納中譯而不截斷半句
const MAX_TOKENS_LIVE = 256
const MAX_TOKENS_FILE = 1024
const CLOUD_TIMEOUT_MS = 20000

/** @type {import('electron-store').default | null} */
let storeRef = null

/**
 * 已載入資源（需保留參考才能 dispose）
 * intentGpu = 載入當下的使用者意圖；actualGpu = 實際後端（CUDA 失敗時為 false）
 * @type {{ session: object, context: object, model: object, llama: object, key: string, intentGpu: boolean, actualGpu: boolean } | null}
 */
let resources = null
/** @type {Promise<object> | null} */
let loadPromise = null
/** @type {{ key: string, intentGpu: boolean } | null} */
let loadingFingerprint = null
/** unload 時遞增；in-flight load 完成後 gen 不符則 dispose 丟棄 */
let loadGen = 0
/** 是否已跑過拋棄式暖機推論（首次推論的 compute-graph 冷啟動 ~12s，預熱時先付掉） */
let warmedUp = false
/** 最近一次實際使用的後端（供 UI／除錯） */
let lastBackend = 'cpu'

/** 翻譯 serial lock */
let translateChain = Promise.resolve()

/** @param {unknown} e */
function isLoadCancelled(e) {
  return e instanceof Error && e.message === 'LLM load cancelled'
}

/**
 * @param {import('electron-store').default} store
 */
function setStore(store) {
  storeRef = store
}

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
 * 解析要用的本地翻譯模型 key（選中未下載時 fallback 到已下載的 qwen）
 * @param {{ get: (k: string, d?: unknown) => unknown } | null} [store]
 * @returns {string}
 */
function resolveLocalTranslateModel(store = storeRef) {
  const raw = store ? store.get('localTranslateModel', DEFAULT_LLM_KEY) : DEFAULT_LLM_KEY
  const preferred = isLlmKey(raw) ? raw : DEFAULT_LLM_KEY
  if (isDownloaded(preferred)) return preferred
  if (preferred !== FALLBACK_LLM_KEY && isDownloaded(FALLBACK_LLM_KEY)) {
    return FALLBACK_LLM_KEY
  }
  // 任一已下載的 llm
  for (const k of LLM_MODEL_KEYS) {
    if (isDownloaded(k)) return k
  }
  return preferred
}

/**
 * 是否意圖使用 GPU（硬體不符時視為 false）
 * @param {{ get: (k: string, d?: unknown) => unknown } | null} [store]
 * @returns {Promise<boolean>}
 */
async function resolveWantGpu(store = storeRef) {
  if (!store || store.get('llmGpu', false) !== true) return false
  const cap = await detectGpuCapability()
  return !!cap.ok
}

/**
 * @param {object | null} obj
 * @param {string} name
 * @param {string[]} warnings
 */
async function tryDispose(obj, name, warnings) {
  if (!obj) return
  try {
    if (typeof obj.dispose === 'function') {
      await Promise.race([
        obj.dispose(),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('dispose timeout')), 15000)
        })
      ])
    }
  } catch (e) {
    warnings.push(`${name}: ${e.message || e}`)
  }
}

/**
 * @param {{ session?: object, context?: object, model?: object, llama?: object } | null} res
 * @param {string[]} warnings
 */
async function disposeResources(res, warnings) {
  if (!res) return
  // 順序：session → context → model
  // 刻意不 dispose llama binding：node-llama-cpp 在 Windows/Vulkan 上 dispose llama 可能 AV 崩潰
  // model.dispose 已釋放權重／VRAM；進程結束時 OS 回收 binding
  await tryDispose(res.session, 'session', warnings)
  await tryDispose(res.context, 'context', warnings)
  await tryDispose(res.model, 'model', warnings)
}

/**
 * 取得 llama 實例；CUDA 失敗時自動回退 CPU
 * @param {boolean} wantGpu
 * @param {string[]} warnings
 * @returns {Promise<{ llama: object, usedGpu: boolean }>}
 */
/**
 * 取得 llama 實例。
 * GPU 意圖：依序試 cuda → vulkan（本機 CUDA prebuilt 可能與驅動不相容）；皆失敗則 CPU。
 * @param {boolean} wantGpu
 * @param {string[]} warnings
 * @returns {Promise<{ llama: object, usedGpu: boolean, backend: string }>}
 */
async function createLlama(wantGpu, warnings) {
  // e2e／晚啟動路徑也可能載入 GPU：確保 cudart/cublas 在 PATH（與 main 啟動時一致）
  if (wantGpu) {
    try {
      prependCudaBinToPath()
    } catch (e) {
      warnings.push(`CUDA PATH: ${e.message || e}`)
    }
  }
  const { getLlama } = await import('node-llama-cpp')
  if (wantGpu) {
    for (const gpu of ['cuda', 'vulkan']) {
      try {
        const llama = await getLlama({ gpu, progressLogs: false })
        const backend = llama.gpu || gpu
        return { llama, usedGpu: true, backend: String(backend) }
      } catch (e) {
        const msg = e?.message || String(e)
        warnings.push(`${gpu} 不可用：${msg}`)
        console.warn(`[local-llm] ${gpu} failed:`, msg)
      }
    }
    warnings.push('GPU 後端皆失敗，改用 CPU')
  }
  const llama = await getLlama({ gpu: false, progressLogs: false })
  return { llama, usedGpu: false, backend: 'cpu' }
}

/**
 * 指紋是否一致
 * @param {{ key: string, intentGpu: boolean } | null} fp
 * @param {string} key
 * @param {boolean} intentGpu
 */
function fingerprintMatch(fp, key, intentGpu) {
  return !!fp && fp.key === key && fp.intentGpu === intentGpu
}

/**
 * 載入本地 LLM（指紋：model key + 意圖 GPU；mismatch 先卸再載）
 * CUDA fallback 後仍視為同意圖指紋，避免無限重載。
 * 同指紋 in-flight 必 join，禁止誤 cancel（舊邏輯會在第二個呼叫者把進行中的載入作廢 → UI 顯示 LLM load cancelled）。
 * @returns {Promise<object>} session
 */
async function getSession() {
  const key = resolveLocalTranslateModel()
  const intentGpu = await resolveWantGpu()
  const label = MODELS[key]?.label || key

  // 同意圖已載入（含 CUDA→CPU fallback）
  if (resources?.session && resources.key === key && resources.intentGpu === intentGpu) {
    return resources.session
  }

  // 進行中的 load：同指紋則 join（不可誤 cancel）
  if (loadPromise && fingerprintMatch(loadingFingerprint, key, intentGpu)) {
    return loadPromise
  }

  // 指紋不符：dispose 舊資源／作廢 in-flight（不可呼叫 unload()——translate 在 withTranslateLock 內會死鎖）
  if (resources?.session || loadPromise) {
    loadGen += 1
    warmedUp = false
    loadingFingerprint = null
    const pending = loadPromise
    loadPromise = null
    if (pending) {
      try { await pending } catch { /* cancelled */ }
    }
    const old = resources
    resources = null
    lastBackend = 'cpu'
    await disposeResources(old, [])
  }

  // await 取消期間可能被別處載好／新開同意圖
  if (resources?.session && resources.key === key && resources.intentGpu === intentGpu) {
    return resources.session
  }
  if (loadPromise && fingerprintMatch(loadingFingerprint, key, intentGpu)) {
    return loadPromise
  }

  if (!isDownloaded(key)) {
    throw new Error(`本地翻譯模型尚未下載（${label}），請先到設定下載`)
  }

  const rel = ggufRelativePath(key)
  if (!rel) throw new Error(`模型 ${key} 缺少 GGUF 定義`)

  // 此段無 await：單執行緒下不會雙開 loadPromise
  if (loadPromise && fingerprintMatch(loadingFingerprint, key, intentGpu)) {
    return loadPromise
  }

  const myGen = loadGen
  loadingFingerprint = { key, intentGpu }
  const warnings = []

  loadPromise = (async () => {
    const { LlamaChatSession } = await import('node-llama-cpp')
    const { llama, usedGpu, backend } = await createLlama(intentGpu, warnings)
    const modelPath = path.join(modelDir(key), rel)
    const model = await llama.loadModel({ modelPath })
    const context = await model.createContext({ contextSize: 2048 })
    const session = new LlamaChatSession({ contextSequence: context.getSequence() })
    const built = {
      session,
      context,
      model,
      llama,
      key,
      intentGpu,
      actualGpu: usedGpu,
      backend
    }

    if (myGen !== loadGen) {
      await disposeResources(built, [])
      throw new Error('LLM load cancelled')
    }
    resources = built
    lastBackend = backend || (usedGpu ? 'gpu' : 'cpu')
    if (warnings.length) console.warn('[local-llm]', warnings.join('; '))
    return session
  })()

  try {
    return await loadPromise
  } catch (e) {
    if (myGen === loadGen) {
      resources = null
      lastBackend = 'cpu'
    }
    throw e
  } finally {
    if (myGen === loadGen) {
      loadPromise = null
      loadingFingerprint = null
    }
  }
}

/**
 * 拋棄式暖機推論：首次 prompt 會做 compute-graph 冷啟動（實測 ~12s），
 * 若拖到使用者「開始字幕」後第一句才付，該 12s 內 ASR 持續產批、翻譯佇列塞爆丟批次，
 * 僅翻譯模式會整段只剩原文。預熱時先跑一次 maxTokens:1 把成本挪到背景。
 * @param {object} session
 */
async function warmupInference(session) {
  try {
    session.setChatHistory([{ type: 'system', text: '你是翻譯引擎。' }])
    await session.prompt('warmup', { maxTokens: 1, temperature: 0, budgets: { thoughtTokens: 0 } })
  } catch { /* 暖機失敗不影響實際翻譯 */ }
}

/**
 * 預熱本地翻譯模型（載入 ＋ 首次推論冷啟動）
 * 若遇「切頁／改設定」造成的 load cancelled，自動重試一次（避免 UI 誤報）。
 * @returns {Promise<{ ok: boolean, warnings: string[] }>}
 */
async function warm() {
  const warnings = []
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const session = await getSession()
      // 與實際翻譯共用 serial lock，暖機期間不與 translate/unload 互踩
      if (!warmedUp) {
        await withTranslateLock(() => warmupInference(session))
        warmedUp = true
      }
      return { ok: true, warnings }
    } catch (e) {
      if (isLoadCancelled(e) && attempt === 0) {
        // 被 unload／指紋切換作廢：再取一次（若 owner 仍在會重新載）
        continue
      }
      const msg = isLoadCancelled(e)
        ? '翻譯模型載入被中斷（可能正在切換裝置或分頁），請再試一次'
        : (e.message || String(e))
      return { ok: false, warnings: [msg] }
    }
  }
  return { ok: false, warnings: ['翻譯模型載入被中斷，請再試一次'] }
}

/**
 * 卸載本地 LLM：等翻譯佇列結束 → bump gen → dispose
 * @returns {Promise<{ ok: boolean, warnings: string[] }>}
 */
async function unload() {
  const warnings = []
  loadGen += 1
  warmedUp = false
  loadingFingerprint = null

  // 等進行中的翻譯跑完再卸
  await withTranslateLock(async () => {})

  const pending = loadPromise
  loadPromise = null
  if (pending) {
    try { await pending } catch { /* cancelled */ }
  }

  await disposeResources(resources, warnings)
  resources = null
  lastBackend = 'cpu'
  return { ok: true, warnings }
}

/** @returns {boolean} */
function isLoaded() {
  return !!resources?.session
}

/**
 * 目前載入狀態（供設定 UI／除錯）
 * @returns {{ loaded: boolean, key: string | null, gpu: boolean, backend: string }}
 */
function getLoadInfo() {
  return {
    loaded: !!resources?.session,
    key: resources?.key || null,
    gpu: !!resources?.actualGpu,
    intentGpu: !!resources?.intentGpu,
    backend: resources?.backend || lastBackend
  }
}

function stripThink(text) {
  const lastClose = text.lastIndexOf('</think>')
  if (lastClose !== -1) return text.slice(lastClose + 8).trim()
  return text.replace(/<think>[\s\S]*/g, '').trim()
}

/**
 * LinguaForge SFT 指令前綴（與訓練／HF 卡片一致）
 * @param {string} targetLang
 * @returns {string}
 */
function linguaforgeInstr(targetLang) {
  if (targetLang === 'zh-TW') return '翻譯成繁體中文：'
  if (targetLang === 'zh-CN') return '翻譯成簡體中文：'
  if (targetLang === 'en') return '翻譯成英文：'
  if (targetLang === 'ja') return '翻譯成日文：'
  if (targetLang === 'ko') return '翻譯成韓文：'
  return `翻譯成${LANGUAGE_NAMES[targetLang] || targetLang}：`
}

/**
 * 指令走 system prompt、前文走真實對話輪（chat template 原生結構）。
 * 0.8B 小模型看到「【前文】【本段】」括號式 meta-prompt 會整段複誦而不翻譯。
 * LinguaForge 必須用訓練格式：system=professional translator、user=`翻譯成…：\n`+text
 * @param {string} modelKey
 * @param {string} targetLang
 * @param {'live' | 'file' | undefined} mode
 */
function buildSystemPrompt(modelKey, targetLang, mode) {
  if (modelKey === 'linguaforge08') {
    return 'You are a professional translator.'
  }
  const langName = LANGUAGE_NAMES[targetLang] || targetLang
  if (mode === 'live') {
    // 祈使句、弱化 persona 自稱：避免極短/退化輸入時 0.8B 自我介紹成「即時字幕翻譯引擎」
    return `將使用者訊息翻譯成${langName}。訊息可能是任何語言（含日文、韓文等與目標語共用文字的語言）。即使很短也一律視為待譯文本直接翻譯；只輸出${langName}譯文，嚴禁原樣輸出、回問、解釋或寒暄。`
  }
  return `將使用者訊息翻譯成${langName}。來源可為任何語言。即使只有兩三個詞也必須翻譯；口語可補全省略主語使譯文通順。只輸出${langName}譯文，嚴禁原樣輸出原文、回問、解釋或寒暄。`
}

/**
 * @param {string} modelKey
 * @param {string} text
 * @param {string} targetLang
 */
function buildUserMessage(modelKey, text, targetLang) {
  if (modelKey === 'linguaforge08') {
    return `${linguaforgeInstr(targetLang)}\n${text}`
  }
  return text
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
  const key = resolveLocalTranslateModel()
  if (!isDownloaded(key)) {
    const label = MODELS[key]?.label || key
    throw new Error(`本地翻譯模型尚未下載（${label}），請先到設定下載`)
  }
  const session = await getSession()
  const history = [{ type: 'system', text: buildSystemPrompt(key, targetLang, options.mode) }]
  const pair = buildContextPair(context)
  if (pair) {
    history.push({ type: 'user', text: buildUserMessage(key, pair.prevSrc, targetLang) })
    history.push({ type: 'model', response: [pair.prevTr] })
  }
  session.setChatHistory(history)
  const out = await session.prompt(buildUserMessage(key, text, targetLang), {
    maxTokens: resolveMaxTokens(options),
    temperature: 0,
    budgets: { thoughtTokens: 0 }
  })
  return stripThink(out)
}

async function translateCloud(text, targetLang, cfg, context = {}, options = {}) {
  if (!cfg.apiKey) throw new Error('尚未設定 API Key')
  // 雲端無 modelKey（非 LinguaForge 訓練格式）→ 傳 null 走通用指令
  const messages = [{ role: 'system', content: buildSystemPrompt(null, targetLang, options.mode) }]
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
        temperature: 0,
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
  const rawBody = await res.text()
  let data = null
  try {
    data = rawBody ? JSON.parse(rawBody) : null
  } catch {
    // API 偶爾回含控制字元／非 JSON 的 body
    const preview = (rawBody || '').replace(/[\u0000-\u001F]+/g, ' ').slice(0, 120)
    throw new Error(
      res.ok
        ? `翻譯 API 回傳無法解析的內容${preview ? `：${preview}` : ''}`
        : `翻譯 API 錯誤: ${res.status}${preview ? ` ${preview}` : ''}`
    )
  }
  if (!res.ok) {
    throw new Error(data?.error?.message || `翻譯 API 錯誤: ${res.status}`)
  }
  return stripThink(data?.choices?.[0]?.message?.content || '')
}

/**
 * @param {import('electron-store').default} store
 * @param {string} text
 * @param {string} targetLang
 * @param {{ previousSource?: string, previousTranslation?: string, mode?: 'live' | 'file' }} [opts]
 */
/**
 * 是否含足夠語言性字元（與 renderer hasLinguisticContent 同構）。
 * 純符號／♪／零寬等餵給 0.8B 會觸發 persona 問候而非翻譯。
 * @param {string} text
 */
function hasLinguisticContent(text) {
  return (text || '').replace(/[^\p{L}]/gu, '').length >= 2
}

async function translate(store, text, targetLang, opts = {}) {
  // 舊版 none：視為 local（關閉翻譯改由目標語言「自動偵測」）
  let translator = store.get('translator', 'local')
  if (translator === 'none') translator = 'local'
  if (!text.trim()) return text
  // 縱深：renderer 應已擋；此處再擋一次避免任何路徑把 ♪♪♪／…… 送進小模型
  if (!hasLinguisticContent(text)) return text

  return withTranslateLock(async () => {
    const context = {
      previousSource: opts.previousSource || '',
      previousTranslation: opts.previousTranslation || ''
    }
    const options = { mode: opts.mode || 'file' }

    let result
    if (translator === 'local') {
      result = await translateLocal(text, targetLang, context, options)
    } else if (translator === 'cloud') {
      result = await translateCloud(
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
    } else {
      // 未知 translator 值：原樣回傳，避免誤打雲端
      return text
    }

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
  setStore,
  resolveLocalTranslateModel,
  getLoadInfo,
  TRANSLATE_MODEL_KEY,
  DEFAULT_LLM_KEY,
  FALLBACK_LLM_KEY,
  LLM_MODEL_KEYS
}
