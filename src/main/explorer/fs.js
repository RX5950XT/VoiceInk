'use strict'

/**
 * 整機檔案操作（Main Process）。所有路徑都過 `paths.resolveAbs`。
 */

const fs = require('../raw-fs')
const fsp = require('../raw-fs').promises
const path = require('path')
const paths = require('./paths')
const recycle = require('./recycle')

const MAX_ENTRIES = 2000
const MAX_PAGE_SIZE = 2000
const DEFAULT_PAGE_SIZE = MAX_ENTRIES
const LIST_CACHE_TTL_MS = 1500
/** sidecar 屬性查詢的上限：拿不到就退回 isHiddenName，不可拖慢 listDir。 */
const ATTRS_TIMEOUT_MS = 200
const STAT_CONCURRENCY = 64
const MAX_READ_BYTES = 2 * 1024 * 1024
const MAX_TEXT_BYTES = 8 * 1024
const MAX_MARKDOWN_BYTES = 4 * 1024 * 1024
const COPY_CHUNK_BYTES = 1024 * 1024
const SORT_KEYS = new Set(['name', 'date', 'size'])
const HIDDEN_NAMES = new Set([
  '.git',
  '$recycle.bin',
  'system volume information',
  'desktop.ini',
  'thumbs.db',
  'pagefile.sys',
  'hiberfil.sys',
  'swapfile.sys',
  'ntuser.ini'
])
const TEXT_EXT = new Set([
  'txt', 'md', 'json', 'js', 'mjs', 'cjs', 'css', 'html', 'htm', 'xml',
  'csv', 'log', 'ini', 'cfg', 'yml', 'yaml', 'ps1', 'bat', 'cmd', 'svg'
])

const IMAGE_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml'
}

/** @type {Map<string, Promise<any>>} */
const writeChains = new Map()
/** @type {Map<string, { createdAt: number, entries: object[], sorted: Map<string, object[]> }>} */
const listCache = new Map()

/**
 * @template T
 * @param {string} full
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function queueWrite(full, task) {
  const key = full.toLowerCase()
  const prev = writeChains.get(key) || Promise.resolve()
  const next = prev.then(task, task)
  writeChains.set(key, next)
  const done = () => {
    if (writeChains.get(key) === next) writeChains.delete(key)
  }
  next.then(done, done)
  return next
}

/**
 * @param {string} full
 * @returns {string}
 */
function imageMime(full) {
  const ext = path.extname(full).slice(1).toLowerCase()
  return IMAGE_MIME[ext] || ''
}

/**
 * Windows 檔案總管預設會藏的名字（啟發式；Node 在 Windows 讀不到 FILE_ATTRIBUTE_HIDDEN）。
 *
 * **不可以照 Unix 慣例把「點開頭」一律當隱藏**：`.gitignore`／`.env`／`.vscode`／`.eslintrc`
 * 在 Windows 上根本沒有 hidden 屬性，檔案總管照顯示——這個 App 的使用者天天要看這些檔，
 * 藏掉等於把專案資料夾挖空。版本控制那個資料夾是例外（建立時自己設了 hidden），列在名單裡。
 * @param {unknown} name
 * @returns {boolean}
 */
function isHiddenName(name) {
  const s = String(name || '')
  if (!s) return false
  const lower = s.toLowerCase()
  if (HIDDEN_NAMES.has(lower)) return true
  return lower.startsWith('ntuser.dat')
}

/**
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next
      next += 1
      out[i] = await fn(items[i])
    }
  }
  const n = Math.max(1, Math.min(limit, items.length || 1))
  const workers = []
  for (let w = 0; w < n; w++) workers.push(worker())
  await Promise.all(workers)
  return out
}

/**
 * @param {string} dirPath
 * @returns {Promise<Map<string, { hidden: boolean, system: boolean }>|null>}
 */
async function readAttrs(dirPath) {
  if (!process.versions.electron) return null
  if (!dirPath || String(dirPath).startsWith('\\\\')) return null
  try {
    const shell = require('./shell')
    if (typeof shell.attrsOf !== 'function') return null
    const result = await withTimeout(shell.attrsOf(dirPath), ATTRS_TIMEOUT_MS)
    if (!result || typeof result.get !== 'function') return null
    const lower = new Map()
    for (const [name, flags] of result) {
      if (typeof name === 'string' && name) lower.set(name.toLowerCase(), flags)
    }
    return lower
  } catch {
    return null
  }
}

