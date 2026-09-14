/**
 * Windows 依隱形 textarea 定位候選字框。AI CLI 重畫會暫時搬走游標，
 * 組字期間用 CSS 固定 textarea 與組字文字，不能等下一幀才搬回來。
 */
/** @typedef {import('@xterm/xterm').Terminal} Terminal */

// ponytail: 用 40ms 靜默記住輸入位置；若 CLI 沒有靜默間隔，再接它的重畫完成標記。
const SETTLE_MS = 40
const anchors = new WeakMap()
const composing = new WeakSet()

/** @param {Terminal} term */
function caretBox(term) {
  const screen = term.element?.querySelector('.xterm-screen')
  if (!screen || !term.cols || !term.rows) return null
  const cellW = screen.clientWidth / term.cols
  const cellH = screen.clientHeight / term.rows
  if (!cellW || !cellH) return null
  const buffer = term.buffer.active
  return {
    left: `${Math.round(Math.min(buffer.cursorX, term.cols - 1) * cellW)}px`,
    top: `${Math.round(buffer.cursorY * cellH)}px`,
    cellW,
    cellH
  }
}

/** 平常對齊游標；組字中不改錨點，也不縮掉 xterm 撐開的文字寬度。 @param {Terminal} term */
export function syncImeCaret(term) {
  if (composing.has(term)) return
  const area = term.textarea
  const box = caretBox(term)
  if (!area || !box) return
  area.style.left = box.left
  area.style.top = box.top
  area.style.width = `${Math.max(Math.round(box.cellW), 1)}px`
  area.style.height = `${Math.max(Math.round(box.cellH), 1)}px`
  area.style.lineHeight = `${Math.round(box.cellH)}px`
  anchors.set(term, box)
}

/** @param {Terminal} term */
export function bindImeCaret(term) {
  const area = term.textarea
  if (!area) return () => {}
  let settleTimer
  const focus = () => syncImeCaret(term)
  const start = () => {
    if (composing.has(term)) return
    const anchor = anchors.get(term) || caretBox(term)
    if (!anchor) return
    clearTimeout(settleTimer)
    composing.add(term)
    term.element.style.setProperty('--ime-left', anchor.left)
    term.element.style.setProperty('--ime-top', anchor.top)
    term.element.classList.add('ime-composing')
  }
  const stop = () => {
    composing.delete(term)
    term.element.classList.remove('ime-composing')
    term.element.style.removeProperty('--ime-left')
    term.element.style.removeProperty('--ime-top')
  }
  const events = { focus, compositionstart: start, compositionend: stop, blur: stop }
  for (const [event, handler] of Object.entries(events)) area.addEventListener(event, handler)
  const cursor = term.onCursorMove(() => {
    clearTimeout(settleTimer)
    if (composing.has(term)) return
    settleTimer = setTimeout(() => {
      const box = caretBox(term)
      if (box && !composing.has(term)) anchors.set(term, box)
    }, SETTLE_MS)
  })
  return () => {
    clearTimeout(settleTimer)
    cursor.dispose()
    for (const [event, handler] of Object.entries(events)) area.removeEventListener(event, handler)
    stop()
    anchors.delete(term)
  }
}
