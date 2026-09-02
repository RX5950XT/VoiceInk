/**
 * VoiceInk — 系統監控頁。
 *
 * 效能是這一頁的驗收標準（原生工作管理員在 400+ 進程時很卡），所以：
 *  1. 只有停在這一頁且視窗看得見時才取樣（`refreshSysmonPage` / `cooldownSysmonPage`）
 *  2. 進程表**虛擬捲動**：400 列只掛 ~40 個 DOM 節點，捲動時重用同一批節點
 *  3. 每輪更新走 `textContent`，不重建 DOM、不 innerHTML
 *  4. CPU%／速率都由 main 算好，這裡只排序與畫
 * sparkline 用 canvas 而不是 DOM 條：120 個點 × 6 張卡若做成元素就是 720 個節點。
 */

import { electronAPI } from './app.js'
import { initCustomSelects, syncCustomSelects } from './custom-select.js'
import { showFanPanel, hideFanPanel } from './sysmon-fans.js'

const HISTORY = 120
const ROW_HEIGHT = 30
const OVERSCAN = 8

/** 進程表欄位。key 要與 main 的 metrics.SORT_KEYS 對得上。 */
const COLUMNS = [
  { key: 'pid', label: 'PID', align: 'right' },
  { key: 'name', label: '名稱', align: 'left' },
  { key: 'cpu', label: 'CPU', align: 'right' },
  { key: 'memory', label: '記憶體', align: 'right' },
  { key: 'diskTotal', label: '磁碟', align: 'right' },
  { key: 'gpu', label: 'GPU', align: 'right' },
  { key: 'gpuMemory', label: 'VRAM', align: 'right' },
  { key: 'threads', label: '執行緒', align: 'right' }
]

const state = {
  inited: false,
  active: false,
  subtab: 'overview',
  intervalKey: 'normal',
  /** @type {any} */
  sample: null,
  /** @type {any} */
  inventory: null,
  sortKey: 'cpu',
  sortDir: 'desc',
  filter: '',
  /** @type {number|null} */
  selectedPid: null,
  /** @type {any[]} */
  rows: [],
  scrollTop: 0,
  benching: false,
  inventoryPolling: false,
  /** 進頁自動啟用完整感測器。預設開——使用者要的是「進來就看得到溫度」 */
  sensorsAuto: true
}

/** @type {Map<string, number[]>} 每張卡的歷史值（0–100 或 bytes/s） */
const history = new Map()
/** @type {(() => void) | null} */
let unsubscribe = null
/** @type {HTMLElement[]} 虛擬捲動的節點池 */
const rowPool = []

const $ = (id) => document.getElementById(id)

// ===== 格式化 =====

