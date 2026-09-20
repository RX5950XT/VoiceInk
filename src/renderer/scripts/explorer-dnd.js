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

/** 殼層也有、但 App 自己做過的動詞——再畫一次會變成兩份「開啟／複製」。 */
export const SKIP_SHELL_VERBS = new Set([
  'open', 'cut', 'copy', 'paste', 'pastelink', 'delete', 'rename', 'link', 'copyaspath'
])

const SKIP_SHELL_LABELS = new Set([
  '開啟', '打開', '剪下', '複製', '貼上', '刪除', '重新命名',
  '複製路徑', '複製為路徑', '建立捷徑', '顯示更多選項',
  'Open', 'Cut', 'Copy', 'Paste', 'Delete', 'Rename',
  'Copy as path', 'Create shortcut', 'Show more options'
])

function ownedLabel(label) {
  return SKIP_SHELL_LABELS.has(String(label || '').replace(/\s/g, ''))
}

/**
 * 去掉跟 App 自己那組重複的殼層項目，連續分隔線收成一條。
 * @param {object[]} items
 * @returns {object[]}
 */
export function filterShellItems(items) {
  if (!Array.isArray(items)) return []
  const out = []
  for (const item of items) {
    if (!item) continue
    if (item.sep) {
      if (out.length && !out[out.length - 1].sep) out.push({ sep: true })
      continue
    }
    const verb = String(item.verb || '').toLowerCase()
    if (SKIP_SHELL_VERBS.has(verb)) continue
    const kids = Array.isArray(item.children) ? filterShellItems(item.children) : null
    if (ownedLabel(item.label) && !(kids && kids.length)) continue
    const next = { ...item }
    if (kids) next.children = kids
    out.push(next)
  }
  while (out.length && out[0].sep) out.shift()
  while (out.length && out[out.length - 1].sep) out.pop()
  return out
}

function asMenuItems(items, invoke) {
  return filterShellItems(items).map((item) => {
    if (item.sep) return { sep: true }
    const row = {
      label: item.label || '⋯',
      icon: item.icon || '',
      disabled: Boolean(item.disabled)
    }
    if (item.children && item.children.length) row.children = asMenuItems(item.children, invoke)
    else {
      const cmd = item.cmd
      row.onSelect = () => invoke(cmd)
    }
    return row
  })
}

/**
 * @param {{ x: number, y: number }} at
 * @param {{ recycle: boolean, items: object[], shell?: object[], invokeShell?: Function, onClose?: Function, actions: Record<string, () => void> }} spec
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
    if (items.length === 1 && items[0].dir && act.openTab) menu.push({ label: '在新分頁開啟', onSelect: act.openTab })
    if (items.length === 1 && items[0].dir && act.openProject) {
      menu.push({ label: '加入工作區專案', onSelect: act.openProject })
    }
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
    if (act.openProjectHere) menu.push({ label: '把這個資料夾加入專案', onSelect: act.openProjectHere })
  }
  if (act.refresh) {
    menu.push({ sep: true })
    menu.push({ label: '重新整理', onSelect: act.refresh })
  }
  if (spec.shell && spec.shell.length && typeof spec.invokeShell === 'function') {
    const extra = asMenuItems(spec.shell, spec.invokeShell)
    if (extra.length) {
      if (menu.length) menu.push({ sep: true })
      menu.push(...extra)
    }
  }
  showMenu(at, menu, { onClose: spec.onClose })
}
