/**
 * 終端機的輸入法對位：把那個隱形 `<textarea>`（Windows 拿它的游標框決定候選字視窗
 * 開在哪）擺到終端機游標所在的那一格，並在**組字期間釘住不准被拉走**。
 *
 * 兩件事分開看：
 *
 * 1. **平常**：xterm 把 textarea 丟在 `left: -9999em`，只有 `onCursorMove` 才挪回游標上。
 *    所以剛開分頁、剛切回來、還沒打出第一個字之前，系統看到的輸入框在畫面外，
 *    候選字視窗會被夾到螢幕角落。聚焦時對一次位置就夠。
 *
 * 2. **組字中**：換成 xterm 自己的 `updateCompositionElements()` 在搬，而它讀的是
 *    **當下的 `buffer.x/y`**。Claude Code／Codex 那類 Ink CLI 每一幀都把整塊清掉重印
 *    （游標先往上跳幾行、走完再回到輸入行），按鍵落在哪個瞬間，候選字視窗就被擺到哪
 *    ——使用者看到的就是「打注音時候選字視窗一直閃」，而且只有這類 CLI 才會。
 *    實測（`probe-terminal-flicker.js`）：12 個組字鍵落在 3 個位置，DOM 與 WebGL
 *    兩個 renderer 一模一樣，所以**跟 renderer 無關**，是組字那段程式在搬。
 *
 * 釘法有三個關鍵，少一個就還是會跳：
 *
 * - **錨點要等游標「停下來」才取**（`SETTLE_MS`）。重畫中途每一格都是合法的游標位置，
 *   分不出哪個是輸入行；但重畫是一陣一陣的，安靜 40ms 之後游標一定停在輸入行。
 *   取 `compositionstart` 當下或下一個 `requestAnimationFrame` 都還是會抓到中途的
 *   位置（實測分別是 `0,0` 與 `0px,60px`）。
 * - **整段組字期間每一幀都擺回去**。xterm 在同一個事件裡自己還會再排一次
 *   `updateCompositionElements()`，只補在它後面贏不了（實測 12 次有 9 次被蓋掉）。
 * - **`compositionupdate` 之後也補一次**：等下一幀才改回來，中間那十幾毫秒足夠讓系統
 *   問到錯的位置。
 *
 * **寬高一律不動**：那是 xterm 用來撐組字文字的，動了字會被縮回一格。
 *
 * 這一支刻意獨立成檔，`probe-terminal-flicker.js` 才量得到真的是這段程式碼在對位。
 */

/** @typedef {import('@xterm/xterm').Terminal} Terminal */

/** 游標安靜多久算「這一輪重畫走完了」。Ink 大約每 80ms 重畫一次。 */
const SETTLE_MS = 40

/** 組字期間要釘回去的位置。key 是 Terminal，分頁收掉就跟著消失。 */
const anchors = new WeakMap()

/** 組字期間那個每幀重釘的 rAF id */
const pins = new WeakMap()

/** 等游標停下來的計時器 */
const settleTimers = new WeakMap()

/**
 * 算出游標那一格的左上角。量不到（分頁還沒顯示）時回 null。
 * @param {Terminal} term
 * @returns {{ left: string, top: string, cellW: number, cellH: number } | null}
 */
function caretBox(term) {
  const screen = /** @type {HTMLElement | null} */ (term.element?.querySelector('.xterm-screen'))
  if (!screen || !term.cols || !term.rows) return null
  const cellW = screen.clientWidth / term.cols
  const cellH = screen.clientHeight / term.rows
  if (!cellW || !cellH) return null
  const buffer = term.buffer.active
  const col = Math.min(buffer.cursorX, term.cols - 1)
  return {
    left: `${Math.round(col * cellW)}px`,
    top: `${Math.round(buffer.cursorY * cellH)}px`,
    cellW,
    cellH
  }
}

/**
 * 把 textarea 對到游標那一格，並記下這個位置當組字期間的錨點。
 * @param {Terminal} term
 */
export function syncImeCaret(term) {
  const area = term.textarea
  const box = caretBox(term)
  if (!area || !box) return
  area.style.left = box.left
  area.style.top = box.top
  area.style.width = `${Math.max(Math.round(box.cellW), 1)}px`
  area.style.height = `${Math.max(Math.round(box.cellH), 1)}px`
  area.style.lineHeight = `${Math.round(box.cellH)}px`
  anchors.set(term, { left: box.left, top: box.top })
}

/**
 * 把候選字視窗與組字文字擺回錨點（只動位置，寬高留給 xterm）。
 * @param {Terminal} term
 */
function pinImeCaret(term) {
  const anchor = anchors.get(term)
  const area = term.textarea
  if (!anchor || !area) return
  area.style.left = anchor.left
  area.style.top = anchor.top
  const view = /** @type {HTMLElement | null} */ (term.element?.querySelector('.composition-view'))
  if (view) {
    view.style.left = anchor.left
    view.style.top = anchor.top
  }
}

/**
 * 組字開始：每一幀把位置釘回去，直到組字結束。
 * @param {Terminal} term
 */
function startPin(term) {
  stopPin(term)
  const step = () => {
    pinImeCaret(term)
    pins.set(term, requestAnimationFrame(step))
  }
  pinImeCaret(term)
  pins.set(term, requestAnimationFrame(step))
}

/** @param {Terminal} term */
function stopPin(term) {
  const id = pins.get(term)
  if (id !== undefined) cancelAnimationFrame(id)
  pins.delete(term)
}

/**
 * 掛上對位需要的事件。
 * @param {Terminal} term
 */
export function bindImeCaret(term) {
  const area = term.textarea
  if (!area) return
  area.addEventListener('focus', () => syncImeCaret(term))
  area.addEventListener('compositionstart', () => startPin(term))
  area.addEventListener('compositionupdate', () => setTimeout(() => pinImeCaret(term), 0))
  area.addEventListener('compositionend', () => stopPin(term))
  // 游標安靜下來才記錨點：重畫中途的位置每一個都合法，但只有停下來那個是輸入行
  term.onCursorMove(() => {
    clearTimeout(settleTimers.get(term))
    settleTimers.set(term, setTimeout(() => {
      const box = caretBox(term)
      if (box) anchors.set(term, { left: box.left, top: box.top })
    }, SETTLE_MS))
  })
}
