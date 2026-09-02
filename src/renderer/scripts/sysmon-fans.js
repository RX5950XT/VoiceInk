/**
 * VoiceInk — 系統監控 ▸ 風扇控制。
 *
 * 兩件事：
 *  1. **通用機殼示意圖（等角斜上方視角）**：主機板只給得出接頭名稱（`System Fan #1`），
 *     給不出實體位置，所以畫的是通用槽位。開機第一次由接頭編號猜一個預設位置
 *     （空的示意圖等於在請使用者憑空想像），再配一顆「識別」按鈕把那條拉到全速幾秒，
 *     用**聽的**認出來之後自己改。
 *  2. **轉速曲線編輯器**：X 是來源值（溫度或使用率，都是 0~100 所以同一個元件通吃）、
 *     Y 是 PWM 百分比。**Y 不是 RPM**：能寫進晶片的只有 PWM，標成 RPM 是騙人；
 *     實測轉速另外以文字顯示。
 *
 * 版面：左邊示意圖、右邊通道清單，點一列**就地向下展開**設定（`#fanEditor` 只有一份，
 * 由 JS 搬進被選中那一列的容器裡——兩份編輯器等於兩份狀態）。
 *
 * 每秒重畫一次，但**拖曳中不重畫編輯器**（不然手上的點會被伺服器狀態彈回去）。
 * SVG 只建一次，之後只改 textContent／class／transform（比照總覽區塊那條教訓）。
 */

import { electronAPI } from './app.js'
import { initCustomSelects, syncCustomSelects } from './custom-select.js'

const POLL_MS = 1000
/** 曲線圖的內部座標系；四邊留白不對稱（左邊要放刻度、下面要放單位） */
const PLOT_W = 360
const PLOT_H = 208
const PAD = { l: 32, r: 14, t: 14, b: 26 }
const MAX_POINTS = 10

/**
 * 扇葉動畫是**慢動作**：700 RPM 換算成畫面是每秒 11.7 次，在 60fps 下只會糊成一團。
 * 週期跟真實 RPM 成正比（越快轉越快、停轉就不動），但整體放慢 SPIN_SCALE 倍。
 */
const SPIN_SCALE = 6

// ===== 等角投影 =====
// 世界座標：x = 深度（0 背板 → D 前面板）、y = 寬度（0 主機板托盤 → W 側板）、z = 高度。
// 視點在左前上方，近側板不畫，所以看得進機殼內部。
const AX = { x: [0.87, 0.5], y: [-0.87, 0.5], z: [0, -1] }
const ORIGIN = [56, 152]
const BOX = { d: 110, w: 60, h: 140 }

/** 世界座標 → 螢幕座標 */
const P = (x, y, z) => [
  ORIGIN[0] + AX.x[0] * x + AX.y[0] * y,
  ORIGIN[1] + AX.x[1] * x + AX.y[1] * y + AX.z[1] * z
]
const pts = (list) => list.map((p) => P(p[0], p[1], p[2]).map((n) => n.toFixed(1)).join(',')).join(' ')

/**
 * 風扇所在平面的兩個單位向量。`det > 0` 才不會左右鏡像（鏡像的話扇葉會倒著轉）。
 * `tray` 是主機板托盤（y = 0 那面，法線朝向觀看者）。
 */
const NEG = (v) => [-v[0], -v[1]]
const PLANES = {
  panel: { u: AX.y, v: AX.z },      // 前／後面板（x 固定）
  deck: { u: AX.x, v: AX.y },       // 頂／底（z 固定）
  tray: { u: NEG(AX.x), v: AX.z }   // 主機板托盤與側板（y 固定）
}

/**
 * 通用槽位在機殼裡的位置。id 要跟 main 的 `fans.js` SLOTS 對得上。
 * 不是任何一張真主機板的實圖——只是讓人對得上「前／後／上／下」的方位。
 * **投影之後不可以互相疊到**（等角投影會把 z 與 x+y 壓在同一個螢幕軸上，
 * 世界座標看起來離很遠的兩顆在畫面上可能只差十幾個單位）：
 * 動座標之後拿 `scratchpad/geom.js` 那套「兩兩距離 ≥ r1+r2+4」重算一次。
 */
