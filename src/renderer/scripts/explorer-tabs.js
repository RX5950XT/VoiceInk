/**
 * 檔案總管的分頁列（像瀏覽器那樣，一頁一個路徑）。
 *
 * 只畫畫面：分頁資料與切換／關閉由 explorer-page.js 決定。零 innerHTML。
 * 關閉鈕常駐不做 hover-only（hover 才出現的操作等於沒有）。
 */

/**
 * @param {{
 *   host: HTMLElement,
 *   tabs: Array<{ id: string, cwd: string }>,
 *   activeId: string,
 *   titleOf: (cwd: string) => string,
 *   onSelect: (id: string) => void,
 *   onClose: (id: string) => void,
 *   controls?: string
 * }} spec
 */
export function paintTabStrip(spec) {
  const { host, tabs, activeId, titleOf, onSelect, onClose, controls = 'exContent' } = spec
  const hadFocus = host.contains(document.activeElement)
  host.replaceChildren()
  const closable = tabs.length > 1
  for (const tab of tabs) {
    const el = document.createElement('div')
    el.className = 'ex-tab'
    el.dataset.id = tab.id
    el.dataset.path = tab.cwd
    el.setAttribute('role', 'presentation')
    const active = tab.id === activeId
    el.classList.toggle('is-active', active)

    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'ex-tab-open'
    open.setAttribute('role', 'tab')
    open.setAttribute('aria-selected', String(active))
    open.setAttribute('aria-controls', controls)
    open.tabIndex = active ? 0 : -1
    open.textContent = titleOf(tab.cwd)
    open.title = tab.cwd
    open.addEventListener('click', () => onSelect(tab.id))
    open.addEventListener('keydown', (e) => {
      const i = tabs.indexOf(tab)
      const target = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1
        : e.key === 'ArrowRight' ? (i + 1) % tabs.length
          : e.key === 'ArrowLeft' ? (i + tabs.length - 1) % tabs.length : -1
      if (target < 0) return
      e.preventDefault()
      onSelect(tabs[target].id)
    })
    el.appendChild(open)

    if (closable) {
      const close = document.createElement('button')
      close.type = 'button'
      close.className = 'ex-tab-close'
      close.textContent = '×'
      close.title = '關閉分頁（Ctrl+W）'
      close.setAttribute('aria-label', `關閉分頁 ${titleOf(tab.cwd)}`)
      close.addEventListener('click', (e) => {
        e.stopPropagation()
        onClose(tab.id)
      })
      el.appendChild(close)
    }

    el.addEventListener('auxclick', (e) => {
      if (e.button !== 1 || !closable) return
      e.preventDefault()
      onClose(tab.id)
    })
    host.appendChild(el)
  }
  if (hadFocus) host.querySelector('.is-active .ex-tab-open')?.focus({ preventScroll: true })
  host.querySelector('.is-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}
