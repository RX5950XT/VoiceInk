import { electronAPI, showToast, setChatPaneMode } from './app.js'
import { createListReorder } from './list-reorder.js'
import {
  initWsTabs,
  openEditorTab,
  openDiffTab,
  openBrowserTab,
  openAiSessionTab,
  setActiveProject,
  newTerminalWithCommand,
  closeActiveTab,
  cycleTab
} from './ws-tabs.js'
import { showMenu } from './ws-menu.js'
import { openQuickOpen, isOpen as isQuickOpenOpen } from './ws-quickopen.js'

/**
 * 專案工作區：左側欄的「專案」清單 ＋ 右側欄的三個面板（檔案總管／Git／AI 記錄）。
 *
 * 一個專案就是本機的一個資料夾（`workspaces.json`）。**沒有 git worktree**——
 * Orca 的核心是 worktree，但那要連帶處理分支、清理、每個 worktree 各一組分頁，
 * 量級完全不同；先做「資料夾」，真的不夠用再說。
 *
 * 這裡從頭到尾只送 `projectId` 與專案內的相對路徑，絕對路徑全部在 main
 * （`src/main/workspace/files.js` 的 `resolveIn` 會擋掉爬出專案範圍的寫法）。
 */

/** 刪除鈕的二次確認逾時（與聊天／終端機側欄一致） */
const DELETE_ARM_MS = 3000

// ===== 圖示（與聊天側欄同一套線條，不用 emoji）=====
const SVG_NS = 'http://www.w3.org/2000/svg'
const ICON_PENCIL = ['M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3Z', 'M14.5 6.5l3 3']
const ICON_TRASH = ['M5 7h14', 'M10 5h4', 'M7 7l1 12h8l1-12', 'M10.5 10.5v6', 'M13.5 10.5v6']
const ICON_CHECK = ['M5 12.5l4.5 4.5L19 7.5']
const ICON_TERMINAL = ['M4 17l6-5-6-5', 'M12 19h8']

let initialized = false

/** @type {Array<{ id: string, name: string, path: string, missing: boolean }>} */
let projects = []
let currentId = ''
/** 專案切換世代；舊請求回來時不能再改目前畫面 */
let projectSeq = 0
/** 右側欄現在顯示哪一個面板 */
let panel = 'files'
/** 檔案樹上展開了哪些資料夾（相對路徑） */
let expanded = new Set()
/** 檔案樹上被選起來的相對路徑（可以多選）。空集合＝沒選任何東西 */
let selected = new Set()
/** Shift 範圍選取的起點（上一次「單純點一下」的那一列） */
let anchorRel = ''
/** 複製多筆路徑時的換行（Windows 的剪貼簿吃 CRLF） */
const NEWLINE = String.fromCharCode(13, 10)
/** 正在拖曳的那幾筆相對路徑 */
let dragging = []
/** 檔案面板現在是「檔案樹」還是「搜尋」 */
let filesView = 'tree'
/** 搜尋輸入的節流計時器（打字時不要每個鍵都去掃一次磁碟） */
let searchTimer = 0
/** 搜尋的世代編號：慢回來的舊結果不可以蓋掉新的 */
let searchSeq = 0
/** 檔案樹的世代編號：重新整理後舊的遞迴結果不可以蓋掉新的 */
let treeSeq = 0
/** 編輯器現在開著的那個檔案（相對路徑），用來在樹上標出來 */
let openRel = ''
/** @type {HTMLButtonElement | null} */
let armedDeleteBtn = null

/** @type {Record<string, HTMLElement | null>} */
const el = {}

// ===== 共用 =====

/**
 * main 的回覆一律是 { ok, data } / { ok, error }。
 * @param {Promise<{ ok: boolean, data?: any, error?: { message: string } }>} promise
 * @param {string} fallbackMessage
 * @returns {Promise<any>}
 */
async function call(promise, fallbackMessage) {
  const result = await promise
  if (result && result.ok) return result.data
  showToast(result?.error?.message || fallbackMessage, 'error')
  throw new Error(result?.error?.message || fallbackMessage)
}

/**
 * @param {HTMLElement} btn
 * @param {string[]} paths
 */
function setIconPaths(btn, paths) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  for (const d of paths) {
    const node = document.createElementNS(SVG_NS, 'path')
    node.setAttribute('d', d)
    svg.appendChild(node)
  }
  btn.querySelector('svg')?.remove()
  btn.appendChild(svg)
}

/**
 * @param {string[]} paths
 * @param {string} label
 * @param {() => void} onClick
 * @returns {HTMLButtonElement}
 */
function listActionButton(paths, label, onClick) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'chat-list-btn'
  btn.title = label
  btn.setAttribute('aria-label', label)
  setIconPaths(btn, paths)
  btn.addEventListener('click', (event) => {
    event.stopPropagation()
    onClick(event)
  })
  return btn
}

/** @returns {{ id: string, name: string, path: string } | null} */
function currentProject() {
  return projects.find((item) => item.id === currentId) || null
}

/**
 * @param {{ id: string } | null} project
 * @param {number} seq
 * @returns {boolean}
 */
function isCurrentProject(project, seq = projectSeq) {
  return Boolean(project && project.id === currentId && seq === projectSeq)
}

// ===== 專案側欄 =====

function renderList() {
  if (!el.list) return
  disarmDelete()
  el.list.replaceChildren()
  if (!projects.length) {
    const empty = document.createElement('p')
    empty.className = 'chat-empty'
    empty.textContent = '拖入資料夾加入'
    el.list.appendChild(empty)
    return
  }
  for (const item of projects) el.list.appendChild(buildListItem(item))
}

/**
 * @param {{ id: string, name: string, path: string, missing: boolean }} item
 * @returns {HTMLElement}
 */
function buildListItem(item) {
  const row = document.createElement('div')
  row.className = item.id === currentId
    ? 'chat-list-item proj-list-item active'
    : 'chat-list-item proj-list-item'
  row.dataset.id = item.id
  row.tabIndex = 0

  const open = document.createElement('button')
  open.type = 'button'
  open.className = 'chat-list-open'

  const title = document.createElement('span')
  title.className = 'chat-list-title'
  title.textContent = item.name

  const meta = document.createElement('span')
  meta.className = 'chat-list-meta proj-meta'
  if (item.missing) {
    const warn = document.createElement('span')
    warn.className = 'proj-missing'
    warn.textContent = '找不到'
    warn.title = '這個資料夾現在不存在'
    meta.appendChild(warn)
  }
  const pathEl = document.createElement('span')
  pathEl.className = 'proj-path'
  pathEl.textContent = shortenPath(item.path)
  pathEl.title = item.path
  meta.appendChild(pathEl)

  open.append(title, meta)
  open.addEventListener('click', () => void selectProject(item.id))

  const actions = document.createElement('span')
  actions.className = 'chat-list-actions'
  const termBtn = listActionButton(ICON_TERMINAL, '在此專案開啟終端機（Shift+點擊以管理員開啟）', (e) => {
    void launchProjectTerminal(item, Boolean(e?.shiftKey))
  })
  termBtn.addEventListener('contextmenu', (event) => {
    event.stopPropagation()
    event.preventDefault()
    showMenu({ x: event.clientX, y: event.clientY }, [
      { label: '在此開啟終端機', onSelect: () => void launchProjectTerminal(item, false) },
      { label: '以管理員身分開啟終端機', onSelect: () => void launchProjectTerminal(item, true) }
    ])
  })
  const trash = listActionButton(ICON_TRASH, '從清單移除', () => armDelete(trash, item))
  actions.append(termBtn, listActionButton(ICON_PENCIL, '重新命名', () => startRename(row, item)), trash)

  row.append(open, actions)
  row.addEventListener('pointerdown', reorder.onPointerDown)
  row.addEventListener('keydown', reorder.onKeydown)
  return row
}

