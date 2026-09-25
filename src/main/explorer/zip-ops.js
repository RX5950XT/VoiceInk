'use strict'

/**
 * 檔案總管門面跟 `zip.js` 之間的接縫：路徑驗證、清單分頁、詳情、解壓縮到哪裡。
 * `index.js` 每個入口先問 `zipOf`，是壓縮檔裡的路徑就改走這裡。
 */

const path = require('path')
const fsp = require('../raw-fs').promises
const paths = require('./paths')
const files = require('./fs')
const zip = require('./zip')

/** 詳情窗格自動解出來看內容的上限（跟一般檔案的文字預覽差不多大） */
const INSPECT_EXTRACT_BYTES = 2 * 1024 * 1024

/**
 * 這個路徑在壓縮檔裡嗎？壓縮檔本身也要過 `resolveExisting`（存在＋在允許的範圍）。
 * @param {unknown} target
 * @returns {Promise<{ archive: string, inner: string, full: string } | null>}
 */
async function zipOf(target) {
  let full
  try {
    full = paths.resolveAbs(target)
  } catch {
    return null
  }
  if (!zip.looksZip(full)) return null
  const where = await zip.locate(full)
  if (!where) return null
  paths.resolveExisting(where.archive)
  return { ...where, full }
}

/** 壓縮檔裡（不含壓縮檔本身）才算唯讀區 */
async function innerOf(target) {
  const where = await zipOf(target)
  return where && where.inner ? where : null
}

async function assertWritable(dir) {
  if (await innerOf(dir)) throw paths.fail('READ_ONLY', '壓縮檔裡是唯讀的，請先解壓縮')
}

/**
 * @param {{ archive: string, inner: string, full: string }} where
 * @param {unknown} rawOpts
 */
async function list(where, rawOpts) {
  const entries = await zip.list(where.archive, where.inner)
  const sorted = files.sortEntries(entries, files.sanitizeSort(rawOpts))
  const opts = rawOpts && typeof rawOpts === 'object' ? rawOpts : {}
  const offset = Math.max(0, Math.floor(Number(opts.offset) || 0))
  const limit = Math.max(1, Math.min(files.MAX_PAGE_SIZE, Math.floor(Number(opts.limit ?? opts.pageSize) || files.DEFAULT_PAGE_SIZE)))
  const slice = sorted.slice(offset, offset + limit)
  const hasMore = offset + slice.length < sorted.length
  return {
    path: where.full,
    archive: where.archive,
    entries: slice,
    offset,
    limit,
    total: sorted.length,
    hasMore,
    nextOffset: hasMore ? offset + slice.length : null,
    truncated: hasMore
  }
}

/**
 * 詳情窗格。小檔解到暫存直接用一般的 `inspect`（文字預覽、圖片尺寸都有），路徑換回壓縮檔裡那個。
 * @param {{ archive: string, inner: string, full: string }} where
 */
async function inspect(where) {
  const st = await zip.stat(where.archive, where.inner)
  const name = where.inner.split('/').pop()
  if (!st.dir && st.size <= INSPECT_EXTRACT_BYTES) {
    try {
      const temp = await zip.extractTemp(where.archive, where.inner)
      return { ...(await files.inspect(temp)), path: where.full, name, zip: true }
    } catch {
      // 解不出來（加密／不支援的壓縮法）就只給基本資料
    }
  }
  const ext = st.dir ? '' : path.extname(name).slice(1).toLowerCase()
  return {
    path: where.full,
    name,
    dir: st.dir,
    link: false,
    size: st.size,
    mtimeMs: st.mtimeMs,
    ctimeMs: 0,
    atimeMs: 0,
    ext,
    type: st.dir ? '資料夾' : (ext ? `${ext.toUpperCase()} 檔` : '檔案'),
    image: '',
    text: '',
    shortcutTarget: '',
    linkTarget: '',
    width: 0,
    height: 0,
    tooLarge: !st.dir,
    zip: true
  }
}

/** 開檔、拖出去、大預覽：解到暫存，回那份真的路徑 */
async function realPath(where) {
  return zip.extractTemp(where.archive, where.inner)
}

/**
 * 解壓縮。每一項可以是壓縮檔本身（整包）或壓縮檔裡的項目。
 * - 有給 `toDir`：全部解到那裡
 * - 沒給：整包的解到壓縮檔旁邊的同名資料夾（Windows「全部解壓縮」）；裡面的項目解到壓縮檔旁邊
 * @param {unknown} items
 * @param {unknown} toDir
 * @returns {Promise<{ paths: string[] }>}
 */
async function extract(items, toDir) {
  if (!Array.isArray(items) || !items.length) throw paths.fail('BAD_PATH', '路徑不合法')
  let dest = ''
  if (toDir) {
    await assertWritable(toDir)
    dest = paths.resolveExisting(toDir)
    const st = await fsp.stat(dest).catch(() => null)
    if (!st || !st.isDirectory()) throw paths.fail('BAD_PATH', '只能解到資料夾裡')
    paths.assertCreatable(dest)
  }
  const groups = new Map()
  const landed = []
  for (const item of items.slice(0, 50)) {
    const where = await zipOf(item)
    if (!where) throw paths.fail('BAD_PATH', '這不是壓縮檔')
    const target = dest || paths.parentOf(where.archive)
    if (!dest) paths.assertCreatable(target)
    if (!where.inner) {
      const folder = files.uniqueDest(target, path.basename(where.archive).replace(/\.zip$/i, '') || 'archive')
      await fsp.mkdir(folder)
      await zip.extract(where.archive, [''], folder, files.uniqueDest)
      landed.push(folder)
      continue
    }
    const key = `${where.archive}\n${target}`
    const group = groups.get(key) || { archive: where.archive, target, inners: [] }
    group.inners.push(where.inner)
    groups.set(key, group)
  }
  for (const group of groups.values()) {
    landed.push(...await zip.extract(group.archive, group.inners, group.target, files.uniqueDest))
  }
  files.invalidateListCache()
  return { paths: landed }
}

module.exports = { zipOf, innerOf, assertWritable, list, inspect, realPath, extract }
