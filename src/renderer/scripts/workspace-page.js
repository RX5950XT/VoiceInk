import { electronAPI, showToast, setChatPaneMode } from './app.js'
import { createListReorder } from './list-reorder.js'
import { askConfirm, askInput, showAlert } from './app-dialog.js'
import { terminalStatuses } from './ws-terminal-status.js'
import { toolIcon, terminalStateIcon } from './ws-tool-icons.js'
import {
  initWsTabs,
  openEditorTab,
  openDiffTab,
  openBrowserTab,
  openAiSessionTab,
  setActiveProject,
  newTerminalWithCommand,
  closeActiveTab,
  cycleTab,
  retargetTabs,
  openReviewTab
} from './ws-tabs.js'
import { showMenu } from './ws-menu.js'
import { gitStatusShared, invalidateGitStatus } from './ws-git-status.js'
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
/** 檔案樹目前的 Git 狀態；key 是專案內相對路徑 */
let treeGitFiles = new Map()
/** 檔案樹目前各資料夾底下的變更檔案 */
let treeGitDirs = new Map()
/** 樹上現在畫的是哪個專案（換專案才需要先清空，同專案重畫留著舊樹避免閃爍） */
let treeProjectId = ''
/** 編輯器現在開著的那個檔案（相對路徑），用來在樹上標出來 */
let openRel = ''
/** 審閱：現在跟哪條分支比，以及那一輪的檔案清單 */
let reviewRef = ''
/** 監看事件的合併計時器（npm install 一秒幾千個事件，不能每個都重畫） */
let watchTimer = 0

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
  el.list.replaceChildren()
  if (!projects.length) {
    const empty = document.createElement('p')
    empty.className = 'chat-empty'
    empty.textContent = '拖入資料夾加入'
    el.list.appendChild(empty)
    return
  }
  for (const item of projects) el.list.appendChild(buildListItem(item))
  paintProjectStatuses()
}

function paintProjectStatuses() {
  for (const row of el.list?.querySelectorAll('.proj-list-item') || []) {
    const host = row.querySelector('.proj-status')
    if (!host) continue
    const sessions = terminalStatuses().filter((item) => item.projectId === row.dataset.id)
    if (!sessions.length) {
      if (host.querySelector('.proj-status-empty')) continue
      for (const chip of host.querySelectorAll('.proj-session-status')) chip.remove()
      const empty = document.createElement('span')
      empty.className = 'proj-status-empty'
      empty.textContent = '沒有終端機'
      host.appendChild(empty)
      continue
    }
    host.querySelector('.proj-status-empty')?.remove()
    const existing = new Map(
      [...host.querySelectorAll('.proj-session-status')].map((chip) => [chip.dataset.id, chip])
    )
    const keep = new Set()
    let node = host.firstElementChild
    for (const item of sessions) {
      keep.add(item.id)
      let chip = existing.get(item.id)
      if (chip) {
        patchSessionChip(chip, item)
        if (chip !== node) host.insertBefore(chip, node)
        node = chip.nextElementSibling
      } else {
        chip = buildSessionChip(item)
        host.insertBefore(chip, node)
        node = chip.nextElementSibling
      }
    }
    for (const [id, chip] of existing) {
      if (!keep.has(id)) chip.remove()
    }
  }
}

/**
 * 狀態沒變就留下正在轉的 SVG——每次 `terminal:status` 都拆掉重建的話，
 * 轉圈圈的 CSS 動畫永遠從 0% 重來，看起來像在抖。
 * @param {HTMLElement} chip
 * @param {{ id: string, title: string, preset?: string, state: string, stateLabel: string, exitCode?: number | null }} item
 */
function patchSessionChip(chip, item) {
  chip.title = `${item.title} · ${item.stateLabel}（依此 App 的終端機活動判定）`
  const preset = item.preset || 'shell'
  if (chip.dataset.preset !== preset) {
    chip.dataset.preset = preset
    const logo = chip.querySelector('.ws-tool-icon:not(.ws-status-icon)')
    const nextLogo = toolIcon(preset) || toolIcon('shell')
    if (logo && nextLogo) logo.replaceWith(nextLogo)
    else if (nextLogo && !logo) chip.insertBefore(nextLogo, chip.firstChild)
  }
  const exit = item.exitCode == null ? '' : String(item.exitCode)
  if (chip.dataset.state === item.state && (chip.dataset.exit || '') === exit) return
  chip.dataset.state = item.state
  chip.dataset.exit = exit
  const old = chip.querySelector('.ws-status-icon')
  const next = terminalStateIcon(item)
  if (old && next) old.replaceWith(next)
  else if (next) chip.appendChild(next)
  else old?.remove()
}

/**
 * 側欄上的一顆終端機：左邊是那一家 CLI 的標誌，右邊是執行狀態的圖示
 * （跑的時候轉圈圈，停下來是一個靜止的標示）。
 *
 * **只有圖示不放文字**：一個專案同時開三四顆很正常，每顆再帶一行
 * 「Claude Code · VoiceInk · 暫無輸出」的話，側欄整個被狀態文字塞滿，
 * 而專案名稱反而看不見。完整的一句話留在 `title` 裡。
 *
 * @param {{ id: string, title: string, preset?: string, state: string, stateLabel: string, exitCode?: number | null }} item
 * @returns {HTMLElement}
 */
function buildSessionChip(item) {
  const chip = document.createElement('span')
  chip.className = 'proj-session-status'
  chip.dataset.state = item.state
  chip.dataset.id = item.id
  chip.dataset.exit = item.exitCode == null ? '' : String(item.exitCode)
  chip.dataset.preset = item.preset || 'shell'
  const logo = toolIcon(item.preset || 'shell') || toolIcon('shell')
  if (logo) chip.appendChild(logo)
  const state = terminalStateIcon(item)
  if (state) chip.appendChild(state)
  chip.title = `${item.title} · ${item.stateLabel}（依此 App 的終端機活動判定）`
  return chip
}

const TERMS_COLLAPSED_KEY = 'wsProjTermsCollapsed'

/** 收起了終端機清單的專案 id（存 localStorage，重畫與重開都留著）。 */
function collapsedProjects() {
  try {
    const raw = JSON.parse(localStorage.getItem(TERMS_COLLAPSED_KEY) || '[]')
    return new Set(Array.isArray(raw) ? raw.map(String) : [])
  } catch {
    return new Set()
  }
}

/**
 * 專案那一列右邊的箭頭：把底下的終端機狀態清單收起／展開。
 * @param {HTMLElement} row
 * @param {string} id
 * @returns {HTMLButtonElement}
 */
