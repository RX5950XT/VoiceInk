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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-ex-'))
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
  fs.rmSync(dir, { recursive: true, force: true })
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
  const places = drives.listPlaces()
  ok('至少有家目錄', places.some((p) => p.id === 'home' && fs.existsSync(p.path)), JSON.stringify(places.map((p) => p.id)))
  const disks = drives.listDrives()
  ok('至少有一顆磁碟', disks.length >= 1 && /^[A-Z]$/.test(disks[0].letter), JSON.stringify(disks.map((d) => d.letter)))
}

console.log('\n[G] 複製／搬移碰撞給唯一名，不覆寫')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-ex-col-'))
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
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('\n[H] 排序是 listDir 的真實轉換（資料夾在前）')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-ex-sort-'))
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
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('\n[I] 預設刪除進資源回收筒，可還原；永久刪除是另一支')
{
  ok('回收筒是虛擬位置不是 UNC', recycle.RECYCLE_CWD === 'recyclebin' && recycle.isRecyclePath('recyclebin'))
  const round = recycle.parseIFile(recycle.encodeIFile('C:\\Temp\\a.txt', 4, 1_700_000_000_000))
  ok('$I 中繼資料往返', Boolean(round && round.originalPath === 'C:\\Temp\\a.txt' && round.size === 4))

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-ex-bin-'))
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
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 暫存 */ }
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-ex-paste-'))
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
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 暫存 */ }
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-ex-junc-'))
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
    fs.rmSync(dir, { recursive: true, force: true })
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
    fs.rmSync(dir, { recursive: true, force: true })
  }
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-ex-self-'))
  const nested = path.join(tree, 'tree')
  const inner = path.join(nested, 'inner')
  fs.mkdirSync(nested)
  fs.mkdirSync(inner)
  fs.writeFileSync(path.join(inner, 'x.txt'), 'x')
  await denies('不能複製進自己底下', () => files.copyEntry(nested, inner), 'BAD_PATH')
  fs.rmSync(tree, { recursive: true, force: true })
}

console.log('\n[N] UFFS 只認安裝目錄；checksum 缺就失敗')
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-ex-uffs-'))
  uffs.configure(tmp)
  ok('空安裝目錄找不到 exe', uffs.findUffs() === '')
  const boxed = path.join(tmp, 'uffs')
  fs.mkdirSync(boxed)
  fs.writeFileSync(path.join(boxed, 'uffs.exe'), 'fake')
  ok('只認 userData/uffs', uffs.findUffs().toLowerCase() === path.join(boxed, 'uffs.exe').toLowerCase())
  const decoy = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-ex-uffs-path-'))
  fs.writeFileSync(path.join(decoy, 'uffs.exe'), 'decoy')
  const prevPath = process.env.PATH
  process.env.PATH = decoy + path.delimiter + prevPath
  uffs.configure('')
  ok('不認 PATH 上的 exe', uffs.findUffs() === '')
  process.env.PATH = prevPath
  fs.rmSync(decoy, { recursive: true, force: true })
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
  fs.rmSync(tmp, { recursive: true, force: true })
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-ex-inspect-'))
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
  fs.rmSync(dir, { recursive: true, force: true })
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
