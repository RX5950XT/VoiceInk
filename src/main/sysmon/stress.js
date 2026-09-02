'use strict'

/**
 * VoiceInk — CPU 與記憶體壓力測試。
 *
 * 兩個都放 main 而不是 renderer，理由不同但都很實際：
 *  - CPU：renderer 的 Web Worker 跟畫面共用同一個 process 的排程，量到的是「瀏覽器分給你多少」
 *    而不是這台機器的上限；而且 CSP `script-src 'self'` 在 file:// 底下能不能建 Worker 並不保證。
 *  - 記憶體：V8 的堆有上限（約 4GB），renderer 根本配不到 32GB。實際配置又再往下推一層，
 *    交給 `ELECTRON_RUN_AS_NODE` 開出來的**子程序**——Electron 的 V8 sandbox 對整個 process
 *    的 ArrayBuffer 有大約 8GB 的天花板（見 `CHILD_MAX_BYTES`），而且砍程序才是唯一
 *    「按下停止就真的把記憶體還給作業系統」的做法。
 *
 * 兩者都有 5 分鐘安全上限；`before-quit` 走 `shutdown()` 一起收（同終端機 killAll 那條教訓）。
 * renderer 只送「開／關」與一個數字，上限與夾值全在這一層。
 */

const os = require('os')
const { Worker } = require('worker_threads')
const { spawn } = require('child_process')

/** 安全閥：跟 GPU 壓力測試同一個上限 */
const MAX_MS = 5 * 60 * 1000
const CHUNK_BYTES = 256 * 1024 * 1024
/** 每 2 秒摸一次已配置的記憶體，免得作業系統把它換出去（換出去就等於沒在測） */
const TOUCH_MS = 2000
/** 最多吃掉目前可用記憶體的七成——再多就是在測分頁交換，不是在測記憶體 */
const MEMORY_HEADROOM = 0.7
/**
 * 一個子程序最多配多少。
 *
 * **Electron 的 V8 sandbox 對整個 process 的 ArrayBuffer 有大約 8GB 的上限**，而且是
 * 每個 process 一份、不是每個 isolate 一份（實測：main 裡配到 7.75GB 就 `Failed to
 * allocate memory`；改開 5 條 worker thread 各自配，五條加起來還是 7.75GB；同一台機器
 * 用純 node 跑同一段程式碼可以配到 50GB）。所以要在 64GB 的機器上真的把記憶體吃滿，
 * 只能開好幾個**子程序**，一個吃一份額度。
 *
 * 順帶解決另一個問題：以前停止只是把 Buffer 的參考丟掉，實際回收要等 GC——`--expose-gc`
 * 沒開的話那可能是好幾秒甚至更久，畫面上寫著「已釋放」但工作管理員裡還是滿的（實測到
 * 停止後 4 秒可用記憶體一點都沒回來）。子程序砍掉是作業系統立刻回收，沒有等待。
 */
const CHILD_MAX_BYTES = 6 * 1024 * 1024 * 1024

/**
 * 忙迴圈。相依運算 + 回寫，JIT 沒辦法把整段消掉；`setImmediate` 是為了讓
 * 事件迴圈有機會收到 stop 訊息（純 while(true) 會連停都停不了）。
 */
const BURN_SOURCE = `
const { parentPort } = require('worker_threads')
let running = true
let x = 1.000001
parentPort.on('message', (msg) => { if (msg === 'stop') running = false })
function spin() {
  for (let i = 0; i < 4e6; i += 1) x = Math.sqrt(x * 1.0000001 + (i % 7)) + 1.000001
  if (!Number.isFinite(x) || x === 0) x = 1.000001
  if (running) setImmediate(spin)
  else process.exit(0)
}
spin()
`

/**
 * 吃記憶體的子程序。用 `ELECTRON_RUN_AS_NODE` 把 VoiceInk.exe 當成 node 跑（打包後沒有
 * 另一支 node 可用），`-e` 直接餵原始碼——不必為了它在 asar 裡放一個檔案。
 *
 * 配完之後把「實際配到幾塊」印到 stdout；父程序讀那一行才知道真的吃了多少。
 * 自帶 5 分鐘自殺計時器：父程序萬一沒收掉，它也不會一直佔著記憶體。
 */
const HOG_SOURCE = `
const count = Number(process.argv[1]) || 0
const CHUNK = ${CHUNK_BYTES}
const chunks = []
for (let i = 0; i < count; i += 1) {
  try {
    const b = Buffer.allocUnsafe(CHUNK)
    // 一定要寫過才算真的跟作業系統要到頁；allocUnsafe 不寫的話可能只是保留位址空間
    b.fill(i & 0xff)
    chunks.push(b)
  } catch {
    break
  }
}
console.log(chunks.length)
let t = 0
// 定期摸一下，免得作業系統把它換出去（換出去就等於沒在測）
setInterval(() => {
  t = (t + 1) & 0xff
  for (const c of chunks) c[(t * 997) % c.length] = t
}, ${TOUCH_MS})
setTimeout(() => process.exit(0), ${MAX_MS})
`

