#!/usr/bin/env node
/**
 * 探針：Claude Code 的 OAuth 續期打真上游（`node scripts/probe-claude-refresh.js [--force]`）
 *
 * **會動你真的 `~/.claude/.credentials.json`**（跟 Claude Code 自己續期一樣：同一組鎖、CAS 寫回）。
 * 不帶 `--force` 時只在 token 快過期才續；帶了就立刻續一次，用來驗證端點與 body 形狀還對不對。
 *
 *  [A] 續完檔案還是合法 JSON、其他欄位（mcpOAuth…）都在
 *  [B] 新的 access token 打得通額度 API（Anthropic OAuth usage）
 *  [C] `claude auth status` 仍是登入狀態（CLI 看得懂我們寫回去的東西）
 *
 * 只印到期時間與結果，不印任何 token。
 */

'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { ensureFreshToken } = require('../src/main/usage/claude-auth')
const { fetchJson } = require('../src/main/usage/shared')
const { ENDPOINTS } = require('../src/main/usage/constants')

const home = os.homedir()
const file = path.join(home, '.claude', '.credentials.json')
const force = process.argv.includes('--force')

const read = () => JSON.parse(fs.readFileSync(file, 'utf8'))
const keysOf = (data) => Object.keys(data).sort().join(',')

;(async () => {
  let failed = 0
  const ok = (name, pass, detail = '') => {
    if (!pass) failed++
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  }
  const before = read()
  const oldExpiry = before.claudeAiOauth?.expiresAt
  console.log(`到期時間（前）：${new Date(oldExpiry).toISOString()}　force=${force}`)

  const { token } = await ensureFreshToken(home, { force, log: (m) => console.log(`  ${m}`) })
  const after = read()
  const newExpiry = after.claudeAiOauth?.expiresAt
  console.log(`到期時間（後）：${new Date(newExpiry).toISOString()}`)
  ok('[A] 檔案仍是合法 JSON、頂層欄位一樣', keysOf(after) === keysOf(before), keysOf(after))
  if (force) ok('[A] 真的續了（到期時間往後）', newExpiry > oldExpiry)
  ok('[A] 拿到的 token 就是檔案裡那顆', token === after.claudeAiOauth?.accessToken)

  try {
    const usage = await fetchJson(ENDPOINTS.claude, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' }
    })
    ok('[B] 新 token 打得通額度 API', Boolean(usage.five_hour || usage.seven_day))
  } catch (error) {
    ok('[B] 新 token 打得通額度 API', false, error.status ? `HTTP ${error.status}` : error.code)
  }

  try {
    const status = JSON.parse(execFileSync('claude', ['auth', 'status', '--json'], { encoding: 'utf8', shell: true }))
    ok('[C] claude auth status 仍是登入', status.loggedIn === true)
  } catch (error) {
    ok('[C] claude auth status 仍是登入', false, error.message.slice(0, 120))
  }
  process.exit(failed ? 1 : 0)
})().catch((error) => {
  console.error(error.code || error.message)
  process.exit(1)
})
