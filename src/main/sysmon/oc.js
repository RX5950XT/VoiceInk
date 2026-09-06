'use strict'

/**
 * VoiceInk — CPU／GPU 效能調整。
 *
 * 跟風扇控制同一顆 sidecar、同一條提權邊界，但寫入路徑完全不同（不能沿用 S／D／R）：
 *   G <coreMHz> <memMHz> <powerPct> [voltMv] [tempC]  NVIDIA 時脈／功耗／電壓／溫度牆
 *   C <pptW> <tdcA> <edcA> <scalar×100> [co] [freq] [tctl] [voltMv]  Ryzen PBO／鎖頻／電壓
 *   K <n> <m0…>                       Curve Optimizer 每核
 *   X                                 還原本次套用
 *
 * 安全方向跟風扇相反：卡住要還原出廠，不是拉高。套用是按鈕，不每秒灌 SMU／NVAPI。
 * 設定記滑桿數字，開機不自動套用（軟體時脈重開就回預設，開機再套等於主動超頻）。
 * `ocControl` 刻意不進 STORE_ALLOWLIST。
 */

const TICK_MS = 1000
const DEFAULT_PANIC_TEMP = 95
const CORE_MIN = -200
const CORE_MAX = 200
const MEM_MIN = -500
const MEM_MAX = 1000
const POWER_MIN = 50
const POWER_MAX = 120
const SCALAR_MIN = 100
const SCALAR_MAX = 200
const PPT_MIN = 15
const PPT_MAX = 400
const CURRENT_MIN = 10
const CURRENT_MAX = 500
const VOLT_MIN = -100
const VOLT_MAX = 100
const CPU_VOLT_MIN = 800
const CPU_VOLT_MAX = 1400
const SOC_MIN = 900
const SOC_MAX = 1200
const VF_MAX_POINTS = 96
const GPU_TEMP_MIN = 65
const GPU_TEMP_MAX = 95
const CO_MIN = -30
const CO_MAX = 30
const FREQ_MIN = 3500
const FREQ_MAX = 5000
const TCTL_MIN = 70
const TCTL_MAX = 95

/**
 * @param {number} value
 * @param {number} lo
 * @param {number} hi
 */
function clamp(value, lo, hi) {
  const n = Number(value)
  if (!Number.isFinite(n)) return lo
  const rounded = Math.round(n)
  if (rounded < lo) return lo
  if (rounded > hi) return hi
  return rounded
}

/**
 * 工廠值的 50%～150% 夾值；沒有工廠值就退回絕對上下限。
 * @param {number} value
 * @param {number} factory
 * @param {number} absMin
 * @param {number} absMax
 */
function clampAround(value, factory, absMin, absMax) {
  if (!Number.isFinite(factory) || factory <= 0) return clamp(value, absMin, absMax)
  const lo = Math.max(absMin, Math.round(factory * 0.5))
  const hi = Math.min(absMax, Math.round(factory * 1.5))
  return clamp(value, lo, hi)
}

/**
 * @param {any} raw
 */
function sanitizeGpu(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  return {
    coreMHz: clamp(src.coreMHz == null ? 0 : src.coreMHz, CORE_MIN, CORE_MAX),
    memMHz: clamp(src.memMHz == null ? 0 : src.memMHz, MEM_MIN, MEM_MAX),
    powerPct: clamp(src.powerPct == null ? 100 : src.powerPct, POWER_MIN, POWER_MAX),
    voltMv: clamp(src.voltMv == null ? 0 : src.voltMv, VOLT_MIN, VOLT_MAX),
    tempC: clamp(src.tempC == null ? 90 : src.tempC, GPU_TEMP_MIN, GPU_TEMP_MAX),
    vfDeltas: sanitizeVf(src.vfDeltas)
  }
}

/**
 * 沒填就用工廠值；工廠值也沒有就 0，UI 會改顯示說明而不是假裝有牆。
 * @param {unknown} value
 * @param {number} factory
 * @param {number} absMin
 * @param {number} absMax
 */
function withFactory(value, factory, absMin, absMax) {
  if (value == null || !Number.isFinite(Number(value))) {
    return Number.isFinite(factory) && factory > 0 ? clampAround(factory, factory, absMin, absMax) : 0
  }
  return clampAround(value, factory, absMin, absMax)
}

/**
 * 0＝自動（不鎖 VID）；其餘夾在 0.80～1.40 V。
 * @param {unknown} value
 */
function sanitizeCpuVolt(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < CPU_VOLT_MIN) return 0
  return clamp(n, CPU_VOLT_MIN, CPU_VOLT_MAX)
}

