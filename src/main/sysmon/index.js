'use strict'

/**
 * VoiceInk — 系統監控服務門面。
 *
 * renderer 拿不到任何路徑、指令或 SQL：它只能送「開始／停止」「換取樣間隔」「結束這個 pid」，
 * 其餘（PowerShell 腳本、nvidia-smi 參數、taskkill 參數、測速目錄）全部固定在這一層。
 *
 * 三顆子程序都要記得收（比照終端機那條教訓）：probe.ps1、nvidia-smi、感測器 sidecar。
 * `before-quit` 少收一顆就會留在工作管理員裡。
 */

const os = require('os')
const { spawn } = require('child_process')
const { createSampler, INTERVALS } = require('./sampler')
const { createGpuFeed } = require('./gpu')
const { runDiskBench, cancelDiskBench, clampSizeMb } = require('./bench')
const { createSensorBridge, PAWNIO_URL } = require('./sensors')
const { createStressRunner } = require('./stress')
const { createFanEngine } = require('./fans')
const { createOcEngine } = require('./oc')
const pawnio = require('./pawnio')
const metrics = require('./metrics')

const INTERVAL_KEYS = Object.freeze(Object.keys(INTERVALS))
const KILL_TIMEOUT_MS = 10_000

/**
 * 每台螢幕的桌面配置。`electron` 在單元測試裡不一定 require 得到，失敗就當作沒有。
 * @returns {Array<object>}
 */
function readDisplays() {
  try {
    const { screen } = require('electron')
    const primaryId = screen.getPrimaryDisplay().id
    return screen.getAllDisplays().map((d) => ({
      id: String(d.id),
      label: d.label || '',
      width: d.size.width,
      height: d.size.height,
      refreshHz: Math.round(d.displayFrequency || 0),
      scale: d.scaleFactor,
      colorDepth: d.colorDepth,
      rotation: d.rotation,
      internal: Boolean(d.internal),
      primary: d.id === primaryId
    }))
  } catch {
    return []
  }
}

