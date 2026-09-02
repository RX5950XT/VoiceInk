'use strict'

/**
 * CLI 版本檢查（Main Process）。
 *
 * 本機版本靠跑一次 `<工具> --version`，最新版本查 npm registry。**更新不在這裡做**：
 * 我們只把指令交給既有的終端機分頁去跑，使用者看得到整個安裝過程、出錯也自己看得懂。
 * App 偷偷在背景裝全域套件是另一回事。
 *
 * 更新一律用**該工具自己的 updater**（`claude update`／`codex update`／`grok update`／
 * `opencode upgrade`／`agy update`），不要一律組 `npm i -g`：這幾家多半是各自的安裝器裝的
 * （本機實測 claude 在 `~/.local/bin`、grok 在 `~/.grok/bin`、agy 在 `AppData\Local\agy\bin`，
 * 只有 codex 與 opencode 真的是 npm global），對非 npm 安裝的跑 `npm i -g` 會裝出第二份互相蓋。
 *
 * 工具清單是這裡的固定表，renderer 只送 key——跟終端機的 shell 白名單同一條理由。
 */

const { spawn } = require('child_process')
const shared = require('../usage/shared')

/** 跑 `--version` 的逾時。正常都在 1～3 秒。 */
const VERSION_TIMEOUT_MS = 10000
/** 子程序輸出讀取上限（版本號就一行，這條只是防它狂吐） */
const MAX_OUTPUT_BYTES = 64 * 1024

/**
 * 支援的 CLI。
 * `pkg` 只用來查「最新版是幾號」（空＝這家沒發 npm，版本比對交給它自己的 updater）；
 * `update` 是真正拿去終端機跑的指令。
 * @type {ReadonlyArray<{ key: string, label: string, exe: string, pkg: string, update: string }>}
 */
const TOOLS = Object.freeze([
  { key: 'claude', label: 'Claude Code', exe: 'claude', pkg: '@anthropic-ai/claude-code', update: 'claude update' },
  { key: 'codex', label: 'Codex CLI', exe: 'codex', pkg: '@openai/codex', update: 'codex update' },
  { key: 'grok', label: 'Grok CLI', exe: 'grok', pkg: '@xai-official/grok', update: 'grok update' },
  { key: 'opencode', label: 'OpenCode', exe: 'opencode', pkg: 'opencode-ai', update: 'opencode upgrade' },
  // Antigravity 沒發 npm（安裝器裝到 AppData\Local\agy\bin），只有自己的 update 子指令
  { key: 'agy', label: 'Antigravity CLI', exe: 'agy', pkg: '', update: 'agy update' }
])

const BY_KEY = new Map(TOOLS.map((tool) => [tool.key, tool]))

/**
 * 從一堆輸出裡挑出版本號。CLI 各家格式不同：
 * `1.2.3`、`claude 1.2.3 (Claude Code)`、`codex-cli 0.5.0` 都要認得。
 * @param {string} output
 * @returns {string}
 */
function parseVersion(output) {
  const match = String(output).match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)
  return match ? match[0] : ''
}

/**
 * 版本比較。回傳 1 / 0 / -1（a 比 b 新 / 一樣 / 舊）。
 * 只比數字段落，**帶預發布後綴的一律視為比正式版舊**（`1.2.3-beta.1` < `1.2.3`），
 * 這樣 `next` tag 的使用者不會被一直提示「有新版」。
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareVersions(a, b) {
  const parse = (value) => {
    const [core, pre = ''] = String(value).split('-', 2)
    const parts = core.split('.').map((n) => Number.parseInt(n, 10) || 0)
    return { parts, pre }
  }
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < 3; i++) {
    const diff = (left.parts[i] || 0) - (right.parts[i] || 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  if (left.pre === right.pre) return 0
  if (!left.pre) return 1
  if (!right.pre) return -1
  return left.pre > right.pre ? 1 : -1
}

/**
 * 跑一次 `<exe> --version`。
 *
 * Windows 上這些工具多半是 `.cmd`，直接 spawn 執行檔找不到，所以走 `cmd /c`。
 * exe 名字來自上面的固定表，不是 renderer 給的，所以組進命令列是安全的。
 *
 * `stdin` 一律 `ignore`：留著一條永遠收不到 EOF 的管線會讓 CLI 卡在等輸入
 * （AGY 代跑 `agy.exe` 時實測踩過，CLAUDE.md 有記）。
 *
 * @param {string} exe
 * @returns {Promise<string>} 版本號；找不到或跑不起來回空字串
 */
