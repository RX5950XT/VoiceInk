'use strict'

/**
 * VoiceInk - 語音輸入熱鍵的原生 sidecar（`VoiceInkHook.exe`）
 *
 * 它是一支 .NET 小程式，裝一個 Windows 低階鍵盤 hook（WH_KEYBOARD_LL）並**把熱鍵吞掉**：
 * 前景程式收不到那顆鍵，所以不會再有「單獨一顆 Alt 把選單列叫出來」的副作用，
 * 也不必補送 F24 去中和（`hotkey.js` 的 uiohook 退路才需要那招）。
 *
 * 這裡只負責把它拉起來、逐行讀事件、程序不見時重開。按鍵語意（按住／短按切換／Esc 取消）
 * 一律交給 `hotkey.createMachine`，兩條路徑共用同一個狀態機。
 *
 * 協定（sidecar 的 stdout，一行一個）：`READY` / `D` / `U` / `E`
 *
 * **優先用 Rust 版 `voiceink-probe.exe hook`**（native/voiceink-probe/src/hook.rs，同一份協定）：
 * .NET 那支光 runtime 就佔 30MB 級的工作集，Rust 版個位數 MB。找不到才退回 .NET 那支。
 */

const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')

/** 掛上 hook 的等待上限：正常 100ms 內就回 READY */
const READY_TIMEOUT_MS = 4000
/** 程序意外結束後隔多久重開 */
const RESTART_DELAY_MS = 1500
/** 連續重開幾次還是不行就放棄，退回 uiohook */
const MAX_RESTARTS = 3

/**
 * sidecar 的位置。打包後在 `resources/hook/`（`extraResources`），
 * 開發時在專案的 `resources/hook/`（`npm run build:hook` 的產出）。
 * @param {{ resourcesPath?: string }} [deps]
 * @returns {string}
 */
function resolveExePath(deps = {}) {
  const resourcesPath = deps.resourcesPath || process.resourcesPath || ''
  const candidates = [
    resourcesPath ? path.join(resourcesPath, 'hook', 'VoiceInkHook.exe') : '',
    path.join(__dirname, '..', '..', '..', 'resources', 'hook', 'VoiceInkHook.exe')
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
 * 要 spawn 什麼：有 Rust 版就 `voiceink-probe.exe hook`，否則 .NET 那支。
 * @param {{ exePath?: string, resourcesPath?: string, probeExe?: string }} [deps]
 * @returns {{ file: string, args: string[] }}
 */
function hookCommand(deps = {}) {
  if (deps.exePath) return { file: deps.exePath, args: [] }
  const probe = deps.probeExe ?? require('../native-probe').resolveProbeExe({ resourcesPath: deps.resourcesPath })
  if (probe) return { file: probe, args: ['hook'] }
  return { file: resolveExePath(deps), args: [] }
}

/**
 * 把 sidecar 拉起來。
 *
 * @param {{ onEvent: (kind: 'down'|'up'|'escape') => void,
 *           spawnFn?: Function, exePath?: string, resourcesPath?: string }} deps
 * @returns {Promise<{ ok: boolean, error?: string, stop?: () => void }>}
 */
async function startHook(deps) {
  const { file: exePath, args } = hookCommand(deps)
  if (!exePath) return { ok: false, error: 'HOOK_EXE_MISSING' }
  const spawnFn = deps.spawnFn || spawn
  const onEvent = typeof deps.onEvent === 'function' ? deps.onEvent : () => {}

  let stopped = false
  let restarts = 0
  /** @type {import('child_process').ChildProcess | null} */
  let child = null
  /** @type {NodeJS.Timeout | null} */
  let restartTimer = null

  const stop = () => {
    stopped = true
    if (restartTimer) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
    const current = child
    child = null
    if (current) {
      try {
        current.kill()
      } catch (err) {
        console.error('[dictation] 收掉熱鍵 sidecar 失敗:', err?.message || err)
      }
    }
  }

  /**
   * @returns {Promise<boolean>} 有沒有收到 READY
   */
  const launch = () => new Promise((resolve) => {
    let settled = false
    let buffer = ''
    let proc
    try {
      // stdin 要保持開著：sidecar 靠 stdin 的 EOF 知道我們關掉了，才不會變成
      // 「攔著全機鍵盤的孤兒程序」
      proc = spawnFn(exePath, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    } catch (err) {
      console.error('[dictation] 啟動熱鍵 sidecar 失敗:', err?.message || err)
      resolve(false)
      return
    }
    child = proc

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(false)
    }, READY_TIMEOUT_MS)
    if (timer.unref) timer.unref()

    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
        if (!line) continue
        if (line === 'READY') {
          restarts = 0
          if (!settled) {
            settled = true
            clearTimeout(timer)
            resolve(true)
          }
        } else if (line === 'D') onEvent('down')
        else if (line === 'U') onEvent('up')
        else if (line === 'E') onEvent('escape')
      }
      // 一行都塞不滿卻已經很長＝對方吐了非預期的東西，丟掉免得無限長大
      if (buffer.length > 4096) buffer = ''
    })

    proc.on('error', (err) => {
      console.error('[dictation] 熱鍵 sidecar 錯誤:', err?.message || err)
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve(false)
      }
    })

    proc.on('exit', () => {
      if (child === proc) child = null
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve(false)
        return
      }
      // 已經在用了才掛掉（例如被防毒收掉）：自己重開，不要讓熱鍵無聲失效
      if (stopped || restarts >= MAX_RESTARTS) return
      restarts++
      restartTimer = setTimeout(() => {
        restartTimer = null
        if (!stopped) void launch()
      }, RESTART_DELAY_MS)
      if (restartTimer.unref) restartTimer.unref()
    })
  })

  const ok = await launch()
  if (!ok) {
    stop()
    return { ok: false, error: 'HOOK_START_FAILED' }
  }
  return { ok: true, stop }
}

module.exports = {
  resolveExePath,
  hookCommand,
  startHook,
  READY_TIMEOUT_MS,
  MAX_RESTARTS
}
