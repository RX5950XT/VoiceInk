'use strict'

/**
 * 手機／相機（MTP）：沒有磁碟代號，Node 的 fs 碰不到，全部經殼層 sidecar
 * （`native/explorer-shell/Portable.cs`）。
 *
 * App 裡的路徑長這樣：`mtp:Pixel 6a\內部共用儲存空間\DCIM`——`mtp:` 後面第一段是裝置名稱，
 * 其餘是一層層顯示名稱。裝置名稱 → 殼層解析名稱（`::{20D04FE0…}\\\?\usb#…`）記在這裡；
 * 列過的項目也記下它的解析名稱（物件 ID），開檔／複製時不用再從頭一層層列舉。
 *
 * 只做：瀏覽、開檔／預覽／拖出去（先複製到暫存）、複製出來、複製進去、刪除（沒有回收筒＝永久）。
 * 不做改名、新增資料夾。
 */

const path = require('path')
const crypto = require('crypto')
const { shell } = require('electron')
const fsp = require('../raw-fs').promises
const drives = require('./drives')
const paths = require('./paths')
const files = require('./fs')
const shellExt = require('./shell')
const host = require('./shell-host')
const zip = require('./zip')

const PREFIX = 'mtp:'
/** 相機資料夾幾百張要列 3～4 秒，幾千張會更久 */
const LIST_TIMEOUT_MS = 2 * 60 * 1000
/** 使用者的複製可以很大（影片），Windows 自己的進度視窗有取消鈕 */
const COPY_TIMEOUT_MS = 6 * 60 * 60 * 1000
const MAX_PARSE_CACHE = 20000
/** 最近列過的幾個資料夾：翻頁、開檔、看詳情都從這裡找，不要每次都再問手機一次 */
const MAX_LISTINGS = 8

/** 小寫裝置名稱 → 殼層解析名稱 */
let deviceRoots = new Map()
/** 小寫 App 路徑 → 殼層解析名稱 */
const parseCache = new Map()
/** 小寫 App 路徑 → 那一層的清單 @type {Map<string, object[]>} */
const listings = new Map()

/** @param {unknown} target */
function isMtp(target) {
  return typeof target === 'string' && target.slice(0, PREFIX.length).toLowerCase() === PREFIX
}

/**
 * @param {unknown} target
 * @returns {{ device: string, segs: string[], full: string }}
 */
function parse(target) {
  if (!isMtp(target)) throw paths.fail('BAD_PATH', '路徑不合法')
  const parts = String(target).slice(PREFIX.length).replace(/\\+$/, '').split('\\')
  const bad = parts.length > 64 || parts.some((p) => !p || p === '.' || p === '..' || p.length > 255 || /[\u0000-\u001f]/.test(p))
  if (bad) throw paths.fail('BAD_PATH', '路徑不合法')
  return { device: parts[0], segs: parts.slice(1), full: PREFIX + parts.join('\\') }
}

/**
 * 首頁要的裝置清單；順便更新名稱對應。兩台同名的第二台叫「名稱 (2)」。
 * @returns {Promise<Array<{ name: string, path: string, type: string }>>}
 */
async function listDevices() {
  const found = await drives.listDevices()
  const next = new Map()
  const out = []
  for (const dev of found) {
    const base = dev.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || '裝置'
    let name = base
    for (let n = 2; next.has(name.toLowerCase()); n += 1) name = `${base} (${n})`
    next.set(name.toLowerCase(), dev.path)
    out.push({ name, path: PREFIX + name, type: dev.type })
  }
  deviceRoots = next
  return out
}

async function rootOf(device) {
  if (!deviceRoots.has(device.toLowerCase())) await listDevices()
  const root = deviceRoots.get(device.toLowerCase())
  if (!root) throw paths.fail('NOT_FOUND', '找不到這支手機：可能拔掉了，或還沒解鎖、USB 沒選「檔案傳輸」')
  return root
}

async function address(where) {
  return { root: await rootOf(where.device), segs: where.segs, parse: parseCache.get(where.full.toLowerCase()) }
}

function remember(full, parsed) {
  if (typeof parsed !== 'string' || !parsed || parsed.length > 2048) return
  if (parseCache.size >= MAX_PARSE_CACHE) parseCache.clear()
  parseCache.set(full.toLowerCase(), parsed)
}

