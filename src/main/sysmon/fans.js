'use strict'

/**
 * VoiceInk — 風扇控制引擎。
 *
 * 資料流：感測器 sidecar 每秒送一框（含溫度／使用率與可寫的 PWM 通道）→ 這裡依每條通道的
 * 設定算出目標 PWM → 用一行指令送回 sidecar。renderer 只送 identifier 與數字，
 * 設定的驗證與落盤都在這一層（`fanControl` 刻意不進 `STORE_ALLOWLIST`）。
 *
 * 三個「硬體必要」的校正旋鈕，少了會讓風扇來回震盪：
 *   1. 取樣平滑（3 次移動平均）——單一框的溫度會跳個兩三度
 *   2. 遲滯（HYSTERESIS）——來源值變動小於此就沿用上次的目標
 *   3. 斜率上限（MAX_STEP）——每秒最多變這麼多 %，避免忽大忽小的嘯叫
 *
 * 安全（因為手動 PWM 是**留在晶片裡**的，實測硬殺程序後不會自動還原，
 * 而且事後用另一支程序 `SetDefault` 也救不回來——只有重開機才會回到 BIOS 曲線）：
 *   - 每條通道有下限 `minPwm`（≥ MIN_FLOOR）：真的卡住也只是比較吵，不會過熱
 *   - 來源溫度 ≥ `panicTemp` 直接 100%，不套曲線也不套斜率
 *   - 讀不到來源值就**交還 BIOS**，不是沿用上一個值（感測器掛了還照著舊溫度吹是危險的）
 *   - `dirty` 旗標：第一次寫入前設 true、完整交還後設 false。啟動時仍是 true ⇒ 上次沒正常收尾
 *   - sidecar 自己還有 5 秒看門狗（見 native/sysmon-sensors/Program.cs）
 */

const TICK_MS = 1000
/** 每秒最多變動幾 %；再快就會聽得出來忽大忽小 */
const MAX_STEP = 5
/** 來源值變動小於這個就不重算（溫度單位是 °C、使用率是 %，共用同一個門檻） */
const HYSTERESIS = 2
/** 移動平均的取樣數 */
const SMOOTH_N = 3
/** 下限的下限：使用者可以調低，但不准低於這裡 */
const MIN_FLOOR = 20
const DEFAULT_MIN_PWM = 30
const DEFAULT_PANIC_TEMP = 90
const IDENTIFY_MS = 4000
const IDENTIFY_PWM = 100
const MAX_POINTS = 10
const MAX_LABEL = 24

const MODES = new Set(['bios', 'fixed', 'curve'])

/**
 * 示意圖上的槽位。**刻意是通用的**：晶片只給得出接頭名稱，給不出實體位置，
 * 畫死某一張主機板等於只有那台能用。使用者自己把偵測到的通道指派上來。
 */
const SLOTS = Object.freeze([
  { id: 'cpu', label: 'CPU 散熱器' },
  { id: 'cpu-opt', label: 'CPU 第二顆' },
  { id: 'pump', label: '水冷泵' },
  { id: 'pch', label: '晶片組' },
  { id: 'gpu', label: '顯示卡' },
  { id: 'front-1', label: '前方進風 1' },
  { id: 'front-2', label: '前方進風 2' },
  { id: 'front-3', label: '前方進風 3' },
  { id: 'rear', label: '後方排風' },
  { id: 'top-1', label: '上方排風 1' },
  { id: 'top-2', label: '上方排風 2' },
  { id: 'bottom', label: '底部進風' },
  { id: 'side', label: '側板' }
])
const SLOT_IDS = new Set(SLOTS.map((s) => s.id))

/**
 * 曲線的 X 軸來源。溫度與使用率**都是 0~100 的區間**，所以同一個圖形元件通吃，
 * 只換單位標籤。`hw` 比對硬體型別、`kind` 比對感測器型別、`prefer` 是優先挑的名稱。
 */
const SOURCES = Object.freeze([
  { id: 'cpu-temp', label: 'CPU 溫度', unit: '°C', hw: /^Cpu$/, kind: 'Temperature', prefer: /Tctl|Package|Core Average/i, temp: true },
  { id: 'cpu-load', label: 'CPU 使用率', unit: '%', hw: /^Cpu$/, kind: 'Load', prefer: /CPU Total/i, temp: false },
  { id: 'gpu-temp', label: 'GPU 溫度', unit: '°C', hw: /^Gpu/, kind: 'Temperature', prefer: /GPU Core|Hot ?Spot/i, temp: true },
  { id: 'gpu-load', label: 'GPU 使用率', unit: '%', hw: /^Gpu/, kind: 'Load', prefer: /GPU Core/i, temp: false },
  { id: 'nvme-temp', label: '硬碟溫度', unit: '°C', hw: /^Storage$/, kind: 'Temperature', prefer: /Temperature/i, temp: true },
  { id: 'board-temp', label: '主機板溫度', unit: '°C', hw: /^(Motherboard|SuperIO)$/, kind: 'Temperature', prefer: /System|Motherboard/i, temp: true }
])
const SOURCE_BY_ID = new Map(SOURCES.map((s) => [s.id, s]))