/**
 * @param {fs.Dirent} dirent
 * @param {string} full
 * @param {boolean} hidden
 * @returns {Promise<{ name: string, path: string, dir: boolean, size: number, mtimeMs: number, ext: string, hidden: boolean }>}
 */
async function statEntry(dirent, full, hidden) {
  let dir = dirent.isDirectory()
  let link = dirent.isSymbolicLink()
  let size = 0
  let mtimeMs = 0
  try {
    const st = await fsp.lstat(full)
    link = st.isSymbolicLink()
    if (link) {
      try {
        dir = (await fsp.stat(full)).isDirectory()
      } catch {
        dir = false
      }
    } else {
      dir = st.isDirectory()
    }
    size = dir ? 0 : Number(st.size) || 0
    mtimeMs = Number(st.mtimeMs) || 0
  } catch {
    // 權限或短暫消失：仍列得出名字
  }
  return {
    name: dirent.name,
    path: full,
    dir,
    link,
    size,
    mtimeMs,
    ext: dir ? '' : path.extname(dirent.name).slice(1).toLowerCase(),
    hidden: hidden === true
  }
}

/**
 * @param {string} from
 * @param {string} dir
 */
function isIntoSelf(from, dir) {
  const a = String(from || '').toLowerCase()
  const b = String(dir || '').toLowerCase()
  return Boolean(a) && (b === a || b.startsWith(a + path.sep))
}

/**
 * @param {unknown} raw
 * @returns {{ by: 'name'|'date'|'size', desc: boolean, showHidden: boolean }}
 */
function sanitizeSort(raw) {
  const obj = raw && typeof raw === 'object' ? raw : {}
  const by = SORT_KEYS.has(obj.sort) ? obj.sort : 'name'
  return { by, desc: Boolean(obj.desc), showHidden: obj.showHidden === true }
}

/**
 * 資料夾永遠排在檔案前面，其餘依 name／date／size。
 * @param {Array<{ name: string, dir: boolean, size?: number, mtimeMs?: number }>} entries
 * @param {{ by?: string, desc?: boolean }} opts
 */
function sortEntries(entries, opts) {
  const by = opts && opts.by === 'size' ? 'size' : opts && opts.by === 'date' ? 'date' : 'name'
  const desc = Boolean(opts && opts.desc)
  const copy = Array.isArray(entries) ? entries.slice() : []
  copy.sort((a, b) => {
    if (Boolean(a.dir) !== Boolean(b.dir)) return a.dir ? -1 : 1
    let cmp = 0
    if (by === 'size') cmp = (Number(a.size) || 0) - (Number(b.size) || 0)
    else if (by === 'date') cmp = (Number(a.mtimeMs) || 0) - (Number(b.mtimeMs) || 0)
    else cmp = String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hant', { numeric: true, sensitivity: 'base' })
    if (cmp === 0) {
      cmp = String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hant', { numeric: true, sensitivity: 'base' })
    }
    return desc ? -cmp : cmp
  })
  return copy
}

/**
 * 同名時變成 `name (2).ext`，不覆寫。
 * @param {string} dir
 * @param {string} basename
 * @returns {string} 絕對路徑
 */
function uniqueDest(dir, basename) {
  const ext = path.extname(basename)
  const stem = ext ? basename.slice(0, -ext.length) : basename
  let n = 2
  let name = basename
  while (fs.existsSync(path.join(dir, name))) {
    name = `${stem} (${n})${ext}`
    n += 1
    if (n > 9999) throw paths.fail('EXISTS', '那裡已經有同名的東西了')
  }
  return path.join(dir, name)
}

/**
 * 目的地已經有同名的東西時怎麼辦。`skip` 略過，`overwrite` 先把舊的丟進回收筒再放新的
 * （丟不進去才真的刪——NAS／非 NTFS 沒有回收筒），其餘一律保留兩份（`name (2).ext`）。
 * 複製到同一個資料夾時「覆蓋」等於把來源自己刪掉，所以退回保留兩份。
 * @param {string} dir
 * @param {string} from
 * @param {string} next
 * @param {{ collision?: string } | null} options
 * @returns {Promise<{ skipped: true } | { dest: string }>}
 */
