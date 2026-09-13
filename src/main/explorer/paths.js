'use strict'

/**
 * 整機檔案總管的唯一路徑入口（Main Process）。
 *
 * 工作區那套 `resolveIn(projectRoot, relPath)` 套不進來——這一頁本來就要讀
 * `D:\`。renderer 送來的是絕對路徑，這裡只放行「磁碟機字母開頭的本機路徑」，
 * 列出／改動前用 `lstat` 確認存在；`realpath` 只當「目標仍是本機磁碟」的檢查，
 * 回傳值是使用者給的路徑，不把 junction 換成目標。
 *
 * 放行磁碟機字母與嚴格的 UNC（`\\伺服器\分享\…`）。
 * 不收 `\\.\`／`\\?\`／named pipe／NTFS ADS（第二個冒號）。
 */

const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const os = require('os')

const DRIVE_ABS = /^[A-Za-z]:\\/
const MAX_PATH = 32767
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/
const IPV4 = /^(\d{1,3})(\.(\d{1,3})){3}$/

/**
 * @param {string} code
 * @param {string} message
 * @returns {Error}
 */
function fail(code, message) {
  const error = new Error(code)
  error.code = code
  error.userMessage = message
  return error
}

/**
 * 新增／改名用的單層名字。跟工作區 `files.checkName` 同一套規則。
 * @param {unknown} raw
 * @returns {string}
 */
function checkName(raw) {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (!name || name.length > 255) throw fail('BAD_NAME', '名稱不合法')
  if (name === '.' || name === '..') throw fail('BAD_NAME', '名稱不合法')
  // eslint-disable-next-line no-control-regex
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(name)) {
    throw fail('BAD_NAME', '名稱不能含 \\ / : * ? " < > | 這些字元')
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) {
    throw fail('BAD_NAME', '這是 Windows 的保留名稱')
  }
  if (/[. ]$/.test(name)) throw fail('BAD_NAME', '名稱不能以句點或空白結尾')
  return name
}

/**
 * @param {string} target
 * @returns {string}
 */
function realOf(target) {
  try {
    return fs.realpathSync.native(target)
  } catch {
    return ''
  }
}

/**
 * @param {string} s
 * @returns {boolean}
 */