function failure(res) {
  if (res.error === 'SHELL_EXE_MISSING') return paths.fail('SHELL_MISSING', '缺少殼層元件，讀不了手機')
  if (res.error === 'SHELL_TIMEOUT') return paths.fail('TIMEOUT', '手機回應太慢')
  return paths.fail('MTP_FAILED', '讀不到手機：可能拔掉了，或還沒解鎖、USB 沒選「檔案傳輸」')
}

/** 列資料夾走常駐那顆 sidecar */
async function ask(request) {
  const session = await shellExt.ensure()
  if (!session) throw failure({ error: 'SHELL_EXE_MISSING' })
  const res = await session.send(request, LIST_TIMEOUT_MS)
  if (!res.ok) throw failure(res)
  return res.data || {}
}

/**
 * 複製／刪除另外開一顆 sidecar：IFileOperation 會一路卡到做完，
 * 用常駐那顆的話，這段時間圖示、右鍵選單、列手機資料夾全都等著。
 */
async function operate(request) {
  const session = await host.startShell()
  if (!session.ok) throw failure(session)
  try {
    const res = await session.send({ hwnd: shellExt.hwndOf(), ...request }, COPY_TIMEOUT_MS)
    if (!res.ok) throw failure(res)
    return { aborted: Boolean(res.data && res.data.aborted) }
  } finally {
    session.stop()
  }
}

/**
 * @param {{ device: string, segs: string[], full: string }} where
 * @param {{ fresh?: boolean }} [opts] fresh＝一定重問手機（第一頁＝進資料夾、重新整理）
 */
async function entriesOf(where, opts = {}) {
  const key = where.full.toLowerCase()
  if (!opts.fresh && listings.has(key)) return listings.get(key)
  const data = await ask({ op: 'mtpList', at: await address(where) })
  const entries = []
  for (const item of Array.isArray(data.items) ? data.items : []) {
    const name = item && typeof item.name === 'string' ? item.name : ''
    if (!name || name.length > 255 || /[\\/\u0000-\u001f]/.test(name) || name === '.' || name === '..') continue
    const full = `${where.full}\\${name}`
    remember(full, item.parse)
    const dir = item.dir === true
    entries.push({
      name,
      path: full,
      dir,
      link: false,
      size: dir ? 0 : Math.max(0, Number(item.size) || 0),
      mtimeMs: Math.max(0, Number(item.mtimeMs) || 0),
      ext: dir ? '' : path.extname(name).slice(1).toLowerCase(),
      // `.thumbnails`、`.trash-storage` 這類：跟 Android 自己的檔案管理員一樣當隱藏項目
      hidden: name.startsWith('.'),
      phone: true
    })
  }
  listings.delete(key)
  listings.set(key, entries)
  if (listings.size > MAX_LISTINGS) listings.delete(listings.keys().next().value)
  return entries
}

/**
 * @param {unknown} target
 * @param {unknown} rawOpts 同 `files.listDir`
 */
async function list(target, rawOpts) {
  const where = parse(target)
  const opts = rawOpts && typeof rawOpts === 'object' ? rawOpts : {}
  const offset = Math.max(0, Math.floor(Number(opts.offset) || 0))
  const all = await entriesOf(where, { fresh: offset === 0 })
  const shown = opts.showHidden === true ? all : all.filter((e) => !e.hidden)
  const sorted = files.sortEntries(shown, files.sanitizeSort(opts))
  const limit = Math.max(1, Math.min(files.MAX_PAGE_SIZE, Math.floor(Number(opts.limit ?? opts.pageSize) || files.DEFAULT_PAGE_SIZE)))
  const slice = sorted.slice(offset, offset + limit)
  const hasMore = offset + slice.length < sorted.length
  return {
    path: where.full,
    phone: PREFIX + where.device,
    entries: slice,
    offset,
    limit,
    total: sorted.length,
    hasMore,
    nextOffset: hasMore ? offset + slice.length : null,
    truncated: hasMore
  }
}

/** 這一項的資料（從上一層的清單找；裝置本身與儲存空間都算資料夾） */
async function stat(target) {
  const where = parse(target)
  if (!where.segs.length) return { where, entry: { name: where.device, path: where.full, dir: true, size: 0, mtimeMs: 0, ext: '' } }
  const parent = { device: where.device, segs: where.segs.slice(0, -1), full: where.full.slice(0, where.full.lastIndexOf('\\')) }
  const name = where.segs[where.segs.length - 1].toLowerCase()
  const entry = (await entriesOf(parent)).find((e) => e.name.toLowerCase() === name)
  if (!entry) throw paths.fail('NOT_FOUND', '手機裡找不到這個檔案')
  return { where, entry }
}