async function resolveCollision(dir, from, next, options) {
  if (!fs.existsSync(next)) return { dest: next }
  const mode = options && options.collision
  if (mode === 'skip') return { skipped: true }
  if (mode === 'overwrite' && next.toLowerCase() !== String(from).toLowerCase()) {
    paths.assertMutable(next)
    try {
      await recycle.trash(next)
    } catch {
      await paths.removeLinkOrTree(next)
    }
    return { dest: next }
  }
  return { dest: uniqueDest(dir, path.basename(from)) }
}

function cancelledError() {
  return paths.fail('CANCELLED', '操作已取消')
}

function checkCancelled(signal) {
  if (signal && signal.aborted) throw cancelledError()
}

/**
 * 不追 junction／symlink，量出能可靠取得的檔案大小。
 * @param {string} full
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<{ bytes: number, complete: boolean }>}
 */
async function measureTree(full, signal) {
  checkCancelled(signal)
  let st
  try { st = await fsp.lstat(full) } catch { return { bytes: 0, complete: false } }
  if (st.isSymbolicLink()) return { bytes: 0, complete: true }
  if (!st.isDirectory()) return { bytes: Number(st.size) || 0, complete: true }
  let names
  try { names = await fsp.readdir(full) } catch { return { bytes: 0, complete: false } }
  let bytes = 0
  let complete = true
  for (const name of names) {
    checkCancelled(signal)
    const child = await measureTree(path.join(full, name), signal)
    bytes += child.bytes
    complete = complete && child.complete
  }
  return { bytes, complete }
}

/**
 * 逐檔複製，目的地先用 wx 建立；中斷或失敗由上層移除半成品。
 * @param {string} from
 * @param {string} to
 * @param {{ signal?: AbortSignal, bytes: number, onProgress?: (bytes: number) => void }} ctx
 */
async function copyNode(from, to, ctx) {
  checkCancelled(ctx.signal)
  const st = await fsp.lstat(from)
  if (st.isSymbolicLink()) {
    const link = await fsp.readlink(from)
    let target
    try { target = await fsp.stat(from) } catch { target = null }
    await fsp.symlink(link, to, target && target.isDirectory() ? 'junction' : 'file')
    return
  }
  if (st.isDirectory()) {
    await fsp.mkdir(to)
    const names = await fsp.readdir(from)
    for (const name of names) await copyNode(path.join(from, name), path.join(to, name), ctx)
    return
  }
  const input = await fsp.open(from, 'r')
  const output = await fsp.open(to, 'wx', st.mode & 0o777)
  const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES)
  try {
    while (true) {
      checkCancelled(ctx.signal)
      const read = await input.read(buffer, 0, buffer.length, null)
      if (!read.bytesRead) break
      await output.write(buffer, 0, read.bytesRead, null)
      ctx.bytes += read.bytesRead
      if (ctx.onProgress) ctx.onProgress(ctx.bytes)
    }
  } finally {
    await input.close()
    await output.close()
  }
}

/**
 * @param {string} from
 * @param {string} to
 * @param {{ signal?: AbortSignal, onProgress?: (bytes: number) => void, onTotal?: (total: number|null) => void }} opts
 */
async function copyTreeWithProgress(from, to, opts) {
  const measured = await measureTree(from, opts.signal)
  if (opts.onTotal) opts.onTotal(measured.complete ? measured.bytes : null)
  const ctx = { signal: opts.signal, bytes: 0, onProgress: opts.onProgress }
  try {
    await copyNode(from, to, ctx)
  } catch (error) {
    try { await paths.removeLinkOrTree(to) } catch { /* 半成品可能尚未建立 */ }
    throw error
  }
  return { path: to, bytes: ctx.bytes, totalBytes: measured.complete ? measured.bytes : null }
}

/**
 * @param {Promise<T>} promise
 * @param {number} ms
 * @template T
 */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error('TIMEOUT')
      error.code = 'TIMEOUT'
      reject(error)
    }, ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) }
    )
  })
}

function pageOptions(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const offset = Number.isFinite(Number(value.offset))
    ? Math.max(0, Math.floor(Number(value.offset)))
    : 0
  const requested = value.limit ?? value.pageSize
  const limit = Number.isFinite(Number(requested))
    ? Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(Number(requested))))
    : DEFAULT_PAGE_SIZE
  return { offset, limit }
}

function listCacheKey(full, opts) {
  return `${full.toLowerCase()}|${opts.showHidden ? '1' : '0'}`
}