/** @param {number} bytes */
function fmtBytes(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${Math.round(n)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`
}

/** @param {number} bytesPerSec */
function fmtRate(bytesPerSec) {
  const n = Number(bytesPerSec) || 0
  if (n < 1024) return '—'
  return `${fmtBytes(n)}/s`
}

/** @param {number} pct */
function fmtPct(pct) {
  const n = Number(pct) || 0
  if (n <= 0) return '—'
  return `${n < 10 ? n.toFixed(1) : Math.round(n)}%`
}

function fmtMhz(mhz) {
  const n = Number(mhz) || 0
  return n > 0 ? `${n} MHz` : '—'
}

/** @param {number} ms */
function fmtUptime(bootedAt) {
  if (!bootedAt) return '—'
  const sec = Math.max(0, Math.floor((Date.now() - bootedAt) / 1000))
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return d > 0 ? `${d} 天 ${h} 小時` : `${h} 小時 ${m} 分`
}

// ===== sparkline =====

/**
 * @param {string} key
 * @param {number} value
 * @param {number} max  0 表示自動縮放（速率類用）
 */
function pushHistory(key, value) {
  let list = history.get(key)
  if (!list) {
    list = []
    history.set(key, list)
  }
  list.push(Number(value) || 0)
  if (list.length > HISTORY) list.shift()
  return list
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {number[]} values
 * @param {number} max  0 = 自動取樣本最大值
 */
function drawSpark(canvas, values, max) {
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const w = canvas.clientWidth || 200
  const h = canvas.clientHeight || 44
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  if (values.length < 2) return

  const style = getComputedStyle(canvas)
  const line = style.getPropertyValue('--spark-line').trim() || '#78a3b5'
  const fill = style.getPropertyValue('--spark-fill').trim() || 'rgba(120,163,181,0.18)'
  const ceiling = max > 0 ? max : Math.max(1, ...values)
  const step = w / (HISTORY - 1)
  const xOf = (i) => w - (values.length - 1 - i) * step
  const yOf = (v) => h - Math.max(0, Math.min(1, v / ceiling)) * (h - 2) - 1

  ctx.beginPath()
  ctx.moveTo(xOf(0), yOf(values[0]))
  for (let i = 1; i < values.length; i += 1) ctx.lineTo(xOf(i), yOf(values[i]))
  ctx.lineTo(xOf(values.length - 1), h)
  ctx.lineTo(xOf(0), h)
  ctx.closePath()
  ctx.fillStyle = fill
  ctx.fill()

  ctx.beginPath()
  ctx.moveTo(xOf(0), yOf(values[0]))
  for (let i = 1; i < values.length; i += 1) ctx.lineTo(xOf(i), yOf(values[i]))
  ctx.strokeStyle = line
  ctx.lineWidth = 1.5
  ctx.stroke()
}

// ===== 硬體區塊（總覽 ⊕ 硬體資訊）=====

/**
 * 一個區塊 = 一種硬體。收起時只有「大數字＋進度條＋歷史曲線＋兩三個關鍵讀數」，
 * 展開才長出視覺化明細、規格表與感測器讀數；同性質的長清單（每核心溫度、每條記憶體、
 * 每顆碟）再包一層 `<details>`。這就是使用者要的漸進式揭露：一眼看得懂，想深究再點。
 *
 * 效能上這樣做也划算：沒展開的區塊每輪只更新四五個 `textContent`，
 * 展開的才走 viz／規格／感測器那幾百格。
 */

/**
 * 收起了哪些區塊。**記的是「收起」不是「展開」**：預設就要看到完整資訊，
 * 空集合＝全部展開，使用者收掉的才存起來。這是純畫面狀態（不是設定），
 * 所以放 localStorage 而不是 electron-store：它不改變任何行為，
 * 也不值得占一個 IPC allowlist 的名額。
 */
const CLOSED_KEY = 'voiceink.sysmon.closed'
const closedBlocks = new Set(loadClosedBlocks())

function loadClosedBlocks() {
  try {
    const raw = JSON.parse(localStorage.getItem(CLOSED_KEY) || '[]')
    return Array.isArray(raw) ? raw.filter((v) => typeof v === 'string') : []
  } catch { return [] }
}

function saveClosedBlocks() {
  try { localStorage.setItem(CLOSED_KEY, JSON.stringify([...closedBlocks])) } catch { /* 存不了就算了 */ }
}

/** @param {string} id */
const isOpen = (id) => !closedBlocks.has(id)

const DASH = '—'

/** LibreHardwareMonitor 的感測器型別 → 中文與單位 */
const SENSOR_TYPES = Object.freeze({
  Temperature: { label: '溫度', unit: '°C' },
  Load: { label: '負載', unit: '%' },
  Clock: { label: '時脈', unit: 'MHz' },
  Power: { label: '功耗', unit: 'W' },
  Voltage: { label: '電壓', unit: 'V' },
  Fan: { label: '風扇', unit: 'RPM' },
  Current: { label: '電流', unit: 'A' },
  Control: { label: '風扇控制', unit: '%' },
  Data: { label: '累計資料量', unit: 'GB' },
  Throughput: { label: '傳輸速率', unit: 'B/s' },
  Level: { label: '水位', unit: '%' },
  Factor: { label: '係數', unit: '' },
  Frequency: { label: '頻率', unit: 'Hz' },
  Energy: { label: '能量', unit: 'mWh' },
  Noise: { label: '噪音', unit: 'dBA' },
  // 記憶體的 SPD/XMP 時序（tCL-tRCD-tRP-tRAS…）。CPU-Z 是自己走 SMBus 讀顆粒，
  // 但 LHM 有把它當一般感測器吐出來——所以這台機器上是拿得到的。
  // SPD 存的是**時間**不是週期數：tAA 13.75 ns、tCKAVGmin 0.625 ns。
  Timing: { label: '時序', unit: 'ns' },
  // LHM 給 GPU 的 MB 級數值（各種記憶體池）用這個型別
  SmallData: { label: '記憶體用量', unit: 'MB' }
})
/** 感測器分組的顯示順序；沒列到的排在後面 */
const SENSOR_ORDER = [
  'Temperature', 'Load', 'Clock', 'Timing', 'Power', 'Voltage', 'Fan', 'Control', 'Current', 'SmallData'
]

/** 這幾種讀數本來就是整數（時序**不是**：0.625 ns 進位成 1 就直接錯了） */
const INTEGER_SENSORS = new Set(['Clock', 'Fan', 'Frequency', 'SmallData'])

function sensorUnit(type) {
  return SENSOR_TYPES[type]?.unit ?? ''
}

/** GPU 在 LHM 裡依廠牌分成 GpuNvidia／GpuAmd／GpuIntel 三種型別 */
function isGpuType(t) {
  return String(t || '').startsWith('Gpu')
}

/** @param {string | ((t: string) => boolean)} matchType */
function typeMatcher(matchType) {
  return typeof matchType === 'function' ? matchType : (t) => t === matchType
}

/**
 * 從提權感測器的樹狀結果裡撈第一個符合的值。
 *
 * **0 一律當成「沒讀到」**：缺 PawnIO 核心驅動時，Ryzen 的 Tctl/Tdie 會安靜地回 0，
 * 照著顯示就變成「CPU 溫度 0 度」——那比留白更糟，因為看起來像真的。
 */
function findSensor(sensors, matchType, sensorType) {
  if (!sensors?.available) return null
  const match = typeMatcher(matchType)
  for (const hw of sensors.groups || []) {
    if (!match(hw.t)) continue
    for (const s of hw.s || []) {
      if (s.t === sensorType && typeof s.v === 'number' && s.v > 0) return s.v
    }
  }
  return null
}

/**
 * 風扇轉速要依名稱挑：主機板的 SuperIO 上同時掛著 CPU 與機殼風扇，
 * GPU 自己的風扇又在 GpuNvidia 群組裡。名稱關鍵字實測自 ITE IT8688E／NVIDIA
 * （`CPU Fan`、`System Fan #1`、`GPU Fan`）——`findSensor` 只認型別會撈到機殼風扇。
 * @param {any} sensors
 * @param {{ hardware: (t: string) => boolean, fan: RegExp }} spec
 * @returns {number | null} RPM；讀不到回 null
 */
function findFan(sensors, spec) {
  if (!sensors?.available) return null
  const fan = findSensor(sensors, spec.hardware, 'Fan')
  if (fan != null) return fan
  for (const hw of sensors.groups || []) {
    if (!spec.hardware(hw.t)) continue
    for (const s of hw.s || []) {
      if (s.t === 'Fan' && typeof s.v === 'number' && s.v > 0 && spec.fan.test(s.n)) return s.v
    }
  }
  return null
}

const CPU_FAN = { hardware: (t) => t === 'Motherboard' || t === 'SuperIO', fan: /cpu/i }
const GPU_FAN = { hardware: isGpuType, fan: /fan/i }

/** @param {{ t: string, v: number }} s */
function sensorValueText(s) {
  // 時序的小數是有意義的（13.75 ns＝CL22＠3200），但尾巴的零不是
  const digits = s.t === 'Timing' ? 3 : INTEGER_SENSORS.has(s.t) ? 0 : 1
  const num = s.t === 'Timing' ? String(Number(s.v.toFixed(3))) : s.v.toFixed(digits)
  return `${num} ${sensorUnit(s.t)}`.trim()
}

/**
 * LHM 的時序名稱是 `tAA (CAS Latency Time)`，整串塞進只有 108px 的標籤欄會折成三行、
 * 右邊只掛一個 `13.75 ns`，17 列就是 17 個破洞。縮寫當標籤、全名跟著值走成一行。
 * @param {{ n: string, t: string, v: number }} s
 * @returns {[string, string]}
 */
function sensorRow(s) {
  const value = sensorValueText(s)
  const m = s.t === 'Timing' && /^(\S+)\s+\((.+)\)$/.exec(s.n)
  return m ? [m[1], `${value} · ${m[2]}`] : [s.n, value]
}

/** ` -  (#0)` 這種空廠商的 SPD 只剩槽號；`Team Group Inc - TEAMGROUP-…` 去掉破折號 */
function sensorHwLabel(name) {
  const clean = String(name || '').replace(/\s+-\s+/g, ' ').replace(/\s+/g, ' ').trim()
  const slot = /^\(#(\d+)\)$/.exec(clean)
  return slot ? `插槽 #${slot[1]}` : clean
}

/**
 * 把某一類硬體的感測器**依讀數種類拆成好幾組**（溫度一組、時脈一組…）。
 * 不拆的話 CPU 那一塊會是 50 列混在一起——16 條核心時脈、16 個核心溫度、
 * 一堆電壓全部平鋪，等於沒有資訊架構。
 *
 * **同一種讀數落在好幾個硬體上時要再按硬體拆一次**：四條記憶體各有一份 SPD 時序、
 * 主機板上有兩顆 ITE 晶片、雙顯卡各一組——全部倒進同一張表的話 `tAA` 會出現四次、
 * 每次值都不一樣，而且完全看不出是哪一條，等於整組資料作廢（實測記憶體那組 68 列）。
 * @param {any} sensors
 * @param {string | ((t: string) => boolean)} matchType
 * @param {string} prefix
 */
function sensorGroups(sensors, matchType, prefix) {
  if (!sensors?.available) return []
  const match = typeMatcher(matchType)
  /** @type {Map<string, { type: string, hw: string, rows: Array<[string, string]> }>} */
  const byKey = new Map()
  for (const hw of sensors.groups || []) {
    if (!match(hw.t)) continue
    for (const s of hw.s || []) {
      // 0 是「沒讀到」不是「真的 0」（缺 PawnIO 時 CPU 那一整組都是 0）
      if (typeof s.v !== 'number' || s.v === 0) continue
      const key = `${s.t} ${hw.n}`
      const entry = byKey.get(key) || { type: s.t, hw: sensorHwLabel(hw.n), rows: [] }
      entry.rows.push(sensorRow(s))
      byKey.set(key, entry)
    }
  }
  /** 這一種讀數散在幾個硬體上；只有一個就不必在標題上點名 */
  const spread = new Map()
  for (const e of byKey.values()) spread.set(e.type, (spread.get(e.type) || 0) + 1)
  return [...byKey.values()]
    .sort((a, b) => {
      const ai = SENSOR_ORDER.indexOf(a.type)
      const bi = SENSOR_ORDER.indexOf(b.type)
      return ((ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi)) || a.hw.localeCompare(b.hw)
    })
    .map((e) => {
      const label = `${prefix}${SENSOR_TYPES[e.type]?.label || e.type}`
      return {
        title: spread.get(e.type) > 1 && e.hw ? `${label} · ${e.hw}` : label,
        rows: e.rows
      }
    })
}

/**
 * 多台顯示器的同一種規格併成一行。空的那幾格丟掉，全空就回破折號。
 * @param {Array<string>} values
 */
function joinAll(values) {
  const kept = values.filter(Boolean)
  return kept.length ? kept.join('、') : DASH
}

/** probe 給的原生模式是 `2560x1440@60`，排版上要有空格才讀得順 */
function fmtNative(native) {
  const m = /^(\d+)x(\d+)@(\d+)$/.exec(String(native || ''))
  return m ? `${m[1]} × ${m[2]} @ ${m[3]} Hz` : ''
}

/**
 * EDID 只給可視區域的長寬（公分），對角線英吋要自己算——面板規格寫的是那個數字。
 * @param {string} sizeCm 形如 `60x34`
 * @returns {string} 四捨五入到整數的英吋；算不出來回空字串
 */
function diagonalInch(sizeCm) {
  const [w, h] = String(sizeCm || '').split('x').map(Number)
  if (!(w > 0) || !(h > 0)) return ''
  return String(Math.round(Math.hypot(w, h) / 2.54))
}

/**
 * 顯示介面卡清單。虛擬顯示卡（Meta／向日葵之類）也是真的裝在系統上的裝置，
 * 一樣列出來——只是它們沒有 VRAM／解析度，那幾格自然會空著。
 * @param {any[]} gpus
 * @returns {Array<[string, string]>}
 */
function gpuCardRows(gpus) {
  return gpus.map((g) => [g.name, [
    g.vram ? fmtBytes(g.vram) : '',
    g.processor && g.processor !== g.name ? g.processor : '',
    g.driver ? `驅動 ${g.driver}` : '',
    g.driverDate || '',
    g.width ? `${g.width} × ${g.height} @ ${g.refreshHz} Hz` : ''
  ].filter(Boolean).join(' · ') || DASH])
}

/** 千分位。SMART 的次數／指令數動輒十億，沒有分隔看不出量級 */
function fmtNum(n) {
  return Number(n || 0).toLocaleString('zh-TW')
}

/** 通電時數：小時是廠商回報的單位，但「幾天」才是人腦算得動的量級 */
function fmtHours(h) {
  if (!(h > 0)) return ''
  return `${fmtNum(h)} 小時（約 ${fmtNum(Math.round(h / 24))} 天）`
}

const HEALTH_TEXT = Object.freeze({ good: '良好', caution: '警告', bad: '不良' })

/**
 * 一顆硬碟的 S.M.A.R.T. 摘要（CrystalDiskInfo 上半部那一塊）。
 *
 * 值為 0 的欄位刻意**照樣顯示**（「非正常關機 0 次」是好消息，不是「沒讀到」）；
 * 真的沒讀到的欄位在 main 就會是 null／空字串，這裡才整行不出現。
 * @param {any} sm
 * @returns {Array<[string, string]>}
 */
function smartRows(sm) {
  /** @type {Array<[string, string]>} */
  const rows = []
  const level = sm.health?.level || 'good'
  const life = sm.proto === 'nvme' ? `（剩餘壽命 ${Math.max(0, 100 - sm.usedPct)}%）` : ''
  const why = sm.health?.reason ? ` · ${sm.health.reason}` : ''
  rows.push(['健康狀態', `${HEALTH_TEXT[level] || level}${life}${why}`])
  if (sm.tempC != null) {
    const limits = sm.warnTempC ? `（警告 ${sm.warnTempC} °C · 危險 ${sm.critTempC} °C）` : ''
    rows.push(['溫度', `${sm.tempC} °C${limits}`])
  }
  // 感測器 1 通常就是複合溫度，只有真的多顆時才另外列
  if (sm.sensorsC.length > 1) {
    rows.push(['各感測器溫度', sm.sensorsC.map((v) => `${v} °C`).join('、')])
  }
  const hours = fmtHours(sm.powerOnHours)
  if (hours) rows.push(['通電時數', hours])
  if (sm.powerCycles > 0) rows.push(['通電次數', `${fmtNum(sm.powerCycles)} 次`])
  if (sm.proto === 'nvme') {
    rows.push(['非正常關機', `${fmtNum(sm.unsafeShutdowns)} 次`])
    rows.push(['已用寫入壽命', `${sm.usedPct}%`])
    if (sm.spare > 0) rows.push(['可用備援空間', `${sm.spare}%（廠商門檻 ${sm.spareThreshold}%）`])
    if (sm.bytesWritten > 0) rows.push(['累計寫入', fmtBytes(sm.bytesWritten)])
    if (sm.bytesRead > 0) rows.push(['累計讀取', fmtBytes(sm.bytesRead)])
    if (sm.hostWriteCmds > 0 || sm.hostReadCmds > 0) {
      rows.push(['主機指令數', `寫 ${fmtNum(sm.hostWriteCmds)} · 讀 ${fmtNum(sm.hostReadCmds)}`])
    }
    rows.push(['媒體與資料完整性錯誤', `${fmtNum(sm.mediaErrors)} 次`])
    rows.push(['錯誤記錄筆數', `${fmtNum(sm.errorLogEntries)} 筆`])
    if (sm.busyMinutes > 0) rows.push(['控制器忙碌時間', `${fmtNum(sm.busyMinutes)} 分鐘`])
    if (sm.warnTempMinutes > 0 || sm.critTempMinutes > 0) {
      rows.push(['高溫累計時間', `警告 ${fmtNum(sm.warnTempMinutes)} 分 · 危險 ${fmtNum(sm.critTempMinutes)} 分`])
    }
    if (sm.specVersion) rows.push(['NVMe 規格版本', sm.specVersion])
    if (sm.firmwareSlots > 0) rows.push(['韌體插槽', `${sm.firmwareSlots} 個`])
    if (sm.features.length) rows.push(['支援功能', sm.features.join('、')])
  }
  return rows
}

/**
 * 每一輪把「現在該顯示什麼」整份描述出來，再交給通用的渲染器去比對。
 * 這樣新增一塊硬體只要多推一個物件，不必再寫一份 DOM 組裝。
 * @param {any} s 這一輪的取樣
 * @param {any} inv 一次性硬體清單
 * @returns {any[]}
 */
function describeBlocks(s, inv) {
  const out = []
  const sensors = s.sensors

  // ── CPU ────────────────────────────────────────────────────────
  {
    const cpu = inv?.cpus?.[0]
    const total = s.cpu?.total || 0
    const temp = findSensor(sensors, 'Cpu', 'Temperature')
    const clock = findSensor(sensors, 'Cpu', 'Clock')
    const power = findSensor(sensors, 'Cpu', 'Power')
    const cpuFan = findFan(sensors, CPU_FAN)
    const l1 = (inv?.caches || []).find((c) => c.level === 1)
    const cpuCount = (inv?.cpus || []).length
    out.push({
      id: 'cpu',
      title: 'CPU',
      accent: 'var(--accent-primary)',
      sub: cpu ? `${cpu.name} · ${cpu.cores} 核心 / ${cpu.threads} 執行緒` : '偵測中…',
      value: total,
      valueText: `${total.toFixed(1)}%`,
      spark: { key: 'cpu', value: total, max: 100 },
      stats: [
        ['溫度', temp != null ? `${temp.toFixed(0)} °C` : DASH],
        ['時脈', clock != null ? `${Math.round(clock)} MHz` : fmtMhz(cpu?.currentClockMhz || cpu?.maxClockMhz)],
        ['功耗', power != null ? `${power.toFixed(0)} W` : DASH],
        ['風扇', cpuFan != null ? `${Math.round(cpuFan)} RPM` : DASH]
      ],
      viz: { kind: 'cores', label: '每執行緒負載', values: s.cpu?.perCore || [] },
      specs: cpu ? [
        ['型號', cpu.name],
        ['製造商', cpu.vendor],
        ['系列', cpu.description || DASH],
        ['架構', cpu.arch || DASH],
        ['插槽', cpu.socket],
        ['實體插槽數', cpuCount > 1 ? `${cpuCount} 顆` : '1 顆'],
        ['核心 / 執行緒', `${cpu.cores} / ${cpu.threads}`],
        ['已啟用核心', cpu.enabledCores ? `${cpu.enabledCores} 核` : DASH],
        ['基礎時脈', fmtMhz(cpu.maxClockMhz)],
        ['外頻', cpu.extClockMhz ? fmtMhz(cpu.extClockMhz) : DASH],
        ['家族 / 步進', cpu.family ? `${cpu.family} / ${cpu.stepping || DASH}` : DASH],
        ['修訂版本', cpu.revision ? String(cpu.revision) : DASH],
        ['L1 快取', l1 ? fmtBytes(l1.sizeKb * 1024) : DASH],
        ['L2 快取', cpu.l2CacheKb ? fmtBytes(cpu.l2CacheKb * 1024) : DASH],
        ['L3 快取', cpu.l3CacheKb ? fmtBytes(cpu.l3CacheKb * 1024) : DASH],
        ['定址寬度', cpu.addressWidth ? `${cpu.addressWidth} 位元` : DASH],
        ['硬體虛擬化', cpu.virtualization ? '已啟用' : '未啟用'],
        ['Hypervisor', inv?.system?.hypervisor ? '執行中' : '未執行'],
        ['核心電壓', cpu.voltage > 0 ? `${cpu.voltage.toFixed(2)} V` : DASH],
        ['處理器 ID', cpu.processorId || DASH]
      ] : [],
      groups: [
        // 多路系統（或 big.LITTLE 被拆成多筆）時每一顆都要看得到
        cpuCount > 1
          ? {
            title: '處理器',
            rows: (inv?.cpus || []).map((c, i) => [`CPU ${i + 1}`, [
              c.name, `${c.cores} 核 / ${c.threads} 緒`, fmtMhz(c.maxClockMhz), c.socket
            ].filter(Boolean).join(' · ')])
          }
          : { title: '處理器', rows: [] },
        {
          title: '快取階層',
          rows: (inv?.caches || []).map((c) => [
            `L${c.level}`,
            [fmtBytes(c.sizeKb * 1024), c.purpose].filter(Boolean).join(' · ')
          ])
        },
        ...sensorGroups(sensors, 'Cpu', 'CPU ')
      ]
    })
  }

  // ── 記憶體 ─────────────────────────────────────────────────────
  {
    const total = s.totalMemory || 0
    const avail = s.memory?.available || 0
    const cache = s.memory?.cache || 0
    const committed = s.memory?.committed || 0
    const commitLimit = s.memory?.commitLimit || 0
    const used = Math.max(0, total - avail)
    const pct = total > 0 ? (used / total) * 100 : 0
    const mods = inv?.memoryModules || []
    const array = inv?.memoryArray
    const first = mods[0]
    const speed = first ? (first.configuredMhz || first.speedMhz) : 0
    const osInfo = inv?.os
    const pages = inv?.pageFiles || []
    const pageTotal = pages.reduce((n, p) => n + p.sizeMb, 0)
    const pageUsed = pages.reduce((n, p) => n + p.usedMb, 0)
    // BankLabel 就是通道（`P0 CHANNEL A`／`B`），插了幾種就是跑幾通道
    const channels = new Set(mods.map((m) => m.bank).filter(Boolean)).size
    out.push({
      id: 'memory',
      title: '記憶體',
      accent: 'var(--accent-warm)',
      sub: mods.length
        ? `${fmtBytes(total)} · ${mods.length} 條 ${[first.type, speed ? `${speed} MHz` : ''].filter(Boolean).join(' ')}`
        : fmtBytes(total),
      value: pct,
      valueText: `${pct.toFixed(1)}%`,
      spark: { key: 'memory', value: pct, max: 100 },
      stats: [
        ['已使用', fmtBytes(used)],
        ['可用', fmtBytes(avail)],
        ['已認可', fmtBytes(committed)]
      ],
      viz: {
        kind: 'meters',
        label: '記憶體配置',
        items: [
          { label: '實體記憶體', value: used, max: total || 1, text: `${fmtBytes(used)} / ${fmtBytes(total)}` },
          { label: '已認可', value: committed, max: commitLimit || 1, text: `${fmtBytes(committed)} / ${fmtBytes(commitLimit)}` },
          { label: '系統快取', value: cache, max: total || 1, text: fmtBytes(cache) }
        ]
      },
      specs: [
        ['總容量', fmtBytes(total)],
        ['已使用', `${fmtBytes(used)}（${pct.toFixed(1)}%）`],
        ['可用', fmtBytes(avail)],
        ['系統快取', fmtBytes(cache)],
        ['已認可 / 上限', `${fmtBytes(committed)} / ${fmtBytes(commitLimit)}`],
        ['虛擬記憶體', osInfo?.virtualKb ? fmtBytes(osInfo.virtualKb * 1024) : DASH],
        ['分頁檔', pageTotal > 0
          ? `${fmtBytes(pageUsed * 1048576)} / ${fmtBytes(pageTotal * 1048576)}`
          : DASH],
        ['插槽使用', mods.length
          ? `${mods.length} 條${array?.slots ? ` / ${array.slots} 槽` : ''}`
          : DASH],
        ['主機板上限', array?.maxCapacity ? fmtBytes(array.maxCapacity) : DASH],
        ['類型', first?.type || DASH],
        ['封裝', first?.formFactor || DASH],
        ['通道', channels ? `${channels} 通道` : DASH],
        ['實際頻率', speed ? `${speed} MHz` : DASH],
        ['標稱頻率', first?.speedMhz ? `${first.speedMhz} MHz` : DASH],
        ['工作電壓', first?.voltageMv > 0 ? `${(first.voltageMv / 1000).toFixed(2)} V` : DASH]
      ],
      groups: [
        {
          title: '記憶體模組',
          rows: mods.map((m) => [
            [m.bank, m.slot].filter(Boolean).join(' / ') || '插槽',
            [
              fmtBytes(m.capacity), m.type, m.formFactor,
              `${m.configuredMhz || m.speedMhz} MHz`,
              m.voltageMv > 0 ? `${(m.voltageMv / 1000).toFixed(2)} V` : '',
              m.vendor, m.partNumber,
              // 廠商常回一整串 0（沒寫就補零）；全 0 跟空值一樣沒資訊，乾脆不顯示
              m.serial && !/^0+$/.test(m.serial) ? `序號 ${m.serial}` : ''
            ].filter(Boolean).join(' · ')
          ])
        },
        {
          title: '分頁檔',
          rows: (inv?.pageFiles || []).map((p) => [p.name, [
            `${fmtBytes(p.usedMb * 1048576)} 已用 / ${fmtBytes(p.sizeMb * 1048576)}`,
            p.peakMb > 0 ? `尖峰 ${fmtBytes(p.peakMb * 1048576)}` : ''
          ].filter(Boolean).join(' · ')])
        },
        ...sensorGroups(sensors, 'Memory', '記憶體')
      ]
    })
  }

  // ── GPU ────────────────────────────────────────────────────────
  const nvCards = s.gpu?.cards || []
  const invGpus = inv?.gpus || []
  if (nvCards.length) {
    nvCards.forEach((g, i) => {
      const info = invGpus.find((x) => x.name && (x.name.includes(g.name) || g.name.includes(x.name)))
      const util = g.utilization ?? 0
      const vramUsed = (g.memoryUsed || 0) * 1048576
      const vramTotal = (g.memoryTotal || 0) * 1048576
      // 風扇轉速優先走 LHM 的 RPM；nvidia-smi 只有百分比（`g.fan`），沒 RPM 時退回百分比
      const gpuFanRpm = findFan(sensors, GPU_FAN)
      const fanText = gpuFanRpm != null
        ? `${Math.round(gpuFanRpm)} RPM`
        : (g.fan != null ? `${g.fan}%` : DASH)
      out.push({
        id: `gpu${i}`,
        title: nvCards.length > 1 ? `GPU ${i + 1}` : 'GPU',
        accent: 'var(--success)',
        sub: g.name,
        value: util,
        valueText: `${Math.round(util)}%`,
        spark: { key: `gpu${i}`, value: util, max: 100 },
        stats: [
          ['溫度', g.temperature != null ? `${g.temperature} °C` : DASH],
          ['功耗', g.power != null ? `${g.power.toFixed(0)} W` : DASH],
          ['VRAM', vramTotal ? fmtBytes(vramUsed) : DASH],
          ['風扇', fanText]
        ],
        viz: {
          kind: 'meters',
          label: '即時狀態',
          items: [
            { label: '使用率', value: util, max: 100, text: `${Math.round(util)}%` },
            vramTotal
              ? { label: 'VRAM', value: vramUsed, max: vramTotal, text: `${fmtBytes(vramUsed)} / ${fmtBytes(vramTotal)}` }
              : null,
            g.temperature != null
              ? { label: '溫度', value: g.temperature, max: 100, text: `${g.temperature} °C` }
              : null,
            g.clockSm ? { label: '核心時脈', value: g.clockSm, max: 3200, text: fmtMhz(g.clockSm) } : null
          ].filter(Boolean)
        },
        specs: [
          ['名稱', g.name],
          ['繪圖處理器', info?.processor || DASH],
          ['驅動版本', info?.driver || DASH],
          ['驅動日期', info?.driverDate || DASH],
          ['VBIOS', g.vbios || DASH],
          ['專用記憶體', vramTotal ? fmtBytes(vramTotal) : DASH],
          ['已用 VRAM', vramTotal ? `${fmtBytes(vramUsed)}（${((vramUsed / vramTotal) * 100).toFixed(1)}%）` : DASH],
          ['核心時脈', g.clockSm ? fmtMhz(g.clockSm) : DASH],
          ['記憶體時脈', g.clockMem ? fmtMhz(g.clockMem) : DASH],
          ['匯流排介面', g.pcieGen ? `PCIe Gen${g.pcieGen} × ${g.pcieWidth || '?'}` : DASH],
          ['目前顯示模式', info?.width ? `${info.width} × ${info.height} @ ${info.refreshHz} Hz` : DASH],
          ['裝置 ID', info?.pnpId || DASH]
        ],
        groups: [
          // 主卡以外還有內顯／虛擬顯示卡時，只列 nvidia-smi 看得到的那張等於漏掉其他的
          {
            title: '顯示介面卡',
            rows: gpuCardRows(invGpus)
          },
          ...sensorGroups(sensors, isGpuType, 'GPU ')
        ]
      })
    })
  } else {
    // 沒有 nvidia-smi：Windows 的 GPU 效能計數器仍有使用率，只是沒有溫度／功耗
    const utils = s.gpuAdapterUtil || {}
    const keys = Object.keys(utils)
    const pct = keys.length ? Math.max(...keys.map((k) => utils[k])) : 0
    const primary = invGpus.find((g) => g.vram > 0) || invGpus[0]
    const vram = s.processes.reduce((n, p) => n + (p.gpuMemory || 0), 0)
    out.push({
      id: 'gpu0',
      title: 'GPU',
      accent: 'var(--success)',
      sub: primary?.name || '偵測中…',
      value: pct,
      valueText: `${Math.round(pct)}%`,
      spark: { key: 'gpu0', value: pct, max: 100 },
      stats: [
        ['專用記憶體', fmtBytes(vram)],
        ['資料來源', 'Windows 計數器']
      ],
      viz: {
        kind: 'meters',
        label: '即時狀態',
        items: [{ label: '使用率', value: pct, max: 100, text: `${Math.round(pct)}%` }]
      },
      specs: [
        ['名稱', primary?.name || DASH],
        ['驅動版本', primary?.driver || DASH],
        ['驅動日期', primary?.driverDate || DASH],
        ['專用記憶體', primary?.vram ? fmtBytes(primary.vram) : DASH],
        ['溫度與功耗', '需要 NVIDIA 顯示卡或完整感測器']
      ],
      groups: [
        { title: '顯示介面卡', rows: gpuCardRows(invGpus) },
        ...sensorGroups(sensors, isGpuType, 'GPU ')
      ]
    })
  }

  // ── 儲存 ───────────────────────────────────────────────────────
  {
    // 效能計數器的磁碟名是「實體碟序號 + 第一個分割區代號」（`0 C:`、`1 D:`），
    // `_Total` 是彙總列。前綴數字對到 `Win32_PhysicalDisk.DeviceId`，
    // 這樣每顆硬碟的讀寫能標上自己的型號——只顯示一個總量的話，
    // 插很多顆硬碟時看不出是誰在動。
    const totalRow = s.disks.find((d) => d.name === '_Total')
    const read = totalRow ? totalRow.read : s.disks.reduce((n, d) => n + d.read, 0)
    const write = totalRow ? totalRow.write : s.disks.reduce((n, d) => n + d.write, 0)
    const vols = inv?.volumes || []
    const pdisks = inv?.physicalDisks || []
    const smart = inv?.smart || []
    const liveTemps = s.driveTemps || []
    const rawTotal = pdisks.reduce((n, d) => n + d.size, 0)
    const volTotal = vols.reduce((n, v) => n + v.size, 0)
    const volFree = vols.reduce((n, v) => n + v.free, 0)
    /**
     * 效能計數器的磁碟列 → 顯示用資訊。每顆實體碟一筆，帶型號與它掛的磁碟代號。
     * @type {Array<{ name: string, label: string, read: number, write: number, temp: number|null }>}
     */
    const diskRows = s.disks
      .filter((d) => d.name !== '_Total')
      .map((d) => {
        const idx = /^(\d+)\s/.exec(d.name)?.[1] ?? ''
        const pdisk = pdisks.find((p) => p.id === idx)
        const drive = (d.name.match(/([A-Z]:)/) || [])[1] || ''
        const temps = (sensors?.groups || [])
          .filter((hw) => hw.t === 'Storage' && hw.n === pdisk?.name)
          .flatMap((hw) => (hw.s || []).filter((x) => x.t === 'Temperature' && /Temperature$/.test(x.n)))
        // 感測器 sidecar 要 UAC，大多數人不會按；NVMe 的 SMART 溫度免權限，
        // 所以沒有 sidecar 時退回它——兩個都沒有才留空
        const live = liveTemps.find((t) => t.id === idx)
        const temp = temps.length
          ? Math.max(...temps.map((x) => x.v))
          : (live ? live.tempC : null)
        return {
          name: d.name,
          label: pdisk ? `${pdisk.name}${drive ? `（${drive}）` : ''}` : (d.name || '磁碟'),
          read: d.read,
          write: d.write,
          temp
        }
      })
    // 摘要用最壞的那顆：多碟機器上「有一顆快掛了」不該被另外三顆的良好蓋掉
    const RANK = { bad: 2, caution: 1, good: 0 }
    const worst = smart.reduce((acc, x) => (
      !acc || RANK[x.health?.level] > RANK[acc.health?.level] ? x : acc
    ), null)
    const maxTemp = diskRows.reduce((n, d) => (d.temp != null ? Math.max(n, d.temp) : n), 0)
    const maxHours = smart.reduce((n, x) => Math.max(n, x.powerOnHours), 0)
    const totalWritten = smart.reduce((n, x) => n + x.bytesWritten, 0)
    out.push({
      id: 'storage',
      title: '儲存',
      accent: 'var(--accent-hover)',
      sub: pdisks.length ? pdisks.map((d) => d.name).join('、') : '偵測中…',
      value: null,
      valueText: read + write >= 1024 ? fmtRate(read + write) : '閒置',
      spark: { key: 'disk', value: read + write, max: 0 },
      stats: [
        ['總讀取', fmtRate(read)],
        ['總寫入', fmtRate(write)],
        ['實體硬碟', String(pdisks.length || diskRows.length || 0)]
      ],
      viz: {
        kind: 'meters',
        label: '各硬碟讀寫速率',
        // 速率沒有天花板：拿這一輪最忙的那顆當滿格，看得出相對忙碌程度（同網路那格）
        items: diskRows.map((d) => ({
          label: d.label,
          value: d.read + d.write,
          max: Math.max(1024, ...diskRows.map((x) => x.read + x.write)),
          text: `讀 ${fmtRate(d.read)}　寫 ${fmtRate(d.write)}${d.temp != null ? `　${d.temp.toFixed(0)} °C` : ''}`
        }))
      },
      specs: [
        ['實體磁碟', pdisks.length ? `${pdisks.length} 顆` : DASH],
        ['磁碟區', vols.length ? `${vols.length} 個` : DASH],
        ['硬體總容量', rawTotal ? fmtBytes(rawTotal) : DASH],
        ['磁碟區總容量', volTotal ? fmtBytes(volTotal) : DASH],
        ['磁碟區已用', volTotal ? `${fmtBytes(volTotal - volFree)}（${(((volTotal - volFree) / volTotal) * 100).toFixed(1)}%）` : DASH],
        ['磁碟區可用', volTotal ? fmtBytes(volFree) : DASH],
        ['健康狀態', worst ? `${HEALTH_TEXT[worst.health?.level] || DASH}${worst.health?.reason ? `（${worst.health.reason}）` : ''}` : DASH],
        ['最高溫度', maxTemp ? `${maxTemp.toFixed(0)} °C` : DASH],
        ['最長通電時數', fmtHours(maxHours) || DASH],
        ['累計寫入量', totalWritten ? fmtBytes(totalWritten) : DASH],
        ['目前讀取', fmtRate(read)],
        ['目前寫入', fmtRate(write)]
      ],
      groups: [
        // 每顆硬碟一列：型號＋現在的讀寫速率＋溫度，一眼分清楚是誰在動
        {
          title: '各硬碟即時速率',
          rows: diskRows.map((d) => [d.label, [
            `讀 ${fmtRate(d.read)}`,
            `寫 ${fmtRate(d.write)}`,
            d.temp != null ? `${d.temp.toFixed(0)} °C` : ''
          ].filter(Boolean).join(' · ')])
        },
        {
          title: '實體磁碟',
          rows: pdisks.map((d) => [d.name, [
            d.mediaType, d.busType, fmtBytes(d.size),
            d.partitionStyle, d.isBoot ? '開機碟' : '',
            d.partitions > 0 ? `${d.partitions} 個分割區` : '',
            d.spindleRpm > 0 ? `${d.spindleRpm} RPM` : '',
            // 4Kn／512e 的差別會影響對齊與相容性，是規格表上真的會查的一格
            d.logicalSector > 0 ? `磁區 ${d.logicalSector}B/${d.physicalSector}B` : '',
            d.firmware ? `韌體 ${d.firmware}` : '',
            // 韌體那組序號常是一長串補零；標籤上刻的那組（FruId）優先
            d.fruId || d.adapterSerial || d.serial ? `序號 ${d.fruId || d.adapterSerial || d.serial}` : '',
            d.location || '',
            d.health === 'Healthy' ? '健康' : d.health
          ].filter(Boolean).join(' · ')])
        },
        // 一顆碟一組：CrystalDiskInfo 的上半部。多碟機器把它們擠在同一組會看不出誰是誰
        ...smart.map((sm) => {
          const owner = pdisks.find((p) => p.id === sm.id)
          return { title: `S.M.A.R.T.｜${owner?.name || `磁碟 ${sm.id}`}`, rows: smartRows(sm) }
        }),
        // ATA／SATA 才有的原始屬性表（NVMe 沒有這套編號制）
        ...smart.filter((sm) => sm.attributes.length).map((sm) => {
          const owner = pdisks.find((p) => p.id === sm.id)
          return {
            title: `S.M.A.R.T. 屬性｜${owner?.name || `磁碟 ${sm.id}`}`,
            rows: sm.attributes.map((a) => [
              `${a.id} ${a.name}`,
              `目前 ${a.current} · 最差 ${a.worst}${a.threshold > 0 ? ` · 門檻 ${a.threshold}` : ''} · 原始值 ${fmtNum(a.raw)}`
            ])
          }
        }),
        {
          title: '磁碟區',
          // 標出住在哪一顆實體碟：多碟機器上「D 槽滿了」得先知道 D 在誰身上
          rows: vols.map((v) => {
            const host = pdisks.find((p) => p.id === v.diskId)
            return [
              `${v.drive} ${v.label || ''}`.trim(),
              [
                `${fmtBytes(v.size - v.free)} 已用 / ${fmtBytes(v.size)}`,
                v.size > 0 ? `可用 ${fmtBytes(v.free)}（${((v.free / v.size) * 100).toFixed(0)}%）` : '',
                v.fileSystem,
                // 對不到實體碟的多半是掛載出來的虛擬碟（雲端硬碟、映像檔）
                host ? host.name : '虛擬／網路磁碟'
              ].filter(Boolean).join(' · ')
            ]
          })
        }
      ]
    })
  }

  // ── 網路 ───────────────────────────────────────────────────────
  {
    const rx = s.nets.reduce((n, x) => n + x.rx, 0)
    const tx = s.nets.reduce((n, x) => n + x.tx, 0)
    const nics = inv?.nics || []
    const online = nics.filter((n) => n.status === '已連線')
    // 「主要」＝有預設閘道那一張（VPN／虛擬網卡也算已連線，但不是實際上網的那條）
    const main = online.find((n) => n.gateway && n.ips) || online[0]
    out.push({
      id: 'network',
      title: '網路',
      accent: 'var(--warning)',
      sub: online.length ? online.map((n) => n.connection || n.name).join('、') : '偵測中…',
      value: null,
      valueText: rx + tx >= 1024 ? fmtRate(rx + tx) : '閒置',
      spark: { key: 'net', value: rx + tx, max: 0 },
      stats: [
        ['下載', fmtRate(rx)],
        ['上傳', fmtRate(tx)],
        ['介面', String(s.nets.length)]
      ],
      viz: {
        kind: 'meters',
        label: '各介面速率',
        // 速率沒有天花板，就用「這一輪最忙的那條」當滿格，看得出相對忙碌程度
        items: s.nets.map((n) => ({
          label: n.name,
          value: n.rx + n.tx,
          max: Math.max(1024, ...s.nets.map((x) => x.rx + x.tx)),
          text: `↓ ${fmtRate(n.rx)}　↑ ${fmtRate(n.tx)}`
        }))
      },
      specs: [
        ['目前下載', fmtRate(rx)],
        ['目前上傳', fmtRate(tx)],
        ['實體網路卡', nics.length ? `${nics.length} 張` : DASH],
        ['已連線', online.length ? `${online.length} 張` : DASH],
        ['主要連線', main ? (main.connection || main.name) : DASH],
        ['IPv4 位址', main?.ips || DASH],
        ['子網路遮罩', main?.subnet || DASH],
        ['IPv6 位址', main?.ipv6 || DASH],
        ['預設閘道', online.find((n) => n.gateway)?.gateway || DASH],
        ['DNS 伺服器', online.find((n) => n.dns)?.dns || DASH],
        ['DHCP 伺服器', online.find((n) => n.dhcpServer)?.dhcpServer || DASH],
        ['連線速率', main?.speed > 0 && main.speed < 1e12 ? `${Math.round(main.speed / 1e6)} Mbps` : DASH],
        ['主機名稱', inv?.system?.hostname || DASH],
        ['工作群組', inv?.system?.workgroup || DASH]
      ],
      groups: [
        {
          title: '網路介面卡',
          rows: nics.map((n) => [n.connection || n.name, [
            n.name,
            n.mac,
            n.speed > 0 && n.speed < 1e12 ? `${Math.round(n.speed / 1e6)} Mbps` : '',
            n.status,
            n.ips,
            n.subnet ? `遮罩 ${n.subnet}` : '',
            n.gateway ? `閘道 ${n.gateway}` : '',
            n.dns ? `DNS ${n.dns}` : '',
            n.dhcpServer ? `DHCP ${n.dhcpServer}` : '',
            n.ipv6 ? `IPv6 ${n.ipv6}` : '',
            n.dhcp === 'dhcp' ? '自動取得' : (n.dhcp === 'static' ? '靜態 IP' : ''),
            n.adapterType
          ].filter(Boolean).join(' · ')])
        },
        ...sensorGroups(sensors, 'Network', '網路')
      ]
    })
  }

  // ── 主機板 ─────────────────────────────────────────────────────
  {
    const board = inv?.board
    const bios = inv?.bios
    const chassis = inv?.chassis
    const sys = inv?.system
    const slots = inv?.slots || []
    const slotsUsed = slots.filter((sl) => sl.usage === '使用中').length
    const usb = inv?.usbControllers || []
    const boardTemp = findSensor(sensors, (t) => t === 'Motherboard' || t === 'SuperIO', 'Temperature')
    // 機殼風扇（CPU 那顆已經在 CPU 區塊顯示，同一個值不用重複兩次）
    const fan = findFan(sensors, { hardware: (t) => t === 'Motherboard' || t === 'SuperIO', fan: /system|chassis|pch|case/i })
    out.push({
      id: 'board',
      title: '主機板',
      accent: 'var(--accent-primary)',
      sub: board ? `${board.vendor} ${board.product}` : '偵測中…',
      value: null,
      valueText: bios?.version ? `BIOS ${bios.version}` : DASH,
      spark: null,
      stats: [
        ['溫度', boardTemp != null ? `${boardTemp.toFixed(0)} °C` : DASH],
        ['風扇', fan != null ? `${Math.round(fan)} RPM` : DASH],
        ['安全開機', inv?.security?.secureBoot === 'on' ? '已啟用' : (inv?.security?.secureBoot === 'off' ? '未啟用' : DASH)]
      ],
      viz: null,
      specs: [
        ['製造商', board?.vendor || DASH],
        ['型號', board?.product || DASH],
        ['版本', board?.version || DASH],
        ['主機板序號', board?.serial || DASH],
        ['晶片組插槽', inv?.cpus?.[0]?.socket || DASH],
        ['BIOS 廠商', bios?.vendor || DASH],
        ['BIOS 版本', bios?.version || DASH],
        ['BIOS 日期', bios?.releaseDate || DASH],
        ['BIOS 內部版本', bios?.internalVersion || DASH],
        ['系統 BIOS 字串', bios?.systemBios || DASH],
        ['SMBIOS 版本', bios?.smbios || DASH],
        ['擴充插槽', slots.length ? `${slotsUsed} 使用中 / ${slots.length} 條` : DASH],
        ['USB 控制器', usb.length ? `${usb.length} 組` : DASH],
        ['機殼型式', chassis?.type || DASH],
        ['機殼序號', chassis?.serial || DASH],
        ['系統型號', sys ? `${sys.vendor} ${sys.model}`.trim() || DASH : DASH],
        ['系統家族', sys?.family || DASH],
        ['開機方式', sys?.bootState || DASH],
        ['韌體模式', inv?.security?.firmware || DASH],
        ['安全開機', inv?.security?.secureBoot === 'on' ? '已啟用' : (inv?.security?.secureBoot === 'off' ? '未啟用' : DASH)],
        ['TPM', inv?.security?.tpm || DASH]
      ],
      groups: [
        {
          title: '擴充插槽',
          rows: slots.map((sl) => [sl.name || sl.tag || '插槽',
            [sl.width, sl.usage].filter(Boolean).join(' · ') || DASH])
        },
        {
          title: 'USB 控制器',
          rows: usb.map((u, i) => [`控制器 ${i + 1}`,
            [u.name, u.vendor, u.status === 'OK' ? '正常' : u.status].filter(Boolean).join(' · ')])
        },
        {
          title: '機殼 I/O 埠',
          // SMBIOS 寫的是「機殼上有哪些孔」：USB 3.0、USB-C、HDMI、DP、音源……
          rows: (inv?.ports || []).map((p) => [
            p.name || `${p.portType || '連接埠'}`,
            p.portType || DASH
          ])
        },
        ...sensorGroups(sensors, (t) => t === 'Motherboard' || t === 'SuperIO' || t === 'Cooler' || t === 'Psu', '主機板')
      ]
    })
  }

  // ── 顯示器 ─────────────────────────────────────────────────────
  {
    const monitors = inv?.monitors || []
    // EDID（型號／尺寸／出廠年）跟桌面配置（解析度／更新率／縮放）是兩份不同的清單，
    // 沒有可靠的對應鍵，所以各列各的，不硬湊在一起
    const displays = inv?.displays || []
    if (monitors.length || displays.length) {
      const main = displays.find((d) => d.primary) || displays[0]
      const desktopArea = displays.length
        ? { w: Math.max(...displays.map((d) => d.width)), h: Math.max(...displays.map((d) => d.height)) }
        : null
      out.push({
        id: 'monitors',
        title: '顯示器',
        accent: 'var(--success)',
        sub: monitors.length
          ? monitors.map((m) => m.name || m.vendor).join('、')
          : displays.map((d) => d.label || '顯示器').join('、'),
        value: null,
        valueText: `${Math.max(monitors.length, displays.length)} 台`,
        spark: null,
        stats: [
          ['主要解析度', main ? `${main.width} × ${main.height}` : DASH],
          ['更新率', main?.refreshHz ? `${main.refreshHz} Hz` : DASH],
          ['縮放', main?.scale ? `${Math.round(main.scale * 100)}%` : DASH]
        ],
        viz: null,
        // 上半是桌面配置（Electron 的 screen，主要顯示器是可靠的），
        // 下半是 EDID 面板規格——兩份對不起來，所以 EDID 那幾行一律列「全部面板」，
        // 不假裝其中一台是「主要」的（見上面的註解）
        specs: [
          ['連接台數', `${Math.max(monitors.length, displays.length)} 台`],
          ['主要解析度', main ? `${main.width} × ${main.height}` : DASH],
          ['更新率', main?.refreshHz ? `${main.refreshHz} Hz` : DASH],
          ['縮放', main?.scale ? `${Math.round(main.scale * 100)}%` : DASH],
          ['色彩深度', main?.colorDepth ? `${main.colorDepth} 位元` : DASH],
          ['方向', main?.rotation ? `旋轉 ${main.rotation}°` : '橫向'],
          ['最高解析度', desktopArea ? `${desktopArea.w} × ${desktopArea.h}` : DASH],
          ['面板型號', joinAll(monitors.map((mo) => mo.name || mo.vendor))],
          ['面板原生解析度', joinAll(monitors.map((mo) => fmtNative(mo.native)))],
          ['面板接頭', joinAll(monitors.map((mo) => mo.connector))],
          ['面板尺寸', joinAll(monitors.map((mo) => (mo.sizeCm ? `${diagonalInch(mo.sizeCm)}"` : '')))]
        ],
        groups: [
          {
            title: '顯示器明細',
            rows: monitors.map((m) => [m.name || m.vendor || '顯示器', [
              m.vendor,
              m.productCode ? `型號碼 ${m.productCode}` : '',
              m.native ? `原生 ${fmtNative(m.native)}` : '',
              m.connector,
              m.sizeCm ? `${m.sizeCm.replace('x', ' × ')} cm（約 ${diagonalInch(m.sizeCm)}"）` : '',
              m.year > 0 ? `${m.year} 年第 ${m.week || '?'} 週製` : '',
              m.serial ? `序號 ${m.serial}` : ''
            ].filter(Boolean).join(' · ')])
          },
          {
            title: '桌面配置',
            rows: displays.map((d) => [
              `${d.label || '顯示器'}${d.primary ? '（主要）' : ''}`,
              [
                `${d.width} × ${d.height}`,
                d.refreshHz ? `${d.refreshHz} Hz` : '',
                `縮放 ${Math.round(d.scale * 100)}%`,
                d.colorDepth ? `${d.colorDepth} 位元色彩` : '',
                d.rotation ? `旋轉 ${d.rotation}°` : '',
                d.internal ? '內建' : ''
              ].filter(Boolean).join(' · ')
            ])
          }
        ]
      })
    }
  }

  // ── 系統 ───────────────────────────────────────────────────────
  {
    const osInfo = inv?.os
    const sys = inv?.system
    const sound = inv?.sound || []
    const batteries = inv?.batteries || []
    out.push({
      id: 'system',
      title: '系統',
      accent: 'var(--accent-warm)',
      sub: osInfo ? `${osInfo.caption} · 組建 ${osInfo.build}` : '偵測中…',
      value: null,
      valueText: fmtUptime(osInfo?.bootedAt),
      spark: null,
      stats: [
        ['主機名稱', sys?.hostname || DASH],
        ['處理程序', String(s.processes.length)]
      ],
      viz: null,
      specs: [
        ['作業系統', osInfo?.caption || DASH],
        ['功能更新版本', osInfo?.displayVersion || DASH],
        ['版本 / 組建', osInfo
          ? `${osInfo.version} (${osInfo.build}${osInfo.ubr ? `.${osInfo.ubr}` : ''})`
          : DASH],
        ['版本代號', osInfo?.edition || DASH],
        ['系統架構', osInfo?.arch || DASH],
        ['系統類型', sys?.systemType || DASH],
        ['介面語言', osInfo?.languages || DASH],
        ['時區', inv?.timeZone?.caption || DASH],
        // WMI 的 InstallDate 常常是空的，退回 Windows 目錄的建立時間（見 probe.ps1）
        ['安裝日期', osInfo?.installedAt || inv?.security?.installedAt || DASH],
        ['電腦名稱', sys?.hostname || DASH],
        ['登入使用者', sys?.user || DASH],
        [sys?.inDomain ? '網域' : '工作群組', sys?.workgroup || DASH],
        ['製造商 / 型號', sys ? `${sys.vendor} ${sys.model}`.trim() || DASH : DASH],
        ['系統磁碟', osInfo?.systemDrive || DASH],
        ['Windows 目錄', osInfo?.windowsDir || DASH],
        ['虛擬化', sys?.hypervisor ? 'Hypervisor 執行中' : '未執行'],
        ['處理程序數', String(s.processes.length)],
        ['已開機', fmtUptime(osInfo?.bootedAt)]
      ],
      groups: [
        {
          title: '輸入裝置',
          rows: (inv?.inputDevices || []).map((d) => [d.kind, [
            d.name, d.detail, d.count > 1 ? `${d.count} 個` : ''
          ].filter(Boolean).join(' · ')])
        },
        { title: '音效裝置', rows: sound.map((d) => [d.name, [d.vendor, d.status === 'OK' ? '正常' : d.status].filter(Boolean).join(' · ')]) },
        {
          title: '喇叭與麥克風',
          // `Win32_SoundDevice` 是驅動層（一張卡一列），這裡是「聽得到的那顆」：
          // 螢幕喇叭、DAC、耳機麥克風。虛擬混音器（Broadcast／Virtual）已在 probe 就擋掉。
          // 值是空的也**不能給空字串**——空 dd 沒有行高，整列在格線裡塌成 0px
          rows: (inv?.audioEndpoints || []).map((a) => [a.name, DASH])
        },
        {
          title: '攝影機與掃描器',
          rows: (inv?.cameras || []).map((c) => [c.name, [c.vendor, c.status === 'OK' ? '正常' : c.status].filter(Boolean).join(' · ')])
        },
        {
          title: '藍牙',
          rows: (inv?.bluetooth || []).map((b) => [b.name, b.status === 'OK' ? '正常' : (b.status || DASH)])
        },
        {
          title: 'Windows 更新',
          rows: (inv?.hotfixes || []).map((h) => [h.id, h.installedOn || DASH])
        },
        {
          title: '電池',
          rows: batteries.map((b) => [b.name, [
            `${b.charge}%`,
            b.chemistry,
            b.designVoltageMv > 0 ? `設計電壓 ${(b.designVoltageMv / 1000).toFixed(2)} V` : '',
            b.status === 2 ? '使用市電中' : (b.status === 1 ? '放電中' : '')
          ].filter(Boolean).join(' · ')])
        },
        ...sensorGroups(sensors, (t) => t === 'Battery' || t === 'EmbeddedController', '系統')
      ]
    })
  }

  return out
}

/** 建一次、之後只改文字；每輪重建 DOM 是這一頁最容易卡的地方 */
const blocks = new Map()

function toggleBlock(id) {
  if (closedBlocks.has(id)) closedBlocks.delete(id)
  else closedBlocks.add(id)
  saveClosedBlocks()
  renderBlocks()
}

/** @param {any} desc */
function ensureBlock(desc) {
  const host = $('sysmonBlocks')
  if (!host) return null
  let b = blocks.get(desc.id)
  if (b) return b

  const el = document.createElement('section')
  el.className = 'sysmon-block'
  el.dataset.block = desc.id
  if (desc.accent) el.style.setProperty('--block-accent', desc.accent)

  const head = document.createElement('button')
  head.type = 'button'
  head.className = 'sysmon-block-head'
  head.setAttribute('aria-expanded', 'false')

  const chevron = document.createElement('span')
  chevron.className = 'sysmon-chevron'
  chevron.setAttribute('aria-hidden', 'true')

  const title = document.createElement('span')
  title.className = 'sysmon-block-title'
  const name = document.createElement('strong')
  const sub = document.createElement('span')
  sub.className = 'sysmon-block-sub'
  title.append(name, sub)

  const stats = document.createElement('span')
  stats.className = 'sysmon-block-stats'

  const spark = document.createElement('canvas')
  spark.className = 'sysmon-block-spark'
  spark.setAttribute('aria-hidden', 'true')

  const value = document.createElement('span')
  value.className = 'sysmon-block-value'

  head.append(chevron, title, stats, spark, value)

  const gauge = document.createElement('div')
  gauge.className = 'sysmon-gauge'
  const gaugeFill = document.createElement('i')
  gauge.appendChild(gaugeFill)

  const body = document.createElement('div')
  body.className = 'sysmon-block-body'
  body.hidden = true

  el.append(head, gauge, body)
  host.appendChild(el)
  head.addEventListener('click', () => toggleBlock(desc.id))

  b = {
    el, head, name, sub, stats, spark, value, gauge, gaugeFill, body,
    statFields: new Map(), sig: '', slots: null
  }
  blocks.set(desc.id, b)
  return b
}

/** 標題列右側那幾個小讀數：數量固定時只改文字，數量變了才重建 */
function setStats(b, pairs) {
  if (b.statFields.size !== pairs.length) {
    b.stats.textContent = ''
    b.statFields.clear()
    for (const [label] of pairs) {
      const cell = document.createElement('span')
      cell.className = 'sysmon-stat'
      const v = document.createElement('b')
      const l = document.createElement('i')
      l.textContent = label
      cell.append(v, l)
      b.stats.appendChild(cell)
      b.statFields.set(label, v)
    }
  }
  for (const [label, text] of pairs) {
    const node = b.statFields.get(label)
    if (!node) {
      b.statFields.clear()
      setStats(b, pairs)
      return
    }
    node.textContent = text
  }
}

/** 內文的「結構」指紋。變了才重建 DOM，沒變就只寫值。 */
function bodySignature(desc) {
  const viz = desc.viz
    ? `${desc.viz.kind}:${(desc.viz.values || desc.viz.items || []).length}`
    : '-'
  const specs = desc.specs.map(([k]) => k).join(',')
  const groups = desc.groups
    .filter((g) => g.rows.length)
    .map((g) => `${g.title}#${g.rows.map(([k]) => k).join(',')}`)
    .join(';')
  return `${viz}|${specs}|${groups}`
}

/** @param {any} viz @param {any[]} slots */
function buildViz(viz, slots) {
  const wrap = document.createElement('div')
  wrap.className = `sysmon-viz sysmon-viz-${viz.kind}`
  if (viz.label) {
    const cap = document.createElement('h3')
    cap.textContent = viz.label
    wrap.appendChild(cap)
  }
  const grid = document.createElement('div')
  grid.className = 'sysmon-viz-grid'
  wrap.appendChild(grid)

  if (viz.kind === 'cores') {
    viz.values.forEach((_, i) => {
      const cell = document.createElement('span')
      cell.className = 'sysmon-corecell'
      const label = document.createElement('i')
      label.textContent = `#${i}`
      const track = document.createElement('span')
      track.className = 'sysmon-track'
      const fill = document.createElement('b')
      track.appendChild(fill)
      const pct = document.createElement('em')
      cell.append(label, track, pct)
      grid.appendChild(cell)
      slots.push({ fill, text: pct })
    })
  } else {
    for (const item of viz.items) {
      const cell = document.createElement('span')
      cell.className = 'sysmon-metercell'
      const label = document.createElement('i')
      label.textContent = item.label
      // 這一格寬度有限（旁邊還有長條與數值），放不下時至少滑過去看得到全名
      label.title = item.label
      const track = document.createElement('span')
      track.className = 'sysmon-track'
      const fill = document.createElement('b')
      track.appendChild(fill)
      const text = document.createElement('em')
      cell.append(label, track, text)
      grid.appendChild(cell)
      slots.push({ fill, text })
    }
  }
  return wrap
}

/** @param {any} viz @param {any[]} slots */
function updateViz(viz, slots) {
  if (viz.kind === 'cores') {
    viz.values.forEach((pct, i) => {
      const slot = slots[i]
      if (!slot) return
      const clamped = Math.max(0, Math.min(100, pct))
      slot.fill.style.width = `${clamped}%`
      slot.fill.classList.toggle('is-hot', clamped >= 80)
      slot.text.textContent = `${Math.round(clamped)}%`
    })
    return
  }
  viz.items.forEach((item, i) => {
    const slot = slots[i]
    if (!slot) return
    const ratio = item.max > 0 ? Math.max(0, Math.min(1, item.value / item.max)) : 0
    slot.fill.style.width = `${ratio * 100}%`
    slot.fill.classList.toggle('is-hot', ratio >= 0.85)
    slot.text.textContent = item.text
  })
}

/**
 * 規格清單。每一組 dt/dd 包在 `<div>` 裡（HTML 的 `<dl>` 允許），
 * 否則多欄流版會把標籤跟值拆到不同欄去。
 * @param {Array<[string, string]>} rows
 * @param {HTMLElement[]} slots 收集 dd 節點，之後每輪只改它們的 textContent
 */
function buildSpecList(rows, slots) {
  const dl = document.createElement('dl')
  dl.className = 'sysmon-spec-grid'
  for (const [label] of rows) {
    const pair = document.createElement('div')
    const dt = document.createElement('dt')
    dt.textContent = label
    const dd = document.createElement('dd')
    pair.append(dt, dd)
    dl.appendChild(pair)
    slots.push(dd)
  }
  return dl
}

/** @param {any} b @param {any} desc */
function buildBody(b, desc) {
  b.body.textContent = ''
  b.slots = { viz: [], specs: [], groups: [] }

  if (desc.viz) b.body.appendChild(buildViz(desc.viz, b.slots.viz))

  if (desc.specs.length) {
    b.body.appendChild(buildSpecList(desc.specs, b.slots.specs))
  }

  for (const group of desc.groups) {
    if (!group.rows.length) continue
    const det = document.createElement('details')
    det.className = 'sysmon-sub'
    const key = `${desc.id}/${group.title}`
    det.open = isOpen(key)
    const summary = document.createElement('summary')
    summary.textContent = `${group.title}（${group.rows.length}）`
    /** @type {HTMLElement[]} */
    const slots = []
    det.append(summary, buildSpecList(group.rows, slots))
    det.addEventListener('toggle', () => {
      if (det.open) closedBlocks.delete(key)
      else closedBlocks.add(key)
      saveClosedBlocks()
    })
    b.body.appendChild(det)
    b.slots.groups.push(slots)
  }
}

/** @param {any} b @param {any} desc */
function updateBody(b, desc) {
  if (!b.slots) return
  if (desc.viz) updateViz(desc.viz, b.slots.viz)
  desc.specs.forEach(([, text], i) => {
    const node = b.slots.specs[i]
    if (node) node.textContent = text
  })
  let gi = 0
  for (const group of desc.groups) {
    if (!group.rows.length) continue
    const slots = b.slots.groups[gi]
    gi += 1
    if (!slots) continue
    group.rows.forEach(([, text], i) => {
      const node = slots[i]
      if (node) node.textContent = text
    })
  }
}

function renderBlocks() {
  const s = state.sample
  const host = $('sysmonBlocks')
  if (!s || !host) return
  const descs = describeBlocks(s, state.inventory)

  descs.forEach((desc, index) => {
    const b = ensureBlock(desc)
    if (!b) return
    // 順序可能變（第二張顯示卡是晚一點才被偵測到的），但只有真的不對位才動 DOM
    if (host.children[index] !== b.el) host.insertBefore(b.el, host.children[index] || null)

    b.name.textContent = desc.title
    b.sub.textContent = desc.sub
    // 標題列必須是單行（不然每塊高度會跳），所以放不下時靠 title 補完整內容
    b.sub.title = desc.sub
    b.value.textContent = desc.valueText
    setStats(b, desc.stats)

    if (desc.value == null) {
      b.gauge.hidden = true
    } else {
      b.gauge.hidden = false
      const pct = Math.max(0, Math.min(100, desc.value))
      b.gaugeFill.style.width = `${pct}%`
      b.gaugeFill.classList.toggle('is-hot', pct >= 85)
    }

    if (desc.spark) {
      b.spark.hidden = false
      drawSpark(b.spark, pushHistory(desc.spark.key, desc.spark.value), desc.spark.max)
    } else {
      b.spark.hidden = true
    }

    const open = isOpen(desc.id)
    b.head.setAttribute('aria-expanded', open ? 'true' : 'false')
    b.el.classList.toggle('is-open', open)
    b.body.hidden = !open
    if (!open) return

    const sig = bodySignature(desc)
    if (sig !== b.sig) {
      b.sig = sig
      buildBody(b, desc)
    }
    updateBody(b, desc)
  })
}

// ===== 進程表 =====

function renderHead() {
  const head = $('sysmonHead')
  if (!head || head.childElementCount === COLUMNS.length) {
    updateHeadSort()
    return
  }
  head.textContent = ''
  for (const col of COLUMNS) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `sysmon-th sysmon-th-${col.align}`
    btn.dataset.key = col.key
    btn.setAttribute('role', 'columnheader')
    const label = document.createElement('span')
    label.textContent = col.label
    const arrow = document.createElement('i')
    arrow.className = 'sysmon-sort-arrow'
    btn.append(label, arrow)
    btn.addEventListener('click', () => {
      if (state.sortKey === col.key) {
        state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc'
      } else {
        state.sortKey = col.key
        // 數字欄預設由大到小（想看誰吃資源），名稱欄由 A 到 Z
        state.sortDir = col.key === 'name' || col.key === 'pid' ? 'asc' : 'desc'
      }
      electronAPI.store.set('sysmonSort', `${state.sortKey}:${state.sortDir}`)
      updateHeadSort()
      rebuildRows()
    })
    head.appendChild(btn)
  }
  updateHeadSort()
}

function updateHeadSort() {
  const head = $('sysmonHead')
  if (!head) return
  for (const btn of head.children) {
    const on = btn.dataset.key === state.sortKey
    btn.classList.toggle('is-sorted', on)
    btn.classList.toggle('is-asc', on && state.sortDir === 'asc')
    btn.setAttribute('aria-sort', on ? (state.sortDir === 'asc' ? 'ascending' : 'descending') : 'none')
  }
}

/** 排序鍵 → 取值。跟 main 的 metrics.SORT_KEYS 是同一份定義，這裡是顯示端的副本。 */
const PICK = {
  pid: (p) => p.pid,
  name: (p) => p.name.toLowerCase(),
  cpu: (p) => p.cpu,
  memory: (p) => p.memory,
  threads: (p) => p.threads,
  diskTotal: (p) => p.diskRead + p.diskWrite,
  gpu: (p) => p.gpu,
  gpuMemory: (p) => p.gpuMemory
}

function rebuildRows() {
  const s = state.sample
  if (!s) return
  const needle = state.filter.trim().toLowerCase()
  let list = s.processes
  if (needle) {
    list = list.filter((p) => p.name.toLowerCase().includes(needle) || String(p.pid).includes(needle))
  }
  const pick = PICK[state.sortKey] || PICK.cpu
  const sign = state.sortDir === 'asc' ? 1 : -1
  // pid 當第二鍵：一堆 CPU 都是 0 的時候，沒有它每輪順序都會跳
  state.rows = [...list].sort((a, b) => {
    const av = pick(a)
    const bv = pick(b)
    if (av < bv) return -sign
    if (av > bv) return sign
    return a.pid - b.pid
  })
  const count = $('sysmonProcCount')
  if (count) {
    count.textContent = needle
      ? `${state.rows.length} / ${s.processes.length} 個處理程序`
      : `${s.processes.length} 個處理程序`
  }
  renderVisibleRows()
}

function renderVisibleRows() {
  const body = $('sysmonBody')
  const spacer = $('sysmonSpacer')
  const rowsHost = $('sysmonRows')
  if (!body || !spacer || !rowsHost) return

  spacer.style.height = `${state.rows.length * ROW_HEIGHT}px`
  const viewport = body.clientHeight || 400
  const first = Math.max(0, Math.floor(state.scrollTop / ROW_HEIGHT) - OVERSCAN)
  const visible = Math.ceil(viewport / ROW_HEIGHT) + OVERSCAN * 2
  const slice = state.rows.slice(first, first + visible)
  rowsHost.style.transform = `translateY(${first * ROW_HEIGHT}px)`

  // 節點池：只有「可見列數」這麼多個 DOM，捲動與更新都重用它們
  while (rowPool.length < slice.length) {
    const row = document.createElement('div')
    row.className = 'sysmon-row'
    row.setAttribute('role', 'row')
    for (const col of COLUMNS) {
      const cell = document.createElement('span')
      cell.className = `sysmon-td sysmon-td-${col.align}`
      cell.setAttribute('role', 'cell')
      row.appendChild(cell)
    }
    row.addEventListener('click', () => selectPid(Number(row.dataset.pid)))
    rowPool.push(row)
    rowsHost.appendChild(row)
  }
  for (let i = slice.length; i < rowPool.length; i += 1) rowPool[i].classList.add('hidden')

  slice.forEach((p, i) => {
    const row = rowPool[i]
    row.classList.remove('hidden')
    row.dataset.pid = String(p.pid)
    row.classList.toggle('is-selected', state.selectedPid === p.pid)
    const c = row.children
    c[0].textContent = String(p.pid)
    c[1].textContent = p.name
    c[2].textContent = fmtPct(p.cpu)
    c[3].textContent = fmtBytes(p.memory)
    c[4].textContent = fmtRate(p.diskRead + p.diskWrite)
    c[5].textContent = fmtPct(p.gpu)
    c[6].textContent = p.gpuMemory > 0 ? fmtBytes(p.gpuMemory) : '—'
    c[7].textContent = String(p.threads)
    // 熱度：吃愈兇顏色愈亮，btop 的做法
    c[2].classList.toggle('is-hot', p.cpu >= 10)
    c[3].classList.toggle('is-hot', p.memory >= 1024 * 1024 * 1024)
  })
}

function selectPid(pid) {
  if (!Number.isFinite(pid)) return
  state.selectedPid = pid
  renderVisibleRows()
  updateKillButtons()
  const box = $('sysmonDetail')
  if (box) box.textContent = '讀取中…'
  electronAPI.sysmon.detail(pid).then((res) => {
    if (state.selectedPid !== pid || !box) return
    const d = res?.ok ? res.data : null
    if (!d) {
      box.textContent = '這個處理程序已經結束，或需要更高權限才能查看細節。'
      return
    }
    const bits = [
      `PID ${d.pid}`,
      d.description || d.name,
      d.company ? `發行者：${d.company}` : '',
      d.owner ? `使用者：${d.owner}` : '',
      d.path || ''
    ].filter(Boolean)
    box.textContent = bits.join(' · ')
  })
}

function updateKillButtons() {
  const kill = $('sysmonKillBtn')
  if (kill) kill.disabled = state.selectedPid == null
}

/** 只留強制結束：溫和的「結束工作」對沒有視窗訊息迴圈的程序本來就沒作用 */
function askKill(force) {
  const pid = state.selectedPid
  if (pid == null) return
  const proc = state.rows.find((p) => p.pid === pid)
  const dialog = $('sysmonKillDialog')
  const desc = $('sysmonKillDesc')
  const confirm = $('sysmonKillConfirm')
  if (!dialog || !desc || !confirm) return
  desc.textContent = force
    ? `強制結束「${proc?.name || pid}」（PID ${pid}）與它的子處理程序。未存檔的資料會直接遺失。`
    : `要求「${proc?.name || pid}」（PID ${pid}）關閉。程式會有機會存檔；沒有回應的話再用強制結束。`
  confirm.textContent = force ? '強制結束' : '結束'
  confirm.dataset.force = force ? '1' : ''
  dialog.showModal()
}

async function doKill() {
  const dialog = $('sysmonKillDialog')
  const confirm = $('sysmonKillConfirm')
  const pid = state.selectedPid
  dialog?.close()
  if (pid == null) return
  const res = await electronAPI.sysmon.kill(pid, confirm?.dataset.force === '1')
  if (res?.ok) {
    state.selectedPid = null
    updateKillButtons()
    const box = $('sysmonDetail')
    if (box) box.textContent = ''
    showError('')
  } else {
    showError(res?.error?.message || '結束處理程序失敗')
  }
}

// ===== GPU 壓力測試 =====

/**
 * 壓力測試的下一格。
 *
 * **一律用計時器，不用 `requestAnimationFrame`**，兩個理由：
 *  1. 視窗被最小化或被別的視窗完全遮住時 rAF 根本不觸發，壓力測試會安靜地停下來，
 *     但畫面還寫著「執行中」（`transcribe.js` 的 `waitForPaint()` 踩過同一個坑）。
 *  2. 就算視窗看得見，rAF 也是**跟著螢幕更新率**走的——一秒最多 60～165 次，而且
 *     Chromium 對被遮住的視窗會把它節流到 1Hz。實測就是這樣：GPU 每個 frame 忙 86ms，
 *     但兩次回呼之間隔 700ms，量到的使用率只剩 40%（前 7 秒 84%，之後掉到個位數）。
 *     壓力測試要的是「一批畫完立刻排下一批」，跟畫面更新沒有關係。
 *
 * 代價是這條迴圈會一直佔著 renderer 的主執行緒，跑起來畫面會很頓——那是預期的。
 * @param {(now: number) => void} fn
 */
function schedule(fn) {
  stress.raf = setTimeout(() => fn(performance.now()), 0)
}

function unschedule() {
  if (!stress.raf) return
  clearTimeout(stress.raf)
  stress.raf = 0
}

const stress = {
  /** @type {WebGL2RenderingContext | null} */
  gl: null,
  raf: 0,
  running: false,
  frames: 0,
  startedAt: 0,
  lastFpsAt: 0,
  /** @type {WebGLTexture[]} */
  textures: [],
  vramMb: 0,
  /** @type {WebGLProgram | null} */
  program: null,
  loadLoc: null,
  timeLoc: null,
  /** 一個 frame 要連畫幾次（自動加壓調出來的，見 startStress） */
  passes: 1,
  /** 上一個 frame 的 GPU 實際耗時（readPixels 擋回來之後量的） */
  lastFrameMs: 0,
  /** readPixels 的落點，建一次就好 */
  probePixel: new Uint8Array(4),
  /** @type {WebGLFramebuffer | null} 離屏 framebuffer（負載畫在這裡，不畫進畫布） */
  fbo: null,
  /** 安全閥：預設 5 分鐘自動停 */
  maxMs: 5 * 60 * 1000
}

/**
 * 一個 frame 要讓 GPU 忙多久。
 *
 * 這個數字就是「能不能真的滿載」的關鍵：如果一批只花零點幾毫秒，GPU 大部分時間都在等
 * 下一次排程——使用率是個位數。每一批之間的固定開銷（readPixels 同步回來、下一個
 * setTimeout 被夾到 4ms、送出 draw call）實測約 20ms，所以批次要夠大才蓋得過去：
 * 100ms 的批次實測 GPU 80%，300ms 約 94%。
 *
 * 上限刻意留在 Windows 的 TDR（2 秒沒回應就重置驅動）以下很多：真的撞到 TDR 的話
 * 畫面會黑一下、WebGL context 直接 lost，測試等於中斷。
 */
const GPU_FRAME_BUDGET_MS = 300
/** 自動加壓的上限，避免在很慢的 GPU 上愈加愈重 */
const GPU_MAX_PASSES = 4096
/** 離屏 framebuffer 的大小。像素數就是壓力，跟畫面上顯示多大無關 */
const STRESS_WIDTH = 1920
const STRESS_HEIGHT = 1080

const VERT = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`

// 迴圈次數由 uniform 控制；刻意用不會被最佳化掉的相依運算把 ALU 塞滿
const FRAG = `#version 300 es
precision highp float;
uniform int uLoad;
uniform float uTime;
out vec4 color;
void main() {
  vec2 uv = gl_FragCoord.xy * 0.01;
  vec4 acc = vec4(uv, uTime, 1.0);
  for (int i = 0; i < 4096; i++) {
    if (i >= uLoad) break;
    acc = sin(acc * 1.0001 + acc.wxyz * 0.5) + cos(acc.zwxy * 0.25 + uTime * 0.001);
    acc = normalize(acc + 0.0001);
  }
  color = vec4(abs(acc.xyz) * 0.5 + 0.25, 1.0);
}`

function initStressGl() {
  if (stress.gl) return stress.gl
  const canvas = /** @type {HTMLCanvasElement|null} */ ($('sysmonStressCanvas'))
  if (!canvas) return null
  const gl = canvas.getContext('webgl2', { antialias: false, powerPreference: 'high-performance' })
  if (!gl) return null

  const compile = (type, src) => {
    const sh = gl.createShader(type)
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    return sh
  }
  const program = gl.createProgram()
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT))
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null
  gl.useProgram(program)

  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const loc = gl.getAttribLocation(program, 'p')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)

  // 畫進**離屏 framebuffer**，不畫進畫布本身。
  //
  // 畫預設 framebuffer 的話，每一批結束都得跟合成器與 swap chain 打交道，而那條路的行為
  // 跟視窗有沒有被遮住有關——實測同一版程式碼連跑三次，nvidia-smi 量到 77%／100%／3%，
  // 而 renderer 每次都說自己等了 255ms（等的是呈現，不是運算）。離屏之後這條路整個消失。
  //
  // 解析度是壓力的來源：原本 320×180（5.8 萬像素）就算把迴圈開到最大也塞不滿現代顯示卡。
  const fbo = gl.createFramebuffer()
  const rbo = gl.createRenderbuffer()
  gl.bindRenderbuffer(gl.RENDERBUFFER, rbo)
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, STRESS_WIDTH, STRESS_HEIGHT)
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rbo)
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return null

  stress.gl = gl
  stress.fbo = fbo
  stress.program = program
  stress.loadLoc = gl.getUniformLocation(program, 'uLoad')
  stress.timeLoc = gl.getUniformLocation(program, 'uTime')
  return gl
}

/** 配置到目標 MB 為止；配不到就回報實際上限（那本身就是有用的資訊） */
function allocVram(targetMb) {
  const gl = stress.gl
  if (!gl) return 0
  freeVram()
  // 一張 1024×1024 RGBA8 = 4MB
  const perTexture = 4
  const count = Math.floor(targetMb / perTexture)
  const pixels = new Uint8Array(1024 * 1024 * 4)
  for (let i = 0; i < count; i += 1) {
    const tex = gl.createTexture()
    if (!tex) break
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1024, 1024, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    if (gl.getError() !== gl.NO_ERROR) {
      gl.deleteTexture(tex)
      break
    }
    stress.textures.push(tex)
  }
  stress.vramMb = stress.textures.length * perTexture
  return stress.vramMb
}

function freeVram() {
  const gl = stress.gl
  if (gl) for (const tex of stress.textures) gl.deleteTexture(tex)
  stress.textures = []
  stress.vramMb = 0
}

function startStress() {
  const gl = initStressGl()
  const stat = $('sysmonStressStat')
  if (!gl) {
    if (stat) stat.textContent = '這台機器沒有可用的 WebGL2，無法執行 GPU 壓力測試。'
    return
  }
  const level = Number($('sysmonGpuLoad')?.value || 3)
  const targetVram = Number($('sysmonVram')?.value || 0)
  const allocated = targetVram > 0 ? allocVram(targetVram) : 0

  stress.running = true
  stress.frames = 0
  stress.startedAt = performance.now()
  stress.lastFpsAt = stress.startedAt
  stress.passes = 1
  stress.lastFrameMs = 0
  const iterations = [0, 256, 640, 1280, 2560, 4096][level] || 1280

  $('sysmonStressStart').disabled = true
  $('sysmonStressStop').disabled = false
  // 視窗被遮住時 Chromium 會把這個 renderer 降級，GPU 負載會安靜地垮掉（實測掉到 3%）。
  // 只在測試期間關掉節流；`stopStress` 一定要打開回來
  void electronAPI.sysmon.gpuStress(true)

  const loop = (now) => {
    if (!stress.running) return
    if (now - stress.startedAt > stress.maxMs) {
      stopStress('已達 5 分鐘安全上限，自動停止。')
      return
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, stress.fbo)
    gl.viewport(0, 0, STRESS_WIDTH, STRESS_HEIGHT)
    gl.uniform1i(stress.loadLoc, iterations)
    gl.uniform1f(stress.timeLoc, now)
    const t0 = performance.now()
    for (let i = 0; i < stress.passes; i += 1) gl.drawArrays(gl.TRIANGLES, 0, 3)
    // **這一行才是計時的關鍵**：`readPixels` 是同步的，會擋到 GPU 真的把前面那些畫完
    // 才回來（讀 1 個像素，頻寬可以忽略）。
    // 試過的兩種都不行：`gl.finish()` 在 Chromium 底下量回來永遠是 0ms（指令只是進了
    // 驅動佇列），自動加壓會一路衝到上限——實測 1.2 FPS、一個 frame 800ms，離 Windows
    // 兩秒的 TDR 只差一點點；改用「兩次 frame 的間隔」則是在視窗被遮住時被 Chromium
    // 的 rAF 節流騙走（量到 1001ms，於是完全不加壓，GPU 只有 3%）
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, stress.probePixel)
    stress.lastFrameMs = performance.now() - t0
    // 自動加壓：把單一 frame 的 GPU 工作量推到預算附近，等 vsync 的空檔就被擠掉了
    if (stress.lastFrameMs < GPU_FRAME_BUDGET_MS * 0.8 && stress.passes < GPU_MAX_PASSES) {
      stress.passes = Math.min(GPU_MAX_PASSES, Math.max(stress.passes + 1, Math.round(stress.passes * 1.7)))
    } else if (stress.lastFrameMs > GPU_FRAME_BUDGET_MS * 1.6 && stress.passes > 1) {
      stress.passes = Math.max(1, Math.round(stress.passes * 0.7))
    }
    stress.frames += 1
    if (now - stress.lastFpsAt >= 500 && stat) {
      const fps = (stress.frames / ((now - stress.startedAt) / 1000)).toFixed(1)
      const secs = Math.round((now - stress.startedAt) / 1000)
      stat.textContent = `執行中 · ${fps} FPS · 每 frame ${stress.passes} 次繪製／${stress.lastFrameMs.toFixed(0)}ms · ${secs}s${allocated ? ` · 已配置 ${allocated} MB VRAM` : ''}`
      stress.lastFpsAt = now
    }
    schedule(loop)
  }
  schedule(loop)

  if (targetVram > 0 && allocated < targetVram && stat) {
    stat.textContent = `只配置到 ${allocated} MB（顯示卡拒絕再給），仍會繼續跑著色器負載。`
  }
}

function stopStress(reason = '') {
  unschedule()
  stress.running = false
  freeVram()
  void electronAPI.sysmon.gpuStress(false)
  const start = $('sysmonStressStart')
  const stop = $('sysmonStressStop')
  if (start) start.disabled = false
  if (stop) stop.disabled = true
  const stat = $('sysmonStressStat')
  if (stat) stat.textContent = reason || '已停止。'
}

// ===== CPU／記憶體壓力測試 =====

/**
 * 兩個都跑在 main（`sysmon/stress.js`），不在這裡：
 * renderer 的 Web Worker 會跟畫面搶同一個 process 的排程，量到的是「瀏覽器分給你多少」；
 * 而 V8 的堆有上限，這裡也配不到幾十 GB。這一段只負責按鈕與顯示。
 */
async function toggleCpuStress(run) {
  const start = $('sysmonCpuStressStart')
  const stop = $('sysmonCpuStressStop')
  const stat = $('sysmonCpuStressStat')
  const threads = Number($('sysmonCpuThreads')?.value || 1)
  const res = await electronAPI.sysmon.cpuStress(run, threads)
  if (!res?.ok) {
    if (stat) stat.textContent = res?.error?.message || 'CPU 壓力測試無法啟動。'
    return
  }
  const cpu = res.data.cpu
  if (start) start.disabled = cpu.running
  if (stop) stop.disabled = !cpu.running
  if (stat) {
    stat.textContent = cpu.running
      ? `執行中 · ${cpu.threads} 條執行緒 · 5 分鐘後自動停止`
      : '已停止。'
  }
}

async function toggleMemStress(run) {
  const start = $('sysmonMemStressStart')
  const stop = $('sysmonMemStressStop')
  const stat = $('sysmonMemStressStat')
  const gb = Number($('sysmonMemSize')?.value || 1)
  // 配置幾十 GB 要好幾秒（main 會開子程序去配、配完才回），先講一聲免得看起來像沒反應
  if (run && stat) stat.textContent = `配置中… 目標 ${gb} GB`
  if (run && start) start.disabled = true
  const res = await electronAPI.sysmon.memStress(run, gb)
  if (!res?.ok) {
    if (stat) stat.textContent = res?.error?.message || '記憶體壓力測試無法啟動。'
    return
  }
  const mem = res.data.memory
  if (start) start.disabled = mem.running
  if (stop) stop.disabled = !mem.running
  if (stat) {
    if (!mem.running) stat.textContent = '已停止，記憶體已釋放。'
    else {
      const actual = mem.allocatedBytes / (1024 ** 3)
      // 配不到要求的量本身就是有用的資訊，不要默默少配
      stat.textContent = actual + 0.25 < gb
        ? `已配置 ${actual.toFixed(2)} GB（可用記憶體不足，未達要求的 ${gb} GB）`
        : `執行中 · 已配置 ${actual.toFixed(2)} GB · 5 分鐘後自動釋放`
    }
  }
}

/** 壓力測試頁上方那一條即時儀錶：跑測試時不必切回總覽也看得到負載與溫度 */
function renderStressGauges() {
  const s = state.sample
  const cpuHost = $('sysmonStressCpu')
  const gpuHost = $('sysmonStressGpu')
  const diskHost = $('sysmonStressDisks')
  if (!cpuHost || !gpuHost || !diskHost || !s) return
  const sensors = s.sensors
  const total = s.totalMemory || 0
  const used = Math.max(0, total - (s.memory?.available || 0))
  const gpuCard = (s.gpu?.cards || [])[0]
  const cpuTemp = findSensor(sensors, 'Cpu', 'Temperature')
  const cpuPower = findSensor(sensors, 'Cpu', 'Power')
  const cpuFan = findFan(sensors, CPU_FAN)
  const gpuFanRpm = findFan(sensors, GPU_FAN)

  /** 磁碟列 → 顯示標籤（型號＋代號），跟總覽的儲存區塊同一套對法 */
  const pdisks = state.inventory?.physicalDisks || []
  const diskRows = (s.disks || [])
    .filter((d) => d.name !== '_Total')
    .map((d) => {
      const idx = /^(\d+)\s/.exec(d.name)?.[1] ?? ''
      const pdisk = pdisks.find((p) => p.id === idx)
      const drive = (d.name.match(/([A-Z]:)/) || [])[1] || ''
      return {
        key: d.name,
        label: pdisk ? `${pdisk.name}${drive ? `（${drive}）` : ''}` : (d.name || '磁碟'),
        rate: d.read + d.write
      }
    })

  // CPU／GPU 各固定四格：負載／功耗／溫度／轉速
  const cpuItems = [
    { label: '負載', value: s.cpu?.total || 0, max: 100, text: `${(s.cpu?.total || 0).toFixed(0)}%` },
    { label: '功耗', value: cpuPower || 0, max: 250, text: cpuPower != null ? `${cpuPower.toFixed(0)} W` : '需完整感測器' },
    { label: '溫度', value: cpuTemp || 0, max: 100, text: cpuTemp != null ? `${cpuTemp.toFixed(0)} °C` : '需完整感測器' },
    { label: '轉速', value: cpuFan || 0, max: 3000, text: cpuFan != null ? `${Math.round(cpuFan)} RPM` : '需完整感測器' }
  ]
  const gpuItems = gpuCard ? [
    { label: '負載', value: gpuCard.utilization || 0, max: 100, text: `${Math.round(gpuCard.utilization || 0)}%` },
    { label: '功耗', value: gpuCard.power || 0, max: 400, text: gpuCard.power != null ? `${gpuCard.power.toFixed(0)} W` : DASH },
    { label: '溫度', value: gpuCard.temperature || 0, max: 100, text: gpuCard.temperature != null ? `${gpuCard.temperature} °C` : DASH },
    {
      label: '轉速',
      value: gpuFanRpm || 0,
      max: 3000,
      text: gpuFanRpm != null ? `${Math.round(gpuFanRpm)} RPM` : (gpuCard.fan != null ? `${gpuCard.fan}%` : DASH)
    }
  ] : []

  // 記憶體壓力測試量的就是「吃掉多少容量」；硬碟一格一顆，看的是「有沒有在讀寫」
  const diskItems = [
    { key: 'mem', label: '記憶體已用', value: used, max: total || 1, text: `${fmtBytes(used)} / ${fmtBytes(total)}` },
    ...diskRows.map((d) => {
      // 尺規跟著看過的峰值走：不同機器的 SSD 差好幾倍，寫死上限不是滿格就是永遠貼底
      const peak = Math.max((diskPeaks.get(d.key) || 0) * 0.995, d.rate, 100 * 1024 * 1024)
      diskPeaks.set(d.key, peak)
      return { key: d.key, label: d.label, value: d.rate, max: peak, text: d.rate >= 1024 ? fmtRate(d.rate) : '閒置' }
    })
  ]

  renderGaugeRow(cpuHost, cpuItems, stressCpuSlots)
  renderGaugeRow(gpuHost, gpuItems, stressGpuSlots)
  // 硬碟的數量會變（隨身碟插拔），數量對不上就整排重畫
  renderGaugeRow(diskHost, diskItems, stressDiskSlots, true)
}

/**
 * 一排儀錶格。結構固定時只改文字與長條寬度，不重建 DOM。
 * @param {HTMLElement} host
 * @param {Array<{ label: string, value: number, max: number, text: string }>} items
 * @param {Array<{ fill: HTMLElement, text: HTMLElement }>} slots
 * @param {boolean} [rebuildOnChange] 數量變了就整排重建（硬碟列）
 */
function renderGaugeRow(host, items, slots, rebuildOnChange = false) {
  if (!host) return
  if (rebuildOnChange && slots.length !== items.length) host.textContent = ''
  if (!slots.length || slots.length !== items.length) {
    host.textContent = ''
    slots.length = 0
    for (const item of items) {
      const cell = document.createElement('span')
      cell.className = 'sysmon-metercell'
      const label = document.createElement('i')
      label.textContent = item.label
      // 這一格寬度有限（旁邊還有長條與數值），放不下時至少滑過去看得到全名
      label.title = item.label
      const track = document.createElement('span')
      track.className = 'sysmon-track'
      const fill = document.createElement('b')
      track.appendChild(fill)
      const text = document.createElement('em')
      cell.append(label, track, text)
      host.appendChild(cell)
      slots.push({ fill, text })
    }
    return
  }
  items.forEach((item, i) => {
    const slot = slots[i]
    if (!slot) return
    const ratio = item.max > 0 ? Math.max(0, Math.min(1, item.value / item.max)) : 0
    slot.fill.style.width = `${ratio * 100}%`
    slot.fill.classList.toggle('is-hot', ratio >= 0.85)
    slot.text.textContent = item.text
  })
}

/** @type {Array<{ fill: HTMLElement, text: HTMLElement }>} */
const stressCpuSlots = []
const stressGpuSlots = []
const stressDiskSlots = []
/** 每顆硬碟自己的讀寫峰值（慢慢往下衰減，免得一次尖峰把之後的長條壓扁） */
const diskPeaks = new Map()

// ===== 磁碟測速 =====

/**
 * 把偵測到的磁碟代號填進下拉。資料夾路徑完全不經過 renderer——
 * renderer 只送磁碟代號，測試檔放哪裡由 main 自己決定。
 */
function fillBenchDisks() {
  const select = /** @type {HTMLSelectElement|null} */ ($('sysmonBenchDisk'))
  if (!select || !state.inventory) return
  const vols = state.inventory.volumes || []
  if (!vols.length || select.dataset.filled === String(vols.length)) return
  const current = select.value
  select.textContent = ''
  for (const v of vols) {
    const option = document.createElement('option')
    option.value = v.drive
    option.textContent = `${v.drive} ${v.label || ''}`.trim()
    select.appendChild(option)
  }
  select.dataset.filled = String(vols.length)
  if (current && vols.some((v) => v.drive === current)) select.value = current
}

async function runBench() {
  if (state.benching) return
  const drive = /** @type {HTMLSelectElement|null} */ ($('sysmonBenchDisk'))?.value
  if (!drive) {
    showBenchResult('還沒偵測到硬碟，稍等一下再試。')
    return
  }
  state.benching = true
  $('sysmonBenchStart').disabled = true
  $('sysmonBenchStop').disabled = false
  showBenchResult(`準備中…（${drive}）`)
  const sizeMb = Number($('sysmonBenchSize')?.value || 1024)
  const res = await electronAPI.sysmon.diskBench({ drive, sizeMb })
  state.benching = false
  $('sysmonBenchStart').disabled = false
  $('sysmonBenchStop').disabled = true
  if (!res?.ok) {
    showBenchResult(res?.error?.message || '磁碟測速失敗')
    return
  }
  const d = res.data
  showBenchResult(
    `${d.drive}　序列寫入 ${d.writeMbPerSec.toFixed(1)} MB/s（含 fsync，實際落盤）\n` +
    `序列讀取 ${d.readMbPerSec.toFixed(1)} MB/s（含系統快取，僅供相對參考）\n` +
    `測試檔 ${d.sizeMb} MB，已刪除`
  )
}

function showBenchResult(text) {
  const box = $('sysmonBenchResult')
  if (box) box.textContent = text
}

// ===== 訊息 =====

function showError(text) {
  const el = $('sysmonError')
  if (!el) return
  el.textContent = text || ''
  el.classList.toggle('hidden', !text)
}

function showSensorNote(status) {
  const el = $('sysmonSensorNote')
  const text = $('sysmonSensorNoteText')
  const btn = $('sysmonSensorsBtn')
  const pawn = $('sysmonPawnIoBtn')
  if (!el || !btn || !text || !pawn) return

  // 感測器是自動啟用的，所以這顆鈕只在「沒啟用成功」時才出現（授權被拒、被系統擋下…）
  const running = status?.state === 'on' || status?.state === 'starting'
  btn.classList.toggle('hidden', running)
  btn.disabled = false
  btn.textContent = '重試啟用完整感測器'
  // 已啟用但缺 PawnIO 時說明仍要留著：那句講的是「還有一半拿不到、以及怎麼補」
  text.textContent = status?.message || ''
  el.classList.toggle('hidden', !status?.message)
  // 代裝按鈕只在「缺驅動」時出現；手動下載頁留給代裝失敗時才亮（見 installPawnIo 的 catch）
  pawn.classList.toggle('hidden', status?.needsPawnIo !== true)
  if (status?.needsPawnIo === true) {
    pawn.disabled = false
    pawn.textContent = '自動安裝 PawnIO 驅動'
  }
}

// ===== 子分頁 =====

function switchSubtab(name) {
  state.subtab = name
  for (const btn of document.querySelectorAll('#sysmonTabs .sysmon-tab')) {
    const on = btn.dataset.subtab === name
    btn.classList.toggle('active', on)
    btn.setAttribute('aria-selected', on ? 'true' : 'false')
  }
  for (const panel of document.querySelectorAll('#page-sysmon .sysmon-panel')) {
    panel.classList.toggle('active', panel.id === `sysmon-${name}`)
  }
  if (name === 'processes') {
    renderHead()
    rebuildRows()
  }
  if (name === 'overview') {
    renderBlocks()
    loadInventory()
  }
  if (name === 'stress') renderStressGauges()
  if (name === 'fans') showFanPanel()
  else hideFanPanel()
}

// ===== 生命週期 =====

/**
 * 硬體清單只查一次。**不要等 onSample 才拉**：取樣間隔設 5 秒時，
 * 使用者切到「硬體資訊」會盯著「偵測中…」看好幾秒，看起來像壞掉。
 */
function loadInventory() {
  if (state.inventory || state.inventoryPolling) return Promise.resolve(state.inventory)
  state.inventoryPolling = true
  // 靜態清單是取樣器啟動後第二個回來的框，剛切進來時還沒有。**要自己輪詢**：
  // 只等 onSample 的話，取樣間隔設 5 秒時「硬體資訊」會盯著「偵測中…」看好幾秒。
  // 45 秒不是隨便給的：剛打包完的第一次啟動會被 Defender 掃整個 asar，
  // 取樣器要 20 秒以上才吐出第一個框（CDP 測試實測撞到過）
  const deadline = Date.now() + 45_000
  const tick = () => electronAPI.sysmon.inventory().then((res) => {
    if (res?.ok && res.data) {
      state.inventory = res.data
      state.inventoryPolling = false
      fillBenchDisks()
      if (state.subtab === 'overview') renderBlocks()
      return state.inventory
    }
    if (!state.active || Date.now() > deadline) {
      state.inventoryPolling = false
      return null
    }
    return new Promise((resolve) => setTimeout(() => resolve(tick()), 400))
  })
  return tick()
}

function onSample(sample) {
  const wasAvailable = state.sample?.sensors?.available
  state.sample = sample
  if (!state.inventory) loadInventory()
  // 感測器狀態變了才動提示（每輪重寫會把使用者正在讀的字閃掉）
  if (sample.sensors && sample.sensors.available !== wasAvailable) showSensorNote(sample.sensors)
  // 只畫目前看得見的那個子分頁：切到「處理程序」時沒必要重畫區塊
  if (state.subtab === 'overview') renderBlocks()
  else if (state.subtab === 'processes') rebuildRows()
  else if (state.subtab === 'stress') renderStressGauges()
}

export function initSysmonPage() {
  if (state.inited) return
  state.inited = true

  $('sysmonTabs')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.sysmon-tab')
    if (btn) switchSubtab(btn.dataset.subtab)
  })

  const body = $('sysmonBody')
  body?.addEventListener('scroll', () => {
    state.scrollTop = body.scrollTop
    renderVisibleRows()
  }, { passive: true })

  $('sysmonSearch')?.addEventListener('input', (e) => {
    state.filter = e.target.value
    state.scrollTop = 0
    if (body) body.scrollTop = 0
    rebuildRows()
  })

  $('sysmonKillBtn')?.addEventListener('click', () => askKill(true))
  $('sysmonKillConfirm')?.addEventListener('click', doKill)
  $('sysmonKillCancel')?.addEventListener('click', () => $('sysmonKillDialog')?.close())

  $('sysmonInterval')?.addEventListener('change', (e) => {
    state.intervalKey = e.target.value
    electronAPI.store.set('sysmonInterval', state.intervalKey)
    if (state.active) electronAPI.sysmon.start(state.intervalKey)
  })

  $('sysmonSensorsBtn')?.addEventListener('click', () => enableSensors())

  $('sysmonCpuThreads')?.addEventListener('input', (e) => {
    const out = $('sysmonCpuThreadsOut')
    if (out) out.textContent = e.target.value
  })
  $('sysmonCpuStressStart')?.addEventListener('click', () => toggleCpuStress(true))
  $('sysmonCpuStressStop')?.addEventListener('click', () => toggleCpuStress(false))
  $('sysmonMemSize')?.addEventListener('input', (e) => {
    const out = $('sysmonMemSizeOut')
    if (out) out.textContent = `${e.target.value} GB`
  })
  $('sysmonMemStressStart')?.addEventListener('click', () => toggleMemStress(true))
  $('sysmonMemStressStop')?.addEventListener('click', () => toggleMemStress(false))
  $('sysmonPawnIoBtn')?.addEventListener('click', async (e) => {
    // 下載 → 驗簽 → 提權靜默安裝，全在 main；這裡只負責讓使用者知道還在跑
    const btn = e.currentTarget
    btn.disabled = true
    btn.textContent = '安裝中…'
    const noteText = $('sysmonSensorNoteText')
    if (noteText) noteText.textContent = '正在下載並安裝 PawnIO 核心驅動，過程中會要求一次系統管理員授權…'
    const res = await electronAPI.sysmon.installPawnIo()
    if (res?.ok) {
      btn.classList.add('hidden')
      showSensorNote(res.data.sensors)
      if (state.subtab === 'hardware') renderSpecs()
      return
    }
    btn.disabled = false
    btn.textContent = '重試自動安裝'
    if (noteText) noteText.textContent = res?.error?.message || '自動安裝失敗，請改由官方網站手動安裝。'
    $('sysmonPawnIoPageBtn')?.classList.remove('hidden')
  })
  $('sysmonPawnIoPageBtn')?.addEventListener('click', () => electronAPI.sysmon.openPawnIoPage())

  $('sysmonGpuLoad')?.addEventListener('input', (e) => {
    const out = $('sysmonGpuLoadOut')
    if (out) out.textContent = e.target.value
  })
  $('sysmonVram')?.addEventListener('input', (e) => {
    const out = $('sysmonVramOut')
    if (out) out.textContent = `${e.target.value} MB`
  })
  $('sysmonStressStart')?.addEventListener('click', startStress)
  $('sysmonStressStop')?.addEventListener('click', () => stopStress())

  $('sysmonBenchStart')?.addEventListener('click', runBench)
  $('sysmonBenchStop')?.addEventListener('click', () => electronAPI.sysmon.cancelDiskBench())

  // 視窗被藏起來（縮到系統匣／被完全遮住）時停掉取樣：那條會開 PowerShell，常駐著等於整天在跑
  document.addEventListener('visibilitychange', () => {
    if (!state.active) return
    if (document.hidden) electronAPI.sysmon.stop()
    else electronAPI.sysmon.start(state.intervalKey)
  })

  renderHead()
  initCustomSelects(document.getElementById('page-sysmon'))

  // 執行緒滑桿的上限是這台機器的邏輯核心數（main 也會夾一次，這裡只是別讓使用者拉到沒意義的數字）
  const threads = $('sysmonCpuThreads')
  if (threads) {
    const cores = Math.max(1, navigator.hardwareConcurrency || 4)
    threads.max = String(cores)
    threads.value = String(cores)
    const out = $('sysmonCpuThreadsOut')
    if (out) out.textContent = String(cores)
  }

  Promise.all([
    electronAPI.store.get('sysmonInterval', 'normal'),
    electronAPI.store.get('sysmonSort', 'cpu:desc'),
    electronAPI.store.get('sysmonSensors', true)
  ]).then(([interval, sort, sensorsAuto]) => {
    state.sensorsAuto = sensorsAuto !== false
    state.intervalKey = ['fast', 'normal', 'slow'].includes(interval) ? interval : 'normal'
    const select = $('sysmonInterval')
    if (select) {
      select.value = state.intervalKey
        syncCustomSelects()
    }
    const [key, dir] = String(sort || '').split(':')
    if (PICK[key]) {
      state.sortKey = key
      state.sortDir = dir === 'asc' ? 'asc' : 'desc'
      updateHeadSort()
    }
    if (state.active) {
      electronAPI.sysmon.start(state.intervalKey)
      if (state.sensorsAuto) enableSensors()
    }
  })
}

/**
 * 啟用完整感測器。**預設是開的**：每次 App 啟動第一次進這一頁會走一次 UAC，
 * 因為 sidecar 是獨立的提權程序，App 重開它就不在了。
 * 使用者在 UAC 按「否」（state 'declined'）就把自動啟用關掉——同一個提示連跳兩天很煩，
 * 之後改由旁邊那顆按鈕手動啟用。
 */
async function enableSensors() {
  if (sensorsInFlight) return
  sensorsInFlight = true
  showSensorNote({ state: 'starting' })
  try {
    const res = await electronAPI.sysmon.enableSensors()
    const status = res?.ok ? res.data : { state: 'blocked', message: '無法啟用完整感測器。' }
    showSensorNote(status)
    if (status.state === 'declined' && state.sensorsAuto) {
      state.sensorsAuto = false
      electronAPI.store.set('sysmonSensors', false)
    }
    // 感測器一進來就重畫，溫度那幾區才會立刻出現
    if (state.subtab === 'overview') renderBlocks()
  } finally {
    sensorsInFlight = false
  }
}

/** 自動啟用與手動按鈕可能同時發生（進頁 + 手滑），合併成一次 */
let sensorsInFlight = false

export function refreshSysmonPage() {
  initSysmonPage()
  state.active = true
  if (!unsubscribe) {
    unsubscribe = electronAPI.sysmon.onEvent((payload) => {
      if (payload.type === 'sample') onSample(payload.data)
      else if (payload.type === 'error') showError(payload.data?.message || '')
      else if (payload.type === 'benchProgress') {
        showBenchResult(`${payload.data.phase === 'write' ? '寫入' : '讀取'}中… ${payload.data.percent}% · ${payload.data.mbPerSec.toFixed(1)} MB/s`)
      }
    })
  }
  electronAPI.sysmon.start(state.intervalKey)
  loadInventory()
  // 壓力測試的真相在 main（離開分頁時被停掉了），按鈕要跟它對齊而不是各記一份
  electronAPI.sysmon.stressStatus().then((res) => {
    if (!res?.ok) return
    const cpu = $('sysmonCpuStressStart')
    const cpuStop = $('sysmonCpuStressStop')
    const mem = $('sysmonMemStressStart')
    const memStop = $('sysmonMemStressStop')
    if (cpu) cpu.disabled = res.data.cpu.running
    if (cpuStop) cpuStop.disabled = !res.data.cpu.running
    if (mem) mem.disabled = res.data.memory.running
    if (memStop) memStop.disabled = !res.data.memory.running
    // 記憶體滑桿的上下限跟著這台機器走（跟執行緒滑桿同一個道理）：
    // 上限是總記憶體，預設放在「現在吃得下的最大值」，按下開始就是真的滿載
    const size = /** @type {HTMLInputElement|null} */ ($('sysmonMemSize'))
    if (size && !res.data.memory.running) {
      size.max = String(Math.max(1, res.data.memory.totalGb))
      size.value = String(Math.max(1, Math.min(res.data.memory.maxGb, res.data.memory.totalGb)))
      const out = $('sysmonMemSizeOut')
      if (out) out.textContent = `${size.value} GB`
    }
  })
  electronAPI.sysmon.status().then((res) => {
    if (!res?.ok) return
    showSensorNote(res.data.sensors)
    // 沒開過就自己開一次：使用者要的是「進來就看得到溫度」，不是每次都先按一顆鈕
    if (state.sensorsAuto && res.data.sensors?.state === 'off') enableSensors()
  })
}

export function cooldownSysmonPage() {
  if (!state.active) return
  state.active = false
  stopStress()
  hideFanPanel()
  // 壓力測試跑在 main，離開分頁不主動收的話它會在背景一直燒到 5 分鐘上限
  electronAPI.sysmon.cpuStress(false, 1)
  electronAPI.sysmon.memStress(false, 1)
  electronAPI.sysmon.stop()
}
