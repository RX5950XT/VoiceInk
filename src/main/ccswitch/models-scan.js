'use strict'

/**
 * Claude Code 供應商的模型清單掃描（Main Process）。
 *
 * URL 與憑證全在 main 這邊決定（跟 `chat:scanModels` 同一條規矩）：內建各家用
 * `presets.js` 實測過的 `modelsUrl`；`custom` 由使用者填的 baseUrl 與協議推導。
 * 錯誤只回我們自己寫的固定訊息——上游 body 一律不透傳（可能回填金鑰）。
 */

const presets = require('./presets')
const { fetchModels } = require('../chat-models')

const API_FORMATS = new Set(['anthropic', 'openai_chat', 'openai_responses'])
const TEST_TIMEOUT_MS = 15_000
const GROK_CLI_VERSION = '1.0.13'

/** @type {{ acquire: Function | null }} 測試注入的憑證取得函式 */
const deps = { acquire: null }

/**
 * @param {{ acquire?: Function }} [options]
 */
function configure(options = {}) {
  if (typeof options?.acquire === 'function') deps.acquire = options.acquire
}

/**
 * @returns {Function}
 */
function acquireFn() {
  return deps.acquire || require('./gateway/credential').acquire
}

/**
 * 這一筆要打哪個 models 端點、帶什麼鑑別。
 * 回 null＝這家不支援掃描（UI 要把掃描按鈕收掉）。
 *
 * @param {{ presetId?: string, apiFormat?: string, baseUrl?: string }} provider
 * @returns {{ url: string, auth: 'bearer' | 'x-api-key' | 'cli' | 'none', codex: boolean } | null}
 */
function resolveScanTarget(provider) {
  const preset = presets.getPreset(provider?.presetId)
  if (!preset) return null
  if (preset.id !== 'custom') {
    if (!preset.modelsUrl) return null
    return { url: preset.modelsUrl, auth: preset.modelsAuth || 'bearer', codex: preset.id === 'codex' }
  }
  // custom：anthropic 形狀的模型清單在 /v1/models，OpenAI 形狀在 /models
  const base = String(provider?.baseUrl || '').replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(base)) return null
  if (provider.apiFormat === 'openai_chat' || provider.apiFormat === 'openai_responses') {
    return { url: `${base}/models`, auth: 'bearer', codex: false }
  }
  return { url: `${base}/v1/models`, auth: 'x-api-key', codex: false }
}

/**
 * 依使用者選的驗證格式建立最小測試端點。端點仍只來自 main 的 preset 或已存 custom URL。
 * @param {{ presetId?: string, validationFormat?: string, apiFormat?: string, baseUrl?: string }} provider
 * @returns {{ url: string, format: string, auth: string, authField: string, codex: boolean } | null}
 */