async function readDirectoryEntries(full, opts) {
  const key = listCacheKey(full, opts)
  const current = listCache.get(key)
  if (current && Date.now() - current.createdAt < LIST_CACHE_TTL_MS) return current
  let dirents
  try {
    const read = fsp.readdir(full, { withFileTypes: true })
    dirents = full.startsWith('\\\\') ? await withTimeout(read, 12000) : await read
  } catch {
    throw paths.fail('READ_FAILED', '讀不到這個資料夾')
  }
  const attrMap = await readAttrs(full)
  const flagged = dirents.map((d) => {
    const attr = attrMap ? attrMap.get(d.name.toLowerCase()) : null
    return { dirent: d, hidden: Boolean(attr && attr.hidden) || isHiddenName(d.name) }
  })
  const visible = opts.showHidden ? flagged : flagged.filter((item) => !item.hidden)
  const entries = await mapLimit(visible, STAT_CONCURRENCY, (item) => (
    statEntry(item.dirent, path.join(full, item.dirent.name), item.hidden)
  ))
  const next = { createdAt: Date.now(), entries, sorted: new Map() }
  listCache.set(key, next)
  return next
}

async function listDir(dirPath, rawOpts) {
  const full = paths.resolveAbs(dirPath)
  const opts = sanitizeSort(rawOpts)
  const page = pageOptions(rawOpts)
  const source = await readDirectoryEntries(full, opts)
  const sortKey = `${opts.by}:${opts.desc ? '1' : '0'}`
  let sorted = source.sorted.get(sortKey)
  if (!sorted) {
    sorted = sortEntries(source.entries, opts)
    source.sorted.set(sortKey, sorted)
  }
  const total = sorted.length
  const entries = sorted.slice(page.offset, page.offset + page.limit)
  const hasMore = page.offset + entries.length < total
  return {
    path: full,
    entries,
    offset: page.offset,
    limit: page.limit,
    total,
    hasMore,
    nextOffset: hasMore ? page.offset + entries.length : null,
    // 舊 caller 仍用 truncated 判斷「畫面還沒拿完」；現在它代表尚有下一頁。
    truncated: hasMore
  }
}

/** @param {unknown} dirPath */
function invalidateListCache(dirPath) {
  if (typeof dirPath !== 'string' || !dirPath) {
    listCache.clear()
    return
  }
  let full
  try { full = paths.resolveAbs(dirPath).toLowerCase() } catch { return }
  for (const key of listCache.keys()) {
    if (key.startsWith(`${full}|`)) listCache.delete(key)
  }
}

/**
 * @param {unknown} rawOpts
 */
async function listRecycle(rawOpts) {
  const listed = await recycle.list()
  const opts = sanitizeSort(rawOpts)
  const page = pageOptions(rawOpts)
  const sorted = sortEntries(listed.entries, opts)
  const entries = sorted.slice(page.offset, page.offset + page.limit)
  const total = sorted.length
  const hasMore = page.offset + entries.length < total
  return {
    ...listed,
    entries,
    offset: page.offset,
    limit: page.limit,
    total,
    hasMore,
    nextOffset: hasMore ? page.offset + entries.length : null,
    truncated: Boolean(listed.truncated) || hasMore
  }
}

/**
 * @param {{ dir: boolean, link: boolean, ext: string }} entry
 */
function typeLabel(entry) {
  if (entry.dir) return entry.link ? '連結資料夾' : '資料夾'
  if (entry.ext === 'lnk') return '捷徑'
  if (IMAGE_MIME[entry.ext]) return '圖片'
  if (entry.ext) return `${entry.ext.toUpperCase()} 檔`
  return '檔案'
}

/**
 * @param {Buffer} buf
 * @param {string} ext
 * @returns {{ width: number, height: number } | null}
 */
