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
const { stripThink, stripTranslationNoise, findRepetitionLoop } = require('./translate-clean')
const { detectGpuCapability } = require('./gpu-capability')
const { prependCudaBinToPath } = require('./cuda-env')
const { ensureLlamaAddon } = require('./llama-addon')

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
const DEFAULT_LLM_KEY = 'linguaforge08'
const LINGUAFORGE_KEY = 'linguaforge08'
/** 同一顆 LinguaForge 的兩個量化（Q8 預設／Q4 省空間）共用整套 SFT 格式與 DECODE */
const LINGUAFORGE_KEYS = Object.freeze(['linguaforge08', 'linguaforge08q4'])

/**
 * @param {unknown} key
 * @returns {boolean}
 */
function isLinguaforge(key) {
  return LINGUAFORGE_KEYS.includes(/** @type {string} */ (key))
}

// live 段落原文上限 120 字（MAX_BATCH_CHARS），256 tokens 足以容納中譯而不截斷半句
const MAX_TOKENS_LIVE = 256
const MAX_TOKENS_FILE = 1024
const CLOUD_TIMEOUT_MS = 20000

// ─── LinguaForge v5e 出貨解碼（evaluate.py / INTEGRATION.md）────────────────
// transformers 主路徑：beam=4 + length_penalty=1.2 + 雙 EOS + 依目標語 DECODE
// 本 app 走 GGUF／node-llama-cpp：無 beam／無 no_repeat_ngram → 映射到
//   temperature=0、repeatPenalty、dryRepeatPenalty、thoughtTokens:0、s2twp
/** SFT 收尾 <|im_end|> + base <|endoftext|>；只用單一 eos 會灌水到 max_new_tokens */
const LINGUAFORGE_EOS_TOKEN_IDS = Object.freeze([248046, 248044])
const LINGUAFORGE_NUM_BEAMS = 4
const LINGUAFORGE_LENGTH_PENALTY = 1.2
/** 長文單段建議上限（CJK 字元級）；超出在 main 再切 */
const LINGUAFORGE_CHUNK_CHARS = 280
/** 與訓練一致的指令（僅三語；勿發明 general-chat system） */
const LINGUAFORGE_INSTR = Object.freeze({
  'zh-TW': '翻譯成繁體中文：',
  en: '翻譯成英文：',
  ja: '翻譯成日文：'
})
/**
 * evaluate.DECODE 依目標語：
 *   ja/en: repetition_penalty=1.1 + no_repeat_ngram_size=4
 *   zhtw:  僅 no_repeat_ngram_size=4（禁止 rep-penalty，否則繁簡洩漏飆升）
 * @typedef {{ tgtKey: 'zhtw'|'en'|'ja', repetitionPenalty: number|null, noRepeatNgramSize: number, s2twp: boolean, numBeams: number, lengthPenalty: number, eosTokenIds: readonly number[] }} LinguaforgeDecode
 */
/** @type {Readonly<Record<'zh-TW'|'en'|'ja', Omit<LinguaforgeDecode, 'numBeams'|'lengthPenalty'|'eosTokenIds'>>>} */
const LINGUAFORGE_DECODE = Object.freeze({
  'zh-TW': { tgtKey: 'zhtw', repetitionPenalty: null, noRepeatNgramSize: 4, s2twp: true },
  en: { tgtKey: 'en', repetitionPenalty: 1.1, noRepeatNgramSize: 4, s2twp: false },
  ja: { tgtKey: 'ja', repetitionPenalty: 1.1, noRepeatNgramSize: 4, s2twp: false }
})

/**
 * Qwen3.5 chat_template 在 enable_thinking 未開時，`<|im_start|>assistant\n` 之後
 * **固定補空 think 區塊** `<think>\n\n</think>\n\n`（token 248068,271,248069,271）；
 * 模型從頭到尾帶著它訓練與評測。node-llama-cpp 預設解析出的 Qwen wrapper 不補這 4 個 token，
 * 掉出分布 → 憑空標籤前綴（說明：／問：）、拉丁專名整個消失、年份幻覺。
 * `budgets.thoughtTokens:0` 只是「不生成 thinking」，補不了前綴，兩件事都要做。
 *
 * 實測（scripts/probe-prompt-path.js）：`thoughts:'discourage'` 產出的字串與
 * transformers `apply_chat_template(..., add_generation_prompt=True)` 逐字元相同，
 * 尾端 token 正是 248068,271,248069,271 → 不需自訂 subclass。
 */
