'use strict'

/**
 * 本機磁碟與使用者資料夾（Main Process）。
 *
 * 磁碟字母走 `fsutil fsinfo drives`（System32），不要 A–Z 去 `existsSync`：
 * 沒有軟碟的 A:／B: 與空光碟機會卡住好幾秒。用量再 `statfsSync`。
 */

const fs = require('../raw-fs')
const os = require('os')
const path = require('path')
const { spawnSync, execFile } = require('child_process')

/** 虛擬位置：Windows 那樣的「本機」首頁（不是真路徑，別送進 paths）。 */
const THIS_PC = 'thispc'

/**
 * @param {unknown} raw
 * @returns {boolean}
 */
function isThisPc(raw) {
  return String(raw || '').replace(/[\\/]+$/, '').toLowerCase() === THIS_PC
}

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
  const homePlace = place(home, 'home', '個人資料夾')
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
    let full = path.join(home, folder)
    try {
      const { app } = require('electron')
      if (app) full = app.getPath(id)
    } catch {
      // 純 Node 或系統位置取不到時，保留家目錄退路。
    }
    const item = place(full, id, label)
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

/**
 * 「本機」首頁要的容量與磁碟種類。**不要**對每顆盤 `statfsSync`
 * （空光碟機／斷線的網路磁碟會卡十幾秒）：一次 CIM 查詢就把標籤、
 * 檔案系統、容量、種類全拿回來，而且是非同步的，卡不到主程序。
 *
 * @returns {Promise<Array<{ letter: string, path: string, label: string, fs: string, total: number, free: number, type: number, remote: string }>>}
 */
let infoPending = null
function driveInfo() {
  if (infoPending) return infoPending
  const exe = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  const script = '[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); Get-CimInstance Win32_LogicalDisk |'
    + ' Select-Object DeviceID,VolumeName,FileSystem,DriveType,Size,FreeSpace,ProviderName |'
    + ' ConvertTo-Json -Compress'
  infoPending = new Promise((resolve) => {
    execFile(exe, ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, encoding: 'utf8', timeout: 8000, maxBuffer: 256 * 1024
    }, (error, out) => resolve(error ? listDrives().map(toInfo) : parseDriveInfo(out)))
  }).finally(() => { infoPending = null })
  return infoPending
}

/**
 * @param {{ letter: string, path: string }} disk
 */
function toInfo(disk) {
  return { ...disk, label: '', fs: '', total: 0, free: 0, type: 3, remote: '' }
}

/**
 * `ConvertTo-Json` 只有一顆盤時回物件不是陣列。
 *
 * @param {string} raw
 * @returns {Array<object>}
 */
function parseDriveInfo(raw) {
  let parsed = null
  try {
    parsed = JSON.parse(String(raw || '').trim() || 'null')
  } catch {
    return listDrives().map(toInfo)
  }
  const list = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : [])
  const out = []
  for (const item of list) {
    const id = String((item && item.DeviceID) || '')
    if (!/^[A-Za-z]:$/.test(id)) continue
    const letter = id[0].toUpperCase()
    out.push({
      letter,
      path: `${letter}:\\`,
      label: String((item && item.VolumeName) || '').slice(0, 64),
      fs: String((item && item.FileSystem) || '').slice(0, 16),
      total: capacity(item.Size),
      free: Math.min(capacity(item.FreeSpace), capacity(item.Size)),
      type: Number(item && item.DriveType) || 0,
      remote: String((item && item.ProviderName) || '').slice(0, 260)
    })
  }
  return out.length ? out : listDrives().map(toInfo)
}

function capacity(raw) {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 0
}

module.exports = { THIS_PC, isThisPc, listPlaces, listDrives, driveInfo, parseDriveInfo }
