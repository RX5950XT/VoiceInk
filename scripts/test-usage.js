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

test('初始狀態固定包含五家 provider 且沒有假額度', () => {
  const { constants, shared } = loadShared()
  assert.deepEqual(constants.PROVIDER_IDS, [
    'claude-code',
    'codex',
    'antigravity',
    'opencode-go',
    'grok'
  ])
  assert.deepEqual(constants.DEFAULT_USAGE_SETTINGS.visibleProviders, constants.PROVIDER_IDS)
  const accounts = shared.createInitialAccounts(0)
  assert.equal(accounts.length, 5)
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

test('Claude Code 將 OAuth usage 正規化為 5h 與 weekly', async () => {
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
          extra_usage: { is_enabled: true }
        }), { status: 200 })
      },
      log: () => {}
    })
    assert.equal(request.options.headers.Authorization, `Bearer ${token}`)
    assert.equal(request.options.headers['anthropic-beta'], 'oauth-2025-04-20')
    assert.deepEqual(account.windows.map((window) => [window.id, window.used]), [
      ['claude-5h', 62.5],
      ['claude-weekly', 38]
    ])
    assert.equal(account.accuracy, 'official')
    assert.equal(account.planName, 'Claude Pro / Max')
    assert.ok(!JSON.stringify(account).includes(token))
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

test('OpenCode 以唯讀 SQLite 加總增量成本並保留 DB 位元組', async () => {
  const { DatabaseSync } = require('node:sqlite')
  const { syncOpenCode } = require('../src/main/usage/opencode')
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-usage-opencode-'))
  const dbDir = path.join(homeDir, '.local', 'share', 'opencode')
  const dbPath = path.join(dbDir, 'opencode.db')
  const nowMs = Date.parse('2026-08-20T12:00:00Z')
  try {
    fs.mkdirSync(dbDir, { recursive: true })
    const db = new DatabaseSync(dbPath)
    db.exec(`create table part (
      id text primary key,
      message_id text not null,
      session_id text not null,
      time_created integer not null,
      time_updated integer not null,
      data text not null
    )`)
    const insert = db.prepare(`insert into part
      (id, message_id, session_id, time_created, time_updated, data)
      values (?, 'm', 's', ?, ?, ?)`)
    insert.run('p1', nowMs - 120_000, nowMs - 120_000, JSON.stringify({ type: 'step-finish', cost: 1.5 }))
    insert.run('p2', nowMs - 60_000, nowMs - 60_000, JSON.stringify({ type: 'step-finish', cost: 2.5 }))
    insert.run('old', nowMs - 31 * 24 * 60 * 60 * 1000, nowMs, JSON.stringify({ type: 'step-finish', cost: 99 }))
    insert.run('other', nowMs - 30_000, nowMs, JSON.stringify({ type: 'text', cost: 500 }))
    db.close()

    const before = fs.readFileSync(dbPath)
    const account = await syncOpenCode({
      homeDir,
      nowMs,
      settings: {
        opencodeWeeklyReset: { day: 1, hour: 7, minute: 0 },
        opencodeMonthlyReset: { day: 1, hour: 0, minute: 0 }
      },
      log: () => {}
    })
    const after = fs.readFileSync(dbPath)
    assert.ok(before.equals(after), 'read-only sync must not mutate opencode.db')
    assert.deepEqual(account.windows.map((window) => [window.id, window.used, window.limit]), [
      ['opencode-5h', 4, 12],
      ['opencode-weekly', 4, 30],
      ['opencode-monthly', 4, 60]
    ])
    assert.equal(account.windows[0].resetAt, new Date(nowMs - 60_000 + 5 * 60 * 60 * 1000).toISOString())
    assert.equal(account.accuracy, 'local')
    assert.match(account.notes, /非官方額度/)
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('OpenCode reset 計算處理同日跨週與月底不存在日期', () => {
  const {
    calculateNextWeeklyReset,
    calculateNextMonthlyReset
  } = require('../src/main/usage/opencode')
  const weekly = { day: 1, hour: 7, minute: 0 }
  assert.equal(
    calculateNextWeeklyReset(weekly, Date.parse('2026-08-17T06:00:00Z')),
    '2026-08-17T07:00:00.000Z'
  )
  assert.equal(
    calculateNextWeeklyReset(weekly, Date.parse('2026-08-17T08:00:00Z')),
    '2026-08-24T07:00:00.000Z'
  )
  assert.equal(
    calculateNextMonthlyReset({ day: 31, hour: 0, minute: 0 }, Date.parse('2027-01-31T01:00:00Z')),
    '2027-02-28T00:00:00.000Z'
  )
})

test('OpenCode DB 不存在時回 disconnected 且不建立檔案', async () => {
  const { syncOpenCode } = require('../src/main/usage/opencode')
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-usage-opencode-missing-'))
  try {
    const account = await syncOpenCode({ homeDir, settings: {}, nowMs: 0, log: () => {} })
    assert.equal(account.status, 'disconnected')
    assert.equal(account.windows.length, 0)
    assert.equal(fs.existsSync(path.join(homeDir, '.local', 'share', 'opencode', 'opencode.db')), false)
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

test('usage settings 只保留合法 provider、順序與 reset 範圍', () => {
  const { sanitizeSettings } = require('../src/main/usage/store')
  const input = {
    visibleProviders: ['grok', 'grok', 'unknown', 'claude-code'],
    providerOrder: ['grok', 'unknown', 'grok'],
    opencodeWeeklyReset: { day: 9, hour: 8, minute: 90 },
    opencodeMonthlyReset: { day: 31, hour: 23, minute: 59 }
  }
  const result = sanitizeSettings(input)
  assert.deepEqual(result.visibleProviders, ['grok', 'claude-code'])
  assert.deepEqual(result.providerOrder, [
    'grok',
    'claude-code',
    'codex',
    'antigravity',
    'opencode-go'
  ])
  assert.deepEqual(result.opencodeWeeklyReset, { day: 1, hour: 8, minute: 0 })
  assert.deepEqual(result.opencodeMonthlyReset, { day: 31, hour: 23, minute: 59 })
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
