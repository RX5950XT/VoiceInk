#!/usr/bin/env node
/**
 * 檔案頁 ZIP 瀏覽（src/main/explorer/zip.js）。
 * 自己組 zip 才測得到壞檔：zip-slip 名稱、CRC 不符、謊報大小、沒標 UTF-8 的 Big5 檔名；
 * 另外用 PowerShell 的 Compress-Archive 壓一份真的，確認 Windows 產出的讀得動。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { execFileSync } = require('child_process')
const { tempDir, removeTree } = require('./lib/test-temp')

const ROOT = path.join(__dirname, '..')
const zip = require(path.join(ROOT, 'src/main/explorer/zip.js'))
const files = require(path.join(ROOT, 'src/main/explorer/fs.js'))

let passed = 0
let failed = 0
function ok(name, cond, detail) {
  if (cond) { passed += 1; console.log(`  PASS ${name}`) } else { failed += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}
async function denies(name, fn, code) {
  try { await fn(); ok(name, false, '沒有拋錯') } catch (e) { ok(name, e.code === code, e.code) }
}

/**
 * @param {Array<{ name: string | Buffer, data?: string | Buffer, deflate?: boolean, utf8?: boolean, crc?: number, usize?: number }>} items
 */
function buildZip(items) {
  const locals = []
  const cens = []
  let offset = 0
  for (const it of items) {
    const name = Buffer.isBuffer(it.name) ? it.name : Buffer.from(it.name, 'utf8')
    const data = Buffer.from(it.data || '')
    const body = it.deflate ? zlib.deflateRawSync(data) : data
    const crc = it.crc !== undefined ? it.crc : zlib.crc32(data)
    const usize = it.usize !== undefined ? it.usize : data.length
    const flags = it.utf8 === false ? 0 : 0x800
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(it.deflate ? 8 : 0, 8)
    local.writeUInt32LE(crc >>> 0, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(usize, 22)
    local.writeUInt16LE(name.length, 26)
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(flags, 8)
    cen.writeUInt16LE(it.deflate ? 8 : 0, 10)
    cen.writeUInt16LE(0, 12)
    cen.writeUInt16LE((46 << 9) | (1 << 5) | 2, 14) // 2026-01-02
    cen.writeUInt32LE(crc >>> 0, 16)
    cen.writeUInt32LE(body.length, 20)
    cen.writeUInt32LE(usize, 24)
    cen.writeUInt16LE(name.length, 28)
    cen.writeUInt32LE(offset, 42)
    locals.push(local, name, body)
    cens.push(cen, name)
    offset += 30 + name.length + body.length
  }
  const cd = Buffer.concat(cens)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(items.length, 8)
  eocd.writeUInt16LE(items.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

async function main() {
  const dir = tempDir('vi-zip-')
  process.env.VOICEINK_ZIP_TEMP = path.join(dir, 'zip-temp')
  try {
    const big5 = Buffer.from([0xa4, 0xa4, 0xa4, 0xe5, 0x2e, 0x74, 0x78, 0x74]) // 「中文.txt」的 Big5
    const good = path.join(dir, 'good.zip')
    fs.writeFileSync(good, buildZip([
      { name: 'readme.txt', data: 'hello zip' },
      { name: 'docs/', data: '' },
      { name: 'docs/a.md', data: '# A\n'.repeat(500), deflate: true },
      { name: 'src/deep/b.js', data: 'console.log(1)\n', deflate: true },
      { name: '../evil.txt', data: 'pwned' },
      { name: 'C:/Windows/evil.txt', data: 'pwned' },
      { name: '空的.txt', data: '' },
      { name: big5, data: 'big5', utf8: false }
    ]))

    console.log('\n[A] 定位與清單')
    const where = await zip.locate(path.join(good, 'docs', 'a.md'))
    ok('路徑裡找得到壓縮檔與內部路徑', where && where.archive === good && where.inner === 'docs/a.md', JSON.stringify(where))
    ok('壓縮檔本身＝根目錄', (await zip.locate(good))?.inner === '')
    fs.mkdirSync(path.join(dir, 'real.zip'))
    ok('真的資料夾叫 x.zip 不算壓縮檔', (await zip.locate(path.join(dir, 'real.zip', 'x'))) === null)
    ok('沒有 .zip 字樣不去 stat', (await zip.locate('C:\\Windows\\System32')) === null)

    const top = await zip.list(good, '')
    const names = top.map((e) => e.name).sort()
    ok('根目錄列得出檔案、明寫與隱含的資料夾', JSON.stringify(names) === JSON.stringify(['docs', 'readme.txt', 'src', '中文.txt', '空的.txt'].sort()), JSON.stringify(names))
    ok('zip-slip 名稱整個丟掉', !names.some((n) => n.includes('evil')) && !names.includes('..') && !names.includes('C:'))
    const readme = top.find((e) => e.name === 'readme.txt')
    ok('項目欄位跟一般清單一樣', readme && readme.size === 9 && readme.ext === 'txt' && readme.dir === false &&
      readme.path === `${good}\\readme.txt` && readme.mtimeMs > 0, JSON.stringify(readme))
    ok('隱含資料夾是資料夾', top.find((e) => e.name === 'src')?.dir === true)
    const deep = await zip.list(good, 'src')
    ok('往下一層列得出隱含資料夾', deep.length === 1 && deep[0].name === 'deep' && deep[0].dir)
    await denies('不存在的內部資料夾', () => zip.list(good, 'nope'), 'NOT_FOUND')
    await denies('不是 zip 的檔案', async () => {
      fs.writeFileSync(path.join(dir, 'fake.zip'), 'not a zip')
      await zip.list(path.join(dir, 'fake.zip'), '')
    }, 'BAD_ZIP')

    console.log('\n[B] 解壓縮')
    const out = path.join(dir, 'out')
    fs.mkdirSync(out)
    const landed = await zip.extract(good, ['docs', 'readme.txt', '空的.txt'], out, files.uniqueDest)
    ok('資料夾與檔案都解得出來', fs.readFileSync(path.join(out, 'docs', 'a.md'), 'utf8') === '# A\n'.repeat(500) &&
      fs.readFileSync(path.join(out, 'readme.txt'), 'utf8') === 'hello zip', JSON.stringify(landed))
    ok('空檔案解得出來', fs.statSync(path.join(out, '空的.txt')).size === 0)
    ok('修改時間照壓縮檔', new Date(fs.statSync(path.join(out, 'readme.txt')).mtimeMs).getFullYear() === 2026)
    const again = await zip.extract(good, ['docs', 'readme.txt'], out, files.uniqueDest)
    ok('撞名產生 (2)，不覆寫', again.some((p) => path.basename(p) === 'docs (2)') &&
      again.some((p) => path.basename(p) === 'readme (2).txt') && fs.existsSync(path.join(out, 'docs (2)', 'a.md')), JSON.stringify(again))
    const all = path.join(dir, 'all')
    fs.mkdirSync(all)
    await zip.extract(good, [''], all, files.uniqueDest)
    ok('整包解開，深層資料夾也在', fs.existsSync(path.join(all, 'src', 'deep', 'b.js')) && fs.existsSync(path.join(all, '中文.txt')))
    ok('zip-slip 沒有寫到外面', !fs.existsSync(path.join(dir, 'evil.txt')) && !fs.existsSync(path.join(all, 'evil.txt')))
    const temp = await zip.extractTemp(good, 'docs/a.md')
    ok('開檔用的暫存副本在暫存資料夾', temp.startsWith(zip.tempRoot()) && fs.readFileSync(temp, 'utf8').startsWith('# A'), temp)
    ok('stat 回得出大小', (await zip.stat(good, 'readme.txt')).size === 9 && (await zip.stat(good, 'src')).dir === true)

    console.log('\n[C] 壞檔')
    const badCrc = path.join(dir, 'crc.zip')
    fs.writeFileSync(badCrc, buildZip([{ name: 'x.txt', data: 'abc', crc: 123 }]))
    await denies('CRC 不符拒絕', () => zip.extract(badCrc, ['x.txt'], out, files.uniqueDest), 'BAD_ZIP')
    ok('CRC 不符不留半成品', !fs.existsSync(path.join(out, 'x.txt')) && !fs.existsSync(path.join(out, 'x.txt.part')))
    const liar = path.join(dir, 'liar.zip')
    fs.writeFileSync(liar, buildZip([{ name: 'bomb.txt', data: 'A'.repeat(100000), deflate: true, usize: 10 }]))
    await denies('解出來比宣告大就中止', () => zip.extract(liar, ['bomb.txt'], out, files.uniqueDest), 'BAD_ZIP')

    console.log('\n[E] 接到檔案總管門面')
    {
      const Module = require('node:module')
      const load = Module._load
      Module._load = function (name) { return name === 'electron' ? {} : load.apply(this, arguments) }
      const explorer = require(path.join(ROOT, 'src/main/explorer'))
      Module._load = load
      const listed = await explorer.listDir(path.join(good, 'docs'))
      ok('listDir 走得進壓縮檔裡的資料夾', listed.archive === good && listed.entries.some((e) => e.name === 'a.md' && e.zip), JSON.stringify(listed.entries.map((e) => e.name)))
      const opened = await explorer.openPath(good)
      ok('點 .zip＝走進去', opened && opened.dir === true && opened.path === good)
      const info = await explorer.inspect(path.join(good, 'readme.txt'))
      ok('詳情讀得到壓縮檔裡的內容', info.zip && info.size === 9 && String(info.text).includes('hello zip'), JSON.stringify({ size: info.size, text: info.text }))
      ok('路徑列打得進壓縮檔裡', (await explorer.resolvePath(path.join(good, 'src', 'deep'))).dir === true)
      const pasteTo = path.join(dir, 'paste-to')
      fs.mkdirSync(pasteTo)
      const clip = await explorer.setClipboard([path.join(good, 'readme.txt'), path.join(good, 'src')], 'cut')
      ok('從壓縮檔剪下一律當複製', clip.mode === 'copy')
      const pasted = await explorer.paste(pasteTo)
      ok('貼上＝解壓縮', fs.existsSync(path.join(pasteTo, 'readme.txt')) && fs.existsSync(path.join(pasteTo, 'src', 'deep', 'b.js')) && pasted.paths.length === 2, JSON.stringify(pasted.paths))
      ok('壓縮檔本身沒被動到', (await zip.list(good, '')).some((e) => e.name === 'readme.txt'))
      await denies('貼進壓縮檔裡拒絕', () => explorer.paste(path.join(good, 'docs')), 'READ_ONLY')
      const whole = await explorer.extract([good])
      ok('全部解壓縮＝壓縮檔旁邊的同名資料夾', whole.paths[0] === path.join(dir, 'good') && fs.existsSync(path.join(dir, 'good', 'docs', 'a.md')), JSON.stringify(whole.paths))
      const twice = await explorer.extract([good])
      ok('再解一次不覆寫', twice.paths[0] === path.join(dir, 'good (2)'), JSON.stringify(twice.paths))
      await denies('不是壓縮檔的不解', () => explorer.extract([path.join(dir, 'out')]), 'BAD_PATH')
    }

    console.log('\n[D] Windows 壓出來的真檔')
    const srcDir = path.join(dir, 'ps-src')
    fs.mkdirSync(path.join(srcDir, '子資料夾'), { recursive: true })
    fs.writeFileSync(path.join(srcDir, '子資料夾', '說明.txt'), '這是內容\n'.repeat(1000))
    const psZip = path.join(dir, 'ps.zip')
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-Command',
        `Compress-Archive -Path '${srcDir}\\*' -DestinationPath '${psZip}'`], { stdio: 'ignore' })
      const listed = await zip.list(psZip, '子資料夾')
      ok('中文檔名讀得出來', listed.length === 1 && listed[0].name === '說明.txt', JSON.stringify(listed.map((e) => e.name)))
      const psOut = path.join(dir, 'ps-out')
      fs.mkdirSync(psOut)
      await zip.extract(psZip, ['子資料夾/說明.txt'], psOut, files.uniqueDest)
      ok('內容一字不差', fs.readFileSync(path.join(psOut, '說明.txt'), 'utf8') === '這是內容\n'.repeat(1000))
    } catch (error) {
      ok('Compress-Archive 產出的讀得動', false, error.message)
    }
  } finally {
    removeTree(dir)
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
