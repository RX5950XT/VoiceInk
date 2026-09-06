/**
 * VoiceInk - 使用現場的模型選單
 *
 * 設定頁只管「裝了什麼、怎麼推論」；「這件事要用哪一顆」在做事的頁面上直接選。
 *
 * 「語音轉文字」底下三個子分頁**各自獨立**（scope＝`file`／`live`／`dictation`），
 * 每一頁各存一份選擇，選單就放在那一頁的內容裡：
 *   ASR → `<scope>Asr`：`local:<模型 key>` ／ `cloud:<雲端設定 id>:<模型 id>`
 *   LLM → `<scope>Llm`：`local:<模型 key>` ／ `cloud:<供應商 id>:<模型 id>` ／ ''（不使用）
 *
 * 「翻譯與 TTS」頁是另一組（全域的 `translator` ＋ `localTranslateModel` ／
 * `translateProviderId` ＋ `translateModelId`），沿用原本的 `*Translate*` 那幾支。
 *
 * 雲端 LLM 直接列聊天供應商清單裡的每一顆——兩邊都是 OpenAI 相容的
 * chat completions，沒必要讓使用者把同一組網址金鑰填兩次。
 */

import { electronAPI, showToast } from './app.js'

/** 選項值編碼：本地 `local:<模型 key>`；ASR 雲端 `cloud`；LLM 雲端 `cloud:<供應商 id>:<模型 id>` */
const CLOUD_VALUE = 'cloud'

/** 本地 ASR 模型顯示順序（與 main models.js 的 ASR_MODEL_KEYS 一致） */
const ASR_KEYS = ['qwen3asr', 'qwen3asrgpu']
/** 本地 LLM 模型顯示順序（與 main models.js 的 LLM_MODEL_KEYS 一致） */
const LLM_KEYS = ['linguaforge08q4', 'qwen35translate', 'qwen354b']

/** 三個子分頁各自的 store key（與 main model-scope.js 一致） */
export const SCOPE_KEYS = Object.freeze({
  file: { asr: 'fileAsr', llm: 'fileLlm' },
  live: { asr: 'liveAsr', llm: 'liveLlm' },
  dictation: { asr: 'dictationAsr', llm: 'dictationLlm' }
})

/**
 * @param {Record<string, { label?: string, downloaded?: boolean, requires?: string|null }>} modelsMap
 * @param {string[]} keys
 * @param {string | null} cloudLabel null＝不加通用雲端項（LLM 改為逐一列出供應商的模型）
 * @returns {{ value: string, label: string, ready: boolean }[]}
 */
function buildOptions(modelsMap, keys, cloudLabel) {
  const options = keys
    .filter((key) => modelsMap?.[key])
    .map((key) => {
      const def = modelsMap[key]
      const needsRuntime = def.requires && !modelsMap?.[def.requires]?.downloaded
      const ready = !!def.downloaded && !needsRuntime
      return {
        value: `local:${key}`,
        label: `本地 · ${def.label || key}${ready ? '' : '（未安裝）'}`,
        ready
      }
    })
  if (cloudLabel !== null) options.push({ value: CLOUD_VALUE, label: `雲端 · ${cloudLabel}`, ready: true })
  return options
}

/**
 * 本地兩顆 ＋ 每一組雲端設定底下的每一顆模型。
 *
 * 一組雲端設定可以放好幾顆轉錄模型（同一把金鑰、同一個端點），所以這裡跟雲端 LLM
 * 一樣逐一列出來，值是 `cloud:<設定 id>:<模型 id>`。
 * @param {Record<string, { label?: string, downloaded?: boolean, requires?: string|null }>} modelsMap
 * @param {{ asrClouds?: Array<{ id: string, name?: string, apiUrl?: string, apiKey?: string, models?: string[] }> }} settings
 */
export function asrOptions(modelsMap, settings) {
  const options = buildOptions(modelsMap, ASR_KEYS, null)
  const clouds = Array.isArray(settings?.asrClouds) ? settings.asrClouds : []
  for (const cloud of clouds) {
    const ready = Boolean(cloud?.apiUrl && cloud?.apiKey)
    // 舊檔可能還是單一 modelId（main 開機會升級，這裡容錯免得升級前那一輪整排不見）
    const list = cloud?.models?.length ? cloud.models : [cloud?.modelId].filter(Boolean)
    for (const model of list) {
      options.push({
        value: `${CLOUD_VALUE}:${cloud.id}:${model}`,
        label: `雲端 · ${cloud.name || '未命名'} / ${model}${ready ? '' : '（缺 API Key）'}`,
        ready
      })
    }
  }
  if (!options.some((o) => o.value.startsWith(`${CLOUD_VALUE}:`))) {
    options.push({ value: CLOUD_VALUE, label: '雲端 · 尚未設定轉錄模型', ready: false })
  }
  return options
}

