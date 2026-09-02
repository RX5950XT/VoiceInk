'use strict'

/**
 * Command Code（commandcode.ai）額度。
 *
 *   GET https://api.commandcode.ai/alpha/billing/credits
 *   GET https://api.commandcode.ai/alpha/billing/subscriptions
 *   Authorization: Bearer <apiKey>
 *   → { credits: { monthlyCredits, purchasedCredits, freeCredits, ... },
 *       windowLimits: { limited, exceeded,
 *                       fiveHour: { used, cap, exceeded, resetAt },
 *                       weekly:   { used, cap, exceeded, resetAt } } }
 *
 * 第一方但沒寫進文件的 `/alpha` 路由（CLI 的 `/usage` 讀的就是這幾支）。四個要點：
 *
 * - **額度在 `billing/credits`，不在 `usage/summary`**：後者回 200，但內容是這個計費週期的
 *   花費報表（`totalCost`／`totalTokens`／`periodBasis`），**一個上限欄位都沒有**。
 *   拿它當額度解析每次都 parse 不到，卡片會顯示成「0% 全新未用」——那比空白更糟。
 * - 上游給的是**真的 used／cap**（單位 credits），不是百分比，直接餵進 used/limit 就好。
 * - `resetAt` 是 **epoch 秒或毫秒**，要轉成 ISO 才進得了視窗；日期字串則原樣保留。
 * - 月額度要把 `credits.monthlyCredits`（剩餘）配上訂閱的 `planId` 與 `currentPeriodEnd`，才有總額與重置時間。
 * - `limited: false` 是正常狀態不是錯誤：加購的 credits 不受視窗限制，用完視窗會直接吃那一池。
 *
 * 這是 `/alpha` 路由，上游會動。每個欄位都當成可能不存在：`cap` 缺了或是 0 就**跳過那一格**，
 * 不要畫成 0%（畫 0% 等於宣稱「你都沒用」，是會被相信的假數字）。
 */

const { COMMANDCODE_PLAN_CREDITS, COMMANDCODE_WINDOWS, ENDPOINTS } = require('./constants')
const { resolveCommandCodeKey } = require('./api-key')
const {
  createBaseAccount,
  createWindow,
  fetchJson,
  normalizeAccount
} = require('./shared')

/**
 * epoch 秒／毫秒 → ISO 字串。已經是日期字串就原樣採用。
 * @param {unknown} value
 * @returns {string}
 */
function toIsoReset(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return ''
    const numeric = Number(trimmed)
    if (!Number.isFinite(numeric)) return trimmed
    value = numeric
  }
  const raw = Number(value)
  if (!Number.isFinite(raw) || raw <= 0) return ''
  const milliseconds = raw < 100_000_000_000 ? raw * 1000 : raw
  const date = new Date(milliseconds)
  return Number.isFinite(date.getTime()) ? date.toISOString() : ''
}

/**
 * @param {unknown} raw 單一視窗（`fiveHour`／`weekly`）
 * @param {{ id: string, kind: string }} definition
 * @returns {object | null}
 */
function buildWindow(definition, raw) {
  if (!raw || typeof raw !== 'object') return null
  const used = Number(raw.used)
  const cap = Number(raw.cap)
  if (!Number.isFinite(used) || used < 0) return null
  if (!Number.isFinite(cap) || cap <= 0) return null
  return createWindow(definition.id, '', definition.kind, Math.min(used, cap), cap, toIsoReset(raw.resetAt))
}

/**
 * @param {unknown} payload
 * @param {unknown} subscriptionPayload
 * @returns {object | null}
 */
