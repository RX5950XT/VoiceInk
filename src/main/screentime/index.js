'use strict'

/**
 * 使用時長服務：導入 Tai 資料、前景計時、瀏覽器外掛 WebSocket。
 * 關視窗縮到系統匣時仍繼續記。
 */

const { createObserver } = require('./observer')
const { createWebServer } = require('./webserver')
const fs = require('fs')
const path = require('path')
const dbMod = require('./db')
const write = require('./write')
const stats = require('./stats')
const csv = require('./csv')
const {
  isIgnoredName, isSystemPath, IDLE_SLEEP_MS, sanitizeWebNotify, friendlyName
} = require('./util')

const FLUSH_EVERY = 60
const RETRY_MS = 15_000

/**
 * @param {{ userDataPath: string, Database?: Function, sourceDir?: string, now?: () => Date, port?: number }} deps
 */
function createScreentimeService(deps = {}) {
  const userDataPath = deps.userDataPath
  const nowFn = deps.now || (() => new Date())
  let db = null
  let importInfo = { imported: false, reason: 'idle', dest: '', source: '' }
  let webEnabled = true
  let sleepWatch = true

  let activeName = ''
  let activePath = ''
  let activeSeconds = 0
  let activeStarted = null
  let sleeping = false

  const observer = createObserver({ onTick: handleTick, spawnFn: deps.spawnFn })
  const web = createWebServer({
    onNotify: handleWeb,
    port: deps.port,
    host: deps.host
  })
  let retryTimer = null

  function handleTick(info) {
    if (!db) return
    if (sleepWatch && info.idleMs >= IDLE_SLEEP_MS) {
      if (!sleeping) flushApp()
      sleeping = true
      return
    }
    sleeping = false
    const name = String(info.name || '')
    if (isIgnoredName(name) || isSystemPath(info.path)) {
      if (activeName) flushApp()
      return
    }
    if (name !== activeName) {
      flushApp()
      activeName = name
      activePath = info.path || ''
      activeSeconds = 0
      activeStarted = nowFn()
    }
    activeSeconds += 1
    if (activeSeconds >= FLUSH_EVERY) flushApp(true)
  }

  function flushApp(keep) {
    if (db && activeName && activeSeconds > 0 && activeStarted) {
      try {
        write.updateAppDuration(db, activeName, activeSeconds, activeStarted, activePath)
      } catch { /* 防毒鎖檔：下一輪再寫 */ }
    }
    if (keep && activeName) {
      activeSeconds = 0
      activeStarted = nowFn()
      return
    }
    activeName = ''
    activePath = ''
    activeSeconds = 0
    activeStarted = null
  }

  function handleWeb(rec) {
    if (!db || !webEnabled || !rec) return
    try { write.addUrlBrowseTime(db, rec) } catch { /* 鎖檔 */ }
  }

  function applyConfig() {
    const cfg = dbMod.readAppConfig(dbMod.destDir(userDataPath))
    webEnabled = cfg?.General?.IsWebEnabled !== false
    sleepWatch = cfg?.Behavior?.IsSleepWatch !== false
  }

  function startWeb() {
    if (!webEnabled || web.listening) return
    web.start().then((res) => {
      if (res.ok) return
      retryTimer = setTimeout(() => {
        retryTimer = null
        startWeb()
      }, RETRY_MS)
    })
  }

  function start() {
    if (!userDataPath) return status()
    importInfo = dbMod.ensureImported(userDataPath, {
      sourceDir: deps.sourceDir,
      Database: deps.Database,
      import: deps.import
    })
    if (!db) db = dbMod.openDb(userDataPath, { Database: deps.Database })
    applyConfig()
    observer.start()
    startWeb()
    watchPower()
    return status()
  }

  function watchPower() {
    try {
      const { powerMonitor } = require('electron')
      if (!powerMonitor || powerMonitor._screentimeBound) return
      powerMonitor._screentimeBound = true
      powerMonitor.on('suspend', () => flushApp())
      powerMonitor.on('lock-screen', () => flushApp())
      powerMonitor.on('resume', () => { sleeping = false })
      powerMonitor.on('unlock-screen', () => { sleeping = false })
    } catch { /* 單元測試沒有 electron */ }
  }

  function stop() {
    flushApp()
    observer.stop()
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
    return web.stop()
  }

  async function shutdown() {
    await stop()
    dbMod.closeDb(db)
    db = null
  }

  function status() {
    return {
      webEnabled,
      recording: observer.running,
      observer: observer.running,
      webListening: web.listening,
      webClients: web.clients,
      webError: web.lastError,
      imported: importInfo.imported,
      importReason: importInfo.reason,
      source: importInfo.source || '',
      dest: importInfo.dest || dbMod.destDir(userDataPath || ''),
      active: activeName || '',
      activeLabel: activeName ? friendlyName({ name: activeName }) : '',
      sleeping
    }
  }

  function getStats(q) {
    if (!db) return { kind: 'app', list: [], series: [], cards: emptyCards(), labels: [] }
    return stats.queryStats(db, q || {})
  }

  function getDrill(q) {
    if (!db) return []
    return stats.queryDrill(db, q || {})
  }

  /**
   * 匯出目前範圍的 CSV。路徑由系統存檔對話框決定，測試可傳 writeTo。
   * @param {{ kind?: string, range?: string, date?: string }} q
   * @param {{ writeTo?: string }} [opts]
   */
  async function exportCsv(q, opts = {}) {
    if (!db) db = dbMod.openDb(userDataPath, { Database: deps.Database })
    const table = stats.queryExport(db, q || {})
    const body = `\uFEFF${csv.toCsv(table.headers, table.rows)}`
    const suggested = `使用時長-${table.kind === 'web' ? '網站' : '應用'}-${table.start.slice(0, 10)}.csv`
    let out = typeof opts.writeTo === 'string' ? opts.writeTo : ''
    if (!out) {
      const { dialog, BrowserWindow } = require('electron')
      const win = BrowserWindow.getFocusedWindow()
      const result = await dialog.showSaveDialog(win || undefined, {
        title: '匯出使用時長',
        defaultPath: suggested,
        filters: [{ name: 'CSV', extensions: ['csv'] }]
      })
      if (result.canceled || !result.filePath) return { saved: false }
      out = result.filePath
    }
    if (!/\.csv$/i.test(out)) {
      const err = new Error('not csv')
      err.code = 'SCREENTIME_EXPORT'
      err.userMessage = '請存成 .csv 檔'
      throw err
    }
    fs.writeFileSync(out, body, 'utf8')
    return { saved: true, fileName: path.basename(out), rows: table.rows.length }
  }

  function openFolder() {
    const dir = dbMod.destDir(userDataPath)
    fs.mkdirSync(dir, { recursive: true })
    const { shell } = require('electron')
    return shell.openPath(dir).then((msg) => {
      if (msg) {
        const err = new Error('open failed')
        err.code = 'SCREENTIME_FOLDER'
        err.userMessage = '打不開資料夾'
        throw err
      }
      return { dirName: 'screentime' }
    })
  }

  function emptyCards() {
    return {
      totalTime: 0, totalLabel: '0 秒', count: 0,
      longestName: '—', longestTime: 0, longestLabel: '—'
    }
  }

  /** 測試用：直接寫一筆，不經前景／外掛 */
  function recordApp(name, duration, startTime, filePath) {
    if (!db) db = dbMod.openDb(userDataPath, { Database: deps.Database })
    return write.updateAppDuration(db, name, duration, startTime, filePath)
  }

  function recordWeb(raw) {
    if (!db) db = dbMod.openDb(userDataPath, { Database: deps.Database })
    const rec = sanitizeWebNotify(raw) || raw
    return write.addUrlBrowseTime(db, rec)
  }

  return {
    start, stop, shutdown, status,
    stats: getStats, drill: getDrill, exportCsv, openFolder,
    recordApp, recordWeb, handleWeb, handleTick
  }
}

module.exports = { createScreentimeService }
