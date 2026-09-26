/**
 * 檔案總管的「本機」首頁：資料夾 + 裝置和磁碟機 + 網路位置。
 *
 * 只畫畫面，資料與導覽由 explorer-page.js 給。零 innerHTML。
 */

const DRIVE_ICON = { 2: '🔌', 3: '🖴', 4: '🖧', 5: '💿' }

/**
 * @param {number} type Win32_LogicalDisk 的 DriveType
 */
function iconOf(type) {
  return DRIVE_ICON[Number(type)] || '🖴'
}

/**
 * @param {{ letter: string, label?: string, type?: number }} disk
 */
function driveName(disk) {
  const label = String(disk.label || '').trim()
  const fallback = Number(disk.type) === 4 ? '網路磁碟' : Number(disk.type) === 5 ? '光碟機' : '本機磁碟'
  return `${label || fallback} (${disk.letter}:)`
}

/**
 * @param {string} title
 * @param {HTMLElement[]} cards
 */
function section(title, cards) {
  const box = document.createElement('section')
  box.className = 'ex-home-section'
  const head = document.createElement('h2')
  head.className = 'ex-home-title'
  head.textContent = title
  const grid = document.createElement('div')
  grid.className = 'ex-home-grid'
  grid.append(...cards)
  box.append(head, grid)
  return box
}

/**
 * @param {{ icon: string, name: string, sub: string, path: string }} spec
 * @param {(path: string, newPage?: boolean) => void} onOpen
 * @param {(el: HTMLElement, path: string) => void} bindDrop
 */
function card(spec, onOpen, bindDrop) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'ex-home-card'
  btn.dataset.path = spec.path
  btn.title = spec.path
  const icon = document.createElement('span')
  icon.className = 'ex-home-icon'
  icon.textContent = spec.icon
  icon.setAttribute('aria-hidden', 'true')
  const body = document.createElement('span')
  body.className = 'ex-home-body'
  const name = document.createElement('span')
  name.className = 'ex-home-name'
  name.textContent = spec.name
  const sub = document.createElement('span')
  sub.className = 'ex-home-sub'
  sub.textContent = spec.sub
  body.append(name, sub)
  btn.append(icon, body)
  btn.addEventListener('click', (e) => onOpen(spec.path, e.ctrlKey))
  btn.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return
    e.preventDefault()
    onOpen(spec.path, true)
  })
  bindDrop(btn, spec.path)
  return { btn, body }
}

/**
 * @param {number} used 0–1
 */
function bar(used) {
  const track = document.createElement('span')
  track.className = 'ex-home-bar'
  const fill = document.createElement('span')
  fill.className = 'ex-home-bar-fill'
  if (used >= 0.9) fill.classList.add('is-low')
  fill.style.width = `${Math.max(2, Math.min(100, Math.round(used * 100)))}%`
  track.appendChild(fill)
  return track
}

/**
 * @param {{
 *   host: HTMLElement,
 *   folders: Array<{ label: string, path: string }>,
 *   disks: Array<{ letter: string, path: string, label?: string, fs?: string, total?: number, free?: number, type?: number }>,
 *   devices?: Array<{ name: string, path: string, type?: string }>,
 *   formatSize: (n: number) => string,
 *   onOpen: (path: string, newPage?: boolean) => void,
 *   bindDrop: (el: HTMLElement, path: string) => void
 * }} spec
 */
export function paintHomePane(spec) {
  const { host, formatSize, onOpen, bindDrop } = spec
  host.replaceChildren()
  const folders = spec.folders || []
  if (folders.length) {
    host.appendChild(section('資料夾', folders.map((f) => (
      card({ icon: '📁', name: f.label, sub: f.path, path: f.path }, onOpen, bindDrop).btn
    ))))
  }
  const disks = spec.disks || []
  const local = disks.filter((d) => Number(d.type) !== 4)
  const net = disks.filter((d) => Number(d.type) === 4)
  const build = (disk) => {
    const total = Number(disk.total) || 0
    const free = Number(disk.free) || 0
    const { btn, body } = card({
      icon: iconOf(disk.type),
      name: driveName(disk),
      sub: total ? `剩餘 ${formatSize(free)}，共 ${formatSize(total)}` : (disk.fs ? '' : '未就緒'),
      path: disk.path
    }, onOpen, bindDrop)
    if (total > 0) body.insertBefore(bar((total - free) / total), body.lastChild)
    if (disk.fs) {
      const fsTag = document.createElement('span')
      fsTag.className = 'ex-home-fs'
      fsTag.textContent = String(disk.fs)
      btn.appendChild(fsTag)
    }
    return btn
  }
  // 手機（`mtp:名稱`）：點進去一樣在 App 裡瀏覽。不收拖放——裝置那一層底下是儲存空間，放不了檔案
  const phones = (spec.devices || []).map((dev) => card(
    { icon: '📱', name: dev.name, sub: dev.type || '手機', path: dev.path },
    onOpen,
    () => {}
  ).btn)
  if (local.length || phones.length) host.appendChild(section('裝置和磁碟機', [...local.map(build), ...phones]))
  if (net.length) host.appendChild(section('網路位置', net.map(build)))
  if (!host.childElementCount) {
    const empty = document.createElement('p')
    empty.className = 'ex-empty'
    empty.textContent = '找不到磁碟'
    host.appendChild(empty)
  }
}
