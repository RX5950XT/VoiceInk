const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

function loadShared() {
  return {
    constants: require('../src/main/usage/constants'),
    shared: require('../src/main/usage/shared')
  }
}

test('初始狀態固定包含七家 provider 且沒有假額度', () => {
  const { constants, shared } = loadShared()
  assert.deepEqual(constants.PROVIDER_IDS, [
    'claude-code',
    'codex',
    'antigravity',
    'opencode-go',
    'grok',
    'ollama',
    'commandcode'
  ])
  assert.deepEqual(constants.DEFAULT_USAGE_SETTINGS.visibleProviders, constants.PROVIDER_IDS)
  const accounts = shared.createInitialAccounts(0)
  assert.equal(accounts.length, 7)
  assert.ok(accounts.every((account) => account.windows.length === 0))
  assert.ok(accounts.every((account) => account.status === 'disconnected'))
})

test('正規化會移除非有限或無效額度視窗', () => {
  const { shared } = loadShared()
  const account = shared.createBaseAccount('claude-code', 0)
  account.windows = [
    shared.createWindow('infinite', '', 'weekly', Infinity, 100, ''),
    shared.createWindow('zero-limit', '', 'weekly', 20, 0, ''),
    shared.createWindow('bad-kind', '', 'hourly', 20, 100, ''),
    shared.createWindow('valid', '', 'weekly', 20, 100, '2026-08-20T00:00:00Z')
  ]
  const normalized = shared.normalizeAccount(account)
  assert.deepEqual(normalized.windows.map((window) => window.id), ['valid'])
})

test('未知例外轉為不洩漏原訊息的公開錯誤', () => {
  const { shared } = loadShared()
  assert.deepEqual(shared.publicError(new Error('secret response body')), {
    code: 'USAGE_FAILED',
    message: '額度資料處理失敗'
  })
  const known = new shared.UsageError('HTTP_ERROR', 'Claude API 暫時無法使用', 503)
  assert.deepEqual(shared.publicError(known), {
    code: 'HTTP_ERROR',
    message: 'Claude API 暫時無法使用'
  })
})

