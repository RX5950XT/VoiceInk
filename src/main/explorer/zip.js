'use strict'

/**
 * 檔案頁的 ZIP 瀏覽（唯讀）。
 *
 * 路徑長得跟資料夾一樣：`C:\下載\a.zip\docs\readme.txt`＝a.zip 裡的 `docs/readme.txt`。
 * 只讀中央目錄就列得出清單，不整包解開；要開檔／拖出去／貼上時才解那幾個檔案。
 *
 * 沒有第三方套件：stored（0）與 deflate（8）兩種壓縮法就涵蓋 Windows「傳送到壓縮資料夾」、
 * 7-Zip／WinRAR 預設產出的 .zip；其餘（加密、deflate64、lzma…）明講不支援。
 *
 * 安全：entry 名稱是外部輸入——含 `..`、絕對路徑、磁碟代號的直接丟掉（zip-slip）；
 * 解出來的位元組超過宣告的大小就中止（壓縮炸彈謊報大小）；CRC 對不上就刪掉半成品。
 */

const fs = require('../raw-fs')
const fsp = fs.promises
const path = require('path')
const os = require('os')
const zlib = require('zlib')
const crypto = require('crypto')
const { Transform } = require('stream')
const { pipeline } = require('stream/promises')
const paths = require('./paths')

const SIG_EOCD = 0x06054b50
const SIG_EOCD64 = 0x06064b50
const SIG_LOC64 = 0x07064b50
const SIG_CEN = 0x02014b50
const SIG_LOCAL = 0x04034b50
/** 中央目錄最多讀多大、最多幾筆（幾十萬檔的壓縮檔清單也才幾十 MB） */
const MAX_CD_BYTES = 64 * 1024 * 1024
const MAX_ENTRIES = 200000
/** 一次解壓縮的總量上限（照宣告的大小先算，超過整批拒絕） */
const MAX_EXTRACT_BYTES = 16 * 1024 * 1024 * 1024
const CACHE_SIZE = 4

/** @type {Map<string, { size: number, mtimeMs: number, entries: object[] }>} */
const cache = new Map()

/** 沒標 UTF-8 的舊壓縮檔用系統語系的舊編碼（Windows「壓縮資料夾」就是這樣存的） */
const LEGACY_BY_LOCALE = { 'zh-TW': 'big5', 'zh-HK': 'big5', 'zh-CN': 'gbk', ja: 'shift_jis', ko: 'euc-kr' }

function legacyDecoder() {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale || ''
  const label = LEGACY_BY_LOCALE[locale] || LEGACY_BY_LOCALE[locale.split('-')[0]] || 'windows-1252'
  try {
    return new TextDecoder(label)
  } catch {
    return new TextDecoder('windows-1252')
  }
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true })
let legacy = null

function decodeName(bytes, utf8Flag) {
  if (utf8Flag) return bytes.toString('utf8')
  try {
    return utf8Strict.decode(bytes)
  } catch {
    legacy = legacy || legacyDecoder()
    return legacy.decode(bytes)
  }
}

/** 路徑看起來像在壓縮檔裡（便宜的字面檢查，真的要算數得再 `locate`） */
function looksZip(full) {
  return /\.zip(\\|\/|$)/i.test(String(full || ''))
}

/**
 * 找出路徑裡那個 .zip 檔。真的資料夾叫 `x.zip` 的就不是。
 * @param {string} full 已經過 resolveAbs 的絕對路徑
 * @returns {Promise<{ archive: string, inner: string } | null>}
 */
async function locate(full) {
  if (!looksZip(full)) return null
  const segments = String(full).split(/[\\/]/)
  for (let i = 1; i < segments.length; i += 1) {
    if (!/\.zip$/i.test(segments[i])) continue
    const archive = segments.slice(0, i + 1).join('\\')
    let st
    try {
      st = await fsp.stat(archive)
    } catch {
      return null
    }
    if (st.isDirectory()) continue
    if (!st.isFile()) return null
    return { archive, inner: segments.slice(i + 1).filter(Boolean).join('/') }
  }
  return null
}

