'use strict'

const { randomBytes } = require('crypto')
const catalog = require('./catalog')
const credential = require('./credential')
const logs = require('./logs')
const server = require('./server')

/**
 * AGY 反代的服務門面。
 * 設定走主 electron-store（由 main.js 注入存取器），日誌走自己的 SQLite。
 * renderer 只透過這裡拿去敏後的狀態，永遠碰不到憑證、project id 或上游 URL。
 */

const DEFAULTS = Object.freeze({
  agyEnabled: false,
  agyPort: 8788,
  agyApiKey: '',
  agyLogBodies: false,
  agyLogRetentionDays: 30
})

let store = null
let ready = false

function generateApiKey() {
  return `agy-${randomBytes(24).toString('base64url')}`
}

function sanitizePort(raw) {
  const port = Number(raw)
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULTS.agyPort
}

function sanitizeRetentionDays(raw) {
  const days = Number(raw)
  return Number.isInteger(days) && days >= 1 && days <= 365 ? days : DEFAULTS.agyLogRetentionDays
}

function readSettings() {
  if (!store) return { ...DEFAULTS }
  return {
    agyEnabled: store.get('agyEnabled', DEFAULTS.agyEnabled) === true,
    agyPort: sanitizePort(store.get('agyPort', DEFAULTS.agyPort)),
    agyApiKey: typeof store.get('agyApiKey', '') === 'string' ? store.get('agyApiKey', '') : '',
    agyLogBodies: store.get('agyLogBodies', DEFAULTS.agyLogBodies) === true,
    agyLogRetentionDays: sanitizeRetentionDays(store.get('agyLogRetentionDays', DEFAULTS.agyLogRetentionDays))
  }
}

/** 首次使用自動配一把 key，使用者不必手動產生就能直接接客戶端 */
function ensureApiKey() {
  const current = readSettings().agyApiKey
  if (current) return current
  const key = generateApiKey()
  store?.set('agyApiKey', key)
  return key
}

/** @param {{ userDataPath: string, store: { get: Function, set: Function } }} options */
function configure(options) {
  store = options.store
  ready = logs.init({ userDataPath: options.userDataPath })
  if (ready) {
    const days = readSettings().agyLogRetentionDays
    setImmediate(() => {
      try { logs.cleanup(days) } catch { /* 清理失敗不能擋啟動 */ }
    })
  }
  return ready
}

async function start() {
  const settings = readSettings()
  const result = await server.start({
    port: settings.agyPort,
    apiKey: settings.agyApiKey || ensureApiKey(),
    logBodies: settings.agyLogBodies
  })
  if (result.ok) store?.set('agyEnabled', true)
  return result
}

async function stop() {
  await server.stop()
  store?.set('agyEnabled', false)
  return { ok: true }
}

/** 埠或除錯開關改了要重啟才會生效 */
async function restart() {
  const running = server.status().running
  if (running) await server.stop()
  if (!running) return { ok: true, port: readSettings().agyPort }
  return start()
}

/** App 啟動時呼叫：上次關閉時是開著的就自動接續 */
async function autoStart() {
  if (!readSettings().agyEnabled) return { ok: false, error: 'DISABLED' }
  return start()
}

async function status() {
  const settings = readSettings()
  const serverStatus = server.status()
  // 服務沒開就不做 acquire：那會讀 Windows Credential Manager（要開 PowerShell）
  // 甚至走一次 OAuth refresh，5 秒一輪的輪詢不該付這個代價。
  // 但 detectSources 只是檢查執行檔存不存在，很便宜，而且模型查詢失敗時
  // renderer 要靠它決定該給哪一種指引，所以停止中也一併給。
  const credentialStatus = serverStatus.running
    ? await credential.status()
    : { connected: false, tier: '', code: 'NOT_RUNNING', message: '', sources: credential.detectSources() }

  return {
    ...serverStatus,
    // 兩個都要給：OpenAI 相容客戶端要 `/v1`（自己接 `/chat/completions`），
    // Claude Code 要根位址（自己接 `/v1/messages`，帶 `/v1` 會變成 `/v1/v1/messages` → 404）
    baseUrl: `http://${serverStatus.host}:${settings.agyPort}/v1`,
    anthropicBaseUrl: `http://${serverStatus.host}:${settings.agyPort}`,
    apiKey: settings.agyApiKey,
    port: settings.agyPort,
    logBodies: settings.agyLogBodies,
    retentionDays: settings.agyLogRetentionDays,
    credential: credentialStatus,
    db: logs.health()
  }
}

