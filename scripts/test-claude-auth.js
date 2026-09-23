#!/usr/bin/env node
/**
 * Claude Code 的 OAuth 續期（`src/main/usage/claude-auth.js`）：`node scripts/test-claude-auth.js`
 *
 * 全部在暫存的假家目錄裡跑，fetch 一律 mock——**不碰使用者真的 `~/.claude`**。
 *
 *  [A] 還沒快過期：一個請求都不送，檔案不動
 *  [B] 快過期：送出 Claude Code 同款的 JSON body，新 token 寫回檔案，其他欄位（mcpOAuth）原樣保留，兩把鎖放掉
 *  [C] 另一個 Claude Code 正抓著鎖、而且它續好了：等它放鎖、直接用它那顆，不再送請求
 *  [D] CAS：送出去之後檔案裡的 refresh token 被別人換掉了 → 不寫回
 *  [E] 前一個人當掉留下的舊鎖（mtime 超過 60 秒）要能接手
 *  [F] 額度 API 回 401（還沒到期卻被撤銷）：強制續一次再打，拿到額度
 */

'use strict'

const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const { tempDir } = require('./lib/test-temp')

const auth = require('../src/main/usage/claude-auth')
const { syncClaude } = require('../src/main/usage/claude')

let passed = 0
let failed = 0
async function test(name, fn) {
  auth._resetForTests()
  try {
    await fn()
    passed++
    console.log(`  PASS ${name}`)
  } catch (error) {
    failed++
    console.log(`  FAIL ${name} — ${error.message}`)
  }
}

function makeHome(oauth) {
  const home = tempDir('claude-auth-')
  fs.mkdirSync(path.join(home, '.claude'))
  write(home, { mcpOAuth: { keep: 'me' }, claudeAiOauth: oauth })
  return home
}
function write(home, data) {
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify(data))
}
function read(home) {
  return JSON.parse(fs.readFileSync(path.join(home, '.claude', '.credentials.json'), 'utf8'))
}
function lockDirs(home) {
  return [path.join(home, '.claude', '.oauth_refresh.lock'), `${fs.realpathSync(path.join(home, '.claude'))}.lock`]
}
const expiring = (extra = {}) => ({
  accessToken: 'old-access',
  refreshToken: 'old-refresh',
  expiresAt: Date.now() + 60_000,
  scopes: ['user:inference', 'user:profile'],
  subscriptionType: 'pro',
  ...extra
})
const okRefresh = (calls, reply = {}) => async (url, options) => {
  calls.push({ url, options })
  return new Response(JSON.stringify({
    access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 28800, ...reply
  }), { status: 200 })
}

