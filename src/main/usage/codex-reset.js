'use strict'

/**
 * 用掉一次 Codex 的額度重置（rate limit reset credit）。
 *
 * 不直接打 `/wham/rate-limit-reset-credits/consume`：那支的 body 沒有文件，猜錯的代價是
 * 使用者的次數。改走 Codex 官方的 app-server 協定（`codex app-server`，stdio JSONL）：
 * `initialize` → `initialized` → `account/rateLimitResetCredit/consume`，
 * 參數與回應照 `codex app-server generate-json-schema` 產出的 schema（CLI 0.155.1）。
 * 憑證、續期都由 CLI 自己處理，這裡碰不到 token。
 */

const { spawn, execFile } = require('child_process')
const { randomUUID } = require('crypto')
const { UsageError } = require('./shared')

const TIMEOUT_MS = 45_000
const MAX_LINE_BYTES = 1024 * 1024
const OUTCOMES = new Set(['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed'])

/** Windows 上 `codex` 是 npm 的 `.cmd`，直接 spawn 找不到，走 `cmd /c`（指令是寫死的，沒有外部輸入） */
function spawnAppServer() {
  return process.platform === 'win32'
    ? spawn('cmd', ['/c', 'codex app-server'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    : spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] })
}

/** `cmd` 底下還有 node 與 codex.exe，只殺 cmd 會留孤兒 */
function killTree(child) {
  if (child.exitCode !== null) return
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
  } else {
    child.kill()
  }
}

/**
 * @param {string | null} creditId 要用哪一張；null＝交給後端挑下一張
 * @param {{ spawnImpl?: () => import('child_process').ChildProcess, version?: string, timeoutMs?: number }} [deps]
 * @returns {Promise<'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed'>}
 */
function consumeCodexReset(creditId, deps = {}) {
  const child = (deps.spawnImpl || spawnAppServer)()
  const params = { creditId: creditId || null, idempotencyKey: randomUUID() }
  return new Promise((resolve, reject) => {
    let buffer = ''
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.stdin.end() } catch { /* 已經關了 */ }
      // 收到答案之後 app-server 讀到 EOF 會自己結束；給它一秒，沒走就整棵殺掉
      setTimeout(() => killTree(child), 1000).unref?.()
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(
      // 送出之後才逾時的話，後端可能已經扣了：不說「沒送出」，叫使用者看同步後的次數
      () => finish(new UsageError('TIMEOUT', 'Codex 沒有回應；同步後再看次數有沒有少')),
      deps.timeoutMs || TIMEOUT_MS
    )
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)

    const onMessage = (message) => {
      if (message.id === 1) {
        if (message.error) return finish(new UsageError('CODEX_INIT_FAILED', 'Codex 啟動失敗，重置沒有送出'))
        send({ method: 'initialized' })
        send({ id: 2, method: 'account/rateLimitResetCredit/consume', params })
        return
      }
      if (message.id !== 2) return
      if (message.error) return finish(new UsageError('CODEX_RESET_FAILED', 'Codex 拒絕了這次重置'))
      const outcome = message.result?.outcome
      if (!OUTCOMES.has(outcome)) return finish(new UsageError('CODEX_RESET_FAILED', 'Codex 回了看不懂的結果'))
      finish(null, outcome)
    }

    child.stdout.on('data', (chunk) => {
      buffer += chunk
      if (buffer.length > MAX_LINE_BYTES) return finish(new UsageError('CODEX_RESET_FAILED', 'Codex 回應過大'))
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line) continue
        let message
        try { message = JSON.parse(line) } catch { continue }
        if (message && typeof message === 'object') onMessage(message)
      }
    })
    child.on('error', () => finish(new UsageError('CODEX_NOT_FOUND', '找不到 Codex CLI（需要 npm 版 codex）')))
    child.on('exit', () => finish(new UsageError('CODEX_RESET_FAILED', 'Codex 提前結束，重置沒有完成')))

    send({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'voiceink', title: 'VoiceInk', version: deps.version || '0.0.0' } }
    })
  })
}

module.exports = { consumeCodexReset }
