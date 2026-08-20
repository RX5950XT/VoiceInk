'use strict'

const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { app } = require('electron')

const PROVIDERS = ['claude-code', 'codex', 'antigravity', 'opencode-go', 'grok']
const WINDOW_KINDS = new Set(['rolling-5h', 'weekly', 'monthly'])

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
    assert.equal(new Set(state.accounts.map((account) => account.provider)).size, 5)
    for (const account of state.accounts) {
      assert.notEqual(account.status, 'disconnected', `${account.provider}: ${account.notes}`)
      for (const window of account.windows) {
        assert.ok(Number.isFinite(window.used), `${account.provider}/${window.id}: used`)
        assert.ok(Number.isFinite(window.limit) && window.limit > 0, `${account.provider}/${window.id}: limit`)
        assert.ok(WINDOW_KINDS.has(window.kind), `${account.provider}/${window.id}: kind`)
      }
    }

    const openCode = state.accounts.find((account) => account.provider === 'opencode-go')
    assert.equal(openCode.windows.length, 3, openCode.notes)
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
    console.log('\n6/6 passed')
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
