'use strict'

/**
 * 終端機背景圖（桌布）。
 *
 * 規則跟聊天的圖片附件一樣：**檔案由 main 保管，renderer 只拿得到 `data:` URI**。
 * renderer 送不進來任何路徑——要換圖只能按按鈕走系統對話框，main 把選到的檔案複製進
 * `<userData>/terminal-bg/`，回一個純檔名。store 裡存的也是那個檔名（`termBgImage`），
 * 這樣 `config.json` 不會被一張圖撐爆，換主題／重開 App 也還在。
 *
 * 只留一張：選了新的就把舊的刪掉（這是「桌布」不是「相簿」）。
 */
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')

/** 一張桌布的上限。超過就不收——8MB 的 JPEG 已經是 4K 等級了 */
const MAX_BYTES = 8 * 1024 * 1024

/** 收哪些格式（副檔名 → data: URI 的 MIME） */
const TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp'
}

/**
 * 給使用者看的錯誤。`ipc-invoke.js` 只放行帶 `userMessage` 的錯誤，
 * 不帶的話畫面上只會拿到通用訊息（使用者不知道是圖太大還是格式不收）。
 * @param {string} message
 */
function fail(message) {
  const error = new Error(message)
  error.userMessage = message
  return error
}

/** 存進 store 的檔名只准長這樣（讀回來時再驗一次，路徑穿越一律擋掉） */
const NAME_RE = /^bg-\d+\.[a-z]{3,4}$/

/**
 * `<userData>/terminal-bg`。延遲取（跟 `service.js` 拿 host 路徑同一個寫法）：
 * 模組載入時 `app` 還沒 ready，寫成常數會拿到空字串。
 * @returns {string}
 */
function dirOf() {
  try {
    return path.join(require('electron').app.getPath('userData'), 'terminal-bg')
  } catch {
    return ''
  }
}

/**
 * store 裡的 `termBgImage` 一律過這裡。壞值（含路徑分隔符、副檔名不認得）回空字串。
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeName(value) {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!NAME_RE.test(name)) return ''
  return TYPES[path.extname(name).toLowerCase()] ? name : ''
}

/**
 * 把使用者選的圖複製進來，回新檔名。舊的那張順手刪掉。
 * @param {string} sourcePath 系統對話框給的絕對路徑（**不是** renderer 給的）
 * @param {string} previous 目前存著的檔名
 * @returns {Promise<string>} 新檔名
 */
async function adopt(sourcePath, previous) {
  const ext = path.extname(String(sourcePath || '')).toLowerCase()
  const mime = TYPES[ext]
  if (!mime) throw fail('只收 PNG／JPG／WebP／GIF／BMP')
  const stat = await fsp.stat(sourcePath)
  if (!stat.isFile()) throw fail('這不是一個檔案')
  if (stat.size > MAX_BYTES) throw fail('圖片太大（上限 8MB）')

  const dir = dirOf()
  if (!dir) throw fail('找不到存放位置')
  await fsp.mkdir(dir, { recursive: true })
  const name = `bg-${Date.now()}${ext}`
  await fsp.copyFile(sourcePath, path.join(dir, name))
  await remove(previous)
  return name
}

/**
 * 讀成 `data:` URI 給 renderer 當 CSS 背景。檔案不在（使用者清了 userData）就回空字串，
 * 不是錯誤——畫面退回純色底就好。
 * @param {unknown} value store 裡的檔名
 * @returns {Promise<string>}
 */
async function dataUri(value) {
  const name = sanitizeName(value)
  if (!name) return ''
  const dir = dirOf()
  if (!dir) return ''
  try {
    const buf = await fsp.readFile(path.join(dir, name))
    if (buf.length > MAX_BYTES) return ''
    return `data:${TYPES[path.extname(name).toLowerCase()]};base64,${buf.toString('base64')}`
  } catch {
    return ''
  }
}

/**
 * 刪掉一張（換圖或使用者按「清除」）。不存在不是錯。
 * @param {unknown} value
 * @returns {Promise<void>}
 */
async function remove(value) {
  const name = sanitizeName(value)
  const dir = dirOf()
  if (!name || !dir) return
  try {
    await fsp.unlink(path.join(dir, name))
  } catch {
    /* 本來就不在 */
  }
}

/** 給測試用：確認資料夾存不存在，不建立 */
function dirExists() {
  const dir = dirOf()
  return Boolean(dir) && fs.existsSync(dir)
}

module.exports = { MAX_BYTES, TYPES, sanitizeName, adopt, dataUri, remove, dirExists }