function createSysmonService(deps = {}) {
  const spawnFn = deps.spawnFn || spawn
  const sampler = createSampler(deps.samplerDeps)
  const gpu = createGpuFeed(deps.gpuDeps)
  const sensors = createSensorBridge(deps.sensorDeps)
  const stress = createStressRunner()
  const fans = createFanEngine({ sensors })
  const oc = createOcEngine({ sensors })

  /** @type {(payload: any) => void} */
  let emit = () => {}
  let intervalKey = 'normal'
  /** 最近一筆取樣，效能調整儀表拿 CPU% 與 nvidia-smi 補 sidecar 還沒到的欄位 */
  let lastFeed = null

  sampler.setSampleHandler((sample) => {
    const data = {
      ...sample,
      gpu: gpu.read(),
      // 帶上 status 是為了讓畫面能自己更新提示：裝了 PawnIO 之後 `Computer.Open()`
      // 要載一堆核心模組，第一筆讀數實測約 10 秒才到，中間得有話講
      sensors: { ...sensorStatus(), groups: sensors.read().groups },
      totalMemory: os.totalmem()
    }
    lastFeed = data
    emit({ type: 'sample', data })
  })
  sampler.setErrorHandler((error) => {
    // 這裡的訊息全是我們自己寫死的字串，沒有夾帶系統錯誤內容
    emit({ type: 'error', data: error })
  })

  /** 感測器狀態＋「核心驅動裝了沒」——按鈕要靠它決定是「安裝驅動」還是「啟用」 */
  function sensorStatus() {
    return { ...sensors.status(), pawnIoInstalled: pawnio.isInstalled() }
  }

  /**
   * 儀表用的即時讀數：sidecar 的 o 是牆與每核時脈，nvidia-smi／probe 補負載與 GPU 功耗。
   * @param {any} snap
   */
  function withOcFeed(snap) {
    const card = (lastFeed?.gpu?.cards || gpu.read().cards || [])[0] || null
    return {
      ...snap,
      feed: {
        cpuTotal: lastFeed?.cpu?.total ?? null,
        gpu: card
      }
    }
  }

  /** 靜默把感測器拉起來（見門面的 ensureSensors） */
  async function ensureSensors() {
    const result = await sensors.enable({ elevate: false })
    if (fans.isEnabled() && result.state === 'on') await fans.setEnabled(true)
    return result
  }

  /** @param {unknown} key */
  function normalizeInterval(key) {
    return INTERVAL_KEYS.includes(String(key)) ? String(key) : 'normal'
  }

  return {
    /** @param {(payload: any) => void} fn */
    setEmitter(fn) { emit = typeof fn === 'function' ? fn : () => {} },

    /** @param {unknown} key */
    start(key) {
      intervalKey = normalizeInterval(key)
      // nvidia-smi 的輪詢最小單位是秒，取樣 1 秒時它也給 1 秒
      gpu.start(Math.max(1, Math.round(INTERVALS[intervalKey] / 1000)))
      sampler.start(intervalKey)
      return { running: true, intervalKey }
    },

    stop() {
      sampler.stop()
      gpu.stop()
      return { running: false, intervalKey }
    },

    status() {
      return {
        running: sampler.isRunning(),
        intervalKey,
        intervals: INTERVALS,
        logicalCores: os.cpus().length,
        totalMemory: os.totalmem(),
        hostname: os.hostname(),
        gpuFeed: gpu.read().available,
        sensors: sensorStatus()
      }
    },

    /**
     * 一次性硬體清單；取樣器還沒回報就回 null，renderer 顯示「偵測中」。
     * 桌面配置（每台螢幕的解析度／更新率／縮放）走 Electron 的 `screen`——
     * `Win32_VideoController` 只講得出主顯示器那一組。
     */
    inventory() {
      const stat = sampler.getStatic()
      if (!stat) return null
      // 健康度判定放在這裡而不是 renderer：renderer 是 ESM、載不動 CJS 的 metrics.js，
      // 複製一份判準過去就等於留了兩套會各自漂移的規則
      const smart = (stat.smart || []).map((s) => ({ ...s, health: metrics.smartHealth(s) }))
      return { ...stat, smart, displays: readDisplays() }
    },

    /** @param {unknown} pid */
    detail(pid) {
      const check = metrics.validateKillPid(pid)
      if (!check.ok) return Promise.resolve(null)
      return sampler.detail(check.pid)
    },

    /**
     * 結束工作。`taskkill` 不帶 /F 是送關閉訊息（工作管理員的「結束工作」），
     * 帶 /F /T 才是強制連子程序一起砍（「強制結束工作」）。
     * @param {unknown} pid
     * @param {unknown} force
     */
    killProcess(pid, force) {
      const check = metrics.validateKillPid(pid)
      if (!check.ok) {
        const err = new Error('invalid pid')
        err.code = 'SYSMON_BAD_PID'
        err.userMessage = check.reason
        throw err
      }
      if (check.pid === process.pid) {
        const err = new Error('self')
        err.code = 'SYSMON_SELF'
        err.userMessage = '不能從這裡結束 VoiceInk 自己'
        throw err
      }
      const args = force === true
        ? ['/PID', String(check.pid), '/F', '/T']
        : ['/PID', String(check.pid)]

      return new Promise((resolve, reject) => {
        let child
        try {
          // stdio 全部 ignore：留著 stdin 管線會讓子程序等一個永遠不來的 EOF（AGY 那條教訓）
          child = spawnFn('taskkill.exe', args, { windowsHide: true, stdio: 'ignore' })
        } catch {
          const err = new Error('spawn failed')
          err.code = 'SYSMON_KILL_FAILED'
          err.userMessage = '無法結束這個處理程序'
          reject(err)
          return
        }
        const timer = setTimeout(() => {
          try { child.kill() } catch { /* 已經結束了 */ }
          const err = new Error('timeout')
          err.code = 'SYSMON_KILL_TIMEOUT'
          err.userMessage = '結束處理程序逾時'
          reject(err)
        }, KILL_TIMEOUT_MS)
        child.on('error', () => {
          clearTimeout(timer)
          const err = new Error('spawn failed')
          err.code = 'SYSMON_KILL_FAILED'
          err.userMessage = '無法結束這個處理程序'
          reject(err)
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          if (code === 0) {
            resolve({ pid: check.pid, forced: force === true })
            return
          }
          const err = new Error(`taskkill exit ${code}`)
          err.code = 'SYSMON_KILL_DENIED'
          // taskkill 的 exit code 不細分，最常見的就是權限不足或程序已經不在了
          err.userMessage = force === true
            ? '結束失敗：可能需要系統管理員權限，或這個處理程序已經結束'
            : '結束失敗：程式沒有回應關閉要求，可以改用「強制結束工作」'
          reject(err)
        })
      })
    },

    /**
     * CPU 壓力測試。renderer 只送「開／關」與執行緒數，上限夾在 stress.js 裡。
     * @param {unknown} run @param {unknown} threads
     */
    cpuStress(run, threads) { return stress.cpu(run === true, threads) },

    /** 記憶體壓力測試。目標容量會被目前可用記憶體的七成夾住。 */
    memStress(run, gb) { return stress.memory(run === true, gb) },

    stressStatus: () => stress.status(),

    /**
     * @param {{ dir: string, sizeMb?: unknown }} req  dir 由 IPC 層走系統對話框取得並驗過
     */
    diskBench(req) {
      return runDiskBench(
        { dir: req?.dir, sizeMb: clampSizeMb(req?.sizeMb) },
        (progress) => emit({ type: 'benchProgress', data: progress })
      )
    },
    cancelDiskBench,

    /**
     * 設定與路徑注入。`packaged` 決定能不能安裝「免 UAC 啟動」的排程工作
     * （開發版的執行檔在可寫目錄，註冊成提權工作等於留後門）。
     * @param {{ store?: any, userDataPath?: string, packaged?: boolean }} options
     */
    configure(options = {}) {
      sensors.configure({
        userDataPath: options.userDataPath,
        packaged: options.packaged,
        // sidecar 死掉時自己重拉（走排程工作那條，不彈 UAC），風扇才不會斷手
        onLost: () => { ensureSensors().catch(() => undefined) }
      })
      fans.configure({ store: options.store })
      oc.configure({ store: options.store })
    },

    /** 提權感測器（CPU／主機板／硬碟溫度、風扇、電壓） */
    enableSensors: () => sensors.enable({ elevate: true }).then(async () => {
      // 感測器一上線就把風扇接管接回去——使用者上次開著的設定不該因為重開 App 就失效
      if (fans.isEnabled()) await fans.setEnabled(true)
      return sensorStatus()
    }),
    sensorStatus,

    // ---- 風扇控制 ----
    /**
     * 開機自啟動時的接管：`fanControl.enabled` 為真才會去拉感測器 sidecar。
     * **不必開系統監控頁**——風扇要在使用者還沒點任何東西之前就歸我們管。
     */
    /**
     * 開機預設把感測器靜默拉起來（有排程工作就不跳 UAC、也沒有主控台視窗）。
     * `sysmonSensors === false` 才略過。sidecar 中途死掉時 `onLost` 也走這條，
     * 所以風扇接管要在這裡接回去。
     */
    ensureSensors,

    async ensureFanControl() {
      if (!fans.isEnabled()) return { enabled: false, started: false }
      const result = await sensors.enable({ elevate: false })
      if (result.state !== 'on') return { enabled: true, started: false, state: result.state }
      await fans.setEnabled(true)
      return { enabled: true, started: true }
    },

    fanList: () => fans.list(),
    /** @param {unknown} on */
    fanEnable(on) {
      if (on === true && sensors.status().state !== 'on') {
        // 感測器沒起來就沒有通道可控；先把它拉起來（會走一次 UAC 或排程工作）
        return sensors.enable({ elevate: true }).then(() => fans.setEnabled(true))
      }
      return fans.setEnabled(on === true)
    },
    /** @param {unknown} id @param {any} patch */
    fanSetChannel: (id, patch) => fans.setChannel(id, patch),
    /** @param {unknown} id */
    fanIdentify: (id) => fans.identify(id),
    fanResetAll: () => fans.resetAll(),
    fanTaskStatus: () => sensors.taskStatus(),
    fanTaskInstall: () => sensors.taskInstall(),
    fanTaskRemove: () => sensors.taskRemove(),

    ocStatus: () => withOcFeed(oc.status()),
    ocSetDraft: (patch) => withOcFeed(oc.setDraft(patch)),
    ocApply: () => withOcFeed(oc.apply()),
    ocReset: () => withOcFeed(oc.reset()),

    /**
     * 代裝 PawnIO 核心驅動（CPU／主機板那一整組感測器的前提）。
     * 已經在跑的 sidecar 是在「沒有驅動」的狀態下 Open 的，裝完要重開才吃得到，
     * 所以這裡順手收掉並重新啟用（會再走一次 UAC——兩個提權動作本來就分開）。
     */
    async installPawnIo() {
      const result = await pawnio.install()
      if (!result.already) {
        await sensors.stop()
        await sensors.enable({ elevate: true })
      }
      return { ...result, sensors: sensorStatus() }
    },

    /** 只開這一個固定網址；renderer 傳不進任何字串 */
    openPawnIoPage() {
      const { shell } = require('electron')
      return shell.openExternal(PAWNIO_URL).then(() => true)
    },

    /**
     * before-quit 用：三顆子程序全收。
     * **風扇與效能調整都要排在 sensors.stop() 之前**——先斷線就交不回去。
     * @returns {Promise<void>}
     */
    shutdown() {
      oc.shutdown()
      fans.shutdown()
      sampler.stop()
      gpu.stop()
      stress.shutdown()
      cancelDiskBench()
      return Promise.resolve(sensors.stop()).catch(() => undefined)
    }
  }
}

module.exports = { createSysmonService, INTERVAL_KEYS }
