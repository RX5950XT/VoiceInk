export function moveProvider(order, provider, targetIndex) {
  const from = order.indexOf(provider)
  if (from < 0) return [...order]
  const next = [...order]
  next.splice(from, 1)
  const to = Math.max(0, Math.min(next.length, targetIndex))
  next.splice(to, 0, provider)
  return next
}

export function mergeVisibleOrder(fullOrder, visibleOrder) {
  const visible = new Set(visibleOrder)
  let index = 0
  return fullOrder.map((provider) => (
    visible.has(provider) ? visibleOrder[index++] : provider
  ))
}

/**
 * Token Anxiety / dnd-kit 的碰撞：先 pointerWithin，沒命中再 closestCenter。
 * 不要求游標進到卡片正中，空隙裡也會選最近的那張。
 * @param {{ x: number, y: number }} pointer
 * @param {Array<{ id: string, left: number, top: number, width: number, height: number }>} items
 * @returns {string | null}
 */
/**
 * 卡片從 home 槽位移到目標槽位的位移。拖曳中只改 transform，不改 DOM。
 * @param {{ left: number, top: number } | null | undefined} home
 * @param {{ left: number, top: number } | null | undefined} slot
 * @returns {{ dx: number, dy: number }}
 */
export function slotShift(home, slot) {
  if (!home || !slot) return { dx: 0, dy: 0 }
  return {
    dx: Math.round(slot.left - home.left),
    dy: Math.round(slot.top - home.top)
  }
}

export function pickCollision(pointer, items) {
  if (!items.length) return null
  const inside = items.find((item) => (
    pointer.x >= item.left && pointer.x <= item.left + item.width &&
    pointer.y >= item.top && pointer.y <= item.top + item.height
  ))
  if (inside) return inside.id
  let bestId = null
  let best = Infinity
  for (const item of items) {
    const dx = pointer.x - (item.left + item.width / 2)
    const dy = pointer.y - (item.top + item.height / 2)
    const distance = dx * dx + dy * dy
    if (distance < best) {
      best = distance
      bestId = item.id
    }
  }
  return bestId
}

export function capturePositions(elements) {
  return new Map(elements.map((element) => [
    element.dataset.provider,
    element.getBoundingClientRect()
  ]))
}

export function animateFlip(elements, before, reducedMotion) {
  if (reducedMotion) return []
  return elements.flatMap((element) => {
    const first = before.get(element.dataset.provider)
    // first 是使用者此刻看到的位置（含進行中的 FLIP）。
    // 量 last 前必須先取消舊動畫，否則 last 仍帶著舊 invert，
    // 新動畫一替換就把剩餘位移丢掉，卡片會突然跳一格。
    for (const animation of element.getAnimations()) animation.cancel()
    const last = element.getBoundingClientRect()
    const dx = first ? first.left - last.left : 0
    const dy = first ? first.top - last.top : 0
    if (!dx && !dy) return []
    return [element.animate([
      { transform: `translate3d(${dx}px, ${dy}px, 0)` },
      { transform: 'translate3d(0, 0, 0)' }
    ], {
      duration: 110,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      fill: 'none'
    })]
  })
}
