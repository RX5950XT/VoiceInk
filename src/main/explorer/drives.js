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
const { execFile } = require('child_process')

/** 虛擬位置：Windows 那樣的「本機」首頁（不是真路徑，別送進 paths）。 */
const THIS_PC = 'thispc'

/**
 * 碰使用者資料夾／磁碟一次最多等多久。**這一整支都不可以用同步 fs**：
 * 「下載」常被搬到網路磁碟，NAS 睡著時 `statSync` 會把主程序卡到 SMB 逾時（十幾秒），
 * 整個 App 在 Windows 眼裡就是「沒有回應」。逾時一律當成「在，只是現在慢」。
 */
const PROBE_TIMEOUT_MS = 1500

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {T} fallback 逾時回這個
 * @returns {Promise<T>}
 */
function withTimeout(promise, fallback, ms = PROBE_TIMEOUT_MS) {
  let timer
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms) })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}

/**
 * 是不是資料夾。不存在回 false；網路磁碟太慢（逾時）回 true，讓它照樣列出來。
 * @param {string} full
 * @returns {Promise<boolean>}
 */
function isDirSoon(full) {
  return withTimeout(fs.promises.stat(full).then((st) => st.isDirectory(), () => false), true)
}

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
async function place(folder, id, label) {
  const full = path.resolve(folder)
  return await isDirSoon(full) ? { id, label, path: full } : null
}

/**
 * @returns {Promise<Array<{ id: string, label: string, path: string }>>}
 */
async function listPlaces() {
  let home = ''
  try {
    home = os.homedir()
  } catch {
    return []
  }
  const pending = [place(home, 'home', '個人資料夾')]
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
    pending.push(place(full, id, label))
  }
  // 六個一起查：一個在睡著的 NAS 上也只多等一次逾時，不是六次
  return (await Promise.all(pending)).filter(Boolean)
}

/**
 * @returns {Promise<string[]>}
 */
async function driveLetters() {
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'fsutil.exe')
  const stdout = await new Promise((resolve) => {
    execFile(exe, ['fsinfo', 'drives'], { encoding: 'utf8', timeout: 3000, windowsHide: true },
      (error, out) => resolve(error ? '' : String(out || '')))
  })
  const found = stdout.match(/[A-Z]:\\/gi) || []
  if (found.length) return [...new Set(found.map((item) => item[0].toUpperCase()))]
  // 退回 C–Z 一起問；仍跳過 A／B，避免軟碟機卡住
  const letters = []
  for (let code = 67; code <= 90; code += 1) letters.push(String.fromCharCode(code))
  const alive = await Promise.all(letters.map((letter) => (
    withTimeout(fs.promises.stat(`${letter}:\\`).then(() => true, () => false), true)
  )))
  return letters.filter((_, i) => alive[i])
}

/**
 * 只回字母與根路徑。**不要**對每顆盤 `statfsSync`：空光碟機／未就緒
 * 的網路磁碟會卡住十幾秒，檔案頁一進來就像當掉。
 *
 * @returns {Array<{ letter: string, path: string, total: number, free: number }>}
 */
async function listDrives() {
  return (await driveLetters()).map((letter) => ({
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
    }, (error, out) => resolve(error ? [] : parseDriveInfo(out)))
  }).then(async (parsed) => (parsed.length ? parsed : (await listDrives()).map(toInfo)))
    .finally(() => { infoPending = null })
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
    return []
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
  return out
}

function capacity(raw) {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * 手機／相機（MTP）沒有磁碟代號，只存在於殼層的「本機」底下，路徑長這樣：
 * `::{20D04FE0-…}\\\?\usb#vid_18d1&pid_4ee2…#{6ac27878-…}`（只給 explorer.exe 開）。
 */
const DEVICE_RE = /^::\{20D04FE0-3AEA-1069-A2D8-08002B30309D\}\\{3}\?\\[\w#&.{}~-]+$/i

/** @param {unknown} raw */
function isDevicePath(raw) {
  return typeof raw === 'string' && raw.length <= 512 && DEVICE_RE.test(raw)
}

/**
 * 「本機」底下不是檔案系統的裝置（插著的手機、相機）。
 * @returns {Promise<Array<{ name: string, path: string, type: string }>>}
 */
function listDevices() {
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = '[Console]::OutputEncoding = [Text.UTF8Encoding]::new();'
    + ' @((New-Object -ComObject Shell.Application).NameSpace(17).Items() | Where-Object { -not $_.IsFileSystem } |'
    + ' ForEach-Object { @{ name = $_.Name; path = $_.Path; type = $_.Type } }) | ConvertTo-Json -Compress'
  return new Promise((resolve) => {
    execFile(exe, ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, encoding: 'utf8', timeout: 8000, maxBuffer: 256 * 1024
    }, (error, out) => resolve(error ? [] : parseDevices(out)))
  })
}

/** `ConvertTo-Json` 沒東西時回空字串、一台時回物件不是陣列。 @param {string} raw */
function parseDevices(raw) {
  let parsed = null
  try {
    parsed = JSON.parse(String(raw || '').trim() || 'null')
  } catch {
    return []
  }
  const list = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : [])
  return list.filter((item) => item && isDevicePath(item.path)).map((item) => ({
    name: String(item.name || '裝置').slice(0, 128),
    path: item.path,
    type: String(item.type || '').slice(0, 64)
  }))
}

module.exports = {
  THIS_PC, isThisPc, listPlaces, listDrives, driveInfo, parseDriveInfo, isDirSoon,
  listDevices, parseDevices
}