function imageDim(buf, ext) {
  if (ext === 'png' && buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  return null
}

function readCString(buf, start) {
  if (start < 0 || start >= buf.length) return ''
  const end = buf.indexOf(0, start)
  const slice = buf.subarray(start, end === -1 ? buf.length : end)
  return slice.toString('utf8')
}

function readWString(buf, start) {
  if (start < 0 || start + 1 >= buf.length) return ''
  const chars = []
  for (let i = start; i + 1 < buf.length; i += 2) {
    const code = buf.readUInt16LE(i)
    if (!code) break
    chars.push(String.fromCharCode(code))
  }
  return chars.join('')
}

/**
 * 讀 .lnk 的本機／網路目標。不依賴 Electron。
 * @param {Buffer} buf
 * @returns {string}
 */
function parseLnkTarget(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 0x4C) return ''
  if (buf[0] !== 0x4C || buf[1] !== 0x00) return ''
  const flags = buf.readUInt32LE(0x14)
  let off = 0x4C
  if (flags & 0x01) {
    if (off + 2 > buf.length) return ''
    off += 2 + buf.readUInt16LE(off)
  }
  if (!(flags & 0x02) || off + 0x1C > buf.length) return ''
  const infoSize = buf.readUInt32LE(off)
  const headerSize = buf.readUInt32LE(off + 4)
  const localOff = buf.readUInt32LE(off + 16)
  const netOff = buf.readUInt32LE(off + 20)
  let target = ''
  if (localOff && localOff < infoSize) target = readCString(buf, off + localOff)
  if (!target && headerSize >= 0x24 && off + 32 <= buf.length) {
    const uniOff = buf.readUInt32LE(off + 28)
    if (uniOff && uniOff < infoSize) target = readWString(buf, off + uniOff)
  }
  if (!target && netOff && netOff + 20 < infoSize) {
    const netBase = off + netOff
    const deviceOff = buf.readUInt32LE(netBase + 16)
    if (deviceOff && netBase + deviceOff < buf.length) {
      target = readCString(buf, netBase + deviceOff)
    }
  }
  return target
}

/**
 * 詳情＋預覽。圖片回 data URI，文字檔回開頭一段，捷徑回目標。
 * @param {unknown} filePath
 */
async function inspect(filePath) {
  const full = paths.resolveExisting(filePath)
  let st
  try {
    st = await fsp.lstat(full)
  } catch {
    throw paths.fail('READ_FAILED', '讀不到這個檔案')
  }
  const name = path.basename(full)
  let dir = st.isDirectory()
  const link = st.isSymbolicLink()
  if (link) {
    try {
      dir = (await fsp.stat(full)).isDirectory()
    } catch {
      dir = false
    }
  }
  const ext = dir ? '' : path.extname(name).slice(1).toLowerCase()
  const info = {
    path: full,
    name,
    dir,
    link,
    size: dir ? 0 : Number(st.size) || 0,
    mtimeMs: Number(st.mtimeMs) || 0,
    ctimeMs: Number(st.birthtimeMs || st.ctimeMs) || 0,
    atimeMs: Number(st.atimeMs) || 0,
    ext,
    type: typeLabel({ dir, link, ext }),
    image: '',
    text: '',
    shortcutTarget: '',
    linkTarget: '',
    width: 0,
    height: 0,
    tooLarge: false
  }
  if (link) {
    try {
      info.linkTarget = await fsp.readlink(full)
    } catch {
      // 目標消失仍回詳情
    }
  }
  if (dir) return info
  if (ext === 'lnk') {
    if (process.versions.electron) {
      try {
        const { shell } = require('electron')
        const sc = shell.readShortcutLink(full)
        info.shortcutTarget = sc && sc.target ? String(sc.target) : ''
      } catch {
        // 改讀檔頭
      }
    }
    if (!info.shortcutTarget) {
      try {
        const n = Math.min(Number(st.size) || 0, 64 * 1024)
        const buf = Buffer.alloc(n)
        const fh = await fsp.open(full, 'r')
        try {
          await fh.read(buf, 0, n, 0)
        } finally {
          await fh.close()
        }
        info.shortcutTarget = parseLnkTarget(buf)
      } catch {
        // 壞掉的捷徑只顯示檔案本身
      }
    }
  }
  const mime = imageMime(full)
  if (mime) {
    if (st.size > MAX_READ_BYTES) {
      info.tooLarge = true
      return info
    }
    const buf = await fsp.readFile(full)
    const dim = imageDim(buf, ext)
    if (dim) {
      info.width = dim.width
      info.height = dim.height
    }
    info.image = `data:${mime};base64,${buf.toString('base64')}`
    return info
  }
  if (TEXT_EXT.has(ext) && st.size > 0) {
    const n = Math.min(Number(st.size) || 0, MAX_TEXT_BYTES)
    const buf = Buffer.alloc(n)
    const fh = await fsp.open(full, 'r')
    try {
      await fh.read(buf, 0, n, 0)
    } finally {
      await fh.close()
    }
    if (!buf.includes(0)) info.text = buf.toString('utf8')
  }
  return info
}

