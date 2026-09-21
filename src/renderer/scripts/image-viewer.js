/**
 * 全視窗的大圖預覽（檔案總管按空白鍵／點右側預覽圖／右鍵「預覽」叫出來的那個）。
 *
 * 跟 Windows 的「相片」看齊的幾件事：
 * - 一進來是「整張看得到」，滾輪（Ctrl 按不按都行）縮放，放大後可以拖著移動
 * - 雙擊在「符合視窗」與「實際大小」之間切
 * - ←／→ 換同一個資料夾裡的上一張／下一張，Esc 或點黑底關掉
 *
 * 圖片走 `vi-media://` 協定（`explorer.mediaUrl`）**邊讀邊送**，不是 `data:` URI
 * ——側欄那個小預覽卡在 2MB，正是因為它把整個檔案 base64 過一次 IPC。
 *
 * DOM 一律 createElement + textContent（零 innerHTML），檔名是外部輸入。
 */

import { nextZoom, ZOOM_MIN, ZOOM_MAX } from './ws-zoom.js'

/** 縮放按鈕一下跳多少（滾輪那條走 `nextZoom`） */
const BUTTON_STEP = 1.25

/** @type {{ root: HTMLElement, img: HTMLImageElement, caption: HTMLElement, zoomLabel: HTMLElement, stage: HTMLElement } | null} */
let ui = null
/** @type {Array<{ path: string, name: string }>} */
let items = []
let index = 0
/** 0 ＝符合視窗（還沒有人手動縮放過） */
let zoom = 0
let panX = 0
let panY = 0
/** @type {((filePath: string) => Promise<{ ok?: boolean, data?: { url?: string } } | null>) | null} */
let resolveUrl = null
let loadSeq = 0

function icon(label) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'btn-icon iv-btn'
  btn.textContent = label
  return btn
}

function build() {
  const root = document.createElement('div')
  root.className = 'iv-root'
  root.tabIndex = -1

  const bar = document.createElement('div')
  bar.className = 'iv-bar'
  const caption = document.createElement('div')
  caption.className = 'iv-caption'
  const zoomLabel = document.createElement('span')
  zoomLabel.className = 'iv-zoom'
  const zoomOut = icon('－')
  zoomOut.title = '縮小（-）'
  const zoomIn = icon('＋')
  zoomIn.title = '放大（+）'
  const fitBtn = icon('⤢')
  fitBtn.title = '符合視窗（0）'
  const closeBtn = icon('✕')
  closeBtn.title = '關閉（Esc）'
  const tools = document.createElement('div')
  tools.className = 'iv-tools'
  tools.append(zoomLabel, zoomOut, zoomIn, fitBtn, closeBtn)
  bar.append(caption, tools)

  const stage = document.createElement('div')
  stage.className = 'iv-stage'
  const img = document.createElement('img')
  img.className = 'iv-img'
  img.alt = ''
  img.draggable = false
  img.addEventListener('load', applyTransform)
  stage.appendChild(img)

  const prev = icon('‹')
  prev.className = 'btn-icon iv-nav iv-prev'
  prev.title = '上一張（←）'
  const next = icon('›')
  next.className = 'btn-icon iv-nav iv-next'
  next.title = '下一張（→）'

  root.append(bar, stage, prev, next)
  document.body.appendChild(root)

  zoomOut.addEventListener('click', () => setZoom(effectiveZoom() / BUTTON_STEP))
  zoomIn.addEventListener('click', () => setZoom(effectiveZoom() * BUTTON_STEP))
  fitBtn.addEventListener('click', fit)
  closeBtn.addEventListener('click', close)
  prev.addEventListener('click', () => step(-1))
  next.addEventListener('click', () => step(1))

  // 點黑底關掉；點圖片本身不關（不然拖曳放開會誤關）
  stage.addEventListener('pointerdown', (e) => {
    if (e.target === stage) close()
  })
  // 滾輪縮放。Ctrl 按不按都算——使用者的手是從檔案總管的 Ctrl+滾輪延續過來的。
  stage.addEventListener('wheel', (e) => {
    e.preventDefault()
    setZoom(nextZoom(effectiveZoom(), e.deltaY))
  }, { passive: false })
  img.addEventListener('dblclick', () => {
    if (zoom === 0) setZoom(1)
    else fit()
  })
  bindPan(img)

  ui = { root, img, caption, zoomLabel, stage }
  return ui
}

/**
 * 放大之後拖著移動。用 pointer capture，滑鼠拖到視窗外放開也收得到。
 * @param {HTMLElement} img
 */