/**
 * 快速在專案中建立終端機
 * @param {{ id: string, name: string, path: string }} item
 * @param {boolean} admin
 */
async function launchProjectTerminal(item, admin = false) {
  try {
    const created = await call(electronAPI.terminal.create({
      preset: 'shell',
      cwd: item.path,
      admin
    }), '建立終端機失敗')
    const mod = await import('./terminal-page.js')
    await mod.openTerminalSession(created.id)
  } catch {
    // call 已顯示提示
  }
}

/**
 * 只留最後兩層，側欄放不下整條路徑。
 * @param {string} value
 * @returns {string}
 */
function shortenPath(value) {
  const parts = String(value || '').split(/[\\/]/).filter(Boolean)
  return parts.length <= 2 ? String(value || '') : `…\\${parts.slice(-2).join('\\')}`
}

/**
 * 就地改名：Enter／失焦送出，Esc 取消。
 * @param {HTMLElement} row
 * @param {{ id: string, name: string }} item
 */
function startRename(row, item) {
  const title = row.querySelector('.chat-list-title')
  if (!title || row.querySelector('.chat-list-rename')) return
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'chat-list-rename'
  input.value = item.name
  input.maxLength = 60
  input.setAttribute('aria-label', '專案名稱')
  let done = false
  const finish = async (commit) => {
    if (done) return
    done = true
    const next = input.value.trim()
    if (commit && next && next !== item.name) {
      try {
        await call(electronAPI.workspace.renameProject(item.id, next), '改名失敗')
        await reloadList()
      } catch {
        input.replaceWith(title)
      }
    } else {
      input.replaceWith(title)
    }
  }
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); void finish(true) }
    else if (event.key === 'Escape') { event.preventDefault(); void finish(false) }
  })
  input.addEventListener('blur', () => void finish(true))
  input.addEventListener('pointerdown', (event) => event.stopPropagation())
  title.replaceWith(input)
  input.focus()
  input.select()
}

/**
 * 移除的二次確認：按鈕就地變紅勾，再按一次才真的移除，逾時自動復原。
 * @param {HTMLButtonElement} btn
 * @param {{ id: string, name: string }} item
 */
function armDelete(btn, item) {
  if (btn.dataset.armed === '1') {
    clearTimeout(Number(btn.dataset.timer))
    void removeProject(item)
    return
  }
  disarmDelete()
  btn.dataset.armed = '1'
  btn.classList.add('is-armed')
  btn.title = '再按一次確認移除'
  btn.setAttribute('aria-label', `再按一次把「${item.name}」從清單移除`)
  setIconPaths(btn, ICON_CHECK)
  btn.dataset.timer = String(setTimeout(disarmDelete, DELETE_ARM_MS))
  armedDeleteBtn = btn
}

function disarmDelete() {
  const btn = armedDeleteBtn
  armedDeleteBtn = null
  if (!btn) return
  clearTimeout(Number(btn.dataset.timer))
  delete btn.dataset.armed
  delete btn.dataset.timer
  btn.classList.remove('is-armed')
  btn.title = '從清單移除'
  btn.setAttribute('aria-label', '從清單移除')
  setIconPaths(btn, ICON_TRASH)
}

/**
 * **只從清單移除，不碰磁碟上的資料夾**。
 * @param {{ id: string }} item
 */
async function removeProject(item) {
  disarmDelete()
  try {
    await call(electronAPI.workspace.removeProject(item.id), '移除失敗')
  } catch {
    return
  }
  if (currentId === item.id) {
    projectSeq += 1
    currentId = ''
    void setActiveProject(null).catch(() => {})
  }
  try {
    await reloadList()
  } catch {
    return
  }
  renderPanel()
}

/**
 * 拖曳／Alt+↑↓ 排序，與聊天、終端機側欄共用同一份實作。
 */
const reorder = createListReorder({
  getList: () => el.list,
  itemSelector: '.proj-list-item',
  ignoreSelector: '.chat-list-btn, .chat-list-rename',
  onCommit: () => void persistOrder().catch(() => {})
})

/** DOM 上的順序才是真相（剛拖完還沒重畫） */
async function persistOrder() {
  if (!el.list) return
  const ids = [...el.list.querySelectorAll('.proj-list-item')]
    .map((node) => /** @type {HTMLElement} */ (node).dataset.id)
  projects = await call(electronAPI.workspace.reorderProjects(ids), '排序沒有存起來')
}

async function reloadList() {
  projects = await call(electronAPI.workspace.listProjects(), '讀不到專案清單')
  if (currentId && !projects.some((item) => item.id === currentId)) currentId = ''
  renderList()
}

async function addProject() {
  let created
  try {
    created = await call(electronAPI.workspace.addProject(), '加入專案失敗')
  } catch {
    return
  }
  if (!created) return
  try {
    await reloadList()
  } catch {
    return
  }
  await selectProject(created.id)
}

/**
 * 專案區支援直接拖資料夾進來加入。File → 路徑的轉換在 preload（webUtils），
 * 驗證在 main（store.create）。drop 的對象是整個 #projPanel，空清單也接得住。
 */
function initProjectDrop() {
  const panel = document.getElementById('projPanel')
  if (!panel) return
  // dragenter/dragleave 會在子節點之間成對亂跳，用計數擋
  let depth = 0
  const hasFiles = (event) => Array.from(event.dataTransfer?.types ?? []).includes('Files')
  panel.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return
    event.preventDefault()
    depth += 1
    panel.classList.add('is-drop')
  })
  panel.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  })
  panel.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1)
    if (!depth) panel.classList.remove('is-drop')
  })
  panel.addEventListener('drop', async (event) => {
    depth = 0
    panel.classList.remove('is-drop')
    const files = Array.from(event.dataTransfer?.files ?? [])
    if (!files.length) return
    event.preventDefault()
    try {
      const result = await electronAPI.workspace.addDropped(files)
      if (!result?.ok) {
        showToast(result?.error?.message || '加入專案失敗', 'error')
        return
      }
      if (result.data.added) {
        showToast(result.data.added === 1 ? '已加入專案' : `已加入 ${result.data.added} 個專案`)
      }
      if (result.data.skipped) showToast(`略過 ${result.data.skipped} 個（已存在或不是資料夾）`, 'error')
      await reloadList()
      if (result.data.firstId) await selectProject(result.data.firstId)
    } catch {
      showToast('加入專案失敗', 'error')
    }
  })
}

/**
 * @param {string} id
 */
async function selectProject(id) {
  const project = projects.find((item) => item.id === id) || null
  if (!project) return false
  const seq = ++projectSeq
  let activated
  try {
    activated = await setActiveProject(project)
  } catch {
    activated = false
  }
  if (!activated || seq !== projectSeq) return false
  currentId = project.id
  expanded = new Set()
  selected = new Set()
  anchorRel = ''
  setChatPaneMode('workspace')
  renderList()
  await renderPanel(project, seq)
  return seq === projectSeq
}

// ===== 右側欄 =====

/**
 * @param {string} next
 */
function setPanel(next) {
  panel = next
  document.querySelectorAll('.ws-right-tab').forEach((btn) => {
    const on = /** @type {HTMLElement} */ (btn).dataset.panel === next
    btn.classList.toggle('active', on)
    btn.setAttribute('aria-selected', on ? 'true' : 'false')
  })
  void renderPanel()
}

async function renderPanel(project = currentProject(), seq = projectSeq) {
  const has = Boolean(project)
  if (el.rightEmpty) el.rightEmpty.hidden = has
  if (el.panelFiles) el.panelFiles.hidden = !has || panel !== 'files'
  if (el.panelGit) el.panelGit.hidden = !has || panel !== 'git'
  if (el.panelAgents) el.panelAgents.hidden = !has || panel !== 'agents'
  if (el.panelPorts) el.panelPorts.hidden = !has || panel !== 'ports'
  if (!project || !isCurrentProject(project, seq)) return
  if (panel === 'files') await renderFilesPanel(project, seq)
  else if (panel === 'git') await renderGit(project, seq)
  else if (panel === 'ports') await renderPorts(seq)
  else await renderAgents(project, seq)
}

