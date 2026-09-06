'use strict'

/**
 * 使用時長的純函式：日期格式、日／小時切桶、網址網域、忽略清單。
 * 對齊 Tai 的寫入規則（秒、整點小時桶、日桶），不碰 SQLite。
 */

const IGNORE_NAMES = new Set([
  'Tai', 'VoiceInk', 'electron', 'SearchHost', 'Taskmgr', 'ApplicationFrameHost',
  'dwm', 'DWM', 'ShellExperienceHost', 'StartMenuExperienceHost', 'TextInputHost',
  'SystemSettings', 'LockApp', 'SearchApp', 'Video.UI', 'Idle', 'System',
  'Registry', 'csrss', 'smss', 'wininit', 'services', 'lsass', 'svchost',
  'fontdrvhost', 'conhost', 'sihost', 'taskhostw', 'RuntimeBroker',
  'SecurityHealthSystray', 'Widgets', 'WidgetService', 'LockAppHost',
  'CrossDeviceResume', 'PhoneExperienceHost', 'UserOOBEBroker', 'ChxUI',
  'LogonUI', 'winlogon', 'dwm.exe'
])

const MAX_HOUR = 3600
const MAX_DAY = 86400
const MAX_URL = 2048
const MAX_TITLE = 500
const IDLE_SLEEP_MS = 10 * 60 * 1000
const WS_PORT = 8908
const WS_PATH = '/TaiWebSentry'

/** @param {number} n */
function pad(n) {
  return n < 10 ? `0${n}` : String(n)
}

/** @param {Date} d */
function fmtDateTime(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** @param {Date} d */
function fmtHour(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:00:00`
}

/** @param {Date} d */
function fmtDay(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 00:00:00`
}

/** @param {Date} d */
function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** 週一 00:00（跟 Tai 一樣） @param {Date} d */
function weekStart(d) {
  const day = d.getDay() || 7
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - (day - 1))
}

/** @param {string} iso @returns {Date} */
function parseStamp(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(iso || ''))
  if (!m) return new Date(NaN)
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))
}

/**
 * 一段時長依開始時間切成整點小時桶（Tai UpdateAppDuration）。
 * @param {Date} start
 * @param {number} duration
 * @returns {Map<string, number>}
 */
function splitHours(start, duration) {
  const map = new Map()
  if (!(start instanceof Date) || !Number.isFinite(start.getTime()) || duration <= 0) return map
  const remainInHour = (59 - start.getMinutes()) * 60 + (60 - start.getSeconds())
  const first = Math.min(duration, remainInHour)
  let cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate(), start.getHours())
  map.set(fmtHour(cursor), first)
  let left = duration - first
  while (left > 0) {
    cursor = new Date(cursor.getTime() + 3600 * 1000)
    const chunk = Math.min(left, MAX_HOUR)
    map.set(fmtHour(cursor), chunk)
    left -= chunk
  }
  return map
}

/**
 * 一段時長依開始時間切成日桶。
 * @param {Date} start
 * @param {number} duration
 * @returns {Map<string, number>}
 */
function splitDays(start, duration) {
  const map = new Map()
  if (!(start instanceof Date) || !Number.isFinite(start.getTime()) || duration <= 0) return map
  const next = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1)
  const remainInDay = Math.max(1, Math.floor((next - start) / 1000))
  const first = Math.min(duration, remainInDay)
  let cursor = startOfDay(start)
  map.set(fmtDay(cursor), first)
  let left = duration - first
  while (left > 0) {
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1)
    const chunk = Math.min(left, MAX_DAY)
    map.set(fmtDay(cursor), chunk)
    left -= chunk
  }
  return map
}

/**
 * Tai UrlHelper.GetDomain：去掉協議，取到第一個 / 之前（保留 www.）。
 * @param {string} url
 */
