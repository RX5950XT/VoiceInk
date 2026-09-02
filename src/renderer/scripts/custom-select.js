/**
 * 頁面內可控的下拉清單。
 * 原始 select 留在 DOM 供既有資料流使用，畫面與鍵盤操作由 listbox 接手。
 */

const states = new WeakMap()
let openState = null
let globalEventsBound = false

/**
 * 初始化頁面上的單選下拉。
 * @param {ParentNode} [root]
 */
export function initCustomSelects(root = document) {
  root.querySelectorAll('select:not([multiple]):not([size])').forEach((select) => {
    if (!states.has(select)) enhanceSelect(/** @type {HTMLSelectElement} */ (select))
  })
  bindGlobalEvents()
}

/**
 * 重新同步自訂下拉；給少數只改 select.value、沒有 change 事件的流程使用。
 */
export function syncCustomSelects() {
  document.querySelectorAll('select:not([multiple]):not([size])').forEach((select) => {
    const state = states.get(select)
    if (state) syncState(state)
  })
}

/**
 * @typedef {{ select: HTMLSelectElement, wrapper: HTMLElement, trigger: HTMLButtonElement,
 *   menu: HTMLElement, items: HTMLElement[], highlighted: number, observer: MutationObserver,
 *   portal: HTMLDialogElement|null }} SelectState
 */

/**
 * @param {HTMLSelectElement} select
 */
function enhanceSelect(select) {
  const wrapper = document.createElement('span')
  wrapper.className = 'custom-select'
  wrapper.dataset.selectId = select.id || ''
  select.parentNode?.insertBefore(wrapper, select)
  wrapper.appendChild(select)

  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.className = 'custom-select-trigger'
  trigger.dataset.selectId = select.id || ''
  trigger.setAttribute('aria-haspopup', 'listbox')
  trigger.setAttribute('aria-expanded', 'false')
  trigger.setAttribute('aria-label', getLabel(select))

  const menu = document.createElement('div')
  menu.className = 'custom-select-menu'
  menu.id = `${select.id || `custom-select-${Math.random().toString(36).slice(2)}`}Menu`
  menu.setAttribute('role', 'listbox')
  menu.hidden = true

  select.classList.add('custom-select-native')
  select.tabIndex = -1
  select.setAttribute('aria-hidden', 'true')
  wrapper.append(trigger)
  wrapper.append(menu)

  /** @type {SelectState} */
  const state = { select, wrapper, trigger, menu, items: [], highlighted: -1, observer: null, portal: null }
  states.set(select, state)
  trigger.setAttribute('aria-controls', menu.id)
  trigger.addEventListener('click', (event) => {
    event.preventDefault()
    toggleMenu(state)
  })
  trigger.addEventListener('keydown', (event) => onTriggerKeydown(event, state))
  select.addEventListener('change', () => syncState(state))
  state.observer = new MutationObserver(() => syncState(state))
  state.observer.observe(select, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['disabled', 'label', 'selected', 'value']
  })
  syncState(state)
}

/**
 * @param {HTMLSelectElement} select
 * @returns {string}
 */
function getLabel(select) {
  if (select.getAttribute('aria-label')) return select.getAttribute('aria-label')
  if (select.id) {
    const label = [...document.querySelectorAll('label[for]')]
      .find((candidate) => candidate.getAttribute('for') === select.id)
    if (label?.textContent?.trim()) return label.textContent.trim()
  }
  return select.closest('label')?.textContent?.trim() || '選擇項目'
}

/**
 * @param {SelectState} state
 */
function syncState(state) {
  const selected = state.select.selectedOptions[0]
  const text = selected?.textContent?.trim() || '未設定'
  state.trigger.textContent = text
  state.trigger.title = text
  state.trigger.disabled = state.select.disabled
  renderMenu(state)
  if (openState === state) {
    state.highlighted = state.items.findIndex((item) => item.getAttribute('aria-selected') === 'true')
    setHighlight(state, state.highlighted >= 0 ? state.highlighted : firstEnabled(state))
    positionMenu(state)
  }
}

