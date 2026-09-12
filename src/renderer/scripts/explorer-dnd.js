/**
 * 檔案總管拖放與右鍵選單。
 */

import { showMenu } from './ws-menu.js'

export const DRAG_MIME = 'application/x-voiceink-explorer'
export const RECYCLE_CWD = 'recyclebin'

export function pathKey(value) {
  return String(value || '').replace(/\\+$/, '').toLowerCase()
}

export function readDragPaths(event) {
  try {
    const raw = event.dataTransfer.getData(DRAG_MIME)
    const data = raw ? JSON.parse(raw) : null
    return data && Array.isArray(data.paths) ? data.paths : []
  } catch {
    return []
  }
}

export function writeDragPaths(event, paths, label) {
  event.dataTransfer.effectAllowed = 'copyMove'
  event.dataTransfer.setData(DRAG_MIME, JSON.stringify({ paths }))
  event.dataTransfer.setData('text/plain', label || 'files')
}

export function dropMode(event, fromPath, toDir) {
  if (pathKey(toDir) === RECYCLE_CWD) return 'trash'
  if (event.ctrlKey) return 'copy'
  if (event.shiftKey) return 'move'
  const a = String(fromPath || '')[0]
  const b = String(toDir || '')[0]
  return a && b && a.toLowerCase() === b.toLowerCase() ? 'move' : 'copy'
}

export function hasExplorerDrag(event) {
  return [...event.dataTransfer.types].includes(DRAG_MIME)
}

export function bindDropTarget(el, destFn, onDrop) {
  el.addEventListener('dragover', (event) => {
    if (!hasExplorerDrag(event)) return
    event.preventDefault()
    const dest = destFn()
    event.dataTransfer.dropEffect = pathKey(dest) === RECYCLE_CWD
      ? 'move'
      : (event.ctrlKey ? 'copy' : 'move')
    el.classList.add('is-drop')
  })
  el.addEventListener('dragleave', () => el.classList.remove('is-drop'))
  el.addEventListener('drop', (event) => {
    event.preventDefault()
    el.classList.remove('is-drop')
    onDrop(event, destFn())
  })
}

export function clearDrop() {
  document.querySelectorAll('.ex-row.is-drop, .ex-side-item.is-drop').forEach((el) => {
    el.classList.remove('is-drop')
  })
}

/**
 * @param {{ x: number, y: number }} at
 * @param {{ recycle: boolean, items: object[], actions: Record<string, () => void> }} spec
 */
export function showExplorerMenu(at, spec) {
  const items = spec.items || []
  const act = spec.actions
  /** @type {{ label: string, danger?: boolean, onSelect: () => void }[]} */
  const menu = []
  if (spec.recycle) {
    if (items.length) {
      menu.push({ label: '還原', onSelect: act.restore })
      menu.push({ label: '永久刪除', danger: true, onSelect: act.purge })
    }
    menu.push({ label: '清空資源回收筒', danger: true, onSelect: act.empty })
    if (act.refresh) menu.push({ label: '重新整理', onSelect: act.refresh })
    showMenu(at, menu)
    return
  }
  if (items.length) {
    menu.push({ label: '開啟', onSelect: act.open })
    if (act.reveal) menu.push({ label: '顯示位置', onSelect: act.reveal })
    if (act.pin) menu.push({ label: '釘到側欄', onSelect: act.pin })
    menu.push({ sep: true })
    menu.push({ label: '剪下', onSelect: act.cut })
    menu.push({ label: '複製', onSelect: act.copy })
  }
  menu.push({ label: '貼上', onSelect: act.paste })
  if (items.length) {
    if (act.copyPath) menu.push({ label: '複製路徑', onSelect: act.copyPath })
    if (act.copyName) menu.push({ label: '複製名稱', onSelect: act.copyName })
    if (act.shortcut) menu.push({ label: '建立捷徑', onSelect: act.shortcut })
    menu.push({ sep: true })
  }
  if (items.length === 1) menu.push({ label: '重新命名', onSelect: act.rename })
  if (items.length) menu.push({ label: '刪除', danger: true, onSelect: act.remove })
  if (!items.length) {
    menu.push({ label: '新增資料夾', onSelect: act.newFolder })
    menu.push({ label: '新增檔案', onSelect: act.newFile })
    if (act.pinHere) menu.push({ label: '釘到側欄', onSelect: act.pinHere })
  }
  if (act.refresh) {
    menu.push({ sep: true })
    menu.push({ label: '重新整理', onSelect: act.refresh })
  }
  showMenu(at, menu)
}