const DEFAULT_POINTS = Object.freeze([[30, 30], [50, 40], [70, 70], [85, 100]])

/**
 * 機殼風扇的預設槽位。接頭編號跟實體位置**沒有**必然關係，這只是為了讓示意圖
 * 一開始就有東西可看、可點——空的示意圖等於在請使用者憑空想像。使用者按「識別」
 * 認出是哪一顆之後再自己改，改過的值會蓋掉這裡（`sanitizeChannel` 的 `hasSlot`）。
 */
const CHASSIS_ORDER = Object.freeze(['front-1', 'front-2', 'front-3', 'rear', 'top-1', 'top-2', 'bottom', 'side'])

/** 依接頭名稱猜一個槽位與來源；猜不到就留空讓使用者自己指派 */
function guessChannel(name) {
  const text = String(name || '')
  if (/GPU/i.test(text)) return { slot: 'gpu', source: 'gpu-temp' }
  if (/Pump/i.test(text)) return { slot: 'pump', source: 'cpu-temp' }
  if (/CPU Opt/i.test(text)) return { slot: 'cpu-opt', source: 'cpu-temp' }
  if (/CPU/i.test(text)) return { slot: 'cpu', source: 'cpu-temp' }
  if (/PCH|Chipset/i.test(text)) return { slot: 'pch', source: 'board-temp' }
  const chassis = /(?:System|Chassis|Case)\s*Fan\s*#?\s*(\d+)/i.exec(text)
  if (chassis) {
    return { slot: CHASSIS_ORDER[(Number(chassis[1]) - 1) % CHASSIS_ORDER.length], source: 'cpu-temp' }
  }
  return { slot: '', source: 'cpu-temp' }
}

/** @param {number} value @param {number} lo @param {number} hi */
function clamp(value, lo, hi) {
  return value < lo ? lo : (value > hi ? hi : value)
}

/**
 * 折線內插。points 已由 sanitize 保證是遞增的 [[x, y], …]；
 * 兩端之外一律夾住（不外插——外插會在低溫時算出負的轉速）。
 * @param {Array<[number, number]>} points
 * @param {number} x
 * @returns {number}
 */
function interpolate(points, x) {
  if (!points.length) return 0
  if (x <= points[0][0]) return points[0][1]
  const last = points[points.length - 1]
  if (x >= last[0]) return last[1]
  for (let i = 1; i < points.length; i += 1) {
    const [x0, y0] = points[i - 1]
    const [x1, y1] = points[i]
    if (x > x1) continue
    const span = x1 - x0
    // sanitize 保證 x 嚴格遞增，但除以 0 的代價太高，還是擋一下
    if (span <= 0) return y1
    return y0 + ((y1 - y0) * (x - x0)) / span
  }
  return last[1]
}

/**
 * 斜率上限＋下限夾值。`prev` 為 null（第一次）時直接到位，
 * 不然剛接管的頭幾秒會從下限慢慢爬，看起來像沒反應。
 * @param {number|null} prev @param {number} target @param {number} minPwm
 */
function nextPwm(prev, target, minPwm) {
  const wanted = clamp(target, minPwm, 100)
  if (prev === null || !Number.isFinite(prev)) return wanted
  const delta = clamp(wanted - prev, -MAX_STEP, MAX_STEP)
  return clamp(prev + delta, minPwm, 100)
}

/**
 * 3 次移動平均。
 * @returns {{ history: number[], value: number }}
 */
function smooth(history, value) {
  const next = (Array.isArray(history) ? history : []).concat(value).slice(-SMOOTH_N)
  return { history: next, value: next.reduce((a, b) => a + b, 0) / next.length }
}

/**
 * 從 sidecar 的 groups 讀出某個來源的值。
 * @param {Array<any>} groups @param {string} sourceId
 * @returns {number|null} 讀不到回 null（不是 0——0 度／0% 是完全不同的意思）
 */