function buildMonthlyWindow(payload, subscriptionPayload) {
  const credits = payload?.credits
  const rawData = subscriptionPayload?.success === true ? subscriptionPayload.data : null
  const data = rawData && typeof rawData === 'object' && !Array.isArray(rawData) ? rawData : null
  const planId = typeof data?.planId === 'string' ? data.planId.trim().toLowerCase() : ''
  const limit = COMMANDCODE_PLAN_CREDITS[planId]
  const remaining = Number(credits?.monthlyCredits)
  if (!Number.isFinite(limit) || !Number.isFinite(remaining) || remaining < 0) return null
  const used = Math.max(0, limit - Math.min(limit, remaining))
  return createWindow(
    'commandcode-monthly',
    '',
    'monthly',
    used,
    limit,
    toIsoReset(data.currentPeriodEnd)
  )
}

/**
 * @param {unknown} payload
 * @param {number} nowMs
 * @param {unknown} subscriptionPayload
 * @returns {object}
 */
function applyCommandCodeUsage(payload, nowMs = Date.now(), subscriptionPayload = null) {
  const account = createBaseAccount('commandcode', nowMs)
  // `windowLimits` 是目前的位置；上游若把它攤平到頂層，退回讀文件本體（多一行，換下一次改版只是降級不是空白）
  const source = payload && typeof payload === 'object'
    ? (payload.windowLimits && typeof payload.windowLimits === 'object' ? payload.windowLimits : payload)
    : null
  if (source) {
    for (const definition of COMMANDCODE_WINDOWS) {
      const window = buildWindow(definition, source[definition.key])
      if (window) account.windows.push(window)
    }
  }
  const monthly = buildMonthlyWindow(payload, subscriptionPayload)
  if (monthly) account.windows.push(monthly)
  account.accuracy = 'official'
  account.status = account.windows.length ? 'available' : 'connected'
  const hasMonthly = account.windows.some((window) => window.kind === 'monthly')
  account.notes = account.windows.length
    ? `已從 Command Code 官方端點讀取 5 小時與每週滾動視窗${hasMonthly ? '及每月額度' : ''}。`
    : 'Command Code 已連線，但沒有回傳視窗上限。'
  return normalizeAccount(account)
}

async function syncCommandCode({
  homeDir,
  env = process.env,
  nowMs = Date.now(),
  fetchImpl,
  log = () => {}
}) {
  const account = createBaseAccount('commandcode', nowMs)
  const { key, source } = await resolveCommandCodeKey({ homeDir, env })
  if (!key) {
    account.status = 'disconnected'
    account.notes = '找不到 Command Code 金鑰，請到「CC代理」頁的 Command Code 填入 API Key（或跑 cmd login）。'
    return normalizeAccount(account)
  }

  try {
    const payload = await fetchJson(ENDPOINTS.commandcode, {
      fetchImpl,
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }
    })
    let subscription = null
    try {
      subscription = await fetchJson(ENDPOINTS.commandcodeSubscriptions, {
        fetchImpl,
        retries: 1,
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }
      })
    } catch (subscriptionError) {
      log(`commandcode: subscription unavailable ${subscriptionError.status ? `HTTP ${subscriptionError.status}` : subscriptionError.code || 'unknown'}`)
    }
    const result = applyCommandCodeUsage(payload, nowMs, subscription)
    log(`commandcode: API OK key=${source} windows=${result.windows.length}`)
    return result
  } catch (error) {
    log(`commandcode: API failed ${error.status ? `HTTP ${error.status}` : error.code || 'unknown'}`)
    if (error?.status === 401 || error?.status === 403) {
      account.status = 'disconnected'
      account.notes = 'Command Code 金鑰被拒絕，請在「CC代理」頁換一把 API Key 或重跑 cmd login。'
    } else {
      account.status = 'connected'
      account.accuracy = 'estimated'
      account.notes = error?.status
        ? `Command Code 額度端點暫時無法使用（HTTP ${error.status}）。`
        : 'Command Code 額度端點暫時無法使用。'
    }
    return normalizeAccount(account)
  }
}

module.exports = {
  applyCommandCodeUsage,
  buildWindow,
  syncCommandCode,
  toIsoReset
}
