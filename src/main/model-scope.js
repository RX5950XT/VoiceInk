/**
 * VoiceInk - 每一頁自己的模型選擇（Main Process）
 *
 * 「語音轉文字」底下三個子分頁各做各的事，共用一組模型會互相打架
 * （即時字幕想用 GPU 那顆、語音輸入想用 CPU 那顆），所以每一頁各存一份選擇。
 *
 * 值的字串格式沿用語音輸入原本的 `dictationLlm`，三個 scope 共用同一組解析：
 *   ASR → `local:<模型 key>` ／ `cloud:<雲端設定 id>:<模型 id>` ／ `cloud`（舊值＝用預設那組）
 *   LLM → `local:<模型 key>` ／ `cloud:<供應商 id>:<模型 id>` ／ `''`（不使用）
 *
 * 「不使用」只有語音輸入需要（整理是加分項）；檔案轉錄與即時字幕靠「目標語言＝
 * 自動偵測」關掉翻譯，再多一個關閉開關只會讓使用者搞不清楚是哪一個在生效。
 *
 * 翻譯與 TTS 頁**不在這裡**：它維持用全域的 `translator`／`localTranslateModel`／
 * `translateProviderId`／`translateModelId`。
 */

const models = require('./models')

/** @typedef {'file'|'live'|'dictation'} Scope */

/** @type {readonly Scope[]} */
const SCOPES = Object.freeze(['file', 'live', 'dictation'])

const ASR_STORE_KEYS = Object.freeze({ file: 'fileAsr', live: 'liveAsr', dictation: 'dictationAsr' })
const LLM_STORE_KEYS = Object.freeze({ file: 'fileLlm', live: 'liveLlm', dictation: 'dictationLlm' })

/** 只有語音輸入可以選「不整理」 */
const LLM_OPTIONAL = Object.freeze({ file: false, live: false, dictation: true })

const DEFAULT_ASR_VALUE = 'local:qwen3asr'
const DEFAULT_LLM_VALUE = 'local:linguaforge08q4'

/**
 * @param {unknown} scope
 * @returns {scope is Scope}
 */
function isScope(scope) {
  return typeof scope === 'string' && SCOPES.includes(/** @type {Scope} */ (scope))
}

/**
 * @param {unknown} raw
 * @param {Array<{ id: string, models: string[] }>} [clouds] 已 sanitize 的雲端 ASR 設定清單
 * @returns {string} `cloud`／`cloud:<設定 id>:<模型 id>`／`local:<已知的 ASR key>`
 */
function sanitizeAsr(raw, clouds) {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (value === 'cloud') {
    // 舊值只說「用雲端」，沒說是哪一組哪一顆。有清單就升級成明確的那一顆——
    // 不升級的話功能頁的選單找不到對應項目，畫面會顯示成本地那顆（實際上還是雲端在跑）
    const list = Array.isArray(clouds) ? clouds : cloudsOf(null)
    const first = list.find((c) => c?.models?.length)
    return first ? `cloud:${first.id}:${first.models[0]}` : 'cloud'
  }
  if (value.startsWith('local:')) {
    const key = value.slice('local:'.length)
    if (models.isAsrKey(key)) return `local:${key}`
  }
  if (value.startsWith('cloud:')) {
    // 模型 id 可能含冒號（`openai/whisper-1:extended`），設定 id 不會 → 只切第一刀
    const [, cloudId, ...rest] = value.split(':')
    const modelId = rest.join(':')
    const list = Array.isArray(clouds) ? clouds : cloudsOf(null)
    const cloud = list.find((c) => c?.id === cloudId)
    if (cloud && Array.isArray(cloud.models) && cloud.models.includes(modelId)) {
      return `cloud:${cloudId}:${modelId}`
    }
    // 設定還在、只是那顆模型被刪了 → 退回同一組設定的第一顆，不要整個掉回本地
    if (cloud && cloud.models?.length) return `cloud:${cloudId}:${cloud.models[0]}`
    return 'cloud'
  }
  return DEFAULT_ASR_VALUE
}

/**
 * @param {{ get: (k: string, d?: unknown) => unknown } | null} store
 * @returns {Array<{ id: string, name: string, apiUrl: string, apiKey: string, models: string[] }>}
 */
function cloudsOf(store) {
  // 延後 require：cloud-asr 也會回頭問這個模組要 scope 的選擇（互相 require）
  return require('./cloud-asr').sanitizeAsrClouds(store?.get('asrClouds', []) || [])
}

/**
 * @param {unknown} raw
 * @param {Array<{ id: string, models: string[] }>} providers 已 sanitize 的供應商清單
 * @param {boolean} allowOff false 時空值退回預設本地模型（檔案轉錄／即時字幕）
 * @returns {string}
 */
function sanitizeLlm(raw, providers, allowOff) {
  const fallback = allowOff ? '' : DEFAULT_LLM_VALUE
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) return fallback
  if (value.startsWith('local:')) {
    const key = models.migrateModelKey(value.slice('local:'.length))
    return models.isLlmKey(key) ? `local:${key}` : fallback
  }
  if (value.startsWith('cloud:')) {
    // 模型 id 本身可能含冒號（`openai/gpt-4o:extended`），供應商 id 不會 → 只切第一刀
    const [, providerId, ...rest] = value.split(':')
    const modelId = rest.join(':')
    const provider = (Array.isArray(providers) ? providers : []).find((p) => p?.id === providerId)
    if (provider && Array.isArray(provider.models) && provider.models.includes(modelId)) {
      return `cloud:${providerId}:${modelId}`
    }
  }
  return fallback
}

/**
 * @param {{ get: (k: string, d?: unknown) => unknown } | null} store
 * @returns {Array<{ id: string, name: string, apiUrl: string, apiKey: string, models: string[] }>}
 */