/**
 * 檔案面板有兩個檢視（檔案樹／搜尋），共用同一個分頁。
 * @param {string} [next]
 */
function setFilesView(next) {
  if (next) filesView = next
  document.querySelectorAll('.ws-files-mode').forEach((btn) => {
    const on = /** @type {HTMLElement} */ (btn).dataset.view === filesView
    btn.classList.toggle('active', on)
    btn.setAttribute('aria-selected', on ? 'true' : 'false')
  })
  if (el.tree) el.tree.hidden = filesView !== 'tree'
  if (el.search) el.search.hidden = filesView !== 'search'
  if (filesView === 'search') el.searchInput?.focus()
}

async function renderFilesPanel(project = currentProject(), seq = projectSeq) {
  setFilesView()
  if (filesView === 'tree') await renderTree(project, seq)
}

// ===== 檔案總管 =====

/**
 * 一次只展開一層：真的去 `listDir` 那一層，不預先遞迴（大 repo 會卡好幾秒）。
 */
async function renderTree(project = currentProject(), seq = projectSeq) {
  const request = ++treeSeq
  if (!isCurrentProject(project, seq) || !el.tree) return
  if (el.filesProject) {
    el.filesProject.textContent = project.name
    el.filesProject.title = project.path
  }
  el.tree.replaceChildren()
  await appendLevel(project, '', el.tree, 0, seq, request)
  if (isCurrentProject(project, seq) && request === treeSeq) resetTreeCursor()
}

/**
 * @param {{ id: string }} project
 * @param {string} relPath
 * @param {HTMLElement} host
 * @param {number} depth
 * @param {number} seq
 * @param {number} request
 */
async function appendLevel(project, relPath, host, depth, seq, request) {
  let listed
  try {
    listed = await call(electronAPI.workspace.listDir(project.id, relPath), '讀不到資料夾')
  } catch {
    return
  }
  if (!isCurrentProject(project, seq) || request !== treeSeq) return
  for (const entry of listed.entries) {
    if (!isCurrentProject(project, seq) || request !== treeSeq) return
    host.appendChild(buildTreeRow(project, entry, depth))
    if (entry.dir && expanded.has(entry.rel)) {
      const child = document.createElement('div')
      child.className = 'ws-tree-children'
      host.appendChild(child)
      await appendLevel(project, entry.rel, child, depth + 1, seq, request)
    }
  }
  if (isCurrentProject(project, seq) && request === treeSeq && listed.truncated) {
    const note = document.createElement('p')
    note.className = 'ws-tree-note'
    note.textContent = '只列出前面一部分'
    host.appendChild(note)
  }
}

/**
 * @param {{ id: string, name: string }} project
 * @param {{ name: string, rel: string, dir: boolean }} entry
 * @param {number} depth
 * @returns {HTMLElement}
 */
function buildTreeRow(project, entry, depth) {
  const row = document.createElement('button')
  row.type = 'button'
  row.className = entry.dir ? 'ws-tree-row is-dir' : 'ws-tree-row'
  row.style.paddingLeft = `${8 + depth * 12}px`
  row.title = entry.rel
  row.dataset.rel = entry.rel
  row.dataset.depth = String(depth)
  if (entry.dir) row.dataset.dir = '1'
  // 鍵盤只在樹**整體**進出一次（roving tabindex）：每一列都能 Tab 進去的話，
  // 幾百列的樹會讓 Tab 鍵完全沒用。
  row.tabIndex = -1
  row.setAttribute('role', 'treeitem')
  row.setAttribute('aria-level', String(depth + 1))
  if (entry.dir) row.setAttribute('aria-expanded', expanded.has(entry.rel) ? 'true' : 'false')
  if (!entry.dir && entry.rel === openRel) row.classList.add('is-open')
  if (selected.has(entry.rel)) row.classList.add('is-selected')
  // 搬檔用 HTML5 DnD：檔案總管本來就是這個手感（半透明拖影正好當「要搬走的東西」），
  // 而且 dragover／drop 的目標判定是瀏覽器算的，不必自己接 elementFromPoint。
  // 分頁列那邊刻意不用它——那裡要的是「跟手＋平滑讓位」，拖影只會礙事。
  row.draggable = true

  const caret = document.createElement('span')
  caret.className = 'ws-tree-caret'
  caret.textContent = entry.dir ? (expanded.has(entry.rel) ? '▾' : '▸') : ''
  const name = document.createElement('span')
  name.className = 'ws-tree-name'
  name.textContent = entry.name
  row.append(caret, name)

  row.addEventListener('contextmenu', (event) => openTreeMenu(project, entry, event))
  row.addEventListener('focus', () => setTreeCursor(row))
  row.addEventListener('dragstart', (event) => onTreeDragStart(event, entry))
  row.addEventListener('dragend', () => clearDropMarks())
  row.addEventListener('dragover', (event) => onTreeDragOver(event, entry, row))
  row.addEventListener('dragleave', () => row.classList.remove('is-drop'))
  row.addEventListener('drop', (event) => void onTreeDrop(event, project, entry))
  row.addEventListener('click', (event) => {
    if (event.ctrlKey || event.metaKey) {
      toggleSelect(entry.rel)
      return
    }
    if (event.shiftKey) {
      selectRange(entry.rel)
      return
    }
    setSelection([entry.rel])
    if (entry.dir) {
      void toggleDir(project, entry.rel, row)
      return
    }
    void openEditorTab(project, entry.rel)
  })
  return row
}

/**
 * 展開／收合一個資料夾。**只動這一列後面那一塊**——
 * 以前每次都 `renderTree()` 整棵重畫，等於把所有展開過的層再讀一次 IPC，
 * 而且捲動位置會跳回最上面（開一個深一點的資料夾就找不到自己在哪了）。
 *
 * 收起來時子節點直接丟掉（`expanded` 仍留著），再展開就重讀一次——
 * 那正好順便反映磁碟上的變動，比自己維護一份快取便宜。
 *
 * @param {{ id: string }} project
 * @param {string} rel
 * @param {HTMLElement} row
 */
async function toggleDir(project, rel, row) {
  const depth = Number(row.dataset.depth || 0)
  const caret = row.querySelector('.ws-tree-caret')
  const next = row.nextElementSibling
  if (expanded.has(rel)) {
    expanded.delete(rel)
    if (next && next.classList.contains('ws-tree-children')) next.remove()
    row.setAttribute('aria-expanded', 'false')
    if (caret) caret.textContent = '▸'
    return
  }
  expanded.add(rel)
  row.setAttribute('aria-expanded', 'true')
  if (caret) caret.textContent = '▾'
  const child = document.createElement('div')
  child.className = 'ws-tree-children'
  row.after(child)
  await appendLevel(project, rel, child, depth + 1, projectSeq, treeSeq)
}

// ===== 檔案樹的鍵盤導覽 =====

// ===== 檔案樹的多選與拖曳搬檔 =====

/**
 * 只改 class，不重畫整棵樹——重畫會把捲動位置與展開狀態一起洗掉，
 * 而選取本來就只是「哪幾列要塗底色」。
 */
function paintSelection() {
  for (const row of treeRows()) {
    row.classList.toggle('is-selected', selected.has(row.dataset.rel || ''))
  }
}

/**
 * @param {string[]} rels
 */
function setSelection(rels) {
  selected = new Set(rels)
  anchorRel = rels[rels.length - 1] || ''
  paintSelection()
}

