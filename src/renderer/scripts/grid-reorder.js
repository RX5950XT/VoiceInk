import { pickCollision, slotShift, moveProvider } from './usage-reorder.js'

/**
 * 二維格線的拖曳排序，行為比照額度儀表板：
 * 跟手的是 `position: fixed` 的 overlay 複本，原本那格留下鬼影，
 * 其他格只用 transform 推開——拖曳中完全不動 DOM，放開才改一次順序。
 *
 * 碰撞打**拖曳開始時記下的靜態槽位**（pointerWithin → closestCenter），
 * 不打動畫中的 `getBoundingClientRect`，否則會跟正在滑的 transform 互相追打。
 *
 * 監聽掛 `window`：游標會滑出格線範圍，掛在元素上會中途斷掉。
 *
 * 額度頁沒有共用這支：那邊多了 aria 播報、鍵盤抓取模式與「存檔失敗要還原」，
 * 是它自己的流程。這裡只做「拖著換位置」。
 */

/** 拖曳的啟動門檻：小於這個距離仍當成點擊 */
const DRAG_THRESHOLD_PX = 4

/**
 * @param {{
 *   getList: () => HTMLElement | null,
 *   itemSelector: string,
 *   ignoreSelector: string,
 *   onCommit: (ids: string[]) => void
 * }} config
 * @returns {{ onPointerDown: (event: PointerEvent) => void, onKeydown: (event: KeyboardEvent) => void }}
 */
export function createGridReorder({ getList, itemSelector, ignoreSelector, onCommit }) {
  /** @type {{ el: HTMLElement, id: string, pointerId: number, startX: number, startY: number, offsetX: number, offsetY: number, active: boolean } | null} */
  let grab = null
  /** @type {{ el: HTMLElement, id: string, order: string[], homes: Map<string, DOMRect>, slots: DOMRect[], overlay: HTMLElement } | null} */
  let session = null

  const itemsOf = () => [...(getList()?.querySelectorAll(itemSelector) || [])]

  const mountOverlay = (el, event) => {
    const rect = el.getBoundingClientRect()
    const overlay = /** @type {HTMLElement} */ (el.cloneNode(true))
    overlay.classList.add('reorder-overlay')
    overlay.removeAttribute('tabindex')
    overlay.setAttribute('aria-hidden', 'true')
    overlay.style.width = `${Math.round(rect.width)}px`
    overlay.style.height = `${Math.round(rect.height)}px`
    overlay.style.left = '0px'
    overlay.style.top = '0px'
    placeOverlay(overlay, event)
    document.body.appendChild(overlay)
    return overlay
  }

  const placeOverlay = (overlay, event) => {
    const x = Math.round(event.clientX - grab.offsetX)
    const y = Math.round(event.clientY - grab.offsetY)
    overlay.style.transform = `translate3d(${x}px, ${y}px, 0)`
  }

  /** 拖曳中只改 transform：鬼影立刻跳到落點，其他格 110ms 推開 */
  const applyTransforms = (order, animate) => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const motion = animate && !reduced
      ? 'transform 110ms cubic-bezier(0.22, 1, 0.36, 1)'
      : 'none'
    for (const el of itemsOf()) {
      const home = session.homes.get(el.dataset.id)
      const index = order.indexOf(el.dataset.id)
      if (!home || index < 0) continue
      const { dx, dy } = slotShift(home, session.slots[index])
      el.style.transition = el === session.el ? 'none' : motion
      el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`
    }
  }

  const clearTransforms = () => {
    for (const el of itemsOf()) {
      el.style.transition = 'none'
      el.style.transform = ''
    }
  }

  const startSession = (event) => {
    const list = getList()
    const els = itemsOf()
    if (!list || !els.length) return false
    const homes = new Map()
    const slots = []
    for (const el of els) {
      const rect = el.getBoundingClientRect()
      homes.set(el.dataset.id, rect)
      slots.push(rect)
    }
    const rect = grab.el.getBoundingClientRect()
    grab.offsetX = event.clientX - rect.left
    grab.offsetY = event.clientY - rect.top
    list.classList.add('is-sorting')
    grab.el.classList.add('is-ghost')
    session = {
      el: grab.el,
      id: grab.id,
      order: els.map((el) => el.dataset.id),
      homes,
      slots,
      overlay: mountOverlay(grab.el, event)
    }
    return true
  }

  const finish = () => {
    session?.overlay.remove()
    clearTransforms()
    getList()?.classList.remove('is-sorting')
    for (const el of itemsOf()) {
      el.classList.remove('is-ghost')
      el.style.transition = ''
    }
    session = null
  }

  const onMove = (event) => {
    if (!grab || event.pointerId !== grab.pointerId) return
    if (!grab.active) {
      const moved = Math.hypot(event.clientX - grab.startX, event.clientY - grab.startY)
      if (moved < DRAG_THRESHOLD_PX) return
      if (!startSession(event)) {
        detach()
        return
      }
      grab.active = true
    }
    event.preventDefault()
    placeOverlay(session.overlay, event)
    const slots = session.slots.map((slot, index) => ({
      id: String(index), left: slot.left, top: slot.top, width: slot.width, height: slot.height
    }))
    const hit = pickCollision({ x: event.clientX, y: event.clientY }, slots)
    if (hit == null) return
    const next = moveProvider(session.order, session.id, Number(hit))
    if (next.every((id, i) => id === session.order[i])) return
    session.order = next
    applyTransforms(next, true)
  }

  const detach = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onCancel)
    const active = Boolean(grab?.active)
    grab = null
    return active
  }

  const onUp = () => {
    if (!detach()) return
    const list = getList()
    const order = session?.order || []
    const byId = new Map(itemsOf().map((el) => [el.dataset.id, el]))
    // 不屬於排序範圍的尾巴（例如「＋」那格）放開後仍要留在最後
    const tail = [...(list?.children || [])].filter((el) => !el.matches(itemSelector))
    finish()
    // 放開才改 DOM：transform 已清掉，照落點順序重排一次
    for (const id of order) {
      const el = byId.get(id)
      if (el && list) list.appendChild(el)
    }
    for (const el of tail) list?.appendChild(el)
    onCommit(order)
  }

  const onCancel = () => {
    if (detach()) finish()
  }

  const onEscape = (event) => {
    if (event.key === 'Escape' && session && detach()) finish()
  }

  window.addEventListener('keydown', onEscape)

  return {
    /** @param {PointerEvent} event */
    onPointerDown(event) {
      if (event.button !== 0 || grab || session) return
      if (event.target.closest(ignoreSelector)) return
      const el = /** @type {HTMLElement} */ (event.currentTarget)
      grab = {
        el,
        id: el.dataset.id,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        offsetX: 0,
        offsetY: 0,
        active: false
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onCancel)
    },

    /**
     * Alt+方向鍵搬動（不用滑鼠也要能排序）
     * @param {KeyboardEvent} event
     */
    onKeydown(event) {
      if (!event.altKey || !event.key.startsWith('Arrow')) return
      const el = /** @type {HTMLElement} */ (event.currentTarget)
      const back = event.key === 'ArrowUp' || event.key === 'ArrowLeft'
      const sibling = back ? el.previousElementSibling : el.nextElementSibling
      if (!sibling || !sibling.matches(itemSelector)) return
      event.preventDefault()
      if (back) sibling.before(el)
      else sibling.after(el)
      el.focus()
      onCommit(itemsOf().map((item) => item.dataset.id))
    }
  }
}