const SLOT_3D = {
  'top-1': { p: [28, 30, 140], plane: 'deck', r: 10, code: '上1', la: 'a' },
  'top-2': { p: [58, 30, 140], plane: 'deck', r: 10, code: '上2', la: 'a' },
  pump: { p: [88, 30, 140], plane: 'deck', r: 10, code: '泵', la: 'a' },
  rear: { p: [0, 30, 112], plane: 'panel', r: 9, code: '後', la: 'l' },
  'front-1': { p: [110, 30, 112], plane: 'panel', r: 11, code: '前1', la: 'l' },
  'front-2': { p: [110, 30, 70], plane: 'panel', r: 11, code: '前2', la: 'l' },
  'front-3': { p: [110, 30, 28], plane: 'panel', r: 11, code: '前3', la: 'l' },
  bottom: { p: [58, 30, 0], plane: 'deck', r: 10, code: '底', la: 'b' },
  side: { p: [52, 60, 62], plane: 'tray', r: 10, code: '側', la: 'l' },
  cpu: { p: [34, 8, 88], plane: 'tray', r: 10, code: 'CPU', la: 'l' },
  'cpu-opt': { p: [64, 8, 96], plane: 'tray', r: 7, code: 'CPU2', la: 'a' },
  gpu: { p: [42, 10, 56], plane: 'tray', r: 7.5, code: 'GPU', la: 'l' },
  pch: { p: [86, 8, 26], plane: 'tray', r: 6, code: 'PCH', la: 'b' }
}

const state = {
  inited: false,
  timer: 0,
  /** @type {HTMLElement|null} 唯一的那份編輯器（會被搬進展開的那一列） */ editorNode: null,
  /** @type {any} */ data: null,
  /** null = 還沒選過（第一次自動展開第一列）；'' = 使用者自己收起來的，不可以再自動展開 */
  /** @type {string|null} */ selectedId: null,
  /** 拖曳中：這一輪不要重畫編輯器 */
  dragging: false,
  chassisBuilt: false,
  taskStatus: null,
  busy: false
}

const $ = (id) => document.getElementById(id)
const svgEl = (name, attrs = {}) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v))
  return node
}
const el = (tag, className = '', text = '') => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}
const fmt = (value, unit = '') => (
  value === null || value === undefined || Number.isNaN(Number(value)) ? '—' : `${Math.round(Number(value))}${unit}`
)

// ===== 機殼示意圖 =====

/** 機殼外殼：半透明的玻璃面 + 描邊。半透明是為了不用處理遮擋順序（風扇一律畫在最上層）。 */
function buildShell(svg) {
  const { d, w, h } = BOX
  const faces = [
    ['fan-face fan-face-tray', [[0, 0, 0], [d, 0, 0], [d, 0, h], [0, 0, h]]],
    ['fan-face', [[0, 0, 0], [0, w, 0], [0, w, h], [0, 0, h]]],
    ['fan-face fan-face-floor', [[0, 0, 0], [d, 0, 0], [d, w, 0], [0, w, 0]]],
    ['fan-face fan-face-front', [[d, 0, 0], [d, w, 0], [d, w, h], [d, 0, h]]]
  ]
  for (const [cls, quad] of faces) svg.append(svgEl('polygon', { class: cls, points: pts(quad) }))

  // 主機板與板上的大零件（CPU 座、顯示卡、晶片組），畫在托盤面上稍微往外浮一點，才有厚度感。
  // **不另外印文字**：槽位代碼本來就叫 CPU／GPU／PCH，印兩次只會互相疊到。
  const flat = (y, x1, z1, x2, z2, cls) => svgEl('polygon', {
    class: cls, points: pts([[x1, y, z1], [x2, y, z1], [x2, y, z2], [x1, y, z2]])
  })
  svg.append(
    flat(2, 14, 16, 96, 126, 'fan-board'),
    flat(5, 24, 74, 54, 118, 'fan-part'),
    flat(7, 20, 46, 92, 66, 'fan-part'),
    flat(5, 78, 18, 98, 36, 'fan-part')
  )
  // 機殼骨架：頂面開口與近側板的邊，補上「這是個盒子」的線索
  const edge = (a, b) => svgEl('polyline', { class: 'fan-edge', points: pts([a, b]) })
  svg.append(
    svgEl('polygon', { class: 'fan-edge fan-edge-top', points: pts([[0, 0, h], [d, 0, h], [d, w, h], [0, w, h]]) }),
    edge([d, w, 0], [d, w, h]), edge([0, w, 0], [d, w, 0]), edge([0, w, 0], [0, w, h])
  )
}

