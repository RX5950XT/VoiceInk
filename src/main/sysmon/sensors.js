'use strict'

/**
 * VoiceInk — 完整感測器橋接（HWMonitor／HWiNFO 那一塊）。
 *
 * 為什麼要另外一顆程序：CPU／主機板／VRM／硬碟的溫度、風扇轉速與電壓在 Windows 上**沒有**
 * 免權限的介面。實測 `MSAcpi_ThermalZoneTemperature` 在桌機回空、`Get-StorageReliabilityCounter`
 * 未提權直接 Access Denied。唯一的路是核心驅動（LibreHardwareMonitorLib 的 WinRing0），
 * 而那需要系統管理員。
 *
 * **不把整個 VoiceInk 提權**：終端機分頁會連帶用管理員身分開 shell，等於把整個 App 變成提權跳板。
 * 改成使用者按一次按鈕 → 只有這顆小 sidecar 走 UAC → 透過**具名管道**把讀數送回來。
 * 管道名是 128 bit 亂數，而且只接受第一個連線。
 *
 * 這條路真的可能被系統擋下（LibreHardwareMonitor 0.9.6 仍用 WinRing0，它在 Microsoft 的
 * 弱點驅動封鎖清單上；開了 HVCI／Memory Integrity 的機器一定載不起來，Defender 也可能
 * 報 HackTool:Win32/Winring0）。所以每一種失敗都要回一個**看得懂原因**的狀態，
 * 不能只丟一句「失敗」——免驅動的那些數值本來就還在，頁面不該整個空掉。
 */

const net = require('net')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { spawn } = require('child_process')
const { createSensorTask } = require('./sensors-task')

/** 官方安裝頁。代裝失敗時的後路；代裝本身在 `pawnio.js`。 */
const PAWNIO_URL = 'https://pawnio.eu/'
const CONNECT_TIMEOUT_MS = 60_000
const STALE_MS = 20_000
const MAX_LINE_BYTES = 512 * 1024
/** 等 sidecar 回報「風扇已交還」的上限；逾時就直接斷（它自己還有看門狗） */
const RESET_TIMEOUT_MS = 2_000

/** @returns {string} sidecar 執行檔位置；打包後在 resources/sensors/ */
function resolveSensorExe(deps = {}) {
  const resourcesPath = deps.resourcesPath || process.resourcesPath || ''
  const candidates = [
    resourcesPath ? path.join(resourcesPath, 'sensors', 'VoiceInkSensors.exe') : '',
    path.join(__dirname, '..', '..', '..', 'resources', 'sensors', 'VoiceInkSensors.exe')
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch { /* 路徑不合法就換下一個 */ }
  }
  return ''
}