/**
 * Ctrl／⌘ 點：加一筆或減一筆。
 * @param {string} rel
 */
function toggleSelect(rel) {
  if (selected.has(rel)) selected.delete(rel)
  else selected.add(rel)
  anchorRel = rel
  paintSelection()
}

/**
 * Shift 點：從上一次單純點過的那一列到這一列，**照畫面上看得到的順序**
 * （不是相對路徑的字母序，那跟眼睛看到的不一樣）。
 * @param {string} rel
 */
function selectRange(rel) {
  const rows = treeRows()
  const to = rows.findIndex((row) => row.dataset.rel === rel)
  const from = anchorRel ? rows.findIndex((row) => row.dataset.rel === anchorRel) : to
  if (to < 0) return
  const [lo, hi] = from < 0 || from > to ? [to, from < 0 ? to : from] : [from, to]
  selected = new Set(rows.slice(lo, hi + 1).map((row) => row.dataset.rel || ''))
  paintSelection()
}

/**
 * 一筆的父資料夾（空字串＝專案根目錄）。
 * @param {string} rel
 * @returns {string}
 */
const parentDirOf = (rel) => rel.split('/').slice(0, -1).join('/')

/**
 * 放到哪個資料夾裡。放在檔案上＝放進**那個檔案所在的資料夾**（比照檔案總管），
 * 放在空白處＝放進專案根目錄。
 * @param {{ rel: string, dir: boolean } | null} entry
 * @returns {string}
 */
const dropDirOf = (entry) => (entry ? (entry.dir ? entry.rel : parentDirOf(entry.rel)) : '')

/** 清掉所有「可以放在這裡」的框線 */
function clearDropMarks() {
  for (const row of treeRows()) row.classList.remove('is-drop')
  el.tree?.classList.remove('is-drop')
}

/**
 * @param {DragEvent} event
 * @param {{ rel: string, dir: boolean }} entry
 */
function onTreeDragStart(event, entry) {
  // 拖的那一列不在選取裡＝使用者只想搬它，先把選取換成它
  if (!selected.has(entry.rel)) setSelection([entry.rel])
  dragging = [...selected]
  if (!event.dataTransfer) return
  event.dataTransfer.effectAllowed = 'move'
  // **一定要 setData**：不寫的話 Chromium 根本不會啟動這次拖曳
  event.dataTransfer.setData('text/plain', dragging.join(', '))
}

/**
 * 這個目的地收不收得下。收不下就**不要** `preventDefault`——
 * 那是唯一告訴瀏覽器「這裡不能放」的方式（游標會變成禁止符號）。
 *
 * @param {string} toDir
 * @returns {boolean}
 */
function canDropInto(toDir) {
  if (!dragging.length) return false
  return dragging.every((rel) => (
    // 搬到原本就在的那一層＝白做工
    parentDirOf(rel) !== toDir
    // 資料夾不能搬進自己底下（會把整棵子樹弄不見）
    && toDir !== rel
    && !toDir.startsWith(`${rel}/`)
  ))
}

/**
 * @param {DragEvent} event
 * @param {{ rel: string, dir: boolean }} entry
 * @param {HTMLElement} row
 */
function onTreeDragOver(event, entry, row) {
  const toDir = dropDirOf(entry)
  if (!canDropInto(toDir)) return
  event.preventDefault()
  event.stopPropagation()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  clearDropMarks()
  // 放在檔案上時，把框線畫在**那個檔案的資料夾**那一列，不然看起來像要放進檔案裡
  const mark = entry.dir ? row : treeRows().find((one) => one.dataset.rel === toDir)
  if (mark) mark.classList.add('is-drop')
  else el.tree?.classList.add('is-drop')
}

/**
 * @param {DragEvent} event
 * @param {{ id: string, name: string }} project
 * @param {{ rel: string, dir: boolean } | null} entry
 */
async function onTreeDrop(event, project, entry) {
  event.preventDefault()
  event.stopPropagation()
  clearDropMarks()
  const toDir = dropDirOf(entry)
  const list = dragging
  dragging = []
  if (!list.length || !canDropInto(toDir)) return

  const seq = projectSeq
  let moved = 0
  for (const rel of list) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await call(electronAPI.workspace.moveEntry(project.id, rel, toDir), '搬不過去')
      moved += 1
    } catch {
      break
    }
    expanded.delete(rel)
  }
  if (!isCurrentProject(project, seq)) return
  if (toDir) expanded.add(toDir)
  selected = new Set()
  await renderTree(project, seq)
  if (moved) showToast(moved > 1 ? `已搬移 ${moved} 個項目` : '已搬移')
}

/**
 * 目前畫面上看得到的列（DOM 順序就是視覺順序）。
 * @returns {HTMLElement[]}
 */
function treeRows() {
  return el.tree ? Array.from(el.tree.querySelectorAll('.ws-tree-row')) : []
}

/**
 * roving tabindex：整棵樹只有一列是 `tabindex=0`。
 * @param {HTMLElement | null} row
 */
function setTreeCursor(row) {
  for (const other of treeRows()) other.tabIndex = other === row ? 0 : -1
}

/** 樹重畫之後把「可以 Tab 進來」的那一列補回去（沒有就是第一列） */
function resetTreeCursor() {
  const rows = treeRows()
  if (!rows.length) return
  const open = rows.find((row) => row.classList.contains('is-open'))
  setTreeCursor(open || rows[0])
}

/**
 * 照 VS Code／Orca 的樹狀導覽：上下走「看得到的那幾列」，
 * 右鍵展開或走進第一個子項、左鍵收合或退回父層。
 *
 * @param {KeyboardEvent} event
 */
function onTreeKeydown(event) {
  const rows = treeRows()
  if (!rows.length) return
  const current = /** @type {HTMLElement | null} */ (
    document.activeElement && document.activeElement.closest('.ws-tree-row')
  )
  const at = current ? rows.indexOf(current) : -1
  /** @param {number} index */
  const go = (index) => {
    const target = rows[Math.max(0, Math.min(rows.length - 1, index))]
    if (!target) return
    setTreeCursor(target)
    target.focus()
    target.scrollIntoView({ block: 'nearest' })
  }

  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      go(at + 1)
      return
    case 'ArrowUp':
      event.preventDefault()
      go(at === -1 ? rows.length - 1 : at - 1)
      return
    case 'Home':
      event.preventDefault()
      go(0)
      return
    case 'End':
      event.preventDefault()
      go(rows.length - 1)
      return
    case 'ArrowRight': {
      if (!current) return
      event.preventDefault()
      if (current.dataset.dir !== '1') return
      if (current.getAttribute('aria-expanded') === 'true') go(at + 1)
      else current.click()
      return
    }
    case 'ArrowLeft': {
      if (!current) return
      event.preventDefault()
      if (current.dataset.dir === '1' && current.getAttribute('aria-expanded') === 'true') {
        current.click()
        return
      }
      const depth = Number(current.dataset.depth || 0)
      for (let i = at - 1; i >= 0; i -= 1) {
        if (Number(rows[i].dataset.depth || 0) < depth) {
          go(i)
          return
        }
      }
      return
    }
    default:
  }
}

// ===== 目前開著的檔案 =====

/**
 * 標出「編輯器現在開的是樹上的哪一個檔案」，看不到的話把它的上層展開再捲過去。
 *
 * 事件由 `ws-tabs.js` 在切分頁時發（**不是 import**：workspace-page 已經
 * import 了 ws-tabs，反過來再 import 就繞成一個圈）。
 *
 * @param {string} projectId
 * @param {string} rel
 */