/**
 * 圖片預覽。只走已知副檔名，回 `data:` URI。
 * @param {unknown} filePath
 */
async function preview(filePath) {
  const info = await inspect(filePath)
  if (info.dir) throw paths.fail('NOT_A_FILE', '這不是一個檔案')
  return { path: info.path, image: info.image, tooLarge: info.tooLarge, size: info.size }
}

/**
 * 讀 Markdown 預覽用的文字。只接受 Markdown 副檔名並限制大小，避免把任意
 * 二進位檔或大型檔案送進 renderer。
 * @param {unknown} filePath
 */
async function readMarkdown(filePath) {
  const full = paths.resolveExisting(filePath)
  const ext = path.extname(full).slice(1).toLowerCase()
  if (!['md', 'markdown', 'mdown', 'mkd'].includes(ext)) {
    throw paths.fail('NOT_MARKDOWN', '這不是 Markdown 檔案')
  }
  let stat
  try { stat = await fsp.stat(full) } catch { throw paths.fail('READ_FAILED', '讀不到這個檔案') }
  if (!stat.isFile()) throw paths.fail('NOT_A_FILE', '這不是一個檔案')
  if (stat.size > MAX_MARKDOWN_BYTES) throw paths.fail('TOO_LARGE', 'Markdown 檔案太大')
  const text = (await fsp.readFile(full)).toString('utf8')
  return { path: full, text, size: stat.size, mtimeMs: Number(stat.mtimeMs) || 0 }
}

/**
 * @param {unknown} dirPath
 * @param {unknown} rawName
 * @param {boolean} dir
 */
async function createEntry(dirPath, rawName, dir) {
  const name = paths.checkName(rawName)
  const parent = paths.resolveExisting(dirPath)
  paths.assertCreatable(parent)
  const full = path.join(parent, name)
  paths.resolveAbs(full)
  if (paths.isProtected(full)) throw paths.fail('PROTECTED', '這個位置不能改')
  if (fs.existsSync(full)) throw paths.fail('EXISTS', '這個名字已經有東西了')
  try {
    if (dir) await fsp.mkdir(full)
    else await fsp.writeFile(full, '', { flag: 'wx' })
  } catch {
    throw paths.fail('CREATE_FAILED', dir ? '建不了資料夾' : '建不了檔案')
  }
  invalidateListCache(parent)
  return { path: full, dir: Boolean(dir) }
}

/**
 * @param {unknown} target
 * @param {unknown} rawName
 */
async function renameEntry(target, rawName) {
  const name = paths.checkName(rawName)
  const full = paths.resolveExisting(target)
  paths.assertMutable(full)
  const next = path.join(path.dirname(full), name)
  paths.resolveAbs(next)
  if (next === full) return { path: full }
  // 大小寫別名可以改；若目錄區分大小寫、確實有另一筆同名項目，仍拒絕覆蓋。
  if (fs.existsSync(next) && (next.toLowerCase() !== full.toLowerCase()
    || fs.readdirSync(path.dirname(full)).includes(name))) throw paths.fail('EXISTS', '這個名字已經有東西了')
  try {
    await fsp.rename(full, next)
  } catch {
    throw paths.fail('RENAME_FAILED', '改名失敗')
  }
  invalidateListCache(path.dirname(full))
  return { path: next }
}

/**
 * 預設丟進資源回收筒。`{ permanent: true }` 才真的 rm。
 * @param {unknown} target
 * @param {unknown} rawOpts
 */
async function removeEntry(target, rawOpts) {
  const full = paths.resolveExisting(target)
  paths.assertMutable(full)
  const permanent = Boolean(rawOpts && typeof rawOpts === 'object' && rawOpts.permanent === true)
  try {
    if (permanent) await paths.removeLinkOrTree(full)
    else await recycle.trash(full)
  } catch (error) {
    if (error && error.code === 'PROTECTED') throw error
    if (error && error.code === 'DELETE_FAILED') throw error
    throw paths.fail('DELETE_FAILED', '刪不掉')
  }
  invalidateListCache(path.dirname(full))
  return { path: full, permanent }
}

const restoreEntry = (key) => recycle.restore(key)
const purgeEntry = (key) => recycle.purge(key)
const emptyRecycle = () => recycle.empty()

