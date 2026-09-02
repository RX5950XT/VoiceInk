'use strict'

/**
 * Claude Code 的 MCP 伺服器管理（Main Process）。
 *
 * 真相在 `~/.claude.json` 根物件的 `mcpServers`（**不是** `settings.json`）。那份檔案同時裝著
 * 全部專案的歷史記錄，動輒好幾 MB，所以一律「讀進來 → 只改 mcpServers → 原子寫回」，
 * 其餘欄位一個都不碰，寫之前照樣備份。
 *
 * 「停用」在 Claude Code 沒有對應欄位（使用者層級只有「在不在 mcpServers 裡」），
 * 所以停用的伺服器搬到我們自己的 `<userData>/cc-providers.json`，要用再放回去——
 * 直接刪掉的話使用者一關就再也找不回設定。
 *
 * Windows 上 `npx`／`npm`／`node` 這類指令實際是 `.cmd` 批次檔，ConPTY 之外的
 * spawn 起不來，要包成 `cmd /c`（Claude Code 的 `/doctor` 也會抱怨這件事）。
 */

const claudeSettings = require('./claude-settings')

/** `~/.claude.json` 大得多（含全部專案歷史），上限另外給 */
const MAX_CLAUDE_JSON_BYTES = 64 * 1024 * 1024
/** MCP 伺服器數量上限 */
const MAX_SERVERS = 100
const MAX_ID = 80
const MAX_FIELD = 2048
const MAX_ARGS = 40

/** Windows 上要包 `cmd /c` 的指令 */
const WINDOWS_WRAP_COMMANDS = new Set(['npx', 'npm', 'yarn', 'pnpm', 'node', 'bun', 'deno'])

/** 常用範本（stdio 為主，複製過去再自己改） */
const TEMPLATES = Object.freeze([
  { id: 'context7', label: 'Context7（套件文件查詢）', spec: { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'] } },
  { id: 'sequential-thinking', label: 'Sequential Thinking（逐步推理）', spec: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] } },
  { id: 'memory', label: 'Memory（知識圖譜記憶）', spec: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] } },
  { id: 'fetch', label: 'Fetch（抓網頁）', spec: { type: 'stdio', command: 'uvx', args: ['mcp-server-fetch'] } },
  { id: 'http-example', label: 'HTTP 遠端伺服器（範例）', spec: { type: 'http', url: 'https://example.com/mcp' } }
])

/** @type {(() => Promise<import('electron-store')>) | null} */
let getStore = null

/**
 * 停用清單存哪由呼叫端注入（跟供應商共用同一個 electron-store 實例）。
 * @param {() => Promise<import('electron-store')>} fn
 */
function configure(fn) {
  getStore = fn
}

// ===== 純函式 =====

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

/**
 * 驗證並收斂一份 MCP 伺服器定義。
 *
 * 寬鬆但不放行不合法的形狀：`type` 省略視同 stdio（Claude Code 的預設），
 * stdio 一定要有 `command`，http／sse 一定要有 `url`。
 *
 * @param {unknown} raw
 * @returns {Record<string, unknown>}
 */
