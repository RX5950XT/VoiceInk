/**
 * 使用時長：切桶、網址、忽略清單、讀 Tai 舊庫、寫入應用／網站。
 * 用法：node scripts/test-screentime.js
 */
'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const crypto = require('crypto')
const util = require('../src/main/screentime/util')
const dbMod = require('../src/main/screentime/db')
const write = require('../src/main/screentime/write')
const stats = require('../src/main/screentime/stats')
const { createScreentimeService } = require('../src/main/screentime')
const { createWebServer, acceptKey } = require('../src/main/screentime/webserver')
const csv = require('../src/main/screentime/csv')

/** 測試不開真的前景觀測器（那會開一支 PowerShell 去讀使用者正在用的視窗）。 */
function noObserver() { throw new Error('no observer in tests') }

let failed = 0
function check(name, fn) {
  try {
    const out = fn()
    if (out && typeof out.then === 'function') {
      return out.then(() => console.log(`  ok  ${name}`)).catch((error) => {
        failed += 1
        console.log(`  FAIL ${name}`)
        console.log(`       ${error.message}`)
      })
    }
    console.log(`  ok  ${name}`)
    return Promise.resolve()
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${error.message}`)
    return Promise.resolve()
  }
}

const TAI_DATA = 'D:\\Workspace\\PG\\Tai1.5.0.6\\Data'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vi-screentime-'))
}

console.log('test-screentime')

async function main() {
  await check('跨小時切桶：50 分開始的 20 分鐘會切兩段', () => {
    const start = new Date(2026, 8, 4, 14, 50, 0)
    const hours = util.splitHours(start, 20 * 60)
    assert.strictEqual(hours.get('2026-09-04 14:00:00'), 10 * 60)
    assert.strictEqual(hours.get('2026-09-04 15:00:00'), 10 * 60)
  })

  await check('跨日切桶', () => {
    const start = new Date(2026, 8, 4, 23, 50, 0)
    const days = util.splitDays(start, 20 * 60)
    assert.strictEqual(days.get('2026-09-04 00:00:00'), 10 * 60)
    assert.strictEqual(days.get('2026-09-05 00:00:00'), 10 * 60)
  })

  await check('網域保留 www，站名 Youtube', () => {
    assert.strictEqual(util.getDomain('https://www.youtube.com/watch?v=1'), 'www.youtube.com')
    assert.strictEqual(util.getSiteName('https://www.youtube.com/watch?v=1'), 'Youtube')
    assert.strictEqual(util.getSiteName('https://github.com/Planshit/Tai'), 'Github')
  })

  await check('畫面上用常見名稱，不是進程原名', () => {
    assert.strictEqual(util.friendlyName({ name: 'msedge', description: 'Microsoft Edge' }), 'Microsoft Edge')
    assert.strictEqual(util.friendlyName({ name: 'Code', description: 'Visual Studio Code' }), 'Visual Studio Code')
    assert.strictEqual(
      util.friendlyName({ name: 'wezterm-gui', description: "WezTerm - Wez's Terminal Emulator" }),
      'WezTerm'
    )
    assert.strictEqual(util.friendlyName({ name: 'explorer' }), '檔案總管')
    assert.strictEqual(util.friendlyName({ alias: '我的瀏覽器', name: 'msedge' }), '我的瀏覽器')
  })

  await check('忽略系統行程與 Tai／VoiceInk', () => {
    assert.strictEqual(util.isIgnoredName('Tai'), true)
    assert.strictEqual(util.isIgnoredName('VoiceInk'), true)
    assert.strictEqual(util.isIgnoredName('dwm'), true)
    assert.strictEqual(util.isIgnoredName('msedge'), false)
    assert.strictEqual(util.isIgnoredName('explorer'), false)
  })

  await check('外掛 JSON 要有 http(s) 與合理秒數', () => {
    const ok = util.sanitizeWebNotify({
      Url: 'https://x.com/a', Title: 'X', Duration: 10, ActiveTime: 1757000000
    })
    assert.ok(ok)
    assert.strictEqual(ok.url, 'https://x.com/a')
    assert.strictEqual(ok.duration, 10)
    assert.strictEqual(util.sanitizeWebNotify({ Url: 'https://x.com', Duration: 0 }), null)
    assert.strictEqual(util.sanitizeWebNotify({ Url: 'file:///c:/x', Duration: 5 }), null)
    assert.strictEqual(util.sanitizeWebNotify('ping'), null)
  })

  await check('週一為週首', () => {
    const thursday = new Date(2026, 8, 3) // 2026-09-03 週四
    const bounds = util.rangeBounds('week', thursday)
    assert.strictEqual(util.fmtDay(bounds.start), '2026-08-31 00:00:00')
    assert.strictEqual(bounds.labels.length, 7)
  })

  const dir = tmpDir()
  const db = dbMod.openDb(dir)
  const start = new Date(2026, 8, 4, 10, 0, 0)

  await check('寫入應用時長會進日桶、小時桶與總時長', () => {
    const id = write.updateAppDuration(db, 'TestApp', 125, start, 'C:\\TestApp.exe')
    assert.ok(id > 0)
    const app = db.prepare('SELECT TotalTime, File FROM AppModels WHERE Name = ?').get('TestApp')
    assert.strictEqual(app.TotalTime, 125)
    assert.ok(String(app.File).includes('TestApp.exe'))
    const day = db.prepare('SELECT Time FROM DailyLogModels WHERE AppModelID = ?').get(id)
    assert.strictEqual(day.Time, 125)
    const hour = db.prepare('SELECT Time FROM HoursLogModels WHERE AppModelID = ?').get(id)
    assert.strictEqual(hour.Time, 125)
  })

  await check('同一小時再加會累加，且不超過 3600', () => {
    const id = write.updateAppDuration(db, 'TestApp', 3500, start, 'C:\\TestApp.exe')
    const hour = db.prepare('SELECT Time FROM HoursLogModels WHERE AppModelID = ?').get(id)
    assert.strictEqual(hour.Time, 3600)
    const day = db.prepare('SELECT Time FROM DailyLogModels WHERE AppModelID = ?').get(id)
    assert.strictEqual(day.Time, 125 + 3500)
  })

  await check('寫入網站時長會建站點與小時瀏覽列', () => {
    write.addUrlBrowseTime(db, {
      url: 'https://www.youtube.com/watch?v=abc',
      title: '測試影片',
      duration: 42,
      activeAt: start
    })
    const site = db.prepare('SELECT Title, Domain, Duration FROM WebSiteModels WHERE Domain = ?')
      .get('www.youtube.com')
    assert.strictEqual(site.Title, 'Youtube')
    assert.strictEqual(site.Duration, 42)
    const log = db.prepare('SELECT Duration FROM WebBrowseLogModels').get()
    assert.strictEqual(log.Duration, 42)
  })

  await check('CSV 會跳脫逗號與引號，並用 CRLF', () => {
    const text = csv.toCsv(['名稱', '備註'], [['Edge', 'a,b'], ['x', 'say "hi"']])
    assert.ok(text.includes('"a,b"'))
    assert.ok(text.includes('"say ""hi"""'))
    assert.ok(text.includes('\r\n'))
  })

  await check('匯出 CSV 含應用名稱與秒數', async () => {
    const user = tmpDir()
    const file = path.join(user, 'out.csv')
    const svc = createScreentimeService({
      userDataPath: user, spawnFn: noObserver, import: false, port: 0
    })
    svc.start()
    const when = new Date(2026, 8, 4, 10, 0, 0)
    svc.recordApp('CsvApp', 125, when, 'C:\\CsvApp.exe')
    const res = await svc.exportCsv(
      { kind: 'app', range: 'day', date: '2026-09-04' },
      { writeTo: file }
    )
    assert.strictEqual(res.saved, true)
    const text = fs.readFileSync(file, 'utf8')
    assert.ok(text.charCodeAt(0) === 0xFEFF)
    assert.ok(text.includes('CsvApp'))
    assert.ok(text.includes('125'))
    await svc.shutdown()
  })

  await check('總時長與應用數算全部，不是只算清單上那幾筆', () => {
    const user = tmpDir()
    const fresh = dbMod.openDb(user)
    const when = new Date(2026, 8, 4, 9, 0, 0)
    for (let i = 0; i < 90; i += 1) write.updateAppDuration(fresh, `App${i}`, 10, when, `C:\App${i}.exe`)
    const out = stats.queryStats(fresh, { kind: 'app', range: 'day', date: '2026-09-04' })
    assert.strictEqual(out.list.length, 80, '清單本來就只給前 80 筆')
    assert.strictEqual(out.cards.count, 90, JSON.stringify(out.cards))
    assert.strictEqual(out.cards.totalTime, 900, JSON.stringify(out.cards))
    dbMod.closeDb(fresh)
  })

  await check('統計查詢看得到剛寫的應用與網站', () => {
    const apps = stats.queryStats(db, { kind: 'app', range: 'day', date: '2026-09-04' })
    assert.ok(apps.list.some((r) => r.name === 'TestApp' && r.time >= 125))
    assert.ok(apps.cards.totalTime >= 125)
    const webs = stats.queryStats(db, { kind: 'web', range: 'day', date: '2026-09-04' })
    assert.ok(webs.list.some((r) => r.domain === 'www.youtube.com'))
    assert.ok(webs.cards.totalTime >= 42)
  })

  dbMod.closeDb(db)

  await check('讀得了本機 Tai 舊資料：應用含 msedge、網站含 Youtube', () => {
    assert.ok(fs.existsSync(path.join(TAI_DATA, 'data.db')), '找不到 Tai data.db')
    const user = tmpDir()
    const dest = path.join(user, 'screentime')
    fs.mkdirSync(dest)
    fs.copyFileSync(path.join(TAI_DATA, 'data.db'), path.join(dest, 'data.db'))
    for (const extra of ['data.db-wal', 'data.db-shm']) {
      const src = path.join(TAI_DATA, extra)
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dest, extra))
    }
    const imported = dbMod.openDb(user)
    const apps = stats.queryStats(imported, { kind: 'app', range: 'year', date: '2026-09-04' })
    const edge = apps.list.find((r) => r.name === 'msedge')
    assert.ok(edge, JSON.stringify(apps.list.slice(0, 3)))
    assert.strictEqual(edge.display, 'Microsoft Edge')
    assert.ok(apps.cards.totalTime > 1000)
    const webs = stats.queryStats(imported, { kind: 'web', range: 'year', date: '2026-09-04' })
    assert.ok(webs.list.some((r) => /youtube/i.test(r.domain) || /youtube/i.test(r.name)),
      JSON.stringify(webs.list.slice(0, 3)))
    dbMod.closeDb(imported)
  })

  await check('服務 recordApp／recordWeb 寫進自己的資料夾', () => {
    const user = tmpDir()
    const svc = createScreentimeService({
      userDataPath: user,
      spawnFn: noObserver,
      import: false,
      port: 0
    })
    svc.start()
    const when = new Date(2026, 8, 4, 11, 0, 0)
    svc.recordApp('ProbeApp', 90, when, 'C:\\ProbeApp.exe')
    svc.recordWeb({
      Url: 'https://voiceink-probe.example/test', Title: 'Probe', Duration: 15,
      ActiveTime: Math.floor(when.getTime() / 1000)
    })
    const app = svc.stats({ kind: 'app', range: 'day', date: '2026-09-04' })
    const web = svc.stats({ kind: 'web', range: 'day', date: '2026-09-04' })
    assert.ok(app.list.some((r) => r.name === 'ProbeApp' && r.time === 90))
    assert.ok(web.list.some((r) => r.domain === 'voiceink-probe.example' && r.time === 15),
      JSON.stringify(web.list.slice(0, 3)))
    return svc.shutdown()
  })

  await check('WebSocket 握手後可收外掛 JSON，忽略 ping', async () => {
    const port = await new Promise((resolve) => {
      const probe = http.createServer()
      probe.listen(0, '127.0.0.1', () => {
        const p = probe.address().port
        probe.close(() => resolve(p))
      })
    })
    const got = []
    const server = createWebServer({
      port,
      onNotify: (rec) => got.push(rec)
    })
    const started = await server.start()
    assert.strictEqual(started.ok, true, JSON.stringify(started))
    const rec = await sendWs(port, [
      'ping',
      JSON.stringify({ Url: 'https://example.com/x', Title: 'Ex', Duration: 8, ActiveTime: 1757000000 })
    ])
    await server.stop()
    assert.ok(got.length >= 1, `got ${got.length} rec=${rec}`)
    assert.strictEqual(got[0].url, 'https://example.com/x')
    assert.strictEqual(got[0].duration, 8)
  })

  console.log(failed ? `\nFAILED — ${failed}` : `\nALL PASS`)
  process.exit(failed ? 1 : 0)
}

/**
 * @param {number} port
 * @param {string[]} messages
 */
function sendWs(port, messages) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64')
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/TaiWebSentry',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key
      }
    })
    req.on('upgrade', (_res, socket) => {
      for (const text of messages) socket.write(maskText(text))
      setTimeout(() => { socket.end(); resolve('ok') }, 200)
    })
    req.on('error', reject)
    req.end()
    setTimeout(() => reject(new Error('ws timeout')), 3000)
  })
}

function maskText(text) {
  const payload = Buffer.from(text, 'utf8')
  const mask = crypto.randomBytes(4)
  const header = Buffer.alloc(2)
  header[0] = 0x81
  header[1] = 0x80 | payload.length
  const masked = Buffer.from(payload)
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4]
  return Buffer.concat([header, mask, masked])
}

void acceptKey
main()
