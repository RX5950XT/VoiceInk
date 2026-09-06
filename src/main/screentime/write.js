'use strict'

/**
 * 寫入規則對齊 Tai Data.UpdateAppDuration / WebData.AddUrlBrowseTime。
 * 全部參數化查詢。
 */

const {
  MAX_HOUR, MAX_DAY, splitHours, splitDays, fmtHour, getDomain, getSiteName, friendlyName
} = require('./util')

function intOf(value, max) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n <= 0) return 0
  return max ? Math.min(n, max) : n
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} name
 * @param {string} filePath
 * @returns {number} app id
 */
function ensureApp(db, name, filePath) {
  const processName = String(name || '').trim()
  if (!processName) return 0
  const file = String(filePath || '')
  const row = db.prepare('SELECT ID, File, Description FROM AppModels WHERE Name = ?').get(processName)
  const label = friendlyName({ name: processName })
  if (row) {
    if (file && !row.File) {
      db.prepare('UPDATE AppModels SET File = ? WHERE ID = ?').run(file, row.ID)
    }
    if (!row.Description && label !== processName) {
      db.prepare('UPDATE AppModels SET Description = ? WHERE ID = ?').run(label, row.ID)
    }
    return row.ID
  }
  db.prepare(
    `INSERT INTO AppModels (Name, File, CategoryID, IconFile, TotalTime, Alias, Description)
     VALUES (?, ?, 0, '', 0, '', ?)`
  ).run(processName, file, label === processName ? '' : label)
  const created = db.prepare('SELECT ID FROM AppModels WHERE Name = ?').get(processName)
  return created ? created.ID : 0
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} appId
 * @param {Map<string, number>} buckets
 * @param {string} table
 * @param {string} timeCol
 * @param {number} cap
 */
function addBuckets(db, appId, buckets, table, timeCol, cap) {
  const select = db.prepare(
    `SELECT ID, Time FROM ${table} WHERE ${timeCol} = ? AND AppModelID = ?`
  )
  const insert = db.prepare(
    `INSERT INTO ${table} (${timeCol}, Time, AppModelID) VALUES (?, ?, ?)`
  )
  const update = db.prepare(`UPDATE ${table} SET Time = ? WHERE ID = ?`)
  for (const [stamp, seconds] of buckets) {
    const add = intOf(seconds, cap)
    if (!add) continue
    const row = select.get(stamp, appId)
    if (!row) insert.run(stamp, add, appId)
    else update.run(Math.min(cap, intOf(row.Time, cap) + add), row.ID)
  }
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} processName
 * @param {number} duration
 * @param {Date} startTime
 * @param {string} [filePath]
 */
function updateAppDuration(db, processName, duration, startTime, filePath) {
  const seconds = intOf(duration)
  if (!processName || seconds <= 0 || !(startTime instanceof Date) || !Number.isFinite(startTime.getTime())) {
    return 0
  }
  const hourBuckets = splitHours(startTime, seconds)
  const dayBuckets = splitDays(startTime, seconds)
  db.exec('BEGIN')
  try {
    const appId = ensureApp(db, processName, filePath)
    if (!appId) {
      db.exec('ROLLBACK')
      return 0
    }
    db.prepare('UPDATE AppModels SET TotalTime = TotalTime + ? WHERE ID = ?').run(seconds, appId)
    addBuckets(db, appId, dayBuckets, 'DailyLogModels', 'Date', MAX_DAY)
    addBuckets(db, appId, hourBuckets, 'HoursLogModels', 'DataTime', MAX_HOUR)
    db.exec('COMMIT')
    return appId
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* ignore */ }
    throw error
  }
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} url
 * @param {string} title
 */
function ensureUrl(db, url, title) {
  const row = db.prepare('SELECT ID FROM WebUrlModels WHERE Url = ?').get(url)
  if (row) {
    if (title) db.prepare('UPDATE WebUrlModels SET Title = ? WHERE ID = ?').run(title, row.ID)
    return row.ID
  }
  db.prepare('INSERT INTO WebUrlModels (Title, Url, IconFile) VALUES (?, ?, ?)').run(title || '', url, '')
  return db.prepare('SELECT ID FROM WebUrlModels WHERE Url = ?').get(url).ID
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} url
 */