function readSource(groups, sourceId) {
  const spec = SOURCE_BY_ID.get(sourceId)
  if (!spec || !Array.isArray(groups)) return null
  let preferred = null
  let fallback = null
  for (const group of groups) {
    if (!spec.hw.test(String(group?.t || ''))) continue
    for (const sensor of group?.s || []) {
      if (String(sensor?.t) !== spec.kind) continue
      const value = Number(sensor?.v)
      if (!Number.isFinite(value)) continue
      if (preferred === null && spec.prefer.test(String(sensor?.n || ''))) preferred = value
      if (fallback === null || value > fallback) fallback = value
    }
  }
  // 挑不到指名的那顆就用同型別裡最高的（保守：寧可吹快一點）
  return preferred !== null ? preferred : fallback
}

/** 曲線點：排序、去掉重複的 x、夾進 0~100、限制點數 */
function sanitizePoints(raw) {
  const list = Array.isArray(raw) ? raw : []
  const cleaned = []
  for (const point of list) {
    const x = Number(Array.isArray(point) ? point[0] : NaN)
    const y = Number(Array.isArray(point) ? point[1] : NaN)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    cleaned.push([clamp(Math.round(x), 0, 100), clamp(Math.round(y), 0, 100)])
  }
  cleaned.sort((a, b) => a[0] - b[0])
  const unique = cleaned.filter((point, i) => i === 0 || point[0] !== cleaned[i - 1][0])
  if (unique.length < 2) return DEFAULT_POINTS.map((p) => [p[0], p[1]])
  return unique.slice(0, MAX_POINTS)
}

/**
 * 單一通道設定的驗證。**這是信任邊界**：renderer 給的東西一律當成敵意輸入。
 * 認不得的值退回猜測或預設，而不是丟掉整筆（比照 chatProviders 那條教訓）。
 */
function sanitizeChannel(raw, name) {
  const guess = guessChannel(name)
  const hasSlot = typeof raw?.slot === 'string'
  return {
    slot: SLOT_IDS.has(String(raw?.slot)) ? String(raw.slot) : (hasSlot ? '' : guess.slot),
    // 控制字元會讓 UI 的單行標籤破版；長度上限避免有人塞一整篇進 config.json
    label: String(raw?.label || '').replace(/[\u0000-\u001f]/g, '').slice(0, MAX_LABEL),
    mode: MODES.has(String(raw?.mode)) ? String(raw.mode) : 'bios',
    fixed: clamp(Math.round(Number(raw?.fixed) || DEFAULT_MIN_PWM), 0, 100),
    source: SOURCE_BY_ID.has(String(raw?.source)) ? String(raw.source) : guess.source,
    points: sanitizePoints(raw?.points),
    minPwm: clamp(Math.round(Number(raw?.minPwm) || DEFAULT_MIN_PWM), MIN_FLOOR, 100)
  }
}

/**
 * 整份設定的驗證。
 * @param {any} raw @param {Map<string, string>} names identifier → 接頭名稱（拿來猜預設值）
 */
function sanitizeConfig(raw, names = new Map()) {
  const channels = {}
  const source = raw && typeof raw.channels === 'object' && raw.channels ? raw.channels : {}
  for (const [id, value] of Object.entries(source)) {
    if (typeof id !== 'string' || !id) continue
    channels[id] = sanitizeChannel(value, names.get(id) || '')
  }
  return {
    enabled: raw?.enabled === true,
    dirty: raw?.dirty === true,
    panicTemp: clamp(Math.round(Number(raw?.panicTemp) || DEFAULT_PANIC_TEMP), 60, 105),
    channels
  }
}

/**
 * 引擎本體。`sensors` 是 `sensors.js` 的橋接（要有 `read()` 與 `send()`）。
 * @param {{ sensors: any, store?: any }} deps
 */
