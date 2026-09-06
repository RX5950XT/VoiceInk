'use strict'

/**
 * Tai 相容 SQLite：同一份表名與寫入規則。
 * 第一次啟動把既有 Tai `Data\` 拷進 `<userData>/screentime/`。
 */

const fs = require('fs')
const path = require('path')

const BUSY_TIMEOUT_MS = 2000
const MARKER = 'imported.json'

const CREATE_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};
PRAGMA foreign_keys = OFF;
CREATE TABLE IF NOT EXISTS "AppModels" (
  [ID] INTEGER PRIMARY KEY,
  [Name] nvarchar NULL DEFAULT '',
  [Alias] nvarchar NULL DEFAULT '',
  [Description] nvarchar NULL DEFAULT '',
  [File] nvarchar NULL DEFAULT '',
  [CategoryID] int NULL DEFAULT 0,
  [IconFile] nvarchar NULL DEFAULT '',
  [TotalTime] int NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS "CategoryModels" (
  [ID] INTEGER PRIMARY KEY,
  [Name] nvarchar NULL DEFAULT '',
  [IconFile] nvarchar NULL DEFAULT '',
  [Color] nvarchar NULL DEFAULT '',
  [IsDirectoryMath] INTEGER DEFAULT 0,
  [Directories] nvarchar NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS "DailyLogModels" (
  [ID] INTEGER PRIMARY KEY,
  [Date] datetime NULL DEFAULT '',
  [Time] int NULL DEFAULT 0,
  [AppModelID] int NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS "HoursLogModels" (
  [ID] INTEGER PRIMARY KEY,
  [DataTime] datetime NULL DEFAULT '',
  [Time] int NULL DEFAULT 0,
  [AppModelID] int NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS "WebBrowseLogModels" (
  [ID] INTEGER PRIMARY KEY,
  [UrlId] int NULL DEFAULT 0,
  [LogTime] datetime NULL DEFAULT '',
  [Duration] int NULL DEFAULT 0,
  [SiteId] int NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS "WebSiteCategoryModels" (
  [ID] INTEGER PRIMARY KEY,
  [Name] nvarchar NULL DEFAULT '',
  [IconFile] nvarchar NULL DEFAULT '',
  [Color] nvarchar NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS "WebSiteModels" (
  [ID] INTEGER PRIMARY KEY,
  [Title] nvarchar NULL DEFAULT '',
  [Domain] nvarchar NULL DEFAULT '',
  [Alias] nvarchar NULL DEFAULT '',
  [CategoryID] int NULL DEFAULT 0,
  [IconFile] nvarchar NULL DEFAULT '',
  [Duration] int NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS "WebUrlModels" (
  [ID] INTEGER PRIMARY KEY,
  [Title] nvarchar NULL DEFAULT '',
  [Url] nvarchar NULL DEFAULT '',
  [IconFile] nvarchar NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_DailyLogModels_Date_App ON DailyLogModels (Date, AppModelID);
CREATE INDEX IF NOT EXISTS idx_HoursLogModels_DataTime_App ON HoursLogModels (DataTime, AppModelID);
CREATE INDEX IF NOT EXISTS idx_WebBrowseLogModels_LogTime ON WebBrowseLogModels (LogTime);
CREATE INDEX IF NOT EXISTS idx_WebBrowseLogModels_SiteId ON WebBrowseLogModels (SiteId);
CREATE INDEX IF NOT EXISTS idx_WebBrowseLogModels_UrlId ON WebBrowseLogModels (UrlId);
CREATE INDEX IF NOT EXISTS idx_WebSiteModels_Domain ON WebSiteModels (Domain);
CREATE INDEX IF NOT EXISTS idx_WebUrlModels_Url ON WebUrlModels (Url);
CREATE INDEX IF NOT EXISTS idx_AppModels_Name ON AppModels (Name);
`

const KNOWN_TAI = [
  path.join('D:', 'Workspace', 'PG', 'Tai1.5.0.6'),
  path.join('D:', 'Workbench', 'PG', 'Tai1.5.0.6')
]

function sqliteCtor(override) {
  return override || require('node:sqlite').DatabaseSync
}

function destDir(userDataPath) {
  return path.join(userDataPath, 'screentime')
}

function destDbPath(userDataPath) {
  return path.join(destDir(userDataPath), 'data.db')
}

/** @param {string} dir */
function dataDirOf(dir) {
  const direct = path.join(dir, 'data.db')
  if (fs.existsSync(direct)) return dir
  const nested = path.join(dir, 'Data', 'data.db')
  if (fs.existsSync(nested)) return path.join(dir, 'Data')
  return ''
}

/**
 * 找本機 Tai 的 Data 資料夾。優先跑著的 Tai.exe，再試已知路徑。
 * @returns {string}
 */
function findTaiDataDir() {
  for (const root of KNOWN_TAI) {
    const data = dataDirOf(root)
    if (data) return data
  }
  try {
    const { execFileSync } = require('child_process')
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const out = execFileSync(ps, [
      '-NoProfile', '-NonInteractive', '-Command',
      '(Get-CimInstance Win32_Process -Filter "Name=\'Tai.exe\'" | Select-Object -First 1 -ExpandProperty ExecutablePath)'
    ], { windowsHide: true, timeout: 8000, encoding: 'utf8' }).trim()
    if (out) {
      const data = dataDirOf(path.dirname(out))
      if (data) return data
    }
  } catch { /* 沒裝 Tai 或沒在跑 */ }
  return ''
}

/** @param {string} fromDir @param {string} toDir */
function copyTree(fromDir, toDir) {
  if (!fromDir || !fs.existsSync(fromDir)) return
  fs.cpSync(fromDir, toDir, { recursive: true, force: false, errorOnExist: false })
}

/**
 * 把 Tai Data（含 WAL）拷到 dest。AppIcons／WebFavicons 在 Data 隔壁。
 * @param {string} dest
 * @param {string} sourceData
 */
function copyTaiFiles(dest, sourceData) {
  fs.mkdirSync(dest, { recursive: true })
  for (const name of ['data.db', 'data.db-wal', 'data.db-shm', 'data.db.version', 'AppConfig.json']) {
    const src = path.join(sourceData, name)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dest, name))
  }
  const backup = path.join(sourceData, 'backup')
  if (fs.existsSync(backup)) copyTree(backup, path.join(dest, 'backup'))
  const root = path.dirname(sourceData)
  // AppIcons 是相對路徑；WebFavicons 在庫裡是 Tai 的絕對路徑，拷了也對不到，留給原資料夾。
  copyTree(path.join(root, 'AppIcons'), path.join(dest, 'AppIcons'))
}

/**
 * @param {string} userDataPath
 * @param {{ sourceDir?: string, Database?: Function }} [opts]
 */
function ensureImported(userDataPath, opts = {}) {
  const dest = destDir(userDataPath)
  fs.mkdirSync(dest, { recursive: true })
  const dbFile = path.join(dest, 'data.db')
  if (fs.existsSync(dbFile)) {
    return { imported: false, reason: 'exists', dest, source: '' }
  }
  if (opts.import === false) {
    return { imported: false, reason: 'skipped', dest, source: '' }
  }
  const source = opts.sourceDir || findTaiDataDir()
  if (source && fs.existsSync(path.join(source, 'data.db'))) {
    copyTaiFiles(dest, source)
    fs.writeFileSync(path.join(dest, MARKER), JSON.stringify({
      source, at: new Date().toISOString()
    }))
    return { imported: true, reason: 'copied', dest, source }
  }
  return { imported: false, reason: 'empty', dest, source: '' }
}

/**
 * @param {string} userDataPath
 * @param {{ Database?: Function }} [opts]
 */
function openDb(userDataPath, opts = {}) {
  const Ctor = sqliteCtor(opts.Database)
  const dbPath = destDbPath(userDataPath)
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Ctor(dbPath)
  db.exec(CREATE_SQL)
  try { db.exec('PRAGMA wal_checkpoint(PASSIVE)') } catch { /* 新庫沒有 WAL */ }
  return db
}

function closeDb(db) {
  try { db?.close() } catch { /* 已關 */ }
}

/**
 * @param {string} dest
 * @returns {object}
 */
function readAppConfig(dest) {
  const file = path.join(dest, 'AppConfig.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return { General: { IsWebEnabled: true }, Behavior: { IsSleepWatch: true } }
  }
}

module.exports = {
  CREATE_SQL,
  destDir,
  destDbPath,
  findTaiDataDir,
  dataDirOf,
  copyTaiFiles,
  ensureImported,
  openDb,
  closeDb,
  readAppConfig
}