function ensureSite(db, url) {
  const domain = getDomain(url)
  if (!domain) return 0
  const row = db.prepare('SELECT ID FROM WebSiteModels WHERE Domain = ?').get(domain)
  if (row) return row.ID
  const title = getSiteName(url)
  db.prepare(
    `INSERT INTO WebSiteModels (Title, Domain, Alias, CategoryID, IconFile, Duration)
     VALUES (?, ?, '', 0, '', 0)`
  ).run(title, domain)
  return db.prepare('SELECT ID FROM WebSiteModels WHERE Domain = ?').get(domain).ID
}

/**
 * 跨小時時切到下一個整點（Tai AddUrlBrowseTime）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ url: string, title: string, duration: number, activeAt: Date }} rec
 */
function addUrlBrowseTime(db, rec) {
  if (!rec?.url || rec.duration <= 0) return 0
  return addUrlAt(db, rec, rec.activeAt, intOf(rec.duration, MAX_HOUR * 24))
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ url: string, title: string }} rec
 * @param {Date} dateTime
 * @param {number} duration
 */
function addUrlAt(db, rec, dateTime, duration) {
  if (duration <= 0) return 0
  if (dateTime.getMinutes() === 59 && dateTime.getSeconds() === 59) {
    const next = new Date(dateTime.getFullYear(), dateTime.getMonth(), dateTime.getDate(), dateTime.getHours() + 1)
    return addUrlAt(db, rec, next, duration)
  }
  const logTime = new Date(dateTime.getFullYear(), dateTime.getMonth(), dateTime.getDate(), dateTime.getHours())
  const nowMax = Math.max(1, (60 - dateTime.getMinutes()) * 60)
  let nowDur = duration
  let nextDur = 0
  if (duration > MAX_HOUR) {
    nowDur = MAX_HOUR
    nextDur = duration - MAX_HOUR
  }
  if (nowDur > nowMax) {
    nextDur += nowDur - nowMax
    nowDur = nowMax
  }
  const written = writeWebSlice(db, rec, logTime, nowDur)
  if (nextDur <= 0) return written
  return written + addUrlAt(db, rec, new Date(logTime.getTime() + 3600 * 1000), nextDur)
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ url: string, title: string }} rec
 * @param {Date} logTime
 * @param {number} nowDur
 */
function writeWebSlice(db, rec, logTime, nowDur) {
  const add = intOf(nowDur, MAX_HOUR)
  if (!add) return 0
  const stamp = fmtHour(logTime)
  db.exec('BEGIN')
  try {
    const siteId = ensureSite(db, rec.url)
    const urlId = ensureUrl(db, rec.url, rec.title)
    if (!siteId || !urlId) {
      db.exec('ROLLBACK')
      return 0
    }
    const row = db.prepare(
      'SELECT ID, Duration FROM WebBrowseLogModels WHERE LogTime = ? AND UrlId = ?'
    ).get(stamp, urlId)
    if (row) {
      const next = Math.min(MAX_HOUR, intOf(row.Duration, MAX_HOUR) + add)
      db.prepare('UPDATE WebBrowseLogModels SET Duration = ? WHERE ID = ?').run(next, row.ID)
    } else {
      db.prepare(
        'INSERT INTO WebBrowseLogModels (UrlId, LogTime, Duration, SiteId) VALUES (?, ?, ?, ?)'
      ).run(urlId, stamp, add, siteId)
    }
    db.prepare('UPDATE WebSiteModels SET Duration = Duration + ? WHERE ID = ?').run(add, siteId)
    db.exec('COMMIT')
    return add
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* ignore */ }
    throw error
  }
}

module.exports = { ensureApp, updateAppDuration, addUrlBrowseTime, ensureSite, ensureUrl }
