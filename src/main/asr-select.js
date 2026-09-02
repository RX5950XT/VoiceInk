/**
 * VoiceInk - 本地 ASR 模組選擇（Main Process）
 *
 * 使用者在「語音轉文字」頁選的是哪一顆本地模型，決定要用哪一支實作：
 *   qwen3asr    → local-asr.js（sherpa-onnx，只有 CPU）
 *   qwen3asrgpu → llama-asr.js（llama-server sidecar，Vulkan GPU）
 *
 * 兩支的對外介面一樣，所以選擇邏輯只寫在這一個檔案，
 * `engine.js`／`file-transcribe.js`／`main.js` 都只認這個門面，不各寫一份 if。
 */

const localAsr = require('./local-asr')
const llamaAsr = require('./llama-asr')
const modelScope = require('./model-scope')

const DEFAULT_ASR_MODEL_KEY = 'qwen3asr'
const GPU_ASR_MODEL_KEY = 'qwen3asrgpu'

/** @type {{ get: (k: string, d?: unknown) => unknown } | null} */
let storeRef = null

/**
 * @param {object} store
 */
function setStore(store) {
  storeRef = /** @type {{ get: (k: string, d?: unknown) => unknown }} */ (store)
  localAsr.setStore(store)
  llamaAsr.setStore(store)
}

/**
 * 這個 scope（檔案轉錄／即時字幕／語音輸入）選中的本地 ASR 模型 key。
 * 三頁各存一份選擇，所以 scope 一定要傳；`asr-select` 不再有「全域那一顆」。
 * @param {import('./model-scope').Scope} scope
 * @param {{ get: (k: string, d?: unknown) => unknown } | null} [store]
 * @returns {string}
 */
function currentKey(scope, store = storeRef) {
  const raw = modelScope.readAsr(store, scope).modelKey
  return raw === GPU_ASR_MODEL_KEY ? GPU_ASR_MODEL_KEY : DEFAULT_ASR_MODEL_KEY
}

/**
 * 目前該用哪一支實作
 * @param {import('./model-scope').Scope} scope
 * @param {{ get: (k: string, d?: unknown) => unknown } | null} [store]
 * @returns {typeof localAsr | typeof llamaAsr}
 */
function pick(scope, store = storeRef) {
  return currentKey(scope, store) === GPU_ASR_MODEL_KEY ? llamaAsr : localAsr
}

/**
 * 另一支（切換模型時要把它收掉，兩顆同時吃記憶體沒意義）
 * @param {object} chosen
 */
function other(chosen) {
  return chosen === llamaAsr ? localAsr : llamaAsr
}

/**
 * @param {import('./model-scope').Scope} scope
 * @returns {Promise<{ ok: boolean, warnings: string[] }>}
 */
async function warm(scope) {
  const chosen = pick(scope)
  const idle = other(chosen)
  if (idle.isLoaded()) await idle.unload()
  return chosen.warm()
}

/**
 * 兩支任一載著就算載著：engine 的 `acquire` 只想知道「ASR 準備好了沒」。
 * @returns {boolean}
 */
function isLoaded() {
  return localAsr.isLoaded() || llamaAsr.isLoaded()
}

/**
 * 兩支都收掉：engine 的 refcount 歸零時不該留下任何常駐資源
 * @returns {Promise<{ ok: boolean, warnings: string[] }>}
 */
async function unload() {
  const results = await Promise.all([localAsr.unload(), llamaAsr.unload()])
  return {
    ok: results.every((r) => r?.ok !== false),
    warnings: results.flatMap((r) => r?.warnings || [])
  }
}

/**
 * 只往下傳三個欄位：模型由 main 依 scope 從 store 決定，
 * renderer 給的 `modelKey`／`scope` 一律不採用（scope 由 IPC 通道本身決定）。
 * @param {import('./model-scope').Scope} scope
 * @param {{ samples: unknown, sampleRate?: number, lang?: string }} req
 * @returns {Promise<string>}
 */
function transcribe(scope, req) {
  return pick(scope).transcribe({
    samples: req?.samples,
    sampleRate: req?.sampleRate,
    lang: req?.lang
  })
}

module.exports = {
  setStore,
  warm,
  unload,
  isLoaded,
  transcribe,
  currentKey,
  pick,
  DEFAULT_ASR_MODEL_KEY,
  GPU_ASR_MODEL_KEY
}
