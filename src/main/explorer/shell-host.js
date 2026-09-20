'use strict'

/**
 * VoiceInk - Windows 殼層 sidecar 的宿主（`VoiceInkShell.exe`）
 *
 * 右鍵選單裡的 7-Zip／WinRAR／Git／「傳送到」／「內容」都是 COM 動態處理常式，
 * 登錄檔裡查不到項目文字——只能真的把 `IContextMenu` 叫起來看它塞了什麼。
 * Google Drive 的綠勾也是同一顆程序用 `SHGetFileInfo` 問來的。細節見
 * `native/explorer-shell/VoiceInkShell.csproj` 的註解。
 *
 * 這裡只管：找到執行檔、拉起來、一行一個 JSON 來回、程序不見時下次再開。
 * 沒有它也不影響檔案總管——選單少掉殼層那幾項、綠勾不畫，其餘照常。
 *
 * 協定：送 `{ id, op, ... }`，收 `{ id, ok, data | error }`；啟動第一行是 `READY`。
 */

const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')

/** 掛起來的等待上限：正常 200ms 內回 READY，冷啟動（自帶執行環境解壓）會久一點 */
const READY_TIMEOUT_MS = 8000
/** 單一請求的上限。殼層擴充自己卡住時不能把 UI 一起拖著 */
const CALL_TIMEOUT_MS = 6000
/** 一行 JSON 的上限：選單圖示是 base64，幾十個項目也就幾百 KB */
const MAX_LINE = 8 * 1024 * 1024

/**
 * sidecar 的位置。打包後在 `resources/shell/`（`extraResources`），
 * 開發時在專案的 `resources/shell/`（`npm run build:shell` 的產出）。
 * @param {{ resourcesPath?: string }} [deps]
 * @returns {string}
 */
function resolveExePath(deps = {}) {
  const resourcesPath = deps.resourcesPath || process.resourcesPath || ''
  const candidates = [
    resourcesPath ? path.join(resourcesPath, 'shell', 'VoiceInkShell.exe') : '',
    path.join(__dirname, '..', '..', '..', 'resources', 'shell', 'VoiceInkShell.exe')
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      // 存取不到就試下一個
    }
  }
  return ''
}

/**
 * 把 sidecar 拉起來。
 *
 * @param {{ spawnFn?: Function, exePath?: string, resourcesPath?: string }} [deps]
 * @returns {Promise<{ ok: boolean, error?: string, send?: Function, stop?: Function }>}
 */
async function startShell(deps = {}) {
  const exePath = deps.exePath || resolveExePath(deps)
  if (!exePath) return { ok: false, error: 'SHELL_EXE_MISSING' }
  const spawnFn = deps.spawnFn || spawn

  let proc
  try {
    // stdin 要保持開著：sidecar 靠 EOF 知道我們關掉了
    proc = spawnFn(exePath, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  } catch (error) {
    console.error('[explorer] 啟動殼層 sidecar 失敗:', error?.message || error)
    return { ok: false, error: 'SHELL_START_FAILED' }
  }

  /** @type {Map<number, { resolve: Function, timer: NodeJS.Timeout }>} */
  const pending = new Map()
  let nextId = 1
  let buffer = ''
  let ready = null
  let dead = false

  const settleAll = (error) => {
    dead = true
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.resolve({ ok: false, error })
    }
    pending.clear()
  }

  const readyPromise = new Promise((resolve) => { ready = resolve })

  proc.stdout?.setEncoding('utf8')
  proc.stdout?.on('data', (chunk) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
      if (line === 'READY') ready(true)
      else if (line) dispatch(line)
    }
    // 一行都收不完卻已經超長＝對方吐了非預期的東西，丟掉免得無限長大
    if (buffer.length > MAX_LINE) buffer = ''
  })

  /**
   * @param {string} line
   */
  function dispatch(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    const entry = pending.get(message?.id)
    if (!entry) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    entry.resolve(message.ok ? { ok: true, data: message.data } : { ok: false, error: message.error || 'SHELL_FAILED' })
  }

  proc.on('error', (error) => {
    console.error('[explorer] 殼層 sidecar 錯誤:', error?.message || error)
    ready(false)
    settleAll('SHELL_START_FAILED')
  })
  proc.on('exit', () => {
    ready(false)
    settleAll('SHELL_GONE')
  })

  const timer = setTimeout(() => ready(false), READY_TIMEOUT_MS)
  if (timer.unref) timer.unref()
  const ok = await readyPromise
  clearTimeout(timer)
  if (!ok) {
    try {
      proc.kill()
    } catch {
      // 已經不在了
    }
    return { ok: false, error: 'SHELL_START_FAILED' }
  }

  /**
   * @param {object} request
   * @returns {Promise<{ ok: boolean, data?: object, error?: string }>}
   */
  const send = (request) => new Promise((resolve) => {
    if (dead) {
      resolve({ ok: false, error: 'SHELL_GONE' })
      return
    }
    const id = nextId++
    const entry = {
      resolve,
      timer: setTimeout(() => {
        pending.delete(id)
        resolve({ ok: false, error: 'SHELL_TIMEOUT' })
      }, CALL_TIMEOUT_MS)
    }
    if (entry.timer.unref) entry.timer.unref()
    pending.set(id, entry)
    try {
      proc.stdin.write(`${JSON.stringify({ ...request, id })}\n`)
    } catch {
      pending.delete(id)
      clearTimeout(entry.timer)
      resolve({ ok: false, error: 'SHELL_GONE' })
    }
  })

  const stop = () => {
    settleAll('SHELL_GONE')
    try {
      proc.stdin.end()
      proc.kill()
    } catch (error) {
      console.error('[explorer] 收掉殼層 sidecar 失敗:', error?.message || error)
    }
  }

  return { ok: true, send, stop, alive: () => !dead }
}

module.exports = {
  resolveExePath,
  startShell,
  READY_TIMEOUT_MS,
  CALL_TIMEOUT_MS
}
