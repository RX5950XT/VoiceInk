/**
 * 終端機的複製：一般 shell 與 AI CLI 同一套，比照 Windows Terminal。
 *
 * - 選起來就複製（放開滑鼠時）；放開的地方不在這一格也算（拖出邊界是常有的事）
 * - Ctrl+C：**有選取才複製**，沒選取照舊送 `^C` 中斷程式
 * - Ctrl+Shift+C／Ctrl+Insert：一律複製
 * - 右鍵：有選取＝複製並取消反白，沒選取＝貼上（以前永遠貼上，選完按右鍵會把剛選的字貼回提示字元）
 *
 * 剪貼簿一律跟 main 寫（`terminal:clipboardWrite`）：`navigator.clipboard.writeText()` 要文件有焦點，
 * 焦點在內建瀏覽器的 webview、或剛從別的程式切回來時會一聲不吭地失敗。
 */

/**
 * @param {string} text
 * @returns {Promise<boolean>}
 */
async function writeClipboard(text) {
  if (!text) return false
  try {
    const result = await window.electronAPI?.terminal?.clipboardWrite?.(text)
    if (result?.ok) return true
  } catch { /* 退回 renderer 那條 */ }
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/**
 * @param {import('@xterm/xterm').Terminal} term
 * @returns {boolean} 有沒有東西可以複製
 */
export function copySelection(term) {
  const text = term.hasSelection() ? term.getSelection() : ''
  if (!text) return false
  void writeClipboard(text)
  return true
}

/**
 * 給 `attachCustomKeyEventHandler` 用：是複製鍵就處理掉並回 true（呼叫端要 `return false` 吞掉）。
 * @param {import('@xterm/xterm').Terminal} term
 * @param {KeyboardEvent} event
 * @returns {boolean}
 */
export function handleCopyKey(term, event) {
  if (!event.ctrlKey || event.altKey || event.metaKey) return false
  const key = event.key
  const isC = key === 'c' || key === 'C'
  if (event.shiftKey && isC) {
    if (event.type === 'keydown') copySelection(term)
    return true
  }
  if (key === 'Insert' && !event.shiftKey) {
    if (event.type === 'keydown') copySelection(term)
    return true
  }
  // 沒選取的 Ctrl+C 不是複製，是中斷——交還給 xterm 送 `^C`
  if (isC && !event.shiftKey && term.hasSelection()) {
    if (event.type === 'keydown') {
      copySelection(term)
      term.clearSelection()
    }
    return true
  }
  return false
}

/**
 * 掛滑鼠那兩條：放開就複製、右鍵複製或貼上。
 * @param {import('@xterm/xterm').Terminal} term
 * @param {HTMLElement} pane
 * @param {() => void} paste 沒選取時右鍵要做的事
 * @returns {() => void} 收掉監聽
 */
export function bindTermCopy(term, pane, paste) {
  let pressed = false
  const onDown = (event) => { if (event.button === 0) pressed = true }
  // 掛在 window：拖曳常常放開在這一格外面，掛在 pane 上就收不到 mouseup
  const onUp = (event) => {
    if (event.button !== 0 || !pressed) return
    pressed = false
    copySelection(term)
  }
  const onMenu = (event) => {
    event.preventDefault()
    if (copySelection(term)) term.clearSelection()
    else paste()
  }
  pane.addEventListener('mousedown', onDown)
  window.addEventListener('mouseup', onUp)
  pane.addEventListener('contextmenu', onMenu)
  return () => {
    pane.removeEventListener('mousedown', onDown)
    window.removeEventListener('mouseup', onUp)
    pane.removeEventListener('contextmenu', onMenu)
  }
}