function resolveProbeTarget(provider) {
  const preset = presets.getPreset(provider?.presetId)
  if (!preset || preset.auth === 'none') return null
  const format = API_FORMATS.has(String(provider?.validationFormat || ''))
    ? String(provider.validationFormat)
    : (preset.validationFormat || preset.apiFormat)
  const base = preset.id === 'custom'
    ? String(provider?.baseUrl || '').trim().replace(/\/+$/, '')
    : String(preset.wireBaseUrl || preset.baseUrl || '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(base)) return null
  const path = format === 'anthropic'
    ? (preset.id === 'custom' ? '/v1/messages' : '/messages')
    : (format === 'openai_chat' ? '/chat/completions' : '/responses')
  return {
    url: `${base}${path}`,
    format,
    auth: preset.auth,
    authField: String(provider?.authField || preset.keyField || ''),
    codex: preset.id === 'codex'
  }
}

/**
 * @param {string} format
 * @param {string} model
 * @returns {object}
 */
function probeBody(format, model) {
  if (format === 'anthropic') {
    return {
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
      stream: false
    }
  }
  if (format === 'openai_chat') {
    return {
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
      stream: false
    }
  }
  return { model, input: 'ping', max_output_tokens: 1, stream: false }
}

/**
 * 用一個最小請求確認端點有沒有回 HTTP；不讀 response body，避免把上游內容帶出 main。
 * @param {{ presetId: string, validationFormat?: string, apiFormat?: string, baseUrl?: string, apiKey?: string, authField?: string, oauthAccountId?: string, model?: string, sonnetModel?: string, haikuModel?: string, opusModel?: string }} provider
 * @param {{ fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{ ok: boolean, responded: boolean, status?: number, code: string, error?: string, format?: string, url?: string, latencyMs?: number }>}
 */
async function testProvider(provider, options = {}) {
  const target = resolveProbeTarget(provider)
  if (!target) return { ok: false, responded: false, code: 'UNSUPPORTED', error: '這家沒有可測試的上游端點' }

  const preset = presets.getPreset(provider?.presetId)
  const model = String(
    provider?.model || provider?.sonnetModel || provider?.haikuModel || provider?.opusModel ||
    preset?.env?.ANTHROPIC_MODEL || ''
  ).trim()
  if (!model) return { ok: false, responded: false, code: 'MISSING_MODEL', error: '請先填一個模型再測試' }

  /** @type {Record<string, string>} */
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' }
  if (target.format === 'anthropic') headers['anthropic-version'] = '2023-06-01'
  if (target.auth === 'cli') {
    try {
      const { token, accountId } = await acquireFn()(provider.presetId, {
        oauthAccountId: String(provider?.oauthAccountId || '')
      })
      headers.Authorization = `Bearer ${token}`
      if (target.codex) {
        headers['chatgpt-account-id'] = accountId || ''
        headers.originator = 'codex_cli_rs'
      } else {
        headers['x-grok-client-version'] = GROK_CLI_VERSION
      }
    } catch (error) {
      return { ok: false, responded: false, code: error?.code || 'NO_CREDENTIAL', error: error?.userMessage || '取不到登入憑證' }
    }
  } else {
    const key = String(provider?.apiKey || '').trim()
    if (!key) return { ok: false, responded: false, code: 'MISSING_API_KEY', error: '請先填 API 金鑰再測試' }
    if (target.authField === 'ANTHROPIC_API_KEY') headers['x-api-key'] = key
    else headers.Authorization = `Bearer ${key}`
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS)
  const startedAt = Date.now()
  try {
    const response = await (options.fetchImpl || globalThis.fetch)(target.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(probeBody(target.format, model)),
      signal: controller.signal
    })
    const status = Number(response?.status) || 0
    try {
      await response?.body?.cancel?.()
    } catch {
      // 回應已經關閉
    }
    const result = {
      ok: Boolean(response?.ok),
      responded: status > 0,
      status,
      code: `HTTP_${status}`,
      format: target.format,
      url: target.url,
      latencyMs: Date.now() - startedAt
    }
    if (!result.ok) {
      result.error = status === 401 || status === 403
        ? `上游有回應，但驗證失敗（HTTP ${status}）`
        : status === 404
          ? `上游有回應，但 URL 或驗證格式不符（HTTP ${status}）`
          : `上游有回應（HTTP ${status}）`
    }
    return result
  } catch (error) {
    return {
      ok: false,
      responded: false,
      code: error?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK',
      error: error?.name === 'AbortError' ? '測試逾時' : '無法連線到上游',
      format: target.format,
      url: target.url,
      latencyMs: Date.now() - startedAt
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * `fetchImpl` 只給測試換掉網路層（跟 `chat-models.fetchModels` 同一個注入點）。
 *
 * @param {{ presetId: string, apiFormat?: string, baseUrl?: string, apiKey?: string, oauthAccountId?: string }} provider 完整實例
 * @param {{ fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{ ok: true, models: string[] } | { ok: false, code: string, error: string }>}
 */
async function scanProviderModels(provider, options = {}) {
  const target = resolveScanTarget(provider)
  if (!target) return { ok: false, code: 'UNSUPPORTED', error: '這家不支援自動掃描模型' }

  /** @type {Record<string, string>} */
  const headers = {}
  let apiKey = ''
  if (target.auth === 'x-api-key') {
    const key = String(provider?.apiKey || '').trim()
    if (key) headers['x-api-key'] = key
  } else if (target.auth === 'bearer') {
    apiKey = String(provider?.apiKey || '').trim()
  } else if (target.auth === 'cli') {
    try {
      const { token, accountId } = await acquireFn()(provider.presetId, {
        oauthAccountId: String(provider?.oauthAccountId || '')
      })
      headers.authorization = `Bearer ${token}`
      if (target.codex) {
        headers['chatgpt-account-id'] = accountId || ''
        headers.originator = 'codex_cli_rs'
      }
    } catch (error) {
      return { ok: false, code: error?.code || 'NO_CREDENTIAL', error: error?.userMessage || '取不到登入憑證' }
    }
  }

  const result = await fetchModels({ url: target.url, apiKey, headers, fetchImpl: options.fetchImpl })
  // cli 那兩家沒有「API Key」，401／403 只會是登入或額度的問題，提示不能照搬金鑰那套
  if (!result.ok && target.auth === 'cli' && /^HTTP_(401|403)$/.test(result.code)) {
    return { ok: false, code: result.code, error: '上游拒絕了登入憑證（可能需要重新登入，或訂閱額度用完）' }
  }
  return result
}

module.exports = { configure, resolveScanTarget, resolveProbeTarget, testProvider, probeBody, scanProviderModels }