const THINK_PREFIX = '<think>\n\n</think>\n\n'
const THINK_PREFIX_TOKEN_IDS = Object.freeze([248068, 271, 248069, 271])

/**
 * @param {new (opts?: object) => object} QwenChatWrapper
 * @returns {object}
 */
function newQwen35ChatWrapper(QwenChatWrapper) {
  return new QwenChatWrapper({ thoughts: 'discourage' })
}

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
        ensureLlamaAddon(gpu === 'cuda' ? 'win-x64-cuda' : 'win-x64-vulkan')
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
    const { LlamaChatSession, QwenChatWrapper } = await import('node-llama-cpp')
    const { llama, usedGpu, backend } = await createLlama(intentGpu, warnings)
    const modelPath = path.join(modelDir(key), rel)
    const model = await llama.loadModel({ modelPath })
    const context = await model.createContext({ contextSize: 2048 })
    const session = new LlamaChatSession({
      contextSequence: context.getSequence(),
      chatWrapper: newQwen35ChatWrapper(QwenChatWrapper)
    })
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

/**
 * LinguaForge DECODE 查表（單一真相來源；對齊 evaluate.py）
 * @param {string} targetLang
 * @returns {LinguaforgeDecode}
 */
function resolveLinguaforgeDecode(targetLang) {
  const row = LINGUAFORGE_DECODE[/** @type {'zh-TW'|'en'|'ja'} */ (targetLang)]
    || LINGUAFORGE_DECODE.en
  return {
    ...row,
    numBeams: LINGUAFORGE_NUM_BEAMS,
    lengthPenalty: LINGUAFORGE_LENGTH_PENALTY,
    eosTokenIds: LINGUAFORGE_EOS_TOKEN_IDS
  }
}

/**
 * LinguaForge SFT 指令前綴（僅訓練三語；其餘 fallback 通用句以免硬編假指令）
 * @param {string} targetLang
 * @returns {string}
 */
function linguaforgeInstr(targetLang) {
  if (Object.prototype.hasOwnProperty.call(LINGUAFORGE_INSTR, targetLang)) {
    return LINGUAFORGE_INSTR[/** @type {keyof typeof LINGUAFORGE_INSTR} */ (targetLang)]
  }
  return `翻譯成${LANGUAGE_NAMES[targetLang] || targetLang}：`
}

/**
 * 依源文長度估 max_new_tokens（約 1.5–2×，設上下限防 runaway）
 * @param {string} text
 * @param {'live' | 'file' | undefined} mode
 * @param {boolean} isLinguaforge
 */
function resolveMaxTokens(text, mode, isLinguaforge = false) {
  if (mode === 'live') return MAX_TOKENS_LIVE
  if (!isLinguaforge) return MAX_TOKENS_FILE
  const n = String(text || '').length
  // CJK 約 1 token／字；輸出給 2× 空間，上限 768 防灌水
  return Math.min(768, Math.max(64, Math.ceil(n * 2)))
}

/**
 * GGUF 映射出貨 DECODE → node-llama-cpp prompt 選項
 * - 無 beam／length_penalty（log 標 N/A）
 * - zhtw 必須 repeatPenalty:false（套件省略時預設 1.1，會攪亂繁簡）
 * - no_repeat_ngram_size≈ dry allowedLength=n-1
 * - thinking 關：budgets.thoughtTokens=0
 * @param {LinguaforgeDecode} decode
 * @param {string} text
 * @param {'live' | 'file' | undefined} mode
 */