/** 只建一次。之後每輪只改文字與 class——每秒重建 SVG 會讓點不到、也會閃。 */
function buildChassis() {
  const host = $('fanChassis')
  if (!host || state.chassisBuilt) return
  host.textContent = ''
  const svg = svgEl('svg', {
    viewBox: '0 0 158 252', class: 'fan-chassis-svg', role: 'group',
    'aria-label': '機殼與主機板示意圖'
  })
  buildShell(svg)

  for (const [slot, spec] of Object.entries(SLOT_3D)) {
    const plane = PLANES[spec.plane]
    const [px, py] = P(spec.p[0], spec.p[1], spec.p[2])
    const group = svgEl('g', { class: 'fan-slot', 'data-slot': slot, tabindex: '0', role: 'button' })
    const disc = svgEl('g', {
      class: 'fan-disc',
      transform: `matrix(${(plane.u[0] * spec.r).toFixed(3)} ${(plane.u[1] * spec.r).toFixed(3)} `
        + `${(plane.v[0] * spec.r).toFixed(3)} ${(plane.v[1] * spec.r).toFixed(3)} ${px.toFixed(1)} ${py.toFixed(1)})`
    })
    // 外框同時是點擊範圍（環太細了點不到）
    disc.append(
      svgEl('rect', { class: 'fan-frame', x: -1.16, y: -1.16, width: 2.32, height: 2.32, rx: 0.28 }),
      svgEl('circle', { r: 1, class: 'fan-slot-ring' })
    )
    const blades = svgEl('g', { class: 'fan-blades' })
    for (let i = 0; i < 5; i += 1) {
      blades.append(svgEl('path', {
        d: 'M0,0 Q0.46,-0.26 0.72,-0.60 Q0.26,-0.72 0,-0.27 Z', transform: `rotate(${i * 72})`
      }))
    }
    disc.append(blades, svgEl('circle', { r: 0.17, class: 'fan-hub' }))
    group.append(disc)
    // 標籤只放**短代碼**：十三個接頭全名印上去必定互相疊到（實測 System Fan #1~#5
    // 截斷後長得一模一樣，等於沒有資訊）。全名走 <title> 與 aria-label。
    // 擺放方向逐槽指定（`la`）：前面板那一排上下相鄰，標籤一律往內側放才不會壓到下一顆。
    const place = {
      a: [px, py - spec.r - 3.5, 'middle'],
      b: [px, py + spec.r + 6.5, 'middle'],
      l: [px - spec.r - 3, py + 2, 'end'],
      r: [px + spec.r + 3, py + 2, 'start']
    }[spec.la || 'b']
    const label = svgEl('text', {
      class: 'fan-slot-label', 'text-anchor': place[2],
      x: place[0].toFixed(1), y: place[1].toFixed(1)
    })
    label.textContent = spec.code
    const title = svgEl('title')
    group.append(label, title)
    svg.append(group)
  }
  host.append(svg)
  state.chassisBuilt = true
}

function updateChassis(data) {
  const bySlot = new Map()
  for (const channel of data.channels) if (channel.slot && !bySlot.has(channel.slot)) bySlot.set(channel.slot, channel)

  for (const group of document.querySelectorAll('#fanChassis .fan-slot')) {
    const slot = /** @type {SVGGElement} */ (group).dataset.slot || ''
    const channel = bySlot.get(slot)
    const slotLabel = data.slots.find((s) => s.id === slot)?.label || slot
    const blades = /** @type {SVGGElement} */ (group.querySelector('.fan-blades'))
    group.classList.toggle('is-empty', !channel)
    group.classList.toggle('is-selected', Boolean(channel) && channel.id === state.selectedId)
    group.classList.toggle('is-panic', Boolean(channel?.panic))
    const description = channel
      ? `${slotLabel}：${channel.label || channel.name}，${fmt(channel.rpm)} RPM`
      : `${slotLabel}：未指派`
    const title = group.querySelector('title')
    if (title && title.textContent !== description) title.textContent = description
    group.setAttribute('aria-label', description)
    // 慢動作，但週期跟真實 RPM 成正比。停轉就不要動（動畫跑著等於在說謊）
    const rpm = Number(channel?.rpm) || 0
    if (blades) {
      blades.style.animationDuration = rpm > 0 ? `${Math.max(0.25, (60 / rpm) * SPIN_SCALE).toFixed(2)}s` : ''
      blades.classList.toggle('is-spinning', rpm > 0)
    }
  }
}

// ===== 通道清單（點一列就地展開） =====

const modeText = (channel) => (
  channel.mode === 'curve' ? '曲線'
    : (channel.mode === 'fixed' ? `固定 ${channel.fixed}%` : 'BIOS')
)

