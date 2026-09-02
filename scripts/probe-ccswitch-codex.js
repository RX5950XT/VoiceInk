'use strict'

/**
 * ChatGPT Codex 後端的 Responses 端點到底吃哪些參數。**動 `convert.forCodexBackend`
 * 或 `models-scan.probeBody` 之前先跑這支。**
 *
 * 它跟公版 OpenAI Responses 不一樣，而且只回一行 `{"detail":"..."}`，
 * 經過閘道之後全部收斂成同一句「上游回應失敗（HTTP 400）」——所以只有直接打才看得出來。
 *
 * 2026-09-03 實測（gpt-5.6-sol）：
 *   200  基準（store:false）
 *   400  +max_output_tokens   Unsupported parameter
 *   400  +temperature         Unsupported parameter
 *   200  +reasoning / +tools / +parallel_tool_calls / +include
 *   400  模型名帶 [1m]         model is not supported
 *
 * 要有已登入的 Codex CLI 憑證（`~/.codex/auth.json`）。
 *
 *     node scripts/probe-ccswitch-codex.js
 */

const path = require('path')

const gateway = path.join(__dirname, '..', 'src', 'main', 'ccswitch', 'gateway')
const convert = require(path.join(gateway, 'convert.js'))
const credential = require(path.join(gateway, 'credential.js'))

const URL_ = 'https://chatgpt.com/backend-api/codex/responses'
const MODEL = 'gpt-5.6-sol'

/** 公版 Responses 會長的樣子（`convert.toResponsesRequest` 的產物） */
const VANILLA = {
  model: MODEL,
  input: [{ role: 'user', content: [{ type: 'input_text', text: 'say hi in 3 words' }] }],
  stream: true,
  instructions: 'You are a helpful assistant.',
  max_output_tokens: 64,
  temperature: 0.5
}

/** 每一格是「在 Codex 專用形狀上再加這些」，用來確認哪一個參數才是地雷 */
const CASES = [
  ['公版（沒過 forCodexBackend）', VANILLA, true],
  ['forCodexBackend 之後', {}, false],
  ['+max_output_tokens', { max_output_tokens: 64 }, false],
  ['+temperature', { temperature: 0.5 }, false],
  ['+reasoning', { reasoning: { effort: 'medium' } }, false],
  ['+tools', {
    tools: [{ type: 'function', name: 'ping', description: 'p', parameters: { type: 'object', properties: {} } }],
    tool_choice: 'auto'
  }, false],
  ['模型名帶 [1m]', { model: `${MODEL}[1m]` }, false]
]

/**
 * @param {{ token: string, accountId: string }} auth
 * @param {object} body
 * @returns {Promise<{ status: number, note: string }>}
 */
async function send(auth, body) {
  const response = await fetch(URL_, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${auth.token}`,
      'chatgpt-account-id': auth.accountId || '',
      originator: 'codex_cli_rs',
      'OpenAI-Beta': 'responses=experimental'
    },
    body: JSON.stringify(body)
  })
  const text = await response.text()
  if (response.ok) {
    return { status: response.status, note: /response\.completed/.test(text) ? '整串跑完' : '有回應但沒收完' }
  }
  // 這是實測工具，上游的錯誤字串就是我們要看的東西（不會進 App 的 UI／IPC）
  return { status: response.status, note: text.slice(0, 160).replace(/\s+/g, ' ') }
}

async function main() {
  let auth
  try {
    auth = await credential.acquire('codex', {})
  } catch (error) {
    console.error('取不到 Codex 憑證，先跑一次 `codex login`：', error?.code || error?.message || error)
    process.exitCode = 1
    return
  }

  let bad = 0
  for (const [name, extra, raw] of CASES) {
    const body = raw ? { ...extra } : { ...convert.forCodexBackend(VANILLA), ...extra }
    const { status, note } = await send(auth, body)
    // 公版與「明知會壞」那兩格本來就該 400；其餘 200 才算過
    const expectOk = !raw && !('max_output_tokens' in extra) && !('temperature' in extra) && !('model' in extra)
    const pass = expectOk ? status === 200 : status !== 200
    if (!pass) bad++
    console.log(`${pass ? 'OK  ' : 'BAD '} ${String(status).padEnd(4)} ${name.padEnd(28)} ${note}`)
  }

  console.log(bad ? `\n${bad} 格跟上次實測不一樣，上游規則變了` : '\n跟上次實測一致')
  process.exitCode = bad ? 1 : 0
}

main().catch((error) => {
  console.error('探測失敗：', error?.message || error)
  process.exitCode = 1
})
