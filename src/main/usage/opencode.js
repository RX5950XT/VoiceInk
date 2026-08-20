'use strict'

const fs = require('fs')
const path = require('path')
const {
  DEFAULT_USAGE_SETTINGS,
  OPENCODE_WINDOWS
} = require('./constants')
const {
  createBaseAccount,
  createWindow,
  normalizeAccount
} = require('./shared')

function calculateNextWeeklyReset(config, nowMs) {
  const now = new Date(nowMs)
  if (!Number.isFinite(now.getTime())) return ''
  const targetDay = Number(config?.day)
  const hour = Number(config?.hour)
  const minute = Number(config?.minute)
  if (![targetDay, hour, minute].every(Number.isInteger)) return ''

  let daysUntil = (targetDay - now.getUTCDay() + 7) % 7
  const candidate = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + daysUntil,
    hour,
    minute,
    0,
    0
  )
  if (candidate <= nowMs) daysUntil += 7
  return new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + daysUntil,
    hour,
    minute,
    0,
    0
  )).toISOString()
}

function calculateNextMonthlyReset(config, nowMs) {
  const now = new Date(nowMs)
  if (!Number.isFinite(now.getTime())) return ''
  const day = Number(config?.day)
  const hour = Number(config?.hour)
  const minute = Number(config?.minute)
  if (![day, hour, minute].every(Number.isInteger)) return ''

  let year = now.getUTCFullYear()
  let month = now.getUTCMonth()
  const thisMonthDay = Math.min(day, new Date(Date.UTC(year, month + 1, 0)).getUTCDate())
  let candidate = Date.UTC(year, month, thisMonthDay, hour, minute, 0, 0)
  if (candidate <= nowMs) {
    month += 1
    if (month > 11) {
      month = 0
      year += 1
    }
    const nextDay = Math.min(day, new Date(Date.UTC(year, month + 1, 0)).getUTCDate())
    candidate = Date.UTC(year, month, nextDay, hour, minute, 0, 0)
  }
  return new Date(candidate).toISOString()
}

function queryCost(db, sinceMs) {
  const row = db.prepare(`select coalesce(sum(json_extract(data, '$.cost')), 0) as cost
    from part
    where json_extract(data, '$.type') = 'step-finish'
      and time_created >= ?`).get(sinceMs)
  const cost = Number(row?.cost)
  if (!Number.isFinite(cost)) throw new Error('invalid cost')
  return cost
}

function queryLatestReset(db, sinceMs, widthMs) {
  const row = db.prepare(`select max(time_created) as latest
    from part
    where json_extract(data, '$.type') = 'step-finish'
      and time_created >= ?`).get(sinceMs)
  const latest = Number(row?.latest)
  if (!Number.isFinite(latest)) return ''
  const timestampMs = latest > 1_000_000_000_000 ? latest : latest * 1000
  return new Date(timestampMs + widthMs).toISOString()
}

function applyOpenCodeWindows(account, db, settings, nowMs, log) {
  for (const definition of OPENCODE_WINDOWS) {
    const sinceMs = nowMs - definition.widthMs
    const used = queryCost(db, sinceMs)
    let resetAt = ''
    if (definition.kind === 'rolling-5h') {
      resetAt = queryLatestReset(db, sinceMs, definition.widthMs)
    } else if (definition.kind === 'weekly') {
      resetAt = calculateNextWeeklyReset(settings.opencodeWeeklyReset, nowMs)
    } else {
      resetAt = calculateNextMonthlyReset(settings.opencodeMonthlyReset, nowMs)
    }
    log(`opencode: ${definition.id} used=${used.toFixed(2)} reset=${resetAt ? 'set' : 'missing'}`)
    account.windows.push(createWindow(
      definition.id,
      '',
      definition.kind,
      used,
      definition.limit,
      resetAt
    ))
  }
}

async function syncOpenCode({ homeDir, settings = {}, nowMs = Date.now(), log = () => {}, Database }) {
  const account = createBaseAccount('opencode-go', nowMs)
  const dbPath = path.join(homeDir, '.local', 'share', 'opencode', 'opencode.db')
  if (!fs.existsSync(dbPath)) {
    account.status = 'disconnected'
    account.notes = '找不到 OpenCode 本機資料庫。'
    return normalizeAccount(account)
  }

  const safeSettings = {
    opencodeWeeklyReset: settings.opencodeWeeklyReset || DEFAULT_USAGE_SETTINGS.opencodeWeeklyReset,
    opencodeMonthlyReset: settings.opencodeMonthlyReset || DEFAULT_USAGE_SETTINGS.opencodeMonthlyReset
  }
  account.status = 'available'
  account.accuracy = 'local'
  account.notes = '本機 opencode.db 成本估算（非官方額度）；包含所有經 OpenCode 的 provider 用量。'

  let db
  try {
    const DatabaseCtor = Database || require('node:sqlite').DatabaseSync
    db = new DatabaseCtor(dbPath, {
      open: true,
      readOnly: true,
      allowExtension: false,
      timeout: 2000
    })
    applyOpenCodeWindows(account, db, safeSettings, nowMs, log)
  } catch (error) {
    log(`opencode: read-only query failed ${error?.code || error?.name || 'unknown'}`)
    account.windows = []
    account.notes = 'OpenCode 本機資料庫暫時無法讀取；若有快取將顯示上次成功資料。'
  } finally {
    try { db?.close() } catch { /* already closed */ }
  }
  return normalizeAccount(account)
}

module.exports = {
  applyOpenCodeWindows,
  calculateNextMonthlyReset,
  calculateNextWeeklyReset,
  queryCost,
  queryLatestReset,
  syncOpenCode
}