/** 清單順序＝示意圖上的槽位順序；沒指派的排最後，同組再依接頭名稱的自然序。 */
function sortChannels(data) {
  const order = new Map(data.slots.map((s, i) => [s.id, i]))
  return data.channels.slice().sort((a, b) => {
    const oa = order.has(a.slot) ? order.get(a.slot) : 99
    const ob = order.has(b.slot) ? order.get(b.slot) : 99
    if (oa !== ob) return oa - ob
    return String(a.name).localeCompare(String(b.name), 'en', { numeric: true })
  })
}

/**
 * 清單每秒都要更新 RPM，但**不重建 DOM**：重建會把鍵盤焦點與選取狀態一起洗掉
 * （比照總覽區塊那條教訓）。只有「有哪幾條、模式是什麼、展開哪一列」變了才重畫。
 */
function renderList(data) {
  const host = $('fanList')
  // 編輯器只有一份、被搬進展開的那一列。**搬走之後不可以留在 DOM 外面**
  // （`getElementById` 找不到脫離文件的節點，下一輪就再也找不回來了），
  // 所以沒有展開任何一列時它一樣掛在清單底下，只是 hidden。
  const editor = state.editorNode || (state.editorNode = $('fanEditor'))
  if (!host || !editor) return
  const channels = sortChannels(data)
  const signature = channels.map((c) => `${c.id}|${c.label}|${c.slot}|${c.mode}|${c.fixed}`).join('~')
    + `~${state.selectedId}~${channels.length}`
  if (host.dataset.signature !== signature) {
    host.dataset.signature = signature
    host.textContent = ''
    if (!channels.length) {
      editor.hidden = true
      host.append(el('p', 'fan-empty', data.available
        ? '這台機器上沒有偵測到可以調整的風扇通道。桌機主機板（ITE／Nuvoton／Fintek）與獨立顯示卡通常可以；筆記型電腦幾乎都由廠商的 EC 控制，沒有公開介面。'
        : '請先在上方啟用感測器，才讀得到風扇通道。'), editor)
      return
    }
    for (const channel of channels) {
      const item = el('div', 'fan-item')
      item.dataset.id = channel.id
      const open = channel.id === state.selectedId
      item.classList.toggle('is-open', open)
      const row = el('button', 'fan-row')
      row.type = 'button'
      row.dataset.id = channel.id
      row.setAttribute('aria-expanded', open ? 'true' : 'false')
      const slotLabel = data.slots.find((s) => s.id === channel.slot)?.label || '未指派'
      row.append(
        el('span', 'fan-row-caret', '›'),
        el('span', 'fan-row-name', channel.label || channel.name),
        el('span', 'fan-row-slot', slotLabel),
        el('span', 'fan-row-rpm', ''),
        el('span', 'fan-row-pwm', ''),
        el('span', `fan-row-mode${channel.mode === 'bios' ? '' : ' is-on'}`, modeText(channel))
      )
      item.append(row)
      if (open) item.append(editor)
      host.append(item)
    }
    if (!host.contains(editor)) {
      editor.hidden = true
      host.append(editor)
    }
  }
  for (const channel of channels) {
    const row = host.querySelector(`.fan-row[data-id="${CSS.escape(channel.id)}"]`)
    if (!row) continue
    const rpm = row.querySelector('.fan-row-rpm')
    const pwm = row.querySelector('.fan-row-pwm')
    if (rpm) rpm.textContent = channel.rpm === null ? '無訊號' : `${fmt(channel.rpm)} RPM`
    if (pwm) pwm.textContent = channel.applied === null ? 'BIOS' : `${fmt(channel.applied)}%`
  }
}

// ===== 曲線編輯器 =====

const toPx = ([x, y]) => [
  PAD.l + (x / 100) * (PLOT_W - PAD.l - PAD.r),
  PLOT_H - PAD.b - (y / 100) * (PLOT_H - PAD.t - PAD.b)
]

/** 指標座標 → 資料座標（0~100）。SVG 是等比縮放的，所以一個比例就夠。 */
function toData(svg, event) {
  const rect = svg.getBoundingClientRect()
  const scale = rect.width / PLOT_W
  const px = (event.clientX - rect.left) / scale
  const py = (event.clientY - rect.top) / scale
  const x = ((px - PAD.l) / (PLOT_W - PAD.l - PAD.r)) * 100
  const y = ((PLOT_H - PAD.b - py) / (PLOT_H - PAD.t - PAD.b)) * 100
  return [Math.round(Math.min(100, Math.max(0, x))), Math.round(Math.min(100, Math.max(0, y)))]
}