function buildTermsToggle(row, id) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'chat-list-btn proj-terms-toggle'
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', 'M8 10l4 4 4-4')
  svg.appendChild(path)
  btn.appendChild(svg)
  const paint = (open) => {
    btn.setAttribute('aria-expanded', String(open))
    btn.title = open ? '收起終端機清單' : '展開終端機清單'
    btn.setAttribute('aria-label', btn.title)
    row.classList.toggle('terms-collapsed', !open)
  }
  paint(!collapsedProjects().has(id))
  btn.addEventListener('click', (event) => {
    event.stopPropagation()
    const next = btn.getAttribute('aria-expanded') !== 'true'
    paint(next)
    const set = collapsedProjects()
    if (next) set.delete(id)
    else set.add(id)
    try {
      localStorage.setItem(TERMS_COLLAPSED_KEY, JSON.stringify([...set]))
    } catch {
      /* 隱私模式寫不進去就算了，這一輪照樣收得起來 */
    }
  })
  return btn
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

  // 路徑刻意不畫在側欄上：一個專案就是一個標題，剩下的空間留給終端機狀態。
  // 完整路徑滑到標題上就看得到（右鍵選單裡也有「在檔案總管開啟」）。
  title.title = item.path

  const status = document.createElement('span')
  status.className = 'proj-status'
  open.append(title)
  if (item.missing) {
    const warn = document.createElement('span')
    warn.className = 'proj-missing'
    warn.textContent = '找不到'
    warn.title = `這個資料夾現在不存在：${item.path}`
    open.appendChild(warn)
  }
  open.appendChild(status)
  open.addEventListener('click', () => void selectProject(item.id))

  row.append(open, buildTermsToggle(row, item.id))
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    showProjectMenu({ x: event.clientX, y: event.clientY }, row, item)
  })
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
    // 分頁是跟著專案走的：先切過去，不然終端機會落在別的專案那一組分頁裡
    if (currentId !== item.id) await selectProject(item.id)
    const created = await call(electronAPI.terminal.create({
      preset: 'shell',
      cwd: item.path,
      projectId: item.id,
      admin
    }), '建立終端機失敗')
    const mod = await import('./terminal-page.js')
    await mod.openTerminalSession(created.id)
  } catch {
    // call 已顯示提示
  }
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
 * 專案列的右鍵選單（取代以前 hover 才出現的三顆小鈕——hover 在觸控裝置上等於沒有）。
 *
 * 移除仍然是兩步：選了之後再開一次選單問「確定移除」，
 * 免得右鍵手滑就把專案從側欄弄不見。
 *
 * @param {{ x: number, y: number }} at
 * @param {HTMLElement} row
 * @param {{ id: string, name: string, path: string }} item
 */
function showProjectMenu(at, row, item) {
  showMenu(at, [
    { label: '在此開啟終端機', onSelect: () => void launchProjectTerminal(item, false) },
    { label: '以管理員身分開啟終端機', onSelect: () => void launchProjectTerminal(item, true) },
    { label: '重新命名', onSelect: () => startRename(row, item) },
    {
      label: '從清單移除…',
      danger: true,
      onSelect: () => showMenu(at, [
        { label: `確定移除「${item.name}」`, danger: true, onSelect: () => void removeProject(item) }
      ])
    }
  ])
}

/**
 * **只從清單移除，不碰磁碟上的資料夾**。
 * @param {{ id: string }} item
 */
async function removeProject(item) {
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
  if (currentId && !projects.some((item) => item.id === currentId)) {
    currentId = ''
    announceProject()
    // 沒有專案了就把監看收掉（那個 watcher 掛在一個已經不在清單裡的資料夾上）
    void electronAPI.workspace.unwatch?.().catch(() => {})
  }
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
  try { localStorage.setItem('wsLastProject', project.id) } catch { /* 版面偏好不影響專案資料 */ }
  expanded = new Set()
  selected = new Set()
  anchorRel = ''
  reviewRef = ''
  // 換專案＝上一個專案的變更清單與篩選條件全部作廢（留著會拿 A 的字去篩 B 的檔案）
  gitFilter = ''
  lastGitStatus = null
  if (el.gitFilter) /** @type {HTMLInputElement} */ (el.gitFilter).value = ''
  setChatPaneMode('workspace')
  announceProject()
  startWatching(project.id)
  renderList()
  await renderPanel(project, seq)
  return seq === projectSeq
}

/**
 * 告訴別的模組「現在選著哪個專案」（聊天側欄靠它決定新對話掛在哪）。
 * 用事件而不是互相 import：兩邊都是 lazy load 的，載入順序不固定。
 */
function announceProject() {
  const project = currentProject()
  document.dispatchEvent(new CustomEvent('ws:project', {
    detail: { id: project?.id || '', name: project?.name || '' }
  }))
}

/**
 * 監看目前這個專案的資料夾。一次只看一個——切過去就換成新的那個。
 * 監看不起來（網路磁碟）不是錯誤，安靜退回手動重新整理。
 * @param {string} projectId
 */
function startWatching(projectId) {
  void electronAPI.workspace.watch?.(projectId).catch(() => {})
}

/**
 * 資料夾有東西變了（AI 跑完、git 換分支、另一個編輯器存檔）。
 *
 * 事件已經在 main 合併過一輪，這裡再合併一次：連續的變動只重畫最後一次。
 * @param {{ projectId: string, paths: string[], git: boolean, overflow: boolean }} payload
 */
function onProjectChanged(payload) {
  if (!payload || payload.projectId !== currentId) return
  window.clearTimeout(watchTimer)
  watchTimer = window.setTimeout(() => {
    const project = currentProject()
    if (!project) return
    if (panel === 'git') void renderGit()
    else if (panel === 'files' && filesView === 'tree') void refreshTreeKeepingScroll()
    // 編輯器那邊自己決定要不要跳提示條（它知道哪個檔案開著、草稿動過沒有）
    document.dispatchEvent(new CustomEvent('ws:files-changed', { detail: payload }))
  }, 350)
}

/**
 * 重讀檔案樹但**留在原地**：展開狀態本來就在 `expanded` 裡，
 * 捲動位置要自己記一下，不然每次別人存檔畫面就跳回最上面。
 */
async function refreshTreeKeepingScroll() {
  const top = el.tree?.scrollTop || 0
  await renderTree()
  if (el.tree) el.tree.scrollTop = top
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

/** 資料夾提示最多列幾個檔名 */
const DIR_SAMPLES = 4

/** Git 回傳的路徑統一成檔案樹使用的 `/`，並去掉未追蹤資料夾的尾斜線。 */
function normalizeGitPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
}

/**
 * 讀檔案樹需要的 Git 狀態。非 Git 資料夾或 git 暫時讀不到時，檔案樹照常顯示。
 * @param {{ id: string }} project
 * @param {number} seq
 * @param {number} request
 * @returns {Promise<boolean>}
 */
