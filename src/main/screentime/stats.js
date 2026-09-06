'use strict'

/**
 * 統計查詢：應用／網站、日週月年、分類、最常使用、時段下鑽。
 * renderer 只拿彙總，原始 URL 會截斷。
 */

const { fmtHour, fmtDay, rangeBounds, formatDuration, friendlyName } = require('./util')

const LIST_LIMIT = 80

function stampDay(d) { return fmtDay(d) }
function stampEnd(d) { return fmtHour(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23)) }

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ kind: 'app'|'web', range: 'day'|'week'|'month'|'year', date: string }} q
 */
function queryStats(db, q) {
  const kind = q?.kind === 'web' ? 'web' : 'app'
  const range = ['day', 'week', 'month', 'year'].includes(q?.range) ? q.range : 'day'
  const cursor = q?.date ? new Date(`${q.date}T00:00:00`) : new Date()
  const bounds = rangeBounds(range, Number.isFinite(cursor.getTime()) ? cursor : new Date())
  const start = stampDay(bounds.start)
  const end = range === 'day' ? stampEnd(bounds.start) : stampDay(bounds.end).slice(0, 10) + ' 23:59:59'
  if (kind === 'web') return webStats(db, range, bounds, start, end)
  return appStats(db, range, bounds, start, end)
}

function appStats(db, range, bounds, start, end) {
  const list = db.prepare(`
    SELECT a.ID AS id, a.Name AS name, a.Alias AS alias, a.Description AS description,
           a.CategoryID AS categoryId, a.IconFile AS iconFile, SUM(d.Time) AS time
    FROM DailyLogModels d
    JOIN AppModels a ON a.ID = d.AppModelID
    WHERE d.Date >= ? AND d.Date <= ? AND d.AppModelID != 0
    GROUP BY a.ID
    ORDER BY time DESC
    LIMIT ${LIST_LIMIT}
  `).all(start, end)

  const series = range === 'day'
    ? hourSeries(db, start, end)
    : range === 'year'
      ? monthSeries(db, bounds.start.getFullYear())
      : daySeries(db, bounds)

  const categories = db.prepare(`
    SELECT COALESCE(c.ID, 0) AS id, COALESCE(c.Name, '未分類') AS name,
           SUM(d.Time) AS time
    FROM DailyLogModels d
    JOIN AppModels a ON a.ID = d.AppModelID
    LEFT JOIN CategoryModels c ON c.ID = a.CategoryID
    WHERE d.Date >= ? AND d.Date <= ? AND d.AppModelID != 0
    GROUP BY COALESCE(c.ID, 0)
    ORDER BY time DESC
  `).all(start, end)

  // 總時長／應用數要算全部，不能拿 LIMIT 80 的清單加總（週月年很容易超過）
  const sum = db.prepare(`
    SELECT COUNT(DISTINCT d.AppModelID) AS count, SUM(d.Time) AS time
    FROM DailyLogModels d
    JOIN AppModels a ON a.ID = d.AppModelID
    WHERE d.Date >= ? AND d.Date <= ? AND d.AppModelID != 0
  `).get(start, end)
  const total = sum?.time || 0
  const longest = list[0] || null
  return {
    kind: 'app',
    range,
    start,
    end,
    labels: bounds.labels,
    series,
    categories: categories.map(rowOut),
    list: list.map(rowOut),
    cards: {
      totalTime: total,
      totalLabel: formatDuration(total),
      count: sum?.count || 0,
      longestName: displayName(longest),
      longestTime: longest ? longest.time : 0,
      longestLabel: longest ? formatDuration(longest.time) : '—'
    }
  }
}