function sanitizeSpec(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    const error = new Error('MCP_INVALID')
    error.code = 'MCP_INVALID'
    error.userMessage = 'MCP 伺服器定義必須是物件'
    throw error
  }
  const type = text(raw.type, 20) || 'stdio'
  if (!['stdio', 'http', 'sse'].includes(type)) {
    const error = new Error('MCP_INVALID_TYPE')
    error.code = 'MCP_INVALID_TYPE'
    error.userMessage = 'type 只能是 stdio、http 或 sse'
    throw error
  }

  /** @type {Record<string, unknown>} */
  const out = { type }

  if (type === 'stdio') {
    const command = text(raw.command, MAX_FIELD)
    if (!command) {
      const error = new Error('MCP_MISSING_COMMAND')
      error.code = 'MCP_MISSING_COMMAND'
      error.userMessage = 'stdio 伺服器要填 command'
      throw error
    }
    out.command = command
    // 數字／布林轉成字串而不是丟掉：`args: ["--port", 8080]` 是常見寫法，
    // 靜默少一個參數會變成一條意思完全不同的指令，而且很難查
    const args = Array.isArray(raw.args)
      ? raw.args.slice(0, MAX_ARGS)
        .filter((arg) => arg !== null && arg !== undefined && typeof arg !== 'object')
        .map((arg) => String(arg).slice(0, MAX_FIELD))
        .filter(Boolean)
      : []
    if (args.length) out.args = args
  } else {
    const url = text(raw.url, MAX_FIELD)
    if (!url) {
      const error = new Error('MCP_MISSING_URL')
      error.code = 'MCP_MISSING_URL'
      error.userMessage = `${type} 伺服器要填 url`
      throw error
    }
    out.url = url
    const headers = sanitizeStringMap(raw.headers)
    if (Object.keys(headers).length) out.headers = headers
  }

  const env = sanitizeStringMap(raw.env)
  if (Object.keys(env).length) out.env = env
  return out
}

/**
 * @param {unknown} raw
 * @returns {Record<string, string>}
 */
function sanitizeStringMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  /** @type {Record<string, string>} */
  const out = {}
  for (const [key, value] of Object.entries(raw)) {
    const name = text(key, 120)
    if (!name || typeof value === 'object') continue
    out[name] = String(value).slice(0, MAX_FIELD)
  }
  return out
}

/**
 * Windows 上把 `npx foo` 換成 `cmd /c npx foo`。已經是 cmd 的不重複包。
 * @param {Record<string, unknown>} spec
 * @param {boolean} isWindows
 * @returns {Record<string, unknown>}
 */
function wrapForWindows(spec, isWindows = process.platform === 'win32') {
  if (!isWindows || spec.type !== 'stdio') return spec
  const command = text(spec.command, MAX_FIELD)
  if (!command) return spec
  const lower = command.toLowerCase()
  if (lower === 'cmd' || lower === 'cmd.exe') return spec
  // 去掉路徑與副檔名再比對（npx.cmd、C:\...\npx 都要認得）
  const stem = lower.split(/[\\/]/).pop().replace(/\.[^.]*$/, '')
  if (!WINDOWS_WRAP_COMMANDS.has(stem)) return spec
  return {
    ...spec,
    command: 'cmd',
    args: ['/c', command, ...(Array.isArray(spec.args) ? spec.args : [])]
  }
}

/**
 * @param {unknown} id
 * @returns {string}
 */
function sanitizeId(id) {
  const name = text(id, MAX_ID)
  if (!name) {
    const error = new Error('MCP_INVALID_ID')
    error.code = 'MCP_INVALID_ID'
    error.userMessage = 'MCP 伺服器名稱不能空白'
    throw error
  }
  // __proto__ 這類鍵會污染物件原型；直接擋掉比事後補救省事
  if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
    const error = new Error('MCP_INVALID_ID')
    error.code = 'MCP_INVALID_ID'
    error.userMessage = '這個名稱不能用'
    throw error
  }
  return name
}

/**
 * 讀出來的 mcpServers 可能被手改。壞掉的那筆略過，不讓整份清單掛掉。
 * @param {unknown} raw
 * @returns {Record<string, Record<string, unknown>>}
 */
function sanitizeMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  /** @type {Record<string, Record<string, unknown>>} */
  const out = {}
  let count = 0
  for (const [key, value] of Object.entries(raw)) {
    if (count >= MAX_SERVERS) break
    try {
      out[sanitizeId(key)] = sanitizeSpec(value)
      count++
    } catch {
      // 壞掉的那筆略過
    }
  }
  return out
}

// ===== 檔案 I/O =====

/** @returns {Record<string, unknown>} */
function readClaudeJson() {
  return claudeSettings.readJsonFile(claudeSettings.claudeJsonPath(), MAX_CLAUDE_JSON_BYTES)
}