async function loadTreeGitStatus(project, seq, request) {
  let result = null
  try {
    // 跟編輯器的「未提交變更」鈕共用同一趟（`ws-git-status.js`）
    result = await gitStatusShared(project.id)
  } catch {
    // 沒有 git 的普通資料夾仍然可以使用檔案總管
  }
  if (!isCurrentProject(project, seq) || request !== treeSeq) return false

  const rows = result?.ok && result.data?.repo && Array.isArray(result.data.files)
    ? result.data.files
    : []
  const files = new Map()
  const dirs = new Map()
  for (const row of rows) {
    if (!row || typeof row.path !== 'string') continue
    const rel = normalizeGitPath(row.path)
    if (!rel) continue
    files.set(rel, { ...row, path: rel })
    const parts = rel.split('/')
    for (let i = 1; i < parts.length; i += 1) {
      const dir = parts.slice(0, i).join('/')
      const previous = dirs.get(dir) || { count: 0, files: [] }
      // 提示只印得下前 DIR_SAMPLES 個，所以不留整份清單——
      // `[...previous.files, rel]` 每個檔案每一層都複製一次成長中的陣列（O(n²)）。
      previous.count += 1
      if (previous.files.length < DIR_SAMPLES) previous.files.push(rel)
      dirs.set(dir, previous)
    }
  }
  treeGitFiles = files
  treeGitDirs = dirs
  return true
}

/**
 * 取得檔案樹一列的 Git 標記；資料夾顯示底下變更檔案數，檔案標記可開 Diff。
 * @param {{ name: string, rel: string, dir: boolean }} entry
 * @returns {{ label: string, className: string, title: string, staged?: boolean } | null}
 */
function treeStatusInfo(entry) {
  const rel = normalizeGitPath(entry.rel)
  const file = treeGitFiles.get(rel)
  if (!entry.dir && file) {
    const index = typeof file.index === 'string' ? file.index : '.'
    const worktree = typeof file.worktree === 'string' ? file.worktree : '.'
    const code = worktree !== '.' && worktree !== '?' ? worktree : index
    if (code === '.' || !code) return null
    const staged = worktree === '.' && index !== '.' && index !== '?'
    const label = GIT_LABELS[code] || '改'
    return {
      label,
      className: code === '?' || code === 'A' ? 'is-new' : code === 'U' ? 'is-conflict' : 'is-changed',
      title: `${label}（${staged ? '已暫存，尚未提交' : '尚未提交'}）`,
      staged
    }
  }
  if (entry.dir) {
    // 整個資料夾都是新的時候，git 只回**一筆** `? newdir/`（沒有底下的檔案），
    // 所以它落在 files 而不是 dirs。只查 dirs 的話，新增一整個資料夾在樹上
    // 完全看不出來——連裡面的檔案也不會有標記。
    if (file) {
      return { label: GIT_LABELS['?'] || '新', className: 'is-new', title: '整個資料夾都還沒加入版控' }
    }
    const info = treeGitDirs.get(rel)
    if (info?.count) {
      const paths = info.files.join('、')
      const more = info.count > info.files.length ? '…' : ''
      return {
        label: `改 ${info.count}`,
        className: 'is-folder',
        title: `底下有變更：${paths}${more}`
      }
    }
  }
  return null
}

/**
 * 一次只展開一層：真的去 `listDir` 那一層，不預先遞迴（大 repo 會卡好幾秒）。
 */
async function renderTree(project = currentProject(), seq = projectSeq) {
  const request = ++treeSeq
  if (!isCurrentProject(project, seq) || !el.tree) return
  // 換專案才清空——不然會點到上一個專案的列。同一個專案只就地改動：
  // 監看最快每秒一次，先清再等 git status／listDir 等於整棵樹閃白。
  if (treeProjectId !== project.id) el.tree.replaceChildren()
  treeProjectId = project.id
  if (!await loadTreeGitStatus(project, seq, request)) return
  if (el.filesProject) {
    el.filesProject.textContent = project.name
    el.filesProject.title = project.path
  }
  await syncLevel(project, '', el.tree, 0, seq, request)
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
 * 監看刷新：對這一層就地增刪改，不把整棵拆掉重畫。
 * @param {{ id: string }} project
 * @param {string} relPath
 * @param {HTMLElement} host
 * @param {number} depth
 * @param {number} seq
 * @param {number} request
 */
async function syncLevel(project, relPath, host, depth, seq, request) {
  let listed
  try {
    listed = await call(electronAPI.workspace.listDir(project.id, relPath), '讀不到資料夾')
  } catch {
    return
  }
  if (!isCurrentProject(project, seq) || request !== treeSeq) return
  let node = skipNonRows(host.firstElementChild)
  for (const entry of listed.entries) {
    if (!isCurrentProject(project, seq) || request !== treeSeq) return
    node = skipNonRows(node)
    node = await syncEntry(project, entry, host, node, depth, seq, request)
  }
  while (node) {
    const doomed = node
    node = node.nextElementSibling
    doomed.remove()
  }
  if (listed.truncated) {
    const note = document.createElement('p')
    note.className = 'ws-tree-note'
    note.textContent = '只列出前面一部分'
    host.appendChild(note)
  }
}

/** @param {Element | null} node @returns {Element | null} */
function skipNonRows(node) {
  while (node && !node.classList.contains('ws-tree-row')) {
    const doomed = node
    node = node.nextElementSibling
    doomed.remove()
  }
  return node
}

/** @param {HTMLElement} row @returns {HTMLElement | null} */
function takeChildren(row) {
  const next = row.nextElementSibling
  return next?.classList.contains('ws-tree-children') ? next : null
}

/** @param {Element | null} node @param {string} rel @returns {HTMLElement | null} */
function findRowFrom(node, rel) {
  while (node) {
    if (node.classList.contains('ws-tree-row') && /** @type {HTMLElement} */ (node).dataset.rel === rel) {
      return /** @type {HTMLElement} */ (node)
    }
    node = node.nextElementSibling
  }
  return null
}

/**
 * @param {{ id: string }} project
 * @param {{ name: string, rel: string, dir: boolean, ignored?: boolean }} entry
 * @param {HTMLElement} host
 * @param {Element | null} node
 * @param {number} depth
 * @param {number} seq
 * @param {number} request
 * @returns {Promise<Element | null>}
 */
async function syncEntry(project, entry, host, node, depth, seq, request) {
  let row = node && /** @type {HTMLElement} */ (node).dataset.rel === entry.rel
    ? /** @type {HTMLElement} */ (node)
    : null
  if (!row) {
    const found = findRowFrom(node, entry.rel)
    if (found) {
      const kids = takeChildren(found)
      host.insertBefore(found, node)
      if (kids) host.insertBefore(kids, node)
      row = patchTreeRow(found, project, entry, depth)
    } else {
      row = buildTreeRow(project, entry, depth)
      host.insertBefore(row, node)
    }
  } else {
    row = patchTreeRow(row, project, entry, depth)
  }
  const wantKids = Boolean(entry.dir && expanded.has(entry.rel))
  let kids = takeChildren(row)
  if (wantKids) {
    if (!kids) {
      kids = document.createElement('div')
      kids.className = 'ws-tree-children'
      row.after(kids)
    }
    await syncLevel(project, entry.rel, kids, depth + 1, seq, request)
    return kids.nextElementSibling
  }
  if (kids) kids.remove()
  return row.nextElementSibling
}

/**
 * @param {{ id: string, name: string }} project
 * @param {{ name: string, rel: string, dir: boolean, ignored?: boolean }} entry
 * @param {number} depth
 * @returns {HTMLElement}
 */
function buildTreeRow(project, entry, depth) {
  const row = document.createElement('div')
  row.className = entry.dir ? 'ws-tree-row is-dir' : 'ws-tree-row'
  row.style.paddingLeft = `${8 + depth * 12}px`
  row.title = entry.rel
  row.dataset.rel = entry.rel
  row.dataset.depth = String(depth)
  if (entry.dir) row.dataset.dir = '1'
  // 被 .gitignore 排除的變暗：看得到、點得開，但一眼知道提交不會帶到
  if (entry.ignored) {
    row.classList.add('is-ignored')
    row.title = `${entry.rel}（被 .gitignore 排除，不會提交）`
  }
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

  const status = treeStatusInfo(entry)
  if (status) row.appendChild(buildTreeStatus(project, entry, status))

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
 * 就地改一列的 Git 標記／開檔高亮，不重綁點擊。檔案變資料夾才整列換掉。
 * @param {HTMLElement} row
 * @param {{ id: string, name: string }} project
 * @param {{ name: string, rel: string, dir: boolean, ignored?: boolean }} entry
 * @param {number} depth
 * @returns {HTMLElement}
 */
function patchTreeRow(row, project, entry, depth) {
  if (Boolean(row.dataset.dir) !== entry.dir) {
    const next = buildTreeRow(project, entry, depth)
    takeChildren(row)?.remove()
    row.replaceWith(next)
    return next
  }
  row.classList.toggle('is-ignored', Boolean(entry.ignored))
  row.classList.toggle('is-open', !entry.dir && entry.rel === openRel)
  row.classList.toggle('is-selected', selected.has(entry.rel))
  row.style.paddingLeft = `${8 + depth * 12}px`
  row.dataset.depth = String(depth)
  row.title = entry.ignored ? `${entry.rel}（被 .gitignore 排除，不會提交）` : entry.rel
  if (entry.dir) {
    row.setAttribute('aria-expanded', expanded.has(entry.rel) ? 'true' : 'false')
  }
  const caret = row.querySelector('.ws-tree-caret')
  if (caret) caret.textContent = entry.dir ? (expanded.has(entry.rel) ? '▾' : '▸') : ''
  const name = row.querySelector('.ws-tree-name')
  if (name && name.textContent !== entry.name) name.textContent = entry.name
  const status = treeStatusInfo(entry)
  let statusEl = row.querySelector('.ws-tree-status')
  if (status) {
    if (!statusEl) row.appendChild(buildTreeStatus(project, entry, status))
    else paintTreeStatus(statusEl, entry, status)
  } else {
    statusEl?.remove()
  }
  return row
}

/**
 * @param {{ id: string }} project
 * @param {{ name: string, rel: string, dir: boolean }} entry
 * @param {{ label: string, className: string, title: string, staged?: boolean }} status
 * @returns {HTMLElement}
 */
function buildTreeStatus(project, entry, status) {
  const statusEl = document.createElement('span')
  paintTreeStatus(statusEl, entry, status)
  if (!entry.dir) {
    statusEl.setAttribute('role', 'button')
    statusEl.tabIndex = 0
    const openDiff = () => void openDiffTab(project, entry.rel, statusEl.dataset.staged === '1')
    statusEl.addEventListener('click', (event) => {
      event.stopPropagation()
      openDiff()
    })
    statusEl.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      event.stopPropagation()
      openDiff()
    })
  }
  return statusEl
}