;(async () => {
  console.log('\n[claude-auth]')

  await test('[A] 還沒快過期就不續', async () => {
    const home = makeHome(expiring({ expiresAt: Date.now() + 3600_000 }))
    const calls = []
    const got = await auth.ensureFreshToken(home, { fetchImpl: okRefresh(calls) })
    assert.equal(got.token, 'old-access')
    assert.equal(calls.length, 0)
  })

  await test('[B] 快過期：照 Claude Code 的格式續、寫回、保留其他欄位、放鎖', async () => {
    const home = makeHome(expiring())
    const calls = []
    const got = await auth.ensureFreshToken(home, { fetchImpl: okRefresh(calls) })
    assert.equal(got.token, 'new-access')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, auth.TOKEN_URL)
    const body = JSON.parse(calls[0].options.body)
    assert.deepEqual(body, {
      grant_type: 'refresh_token', refresh_token: 'old-refresh',
      client_id: auth.CLIENT_ID, scope: 'user:inference user:profile'
    })
    const disk = read(home)
    assert.equal(disk.claudeAiOauth.accessToken, 'new-access')
    assert.equal(disk.claudeAiOauth.refreshToken, 'new-refresh')
    assert.equal(disk.claudeAiOauth.subscriptionType, 'pro', '沒回的欄位要留著')
    assert.ok(disk.claudeAiOauth.expiresAt > Date.now() + 7 * 3600_000)
    assert.deepEqual(disk.mcpOAuth, { keep: 'me' })
    for (const dir of lockDirs(home)) assert.equal(fs.existsSync(dir), false, `鎖沒放掉：${dir}`)
    const leftovers = fs.readdirSync(path.join(home, '.claude')).filter((name) => name.endsWith('.tmp'))
    assert.deepEqual(leftovers, [])
  })

  await test('[C] 別人抓著鎖且續好了：等它放鎖，用它那顆', async () => {
    const home = makeHome(expiring())
    const [lockA] = lockDirs(home)
    fs.mkdirSync(lockA)
    setTimeout(() => {
      write(home, { mcpOAuth: { keep: 'me' }, claudeAiOauth: expiring({ accessToken: 'cli-access', refreshToken: 'cli-refresh', expiresAt: Date.now() + 8 * 3600_000 }) })
      fs.rmdirSync(lockA)
    }, 600)
    const calls = []
    const got = await auth.ensureFreshToken(home, { fetchImpl: okRefresh(calls) })
    assert.equal(got.token, 'cli-access')
    assert.equal(calls.length, 0, '別人續好了還再送一次＝把它的 refresh token 作廢')
    assert.equal(read(home).claudeAiOauth.refreshToken, 'cli-refresh')
  })

  await test('[D] CAS：送出之後檔案被換掉就不寫回', async () => {
    const home = makeHome(expiring())
    const calls = []
    const fetchImpl = async (url, options) => {
      write(home, { claudeAiOauth: expiring({ accessToken: 'cli-access', refreshToken: 'cli-refresh' }) })
      return okRefresh(calls)(url, options)
    }
    await auth.ensureFreshToken(home, { fetchImpl })
    assert.equal(read(home).claudeAiOauth.refreshToken, 'cli-refresh')
  })

  await test('[E] 超過 60 秒的舊鎖可以接手', async () => {
    const home = makeHome(expiring())
    const [lockA, lockB] = lockDirs(home)
    fs.mkdirSync(lockA)
    fs.mkdirSync(lockB)
    const old = new Date(Date.now() - 2 * auth.LOCK_STALE_MS)
    fs.utimesSync(lockA, old, old)
    fs.utimesSync(lockB, old, old)
    const calls = []
    const got = await auth.ensureFreshToken(home, { fetchImpl: okRefresh(calls) })
    assert.equal(got.token, 'new-access')
    for (const dir of lockDirs(home)) assert.equal(fs.existsSync(dir), false)
  })

  await test('[F] 額度 API 回 401：強制續一次再打', async () => {
    const home = makeHome(expiring({ expiresAt: Date.now() + 3600_000 }))
    const refreshCalls = []
    const tokens = []
    const account = await syncClaude({
      homeDir: home,
      authFetchImpl: okRefresh(refreshCalls),
      fetchImpl: async (url, options) => {
        tokens.push(options.headers.Authorization)
        if (options.headers.Authorization === 'Bearer old-access') return new Response('{}', { status: 401 })
        return new Response(JSON.stringify({ five_hour: { utilization: 10, resets_at: '2026-09-23T10:00:00Z' } }), { status: 200 })
      },
      log: () => {}
    })
    assert.deepEqual(tokens, ['Bearer old-access', 'Bearer new-access'])
    assert.equal(refreshCalls.length, 1)
    assert.equal(account.accuracy, 'official')
    assert.equal(account.windows.length, 1)
  })

  await test('[F2] 過期的憑證在打額度 API 之前就先續', async () => {
    const home = makeHome(expiring({ expiresAt: Date.now() - 3600_000 }))
    const tokens = []
    const account = await syncClaude({
      homeDir: home,
      authFetchImpl: okRefresh([]),
      fetchImpl: async (url, options) => {
        tokens.push(options.headers.Authorization)
        return new Response(JSON.stringify({ five_hour: { utilization: 10, resets_at: '2026-09-23T10:00:00Z' } }), { status: 200 })
      },
      log: () => {}
    })
    assert.deepEqual(tokens, ['Bearer new-access'])
    assert.equal(account.accuracy, 'official')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})()
