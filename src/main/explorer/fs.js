'use strict'

/**
 * 整機檔案操作（Main Process）。所有路徑都過 `paths.resolveAbs`。
 */

const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const paths = require('./paths')
const recycle = require('./recycle')

const MAX_ENTRIES = 2000
const MAX_READ_BYTES = 2 * 1024 * 1024
const MAX_TEXT_BYTES = 8 * 1024
const SORT_KEYS = new Set(['name', 'date', 'size'])
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
 * @param {fs.Dirent} dirent
 * @param {string} full
 * @returns {Promise<{ name: string, path: string, dir: boolean, size: number, mtimeMs: number, ext: string }>}
 */
async function statEntry(dirent, full) {
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
    ext: dir ? '' : path.extname(dirent.name).slice(1).toLowerCase()
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
 * @returns {{ by: 'name'|'date'|'size', desc: boolean }}
 */
function sanitizeSort(raw) {
  const by = raw && typeof raw === 'object' && SORT_KEYS.has(raw.sort) ? raw.sort : 'name'
  return { by, desc: Boolean(raw && typeof raw === 'object' && raw.desc) }
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

async function listDir(dirPath, rawOpts) {
  const full = paths.resolveAbs(dirPath)
  let dirents
  try {
    const read = fsp.readdir(full, { withFileTypes: true })
    dirents = full.startsWith('\\\\') ? await withTimeout(read, 12000) : await read
  } catch {
    throw paths.fail('READ_FAILED', '讀不到這個資料夾')
  }
  const slice = dirents.slice(0, MAX_ENTRIES)
  const entries = await Promise.all(slice.map((d) => statEntry(d, path.join(full, d.name))))
  return {
    path: full,
    entries: sortEntries(entries, sanitizeSort(rawOpts)),
    truncated: dirents.length > MAX_ENTRIES
  }
}

/**
 * @param {unknown} rawOpts
 */
async function listRecycle(rawOpts) {
  const listed = await recycle.list()
  return { ...listed, entries: sortEntries(listed.entries, sanitizeSort(rawOpts)) }
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
  if (next.toLowerCase() === full.toLowerCase()) return { path: full }
  if (fs.existsSync(next)) throw paths.fail('EXISTS', '這個名字已經有東西了')
  try {
    await fsp.rename(full, next)
  } catch {
    throw paths.fail('RENAME_FAILED', '改名失敗')
  }
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
  return { path: full, permanent }
}

const restoreEntry = (key) => recycle.restore(key)
const purgeEntry = (key) => recycle.purge(key)
const emptyRecycle = () => recycle.empty()

/**
 * @param {unknown} fromPath
 * @param {unknown} toDir
 */
async function moveEntry(fromPath, toDir) {
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
  return queueWrite(dir, async () => {
    let next = path.join(dir, path.basename(from))
    paths.resolveAbs(next)
    if (next.toLowerCase() === from.toLowerCase()) return { path: from }
    if (fs.existsSync(next)) next = uniqueDest(dir, path.basename(from))
    try {
      await fsp.rename(from, next)
      return { path: next }
    } catch {
      try {
        await fsp.cp(from, next, { recursive: true, errorOnExist: true, verbatimSymlinks: true })
        await paths.removeLinkOrTree(from)
      } catch {
        throw paths.fail('MOVE_FAILED', '搬不過去')
      }
      return { path: next }
    }
  })
}

/**
 * @param {unknown} fromPath
 * @param {unknown} toDir
 */
async function copyEntry(fromPath, toDir) {
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
  return queueWrite(dir, async () => {
    let next = path.join(dir, path.basename(from))
    paths.resolveAbs(next)
    if (fs.existsSync(next)) next = uniqueDest(dir, path.basename(from))
    try {
      await fsp.cp(from, next, { recursive: true, errorOnExist: true, verbatimSymlinks: true })
    } catch {
      throw paths.fail('COPY_FAILED', '複製失敗')
    }
    return { path: next }
  })
}

module.exports = {
  MAX_ENTRIES,
  MAX_READ_BYTES,
  IMAGE_MIME,
  SORT_KEYS,
  sanitizeSort,
  sortEntries,
  uniqueDest,
  listDir,
  listRecycle,
  preview,
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