/**
 * @param {any} raw
 * @param {number} count
 */
function sanitizeCores(raw, count) {
  const n = clamp(count || 8, 1, 16)
  const src = Array.isArray(raw) ? raw : []
  const out = []
  for (let i = 0; i < n; i += 1) out.push(clamp(src[i] == null ? 0 : src[i], CO_MIN, CO_MAX))
  return out
}

/**
 * 0＝跟全核／PBO；其餘夾在全核鎖頻範圍。
 * @param {any} raw
 * @param {number} count
 */
function sanitizeFreqCores(raw, count) {
  const n = clamp(count || 8, 1, 16)
  const src = Array.isArray(raw) ? raw : []
  const out = []
  for (let i = 0; i < n; i += 1) {
    const value = Number(src[i])
    out.push(!Number.isFinite(value) || value <= 0 ? 0 : clamp(value, FREQ_MIN, FREQ_MAX))
  }
  return out
}

/** @param {unknown} value */
function sanitizeSoc(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < SOC_MIN) return 0
  return clamp(n, SOC_MIN, SOC_MAX)
}

/** @param {any} raw */
function sanitizeVf(raw) {
  const src = Array.isArray(raw) ? raw : []
  const n = Math.min(src.length, VF_MAX_POINTS)
  const out = []
  for (let i = 0; i < n; i += 1) out.push(clamp(src[i] == null ? 0 : src[i], CORE_MIN, CORE_MAX))
  return out
}

function sanitizeCpu(raw, factory = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const freqRaw = Number(src.freqMhz)
  return {
    pptW: withFactory(src.pptW, factory.pptW, PPT_MIN, PPT_MAX),
    tdcA: withFactory(src.tdcA, factory.tdcA, CURRENT_MIN, CURRENT_MAX),
    edcA: withFactory(src.edcA, factory.edcA, CURRENT_MIN, CURRENT_MAX),
    scalarX100: clamp(src.scalarX100 == null ? 100 : src.scalarX100, SCALAR_MIN, SCALAR_MAX),
    coAll: clamp(src.coAll == null ? 0 : src.coAll, CO_MIN, CO_MAX),
    freqMhz: !Number.isFinite(freqRaw) || freqRaw <= 0 ? 0 : clamp(freqRaw, FREQ_MIN, FREQ_MAX),
    tctlC: clamp(src.tctlC == null ? 90 : src.tctlC, TCTL_MIN, TCTL_MAX),
    voltMv: sanitizeCpuVolt(src.voltMv),
    socMv: sanitizeSoc(src.socMv),
    cores: sanitizeCores(src.cores, factory.coreCount || src.coreCount || 8),
    freqCores: sanitizeFreqCores(src.freqCores, factory.coreCount || src.coreCount || 8)
  }
}

/**
 * 套用期間溫度過高或兩邊都讀不到 → 還原。用未平滑的原始值。
 * @param {number|null} cpuTemp
 * @param {number|null} gpuTemp
 * @param {number} limit
 */
function isPanic(cpuTemp, gpuTemp, limit) {
  if (cpuTemp === null && gpuTemp === null) return true
  if (cpuTemp !== null && cpuTemp >= limit) return true
  if (gpuTemp !== null && gpuTemp >= limit) return true
  return false
}

/**
 * @param {any} raw
 * @param {{ pptW?: number, tdcA?: number, edcA?: number }} factory
 */
function sanitizeConfig(raw, factory = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  return {
    dirty: src.dirty === true,
    panicTemp: clamp(src.panicTemp == null ? DEFAULT_PANIC_TEMP : src.panicTemp, 70, 105),
    gpu: sanitizeGpu(src.gpu),
    cpu: sanitizeCpu(src.cpu, factory)
  }
}

/**
 * sidecar 每一框的 "o"。短鍵見 native Oc.AppendJson。
 * @param {any} raw
 */