function buildCurve(channel, source) {
  const svg = svgEl('svg', {
    viewBox: `0 0 ${PLOT_W} ${PLOT_H}`, class: 'fan-curve', role: 'group',
    'aria-label': '轉速曲線，可拖曳調整'
  })
  const [x0, y0] = toPx([0, 0])
  const [x1, y1] = toPx([100, 100])
  svg.append(svgEl('rect', { class: 'fan-plot-bg', x: x0, y: y1, width: x1 - x0, height: y0 - y1, rx: 4 }))
  for (let i = 0; i <= 4; i += 1) {
    const [, gy] = toPx([0, i * 25])
    const [gx] = toPx([i * 25, 0])
    svg.append(
      svgEl('line', { x1: x0, y1: gy, x2: x1, y2: gy, class: 'fan-grid' }),
      svgEl('line', { x1: gx, y1: y1, x2: gx, y2: y0, class: 'fan-grid' })
    )
    const yTick = svgEl('text', { x: x0 - 6, y: gy + 3.5, class: 'fan-tick', 'text-anchor': 'end' })
    yTick.textContent = `${i * 25}%`
    const xTick = svgEl('text', { x: gx, y: y0 + 13, class: 'fan-tick', 'text-anchor': 'middle' })
    xTick.textContent = `${i * 25}${source?.unit || ''}`
    svg.append(yTick, xTick)
  }
  // 下限那條線：低於它的地方是拉不下去的
  const floorY = toPx([0, channel.minPwm])[1]
  svg.append(
    svgEl('rect', { class: 'fan-floor-zone', x: x0, y: floorY, width: x1 - x0, height: Math.max(0, y0 - floorY) }),
    svgEl('line', { x1: x0, x2: x1, y1: floorY, y2: floorY, class: 'fan-floor' })
  )
  svg.append(
    svgEl('polygon', { class: 'fan-curve-area', points: '' }),
    svgEl('polyline', { class: 'fan-curve-line', points: '' }),
    svgEl('line', { class: 'fan-live-line', x1: -99, x2: -99, y1: y1, y2: y0 }),
    svgEl('circle', { r: 5, class: 'fan-live-dot', cx: -99, cy: -99 })
  )
  return svg
}

function paintCurve(svg, channel) {
  const points = channel.points
  const screen = points.map((p) => toPx(p))
  const [x0, y0] = toPx([0, 0])
  const [x1] = toPx([100, 0])
  svg.querySelector('.fan-curve-line')?.setAttribute('points',
    [[x0, screen[0][1]], ...screen, [x1, screen[screen.length - 1][1]]].map((p) => p.join(',')).join(' '))
  svg.querySelector('.fan-curve-area')?.setAttribute('points',
    [[x0, y0], [x0, screen[0][1]], ...screen, [x1, screen[screen.length - 1][1]], [x1, y0]]
      .map((p) => p.join(',')).join(' '))

  for (const old of svg.querySelectorAll('.fan-point')) old.remove()
  points.forEach((point, index) => {
    const [cx, cy] = screen[index]
    svg.append(svgEl('circle', {
      cx, cy, r: 6, class: 'fan-point', 'data-index': index, tabindex: '0', role: 'slider',
      'aria-label': `第 ${index + 1} 個點`, 'aria-valuetext': `${point[0]} → ${point[1]}%`
    }))
  })

  const dot = svg.querySelector('.fan-live-dot')
  const line = svg.querySelector('.fan-live-line')
  const value = channel.sourceValue
  const pwm = channel.applied === null ? channel.pwm : channel.applied
  if (dot && line && value !== null && pwm !== null && pwm !== undefined) {
    const [cx, cy] = toPx([Number(value), Number(pwm)])
    dot.setAttribute('cx', String(cx))
    dot.setAttribute('cy', String(cy))
    line.setAttribute('x1', String(cx))
    line.setAttribute('x2', String(cx))
  } else if (dot && line) {
    dot.setAttribute('cx', '-99')
    line.setAttribute('x1', '-99')
    line.setAttribute('x2', '-99')
  }
}

/** 送出前先在本地夾住：X 不可越過左右鄰居，Y 不可低於下限 */
function movePoint(channel, index, x, y) {
  const points = channel.points.map((p) => [p[0], p[1]])
  const lo = index === 0 ? 0 : points[index - 1][0] + 1
  const hi = index === points.length - 1 ? 100 : points[index + 1][0] - 1
  points[index] = [
    Math.min(Math.max(x, lo), Math.max(lo, hi)),
    Math.min(100, Math.max(channel.minPwm, y))
  ]
  return points
}

