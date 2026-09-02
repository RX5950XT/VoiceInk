'use strict'

const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { app } = require('electron')

const PROVIDERS = ['claude-code', 'codex', 'antigravity', 'opencode-go', 'grok', 'ollama', 'commandcode']
const WINDOW_KINDS = new Set(['rolling-5h', 'weekly', 'monthly'])
// OpenCode Go 要有訂閱才拿得到額度（沒訂閱時官方端點回 403 EntitlementError），
// Command Code 要跑過 `cmd login` 才有金鑰。這台機器有沒有那兩樣不是程式的事，
// 所以這兩家的「未連線」另外判。
const OPTIONAL_PROVIDERS = new Set(['opencode-go', 'commandcode'])

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) } catch { return null }
}

async function collectSecrets(homeDir, antigravity) {
  const secrets = []
  const claude = readJson(path.join(homeDir, '.claude', '.credentials.json'))
  const codex = readJson(path.join(homeDir, '.codex', 'auth.json'))
  const grokRoot = process.env.GROK_HOME && path.isAbsolute(process.env.GROK_HOME)
    ? process.env.GROK_HOME
    : path.join(homeDir, '.grok')
  const grok = readJson(path.join(grokRoot, 'auth.json'))
  const add = (value) => {
    if (typeof value === 'string' && value.length >= 8) secrets.push(value)
  }
  add(claude?.claudeAiOauth?.accessToken)
  add(codex?.tokens?.access_token)
  for (const entry of Object.values(grok || {})) add(entry?.key)
  const credential = antigravity.parseCredential(await antigravity.readAntigravityCredential() || '')
  add(credential?.accessToken)
  add(credential?.refreshToken)
  // OpenCode CLI 的 auth.json 同時裝著 OpenCode Go 與 Ollama Cloud 的 API 金鑰
  const openCodeAuth = readJson(path.join(homeDir, '.local', 'share', 'opencode', 'auth.json'))
  for (const entry of Object.values(openCodeAuth || {})) add(entry?.key)
  add(readJson(path.join(homeDir, '.commandcode', 'auth.json'))?.apiKey)
  add(process.env.OPENCODE_API_KEY)
  add(process.env.OLLAMA_API_KEY)
  add(process.env.COMMAND_CODE_API_KEY)
  return secrets
}

async function main() {
  const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-usage-e2e-'))
  app.setPath('userData', tempUserData)
  try {
    await app.whenReady()
    const usage = require('../src/main/usage')
    const antigravity = require('../src/main/usage/antigravity')
    const homeDir = process.env.USERPROFILE || process.env.HOME
    const secrets = await collectSecrets(homeDir, antigravity)
    const state = await usage.sync()

    assert.deepEqual(state.accounts.map((account) => account.provider).sort(), [...PROVIDERS].sort())
    assert.equal(new Set(state.accounts.map((account) => account.provider)).size, PROVIDERS.length)
    for (const account of state.accounts) {
      if (!OPTIONAL_PROVIDERS.has(account.provider)) {
        assert.notEqual(account.status, 'disconnected', `${account.provider}: ${account.notes}`)
      }
      for (const window of account.windows) {
        assert.ok(Number.isFinite(window.used), `${account.provider}/${window.id}: used`)
        assert.ok(Number.isFinite(window.limit) && window.limit > 0, `${account.provider}/${window.id}: limit`)
        assert.ok(WINDOW_KINDS.has(window.kind), `${account.provider}/${window.id}: kind`)
      }
    }

    // 有訂閱就一定是官方三窗；沒訂閱只能是「明講原因的未連線」——
    // 不可以出現「連上了但空空如也」這種看不出發生什麼事的中間態。
    const openCode = state.accounts.find((account) => account.provider === 'opencode-go')
    if (openCode.status === 'disconnected') {
      assert.ok(openCode.notes.trim(), 'opencode-go 未連線時必須說明原因')
      console.log(`SKIP opencode-go: ${openCode.notes}`)
    } else {
      assert.equal(openCode.windows.length, 3, openCode.notes)
      assert.equal(openCode.accuracy, 'official', openCode.notes)
    }

    // Ollama 的 monthly 視窗上游不給重置時間，這裡順便守住「不要自己編一個」
    const ollama = state.accounts.find((account) => account.provider === 'ollama')
    if (ollama.windows.length) {
      assert.equal(ollama.windows.length, 1, ollama.notes)
      assert.ok(ollama.windows.every((window) => window.resetAt === ''), 'ollama 不該有捏造的重置時間')
    }

    // Command Code 的月額度來自訂閱週期；尚未使用的 5 小時滾動視窗沒有 resetAt 是正常的。
    const commandCode = state.accounts.find((account) => account.provider === 'commandcode')
    if (commandCode.status === 'disconnected') {
      assert.ok(commandCode.notes.trim(), 'commandcode 未連線時必須說明原因')
      console.log(`SKIP commandcode: ${commandCode.notes}`)
    } else if (commandCode.windows.length) {
      assert.equal(commandCode.windows.length, 3, commandCode.notes)
      assert.equal(commandCode.accuracy, 'official', commandCode.notes)
      assert.ok(commandCode.windows
        .filter((window) => window.kind !== 'rolling-5h')
        .every((window) => window.resetAt), 'commandcode weekly/monthly 應該帶重置時間')
      const fiveHour = commandCode.windows.find((window) => window.kind === 'rolling-5h')
      assert.ok(fiveHour.used === 0 ? !fiveHour.resetAt : fiveHour.resetAt, 'commandcode 5h resetAt 狀態不一致')
    }

    const serialized = JSON.stringify({ state, diagnostics: await usage.getDiagnostics() })
    for (const secret of secrets) {
      assert.ok(!serialized.includes(secret), 'credential leaked into usage state or diagnostics')
    }

    for (const account of state.accounts) {
      const windows = account.windows.map((window) => (
        `${window.id}=${Math.round(window.used / window.limit * 100)}%/${window.resetAt ? 'reset' : 'no-reset'}`
      )).join(', ') || 'no windows'
      console.log(`PASS ${account.provider}: ${account.status}; ${windows}`)
    }
    console.log('PASS credentials absent from state and diagnostics')
    console.log(`\n${PROVIDERS.length + 1}/${PROVIDERS.length + 1} passed`)
  } finally {
    fs.rmSync(tempUserData, { recursive: true, force: true })
    app.quit()
  }
}

main().catch((error) => {
  console.error('FAIL usage integration:', error?.stack || error)
  process.exitCode = 1
  app.quit()
})
