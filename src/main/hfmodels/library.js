'use strict'

/**
 * 本機模型庫：`<userData>/hf-models/<模型 id>/`，一個資料夾一顆模型。
 *
 * **這個佈局是 router 決定的，不是我們挑的**（實測）：router 拿子資料夾名當 model id，
 * 而且會自動把同一個資料夾裡的 `mmproj-*.gguf` 接成 `--mmproj`。順著它擺，
 * 「使用者自己把 gguf 拖進資料夾」就完全不必寫程式（`GET /models?reload=1` 就掃得到）。
 *
 * **沒有全域索引檔**：每顆模型的來歷寫在自己資料夾裡的 `voiceink-meta.json`。
 * 有索引就要處理「索引說有、磁碟上沒有」的不一致，而磁碟本來就是唯一的真相
 * （使用者可以直接把資料夾刪掉）。router 只認 `.gguf`，多一個 json 不會被當成模型。
 */

const fs = require('fs')
const path = require('path')

const META_FILE = 'voiceink-meta.json'
/** 跟 `catalog.safeId` 產出的形狀一致 */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/

let rootDir = ''

/**
 * @param {string} dir `<userData>/hf-models`
 */
function setRoot(dir) {
  rootDir = String(dir || '')
}

/**
 * @returns {string}
 */
function root() {
  if (!rootDir) throw new Error('模型庫路徑尚未設定')
  return rootDir
}

/**
 * @param {any} id
 * @returns {boolean}
 */
function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id) && id !== '.' && id !== '..'
}

/**
 * 模型資料夾。**id 一律先驗過**：這個值會被接成路徑，收到 `..\..\Windows` 就是在幫別人刪檔案。
 * @param {string} id
 * @returns {string}
 */
function dirFor(id) {
  if (!isValidId(id)) throw new Error('模型代號格式不正確')
  return path.join(root(), id)
}

/**
 * @param {string} dir
 * @returns {string[]} 該資料夾裡的 .gguf 檔名（不遞迴：router 也只看一層）
 */
function ggufsIn(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.gguf$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * @param {string} id
 * @returns {Record<string, any>}
 */
function readMeta(id) {
  try {
    const text = fs.readFileSync(path.join(dirFor(id), META_FILE), 'utf8')
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    // 沒有 meta 是正常的（使用者自己拖進來的），不是錯誤
    return {}
  }
}

/**
 * @param {string} id
 * @param {Record<string, any>} meta
 */
function writeMeta(id, meta) {
  const dir = dirFor(id)
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, META_FILE)
  const tmp = `${target}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf8')
  fs.renameSync(tmp, target)
}

/**
 * 磁碟上真的有的模型。`.part`（下載到一半）不算數。
 * @returns {Array<{ id: string, files: string[], mmproj: string, bytes: number,
 *                   multimodal: boolean, meta: Record<string, any> }>}
 */
function list() {
  let entries = []
  try {
    entries = fs.readdirSync(root(), { withFileTypes: true })
  } catch {
    return []
  }
  const models = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidId(entry.name)) continue
    const dir = path.join(root(), entry.name)
    const files = ggufsIn(dir)
    if (!files.length) continue
    const mmproj = files.find((name) => /^mmproj/i.test(name)) || ''
    let bytes = 0
    for (const name of files) {
      try { bytes += fs.statSync(path.join(dir, name)).size } catch { /* 讀不到就當 0 */ }
    }
    models.push({
      id: entry.name,
      files,
      mmproj,
      bytes,
      multimodal: !!mmproj,
      meta: readMeta(entry.name)
    })
  }
  return models.sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * @param {string} id
 * @returns {boolean}
 */
function has(id) {
  return isValidId(id) && ggufsIn(dirFor(id)).length > 0
}

/**
 * 刪掉一顆模型。**只刪 root 底下的那一層**，路徑要真的落在 root 裡才動手。
 * @param {string} id
 * @returns {boolean}
 */
function remove(id) {
  const dir = dirFor(id)
  const inside = path.relative(root(), dir)
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new Error('模型路徑不在模型庫裡')
  }
  if (!fs.existsSync(dir)) return false
  fs.rmSync(dir, { recursive: true, force: true })
  return true
}

/**
 * 使用者自己有一顆 gguf：複製進模型庫（**不搬移**——搬走使用者原本的檔案不是我們該做的事）
 * @param {string} sourcePath
 * @param {string} [id] 省略時用檔名
 * @returns {{ id: string, dir: string }}
 */
function importFile(sourcePath, id = '') {
  const stat = fs.statSync(sourcePath)
  if (!stat.isFile() || !/\.gguf$/i.test(sourcePath)) throw new Error('只能匯入 .gguf 檔案')
  const name = id || path.basename(sourcePath).replace(/\.gguf$/i, '')
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 96)
  if (!isValidId(safe)) throw new Error('模型代號格式不正確')
  const dir = dirFor(safe)
  fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(sourcePath, path.join(dir, path.basename(sourcePath)))
  writeMeta(safe, { source: 'import', importedAt: new Date().toISOString() })
  return { id: safe, dir }
}

module.exports = {
  setRoot, root, isValidId, dirFor, list, has, remove, readMeta, writeMeta, importFile, META_FILE
}