function bindCurve(svg, channel, readout) {
  const commit = (points) => {
    channel.points = points
    paintCurve(svg, channel)
  }
  const save = () => saveChannel(channel.id, { points: channel.points })
  const tell = (point) => {
    if (readout) readout.textContent = point ? `${point[0]} → ${point[1]}%` : ''
  }

  svg.addEventListener('pointerdown', (event) => {
    const target = /** @type {Element} */ (event.target)
    const point = target.closest('.fan-point')
    if (point) {
      const index = Number(point.getAttribute('data-index'))
      state.dragging = true
      svg.classList.add('is-dragging')
      const move = (e) => {
        const [x, y] = toData(svg, e)
        const points = movePoint(channel, index, x, y)
        tell(points[index])
        commit(points)
      }
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        state.dragging = false
        svg.classList.remove('is-dragging')
        tell(null)
        save()
      }
      // 掛在 window：setPointerCapture 可能被隱式釋放（額度卡片那條教訓）
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      event.preventDefault()
      return
    }
    // 空白處：新增一個點
    if (channel.points.length >= MAX_POINTS) return
    const [x, y] = toData(svg, event)
    const points = channel.points.concat([[x, Math.max(channel.minPwm, y)]])
      .sort((a, b) => a[0] - b[0])
      .filter((p, i, list) => i === 0 || p[0] !== list[i - 1][0])
    commit(points)
    save()
  })

  svg.addEventListener('keydown', (event) => {
    const point = /** @type {Element} */ (event.target).closest?.('.fan-point')
    if (!point) return
    const index = Number(point.getAttribute('data-index'))
    const step = event.shiftKey ? 5 : 1
    const [x, y] = channel.points[index]
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (channel.points.length <= 2) return
      commit(channel.points.filter((_, i) => i !== index))
      save()
      event.preventDefault()
      return
    }
    const deltas = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step]
    }
    const delta = deltas[event.key]
    if (!delta) return
    commit(movePoint(channel, index, x + delta[0], y + delta[1]))
    save()
    event.preventDefault()
    // 移動後 DOM 被重畫，焦點要跟著回到同一個點上
    /** @type {SVGElement|null} */ (svg.querySelector(`.fan-point[data-index="${index}"]`))?.focus()
  })
}

// ===== 編輯器 =====

function chip(label, value) {
  const node = el('span', 'fan-chip')
  node.append(el('span', 'fan-chip-key', label), el('span', 'fan-chip-val', value))
  return node
}

