'use strict'

/**
 * Claude Code 的 `~/.claude/settings.json` 讀寫（Main Process）。
 *
 * 這是整個 cc-switch 功能裡唯一會動到「App 之外的使用者真實資料」的地方，所以規矩比別處嚴：
 *
 * 1. **只動 `env` 裡我們自己管的那幾個鍵**（`MANAGED_ENV_KEYS`）。使用者的 `hooks`、
 *    `enabledPlugins`、`statusLine`、`permissions`、`model` 通通原樣留著。
 *    上游 cc-switch 是把整份 settings.json 換成供應商的設定（SSOT 模型），照抄過來
 *    等於使用者換一次供應商就把自己的 hooks 與外掛清單全部弄丟。
 * 2. **切換時先清掉前一家留下的鍵**：A 家有 `ANTHROPIC_API_KEY`、B 家用
 *    `ANTHROPIC_AUTH_TOKEN`，只做 merge 的話 A 的金鑰會殘留，Claude Code 兩個都送出去。
 * 3. **寫入前備份、寫入用原子替換**：備份放 `<userData>/claude-backup/`，
 *    只留最近 `MAX_BACKUPS` 份；寫檔先寫暫存再 rename，避免半寫狀態把設定檔弄壞。
 *
 * 純函式（`stripManaged`／`mergeEnv`／`sanitizeEnv`）不碰檔案系統，可以 node 直測。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

/**
 * 我們管的 env 鍵。切換供應商時這些會被整組換掉，其餘一律不動。
 *
 * `ANTHROPIC_SMALL_FAST_MODEL` 是舊版 Claude Code 的鍵，現在的預設不會再寫，
 * 但舊使用者的設定檔裡可能還躺著一個——列進來才清得掉。
 */
const MANAGED_ENV_KEYS = Object.freeze([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW'
])

const MANAGED_SET = new Set(MANAGED_ENV_KEYS)

/** 單一 env 值的長度上限。金鑰再長也不會到這個量級，超過就是餵了奇怪的東西進來。 */
const MAX_ENV_VALUE = 4096
/** settings.json 大小上限（8MB）。正常是幾 KB，這條只是防讀到不該讀的東西。 */
const MAX_SETTINGS_BYTES = 8 * 1024 * 1024
/** 備份保留份數 */
const MAX_BACKUPS = 20

/** @type {{ homeDir: string, backupDir: string }} */
const paths = { homeDir: '', backupDir: '' }

/**
 * 測試要能把家目錄指到暫存夾，不然跑一次測試就改到開發者自己的 Claude Code 設定。
 * 正式執行時 main.js 只傳 backupDir（放 userData），homeDir 留空走 os.homedir()。
 * @param {{ homeDir?: string, backupDir?: string }} options
 */
function configure(options = {}) {
  if (typeof options.homeDir === 'string') paths.homeDir = options.homeDir
  if (typeof options.backupDir === 'string') paths.backupDir = options.backupDir
}

/** @returns {string} */
function homeDir() {
  return paths.homeDir || os.homedir()
}

/** @returns {string} `~/.claude` */
function claudeDir() {
  return path.join(homeDir(), '.claude')
}

/** @returns {string} `~/.claude/settings.json` */
function settingsPath() {
  return path.join(claudeDir(), 'settings.json')
}

/** @returns {string} `~/.claude.json`（MCP 與 CLI 狀態都在這裡，不是 settings.json） */
function claudeJsonPath() {
  return path.join(homeDir(), '.claude.json')
}

/** @returns {string} */
function backupDir() {
  return paths.backupDir || path.join(claudeDir(), '.voiceink-backup')
}

// ===== 純函式 =====

/**
 * 把供應商給的 env 收斂成「字串 → 字串、只留我們管的鍵、非空值」。
 *
 * 值一律轉字串：Claude Code 讀的是環境變數，數字型的 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`
 * 寫成 JSON number 也能跑，但兩種型別混在同一個檔案裡之後很難比對「有沒有變」。
 *
 * @param {unknown} raw
 * @returns {Record<string, string>}
 */
function sanitizeEnv(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  /** @type {Record<string, string>} */
  const out = {}
  for (const key of MANAGED_ENV_KEYS) {
    const value = raw[key]
    if (value === undefined || value === null) continue
    if (typeof value === 'object') continue
    const text = String(value).trim()
    if (!text || text.length > MAX_ENV_VALUE) continue
    out[key] = text
  }
  return out
}

/**
 * 移除我們管的鍵，保留其他全部。
 * @param {Record<string, unknown> | undefined} env
 * @returns {Record<string, unknown>}
 */
function stripManaged(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return {}
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const [key, value] of Object.entries(env)) {
    if (MANAGED_SET.has(key)) continue
    out[key] = value
  }
  return out
}

/**
 * 先清掉舊供應商留下的鍵，再放進新的那組。
 * @param {Record<string, unknown> | undefined} currentEnv 設定檔裡現有的整個 env
 * @param {Record<string, unknown>} providerEnv 供應商設定（會先過 sanitizeEnv）
 * @returns {Record<string, unknown>}
 */
function mergeEnv(currentEnv, providerEnv) {
  return { ...stripManaged(currentEnv), ...sanitizeEnv(providerEnv) }
}

/**
 * 從 env 取出目前指向哪個 Base URL（給 UI 判斷「現在真的是哪一家」用）。
 * @param {Record<string, unknown> | undefined} env
 * @returns {string}
 */
function baseUrlOf(env) {
  const raw = env && typeof env === 'object' ? env.ANTHROPIC_BASE_URL : ''
  return typeof raw === 'string' ? raw.trim() : ''
}

// ===== 檔案 I/O =====