function getDomain(url) {
  let s = String(url || '')
  s = s.replace(/^(https|http|ftp|rtsp|mms):\/\//i, '')
  const slash = s.indexOf('/')
  if (slash !== -1) s = s.slice(0, slash)
  return s
}

/**
 * Tai UrlHelper.GetName：www.youtube.com → Youtube。
 * @param {string} url
 */
function getSiteName(url) {
  const domain = getDomain(url)
  const named = {
    'www.google.com': 'Google',
    'github.com': 'Github',
    'translate.google.com': 'Google 翻译',
    'v2ex.com': 'V2EX',
    'www.bilibili.com': '哔哩哔哩'
  }
  if (named[domain]) return named[domain]
  const arr = domain.split('.')
  const cap = (w) => (w ? w[0].toUpperCase() + w.slice(1) : w)
  if (arr.length === 2) return cap(arr[0])
  if (arr.length >= 3) {
    return arr[0] === 'www' ? cap(arr[1]) : `${cap(arr[1])} ${cap(arr[0])}`
  }
  return cap(domain)
}

/** @param {string} name */
function isIgnoredName(name) {
  const n = String(name || '')
  if (!n) return true
  if (IGNORE_NAMES.has(n)) return true
  return IGNORE_NAMES.has(n.replace(/\.exe$/i, ''))
}

/** 沒有執行檔路徑就不要記（Tai 同樣丟掉）。 @param {string} filePath */
function isSystemPath(filePath) {
  return !String(filePath || '').trim()
}

/**
 * @param {unknown} raw
 * @returns {{ url: string, title: string, icon: string, duration: number, activeAt: Date } | null}
 */
function sanitizeWebNotify(raw) {
  if (!raw || typeof raw !== 'object') return null
  const url = String(raw.Url || raw.url || '').trim()
  if (!/^https?:\/\//i.test(url) || url.length > MAX_URL) return null
  const duration = Math.floor(Number(raw.Duration ?? raw.duration))
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_HOUR) return null
  const epoch = Number(raw.ActiveTime ?? raw.activeTime)
  const activeAt = Number.isFinite(epoch) && epoch > 1e9
    ? new Date(epoch * 1000)
    : new Date()
  if (!Number.isFinite(activeAt.getTime())) return null
  return {
    url: url.slice(0, MAX_URL),
    title: String(raw.Title || raw.title || '').slice(0, MAX_TITLE),
    icon: String(raw.Icon || raw.icon || '').slice(0, MAX_URL),
    duration,
    activeAt
  }
}

const FRIENDLY_PROCESS = {
  msedge: 'Microsoft Edge',
  chrome: 'Google Chrome',
  firefox: 'Firefox',
  explorer: '檔案總管',
  Code: 'Visual Studio Code',
  WINWORD: 'Microsoft Word',
  EXCEL: 'Microsoft Excel',
  POWERPNT: 'Microsoft PowerPoint',
  Outlook: 'Microsoft Outlook',
  ONENOTE: 'Microsoft OneNote',
  Discord: 'Discord',
  Telegram: 'Telegram',
  Slack: 'Slack',
  steam: 'Steam',
  javaw: 'Java',
  python: 'Python',
  WindowsTerminal: 'Windows Terminal',
  powershell: 'PowerShell',
  cmd: '命令提示字元',
  notepad: '記事本',
  Taskmgr: '工作管理員'
}

/**
 * 畫面上用常見名稱，不要直接秀進程名。
 * 優先：使用者別名 → 檔案說明（去掉副標）→ 對照表 → 稍加整理的進程名。
 * @param {{ name?: string, alias?: string, description?: string, domain?: string }} row
 */
function friendlyName(row) {
  if (!row) return '—'
  const alias = String(row.alias || '').trim()
  if (alias) return alias
  if (row.domain) {
    const title = String(row.name || '').trim()
    return title || String(row.domain)
  }
  const desc = String(row.description || '').trim()
  if (desc) {
    const cut = desc.split(/\s+-\s+/)[0].trim()
    return cut || desc
  }
  const name = String(row.name || '').trim()
  if (!name) return '—'
  if (FRIENDLY_PROCESS[name]) return FRIENDLY_PROCESS[name]
  const head = name.split(/[-_]/)[0]
  if (head && head !== name && head.length >= 3 && !/^(Win64|Win32|Shipping)$/i.test(head)) {
    return head.replace(/([a-z])([A-Z])/g, '$1 $2')
  }
  return name.replace(/([a-z])([A-Z])/g, '$1 $2')
}

/** @param {number} sec */
function formatDuration(sec) {
  const n = Math.max(0, Math.floor(Number(sec) || 0))
  const h = Math.floor(n / 3600)
  const m = Math.floor((n % 3600) / 60)
  const s = n % 60
  if (h > 0) return m > 0 ? `${h} 小時 ${m} 分` : `${h} 小時`
  if (m > 0) return s > 0 ? `${m} 分 ${s} 秒` : `${m} 分`
  return `${s} 秒`
}

/**
 * @param {'day'|'week'|'month'|'year'} range
 * @param {Date} cursor
 * @returns {{ start: Date, end: Date, labels: string[] }}
 */
function rangeBounds(range, cursor) {
  const c = cursor instanceof Date ? cursor : new Date()
  if (range === 'week') {
    const start = weekStart(c)
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6, 23, 59, 59)
    const labels = ['週一', '週二', '週三', '週四', '週五', '週六', '週日']
    return { start, end, labels }
  }
  if (range === 'month') {
    const start = new Date(c.getFullYear(), c.getMonth(), 1)
    const last = new Date(c.getFullYear(), c.getMonth() + 1, 0)
    const end = new Date(last.getFullYear(), last.getMonth(), last.getDate(), 23, 59, 59)
    const labels = Array.from({ length: last.getDate() }, (_, i) => String(i + 1))
    return { start, end, labels }
  }
  if (range === 'year') {
    const start = new Date(c.getFullYear(), 0, 1)
    const end = new Date(c.getFullYear(), 11, 31, 23, 59, 59)
    const labels = Array.from({ length: 12 }, (_, i) => `${i + 1} 月`)
    return { start, end, labels }
  }
  const start = startOfDay(c)
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 23, 59, 59)
  const labels = Array.from({ length: 24 }, (_, i) => `${pad(i)}:00`)
  return { start, end, labels }
}

module.exports = {
  IGNORE_NAMES,
  MAX_HOUR,
  MAX_DAY,
  MAX_URL,
  IDLE_SLEEP_MS,
  WS_PORT,
  WS_PATH,
  pad,
  fmtDateTime,
  fmtHour,
  fmtDay,
  startOfDay,
  weekStart,
  parseStamp,
  splitHours,
  splitDays,
  getDomain,
  getSiteName,
  isIgnoredName,
  isSystemPath,
  sanitizeWebNotify,
  friendlyName,
  formatDuration,
  rangeBounds
}
