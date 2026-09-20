#!/usr/bin/env node
/**
 * VoiceInk — 整機檔案總管回歸（node 直跑，不開 Electron）
 *
 * 路徑守衛、單層列目錄、新增／改名／刪／複製／搬移、UFFS pattern 消毒、
 * 三份 IPC 清單。暫存目錄自種檔案，測完刪掉。
 */

'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { tempDir, removeTree } = require('./lib/test-temp')

const ROOT = path.join(__dirname, '..')
const paths = require(path.join(ROOT, 'src/main/explorer/paths.js'))
const files = require(path.join(ROOT, 'src/main/explorer/fs.js'))
const recycle = require(path.join(ROOT, 'src/main/explorer/recycle.js'))
const uffs = require(path.join(ROOT, 'src/main/explorer/uffs.js'))
const drives = require(path.join(ROOT, 'src/main/explorer/drives.js'))

let passed = 0
let failed = 0
function ok(name, cond, detail = '') {
  if (cond) {
    passed += 1
    console.log(`  PASS ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function denies(label, run, code) {
  try {
    await run()
    ok(label, false, '沒有擋下來')
  } catch (error) {
    ok(label, error && error.code === code, `code=${error && error.code}`)
    ok(`${label} 訊息不含路徑`, !String(error.userMessage || '').includes('C:\\'), error.userMessage)
  }
}

async function main() {
console.log('\n[A] 路徑守衛 resolveAbs')
{
  ok('磁碟機絕對路徑放行', paths.resolveAbs('C:\\Windows') === 'C:\\Windows')
  ok('正斜線會正規化', paths.resolveAbs('C:/Windows').toLowerCase() === 'c:\\windows')
  await denies('拒絕相對路徑', () => paths.resolveAbs('foo\\bar'), 'BAD_PATH')
  try {
    ok('UNC 分享根放行', paths.resolveAbs('\\\\fileserver\\media') === '\\\\fileserver\\media')
  } catch (error) {
    ok('UNC 分享根放行', false, error && error.code)
  }
  try {
    ok('UNC 子路徑放行', paths.resolveAbs('\\\\fileserver\\media\\photos').toLowerCase() === '\\\\fileserver\\media\\photos')
  } catch (error) {
    ok('UNC 子路徑放行', false, error && error.code)
  }
  try {
    ok('UNC IPv4 放行', paths.resolveAbs('\\\\192.168.1.10\\share') === '\\\\192.168.1.10\\share')
  } catch (error) {
    ok('UNC IPv4 放行', false, error && error.code)
  }
  await denies('拒絕沒有分享名的 UNC', () => paths.resolveAbs('\\\\fileserver'), 'BAD_PATH')
  await denies('拒絕裝置路徑', () => paths.resolveAbs('\\\\.\\C:'), 'BAD_PATH')
  await denies('拒絕 \\\\?\\ 裝置路徑', () => paths.resolveAbs('\\\\?\\C:\\Windows'), 'BAD_PATH')
  await denies('拒絕 named pipe', () => paths.resolveAbs('\\\\fileserver\\pipe'), 'BAD_PATH')
  await denies('拒絕 ADS', () => paths.resolveAbs('C:\\foo.txt:stream'), 'BAD_PATH')
  await denies('拒絕空字串', () => paths.resolveAbs(''), 'BAD_PATH')
  await denies('拒絕 NUL', () => paths.resolveAbs('C:\\foo\0bar'), 'BAD_PATH')
}

console.log('\n[B] 受保護路徑（只擋刪／改，不擋瀏覽）')
{
  ok('磁碟根目錄受保護', paths.isProtected('C:\\') === true)
  ok('Windows 目錄本身受保護', paths.isProtected(process.env.SystemRoot || 'C:\\Windows') === true)
  ok('家目錄本身受保護', paths.isProtected(os.homedir()) === true)
  ok('家目錄底下不受保護', paths.isProtected(path.join(os.homedir(), 'Desktop')) === false)
  ok('Windows 底下檔案不受保護（權限交給 OS）', paths.isProtected(path.join(process.env.SystemRoot || 'C:\\Windows', 'notepad.exe')) === false)
}

console.log('\n[C] checkName')
{
  ok('普通名字', paths.checkName('notes.txt') === 'notes.txt')
  await denies('斜線', () => paths.checkName('a/b'), 'BAD_NAME')
  await denies('冒號', () => paths.checkName('a:b'), 'BAD_NAME')
  await denies('CON', () => paths.checkName('CON'), 'BAD_NAME')
  await denies('句點結尾', () => paths.checkName('foo.'), 'BAD_NAME')
}

console.log('\n[D] 單層列目錄與增刪改')
{
  const dir = tempDir('vi-ex-')
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'hi')
  fs.mkdirSync(path.join(dir, 'sub'))
  const listed = await files.listDir(dir)
  const names = listed.entries.map((e) => e.name).sort()
  ok('列得出自種檔案', names.includes('hello.txt') && names.includes('sub'), names.join(','))
  ok('回絕對路徑', path.isAbsolute(listed.path) && listed.entries.every((e) => path.isAbsolute(e.path)))
  ok('資料夾排在檔案前面', listed.entries[0].dir === true)

  const made = await files.createEntry(dir, 'fresh', true)
  ok('新增資料夾', fs.statSync(made.path).isDirectory())
  await denies('同名拒絕', () => files.createEntry(dir, 'fresh', true), 'EXISTS')

  const renamed = await files.renameEntry(made.path, 'renamed')
  ok('改名', fs.existsSync(renamed.path) && !fs.existsSync(made.path))
  const cased = await files.renameEntry(renamed.path, 'RENAMED')
  ok('只改大小寫也要真的改名', path.basename(cased.path) === 'RENAMED'
    && fs.readdirSync(dir).includes('RENAMED'))
  await files.renameEntry(cased.path, 'renamed')

  const copied = await files.copyEntry(path.join(dir, 'hello.txt'), renamed.path)
  ok('複製檔案', fs.existsSync(copied.path) && fs.readFileSync(copied.path, 'utf8') === 'hi')

  const destDir = await files.createEntry(dir, 'dest', true)
  const moved = await files.moveEntry(copied.path, destDir.path)
  ok('搬到另一個資料夾', fs.existsSync(moved.path) && !fs.existsSync(copied.path))

  await files.removeEntry(moved.path, { permanent: true })
  ok('刪檔', !fs.existsSync(moved.path))
  await files.removeEntry(destDir.path, { permanent: true })
  await files.removeEntry(renamed.path, { permanent: true })
  ok('刪資料夾', !fs.existsSync(renamed.path))

  const madeFile = await files.createEntry(dir, 'blank.txt', false)
  ok('新增檔案', fs.statSync(madeFile.path).isFile() && fs.readFileSync(madeFile.path).length === 0)
  await denies('同名檔案拒絕', () => files.createEntry(dir, 'blank.txt', false), 'EXISTS')

  await denies('不能刪磁碟根目錄', () => files.removeEntry('C:\\'), 'PROTECTED')
  removeTree(dir)
}

console.log('\n[E] UFFS pattern 消毒')
{
  ok('普通字串', uffs.sanitizePattern('invoice') === 'invoice')
  ok('glob', uffs.sanitizePattern('*.pdf') === '*.pdf')
  await denies('拒絕 regex 前綴', () => uffs.sanitizePattern('>.*\\.exe'), 'BAD_QUERY')
  await denies('拒絕以 - 開頭', () => uffs.sanitizePattern('--limit'), 'BAD_QUERY')
  await denies('拒絕空字串', () => uffs.sanitizePattern('   '), 'BAD_QUERY')
  const rows = uffs.parseJsonRows('[{"path":"C:\\\\Windows\\\\notepad.exe","name":"notepad.exe","size":1,"type":"file"}]')
  ok('JSON 陣列', rows.length === 1)
  const hit = uffs.sanitizeHit(rows[0])
  ok('命中只留白名單欄位', Boolean(hit && hit.path && hit.name === 'notepad.exe' && hit.dir === false))
  ok('壞路徑的命中丟掉', uffs.sanitizeHit({ path: '\\\\.\\C:\\x' }) === null)
  ok('沒分享名的 UNC 命中丟掉', uffs.sanitizeHit({ path: '\\\\server' }) === null)

  const live = uffs.parseStatusJson(JSON.stringify({
    broker: { applicable: true, installed: false },
    daemon: { running: false }
  }))
  ok('未授權時 broker.installed 是 false', live.broker.installed === false)
  ok('daemon 沒跑時 running 是 false', live.daemon.running === false)
  const ready = uffs.parseStatusJson(JSON.stringify({
    broker: { installed: true },
    daemon: { running: true, drives: [{ letter: 'C' }], stats: { total_records: 12 } }
  }))
  ok('已授權且 daemon 在跑', ready.broker.installed === true && ready.daemon.running === true && ready.daemon.records === 12)

  const admin = uffs.classifySearchError(1, 'UFFS daemon needs admin privileges to read NTFS Master File Tables.\nDaemon binary that would have been spawned:\n  C:\\Users\\you\\uffsd.exe')
  ok('沒提權要走授權', admin.kind === 'broker')
  ok('分類結果不含路徑', !JSON.stringify(admin).includes('uffsd'))
  ok('成功的搜尋不算失敗', uffs.classifySearchError(0, '').kind === 'ok')
  ok('非 0 且無提權字樣是失敗', uffs.classifySearchError(1, 'boom').kind === 'failed')

  ok('auto 關掉就不該 ensure', uffs.needsEnsure({ installed: false }, { auto: false }) === false)
  ok('沒裝就要 ensure', uffs.needsEnsure({ installed: false }, { auto: true }) === true)
  ok('broker 沒裝要 ensure', uffs.needsEnsure({
    installed: true,
    broker: { present: true, installed: false },
    daemon: { running: false }
  }, { auto: true }) === true)
  ok('已經在跑就不用', uffs.needsEnsure({
    installed: true,
    broker: { present: true, installed: true },
    daemon: { running: true }
  }, { auto: true }) === false)
  ok('broker 已裝但 daemon 沒跑仍要 ensure', uffs.needsEnsure({
    installed: true,
    broker: { present: true, installed: true },
    daemon: { running: false }
  }, { auto: true }) === true)
  ok('沒設定 userData 視為暫存', uffs.inTempUserData() === true)

  const storeMod = require(path.join(ROOT, 'src/main/explorer/store.js'))
  ok('uffsAuto 預設開', storeMod.sanitizeAuto(undefined) === true)
  ok('明示 false 才關', storeMod.sanitizeAuto(false) === false)
  ok('別的值當開', storeMod.sanitizeAuto('no') === true)
}

console.log('\n[F] 本機位置與磁碟')
{
  const parsed = drives.parseDriveInfo(JSON.stringify([
    { DeviceID: 'C:', VolumeName: '中文磁碟', Size: 100, FreeSpace: 40, DriveType: 3 },
    { DeviceID: 'bad' },
    { DeviceID: 'X:', Size: -1, FreeSpace: 20, DriveType: 4 }
  ]))
  ok('磁碟資訊只接受有效磁碟代號', parsed.length === 2)
  ok('磁碟名稱與剩餘容量保留', parsed[0].label === '中文磁碟' && parsed[0].free === 40)
  ok('容量不接受負數或超過總量', parsed[1].total === 0 && parsed[1].free === 0)
  const places = drives.listPlaces()
  ok('至少有家目錄', places.some((p) => p.id === 'home' && fs.existsSync(p.path)), JSON.stringify(places.map((p) => p.id)))
  const disks = drives.listDrives()
  ok('至少有一顆磁碟', disks.length >= 1 && /^[A-Z]$/.test(disks[0].letter), JSON.stringify(disks.map((d) => d.letter)))
}

console.log('\n[G] 複製／搬移碰撞給唯一名，不覆寫')
{
  const dir = tempDir('vi-ex-col-')
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'alpha')
  const dest = path.join(dir, 'dest')
  fs.mkdirSync(dest)
  fs.writeFileSync(path.join(dest, 'hello.txt'), 'keep-me')
  try {
    const copied = await files.copyEntry(path.join(dir, 'hello.txt'), dest)
    const destHello = path.join(dest, 'hello.txt')
    ok('碰撞後來源還在', fs.readFileSync(path.join(dir, 'hello.txt'), 'utf8') === 'alpha')
    ok('碰撞不覆寫既有檔', fs.readFileSync(destHello, 'utf8') === 'keep-me')
    ok('碰撞產出 hello (2).txt', path.basename(copied.path) === 'hello (2).txt'
      && fs.readFileSync(copied.path, 'utf8') === 'alpha', copied.path)
    const same = await files.copyEntry(path.join(dir, 'hello.txt'), dir)
    ok('同資料夾複製也給唯一名', same.path !== path.join(dir, 'hello.txt')
      && fs.existsSync(path.join(dir, 'hello.txt'))
      && fs.existsSync(same.path), same.path)
    const moved = await files.moveEntry(path.join(dir, 'hello.txt'), dest)
    ok('搬移碰撞來源消失', !fs.existsSync(path.join(dir, 'hello.txt')))
    ok('搬移不覆寫既有檔', fs.readFileSync(destHello, 'utf8') === 'keep-me')
    ok('搬移產出唯一名', moved.path !== destHello && fs.existsSync(moved.path)
      && fs.readFileSync(moved.path, 'utf8') === 'alpha', moved.path)
  } catch (error) {
    ok('複製／搬移碰撞', false, `${error && error.code}: ${error && error.message}`)
  }
  removeTree(dir)
}

console.log('\n[H] 排序是 listDir 的真實轉換（資料夾在前）')
{
  const dir = tempDir('vi-ex-sort-')
  const fileA = path.join(dir, 'a.txt')
  const fileC = path.join(dir, 'c.txt')
  const folder = path.join(dir, 'b-dir')
  fs.writeFileSync(fileC, 'x')
  fs.writeFileSync(fileA, 'xxxx')
  fs.mkdirSync(folder)
  const tOld = new Date(Date.now() - 20_000)
  const tMid = new Date(Date.now() - 10_000)
  const tNew = new Date()
  fs.utimesSync(fileC, tOld, tOld)
  fs.utimesSync(folder, tMid, tMid)
  fs.utimesSync(fileA, tNew, tNew)
  const byName = await files.listDir(dir, { sort: 'name' })
  ok('名稱：資料夾在前', byName.entries[0] && byName.entries[0].name === 'b-dir' && byName.entries[0].dir)
  ok('名稱：其餘依名', byName.entries.slice(1).map((e) => e.name).join(',') === 'a.txt,c.txt')
  const bySize = await files.listDir(dir, { sort: 'size' })
  ok('大小：資料夾在前', bySize.entries[0] && bySize.entries[0].dir)
  ok('大小：小的在前', bySize.entries.filter((e) => !e.dir).map((e) => e.name).join(',') === 'c.txt,a.txt')
  const byDate = await files.listDir(dir, { sort: 'date' })
  ok('日期：資料夾在前', byDate.entries[0] && byDate.entries[0].dir)
  ok('日期：舊的在前', byDate.entries.filter((e) => !e.dir).map((e) => e.name).join(',') === 'c.txt,a.txt')
  const bySizeDesc = await files.listDir(dir, { sort: 'size', desc: true })
  ok('大小遞減', bySizeDesc.entries.filter((e) => !e.dir).map((e) => e.name).join(',') === 'a.txt,c.txt')
  removeTree(dir)
}

console.log('\n[H2] 大於 MAX_ENTRIES 時先全資料夾排序再截斷')
{
  const dir = tempDir('vi-ex-trunc-')
  const n = files.MAX_ENTRIES + 100
  for (let i = 0; i < n; i++) {
    fs.writeFileSync(path.join(dir, `n${String(i).padStart(4, '0')}.txt`), 'x')
  }
  const bigName = 'zzzz-big.bin'
  fs.writeFileSync(path.join(dir, bigName), Buffer.alloc(64 * 1024))
  const order = fs.readdirSync(dir)
  const bigIdx = order.indexOf(bigName)
  ok(
    '大檔在 readdir 第 MAX_ENTRIES 筆之後',
    bigIdx >= files.MAX_ENTRIES,
    `idx=${bigIdx} total=${order.length}`
  )
  const listed = await files.listDir(dir, { sort: 'size', desc: true })
  const first = listed.entries.find((e) => !e.dir)
  ok(
    '按大小排序的第一筆是整個資料夾裡最大的',
    Boolean(first && first.name === bigName),
    first ? first.name : 'empty'
  )
  ok('超過上限要標 truncated', listed.truncated === true)
  ok('回傳不超過 MAX_ENTRIES', listed.entries.length === files.MAX_ENTRIES)
  removeTree(dir)
}

console.log('\n[H3] 隱藏項目啟發式與 showHidden')
{
  ok('isHiddenName 是函式', typeof files.isHiddenName === 'function')
  const hiddenFn = typeof files.isHiddenName === 'function' ? files.isHiddenName : () => false
  ok('isHiddenName .git', hiddenFn('.git') === true)
  ok('isHiddenName $RECYCLE.BIN', hiddenFn('$RECYCLE.BIN') === true)
  ok('isHiddenName NTUSER.DAT.LOG1', hiddenFn('NTUSER.DAT.LOG1') === true)
  ok('isHiddenName desktop.ini', hiddenFn('desktop.ini') === true)
  ok('isHiddenName a.txt', hiddenFn('a.txt') === false)
  ok('isHiddenName 專案.md', hiddenFn('專案.md') === false)
  ok('isHiddenName node_modules', hiddenFn('node_modules') === false)

  const dir = tempDir('vi-ex-hidden-')
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x')
  fs.writeFileSync(path.join(dir, '專案.md'), 'x')
  fs.mkdirSync(path.join(dir, 'node_modules'))
  fs.mkdirSync(path.join(dir, '.git'))
  fs.mkdirSync(path.join(dir, '$RECYCLE.BIN'))
  fs.writeFileSync(path.join(dir, 'desktop.ini'), 'x')
  fs.writeFileSync(path.join(dir, 'NTUSER.DAT.LOG1'), 'x')

  const hiddenOff = await files.listDir(dir)
  const offNames = hiddenOff.entries.map((e) => e.name)
  ok('showHidden false 濾掉 .git', !offNames.includes('.git'))
  ok('showHidden false 濾掉 $RECYCLE.BIN', !offNames.includes('$RECYCLE.BIN'))
  ok('showHidden false 濾掉 desktop.ini', !offNames.includes('desktop.ini'))
  ok('showHidden false 濾掉 NTUSER.DAT.LOG1', !offNames.includes('NTUSER.DAT.LOG1'))
  ok('showHidden false 留下 a.txt', offNames.includes('a.txt'))
  ok('showHidden false 留下 專案.md', offNames.includes('專案.md'))
  ok('showHidden false 留下 node_modules', offNames.includes('node_modules'))
  ok(
    '預設不帶 hidden 的項目 hidden=false',
    hiddenOff.entries.every((e) => e.hidden === false),
    hiddenOff.entries.map((e) => `${e.name}:${e.hidden}`).join(',')
  )

  const hiddenOn = await files.listDir(dir, { showHidden: true })
  const onNames = hiddenOn.entries.map((e) => e.name)
  ok('showHidden true 留 .git', onNames.includes('.git'))
  ok('showHidden true 留 $RECYCLE.BIN', onNames.includes('$RECYCLE.BIN'))
  ok('showHidden true 留 desktop.ini', onNames.includes('desktop.ini'))
  ok('showHidden true 留 NTUSER.DAT.LOG1', onNames.includes('NTUSER.DAT.LOG1'))
  const git = hiddenOn.entries.find((e) => e.name === '.git')
  const visible = hiddenOn.entries.find((e) => e.name === 'a.txt')
  ok('.git 帶 hidden:true', Boolean(git && git.hidden === true))
  ok('a.txt 帶 hidden:false', Boolean(visible && visible.hidden === false))
  removeTree(dir)
}

console.log('\n[I] 預設刪除進資源回收筒，可還原；永久刪除是另一支')
{
  ok('回收筒是虛擬位置不是 UNC', recycle.RECYCLE_CWD === 'recyclebin' && recycle.isRecyclePath('recyclebin'))
  const round = recycle.parseIFile(recycle.encodeIFile('C:\\Temp\\a.txt', 4, 1_700_000_000_000))
  ok('$I 中繼資料往返', Boolean(round && round.originalPath === 'C:\\Temp\\a.txt' && round.size === 4))

  const dir = tempDir('vi-ex-bin-')
  const file = path.join(dir, `gone-${Date.now()}.txt`)
  const marker = `voiceink-recycle-${Date.now()}`
  fs.writeFileSync(file, marker)
  try {
    await files.removeEntry(file)
    ok('預設刪除後原處沒了', !fs.existsSync(file))
    ok('listRecycle 是函式', typeof files.listRecycle === 'function')
    const bin = typeof files.listRecycle === 'function' ? await files.listRecycle() : { entries: [] }
    const hit = (bin.entries || []).find((e) => (
      String(e.originalPath || e.path || '').toLowerCase() === file.toLowerCase()
    ))
    ok('資源回收筒列得到剛刪的', Boolean(hit), hit ? hit.recycleKey : `entries=${(bin.entries || []).length}`)
    if (hit && typeof files.restoreEntry === 'function') {
      await files.restoreEntry(hit.recycleKey)
      ok('還原後檔案回來', fs.existsSync(file) && fs.readFileSync(file, 'utf8') === marker)
    } else {
      ok('還原後檔案回來', false, '沒有 restoreEntry')
    }
    fs.writeFileSync(file, marker)
    await files.removeEntry(file, { permanent: true })
    ok('永久刪除後原處沒了', !fs.existsSync(file))
    const bin2 = typeof files.listRecycle === 'function' ? await files.listRecycle() : { entries: [] }
    const hit2 = (bin2.entries || []).find((e) => (
      String(e.originalPath || e.path || '').toLowerCase() === file.toLowerCase()
    ))
    ok('永久刪除不進回收筒', !hit2)
    if (hit && typeof files.restoreEntry === 'function') {
      await denies('已還原的項目不能再還原', () => files.restoreEntry(hit.recycleKey), 'NOT_FOUND')
    }
  } catch (error) {
    ok('資源回收筒流程', false, `${error && error.code}: ${error && error.message}`)
  }
  try { removeTree(dir) } catch { /* 暫存 */ }
}

console.log('\n[J] 複製貼進回收筒不刪來源；剪下才丟（走 index.paste）')
{
  const Module = require('module')
  const origLoad = Module._load
  Module._load = function loadStub(request, parent, isMain) {
    if (request === 'electron') {
      return { shell: { openPath: async () => '', showItemInFolder: () => {} } }
    }
    return origLoad.apply(this, arguments)
  }
  let explorer
  try {
    explorer = require(path.join(ROOT, 'src/main/explorer/index.js'))
  } finally {
    Module._load = origLoad
  }
  const dir = tempDir('vi-ex-paste-')
  const copied = path.join(dir, `keep-${Date.now()}.txt`)
  const cut = path.join(dir, `cut-${Date.now()}.txt`)
  fs.writeFileSync(copied, 'copy-me')
  fs.writeFileSync(cut, 'cut-me')
  try {
    explorer.setClipboard([copied], 'copy')
    await denies('複製貼進回收筒拒絕', () => explorer.paste(recycle.RECYCLE_CWD), 'BAD_PATH')
    ok('複製貼進回收筒來源還在', fs.existsSync(copied) && fs.readFileSync(copied, 'utf8') === 'copy-me')
    const binBefore = await files.listRecycle()
    const sneak = (binBefore.entries || []).some((e) => (
      String(e.originalPath || '').toLowerCase() === copied.toLowerCase()
    ))
    ok('複製貼進回收筒不進筒', !sneak)

    explorer.setClipboard([cut], 'cut')
    const moved = await explorer.paste(recycle.RECYCLE_CWD)
    ok('剪下貼進回收筒來源沒了', !fs.existsSync(cut))
    ok('剪下貼進回收筒有回傳', Boolean(moved && moved.trashed && Array.isArray(moved.paths)))
    const binAfter = await files.listRecycle()
    const hit = (binAfter.entries || []).find((e) => (
      String(e.originalPath || '').toLowerCase() === cut.toLowerCase()
    ))
    ok('剪下貼進回收筒列得到', Boolean(hit), hit ? hit.recycleKey : `entries=${(binAfter.entries || []).length}`)
    if (hit) await files.restoreEntry(hit.recycleKey)

    explorer.setClipboard([copied], 'copy')
    await denies('drop copy 進回收筒拒絕', () => explorer.dropEntries([copied], recycle.RECYCLE_CWD, 'copy'), 'BAD_PATH')
    ok('drop copy 進回收筒來源還在', fs.existsSync(copied))
  } catch (error) {
    ok('貼進回收筒流程', false, `${error && error.code}: ${error && error.message}`)
  }
  try { removeTree(dir) } catch { /* 暫存 */ }
}

console.log('\n[K] Enter 在頁面快捷鍵裡（點選 rebuild 後焦點不在列上）')
{
  const pageSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/scripts/explorer-page.js'), 'utf8')
  const start = pageSrc.indexOf('function onPageKey')
  const stop = pageSrc.indexOf('\nfunction paintUffs', start)
  const body = start >= 0 ? pageSrc.slice(start, stop > start ? stop : start + 800) : ''
  ok('onPageKey 存在', /function onPageKey/.test(body))
  ok('onPageKey 處理 Enter', /e\.key === 'Enter'/.test(body))
  ok('onPageKey 的 Enter 會 openEntry', /e\.key === 'Enter'[\s\S]{0,200}openEntry/.test(body))
  ok('快捷鍵不因畫面上未開的 dialog 整頁失效', !/\.app-dialog, dialog\[open\]/.test(body) && /dialog\[open\]/.test(body))
  ok('loadDir 有 navSeq', /const seq = \+\+navSeq/.test(pageSrc) && /if \(seq !== navSeq\) return/.test(pageSrc))
  ok('監看保留選取', /onChanged[\s\S]{0,200}keepSelection:\s*true/.test(pageSrc))
  ok('回收筒不預覽原路徑', /inRecycle\(\)/.test(pageSrc) && /IMAGE_EXT|inspect\(/.test(pageSrc))
}

console.log('\n[L] 家目錄可新增子項；受保護的是家目錄本身')
{
  const home = os.homedir()
  const name = `vi-ex-home-${Date.now()}.txt`
  try {
    const made = await files.createEntry(home, name, false)
    ok('家目錄可新增檔案', fs.existsSync(made.path) && fs.statSync(made.path).isFile())
    await files.removeEntry(made.path, { permanent: true })
    ok('家目錄新增的檔案可永久刪', !fs.existsSync(made.path))
  } catch (error) {
    ok('家目錄可新增檔案', false, `${error && error.code}: ${error && error.userMessage}`)
  }
  await denies('不能刪家目錄本身', () => files.removeEntry(home), 'PROTECTED')
  await denies('不能在磁碟根目錄新增', () => files.createEntry('C:\\', `vi-ex-${Date.now()}.txt`, false), 'PROTECTED')
}

console.log('\n[M] junction 刪的是連結不是目標')
{
  const dir = tempDir('vi-ex-junc-')
  const secret = path.join(dir, 'secret')
  const link = path.join(dir, 'link')
  fs.mkdirSync(secret)
  fs.writeFileSync(path.join(secret, 'keep.txt'), 'safe')
  const { spawnSync } = require('child_process')
  const made = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'), [
    '/c', 'mklink', '/J', link, secret
  ], { windowsHide: true, encoding: 'utf8' })
  if (made.status !== 0) {
    console.log('  SKIP junction（mklink 失敗）')
    removeTree(dir)
  } else {
    const resolved = paths.resolveExisting(link)
    ok('resolveExisting 回連結路徑', resolved.toLowerCase() === link.toLowerCase(), resolved)
    try {
      await files.removeEntry(link, { permanent: true })
      ok('刪掉 junction 本身', !fs.existsSync(link))
      ok('目標資料夾還在', fs.existsSync(path.join(secret, 'keep.txt')))
    } catch (error) {
      ok('刪掉 junction 本身', false, `${error && error.code}: ${error && error.message}`)
    }
    removeTree(dir)
  }
  const tree = tempDir('vi-ex-self-')
  const nested = path.join(tree, 'tree')
  const inner = path.join(nested, 'inner')
  fs.mkdirSync(nested)
  fs.mkdirSync(inner)
  fs.writeFileSync(path.join(inner, 'x.txt'), 'x')
  await denies('不能複製進自己底下', () => files.copyEntry(nested, inner), 'BAD_PATH')
  removeTree(tree)
}

console.log('\n[N] UFFS 只認安裝目錄；checksum 缺就失敗')
{
  const tmp = tempDir('vi-ex-uffs-')
  uffs.configure(tmp)
  ok('空安裝目錄找不到 exe', uffs.findUffs() === '')
  const boxed = path.join(tmp, 'uffs')
  fs.mkdirSync(boxed)
  fs.writeFileSync(path.join(boxed, 'uffs.exe'), 'fake')
  ok('只認 userData/uffs', uffs.findUffs().toLowerCase() === path.join(boxed, 'uffs.exe').toLowerCase())
  const decoy = tempDir('vi-ex-uffs-path-')
  fs.writeFileSync(path.join(decoy, 'uffs.exe'), 'decoy')
  const prevPath = process.env.PATH
  process.env.PATH = decoy + path.delimiter + prevPath
  uffs.configure('')
  ok('不認 PATH 上的 exe', uffs.findUffs() === '')
  process.env.PATH = prevPath
  removeTree(decoy)
  ok('checksumFor 能解析', uffs.checksumFor('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  uffs-windows-x64.zip\n', 'uffs-windows-x64.zip') === 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  await denies('checksum 缺就失敗', () => uffs.verifyZipHash(
    path.join(boxed, 'uffs.exe'),
    '',
    'uffs-windows-x64.zip'
  ), 'UFFS_INSTALL')
  await denies('checksum 對不上就失敗', () => uffs.verifyZipHash(
    path.join(boxed, 'uffs.exe'),
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  uffs-windows-x64.zip\n',
    'uffs-windows-x64.zip'
  ), 'UFFS_INSTALL')
  const ensureSrc = fs.readFileSync(path.join(ROOT, 'src/main/explorer/index.js'), 'utf8')
  ok('暫存 userData 忽略 force', /inTempUserData\(\)[\s\S]{0,200}auto:\s*false/.test(ensureSrc)
    || /if\s*\(\s*uffs\.inTempUserData\(\)[\s\S]{0,180}force/.test(ensureSrc))
  const emptySrc = fs.readFileSync(path.join(ROOT, 'src/main/explorer/recycle.js'), 'utf8')
  const emptyFn = emptySrc.slice(emptySrc.indexOf('async function empty()'), emptySrc.indexOf('module.exports'))
  ok('清空不走 list 的 2000 上限', /async function empty\(\)/.test(emptyFn)
    && !emptyFn.includes('await list()') && !emptyFn.includes('2000'))
  removeTree(tmp)
}

console.log('\n[O] 搜尋結果相關度排序')
{
  let rank
  try {
    rank = require(path.join(ROOT, 'src/main/explorer/rank.js'))
    ok('rank.js 存在', typeof rank.rankHits === 'function')
  } catch (error) {
    ok('rank.js 存在', false, error.message)
  }
  if (rank && typeof rank.rankHits === 'function') {
    const hits = [
      { name: 'notes.txt', path: 'C:\\docs\\invoice-notes.txt', dir: false },
      { name: 'invoice.pdf', path: 'D:\\inbox\\invoice.pdf', dir: false },
      { name: 'invoices', path: 'C:\\docs\\invoices', dir: true },
      { name: 'other.txt', path: 'C:\\docs\\other.txt', dir: false }
    ]
    const out = rank.rankHits('invoice', hits)
    ok('檔名完全符合排第一', out[0] && out[0].name === 'invoice.pdf', out[0] && out[0].name)
    ok('檔名開頭符合排在路徑命中前面', out[1] && out[1].name === 'invoices', out[1] && out[1].name)
    ok('路徑才命中的排後面', out[out.length - 1] && out[out.length - 1].name === 'other.txt', out[out.length - 1] && out[out.length - 1].name)
    const uffsSrc = fs.readFileSync(path.join(ROOT, 'src/main/explorer/uffs.js'), 'utf8')
    ok('uffs.search 會做相關度排序', /rankHits\(/.test(uffsSrc))
  }
}

console.log('\n[P] 側欄位置消毒與合併')
{
  let placesMod
  try {
    placesMod = require(path.join(ROOT, 'src/main/explorer/places.js'))
    ok('places.js 存在', typeof placesMod.sanitizePlaces === 'function')
  } catch (error) {
    ok('places.js 存在', false, error.message)
  }
  if (placesMod) {
    const builtins = [
      { id: 'home', label: '本機', path: 'C:\\Users\\x' },
      { id: 'desktop', label: '桌面', path: 'C:\\Users\\x\\Desktop' },
      { id: 'recycle', label: '資源回收筒', path: 'recyclebin' }
    ]
    const stored = [
      { id: 'desktop', label: '桌面', path: 'C:\\Users\\x\\Desktop' },
      { id: 'nas1', label: 'NAS', path: '\\\\fileserver\\media' },
      { id: 'home', hidden: true, path: 'C:\\Users\\x' },
      { id: 'recycle', path: 'recyclebin' },
      { id: '../escape', path: 'C:\\Windows' },
      { id: 'badunc', path: '\\\\.\\C:' }
    ]
    const clean = placesMod.sanitizePlaces(stored)
    ok('自訂 NAS 可進側欄', clean.some((p) => p.id === 'nas1' && p.path === '\\\\fileserver\\media'))
    ok('非法 id 丟掉', !clean.some((p) => p.id.includes('..')))
    ok('裝置路徑丟掉', !clean.some((p) => p.id === 'badunc'))
    const merged = placesMod.mergePlaces(clean, builtins)
    ok('隱藏的內建位置不出現', !merged.some((p) => p.id === 'home'))
    ok('順序跟存檔走', merged[0] && merged[0].id === 'desktop', merged[0] && merged[0].id)
    ok('NAS 留在合併結果', merged.some((p) => p.id === 'nas1'))
    ok('磁碟代號 A 合法', placesMod.sanitizeLetter('a') === 'A')
    await denies('磁碟代號不合法', () => placesMod.sanitizeLetter('1'), 'BAD_PATH')
    await denies('磁碟代號 C 不給對應', () => placesMod.sanitizeLetter('C'), 'BAD_PATH')
  }
}

console.log('\n[R] 詳情 inspect：類型／時間／文字預覽')
{
  const dir = tempDir('vi-ex-inspect-')
  const txt = path.join(dir, 'readme.txt')
  fs.writeFileSync(txt, 'hello inspect\nsecond line\n')
  try {
    const info = await files.inspect(txt)
    ok('inspect 回檔名', info && info.name === 'readme.txt', info && info.name)
    ok('inspect 有修改時間', info && Number(info.mtimeMs) > 0)
    ok('inspect 有建立時間', info && Number(info.ctimeMs) > 0)
    ok('文字預覽含本文', info && typeof info.text === 'string' && info.text.includes('hello inspect'))
    ok('文字檔沒有圖片', info && !info.image)
    const folder = await files.inspect(dir)
    ok('資料夾 inspect 標 dir', folder && folder.dir === true)
    const lnk = Buffer.alloc(0x4C + 0x1C + 20)
    lnk[0] = 0x4C
    lnk.writeUInt32LE(0x02, 0x14)
    lnk.writeUInt32LE(0x1C + 20, 0x4C)
    lnk.writeUInt32LE(0x1C, 0x50)
    lnk.writeUInt32LE(0x1C, 0x4C + 16)
    lnk.write('C:\\app.exe\0', 0x4C + 0x1C, 'utf8')
    ok('lnk 能讀出目標', files.parseLnkTarget(lnk) === 'C:\\app.exe', files.parseLnkTarget(lnk))
  } catch (error) {
    ok('inspect 可用', false, `${error && error.code}: ${error && error.message}`)
  }
  removeTree(dir)
}

console.log('\n[S] 路徑列可輸入、詳情鈕在上、右鍵補強、側欄可改')
{
  const pageSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/scripts/explorer-page.js'), 'utf8')
  const html = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8')
  const dndSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/scripts/explorer-dnd.js'), 'utf8')
  const detailSrc = fs.existsSync(path.join(ROOT, 'src/renderer/scripts/explorer-detail.js'))
    ? fs.readFileSync(path.join(ROOT, 'src/renderer/scripts/explorer-detail.js'), 'utf8')
    : pageSrc
  ok('有路徑輸入框', html.includes('id="exPathInput"'))
  ok('Ctrl+L 進入路徑輸入', /e\.key === 'l'|e\.key === 'L'/.test(pageSrc) && /beginEditPath|editPath|exPathInput/.test(pageSrc))
  ok('命令列在上方橫排', html.includes('id="exCmdBar"') && /function paintCmdBar/.test(pageSrc))
  ok('詳情有預覽區', /previewEl\(/.test(detailSrc) && /ex-detail-preview-box/.test(detailSrc))
  ok('右鍵有複製路徑', /複製路徑/.test(dndSrc))
  ok('右鍵有建立捷徑', /建立捷徑/.test(dndSrc))
  ok('右鍵有釘到側欄', /釘到側欄/.test(dndSrc))
  ok('右鍵有重新整理', /重新整理/.test(dndSrc))
  ok('側欄有新增位置鈕', html.includes('id="exPlaceAddBtn"') || /exPlaceAddBtn/.test(pageSrc))
  ok('回收筒不預覽原路徑', /inRecycle/.test(detailSrc) && /inspect|preview|IMAGE_EXT/.test(detailSrc))
}

console.log('\n[S2] 右鍵能把資料夾加進工作區專案')
{
  const vm = require('vm')
  const dndSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/scripts/explorer-dnd.js'), 'utf8')
    .replace(/^import[\s\S]*?from '[^']+'\r?\n/gm, '')
    .replace(/^export /gm, '')
  /** @type {any[]} */
  let shown = []
  const context = { console, showMenu: (at, menu) => { shown = menu } }
  vm.createContext(context)
  vm.runInContext(dndSrc, context)
  const labels = () => shown.map((row) => row.label)
  const pick = (label) => shown.find((row) => row.label === label)

  const hits = []
  const actions = {
    open: () => {}, openTab: () => {}, paste: () => {}, cut: () => {}, copy: () => {},
    rename: () => {}, remove: () => {}, newFolder: () => {}, newFile: () => {},
    pin: () => {}, pinHere: () => {},
    openProject: () => hits.push('openProject'),
    openProjectHere: () => hits.push('openProjectHere')
  }
  context.showExplorerMenu({ x: 0, y: 0 }, { recycle: false, items: [{ name: 'repo', path: 'D:\\repo', dir: true }], actions })
  ok('單選資料夾看得到「加入工作區專案」', labels().includes('加入工作區專案'), labels().join('｜'))
  pick('加入工作區專案')?.onSelect()

  context.showExplorerMenu({ x: 0, y: 0 }, { recycle: false, items: [{ name: 'a.txt', path: 'D:\\a.txt', dir: false }], actions })
  ok('選到檔案時不出現那一項', !labels().includes('加入工作區專案'))

  context.showExplorerMenu({ x: 0, y: 0 }, { recycle: false, items: [], actions })
  ok('空白處看得到「把這個資料夾加入專案」', labels().includes('把這個資料夾加入專案'), labels().join('｜'))
  pick('把這個資料夾加入專案')?.onSelect()

  context.showExplorerMenu({ x: 0, y: 0 }, { recycle: true, items: [{ name: 'x', path: 'D:\\x', dir: true }], actions: { ...actions, restore: () => {}, purge: () => {}, empty: () => {} } })
  ok('資源回收筒裡不出現', !labels().includes('加入工作區專案'), labels().join('｜'))

  ok('兩個入口都真的叫到動作', hits.join(',') === 'openProject,openProjectHere', hits.join(','))

  const pageSrc2 = fs.readFileSync(path.join(ROOT, 'src/renderer/scripts/explorer-page.js'), 'utf8')
  ok('動作接到 workspace 模組', /openFolderAsProject/.test(pageSrc2) && /setSidebarMode\('projects'\)/.test(pageSrc2))
  ok('虛擬位置擋在外面', /openInWorkspace[\s\S]{0,200}RECYCLE_CWD, THIS_PC/.test(pageSrc2))
  const wsSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/scripts/workspace-page.js'), 'utf8')
  ok('workspace-page 有 openFolderAsProject', /export async function openFolderAsProject/.test(wsSrc))
  const preloadSrc2 = fs.readFileSync(path.join(ROOT, 'src/preload/preload.js'), 'utf8')
  ok('preload 的 addFolders 只送字串路徑', /addFolders: \(paths\)[\s\S]{0,320}typeof p === 'string'/.test(preloadSrc2))
  ok('addFolders 走既有的 workspace:addDropped', /addFolders[\s\S]{0,200}'workspace:addDropped'/.test(preloadSrc2))
}

console.log('\n[S3] 檔案拖得出去，也認得拖進來的真檔案')
{
  const vm = require('vm')
  const dndSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/scripts/explorer-dnd.js'), 'utf8')
    .replace(/^import[\s\S]*?from '[^']+'\r?\n/gm, '')
    .replace(/^export /gm, '')
  const context = { console, showMenu: () => {} }
  vm.createContext(context)
  vm.runInContext(dndSrc, context)

  const evt = (types, files, effectAllowed) => ({
    dataTransfer: { types, files, effectAllowed, dropEffect: '' }
  })
  const file = (full) => ({ name: full.split('\\').pop(), full })
  const toPath = (f) => f.full

  const two = evt(['Files'], [file('D:\\a.txt'), file('D:\\dir')], 'all')
  ok(
    '拖進來的真檔案讀得到絕對路徑',
    context.readDragPaths(two, toPath).join('|') === 'D:\\a.txt|D:\\dir',
    context.readDragPaths(two, toPath).join('|')
  )
  ok('取不到路徑就當沒有（從網頁拖圖）', context.readDragPaths(evt(['Files'], [file('')], 'all'), toPath).length === 0)
  ok('沒有 files 就是空的', context.readDragPaths(evt(['text/plain'], [], 'all'), toPath).length === 0)
  ok('沒給轉換函式不亂猜', context.readDragPaths(two, null).length === 0)

  ok('types 有 Files 就收', context.hasExplorerDrag(evt(['Files'], [], 'all')) === true)
  ok('純文字拖曳不收', context.hasExplorerDrag(evt(['text/plain'], [], 'all')) === false)

  const setEffect = (allowed, want) => {
    const e = evt(['Files'], [], allowed)
    context.setDropEffect(e, want)
    return e.dataTransfer.dropEffect
  }
  ok('來源允許 move 就 move', setEffect('copyMove', 'move') === 'move', setEffect('copyMove', 'move'))
  ok('來源只允許 copy 時退回 copy', setEffect('copy', 'move') === 'copy', setEffect('copy', 'move'))
  ok('來源沒宣告就照自己想的', setEffect('all', 'move') === 'move', setEffect('all', 'move'))

  const pageSrc3 = fs.readFileSync(path.join(ROOT, 'src/renderer/scripts/explorer-page.js'), 'utf8')
  ok(
    'dragstart 讓位給 OS 的拖放',
    /function onDragStart[\s\S]{0,400}e\.preventDefault\(\)[\s\S]{0,200}explorer\.startDrag\(/.test(pageSrc3)
  )
  ok('drop 用 getPathForFile 還原路徑', /readDragPaths\(e, electronAPI\.getPathForFile\)/.test(pageSrc3))
  ok(
    '清單空白處按一下就取消選取',
    /function onListClick[\s\S]{0,200}selected = new Set\(\)/.test(pageSrc3)
      && /addEventListener\('click', onListClick\)/.test(pageSrc3)
  )
  ok('選到列上不清掉', /function onListClick\(e\) \{\s*if \(e\.target\.closest\('\.ex-row'\)/.test(pageSrc3))

  const preloadSrc3 = fs.readFileSync(path.join(ROOT, 'src/preload/preload.js'), 'utf8')
  ok('preload 有 startDrag', /startDrag: \(list\) => ipcRenderer\.invoke\('explorer:startDrag', list\)/.test(preloadSrc3))
  const indexSrc3 = fs.readFileSync(path.join(ROOT, 'src/main/explorer/index.js'), 'utf8')
  ok('main 的 startDrag 仍過路徑守衛', /function startDrag[\s\S]{0,600}paths\.resolveExisting\(/.test(indexSrc3))
  ok('startDrag 要拿到發起的 webContents', /service\.startDrag\(list, event\.sender\)/.test(
    fs.readFileSync(path.join(ROOT, 'src/main/explorer/ipc.js'), 'utf8')
  ))
}

console.log('\n[S4] 鍵盤走得動、空白處框得出來、狀態列講得出選取')
{
  const pageSrc4 = fs.readFileSync(path.join(ROOT, 'src/renderer/scripts/explorer-page.js'), 'utf8')
  const cssSrc4 = fs.readFileSync(path.join(ROOT, 'src/renderer/styles/main.css'), 'utf8')
  ok('方向鍵有接', /ArrowUp', 'ArrowDown'/.test(pageSrc4) && /moveSelection\(e\.key, e\.shiftKey\)/.test(pageSrc4))
  ok('Home／End 也走同一支', /'Home', 'End'/.test(pageSrc4))
  ok('游標跟連選錨點是兩個變數', /let cursor = ''/.test(pageSrc4) && /let anchor = ''/.test(pageSrc4))
  ok('Shift 連選時錨點不跟著走',
    /if \(extend\)[\s\S]{0,200}anchor = at >= 0/.test(pageSrc4), '找不到 extend 分支')
  ok('方格檢視的欄數是量出來的不是寫死的', /function gridColumns[\s\S]{0,400}offsetTop/.test(pageSrc4))
  ok('框選綁在 mousedown', /addEventListener\('mousedown', onListMouseDown\)/.test(pageSrc4))
  ok('按在列上不框選（那是拖檔案）', /function onListMouseDown[\s\S]{0,200}closest\('\.ex-row'\)/.test(pageSrc4))
  ok('框選過程不重畫清單', /只就地 toggle class|classList\.toggle\('is-selected'/.test(pageSrc4))
  ok('放開才 paintList', /const onUp = \(\)[\s\S]{0,260}paintList\(\)/.test(pageSrc4))
  ok('狀態列有選取數量', /已選取 \$\{picked\.length\} 個/.test(pageSrc4))
  ok('選到資料夾不報大小', /picked\.every\(\(p\) => !p\.dir\)/.test(pageSrc4))
  ok('框的樣式在', /\.ex-marquee \{/.test(cssSrc4))
  ok('清單有定位基準', /\.ex-list \{[\s\S]{0,120}position: relative/.test(cssSrc4))
  ok('框用的是存在的 CSS 變數', /--accent-primary/.test(cssSrc4.slice(cssSrc4.indexOf('.ex-marquee'), cssSrc4.indexOf('.ex-marquee') + 400)))
}

console.log('\n[S5] 拖著停住會進資料夾、搬錯了可以 Ctrl+Z')
{
  const pageSrc5 = fs.readFileSync(path.join(ROOT, 'src/renderer/scripts/explorer-page.js'), 'utf8')
  const dndSrc5 = fs.readFileSync(path.join(ROOT, 'src/renderer/scripts/explorer-dnd.js'), 'utf8')
  ok('停留進資料夾有計時器', /HOVER_ENTER_MS/.test(dndSrc5) && /setTimeout\([\s\S]{0,120}HOVER_ENTER_MS\)/.test(dndSrc5))
  ok('離開或放手要把計時器收掉',
    /dragleave[\s\S]{0,120}stopTimer\(\)/.test(dndSrc5) && /'drop'[\s\S]{0,160}stopTimer\(\)/.test(dndSrc5))
  ok('只有資料夾那一列掛 hover', /if \(entry\.dir\) \{[\s\S]{0,320}navigate\(dest\)/.test(pageSrc5))
  ok('搜尋結果與回收筒裡不自動進去', /if \(!inSearch\(\) && !inRecycle\(\)\) void navigate\(dest\)/.test(pageSrc5))

  ok('Ctrl+Z 接到復原', /e\.ctrlKey && \(e\.key === 'z'[\s\S]{0,80}undoLast\(\)/.test(pageSrc5))
  ok('復原堆疊有上限', /MAX_UNDO = \d+/.test(pageSrc5) && /while \(undoStack\.length > MAX_UNDO\)/.test(pageSrc5))
  ok('搬移有記復原', /pushUndo\(mode === 'copy' \? '複製' : '搬移'/.test(pageSrc5))
  ok('改名有記復原', /pushUndo\(`改名/.test(pageSrc5))
  ok('貼上有記復原，而且分得出剪下跟複製',
    /lastClip\.mode === 'cut' \? undoMove/.test(pageSrc5) && /lastClip = \{ mode, paths/.test(pageSrc5))
  ok('復原「複製」是丟資源回收筒不是永久刪',
    /function undoCopy[\s\S]{0,220}RECYCLE_CWD, 'move'/.test(pageSrc5))
  ok('沒東西可復原時講一聲', /沒有可以復原的動作/.test(pageSrc5))
}

console.log('\n[S6] 隱藏／系統項目有開關')
{
  const vm = require('vm')
  const dndSrc6 = fs.readFileSync(path.join(ROOT, 'src/renderer/scripts/explorer-dnd.js'), 'utf8')
    .replace(/^import[\s\S]*?from '[^']+'\r?\n/gm, '')
    .replace(/^export /gm, '')
  let shown6 = []
  const ctx6 = { console, showMenu: (at, menu) => { shown6 = menu } }
  vm.createContext(ctx6)
  vm.runInContext(dndSrc6, ctx6)
  const labels6 = () => shown6.map((r) => r.label)
  let toggled = 0
  const acts = {
    open: () => {}, paste: () => {}, cut: () => {}, copy: () => {}, rename: () => {}, remove: () => {},
    newFolder: () => {}, newFile: () => {}, toggleHidden: () => { toggled += 1 }
  }
  ctx6.showExplorerMenu({ x: 0, y: 0 }, { recycle: false, items: [], showHidden: false, actions: acts })
  ok('空白處右鍵有「顯示隱藏項目」', labels6().includes('顯示隱藏項目'), labels6().join('｜'))
  shown6.find((r) => r.label === '顯示隱藏項目')?.onSelect()
  ok('點下去有叫到動作', toggled === 1, String(toggled))
  ctx6.showExplorerMenu({ x: 0, y: 0 }, { recycle: false, items: [], showHidden: true, actions: acts })
  ok('已經在顯示時換成「不顯示隱藏項目」', labels6().includes('不顯示隱藏項目'), labels6().join('｜'))
  ctx6.showExplorerMenu({ x: 0, y: 0 }, { recycle: false, items: [{ name: 'a.txt', path: 'D:\\a.txt', dir: false }], showHidden: false, actions: acts })
  ok('選到東西時不出現（那是資料夾層級的設定）', !labels6().includes('顯示隱藏項目'), labels6().join('｜'))

  const pageSrc6 = fs.readFileSync(path.join(ROOT, 'src/renderer/scripts/explorer-page.js'), 'utf8')
  ok('列目錄有把開關送給 main', /listDir\(dirPath, \{ sort: sortBy, desc: sortDesc, showHidden \}\)/.test(pageSrc6))
  ok('開關記得住', /saveState\(\{ showHidden \}\)/.test(pageSrc6) && /showHidden = boot\.showHidden === true/.test(pageSrc6))
  ok('隱藏的項目畫淡一點', /if \(entry\.hidden\) row\.classList\.add\('is-dim'\)/.test(pageSrc6))
  const storeSrc6 = fs.readFileSync(path.join(ROOT, 'src/main/explorer/store.js'), 'utf8')
  ok('explorer.json 存得下這個欄位',
    /showHidden: s\.get\('showHidden', false\) === true/.test(storeSrc6)
      && /s\.set\('showHidden', next\.showHidden\)/.test(storeSrc6))
  const cssSrc6 = fs.readFileSync(path.join(ROOT, 'src/renderer/styles/main.css'), 'utf8')
  ok('淡化樣式在', /\.ex-row\.is-dim/.test(cssSrc6))
  const fsMod6 = require(path.join(ROOT, 'src/main/explorer/fs.js'))
  // 這條是刻意的決定，不要「順手」改回 Unix 慣例：Windows 上點開頭沒有隱藏的意思
  ok('.gitignore／.env／.vscode 不准被當成隱藏檔',
    !fsMod6.isHiddenName('.gitignore') && !fsMod6.isHiddenName('.env') && !fsMod6.isHiddenName('.vscode'))
  ok('版本控制資料夾仍然藏著（它真的有 hidden 屬性）', fsMod6.isHiddenName('.git'))
}

console.log('\n[T] 資料夾大小')
{
  let size
  try {
    size = require(path.join(ROOT, 'src/main/explorer/size.js'))
    ok('size.js 存在', typeof size.folderSize === 'function' && typeof size.folderSizeCancel === 'function')
  } catch (error) {
    ok('size.js 存在', false, error && error.message)
  }

  if (!size || typeof size.folderSize !== 'function') {
    ok('巢狀資料夾總和算得對', false, 'size.js 不存在')
    ok('junction 不跟著走', false, 'size.js 不存在')
    ok('取消真的會停', false, 'size.js 不存在')
    ok('上限到了標記不完整', false, 'size.js 不存在')
  } else {
    const nested = tempDir('vi-ex-sz-')
    fs.mkdirSync(path.join(nested, 'sub'))
    fs.writeFileSync(path.join(nested, 'a.bin'), Buffer.alloc(1000))
    fs.writeFileSync(path.join(nested, 'sub', 'b.bin'), Buffer.alloc(1000))
    fs.writeFileSync(path.join(nested, 'sub', 'c.bin'), Buffer.alloc(1000))
    const sum = await size.folderSize(nested, 't-sum')
    ok('巢狀資料夾總和算得對', sum && sum.bytes === 3000 && sum.files === 3 && sum.incomplete !== true,
      JSON.stringify(sum))
    removeTree(nested)

    const jdir = tempDir('vi-ex-sz-junc-')
    const root = path.join(jdir, 'root')
    const outside = path.join(jdir, 'outside')
    fs.mkdirSync(root)
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(root, 'keep.bin'), Buffer.alloc(1000))
    fs.writeFileSync(path.join(outside, 'secret.bin'), Buffer.alloc(50000))
    const link = path.join(root, 'link')
    try {
      fs.symlinkSync(outside, link, 'junction')
      const jsum = await size.folderSize(root, 't-junc')
      ok('junction 不跟著走', jsum && jsum.bytes === 1000 && jsum.files === 1,
        JSON.stringify(jsum))
    } catch (error) {
      ok('junction 不跟著走', false, `${error && error.code}: ${error && error.message}`)
    }
    removeTree(jdir)

    const cdir = tempDir('vi-ex-sz-cancel-')
    fs.mkdirSync(path.join(cdir, 'deep'))
    for (let i = 0; i < 80; i += 1) {
      fs.writeFileSync(path.join(cdir, 'deep', `f${i}.bin`), Buffer.alloc(10))
    }
    const pending = size.folderSize(cdir, 't-cancel')
    size.folderSizeCancel('t-cancel')
    const stopped = await pending
    ok('取消真的會停', stopped && stopped.cancelled === true && stopped.incomplete === true,
      JSON.stringify(stopped))
    removeTree(cdir)

    const ldir = tempDir('vi-ex-sz-lim-')
    fs.writeFileSync(path.join(ldir, 'one.bin'), Buffer.alloc(1000))
    fs.writeFileSync(path.join(ldir, 'two.bin'), Buffer.alloc(1000))
    fs.writeFileSync(path.join(ldir, 'three.bin'), Buffer.alloc(1000))
    const limited = await size.folderSize(ldir, 't-lim', { maxFiles: 1 })
    ok('上限到了標記不完整', limited && limited.incomplete === true && limited.files === 1 && limited.bytes === 1000,
      JSON.stringify(limited))
    removeTree(ldir)
  }

  const detailSrcT = fs.readFileSync(path.join(ROOT, 'src/renderer/scripts/explorer-detail.js'), 'utf8')
  ok('選到資料夾先顯示計算中', /計算中/.test(detailSrcT))
  ok('算完列出檔案數', /個檔案/.test(detailSrcT))
  ok('到上限寫至少', /至少/.test(detailSrcT))
  ok('失敗顯示算不出來', /算不出來/.test(detailSrcT))
  ok('換選取會取消正在算的那次', /folderSizeCancel/.test(detailSrcT))
}

console.log('\n[S7] 縮圖 pending 會延遲重取，暫時的圖不進快取')
{
  const vm = require('vm')
  const src = fs.readFileSync(path.join(ROOT, 'src/renderer/scripts/explorer-icons.js'), 'utf8')
    .replace(/^import[\s\S]*?from '[^']+'\r?\n/gm, '')
    .replace(/^export /gm, '')
  const PNG = 'data:image/png;base64,AAA'
  const PNG2 = 'data:image/png;base64,BBB'

  function loadIcons(fileIcon) {
    /** @type {{ id: number, fn: Function, ms: number }[]} */
    const timers = []
    let nextId = 1
    const observers = []
    const context = {
      console,
      Map, Set, WeakMap, WeakSet, Math,
      setTimeout(fn, ms) {
        const id = nextId++
        timers.push({ id, fn, ms })
        return id
      },
      clearTimeout(id) {
        const i = timers.findIndex((t) => t.id === id)
        if (i >= 0) timers.splice(i, 1)
      },
      IntersectionObserver: class {
        constructor(cb) { this.cb = cb; observers.push(this) }
        observe(el) { this.cb([{ isIntersecting: true, target: el }]) }
        unobserve() {}
        disconnect() {}
      },
      document: { createElement() { return { src: '', alt: '', draggable: false } } },
      window: { electronAPI: { explorer: { fileIcon } } }
    }
    vm.createContext(context)
    vm.runInContext(src, context)
    return { context, timers, observers }
  }

  function iconEl(filePath) {
    return {
      dataset: { path: filePath },
      isConnected: true,
      textContent: '',
      child: null,
      replaceChildren(node) { this.child = node }
    }
  }
  function hostEl(els) {
    return {
      classList: { contains: (name) => name === 'is-grid' },
      querySelectorAll: () => els,
      isConnected: true
    }
  }
  const tick = () => Promise.resolve().then(() => Promise.resolve())

  {
    let calls = 0
    const el = iconEl('D:\\a.pdf')
    async function fileIcon() {
      calls += 1
      if (calls === 1) return { ok: true, data: { url: PNG, pending: true } }
      return { ok: true, data: { url: PNG2 } }
    }
    const { context, timers } = loadIcons(fileIcon)
    context.paintFileIcons(hostEl([el]), () => Promise.resolve({ ok: false }))
    await tick()
    ok('第一次會去問', calls === 1, `calls=${calls}`)
    ok('pending 排了 400ms 重試', timers.length === 1 && timers[0].ms === 400,
      timers.map((t) => t.ms).join(','))
    if (timers.length) {
      timers.shift().fn()
      await tick()
    }
    ok('(a) 真的有第二次呼叫', calls === 2, `calls=${calls}`)
    ok('第二次不是 pending 就不再排', timers.length === 0, `timers=${timers.length}`)
  }

  {
    let calls = 0
    const el = iconEl('D:\\b.pdf')
    async function fileIcon() {
      calls += 1
      return { ok: true, data: { url: PNG, pending: true } }
    }
    const { context, timers } = loadIcons(fileIcon)
    const host = hostEl([el])
    context.paintFileIcons(host, () => Promise.resolve({ ok: false }))
    await tick()
    ok('pending 第一次有叫', calls === 1, `calls=${calls}`)
    context.paintFileIcons(host, () => Promise.resolve({ ok: false }))
    await tick()
    ok('(b) pending 那張沒有被寫進快取', calls === 2, `calls=${calls}`)
    ok('換資料夾會清掉待重試', timers.length === 1 && timers[0].ms === 400,
      `timers=${timers.length}`)
  }

  {
    let calls = 0
    const el = iconEl('D:\\c.pdf')
    const delays = []
    async function fileIcon() {
      calls += 1
      return { ok: true, data: { url: PNG, pending: true } }
    }
    const { context, timers } = loadIcons(fileIcon)
    context.paintFileIcons(hostEl([el]), () => Promise.resolve({ ok: false }))
    await tick()
    while (timers.length) {
      delays.push(timers[0].ms)
      timers.shift().fn()
      await tick()
    }
    ok('(c) 最多重試 3 次就停', calls === 4, `calls=${calls}`)
    ok('退避是 400／800／1600', delays.join(',') === '400,800,1600', delays.join(','))
    ok('停了之後沒有再排隊', timers.length === 0, `timers=${timers.length}`)
  }

  {
    let calls = 0
    const el = iconEl('D:\\gone.pdf')
    async function fileIcon() {
      calls += 1
      return { ok: true, data: { url: PNG, pending: true } }
    }
    const { context, timers, observers } = loadIcons(fileIcon)
    context.paintFileIcons(hostEl([el]), () => Promise.resolve({ ok: false }))
    await tick()
    if (observers[0]) observers[0].cb([{ isIntersecting: false, target: el }])
    if (timers.length) {
      timers.shift().fn()
      await tick()
    }
    ok('捲走了就不再重取', calls === 1, `calls=${calls}`)
  }
}

console.log('\n[Q] index.js 的 exports 都有定義')
{
  const indexSource = fs.readFileSync(path.join(ROOT, 'src/main/explorer/index.js'), 'utf8')
  const block = indexSource.slice(indexSource.lastIndexOf('module.exports = {'))
  const names = [...block.matchAll(/^ {2}([A-Za-z_$][\w$]*)\s*,?\s*$/gm)].map((m) => m[1])
  ok('exports 不是空的', names.length >= 10, String(names.length))
  const missing = names.filter((name) => !new RegExp(
    `(?:^|\\n)\\s*(?:async\\s+function|function|const|let|var)\\s+${name}\\b`
  ).test(indexSource))
  ok('每個 export 都在檔案裡定義得到', missing.length === 0, missing.join(', '))
}

console.log('\n[Q2] ipc.js／main.js／preload 三份清單對得起來')
{
  const ipcSource = fs.readFileSync(path.join(ROOT, 'src/main/explorer/ipc.js'), 'utf8')
  const mainSource = fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf8')
  const preloadSource = fs.readFileSync(path.join(ROOT, 'src/preload/preload.js'), 'utf8')
  const used = [...new Set([...ipcSource.matchAll(/service\.([A-Za-z_$][\w$]*)\(/g)].map((m) => m[1]))]
  ok('ipc.js 真的有在用 service', used.length >= 10, String(used.length))
  const at = mainSource.indexOf('registerExplorerIpc({')
  const block = mainSource.slice(at, mainSource.indexOf('isMainSender', at))
  const missing = used.filter((name) => !block.includes(`${name}: (...args)`))
  ok('main.js 的 service 白名單一個都沒漏', missing.length === 0, missing.join(', '))
  const channels = [...new Set(
    [...ipcSource.matchAll(/ipcMain\.handle\('explorer:([A-Za-z_$][\w$]*)'/g)].map((m) => m[1])
  )]
  const noPreload = channels.filter((name) => !preloadSource.includes(`'explorer:${name}'`))
  ok('每一支 IPC 在 preload 都接得到', noPreload.length === 0, noPreload.join(', '))
}

console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