/**
 * @param {HTMLElement} badge
 * @param {{ rel: string }} entry
 * @param {{ label: string, className: string, title: string, staged?: boolean }} status
 */
function paintTreeStatus(badge, entry, status) {
  badge.className = `ws-tree-status ${status.className}`
  badge.textContent = status.label
  badge.title = status.title
  badge.setAttribute('aria-label', `${entry.rel}：${status.title}`)
  badge.dataset.staged = status.staged ? '1' : ''
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
  // 以「這一列現在畫成什麼樣」為準，不是 `expanded`：重畫是非同步的（要先等 git status），
  // 那段時間畫面上還是舊的一棵樹。照 `expanded` 判斷的話，使用者看到 ▸ 點下去卻是收起來。
  if (row.getAttribute('aria-expanded') === 'true') {
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
  const canDrop = list.length > 0 && canDropInto(toDir)
  dragging = []
  if (!canDrop) return

  const seq = projectSeq
  let moved = 0
  for (const rel of list) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const to = await call(electronAPI.workspace.moveEntry(project.id, rel, toDir), '搬不過去')
      retargetTabs(project.id, rel, to.rel)
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
  const active = document.activeElement instanceof HTMLElement
    ? document.activeElement.closest('.ws-tree-row')
    : null
  if (active && el.tree?.contains(active)) {
    setTreeCursor(active)
    return
  }
  if (rows.some((row) => row.tabIndex === 0)) return
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
    // 列是 `<div role="treeitem">` 不是 `<button>`（button 撐不出樹的縮排與拖曳），
    // 所以 Enter／Space 要自己補：少了它，鍵盤走得到那一列卻打不開檔案。
    case 'Enter':
    case ' ':
      if (!current) return
      event.preventDefault()
      current.click()
      return
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
  const name = await askInput(dir ? '新資料夾的名稱' : '新檔案的名稱', { confirmText: '建立' })
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
  const name = await askInput('新的名稱', { value: entry.name, confirmText: '改名' })
  if (name === null || name === entry.name) return
  const seq = projectSeq
  try {
    const renamed = await call(electronAPI.workspace.renameEntry(project.id, entry.rel, name), '改名失敗')
    // 開著的分頁要跟著換到新路徑，不然存檔會把舊名字重新建出來
    retargetTabs(project.id, entry.rel, renamed.rel)
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
  const yes = await askConfirm(`確定要刪除 ${entry.rel} 嗎？`, {
    desc: `會刪掉${what}，而且救不回來。`,
    confirmText: '刪除',
    danger: true
  })
  if (!yes) return
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
  const yes = await askConfirm(`確定要刪除這 ${rels.length} 個嗎？`, {
    desc: `救不回來。${NEWLINE}${NEWLINE}${preview}${more}`,
    confirmText: '刪除',
    danger: true
  })
  if (!yes) return
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
// `?`（未追蹤）故意只寫一個字：那一組的標題已經寫著「未追蹤」，每一列再寫三個字
// 只會把檔名的空間吃掉（面板只有 280px）。
const GIT_LABELS = { M: '改', A: '新', D: '刪', R: '改名', C: '複製', U: '衝突', '?': '新' }

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
 * 一條相對路徑拆成「檔名」與「它在哪個資料夾」。
 *
 * 面板很窄（280px），整條路徑印出來只會看到一串省略號中間的目錄名，
 * 真正要認的檔名反而被擠掉。拆成兩段之後檔名永遠在最左邊。
 *
 * @param {string} relPath
 * @returns {{ name: string, dir: string }}
 */
function splitGitPath(relPath) {
  const text = String(relPath || '')
  const cut = text.lastIndexOf('/')
  return cut < 0 ? { name: text, dir: '' } : { name: text.slice(cut + 1), dir: text.slice(0, cut) }
}

/**
 * 一列右邊的 `+12 −3`。兩個都是 0（或根本沒數字）就整個不畫——
 * 印一個「+0 −0」只是佔位，讀的人還得停下來想那是什麼意思。
 *
 * @param {{ added?: number, removed?: number, binary?: boolean }} file
 * @returns {HTMLElement | null}
 */
function gitLineCounts(file) {
  if (file.binary) return null
  const added = Number(file.added) || 0
  const removed = Number(file.removed) || 0
  if (!added && !removed) return null
  const wrap = document.createElement('span')
  wrap.className = 'ws-git-lines'
  wrap.title = `新增 ${added} 行、刪除 ${removed} 行（跟上一次提交比）`
  if (added) {
    const plus = document.createElement('span')
    plus.className = 'ws-git-added'
    plus.textContent = `+${added}`
    wrap.appendChild(plus)
  }
  if (removed) {
    const minus = document.createElement('span')
    minus.className = 'ws-git-removed'
    minus.textContent = `−${removed}`
    wrap.appendChild(minus)
  }
  return wrap
}

/**
 * Git 面板的一列。`side` 決定徽章跟動作：staged（取消暫存）、
 * worktree（暫存／捨棄）、untracked（暫存／捨棄）、conflict（解決了）。
 *
 * 動作鈕**常駐**不做「hover 才出現」：面板很窄，滑鼠沒經過就等於沒有那顆按鈕
 * （鍵盤與觸控更是完全按不到）。
 *
 * @param {{ id: string }} project
 * @param {{ path: string, index: string, worktree: string, from: string, added?: number, removed?: number, binary?: boolean }} file
 * @param {'staged' | 'worktree' | 'untracked' | 'conflict'} side
 * @param {Set<string>} [ambiguous] 這份清單裡撞名的檔名（只有這些列會印出所在資料夾）
 * @returns {HTMLElement}
 */
function gitRow(project, file, side, ambiguous) {
  const row = document.createElement('div')
  row.className = 'ws-git-row'
  row.title = file.from ? `${file.from} → ${file.path}` : file.path

  const letter = side === 'staged' ? file.index : file.worktree
  const badge = document.createElement('span')
  badge.className = `ws-git-badge ws-git-${letter === '?' ? 'untracked' : letter.toLowerCase()}`
  badge.textContent = GIT_LABELS[letter] || letter

  const { name: fileName, dir } = splitGitPath(file.path)
  const name = document.createElement('span')
  name.className = 'ws-git-name'
  const base = document.createElement('span')
  base.className = 'ws-git-basename'
  base.textContent = fileName
  name.appendChild(base)
  // 目錄**只在檔名撞名時才印**（跟 VS Code 一樣）：那一格扣掉徽章、行數與兩顆動作鈕
  // 只剩一百多 px，每一列都掛一段路徑的話，被截掉的會是真正要認的檔名
  // （實測畫面上一排 `e2e-termina…`／`workspac…`，完全認不出是哪一支）。
  if (dir && ambiguous?.has(fileName)) {
    const parent = document.createElement('span')
    parent.className = 'ws-git-dir'
    parent.textContent = dir
    name.appendChild(parent)
  }
  row.append(badge, name)
  const counts = gitLineCounts(file)
  if (counts) row.appendChild(counts)
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
  if (side === 'conflict') {
    // 衝突檔案只給一顆「解決了」＝`git add`。捨棄不放在這裡：
    // 合併到一半按下去救不回來，而且那不是這一列該做的事
    row.append(act('解決了', '把這個檔案標成已解決（git add）', (btn) => {
      btn.disabled = true
      void git.gitStage(project.id, file.path).then(refresh)
    }))
  } else if (side === 'staged') {
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

/** 篩選框要到這麼多檔案才出現（少於這個數目直接用眼睛掃比較快） */
const GIT_FILTER_MIN_FILES = 8

/** 篩選框裡打的字（已經轉小寫）。切專案時會清掉。 */
let gitFilter = ''

/** 上一次讀到的 git status；篩選重畫時拿它，不重跑一次 `git status` */
let lastGitStatus = null

/**
 * 面板最上面那一行：分支名 ＋ 領先／落後上游幾筆。
 *
 * 以前是把 `main ↑2 ↓1` 接成一個字串塞進去，箭頭跟分支名同一個顏色、
 * 分不出哪個是要推的哪個是要拉的。改成兩顆各自上色的 chip。
 *
 * @param {{ branch?: string, upstream?: string, ahead?: number, behind?: number }} status
 */
function paintGitBranch(status) {
  if (!el.gitBranch) return
  el.gitBranch.replaceChildren()
  const name = document.createElement('span')
  name.className = 'ws-git-branch-name'
  name.textContent = status.branch || '（detached HEAD）'
  el.gitBranch.appendChild(name)

  const chip = (text, cls, title) => {
    const span = document.createElement('span')
    span.className = `ws-git-chip ${cls}`
    span.textContent = text
    span.title = title
    return span
  }
  if (status.ahead) el.gitBranch.appendChild(chip(`↑${status.ahead}`, 'is-ahead', `有 ${status.ahead} 筆還沒推上去`))
  if (status.behind) el.gitBranch.appendChild(chip(`↓${status.behind}`, 'is-behind', `上游多了 ${status.behind} 筆還沒拉下來`))
  el.gitBranch.title = status.upstream ? `上游：${status.upstream}` : '沒有設定上游'
}

async function renderGit() {
  const project = currentProject()
  if (!project || !el.gitFiles) return
  // 每一個會動到 git 的操作（暫存／取消／捨棄／全部暫存／提交／推送／拉取）
  // 最後都會回到這裡重畫，所以共用快取的失效點放這一個就夠。
  invalidateGitStatus()
  const seq = projectSeq
  let status
  try {
    status = await call(electronAPI.workspace.gitStatus(project.id), '讀不到 Git 狀態')
  } catch {
    return
  }
  // 讀取期間可能已經換過專案：畫下去等於把 A 的變更清單掛在 B 上
  if (!isCurrentProject(project, seq)) return
  if (!status.repo) {
    if (el.gitBranch) el.gitBranch.replaceChildren(document.createTextNode('不是 git 儲存庫'))
    lastGitStatus = null
    if (el.gitFilter) el.gitFilter.hidden = true
    el.gitFiles.replaceChildren()
    const note = document.createElement('p')
    note.className = 'ws-tree-note'
    note.textContent = '不是 git 儲存庫'
    el.gitFiles.appendChild(note)
    el.worktrees?.replaceChildren()
    // 審閱那一區也要跟著清掉：留著的話上一個專案的分支還列在那裡，
    // 按「比較」會拿別的 repo 的分支名去比，錯誤訊息是「沒有共同的起點」
    el.reviewRef?.replaceChildren()
    el.reviewFiles?.replaceChildren()
    reviewRef = ''
    void renderGitLog()
    return
  }
  paintGitBranch(status)
  lastGitStatus = status
  paintGitFiles(project, status)
  void renderWorktrees()
  void renderGitLog()
  void renderBranches()
}

/**
 * 把變更清單畫出來。**篩選只走這一支，不重問 main**：每打一個字就跑一次
 * `git status`（大 repo 上是好幾百毫秒的子程序）會讓輸入整個卡住。
 *
 * @param {{ id: string }} project
 * @param {{ files: Array<object>, truncated?: boolean }} status
 */
function paintGitFiles(project, status) {
  if (!el.gitFiles) return
  // 衝突（porcelain 的 `u` 記錄）要自己一組排最上面：混在「暫存區」與「變更」
  // 兩組裡的話，同一個檔案會出現兩次，而且看不出它其實是合併沒解完
  const conflicts = status.files.filter((file) => file.index === 'U' || file.worktree === 'U')
  const rest = status.files.filter((file) => !conflicts.includes(file))
  const staged = rest.filter((file) => file.index !== '.' && file.index !== '?')
  const changed = rest.filter((file) => file.worktree !== '.' && file.worktree !== '?')
  const untracked = rest.filter((file) => file.index === '?' && file.worktree === '?')

  // 篩選框只有在真的有一堆檔案時才有意義；三五個檔案還要先打字反而礙事
  if (el.gitFilter) el.gitFilter.hidden = status.files.length < GIT_FILTER_MIN_FILES
  if (el.gitFilter?.hidden) gitFilter = ''
  const keep = (files) => (gitFilter ? files.filter((file) => file.path.toLowerCase().includes(gitFilter)) : files)

  // 哪些檔名在這份清單裡不只一個（`index.js` 這種）——只有它們需要在列上印出所在資料夾
  const seen = new Map()
  for (const file of status.files) {
    const base = splitGitPath(file.path).name
    const paths = seen.get(base) || new Set()
    paths.add(file.path)
    seen.set(base, paths)
  }
  const ambiguous = new Set([...seen].filter(([, paths]) => paths.size > 1).map(([base]) => base))

  el.gitFiles.replaceChildren()
  /** @type {Array<[Array<object>, 'conflict' | 'staged' | 'worktree' | 'untracked']>} */
  const groups = [
    [keep(conflicts), 'conflict'],
    [keep(staged), 'staged'],
    [keep(changed), 'worktree'],
    [keep(untracked), 'untracked']
  ]
  const shown = groups.reduce((sum, [files]) => sum + files.length, 0)
  const note = (text) => {
    const p = document.createElement('p')
    p.className = 'ws-tree-note'
    p.textContent = text
    el.gitFiles.appendChild(p)
  }
  if (!status.files.length) note('沒有變更')
  else if (!shown) note(`沒有檔名含「${gitFilter}」的變更`)
  else for (const [files, side] of groups) gitGroup(files, side, project, el.gitFiles, ambiguous)
  if (status.truncated) note('只列出前面一部分')
}

/**
 * 「跟哪條分支比」的下拉。分支清單由 main 給（`for-each-ref`，依最後提交時間排），
 * renderer 只把選到的名字送回去——那個字串會變成 git 的參數，main 還會再驗一次。
 */
async function renderBranches() {
  const project = currentProject()
  const select = /** @type {HTMLSelectElement | null} */ (el.reviewRef)
  if (!project || !select) return
  const seq = projectSeq
  let data
  try {
    data = await call(electronAPI.workspace.gitBranches(project.id), '讀不到分支清單')
  } catch {
    return
  }
  if (!isCurrentProject(project, seq)) return
  const list = data?.branches || []
  select.replaceChildren()
  if (!list.length) {
    const opt = document.createElement('option')
    opt.value = ''
    opt.textContent = '（沒有其他分支）'
    select.appendChild(opt)
    return
  }
  for (const branch of list) {
    // 自己那條不必列（跟自己比沒有東西）
    if (branch.name === data.current) continue
    const opt = document.createElement('option')
    opt.value = branch.name
    opt.textContent = branch.remote ? `${branch.name}（遠端）` : branch.name
    select.appendChild(opt)
  }
  // `custom-select.js` 自己掛了 MutationObserver，選項換掉它會自己跟上
  if (reviewRef && list.some((one) => one.name === reviewRef)) select.value = reviewRef
}

/**
 * 跟選定的分支整體比一次。比的基準是**合併基準點**，右邊是工作區
 * （含還沒提交的），因為要審的就是手上這一份。
 */
async function runCompare() {
  const project = currentProject()
  const select = /** @type {HTMLSelectElement | null} */ (el.reviewRef)
  if (!project || !select || !el.reviewFiles) return
  const ref = select.value
  if (!ref) {
    showToast('先選一條要比的分支', 'error')
    return
  }
  const seq = projectSeq
  let data
  try {
    data = await call(electronAPI.workspace.gitCompareBranch(project.id, ref), '比較失敗')
  } catch {
    return
  }
  if (!isCurrentProject(project, seq)) return
  reviewRef = ref
  el.reviewFiles.replaceChildren()
  const files = data?.files || []
  if (!files.length) {
    const note = document.createElement('p')
    note.className = 'ws-tree-note'
    note.textContent = `跟 ${ref} 相比沒有差異`
    el.reviewFiles.appendChild(note)
    return
  }
  const head = document.createElement('p')
  head.className = 'ws-tree-note'
  head.textContent = `跟 ${ref}（基準 ${data.base}）相比：${files.length} 個檔案`
  el.reviewFiles.appendChild(head)
  for (const file of files) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'ws-review-file'
    row.title = file.path
    const name = document.createElement('span')
    name.className = 'ws-git-name'
    name.textContent = file.path
    const stat = document.createElement('span')
    stat.className = 'ws-diff-stat'
    stat.textContent = file.binary ? '二進位' : `+${file.additions} -${file.deletions}`
    row.append(name, stat)
    row.addEventListener('click', () => void openReviewTab(project, file.path, ref, file))
    el.reviewFiles.appendChild(row)
  }
  if (data.truncated) {
    const note = document.createElement('p')
    note.className = 'ws-tree-note'
    note.textContent = '只列出前面一部分'
    el.reviewFiles.appendChild(note)
  }
}

/**
 * git worktree 清單：同一個 repo 攤開在幾個資料夾裡。
 * 點分支名就切到那個專案（建立時已經幫它加進側欄了）。
 */
async function renderWorktrees() {
  const project = currentProject()
  if (!project || !el.worktrees) return
  const seq = projectSeq
  let data
  try {
    data = await call(electronAPI.workspace.worktreeList(project.id), '讀不到工作樹')
  } catch {
    return
  }
  if (!isCurrentProject(project, seq)) return
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

    if (!tree.current && tree.projectId) {
      const open = document.createElement('button')
      open.type = 'button'
      open.className = 'ws-worktree-open'
      open.title = '切到這個工作樹'
      open.setAttribute('aria-label', `切到 ${tree.branch || tree.path}`)
      open.textContent = '⇗'
      open.addEventListener('click', () => void selectProject(tree.projectId))
      row.appendChild(open)
    }
    if (!tree.current && !tree.projectId) {
      // 已經存在但側欄沒有它（別的地方建的、或上次移除專案時拿掉了）：
      // 只看得到卻切不過去很奇怪，給一顆「加入」
      const adopt = document.createElement('button')
      adopt.type = 'button'
      adopt.className = 'ws-worktree-open'
      adopt.title = '加進側欄的專案清單'
      adopt.setAttribute('aria-label', `加入 ${tree.branch || tree.path}`)
      adopt.textContent = '＋'
      adopt.addEventListener('click', () => void adoptWorktree(project, tree))
      row.appendChild(adopt)
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
 * 開一個新工作樹。**只問名字**——資料夾位置由 main 決定（repo 的兄弟資料夾），
 * renderer 送得了路徑就等於能在任意位置建東西。
 */
async function addWorktree() {
  const project = currentProject()
  if (!project) return
  const name = await askInput('新工作樹的分支名稱', { desc: '同時也是資料夾名。', confirmText: '下一步' })
  if (name === null) return
  const base = (await askInput('從哪個分支或 commit 開？', {
    desc: '留空＝目前的 HEAD。',
    placeholder: 'HEAD',
    confirmText: '建立'
  })) ?? ''
  try {
    const made = await call(electronAPI.workspace.worktreeAdd(project.id, name, base.trim()), '建不出工作樹')
    showToast(`已建立 ${made.branch}`)
    await reloadList()
    // main 會把新專案的 id 一起回來，直接切過去（不必再重載一次去猜是哪一個）
    if (made?.projectId) await selectProject(made.projectId)
    else await renderWorktrees()
  } catch {
    // call() 已經提示過了
  }
}

/**
 * @param {{ id: string }} project
 * @param {{ path: string, branch: string }} tree
 */
async function removeWorktree(project, tree) {
  // 先問「有沒有東西擋著」：git 只會回一個非 0，講不出是哪幾個檔案還沒提交
  let state
  try {
    state = await call(electronAPI.workspace.worktreeCheck(project.id, tree.path), '看不出這棵樹的狀態')
  } catch {
    return
  }
  if (!state.removable) {
    const detail = state.samples?.length ? `${NEWLINE}${state.samples.join(NEWLINE)}` : ''
    await showAlert('移不掉這棵工作樹', { desc: `${state.reason}${detail}` })
    return
  }
  const yes = await askConfirm(`確定要移除工作樹 ${tree.branch || tree.path} 嗎？`, {
    desc: '裡面沒有未提交的變更，移掉之後那個資料夾就不見了。',
    confirmText: '移除',
    danger: true
  })
  if (!yes) return
  try {
    await call(electronAPI.workspace.worktreeRemove(project.id, tree.path), '移不掉')
    showToast('已移除工作樹')
    await reloadList()
    await renderWorktrees()
  } catch {
    // call() 已經提示過了
  }
}

/**
 * 把一棵已經存在的工作樹加進側欄。
 * @param {{ id: string }} project
 * @param {{ path: string, branch: string }} tree
 */
async function adoptWorktree(project, tree) {
  try {
    const added = await call(electronAPI.workspace.worktreeAdopt(project.id, tree.path), '加不進來')
    await reloadList()
    showToast(`已加入 ${tree.branch || tree.path}`)
    if (added?.projectId) await selectProject(added.projectId)
  } catch {
    // call() 已經提示過了
  }
}

/** 每一組的標題文字 */
const GIT_GROUP_LABELS = {
  conflict: '衝突',
  staged: '暫存區',
  worktree: '變更',
  untracked: '未追蹤'
}

/**
 * 四組清單的共用殼：標題、這組有幾個檔案、以及整組一次做完的那顆按鈕。
 *
 * 「整組暫存／整組取消」是這個面板最常做的兩件事，以前只能一列一列按。
 * 衝突與未追蹤刻意沒有整組操作：前者一次全 `add` 等於盲簽，後者整組刪救不回來。
 *
 * @param {Array<object>} files
 * @param {'staged' | 'worktree' | 'untracked' | 'conflict'} side
 * @param {{ id: string }} project
 * @param {HTMLElement} host
 * @param {Set<string>} [ambiguous] 撞名的檔名（往下傳給每一列）
 */
function gitGroup(files, side, project, host, ambiguous) {
  if (!files.length) return
  const head = document.createElement('div')
  head.className = 'ws-git-group'
  if (side === 'conflict') head.classList.add('is-conflict')

  const label = document.createElement('span')
  label.className = 'ws-git-group-label'
  label.textContent = GIT_GROUP_LABELS[side] || side
  const count = document.createElement('span')
  count.className = 'ws-git-group-count'
  count.textContent = String(files.length)
  count.title = `${files.length} 個檔案`
  head.append(label, count)

  const bulk = side === 'staged'
    ? { text: '整組取消', title: '把這一組整個移出暫存區', run: (id, rel) => electronAPI.workspace.gitUnstage(id, rel) }
    : side === 'worktree'
      ? { text: '整組暫存', title: '把這一組整個加入暫存區', run: (id, rel) => electronAPI.workspace.gitStage(id, rel) }
      : null
  if (bulk) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'ws-git-act ws-git-group-act'
    btn.textContent = bulk.text
    btn.title = bulk.title
    btn.addEventListener('click', async () => {
      btn.disabled = true
      // 一個一個送：main 的 stage/unstage 只吃單一相對路徑，而且失敗的那個不該
      // 把整組拖下水（`allSettled` 不是 `all`）
      await Promise.allSettled(files.map((file) => bulk.run(project.id, file.path)))
      void renderGit()
    })
    head.appendChild(btn)
  }

  host.appendChild(head)
  for (const file of files) host.appendChild(gitRow(project, file, side, ambiguous))
}

async function renderGitLog() {
  const project = currentProject()
  if (!project || !el.gitLog) return
  const seq = projectSeq
  let log
  try {
    log = await call(electronAPI.workspace.gitLog(project.id), '讀不到提交紀錄')
  } catch {
    return
  }
  if (!isCurrentProject(project, seq)) return
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
  const seq = projectSeq
  let status
  try {
    status = await call(electronAPI.workspace.gitStatus(project.id), '讀不到 Git 狀態')
  } catch {
    return
  }
  if (!isCurrentProject(project, seq)) return
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
    // 記錄可能是別的工作台代跑的（Orca 有自己的 runtime home），標一下才知道從哪來
    if (row.source) {
      const src = document.createElement('span')
      src.className = 'ws-agent-source'
      src.textContent = row.source
      head.appendChild(src)
    }

    const title = document.createElement('span')
    title.className = 'ws-agent-title'
    title.textContent = row.title || '（沒有標題）'

    item.append(head, title)
    item.addEventListener('click', () => void openAiSessionTab(project, row))

    const wrap = document.createElement('div')
    wrap.className = 'ws-agent-row-wrap'
    const resume = document.createElement('button')
    resume.type = 'button'
    resume.className = 'ws-agent-resume'
    resume.textContent = '接續'
    resume.title = '在新的終端機接續這一段'
    resume.addEventListener('click', (event) => {
      event.stopPropagation()
      void resumeSession(project, row)
    })
    wrap.append(item, resume)
    el.agentList.appendChild(wrap)
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
 * 接續一段對話。指令由 main 組，而且 main 會**先確認這段對話真的屬於這個專案**
 * （只驗 id 格式的話，別的專案的 session id 送進來照樣接得起來）。
 * @param {{ id: string }} project
 * @param {{ agent: string, id: string, title: string, agentLabel: string }} row
 */
async function resumeSession(project, row) {
  let info
  try {
    info = await call(
      electronAPI.workspace.agentResume(project.id, row.agent, row.id),
      '接續不了這段對話'
    )
  } catch {
    return
  }
  await newTerminalWithCommand(`${info.agentLabel} · ${row.title || '接續'}`, info.command)
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

/** Git 面板的收合狀態存這裡（每一段一個布林；預設變更與審閱展開） */
const GIT_SECTIONS_KEY = 'wsGitSections'

/**
 * 四段各自可展開收起。狀態存 localStorage，切專案／重畫都不會被洗掉
 * （收合走 `hidden`，而 `.ws-git-sec-body` 有作者的 `display: flex`，
 * 所以 CSS 那邊要自己補 `[hidden] { display: none }`）。
 */
function initGitSections() {
  /** @type {Record<string, boolean>} */
  let saved = {}
  try {
    saved = JSON.parse(localStorage.getItem(GIT_SECTIONS_KEY) || '{}') || {}
  } catch {
    saved = {}
  }
  const toggles = document.querySelectorAll('.ws-git-sec-toggle')
  for (const node of toggles) {
    const btn = /** @type {HTMLButtonElement} */ (node)
    const key = btn.closest('.ws-git-sec')?.getAttribute('data-sec') || ''
    const body = document.getElementById(btn.getAttribute('aria-controls') || '')
    if (!key || !body) continue
    if (typeof saved[key] === 'boolean') setGitSection(btn, body, saved[key])
    btn.addEventListener('click', () => {
      const next = btn.getAttribute('aria-expanded') !== 'true'
      setGitSection(btn, body, next)
      saved[key] = next
      try {
        localStorage.setItem(GIT_SECTIONS_KEY, JSON.stringify(saved))
      } catch {
        /* 隱私模式寫不進去就算了，這一輪照樣展得開 */
      }
    })
  }
}

/**
 * @param {HTMLButtonElement} btn
 * @param {HTMLElement} body
 * @param {boolean} open
 */
function setGitSection(btn, body, open) {
  btn.setAttribute('aria-expanded', String(open))
  body.hidden = !open
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
  el.gitFilter = document.getElementById('wsGitFilter')
  el.gitMessage = document.getElementById('wsGitMessage')
  el.gitLog = document.getElementById('wsGitLog')
  el.worktrees = document.getElementById('wsWorktrees')
  el.agentList = document.getElementById('wsAgentList')
  el.reviewRef = document.getElementById('wsReviewRef')
  el.reviewFiles = document.getElementById('wsReviewFiles')
  el.panelPorts = document.getElementById('wsPanelPorts')
  el.portList = document.getElementById('wsPortList')
  el.search = document.getElementById('wsSearch')
  el.searchInput = document.getElementById('wsSearchInput')
  el.searchResults = document.getElementById('wsSearchResults')

  initGitSections()
  document.addEventListener('ws:terminal-status', paintProjectStatuses)
  el.newBtn?.addEventListener('click', () => void addProject())
  initProjectDrop()
  document.querySelectorAll('.ws-right-tab').forEach((btn) => {
    btn.addEventListener('click', () => setPanel(/** @type {HTMLElement} */ (btn).dataset.panel))
  })
  document.getElementById('wsFilesRevealBtn')?.addEventListener('click', () => void revealProject())
  document.getElementById('wsFilesRefreshBtn')?.addEventListener('click', () => void renderTree())
  document.getElementById('wsGitRefreshBtn')?.addEventListener('click', () => void renderGit())
  // 篩選只動畫面，不重問 main（狀態已經在手上了，但重畫最省事也最不會不同步）
  el.gitFilter?.addEventListener('input', () => {
    gitFilter = String(/** @type {HTMLInputElement} */ (el.gitFilter).value || '').trim().toLowerCase()
    const project = currentProject()
    if (project && lastGitStatus) paintGitFiles(project, lastGitStatus)
  })
  document.getElementById('wsWorktreeAddBtn')?.addEventListener('click', () => void addWorktree())
  document.getElementById('wsGitOpenAllBtn')?.addEventListener('click', () => void openAllChanged())
  document.getElementById('wsAgentsRefreshBtn')?.addEventListener('click', () => void renderAgents())
  document.getElementById('wsGitStageAllBtn')?.addEventListener('click', () => void stageAll())
  document.getElementById('wsGitCommitBtn')?.addEventListener('click', () => void commitStaged())
  document.getElementById('wsGitPushBtn')?.addEventListener('click', () => void pushCurrent())
  document.getElementById('wsGitPullBtn')?.addEventListener('click', () => void pullCurrent())
  document.getElementById('wsPortsRefreshBtn')?.addEventListener('click', () => void renderPorts())
  document.getElementById('wsReviewCompareBtn')?.addEventListener('click', () => void runCompare())
  document.getElementById('wsReviewRefreshBtn')?.addEventListener('click', () => void renderBranches())
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
  // 資料夾被別人改了（AI 跑完、git 換分支、另一個編輯器存檔）→ 自己更新
  electronAPI.workspace.onChanged?.(onProjectChanged)
  // 回到視窗時 Git 狀態多半已經不一樣了（剛在別的地方 commit 過）
  window.addEventListener('focus', () => {
    if (panel === 'git' && currentProject()) void renderGit()
  })
  // 終端機裡那一行指令跑完了（多半是 agent 收工）→ 重讀一次 Git
  document.addEventListener('ws:terminal-idle', () => {
    if (panel === 'git' && currentProject()) void renderGit()
  })
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
  announceProject()
  void reloadList().then(() => renderPanel()).catch(() => {})
}

/** App 重開時還原上次的專案；等待期間若使用者已切換，就以使用者為準。 */
export async function restoreLastProject(fallbackId = '') {
  initWorkspacePage()
  if (projectSeq) return true
  await reloadList()
  if (projectSeq) return true
  let id = fallbackId
  try { id = localStorage.getItem('wsLastProject') || id } catch { /* 沿用終端機的專案 */ }
  const target = projects.find(item => item.id === id && !item.missing)
  return target ? selectProject(target.id) : false
}