function renderEditor(data) {
  const host = $('fanEditor')
  if (!host || state.dragging) return
  const channel = data.channels.find((c) => c.id === state.selectedId)
  if (!channel) {
    host.hidden = true
    host.textContent = ''
    return
  }
  host.hidden = false
  host.textContent = ''
  const source = data.sources.find((s) => s.id === channel.source)

  const head = el('div', 'fan-editor-head')
  const chips = el('div', 'fan-chips')
  chips.append(
    chip('接頭', `${channel.hardware} · ${channel.name}`),
    chip('轉速', channel.rpm === null ? '無訊號' : `${fmt(channel.rpm)} RPM`),
    chip('輸出', channel.applied === null ? 'BIOS 控制中' : `${fmt(channel.applied)}%`)
  )
  if (channel.sourceValue !== null) {
    chips.append(chip(source?.label || '來源', `${fmt(channel.sourceValue)}${source?.unit || ''}`))
  }
  const identify = el('button', 'btn btn-secondary btn-sm', channel.identifying ? '轉動中…' : '識別')
  identify.type = 'button'
  identify.dataset.action = 'identify'
  identify.disabled = channel.identifying
  identify.title = '把這條拉到全速幾秒，用聽的就知道是哪一顆'
  head.append(chips, identify)
  host.append(head)

  if (channel.panic) {
    host.append(el('p', 'fan-panic', `溫度超過 ${data.panicTemp}°C，已強制全速。`))
  }

  const grid = el('div', 'fan-fields')
  grid.append(field('位置', selectFor('slot', channel.slot, [{ id: '', label: '未指派' }, ...data.slots])))
  const label = el('input', 'input fan-input')
  label.type = 'text'
  label.maxLength = 24
  label.value = channel.label
  label.placeholder = channel.name
  label.dataset.field = 'label'
  grid.append(field('名稱', label))

  const modes = el('div', 'fan-modes')
  modes.setAttribute('role', 'group')
  for (const [id, text] of [['bios', 'BIOS 自動'], ['fixed', '固定轉速'], ['curve', '溫度曲線']]) {
    const button = el('button', `fan-mode${channel.mode === id ? ' is-on' : ''}`, text)
    button.type = 'button'
    button.dataset.mode = id
    button.setAttribute('aria-pressed', channel.mode === id ? 'true' : 'false')
    modes.append(button)
  }
  grid.append(field('模式', modes))

  if (channel.mode !== 'bios') {
    const floor = el('input', 'input fan-input fan-input-num')
    floor.type = 'number'
    floor.min = String(data.minFloor)
    floor.max = '100'
    floor.value = String(channel.minPwm)
    floor.dataset.field = 'minPwm'
    grid.append(field('轉速下限', floor, `不得低於 ${data.minFloor}%。App 被強制關閉時風扇會停在最後的設定值，下限就是那時候的保險。`))
  }
  host.append(grid)

  if (channel.mode === 'fixed') {
    const range = el('input', 'fan-range')
    range.type = 'range'
    range.min = String(channel.minPwm)
    range.max = '100'
    range.value = String(channel.fixed)
    range.dataset.field = 'fixed'
    const out = el('span', 'fan-range-out', `${channel.fixed}%`)
    const wrap = el('div', 'fan-range-wrap')
    wrap.append(range, out)
    host.append(field('轉速', wrap))
  }

  if (channel.mode === 'curve') {
    const plot = el('section', 'fan-plot')
    const plotHead = el('div', 'fan-plot-head')
    const sourceField = field('曲線來源', selectFor('source', channel.source, data.sources))
    sourceField.classList.add('fan-plot-source')
    const readout = el('span', 'fan-plot-readout')
    plotHead.append(sourceField, readout)
    plot.append(plotHead)

    const svg = buildCurve(channel, source)
    plot.append(svg)
    plot.append(el('p', 'fan-axis-note',
      `橫軸 ${source?.label || ''}（${source?.unit || ''}）、直軸風扇輸出（PWM %，不是 RPM）。`
      + '拖曳圓點調整、空白處點一下新增、選中後按 Delete 刪除；虛線以下是轉速下限，拉不進去。'))
    host.append(plot)
    paintCurve(svg, channel)
    bindCurve(svg, channel, readout)
  }

  initCustomSelects(host)
  syncCustomSelects(host)
}

function field(labelText, control, hint = '') {
  const wrap = el('label', 'fan-field')
  wrap.append(el('span', 'fan-field-label', labelText))
  wrap.append(control)
  if (hint) wrap.append(el('span', 'fan-field-hint', hint))
  return wrap
}

function selectFor(fieldName, value, options) {
  const select = el('select', 'select fan-select')
  select.dataset.field = fieldName
  for (const option of options) {
    const node = el('option', '', option.label)
    node.value = option.id
    if (option.id === value) node.selected = true
    select.append(node)
  }
  return select
}

// ===== 上方狀態列與提示 =====

function renderBar(data) {
  const toggle = /** @type {HTMLInputElement|null} */ ($('fanEnabled'))
  if (toggle && document.activeElement !== toggle) toggle.checked = data.enabled
  const taken = data.channels.filter((c) => c.applied !== null).length
  const status = $('fanStatus')
  if (status) {
    status.textContent = data.enabled
      ? `已接管 ${taken}/${data.channels.length} 條`
      : `偵測到 ${data.channels.length} 條可控通道`
  }
  const taskBtn = $('fanTaskBtn')
  if (taskBtn) taskBtn.hidden = !(state.taskStatus && !state.taskStatus.installed && state.taskStatus.canInstall)

  const notices = $('fanNotices')
  if (!notices) return
  const lines = []
  if (data.crashedLastRun) {
    lines.push(['warn', '上次結束時風扇還在手動模式。手動 PWM 是留在晶片裡的，事後也還原不回去——'
      + '重新開機才會回到 BIOS 的轉速曲線。'])
  }
  if (data.enabled && !data.available) {
    lines.push(['warn', '感測器目前沒有連線，風扇暫時交由 BIOS 控制。'])
  }
  if (state.taskStatus && !state.taskStatus.installed) {
    lines.push(['info', state.taskStatus.canInstall
      ? '每次啟動感測器都會跳一次系統管理員確認。按右上角「建立排程工作」就可以免確認啟動，開機自啟動時也才接得了風扇。'
      : state.taskStatus.reason])
  }
  if (data.enabled) {
    lines.push(['info', 'App 若被強制關閉（工作管理員結束、當機、斷電），風扇會停在最後的轉速；'
      + '重新開機即回復 BIOS 曲線。每條通道的「轉速下限」就是為此存在的保險。'])
  }
  const signature = lines.map((l) => l[1]).join('|')
  if (notices.dataset.signature === signature) return
  notices.dataset.signature = signature
  notices.textContent = ''
  for (const [kind, text] of lines) notices.append(el('p', `fan-note fan-note-${kind}`, text))
}

