/**
 * VoiceInk - 使用現場的模型選單（語音轉文字頁／翻譯頁共用）
 *
 * 設定頁只管「裝了什麼、怎麼推論」；「這次要用哪一顆」在做事的頁面上直接選。
 * 選單是既有 store key 的扁平視圖，沒有第三份狀態：
 *   ASR  → `asrEngine`(local|cloud) ＋ `asrModelKey`
 *   翻譯 → `translator`(local|cloud) ＋ `localTranslateModel`
 *          ／雲端時再加 `translateProviderId` ＋ `translateModelId`
 * 選了立刻寫回（跟主題一樣即時套用），不必按儲存。
 *
 * 雲端翻譯的模型直接列聊天供應商清單裡的每一顆——兩邊都是 OpenAI 相容的
 * chat completions，沒必要讓使用者把同一組網址金鑰填兩次。
 */

import { electronAPI, showToast } from './app.js'

/** 選項值編碼：本地 `local:<模型 key>`；ASR 雲端 `cloud`；翻譯雲端 `cloud:<供應商 id>:<模型 id>` */
const CLOUD_VALUE = 'cloud'

/** 本地 ASR 模型顯示順序（與 main models.js 的 ASR_MODEL_KEYS 一致） */
const ASR_KEYS = ['qwen3asr', 'qwen3asrgpu']
/** 本地翻譯模型顯示順序（與 main models.js 的 LLM_MODEL_KEYS 一致） */
const LLM_KEYS = ['linguaforge08q4', 'qwen35translate', 'qwen354b']

/**
 * @param {Record<string, { label?: string, downloaded?: boolean, requires?: string|null }>} modelsMap
 * @param {string[]} keys
 * @param {string | null} cloudLabel null＝不加通用雲端項（翻譯改為逐一列出供應商的模型）
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
 * @param {Record<string, { label?: string, downloaded?: boolean, requires?: string|null }>} modelsMap
 * @param {{ asrModelId?: string }} settings
 */
export function asrOptions(modelsMap, settings) {
  return buildOptions(modelsMap, ASR_KEYS, settings?.asrModelId || '未設定模型 ID')
}

/**
 * 本地三顆 ＋ 雲端供應商清單裡的每一顆
 * @param {Record<string, { label?: string, downloaded?: boolean, requires?: string|null }>} modelsMap
 * @param {{ chatProviders?: Array<{ id: string, name?: string, apiUrl?: string, apiKey?: string, models?: string[] }> }} settings
 */
export function translateOptions(modelsMap, settings) {
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
  return options
}

/**
 * 目前選中的雲端翻譯供應商與模型（`translateProviderId` 失效時退回第一組）
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
 * 目前設定對應到哪一個選項值
 * @param {{ asrEngine?: string, asrModelKey?: string }} settings
 */
export function currentAsrValue(settings) {
  return settings?.asrEngine === 'cloud' ? CLOUD_VALUE : `local:${settings?.asrModelKey || 'qwen3asr'}`
}

/**
 * @param {{ translator?: string, localTranslateModel?: string }} settings
 */
export function currentTranslateValue(settings) {
  if (settings?.translator !== 'cloud') return `local:${settings?.localTranslateModel || 'linguaforge08q4'}`
  const { provider, modelId } = resolveCloudTranslate(settings)
  return provider && modelId ? `${CLOUD_VALUE}:${provider.id}:${modelId}` : CLOUD_VALUE
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
 * @param {string} value
 * @returns {Promise<void>}
 */
export async function applyAsrChoice(value) {
  if (value === CLOUD_VALUE) {
    await electronAPI.store.set('asrEngine', 'cloud')
    return
  }
  await electronAPI.store.set('asrEngine', 'local')
  await electronAPI.store.set('asrModelKey', value.slice('local:'.length))
}

/**
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
    ? '這個雲端供應商還沒設好，請到設定 → 雲端模型補上 API URL 與 Key。'
    : '這顆模型還沒安裝，請到設定 → 本地模型下載後再使用。'
}

/**
 * @param {string} message
 */
export function warnNotReady(message) {
  if (message) showToast(message, 'error')
}