/**
 * 讀一份 JSON 設定檔。檔案不存在回空物件；**壞掉的 JSON 一律拋錯**，
 * 不能當成空物件——那樣下一步寫入就把使用者原本的設定整份洗掉了。
 *
 * `~/.claude/settings.json` 與 `~/.claude.json` 共用這一份實作（後者大得多，
 * 裡面有全部專案的歷史，所以上限另外給）。
 *
 * @param {string} file
 * @param {number} [maxBytes]
 * @returns {Record<string, unknown>}
 */
function readJsonFile(file, maxBytes = MAX_SETTINGS_BYTES) {
  let raw
  const label = path.basename(file)
  try {
    const stat = fs.statSync(file)
    if (stat.size > maxBytes) {
      const error = new Error('SETTINGS_TOO_LARGE')
      error.code = 'SETTINGS_TOO_LARGE'
      error.userMessage = `${label} 太大，請先檢查該檔案`
      throw error
    }
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return {}
    if (error && error.code === 'SETTINGS_TOO_LARGE') throw error
    const wrapped = new Error('SETTINGS_READ_FAILED')
    wrapped.code = 'SETTINGS_READ_FAILED'
    wrapped.userMessage = `讀取 ${label} 失敗`
    throw wrapped
  }
  if (!raw.trim()) return {}
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    const error = new Error('SETTINGS_INVALID_JSON')
    error.code = 'SETTINGS_INVALID_JSON'
    error.userMessage = `${label} 不是合法 JSON，請先修好再操作`
    throw error
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const error = new Error('SETTINGS_INVALID_SHAPE')
    error.code = 'SETTINGS_INVALID_SHAPE'
    error.userMessage = `${label} 的最外層必須是物件`
    throw error
  }
  return parsed
}

/**
 * @returns {Record<string, unknown>}
 */
function readSettings() {
  return readJsonFile(settingsPath())
}

/**
 * 備份一份設定檔。檔案不存在就不用備份（回 null）。
 * 備份失敗**必須擋下整個寫入**：沒有退路的覆寫不值得為了「順利完成」而冒險。
 * @param {string} file
 * @param {string} tag 備份檔名前綴（同一個資料夾裡要分得出是哪一份）
 * @returns {string | null} 備份檔路徑
 */
function backupFile(file, tag) {
  if (!fs.existsSync(file)) return null
  const dir = backupDir()
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = path.join(dir, `${tag}-${stamp}.json`)
  fs.copyFileSync(file, target)
  pruneBackups(dir, tag)
  return target
}

/** @returns {string | null} */
function backupSettings() {
  return backupFile(settingsPath(), 'settings')
}

/**
 * 每個 tag 各留最近 MAX_BACKUPS 份。
 * @param {string} dir
 * @param {string} tag
 */
function pruneBackups(dir, tag) {
  let names
  try {
    names = fs.readdirSync(dir).filter((name) => name.startsWith(`${tag}-`) && name.endsWith('.json')).sort()
  } catch {
    return
  }
  for (const name of names.slice(0, Math.max(0, names.length - MAX_BACKUPS))) {
    try {
      fs.unlinkSync(path.join(dir, name))
    } catch {
      // 刪不掉就算了，備份多留幾份不是問題
    }
  }
}

/**
 * 原子寫入：先寫暫存檔再 rename，避免中途失敗留下半份設定。
 * @param {string} file
 * @param {Record<string, unknown>} data
 */
function writeJsonFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.voiceink-tmp.${process.pid}.${Date.now()}`
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  try {
    fs.renameSync(tmp, file)
  } catch (error) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // 暫存檔清不掉不影響結果
    }
    throw error
  }
}

/**
 * @param {Record<string, unknown>} data
 */
function writeSettings(data) {
  writeJsonFile(settingsPath(), data)
}

/**
 * 套用一個供應商：備份 → 讀 → 換掉我們管的 env → 寫回。
 *
 * @param {Record<string, unknown>} providerEnv 供應商的 env（Claude 官方傳空物件＝清乾淨）
 * @returns {{ path: string, backup: string | null, env: Record<string, unknown> }}
 */
function applyEnv(providerEnv) {
  const settings = readSettings()
  const backup = backupSettings()
  const env = mergeEnv(settings.env, providerEnv || {})
  const next = { ...settings }
  if (Object.keys(env).length > 0) {
    next.env = env
  } else if ('env' in next) {
    // 全空時保留一個空物件比整個刪掉安全：使用者可能自己在裡面加過別的鍵，
    // 而 stripManaged 已經把那些留下來了；真的一個都不剩才留空物件。
    next.env = {}
  }
  writeSettings(next)
  return { path: settingsPath(), backup, env }
}

/**
 * 現在設定檔裡我們管的那組 env 長什麼樣（給 UI 判斷「目前是哪一家」）。
 * @returns {{ exists: boolean, path: string, env: Record<string, string>, baseUrl: string }}
 */
function readManagedEnv() {
  const exists = fs.existsSync(settingsPath())
  const settings = exists ? readSettings() : {}
  const env = sanitizeEnv(settings.env)
  return { exists, path: settingsPath(), env, baseUrl: baseUrlOf(env) }
}

module.exports = {
  MANAGED_ENV_KEYS,
  MAX_BACKUPS,
  configure,
  homeDir,
  claudeDir,
  settingsPath,
  claudeJsonPath,
  backupDir,
  sanitizeEnv,
  stripManaged,
  mergeEnv,
  baseUrlOf,
  readJsonFile,
  writeJsonFile,
  backupFile,
  readSettings,
  writeSettings,
  backupSettings,
  applyEnv,
  readManagedEnv
}
