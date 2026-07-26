/**
 * VoiceInk - 本地 LLM GPU 能力偵測（Main Process）
 * 門檻：NVIDIA 顯示卡且 VRAM ≥ 6GB 才允許開啟 GPU 推論。
 * 另回報 CUDA Runtime / Vulkan 狀態（供設定頁與自動安裝）。
 */

const { execFile } = require('child_process')
const { promisify } = require('util')
const { detectCudaRuntime, detectVulkan } = require('./cuda-env')

const execFileAsync = promisify(execFile)

/** 最低 VRAM（MiB） */
const MIN_VRAM_MIB = 6144

/**
 * @typedef {object} GpuCapability
 * @property {boolean} ok  是否允許開 GPU（NVIDIA + VRAM）
 * @property {string} name
 * @property {number} vramMiB
 * @property {string} reason
 * @property {boolean} hasNvidiaDriver
 * @property {boolean} hasCudaRuntime
 * @property {boolean} hasVulkan
 * @property {boolean} canInstallCuda  可嘗試自動安裝 CUDA
 * @property {string[]} backends  預期可用後端（cuda / vulkan）
 * @property {object} [cudaDetails]
 */

/** @type {GpuCapability | null} */
let cached = null
let cacheAt = 0
const CACHE_MS = 30_000

/**
 * 解析 nvidia-smi CSV 輸出，取最大 VRAM 那張卡
 * @param {string} stdout
 * @returns {{ name: string, vramMiB: number } | null}
 */
function parseNvidiaSmi(stdout) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  let best = null
  for (const line of lines) {
    const parts = line.split(',').map((p) => p.trim())
    if (parts.length < 2) continue
    const memStr = parts[parts.length - 1]
    const name = parts.slice(0, -1).join(', ').trim() || 'NVIDIA GPU'
    const vramMiB = Number(memStr)
    if (!Number.isFinite(vramMiB) || vramMiB <= 0) continue
    if (!best || vramMiB > best.vramMiB) best = { name, vramMiB }
  }
  return best
}

/**
 * @returns {Promise<GpuCapability>}
 */
async function detectGpuCapability() {
  const now = Date.now()
  if (cached && now - cacheAt < CACHE_MS) return cached

  const cuda = detectCudaRuntime()
  const hasVulkan = detectVulkan()

  /** @type {GpuCapability} */
  let result = {
    ok: false,
    name: '',
    vramMiB: 0,
    reason: '',
    hasNvidiaDriver: cuda.hasNvidiaDriver,
    hasCudaRuntime: cuda.hasCudaRuntime,
    hasVulkan,
    canInstallCuda: false,
    backends: [],
    cudaDetails: cuda.details
  }

  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 5000, windowsHide: true }
    )
    const gpu = parseNvidiaSmi(stdout)
    if (!gpu) {
      result.reason = '未偵測到 NVIDIA 顯示卡'
      result.hasNvidiaDriver = result.hasNvidiaDriver || false
    } else if (gpu.vramMiB < MIN_VRAM_MIB) {
      result.name = gpu.name
      result.vramMiB = gpu.vramMiB
      result.hasNvidiaDriver = true
      result.reason = `VRAM ${gpu.vramMiB} MiB 不足（需 ≥ ${MIN_VRAM_MIB} MiB / 6GB）`
    } else {
      result.ok = true
      result.name = gpu.name
      result.vramMiB = gpu.vramMiB
      result.hasNvidiaDriver = true
      result.reason = ''
    }
  } catch {
    if (cuda.hasNvidiaDriver) {
      result.reason = '找到 NVIDIA 驅動，但 nvidia-smi 不可用'
    } else {
      result.reason = '未安裝 NVIDIA 驅動或找不到 nvidia-smi'
    }
  }

  // 後端列表：有 Runtime 才標 cuda；Vulkan 獨立
  if (result.ok) {
    if (cuda.hasCudaRuntime) result.backends.push('cuda')
    if (hasVulkan) result.backends.push('vulkan')
    if (result.backends.length === 0) {
      // 仍允許開 GPU（local-llm 會再試並 fallback CPU）
      result.backends.push('cpu-fallback')
    }
  }

  // 有 NVIDIA + 夠 VRAM、但缺 CUDA Runtime → 可自動安裝
  result.canInstallCuda =
    process.platform === 'win32' &&
    result.hasNvidiaDriver &&
    result.vramMiB >= MIN_VRAM_MIB &&
    !cuda.hasCudaRuntime

  if (result.ok && !cuda.hasCudaRuntime && hasVulkan) {
    // 不擋 GPU；提示可用 Vulkan
    result.reason = result.reason || ''
  }

  cached = result
  cacheAt = now
  return result
}

/** 清除快取 */
function clearGpuCapabilityCache() {
  cached = null
  cacheAt = 0
}

module.exports = {
  MIN_VRAM_MIB,
  detectGpuCapability,
  parseNvidiaSmi,
  clearGpuCapabilityCache
}
