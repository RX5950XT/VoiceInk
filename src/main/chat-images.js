/**
 * VoiceInk - 聊天圖片附件（Main Process）
 *
 * 圖片不進 chats.json：electron-store 是整檔讀寫，把 base64 塞進去會讓
 * 每次 append 都重寫好幾 MB。訊息只存檔名，實體放 `<userData>/chat-images/`。
 *
 * 檔名由本模組產生（不採用 renderer 給的任何字串），讀取前再驗一次格式，
 * 所以 renderer 無法用 `../` 之類的字串跳出這個資料夾。
 */

const fs = require('fs/promises')
const path = require('path')
const { app } = require('electron')

/** 單則訊息最多幾張圖 */
const MAX_IMAGES_PER_MESSAGE = 4
/** 單張解碼後大小上限（renderer 已縮圖，這裡是信任邊界的硬限） */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024

/** 只收這三種；`svg` 會夾帶腳本，不收 */
const DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/
const MIME_EXT = { png: 'png', jpeg: 'jpg', webp: 'webp' }
const EXT_MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }
/** 檔名 allowlist：本模組自己產生的格式 */
const NAME_RE = /^img_[0-9a-z]+_[0-9a-z]+\.(png|jpg|webp)$/

/** 已寫進磁碟、還沒進 chats.json 的檔名。prune 必須跳過，否則並行刪對話會把新附件刪掉。 */
const heldNames = new Set()

function imagesDir() {
  return path.join(app.getPath('userData'), 'chat-images')
}

/**
 * @param {string} ext
 * @returns {string}
 */
function newName(ext) {
  return `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}.${ext}`
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidName(value) {
  return typeof value === 'string' && NAME_RE.test(value)
}

/**
 * 存一批 data URL，回傳檔名陣列（無效的直接略過）
 * @param {unknown} rawList
 * @returns {Promise<string[]>}
 */
async function saveMany(rawList) {
  if (!Array.isArray(rawList) || !rawList.length) return []
  const dir = imagesDir()
  await fs.mkdir(dir, { recursive: true })
  const names = []
  for (const raw of rawList.slice(0, MAX_IMAGES_PER_MESSAGE)) {
    if (typeof raw !== 'string') continue
    const m = DATA_URL_RE.exec(raw)
    if (!m) continue
    const buf = Buffer.from(m[2], 'base64')
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) continue
    const name = newName(MIME_EXT[m[1]])
    await fs.writeFile(path.join(dir, name), buf)
    names.push(name)
  }
  return names
}

/**
 * 讀回 data URL（給送 API 與 renderer 顯示用）
 * @param {unknown} name
 * @returns {Promise<string>} 失敗回空字串
 */
async function toDataUrl(name) {
  if (!isValidName(name)) return ''
  try {
    const buf = await fs.readFile(path.join(imagesDir(), name))
    if (buf.length > MAX_IMAGE_BYTES) return ''
    const ext = name.slice(name.lastIndexOf('.') + 1)
    return `data:${EXT_MIME[ext]};base64,${buf.toString('base64')}`
  } catch {
    return ''
  }
}

/**
 * 刪掉沒有任何對話引用的圖片。
 * 在刪除／淘汰對話後呼叫；資料夾檔數是數百等級，全掃即可。
 * @param {Set<string>} keep 仍被引用的檔名
 * @returns {Promise<number>} 刪除數
 */
/**
 * 標記尚未寫進 chats.json 的新檔，prune 時視為仍被引用
 * @param {string[]} names
 */
function hold(names) {
  if (!Array.isArray(names)) return
  for (const name of names) {
    if (isValidName(name)) heldNames.add(name)
  }
}

/**
 * @param {string[]} names
 */
function release(names) {
  if (!Array.isArray(names)) return
  for (const name of names) heldNames.delete(name)
}

async function prune(keep) {
  let removed = 0
  const dir = imagesDir()
  let entries = []
  try {
    entries = await fs.readdir(dir)
  } catch {
    return 0
  }
  for (const name of entries) {
    if (keep.has(name) || heldNames.has(name)) continue
    if (!isValidName(name)) continue
    try {
      await fs.unlink(path.join(dir, name))
      removed++
    } catch {
      // 檔案可能同時被其他流程刪掉，忽略
    }
  }
  return removed
}

module.exports = {
  saveMany,
  toDataUrl,
  prune,
  hold,
  release,
  isValidName,
  MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGE_BYTES
}