async function markOpenFile(projectId, rel) {
  openRel = rel
  const project = currentProject()
  if (!project || project.id !== projectId || !el.tree) return
  for (const row of treeRows()) {
    row.classList.toggle('is-open', row.dataset.rel === rel && row.dataset.dir !== '1')
  }
  if (!rel) return
  let hit = treeRows().find((row) => row.dataset.rel === rel && row.dataset.dir !== '1')
  if (!hit) {
    // 藏在還沒展開的資料夾裡：把它的每一層祖先打開再重畫一次
    const parts = rel.split('/')
    let acc = ''
    let grew = false
    for (let i = 0; i < parts.length - 1; i += 1) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i]
      if (!expanded.has(acc)) {
        expanded.add(acc)
        grew = true
      }
    }
    if (!grew) return
    await renderTree(project, projectSeq)
    hit = treeRows().find((row) => row.dataset.rel === rel && row.dataset.dir !== '1')
  }
  if (!hit) return
  hit.classList.add('is-open')
  setTreeCursor(hit)
  hit.scrollIntoView({ block: 'nearest' })
}

/**
 * 檔案樹的右鍵選單。**新增一律建在「這一列所在的資料夾」底下**——
 * 在檔案上按右鍵時是它的父資料夾，在資料夾上按時就是它自己。
 *
 * @param {{ id: string, name: string }} project
 * @param {{ name: string, rel: string, dir: boolean }} entry
 * @param {MouseEvent} event
 */
function openTreeMenu(project, entry, event) {
  event.preventDefault()
  // 右鍵按在選取範圍外＝使用者在講這一列，把選取換成它（比照檔案總管）
  if (!selected.has(entry.rel)) setSelection([entry.rel])
  if (selected.size > 1) {
    const many = [...selected]
    showMenu({ x: event.clientX, y: event.clientY }, [
      { label: `複製 ${many.length} 條相對路徑`, onSelect: () => void copyPath(many.join(NEWLINE)) },
      { label: `刪除這 ${many.length} 個`, danger: true, onSelect: () => void removeMany(project, many) }
    ])
    return
  }
  const parent = entry.dir ? entry.rel : entry.rel.split('/').slice(0, -1).join('/')
  showMenu({ x: event.clientX, y: event.clientY }, [
    { label: '新增檔案…', onSelect: () => void createEntry(project, parent, false) },
    { label: '新增資料夾…', onSelect: () => void createEntry(project, parent, true) },
    { label: '改名…', onSelect: () => void renameEntry(project, entry) },
    { label: '複製相對路徑', onSelect: () => void copyPath(entry.rel) },
    { label: '在檔案總管顯示', onSelect: () => void revealEntry(project, entry.rel) },
    { label: `刪除「${entry.name}」`, danger: true, onSelect: () => void removeEntry(project, entry) }
  ])
}

/**
 * @param {{ id: string }} project
 * @param {string} relDir 建在哪個資料夾（空字串＝專案根目錄）
 * @param {boolean} dir
 */
async function createEntry(project, relDir, dir) {
  const name = window.prompt(dir ? '新資料夾的名稱' : '新檔案的名稱', '')
  if (name === null) return
  const seq = projectSeq
  try {
    const made = await call(
      electronAPI.workspace.createEntry(project.id, relDir, name, dir),
      dir ? '建不了資料夾' : '建不了檔案'
    )
    if (!isCurrentProject(project, seq)) return
    if (relDir) expanded.add(relDir)
    await renderTree(project, seq)
    if (isCurrentProject(project, seq) && !made.dir) await openEditorTab(project, made.rel)
  } catch {
    // call() 已經提示過了
  }
}

/**
 * @param {{ id: string }} project
 * @param {{ name: string, rel: string }} entry
 */
async function renameEntry(project, entry) {
  const name = window.prompt('新的名稱', entry.name)
  if (name === null || name === entry.name) return
  const seq = projectSeq
  try {
    await call(electronAPI.workspace.renameEntry(project.id, entry.rel, name), '改名失敗')
    if (!isCurrentProject(project, seq)) return
    expanded.delete(entry.rel)
    await renderTree(project, seq)
  } catch {
    // call() 已經提示過了
  }
}

/**
 * 刪除是唯一會弄丟東西的操作，所以**一定要二次確認**，而且訊息裡要寫出名字
 * （右鍵按錯一列的成本太高）。
 *
 * @param {{ id: string }} project
 * @param {{ name: string, rel: string, dir: boolean }} entry
 */
async function removeEntry(project, entry) {
  const what = entry.dir ? '這個資料夾與裡面所有東西' : '這個檔案'
  if (!window.confirm(`確定要刪除 ${entry.rel} 嗎？\n會刪掉${what}，而且救不回來。`)) return
  const seq = projectSeq
  try {
    await call(electronAPI.workspace.removeEntry(project.id, entry.rel), '刪不掉')
    if (!isCurrentProject(project, seq)) return
    expanded.delete(entry.rel)
    await renderTree(project, seq)
    showToast(`已刪除 ${entry.name}`)
  } catch {
    // call() 已經提示過了
  }
}

/**
 * 批次刪除。**只確認一次**（一次列出全部），但訊息裡要寫清楚有幾個、頭幾個是誰——
 * 一個一個問會讓人閉著眼睛連按，那比不問還糟。
 *
 * @param {{ id: string, name: string }} project
 * @param {string[]} rels
 */
async function removeMany(project, rels) {
  const preview = rels.slice(0, 8).join(NEWLINE)
  const more = rels.length > 8 ? `${NEWLINE}…還有 ${rels.length - 8} 個` : ''
  if (!window.confirm(`確定要刪除這 ${rels.length} 個嗎？救不回來。${NEWLINE}${NEWLINE}${preview}${more}`)) return
  const seq = projectSeq
  let done = 0
  for (const rel of rels) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await call(electronAPI.workspace.removeEntry(project.id, rel), '刪不掉')
      done += 1
    } catch {
      break
    }
    expanded.delete(rel)
  }
  if (!isCurrentProject(project, seq)) return
  selected = new Set()
  await renderTree(project, seq)
  if (done) showToast(`已刪除 ${done} 個`)
}

/**
 * @param {string} rel
 */
async function copyPath(rel) {
  try {
    await navigator.clipboard.writeText(rel)
    showToast('已複製路徑')
  } catch {
    showToast('複製不了路徑', 'error')
  }
}

/**
 * @param {{ id: string }} project
 * @param {string} rel
 */
async function revealEntry(project, rel) {
  try {
    await call(electronAPI.workspace.reveal(project.id, rel), '開不了這個位置')
  } catch {
    // call() 已經提示過了
  }
}

// ===== 專案內搜尋 =====

/**
 * 打字時節流 300ms 再送——每個鍵都去掃一次磁碟等於一直在做白工。
 */
function queueSearch() {
  window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => void runSearch(), 300)
}

async function runSearch() {
  const project = currentProject()
  const projectToken = projectSeq
  const input = /** @type {HTMLInputElement | null} */ (el.searchInput)
  if (!isCurrentProject(project, projectToken) || !input || !el.searchResults) return
  const query = input.value.trim()
  if (query.length < 2) {
    el.searchResults.replaceChildren()
    return
  }
  const seq = searchSeq + 1
  searchSeq = seq
  el.searchResults.replaceChildren(note('搜尋中…'))
  let found
  try {
    found = await call(electronAPI.workspace.search(project.id, query, false), '搜尋失敗')
  } catch {
    if (seq === searchSeq && isCurrentProject(project, projectToken)) el.searchResults.replaceChildren()
    return
  }
  if (seq !== searchSeq || !isCurrentProject(project, projectToken)) return // 已經有更新的一輪了，這份結果作廢
  renderSearchHits(project, found)
}

/**
 * @param {string} text
 * @returns {HTMLElement}
 */
function note(text) {
  const p = document.createElement('p')
  p.className = 'ws-tree-note'
  p.textContent = text
  return p
}

