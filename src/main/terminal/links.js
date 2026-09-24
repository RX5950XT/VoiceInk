'use strict'

/**
 * 終端機畫面上的連結：把 renderer 掃出來的候選字串，對照真實檔案系統確認。
 *
 * renderer 只認得「畫面上這串字長得像路徑」，能不能開得起來只有主行程知道。
 * 這裡負責兩件事：hover 時回報哪些候選真的存在（不存在就不畫底線），
 * 點下去時回給 renderer 用 App 自己開（專案內編輯器／檔案頁）。
 *
 * 相對路徑的基準是**這個工作階段現在的 cwd**：宿主從 PTY 輸出裡撈 OSC 7
 * （`shell` 每次換目錄自己報的），由 `service.js` 呼叫 `noteCwd` 存進來。
 * 沒報過（`cmd.exe`、或 shell 沒設定 OSC 7）就退回開起來時的那個目錄。
 */

const fs = require('../raw-fs')
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

/** 一個候選字最多等多久（網路磁碟睡著、主機名解析不到都會拖很久） */
const STAT_TIMEOUT_MS = 800

/**
 * @param {string} full
 * @returns {Promise<import('fs').Stats | null>}
 */
function statSoon(full) {
  let timer
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), STAT_TIMEOUT_MS) })
  return Promise.race([fs.promises.stat(full).catch(() => null), late]).finally(() => clearTimeout(timer))
}

/**
 * 把畫面上的一串字解析成真的存在的路徑。不存在、含控制字元、太長一律回 null。
 *
 * **非同步＋逾時**：以前是 `statSync`，滑過終端機一次最多 32 個候選字。CLI 輸出裡
 * JSON 轉義過的 `\\Users\\...` 會被當成 UNC 路徑，Windows 要等網路名稱解析逾時
 * （十幾秒）才回來——那段時間主程序整個停住，視窗變成「沒有回應」。
 * 滑過去（hover）時也不碰 UNC：真的網路路徑點下去才查（`allowUnc`）。
 * @param {string} cwd 這個工作階段的起始工作目錄
 * @param {unknown} raw
 * @param {{ allowUnc?: boolean }} [opts]
 * @returns {Promise<{ full: string, kind: 'file' | 'dir' } | null>}
 */
async function resolveCandidate(cwd, raw, opts = {}) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text || text.length > MAX_LENGTH || hasControlChar(text)) return null
  const expanded = text === '~' || text.startsWith('~/') || text.startsWith('~\\')
    ? path.join(os.homedir(), text.slice(1))
    : text
  // 相對路徑沒有基準就不猜：`process.cwd()` 是 App 自己的目錄，跟畫面上看到的無關
  if (!path.isAbsolute(expanded) && !cwd) return null
  const full = path.resolve(cwd || '', expanded)
  if (!opts.allowUnc && full.startsWith('\\\\')) return null
  const stat = await statSoon(full)
  if (!stat) return null
  return { full, kind: stat.isDirectory() ? 'dir' : 'file' }
}

/**
 * 這個絕對路徑落在哪個專案裡。有目前專案而且對得上就用它，不然用根目錄最深的。
 * @param {string} full
 * @param {Array<{ id: string, path: string }>} projects
 * @param {string} [preferredId]
 * @returns {{ projectId: string, relPath: string } | null}
 */
function locateInProjects(full, projects, preferredId = '') {
  if (!full || !Array.isArray(projects)) return null
  const target = path.resolve(full)
  const keyOf = (value) => (process.platform === 'win32' ? value.toLowerCase() : value)
  const want = keyOf(target)
  const hits = []
  for (const proj of projects) {
    const root = typeof proj?.path === 'string' ? path.resolve(proj.path) : ''
    if (!root || !proj.id) continue
    const rootKey = keyOf(root)
    if (want !== rootKey && !want.startsWith(rootKey + path.sep)) continue
    hits.push({
      projectId: proj.id,
      relPath: want === rootKey ? '' : path.relative(root, target).split(path.sep).join('/'),
      root
    })
  }
  if (!hits.length) return null
  const preferred = hits.find((hit) => hit.projectId === preferredId)
  if (preferred) return { projectId: preferred.projectId, relPath: preferred.relPath }
  hits.sort((a, b) => b.root.length - a.root.length)
  return { projectId: hits[0].projectId, relPath: hits[0].relPath }
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
  const picked = texts.slice(0, MAX_CANDIDATES)
  const hits = await Promise.all(picked.map((text) => resolveCandidate(cwd, text)))
  const out = []
  hits.forEach((hit, i) => {
    if (hit) out.push({ text: String(picked[i]), kind: hit.kind })
  })
  return out
}

/**
 * 點下去：告訴 renderer 用 App 開（專案內編輯器／檔案樹，其餘走檔案頁）。
 * @param {unknown} id
 * @param {unknown} text
 * @param {unknown} [line]
 * @returns {Promise<object>}
 */
async function revealLink(id, text, line) {
  const hit = await resolveCandidate(await baseCwd(id), text, { allowUnc: true })
  if (!hit) {
    const error = new Error('NO_PATH')
    error.code = 'NO_PATH'
    error.userMessage = '找不到這個路徑'
    throw error
  }
  const goto = Number(line) > 0 ? Math.floor(Number(line)) : 0
  let preferred = ''
  try {
    const meta = await store.get(String(id || ''))
    preferred = typeof meta?.projectId === 'string' ? meta.projectId : ''
  } catch { /* 沒有工作階段 metadata 就只靠路徑對專案 */ }
  let projects = []
  try {
    projects = await require('../workspace/store').list()
  } catch { projects = [] }
  const located = locateInProjects(hit.full, projects, preferred)
  if (located) {
    return {
      action: hit.kind === 'dir' ? 'reveal' : 'edit',
      projectId: located.projectId,
      relPath: located.relPath,
      line: hit.kind === 'file' ? goto : 0,
      kind: hit.kind
    }
  }
  return { action: 'explorer', kind: hit.kind, path: hit.full }
}

module.exports = {
  resolveCandidate, resolveLinks, revealLink, noteCwd, locateInProjects
}
