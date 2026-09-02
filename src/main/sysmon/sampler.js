'use strict'

/**
 * VoiceInk — 系統監控取樣器的生命週期。
 *
 * probe.ps1 是**常駐**的 PowerShell 子程序：冷啟動要 ~190ms，每輪取樣 ~310ms，
 * 每輪都重開等於一半時間在付啟動費。所以開一次、之後用 stdin 送 `tick <seq>` 驅動。
 *
 * 背壓：上一輪還沒回來就跳過這一輪（`inFlight`）。少了這個，機器忙的時候指令會在
 * stdin 排隊，畫面顯示的是好幾秒前的資料，而且排愈久愈落後。
 */

const { spawn } = require('child_process')
const path = require('path')
const os = require('os')
const metrics = require('./metrics')

/** 取樣間隔白名單。renderer 只送 key，毫秒數由 main 決定。 */
const INTERVALS = Object.freeze({ fast: 1000, normal: 2000, slow: 5000 })
const DEFAULT_INTERVAL_KEY = 'normal'
/** 一輪 ~310ms，逾時給到 8 秒純粹是防它真的卡死 */
const TICK_TIMEOUT_MS = 8000
const READY_TIMEOUT_MS = 15_000
const RESTART_BASE_MS = 1000
const RESTART_MAX_MS = 30_000

/**
 * 打包後 probe.ps1 在 app.asar 裡，而 powershell.exe 是外部程序、**執行不了 asar 內的檔案**。
 * 跟 usage/antigravity.js 的 read-windows-credential.ps1 同一個處理（builder 有 asarUnpack）。
 * @param {string} [baseDir]
 */
function resolveProbePath(baseDir = __dirname) {
  const script = path.join(baseDir, 'probe.ps1')
  const asarSegment = `${path.sep}app.asar${path.sep}`
  return script.replace(asarSegment, `${path.sep}app.asar.unpacked${path.sep}`)
}

