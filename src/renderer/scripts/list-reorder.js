import { pickCollision } from './usage-reorder.js'

/**
 * 單欄側欄清單的拖曳／鍵盤排序（聊天與終端機共用）。
 *
 * 跟額度卡片那套刻意不同：那邊是二維格線，需要跟手的 overlay ＋ 鬼影；
 * 側欄是單欄清單，直接把那一列搬到新位置最直觀，也不必動 transform。
 * 碰撞判定沿用 `usage-reorder.js` 的 `pickCollision`（pointerWithin → closestCenter）。
 *
 * 監聽掛在 `window`：游標會滑出清單範圍，掛在元素上會中途斷掉。
 */

/** 拖曳的啟動門檻：小於這個距離仍當成點擊 */
const DRAG_THRESHOLD_PX = 4

/**
 * @param {{
 *   getList: () => HTMLElement | null,
 *   itemSelector: string,
 *   ignoreSelector: string,
 *   onCommit: () => void
 * }} config
 * @returns {{ onPointerDown: (event: PointerEvent) => void, onKeydown: (event: KeyboardEvent) => void }}
 */
export function createListReorder({ getList, itemSelector, ignoreSelector, onCommit }) {
  /** @type {{ id: string, el: HTMLElement, startX: number, startY: number, active: boolean } | null} */
  let dragState = null

  /** 搬完之後焦點要留在那一列上，否則鍵盤連按第二下就沒對象了 */
  const focusItem = (el) => {
    const opener = el.querySelector('.chat-list-open')
    if (opener) opener.focus()
    else el.focus()
  }

  const onDragMove = (event) => {
    const listEl = getList()
    if (!dragState || !listEl) return
    if (!dragState.active) {
      const moved = Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY)
      if (moved < DRAG_THRESHOLD_PX) return
      dragState.active = true
      dragState.el.classList.add('is-dragging')
      listEl.classList.add('is-reordering')
    }
    const items = [...listEl.querySelectorAll(itemSelector)]
    const rects = items.map((el) => {
      const r = el.getBoundingClientRect()
      return { id: el.dataset.id, left: r.left, top: r.top, width: r.width, height: r.height }
    })
    const targetId = pickCollision({ x: event.clientX, y: event.clientY }, rects)
    if (!targetId || targetId === dragState.id) return
    const from = items.findIndex((el) => el.dataset.id === dragState.id)
    const to = items.findIndex((el) => el.dataset.id === targetId)
    if (from < 0 || to < 0) return
    const target = items[to]
    if (to > from) target.after(dragState.el)
    else target.before(dragState.el)
  }

  const onDragEnd = () => {
    window.removeEventListener('pointermove', onDragMove)
    window.removeEventListener('pointerup', onDragEnd)
    window.removeEventListener('pointercancel', onDragEnd)
    const state = dragState
    dragState = null
    if (!state?.active) return
    state.el.classList.remove('is-dragging')
    getList()?.classList.remove('is-reordering')
    onCommit()
  }

  return {
    /** @param {PointerEvent} event */
    onPointerDown(event) {
      // 改名輸入框與列上的小按鈕不能被當成抓取點
      if (event.button !== 0 || event.target.closest(ignoreSelector)) return
      const el = event.currentTarget
      dragState = {
        id: el.dataset.id, el, startX: event.clientX, startY: event.clientY, active: false
      }
      window.addEventListener('pointermove', onDragMove)
      window.addEventListener('pointerup', onDragEnd)
      window.addEventListener('pointercancel', onDragEnd)
    },

    /**
     * Alt+↑／↓ 搬動（不用滑鼠也要能排序）
     * @param {KeyboardEvent} event
     */
    onKeydown(event) {
      if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
      const el = event.currentTarget
      const sibling = event.key === 'ArrowUp' ? el.previousElementSibling : el.nextElementSibling
      if (!sibling || !sibling.matches(itemSelector)) return
      event.preventDefault()
      if (event.key === 'ArrowUp') sibling.before(el)
      else sibling.after(el)
      focusItem(el)
      onCommit()
    }
  }
}