function providersOf(store) {
  // 延後 require：chat.js 會拉進 chat-store／chat-images，開機路徑上不必要
  return require('./chat').sanitizeProviders(store?.get('chatProviders', []) || [])
}

/**
 * @param {{ get: (k: string, d?: unknown) => unknown } | null} store
 * @param {Scope} scope
 * @returns {{ engine: 'local'|'cloud', modelKey: string, cloudId: string, modelId: string,
 *             value: string }}
 */
function readAsr(store, scope) {
  const key = ASR_STORE_KEYS[isScope(scope) ? scope : 'file']
  const value = sanitizeAsr(store?.get(key, DEFAULT_ASR_VALUE), cloudsOf(store))
  if (value === 'cloud') return { engine: 'cloud', modelKey: '', cloudId: '', modelId: '', value }
  if (value.startsWith('cloud:')) {
    const [, cloudId, ...rest] = value.split(':')
    return { engine: 'cloud', modelKey: '', cloudId, modelId: rest.join(':'), value }
  }
  return {
    engine: 'local',
    modelKey: value.slice('local:'.length),
    cloudId: '',
    modelId: '',
    value
  }
}

/**
 * `stale`＝存的值指到已經不存在的供應商／模型而被清掉。使用者原本是有選的，
 * 靜靜地退回「不使用」等於整理功能無聲消失，呼叫端要拿它提醒一句。
 * @param {{ get: (k: string, d?: unknown) => unknown } | null} store
 * @param {Scope} scope
 * @returns {{ mode: 'off'|'local'|'cloud', modelKey: string, providerId: string, modelId: string,
 *             apiUrl: string, apiKey: string, providerName: string, value: string, stale: boolean }}
 */
function readLlm(store, scope) {
  const name = isScope(scope) ? scope : 'file'
  const raw = String(store?.get(LLM_STORE_KEYS[name], '') || '')
  const value = sanitizeLlm(raw, providersOf(store), LLM_OPTIONAL[name])
  const empty = {
    mode: /** @type {'off'} */ ('off'),
    modelKey: '',
    providerId: '',
    modelId: '',
    apiUrl: '',
    apiKey: '',
    providerName: '',
    value,
    stale: Boolean(raw) && raw !== value
  }
  if (!value) return empty
  if (value.startsWith('local:')) {
    return { ...empty, mode: 'local', modelKey: value.slice('local:'.length) }
  }
  const [, providerId, ...rest] = value.split(':')
  const provider = providersOf(store).find((p) => p.id === providerId)
  if (!provider) return empty
  return {
    ...empty,
    mode: 'cloud',
    providerId,
    modelId: rest.join(':'),
    apiUrl: provider.apiUrl || '',
    apiKey: provider.apiKey || '',
    providerName: provider.name || ''
  }
}

/**
 * 供應商被刪掉或改名之後，三個 scope 的雲端選擇都可能指到不存在的那一組。
 * @param {{ get: (k: string, d?: unknown) => unknown, set: (k: string, v: unknown) => void }} store
 */
function reconcileAll(store) {
  const providers = providersOf(store)
  const clouds = cloudsOf(store)
  for (const scope of SCOPES) {
    const key = LLM_STORE_KEYS[scope]
    store.set(key, sanitizeLlm(store.get(key, ''), providers, LLM_OPTIONAL[scope]))
    // 雲端 ASR 的設定或模型被刪掉時，三頁的選擇也可能指到不存在的那一顆
    const asrKey = ASR_STORE_KEYS[scope]
    const asrValue = store.get(asrKey, '')
    if (asrValue) store.set(asrKey, sanitizeAsr(asrValue, clouds))
  }
}

/**
 * 開機一次性播種：舊版只有一組全域選擇，三頁沿用它當起點。
 * 已經有值的 scope 不動（使用者已經自己選過了）。
 * @param {{ get: (k: string, d?: unknown) => unknown, set: (k: string, v: unknown) => void,
 *           has?: (k: string) => boolean }} store
 */
function seedFromLegacy(store) {
  const legacyAsr = store.get('asrEngine', 'local') === 'cloud'
    ? 'cloud'
    : `local:${store.get('asrModelKey', 'qwen3asr')}`

  let legacyLlm = ''
  if (store.get('translator', 'local') === 'cloud') {
    const providerId = String(store.get('translateProviderId', '') || '')
    const modelId = String(store.get('translateModelId', '') || '')
    if (providerId && modelId) legacyLlm = `cloud:${providerId}:${modelId}`
  } else {
    legacyLlm = `local:${store.get('localTranslateModel', 'linguaforge08q4')}`
  }

  const providers = providersOf(store)
  for (const scope of SCOPES) {
    const asrKey = ASR_STORE_KEYS[scope]
    if (store.get(asrKey, '') === '') store.set(asrKey, sanitizeAsr(legacyAsr))

    const llmKey = LLM_STORE_KEYS[scope]
    // 語音輸入的 `dictationLlm` 是自己的設定，空值代表「不整理」，不可以被播種蓋掉
    if (scope === 'dictation') continue
    if (store.get(llmKey, '') === '') {
      store.set(llmKey, sanitizeLlm(legacyLlm, providers, false))
    }
  }
}

module.exports = {
  SCOPES,
  ASR_STORE_KEYS,
  LLM_STORE_KEYS,
  LLM_OPTIONAL,
  DEFAULT_ASR_VALUE,
  DEFAULT_LLM_VALUE,
  isScope,
  cloudsOf,
  sanitizeAsr,
  sanitizeLlm,
  readAsr,
  readLlm,
  reconcileAll,
  seedFromLegacy
}