function powershellPath() {
  const windowsRoot = process.env.SystemRoot || 'C:\\Windows'
  return path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/**
 * @param {object} [deps] 測試用的注入點
 * @param {typeof spawn} [deps.spawnFn]
 * @param {() => any[]} [deps.cpusFn]
 */
function createSampler(deps = {}) {
  const spawnFn = deps.spawnFn || spawn
  const cpusFn = deps.cpusFn || (() => os.cpus())

  /** @type {import('child_process').ChildProcess | null} */
  let child = null
  let parser = metrics.createFrameParser()
  let stdoutBuf = ''
  let seq = 0
  let inFlight = false
  /** @type {NodeJS.Timeout | null} */
  let tickTimer = null
  /** @type {NodeJS.Timeout | null} */
  let restartTimer = null
  /** @type {NodeJS.Timeout | null} */
  let watchdog = null
  let restartDelay = RESTART_BASE_MS
  let running = false
  let intervalMs = INTERVALS[DEFAULT_INTERVAL_KEY]

  /** @type {ReturnType<typeof metrics.parseTick> | null} */
  let prevTick = null
  /** @type {any[] | null} */
  let prevCpus = null
  /** @type {any} */
  let staticInfo = null
  let staticRequested = false
  /** @type {Map<number, (value: any) => void>} */
  const detailWaiters = new Map()

  /** @type {(sample: any) => void} */
  let onSample = () => {}
  /** @type {(err: { code: string, message: string }) => void} */
  let onError = () => {}

  function clearTimer(t) {
    if (t) clearTimeout(t)
    return null
  }

  function stopChild() {
    tickTimer = clearTimer(tickTimer)
    watchdog = clearTimer(watchdog)
    if (!child) return
    const dying = child
    child = null
    try { dying.stdin?.end() } catch { /* 已經斷了就算了 */ }
    try { dying.kill() } catch { /* 同上 */ }
  }

  function scheduleRestart() {
    if (!running || restartTimer) return
    const delay = restartDelay
    restartDelay = Math.min(RESTART_MAX_MS, restartDelay * 2)
    restartTimer = setTimeout(() => {
      restartTimer = null
      if (running) launch()
    }, delay)
  }

  function send(line) {
    if (!child?.stdin?.writable) return false
    try {
      child.stdin.write(`${line}\n`)
      return true
    } catch {
      return false
    }
  }

  function requestTick() {
    if (!running || !child) return
    // 背壓：上一輪沒回來就跳過，不排隊
    if (inFlight) return
    seq += 1
    inFlight = true
    watchdog = clearTimer(watchdog)
    watchdog = setTimeout(() => {
      // 卡住了：這顆 PowerShell 不會自己好，收掉重開
      inFlight = false
      onError({ code: 'SYSMON_TIMEOUT', message: '系統監控取樣逾時，已重新啟動取樣器' })
      stopChild()
      scheduleRestart()
    }, TICK_TIMEOUT_MS)
    if (!send(`tick ${seq}`)) {
      inFlight = false
      watchdog = clearTimer(watchdog)
    }
  }

  function scheduleNextTick() {
    tickTimer = clearTimer(tickTimer)
    if (!running) return
    tickTimer = setTimeout(() => {
      requestTick()
      scheduleNextTick()
    }, intervalMs)
  }

  function handleFrame(frame) {
    if (frame.kind === 'static') {
      staticInfo = metrics.parseStatic(frame.rows)
      return
    }
    if (frame.kind === 'detail') {
      const waiter = detailWaiters.get(frame.seq)
      if (waiter) {
        detailWaiters.delete(frame.seq)
        waiter(parseDetail(frame.rows))
      }
      return
    }
    if (frame.kind !== 'tick') return

    inFlight = false
    watchdog = clearTimer(watchdog)
    restartDelay = RESTART_BASE_MS

    const tick = metrics.parseTick(frame.rows)
    const cpus = cpusFn()
    const cpu = metrics.cpuUsage(prevCpus, cpus)
    const diff = metrics.diffSamples(prevTick, tick, cpus.length)
    prevTick = tick
    prevCpus = cpus

    onSample({
      ...diff,
      cpu,
      // 第一輪沒有差值可算，畫面別把一整排 0 當成「機器很閒」
      warmup: diff.processes.length > 0 && diff.processes.every((p) => p.cpu === 0)
    })
  }

  function parseDetail(rows) {
    /** @type {any} */
    const out = { pid: 0, name: '', path: '', owner: '', startedAt: 0, parentPid: 0, company: '', description: '', version: '' }
    for (const row of rows) {
      const f = row.split('|')
      if (f[0] === 'X') {
        out.pid = Number(f[1]) || 0
        out.name = f[2] || ''
        out.path = f[3] || ''
        out.owner = f[4] || ''
        out.startedAt = Number(f[5]) || 0
        out.parentPid = Number(f[6]) || 0
      } else if (f[0] === 'XV') {
        out.company = f[1] || ''
        out.description = f[2] || ''
        out.version = f[3] || ''
      }
    }
    return out
  }

  function launch() {
    stopChild()
    parser = metrics.createFrameParser()
    stdoutBuf = ''
    inFlight = false
    staticRequested = false
    prevTick = null
    prevCpus = null

    let proc
    try {
      proc = spawnFn(powershellPath(), [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', resolveProbePath()
      ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch {
      onError({ code: 'SYSMON_SPAWN_FAILED', message: '無法啟動系統監控取樣器' })
      scheduleRestart()
      return
    }
    child = proc

    const readyTimer = setTimeout(() => {
      if (child === proc && !parser.ready()) {
        onError({ code: 'SYSMON_NO_READY', message: '系統監控取樣器沒有回應' })
        stopChild()
        scheduleRestart()
      }
    }, READY_TIMEOUT_MS)

    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk) => {
      stdoutBuf += chunk
      let idx
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx)
        stdoutBuf = stdoutBuf.slice(idx + 1)
        const frame = parser.push(line)
        if (frame) handleFrame(frame)
        else if (parser.ready() && !staticRequested) {
          // 只送一次：這個分支每讀一行就會走到，沒有旗標會連送幾百個 static
          staticRequested = true
          send(`static ${++seq}`)
        }
      }
      // 一列都收不完就無限長 → 上游壞掉時不要把記憶體吃光
      if (stdoutBuf.length > 4 * 1024 * 1024) stdoutBuf = ''
    })
    // stderr 只在開發時有用；內容可能含路徑，不往 renderer 送
    proc.stderr?.resume()
    proc.on('error', () => {
      if (child !== proc) return
      onError({ code: 'SYSMON_SPAWN_FAILED', message: '無法啟動系統監控取樣器' })
      stopChild()
      scheduleRestart()
    })
    proc.on('close', () => {
      clearTimeout(readyTimer)
      if (child !== proc) return
      child = null
      inFlight = false
      if (running) {
        onError({ code: 'SYSMON_EXITED', message: '系統監控取樣器已結束，正在重新啟動' })
        scheduleRestart()
      }
    })

    // 第一輪立刻要，不要讓使用者盯著空畫面等一個 interval
    setTimeout(() => {
      if (child === proc) requestTick()
    }, 0)
    scheduleNextTick()
  }

  return {
    INTERVALS,
    resolveProbePath,
    /** @param {(sample: any) => void} fn */
    setSampleHandler(fn) { onSample = typeof fn === 'function' ? fn : () => {} },
    /** @param {(err: { code: string, message: string }) => void} fn */
    setErrorHandler(fn) { onError = typeof fn === 'function' ? fn : () => {} },
    /** @param {string} [intervalKey] */
    start(intervalKey) {
      intervalMs = INTERVALS[intervalKey] || INTERVALS[DEFAULT_INTERVAL_KEY]
      if (running) {
        scheduleNextTick()
        return
      }
      running = true
      restartDelay = RESTART_BASE_MS
      launch()
    },
    stop() {
      running = false
      restartTimer = clearTimer(restartTimer)
      stopChild()
      send('bye')
      prevTick = null
      prevCpus = null
      for (const waiter of detailWaiters.values()) waiter(null)
      detailWaiters.clear()
    },
    isRunning: () => running,
    getStatic: () => staticInfo,
    /**
     * 選到某一列才查路徑／擁有者（每輪都查要多 284ms）。
     * @param {number} pid
     * @returns {Promise<any|null>}
     */
    detail(pid) {
      if (!child || !running) return Promise.resolve(null)
      const id = ++seq
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          detailWaiters.delete(id)
          resolve(null)
        }, 5000)
        detailWaiters.set(id, (value) => {
          clearTimeout(timer)
          resolve(value)
        })
        if (!send(`detail ${id} ${Math.trunc(pid)}`)) {
          clearTimeout(timer)
          detailWaiters.delete(id)
          resolve(null)
        }
      })
    }
  }
}

module.exports = { createSampler, resolveProbePath, INTERVALS }