function bindPan(img) {
  let dragging = false
  let startX = 0
  let startY = 0
  img.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || zoom === 0) return
    dragging = true
    startX = e.clientX - panX
    startY = e.clientY - panY
    img.setPointerCapture(e.pointerId)
    e.preventDefault()
  })
  img.addEventListener('pointermove', (e) => {
    if (!dragging) return
    panX = e.clientX - startX
    panY = e.clientY - startY
    applyTransform()
  })
  for (const type of ['pointerup', 'pointercancel']) {
    img.addEventListener(type, (e) => {
      if (!dragging) return
      dragging = false
      try { img.releasePointerCapture(e.pointerId) } catch { /* 已經放掉就算了 */ }
    })
  }
}

/** 現在實際的倍率。0（符合視窗）時量畫面上真正的比例，縮放才不會從 1 跳一下。 */
function effectiveZoom() {
  if (zoom !== 0) return zoom
  const img = ui?.img
  if (!img || !img.naturalWidth) return 1
  return img.clientWidth / img.naturalWidth || 1
}

function applyTransform() {
  if (!ui) return
  const { img } = ui
  if (zoom === 0) {
    img.classList.add('is-fit')
    img.style.transform = ''
    ui.zoomLabel.textContent = `${Math.round(effectiveZoom() * 100)}%`
    return
  }
  img.classList.remove('is-fit')
  img.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`
  ui.zoomLabel.textContent = `${Math.round(zoom * 100)}%`
}

/** @param {number} value */
function setZoom(value) {
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 100) / 100))
  // 從「符合視窗」開始縮放時先把平移歸零，圖才不會突然跳掉
  if (zoom === 0) {
    panX = 0
    panY = 0
  }
  zoom = next
  ui?.img.classList.toggle('is-pannable', true)
  applyTransform()
}

function fit() {
  zoom = 0
  panX = 0
  panY = 0
  ui?.img.classList.remove('is-pannable')
  applyTransform()
}

/** @param {number} delta */
function step(delta) {
  if (items.length < 2) return
  index = (index + delta + items.length) % items.length
  void show()
}

async function show() {
  if (!ui) return
  const item = items[index]
  if (!item) return
  const seq = ++loadSeq
  fit()
  ui.caption.textContent = items.length > 1
    ? `${item.name}（${index + 1}／${items.length}）`
    : item.name
  ui.img.removeAttribute('src')
  let url = ''
  try {
    const result = resolveUrl ? await resolveUrl(item.path) : null
    url = result?.ok ? String(result.data?.url || '') : ''
  } catch {
    url = ''
  }
  if (seq !== loadSeq || !ui) return
  if (!url) {
    ui.caption.textContent = `${item.name}（開不起來）`
    return
  }
  ui.img.src = url
  ui.img.alt = item.name
}

/** @param {KeyboardEvent} e */
function onKey(e) {
  if (!ui) return
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    close()
    return
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault()
    e.stopPropagation()
    step(e.key === 'ArrowLeft' ? -1 : 1)
    return
  }
  if (e.key === '+' || e.key === '=') {
    e.preventDefault()
    setZoom(effectiveZoom() * BUTTON_STEP)
    return
  }
  if (e.key === '-' || e.key === '_') {
    e.preventDefault()
    setZoom(effectiveZoom() / BUTTON_STEP)
    return
  }
  if (e.key === '0' || e.key === ' ') {
    e.preventDefault()
    if (e.key === ' ') close()
    else fit()
  }
}

/** 開著沒？（檔案總管要靠它決定空白鍵是開還是關） */
export function imageViewerOpen() {
  return Boolean(ui)
}

export function closeImageViewer() {
  close()
}

function close() {
  if (!ui) return
  document.removeEventListener('keydown', onKey, true)
  ui.root.remove()
  ui = null
  items = []
  loadSeq += 1
}

/**
 * 開大預覽。
 *
 * @param {{
 *   items: Array<{ path: string, name: string }>,
 *   index?: number,
 *   mediaUrl: (filePath: string) => Promise<any>
 * }} opts `items` 是同一個資料夾裡的圖片（←／→ 在這份清單裡走）
 * @returns {boolean} 有沒有真的開起來
 */
export function openImageViewer(opts) {
  const list = Array.isArray(opts?.items) ? opts.items.filter((item) => item && item.path) : []
  if (!list.length || typeof opts.mediaUrl !== 'function') return false
  close()
  items = list
  index = Math.min(Math.max(0, Number(opts.index) || 0), list.length - 1)
  resolveUrl = opts.mediaUrl
  build()
  document.addEventListener('keydown', onKey, true)
  ui.root.focus({ preventScroll: true })
  void show()
  return true
}