function createStressRunner() {
  /** @type {Worker[]} */
  let workers = []
  /** @type {NodeJS.Timeout | null} */
  let cpuTimer = null
  let cpuStartedAt = 0

  /** @type {import('child_process').ChildProcess[]} */
  let hogs = []
  /** 子程序回報「真的配到幾 bytes」的加總 */
  let allocatedBytes = 0
  /** @type {NodeJS.Timeout | null} */
  let memTimer = null
  let memStartedAt = 0

  /** @param {unknown} v @param {number} lo @param {number} hi */
  function clampInt(v, lo, hi) {
    const n = Math.round(Number(v))
    if (!Number.isFinite(n)) return lo
    return Math.min(hi, Math.max(lo, n))
  }

  function stopCpu() {
    if (cpuTimer) { clearTimeout(cpuTimer); cpuTimer = null }
    for (const worker of workers) {
      try { worker.postMessage('stop') } catch { /* 已經結束了 */ }
      // 沒在 200ms 內自己走的就直接收掉：這是壓力測試，不需要優雅退場
      setTimeout(() => { try { worker.terminate() } catch { /* 已經結束了 */ } }, 200).unref?.()
    }
    workers = []
    cpuStartedAt = 0
  }

  function stopMemory() {
    if (memTimer) { clearTimeout(memTimer); memTimer = null }
    for (const hog of hogs) {
      try { hog.kill() } catch { /* 已經結束了 */ }
    }
    hogs = []
    allocatedBytes = 0
    memStartedAt = 0
  }

  /**
   * 開一個吃記憶體的子程序，等它回報實際配到幾塊。
   * @param {number} chunkCount
   * @returns {Promise<void>}
   */
  function spawnHog(chunkCount) {
    return new Promise((resolve) => {
      let child
      try {
        child = spawn(process.execPath, ['-e', HOG_SOURCE, String(chunkCount)], {
          // stdin 不接管線：接了又不關的話子程序可能卡在等輸入（同 AGY 代跑 CLI 那條教訓）
          stdio: ['ignore', 'pipe', 'ignore'],
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          windowsHide: true
        })
      } catch {
        resolve()
        return
      }
      hogs.push(child)
      let line = ''
      let done = false
      const finish = () => {
        if (done) return
        done = true
        resolve()
      }
      child.stdout.on('data', (buf) => {
        line += buf
        if (!line.includes('\n')) return
        allocatedBytes += (Number(line.trim()) || 0) * CHUNK_BYTES
        finish()
      })
      child.on('error', finish)
      child.on('exit', finish)
    })
  }

  return {
    /**
     * @param {unknown} run
     * @param {unknown} threads
     */
    cpu(run, threads) {
      stopCpu()
      if (run !== true) return this.status()
      const count = clampInt(threads, 1, Math.max(1, os.cpus().length))
      for (let i = 0; i < count; i += 1) {
        try {
          workers.push(new Worker(BURN_SOURCE, { eval: true }))
        } catch {
          // 建不起來就用已經起來的那幾條跑；回報的數字是實際值，不是要求值
          break
        }
      }
      cpuStartedAt = Date.now()
      cpuTimer = setTimeout(() => stopCpu(), MAX_MS)
      return this.status()
    },

    /**
     * 配置記憶體。**是 async**：要等子程序真的配完才知道實際吃到多少，
     * 這個數字就是 UI 上「已配置 N GB」那一行的來源。
     * @param {unknown} run
     * @param {unknown} gb
     * @returns {Promise<object>}
     */
    async memory(run, gb) {
      stopMemory()
      if (run !== true) return this.status()
      const requested = clampInt(gb, 1, 512) * 1024 * 1024 * 1024
      const budget = Math.max(CHUNK_BYTES, Math.floor(os.freemem() * MEMORY_HEADROOM))
      const target = Math.min(requested, budget)
      const totalChunks = Math.max(1, Math.floor(target / CHUNK_BYTES))
      const perChild = Math.max(1, Math.floor(CHILD_MAX_BYTES / CHUNK_BYTES))
      memStartedAt = Date.now()
      memTimer = setTimeout(() => stopMemory(), MAX_MS)
      /** @type {Promise<void>[]} */
      const pending = []
      for (let left = totalChunks; left > 0; left -= perChild) {
        pending.push(spawnHog(Math.min(perChild, left)))
      }
      await Promise.all(pending)
      // 等待期間被按了停止：這時 hogs 已經清空，不要留一個「在跑」的假狀態
      if (!hogs.length) allocatedBytes = 0
      return this.status()
    },

    status() {
      return {
        cpu: {
          running: workers.length > 0,
          threads: workers.length,
          maxThreads: Math.max(1, os.cpus().length),
          elapsedMs: cpuStartedAt ? Date.now() - cpuStartedAt : 0
        },
        memory: {
          running: hogs.length > 0,
          allocatedBytes,
          // 現在最多吃得下幾 GB。滑桿要靠它把預設值放在「真的滿載」的位置——
          // 寫死一個 4GB 的話，按下開始只是在 64GB 的機器上配了個零頭
          maxGb: Math.max(1, Math.floor(os.freemem() * MEMORY_HEADROOM / (1024 ** 3))),
          totalGb: Math.max(1, Math.round(os.totalmem() / (1024 ** 3))),
          elapsedMs: memStartedAt ? Date.now() - memStartedAt : 0
        },
        maxMs: MAX_MS
      }
    },

    shutdown() {
      stopCpu()
      stopMemory()
    }
  }
}

module.exports = { createStressRunner, MAX_MS, CHUNK_BYTES, MEMORY_HEADROOM }