function isDevicePath(s) {
  const lower = String(s || '').toLowerCase()
  if (lower.startsWith('\\\\.\\') || lower.startsWith('\\\\?\\')) return true
  return /^\\\\[^\\]+\\(pipe|mailslot)(\\|$)/i.test(s)
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function isServerName(name) {
  if (IPV4.test(name)) {
    return name.split('.').every((n) => {
      const v = Number(n)
      return v >= 0 && v <= 255
    })
  }
  return SERVER_NAME.test(name)
}

/**
 * @param {unknown} raw
 * @returns {boolean}
 */
function isUnc(raw) {
  return typeof raw === 'string' && raw.startsWith('\\\\') && !isDevicePath(raw)
}

/**
 * @param {string} s 已把 / 換成 \
 * @returns {string}
 */
function resolveUnc(s) {
  if (isDevicePath(s)) throw fail('BAD_PATH', '路徑不合法')
  if (s.indexOf(':', 2) !== -1) throw fail('BAD_PATH', '路徑不合法')
  const parts = s.replace(/^\\\\/, '').split('\\').filter(Boolean)
  if (parts.length < 2) throw fail('BAD_PATH', '路徑不合法')
  const server = parts[0]
  const share = parts[1]
  if (!isServerName(server)) throw fail('BAD_PATH', '路徑不合法')
  if (/^(pipe|mailslot)$/i.test(share)) throw fail('BAD_PATH', '路徑不合法')
  const rest = []
  for (const part of parts.slice(2)) {
    if (part === '.') continue
    if (part === '..') {
      if (!rest.length) throw fail('BAD_PATH', '路徑不合法')
      rest.pop()
      continue
    }
    // eslint-disable-next-line no-control-regex
    if (/[<>:"/|?*\u0000-\u001f]/.test(part) || /[<>:"/|?*\u0000-\u001f]/.test(share)) {
      throw fail('BAD_PATH', '路徑不合法')
    }
    rest.push(part)
  }
  // eslint-disable-next-line no-control-regex
  if (/[<>:"/|?*\u0000-\u001f]/.test(share)) throw fail('BAD_PATH', '路徑不合法')
  const full = `\\\\${server}\\${share}${rest.length ? '\\' + rest.join('\\') : ''}`
  if (full.length > MAX_PATH) throw fail('BAD_PATH', '路徑不合法')
  return full
}

/**
 * 上一層。磁碟根／UNC 分享根回空字串。
 * @param {string} full
 * @returns {string}
 */
function parentOf(full) {
  const value = String(full || '')
  if (value.startsWith('\\\\')) {
    const parts = value.replace(/\\+$/, '').replace(/^\\\\/, '').split('\\').filter(Boolean)
    if (parts.length <= 2) return ''
    return `\\\\${parts.slice(0, -1).join('\\')}`
  }
  const trimmed = value.replace(/\\+$/, '')
  const parent = trimmed.replace(/\\[^\\]+$/, '')
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`
  return parent
}

/**
 * @param {string} full
 * @returns {boolean}
 */
function isAllowedAbs(full) {
  if (typeof full !== 'string' || !full) return false
  if (full.startsWith('\\\\')) {
    try {
      return resolveUnc(full) === full || resolveUnc(full).toLowerCase() === full.toLowerCase()
    } catch {
      return false
    }
  }
  return DRIVE_ABS.test(full) && full.indexOf(':', 2) === -1
}

/**
 * 正規化成 Windows 磁碟機絕對路徑或 UNC。不碰磁碟。
 * @param {unknown} raw
 * @returns {string}
 */
function resolveAbs(raw) {
  if (typeof raw !== 'string' || !raw) throw fail('BAD_PATH', '路徑不合法')
  if (raw.includes('\0')) throw fail('BAD_PATH', '路徑不合法')
  if (raw.length > MAX_PATH) throw fail('BAD_PATH', '路徑不合法')
  const s = raw.replace(/\//g, '\\')
  if (s.startsWith('\\\\')) return resolveUnc(s)
  if (!DRIVE_ABS.test(s)) throw fail('BAD_PATH', '路徑不合法')
  if (s.indexOf(':', 2) !== -1) throw fail('BAD_PATH', '路徑不合法')
  let full
  try {
    full = path.resolve(s)
  } catch {
    throw fail('BAD_PATH', '路徑不合法')
  }
  if (!DRIVE_ABS.test(full)) throw fail('BAD_PATH', '路徑不合法')
  if (full.indexOf(':', 2) !== -1) throw fail('BAD_PATH', '路徑不合法')
  if (full.startsWith('\\\\')) throw fail('BAD_PATH', '路徑不合法')
  return full
}

/**
 * 目標必須存在。回傳使用者路徑（不跟 junction）。
 * realpath 若解得出來，仍須是本機磁碟機路徑。
 * @param {unknown} raw
 * @returns {string}
 */
function resolveExisting(raw) {
  const full = resolveAbs(raw)
  let st
  try {
    st = fs.lstatSync(full)
  } catch {
    throw fail('NOT_FOUND', '找不到這個檔案')
  }
  if (!st) throw fail('NOT_FOUND', '找不到這個檔案')
  const real = realOf(full)
  if (real && !isAllowedAbs(real)) throw fail('BAD_PATH', '路徑不合法')
  return full
}

/**
 * 磁碟根目錄與 `%SystemRoot%` 本身不准當新增／貼上／還原的目的地。
 * 家目錄根層可以放子項（擋的是刪掉家目錄自己，見 `isProtected`）。
 * @param {string} full
 * @returns {boolean}
 */
function isSystemLocked(full) {
  const resolved = path.resolve(full).replace(/[\\/]+$/, '')
  const lower = resolved.toLowerCase()
  if (/^[a-z]:$/i.test(lower)) return true
  const windir = String(process.env.SystemRoot || 'C:\\Windows').replace(/[\\/]+$/, '').toLowerCase()
  return lower === windir
}

/**
 * @param {string} full
 */
function assertCreatable(full) {
  if (isSystemLocked(full)) throw fail('PROTECTED', '這個位置不能改')
}

/**
 * 刪連結本身，不走進目標。資料夾則逐層 lstat。
 * @param {string} full
 */
async function removeLinkOrTree(full) {
  let st
  try {
    st = await fsp.lstat(full)
  } catch {
    throw fail('NOT_FOUND', '找不到這個檔案')
  }
  if (st.isSymbolicLink()) {
    try {
      await fsp.unlink(full)
    } catch {
      await fsp.rmdir(full)
    }
    return
  }
  if (!st.isDirectory()) {
    await fsp.unlink(full)
    return
  }
  const kids = await fsp.readdir(full, { withFileTypes: true })
  for (const kid of kids) {
    await removeLinkOrTree(path.join(full, kid.name))
  }
  await fsp.rmdir(full)
}

/**
 * 刪／改名／搬移不准動的位置：磁碟根目錄、Windows 目錄本身、使用者家目錄本身。
 * 瀏覽與開啟不受這條管。
 * @param {string} full 已 resolve 的絕對路徑
 * @returns {boolean}
 */
function isProtected(full) {
  const resolved = path.resolve(full).replace(/[\\/]+$/, '')
  const lower = resolved.toLowerCase()
  if (/^[a-z]:$/i.test(lower)) return true
  let home = ''
  try {
    home = path.resolve(os.homedir()).toLowerCase()
  } catch {
    home = ''
  }
  if (home && lower === home) return true
  const windir = String(process.env.SystemRoot || 'C:\\Windows').replace(/[\\/]+$/, '').toLowerCase()
  return lower === windir
}

/**
 * @param {string} full
 */
function assertMutable(full) {
  if (isProtected(full)) throw fail('PROTECTED', '這個位置不能改')
}

module.exports = {
  DRIVE_ABS,
  MAX_PATH,
  fail,
  checkName,
  realOf,
  isUnc,
  isDevicePath,
  parentOf,
  isAllowedAbs,
  resolveAbs,
  resolveExisting,
  isProtected,
  isSystemLocked,
  assertMutable,
  assertCreatable,
  removeLinkOrTree
}