function buildLinguaforgePromptOptions(decode, text, mode) {
  const maxTokens = resolveMaxTokens(text, mode, true)
  /** @type {Record<string, unknown>} */
  const opts = {
    maxTokens,
    temperature: 0,
    budgets: { thoughtTokens: 0 },
    trimWhitespaceSuffix: true,
    // DRY 近似 no_repeat_ngram_size（allowedLength=3 → 壓制 ≥4-token 重序列）
    dryRepeatPenalty: {
      strength: 0.8,
      base: 1.75,
      allowedLength: Math.max(1, (decode.noRepeatNgramSize || 4) - 1)
    }
  }
  if (decode.repetitionPenalty != null) {
    opts.repeatPenalty = {
      penalty: decode.repetitionPenalty,
      lastTokens: 64,
      penalizeNewLine: false
    }
  } else {
    // 出貨 zhtw 禁止 rep-penalty
    opts.repeatPenalty = false
  }
  // 雙 EOS：chat wrapper 已 stop 於 <|im_end|>；補 <|endoftext|> 文字觸發
  opts.customStopTriggers = ['<|im_end|>', '<|endoftext|>']
  return opts
}

/**
 * 單行按句切 ≤ max（與 renderer splitForTranslate 同構）
 * @param {string} text
 * @param {number} [max]
 * @returns {string[]}
 */
function splitForLinguaforge(text, max = LINGUAFORGE_CHUNK_CHARS) {
  const units = String(text || '').split(/(?<=[。．.！!？?…；;])/)
  const chunks = []
  let buf = ''
  for (const u of units) {
    if (buf && buf.length + u.length > max) {
      chunks.push(buf)
      buf = ''
    }
    if (u.length > max) {
      for (let i = 0; i < u.length; i += max) chunks.push(u.slice(i, i + max))
      continue
    }
    buf += u
  }
  if (buf) chunks.push(buf)
  return chunks.filter((c) => c.trim())
}

/** 行首清單標記（`- ` `· ` `1. ` `(1) ` …）：不送模型，翻完原樣貼回 */
const LIST_MARKER = /^[ 	]*(?:[-*•·‧+>]|\d{1,2}[.)、]|[（(]\d{1,2}[)）])[ 	]*/u

/**
 * 長文切段：**逐行**，行首清單標記剝除後才送模型。
 * - 多段文字混進同一個 prompt，0.8B 會整段退化成重複迴圈並吃掉內容
 * - 孤立的 bullet 區塊整塊送同樣會被「總結」掉
 * - 連 `· ` 一起送，模型會把符號翻成標籤（實測「選擇器：」）
 * 逐行送純句子最穩，一行翻壞也不會拖垮整段；空行保留以還原段落結構。
 * @param {string} text
 * @param {number} [max]
 * @returns {{ prefix: string, parts: string[] }[]} 每行一組；parts 為空＝原樣輸出 prefix
 */
function splitLinesForLinguaforge(text, max = LINGUAFORGE_CHUNK_CHARS) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => {
      if (!line.trim()) return { prefix: '', parts: [] }
      const marker = (line.match(LIST_MARKER) || [''])[0]
      const body = line.slice(marker.length).trim()
      // 純符號行（分隔線等）原樣保留
      if (!body) return { prefix: line.trim(), parts: [] }
      const prefix = marker.trim() ? `${marker.trim()} ` : ''
      return { prefix, parts: splitForLinguaforge(body, max) }
    })
}

/**
 * @param {LinguaforgeDecode} decode
 * @param {{ maxTokens: number, stopReason?: string, s2twpApplied: boolean, chunkIndex?: number, chunkCount?: number }} meta
 */