/**
 * @param {{ id: string, name: string }} project
 * @param {{ query: string, hits: Array<{ rel: string, line: number, text: string }>, truncated: boolean, scanned: number }} found
 */
function renderSearchHits(project, found) {
  const host = el.searchResults
  if (!host) return
  host.replaceChildren()
  if (!found.hits.length) {
    host.appendChild(note(`掃了 ${found.scanned} 個檔案，沒有找到。`))
    return
  }
  for (const hit of found.hits) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'ws-search-hit'
    row.title = `${hit.rel}:${hit.line}`
    const where = document.createElement('span')
    where.className = 'ws-search-where'
    where.textContent = `${hit.rel}:${hit.line}`
    const text = document.createElement('span')
    text.className = 'ws-search-text'
    text.textContent = hit.text.trim()
    row.append(where, text)
    row.addEventListener('click', () => void openEditorTab(project, hit.rel, hit.line))
    host.appendChild(row)
  }
  if (found.truncated) host.appendChild(note('命中太多，只列出前面一部分。'))
}

// ===== 本機埠號 =====

/**
 * 這台機器正在聽的本機 TCP 埠。跟專案無關，但擺在工作區最順手——
 * dev server 起來之後點一下就用內建瀏覽器開。
 */
async function renderPorts(seq = projectSeq) {
  const host = el.portList
  if (!host) return
  host.replaceChildren(note('查詢中…'))
  let ports
  try {
    ports = await call(electronAPI.workspace.listPorts(), '查不到埠號')
  } catch {
    if (seq === projectSeq) host.replaceChildren()
    return
  }
  if (seq !== projectSeq) return
  host.replaceChildren()
  if (!ports.length) {
    host.appendChild(note('現在沒有本機服務在監聽。'))
    return
  }
  for (const item of ports) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'ws-port-row'
    row.title = `用內建瀏覽器開 http://127.0.0.1:${item.port}`
    const port = document.createElement('span')
    port.className = 'ws-port-num'
    port.textContent = String(item.port)
    const name = document.createElement('span')
    name.className = 'ws-port-proc'
    name.textContent = item.process || `PID ${item.pid}`
    row.append(port, name)
    row.addEventListener('click', () => void openBrowserTab(`http://127.0.0.1:${item.port}`))
    host.appendChild(row)
  }
}

/** 在系統檔案總管裡開這個專案（relPath 空字串＝專案根目錄，路徑仍由 main 解析）。 */
async function revealProject() {
  const project = currentProject()
  if (!project) return
  const seq = projectSeq
  try {
    await call(electronAPI.workspace.reveal(project.id, ''), '開不了這個資料夾')
  } catch {
    // call() 已經提示過了
  }
}

// ===== Git =====

/** 狀態字母 → 中文標籤（`.` 代表這一側沒有變動） */
const GIT_LABELS = { M: '改', A: '新', D: '刪', R: '改名', C: '複製', U: '衝突', '?': '未追蹤' }

/** 相對時間（log 列用）；只到「天」就夠，再舊直接給日期 */
function gitTimeOf(at) {
  const date = new Date(at * 1000)
  const diff = Date.now() - date.getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '剛剛'
  if (minutes < 60) return `${minutes} 分鐘前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小時前`
  const days = Math.floor(hours / 24)
  if (days < 14) return `${days} 天前`
  return date.toISOString().slice(0, 10)
}

/**
 * Git 面板的一列。`side` 決定徽章跟動作：staged（取消暫存）、
 * worktree（暫存／捨棄）、untracked（暫存／捨棄）。
 * @param {{ id: string }} project
 * @param {{ path: string, index: string, worktree: string, from: string }} file
 * @param {'staged' | 'worktree' | 'untracked'} side
 * @returns {HTMLElement}
 */
function gitRow(project, file, side) {
  const row = document.createElement('div')
  row.className = 'ws-git-row'
  row.title = file.from ? `${file.from} → ${file.path}` : file.path

  const letter = side === 'staged' ? file.index : file.worktree
  const badge = document.createElement('span')
  badge.className = `ws-git-badge ws-git-${letter === '?' ? 'untracked' : letter.toLowerCase()}`
  badge.textContent = GIT_LABELS[letter] || letter
  const name = document.createElement('span')
  name.className = 'ws-git-name'
  name.textContent = file.path
  row.append(badge, name)
  row.addEventListener('click', () => void openDiffTab(project, file.path, side === 'staged'))

  /** 捨棄的 3 秒二次確認（跟聊天刪除同一套：第一下變「確定？」，逾時收） */
  const armDiscard = (btn, run) => {
    if (btn.dataset.armed === '1') {
      run()
      return
    }
    btn.dataset.armed = '1'
    btn.textContent = '確定？'
    btn.classList.add('is-armed')
    window.setTimeout(() => {
      btn.dataset.armed = ''
      btn.textContent = '捨棄'
      btn.classList.remove('is-armed')
    }, 3000)
  }

  const act = (label, title, handler) => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'ws-git-act'
    btn.textContent = label
    btn.title = title
    btn.addEventListener('click', (event) => {
      event.stopPropagation()
      handler(btn)
    })
    return btn
  }

  const git = electronAPI.workspace
  const refresh = () => void renderGit()
  const untracked = side === 'untracked'
  if (side === 'staged') {
    row.append(act('取消', '取消暫存', (btn) => {
      btn.disabled = true
      void git.gitUnstage(project.id, file.path).then(refresh)
    }))
  } else {
    row.append(
      act('暫存', '加入暫存區', (btn) => {
        btn.disabled = true
        void git.gitStage(project.id, file.path).then(refresh)
      }),
      act(untracked ? '刪' : '捨棄', untracked ? '刪掉這個未追蹤的檔案' : '退回上一次提交的版本（救不回來）', (btn) => {
        armDiscard(btn, () => {
          btn.disabled = true
          void git.gitDiscard(project.id, file.path).then(refresh)
        })
      })
    )
  }
  return row
}

async function renderGit() {
  const project = currentProject()
  if (!project || !el.gitFiles) return
  let status
  try {
    status = await call(electronAPI.workspace.gitStatus(project.id), '讀不到 Git 狀態')
  } catch {
    return
  }
  if (!status.repo) {
    if (el.gitBranch) el.gitBranch.textContent = '不是 git 儲存庫'
    el.gitFiles.replaceChildren()
    const note = document.createElement('p')
    note.className = 'ws-tree-note'
    note.textContent = '不是 git 儲存庫'
    el.gitFiles.appendChild(note)
    el.worktrees?.replaceChildren()
    void renderGitLog()
    return
  }
  if (el.gitBranch) {
    const bits = [status.branch || '（detached HEAD）']
    if (status.ahead) bits.push(`↑${status.ahead}`)
    if (status.behind) bits.push(`↓${status.behind}`)
    el.gitBranch.textContent = bits.join(' ')
    el.gitBranch.title = status.upstream ? `上游：${status.upstream}` : '沒有設定上游'
  }

  const staged = status.files.filter((file) => file.index !== '.' && file.index !== '?')
  const changed = status.files.filter((file) => file.worktree !== '.' && file.worktree !== '?')
  const untracked = status.files.filter((file) => file.index === '?' && file.worktree === '?')

  el.gitFiles.replaceChildren()
  if (!status.files.length) {
    const note = document.createElement('p')
    note.className = 'ws-tree-note'
    note.textContent = '沒有變更'
    el.gitFiles.appendChild(note)
  } else {
    gitGroup(staged, 'staged', project, el.gitFiles)
    gitGroup(changed, 'worktree', project, el.gitFiles)
    gitGroup(untracked, 'untracked', project, el.gitFiles)
  }
  if (status.truncated) {
    const note = document.createElement('p')
    note.className = 'ws-tree-note'
    note.textContent = '只列出前面一部分'
    el.gitFiles.appendChild(note)
  }
  void renderWorktrees()
  void renderGitLog()
}

