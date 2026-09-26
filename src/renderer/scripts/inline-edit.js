/**
 * 就地輸入（比照檔案總管：新增／改名直接在那一列上打字，不跳對話框）。
 * 工作區檔案樹與「檔案」頁共用。
 * Enter 或點別處＝確定，Esc＝取消；空字串或沒改＝取消。
 */

/** @type {(() => void) | null} */
let cancelActive = null
/** @type {HTMLInputElement | null} */
let activeInput = null

/** 有沒有一格正在打字（清單重畫要等它結束，不然輸入框會被拆掉） */
export function isInlineEditing() {
  // 輸入框被別人連根拆掉時不會觸發 blur：當作取消，不然這個狀態會永遠卡住
  if (activeInput && !activeInput.isConnected) cancelActive?.()
  return cancelActive !== null
}

/** 取消正在打的那一格（換專案時用） */
export function cancelInlineEdit() {
  cancelActive?.()
}

/**
 * 把 `slot` 的內容換成輸入框，等使用者打完。結束後還原原本的內容。
 * @param {HTMLElement} slot 要被輸入框取代的元素（檔名那一格）
 * @param {{ value?: string, selectBase?: boolean, label?: string }} [opts]
 *   selectBase：檔案改名時只選主檔名（不含副檔名），跟檔案總管一樣
 * @returns {Promise<string | null>} 新名稱；取消回 null
 */
export function editInline(slot, opts = {}) {
  cancelInlineEdit()
  const value = opts.value || ''
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'chat-list-rename inline-edit-input'
  input.value = value
  input.spellcheck = false
  input.setAttribute('aria-label', opts.label || '名稱')
  const saved = [...slot.childNodes]
  slot.replaceChildren(input)
  // 輸入框裡的按鍵／點擊不能漏到清單（方向鍵換列、點列開檔、框選、拖曳搬檔）
  for (const type of ['keydown', 'click', 'dblclick', 'mousedown', 'pointerdown', 'contextmenu', 'dragstart']) {
    input.addEventListener(type, (event) => event.stopPropagation())
  }
  const row = slot.closest('[draggable="true"]')
  const wasDraggable = row instanceof HTMLElement && row.draggable
  if (row instanceof HTMLElement) row.draggable = false

  return new Promise((resolve) => {
    let done = false
    /** @param {string | null} result */
    const finish = (result) => {
      if (done) return
      done = true
      cancelActive = null
      activeInput = null
      slot.replaceChildren(...saved)
      if (row instanceof HTMLElement) row.draggable = wasDraggable
      const next = result === null ? '' : result.trim()
      resolve(next && next !== value ? next : null)
    }
    cancelActive = () => finish(null)
    activeInput = input
    input.addEventListener('keydown', (event) => {
      if (event.isComposing || event.keyCode === 229) return
      if (event.key === 'Enter') { event.preventDefault(); finish(input.value) }
      else if (event.key === 'Escape') { event.preventDefault(); finish(null) }
    })
    input.addEventListener('blur', () => finish(input.value))
    input.focus()
    const dot = value.lastIndexOf('.')
    if (opts.selectBase && dot > 0) input.setSelectionRange(0, dot)
    else input.select()
  })
}
