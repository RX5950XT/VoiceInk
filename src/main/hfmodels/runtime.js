'use strict'

/**
 * llama.cpp **router 模式**的生命週期。
 *
 * 整個「HF模型」分頁押在這上面：不給 `-m`、只給 `--models-dir`，llama-server 自己會
 * 發現模型、依請求路由、載入／卸載（實測見 `probe-hf-router.js`）。所以這裡**不寫**
 * 多模型程序管理器——那是 router 已經在做的事，我們只負責起它、關它、跟它講話。
 *
 * 實測到的三件事，缺一個就會出問題：
 *   - `--api-key` 在 router 上有效（不帶 401）：sidecar 綁 127.0.0.1 還是要擋同機其他程序
 *   - kill router 之後子 `llama-server` 會一起走，**不必自己追子 pid**
 *   - `GET /models?reload=1` 會重掃資料夾，所以「使用者手動把 gguf 拖進去」零程式碼
 */

const { spawn } = require('child_process')
const { randomBytes } = require('crypto')
const net = require('net')
const path = require('path')

const HOST = '127.0.0.1'
const READY_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 250
const REQUEST_TIMEOUT_MS = 15_000
/** 失敗時留幾行 stderr 給診斷用（**不外流給 renderer**） */
const STDERR_KEEP_LINES = 20

/** @type {{ child: import('child_process').ChildProcess, port: number, apiKey: string } | null} */
let server = null
/** @type {Promise<void> | null} */
let startPromise = null
/** @type {string[]} */
let stderrTail = []
/** stop 遞增：in-flight 的 start 完成後對不上就自己收掉 */
let startGen = 0

/**
 * @returns {Promise<number>}
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, HOST, () => {
      const { port } = /** @type {import('net').AddressInfo} */ (srv.address())
      srv.close(() => resolve(port))
    })
  })
}

/**
 * @param {number} port
 * @returns {Promise<boolean>}
 */
