'use strict'

/**
 * 探測 `presets.js` 裡每一家的端點到底在不在。**加新的一家之前先跑這支。**
 *
 * 做法：依預設 `apiFormat` 不帶真金鑰 POST 該格式的端點。
 * - 400／401／403／422／429 ＝端點真的在，只是請求或憑證不合 → 合格
 * - 404 ＝網址或格式路徑是錯的
 * - 逾時／DNS 失敗 ＝ 這裡看不出來，可能是地區封鎖，要人自己判斷
 *
 * `custom` 與官方訂閱跳過；其餘六家依各自預設上游格式驗，避免拿 Anthropic
 * 路徑去測 OpenAI 端點。
 *
 *     node scripts/probe-ccswitch-endpoints.js
 */

const path = require('path')

const presets = require(path.join(__dirname, '..', 'src', 'main', 'ccswitch', 'presets.js'))

const TIMEOUT_MS = 15_000
/** 這幾個狀態碼代表「端點在，只是沒給對金鑰」 */
const REACHABLE = new Set([400, 401, 403, 422, 429])

/** @param {string} format @returns {string} */
function pathFor(format) {
  return format === 'anthropic' ? '/messages' : format === 'openai_chat' ? '/chat/completions' : '/responses'
}

/** @param {string} format @returns {object} */
function bodyFor(format) {
  return format === 'openai_responses'
    ? { model: 'probe', input: 'hi', max_output_tokens: 1 }
    : { model: 'probe', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }
}

/**
 * @param {object} preset
 * @returns {Promise<{ status: number, note: string, url: string }>}
 */
async function probe(preset) {
  const format = preset.apiFormat
  const baseUrl = String(preset.wireBaseUrl || preset.baseUrl).replace(/\/+$/, '')
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json'
  }
  if (format === 'anthropic') headers['anthropic-version'] = '2023-06-01'
  if (preset.auth === 'cli' || preset.keyField === 'ANTHROPIC_AUTH_TOKEN') headers.authorization = 'Bearer probe'
  else headers['x-api-key'] = 'probe'
  if (preset.id === 'grok-build') headers['x-grok-client-version'] = '1.0.13'
  if (preset.id === 'codex') {
    headers['chatgpt-account-id'] = 'probe'
    headers.originator = 'codex_cli_rs'
  }
  const url = `${baseUrl}${pathFor(format)}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyFor(format)),
      signal: controller.signal
    })
    // 只取固定型別當佐證，不印整包 body（可能夾帶上游的東西）
    let note = ''
    try {
      const data = await response.json()
      note = String(data?.error?.type || data?.type || '').slice(0, 40)
    } catch {
      note = ''
    }
    return { status: response.status, note, url }
  } catch (error) {
    return { status: 0, note: error?.name === 'AbortError' ? '逾時' : '連不上', url }
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  const targets = presets.PRESETS.filter((preset) => preset.id !== 'custom' && preset.auth !== 'none')
  console.log(`探測 ${targets.length} 個內建端點（依預設上游格式；404 = 網址或格式錯）\n`)

  let bad = 0
  for (const preset of targets) {
    const { status, note, url } = await probe(preset)
    const verdict = REACHABLE.has(status) ? 'OK  ' : status === 0 ? '?? ' : 'BAD '
    if (!REACHABLE.has(status) && status !== 0) bad++
    console.log(`${verdict} ${String(status).padEnd(4)} ${preset.id.padEnd(15)} ${url}${note ? `  (${note})` : ''}`)
  }

  // 本機 Ollama 沒開的話一定連不上，那是正常的，不算失敗
  console.log(`\n${bad} 個端點回了非預期狀態碼。連不上（??）要自己判斷是地區封鎖還是服務沒開。`)
  process.exitCode = bad ? 1 : 0
}

main().catch((error) => {
  console.error('探測失敗：', error?.message || error)
  process.exitCode = 1
})
