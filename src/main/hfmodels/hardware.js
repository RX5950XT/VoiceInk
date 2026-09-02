'use strict'

/**
 * 「這台機器能拿什麼跑」——問 llama.cpp 自己，不猜。
 *
 * `--list-devices` 是唯一說得準的來源：它列的是**這份 llama-server 建置真的載得起來的後端**。
 * nvidia-smi 看得到卡不代表這份 binary 有 CUDA 後端（我們出貨的是 Vulkan 版），
 * 拿 nvidia-smi 的顯存去規劃參數就會規劃到一個載不起來的組合。
 *
 * `llama-asr.js` 也有一份只挑第一個非 CPU 裝置的簡版；那支是 ASR sidecar 專用、已經在跑，
 * 這裡不去動它（改一支正在服役的東西換來的只有風險）。
 */

const { spawn } = require('child_process')

/** 例：`  Vulkan0: NVIDIA GeForce RTX 5060 Ti (16265 MiB, 15350 MiB free)` */
const DEVICE_RE = /^\s*((Vulkan|CUDA|ROCm|SYCL|Metal|BLAS|RPC)(\d+)):\s*(.+?)\s*(?:\((\d+)\s*MiB(?:,\s*(\d+)\s*MiB\s*free)?\))?\s*$/i
const LIST_TIMEOUT_MS = 10_000

/**
 * @param {string} text `--list-devices` 的 stdout
 * @returns {Array<{ id: string, backend: string, index: number, name: string,
 *                   totalMiB: number, freeMiB: number }>}
 */
function parseDevices(text) {
  /** @type {Array<{id: string, backend: string, index: number, name: string, totalMiB: number, freeMiB: number}>} */
  const devices = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = DEVICE_RE.exec(line)
    if (!match) continue
    const total = Number(match[5]) || 0
    const free = Number(match[6]) || 0
    devices.push({
      id: match[1],
      backend: match[2],
      index: Number(match[3]) || 0,
      name: match[4],
      totalMiB: total,
      // 沒報 free 的後端（例如 Metal）就當全部可用，不要當成 0 而規劃出「什麼都放不下」
      freeMiB: free || total
    })
  }
  return devices
}

/**
 * 挑一顆來跑：有顯存資訊的優先，其次比 free 大小。CPU 不在這份清單裡（它是退路，不是選項）。
 * @param {ReturnType<typeof parseDevices>} devices
 * @returns {{ id: string, name: string, totalMiB: number, freeMiB: number } | null}
 */
function pickDevice(devices) {
  const usable = (devices || []).filter((d) => d && d.id && !/^(BLAS|RPC)/i.test(d.backend))
  if (!usable.length) return null
  return usable.slice().sort((a, b) => b.freeMiB - a.freeMiB || a.index - b.index)[0]
}

/**
 * 跑一次 `--list-devices`。**不快取**：使用者可能中途插拔 eGPU，或是別的程式把顯存吃光了，
 * 而這支的成本只有一次進程啟動（實測 < 1 秒），沒有必要用「可能過期的數字」去規劃參數。
 *
 * @param {string} exe llama-server 執行檔路徑
 * @returns {Promise<ReturnType<typeof parseDevices>>}
 */
function listDevices(exe) {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }
    const child = spawn(exe, ['--list-devices'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已經結束了 */ }
      finish(parseDevices(out))
    }, LIST_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => { out += String(chunk) })
    child.on('error', () => finish([]))
    child.on('close', () => finish(parseDevices(out)))
  })
}

/** CUDA 13.x 要的最低 NVIDIA 驅動版本 */
const CUDA13_MIN_DRIVER = 580

/**
 * NVIDIA 驅動版本（決定「建不建議裝 CUDA 執行環境」）。
 *
 * 這裡刻意**不用**它來決定推論參數——那要看 `--list-devices`（我們出貨的 Vulkan 版
 * 就算 nvidia-smi 看得到卡，也沒有 CUDA 後端）。這一支只回答「裝 CUDA 版划不划算」。
 * @param {{ execFileFn?: Function }} [deps]
 * @returns {Promise<{ hasNvidia: boolean, driver: string, cudaReady: boolean }>}
 */
function nvidiaDriver(deps = {}) {
  const execFileFn = deps.execFileFn || require('child_process').execFile
  return new Promise((resolve) => {
    const none = { hasNvidia: false, driver: '', cudaReady: false }
    try {
      execFileFn(
        'nvidia-smi',
        ['--query-gpu=driver_version', '--format=csv,noheader'],
        { timeout: 5000, windowsHide: true },
        (/** @type {any} */ error, /** @type {string} */ stdout) => {
          if (error) { resolve(none); return }
          const driver = String(stdout || '').split(/\r?\n/)[0].trim()
          const major = Number(driver.split('.')[0]) || 0
          resolve({ hasNvidia: !!driver, driver, cudaReady: major >= CUDA13_MIN_DRIVER })
        }
      )
    } catch {
      resolve(none)
    }
  })
}

module.exports = { parseDevices, pickDevice, listDevices, nvidiaDriver, CUDA13_MIN_DRIVER }
