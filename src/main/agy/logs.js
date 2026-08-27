'use strict'

const path = require('path')

/**
 * 流量日誌與統計（`<userData>/agy-logs.db`）。
 *
 * node:sqlite 只有同步 API，跑在 main process 上。單列寫入是次毫秒等級可以接受，
 * 但**所有操作都要能失敗**：Windows 防毒偶爾會鎖住 db 檔，日誌寫不進去絕不能連帶
 * 讓使用者的請求失敗——記錄是次要的，代理本身才是主要的。
 */

const BUSY_TIMEOUT_MS = 2000
const MAX_BODY_CHARS = 8192
const MAX_LIST_LIMIT = 500
const PROTOCOLS = new Set(['openai', 'anthropic'])

let db = null
let dbPath = ''
let lastError = ''

function sqliteCtor(override) {
  return override || require('node:sqlite').DatabaseSync
}

/** @param {{ userDataPath: string, Database?: Function }} options */
function init(options = {}) {
  if (db) return true
  try {
    const Ctor = sqliteCtor(options.Database)
    dbPath = path.join(options.userDataPath, 'agy-logs.db')
    db = new Ctor(dbPath)
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};
      CREATE TABLE IF NOT EXISTS request_logs (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        protocol TEXT NOT NULL,
        path TEXT NOT NULL,
        status INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        model TEXT,
        mapped_model TEXT,
        stream INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        thought_tokens INTEGER NOT NULL DEFAULT 0,
        cached_tokens INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        request_body TEXT,
        response_body TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_logs_ts ON request_logs (ts DESC);
    `)
    lastError = ''
    return true
  } catch (error) {
    db = null
    lastError = error?.code || 'DB_OPEN_FAILED'
    return false
  }
}

function close() {
  try { db?.close() } catch { /* 已關閉或鎖住 */ }
  db = null
}

function truncate(value) {
  if (typeof value !== 'string' || !value) return null
  return value.length > MAX_BODY_CHARS ? `${value.slice(0, MAX_BODY_CHARS)}…（已截斷）` : value
}

function intOf(value) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
}

/**
 * 寫一列。任何失敗都吞掉，只留 lastError 給診斷用。
 * @returns {boolean} 是否寫入成功
 */
function append(entry) {
  if (!db) return false
  try {
    db.prepare(`INSERT INTO request_logs
      (id, ts, protocol, path, status, duration_ms, model, mapped_model, stream,
       input_tokens, output_tokens, thought_tokens, cached_tokens,
       error_code, request_body, response_body)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      String(entry.id),
      intOf(entry.ts),
      PROTOCOLS.has(entry.protocol) ? entry.protocol : 'openai',
      String(entry.path || '').slice(0, 200),
      intOf(entry.status),
      intOf(entry.durationMs),
      entry.model ? String(entry.model).slice(0, 120) : null,
      entry.mappedModel ? String(entry.mappedModel).slice(0, 120) : null,
      entry.stream ? 1 : 0,
      intOf(entry.inputTokens),
      intOf(entry.outputTokens),
      intOf(entry.thoughtTokens),
      intOf(entry.cachedTokens),
      entry.errorCode ? String(entry.errorCode).slice(0, 60) : null,
      truncate(entry.requestBody),
      truncate(entry.responseBody)
    )
    return true
  } catch (error) {
    lastError = error?.code || 'DB_WRITE_FAILED'
    return false
  }
}

function rowToLog(row) {
  return {
    id: row.id,
    ts: row.ts,
    protocol: row.protocol,
    path: row.path,
    status: row.status,
    durationMs: row.duration_ms,
    model: row.model || '',
    mappedModel: row.mapped_model || '',
    stream: row.stream === 1,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    thoughtTokens: row.thought_tokens,
    cachedTokens: row.cached_tokens,
    errorCode: row.error_code || '',
    requestBody: row.request_body || '',
    responseBody: row.response_body || ''
  }
}

/**
 * @param {{ limit?: number, protocol?: string, onlyErrors?: boolean }} query
 * @returns {{ logs: object[], total: number }}
 */
function list(query = {}) {
  if (!db) return { logs: [], total: 0 }
  const limit = Math.max(1, Math.min(MAX_LIST_LIMIT, Number(query.limit) || 200))
  const conditions = []
  const params = []
  if (PROTOCOLS.has(query.protocol)) {
    conditions.push('protocol = ?')
    params.push(query.protocol)
  }
  if (query.onlyErrors) conditions.push('status >= 400')
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  try {
    const logs = db.prepare(
      `SELECT * FROM request_logs ${where} ORDER BY ts DESC LIMIT ?`
    ).all(...params, limit).map(rowToLog)
    const total = db.prepare(`SELECT COUNT(*) AS n FROM request_logs ${where}`).get(...params)?.n || 0
    return { logs, total }
  } catch (error) {
    lastError = error?.code || 'DB_READ_FAILED'
    return { logs: [], total: 0 }
  }
}

/**
 * 統計時間範圍白名單。renderer 只送 key，小時數與分桶一律由這裡決定——
 * 讓 renderer 指定小時數或分桶格式，等於把 SQL 的一部分交給前端。
 */