async function healthOk(port) {
  try {
    const res = await fetch(`http://${HOST}:${port}/health`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

/**
 * @returns {{ running: boolean, port: number }}
 */
function status() {
  return { running: !!server, port: server ? server.port : 0 }
}

/**
 * 給 main 內部用（聊天要打這個位址）。**不可以送給 renderer**：金鑰一旦進了畫面，
 * 同機任何跑得起來的東西都能拿它去用這台 router。
 * @returns {{ baseUrl: string, apiKey: string } | null}
 */
function endpoint() {
  if (!server) return null
  return { baseUrl: `http://${HOST}:${server.port}`, apiKey: server.apiKey }
}

/**
 * @param {string} pathname
 * @param {{ method?: string, body?: any, timeoutMs?: number }} [options]
 * @returns {Promise<any>}
 */
async function call(pathname, options = {}) {
  if (!server) throw new Error('本機模型服務尚未啟動')
  const response = await fetch(`http://${HOST}:${server.port}${pathname}`, {
    method: options.method || 'GET',
    headers: {
      authorization: `Bearer ${server.apiKey}`,
      ...(options.body ? { 'content-type': 'application/json' } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(options.timeoutMs || REQUEST_TIMEOUT_MS)
  })
  if (!response.ok) {
    // 只記狀態碼：body 由 llama-server 決定內容，不進 UI
    throw new Error(`本機模型服務回應 HTTP ${response.status}`)
  }
  const text = await response.text()
  try {
    return text ? JSON.parse(text) : null
  } catch {
    throw new Error('本機模型服務回應格式錯誤')
  }
}

/**
 * 啟動 router
 *
 * @param {{ exe: string, modelsDir: string, presetPath?: string }} options
 * @returns {Promise<{ running: boolean, port: number }>}
 */
async function start(options) {
  if (server) return status()
  if (startPromise) {
    try { await startPromise } catch { /* 由下面的 status 判定 */ }
    return status()
  }

  const myGen = startGen
  startPromise = (async () => {
    const port = await freePort()
    // 綁 127.0.0.1 仍然強制金鑰：同機的其他程序也不該能用這台 router
    const apiKey = randomBytes(24).toString('hex')
    const args = [
      '--host', HOST,
      '--port', String(port),
      '--api-key', apiKey,
      '--models-dir', options.modelsDir,
      '--no-webui',
      // 儀表板的速度／排隊都來自這裡；預設是關的，router 會把這面旗子傳給它開的子程序
      '--metrics'
    ]
    if (options.presetPath) args.push('--models-preset', options.presetPath)

    stderrTail = []
    const child = spawn(options.exe, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      cwd: path.dirname(options.exe)
    })
    child.stderr.on('data', (chunk) => {
      stderrTail.push(...String(chunk).split('\n'))
      if (stderrTail.length > STDERR_KEEP_LINES) stderrTail = stderrTail.slice(-STDERR_KEEP_LINES)
    })

    let exited = false
    child.on('exit', () => { exited = true; if (server?.child === child) server = null })
    child.on('error', () => { exited = true })

    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (exited) throw new Error('本機模型服務啟動失敗')
      if (await healthOk(port)) {
        // 等待期間有人按了停止：這一份不要留下來
        if (myGen !== startGen) {
          try { child.kill() } catch { /* 已經走了 */ }
          throw new Error('本機模型服務已取消啟動')
        }
        server = { child, port, apiKey }
        return
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    }
    try { child.kill() } catch { /* 已經走了 */ }
    throw new Error('本機模型服務啟動逾時')
  })()

  try {
    await startPromise
  } finally {
    startPromise = null
  }
  return status()
}

/**
 * 關掉 router。子 `llama-server`（真正跑模型那幾個）會跟著走，實測不必自己追。
 */
function stop() {
  startGen += 1
  const current = server
  server = null
  if (!current) return
  try { current.child.kill() } catch { /* 已經走了 */ }
}

/**
 * `reload=1` 讓 router 重掃資料夾——使用者手動把 gguf 拖進去也認得出來
 * @param {{ reload?: boolean }} [options]
 * @returns {Promise<Array<object>>}
 */
async function listModels(options = {}) {
  const json = await call(options.reload ? '/models?reload=1' : '/models')
  return Array.isArray(json?.data) ? json.data : []
}

/**
 * @param {string} id
 * @returns {Promise<boolean>}
 */
async function loadModel(id) {
  // 載入一顆大模型比一般請求久得多
  const json = await call('/models/load', { method: 'POST', body: { model: id }, timeoutMs: 180_000 })
  return json?.success !== false
}

/**
 * @param {string} id
 * @returns {Promise<boolean>}
 */
async function unloadModel(id) {
  const json = await call('/models/unload', { method: 'POST', body: { model: id }, timeoutMs: 60_000 })
  return json?.success !== false
}

/**
 * 失敗診斷用；**只給 main 的 log，不進 IPC**
 * @returns {string[]}
 */
function diagnostics() {
  return stderrTail.slice()
}

/**
 * llama-server 的 Prometheus `/metrics` 文本。純函式，給儀表板用。
 * @param {string} text
 * @returns {{
 *   promptTokens: number, predictedTokens: number,
 *   promptSeconds: number, predictedSeconds: number,
 *   requestsProcessing: number, requestsDeferred: number,
 *   kvUsage: number | null, promptTps: number, predictedTps: number
 * }}
 */
function parseMetrics(text) {
  /** @type {Record<string, number>} */
  const raw = {}
  for (const line of String(text || '').split('\n')) {
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^(?:llamacpp:)?([a-z0-9_]+)\s+([0-9.eE+-]+)\s*$/)
    if (match) raw[match[1]] = Number(match[2])
  }
  const promptTokens = raw.prompt_tokens_total || 0
  const predictedTokens = raw.tokens_predicted_total || raw.predicted_tokens_total || 0
  const promptSeconds = raw.prompt_seconds_total || 0
  // 實測名字是 `llamacpp:tokens_predicted_seconds_total`（舊名留著當退路）
  const predictedSeconds = raw.tokens_predicted_seconds_total || raw.predicted_seconds_total || 0
  return {
    promptTokens,
    predictedTokens,
    promptSeconds,
    predictedSeconds,
    requestsProcessing: raw.requests_processing || 0,
    requestsDeferred: raw.requests_deferred || 0,
    kvUsage: Number.isFinite(raw.kv_cache_usage_ratio) ? raw.kv_cache_usage_ratio : null,
    promptTps: promptSeconds > 0 ? promptTokens / promptSeconds : 0,
    predictedTps: predictedSeconds > 0 ? predictedTokens / predictedSeconds : 0
  }
}

/**
 * router 模式的 `/metrics` 是**照模型分的**：不帶 model 直接 400。
 * ponytail: 只問一顆（載著的第一顆），要分模型比較再改成逐顆問。
 * @param {string} modelId
 * @returns {Promise<ReturnType<typeof parseMetrics> | null>}
 */
async function metrics(modelId) {
  if (!server || !modelId) return null
  try {
    const url = `http://${HOST}:${server.port}/metrics?model=${encodeURIComponent(modelId)}`
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${server.apiKey}` },
      signal: AbortSignal.timeout(3000)
    })
    if (!response.ok) return null
    return parseMetrics(await response.text())
  } catch {
    return null
  }
}

module.exports = {
  start, stop, status, endpoint, listModels, loadModel, unloadModel,
  diagnostics, call, metrics, parseMetrics, HOST
}