async function readAt(fd, position, length) {
  const buf = Buffer.alloc(length)
  const { bytesRead } = await fd.read(buf, 0, length, position)
  return buf.subarray(0, bytesRead)
}

function dosTime(date, time) {
  if (!date) return 0
  return new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31,
    time >> 11, (time >> 5) & 63, (time & 31) * 2).getTime()
}

/** entry 名稱是外部輸入：`..`、絕對路徑、磁碟代號、NUL 一律不收 */
function safeName(raw) {
  const name = raw.replace(/\\/g, '/')
  if (!name || name.includes('\0') || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return ''
  const parts = name.split('/').filter(Boolean)
  if (!parts.length || parts.some((p) => p === '..' || p === '.' || /[<>:"|?*]/.test(p))) return ''
  return parts.join('/')
}

/**
 * 解析 zip64 的 extra（0x0001）：只有本體欄位是 0xFFFFFFFF 的才依序出現在裡面。
 * 順便收 Info-ZIP 的 UTF-8 檔名（0x7075）。
 */
function readExtra(extra, entry) {
  let pos = 0
  while (pos + 4 <= extra.length) {
    const id = extra.readUInt16LE(pos)
    const len = extra.readUInt16LE(pos + 2)
    const body = extra.subarray(pos + 4, pos + 4 + len)
    if (id === 0x0001) {
      let p = 0
      const next = () => {
        const v = p + 8 <= body.length ? Number(body.readBigUInt64LE(p)) : 0
        p += 8
        return v
      }
      if (entry.usize === 0xffffffff) entry.usize = next()
      if (entry.csize === 0xffffffff) entry.csize = next()
      if (entry.offset === 0xffffffff) entry.offset = next()
    } else if (id === 0x7075 && body.length > 5) {
      entry.unicodeName = body.subarray(5).toString('utf8')
    }
    pos += 4 + len
  }
}

async function readDirectory(fd, fileSize) {
  const tailLen = Math.min(fileSize, 65557)
  const tail = await readAt(fd, fileSize - tailLen, tailLen)
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === SIG_EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw paths.fail('BAD_ZIP', '這不是有效的 ZIP 檔')
  let count = tail.readUInt16LE(eocd + 10)
  let cdSize = tail.readUInt32LE(eocd + 12)
  let cdOffset = tail.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20
    if (loc < 0 || tail.readUInt32LE(loc) !== SIG_LOC64) throw paths.fail('BAD_ZIP', '這不是有效的 ZIP 檔')
    const z64 = await readAt(fd, Number(tail.readBigUInt64LE(loc + 8)), 56)
    if (z64.length < 56 || z64.readUInt32LE(0) !== SIG_EOCD64) throw paths.fail('BAD_ZIP', '這不是有效的 ZIP 檔')
    count = Number(z64.readBigUInt64LE(32))
    cdSize = Number(z64.readBigUInt64LE(40))
    cdOffset = Number(z64.readBigUInt64LE(48))
  }
  if (count > MAX_ENTRIES || cdSize > MAX_CD_BYTES) throw paths.fail('ZIP_TOO_LARGE', '這個壓縮檔的檔案太多，打不開')
  return { count, cd: await readAt(fd, cdOffset, cdSize) }
}

function parseDirectory(cd, count) {
  const out = []
  let pos = 0
  for (let n = 0; n < count && pos + 46 <= cd.length; n += 1) {
    if (cd.readUInt32LE(pos) !== SIG_CEN) break
    const flags = cd.readUInt16LE(pos + 8)
    const nameLen = cd.readUInt16LE(pos + 28)
    const extraLen = cd.readUInt16LE(pos + 30)
    const commentLen = cd.readUInt16LE(pos + 32)
    const entry = {
      flags,
      method: cd.readUInt16LE(pos + 10),
      mtimeMs: dosTime(cd.readUInt16LE(pos + 14), cd.readUInt16LE(pos + 12)),
      crc: cd.readUInt32LE(pos + 16),
      csize: cd.readUInt32LE(pos + 20),
      usize: cd.readUInt32LE(pos + 24),
      offset: cd.readUInt32LE(pos + 42),
      unicodeName: ''
    }
    const nameBytes = cd.subarray(pos + 46, pos + 46 + nameLen)
    readExtra(cd.subarray(pos + 46 + nameLen, pos + 46 + nameLen + extraLen), entry)
    const raw = entry.unicodeName || decodeName(nameBytes, (flags & 0x800) !== 0)
    delete entry.unicodeName
    pos += 46 + nameLen + extraLen + commentLen
    const dir = /[\\/]$/.test(raw)
    const name = safeName(raw.replace(/[\\/]+$/, ''))
    if (!name) continue
    out.push({ ...entry, name, dir })
  }
  return out
}

/**
 * 壓縮檔的全部 entry（依檔案大小＋修改時間快取，最多四份）。
 * @param {string} archive
 * @returns {Promise<Array<{ name: string, dir: boolean, method: number, flags: number, crc: number, csize: number, usize: number, offset: number, mtimeMs: number }>>}
 */
async function readIndex(archive) {
  const st = await fsp.stat(archive)
  const key = archive.toLowerCase()
  const hit = cache.get(key)
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.entries
  const fd = await fsp.open(archive, 'r')
  let entries
  try {
    const { count, cd } = await readDirectory(fd, st.size)
    entries = parseDirectory(cd, count)
  } finally {
    await fd.close()
  }
  cache.delete(key)
  cache.set(key, { size: st.size, mtimeMs: st.mtimeMs, entries })
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value)
  return entries
}

function toWin(inner) {
  return inner.split('/').join('\\')
}

/**
 * 一層的清單，欄位跟 `fs.statEntry` 一樣。沒有明寫資料夾 entry 的（只有 `a/b.txt`）也要補出 `a`。
 * @param {string} archive
 * @param {string} inner
 * @returns {Promise<object[]>}
 */
async function list(archive, inner) {
  const entries = await readIndex(archive)
  const prefix = inner ? `${inner}/` : ''
  const lowerPrefix = prefix.toLowerCase()
  const children = new Map()
  let found = !inner
  for (const entry of entries) {
    if (!entry.name.toLowerCase().startsWith(lowerPrefix)) {
      if (inner && entry.name.toLowerCase() === inner.toLowerCase() && entry.dir) found = true
      continue
    }
    const rest = entry.name.slice(prefix.length)
    if (!rest) {
      found = true
      continue
    }
    found = true
    const slash = rest.indexOf('/')
    const childName = slash < 0 ? rest : rest.slice(0, slash)
    const dir = slash >= 0 || entry.dir
    const key = childName.toLowerCase()
    const prev = children.get(key)
    if (prev && (prev.dir || !dir)) continue
    children.set(key, {
      name: childName,
      path: `${archive}\\${toWin(prefix + childName)}`,
      dir,
      link: false,
      size: dir ? 0 : entry.usize,
      mtimeMs: slash < 0 ? entry.mtimeMs : (prev ? prev.mtimeMs : 0),
      ext: dir ? '' : path.extname(childName).slice(1).toLowerCase(),
      hidden: false,
      zip: true
    })
  }
  if (!found) throw paths.fail('NOT_FOUND', '壓縮檔裡找不到這個資料夾')
  return [...children.values()]
}

/**
 * 壓縮檔裡的一個項目（詳情窗格用）。
 * @param {string} archive
 * @param {string} inner
 */
async function stat(archive, inner) {
  const entries = await readIndex(archive)
  const lower = inner.toLowerCase()
  const exact = entries.find((e) => e.name.toLowerCase() === lower)
  const dir = exact ? exact.dir : entries.some((e) => e.name.toLowerCase().startsWith(`${lower}/`))
  if (!exact && !dir) throw paths.fail('NOT_FOUND', '壓縮檔裡找不到這個檔案')
  return { dir, size: exact && !dir ? exact.usize : 0, csize: exact && !dir ? exact.csize : 0, mtimeMs: exact ? exact.mtimeMs : 0 }
}

/** 邊解邊算 CRC 與位元組數；超過宣告大小就中止（謊報大小的壓縮炸彈）。 */
function guard(entry) {
  let crc = 0
  let bytes = 0
  const hasCrc = typeof zlib.crc32 === 'function'
  const t = new Transform({
    transform(chunk, _enc, done) {
      bytes += chunk.length
      if (bytes > entry.usize) return done(paths.fail('BAD_ZIP', '壓縮檔內容跟記錄的大小不符'))
      if (hasCrc) crc = zlib.crc32(chunk, crc)
      done(null, chunk)
    },
    flush(done) {
      if (bytes !== entry.usize || (hasCrc && crc >>> 0 !== entry.crc >>> 0)) {
        return done(paths.fail('BAD_ZIP', '壓縮檔已損毀（檢查碼不符）'))
      }
      done()
    }
  })
  return t
}

async function dataStart(archive, entry) {
  const fd = await fsp.open(archive, 'r')
  try {
    const head = await readAt(fd, entry.offset, 30)
    if (head.length < 30 || head.readUInt32LE(0) !== SIG_LOCAL) throw paths.fail('BAD_ZIP', '壓縮檔已損毀')
    return entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28)
  } finally {
    await fd.close()
  }
}

/**
 * 把一個檔案 entry 解到 `dest`。先寫 `.part` 再改名，失敗不留半個檔案。
 * @param {string} archive
 * @param {object} entry
 * @param {string} dest
 */
async function extractFile(archive, entry, dest) {
  if (entry.flags & 0x1) throw paths.fail('ZIP_UNSUPPORTED', '加密的壓縮檔不支援，請用 7-Zip／WinRAR 開')
  if (entry.method !== 0 && entry.method !== 8) {
    throw paths.fail('ZIP_UNSUPPORTED', '這種壓縮格式不支援，請用 7-Zip／WinRAR 開')
  }
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  if (!entry.usize) {
    await fsp.writeFile(dest, '')
    return
  }
  if (!entry.csize) throw paths.fail('BAD_ZIP', '壓縮檔已損毀')
  const part = `${dest}.part`
  const start = await dataStart(archive, entry)
  const steps = [fs.createReadStream(archive, { start, end: start + entry.csize - 1 })]
  if (entry.method === 8) steps.push(zlib.createInflateRaw())
  steps.push(guard(entry), fs.createWriteStream(part))
  try {
    await pipeline(...steps)
    await fsp.rename(part, dest)
  } catch (error) {
    await fsp.unlink(part).catch(() => {})
    throw error.userMessage ? error : paths.fail('EXTRACT_FAILED', '解壓縮失敗')
  }
  if (entry.mtimeMs) await fsp.utimes(dest, new Date(), new Date(entry.mtimeMs)).catch(() => {})
}

/** `inner` 底下（含自己）要解出來的檔案，與它們相對於 `inner` 所在層的路徑 */
function collect(entries, inner) {
  const lower = inner.toLowerCase()
  const base = inner.includes('/') ? inner.slice(0, inner.lastIndexOf('/') + 1) : ''
  const picked = entries.filter((e) => {
    const n = e.name.toLowerCase()
    return !inner || n === lower || n.startsWith(`${lower}/`)
  })
  return picked.map((e) => ({ entry: e, rel: inner ? e.name.slice(base.length) : e.name }))
}

/** 目的地一定要在 `root` 底下（safeName 擋過一次，這裡再擋一次）。 */
function inside(root, rel) {
  const target = path.resolve(root, ...rel.split('/'))
  if (target !== root && !target.startsWith(root + path.sep)) throw paths.fail('BAD_ZIP', '壓縮檔裡有不合法的路徑')
  return target
}

/**
 * 把壓縮檔裡的項目解到 `destDir`。頂層撞名的產生 `name (2)`，不覆寫。
 * @param {string} archive
 * @param {string[]} inners 空字串＝整包
 * @param {string} destDir 已存在的資料夾
 * @param {(dir: string, name: string) => string} uniqueDest
 * @returns {Promise<string[]>} 解出來的頂層路徑
 */
async function extract(archive, inners, destDir, uniqueDest) {
  const entries = await readIndex(archive)
  const jobs = inners.map((inner) => ({ inner, items: collect(entries, inner) }))
  const total = jobs.reduce((sum, job) => sum + job.items.reduce((s, it) => s + (it.entry.dir ? 0 : it.entry.usize), 0), 0)
  if (total > MAX_EXTRACT_BYTES) throw paths.fail('ZIP_TOO_LARGE', '要解出來的內容太大了')
  const landed = []
  for (const job of jobs) {
    if (!job.items.length) throw paths.fail('NOT_FOUND', '壓縮檔裡找不到這個檔案')
    const top = job.inner ? job.inner.split('/').pop() : ''
    const rootDest = top ? uniqueDest(destDir, top) : destDir
    const root = path.dirname(rootDest)
    // 頂層改名成 `name (2)` 時，底下每一筆的第一段也要跟著換
    const rename = (rel) => (top ? path.basename(rootDest) + rel.slice(top.length) : rel)
    for (const { entry, rel } of job.items) {
      const target = inside(top ? root : destDir, rename(rel))
      if (entry.dir) await fsp.mkdir(target, { recursive: true })
      else await extractFile(archive, entry, target)
    }
    const onlyFile = job.items.length === 1 && !job.items[0].entry.dir && job.items[0].rel === top
    if (top && !onlyFile) await fsp.mkdir(rootDest, { recursive: true })
    if (top) landed.push(rootDest)
  }
  return landed
}

/** 開檔用的暫存副本放這裡（測試用 VOICEINK_ZIP_TEMP 指到自己的暫存資料夾，不碰正在用的那份） */
function tempRoot() {
  return process.env.VOICEINK_ZIP_TEMP || path.join(os.tmpdir(), 'voiceink-zip')
}

/**
 * 開檔／拖出去用：解到暫存資料夾（同一份壓縮檔、同一個檔案再開一次直接用上次那份）。
 * @param {string} archive
 * @param {string} inner
 * @returns {Promise<string>}
 */
async function extractTemp(archive, inner) {
  const st = await fsp.stat(archive)
  const tag = crypto.createHash('sha1').update(`${archive.toLowerCase()}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 12)
  const root = path.join(tempRoot(), tag)
  const entries = await readIndex(archive)
  const lower = inner.toLowerCase()
  const entry = entries.find((e) => e.name.toLowerCase() === lower && !e.dir)
  if (!entry) {
    if (entries.some((e) => e.name.toLowerCase().startsWith(`${lower}/`))) {
      const dest = inside(root, inner)
      await fsp.mkdir(path.dirname(dest), { recursive: true })
      const done = await extract(archive, [inner], path.dirname(dest), (dir, name) => path.join(dir, name))
      return done[0]
    }
    throw paths.fail('NOT_FOUND', '壓縮檔裡找不到這個檔案')
  }
  const dest = inside(root, inner)
  try {
    if ((await fsp.stat(dest)).size === entry.usize) return dest
  } catch {
    // 還沒解過
  }
  await extractFile(archive, entry, dest)
  return dest
}

module.exports = {
  MAX_EXTRACT_BYTES,
  looksZip,
  locate,
  readIndex,
  list,
  stat,
  extract,
  extractTemp,
  tempRoot,
  safeName,
  parseDirectory
}