async function resolve(target) {
  const { where, entry } = await stat(target)
  const parent = where.full.slice(0, where.full.lastIndexOf('\\')) || where.full
  return { path: where.full, dir: entry.dir, parent: entry.dir ? where.full : parent }
}

async function inspect(target) {
  const { entry } = await stat(target)
  return {
    path: entry.path,
    name: entry.name,
    dir: entry.dir,
    link: false,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    ctimeMs: 0,
    atimeMs: 0,
    ext: entry.ext,
    type: entry.dir ? '資料夾' : (entry.ext ? `${entry.ext.toUpperCase()} 檔` : '檔案'),
    image: '',
    text: '',
    shortcutTarget: '',
    linkTarget: '',
    width: 0,
    height: 0,
    tooLarge: false,
    phone: true
  }
}

/**
 * 開檔、預覽、拖出去：先安靜地複製到暫存，回那份真的路徑。同一個檔案大小沒變就直接用上次那份。
 * 資料夾不做（整個資料夾默默複製可能是好幾 GB）。
 */
async function realPath(target) {
  const { where, entry } = await stat(target)
  if (entry.dir) throw paths.fail('BAD_PATH', '資料夾請用複製、貼上')
  const tag = crypto.createHash('sha1').update(where.full.toLowerCase()).digest('hex').slice(0, 12)
  const dir = path.join(zip.tempRoot(), 'mtp', tag)
  const file = path.join(dir, entry.name)
  const st = await fsp.stat(file).catch(() => null)
  if (st && st.size === entry.size) return file
  await fsp.mkdir(dir, { recursive: true })
  await operate({ op: 'mtpCopy', silent: true, from: [await address(where)], to: { path: dir } })
  const landed = await fsp.stat(file).catch(() => null)
  if (!landed) throw paths.fail('MTP_FAILED', '從手機複製不出來')
  return file
}

async function openPath(target) {
  const info = await resolve(target)
  if (info.dir) return info
  const err = await shell.openPath(await realPath(target))
  if (err) throw paths.fail('OPEN_FAILED', '打不開')
  return true
}

/**
 * 從手機複製到本機資料夾。進度、同名要不要取代都是 Windows 自己的視窗。
 * @param {string[]} sources mtp 路徑
 * @param {string} destination 已驗過的本機資料夾
 */
async function copyOut(sources, destination) {
  const from = []
  for (const item of sources.slice(0, 500)) from.push(await address(parse(item)))
  const result = await operate({ op: 'mtpCopy', from, to: { path: destination } })
  files.invalidateListCache(destination)
  return { paths: [], status: result.aborted ? 'cancelled' : 'completed', items: [] }
}

/**
 * 從本機複製進手機的資料夾。
 * @param {string[]} sources 本機路徑（這裡再驗一次）
 * @param {unknown} toDir mtp 路徑
 */
async function copyIn(sources, toDir) {
  const where = parse(toDir)
  const from = sources.slice(0, 500).map((item) => {
    if (isMtp(item)) throw paths.fail('BAD_PATH', '手機跟手機之間請先複製到電腦')
    return { path: paths.resolveExisting(item) }
  })
  if (!from.length) throw paths.fail('EMPTY', '沒有要複製的檔案')
  const result = await operate({ op: 'mtpCopy', from, to: await address(where) })
  listings.delete(where.full.toLowerCase())
  return { paths: [], status: result.aborted ? 'cancelled' : 'completed', items: [] }
}

/**
 * 永久刪除（手機沒有回收筒；renderer 先問過「永久刪除？」）。裝置與儲存空間本身不給刪。
 * @param {unknown} target
 */
async function remove(target) {
  const where = parse(target)
  if (where.segs.length < 2) throw paths.fail('PROTECTED', '手機的儲存空間不能刪')
  await operate({ op: 'mtpDelete', items: [await address(where)] })
  parseCache.delete(where.full.toLowerCase())
  listings.delete(where.full.slice(0, where.full.lastIndexOf('\\')).toLowerCase())
  return { path: where.full, permanent: true }
}

function readOnly() {
  return paths.fail('READ_ONLY', '手機裡不能改名或新增，只能複製進出與刪除')
}

module.exports = { PREFIX, isMtp, parse, listDevices, list, resolve, inspect, realPath, openPath, copyOut, copyIn, remove, readOnly }