/**
 * 本地三顆 ＋ 雲端供應商清單裡的每一顆
 * @param {Record<string, { label?: string, downloaded?: boolean, requires?: string|null }>} modelsMap
 * @param {{ chatProviders?: Array<{ id: string, name?: string, apiUrl?: string, apiKey?: string, models?: string[] }> }} settings
 * @param {{ offLabel?: string }} [opts] 有 offLabel 就在最前面加一個「不使用」
 */
export function translateOptions(modelsMap, settings, opts = {}) {
  const options = buildOptions(modelsMap, LLM_KEYS, null)
  const providers = Array.isArray(settings?.chatProviders) ? settings.chatProviders : []
  for (const provider of providers) {
    const ready = Boolean(provider?.apiUrl && provider?.apiKey)
    for (const model of provider?.models || []) {
      options.push({
        value: `${CLOUD_VALUE}:${provider.id}:${model}`,
        label: `雲端 · ${provider.name || '未命名'} / ${model}${ready ? '' : '（缺 API Key）'}`,
        ready
      })
    }
  }
  if (!options.some((o) => o.value.startsWith(`${CLOUD_VALUE}:`))) {
    options.push({ value: CLOUD_VALUE, label: '雲端 · 尚未設定供應商', ready: false })
  }
  if (opts.offLabel) options.unshift({ value: '', label: opts.offLabel, ready: true })
  return options
}

/**
 * 目前選中的雲端翻譯供應商與模型（`translateProviderId` 失效時退回第一組）。
 * 這一支是「翻譯與 TTS」頁專用（全域 key）。
 * @param {{ chatProviders?: Array<{ id: string, name?: string, apiUrl?: string, apiKey?: string, models?: string[] }>,
 *           translateProviderId?: string, translateModelId?: string }} settings
 * @returns {{ provider: object|null, modelId: string, ready: boolean }}
 */
export function resolveCloudTranslate(settings) {
  const providers = Array.isArray(settings?.chatProviders) ? settings.chatProviders : []
  const provider = providers.find((p) => p.id === settings?.translateProviderId) || providers[0] || null
  const models = provider?.models || []
  const modelId = models.includes(settings?.translateModelId) ? settings.translateModelId : (models[0] || '')
  return { provider, modelId, ready: Boolean(provider?.apiUrl && provider?.apiKey && modelId) }
}

/**
 * 某個 scope 的雲端 LLM 是否設好了（供應商還在、金鑰有填）
 * @param {{ chatProviders?: Array<{ id: string, apiUrl?: string, apiKey?: string, models?: string[] }> }} settings
 * @param {string} value `<scope>Llm` 的值
 * @returns {{ provider: object|null, modelId: string, ready: boolean }}
 */
export function resolveScopedCloud(settings, value) {
  const raw = String(value || '')
  if (!raw.startsWith(`${CLOUD_VALUE}:`)) return { provider: null, modelId: '', ready: false }
  const [, providerId, ...rest] = raw.split(':')
  const modelId = rest.join(':')
  const providers = Array.isArray(settings?.chatProviders) ? settings.chatProviders : []
  const provider = providers.find((p) => p.id === providerId) || null
  return {
    provider,
    modelId,
    ready: Boolean(provider?.apiUrl && provider?.apiKey && provider?.models?.includes(modelId))
  }
}

/**
 * 這個 scope 的 LLM 選擇代表什麼
 * @param {string} value
 * @returns {{ mode: 'off'|'local'|'cloud', modelKey: string }}
 */
export function parseLlmValue(value) {
  const raw = String(value || '')
  if (raw.startsWith('local:')) return { mode: 'local', modelKey: raw.slice('local:'.length) }
  if (raw.startsWith(CLOUD_VALUE)) return { mode: 'cloud', modelKey: '' }
  return { mode: 'off', modelKey: '' }
}

/**
 * 這個 scope 的 ASR 選擇代表什麼
 * @param {string} value
 * @returns {{ engine: 'local'|'cloud', modelKey: string }}
 */
