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
    const last = element.getBoundingClientRect()
    const dx = first ? first.left - last.left : 0
    const dy = first ? first.top - last.top : 0
    if (!dx && !dy) return []
    return [element.animate([
      { transform: `translate3d(${dx}px, ${dy}px, 0)` },
      { transform: 'translate3d(0, 0, 0)' }
    ], {
      duration: 110,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)'
    })]
  })
}