function runVersion(exe) {
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32'
    const child = isWindows
      ? spawn('cmd', ['/c', `${exe} --version`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(exe, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })

    let output = ''
    let size = 0
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.kill()
      } catch {
        // 已經結束了
      }
      resolve(value)
    }
    const timer = setTimeout(() => finish(''), VERSION_TIMEOUT_MS)

    const collect = (chunk) => {
      if (size >= MAX_OUTPUT_BYTES) return
      size += chunk.length
      output += chunk.toString('utf8')
      // 版本號一出現就可以收工，不必等 CLI 自己結束
      const found = parseVersion(output)
      if (found) finish(found)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', () => finish(''))
    child.on('close', () => finish(parseVersion(output)))
  })
}

/**
 * 查 npm registry 上的最新版。
 *
 * **不要帶 `Accept: application/vnd.npm.install-v1+json`**：那個精簡格式只有 packument
 * 端點支援，`/latest` 收到會回 **406 空 body**，結果是每一家都查不到最新版、UI 一路顯示
 * 「離線？」（實測踩過，只有偶爾命中不同 CDN 節點才會過）。
 *
 * @param {string} pkg
 * @param {{ fetchImpl?: Function }} [options]
 * @returns {Promise<string>}
 */
async function fetchLatest(pkg, options = {}) {
  if (!pkg) return ''
  const data = await shared.fetchJson(
    `https://registry.npmjs.org/${pkg.split('/').map(encodeURIComponent).join('/')}/latest`,
    {
      label: 'npm registry',
      retries: 2,
      timeoutMs: 10000,
      maxBytes: 512 * 1024,
      fetchImpl: options.fetchImpl
    }
  )
  return typeof data.version === 'string' ? data.version : ''
}

/**
 * 一個工具的狀態。查不到最新版**不算失敗**——離線時本機版本照樣要顯示得出來。
 * @param {{ key: string, label: string, exe: string, pkg: string }} tool
 * @param {{ fetchImpl?: Function }} [options]
 */
async function checkTool(tool, options = {}) {
  const [local, latest] = await Promise.all([
    runVersion(tool.exe),
    fetchLatest(tool.pkg, options).catch(() => '')
  ])
  return {
    key: tool.key,
    label: tool.label,
    pkg: tool.pkg,
    installed: Boolean(local),
    local,
    latest,
    outdated: Boolean(local && latest && compareVersions(local, latest) < 0),
    updateCommand: tool.update
  }
}

/**
 * 全部工具一起查。
 * @param {{ fetchImpl?: Function }} [options]
 */
function checkAll(options = {}) {
  return Promise.all(TOOLS.map((tool) => checkTool(tool, options)))
}

/**
 * 更新指令。renderer 只送 key，指令字串由這裡組。
 * @param {unknown} key
 * @returns {string}
 */
function updateCommand(key) {
  const tool = typeof key === 'string' ? BY_KEY.get(key) : null
  if (!tool || !tool.update) {
    const error = new Error('NO_UPDATE_PATH')
    error.code = 'NO_UPDATE_PATH'
    error.userMessage = '這個工具沒有更新指令'
    throw error
  }
  return tool.update
}

module.exports = {
  TOOLS,
  parseVersion,
  compareVersions,
  runVersion,
  fetchLatest,
  checkTool,
  checkAll,
  updateCommand
}