function logLinguaforgeDecode(decode, meta) {
  console.log(
    '[linguaforge decode]',
    JSON.stringify({
      runtime: 'gguf/node-llama-cpp',
      chat_wrapper: "Qwen{thoughts:'discourage'}",
      think_prefix: JSON.stringify(THINK_PREFIX),
      think_prefix_token_ids: [...THINK_PREFIX_TOKEN_IDS],
      eos_token_id: [...decode.eosTokenIds],
      num_beams: `${decode.numBeams} (N/A on GGUF; greedy)`,
      length_penalty: `${decode.lengthPenalty} (N/A on GGUF)`,
      repetition_penalty: decode.repetitionPenalty,
      no_repeat_ngram_size: decode.noRepeatNgramSize,
      dry_allowedLength: Math.max(1, decode.noRepeatNgramSize - 1),
      s2twp: meta.s2twpApplied,
      maxTokens: meta.maxTokens,
      stopReason: meta.stopReason || null,
      chunk: meta.chunkCount
        ? `${(meta.chunkIndex || 0) + 1}/${meta.chunkCount}`
        : null
    })
  )
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
  if (isLinguaforge(modelKey)) {
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
  if (isLinguaforge(modelKey)) {
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

/**
 * 單段本地翻譯（不切段）
 * @param {string} text
 * @param {string} targetLang
 * @param {{ previousSource?: string, previousTranslation?: string }} context
 * @param {{ mode?: 'live' | 'file' }} options
 * @param {string} key
 * @param {{ chunkIndex?: number, chunkCount?: number }} [chunkMeta]
 */
async function translateLocalOnce(text, targetLang, context, options, key, chunkMeta = {}) {
  const session = await getSession()
  const history = [{ type: 'system', text: buildSystemPrompt(key, targetLang, options.mode) }]
  // LinguaForge 是單輪 SFT MT 模型：多一輪對話（前文）會讓 greedy 直接複誦上一輪譯文
  // → 整篇長文每段都吐同一句。出貨格式就是 system + 單一 user，不給前文。
  const pair = isLinguaforge(key) ? null : buildContextPair(context)
  if (pair) {
    history.push({ type: 'user', text: buildUserMessage(key, pair.prevSrc, targetLang) })
    history.push({ type: 'model', response: [pair.prevTr] })
  }
  session.setChatHistory(history)
  const userMsg = buildUserMessage(key, text, targetLang)

  if (isLinguaforge(key)) {
    const decode = resolveLinguaforgeDecode(targetLang)
    const promptOpts = buildLinguaforgePromptOptions(decode, text, options.mode)

    /** 單次推論（重試前必須還原 history，否則第二輪會帶著上一輪 → 複誦） */
    const runOnce = async (opts) => {
      session.setChatHistory(history)
      if (typeof session.promptWithMeta !== 'function') {
        return { out: await session.prompt(userMsg, opts), stopReason: '' }
      }
      const meta = await session.promptWithMeta(userMsg, opts)
      const out = typeof meta?.responseText === 'string'
        ? meta.responseText
        : Array.isArray(meta?.response)
          ? meta.response.filter((x) => typeof x === 'string').join('')
          : String(meta?.response || '')
      return { out, stopReason: meta?.stopReason || '' }
    }

    let { out, stopReason } = await runOnce(promptOpts)
    if (process.env.VOICEINK_DEBUG_RAW) console.log('[linguaforge raw]', JSON.stringify(out))
    let cleaned = stripTranslationNoise(stripThink(out), text)

    // 退化迴圈救援：出貨 zhtw 禁 rep-penalty，條列／多段輸入偶爾整段吐重複片段並吃掉內容。
    // 此時「開 rep-penalty（輕微繁簡風險）」遠優於「一段重複垃圾」→ 只在偵測到退化時重跑。
    const loop = findRepetitionLoop(cleaned)
    if (loop) {
      const retryOpts = {
        ...promptOpts,
        repeatPenalty: { penalty: 1.15, lastTokens: 128, penalizeNewLine: false },
        dryRepeatPenalty: { strength: 1, base: 1.75, allowedLength: 2 }
      }
      const retry = await runOnce(retryOpts)
      const retryCleaned = stripTranslationNoise(stripThink(retry.out), text)
      const retryLoop = findRepetitionLoop(retryCleaned)
      console.warn(
        `[linguaforge] 退化重複「${loop}」→ 重試 anti-repeat：${retryLoop ? `仍退化「${retryLoop}」` : 'ok'}`
      )
      if (!retryLoop && retryCleaned) {
        out = retry.out
        stopReason = retry.stopReason
        cleaned = retryCleaned
      }
    }

    const s2twpApplied = !!(decode.s2twp && cleaned && cleaned !== text.trim())
    const finalOut = s2twpApplied ? s2twp(cleaned) : cleaned
    logLinguaforgeDecode(decode, {
      maxTokens: /** @type {number} */ (promptOpts.maxTokens),
      stopReason,
      s2twpApplied,
      chunkIndex: chunkMeta.chunkIndex,
      chunkCount: chunkMeta.chunkCount
    })
    return finalOut
  }

  const out = await session.prompt(userMsg, {
    maxTokens: resolveMaxTokens(text, options.mode, false),
    temperature: 0,
    budgets: { thoughtTokens: 0 }
  })
  return stripTranslationNoise(stripThink(out), text)
}

async function translateLocal(text, targetLang, context = {}, options = {}) {
  const key = resolveLocalTranslateModel()
  if (!isDownloaded(key)) {
    const label = MODELS[key]?.label || key
    throw new Error(`本地翻譯模型尚未下載（${label}），請先到設定下載`)
  }

  // LinguaForge：file 模式逐行翻譯（清單標記不送模型），再還原行／段落結構
  if (isLinguaforge(key) && options.mode !== 'live') {
    const lines = splitLinesForLinguaforge(text)
    const total = lines.reduce((n, l) => n + l.parts.length, 0)
    if (total > 1) {
      const outLines = []
      let done = 0
      for (const line of lines) {
        if (!line.parts.length) {
          outLines.push(line.prefix)
          continue
        }
        const translated = []
        for (const part of line.parts) {
          translated.push(
            await translateLocalOnce(part, targetLang, {}, options, key, {
              chunkIndex: done++,
              chunkCount: total
            })
          )
        }
        outLines.push(line.prefix + translated.join(''))
      }
      return outLines.join('\n').replace(/\s+$/, '')
    }
  }

  return translateLocalOnce(text, targetLang, context, options, key)
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
        max_tokens: resolveMaxTokens(text, options.mode, false),
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
    // API 偶爾回含控制字元／非 JSON 的 body。
    // 只留狀態碼：body 與 error.message 都是上游可控的字串，不進使用者可見訊息。
    console.error(`[translate] 上游回應無法解析: HTTP ${res.status}`)
    throw new Error(res.ok ? '翻譯 API 回傳無法解析的內容' : `翻譯 API 錯誤: ${res.status}`)
  }
  if (!res.ok) {
    console.error(`[translate] API error: HTTP ${res.status}`)
    throw new Error(`翻譯 API 錯誤: ${res.status}`)
  }
  return stripTranslationNoise(stripThink(data?.choices?.[0]?.message?.content || ''), text)
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

    // 出口再剝一次系統提示洩漏（防任何路徑漏網）
    result = stripTranslationNoise(stripThink(result || ''), text)
    // 模型自我複誦（含日文頑固句）：回原文、不轉繁——s2twp 會 mangle 使 renderer 的 echo 去重失效
    if (result.trim() === text.trim()) return result
    // LinguaForge 已在 translateLocalOnce 依 DECODE.s2twp 處理；其餘本地／雲端 zh-TW 仍過 s2twp
    if (translator === 'local' && isLinguaforge(resolveLocalTranslateModel())) {
      return result
    }
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
  resolveLinguaforgeDecode,
  LINGUAFORGE_KEY,
  LINGUAFORGE_KEYS,
  isLinguaforge,
  LINGUAFORGE_CHUNK_CHARS,
  LINGUAFORGE_EOS_TOKEN_IDS,
  LINGUAFORGE_DECODE,
  THINK_PREFIX,
  THINK_PREFIX_TOKEN_IDS,
  newQwen35ChatWrapper,
  TRANSLATE_MODEL_KEY,
  DEFAULT_LLM_KEY,
  FALLBACK_LLM_KEY,
  LLM_MODEL_KEYS
}