/**
 * git worktree 清單：同一個 repo 攤開在幾個資料夾裡。
 * 點分支名就切到那個專案（建立時已經幫它加進側欄了）。
 */
async function renderWorktrees() {
  const project = currentProject()
  if (!project || !el.worktrees) return
  let data
  try {
    data = await call(electronAPI.workspace.worktreeList(project.id), '讀不到工作樹')
  } catch {
    return
  }
  el.worktrees.replaceChildren()
  const trees = data?.trees || []
  if (trees.length <= 1) {
    const note = document.createElement('p')
    note.className = 'ws-worktree-empty'
    note.textContent = '只有主工作樹。按＋開一個新分支的工作樹。'
    el.worktrees.appendChild(note)
    return
  }
  for (const tree of trees) {
    const row = document.createElement('div')
    row.className = tree.current ? 'ws-worktree-row is-current' : 'ws-worktree-row'
    row.title = tree.path

    const branch = document.createElement('span')
    branch.className = 'ws-worktree-branch'
    branch.textContent = tree.branch || (tree.detached ? `(detached ${tree.head})` : tree.head)

    const tag = document.createElement('span')
    tag.className = 'ws-worktree-tag'
    tag.textContent = tree.main ? '主' : tree.locked ? '鎖定' : ''

    row.append(branch, tag)

    if (!tree.current) {
      const open = document.createElement('button')
      open.type = 'button'
      open.className = 'ws-worktree-open'
      open.title = '切到這個工作樹'
      open.setAttribute('aria-label', `切到 ${tree.branch || tree.path}`)
      open.textContent = '⇗'
      open.addEventListener('click', () => void openWorktree(tree.path))
      row.appendChild(open)
    }
    if (!tree.main) {
      const del = document.createElement('button')
      del.type = 'button'
      del.className = 'ws-worktree-del'
      del.title = '移除這個工作樹'
      del.setAttribute('aria-label', `移除 ${tree.branch || tree.path}`)
      del.textContent = '×'
      del.addEventListener('click', () => void removeWorktree(project, tree))
      row.appendChild(del)
    }
    el.worktrees.appendChild(row)
  }
}

/**
 * 切到某個工作樹＝切到側欄裡那個專案（`worktreeAdd` 建立時已經加進去了）。
 * @param {string} treePath
 */
async function openWorktree(treePath) {
  const target = projects.find((one) => samePath(one.path, treePath))
  if (!target) {
    showToast('那個工作樹不在專案清單裡，把資料夾拖進來就好', 'error')
    return
  }
  await selectProject(target.id)
}

/** Windows 的路徑比對不分大小寫，分隔符號也可能混用 */
const samePath = (a, b) => (
  String(a || '').replace(/[\\/]+$/, '').toLowerCase()
  === String(b || '').replace(/[\\/]+$/, '').toLowerCase()
)

/**
 * 開一個新工作樹。**只問名字**——資料夾位置由 main 決定（repo 的兄弟資料夾），
 * renderer 送得了路徑就等於能在任意位置建東西。
 */
async function addWorktree() {
  const project = currentProject()
  if (!project) return
  const name = window.prompt('新工作樹的分支名稱（同時也是資料夾名）', '')
  if (name === null) return
  const base = window.prompt('從哪個分支或 commit 開？留空＝目前的 HEAD', '') ?? ''
  try {
    const made = await call(electronAPI.workspace.worktreeAdd(project.id, name, base.trim()), '建不出工作樹')
    showToast(`已建立 ${made.branch}`)
    await reloadList()
    await renderWorktrees()
  } catch {
    // call() 已經提示過了
  }
}

/**
 * @param {{ id: string }} project
 * @param {{ path: string, branch: string }} tree
 */
async function removeWorktree(project, tree) {
  if (!window.confirm(`確定要移除工作樹 ${tree.branch || tree.path} 嗎？${NEWLINE}裡面還有沒提交的變更時 git 會擋下來。`)) return
  try {
    await call(electronAPI.workspace.worktreeRemove(project.id, tree.path), '移不掉')
    showToast('已移除工作樹')
    await reloadList()
    await renderWorktrees()
  } catch {
    // call() 已經提示過了
  }
}

/** 三組清單的共用殼（標題由 side 決定） */
function gitGroup(files, side, project, host) {
  if (!files.length) return
  const titleEl = document.createElement('p')
  titleEl.className = 'ws-git-group'
  titleEl.textContent = side === 'staged' ? '暫存區' : side === 'worktree' ? '變更' : '未追蹤'
  host.appendChild(titleEl)
  for (const file of files) host.appendChild(gitRow(project, file, side))
}

async function renderGitLog() {
  const project = currentProject()
  if (!project || !el.gitLog) return
  let log
  try {
    log = await call(electronAPI.workspace.gitLog(project.id), '讀不到提交紀錄')
  } catch {
    return
  }
  el.gitLog.replaceChildren()
  if (!log.length) {
    const note = document.createElement('p')
    note.className = 'ws-tree-note'
    note.textContent = '還沒有提交'
    el.gitLog.appendChild(note)
    return
  }
  for (const entry of log) {
    const row = document.createElement('p')
    row.className = 'ws-git-log-row'
    row.title = entry.subject
    const hash = document.createElement('code')
    hash.textContent = entry.short
    const subject = document.createElement('span')
    subject.textContent = entry.subject
    const time = document.createElement('span')
    time.className = 'ws-git-log-time'
    time.textContent = gitTimeOf(entry.at)
    row.append(hash, subject, time)
    el.gitLog.appendChild(row)
  }
}

async function stageAll() {
  const project = currentProject()
  if (!project) return
  try {
    await call(electronAPI.workspace.gitStageAll(project.id), '暫存失敗')
  } catch {
    return
  }
  await renderGit()
}

/**
 * 開啟所有 Git 變更檔案的 Diff 分頁
 */
async function openAllChanged() {
  const project = currentProject()
  if (!project) return
  let status
  try {
    status = await call(electronAPI.workspace.gitStatus(project.id), '讀不到 Git 狀態')
  } catch {
    return
  }
  if (!status?.files?.length) {
    showToast('目前沒有變更的檔案')
    return
  }
  for (const file of status.files) {
    const isStaged = file.index !== '.' && file.index !== '?'
    void openDiffTab(project, file.path, isStaged)
  }
}

async function commitStaged() {
  const project = currentProject()
  const message = /** @type {HTMLTextAreaElement | null} */ (el.gitMessage)?.value || ''
  if (!project) return
  try {
    await call(electronAPI.workspace.gitCommit(project.id, message, false), '提交失敗')
  } catch {
    return
  }
  if (el.gitMessage) /** @type {HTMLTextAreaElement} */ (el.gitMessage).value = ''
  showToast('已提交')
  await renderGit()
}

async function pushCurrent() {
  const project = currentProject()
  if (!project) return
  try {
    await call(electronAPI.workspace.gitPush(project.id), '推送失敗')
  } catch {
    return
  }
  showToast('已推送')
  await renderGit()
}

async function pullCurrent() {
  const project = currentProject()
  if (!project) return
  try {
    await call(electronAPI.workspace.gitPull(project.id), '拉取失敗')
  } catch {
    return
  }
  showToast('已拉取')
  await renderGit()
}

// ===== AI 對話記錄 =====