/**
 * @param {SelectState} state
 */
function renderMenu(state) {
  state.menu.replaceChildren()
  state.items = []
  for (const child of state.select.children) {
    if (child instanceof HTMLOptGroupElement) {
      const group = document.createElement('div')
      group.className = 'custom-select-group'
      group.setAttribute('role', 'group')
      group.setAttribute('aria-label', child.label)
      const heading = document.createElement('div')
      heading.className = 'custom-select-group-label'
      heading.textContent = child.label
      group.appendChild(heading)
      for (const option of child.querySelectorAll('option')) group.appendChild(createOption(state, option))
      state.menu.appendChild(group)
      continue
    }
    if (child instanceof HTMLOptionElement) state.menu.appendChild(createOption(state, child))
  }
}

/**
 * @param {SelectState} state
 * @param {HTMLOptionElement} option
 * @returns {HTMLElement}
 */
function createOption(state, option) {
  const item = document.createElement('div')
  item.className = 'custom-select-option'
  item.id = `${state.menu.id}-option-${state.items.length}`
  item.dataset.value = option.value
  item.setAttribute('role', 'option')
  item.setAttribute('aria-selected', option.selected ? 'true' : 'false')
  item.setAttribute('aria-disabled', option.disabled ? 'true' : 'false')
  item.textContent = option.textContent || option.value
  if (!option.disabled) {
    item.addEventListener('click', () => chooseOption(state, item))
  }
  state.items.push(item)
  return item
}

/**
 * @param {SelectState} state
 * @param {HTMLElement} item
 */
function chooseOption(state, item) {
  if (item.getAttribute('aria-disabled') === 'true') return
  state.select.value = item.dataset.value || ''
  closeMenu(state)
  state.select.dispatchEvent(new Event('change', { bubbles: true }))
}

/**
 * @param {SelectState} state
 */
function toggleMenu(state) {
  if (state.trigger.disabled) return
  if (openState === state) closeMenu(state)
  else openMenu(state)
}

/**
 * @param {SelectState} state
 */
function openMenu(state) {
  if (openState) closeMenu(openState, false)
  syncState(state)
  openState = state
  state.menu.hidden = false
  state.portal = state.select.closest('dialog[open]')
  state.portal?.classList.add('custom-select-portal-open')
  const host = state.portal || document.body
  host.appendChild(state.menu)
  state.trigger.setAttribute('aria-expanded', 'true')
  state.highlighted = state.items.findIndex((item) => item.getAttribute('aria-selected') === 'true')
  setHighlight(state, state.highlighted >= 0 ? state.highlighted : firstEnabled(state))
  positionMenu(state)
  // 不等 rAF：視窗被遮住時 rAF 可能暫停，清單仍必須立即可操作。
  state.menu.classList.add('is-open')
}

/**
 * @param {SelectState} state
 * @param {boolean} [restoreFocus]
 */
function closeMenu(state, restoreFocus = true) {
  state.menu.classList.remove('is-open')
  state.menu.hidden = true
  state.wrapper.appendChild(state.menu)
  state.portal?.classList.remove('custom-select-portal-open')
  state.portal = null
  state.trigger.setAttribute('aria-expanded', 'false')
  state.trigger.removeAttribute('aria-activedescendant')
  if (openState === state) openState = null
  if (restoreFocus) state.trigger.focus()
}

/**
 * @param {SelectState} state
 * @returns {number}
 */
function firstEnabled(state) {
  return state.items.findIndex((item) => item.getAttribute('aria-disabled') !== 'true')
}

/**
 * @param {SelectState} state
 * @param {number} index
 */
function setHighlight(state, index) {
  const item = state.items[index]
  if (!item || item.getAttribute('aria-disabled') === 'true') return
  state.highlighted = index
  state.items.forEach((candidate) => candidate.removeAttribute('data-highlighted'))
  item.setAttribute('data-highlighted', 'true')
  state.trigger.setAttribute('aria-activedescendant', item.id)
  item.scrollIntoView({ block: 'nearest' })
}