const STAT_RANGES = Object.freeze({
  '6h': { hours: 6, bucket: 'hour' },
  '24h': { hours: 24, bucket: 'hour' },
  '7d': { hours: 24 * 7, bucket: 'day' },
  '30d': { hours: 24 * 30, bucket: 'day' },
  all: { hours: 0, bucket: 'day' }
})
const DEFAULT_STAT_RANGE = '24h'
const MAX_BUCKETS = 96
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/** 桶起點（本機時區）→ 要跟 SQL 的 strftime localtime 逐字元對得上，補零才接得回去 */
function bucketKey(date, bucket) {
  const pad = (n) => String(n).padStart(2, '0')
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return bucket === 'hour' ? `${day} ${pad(date.getHours())}:00` : day
}

/**
 * SQL 只會回「有資料的桶」。直接畫等於把 3 個小時的資料攤成整條時間軸，
 * 看起來像 24 小時都很忙——補零之後長條圖的疏密才是真的。
 */
function fillSeries(rows, from, to, bucket) {
  const byPeriod = new Map(rows.map((row) => [row.period, row]))
  const cursor = new Date(from)
  if (bucket === 'hour') cursor.setMinutes(0, 0, 0)
  else cursor.setHours(0, 0, 0, 0)

  const stepMs = bucket === 'hour' ? HOUR_MS : DAY_MS
  const series = []
  while (cursor.getTime() <= to && series.length < MAX_BUCKETS) {
    const period = bucketKey(cursor, bucket)
    const row = byPeriod.get(period)
    series.push({
      period,
      start: cursor.getTime(),
      requests: Number(row?.requests) || 0,
      tokens: Number(row?.tokens) || 0
    })
    cursor.setTime(cursor.getTime() + stepMs)
  }
  return series
}

/**
 * 統計。時間分組一律用 localtime——用 UTC 會讓非 UTC 時區的圖表整條錯位。
 * summary／series／models 三者套同一個 cutoff，否則卡片講的是「全部時間」、
 * 圖表講的是「近 24 小時」，同一個面板兩種口徑。
 *
 * @param {{ range?: string }} query
 */
function stats(query = {}) {
  const rangeKey = Object.prototype.hasOwnProperty.call(STAT_RANGES, query?.range)
    ? query.range
    : DEFAULT_STAT_RANGE
  const { hours, bucket } = STAT_RANGES[rangeKey]
  const to = Date.now()
  const empty = {
    range: rangeKey,
    bucket,
    from: to,
    to,
    summary: { requests: 0, success: 0, errors: 0, input: 0, output: 0, thought: 0, cached: 0 },
    series: [],
    models: []
  }
  if (!db) return empty

  try {
    let from = to - hours * HOUR_MS
    if (!hours) {
      // 「全部」也要有下限，否則一筆三年前的日誌會讓 X 軸拉成三年
      const earliest = Number(db.prepare('SELECT MIN(ts) AS ts FROM request_logs').get()?.ts)
      from = Math.max(Number.isFinite(earliest) ? earliest : to, to - MAX_BUCKETS * DAY_MS)
    }

    const summary = db.prepare(`SELECT
        COUNT(*) AS requests,
        COALESCE(SUM(CASE WHEN status < 400 THEN 1 ELSE 0 END), 0) AS success,
        COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS errors,
        COALESCE(SUM(input_tokens), 0) AS input,
        COALESCE(SUM(output_tokens), 0) AS output,
        COALESCE(SUM(thought_tokens), 0) AS thought,
        COALESCE(SUM(cached_tokens), 0) AS cached
      FROM request_logs WHERE ts >= ?`).get(from) || empty.summary

    const format = bucket === 'hour' ? '%Y-%m-%d %H:00' : '%Y-%m-%d'
    const rows = db.prepare(`SELECT
        strftime('${format}', ts / 1000, 'unixepoch', 'localtime') AS period,
        COUNT(*) AS requests,
        COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens
      FROM request_logs
      WHERE ts >= ?
      GROUP BY period ORDER BY period ASC`).all(from)

    const models = db.prepare(`SELECT
        COALESCE(NULLIF(mapped_model, ''), '未知') AS model,
        COUNT(*) AS requests,
        COALESCE(SUM(input_tokens), 0) AS input,
        COALESCE(SUM(output_tokens), 0) AS output
      FROM request_logs
      WHERE ts >= ?
      GROUP BY model ORDER BY requests DESC LIMIT 8`).all(from)

    return { range: rangeKey, bucket, from, to, summary, series: fillSeries(rows, from, to, bucket), models }
  } catch (error) {
    lastError = error?.code || 'DB_READ_FAILED'
    return empty
  }
}

/** 依保留天數清理；回傳刪除列數 */
function cleanup(retentionDays) {
  if (!db) return 0
  const days = Math.max(1, Math.min(365, Number(retentionDays) || 30))
  try {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    return db.prepare('DELETE FROM request_logs WHERE ts < ?').run(cutoff).changes || 0
  } catch (error) {
    lastError = error?.code || 'DB_WRITE_FAILED'
    return 0
  }
}

function clear() {
  if (!db) return false
  try {
    db.exec('DELETE FROM request_logs')
    return true
  } catch (error) {
    lastError = error?.code || 'DB_WRITE_FAILED'
    return false
  }
}

/** 給診斷用：只回代碼與路徑存在與否，不回完整路徑 */
function health() {
  return { ready: !!db, lastError }
}

module.exports = {
  MAX_BODY_CHARS,
  STAT_RANGES,
  append,
  cleanup,
  clear,
  close,
  health,
  init,
  list,
  stats
}
