'use strict'

/**
 * 本機磁碟與使用者資料夾（Main Process）。
 *
 * 磁碟字母走 `fsutil fsinfo drives`（System32），不要 A–Z 去 `existsSync`：
 * 沒有軟碟的 A:／B: 與空光碟機會卡住好幾秒。用量再 `statfsSync`。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

/**
 * @param {string} folder
 * @param {string} id
 * @param {string} label
 * @returns {{ id: string, label: string, path: string } | null}
 */
function place(folder, id, label) {
  try {
    const full = path.resolve(folder)
    if (!fs.statSync(full).isDirectory()) return null
    return { id, label, path: full }
  } catch {
    return null
  }
}

/**
 * @returns {Array<{ id: string, label: string, path: string }>}
 */
function listPlaces() {
  let home = ''
  try {
    home = os.homedir()
  } catch {
    return []
  }
  const out = []
  const homePlace = place(home, 'home', '本機')
  if (homePlace) out.push(homePlace)
  const known = [
    ['Desktop', 'desktop', '桌面'],
    ['Downloads', 'downloads', '下載'],
    ['Documents', 'documents', '文件'],
    ['Pictures', 'pictures', '圖片'],
    ['Music', 'music', '音樂'],
    ['Videos', 'videos', '影片']
  ]
  for (const [folder, id, label] of known) {
    const item = place(path.join(home, folder), id, label)
    if (item) out.push(item)
  }
  return out
}

/**
 * @returns {string[]}
 */
function driveLetters() {
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'fsutil.exe')
  try {
    const result = spawnSync(exe, ['fsinfo', 'drives'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true
    })
    const found = String(result.stdout || '').match(/[A-Z]:\\/gi) || []
    if (found.length) return [...new Set(found.map((item) => item[0].toUpperCase()))]
  } catch {
    // 退回 C–Z；仍跳過 A／B，避免軟碟機卡住
  }
  const fallback = []
  for (let code = 67; code <= 90; code += 1) {
    const letter = String.fromCharCode(code)
    try {
      if (fs.existsSync(`${letter}:\\`)) fallback.push(letter)
    } catch {
      // 這顆碰不得
    }
  }
  return fallback
}

/**
 * 只回字母與根路徑。**不要**對每顆盤 `statfsSync`：空光碟機／未就緒
 * 的網路磁碟會卡住十幾秒，檔案頁一進來就像當掉。
 *
 * @returns {Array<{ letter: string, path: string, total: number, free: number }>}
 */
function listDrives() {
  return driveLetters().map((letter) => ({
    letter,
    path: `${letter}:\\`,
    total: 0,
    free: 0
  }))
}

module.exports = { listPlaces, listDrives }
