/**
 * 工作區／檔案總管共用的右鍵選單。
 *
 * 同一時間只會有一個選單活著——開新的先關舊的，`Esc`、點外面、捲動都關掉。
 * 殼層擴充（7-Zip／WinRAR／傳送到）需要子選單與小圖示，所以這份有這兩樣；
 * 沒有鍵盤巡覽：這是「右鍵一下選一項」的東西。
 */

/** @type {HTMLElement | null} */
let open = null
/** @type {(() => void) | null} */
let onCloseCb = null

export function closeMenu() {
  if (!open) return
  open.remove()
  open = null
  window.removeEventListener('pointerdown', onOutside, true)
  window.removeEventListener('keydown', onKey, true)
  window.removeEventListener('resize', closeMenu)
  const cb = onCloseCb
  onCloseCb = null
  if (typeof cb === 'function') cb()
}

/**
 * @param {PointerEvent} event
 */
function onOutside(event) {
  if (open && !open.contains(/** @type {Node} */ (event.target))) closeMenu()
}

/**
 * @param {KeyboardEvent} event
 */
function onKey(event) {
  if (event.key === 'Escape') closeMenu()
}

function clearSubs(host) {
  host.querySelectorAll(':scope > .ws-menu-sub').forEach((node) => node.remove())
}

/**
 * @param {HTMLElement} host
 * @param {object[]} items
 */
function paintItems(host, items) {
  const linedUp = (items || []).some((item) => item && item.icon)
  for (const item of items) {
    if (item.sep) {
      const hr = document.createElement('div')
      hr.className = 'ws-menu-sep'
      hr.setAttribute('role', 'separator')
      host.appendChild(hr)
      continue
    }
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = item.danger ? 'ws-menu-item is-danger' : 'ws-menu-item'
    btn.setAttribute('role', 'menuitem')
    if (item.disabled) btn.disabled = true
    if (item.icon) {
      const img = document.createElement('img')
      img.className = 'ws-menu-icon'
      img.src = item.icon
      img.alt = ''
      img.draggable = false
      btn.appendChild(img)
    } else if (linedUp) {
      const slot = document.createElement('span')
      slot.className = 'ws-menu-icon-slot'
      btn.appendChild(slot)
    }
    const text = document.createElement('span')
    text.className = 'ws-menu-label'
    text.textContent = item.label
    btn.appendChild(text)
    if (item.children && item.children.length) {
      btn.classList.add('has-sub')
      btn.addEventListener('pointerenter', () => openSub(host, btn, item.children))
    } else {
      btn.addEventListener('pointerenter', () => clearSubs(host))
      btn.addEventListener('click', () => {
        if (item.disabled) return
        const selectedMenu = open
        // 先跑動作再關：殼層項目的 IContextMenu 活在 token 上，onClose 會 release
        Promise.resolve(typeof item.onSelect === 'function' ? item.onSelect() : undefined)
          .catch(() => {})
          .finally(() => { if (open === selectedMenu) closeMenu() })
      })
    }
    host.appendChild(btn)
  }
}

function openSub(host, btn, children) {
  clearSubs(host)
  const fly = document.createElement('div')
  fly.className = 'ws-menu ws-menu-sub'
  fly.setAttribute('role', 'menu')
  paintItems(fly, children)
  host.appendChild(fly)
  const br = btn.getBoundingClientRect()
  const fr = fly.getBoundingClientRect()
  let x = br.right - 4
  let y = br.top
  if (x + fr.width > window.innerWidth - 4) x = br.left - fr.width + 4
  if (y + fr.height > window.innerHeight - 4) y = Math.max(4, window.innerHeight - fr.height - 4)
  fly.style.left = `${Math.max(4, x)}px`
  fly.style.top = `${Math.max(4, y)}px`
}

/**
 * @typedef {{ label: string, danger?: boolean, disabled?: boolean, icon?: string, children?: object[], onSelect?: () => void, sep?: boolean }} MenuItem
 */

/**
 * 在滑鼠位置開一個選單。
 *
 * 位置用 `position: fixed` 直接寫視窗座標——工作區這一塊沒有 `backdrop-filter`
 * 的祖先（那會讓 fixed 的定位基準變成那個祖先，`custom-select.js` 踩過），
 * 收邊界則是免得選單掉出畫面外。
 *
 * @param {{ x: number, y: number }} at
 * @param {MenuItem[]} items
 * @param {{ onClose?: () => void }} [opts]
 */
export function showMenu(at, items, opts = {}) {
  closeMenu()
  onCloseCb = typeof opts.onClose === 'function' ? opts.onClose : null
  const menu = document.createElement('div')
  menu.className = 'ws-menu'
  menu.setAttribute('role', 'menu')
  paintItems(menu, items)
  document.body.appendChild(menu)
  open = menu

  const rect = menu.getBoundingClientRect()
  const x = Math.max(4, Math.min(at.x, window.innerWidth - rect.width - 4))
  const y = Math.max(4, Math.min(at.y, window.innerHeight - rect.height - 4))
  menu.style.left = `${x}px`
  menu.style.top = `${y}px`

  window.addEventListener('pointerdown', onOutside, true)
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('resize', closeMenu)
}
