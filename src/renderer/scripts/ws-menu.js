/**
 * 工作區的右鍵選單（檔案樹與分頁列共用一份）。
 *
 * 同一時間只會有一個選單活著——開新的先關舊的，`Esc`、點外面、捲動都關掉。
 * 沒有子選單、沒有圖示、沒有鍵盤巡覽：這是「右鍵一下選一項」的東西，
 * 做成完整的 menubar 元件不划算。
 */

/** @type {HTMLElement | null} */
let open = null

export function closeMenu() {
  if (!open) return
  open.remove()
  open = null
  window.removeEventListener('pointerdown', onOutside, true)
  window.removeEventListener('keydown', onKey, true)
  window.removeEventListener('resize', closeMenu)
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

/**
 * @typedef {{ label: string, danger?: boolean, onSelect: () => void }} MenuItem
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
 */
export function showMenu(at, items) {
  closeMenu()
  const menu = document.createElement('div')
  menu.className = 'ws-menu'
  menu.setAttribute('role', 'menu')
  for (const item of items) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = item.danger ? 'ws-menu-item is-danger' : 'ws-menu-item'
    btn.setAttribute('role', 'menuitem')
    btn.textContent = item.label
    btn.addEventListener('click', () => {
      closeMenu()
      item.onSelect()
    })
    menu.appendChild(btn)
  }
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
