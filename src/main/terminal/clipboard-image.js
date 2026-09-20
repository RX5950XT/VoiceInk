'use strict'

/**
 * 把剪貼簿裡的**圖片**落成一個真的檔案，讓終端機貼得出一條路徑。
 *
 * 為什麼不直接把 `^V` 丟給 CLI 自己去讀剪貼簿：那條路只有少數 CLI 走得通，而且在
 * ConPTY 裡常常一聲不吭（使用者看到的就是「截圖貼不進去」）。改成 App 自己把圖片
 * 存成 PNG、把路徑貼進輸入框，任何 CLI 都吃得下——Claude Code、Codex、Gemini CLI
 * 看到圖片路徑都會自己把圖讀進去。
 *
 * 檔案放在 `<userData>/clipboard-images`，每次貼上前先掃一次：超過一天或超過 40 張
 * 就從最舊的刪起（貼過的圖 CLI 通常當下就讀完了，留著只是佔空間）。
 */
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

/** 留幾張 */
const KEEP_FILES = 40
/** 留多久 */
const KEEP_MS = 24 * 60 * 60 * 1000
/** 超過這個大小就不貼了（截圖不可能這麼大，多半是誤判） */
const MAX_BYTES = 64 * 1024 * 1024

let dir = ''

/** @param {string} userData */
function configure(userData) {
  dir = path.join(String(userData || ''), 'clipboard-images')
}

/** 兩位數補零 */
function pad(n) {
  return String(n).padStart(2, '0')
}

/**
 * `clip-20260921-134501-123.png`：看得懂、排得動、不會撞名。
 * @param {Date} at
 */
function fileNameAt(at) {
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`
    + `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
    + `-${String(at.getMilliseconds()).padStart(3, '0')}`
  return `clip-${stamp}.png`
}

/**
 * 舊圖清掉。失敗完全不影響這次貼上（只是留著佔空間）。
 */
async function sweep() {
  let names = []
  try {
    names = await fsp.readdir(dir)
  } catch {
    return
  }
  const now = Date.now()
  /** @type {Array<{ file: string, mtimeMs: number }>} */
  const kept = []
  for (const name of names) {
    if (!/^clip-[\d-]+\.png$/.test(name)) continue
    const file = path.join(dir, name)
    try {
      const st = await fsp.stat(file)
      if (now - st.mtimeMs > KEEP_MS) {
        await fsp.rm(file, { force: true })
        continue
      }
      kept.push({ file, mtimeMs: st.mtimeMs })
    } catch {
      // 剛好被別人刪掉就算了
    }
  }
  kept.sort((a, b) => a.mtimeMs - b.mtimeMs)
  for (const item of kept.slice(0, Math.max(0, kept.length - KEEP_FILES))) {
    try { await fsp.rm(item.file, { force: true }) } catch { /* 同上 */ }
  }
}

/**
 * 剪貼簿現在有沒有圖片；有的話存成 PNG 回傳路徑。
 *
 * @returns {Promise<{ path: string, width: number, height: number } | null>} 沒有圖片回 null
 */
async function save() {
  if (!dir) return null
  const { clipboard } = require('electron')
  const image = clipboard.readImage()
  if (!image || image.isEmpty()) return null
  const size = image.getSize()
  const buf = image.toPNG()
  if (!buf || !buf.length || buf.length > MAX_BYTES) return null
  await fsp.mkdir(dir, { recursive: true })
  void sweep()
  const at = new Date()
  let file = path.join(dir, fileNameAt(at))
  // 同一毫秒貼兩次也不要蓋掉前一張
  for (let i = 1; i < 100 && fs.existsSync(file); i += 1) {
    file = path.join(dir, fileNameAt(at).replace(/\.png$/, `-${i}.png`))
  }
  await fsp.writeFile(file, buf)
  return { path: file, width: size.width || 0, height: size.height || 0 }
}

module.exports = { configure, save, fileNameAt, sweep, KEEP_FILES, KEEP_MS }