test('本機 JSON 只讀取普通且大小受限的檔案', async () => {
  const { constants, shared } = loadShared()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-usage-shared-'))
  try {
    const validPath = path.join(dir, 'valid.json')
    fs.writeFileSync(validPath, '{"ok":true}')
    assert.deepEqual(await shared.readJsonFile(validPath), { ok: true })

    const largePath = path.join(dir, 'large.json')
    fs.writeFileSync(largePath, Buffer.alloc(constants.FILE_MAX_BYTES + 1, 0x20))
    await assert.rejects(
      () => shared.readJsonFile(largePath),
      (error) => error.code === 'FILE_TOO_LARGE'
    )

    await assert.rejects(
      () => shared.readJsonFile(dir),
      (error) => error.code === 'INVALID_FILE'
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('HTTP JSON 解析受大小限制並依狀態決定重試', async () => {
  const { shared } = loadShared()
  let attempts = 0
  const success = await shared.fetchJson('https://example.test/usage', {
    fetchImpl: async () => new Response('{"usage":42}', {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  })
  assert.deepEqual(success, { usage: 42 })

  await assert.rejects(
    () => shared.fetchJson('https://example.test/usage', {
      retries: 3,
      fetchImpl: async () => {
        attempts++
        return new Response('upstream secret body', { status: 500 })
      }
    }),
    (error) => error.code === 'HTTP_ERROR' && error.status === 500 && !error.message.includes('secret')
  )
  assert.equal(attempts, 3)

  attempts = 0
  await assert.rejects(
    () => shared.fetchJson('https://example.test/usage', {
      retries: 3,
      fetchImpl: async () => {
        attempts++
        return new Response('{}', { status: 401 })
      }
    }),
    (error) => error.status === 401
  )
  assert.equal(attempts, 1)

  await assert.rejects(
    () => shared.fetchJson('https://example.test/usage', {
      maxBytes: 8,
      fetchImpl: async () => new Response('{"payload":"too large"}', { status: 200 })
    }),
    (error) => error.code === 'RESPONSE_TOO_LARGE'
  )
})

test('Claude Code 將 OAuth usage 正規化為 5h、weekly 與 Opus weekly', async () => {
  const { syncClaude } = require('../src/main/usage/claude')
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-usage-claude-'))
  const token = 'claude-sentinel-token'
  try {
    fs.mkdirSync(path.join(homeDir, '.claude'))
    fs.writeFileSync(
      path.join(homeDir, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: token } })
    )
    let request
    const account = await syncClaude({
      homeDir,
      nowMs: Date.parse('2026-08-20T12:00:00Z'),
      fetchImpl: async (url, options) => {
        request = { url, options }
        return new Response(JSON.stringify({
          five_hour: { utilization: 62.5, resets_at: '2026-08-20T15:00:00Z' },
          seven_day: { utilization: 38, resets_at: '2026-08-24T00:00:00Z' },
          seven_day_opus: { utilization: 12, resets_at: '2026-08-24T00:00:00Z' },
          seven_day_sonnet: null,
          extra_usage: { is_enabled: true }
        }), { status: 200 })
      },
      log: () => {}
    })
    assert.equal(request.options.headers.Authorization, `Bearer ${token}`)
    assert.equal(request.options.headers['anthropic-beta'], 'oauth-2025-04-20')
    assert.deepEqual(account.windows.map((window) => [window.id, window.label, window.used]), [
      ['claude-5h', '', 62.5],
      ['claude-weekly', '', 38],
      ['claude-weekly-opus', 'Opus', 12]
    ])
    assert.equal(account.accuracy, 'official')
    assert.equal(account.planName, 'Claude Pro / Max')
    assert.ok(!JSON.stringify(account).includes(token))

    // 非 Max 方案上游把 seven_day_opus 回成 null，不可以憑空多畫一格 0%
    const { applyClaudeUsage } = require('../src/main/usage/claude')
    const pro = applyClaudeUsage({
      five_hour: { utilization: 10, resets_at: '2026-08-20T15:00:00Z' },
      seven_day: { utilization: 5, resets_at: '2026-08-24T00:00:00Z' },
      seven_day_opus: null
    }, Date.parse('2026-08-20T12:00:00Z'), 'pro')
    assert.deepEqual(pro.windows.map((window) => window.id), ['claude-5h', 'claude-weekly'])
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('Codex 將 wham primary/secondary 視窗映射為 5h/weekly', async () => {
  const { syncCodex } = require('../src/main/usage/codex')
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-usage-codex-'))
  const token = 'codex-sentinel-token'
  try {
    fs.mkdirSync(path.join(homeDir, '.codex'))
    fs.writeFileSync(
      path.join(homeDir, '.codex', 'auth.json'),
      JSON.stringify({ tokens: { access_token: token }, plan_type: 'pro' })
    )
    const account = await syncCodex({
      homeDir,
      nowMs: Date.parse('2026-08-20T12:00:00Z'),
      fetchImpl: async (_url, options) => {
        assert.equal(options.headers.Authorization, `Bearer ${token}`)
        return new Response(JSON.stringify({
          rate_limit: {
            primary_window: { used_percent: 45, limit_window_seconds: 18000, reset_at: 1787241600 },
            secondary_window: { used_percent: 28, limit_window_seconds: 604800, reset_at: 1787673600 }
          }
        }), { status: 200 })
      },
      log: () => {}
    })
    assert.deepEqual(account.windows.map((window) => [window.id, window.kind, window.used]), [
      ['codex-5h', 'rolling-5h', 45],
      ['codex-weekly', 'weekly', 28]
    ])
    assert.equal(account.planName, 'ChatGPT Pro')
    assert.ok(!JSON.stringify(account).includes(token))
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('Grok 支援 wrapped 與 flat billing 並送出 CLI header', async () => {
  const { syncGrok, applyGrokBilling } = require('../src/main/usage/grok')
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-usage-grok-'))
  const token = 'grok-sentinel-token'
  try {
    fs.mkdirSync(path.join(homeDir, '.grok'))
    fs.writeFileSync(
      path.join(homeDir, '.grok', 'auth.json'),
      JSON.stringify({ empty: {}, valid: { key: token, user_id: 'user-1', email: 'user@example.test' } })
    )
    const account = await syncGrok({
      homeDir,
      env: {},
      nowMs: Date.parse('2026-08-20T12:00:00Z'),
      fetchImpl: async (_url, options) => {
        assert.equal(options.headers.Authorization, `Bearer ${token}`)
        assert.equal(options.headers['X-XAI-Token-Auth'], 'xai-grok-cli')
        assert.equal(options.headers['x-userid'], 'user-1')
        return new Response(JSON.stringify({
          config: {
            creditUsagePercent: 44,
            subscriptionTier: 'SuperGrok',
            currentPeriod: { end: '2026-08-27T00:00:00Z' }
          }
        }), { status: 200 })
      },
      log: () => {}
    })
    assert.equal(account.windows[0].id, 'grok-weekly')
    assert.equal(account.windows[0].used, 44)
    assert.equal(account.planName, 'Grok SuperGrok')
    assert.ok(!JSON.stringify(account).includes(token))

    const flat = applyGrokBilling({
      creditUsagePercent: 12.5,
      billingPeriodEnd: '2026-08-28T00:00:00Z'
    }, Date.parse('2026-08-20T12:00:00Z'))
    assert.equal(flat.windows[0].used, 12.5)
    assert.equal(flat.planName, 'Grok')
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('訂閱方案取自本機憑證：Claude subscriptionType／Codex id_token／Grok tier', async () => {
  const { syncClaude } = require('../src/main/usage/claude')
  const { syncCodex } = require('../src/main/usage/codex')
  const { syncGrok } = require('../src/main/usage/grok')
  const jwt = (claims) => [
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url'),
    'sig'
  ].join('.')
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-usage-plan-'))
  const nowMs = Date.parse('2026-08-20T12:00:00Z')
  try {
    // Claude：方案在 .credentials.json，usage API 不回。
    // 靠 extra_usage.is_enabled 猜的話 Pro 會被寫成「Pro / Max」。
    fs.mkdirSync(path.join(homeDir, '.claude'))
    fs.writeFileSync(
      path.join(homeDir, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'tok', subscriptionType: 'max' } })
    )
    const claude = await syncClaude({
      homeDir,
      nowMs,
      fetchImpl: async () => new Response(JSON.stringify({
        five_hour: { utilization: 10, resets_at: '2026-08-20T15:00:00Z' },
        extra_usage: { is_enabled: true }
      }), { status: 200 }),
      log: () => {}
    })
    assert.equal(claude.planName, 'Claude Max')

    // Codex：新版 auth.json 沒有頂層 plan_type，方案在 id_token 的自訂 claim
    fs.mkdirSync(path.join(homeDir, '.codex'))
    fs.writeFileSync(path.join(homeDir, '.codex', 'auth.json'), JSON.stringify({
      tokens: {
        access_token: 'tok',
        id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } })
      }
    }))
    const codex = await syncCodex({
      homeDir,
      nowMs,
      fetchImpl: async () => new Response(JSON.stringify({
        rate_limit: { primary_window: { used_percent: 5, reset_at: 1787241600 } }
      }), { status: 200 }),
      log: () => {}
    })
    assert.equal(codex.planName, 'ChatGPT Plus')

    // Grok：billing 沒回 subscriptionTier 時退回 access token 的 tier claim
    fs.mkdirSync(path.join(homeDir, '.grok'))
    fs.writeFileSync(path.join(homeDir, '.grok', 'auth.json'), JSON.stringify({
      valid: { key: jwt({ tier: 1 }), user_id: 'user-1' }
    }))
    const grok = await syncGrok({
      homeDir,
      env: {},
      nowMs,
      fetchImpl: async () => new Response(JSON.stringify({
        config: { creditUsagePercent: 44, currentPeriod: { end: '2026-08-27T00:00:00Z' } }
      }), { status: 200 }),
      log: () => {}
    })
    assert.equal(grok.planName, 'Grok Tier 1')
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('缺少本機憑證時三個雲端 provider 都回 disconnected', async () => {
  const { syncClaude } = require('../src/main/usage/claude')
  const { syncCodex } = require('../src/main/usage/codex')
  const { syncGrok } = require('../src/main/usage/grok')
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-usage-missing-'))
  try {
    const args = { homeDir, nowMs: 0, fetchImpl: async () => { throw new Error('must not fetch') }, log: () => {} }
    const accounts = await Promise.all([
      syncClaude(args),
      syncCodex(args),
      syncGrok({ ...args, env: {} })
    ])
    assert.ok(accounts.every((account) => account.status === 'disconnected'))
    assert.ok(accounts.every((account) => account.windows.length === 0))
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

/** 寫一份 OpenCode CLI 的 auth.json（額度金鑰的來源之一）。 */
function writeOpenCodeAuth(homeDir, entries) {
  const dir = path.join(homeDir, '.local', 'share', 'opencode')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(entries))
}

test('OpenCode Go 讀官方 usage 端點的三個百分比視窗', async () => {
  const { syncOpenCode } = require('../src/main/usage/opencode')
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-usage-opencode-'))
  const key = 'sk-opencode-sentinel'
  const nowMs = Date.parse('2026-08-20T12:00:00Z')
  try {
    writeOpenCodeAuth(homeDir, { 'opencode-go': { type: 'api', key } })
    const account = await syncOpenCode({
      homeDir,
      env: {},
      nowMs,
      fetchImpl: async (url, options) => {
        assert.equal(url, 'https://opencode.ai/zen/go/v1/usage')
        assert.equal(options.headers.Authorization, `Bearer ${key}`)
        return new Response(JSON.stringify({
          usage: {
            rolling: { status: 'ok', percent: 37, resetsAt: '2026-08-20T15:00:00Z' },
            weekly: { status: 'ok', percent: 62, resetsAt: '2026-08-24T07:00:00Z' },
            monthly: { status: 'rate-limited', percent: 100, resetsAt: '2026-09-15T00:00:00Z' },
            // 壞掉的那格跳過就好，不要整份丟掉（上游改過一次形狀）
            bogus: { status: 'ok', percent: 'nope', resetsAt: '2026-09-15T00:00:00Z' }
          }
        }), { status: 200 })
      },
      log: () => {}
    })
    assert.deepEqual(account.windows.map((w) => [w.id, w.kind, w.used, w.limit]), [
      ['opencode-5h', 'rolling-5h', 37, 100],
      ['opencode-weekly', 'weekly', 62, 100],
      ['opencode-monthly', 'monthly', 100, 100]
    ])
    assert.equal(account.windows[1].resetAt, '2026-08-24T07:00:00Z')
    assert.equal(account.accuracy, 'official')
    assert.equal(account.status, 'available')
    assert.ok(!JSON.stringify(account).includes(key))
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('OpenCode Go 的 403（沒訂閱）與 401（金鑰壞掉）是兩件事', async () => {
  const { syncOpenCode } = require('../src/main/usage/opencode')
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-usage-opencode-403-'))
  try {
    writeOpenCodeAuth(homeDir, { 'opencode-go': { type: 'api', key: 'sk-x' } })
    const body = JSON.stringify({ error: { type: 'EntitlementError', message: 'OpenCode Go subscription required.' } })
    const forbidden = await syncOpenCode({
      homeDir,
      env: {},
      nowMs: 0,
      fetchImpl: async () => new Response(body, { status: 403 }),
      log: () => {}
    })
    assert.equal(forbidden.status, 'disconnected')
    assert.match(forbidden.notes, /沒有 Go 訂閱/)
    // 沒訂閱不是「金鑰不對」，訊息不可以把人送去檢查一把正確的金鑰
    assert.ok(!/金鑰被拒絕|重新登入/.test(forbidden.notes))

    const unauthorized = await syncOpenCode({
      homeDir,
      env: {},
      nowMs: 0,
      fetchImpl: async () => new Response('{}', { status: 401 }),
      log: () => {}
    })
    assert.equal(unauthorized.status, 'disconnected')
    assert.match(unauthorized.notes, /401/)

    // 暫時性失敗要留在 connected，才吃得到 6h soft cache
    const flaky = await syncOpenCode({
      homeDir,
      env: {},
      nowMs: 0,
      fetchImpl: async () => new Response('{}', { status: 503 }),
      log: () => {}
    })
    assert.equal(flaky.status, 'connected')
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('沒有 OpenCode 金鑰時回 disconnected，且金鑰解析順序是 env → auth.json', async () => {
  const { syncOpenCode } = require('../src/main/usage/opencode')
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-usage-opencode-missing-'))
  try {
    const missing = await syncOpenCode({ homeDir, env: {}, nowMs: 0, log: () => {} })
    assert.equal(missing.status, 'disconnected')
    assert.equal(missing.windows.length, 0)

    writeOpenCodeAuth(homeDir, { 'opencode-go': { type: 'api', key: 'from-file' } })
    let seen = ''
    await syncOpenCode({
      homeDir,
      env: { OPENCODE_API_KEY: 'from-env' },
      nowMs: 0,
      fetchImpl: async (_url, options) => {
        seen = options.headers.Authorization
        return new Response(JSON.stringify({ usage: {} }), { status: 200 })
      },
      log: () => {}
    })
    assert.equal(seen, 'Bearer from-env')
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('Ollama Cloud 讀 monthly usage 且不編造重置時間', async () => {
  const { syncOllama, applyOllamaUsage, toPercent } = require('../src/main/usage/ollama')
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-usage-ollama-'))
  const key = 'ollama-sentinel-key'
  try {
    writeOpenCodeAuth(homeDir, { 'ollama-cloud': { type: 'api', key } })
    const account = await syncOllama({
      homeDir,
      env: {},
      nowMs: Date.parse('2026-08-20T12:00:00Z'),
      fetchImpl: async (url, options) => {
        assert.equal(url, 'https://ollama.com/api/usage')
        assert.equal(options.headers.Authorization, `Bearer ${key}`)
        return new Response(JSON.stringify({
          activity: { cost: '1.25000', period: { type: 'last_4_weeks' }, models: [] },
          limits: {
            monthly: { usage: 0.125, models: [{ name: 'gpt-oss:20b', request_count: 3 }] }
          }
        }), { status: 200 })
      },
      log: () => {}
    })
    assert.deepEqual(account.windows.map((w) => [w.id, w.kind, w.used, w.limit, w.resetAt]), [
      ['ollama-monthly', 'monthly', 12.5, 100, '']
    ])
    assert.equal(account.accuracy, 'official')
    assert.match(account.notes, /US\$1\.25/)
    assert.ok(!JSON.stringify(account).includes(key))

    // 比例（≤1）與百分比（>1）兩種都不能顯示成 0
    assert.equal(toPercent(1), 100)
    assert.equal(toPercent(42), 42)
    assert.equal(toPercent(-1), null)
    assert.equal(toPercent('nope'), null)

    // limits 整個不見時不補假視窗
    const empty = applyOllamaUsage({ activity: { cost: '0.00000' } }, 0)
    assert.equal(empty.windows.length, 0)
    assert.equal(empty.status, 'connected')
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('Command Code 讀 billing/credits 的三個視窗與訂閱重置時間', async () => {
  const { applyCommandCodeUsage, syncCommandCode, toIsoReset } = require('../src/main/usage/commandcode')
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-usage-cmdcode-'))
  const key = 'commandcode-sentinel-key'
  try {
    fs.mkdirSync(path.join(homeDir, '.commandcode'))
    fs.writeFileSync(path.join(homeDir, '.commandcode', 'auth.json'), JSON.stringify({ apiKey: key }))
    const account = await syncCommandCode({
      homeDir,
      env: {},
      nowMs: Date.parse('2026-08-20T12:00:00Z'),
      fetchImpl: async (url, options) => {
        assert.equal(options.headers.Authorization, `Bearer ${key}`)
        if (url.endsWith('/billing/credits')) {
          // 逐字取自實機回應（只留數字）
          return new Response(JSON.stringify({
            credits: { monthlyCredits: 79.9020260526, purchasedCredits: 0, freeCredits: 0 },
            windowLimits: {
              limited: true,
              exceeded: null,
              fiveHour: { used: 4, cap: 16, exceeded: false, resetAt: 1787476441355 },
              weekly: { used: 10, cap: 40, exceeded: false, resetAt: 1788063241355 }
            }
          }), { status: 200 })
        }
        assert.equal(url, 'https://api.commandcode.ai/alpha/billing/subscriptions')
        return new Response(JSON.stringify({
          success: true,
          data: {
            planId: 'individual-pro-v1',
            status: 'active',
            currentPeriodEnd: '2026-09-20T00:00:00Z'
          }
        }), { status: 200 })
      },
      log: () => {}
    })
    assert.deepEqual(account.windows.slice(0, 2).map((w) => [w.id, w.kind, w.used, w.limit, w.resetAt]), [
      ['commandcode-5h', 'rolling-5h', 4, 16, '2026-08-23T09:14:01.355Z'],
      ['commandcode-weekly', 'weekly', 10, 40, '2026-08-30T04:14:01.355Z']
    ])
    const monthly = account.windows[2]
    assert.deepEqual([monthly.id, monthly.kind, monthly.limit, monthly.resetAt], [
      'commandcode-monthly', 'monthly', 80, '2026-09-20T00:00:00Z'
    ])
    assert.ok(Math.abs(monthly.used - 0.0979739474) < 1e-9)
    const legacyPro = applyCommandCodeUsage(
      { credits: { monthlyCredits: 29 } },
      0,
      { success: true, data: { planId: 'individual-pro', currentPeriodEnd: '2026-09-20T00:00:00Z' } }
    )
    assert.deepEqual([legacyPro.windows[0].used, legacyPro.windows[0].limit], [1, 30])
    assert.equal(account.accuracy, 'official')
    assert.equal(toIsoReset(1788063241), '2026-08-30T04:14:01.000Z')
    assert.ok(!JSON.stringify(account).includes(key))
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('Command Code 不把 usage/summary 的花費報表當成額度，缺 cap 的視窗直接跳過', () => {
  const { applyCommandCodeUsage } = require('../src/main/usage/commandcode')
  // `/alpha/usage/summary` 也回 200，但裡面一個上限欄位都沒有。
  // 解析成「0% 全新未用」比空白更糟——那是會被相信的假數字。
  const costReport = applyCommandCodeUsage({
    totalCount: 0, totalCost: 0, totalTokens: 0, periodBasis: 'billing-period'
  }, 0)
  assert.equal(costReport.windows.length, 0)
  assert.equal(costReport.status, 'connected')

  // cap 缺了或是 0 只丟那一格，另一格照常
  const partial = applyCommandCodeUsage({
    windowLimits: { fiveHour: { used: 3 }, weekly: { used: 1, cap: 4, resetAt: 1788063241355 } }
  }, 0)
  assert.deepEqual(partial.windows.map((w) => w.id), ['commandcode-weekly'])
  assert.equal(applyCommandCodeUsage({ windowLimits: { fiveHour: { used: 0, cap: 0 } } }, 0).windows.length, 0)

  // 加購 credits 可以把用量推過上限，畫面不該出現超過 100% 的長條
  const over = applyCommandCodeUsage({ windowLimits: { fiveHour: { used: 99, cap: 10 } } }, 0)
  assert.deepEqual([over.windows[0].used, over.windows[0].limit], [10, 10])
})

test('沒有 Command Code 金鑰時回 disconnected，env 優先於 auth.json', async () => {
  const { syncCommandCode } = require('../src/main/usage/commandcode')
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-usage-cmdcode-none-'))
  try {
    const missing = await syncCommandCode({ homeDir, env: {}, nowMs: 0, fetchImpl: async () => {
      throw new Error('沒有金鑰就不該打上游')
    }, log: () => {} })
    assert.equal(missing.status, 'disconnected')
    assert.equal(missing.windows.length, 0)
    // 沒跑過 cmd login 的人是在 Studio 開一把 API key，說明要指得到那個填得進去的地方
    assert.match(missing.notes, /CC代理/)

    // 只有 CC 代理頁填了金鑰（沒有 auth.json、沒有環境變數）也要讀得到
    const { resolveCommandCodeKey } = require('../src/main/usage/api-key')
    const ccswitch = require('../src/main/ccswitch/providers')
    const originalKeyForPreset = ccswitch.keyForPreset
    ccswitch.keyForPreset = async (presetId) => (presetId === 'commandcode' ? 'from-ccswitch' : '')
    try {
      assert.deepEqual(
        await resolveCommandCodeKey({ homeDir, env: {} }),
        { key: 'from-ccswitch', source: 'ccswitch' }
      )
    } finally {
      ccswitch.keyForPreset = originalKeyForPreset
    }

    fs.mkdirSync(path.join(homeDir, '.commandcode'))
    fs.writeFileSync(path.join(homeDir, '.commandcode', 'auth.json'), JSON.stringify({ apiKey: 'from-file' }))
    let seen = ''
    await syncCommandCode({
      homeDir,
      env: { COMMAND_CODE_API_KEY: 'from-env' },
      nowMs: 0,
      fetchImpl: async (_url, options) => {
        seen = options.headers.Authorization
        return new Response('{}', { status: 200 })
      },
      log: () => {}
    })
    assert.equal(seen, 'Bearer from-env')
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('Antigravity credential parser 驗證完整 token 欄位', () => {
  const { parseCredential } = require('../src/main/usage/antigravity')
  assert.deepEqual(parseCredential(JSON.stringify({
    token: {
      access_token: 'AT',
      refresh_token: 'RT',
      expiry: '2026-08-20T15:00:00Z'
    },
    auth_method: 'consumer'
  })), {
    accessToken: 'AT',
    refreshToken: 'RT',
    expiry: '2026-08-20T15:00:00Z'
  })
  assert.equal(parseCredential('{"auth_method":"consumer"}'), null)
  assert.equal(parseCredential('not json'), null)
})

test('Antigravity summary 產生 Claude/Gemini 各 5h 與 weekly', () => {
  const { applyAntigravityQuota } = require('../src/main/usage/antigravity')
  const account = applyAntigravityQuota({
    summary: {
      groups: [
        {
          displayName: 'Claude and GPT models',
          buckets: [
            { bucketId: '3p-5h', window: '5h', remainingFraction: 0.6, resetTime: '2026-08-21T00:00:00Z' },
            { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.75, resetTime: '2026-08-27T00:00:00Z' }
          ]
        },
        {
          displayName: 'Gemini Models',
          buckets: [
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.4, resetTime: '2026-08-21T01:00:00Z' },
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.9, resetTime: '2026-08-28T00:00:00Z' }
          ]
        }
      ]
    },
    models: { models: {} },
    tier: 'Google AI Pro',
    nowMs: Date.parse('2026-08-20T12:00:00Z')
  })
  assert.deepEqual(account.windows.map((window) => [window.id, window.used]), [
    ['antigravity-claude-5h', 40],
    ['antigravity-claude-weekly', 25],
    ['antigravity-gemini-5h', 60],
    ['antigravity-gemini-weekly', 10]
  ])
  assert.equal(account.planName, 'Antigravity Google AI Pro')
})

test('Antigravity models fallback 取各 family 最低 remaining 並保留用盡 pool', () => {
  const { applyAntigravityQuota } = require('../src/main/usage/antigravity')
  const account = applyAntigravityQuota({
    summary: null,
    models: {
      models: {
        'claude-sonnet': { quotaInfo: { remainingFraction: 0.8, resetTime: '2026-08-21T00:00:00Z' } },
        'claude-opus': { quotaInfo: { remainingFraction: 0.4, resetTime: '2026-08-21T01:00:00Z' } },
        'gemini-pro': {},
        'gemini-flash': { quotaInfo: { remainingFraction: 0, resetTime: '2026-08-21T02:00:00Z' } }
      }
    },
    tier: '',
    nowMs: Date.parse('2026-08-20T12:00:00Z')
  })
  assert.deepEqual(account.windows.map((window) => [window.id, window.used]), [
    ['antigravity-claude-5h', 60],
    ['antigravity-gemini-5h', 100]
  ])
})

test('Antigravity 缺少 API slot 時保留舊值，沒有舊值則視為用盡', () => {
  const { mergeExpectedWindows } = require('../src/main/usage/antigravity')
  const previous = {
    windows: [
      { id: 'antigravity-claude-5h', label: 'Claude', kind: 'rolling-5h', used: 20, limit: 100, resetAt: '2026-08-21T00:00:00Z' },
      { id: 'antigravity-claude-weekly', label: 'Claude', kind: 'weekly', used: 30, limit: 100, resetAt: '2026-08-27T00:00:00Z' }
    ]
  }
  const merged = mergeExpectedWindows([], previous)
  assert.deepEqual(merged.map((window) => [window.id, window.used]), [
    ['antigravity-claude-5h', 20],
    ['antigravity-claude-weekly', 30],
    ['antigravity-gemini-5h', 100],
    ['antigravity-gemini-weekly', 100]
  ])
})

test('Antigravity 同步只回正規化額度且 refresh secret 不進結果或診斷', async () => {
  const { syncAntigravity } = require('../src/main/usage/antigravity')
  const logs = []
  const calls = []
  const accessToken = 'expired-access-sentinel'
  const refreshToken = 'refresh-sentinel'
  const clientId = 'client-id-sentinel'
  const clientSecret = 'client-secret-sentinel'
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    if (url === 'https://oauth2.googleapis.com/token') {
      assert.match(String(options.body), /client_id=client-id-sentinel/)
      assert.match(String(options.body), /client_secret=client-secret-sentinel/)
      return new Response('{"access_token":"fresh-access-sentinel"}', { status: 200 })
    }
    if (url.endsWith(':loadCodeAssist')) {
      return new Response(JSON.stringify({
        cloudaicompanionProject: 'projects/project-1',
        paidTier: { name: 'Pro' }
      }), { status: 200 })
    }
    if (url.endsWith(':retrieveUserQuotaSummary')) {
      return new Response(JSON.stringify({
        groups: [
          { displayName: 'Claude', buckets: [
            { bucketId: '3p-5h', window: '5h', remainingFraction: 0.5, resetTime: '2026-08-21T00:00:00Z' },
            { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.7, resetTime: '2026-08-27T00:00:00Z' }
          ] },
          { displayName: 'Gemini', buckets: [
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.8, resetTime: '2026-08-21T00:00:00Z' },
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.9, resetTime: '2026-08-27T00:00:00Z' }
          ] }
        ]
      }), { status: 200 })
    }
    if (url.endsWith(':fetchAvailableModels')) {
      return new Response('{"models":{}}', { status: 200 })
    }
    throw new Error(`unexpected URL ${url}`)
  }

  const account = await syncAntigravity({
    env: {
      ANTIGRAVITY_CLIENT_ID: clientId,
      ANTIGRAVITY_CLIENT_SECRET: clientSecret
    },
    nowMs: Date.parse('2026-08-20T12:00:00Z'),
    fetchImpl,
    log: (line) => logs.push(line),
    readCredential: async () => JSON.stringify({
      token: {
        access_token: accessToken,
        refresh_token: refreshToken,
        expiry: '2026-08-20T11:00:00Z'
      }
    })
  })
  assert.equal(calls.filter((call) => call.url === 'https://oauth2.googleapis.com/token').length, 1)
  assert.equal(account.windows.length, 4)
  const publicText = JSON.stringify({ account, logs })
  for (const secret of [accessToken, refreshToken, clientId, clientSecret, 'fresh-access-sentinel']) {
    assert.ok(!publicText.includes(secret), `must not leak ${secret}`)
  }
})

test('usage settings 只保留合法 provider 與順序', () => {
  const { sanitizeSettings } = require('../src/main/usage/store')
  const input = {
    visibleProviders: ['grok', 'grok', 'unknown', 'claude-code'],
    providerOrder: ['grok', 'unknown', 'grok']
  }
  const result = sanitizeSettings(input)
  assert.deepEqual(result.visibleProviders, ['grok', 'claude-code'])
  assert.deepEqual(result.providerOrder, [
    'grok',
    'claude-code',
    'codex',
    'antigravity',
    'opencode-go',
    'ollama',
    'commandcode'
  ])
  input.visibleProviders.length = 0
  assert.deepEqual(result.visibleProviders, ['grok', 'claude-code'])
})

test('6 小時 soft cache 只保留近期且仍連線的額度', () => {
  const { createBaseAccount, createWindow } = loadShared().shared
  const { mergeAccountState } = require('../src/main/usage')
  const nowMs = Date.parse('2026-08-20T12:00:00Z')
  const previous = createBaseAccount('claude-code', nowMs - 359 * 60 * 1000)
  previous.windows = [createWindow('claude-5h', '', 'rolling-5h', 50, 100, '2026-08-20T15:00:00Z')]
  previous.accuracy = 'official'

  const connected = createBaseAccount('claude-code', nowMs)
  connected.status = 'connected'
  connected.notes = 'API 暫時失敗。'
  const cached = mergeAccountState(connected, previous, nowMs)
  assert.equal(cached.windows.length, 1)
  assert.equal(cached.accuracy, 'estimated')
  assert.match(cached.notes, /上次/)

  previous.lastUpdated = new Date(nowMs - 361 * 60 * 1000).toISOString()
  assert.equal(mergeAccountState(connected, previous, nowMs).windows.length, 0)

  previous.lastUpdated = new Date(nowMs - 1_000).toISOString()
  const disconnected = { ...connected, status: 'disconnected' }
  assert.equal(mergeAccountState(disconnected, previous, nowMs).windows.length, 0)
})

test('Antigravity 未連線時不合成假額度視窗', () => {
  const { createBaseAccount } = loadShared().shared
  const { mergeAccountState } = require('../src/main/usage')
  const nowMs = Date.parse('2026-08-20T12:00:00Z')
  const current = createBaseAccount('antigravity', nowMs)
  current.status = 'disconnected'
  current.windows = []

  const merged = mergeAccountState(current, null, nowMs)
  assert.deepEqual(merged.windows, [])
})

test('Antigravity API 失敗且無快取時不合成 100% 假額度', () => {
  const { createBaseAccount } = loadShared().shared
  const { mergeAccountState } = require('../src/main/usage')
  const nowMs = Date.parse('2026-08-20T12:00:00Z')
  const current = createBaseAccount('antigravity', nowMs)
  current.status = 'connected'
  current.accuracy = 'estimated'
  current.windows = []
  current.notes = 'Antigravity 額度 API 暫時無法使用（HTTP 502）。'

  const merged = mergeAccountState(current, null, nowMs)
  assert.deepEqual(merged.windows, [])
  assert.ok(
    merged.windows.every((window) => window.used !== 100),
    '空窗不得被補成 100/100'
  )
})

test('Antigravity API 失敗時用 6h soft cache 而非 100% 補窗', () => {
  const { createBaseAccount, createWindow } = loadShared().shared
  const { mergeAccountState } = require('../src/main/usage')
  const nowMs = Date.parse('2026-08-20T12:00:00Z')
  const previous = createBaseAccount('antigravity', nowMs - 1_000)
  previous.windows = [
    createWindow('antigravity-gemini-5h', 'Gemini', 'rolling-5h', 17, 100, '2026-08-21T00:00:00Z')
  ]
  const current = createBaseAccount('antigravity', nowMs)
  current.status = 'connected'
  current.windows = []
  current.notes = 'Antigravity 額度 API 暫時無法使用。'

  const merged = mergeAccountState(current, previous, nowMs)
  assert.equal(merged.windows.length, 1)
  assert.equal(merged.windows[0].used, 17)
  assert.equal(merged.accuracy, 'estimated')
  assert.match(merged.notes, /上次/)
})

test('Antigravity API 失敗且快取過期時保持空窗', () => {
  const { createBaseAccount, createWindow } = loadShared().shared
  const { mergeAccountState } = require('../src/main/usage')
  const nowMs = Date.parse('2026-08-20T12:00:00Z')
  const previous = createBaseAccount('antigravity', nowMs - 7 * 60 * 60 * 1000)
  previous.windows = [
    createWindow('antigravity-gemini-5h', 'Gemini', 'rolling-5h', 17, 100, '')
  ]
  const current = createBaseAccount('antigravity', nowMs)
  current.status = 'connected'
  current.windows = []

  const merged = mergeAccountState(current, previous, nowMs)
  assert.deepEqual(merged.windows, [])
})

test('打包版 Antigravity credential script 解析到 asar.unpacked', () => {
  const { resolveCredentialScriptPath } = require('../src/main/usage/antigravity')
  const packedDir = path.join('C:', 'app', 'resources', 'app.asar', 'src', 'main', 'usage')
  assert.equal(
    resolveCredentialScriptPath(packedDir),
    path.join('C:', 'app', 'resources', 'app.asar.unpacked', 'src', 'main', 'usage', 'read-windows-credential.ps1')
  )

  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
  assert.ok(packageJson.build.asarUnpack.includes('src/main/usage/read-windows-credential.ps1'))
})

test('Antigravity cache 逐一補齊 API 遺漏的固定 slot', () => {
  const { createBaseAccount, createWindow } = loadShared().shared
  const { mergeAccountState } = require('../src/main/usage')
  const nowMs = Date.parse('2026-08-20T12:00:00Z')
  const previous = createBaseAccount('antigravity', nowMs - 1_000)
  previous.windows = [
    createWindow('antigravity-claude-5h', 'Claude', 'rolling-5h', 20, 100, '2026-08-21T00:00:00Z'),
    createWindow('antigravity-claude-weekly', 'Claude', 'weekly', 30, 100, '2026-08-27T00:00:00Z'),
    createWindow('antigravity-gemini-5h', 'Gemini', 'rolling-5h', 40, 100, '2026-08-21T00:00:00Z'),
    createWindow('antigravity-gemini-weekly', 'Gemini', 'weekly', 50, 100, '2026-08-27T00:00:00Z')
  ]
  const current = createBaseAccount('antigravity', nowMs)
  current.accuracy = 'official'
  current.windows = [createWindow(
    'antigravity-gemini-5h', 'Gemini', 'rolling-5h', 10, 100, '2026-08-21T01:00:00Z'
  )]
  const merged = mergeAccountState(current, previous, nowMs)
  assert.deepEqual(merged.windows.map((window) => [window.id, window.used]), [
    ['antigravity-claude-5h', 20],
    ['antigravity-claude-weekly', 30],
    ['antigravity-gemini-5h', 10],
    ['antigravity-gemini-weekly', 50]
  ])
  assert.equal(merged.accuracy, 'estimated')
})

test('Antigravity 同步只回上游真的給的視窗（不預先補成 100% 用盡）', async () => {
  // 這條擋的是「syncAntigravity 先自己 mergeExpectedWindows(…, null)」那個回歸：
  // 先補一輪之後，index.js 的 mergeAccountState 會看到四個 id 都在，
  // 既撿不回快取的真實值，也偵測不到有視窗是補出來的 → 憑空的 100% 被標成官方 API。
  const { syncAntigravity } = require('../src/main/usage/antigravity')
  const { mergeAccountState } = require('../src/main/usage')
  const { createBaseAccount, createWindow } = loadShared().shared
  const nowMs = Date.parse('2026-08-20T12:00:00Z')

  const json = (body) => new Response(JSON.stringify(body), { status: 200 })
  const fetchImpl = async (url) => {
    if (url.endsWith(':loadCodeAssist')) return json({ cloudaicompanionProject: 'projects/p', paidTier: { name: 'Pro' } })
    if (url.endsWith(':retrieveUserQuotaSummary')) {
      // 上游只回 Gemini，Claude 那兩條沒給
      return json({ groups: [{ displayName: 'Gemini', buckets: [
        { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.83, resetTime: '2026-08-21T00:00:00Z' },
        { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.91, resetTime: '2026-08-27T00:00:00Z' }
      ] }] })
    }
    if (url.endsWith(':fetchAvailableModels')) return json({ models: {} })
    throw new Error(`unexpected URL ${url}`)
  }

  const account = await syncAntigravity({
    nowMs,
    fetchImpl,
    readCredential: async () => JSON.stringify({
      token: { access_token: 'a', refresh_token: 'r', expiry: '2099-01-01T00:00:00Z' }
    })
  })
  assert.deepEqual(
    account.windows.map((window) => window.id),
    ['antigravity-gemini-5h', 'antigravity-gemini-weekly'],
    '上游沒回的視窗不該在這一層被補出來'
  )

  // 接上 index.js 那一層：快取的 Claude 真實值要被撿回來，可信度要降級
  const previous = createBaseAccount('antigravity', nowMs - 1_000)
  previous.windows = [
    createWindow('antigravity-claude-5h', 'Claude', 'rolling-5h', 12, 100, ''),
    createWindow('antigravity-claude-weekly', 'Claude', 'weekly', 30, 100, '')
  ]
  const merged = mergeAccountState(account, previous, nowMs)
  assert.deepEqual(merged.windows.map((window) => [window.id, window.used]), [
    ['antigravity-claude-5h', 12],
    ['antigravity-claude-weekly', 30],
    ['antigravity-gemini-5h', 17],
    ['antigravity-gemini-weekly', 9]
  ])
  assert.equal(merged.accuracy, 'estimated', '有視窗是補的就不能自稱官方 API')
  assert.match(merged.notes, /部分 Antigravity 額度未回傳/)
})

test('Antigravity quota summary 成功時 models 失敗仍回視窗', async () => {
  const { syncAntigravity } = require('../src/main/usage/antigravity')
  const nowMs = Date.parse('2026-08-20T12:00:00Z')
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
  const fetchImpl = async (url) => {
    if (url.endsWith(':loadCodeAssist')) return json({ cloudaicompanionProject: 'projects/p' })
    if (url.endsWith(':retrieveUserQuotaSummary')) {
      return json({ groups: [{ displayName: 'Gemini', buckets: [
        { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.4, resetTime: '2026-08-21T00:00:00Z' }
      ] }] })
    }
    if (url.endsWith(':fetchAvailableModels')) return json({ error: 'unavailable' }, 503)
    throw new Error(`unexpected URL ${url}`)
  }
  const account = await syncAntigravity({
    nowMs,
    fetchImpl,
    readCredential: async () => JSON.stringify({
      token: { access_token: 'a', refresh_token: 'r', expiry: '2099-01-01T00:00:00Z' }
    })
  })
  assert.equal(account.windows.length, 1)
  assert.equal(account.windows[0].id, 'antigravity-gemini-5h')
  assert.equal(account.status, 'available')
})

test('並行同步共用同一個 in-flight 工作', async () => {
  const { coalesceSync, resetForTests } = require('../src/main/usage')
  resetForTests()
  let calls = 0
  let release
  const work = () => {
    calls++
    return new Promise((resolve) => { release = resolve })
  }
  const first = coalesceSync(work)
  const second = coalesceSync(work)
  assert.equal(calls, 1)
  assert.strictEqual(first, second)
  release({ ok: true })
  assert.deepEqual(await first, { ok: true })
  const third = coalesceSync(async () => {
    calls++
    return { ok: 'next' }
  })
  assert.deepEqual(await third, { ok: 'next' })
  assert.equal(calls, 2)
})

test('usage IPC 僅允許主視窗且錯誤不洩漏', async () => {
  const { registerUsageIpc } = require('../src/main/usage/ipc')
  const handlers = new Map()
  const calls = []
  const service = {
    load: async () => ({ accounts: [] }),
    sync: async () => ({ accounts: ['synced'] }),
    saveSettings: async (value) => { calls.push(value); return { settings: value } },
    getDiagnostics: async () => ['safe'],
    publicError: () => ({ code: 'USAGE_FAILED', message: '額度資料處理失敗' })
  }
  registerUsageIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    service,
    isMainSender: (event) => event.allowed === true
  })
  assert.deepEqual([...handlers.keys()], [
    'usage:load',
    'usage:sync',
    'usage:saveSettings',
    'usage:diagnostics'
  ])
  assert.deepEqual(await handlers.get('usage:load')({ allowed: false }), {
    ok: false,
    error: { code: 'FORBIDDEN', message: '僅主視窗可查詢額度' }
  })
  assert.deepEqual(await handlers.get('usage:sync')({ allowed: true }), {
    ok: true,
    data: { accounts: ['synced'] }
  })
  const rawSettings = { visibleProviders: ['grok'] }
  assert.deepEqual(await handlers.get('usage:saveSettings')({ allowed: true }, rawSettings), {
    ok: true,
    data: { settings: rawSettings }
  })
  assert.deepEqual(calls, [rawSettings])

  service.load = async () => { throw new Error('secret response body') }
  assert.deepEqual(await handlers.get('usage:load')({ allowed: true }), {
    ok: false,
    error: { code: 'USAGE_FAILED', message: '額度資料處理失敗' }
  })
})

async function run() {
  let passed = 0
  for (const { name, fn } of tests) {
    try {
      await fn()
      passed++
      console.log(`PASS ${name}`)
    } catch (error) {
      console.error(`FAIL ${name}:`, error?.stack || error)
    }
  }
  console.log(`\n${passed}/${tests.length} passed`)
  if (passed !== tests.length) process.exitCode = 1
}

run()