/**
 * 只換掉 mcpServers，其他欄位（專案歷史、各種旗標）原樣寫回。
 * @param {Record<string, Record<string, unknown>>} servers
 */
function writeLive(servers) {
  const file = claudeSettings.claudeJsonPath()
  const root = readClaudeJson()
  claudeSettings.backupFile(file, 'claude-json')
  claudeSettings.writeJsonFile(file, { ...root, mcpServers: servers })
}

/** @returns {Record<string, Record<string, unknown>>} */
function readLive() {
  return sanitizeMap(readClaudeJson().mcpServers)
}

/** @returns {Promise<Record<string, Record<string, unknown>>>} */
async function readDisabled() {
  if (!getStore) return {}
  const store = await getStore()
  return sanitizeMap(store.get('disabledMcp', {}))
}

/**
 * @param {Record<string, Record<string, unknown>>} map
 */
async function writeDisabled(map) {
  if (!getStore) return
  const store = await getStore()
  store.set('disabledMcp', map)
}

// ===== 對外 =====

/**
 * 啟用中（來自 `~/.claude.json`）＋ 停用中（來自我們的 store），依名稱排序。
 * @returns {Promise<{ path: string, servers: Array<{ id: string, enabled: boolean, spec: object }> }>}
 */
async function list() {
  const live = readLive()
  const disabled = await readDisabled()
  const servers = [
    ...Object.entries(live).map(([id, spec]) => ({ id, enabled: true, spec })),
    ...Object.entries(disabled)
      .filter(([id]) => !(id in live))
      .map(([id, spec]) => ({ id, enabled: false, spec }))
  ].sort((a, b) => a.id.localeCompare(b.id))
  return { path: claudeSettings.claudeJsonPath(), servers }
}

/**
 * 新增或覆蓋一台。已停用的同名項目會一併更新，維持「同一個名字只有一份設定」。
 * @param {string} rawId
 * @param {object} rawSpec
 * @param {boolean} enabled
 */
async function upsert(rawId, rawSpec, enabled = true) {
  const id = sanitizeId(rawId)
  const spec = sanitizeSpec(rawSpec)
  const live = readLive()
  const disabled = await readDisabled()

  if (enabled) {
    if (!(id in live) && Object.keys(live).length >= MAX_SERVERS) {
      const error = new Error('MCP_LIMIT')
      error.code = 'MCP_LIMIT'
      error.userMessage = `MCP 伺服器最多 ${MAX_SERVERS} 台`
      throw error
    }
    delete disabled[id]
    await writeDisabled(disabled)
    writeLive({ ...live, [id]: wrapForWindows(spec) })
  } else {
    if (id in live) {
      const next = { ...live }
      delete next[id]
      writeLive(next)
    }
    await writeDisabled({ ...disabled, [id]: spec })
  }
  return { id, enabled }
}

/**
 * 開關一台。開＝從 store 搬回 `~/.claude.json`；關＝反過來。
 * @param {string} rawId
 * @param {boolean} enabled
 */
async function toggle(rawId, enabled) {
  const id = sanitizeId(rawId)
  const live = readLive()
  const disabled = await readDisabled()
  const spec = live[id] || disabled[id]
  if (!spec) {
    const error = new Error('NOT_FOUND')
    error.code = 'NOT_FOUND'
    error.userMessage = '找不到這台 MCP 伺服器'
    throw error
  }
  return upsert(id, spec, Boolean(enabled))
}

/**
 * @param {string} rawId
 */
async function remove(rawId) {
  const id = sanitizeId(rawId)
  const live = readLive()
  if (id in live) {
    const next = { ...live }
    delete next[id]
    writeLive(next)
  }
  const disabled = await readDisabled()
  if (id in disabled) {
    delete disabled[id]
    await writeDisabled(disabled)
  }
  return true
}

module.exports = {
  TEMPLATES,
  MAX_SERVERS,
  configure,
  sanitizeSpec,
  sanitizeMap,
  sanitizeId,
  wrapForWindows,
  list,
  upsert,
  toggle,
  remove
}