function webStats(db, range, bounds, start, end) {
  const list = db.prepare(`
    SELECT s.ID AS id, s.Title AS name, s.Domain AS domain, s.Alias AS alias,
           s.CategoryID AS categoryId, s.IconFile AS iconFile, SUM(l.Duration) AS time
    FROM WebBrowseLogModels l
    JOIN WebSiteModels s ON s.ID = l.SiteId
    WHERE l.LogTime >= ? AND l.LogTime <= ? AND l.SiteId != 0
    GROUP BY s.ID
    ORDER BY time DESC
    LIMIT ${LIST_LIMIT}
  `).all(start, end)

  const series = range === 'day'
    ? webHourSeries(db, start, end)
    : range === 'year'
      ? webMonthSeries(db, bounds.start.getFullYear())
      : webDaySeries(db, bounds)

  const categories = db.prepare(`
    SELECT COALESCE(c.ID, 0) AS id, COALESCE(c.Name, '未分類') AS name,
           SUM(l.Duration) AS time
    FROM WebBrowseLogModels l
    JOIN WebSiteModels s ON s.ID = l.SiteId
    LEFT JOIN WebSiteCategoryModels c ON c.ID = s.CategoryID
    WHERE l.LogTime >= ? AND l.LogTime <= ? AND l.SiteId != 0
    GROUP BY COALESCE(c.ID, 0)
    ORDER BY time DESC
  `).all(start, end)

  const pages = db.prepare(`
    SELECT COUNT(DISTINCT UrlId) AS n FROM WebBrowseLogModels
    WHERE LogTime >= ? AND LogTime <= ?
  `).get(start, end)
  const sum = db.prepare(`
    SELECT COUNT(DISTINCT l.SiteId) AS count, SUM(l.Duration) AS time
    FROM WebBrowseLogModels l
    JOIN WebSiteModels s ON s.ID = l.SiteId
    WHERE l.LogTime >= ? AND l.LogTime <= ? AND l.SiteId != 0
  `).get(start, end)
  const total = sum?.time || 0
  const longest = list[0] || null
  return {
    kind: 'web',
    range,
    start,
    end,
    labels: bounds.labels,
    series,
    categories: categories.map(rowOut),
    list: list.map(rowOut),
    cards: {
      totalTime: total,
      totalLabel: formatDuration(total),
      count: sum?.count || 0,
      pages: pages?.n || 0,
      longestName: displayName(longest),
      longestTime: longest ? longest.time : 0,
      longestLabel: longest ? formatDuration(longest.time) : '—'
    }
  }
}

function hourSeries(db, start, end) {
  const rows = db.prepare(`
    SELECT DataTime AS t, SUM(Time) AS time FROM HoursLogModels
    WHERE DataTime >= ? AND DataTime <= ? GROUP BY DataTime
  `).all(start, end)
  return fillHours(rows, start)
}

function webHourSeries(db, start, end) {
  const rows = db.prepare(`
    SELECT LogTime AS t, SUM(Duration) AS time FROM WebBrowseLogModels
    WHERE LogTime >= ? AND LogTime <= ? GROUP BY LogTime
  `).all(start, end)
  return fillHours(rows, start)
}

function fillHours(rows, startDay) {
  const map = new Map(rows.map((r) => [String(r.t).slice(0, 19), r.time]))
  const base = new Date(startDay.slice(0, 10) + 'T00:00:00')
  return Array.from({ length: 24 }, (_, i) => {
    const stamp = fmtHour(new Date(base.getFullYear(), base.getMonth(), base.getDate(), i))
    return map.get(stamp) || 0
  })
}

function daySeries(db, bounds) {
  const rows = db.prepare(`
    SELECT Date AS t, SUM(Time) AS time FROM DailyLogModels
    WHERE Date >= ? AND Date <= ? GROUP BY Date
  `).all(stampDay(bounds.start), stampDay(bounds.end))
  return fillDays(rows, bounds)
}

function webDaySeries(db, bounds) {
  const rows = db.prepare(`
    SELECT substr(LogTime, 1, 10) AS t, SUM(Duration) AS time FROM WebBrowseLogModels
    WHERE LogTime >= ? AND LogTime <= ? GROUP BY substr(LogTime, 1, 10)
  `).all(stampDay(bounds.start), stampDay(bounds.end).slice(0, 10) + ' 23:59:59')
  return fillDays(rows, bounds)
}

function fillDays(rows, bounds) {
  const map = new Map(rows.map((r) => [String(r.t).slice(0, 10), r.time]))
  const out = []
  const cursor = new Date(bounds.start)
  const last = startOfDate(bounds.end)
  while (cursor <= last) {
    const key = `${cursor.getFullYear()}-${pad2(cursor.getMonth() + 1)}-${pad2(cursor.getDate())}`
    out.push(map.get(key) || 0)
    cursor.setDate(cursor.getDate() + 1)
  }
  return out
}

function monthSeries(db, year) {
  const start = `${year}-01-01 00:00:00`
  const end = `${year}-12-31 23:59:59`
  const rows = db.prepare(`
    SELECT substr(Date, 1, 7) AS t, SUM(Time) AS time FROM DailyLogModels
    WHERE Date >= ? AND Date <= ? GROUP BY substr(Date, 1, 7)
  `).all(start, end)
  return fillMonths(rows, year)
}