function parseLive(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const cpu = src.c && typeof src.c === 'object' ? src.c : {}
  const gpu = src.g && typeof src.g === 'object' ? src.g : {}
  const num = (value) => {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return {
    cpu: {
      writable: cpu.w === 1 || cpu.w === true,
      name: String(cpu.n || ''),
      temp: num(cpu.t),
      clock: num(cpu.k),
      powerW: num(cpu.p),
      pptW: num(cpu.pl) || num(cpu.fp) || num(cpu.p),
      tdcA: num(cpu.d),
      edcA: num(cpu.e),
      load: num(cpu.u),
      volt: num(cpu.v),
      scalarX100: num(cpu.s),
      factoryPpt: num(cpu.fp),
      factoryTdc: num(cpu.fd),
      factoryEdc: num(cpu.fe),
      coAll: num(cpu.ca),
      freqMhz: num(cpu.fa),
      tctlC: num(cpu.tc),
      voltMv: num(cpu.cv),
      soc: num(cpu.so),
      socMv: num(cpu.sv),
      coreCount: num(cpu.cc),
      cores: Array.isArray(cpu.ck) ? cpu.ck.map((v) => num(v)).filter((v) => v != null) : [],
      applied: cpu.a === 1 || cpu.a === true,
      reason: String(cpu.r || '')
    },
    gpu: {
      writable: gpu.w === 1 || gpu.w === true,
      name: String(gpu.n || ''),
      temp: num(gpu.t),
      hotspot: num(gpu.h),
      clock: num(gpu.k),
      mem: num(gpu.m),
      load: num(gpu.u),
      powerW: num(gpu.pd),
      volt: num(gpu.vl),
      fan: num(gpu.f),
      vramUsed: num(gpu.vu),
      vramTotal: num(gpu.vt),
      coreMHz: num(gpu.co),
      memMHz: num(gpu.mo),
      powerPct: num(gpu.pw),
      voltMv: num(gpu.vo),
      tempC: num(gpu.gt),
      vf: Array.isArray(gpu.vf)
        ? gpu.vf.map((row) => {
          const item = Array.isArray(row) ? row : []
          return { i: num(item[0]), v: num(item[1]), f: num(item[2]), d: num(item[3]) }
        }).filter((p) => p.i != null)
        : [],
      applied: gpu.a === 1 || gpu.a === true,
      reason: String(gpu.r || '')
    }
  }
}

/**
 * @param {{ sensors: any, store?: any }} deps
 */
function createOcEngine(deps = {}) {
  const sensors = deps.sensors
  let store = deps.store || null
  /** @type {NodeJS.Timeout | null} */
  let timer = null
  let config = sanitizeConfig(null)
  let loaded = false
  let dirtyLastRun = false
  let panic = false
  let applied = false
  let lastError = ''

  function persist() {
    if (!store) return
    try { store.set('ocControl', config) } catch { /* 存不進去不該讓還原失敗 */ }
  }

  function factoryOf() {
    const live = parseLive(sensors?.read?.()?.oc)
    return {
      pptW: live.cpu.factoryPpt || live.cpu.pptW || 0,
      tdcA: live.cpu.factoryTdc || live.cpu.tdcA || 0,
      edcA: live.cpu.factoryEdc || live.cpu.edcA || 0,
      coreCount: live.cpu.coreCount || 8
    }
  }

  function load() {
    if (loaded || !store) return
    loaded = true
    let raw = null
    try { raw = store.get('ocControl') } catch { raw = null }
    config = sanitizeConfig(raw, factoryOf())
    dirtyLastRun = config.dirty === true
  }

  function markDirty() {
    if (config.dirty) return
    config.dirty = true
    persist()
  }

  function clearDirty() {
    if (!config.dirty) return
    config.dirty = false
    persist()
  }

  /**
   * 過熱或讀不到溫度就還原。用未平滑的原始值。
   * @param {ReturnType<typeof parseLive>} live
   */
  function shouldPanic(live) {
    return isPanic(live.cpu.temp, live.gpu.temp, config.panicTemp)
  }

  function tick() {
    if (!applied) return
    const live = parseLive(sensors?.read?.()?.oc)
    if (!shouldPanic(live)) {
      panic = false
      return
    }
    panic = true
    lastError = '過熱或讀不到溫度，已還原出廠'
    resetNow()
  }

  function startTimer() {
    if (timer) return
    timer = setInterval(() => {
      try { tick() } catch { /* 單輪失敗不該讓整條停掉 */ }
    }, TICK_MS)
    if (typeof timer.unref === 'function') timer.unref()
  }

  function stopTimer() {
    if (!timer) return
    clearInterval(timer)
    timer = null
  }

  function resetNow() {
    sensors?.send?.('X')
    applied = false
    stopTimer()
    clearDirty()
  }

  function snapshot() {
    load()
    const data = sensors?.read?.() || {}
    const live = parseLive(data.oc)
    const factory = factoryOf()
    config.cpu = sanitizeCpu(config.cpu, factory)
    return {
      available: data.available === true,
      applied,
      panic,
      dirtyLastRun,
      panicTemp: config.panicTemp,
      lastError,
      limits: {
        coreMin: CORE_MIN,
        coreMax: CORE_MAX,
        memMin: MEM_MIN,
        memMax: MEM_MAX,
        powerMin: POWER_MIN,
        powerMax: POWER_MAX,
        scalarMin: SCALAR_MIN,
        scalarMax: SCALAR_MAX,
        voltMin: VOLT_MIN,
        voltMax: VOLT_MAX,
        gpuTempMin: GPU_TEMP_MIN,
        gpuTempMax: GPU_TEMP_MAX,
        coMin: CO_MIN,
        coMax: CO_MAX,
        freqMin: FREQ_MIN,
        freqMax: FREQ_MAX,
        tctlMin: TCTL_MIN,
        tctlMax: TCTL_MAX,
        cpuVoltMin: CPU_VOLT_MIN,
        cpuVoltMax: CPU_VOLT_MAX,
        socMin: SOC_MIN,
        socMax: SOC_MAX
      },
      draft: { gpu: config.gpu, cpu: config.cpu },
      live
    }
  }

  return {
    /** @param {{ store?: any }} options */
    configure(options = {}) {
      if (options.store) store = options.store
      load()
    },

    status() {
      return snapshot()
    },

    /**
     * 只改滑桿草稿，不寫硬體。
     * @param {any} patch
     */
    setDraft(patch) {
      load()
      const src = patch && typeof patch === 'object' ? patch : {}
      const factory = factoryOf()
      if (src.gpu) config.gpu = sanitizeGpu({ ...config.gpu, ...src.gpu })
      if (src.cpu) config.cpu = sanitizeCpu({ ...config.cpu, ...src.cpu }, factory)
      if (src.panicTemp != null) config.panicTemp = clamp(src.panicTemp, 70, 105)
      persist()
      return snapshot()
    },

    apply() {
      load()
      lastError = ''
      panic = false
      const data = sensors?.read?.() || {}
      if (data.available !== true) {
        const err = new Error('sensors off')
        err.code = 'SYSMON_OC_OFF'
        err.userMessage = '請先啟用完整感測器，效能調整才寫得進去。'
        throw err
      }
      const live = parseLive(data.oc)
      const factory = factoryOf()
      config.cpu = sanitizeCpu(config.cpu, factory)
      config.gpu = sanitizeGpu(config.gpu)
      if (!live.cpu.writable && !live.gpu.writable) {
        const err = new Error('nothing writable')
        err.code = 'SYSMON_OC_UNSUPPORTED'
        err.userMessage = live.cpu.reason || live.gpu.reason || '這台機器的 CPU／顯示卡還沒接上效能調整。'
        throw err
      }
      markDirty()
      let sent = false
      if (live.gpu.writable) {
        const g = config.gpu
        sent = sensors.send(`G ${g.coreMHz} ${g.memMHz} ${g.powerPct} ${g.voltMv} ${g.tempC}`) || sent
        if (g.vfDeltas && g.vfDeltas.length) {
          sent = sensors.send(`V ${g.vfDeltas.length} ${g.vfDeltas.join(' ')}`) || sent
        }
      }
      if (live.cpu.writable) {
        const c = config.cpu
        sent = sensors.send(`C ${c.pptW} ${c.tdcA} ${c.edcA} ${c.scalarX100} ${c.coAll} ${c.freqMhz} ${c.tctlC} ${c.voltMv} ${c.socMv}`) || sent
        if (c.cores && c.cores.length) {
          sent = sensors.send(`K ${c.cores.length} ${c.cores.join(' ')}`) || sent
        }
        if (c.freqCores && c.freqCores.some((v) => v > 0)) {
          sent = sensors.send(`F ${c.freqCores.length} ${c.freqCores.join(' ')}`) || sent
        }
      }
      if (!sent) {
        clearDirty()
        const err = new Error('send failed')
        err.code = 'SYSMON_OC_SEND'
        err.userMessage = '指令沒送出去（感測器可能剛斷線）。'
        throw err
      }
      applied = true
      startTimer()
      return snapshot()
    },

    reset() {
      load()
      lastError = ''
      panic = false
      resetNow()
      return snapshot()
    },

    shutdown() {
      if (applied) resetNow()
      stopTimer()
    }
  }
}

module.exports = {
  CORE_MIN,
  CORE_MAX,
  MEM_MIN,
  MEM_MAX,
  POWER_MIN,
  POWER_MAX,
  SCALAR_MIN,
  SCALAR_MAX,
  VOLT_MIN,
  VOLT_MAX,
  CPU_VOLT_MIN,
  CPU_VOLT_MAX,
  SOC_MIN,
  SOC_MAX,
  CO_MIN,
  CO_MAX,
  DEFAULT_PANIC_TEMP,
  clamp,
  clampAround,
  sanitizeGpu,
  sanitizeCpu,
  sanitizeConfig,
  parseLive,
  isPanic,
  createOcEngine
}
