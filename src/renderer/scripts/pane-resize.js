/**
 * 一條可拖的分隔把手。聊天／工作區的側欄與檔案總管的三塊欄位共用這一份。
 *
 * 寬度寫進 `:root` 的 CSS 變數（不是 inline style），所以 media query 與
 * `clamp()` 那些規則仍然管得到；存進 localStorage，下次開還在。
 *
 * 監聽掛在 `window`：拖到把手外、甚至拖出視窗，都要跟得上也放得掉。
 */

const DEFAULT_MIN_W = 180
const DEFAULT_MAX_W = 560

/**
 * @param {{
 *   handleId: string,
 *   panelSelector: string,
 *   cssVar: string,
 *   storageKey: string,
 *   invert?: boolean,
 *   min?: number,
 *   max?: number,
 *   onResize?: (px: number) => void
 * }} options `invert`：把手在面板左邊（往左拖＝變寬）。
 * @returns {() => void} 解除監聽（重複 init 同一條把手時用得到）
 */
export function initResizer(options) {
  const {
    handleId, panelSelector, cssVar, storageKey,
    invert = false, min = DEFAULT_MIN_W, max = DEFAULT_MAX_W, onResize
  } = options
  const handle = document.getElementById(handleId)
  const panel = /** @type {HTMLElement | null} */ (document.querySelector(panelSelector))
  if (!handle || !panel) return () => {}

  /** @param {number} width */
  function apply(width) {
    const px = Math.round(Math.min(max, Math.max(min, width)))
    document.documentElement.style.setProperty(cssVar, `${px}px`)
    try {
      localStorage.setItem(storageKey, String(px))
    } catch {
      // 沒有 storage 就只是這次有效，不值得為它中斷拖曳
    }
    onResize?.(px)
  }

  let saved = 0
  try {
    saved = Number(localStorage.getItem(storageKey)) || 0
  } catch {
    saved = 0
  }
  if (saved) apply(saved)

  /** @param {PointerEvent} event */
  const onMove = (event) => {
    const rect = panel.getBoundingClientRect()
    apply(invert ? rect.right - event.clientX : event.clientX - rect.left)
  }
  const stop = () => {
    handle.classList.remove('is-dragging')
    document.body.classList.remove('is-col-resizing')
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', stop)
  }
  const onDown = (event) => {
    event.preventDefault()
    handle.classList.add('is-dragging')
    // 拖的時候整頁禁選字：不擋的話滑過清單會把檔名一路反白起來。
    document.body.classList.add('is-col-resizing')
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', stop)
  }
  const onKey = (event) => {
    const raw = event.key === 'ArrowLeft' ? -16 : event.key === 'ArrowRight' ? 16 : 0
    if (!raw) return
    event.preventDefault()
    apply(panel.getBoundingClientRect().width + (invert ? -raw : raw))
  }
  handle.addEventListener('pointerdown', onDown)
  handle.addEventListener('keydown', onKey)
  return () => {
    stop()
    handle.removeEventListener('pointerdown', onDown)
    handle.removeEventListener('keydown', onKey)
  }
}