export function parseAsrValue(value) {
  const raw = String(value || '')
  if (raw.startsWith('local:')) {
    return { engine: 'local', modelKey: raw.slice('local:'.length), cloudId: '', modelId: '' }
  }
  if (raw.startsWith(`${CLOUD_VALUE}:`)) {
    // 模型 id 可能含冒號，設定 id 不會 → 只切第一刀
    const [, cloudId, ...rest] = raw.split(':')
    return { engine: 'cloud', modelKey: '', cloudId, modelId: rest.join(':') }
  }
  return { engine: 'cloud', modelKey: '', cloudId: '', modelId: '' }
}

/**
 * 讀某個 scope 現在選的是什麼（main 已做過收斂，這裡直接用）
 * @param {'file'|'live'|'dictation'} scope
 * @returns {Promise<{ asr: string, llm: string }>}
 */
export async function readScope(scope) {
  const keys = SCOPE_KEYS[scope]
  const [asr, llm] = await Promise.all([
    electronAPI.store.get(keys.asr, 'local:qwen3asr'),
    electronAPI.store.get(keys.llm, '')
  ])
  return { asr: String(asr || 'local:qwen3asr'), llm: String(llm || '') }
}

/**
 * @param {'file'|'live'|'dictation'} scope
 * @param {'asr'|'llm'} kind
 * @param {string} value
 * @returns {Promise<void>}
 */
export async function writeScope(scope, kind, value) {
  await electronAPI.store.set(SCOPE_KEYS[scope][kind], value)
}

/**
 * 把選項灌進 <select>；未安裝的仍可選（選了才提示去下載），
 * 這樣使用者看得到「有這個選擇、只是還沒裝」，而不是選單裡憑空少一項。
 * @param {HTMLSelectElement | null} select
 * @param {{ value: string, label: string, ready: boolean }[]} options
 * @param {string} current
 */
export function fillSelect(select, options, current) {
  if (!select) return
  select.replaceChildren()
  for (const opt of options) {
    const el = document.createElement('option')
    el.value = opt.value
    el.textContent = opt.label
    if (!opt.ready) el.dataset.notReady = '1'
    select.appendChild(el)
  }
  if (options.some((o) => o.value === current)) select.value = current
}

/**
 * 「翻譯與 TTS」頁專用（全域 key）
 * @param {{ translator?: string, localTranslateModel?: string }} settings
 */
export function currentTranslateValue(settings) {
  if (settings?.translator !== 'cloud') return `local:${settings?.localTranslateModel || 'linguaforge08q4'}`
  const { provider, modelId } = resolveCloudTranslate(settings)
  return provider && modelId ? `${CLOUD_VALUE}:${provider.id}:${modelId}` : CLOUD_VALUE
}

/**
 * 「翻譯與 TTS」頁專用（全域 key）
 * @param {string} value
 * @returns {Promise<void>}
 */
export async function applyTranslateChoice(value) {
  if (value.startsWith(`${CLOUD_VALUE}:`)) {
    // 順序不能反：main 拿 translateProviderId 當基準驗證 translateModelId，
    // 先寫 model 會被對著舊供應商的清單收斂掉（跟聊天那組一樣的坑）
    const [, providerId, ...rest] = value.split(':')
    await electronAPI.store.set('translator', 'cloud')
    await electronAPI.store.set('translateProviderId', providerId)
    await electronAPI.store.set('translateModelId', rest.join(':'))
    return
  }
  if (value === CLOUD_VALUE) {
    await electronAPI.store.set('translator', 'cloud')
    return
  }
  await electronAPI.store.set('translator', 'local')
  await electronAPI.store.set('localTranslateModel', value.slice('local:'.length))
}

/**
 * 選到還沒裝好的東西時給一句可行動的提示（不擋，等真的要跑才會失敗）
 * @param {HTMLSelectElement | null} select
 * @param {{ value: string, ready: boolean }[]} options
 * @returns {string} 給提示列用的文字（空字串＝沒問題）
 */
export function readinessHint(select, options) {
  const chosen = options.find((o) => o.value === select?.value)
  if (!chosen || chosen.ready) return ''
  return chosen.value.startsWith(CLOUD_VALUE)
    ? '供應商未設好，請到設定 → 雲端模型補上。'
    : '模型未安裝，請到設定 → 本地模型下載。'
}

/**
 * @param {string} message
 */
export function warnNotReady(message) {
  if (message) showToast(message, 'error')
}
