'use strict'

/**
 * OpenCode Go／Ollama Cloud／Command Code 額度端點的實流量探測。
 *
 * 四支都是第一方但**沒寫進文件**的路由，公開整理的清單抄錯過（見 CLAUDE.md 的
 * 「端點一律探測過才寫進表」）。動 `usage/constants.js` 的 `ENDPOINTS.opencodeGo`／
 * `ENDPOINTS.ollama`／`ENDPOINTS.commandcode*`、或動這些解析之前，先跑這支。
 *
 *   node scripts/probe-usage-endpoints.js
 *
 * 金鑰解析跟正式路徑同一支（`usage/api-key.js`）：環境變數 → OpenCode auth.json → CC 代理 store。
 * 輸出**不印金鑰、不印上游 body 的原文**，只印形狀摘要（跟錯誤衛生同一條規矩）。
 */

const path = require('path')

process.env.ELECTRON_RUN_AS_NODE = process.env.ELECTRON_RUN_AS_NODE || '1'

const { ENDPOINTS } = require(path.join(__dirname, '..', 'src', 'main', 'usage', 'constants'))
const { resolveApiKey } = require(path.join(__dirname, '..', 'src', 'main', 'usage', 'api-key'))
const { applyOllamaUsage } = require(path.join(__dirname, '..', 'src', 'main', 'usage', 'ollama'))
const { applyOpenCodeUsage } = require(path.join(__dirname, '..', 'src', 'main', 'usage', 'opencode'))
const { applyCommandCodeUsage } = require(path.join(__dirname, '..', 'src', 'main', 'usage', 'commandcode'))
const { resolveCommandCodeKey } = require(path.join(__dirname, '..', 'src', 'main', 'usage', 'api-key'))

const homeDir = process.env.USERPROFILE || process.env.HOME || ''

/** 只描述形狀，不把上游字串印出來。 */
function shapeOf(value, depth = 0) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `array(${value.length})`
  if (typeof value !== 'object') return typeof value === 'number' ? `number(${value})` : typeof value
  if (depth >= 2) return 'object'
  return `{ ${Object.entries(value).map(([k, v]) => `${k}: ${shapeOf(v, depth + 1)}`).join(', ')} }`
}

async function probe(name, url, apply, resolve, where, loadExtraArgs = async () => []) {
  const { key, source } = await resolve()
  if (!key) {
    console.log(`[${name}] SKIP 找不到金鑰（${where}）`)
    return
  }
  console.log(`[${name}] key source=${source}`)
  let response
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }
    })
  } catch (error) {
    console.log(`[${name}] FAIL 連不上（${error?.name || 'unknown'}）`)
    return
  }
  console.log(`[${name}] HTTP ${response.status}`)
  let payload
  try {
    payload = await response.json()
  } catch {
    console.log(`[${name}] 回應不是 JSON`)
    return
  }
  if (!response.ok) {
    // 錯誤型別（EntitlementError 之類）是我們要分辨 401／403 的依據，型別名可以印；
    // message 是上游可控字串，只印長度。
    const type = payload?.error?.type
    console.log(`[${name}] error.type=${typeof type === 'string' ? type : '(none)'} messageLen=${String(payload?.error?.message || '').length}`)
    return
  }
  console.log(`[${name}] shape ${shapeOf(payload)}`)
  const account = apply(payload, Date.now(), ...(await loadExtraArgs(key)))
  console.log(`[${name}] → status=${account.status} accuracy=${account.accuracy} windows=${JSON.stringify(
    account.windows.map((w) => [w.id, w.used, w.limit, w.resetAt || '(no reset)'])
  )}`)
}

/**
 * Command Code 月額度的訂閱週期資料。
 * @param {string} key
 * @returns {Promise<unknown[]>}
 */
async function readCommandCodeSubscription(key) {
  let response
  try {
    response = await fetch(ENDPOINTS.commandcodeSubscriptions, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }
    })
  } catch (error) {
    console.log(`[commandcode-subscriptions] FAIL 連不上（${error?.name || 'unknown'}）`)
    return [null]
  }
  console.log(`[commandcode-subscriptions] HTTP ${response.status}`)
  if (!response.ok) return [null]
  try {
    const payload = await response.json()
    console.log(`[commandcode-subscriptions] shape ${shapeOf(payload)}`)
    return [payload]
  } catch {
    console.log('[commandcode-subscriptions] 回應不是 JSON')
    return [null]
  }
}

async function main() {
  if (!homeDir) {
    console.log('FAIL 找不到 home 目錄')
    process.exitCode = 1
    return
  }
  const viaOpenCode = (envVar, serviceId, presetId) => ({
    resolve: () => resolveApiKey({ homeDir, envVar, serviceId, presetId }),
    where: `${envVar} / auth.json:${serviceId} / ccswitch:${presetId}`
  })
  const openCode = viaOpenCode('OPENCODE_API_KEY', 'opencode-go', 'opencode-go')
  const ollama = viaOpenCode('OLLAMA_API_KEY', 'ollama-cloud', 'ollama-cloud')
  await probe('opencode-go', ENDPOINTS.opencodeGo, applyOpenCodeUsage, openCode.resolve, openCode.where)
  await probe('ollama', ENDPOINTS.ollama, applyOllamaUsage, ollama.resolve, ollama.where)
  await probe(
    'commandcode',
    ENDPOINTS.commandcode,
    applyCommandCodeUsage,
    () => resolveCommandCodeKey({ homeDir }),
    'COMMAND_CODE_API_KEY / ~/.commandcode/auth.json',
    readCommandCodeSubscription
  )
}

main().catch((error) => {
  console.log(`FAIL ${error?.name || 'unknown'}`)
  process.exitCode = 1
})