// ===== 資料流 =====

function saveChannel(id, patch) {
  if (state.busy) return Promise.resolve()
  state.busy = true
  return electronAPI.sysmon.fanSetChannel(id, patch)
    .then((res) => { if (res?.ok) render(res.data) })
    .finally(() => { state.busy = false })
}

function render(data) {
  state.data = data
  if (state.selectedId === null && data.channels.length) state.selectedId = sortChannels(data)[0].id
  buildChassis()
  updateChassis(data)
  renderBar(data)
  renderList(data)
  renderEditor(data)
}

function poll() {
  electronAPI.sysmon.fanList().then((res) => { if (res?.ok) render(res.data) })
}

// ===== 事件 =====

function onEditorInput(event) {
  const target = /** @type {HTMLInputElement|HTMLSelectElement} */ (event.target)
  const fieldName = target.dataset?.field
  if (!fieldName || !state.selectedId) return
  if (fieldName === 'fixed') {
    const out = target.parentElement?.querySelector('.fan-range-out')
    if (out) out.textContent = `${target.value}%`
    if (event.type === 'input') return
  }
  const value = fieldName === 'fixed' || fieldName === 'minPwm' ? Number(target.value) : target.value
  saveChannel(state.selectedId, { [fieldName]: value })
}

export function initFanPanel() {
  if (state.inited) return
  state.inited = true

  $('fanEnabled')?.addEventListener('change', (event) => {
    const on = /** @type {HTMLInputElement} */ (event.target).checked
    electronAPI.sysmon.fanEnable(on).then((res) => { if (res?.ok) render(res.data) })
  })
  $('fanResetBtn')?.addEventListener('click', () => {
    electronAPI.sysmon.fanResetAll().then((res) => { if (res?.ok) render(res.data) })
  })
  $('fanTaskBtn')?.addEventListener('click', () => {
    electronAPI.sysmon.fanTaskInstall().then((res) => {
      if (res?.ok) state.taskStatus = { ...res.data, canInstall: true, reason: '' }
      poll()
    })
  })
  // 點同一列＝收起（手風琴），點別列＝換過去
  $('fanList')?.addEventListener('click', (event) => {
    const row = /** @type {Element} */ (event.target).closest('.fan-row')
    if (!row) return
    const id = /** @type {HTMLElement} */ (row).dataset.id || ''
    state.selectedId = state.selectedId === id ? '' : id
    if (state.data) render(state.data)
  })
  const selectSlot = (node) => {
    const slot = node?.dataset?.slot
    const channel = state.data?.channels.find((c) => c.slot === slot)
    if (!channel) return
    state.selectedId = channel.id
    render(state.data)
    $('fanList')?.querySelector('.fan-item.is-open')?.scrollIntoView({ block: 'nearest' })
  }
  $('fanChassis')?.addEventListener('click', (event) => {
    selectSlot(/** @type {Element} */ (event.target).closest('.fan-slot'))
  })
  $('fanChassis')?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    selectSlot(/** @type {Element} */ (event.target).closest('.fan-slot'))
    event.preventDefault()
  })

  const editor = $('fanEditor')
  editor?.addEventListener('click', (event) => {
    const target = /** @type {Element} */ (event.target)
    const mode = target.closest('.fan-mode')
    if (mode && state.selectedId) {
      saveChannel(state.selectedId, { mode: /** @type {HTMLElement} */ (mode).dataset.mode })
      return
    }
    if (target.closest('[data-action="identify"]') && state.selectedId) {
      electronAPI.sysmon.fanIdentify(state.selectedId).then(poll)
    }
  })
  editor?.addEventListener('input', onEditorInput)
  editor?.addEventListener('change', onEditorInput)
}

export function showFanPanel() {
  initFanPanel()
  if (!state.taskStatus) {
    electronAPI.sysmon.fanTaskStatus().then((res) => {
      if (res?.ok) state.taskStatus = res.data
      if (state.data) renderBar(state.data)
    })
  }
  poll()
  if (!state.timer) state.timer = window.setInterval(poll, POLL_MS)
}

export function hideFanPanel() {
  if (!state.timer) return
  window.clearInterval(state.timer)
  state.timer = 0
}
