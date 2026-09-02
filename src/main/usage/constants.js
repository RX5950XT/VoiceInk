'use strict'

const PROVIDER_IDS = Object.freeze([
  'claude-code',
  'codex',
  'antigravity',
  'opencode-go',
  'grok',
  'ollama',
  'commandcode'
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
    planName: 'OpenCode Go'
  }),
  grok: Object.freeze({
    label: 'Grok',
    accent: '#a8a8b3',
    accountName: 'Grok',
    planName: 'Grok'
  }),
  ollama: Object.freeze({
    label: 'Ollama Cloud',
    accent: '#5fc9c9',
    accountName: 'Ollama Cloud',
    planName: 'Ollama Cloud'
  }),
  commandcode: Object.freeze({
    label: 'Command Code',
    accent: '#b078e8',
    accountName: 'Command Code',
    planName: 'Command Code'
  })
})

const DEFAULT_USAGE_SETTINGS = Object.freeze({
  visibleProviders: Object.freeze([...PROVIDER_IDS]),
  providerOrder: Object.freeze([...PROVIDER_IDS])
})

const ENDPOINTS = Object.freeze({
  claude: 'https://api.anthropic.com/api/oauth/usage',
  codex: 'https://chatgpt.com/backend-api/wham/usage',
  grok: 'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
  // 兩支都是第一方但沒有寫進文件的路由（實測 2026-09-01：
  // opencode 沒訂閱回 403 EntitlementError、ollama 回 200 帶 limits.monthly）。
  // 動之前跑 scripts/probe-usage-endpoints.js。
  opencodeGo: 'https://opencode.ai/zen/go/v1/usage',
  ollama: 'https://ollama.com/api/usage',
  // Command Code 的額度在 billing/credits，**不是** usage/summary（那支是花費報表，沒有上限欄位）。
  // 實測 2026-09-02：四支 /alpha 路由不帶金鑰都回 401（＝存在），/provider/v1/models 回 200。
  commandcode: 'https://api.commandcode.ai/alpha/billing/credits',
  commandcodeSubscriptions: 'https://api.commandcode.ai/alpha/billing/subscriptions',
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

/**
 * `GET /zen/go/v1/usage` 回的三個視窗。上游只給百分比，不給金額——
 * 文件口徑是 $12／5h、$30／週、$60／月，但那是說明文字不是回應欄位，所以這裡不換算成美元
 * （換算過的數字看起來很精確，其實是我們自己乘出來的）。
 */
const OPENCODE_WINDOWS = Object.freeze([
  Object.freeze({ key: 'rolling', id: 'opencode-5h', kind: 'rolling-5h' }),
  Object.freeze({ key: 'weekly', id: 'opencode-weekly', kind: 'weekly' }),
  Object.freeze({ key: 'monthly', id: 'opencode-monthly', kind: 'monthly' })
])

/**
 * `GET /api/usage` 的 `limits`。上游**不回重置時間**（目前只有 `monthly`），
 * 卡片那一格會顯示「未提供重置時間」——不要自己補一個算出來的時間冒充官方值。
 */
const OLLAMA_WINDOWS = Object.freeze([
  Object.freeze({ key: 'monthly', id: 'ollama-monthly', kind: 'monthly' })
])

/**
 * `GET /alpha/billing/credits` 的 `windowLimits`。跟前面兩家不同，這家給的是**真的用量與上限**
 * （`used`／`cap`，單位是 credits），所以直接餵進 used/limit，不必自己換算百分比。
 * `resetAt` 可能是 epoch 秒或毫秒；月額度則由 `credits.monthlyCredits` 與訂閱週期組成。
 */
const COMMANDCODE_WINDOWS = Object.freeze([
  Object.freeze({ key: 'fiveHour', id: 'commandcode-5h', kind: 'rolling-5h' }),
  Object.freeze({ key: 'weekly', id: 'commandcode-weekly', kind: 'weekly' })
])

const COMMANDCODE_PLAN_CREDITS = Object.freeze({
  'individual-go': 10,
  'individual-goat': 70,
  'individual-pro': 30,
  'individual-pro-v1': 80,
  'individual-max': 150,
  'individual-ultra': 300
})

module.exports = {
  COMMANDCODE_WINDOWS,
  PROVIDER_IDS,
  PROVIDER_META,
  DEFAULT_USAGE_SETTINGS,
  ENDPOINTS,
  HTTP_TIMEOUT_MS,
  API_MAX_BYTES,
  FILE_MAX_BYTES,
  CACHE_TTL_MS,
  MAX_DIAGNOSTICS,
  COMMANDCODE_PLAN_CREDITS,
  OLLAMA_WINDOWS,
  OPENCODE_WINDOWS
}
