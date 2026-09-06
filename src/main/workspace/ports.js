'use strict'

/**
 * 本機正在監聽的 TCP 埠（Main Process）。
 *
 * 這一塊是給「dev server 起來了，一鍵用內建瀏覽器開」用的，所以只列**本機位址**
 * （127.0.0.1／::1／0.0.0.0／::）的監聽埠——列別台機器的沒有意義。
 *
 * 兩件實測：
 * 1. `netstat -ano` 的**狀態字串沒有被在地化**（zh-TW 的 Windows 上照樣印 `LISTENING`），
 *    只有欄位標題會翻譯，所以可以直接比對這個字。
 *    刻意不用 `Get-NetTCPConnection`：那要自動載入 NetTCPIP 模組，
 *    `PSModulePath` 被污染時會整組載不起來（`Get-NetAdapter` 已經踩過一次）。
 * 2. 程序名要另外跑一次 `tasklist`；`netstat` 只給得出 PID。
 *
 * 兩支都是 `spawn(..., { shell: false })` 且**不帶任何使用者輸入**。
 */

const { execFile } = require('child_process')

/** 單次指令逾時 */
const TIMEOUT_MS = 8000
/** 最多列幾個埠 */
const MAX_PORTS = 200
/** 這些埠是 Windows 自己的服務，列出來只是雜訊 */
const NOISE_PORTS = new Set([135, 139, 445, 5040, 7680])

/**
 * @param {string} exe
 * @param {string[]} args
 * @returns {Promise<string>} stdout；失敗回空字串（這個面板壞掉不該讓整頁失敗）
 */
function run(exe, args) {
  return new Promise((resolve) => {
    execFile(exe, args, {
      timeout: TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    }, (error, stdout) => {
      resolve(error && !stdout ? '' : String(stdout || ''))
    })
  })
}

/**
 * 這個位址算不算「這台機器上打得開的」。
 * @param {string} addr `netstat` 的本機位址欄（`0.0.0.0:5173` / `[::1]:3000`）
 * @returns {{ port: number, local: boolean } | null}
 */
function parseAddress(addr) {
  const at = addr.lastIndexOf(':')
  if (at < 0) return null
  const port = Number(addr.slice(at + 1))
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  const host = addr.slice(0, at).replace(/^\[|\]$/g, '')
  const local = host === '0.0.0.0' || host === '::' || host === '127.0.0.1' || host === '::1'
  return { port, local }
}

/**
 * 解析 `netstat -ano -p TCP`。欄位是空白分隔的四／五格：
 * `TCP  <本機>  <外部>  LISTENING  <PID>`
 *
 * @param {string} raw
 * @returns {Map<number, number>} port → pid
 */
function parseNetstat(raw) {
  /** @type {Map<number, number>} */
  const found = new Map()
  for (const line of String(raw || '').split('\n')) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 5) continue
    if (cols[0] !== 'TCP') continue
    if (cols[3] !== 'LISTENING') continue
    const addr = parseAddress(cols[1])
    if (!addr || !addr.local) continue
    const pid = Number(cols[4])
    if (!Number.isInteger(pid) || pid < 0) continue
    // 同一個埠 IPv4 與 IPv6 各一列，留先看到的那個就好
    if (!found.has(addr.port)) found.set(addr.port, pid)
  }
  return found
}

/**
 * 解析 `tasklist /FO CSV /NH`：`"名稱","PID","工作階段","階段編號","記憶體"`。
 * @param {string} raw
 * @returns {Map<number, string>} pid → 程序名
 */
function parseTasklist(raw) {
  /** @type {Map<number, string>} */
  const names = new Map()
  for (const line of String(raw || '').split('\n')) {
    const cols = line.trim().match(/"([^"]*)"/g)
    if (!cols || cols.length < 2) continue
    const name = cols[0].slice(1, -1)
    const pid = Number(cols[1].slice(1, -1))
    if (!Number.isInteger(pid)) continue
    names.set(pid, name)
  }
  return names
}

/**
 * 目前在聽的本機埠，依埠號小到大。
 * @returns {Promise<Array<{ port: number, pid: number, process: string }>>}
 */
async function list() {
  const [netstat, tasks] = await Promise.all([
    run('netstat', ['-ano', '-p', 'TCP']),
    run('tasklist', ['/FO', 'CSV', '/NH'])
  ])
  const ports = parseNetstat(netstat)
  const names = parseTasklist(tasks)
  return [...ports.entries()]
    .filter(([port]) => !NOISE_PORTS.has(port))
    .sort((a, b) => a[0] - b[0])
    .slice(0, MAX_PORTS)
    .map(([port, pid]) => ({ port, pid, process: names.get(pid) || '' }))
}

module.exports = {
  NOISE_PORTS,
  MAX_PORTS,
  parseAddress,
  parseNetstat,
  parseTasklist,
  list
}
