'use strict'

const PROVIDER_IDS = Object.freeze([
  'claude-code',
  'codex',
  'antigravity',
  'opencode-go',
  'grok'
])

const PROVIDER_META = Object.freeze({
  'claude-code': Object.freeze({
    label: 'Claude Code',
    accent: '#c87955',
    accountName: 'Claude Code',
    planName: 'Claude Code'
  }),
  codex: Object.freeze({
    label: 'Codex',
    accent: '#46a5ff',
    accountName: 'Codex',
    planName: 'Codex'
  }),
  antigravity: Object.freeze({
    label: 'Antigravity',
    accent: '#59c889',
    accountName: 'Antigravity',
    planName: 'Antigravity'
  }),
  'opencode-go': Object.freeze({
    label: 'OpenCode',
    accent: '#f0bd4f',
    accountName: 'OpenCode',
    planName: '本機估算（Go 上限）'
  }),
  grok: Object.freeze({
    label: 'Grok',
    accent: '#a8a8b3',
    accountName: 'Grok',
    planName: 'Grok'
  })
})

const DEFAULT_USAGE_SETTINGS = Object.freeze({
  visibleProviders: Object.freeze([...PROVIDER_IDS]),
  providerOrder: Object.freeze([...PROVIDER_IDS]),
  opencodeWeeklyReset: Object.freeze({ day: 1, hour: 7, minute: 0 }),
  opencodeMonthlyReset: Object.freeze({ day: 29, hour: 0, minute: 0 })
})

const ENDPOINTS = Object.freeze({
  claude: 'https://api.anthropic.com/api/oauth/usage',
  codex: 'https://chatgpt.com/backend-api/wham/usage',
  grok: 'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
  googleOauth: 'https://oauth2.googleapis.com/token',
  antigravityBases: Object.freeze([
    'https://daily-cloudcode-pa.sandbox.googleapis.com',
    'https://daily-cloudcode-pa.googleapis.com',
    'https://cloudcode-pa.googleapis.com'
  ])
})

const HTTP_TIMEOUT_MS = 15_000
const API_MAX_BYTES = 1024 * 1024
const FILE_MAX_BYTES = 2 * 1024 * 1024
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const MAX_DIAGNOSTICS = 500

const OPENCODE_WINDOWS = Object.freeze([
  Object.freeze({ id: 'opencode-5h', kind: 'rolling-5h', widthMs: 5 * 60 * 60 * 1000, limit: 12 }),
  Object.freeze({ id: 'opencode-weekly', kind: 'weekly', widthMs: 7 * 24 * 60 * 60 * 1000, limit: 30 }),
  Object.freeze({ id: 'opencode-monthly', kind: 'monthly', widthMs: 30 * 24 * 60 * 60 * 1000, limit: 60 })
])

module.exports = {
  PROVIDER_IDS,
  PROVIDER_META,
  DEFAULT_USAGE_SETTINGS,
  ENDPOINTS,
  HTTP_TIMEOUT_MS,
  API_MAX_BYTES,
  FILE_MAX_BYTES,
  CACHE_TTL_MS,
  MAX_DIAGNOSTICS,
  OPENCODE_WINDOWS
}