function webMonthSeries(db, year) {
  const start = `${year}-01-01 00:00:00`
  const end = `${year}-12-31 23:59:59`
  const rows = db.prepare(`
    SELECT substr(LogTime, 1, 7) AS t, SUM(Duration) AS time FROM WebBrowseLogModels
    WHERE LogTime >= ? AND LogTime <= ? GROUP BY substr(LogTime, 1, 7)
  `).all(start, end)
  return fillMonths(rows, year)
}

function fillMonths(rows, year) {
  const map = new Map(rows.map((r) => [String(r.t).slice(0, 7), r.time]))
  return Array.from({ length: 12 }, (_, i) => map.get(`${year}-${pad2(i + 1)}`) || 0)
}

function pad2(n) { return n < 10 ? `0${n}` : String(n) }
function startOfDate(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()) }

function displayName(row) {
  return friendlyName(row)
}

function rowOut(row) {
  return {
    id: row.id,
    name: row.name || '',
    alias: row.alias || '',
    description: row.description || '',
    domain: row.domain || '',
    categoryId: row.categoryId || 0,
    time: row.time || 0,
    label: formatDuration(row.time || 0),
    display: displayName(row)
  }
}

/**
 * 點某一小時：該時段各應用／網站時長。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ kind: 'app'|'web', stamp: string }} q
 */
function queryDrill(db, q) {
  const stamp = String(q?.stamp || '')
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:00:00$/.test(stamp)) return []
  if (q?.kind === 'web') {
    return db.prepare(`
      SELECT s.ID AS id, s.Title AS name, s.Domain AS domain, s.Alias AS alias,
             SUM(l.Duration) AS time
      FROM WebBrowseLogModels l
      JOIN WebSiteModels s ON s.ID = l.SiteId
      WHERE l.LogTime = ?
      GROUP BY s.ID ORDER BY time DESC LIMIT ${LIST_LIMIT}
    `).all(stamp).map(rowOut)
  }
  return db.prepare(`
    SELECT a.ID AS id, a.Name AS name, a.Alias AS alias, a.Description AS description, h.Time AS time
    FROM HoursLogModels h
    JOIN AppModels a ON a.ID = h.AppModelID
    WHERE h.DataTime = ?
    ORDER BY h.Time DESC LIMIT ${LIST_LIMIT}
  `).all(stamp).map(rowOut)
}

/**
 * 匯出目前選取範圍的明細（不分頁）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ kind: 'app'|'web', range: 'day'|'week'|'month'|'year', date: string }} q
 */
function queryExport(db, q) {
  const kind = q?.kind === 'web' ? 'web' : 'app'
  const range = ['day', 'week', 'month', 'year'].includes(q?.range) ? q.range : 'day'
  const cursor = q?.date ? new Date(`${q.date}T00:00:00`) : new Date()
  const bounds = rangeBounds(range, Number.isFinite(cursor.getTime()) ? cursor : new Date())
  const start = stampDay(bounds.start)
  const end = range === 'day' ? stampEnd(bounds.start) : stampDay(bounds.end).slice(0, 10) + ' 23:59:59'
  if (kind === 'web') {
    const rows = db.prepare(`
      SELECT l.LogTime AS time, s.Title AS name, s.Alias AS alias, s.Domain AS domain,
             u.Url AS url, l.Duration AS seconds
      FROM WebBrowseLogModels l
      JOIN WebUrlModels u ON u.ID = l.UrlId
      JOIN WebSiteModels s ON s.ID = l.SiteId
      WHERE l.LogTime >= ? AND l.LogTime <= ?
      ORDER BY l.LogTime, l.ID
    `).all(start, end)
    return {
      kind,
      start,
      end,
      headers: ['時間', '網站', '網址', '秒數', '時長'],
      rows: rows.map((r) => [
        r.time,
        friendlyName({ name: r.name, alias: r.alias, domain: r.domain }),
        r.url,
        r.seconds || 0,
        formatDuration(r.seconds || 0)
      ])
    }
  }
  const rows = db.prepare(`
    SELECT d.Date AS day, a.Name AS name, a.Alias AS alias, a.Description AS description,
           d.Time AS seconds
    FROM DailyLogModels d
    JOIN AppModels a ON a.ID = d.AppModelID
    WHERE d.Date >= ? AND d.Date <= ? AND d.AppModelID != 0
    ORDER BY d.Date, d.Time DESC
  `).all(start, end)
  return {
    kind,
    start,
    end,
    headers: ['日期', '名稱', '進程', '秒數', '時長'],
    rows: rows.map((r) => [
      String(r.day).slice(0, 10),
      friendlyName(r),
      r.name,
      r.seconds || 0,
      formatDuration(r.seconds || 0)
    ])
  }
}

module.exports = { queryStats, queryDrill, queryExport }