async function saveSettings(raw) {
  const next = raw && typeof raw === 'object' ? raw : {}
  const port = sanitizePort(next.port)
  const logBodies = next.logBodies === true
  const retentionDays = sanitizeRetentionDays(next.retentionDays)

  const previous = readSettings()
  store?.set('agyPort', port)
  store?.set('agyLogBodies', logBodies)
  store?.set('agyLogRetentionDays', retentionDays)
  if (retentionDays !== previous.agyLogRetentionDays) logs.cleanup(retentionDays)

  const needsRestart = server.status().running &&
    (port !== previous.agyPort || logBodies !== previous.agyLogBodies)
  if (needsRestart) {
    await server.stop()
    await start()
  }
  return status()
}

/** 換 key 會讓既有客戶端全部失效，所以一定要重啟服務套用 */
async function regenerateApiKey() {
  const key = generateApiKey()
  store?.set('agyApiKey', key)
  if (server.status().running) {
    await server.stop()
    await start()
  }
  return status()
}

function getLogs(query) {
  return logs.list(query)
}

function getStats(query) {
  return logs.stats(query)
}

function clearLogs() {
  return { ok: logs.clear() }
}

/**
 * App 退出用：關掉 server 但**不動 agyEnabled**。
 * 用 stop() 會把開關寫成 false，下次啟動就不會自動接續了。
 */
async function shutdown() {
  await server.stop()
  logs.close()
  credential.reset()
}

function dispose() {
  logs.close()
  credential.reset()
}

/**
 * 上游模型型錄。走 server 的上游設定，e2e 注入 mock 時型錄才不會打到真實上游。
 * @param {{ force?: boolean }} [params]
 */
function listModels({ force = false } = {}) {
  return catalog.list({ force, options: server.getUpstreamOptions() })
}

const TEST_TIMEOUT_MS = 60_000
const TEST_PROMPT = '請只回覆「OK」兩個字。'

/**
 * 挑一個拿來試打的模型。
 * 額度已經歸零的直接跳過（打下去必定失敗，測不出「連線有沒有通」）。
 * @param {Array<object>} models
 * @returns {string}
 */
function pickTestModel(models) {
  const chat = models.filter((model) => model.chatCapable && !model.deprecated)
  const withQuota = chat.find((model) => model.remainingFraction !== 0)
  return (withQuota || chat[0])?.id || ''
}

/**
 * 端到端自我測試：自動挑一個模型，從**本機閘道**真的送一則訊息出去。
 *
 * 刻意走 loopback HTTP 而不是直接呼叫 upstream：客戶端走的是
 * 「HTTP → 金鑰鑑權 → 模型映射 → 憑證 → 上游」整條路，只測上游等於漏掉前半段，
 * 而使用者接不上時壞在前半段的機率一點都不低。這裡通了＝ Claude Code／OpenAI 客戶端也會通。
 *
 * 失敗只回代碼與我們自己寫的訊息；上游 body 早在 server.js 就收斂成狀態碼了。
 * @param {{ fetchImpl?: Function }} [options]
 */
async function selfTest(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const serverStatus = server.status()
  if (!serverStatus.running) {
    return { ok: false, code: 'NOT_RUNNING', message: '服務尚未啟動，請先按「啟動服務」。' }
  }

  const { models } = await catalog.list({ options: server.getUpstreamOptions() })
  const model = pickTestModel(models)
  if (!model) {
    return { ok: false, code: 'NO_MODEL', message: '上游沒有回報任何可對話的模型。' }
  }

  const startedMs = Date.now()
  let response
  try {
    response = await fetchImpl(`http://${serverStatus.host}:${serverStatus.port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${readSettings().agyApiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: TEST_PROMPT }],
        max_tokens: 64,
        stream: false
      }),
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS)
    })
  } catch {
    return {
      ok: false,
      code: 'UNREACHABLE',
      model,
      durationMs: Date.now() - startedMs,
      message: '連不上本機閘道，請確認監聽埠沒有被其他程式占用。'
    }
  }

  const durationMs = Date.now() - startedMs
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    // error.code 是 server.js 自己塞的（UPSTREAM_502、TOKEN_EXPIRED…），不是上游原文
    const code = typeof payload?.error?.code === 'string' ? payload.error.code : `HTTP_${response.status}`
    return { ok: false, code, model, status: response.status, durationMs, message: '閘道回報請求失敗。' }
  }

  const reply = String(payload?.choices?.[0]?.message?.content || '').trim().slice(0, 120)
  return { ok: true, model, status: 200, durationMs, reply }
}

module.exports = {
  DEFAULTS,
  listModels,
  autoStart,
  clearLogs,
  configure,
  dispose,
  generateApiKey,
  getLogs,
  getStats,
  regenerateApiKey,
  restart,
  sanitizePort,
  sanitizeRetentionDays,
  saveSettings,
  selfTest,
  shutdown,
  start,
  status,
  stop
}