async function renderAgents() {
  const project = currentProject()
  if (!project || !el.agentList) return
  el.agentList.replaceChildren()
  const loading = document.createElement('p')
  loading.className = 'ws-tree-note'
  loading.textContent = '搜尋中…'
  el.agentList.appendChild(loading)

  let rows
  try {
    rows = await call(electronAPI.workspace.agentSessions(project.id), '讀不到 AI 記錄')
  } catch {
    return
  }
  // 讀取期間可能已經換過專案
  if (currentProject()?.id !== project.id) return

  el.agentList.replaceChildren()
  if (!rows.length) {
    const note = document.createElement('p')
    note.className = 'ws-tree-note'
    note.textContent = '最近 60 天沒有在這個資料夾跑過 Claude Code 或 Codex。'
    el.agentList.appendChild(note)
    return
  }
  for (const row of rows) {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'ws-agent-row'
    item.title = `檢視對話記錄（${row.id}）`

    const head = document.createElement('span')
    head.className = 'ws-agent-head'
    const agent = document.createElement('span')
    agent.className = `ws-agent-tag ws-agent-${row.agent}`
    agent.textContent = row.agentLabel
    const when = document.createElement('span')
    when.className = 'ws-agent-when'
    when.textContent = formatWhen(row.mtime)
    head.append(agent, when)

    const title = document.createElement('span')
    title.className = 'ws-agent-title'
    title.textContent = row.title || '（沒有標題）'

    item.append(head, title)
    item.addEventListener('click', () => void openAiSessionTab(project, row))
    el.agentList.appendChild(item)
  }
}

/**
 * @param {number} ms
 * @returns {string}
 */
function formatWhen(ms) {
  const diff = Date.now() - ms
  const hour = 60 * 60 * 1000
  if (diff < hour) return `${Math.max(1, Math.round(diff / 60000))} 分鐘前`
  if (diff < 24 * hour) return `${Math.round(diff / hour)} 小時前`
  const days = Math.round(diff / (24 * hour))
  return days <= 30 ? `${days} 天前` : new Date(ms).toLocaleDateString('zh-TW')
}

/**
 * 接續一段對話：指令字串由 main 的固定表組（renderer 不准自己拼）。
 * @param {{ agent: string, id: string, title: string, agentLabel: string }} row
 */
async function resumeSession(row) {
  let command
  try {
    command = await call(
      electronAPI.workspace.agentResumeCommand(row.agent, row.id),
      '組不出恢復指令'
    )
  } catch {
    return
  }
  await newTerminalWithCommand(`${row.agentLabel} · ${row.title || '接續'}`, command)
}

// ===== 對外 =====

/**
 * 工作區的三個全域快捷鍵：Ctrl+P 快速開檔、Ctrl+W 關分頁、Ctrl+Tab 切分頁。
 *
 * **只在使用者真的在看工作區時才收**（`#termMain` 看得見＝聊天頁在前、
 * 而且切到工作區那半邊），否則會把瀏覽器的列印快捷鍵搶走。
 * **焦點在終端機裡時三個都不收**——那三顆在 shell 裡本來就有意思
 * （Ctrl+W 刪一個詞、Ctrl+P 上一筆指令），搶走等於把終端機弄壞。
 *
 * @param {KeyboardEvent} event
 */
function onGlobalKeydown(event) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return
  const key = event.key.toLowerCase()
  if (key !== 'p' && key !== 'w' && event.key !== 'Tab') return
  const project = currentProject()
  const main = document.getElementById('termMain')
  if (!project || !main || main.offsetParent === null) return
  if (document.activeElement?.closest('#termHost')) return
  if (event.key === 'Tab') {
    event.preventDefault()
    void cycleTab(event.shiftKey ? -1 : 1)
    return
  }
  if (event.shiftKey) return
  if (key === 'w') {
    event.preventDefault()
    void closeActiveTab()
    return
  }
  if (isQuickOpenOpen()) return
  event.preventDefault()
  void openQuickOpen(project, (rel) => void openEditorTab(project, rel))
}

export function initWorkspacePage() {
  if (initialized) return
  initialized = true
  initWsTabs()

  el.list = document.getElementById('projList')
  el.newBtn = document.getElementById('projNewBtn')
  el.rightEmpty = document.getElementById('wsRightEmpty')
  el.panelFiles = document.getElementById('wsPanelFiles')
  el.panelGit = document.getElementById('wsPanelGit')
  el.panelAgents = document.getElementById('wsPanelAgents')
  el.filesProject = document.getElementById('wsFilesProject')
  el.tree = document.getElementById('wsTree')
  el.gitBranch = document.getElementById('wsGitBranch')
  el.gitFiles = document.getElementById('wsGitFiles')
  el.gitMessage = document.getElementById('wsGitMessage')
  el.gitLog = document.getElementById('wsGitLog')
  el.worktrees = document.getElementById('wsWorktrees')
  el.agentList = document.getElementById('wsAgentList')
  el.panelPorts = document.getElementById('wsPanelPorts')
  el.portList = document.getElementById('wsPortList')
  el.search = document.getElementById('wsSearch')
  el.searchInput = document.getElementById('wsSearchInput')
  el.searchResults = document.getElementById('wsSearchResults')

  el.newBtn?.addEventListener('click', () => void addProject())
  initProjectDrop()
  document.querySelectorAll('.ws-right-tab').forEach((btn) => {
    btn.addEventListener('click', () => setPanel(/** @type {HTMLElement} */ (btn).dataset.panel))
  })
  document.getElementById('wsFilesRevealBtn')?.addEventListener('click', () => void revealProject())
  document.getElementById('wsFilesRefreshBtn')?.addEventListener('click', () => void renderTree())
  document.getElementById('wsGitRefreshBtn')?.addEventListener('click', () => void renderGit())
  document.getElementById('wsWorktreeAddBtn')?.addEventListener('click', () => void addWorktree())
  document.getElementById('wsGitOpenAllBtn')?.addEventListener('click', () => void openAllChanged())
  document.getElementById('wsAgentsRefreshBtn')?.addEventListener('click', () => void renderAgents())
  document.getElementById('wsGitStageAllBtn')?.addEventListener('click', () => void stageAll())
  document.getElementById('wsGitCommitBtn')?.addEventListener('click', () => void commitStaged())
  document.getElementById('wsGitPushBtn')?.addEventListener('click', () => void pushCurrent())
  document.getElementById('wsGitPullBtn')?.addEventListener('click', () => void pullCurrent())
  document.getElementById('wsPortsRefreshBtn')?.addEventListener('click', () => void renderPorts())
  document.querySelectorAll('.ws-files-mode').forEach((btn) => {
    btn.addEventListener('click', () => {
      setFilesView(/** @type {HTMLElement} */ (btn).dataset.view)
      if (filesView === 'tree') void renderTree()
    })
  })
  el.tree?.setAttribute('role', 'tree')
  el.tree?.addEventListener('keydown', onTreeKeydown)
  // 樹的空白處＝專案根目錄（拖到最外層要有地方放）
  el.tree?.addEventListener('dragover', (event) => {
    if (!canDropInto('')) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    clearDropMarks()
    el.tree?.classList.add('is-drop')
  })
  el.tree?.addEventListener('dragleave', () => el.tree?.classList.remove('is-drop'))
  el.tree?.addEventListener('drop', (event) => {
    const project = currentProject()
    if (project) void onTreeDrop(event, project, null)
  })
  // ws-tabs 切到某個編輯器分頁時會發這個事件（用事件而不是 import，避免兩個模組互相 import）
  document.addEventListener('ws:active-file', (event) => {
    const detail = /** @type {CustomEvent<{ projectId: string, rel: string }>} */ (event).detail
    void markOpenFile(detail.projectId, detail.rel)
  })
  document.addEventListener('keydown', onGlobalKeydown)
  el.searchInput?.addEventListener('input', queueSearch)
  el.searchInput?.addEventListener('keydown', (event) => {
    if (/** @type {KeyboardEvent} */ (event).key === 'Enter') {
      window.clearTimeout(searchTimer)
      void runSearch()
    }
  })
}

export function refreshWorkspacePage() {
  initWorkspacePage()
  void reloadList().then(() => renderPanel()).catch(() => {})
}
