/**
 * VoiceInk - 引擎生命週期（Main Process）
 * live / file 共用 refcount；引用歸零才 unload
 * warm / unload 經 serial chain + 與各模組 generation 配合
 */

const localAsr = require('./local-asr')
const localLlm = require('./local-llm')

/** @type {{ live: boolean, file: boolean }} */
const users = { live: false, file: false }

/** 生命週期 serial：acquire/release/unloadAll 不互踩 */
let lifecycleChain = Promise.resolve()

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withLifecycle(fn) {
  const run = lifecycleChain.then(fn, fn)
  lifecycleChain = run.then(() => {}, () => {})
  return run
}

/**
 * 取得使用中的 owner
 */
function activeOwners() {
  return Object.entries(users)
    .filter(([, v]) => v)
    .map(([k]) => k)
}

/**
 * 佔用引擎並預熱需要的模型
 * @param {'live'|'file'} owner
 * @param {{ asr?: boolean, llm?: boolean }} needs
 * @returns {Promise<{ ok: boolean, asrLoaded: boolean, llmLoaded: boolean, warnings: string[] }>}
 */
async function acquire(owner, needs = {}) {
  if (owner !== 'live' && owner !== 'file') {
    throw new Error(`未知 engine owner: ${owner}`)
  }
  const wantAsr = needs.asr !== false
  const wantLlm = !!needs.llm

  return withLifecycle(async () => {
    users[owner] = true
    const warnings = []

    // ASR 與 LLM 互相獨立，並行 warm 縮短同時載入兩模型的等待（warm 各自 catch 不 reject）
    const [asrRes, llmRes] = await Promise.all([
      wantAsr ? localAsr.warm() : Promise.resolve(null),
      wantLlm ? localLlm.warm() : Promise.resolve(null)
    ])
    if (asrRes) warnings.push(...(asrRes.warnings || []))
    if (llmRes) warnings.push(...(llmRes.warnings || []))

    const asrLoaded = localAsr.isLoaded()
    const llmLoaded = localLlm.isLoaded()
    const ok = (!wantAsr || asrLoaded) && (!wantLlm || llmLoaded)

    if (!ok) {
      // warm 失敗：釋放此 owner，避免卡 refcount
      users[owner] = false
      await maybeUnloadUnlocked()
    }

    return { ok, asrLoaded, llmLoaded, warnings }
  })
}

/**
 * 釋放 owner；無人使用時卸載模型
 * @param {'live'|'file'} owner
 */
async function release(owner) {
  if (owner !== 'live' && owner !== 'file') return { ok: true, warnings: [] }
  return withLifecycle(async () => {
    users[owner] = false
    return maybeUnloadUnlocked()
  })
}

/**
 * 引用歸零才卸（已在 lifecycle lock 內呼叫）
 */
async function maybeUnloadUnlocked() {
  const warnings = []
  if (activeOwners().length > 0) {
    return { ok: true, unloaded: false, warnings, users: { ...users } }
  }
  const llm = await localLlm.unload()
  const asr = await localAsr.unload()
  warnings.push(...(llm.warnings || []), ...(asr.warnings || []))
  return { ok: true, unloaded: true, warnings, users: { ...users } }
}

/**
 * 強制卸載全部（quit 用）
 */
async function unloadAll() {
  return withLifecycle(async () => {
    users.live = false
    users.file = false
    const warnings = []
    const llm = await localLlm.unload()
    const asr = await localAsr.unload()
    warnings.push(...(llm.warnings || []), ...(asr.warnings || []))
    return { ok: true, unloaded: true, warnings }
  })
}

function status() {
  return {
    users: { ...users },
    asrLoaded: localAsr.isLoaded(),
    llmLoaded: localLlm.isLoaded()
  }
}

module.exports = { acquire, release, unloadAll, status }