/**
 * @param {SelectState} state
 * @param {number} direction
 */
function moveHighlight(state, direction) {
  const enabled = state.items
    .map((item, index) => item.getAttribute('aria-disabled') === 'true' ? -1 : index)
    .filter((index) => index >= 0)
  if (!enabled.length) return
  const current = enabled.indexOf(state.highlighted)
  const next = current < 0
    ? (direction > 0 ? 0 : enabled.length - 1)
    : (current + direction + enabled.length) % enabled.length
  setHighlight(state, enabled[next])
}

/**
 * @param {KeyboardEvent} event
 * @param {SelectState} state
 */
function onTriggerKeydown(event, state) {
  const { key } = event
  if (!state.menu.classList.contains('is-open')) {
    if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(key)) return
    event.preventDefault()
    openMenu(state)
    return
  }
  if (key === 'Escape') {
    event.preventDefault()
    closeMenu(state)
  } else if (key === 'ArrowDown') {
    event.preventDefault()
    moveHighlight(state, 1)
  } else if (key === 'ArrowUp') {
    event.preventDefault()
    moveHighlight(state, -1)
  } else if (key === 'Home' || key === 'End') {
    event.preventDefault()
    const enabled = state.items.filter((item) => item.getAttribute('aria-disabled') !== 'true')
    setHighlight(state, state.items.indexOf(key === 'Home' ? enabled[0] : enabled.at(-1)))
  } else if (key === 'Enter' || key === ' ') {
    event.preventDefault()
    const item = state.items[state.highlighted]
    if (item) chooseOption(state, item)
  } else if (key === 'Tab') {
    closeMenu(state, false)
  }
}

function bindGlobalEvents() {
  if (globalEventsBound) return
  globalEventsBound = true
  document.addEventListener('pointerdown', (event) => {
    if (!openState) return
    const target = /** @type {Node} */ (event.target)
    if (!openState.menu.contains(target) && !openState.trigger.contains(target)) closeMenu(openState, false)
  }, true)
  window.addEventListener('resize', () => {
    if (openState) positionMenu(openState)
  })
  window.addEventListener('scroll', () => {
    if (openState) positionMenu(openState)
  }, true)
}

/**
 * @param {SelectState} state
 */
function positionMenu(state) {
  if (state.menu.hidden) return
  const rect = state.trigger.getBoundingClientRect()
  const gap = 6
  const edge = 8
  const maxWidth = window.innerWidth - edge * 2
  // 先讓內容以單行量出自然寬度，窄觸發鈕不能把選項壓成直排。
  state.menu.style.width = 'max-content'
  const contentWidth = state.menu.getBoundingClientRect().width
  const width = Math.min(Math.max(rect.width, contentWidth), maxWidth)
  state.menu.style.width = `${Math.round(width)}px`
  const height = state.menu.getBoundingClientRect().height
  const below = rect.bottom + gap
  const above = rect.top - gap - height
  const top = below + height <= window.innerHeight - edge || above < edge
    ? Math.min(below, window.innerHeight - edge - height)
    : above
  const left = Math.min(Math.max(edge, rect.left), window.innerWidth - edge - width)
  // 清單是 position: fixed，但 `.app-dialog` 的 backdrop-filter 會讓 dialog 變成
  // fixed 子孫的定位基準——直接寫視窗座標，清單會整個位移一個 dialog 左上角（實測 +491,+286）。
  // 先把 left/top 歸零量出實際原點再回推，不必知道是誰造成的 containing block。
  state.menu.style.left = '0px'
  state.menu.style.top = '0px'
  const origin = state.menu.getBoundingClientRect()
  state.menu.style.left = `${Math.round(left - origin.left)}px`
  state.menu.style.top = `${Math.round(Math.max(edge, top) - origin.top)}px`
}
