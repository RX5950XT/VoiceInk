'use strict'

/**
 * 終端機畫面上的連結：把 renderer 掃出來的候選字串，對照真實檔案系統確認。
 *
 * renderer 只認得「畫面上這串字長得像路徑」，能不能開得起來只有主行程知道。
 * 這裡負責兩件事：hover 時回報哪些候選真的存在（不存在就不畫底線），
 * 點下去時用檔案總管開起來。
 *
 * 相對路徑的基準是**這個工作階段現在的 cwd**：宿主從 PTY 輸出裡撈 OSC 7
 * （`shell` 每次換目錄自己報的），由 `service.js` 呼叫 `noteCwd` 存進來。
 * 沒報過（`cmd.exe`、或 shell 沒設定 OSC 7）就退回開起來時的那個目錄。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const store = require('./store')

/** 一次最多驗幾個候選（一行畫面塞不下更多，多的一律丟掉） */
const MAX_CANDIDATES = 32
/** 單一候選的長度上限，跟 Windows 的長路徑上限同級 */
const MAX_LENGTH = 512

/**
 * 有沒有控制字元。用字碼判斷不用 regex：這支檔案裡不該出現實體控制字元。
 * @param {string} text
 */
function hasControlChar(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code < 32 || code === 127) return true
  }
  return false
}

/**
 * 把畫面上的一串字解析成真的存在的路徑。不存在、含控制字元、太長一律回 null。
 * @param {string} cwd 這個工作階段的起始工作目錄
 * @param {unknown} raw
 * @returns {{ full: string, kind: 'file' | 'dir' } | null}
 */
function resolveCandidate(cwd, raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text || text.length > MAX_LENGTH || hasControlChar(text)) return null
  const expanded = text === '~' || text.startsWith('~/') || text.startsWith('~\\')
    ? path.join(os.homedir(), text.slice(1))
    : text
  // 相對路徑沒有基準就不猜：`process.cwd()` 是 App 自己的目錄，跟畫面上看到的無關
  if (!path.isAbsolute(expanded) && !cwd) return null
  const full = path.resolve(cwd || '', expanded)
  let stat
  try {
    stat = fs.statSync(full)
  } catch {
    return null
  }
  return { full, kind: stat.isDirectory() ? 'dir' : 'file' }
}

/**
 * 前景 shell 目前報到哪個目錄（OSC 7）。**這是終端機裡跑的程式自己講的**，
 * 所以只當成解析相對路徑的基準，能不能開仍然由 `resolveCandidate` 的 `statSync` 說了算。
 * @type {Map<string, string>}
 */
const liveCwd = new Map()

/**
 * @param {string} id
 * @param {string} cwd 空字串＝這個階段收掉了，把記錄清掉
 */
function noteCwd(id, cwd) {
  const key = String(id || '')
  if (!key) return
  if (!cwd) liveCwd.delete(key)
  else if (typeof cwd === 'string' && cwd.length <= MAX_LENGTH && !hasControlChar(cwd)) liveCwd.set(key, cwd)
}

/**
 * @param {unknown} id
 * @returns {Promise<string>}
 */
async function baseCwd(id) {
  const live = liveCwd.get(String(id || ''))
  if (live) return live
  const meta = await store.get(String(id || ''))
  return typeof meta?.cwd === 'string' ? meta.cwd : ''
}

/**
 * hover 用：回報哪些候選字真的指到存在的檔案或資料夾。
 * @param {unknown} id
 * @param {unknown} texts
 * @returns {Promise<Array<{ text: string, kind: 'file' | 'dir' }>>}
 */
async function resolveLinks(id, texts) {
  if (!Array.isArray(texts) || !texts.length) return []
  const cwd = await baseCwd(id)
  const out = []
  for (const text of texts.slice(0, MAX_CANDIDATES)) {
    const hit = resolveCandidate(cwd, text)
    if (hit) out.push({ text: String(text), kind: hit.kind })
  }
  return out
}

/**
 * 點下去：資料夾直接開，檔案在檔案總管裡選起來。
 * @param {unknown} id
 * @param {unknown} text
 * @returns {Promise<boolean>}
 */
async function revealLink(id, text) {
  const hit = resolveCandidate(await baseCwd(id), text)
  if (!hit) {
    const error = new Error('NO_PATH')
    error.code = 'NO_PATH'
    error.userMessage = '找不到這個路徑'
    throw error
  }
  // electron 用到才 require：純路徑解析要能在 node 直跑的回歸測試裡驗
  const { shell } = require('electron')
  if (hit.kind === 'dir') await shell.openPath(hit.full)
  else shell.showItemInFolder(hit.full)
  return true
}

module.exports = { resolveCandidate, resolveLinks, revealLink, noteCwd, _liveCwd: liveCwd }