/**
 * @param {unknown} fromPath
 * @param {unknown} toDir
 */
async function moveEntry(fromPath, toDir, rawOptions) {
  const from = paths.resolveExisting(fromPath)
  paths.assertMutable(from)
  const dir = paths.resolveExisting(toDir)
  paths.assertCreatable(dir)
  let stat
  try {
    stat = await fsp.stat(dir)
  } catch {
    throw paths.fail('BAD_PATH', '目的地不存在')
  }
  if (!stat.isDirectory()) throw paths.fail('BAD_PATH', '只能放進資料夾裡')
  if (isIntoSelf(from, dir)) {
    throw paths.fail('BAD_PATH', '不能把資料夾搬進它自己底下')
  }
  const options = rawOptions && typeof rawOptions === 'object' ? rawOptions : null
  return queueWrite(dir, async () => {
    let next = path.join(dir, path.basename(from))
    paths.resolveAbs(next)
    if (next.toLowerCase() === from.toLowerCase()) return { path: from }
    const decided = await resolveCollision(dir, from, next, options)
    if (decided.skipped) return { path: next, skipped: true }
    next = decided.dest
    if (options && (options.onProgress || options.onTotal)) {
      const measured = await measureTree(from, options.signal)
      if (options.onTotal) options.onTotal(measured.complete ? measured.bytes : null)
      checkCancelled(options.signal)
      try {
        await fsp.rename(from, next)
        invalidateListCache()
        return { path: next, bytes: 0, totalBytes: measured.complete ? measured.bytes : null }
      } catch {
        try {
          const copied = await copyTreeWithProgress(from, next, options)
          checkCancelled(options.signal)
          await paths.removeLinkOrTree(from)
          invalidateListCache()
          return { path: next, ...copied }
        } catch (error) {
          throw error && error.code === 'CANCELLED'
            ? error
            : paths.fail('MOVE_FAILED', '搬不過去')
        }
      }
    }
    try {
      await fsp.rename(from, next)
      invalidateListCache()
      return { path: next }
    } catch {
      try {
        await fsp.cp(from, next, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true })
        await paths.removeLinkOrTree(from)
      } catch {
        throw paths.fail('MOVE_FAILED', '搬不過去')
      }
      invalidateListCache()
      return { path: next }
    }
  })
}

/**
 * @param {unknown} fromPath
 * @param {unknown} toDir
 */
async function copyEntry(fromPath, toDir, rawOptions) {
  const from = paths.resolveExisting(fromPath)
  const dir = paths.resolveExisting(toDir)
  paths.assertCreatable(dir)
  let stat
  try {
    stat = await fsp.stat(dir)
  } catch {
    throw paths.fail('BAD_PATH', '目的地不存在')
  }
  if (!stat.isDirectory()) throw paths.fail('BAD_PATH', '只能放進資料夾裡')
  if (isIntoSelf(from, dir)) {
    throw paths.fail('BAD_PATH', '不能把資料夾搬進它自己底下')
  }
  const options = rawOptions && typeof rawOptions === 'object' ? rawOptions : null
  return queueWrite(dir, async () => {
    let next = path.join(dir, path.basename(from))
    paths.resolveAbs(next)
    const decided = await resolveCollision(dir, from, next, options)
    if (decided.skipped) return { path: next, skipped: true }
    next = decided.dest
    if (options && (options.onProgress || options.onTotal)) {
      const copied = await copyTreeWithProgress(from, next, options)
      invalidateListCache(dir)
      return copied
    }
    try {
      await fsp.cp(from, next, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true })
    } catch {
      throw paths.fail('COPY_FAILED', '複製失敗')
    }
    invalidateListCache(dir)
    return { path: next }
  })
}

module.exports = {
  MAX_ENTRIES,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  ATTRS_TIMEOUT_MS,
  MAX_READ_BYTES,
  MAX_MARKDOWN_BYTES,
  COPY_CHUNK_BYTES,
  IMAGE_MIME,
  SORT_KEYS,
  isHiddenName,
  sanitizeSort,
  sortEntries,
  uniqueDest,
  invalidateListCache,
  measureTree,
  listDir,
  listRecycle,
  preview,
  readMarkdown,
  inspect,
  parseLnkTarget,
  createEntry,
  renameEntry,
  removeEntry,
  restoreEntry,
  purgeEntry,
  emptyRecycle,
  moveEntry,
  copyEntry
}