function createFanEngine(deps = {}) {
  const sensors = deps.sensors
  let store = deps.store || null
  /** @type {NodeJS.Timeout | null} */
  let timer = null
  let config = sanitizeConfig(null)
  /** 上一次啟動有沒有正常收尾（false ⇒ 風扇可能還釘在上次的轉速，只有重開機能救） */
  let crashedLastRun = false
  let loaded = false
  /** @type {Map<string, { history: number[], lastX: number|null, target: number|null, applied: number|null, identifyUntil: number, panic: boolean }>} */
  const runtime = new Map()

  function blank() {
    return { history: [], lastX: null, target: null, applied: null, identifyUntil: 0, panic: false }
  }

  function stateOf(id) {
    if (!runtime.has(id)) runtime.set(id, blank())
    return runtime.get(id)
  }

  function persist() {
    if (!store) return
    try { store.set('fanControl', config) } catch { /* 存不進去不該讓風扇停止運作 */ }
  }

  /** 第一次真的寫入晶片之前先記一筆：下次啟動看到它還是 true 就知道上次沒收乾淨 */
  function markDirty() {
    if (config.dirty) return
    config.dirty = true
    persist()
  }

  function load() {
    if (loaded || !store) return
    loaded = true
    let raw = null
    try { raw = store.get('fanControl') } catch { raw = null }
    config = sanitizeConfig(raw, nameMap())
    crashedLastRun = config.dirty
  }

  /** identifier → 接頭名稱（sanitize 拿來猜槽位／來源） */
  function nameMap() {
    const map = new Map()
    for (const control of liveControls()) map.set(control.id, control.n)
    return map
  }

  function liveControls() {
    const data = sensors?.read?.() || {}
    return Array.isArray(data.controls) ? data.controls : []
  }

  /** 這條通道還沒有設定就依名稱猜一份（不落盤——使用者沒改過就不該長出一堆設定） */
  function configOf(id, name) {
    if (!config.channels[id]) config.channels[id] = sanitizeChannel(null, name)
    return config.channels[id]
  }

  /**
   * 算出這條通道這一輪要送的 PWM。
   * @returns {number|null} null＝交還 BIOS
   */
  function computeTarget(channel, state, groups, now) {
    if (state.identifyUntil > now) return IDENTIFY_PWM
    if (channel.mode === 'bios') return null
    if (channel.mode === 'fixed') return clamp(channel.fixed, channel.minPwm, 100)

    const raw = readSource(groups, channel.source)
    // 讀不到來源就交還 BIOS：照著舊溫度繼續吹是危險的，BIOS 至少看得到真的溫度
    if (raw === null) return null
    const smoothed = smooth(state.history, raw)
    state.history = smoothed.history
    const spec = SOURCE_BY_ID.get(channel.source)
    // 緊急判定用**未平滑的原始值**：平滑會把反應延後最多 SMOOTH_N 秒，
    // 而這條是安全網，慢三秒才全速就失去意義了
    state.panic = Boolean(spec?.temp) && raw >= config.panicTemp
    if (state.panic) return 100

    // 遲滯：來源值沒動多少就沿用上次算好的目標，不然溫度在門檻附近抖動會讓轉速跟著抖
    if (state.lastX !== null && Math.abs(smoothed.value - state.lastX) < HYSTERESIS && state.target !== null) {
      return state.target
    }
    state.lastX = smoothed.value
    return interpolate(channel.points, smoothed.value)
  }

  function tick() {
    const data = sensors?.read?.() || {}
    if (!data.available) return
    // 心跳：sidecar 的看門狗靠它判斷主程式還在
    sensors.send('P')

    const groups = Array.isArray(data.groups) ? data.groups : []
    const now = Date.now()
    for (const control of (Array.isArray(data.controls) ? data.controls : [])) {
      const channel = configOf(control.id, control.n)
      const state = stateOf(control.id)
      const target = computeTarget(channel, state, groups, now)

      if (target === null) {
        state.target = null
        state.lastX = null
        if (state.applied !== null) {
          sensors.send(`D ${control.id}`)
          state.applied = null
        }
        continue
      }
      state.target = target
      // 緊急時不套斜率上限：要的就是立刻全速
      const value = state.panic ? 100 : Math.round(nextPwm(state.applied, target, channel.minPwm))
      if (state.applied !== null && value === state.applied) continue
      markDirty()
      if (sensors.send(`S ${control.id} ${value}`)) state.applied = value
    }
  }

  function startTimer() {
    if (timer) return
    timer = setInterval(() => {
      try { tick() } catch { /* 單輪失敗不該讓整條迴圈停掉 */ }
    }, TICK_MS)
    if (typeof timer.unref === 'function') timer.unref()
  }

  function stopTimer() {
    if (!timer) return
    clearInterval(timer)
    timer = null
  }

  /** 把所有通道交還 BIOS，並把 dirty 清掉 */
  function releaseAll() {
    for (const [id, state] of runtime) {
      if (state.applied !== null) sensors.send(`D ${id}`)
      runtime.set(id, blank())
    }
    if (config.dirty) {
      config.dirty = false
      persist()
    }
  }

  return {
    /** @param {{ store?: any }} options */
    configure(options = {}) {
      if (options.store) store = options.store
      load()
    },

    isEnabled() {
      load()
      return config.enabled
    },

    /** 上次沒正常收尾（風扇可能還釘著；`SetDefault` 救不回來，只有重開機） */
    crashedLastRun: () => crashedLastRun,

    /**
     * UI 要的一整包：即時讀數 ＋ 設定 ＋ 槽位／來源表。
     * 沒有可控通道時 channels 是空陣列，UI 要據此說明原因而不是留白。
     */
    list() {
      load()
      const data = sensors?.read?.() || {}
      const groups = Array.isArray(data.groups) ? data.groups : []
      const now = Date.now()
      const channels = (Array.isArray(data.controls) ? data.controls : []).map((control) => {
        const channel = configOf(control.id, control.n)
        const state = stateOf(control.id)
        return {
          id: control.id,
          name: control.n,
          hardware: control.hw,
          rpm: control.rpm,
          pwm: control.pwm,
          overridden: control.o === true,
          hwMin: Number.isFinite(control.min) ? control.min : 0,
          hwMax: Number.isFinite(control.max) ? control.max : 100,
          ...channel,
          sourceValue: readSource(groups, channel.source),
          applied: state.applied,
          panic: state.panic,
          identifying: state.identifyUntil > now
        }
      })
      return {
        enabled: config.enabled,
        running: Boolean(timer),
        available: data.available === true,
        crashedLastRun,
        panicTemp: config.panicTemp,
        minFloor: MIN_FLOOR,
        slots: SLOTS,
        sources: SOURCES.map((s) => ({ id: s.id, label: s.label, unit: s.unit })),
        channels
      }
    },

    /** @param {unknown} on */
    async setEnabled(on) {
      load()
      config.enabled = on === true
      persist()
      if (config.enabled) {
        startTimer()
        tick()
      } else {
        stopTimer()
        releaseAll()
      }
      return this.list()
    },

    /**
     * 改一條通道的設定。id 必須是**目前真的存在**的通道——不驗的話 config.json 會被
     * 塞進一堆對不到硬體的設定，而且等於讓 renderer 決定我們要寫哪個暫存器。
     * @param {unknown} id @param {any} patch
     */
    setChannel(id, patch) {
      load()
      const key = String(id || '')
      const control = liveControls().find((c) => c.id === key)
      if (!control) {
        const err = new Error('unknown channel')
        err.code = 'SYSMON_FAN_UNKNOWN'
        err.userMessage = '找不到這條風扇通道（可能是感測器重新啟動過）。'
        throw err
      }
      const before = configOf(key, control.n)
      config.channels[key] = sanitizeChannel({ ...before, ...(patch || {}) }, control.n)
      persist()
      // 換模式／換來源之後上一輪的平滑與遲滯就沒有意義了
      const state = stateOf(key)
      state.history = []
      state.lastX = null
      state.target = null
      if (config.enabled) tick()
      return this.list()
    },

    /**
     * 「識別」：把這條通道拉到全速幾秒再放掉——使用者用**聽的**就知道是哪一顆。
     * 沒有這顆按鈕，示意圖只是在請使用者猜（接頭名稱給不出實體位置）。
     */
    identify(id) {
      load()
      const key = String(id || '')
      if (!liveControls().some((c) => c.id === key)) {
        const err = new Error('unknown channel')
        err.code = 'SYSMON_FAN_UNKNOWN'
        err.userMessage = '找不到這條風扇通道。'
        throw err
      }
      const state = stateOf(key)
      state.identifyUntil = Date.now() + IDENTIFY_MS
      markDirty()
      if (sensors.send(`S ${key} ${IDENTIFY_PWM}`)) state.applied = IDENTIFY_PWM
      setTimeout(() => {
        const later = stateOf(key)
        later.identifyUntil = 0
        // 引擎在跑的話下一個 tick 會把它帶回曲線值；沒在跑就自己交還
        if (!timer && later.applied !== null) {
          sensors.send(`D ${key}`)
          later.applied = null
          if (config.dirty) { config.dirty = false; persist() }
        }
      }, IDENTIFY_MS)
      return { identifying: true, ms: IDENTIFY_MS }
    },

    /** 全部交還 BIOS，但不改 `enabled`（使用者只是想先放手看看） */
    resetAll() {
      load()
      releaseAll()
      return this.list()
    },

    /** 關 App／收掉感測器之前一定要走這條，否則風扇會釘在最後的轉速 */
    shutdown() {
      stopTimer()
      releaseAll()
    }
  }
}

module.exports = {
  TICK_MS,
  MAX_STEP,
  HYSTERESIS,
  SMOOTH_N,
  MIN_FLOOR,
  DEFAULT_PANIC_TEMP,
  IDENTIFY_MS,
  IDENTIFY_PWM,
  SLOTS,
  SOURCES,
  DEFAULT_POINTS,
  clamp,
  interpolate,
  nextPwm,
  smooth,
  readSource,
  sanitizePoints,
  sanitizeChannel,
  sanitizeConfig,
  guessChannel,
  createFanEngine
}