function createSensorBridge(deps = {}) {
  const spawnFn = deps.spawnFn || spawn
  const exePathFn = deps.resolveExe || (() => resolveSensorExe(deps))
  /** 免 UAC 啟動用的排程工作；`configure()` 之前先用預設值（等於「不可安裝」） */
  let task = deps.task || createSensorTask({ spawnFn })

  /** @type {'off'|'starting'|'on'|'blocked'|'declined'|'missing'|'timeout'} */
  let state = 'off'
  let message = ''
  /** @type {net.Server | null} */
  let server = null
  /** @type {net.Socket | null} */
  let socket = null
  /** @type {NodeJS.Timeout | null} */
  let connectTimer = null
  let buf = ''
  /** @type {any[]} */
  let groups = []
  let lastAt = 0
  /** 缺 PawnIO：GPU／硬碟溫度仍可讀，只有 CPU／主機板那一塊拿不到 */
  let needsPawnIo = false
  /** 可寫入的 PWM 通道（風扇控制用）；sidecar 每一框都會重送 */
  let controls = []
  /** 等 sidecar 回報「風扇已交還」的人 */
  let resetWaiters = []
  /** 這次是不是用排程工作啟動的（決定失敗時要不要退回 -Verb RunAs） */
  let launchedByTask = false

  function cleanup() {
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = null }
    if (socket) { try { socket.destroy() } catch { /* 已經斷了 */ } socket = null }
    if (server) { try { server.close() } catch { /* 已經關了 */ } server = null }
    buf = ''
  }

  function handleLine(line) {
    const text = line.trim()
    if (!text) return
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      return
    }
    if (payload && payload.error) {
      // sidecar 自己知道驅動載不起來時會回這個
      state = 'blocked'
      message = payload.error === 'driver'
        ? '系統擋下了讀取感測器所需的核心驅動（常見原因：已開啟「記憶體完整性」，或防毒把驅動隔離）。CPU 與主機板溫度會維持空白，其餘數值不受影響。'
        : '感測器讀取失敗，其餘數值不受影響。'
      return
    }
    if (payload && payload.warn === 'pawnio') {
      // 不是致命錯誤：GPU 與硬碟溫度照樣拿得到，只有 CPU／主機板那一塊需要 PawnIO。
      needsPawnIo = true
      message = 'GPU 與硬碟溫度已可讀取。CPU 與主機板溫度另外需要 PawnIO 核心驅動'
        + '（免費、已數位簽章、相容記憶體完整性）；按下方的按鈕就會自動下載並安裝。'
      return
    }
    if (payload && payload.reset) {
      // 風扇已經全部交還，socket 可以安全收掉了
      const waiters = resetWaiters
      resetWaiters = []
      for (const done of waiters) done()
      return
    }
    if (Array.isArray(payload?.h)) {
      groups = payload.h
      controls = Array.isArray(payload.c) ? payload.c : []
      lastAt = Date.now()
      state = 'on'
      // 缺 PawnIO 的說明要留著：它講的是「還有一半拿不到、以及怎麼補」
      if (!needsPawnIo) message = ''
    }
  }

  return {
    status() {
      return {
        state,
        message,
        available: state === 'on' && (Date.now() - lastAt) < STALE_MS,
        installed: Boolean(exePathFn()),
        needsPawnIo,
        pawnIoUrl: needsPawnIo ? PAWNIO_URL : ''
      }
    },

    read() {
      if (state !== 'on' || (Date.now() - lastAt) >= STALE_MS) {
        return { available: false, groups: [], controls: [] }
      }
      return { available: true, groups, controls }
    },

    /**
     * 送一行指令給 sidecar（格式見 native/sysmon-sensors/Program.cs 的類別註解）。
     * 沒連線就回 false——呼叫端要據此把「已接管」狀態收掉，不能假裝送出去了。
     * @param {string} line
     */
    send(line) {
      if (!socket || state !== 'on') return false
      try {
        socket.write(`${line}\n`)
        return true
      } catch {
        return false
      }
    },

    /** @returns {Promise<{ state: string, message: string }>} */
    enable() {
      if (state === 'on' || state === 'starting') return Promise.resolve({ state, message })
      const exe = exePathFn()
      if (!exe) {
        state = 'missing'
        message = '這個版本沒有附帶感測器元件。'
        return Promise.resolve({ state, message })
      }

      cleanup()
      state = 'starting'
      message = ''
      const pipeName = `\\\\.\\pipe\\voiceink-sensors-${crypto.randomBytes(16).toString('hex')}`

      return new Promise((resolve) => {
        const settle = (nextState, nextMessage) => {
          state = nextState
          message = nextMessage
          resolve({ state, message })
        }

        server = net.createServer((conn) => {
          // 只收第一個連線：管道名是密鑰，收完就不再開門
          if (socket) { conn.destroy(); return }
          socket = conn
          try { server?.close() } catch { /* 已經關了 */ }
          server = null
          if (connectTimer) { clearTimeout(connectTimer); connectTimer = null }
          conn.setEncoding('utf8')
          conn.on('data', (chunk) => {
            buf += chunk
            let idx
            while ((idx = buf.indexOf('\n')) >= 0) {
              handleLine(buf.slice(0, idx))
              buf = buf.slice(idx + 1)
            }
            if (buf.length > MAX_LINE_BYTES) buf = ''
          })
          conn.on('close', () => {
            socket = null
            if (state === 'on') {
              state = 'off'
              message = '感測器元件已結束。'
            }
          })
          conn.on('error', () => { /* 斷線由 close 處理 */ })
          settle('on', '')
        })
        server.on('error', () => {
          cleanup()
          settle('blocked', '無法建立感測器連線通道。')
        })

        server.listen(pipeName, async () => {
          // 先試排程工作（不彈 UAC）；沒裝或觸發失敗才退回 -Verb RunAs（每次一個 UAC）
          launchedByTask = await task.run(pipeName).catch(() => false)
          if (launchedByTask) return

          let child
          try {
            // Start-Process -Verb RunAs 才會彈 UAC；直接 spawn 只會拿到 ERROR_ELEVATION_REQUIRED。
            // 參數只有我們自己產生的管道名，沒有任何 renderer 傳進來的字串。
            child = spawnFn('powershell.exe', [
              '-NoProfile',
              '-NonInteractive',
              '-ExecutionPolicy', 'Bypass',
              '-Command',
              `Start-Process -FilePath '${exe.replace(/'/g, "''")}' -ArgumentList '${pipeName}' -Verb RunAs -WindowStyle Hidden`
            ], { windowsHide: true, stdio: 'ignore' })
          } catch {
            cleanup()
            settle('blocked', '無法啟動感測器元件。')
            return
          }
          child.on('error', () => {
            cleanup()
            settle('blocked', '無法啟動感測器元件。')
          })
          child.on('close', (code) => {
            // 使用者在 UAC 按「否」時 Start-Process 會失敗；此時還沒有人連上來
            if (code !== 0 && !socket) {
              cleanup()
              settle('declined', '需要系統管理員權限才能讀取 CPU 與主機板溫度。')
            }
          })
        })

        connectTimer = setTimeout(() => {
          if (socket) return
          cleanup()
          settle('timeout', '感測器元件沒有回應；CPU 與主機板溫度會維持空白，其餘數值不受影響。')
        }, CONNECT_TIMEOUT_MS)
      })
    },

    /**
     * 收掉 sidecar。**先請它把風扇交還再斷線**：手動 PWM 是留在晶片裡的，
     * 直接 destroy 會讓風扇釘在最後的轉速（實測驗過，`SetDefault` 事後救不回來）。
     * sidecar 自己也有 5 秒看門狗，這裡只是把等待縮短到一次來回。
     * @returns {Promise<void>}
     */
    stop() {
      const finish = () => {
        cleanup()
        groups = []
        controls = []
        resetWaiters = []
        lastAt = 0
        if (state !== 'missing') {
          state = 'off'
          message = ''
        }
      }
      if (!socket || state !== 'on') {
        finish()
        return Promise.resolve()
      }
      return new Promise((resolve) => {
        let settled = false
        const done = () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          finish()
          resolve()
        }
        const timer = setTimeout(done, RESET_TIMEOUT_MS)
        resetWaiters.push(done)
        try {
          socket.write('R\n')
        } catch {
          done()
        }
      })
    },

    /**
     * 免 UAC 啟動的排程工作。`packaged` 為假時 `install()` 會被擋下來（見 sensors-task.js）。
     * @param {{ userDataPath?: string, packaged?: boolean }} options
     */
    configure(options = {}) {
      task = createSensorTask({
        spawnFn,
        userDataPath: options.userDataPath || '',
        packaged: options.packaged === true
      })
    },

    taskStatus: () => task.status(exePathFn()),
    taskInstall: () => task.install(exePathFn()),
    taskRemove: () => task.remove(),
    /** 這次的 sidecar 是不是免 UAC 起來的（UI 要據此說明還會不會彈視窗） */
    launchedByTask: () => launchedByTask
  }
}

module.exports = { createSensorBridge, resolveSensorExe, PAWNIO_URL }
