import { electronAPI, showToast, setChatPaneMode } from './app.js'
import { renderMarkdown } from './markdown.js'
import { showMenu } from './ws-menu.js'
import { gitStatusShared, invalidateGitStatus } from './ws-git-status.js'
import { updateGutter, updateIdeStatus, handleEditorKeydown, initFindWidget } from './ws-ide.js'
import { parseUnifiedDiff, renderDiffLines } from './ws-diff.js'
import {
  loadMonaco, ensureEditor, showTab as showMonacoTab, runAction,
  disposeModel, retargetModel, revealLine, cursorInfo, currentValue, pushValue, showDiff,
  selectionInfo, diffGoTo, diffChangeCount, diffCursor
} from './ws-monaco.js'
import { paintAiSession } from './ws-ai-session.js'
import {
  addComment, listComments, removeComment, clearComments, countComments,
  formatComments, sendToChat
} from './ws-review.js'

/**
 * 工作區的分頁列與五種內容（終端機／編輯器／瀏覽器／Git Diff／AI 會話）。
 *
 * 借 Orca 的 tab 模型，適配於本機單一工作區。支援分頁持久化與 Hot Exit
 * （未存檔草稿安全網），切換專案或重新啟動後自動還原。
 *
 * 畫面上五種內容各只有一份 DOM（`#termHost` / `#wsEditor` / `#wsBrowser` / `#wsDiff` / `#wsAiSession`），
 * 切分頁時把狀態搬進搬出。終端機是例外：每個工作階段有自己的 `.term-pane`，
 * 那份由 `terminal-page.js` 管，這裡只負責「現在該不該顯示 `#termHost`」。
 */

/** 分頁標題長度（太長會把整條分頁列擠爆） */
const MAX_TAB_TITLE = 28

/**
 * @typedef {{
 *   id: string,
 *   kind: 'terminal' | 'editor' | 'browser' | 'diff' | 'ai-session',
 *   title: string,
 *   projectId?: string,
 *   relPath?: string,
 *   url?: string,
 *   content?: string,
 *   dirty?: boolean,
 *   preview?: boolean,
 *   readonly?: string,
 *   image?: string,
 *   pdf?: string,
 *   audio?: string,
 *   video?: string,
 *   unsupported?: boolean,
 *   fileSize?: number,
 *   fileExt?: string,
 *   mtimeMs?: number,
 *   staged?: boolean,
 *   state?: string,
 *   stateLabel?: string,
 *   admin?: boolean,
 *   cwd?: string,
 *   unread?: boolean,
 *   diffData?: { diff: string, additions: number, deletions: number },
  versions?: { original: string, modified: string } | null,
 *   sessionRow?: any,
 *   sessionData?: any
 * }} WsTab
 */

/** @type {WsTab[]} */
let tabs = []
let activeId = ''
let initialized = false
let browserSeq = 0
let persistTimer = 0
let projectSwitch = 0

/** 目前選定的專案（由 workspace-page 設定，用來決定新終端機的 cwd） */
let project = null

/** @type {Record<string, HTMLElement | null>} */
const el = {}

/**
 * Monaco 載進來之後放在這裡；**載不起來就一直是 null**，
 * 所有用到它的地方都要先檢查，退回原本的 `<textarea>`（那條路完全沒被拿掉）。
 * @type {any}
 */
let monaco = null
/** 編輯器內容變動時要回呼的那支（在 `initWsTabs` 裡才組得出來） */
let notifyEditorChange = () => {}
/** 試載過了沒（失敗只試一次，不要每開一個檔就再等一輪逾時） */
let monacoTried = false
/** 還沒跳到的那一行（Monaco 掛好之前先記著） */
let pendingGoto = 0

/** Monaco 掛好之後把欠的那一跳補上 */
function applyGoto() {
  if (!monaco || !pendingGoto) return
  revealLine(pendingGoto)
  pendingGoto = 0
  paintMonacoStatus()
}


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
 * @param {string} value
 * @returns {string}
 */
function shortTitle(value) {
  const text = String(value || '').trim() || '未命名'
  return text.length > MAX_TAB_TITLE ? `…${text.slice(-(MAX_TAB_TITLE - 1))}` : text
}

/**
 * 哪一塊內容該顯示。**單一擁有者**——終端機那邊也走這支，
 * 不然開編輯器分頁時 `#termHost` 會留在畫面上疊著。
 * @param {'terminal' | 'editor' | 'browser' | 'diff' | 'ai-session' | 'empty'} kind
 */
export function showSurface(kind) {
  el.termHost?.classList.toggle('hidden', kind !== 'terminal')
  el.termEmpty?.classList.toggle('hidden', kind !== 'empty')
  if (el.editor) el.editor.hidden = kind !== 'editor'
  if (el.browser) el.browser.hidden = kind !== 'browser'
  if (el.diff) el.diff.hidden = kind !== 'diff'
  if (el.aiSession) el.aiSession.hidden = kind !== 'ai-session'
}

// ===== 持久化 (Hot Exit) =====

/**
 * 安排非同步儲存分頁與未存檔草稿狀態（防抖 400ms）
 */
function schedulePersistTabs() {
  if (!project?.id) return
  window.clearTimeout(persistTimer)
  persistTimer = window.setTimeout(() => void persistTabsNow(), 400)
}

/**
 * 立即儲存分頁與草稿狀態至 workspaces.json
 */
/**
 * 草稿存進 `workspaces.json` 的長度上限。**跟 main 的 `files.MAX_WRITE_CHARS` 同一個數字**：
 * 兩邊不一致的話，會出現「編輯器讓你打、存檔也存得下，但關掉分頁草稿就沒了」——
 * 而且完全沒有訊息。超過就當場講，不要安靜丟掉。
 */
const MAX_DRAFT_CHARS = 4 * 1024 * 1024
/** 同一個分頁只嘮叨一次 */
const warnedDrafts = new Set()

async function persistTabsNow() {
  if (!project?.id) return
  stash()
  for (const t of tabs) {
    if (!t.dirty || (t.content || '').length <= MAX_DRAFT_CHARS) continue
    if (warnedDrafts.has(t.id)) continue
    warnedDrafts.add(t.id)
    showToast(`${t.title} 太大，草稿存不起來，關掉分頁前請先儲存`, 'error')
  }
  const payload = {
    activeId,
    // 「比較」與「審閱」分頁都是臨時視角（磁碟 ⇄ 草稿、跟某條分支比），
    // 存了的話下次開專案會被當成一般的 Git diff 去打 `gitDiff`
    tabs: tabs.filter((t) => !t.conflict && !t.reviewRef).map((t) => ({
      id: t.id,
      kind: t.kind,
      title: t.title,
      projectId: t.projectId,
      relPath: t.relPath,
      url: t.url,
      draftContent: t.dirty ? (t.content || '') : '',
      dirty: Boolean(t.dirty),
      preview: Boolean(t.preview),
      staged: Boolean(t.staged),
      sessionRow: t.sessionRow
    }))
  }
  try {
    await call(electronAPI.workspace.saveTabsState(project.id, payload), '草稿儲存失敗')
  } catch {
    return false
  }
  return true
}

// ===== 外部檔案變更偵測 =====

/**
 * 磁碟上的版本跟手上這份對不起來時的提示條。訊息會換：外部改過是一種，
 * 存檔被擋下來是另一種（後者使用者剛按過儲存，不講清楚會以為按了沒反應）。
 * @param {string} [message]
 */
function showExtBanner(message) {
  if (el.editorExtBannerMsg) el.editorExtBannerMsg.textContent = message || '檔案已在外部修改'
  if (el.editorExtBanner) el.editorExtBanner.hidden = false
}

function hideExtBanner() {
  if (el.editorExtBanner) el.editorExtBanner.hidden = true
}

/**
 * 檢查目前開啟的編輯器檔案在磁碟上的 mtime 是否更新過
 */
async function checkActiveFileExternalChange() {
  const tab = findTab(activeId)
  if (!tab || tab.kind !== 'editor' || !tab.projectId || !tab.relPath || tab.readonly) {
    hideExtBanner()
    return
  }
  try {
    const res = await electronAPI.workspace.getFileMtime(tab.projectId, tab.relPath)
    if (!res || !res.ok || !res.data) return
    if (findTab(activeId) !== tab) return
    if (!res.data.exists && tab.mtimeMs) {
      // 原檔被刪掉了。內容留著（那是這裡唯一一份），但要講明白——
      // 不講的話畫面看起來完全正常，而普通存檔已經被 main 擋住（STALE）
      showExtBanner('原檔已被刪除，這裡是最後編輯的內容')
      return
    }
    const diskMtime = res.data.mtimeMs
    if (diskMtime && tab.mtimeMs && diskMtime !== tab.mtimeMs) {
      if (!tab.dirty) {
        // 沒有未存草稿：平滑自動載入最新內容
        await reloadActiveFileFromDisk(false)
      } else {
        // 有未存草稿：跳出警告提示條
        showExtBanner()
      }
    }
  } catch {
    // 靜默
  }
}

/**
 * 依目前檔案的 Git 狀態顯示「看未提交變更」按鈕。
 * @param {WsTab} tab
 */
async function refreshEditorDiffButton(tab) {
  const button = /** @type {HTMLButtonElement | null} */ (el.editorDiffBtn)
  if (!button) return
  button.hidden = true
  delete button.dataset.staged
  if (tab.kind !== 'editor' || !tab.projectId || !tab.relPath) return

  let result
  try {
    // 跟檔案樹共用同一趟（`ws-git-status.js`）：切分頁與監看事件會讓兩邊同時要同一份答案
    result = await gitStatusShared(tab.projectId)
  } catch {
    return
  }
  if (findTab(activeId) !== tab) return
  const rows = result?.ok && result.data?.repo && Array.isArray(result.data.files)
    ? result.data.files
    : []
  const wanted = String(tab.relPath).replace(/\\/g, '/').replace(/^\.\//, '')
  const file = rows.find((row) => (
    row && typeof row.path === 'string'
      && row.path.replace(/\\/g, '/').replace(/^\.\//, '') === wanted
  ))
  if (!file) return
  const index = typeof file.index === 'string' ? file.index : '.'
  const worktree = typeof file.worktree === 'string' ? file.worktree : '.'
  const code = worktree !== '.' && worktree !== '?' ? worktree : index
  if (!code || code === '.') return
  const staged = worktree === '.' && index !== '.' && index !== '?'
  button.dataset.staged = staged ? '1' : '0'
  button.hidden = false
  button.title = staged ? '查看未提交變更（已暫存）' : '查看未提交變更'
  button.setAttribute('aria-label', button.title)
}

/**
 * 從磁碟重新讀取檔案內容
 * @param {boolean} userTriggered
 */
async function reloadActiveFileFromDisk(userTriggered = false) {
  const tab = findTab(activeId)
  if (!tab || tab.kind !== 'editor' || !tab.projectId || !tab.relPath) return
  const original = tab.content
  try {
    const file = await call(
      electronAPI.workspace.readFile(tab.projectId, tab.relPath),
      '讀取檔案失敗'
    )
    if (findTab(activeId) !== tab || tab.content !== original) return
    tab.content = file.content || ''
    tab.savedContent = tab.content
    tab.dirty = false
    tab.mtimeMs = file.mtimeMs || Date.now()
    hideExtBanner()
    if (activeId === tab.id && el.editorText) {
      /** @type {HTMLTextAreaElement} */ (el.editorText).value = tab.content
      paintEditor(tab)
    }
    renderTabs()
    schedulePersistTabs()
    if (!userTriggered) {
      showToast(`${tab.title} 已自動從磁碟更新`)
    } else {
      showToast(`已重新載入 ${tab.title}`)
    }
  } catch {
    // 失敗
  }
}

// ===== 分頁列 =====

function renderTabs() {
  if (!el.strip) return
  // ＋ 按鈕住在 strip 尾端（貼著最後一個分頁），重畫時只能洗掉分頁本身
  el.strip.querySelectorAll('.ws-tab').forEach((node) => node.remove())
  for (const tab of tabs) {
    const item = document.createElement('div')
    item.className = tab.id === activeId ? 'ws-tab is-active' : 'ws-tab'
    item.dataset.id = tab.id
    item.dataset.kind = tab.kind

    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'ws-tab-open'
    open.title = tabTooltip(tab)
    open.setAttribute('role', 'tab')
    open.setAttribute('aria-selected', tab.id === activeId ? 'true' : 'false')
    // 終端機的狀態燈：側欄清單收掉之後，「還在跑嗎」只剩這一顆看得出來
    if (tab.kind === 'terminal') {
      const led = document.createElement('span')
      led.className = `ws-tab-state ws-tab-state-${tab.state || 'stopped'}`
      led.setAttribute('aria-hidden', 'true')
      open.appendChild(led)
    }
    const label = document.createElement('span')
    label.className = 'ws-tab-label'
    label.textContent = shortTitle(tab.title)
    open.appendChild(label)
    if (tab.dirty) {
      const dot = document.createElement('span')
      dot.className = 'ws-tab-dirty'
      dot.setAttribute('aria-label', '尚未儲存')
      open.appendChild(dot)
    }
    if (tab.unread) {
      const dot = document.createElement('span')
      dot.className = 'ws-tab-unread'
      dot.title = '跑完了，還沒看過'
      dot.setAttribute('aria-label', '有新輸出')
      open.appendChild(dot)
    }
    open.addEventListener('click', () => void activate(tab.id))

    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'ws-tab-close'
    close.title = '關閉分頁'
    close.setAttribute('aria-label', `關閉「${tab.title}」`)
    close.textContent = '×'
    close.addEventListener('click', (event) => {
      event.stopPropagation()
      void closeTab(tab.id)
    })

    item.addEventListener('mousedown', (event) => {
      if (event.button === 1) event.preventDefault()
    })
    item.addEventListener('contextmenu', (event) => openTabMenu(tab, event))
    item.addEventListener('pointerdown', (event) => onTabDragStart(event, tab.id))
    item.addEventListener('auxclick', (event) => {
      if (event.button !== 1) return
      event.preventDefault()
      void closeTab(tab.id)
    })

    item.append(open, close)
    el.newBtn ? el.strip.insertBefore(item, el.newBtn) : el.strip.appendChild(item)
  }
}

/**
 * @param {WsTab} tab
 * @returns {string}
 */
function tabTooltip(tab) {
  if (tab.kind === 'editor') return tab.relPath || tab.title
  if (tab.kind !== 'terminal') return tab.title
  const parts = [tab.title]
  if (tab.stateLabel) parts.push(tab.stateLabel)
  if (tab.admin) parts.push('管理員')
  if (tab.cwd) parts.push(tab.cwd)
  return parts.join(' · ')
}

/**
 * @param {string} id
 * @returns {WsTab | undefined}
 */
const findTab = (id) => tabs.find((tab) => tab.id === id)

/**
 * 把 `fromId` 搬到 `toId` 現在的位置。分頁順序只活在記憶體裡（不落盤），
 * 所以不用像側欄那樣回寫 store。
 *
 * @param {string} fromId
 * @param {string} toId
 */
function moveTab(fromId, toId) {
  const from = tabs.findIndex((tab) => tab.id === fromId)
  const to = tabs.findIndex((tab) => tab.id === toId)
  if (from < 0 || to < 0 || from === to) return
  const [moved] = tabs.splice(from, 1)
  tabs.splice(to, 0, moved)
  renderTabs()
  schedulePersistTabs()
}

// ===== 分頁拖曳：比照額度儀表板（拖曳中只改 transform，不改 DOM，零閃爍極致滑順）=====

/** 拖曳啟動門檻：小於這個距離仍當成點擊 */
const DRAG_THRESHOLD_PX = 4

/** 指標離分頁列左右邊緣多近就開始自動捲動 */
const EDGE_PX = 44
/** 自動捲動的速度上限（px / 每一幀） */
const EDGE_SPEED = 14

/**
 * @type {{
 *   id: string,
 *   el: HTMLElement,
 *   startX: number,
 *   startY: number,
 *   startScroll: number,
 *   pointerX: number,
 *   active: boolean,
 *   dragIndex: number,
 *   targetIndex: number,
 *   gap: number,
 *   raf: number,
 *   slots: Array<{ id: string, left: number, width: number, center: number }>,
 *   items: HTMLElement[]
 * } | null}
 */
let drag = null

/**
 * 把作用中的分頁捲進畫面。分頁列會橫向溢出，用 Ctrl+Tab 繞圈或從檔案樹開檔時，
 * 新的那顆常常落在看不見的地方——不捲過去等於「按了沒反應」。
 */
function revealActiveTab() {
  if (!el.strip) return
  const node = el.strip.querySelector(`.ws-tab[data-id="${CSS.escape(activeId)}"]`)
  node?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

/**
 * @param {PointerEvent} event
 * @param {string} id
 */
function onTabDragStart(event, id) {
  if (event.button !== 0 || !el.strip) return
  const item = /** @type {HTMLElement} */ (event.currentTarget)
  // × 按鈕不能當抓取點（按住拖過去會順手把分頁關掉）
  if (/** @type {HTMLElement} */ (event.target).closest('.ws-tab-close')) return

  const items = [...el.strip.querySelectorAll('.ws-tab')]
  const dragIndex = items.findIndex((node) => node.dataset.id === id)
  if (dragIndex < 0) return

  const slots = items.map((node) => {
    const r = node.getBoundingClientRect()
    return {
      id: node.dataset.id || '',
      left: r.left,
      width: r.width,
      center: r.left + r.width / 2
    }
  })

  // 讓位距離＝被拖那顆的寬 ＋ 分頁之間的實際間距。**間距要用量的，不能寫死**：
  // 寫死的值跟 CSS 的 `gap` 差幾 px，鄰居就會停在跟最終位置差幾 px 的地方，
  // 放開的瞬間整排跳一下——看起來就是「拖曳不順」。
  const gap = slots.length > 1
    ? Math.max(0, Math.round(slots[1].left - (slots[0].left + slots[0].width)))
    : 0

  drag = {
    id,
    el: item,
    startX: event.clientX,
    startY: event.clientY,
    startScroll: el.strip.scrollLeft,
    pointerX: event.clientX,
    active: false,
    dragIndex,
    targetIndex: dragIndex,
    gap,
    raf: 0,
    slots,
    items
  }

  window.addEventListener('pointermove', onTabDragMove)
  window.addEventListener('pointerup', onTabDragEnd)
  window.addEventListener('pointercancel', onTabDragEnd)
}

/**
 * @param {PointerEvent} event
 */
function onTabDragMove(event) {
  if (!drag) return
  drag.pointerX = event.clientX

  if (!drag.active) {
    const dy = event.clientY - drag.startY
    if (Math.hypot(event.clientX - drag.startX, dy) < DRAG_THRESHOLD_PX) return
    drag.active = true
    drag.el.classList.add('is-dragging')
    for (const node of drag.items) {
      if (node !== drag.el) {
        node.style.transition = 'transform 180ms cubic-bezier(0.2, 0, 0, 1)'
      }
    }
    drag.raf = requestAnimationFrame(autoScrollTick)
  }
  paintDrag()
}

/**
 * 把「指標移了多遠」換算成畫面。**只吃 X**：分頁列是一條橫的，
 * 讓分頁跟著往上下跑只會讓它飛出這一條，看起來像壞掉。
 *
 * 位移要**加上分頁列自己捲了多少**——邊緣自動捲動時 `clientX` 沒變、
 * 底下的槽位卻整排移動了，不補這一段的話分頁會愈拖愈歪。
 */
function paintDrag() {
  if (!drag || !drag.active || !el.strip) return
  const dx = (drag.pointerX - drag.startX) + (el.strip.scrollLeft - drag.startScroll)

  // 1. 被拖曳項純靠 transform 跟隨指標（零延遲）
  drag.el.style.transform = `translate3d(${dx}px, 0, 0)`

  // 2. 計算目標槽位（根據被拖曳項目前中心點）
  const currentCenter = drag.slots[drag.dragIndex].center + dx
  let bestIndex = drag.dragIndex
  let bestDist = Infinity

  for (let i = 0; i < drag.slots.length; i += 1) {
    const dist = Math.abs(currentCenter - drag.slots[i].center)
    if (dist < bestDist) {
      bestDist = dist
      bestIndex = i
    }
  }

  if (bestIndex === drag.targetIndex) return
  drag.targetIndex = bestIndex

  // 3. 平滑讓位（只改鄰居 transform，絕不改動 DOM 結構，完全不閃爍）
  const dragWidth = drag.slots[drag.dragIndex].width + drag.gap
  for (let i = 0; i < drag.items.length; i += 1) {
    const node = drag.items[i]
    if (node === drag.el) continue
    let shift = 0
    if (drag.dragIndex < drag.targetIndex) {
      // 往右拖：介於 (dragIndex, targetIndex] 的 tab 往左退讓
      if (i > drag.dragIndex && i <= drag.targetIndex) {
        shift = -dragWidth
      }
    } else if (drag.dragIndex > drag.targetIndex) {
      // 往左拖：介於 [targetIndex, dragIndex) 的 tab 往右退讓
      if (i >= drag.targetIndex && i < drag.dragIndex) {
        shift = dragWidth
      }
    }
    node.style.transform = shift === 0 ? '' : `translate3d(${shift}px, 0, 0)`
  }
}

/**
 * 拖到分頁列邊緣時自己往那個方向捲。分頁多到溢出時，
 * 沒有這一段就**根本搬不到看不見的那幾顆旁邊**（指標推到底就沒路了）。
 */
function autoScrollTick() {
  if (!drag || !drag.active || !el.strip) return
  const strip = el.strip
  const rect = strip.getBoundingClientRect()
  const left = drag.pointerX - rect.left
  const right = rect.right - drag.pointerX
  let step = 0
  if (left < EDGE_PX) step = -Math.ceil(((EDGE_PX - left) / EDGE_PX) * EDGE_SPEED)
  else if (right < EDGE_PX) step = Math.ceil(((EDGE_PX - right) / EDGE_PX) * EDGE_SPEED)

  if (step) {
    const before = strip.scrollLeft
    strip.scrollLeft = before + step
    if (strip.scrollLeft !== before) paintDrag()
  }
  drag.raf = requestAnimationFrame(autoScrollTick)
}

function onTabDragEnd() {
  window.removeEventListener('pointermove', onTabDragMove)
  window.removeEventListener('pointerup', onTabDragEnd)
  window.removeEventListener('pointercancel', onTabDragEnd)

  const state = drag
  drag = null
  if (!state) return
  if (state.raf) cancelAnimationFrame(state.raf)

  // 清除所有 tab 的 transform 與 transition
  for (const node of state.items) {
    node.style.transition = ''
    node.style.transform = ''
  }
  state.el.classList.remove('is-dragging')

  if (!state.active || state.targetIndex === state.dragIndex) return

  // 拖曳結束：一次性提交順序變更到資料模型
  const [moved] = tabs.splice(state.dragIndex, 1)
  tabs.splice(state.targetIndex, 0, moved)
  renderTabs()
  schedulePersistTabs()
}

/**
 * 分頁的右鍵選單。「關閉其他／關閉右邊」是分頁列的標配，
 * 一次關一堆比連按十次 × 省事。
 *
 * @param {WsTab} tab
 * @param {MouseEvent} event
 */
function openTabMenu(tab, event) {
  event.preventDefault()
  const at = tabs.findIndex((item) => item.id === tab.id)
  // 終端機不進「關閉其他／右邊」：關掉它等於收掉工作階段，一定要一顆一顆確認
  const bulk = (list) => list.filter((item) => item.kind !== 'terminal')
  const others = bulk(tabs.filter((item) => item.id !== tab.id))
  const right = bulk(tabs.slice(at + 1))
  /** @type {Array<{ label: string, danger?: boolean, onSelect: () => void }>} */
  const items = [
    { label: '關閉', onSelect: () => void closeTab(tab.id) }
  ]
  if (tab.kind === 'terminal') {
    items.push({ label: '重新命名', onSelect: () => startTabRename(tab.id) })
  }
  if (others.length) {
    items.push({ label: `關閉其他 ${others.length} 個`, onSelect: () => void closeMany(others) })
  }
  if (right.length) {
    items.push({ label: `關閉右邊 ${right.length} 個`, onSelect: () => void closeMany(right) })
  }
  if (tab.relPath) {
    items.push({ label: '複製相對路徑', onSelect: () => void copyText(tab.relPath || '') })
  }
  if (tab.kind === 'browser' && tab.url) {
    items.push({ label: '用系統瀏覽器開', onSelect: () => void openOutside(tab.url || '') })
  }
  showMenu({ x: event.clientX, y: event.clientY }, items)
}

/**
 * @param {WsTab[]} list
 */
async function closeMany(list) {
  // 由後往前關：closeTab 會改動陣列，從前面關會跳過東西
  for (const tab of [...list].reverse()) {
    // eslint-disable-next-line no-await-in-loop
    await closeTab(tab.id)
  }
}

/**
 * @param {string} text
 */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    showToast('已複製路徑')
  } catch {
    showToast('複製不了路徑', 'error')
  }
}

/**
 * @param {string} url
 */
async function openOutside(url) {
  try {
    await call(electronAPI.workspace.openExternal(url), '開不了這個網址')
  } catch {
    // call() 已經提示過了
  }
}

/**
 * 切走之前先把畫面上的狀態收回分頁記錄裡（三種內容共用同一份 DOM）。
 */
function stash() {
  const tab = findTab(activeId)
  if (!tab) return
  if (tab.kind === 'editor' && el.editorText) {
    // Monaco 開著的時候它才是真的內容來源；textarea 只是同步過去的一份影子
    const live = monaco ? currentValue() : null
    tab.content = typeof live === 'string'
      ? live
      : /** @type {HTMLTextAreaElement} */ (el.editorText).value
  }
  if (tab.kind === 'browser' && el.browserUrl) {
    tab.url = /** @type {HTMLInputElement} */ (el.browserUrl).value
  }
}

/**
 * @param {string} id
 */
async function activate(id) {
  const tab = findTab(id)
  if (!tab) return
  if (id !== activeId) stash()
  activeId = id
  setChatPaneMode('workspace')

  if (tab.kind === 'terminal') {
    // 終端機那一格由 terminal-page 管；它會自己 showSurface('terminal')
    const mod = await import('./terminal-page.js')
    await mod.openTerminalSession(tab.id)
  } else if (tab.kind === 'editor') {
    paintEditor(tab)
    showSurface('editor')
    void refreshEditorDiffButton(tab)
    void checkActiveFileExternalChange()
  } else if (tab.kind === 'diff') {
    paintDiff(tab)
    showSurface('diff')
  } else if (tab.kind === 'ai-session') {
    paintAiSessionTab(tab)
    showSurface('ai-session')
  } else {
    paintBrowser(tab)
    showSurface('browser')
  }
  // 讓檔案樹知道現在開的是哪一個檔案（用事件不用 import：workspace-page 已經 import 了這裡）
  document.dispatchEvent(new CustomEvent('ws:active-file', {
    detail: {
      projectId: tab.projectId || '',
      rel: tab.kind === 'editor' ? (tab.relPath || '') : ''
    }
  }))
  renderTabs()
  revealActiveTab()
  schedulePersistTabs()
}

/**
 * 檔案改名或搬家之後，把開著的分頁接到新路徑上。
 *
 * 不接的話那個分頁還指著舊路徑：存檔會**把舊檔重新建出來**（草稿等於寫到一個
 * 已經不存在的名字上），而畫面上完全看不出來。資料夾同理——底下每一個開著的檔案都要跟著換。
 *
 * 分頁 id 內嵌相對路徑，所以 id 與 activeId 也要一起換。
 *
 * @param {string} projectId
 * @param {string} fromRel 舊的相對路徑（檔案或資料夾）
 * @param {string} toRel 新的相對路徑
 */
export function retargetTabs(projectId, fromRel, toRel) {
  if (!projectId || !fromRel || !toRel || fromRel === toRel) return
  let changed = false
  for (const tab of tabs) {
    if (tab.projectId !== projectId || !tab.relPath) continue
    const isSelf = tab.relPath === fromRel
    const isChild = tab.relPath.startsWith(`${fromRel}/`)
    if (!isSelf && !isChild) continue
    const nextRel = isSelf ? toRel : `${toRel}${tab.relPath.slice(fromRel.length)}`
    const oldId = tab.id
    // 五種分頁 id 都是「前綴 + 相對路徑」，所以照長度換尾巴就好
    // （用 replace 找 `:${relPath}` 的話，前綴裡剛好有同一段字就會換錯地方）
    tab.id = oldId.endsWith(tab.relPath)
      ? oldId.slice(0, oldId.length - tab.relPath.length) + nextRel
      : oldId
    retargetModel(oldId, tab.id)
    tab.relPath = nextRel
    if (tab.kind === 'editor') tab.title = nextRel.split('/').pop() || nextRel
    if (activeId === oldId) activeId = tab.id
    changed = true
  }
  if (!changed) return
  renderTabs()
  schedulePersistTabs()
}

/**
 * Ctrl+W：關掉目前這個分頁。有未存內容時 `closeTab` 自己會擋一次。
 */
export async function closeActiveTab() {
  if (activeId) await closeTab(activeId)
}

/**
 * Ctrl+Tab／Ctrl+Shift+Tab：在分頁之間繞圈。
 * @param {number} delta
 */
export async function cycleTab(delta) {
  if (tabs.length < 2) return
  const at = tabs.findIndex((tab) => tab.id === activeId)
  const next = tabs[(((at < 0 ? 0 : at) + delta) % tabs.length + tabs.length) % tabs.length]
  if (next) await activate(next.id)
}

/**
 * @param {string} id
 */
export async function closeTab(id) {
  const tab = findTab(id)
  if (!tab) return
  if (tab.kind === 'editor' && tab.dirty) {
    // 就地二次確認：關掉有未存內容的分頁是不可逆的
    if (!confirmDiscard(id, '還沒儲存，再按一次×才會關掉')) return
  }
  if (tab.kind === 'terminal') {
    // 終端機分頁是那個工作階段唯一的入口，關掉＝真的收掉它（裡面常常跑著 AI 代理）
    if (!confirmDiscard(id, '關掉會結束這個終端機，再按一次×')) return
    const mod = await import('./terminal-page.js')
    await mod.deleteTerminalSession(id).catch(() => {})
  }
  tabs = tabs.filter((item) => item.id !== id)
  disposeModel(id)
  if (activeId === id) {
    activeId = ''
    const next = tabs[tabs.length - 1]
    if (next) {
      await activate(next.id)
      schedulePersistTabs()
      return
    }
    showSurface('empty')
  }
  renderTabs()
  schedulePersistTabs()
}

/** @type {{ id: string, timer: number } | null} */
let discardArm = null

/**
 * 不可逆的關閉（未存草稿／收掉終端機）的二次確認：第一次按只是「再按一次」，
 * 3 秒後自動解除。不用 `window.confirm`（會擋住整個 App，樣式也不搭）。
 * @param {string} id
 * @param {string} message
 * @returns {boolean} 這一次要不要真的關掉
 */
function confirmDiscard(id, message) {
  if (discardArm && discardArm.id === id) {
    clearTimeout(discardArm.timer)
    discardArm = null
    return true
  }
  if (discardArm) clearTimeout(discardArm.timer)
  showToast(message, 'error')
  discardArm = {
    id,
    timer: setTimeout(() => { discardArm = null }, 3000)
  }
  return false
}

// ===== 終端機分頁 =====

/**
 * 終端機被打開了（「＋」新開的，或還原專案分頁時接回來的）：沒有分頁就補一個，有就設成作用中。
 * @param {string} id
 * @param {string} title
 */
export function trackTerminal(id, title) {
  const tab = findTab(id)
  if (tab) tab.title = title
  else tabs.push({ id, kind: 'terminal', title })
  if (activeId !== id) stash()
  activeId = id
  renderTabs()
  revealActiveTab()
  schedulePersistTabs()
}

/**
 * 把終端機現在的樣子畫到分頁上（`terminal-page.js` 每次狀態變動都會推過來）。
 * @param {string} id
 * @param {{ title: string, state: string, stateLabel: string, admin: boolean, cwd: string, unread: boolean }} meta
 */
export function paintTerminalTab(id, meta) {
  const tab = findTab(id)
  if (!tab) return
  const before = `${tab.title}|${tab.state}|${tab.unread}|${tab.stateLabel}`
  tab.title = meta.title || tab.title
  tab.state = meta.state
  tab.stateLabel = meta.stateLabel
  tab.admin = meta.admin
  tab.cwd = meta.cwd
  tab.unread = meta.unread
  if (before === `${tab.title}|${tab.state}|${tab.unread}|${tab.stateLabel}`) return
  // 改名中不重畫：提示字元標記三秒會重送九次，重畫會把輸入框整顆換掉
  // （側欄那條「不可以 renderList()」的教訓，在分頁上一模一樣）
  if (renamingId) return
  renderTabs()
  schedulePersistTabs()
}

/** 正在改名的那個分頁（改名期間不重畫分頁列） */
let renamingId = ''

/**
 * 分頁上就地改名：Enter／失焦送出，Esc 取消（跟以前側欄那顆鉛筆同一套手感）。
 * @param {string} id
 */
function startTabRename(id) {
  const tab = findTab(id)
  const label = el.strip?.querySelector(`.ws-tab[data-id="${CSS.escape(id)}"] .ws-tab-label`)
  if (!tab || !label) return
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'ws-tab-rename'
  input.value = tab.title
  input.maxLength = 60
  input.setAttribute('aria-label', '分頁名稱')
  renamingId = id
  let done = false
  const finish = async (commit) => {
    if (done) return
    done = true
    renamingId = ''
    const next = input.value.trim()
    if (commit && next && next !== tab.title) {
      if (tab.kind === 'terminal') {
        const mod = await import('./terminal-page.js')
        await mod.renameTerminalSession(id, next).catch(() => {})
      }
      tab.title = next
    }
    renderTabs()
    schedulePersistTabs()
  }
  input.addEventListener('keydown', (event) => {
    event.stopPropagation()
    if (event.key === 'Enter') { event.preventDefault(); void finish(true) }
    else if (event.key === 'Escape') { event.preventDefault(); void finish(false) }
  })
  input.addEventListener('blur', () => void finish(true))
  input.addEventListener('pointerdown', (event) => event.stopPropagation())
  label.replaceWith(input)
  input.focus()
  input.select()
}

// ===== 編輯器分頁 =====

/**
 * @param {string} relPath
 * @returns {string}
 */
const extOf = (relPath) => {
  const name = String(relPath || '').split('/').pop() || ''
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/**
 * 格式化檔案大小
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i] || 'B'}`
}

/**
 * 開分頁途中專案被切走了嗎？
 *
 * 開一個分頁至少要等一次 IPC，那段時間使用者可能已經切到別的專案——
 * 回來照樣 `tabs.push` 的話，B 專案的分頁列上就會冒出一個 A 專案的檔案
 * （`restoreProjectTabs` 早就有這道守衛，開分頁那幾條漏了）。
 *
 * @param {number} gen 呼叫當下的 `projectSwitch`
 * @param {string} projectId
 * @returns {boolean} true＝這份結果已經作廢
 */
function staleOpen(gen, projectId) {
  return gen !== projectSwitch || (project?.id || '') !== projectId
}

/**
 * 點檔案總管的一個檔案。同一個檔案已經開過就切回去，不重開一份。
 * @param {{ id: string, name: string }} proj
 * @param {string} relPath
 * @param {number} [line]
 */
export async function openEditorTab(proj, relPath, line = 0) {
  const id = `e:${proj.id}:${relPath}`
  const existing = findTab(id)
  if (existing) {
    await activate(id)
    if (line > 0) goToLine(line)
    return
  }
  const gen = projectSwitch
  let file
  try {
    file = await call(
      electronAPI.workspace.readFile(proj.id, relPath),
      '讀不到這個檔案'
    )
  } catch {
    return
  }
  if (staleOpen(gen, proj.id)) return
  // 連點兩下：第二趟讀檔回來時第一趟已經把分頁建好了，不可以再推一份
  if (findTab(id)) {
    await activate(id)
    if (line > 0) goToLine(line)
    return
  }

  const unsupported = Boolean((file.binary && !file.image && !file.pdf && !file.audio && !file.video) || file.tooLarge)
  const isSvg = extOf(relPath) === 'svg'

  /** @type {WsTab} */
  const tab = {
    id,
    kind: 'editor',
    title: relPath.split('/').pop() || relPath,
    projectId: proj.id,
    relPath,
    content: file.content || '',
    dirty: false,
    preview: Boolean(file.image || file.pdf || file.audio || file.video),
    image: file.image || '',
    pdf: file.pdf || '',
    audio: file.audio || '',
    video: file.video || '',
    unsupported,
    fileSize: file.size || 0,
    fileExt: extOf(relPath),
    mtimeMs: file.mtimeMs || Date.now(),
    readonly: file.pdf ? 'PDF 預覽，不能在這裡編輯。'
      : file.audio ? '音訊預覽，不能在這裡編輯。'
      : file.video ? '影片預覽，不能在這裡編輯。'
      : file.image && !isSvg ? '圖片預覽，不能在這裡編輯。'
      : file.binary ? '這是二進位檔案，不能在這裡編輯。'
        : file.tooLarge ? '這個檔案超過 2MB，不在這裡開啟。'
          : ''
  }
  tabs.push(tab)
  await activate(id)
  if (line > 0) goToLine(line)
}

/**
 * 把游標移到第 n 行並捲過去。textarea 沒有「捲到某一行」的 API，
 * 只能靠選取——設 selectionStart 之後 `blur/focus` 一次瀏覽器就會把它捲進畫面。
 *
 * @param {number} line 1 起算
 */
function goToLine(line) {
  if (monaco || !monacoTried) {
    // `useMonaco` 是非同步的：這時候 model 可能還是上一個檔案的，
    // 所以只記下來，等它掛好再跳（`applyGoto`）。
    pendingGoto = line
    applyGoto()
    return
  }
  const text = /** @type {HTMLTextAreaElement | null} */ (el.editorText)
  if (!text || text.hidden) return
  const lines = text.value.split('\n')
  if (line > lines.length) return
  const at = lines.slice(0, line - 1).reduce((sum, one) => sum + one.length + 1, 0)
  text.focus()
  text.setSelectionRange(at, at + (lines[line - 1] || '').length)
}

/**
 * 讓 Monaco 接手這個分頁。第一次會去載那 16MB 的 AMD 包（**惰性**，
 * 開機路徑上不碰）；載不起來就整支放棄，畫面留在原本的 `<textarea>` 上，
 * 存檔、草稿、外部變更偵測那幾條路完全不受影響。
 *
 * @param {WsTab} tab
 */
async function useMonaco(tab) {
  if (!el.monacoHost || tab.unsupported) return
  if (!monaco) {
    if (monacoTried) return
    monacoTried = true
    monaco = await loadMonaco()
    if (!monaco) return
    ensureEditor(monaco, el.monacoHost, onMonacoValue, paintMonacoStatus)
    // Monaco 起來了才把原本那組藏起來（載入中仍然看得到內容）
    el.monacoHost.hidden = false
    if (el.ideGutter) el.ideGutter.hidden = true
    if (el.editorText) el.editorText.hidden = true
    if (el.editorFindBtn) el.editorFindBtn.title = '尋找 (Ctrl+F)'
  }
  if (findTab(activeId) !== tab) return
  showMonacoTab(monaco, tab)
  applyGoto()
  paintMonacoStatus()
}

/**
 * Monaco 改了內容 → 同步回 textarea，再走原本那條變動流程。
 * 這樣「髒了沒」「草稿存檔」「外部變更偵測」全部一行都不用改。
 * @param {string} value
 */
function onMonacoValue(value) {
  const text = /** @type {HTMLTextAreaElement | null} */ (el.editorText)
  if (text) text.value = value
  notifyEditorChange()
  paintMonacoStatus()
}

/** 狀態列的游標位置改吃 Monaco 的（textarea 藏起來之後它的 selectionStart 不會動） */
function paintMonacoStatus() {
  const info = monaco ? cursorInfo() : null
  if (!info) return
  if (el.ideCursorPos) el.ideCursorPos.textContent = `Ln ${info.line}, Col ${info.column}`
  if (el.ideSelection) el.ideSelection.textContent = info.selected ? `已選 ${info.selected} 字元` : ''
  if (el.ideFileInfo) el.ideFileInfo.textContent = `${info.lines} 行`
}

/**
 * @param {WsTab} tab
 */
function paintEditor(tab) {
  const text = /** @type {HTMLTextAreaElement | null} */ (el.editorText)
  if (!text) return
  if (el.editorName) el.editorName.textContent = tab.relPath || tab.title

  if (tab.unsupported) {
    if (el.ideContainer) el.ideContainer.hidden = true
    if (el.ideStatusbar) el.ideStatusbar.hidden = true
    if (el.editorPreview) el.editorPreview.hidden = true
    if (el.unsupported) el.unsupported.hidden = false
    if (el.unsupportedName) el.unsupportedName.textContent = tab.relPath || tab.title
    if (el.unsupportedSize) el.unsupportedSize.textContent = formatBytes(tab.fileSize || 0)
    if (el.unsupportedType) el.unsupportedType.textContent = (tab.fileExt || 'BIN').toUpperCase()
    if (el.editorPreviewBtn) el.editorPreviewBtn.hidden = true
    if (el.editorSaveBtn) el.editorSaveBtn.hidden = true
    if (el.editorFindBtn) el.editorFindBtn.hidden = true
    if (el.editorNote) {
      el.editorNote.textContent = tab.readonly || ''
      el.editorNote.hidden = !tab.readonly
    }
    return
  }

  if (el.unsupported) el.unsupported.hidden = true
  if (el.ideStatusbar) el.ideStatusbar.hidden = false

  text.value = tab.content || ''
  text.readOnly = Boolean(tab.readonly)
  void useMonaco(tab)
  if (el.editorNote) {
    el.editorNote.textContent = tab.readonly || ''
    el.editorNote.hidden = !tab.readonly
  }

  const ext = extOf(tab.relPath || '')
  const previewable = ['md', 'markdown', 'html', 'htm', 'svg'].includes(ext)
  const isMedia = Boolean(tab.image || tab.pdf || tab.audio || tab.video)

  if (el.editorPreviewBtn) {
    el.editorPreviewBtn.hidden = (!previewable && !isMedia) || (isMedia && ext !== 'svg')
    el.editorPreviewBtn.textContent = tab.preview ? '編輯' : '預覽'
  }
  if (el.editorSaveBtn) el.editorSaveBtn.hidden = Boolean(tab.readonly)

  if (el.ideGutter) updateGutter(text, el.ideGutter)
  updateIdeStatus({
    textarea: text,
    relPath: tab.relPath || '',
    cursorPosEl: el.ideCursorPos,
    selectionEl: el.ideSelection,
    fileInfoEl: el.ideFileInfo,
    encodingEl: el.ideEncoding,
    langEl: el.ideLang
  })

  paintPreview(tab)
}

/**
 * @param {WsTab} tab
 */
function paintPreview(tab) {
  const container = el.ideContainer
  const box = el.editorPreview
  const text = /** @type {HTMLTextAreaElement | null} */ (el.editorText)
  if (!container || !box) return

  const on = Boolean(tab.preview)
  const ext = extOf(tab.relPath || '')
  const previewOnly = Boolean((tab.image || tab.pdf || tab.audio || tab.video) && ext !== 'svg')
  if (el.editorFindBtn) {
    el.editorFindBtn.hidden = previewOnly
    el.editorFindBtn.title = on ? '切到編輯並尋找 (Ctrl+F)' : '尋找與取代 (Ctrl+F)'
  }
  container.hidden = on
  box.hidden = !on
  if (!on) {
    if (text && el.ideGutter) updateGutter(text, el.ideGutter)
    return
  }

  if (tab.pdf) {
    void paintPdf(tab, box)
    return
  }
  if (tab.audio) {
    const audio = document.createElement('audio')
    audio.className = 'ws-editor-audio'
    audio.controls = true
    audio.src = tab.audio
    box.replaceChildren(audio)
    return
  }
  if (tab.video) {
    const video = document.createElement('video')
    video.className = 'ws-editor-video'
    video.controls = true
    video.src = tab.video
    box.replaceChildren(video)
    return
  }
  if (tab.image) {
    const img = document.createElement('img')
    img.className = 'ws-editor-img'
    img.alt = tab.title
    img.src = tab.image
    box.replaceChildren(img)
    return
  }
  if (ext === 'html' || ext === 'htm') {
    const frame = document.createElement('iframe')
    frame.className = 'ws-editor-frame'
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.setAttribute('title', '本機 HTML 預覽')
    frame.srcdoc = text?.value || tab.content || ''
    box.replaceChildren(frame)
    return
  }
  box.replaceChildren(renderMarkdown(text?.value || tab.content || ''))
}

/** pdf.js 只在真的開了 PDF 才載（那支 min 檔快 500KB，不該進開機路徑） */
let pdfLib = null

/**
 * PDF 預覽。
 *
 * ponytail: 用 pdf.js 的 **fake worker**（不設 `workerSrc`，整包跑在主執行緒）。
 * 理由是 file:// 下的 Worker 在 Chromium 會被擋，而且省掉 1.2MB 的 worker 檔；
 * 代價是很大的 PDF 會卡一下。真的卡再改成 worker（那時要一併處理 CSP 的 worker-src）。
 *
 * Electron 43 **沒有內建 PDF 檢視器**（`plugins: true` 也長不出來，
 * 見 `scripts/probe-workspace-pdf.js` 的實測矩陣），所以只能自己畫。
 *
 * @param {WsTab} tab
 * @param {HTMLElement} box
 */
async function paintPdf(tab, box) {
  box.replaceChildren(hint('PDF 載入中…'))
  try {
    if (!pdfLib) {
      pdfLib = await import('../../../node_modules/pdfjs-dist/build/pdf.min.mjs')
      // pdf.js v6 一定要有 workerSrc（給空字串會直接拋）。指到 asar 裡那支 worker：
      // file:// 開不出真的 Worker，pdf.js 會自己退回 fake worker，把它 import 進主執行緒。
      pdfLib.GlobalWorkerOptions.workerSrc = new URL(
        '../../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs',
        import.meta.url
      ).href
    }
    const bin = atob(tab.pdf || '')
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
    const doc = await pdfLib.getDocument({ data: bytes, isEvalSupported: false }).promise
    let page = 1

    const bar = document.createElement('div')
    bar.className = 'ws-pdf-bar'
    const prev = document.createElement('button')
    prev.type = 'button'
    prev.className = 'btn btn-secondary btn-sm'
    prev.textContent = '上一頁'
    const label = document.createElement('span')
    label.className = 'ws-pdf-page'
    const next = document.createElement('button')
    next.type = 'button'
    next.className = 'btn btn-secondary btn-sm'
    next.textContent = '下一頁'
    bar.append(prev, label, next)

    const canvas = document.createElement('canvas')
    canvas.className = 'ws-pdf-canvas'
    box.replaceChildren(bar, canvas)

    const draw = async () => {
      label.textContent = `第 ${page} / ${doc.numPages} 頁`
      prev.disabled = page <= 1
      next.disabled = page >= doc.numPages
      const rendered = await doc.getPage(page)
      const viewport = rendered.getViewport({ scale: 1.5 })
      canvas.width = viewport.width
      canvas.height = viewport.height
      const ctx = canvas.getContext('2d')
      if (ctx) await rendered.render({ canvasContext: ctx, viewport }).promise
    }
    prev.addEventListener('click', () => { page -= 1; void draw() })
    next.addEventListener('click', () => { page += 1; void draw() })
    await draw()
  } catch {
    box.replaceChildren(hint('這份 PDF 打不開。'))
  }
}

/**
 * @param {string} text
 * @returns {HTMLElement}
 */
function hint(text) {
  const p = document.createElement('p')
  p.className = 'ws-editor-note'
  p.textContent = text
  return p
}

/**
 * 存檔。預設帶著「開檔當下磁碟的版本」，對不上時 main 會回 STALE 把這次存檔擋下來——
 * 直接蓋掉等於把別人（或另一個編輯器）剛寫進去的東西無聲弄丟。
 *
 * @param {boolean} [force] true＝使用者按過「覆寫」，不帶版本硬寫
 */
async function saveActiveFile(force = false) {
  const tab = findTab(activeId)
  const text = /** @type {HTMLTextAreaElement | null} */ (el.editorText)
  if (!tab || tab.kind !== 'editor' || !text || tab.readonly) return
  const live = monaco ? currentValue() : null
  const content = typeof live === 'string' ? live : text.value
  text.value = content
  let saved
  const result = await electronAPI.workspace.writeFile(
    tab.projectId, tab.relPath, content, force ? undefined : (tab.mtimeMs || 0)
  )
  if (!result || !result.ok) {
    if (result?.error?.code === 'STALE') {
      // 草稿一個字都不能動：它是這裡唯一還活著的那一份
      tab.dirty = true
      renderTabs()
      schedulePersistTabs()
      if (findTab(activeId) === tab) showExtBanner(`存不進去：${result.error.message}`)
      return
    }
    showToast(result?.error?.message || '存檔失敗', 'error')
    return
  }
  saved = result.data
  if (findTab(activeId) === tab) tab.content = text.value
  tab.savedContent = content
  tab.dirty = tab.content !== content
  tab.mtimeMs = saved?.mtimeMs || Date.now()
  if (findTab(activeId) === tab) hideExtBanner()
  renderTabs()
  schedulePersistTabs()
  showToast(`已儲存 ${tab.title}`)
}

// ===== Git Diff 分頁 =====

/**
 * 「比較」：把磁碟上那一版跟手上的草稿並排。借 diff 分頁的版面，但它跟 Git 無關——
 * `conflict` 旗標讓 `paintDiff` 收掉暫存鈕與 +/- 統計，也不會被存進 `tabsState`
 * （存了的話下次開專案會拿去打 `gitDiff`，那是另一件事）。
 */
async function openConflictTab() {
  const tab = findTab(activeId)
  if (!tab || tab.kind !== 'editor' || !tab.projectId || !tab.relPath) return
  const gen = projectSwitch
  let file
  try {
    file = await call(electronAPI.workspace.readFile(tab.projectId, tab.relPath), '讀不到磁碟上的版本')
  } catch {
    return
  }
  if (gen !== projectSwitch) return
  stash()
  const id = `x:${tab.projectId}:${tab.relPath}`
  const existing = findTab(id)
  const next = existing || /** @type {WsTab} */ ({ id, kind: 'diff', projectId: tab.projectId, relPath: tab.relPath, conflict: true })
  next.title = `比較 ${tab.title}`
  next.versions = { original: file.content || '', modified: tab.content || '' }
  if (!existing) tabs.push(next)
  await activate(id)
}

/**
 * 開啟 Git Diff 檢視分頁
 * @param {{ id: string, name: string }} proj
 * @param {string} relPath
 * @param {boolean} [staged]
 */
export async function openDiffTab(proj, relPath, staged = false) {
  const id = `d:${proj.id}:${staged ? 's:' : 'w:'}${relPath}`
  const existing = findTab(id)
  if (existing) {
    await activate(id)
    return
  }
  const gen = projectSwitch
  let diffData
  try {
    diffData = await call(
      electronAPI.workspace.gitDiff(proj.id, relPath, staged),
      '讀取 Diff 失敗'
    )
  } catch {
    await openEditorTab(proj, relPath)
    return
  }
  // diff 編輯器要的是兩份完整內容，unified diff 只夠算 +/- 的數字。
  // 拿不到（不是 repo、二進位檔）就留 null，`paintDiff` 會退回逐行檢視。
  let versions = null
  try {
    const res = await electronAPI.workspace.gitFileVersions(proj.id, relPath, staged)
    if (res?.ok && res.data && !res.data.binary && !res.data.truncated) versions = res.data
  } catch {
    versions = null
  }
  if (staleOpen(gen, proj.id)) return
  if (findTab(id)) {
    await activate(id)
    return
  }

  /** @type {WsTab} */
  const tab = {
    id,
    kind: 'diff',
    title: `${staged ? '[暫存] ' : ''}${relPath.split('/').pop() || relPath}`,
    projectId: proj.id,
    relPath,
    staged,
    diffData,
    versions
  }
  tabs.push(tab)
  await activate(id)
}

/**
 * 審閱分頁：跟**某條分支的合併基準點**比（不是跟那條分支的最新一筆——
 * 那樣對方後來的提交會被算成「我刪掉的」）。
 *
 * 借 diff 分頁的版面，但它跟暫存區無關：`reviewRef` 一設，暫存鈕就收起來。
 *
 * @param {{ id: string, name: string }} proj
 * @param {string} relPath
 * @param {string} ref 要比的分支
 * @param {{ additions?: number, deletions?: number }} [stat] 從整體比較那一份清單帶過來的 +/-
 */
export async function openReviewTab(proj, relPath, ref, stat) {
  const id = `v:${proj.id}:${ref}:${relPath}`
  const existing = findTab(id)
  if (existing) {
    await activate(id)
    return
  }
  const gen = projectSwitch
  let versions = null
  try {
    const res = await electronAPI.workspace.gitFileVersionsAgainst(proj.id, relPath, ref)
    if (res?.ok && res.data && !res.data.binary && !res.data.truncated) versions = res.data
  } catch {
    versions = null
  }
  if (staleOpen(gen, proj.id)) return
  if (findTab(id)) {
    await activate(id)
    return
  }
  /** @type {WsTab} */
  const tab = {
    id,
    kind: 'diff',
    title: `[審閱] ${relPath.split('/').pop() || relPath}`,
    projectId: proj.id,
    relPath,
    reviewRef: ref,
    diffData: stat ? { diff: '', additions: stat.additions || 0, deletions: stat.deletions || 0 } : null,
    versions
  }
  tabs.push(tab)
  await activate(id)
}

/**
 * 繪製 Git Diff 內容
 * @param {WsTab} tab
 */
function paintDiff(tab) {
  if (el.diffTitle) {
    el.diffTitle.textContent = tab.conflict
      ? `[磁碟 ⇄ 未存草稿] ${tab.relPath}`
      : tab.reviewRef
        ? `[跟 ${tab.reviewRef} 比] ${tab.relPath}`
        : `${tab.staged ? '[暫存區] ' : '[工作區] '}${tab.relPath}`
  }
  // 暫存鈕只對「工作區 ⇄ 暫存區」那種 diff 有意義
  if (el.diffStageBtn) el.diffStageBtn.hidden = Boolean(tab.conflict || tab.reviewRef)
  paintReviewCount(tab)
  if (el.diffStats && tab.conflict) el.diffStats.replaceChildren()
  if (el.diffStats && tab.diffData) {
    el.diffStats.replaceChildren()
    const add = document.createElement('span')
    add.className = 'ws-diff-add'
    add.textContent = `+${tab.diffData.additions}`
    const del = document.createElement('span')
    del.className = 'ws-diff-del'
    del.textContent = `-${tab.diffData.deletions}`
    el.diffStats.append(add, del)
  }
  if (el.diffStageBtn) {
    el.diffStageBtn.textContent = tab.staged ? '取消暫存' : '暫存變更'
  }
  void paintDiffBody(tab)
}

/**
 * Diff 的內容。有 Monaco 又拿得到兩份完整內容就用**真正的並排 diff**
 * （可捲、可選、有語法高亮）；否則退回自繪的逐行檢視。
 * @param {WsTab} tab
 */
async function paintDiffBody(tab) {
  const fallback = () => {
    if (el.diffMonaco) el.diffMonaco.hidden = true
    if (el.diffContent) el.diffContent.hidden = false
    if (!el.diffContent) return
    if (tab.diffData) {
      renderDiffLines(el.diffContent, parseUnifiedDiff(tab.diffData.diff))
    } else if (tab.conflict) {
      el.diffContent.replaceChildren(hint('並排比較需要 Monaco 編輯器，這次沒載起來。'))
    }
  }
  if (!tab.versions || !el.diffMonaco) {
    fallback()
    return
  }
  if (!monaco && !monacoTried) {
    monacoTried = true
    monaco = await loadMonaco()
  }
  if (!monaco || findTab(activeId) !== tab) {
    fallback()
    return
  }
  if (el.diffContent) el.diffContent.hidden = true
  el.diffMonaco.hidden = false
  showDiff(monaco, el.diffMonaco, {
    original: tab.versions.original,
    modified: tab.versions.modified,
    relPath: tab.relPath || ''
  })
  // diff 是非同步算出來的，等它一輪再把「幾塊變更」寫上去
  window.setTimeout(() => {
    if (findTab(activeId) !== tab) return
    const count = diffChangeCount()
    if (el.diffNextBtn) el.diffNextBtn.title = count ? `下一個變更（共 ${count} 塊）` : '這一份沒有變更'
  }, 400)
}

// ===== 審閱：上一個／下一個變更、逐行意見 =====

/**
 * 意見數量畫在工具列上。**沒有意見時「交給 AI」不能按**——
 * 送一段空的過去只會讓 AI 問「你是不是漏貼了」。
 * @param {WsTab} [tab]
 */
function paintReviewCount(tab) {
  const active = tab || findTab(activeId)
  const projectId = active?.projectId || project?.id || ''
  const total = projectId ? countComments(projectId) : 0
  if (el.diffCommentsBtn) {
    el.diffCommentsBtn.textContent = `意見 ${total}`
    el.diffCommentsBtn.classList.toggle('is-on', total > 0)
  }
  if (el.reviewCount) el.reviewCount.textContent = `${total} 則意見`
  const empty = total === 0
  if (el.reviewToAiBtn) /** @type {HTMLButtonElement} */ (el.reviewToAiBtn).disabled = empty
  if (el.reviewClearBtn) /** @type {HTMLButtonElement} */ (el.reviewClearBtn).disabled = empty
}

/**
 * 對游標所在（或選取）的那幾行寫一則意見。
 *
 * 釘的是**右邊那一側**的行號（改完之後的樣子）——AI 手上那份就是這一版。
 */
function addReviewComment() {
  const tab = findTab(activeId)
  if (!tab || tab.kind !== 'diff' || !tab.projectId || !tab.relPath) return
  const at = diffCursor()
  if (!at) {
    showToast('先在右邊那一側點一下要講的那幾行', 'error')
    return
  }
  const text = window.prompt(`對 ${tab.relPath} 第 ${at.line} 行的意見`, '')
  if (text === null) return
  if (!addComment(tab.projectId, {
    relPath: tab.relPath,
    line: at.line,
    endLine: at.endLine,
    snippet: at.text,
    text
  })) {
    showToast('意見沒有加進去（空白，或這個專案的意見已經太多）', 'error')
    return
  }
  paintReviewCount(tab)
  if (el.reviewPanel && !el.reviewPanel.hidden) renderReviewList()
}

/** 意見清單（diff 底下那一塊） */
function renderReviewList() {
  const tab = findTab(activeId)
  const projectId = tab?.projectId || project?.id || ''
  if (!el.reviewList || !projectId) return
  el.reviewList.replaceChildren()
  const rows = listComments(projectId)
  if (!rows.length) {
    const note = document.createElement('p')
    note.className = 'ws-editor-note'
    note.textContent = '還沒有意見。在右邊選幾行，按「加意見」。'
    el.reviewList.appendChild(note)
    return
  }
  for (const row of rows) {
    const item = document.createElement('div')
    item.className = 'ws-review-item'
    const where = document.createElement('button')
    where.type = 'button'
    where.className = 'ws-review-where'
    where.textContent = `${row.relPath}:${row.line}`
    where.title = '跳到那一行'
    where.addEventListener('click', () => {
      if (projectId) void openEditorTab({ id: projectId, name: '' }, row.relPath, row.line)
    })
    const text = document.createElement('div')
    text.className = 'ws-review-text'
    text.textContent = row.text
    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'ws-review-del'
    del.textContent = '×'
    del.title = '刪掉這一則'
    del.addEventListener('click', () => {
      removeComment(projectId, row.id)
      renderReviewList()
      paintReviewCount()
    })
    item.append(where, text, del)
    el.reviewList.appendChild(item)
  }
}

/** 把整包意見丟進聊天輸入框（格式在 `ws-review.js`，不改上游 API 契約） */
function reviewToAi() {
  const tab = findTab(activeId)
  const projectId = tab?.projectId || project?.id || ''
  if (!projectId) return
  const text = formatComments(projectId, tab?.reviewRef || '')
  if (!text) {
    showToast('還沒有任何意見', 'error')
    return
  }
  sendToChat(text)
  showToast('意見已經帶進聊天輸入框')
}

/** 把編輯器裡選取的那幾行帶進聊天 */
function selectionToChat() {
  const tab = findTab(activeId)
  if (!tab || tab.kind !== 'editor') return
  const text = /** @type {HTMLTextAreaElement | null} */ (el.editorText)
  const picked = selectionInfo()
  let body = ''
  let where = tab.relPath || tab.title
  if (picked) {
    body = picked.text
    where = `${tab.relPath}:${picked.startLine}${picked.endLine > picked.startLine ? `-${picked.endLine}` : ''}`
  } else if (text && text.selectionEnd > text.selectionStart) {
    // 沒有 Monaco 時退回那份影子 textarea
    body = text.value.slice(text.selectionStart, text.selectionEnd)
    const before = text.value.slice(0, text.selectionStart).split('\n').length
    where = `${tab.relPath}:${before}`
  }
  if (!body.trim()) {
    showToast('先選一段文字再按', 'error')
    return
  }
  const fence = body.includes('```') ? '~~~' : '```'
  sendToChat(`\`${where}\`\n${fence}\n${body}\n${fence}\n`)
  showToast('已經帶進聊天輸入框')
}

// ===== 瀏覽器分頁 =====

/**
 * 只放行 http(s)：這個字串會變成 webview 的 src，`file:` 或 `javascript:`
 * 進去等於把本機檔案／我們自己的 origin 交出去（跟 `markdown.js` 的連結白名單同一條規則）。
 * @param {string} raw
 * @returns {string} 正規化後的網址；不合法回空字串
 */
function safeUrl(raw) {
  const value = String(raw || '').trim()
  if (!value) return ''
  const parse = (text) => {
    try {
      return new URL(text)
    } catch {
      return null
    }
  }
  // 先照原樣解析；**不能只看「有沒有冒號」來決定要不要補 http://**——
  // `localhost:5173` 的 `localhost:` 會被當成協定，於是最常用的那個網址反而進不去。
  let url = parse(value)
  // 只有「沒寫 `://`」才試著補：`file:///C:/x` 補下去會變成主機叫做 `file` 的 http 網址，
  // 使用者明明打的是本機路徑，卻看到它去查一個奇怪的網域。
  if ((!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) && !value.includes('://')) {
    url = parse(`http://${value}`)
  }
  if (!url) return ''
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : ''
}

/**
 * @param {string} [url]
 */
export async function openBrowserTab(url = '') {
  browserSeq += 1
  const id = `b:${browserSeq}`
  tabs.push({ id, kind: 'browser', title: '瀏覽器', url: url || '' })
  await activate(id)
}

// ===== 內建瀏覽器（<webview>）=====
//
// 比照 Orca：guest 不掛 preload、`partition` 用持久 session（登入狀態留著）、
// `allowpopups` 交給 main 的 app 層 handler 轉系統瀏覽器。X-Frame-Options 從此不存在。

/** @returns {Electron.WebviewTag | null} 這個容器裡唯一的 webview（惰性建立） */
function ensureBrowserGuest() {
  const host = el.browserFrame
  if (!host) return null
  let guest = /** @type {Electron.WebviewTag | null} */ (host.querySelector('webview'))
  if (!guest) {
    guest = document.createElement('webview')
    // 這些屬性要在插入與第一次導航**之前**設好（partition 建了就不能改）
    guest.setAttribute('partition', 'persist:wsbrowser')
    guest.setAttribute('allowpopups', '')
    guest.setAttribute('src', 'about:blank')
    guest.addEventListener('did-navigate', (event) => {
      syncBrowserLocation(/** @type {any} */ (event).url)
    })
    guest.addEventListener('did-navigate-in-page', (event) => {
      syncBrowserLocation(/** @type {any} */ (event).url)
    })
    guest.addEventListener('page-title-updated', (event) => {
      const tab = findTab(activeId)
      if (!tab || tab.kind !== 'browser') return
      const title = /** @type {any} */ (event).title
      tab.title = String(title || tab.title)
      renderTabs()
    })
    host.appendChild(guest)
  }
  return guest
}

/**
 * 導航事件 → 更新目前瀏覽器分頁的 url／標題與網址列。
 * @param {string} url
 */
function syncBrowserLocation(url) {
  const tab = findTab(activeId)
  if (!tab || tab.kind !== 'browser' || !url || url === 'about:blank') return
  const guest = el.browserFrame?.querySelector('webview')
  if (guest) guest.dataset.src = url
  tab.url = url
  const input = /** @type {HTMLInputElement | null} */ (el.browserUrl)
  if (input && document.activeElement !== input) input.value = url
  try {
    tab.title = new URL(url).host || '瀏覽器'
  } catch {
    tab.title = '瀏覽器'
  }
  renderTabs()
}

/**
 * @param {WsTab} tab
 */
function paintBrowser(tab) {
  const input = /** @type {HTMLInputElement | null} */ (el.browserUrl)
  const guest = ensureBrowserGuest()
  if (input) input.value = tab.url || ''
  if (!guest) return
  const href = safeUrl(tab.url || '')
  if (!href) {
    if (guest.dataset.src !== 'about:blank') {
      guest.dataset.src = 'about:blank'
      guest.setAttribute('src', 'about:blank')
    }
    return
  }
  // dataset.src 記「這顆 webview 現在真的在哪」：切分頁來回時避免同址重載
  if (href && guest.dataset.src !== href) {
    guest.dataset.src = href
    guest.setAttribute('src', href)
  }
}

function navigateBrowser() {
  const tab = findTab(activeId)
  const input = /** @type {HTMLInputElement | null} */ (el.browserUrl)
  const guest = ensureBrowserGuest()
  if (!tab || tab.kind !== 'browser' || !input || !guest) return
  const href = safeUrl(input.value)
  if (!href) {
    showToast('只支援 http 與 https 的網址', 'error')
    return
  }
  tab.url = href
  input.value = href
  guest.dataset.src = href
  guest.setAttribute('src', href)
  try {
    tab.title = new URL(href).host || '瀏覽器'
  } catch {
    tab.title = '瀏覽器'
  }
  renderTabs()
}

// ===== AI 會話結構化分頁（不需 resume） =====

/**
 * 開啟 AI 對話記錄結構化分頁（不用 resume，直接檢視）
 * @param {{ id: string, name: string, path: string }} proj
 * @param {{ agent: string, id: string, title: string, agentLabel: string, mtime: number }} row
 */
export async function openAiSessionTab(proj, row) {
  const id = `a:${proj.id}:${row.agent}:${row.id}`
  const existing = findTab(id)
  if (existing) {
    await activate(id)
    return
  }
  const gen = projectSwitch
  let sessionData
  try {
    sessionData = await call(
      electronAPI.workspace.agentSessionDetail(proj.id, row.agent, row.id),
      '讀取 AI 對話記錄失敗'
    )
  } catch {
    return
  }
  if (staleOpen(gen, proj.id)) return
  if (findTab(id)) {
    await activate(id)
    return
  }

  /** @type {WsTab} */
  const tab = {
    id,
    kind: 'ai-session',
    title: `${row.agentLabel} · ${shortTitle(row.title || row.id)}`,
    projectId: proj.id,
    sessionRow: row,
    sessionData
  }
  tabs.push(tab)
  await activate(id)
}

/**
 * AI 會話分頁的畫面（實作在 `ws-ai-session.js`，這裡只餵資料與回呼）。
 * @param {WsTab} tab
 */
function paintAiSessionTab(tab) {
  paintAiSession({
    tab,
    els: {
      title: el.aiSessionTitle,
      meta: el.aiSessionMeta,
      body: el.aiSessionBody,
      resumeBtn: /** @type {HTMLButtonElement | null} */ (el.aiResumeBtn),
      resumeIntoBtn: /** @type {HTMLButtonElement | null} */ (el.aiResumeIntoBtn)
    },
    onOpenFile: (rel) => {
      if (tab.projectId) void openEditorTab({ id: tab.projectId, name: '' }, rel)
    },
    // 「送進現有終端機」只列**這個專案分頁列上**開著的那些
    terminals: () => tabs
      .filter((one) => one.kind === 'terminal')
      .map((one) => ({ id: one.id, title: one.title })),
    onResume: (terminalId) => void resumeSession(tab, terminalId)
  })
}

/**
 * 接續一段對話。
 *
 * 指令字串由 main 組，而且 main 會**先確認這段對話真的屬於這個專案**——
 * renderer 這邊連 session id 都只是原樣轉交。
 *
 * @param {WsTab} tab
 * @param {string} terminalId 空字串＝開一個新的終端機
 */
async function resumeSession(tab, terminalId) {
  const row = tab.sessionRow
  if (!tab.projectId || !row) return
  let info
  try {
    info = await call(
      electronAPI.workspace.agentResume(tab.projectId, row.agent, row.id),
      '接續不了這段對話'
    )
  } catch {
    return
  }
  const title = `${info.agentLabel} · ${shortTitle(row.title || row.id)}`
  if (!terminalId) {
    await newTerminalWithCommand(title, info.command)
    return
  }
  // 送進現有的那一顆：先切過去，讓人看得到指令真的被打進去了
  await activate(terminalId)
  await electronAPI.terminal.write(terminalId, `${info.command}\r`)
}

// ===== 新增分頁的選單 =====

/**
 * 「＋」的清單。前幾項都是終端機，只是啟動指令的 preset 不同——
 * 指令字串在 main 的固定表（`terminal/store.js`），這裡只送 key。
 */
const NEW_ITEMS = [
  { preset: 'shell', label: '終端機' },
  { preset: 'claude', label: 'Claude Code' },
  { preset: 'codex', label: 'Codex' },
  { preset: 'opencode', label: 'OpenCode' },
  { preset: 'agy', label: 'Antigravity' },
  { preset: 'grok', label: 'Grok' }
]

/** @type {HTMLElement | null} */
let menuEl = null

function closeMenu() {
  menuEl?.remove()
  menuEl = null
  el.newBtn?.setAttribute('aria-expanded', 'false')
  window.removeEventListener('pointerdown', onOutsideMenu, true)
}

/** @param {PointerEvent} event */
function onOutsideMenu(event) {
  if (!menuEl) return
  const target = /** @type {Node} */ (event.target)
  if (menuEl.contains(target) || el.newBtn?.contains(target)) return
  closeMenu()
}

function toggleMenu() {
  if (menuEl) {
    closeMenu()
    return
  }
  const anchor = el.newBtn
  if (!anchor) return
  menuEl = document.createElement('div')
  menuEl.className = 'ws-new-menu'
  menuEl.setAttribute('role', 'menu')

  const admin = document.createElement('label')
  admin.className = 'ws-new-admin'
  const adminInput = document.createElement('input')
  adminInput.type = 'checkbox'
  adminInput.id = 'wsNewAdmin'
  admin.append(adminInput, document.createTextNode('以系統管理員身分執行'))

  for (const item of NEW_ITEMS) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'ws-new-item'
    btn.setAttribute('role', 'menuitem')
    btn.textContent = item.label
    btn.addEventListener('click', () => {
      const asAdmin = adminInput.checked
      closeMenu()
      void newTerminal(item.preset, asAdmin)
    })
    menuEl.appendChild(btn)
  }

  const sep = document.createElement('div')
  sep.className = 'ws-new-sep'
  menuEl.appendChild(sep)

  // 「自訂…」是選 shell 與工作目錄的唯一入口（側欄那顆「＋ 終端機」收掉之後）
  const customBtn = document.createElement('button')
  customBtn.type = 'button'
  customBtn.className = 'ws-new-item'
  customBtn.id = 'wsNewCustomTerm'
  customBtn.setAttribute('role', 'menuitem')
  customBtn.textContent = '終端機（自訂…）'
  customBtn.addEventListener('click', () => {
    closeMenu()
    void import('./terminal-page.js').then((mod) => mod.openNewTerminalDialog(project?.path || ''))
  })

  const browserBtn = document.createElement('button')
  browserBtn.type = 'button'
  browserBtn.className = 'ws-new-item'
  browserBtn.setAttribute('role', 'menuitem')
  browserBtn.textContent = '瀏覽器'
  browserBtn.addEventListener('click', () => {
    closeMenu()
    void openBrowserTab()
  })
  menuEl.append(customBtn, browserBtn, admin)

  const rect = anchor.getBoundingClientRect()
  menuEl.style.top = `${Math.round(rect.bottom + 4)}px`
  menuEl.style.right = `${Math.round(window.innerWidth - rect.right)}px`
  document.body.appendChild(menuEl)
  anchor.setAttribute('aria-expanded', 'true')
  window.addEventListener('pointerdown', onOutsideMenu, true)
}

/**
 * @param {string} preset
 * @param {boolean} admin
 */
async function newTerminal(preset, admin) {
  try {
    const created = await call(electronAPI.terminal.create({
      preset,
      // 有選專案就在專案裡開；沒有的話 main 會退回家目錄
      cwd: project?.path || '',
      // 工作階段也記在專案底下（缺值＝未分類，舊的 terminals.json 就是這樣）
      projectId: project?.id || '',
      admin
    }), '建立終端機失敗')
    const mod = await import('./terminal-page.js')
    await mod.openTerminalSession(created.id)
  } catch {
    // call 已經吐過 toast
  }
}

/**
 * 開一個已知的恢復指令（AI 記錄面板用）。
 * @param {string} title
 * @param {string} command
 */
export async function newTerminalWithCommand(title, command) {
  try {
    const created = await call(electronAPI.terminal.create({
      preset: 'shell',
      cwd: project?.path || '',
      projectId: project?.id || '',
      title
    }), '建立終端機失敗')
    const mod = await import('./terminal-page.js')
    await mod.openTerminalSession(created.id)
    await electronAPI.terminal.write(created.id, `${command}\r`)
  } catch {
    // call 已經吐過 toast
  }
}

// ===== 對外 =====

/**
 * 還原專案儲存的分頁與草稿（Hot Exit）
 * @param {{ id: string, name: string, path: string }} proj
 */
async function restoreProjectTabs(proj, generation) {
  try {
    const res = await electronAPI.workspace.getTabsState(proj.id)
    if (generation !== projectSwitch) return
    const saved = res?.ok ? res.data : null
    if (!saved || !Array.isArray(saved.tabs) || !saved.tabs.length) {
      tabs = tabs.filter((t) => t.kind === 'terminal')
      renderTabs()
      const carried = tabs[0]
      if (carried) void activate(carried.id)
      else showSurface('empty')
      return
    }

    // 只留「跟著進來」的終端機（沒選專案時開的那些），其餘舊分頁全部清掉
    tabs = tabs.filter((t) => t.kind === 'terminal')
    // 存檔裡的終端機分頁可能指向已經被刪掉的工作階段（另一扇視窗刪的、上次沒收乾淨的）
    const liveTerminals = new Set()
    if (saved.tabs.some((item) => item.kind === 'terminal')) {
      const res2 = await electronAPI.terminal.list()
      if (generation !== projectSwitch) return
      for (const row of (res2?.ok && Array.isArray(res2.data) ? res2.data : [])) liveTerminals.add(row.id)
    }

    for (const item of saved.tabs) {
      if (item.kind === 'terminal') {
        if (liveTerminals.has(item.id) && !findTab(item.id)) {
          tabs.push({ id: item.id, kind: 'terminal', title: item.title || '終端機' })
        }
      } else if (item.kind === 'editor' && item.relPath) {
        try {
          const file = await call(electronAPI.workspace.readFile(proj.id, item.relPath), '')
          if (generation !== projectSwitch) return
          const hasDraft = typeof item.draftContent === 'string'
            && (item.dirty === true || Boolean(item.draftContent)) && item.draftContent !== file.content
          const unsupported = Boolean((file.binary && !file.image && !file.pdf && !file.audio && !file.video) || file.tooLarge)
          const isSvg = extOf(item.relPath) === 'svg'
          tabs.push({
            id: item.id,
            kind: 'editor',
            title: item.relPath.split('/').pop() || item.relPath,
            projectId: proj.id,
            relPath: item.relPath,
            content: hasDraft ? item.draftContent : (file.content || ''),
            savedContent: file.content || '',
            dirty: hasDraft,
            preview: Boolean(item.preview || (file.image || file.pdf || file.audio || file.video)),
            image: file.image || '',
            pdf: file.pdf || '',
            audio: file.audio || '',
            video: file.video || '',
            unsupported,
            fileSize: file.size || 0,
            fileExt: extOf(item.relPath),
            mtimeMs: file.mtimeMs || Date.now(),
            readonly: file.pdf ? 'PDF 預覽，不能在這裡編輯。'
              : file.audio ? '音訊預覽，不能在這裡編輯。'
              : file.video ? '影片預覽，不能在這裡編輯。'
              : file.image && !isSvg ? '圖片預覽，不能在這裡編輯。'
              : file.binary ? '這是二進位檔案，不能在這裡編輯。'
              : file.tooLarge ? '這個檔案超過 2MB，不在這裡開啟。'
              : ''
          })
        } catch {
          if (generation !== projectSwitch) return
          if (typeof item.draftContent === 'string' && (item.dirty || item.draftContent)) {
            tabs.push({ id: item.id, kind: 'editor', projectId: proj.id,
              title: item.relPath.split('/').pop(), relPath: item.relPath,
              content: item.draftContent, savedContent: null, dirty: true, preview: false })
          }
        }
      } else if (item.kind === 'diff' && item.relPath) {
        try {
          const diffData = await call(electronAPI.workspace.gitDiff(proj.id, item.relPath, item.staged), '')
          if (generation !== projectSwitch) return
          tabs.push({
            id: item.id,
            kind: 'diff',
            title: `${item.staged ? '[暫存] ' : ''}${item.relPath.split('/').pop() || item.relPath}`,
            projectId: proj.id,
            relPath: item.relPath,
            staged: Boolean(item.staged),
            diffData
          })
        } catch {
          // ignore
        }
      } else if (item.kind === 'browser') {
        browserSeq += 1
        tabs.push({
          id: item.id || `b:${browserSeq}`,
          kind: 'browser',
          title: item.title || '瀏覽器',
          url: item.url || ''
        })
      } else if (item.kind === 'ai-session' && item.sessionRow) {
        try {
          const detail = await call(electronAPI.workspace.agentSessionDetail(proj.id, item.sessionRow.agent, item.sessionRow.id), '')
          if (generation !== projectSwitch) return
          tabs.push({
            id: item.id,
            kind: 'ai-session',
            title: item.title,
            projectId: proj.id,
            sessionRow: item.sessionRow,
            sessionData: detail
          })
        } catch {
          // ignore
        }
      }
    }
    renderTabs()
    const targetActive = saved.activeId && findTab(saved.activeId) ? saved.activeId : (tabs[0]?.id || '')
    if (targetActive) void activate(targetActive)
    else showSurface('empty')
  } catch {
    renderTabs()
    showSurface('empty')
  }
}

/**
 * @param {{ id: string, name: string, path: string } | null} next
 */
export async function setActiveProject(next) {
  if (project?.id === next?.id) return true
  const generation = ++projectSwitch
  window.clearTimeout(persistTimer)
  if (project?.id) {
    if (await persistTabsNow() === false) return false
  }
  if (generation !== projectSwitch) return false
  const hadProject = Boolean(project?.id)
  project = next
  if (hadProject) {
    // 每個專案有自己一組分頁：離開時把終端機那幾格從畫面上摘掉
    // （**只摘畫面**，pty 與 scrollback 都還在 main，切回來會原樣接上）
    await detachAllTerminals()
    if (generation !== projectSwitch) return false
    tabs = []
  } else {
    // 還沒選過專案時開的終端機沒有地方存，跟著進第一個選中的專案——
    // 丟掉的話那個工作階段就再也叫不出來了（側欄已經沒有清單接住它）
    tabs = tabs.filter((t) => t.kind === 'terminal')
  }
  activeId = ''
  renderTabs()
  showSurface('empty')
  if (!next) return true
  await restoreProjectTabs(next, generation)
  return generation === projectSwitch
}

/**
 * 現在是哪個專案（終端機那邊要把工作階段掛在同一個專案底下）。
 * @returns {string}
 */
export function currentProjectId() {
  return project?.id || ''
}

/** 把目前這組終端機分頁的畫面收掉（工作階段本身不動） */
async function detachAllTerminals() {
  const ids = tabs.filter((t) => t.kind === 'terminal').map((t) => t.id)
  if (!ids.length) return
  const mod = await import('./terminal-page.js')
  for (const id of ids) mod.detachTerminalPane(id)
}

export function initWsTabs() {
  if (initialized) return
  initialized = true

  el.strip = document.getElementById('wsTabStrip')
  el.newBtn = document.getElementById('wsNewBtn')
  // 滑鼠滾輪在分頁列上＝橫向捲。這一條只有直向的滾輪需要轉向；
  // 觸控板本來就會送 deltaX，那種照原樣讓瀏覽器處理。
  el.strip?.addEventListener('wheel', (event) => {
    const wheel = /** @type {WheelEvent} */ (event)
    if (wheel.deltaX || !wheel.deltaY || !el.strip) return
    if (el.strip.scrollWidth <= el.strip.clientWidth) return
    event.preventDefault()
    el.strip.scrollLeft += wheel.deltaY
  }, { passive: false })
  el.termHost = document.getElementById('termHost')
  el.termEmpty = document.getElementById('termEmpty')
  el.editor = document.getElementById('wsEditor')
  el.editorName = document.getElementById('wsEditorName')
  el.editorText = document.getElementById('wsEditorText')
  el.editorPreview = document.getElementById('wsEditorPreview')
  el.editorPreviewBtn = document.getElementById('wsEditorPreviewBtn')
  el.editorSaveBtn = document.getElementById('wsEditorSaveBtn')
  el.editorDiffBtn = document.getElementById('wsEditorDiffBtn')
  el.editorFindBtn = document.getElementById('wsEditorFindBtn')
  el.editorExtBanner = document.getElementById('wsEditorExtBanner')
  el.editorExtBannerMsg = document.querySelector('#wsEditorExtBanner .ws-ext-banner-msg')
  el.editorReloadDiskBtn = document.getElementById('wsEditorReloadDiskBtn')
  el.editorCompareDiskBtn = document.getElementById('wsEditorCompareDiskBtn')
  el.editorOverwriteDiskBtn = document.getElementById('wsEditorOverwriteDiskBtn')
  el.editorIgnoreDiskBtn = document.getElementById('wsEditorIgnoreDiskBtn')
  el.editorNote = document.getElementById('wsEditorNote')
  el.browser = document.getElementById('wsBrowser')
  el.browserUrl = document.getElementById('wsBrowserUrl')
  el.browserFrame = document.getElementById('wsBrowserFrame')

  // AI 會話元素
  el.aiSession = document.getElementById('wsAiSession')
  el.aiSessionTitle = document.getElementById('wsAiSessionTitle')
  el.aiSessionMeta = document.getElementById('wsAiSessionMeta')
  el.aiSessionBody = document.getElementById('wsAiSessionBody')
  el.aiResumeBtn = document.getElementById('wsAiResumeBtn')
  el.aiResumeIntoBtn = document.getElementById('wsAiResumeIntoBtn')
  el.editorToChatBtn = document.getElementById('wsEditorToChatBtn')

  // IDE 元素
  el.ideContainer = document.querySelector('.ws-ide-container')
  el.ideGutter = document.getElementById('wsIdeGutter')
  el.ideCursorPos = document.getElementById('wsIdeCursorPos')
  el.ideSelection = document.getElementById('wsIdeSelection')
  el.ideFileInfo = document.getElementById('wsIdeFileInfo')
  el.ideEncoding = document.getElementById('wsIdeEncoding')
  el.ideLang = document.getElementById('wsIdeLang')
  el.ideStatusbar = document.getElementById('wsIdeStatusbar')

  // 尋找取代元素
  const findWidgetHost = document.getElementById('wsIdeFindWidget')
  const findInput = /** @type {HTMLInputElement} */ (document.getElementById('wsFindInput'))
  const replaceInput = /** @type {HTMLInputElement} */ (document.getElementById('wsReplaceInput'))
  const findCount = document.getElementById('wsFindCount')
  const replaceRow = document.getElementById('wsReplaceRow')
  const prevBtn = document.getElementById('wsFindPrevBtn')
  const nextBtn = document.getElementById('wsFindNextBtn')
  const toggleReplaceBtn = document.getElementById('wsFindToggleReplaceBtn')
  const closeBtn = document.getElementById('wsFindCloseBtn')
  const replaceBtn = document.getElementById('wsReplaceBtn')
  const replaceAllBtn = document.getElementById('wsReplaceAllBtn')

  // 不支援格式元素
  el.unsupported = document.getElementById('wsEditorUnsupported')
  el.unsupportedName = document.getElementById('wsEditorUnsupportedName')
  el.unsupportedSize = document.getElementById('wsEditorUnsupportedSize')
  el.unsupportedType = document.getElementById('wsEditorUnsupportedType')
  el.unsupportedReveal = document.getElementById('wsEditorUnsupportedRevealBtn')

  // Git Diff 元素
  el.diff = document.getElementById('wsDiff')
  el.diffTitle = document.getElementById('wsDiffTitle')
  el.diffStats = document.getElementById('wsDiffStats')
  el.diffStageBtn = document.getElementById('wsDiffStageBtn')
  el.diffOpenEditorBtn = document.getElementById('wsDiffOpenEditorBtn')
  el.diffContent = document.getElementById('wsDiffContent')
  el.monacoHost = document.getElementById('wsMonacoHost')
  el.diffMonaco = document.getElementById('wsDiffMonaco')
  el.diffPrevBtn = document.getElementById('wsDiffPrevBtn')
  el.diffNextBtn = document.getElementById('wsDiffNextBtn')
  el.diffCommentBtn = document.getElementById('wsDiffCommentBtn')
  el.diffCommentsBtn = document.getElementById('wsDiffCommentsBtn')
  el.reviewPanel = document.getElementById('wsReviewPanel')
  el.reviewList = document.getElementById('wsReviewList')
  el.reviewCount = document.getElementById('wsReviewCount')
  el.reviewToAiBtn = document.getElementById('wsReviewToAiBtn')
  el.reviewClearBtn = document.getElementById('wsReviewClearBtn')
  el.reviewCloseBtn = document.getElementById('wsReviewCloseBtn')

  el.newBtn?.addEventListener('click', toggleMenu)

  const onEditorChange = () => {
    const tab = findTab(activeId)
    if (!tab || tab.kind !== 'editor') return
    const text = /** @type {HTMLTextAreaElement} */ (el.editorText)
    const changed = text.value !== tab.content
    if (typeof tab.savedContent !== 'string') tab.savedContent = tab.content || ''
    const next = text.value !== tab.savedContent
    tab.content = text.value
    if (next !== tab.dirty) {
      tab.dirty = next
      renderTabs()
    }
    if (changed) schedulePersistTabs()
    if (el.ideGutter) updateGutter(text, el.ideGutter)
    updateIdeStatus({
      textarea: text,
      relPath: tab.relPath || '',
      cursorPosEl: el.ideCursorPos,
      selectionEl: el.ideSelection,
      fileInfoEl: el.ideFileInfo,
      encodingEl: el.ideEncoding,
      langEl: el.ideLang
    })
    // Monaco 開著時游標／行數以它為準（textarea 藏起來後不會再動）
    paintMonacoStatus()
  }
  notifyEditorChange = onEditorChange

  const findController = initFindWidget({
    textarea: /** @type {HTMLTextAreaElement} */ (el.editorText),
    widget: findWidgetHost,
    findInput,
    replaceInput,
    countEl: findCount,
    replaceRow,
    prevBtn,
    nextBtn,
    toggleReplaceBtn,
    closeBtn,
    replaceBtn,
    replaceAllBtn,
    onDirty: () => {
      const tab = findTab(activeId)
      if (tab && tab.kind === 'editor') {
        tab.dirty = true
        renderTabs()
        onEditorChange()
        schedulePersistTabs()
      }
    }
  })

  el.editorFindBtn?.addEventListener('click', () => {
    const tab = findTab(activeId)
    if (!tab || tab.kind !== 'editor' || tab.unsupported) return
    const ext = extOf(tab.relPath || '')
    const previewOnly = Boolean((tab.image || tab.pdf || tab.audio || tab.video) && ext !== 'svg')
    if (previewOnly) return
    if (tab.preview) {
      tab.preview = false
      if (el.editorPreviewBtn) el.editorPreviewBtn.textContent = '預覽'
      paintPreview(tab)
      schedulePersistTabs()
    }
    if (monaco) {
      // Monaco 的尋找列收起來時**高度還在**（只是 visibility: hidden），
      // 所以要看 `.visible` 這個 class，量高度會一直判成「開著」。
      const open = document.querySelector('#wsMonacoHost .find-widget.visible')
      runAction(open ? 'closeFindWidget' : 'actions.find')
      return
    }
    if (findWidgetHost && !findWidgetHost.hidden) {
      findController?.closeFind()
    } else {
      findController?.openFind(false)
    }
  })

  el.editorReloadDiskBtn?.addEventListener('click', () => void reloadActiveFileFromDisk(true))
  el.editorCompareDiskBtn?.addEventListener('click', () => void openConflictTab())
  el.editorOverwriteDiskBtn?.addEventListener('click', () => void saveActiveFile(true))
  el.editorIgnoreDiskBtn?.addEventListener('click', () => {
    hideExtBanner()
    const tab = findTab(activeId)
    // 「保留編輯」只是把提示收起來，磁碟上那一版仍然比較新——
    // 版本要換成磁碟的真值，不是 `Date.now()`（隨手寫一個時間等於下次存檔又硬蓋一次）
    if (tab?.projectId && tab.relPath) {
      void electronAPI.workspace.getFileMtime(tab.projectId, tab.relPath).then((res) => {
        if (res?.ok && res.data?.mtimeMs) tab.mtimeMs = res.data.mtimeMs
      })
    }
  })

  // 有人直接改了那份影子 textarea（存檔後重載、尋找取代、自動化測試）→ 推回 Monaco。
  // Monaco 自己改的那條路已經先同步過 textarea，值一樣就不會再繞回來。
  el.editorText?.addEventListener('input', () => {
    if (monaco) pushValue(/** @type {HTMLTextAreaElement} */ (el.editorText).value)
  })
  el.editorText?.addEventListener('input', onEditorChange)
  el.editorText?.addEventListener('click', onEditorChange)
  el.editorText?.addEventListener('keyup', onEditorChange)
  el.editorText?.addEventListener('scroll', () => {
    if (el.ideGutter && el.editorText) el.ideGutter.scrollTop = el.editorText.scrollTop
  })

  el.editorText?.addEventListener('keydown', (event) => {
    const tab = findTab(activeId)
    if (!tab || tab.kind !== 'editor') return
    const text = /** @type {HTMLTextAreaElement} */ (el.editorText)
    handleEditorKeydown(event, text, () => {
      tab.dirty = true
      renderTabs()
      onEditorChange()
      schedulePersistTabs()
    }, () => void saveActiveFile(), (withReplace) => {
      findController?.openFind(withReplace)
    })
  })

  el.editorSaveBtn?.addEventListener('click', () => void saveActiveFile())
  el.editorDiffBtn?.addEventListener('click', async () => {
    const tab = findTab(activeId)
    if (!tab || tab.kind !== 'editor' || !tab.projectId || !tab.relPath) return
    await refreshEditorDiffButton(tab)
    if (findTab(activeId) !== tab || el.editorDiffBtn?.hidden) return
    void openDiffTab({ id: tab.projectId, name: '' }, tab.relPath,
      el.editorDiffBtn.dataset.staged === '1')
  })
  el.editorPreviewBtn?.addEventListener('click', () => {
    const tab = findTab(activeId)
    if (!tab || tab.kind !== 'editor') return
    tab.preview = !tab.preview
    if (el.editorPreviewBtn) el.editorPreviewBtn.textContent = tab.preview ? '編輯' : '預覽'
    paintPreview(tab)
    schedulePersistTabs()
  })

  el.unsupportedReveal?.addEventListener('click', () => {
    const tab = findTab(activeId)
    if (!tab || tab.kind !== 'editor' || !tab.projectId || !tab.relPath) return
    void electronAPI.workspace.reveal(tab.projectId, tab.relPath)
  })

  el.editorToChatBtn?.addEventListener('click', selectionToChat)

  // 上一個／下一個變更：Monaco 的 diff 編輯器自己知道變更在哪，不要自己算
  const goDiff = (dir) => {
    if (!diffGoTo(dir)) showToast('這一份沒有可以跳的變更', 'error')
  }
  el.diffPrevBtn?.addEventListener('click', () => goDiff('previous'))
  el.diffNextBtn?.addEventListener('click', () => goDiff('next'))
  el.diffCommentBtn?.addEventListener('click', addReviewComment)
  el.diffCommentsBtn?.addEventListener('click', () => {
    if (!el.reviewPanel) return
    el.reviewPanel.hidden = !el.reviewPanel.hidden
    if (!el.reviewPanel.hidden) renderReviewList()
  })
  el.reviewCloseBtn?.addEventListener('click', () => {
    if (el.reviewPanel) el.reviewPanel.hidden = true
  })
  el.reviewToAiBtn?.addEventListener('click', reviewToAi)
  el.reviewClearBtn?.addEventListener('click', () => {
    const tab = findTab(activeId)
    const projectId = tab?.projectId || project?.id || ''
    if (!projectId) return
    clearComments(projectId)
    renderReviewList()
    paintReviewCount()
  })

  // Alt+↑／↓ 在 diff 分頁上＝跳變更（跟 VS Code 一樣）。
  // 只在 diff 分頁、而且工作區真的看得見時才收，不然會把別頁的方向鍵吃掉。
  document.addEventListener('keydown', (event) => {
    if (!event.altKey || event.ctrlKey || event.metaKey) return
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    const tab = findTab(activeId)
    if (!tab || tab.kind !== 'diff') return
    const main = document.getElementById('termMain')
    if (!main || main.offsetParent === null) return
    event.preventDefault()
    goDiff(event.key === 'ArrowUp' ? 'previous' : 'next')
  })

  el.diffOpenEditorBtn?.addEventListener('click', () => {
    const tab = findTab(activeId)
    if (!tab || tab.kind !== 'diff' || !tab.projectId || !tab.relPath) return
    void openEditorTab({ id: tab.projectId, name: '' }, tab.relPath)
  })

  el.diffStageBtn?.addEventListener('click', async () => {
    const tab = findTab(activeId)
    if (!tab || tab.kind !== 'diff' || !tab.projectId || !tab.relPath) return
    try {
      if (tab.staged) {
        await call(electronAPI.workspace.gitUnstage(tab.projectId, tab.relPath), '取消暫存失敗')
        tab.staged = false
      } else {
        await call(electronAPI.workspace.gitStage(tab.projectId, tab.relPath), '暫存失敗')
        tab.staged = true
      }
      // 剛動過暫存區：檔案樹與「未提交變更」鈕不可以再拿快取那份
      invalidateGitStatus()
      tab.diffData = await call(electronAPI.workspace.gitDiff(tab.projectId, tab.relPath, tab.staged), '更新 Diff 失敗')
      // 並排 diff 的兩份完整內容也要重讀：暫存前後比的是不同的基準
      // （只換 diffData 的話統計是新的、畫面上那兩欄還是舊的）
      const res = await electronAPI.workspace.gitFileVersions(tab.projectId, tab.relPath, tab.staged)
      tab.versions = (res?.ok && res.data && !res.data.binary && !res.data.truncated) ? res.data : null
      tab.title = `${tab.staged ? '[暫存] ' : ''}${tab.relPath.split('/').pop() || tab.relPath}`
      renderTabs()
      paintDiff(tab)
      schedulePersistTabs()
    } catch {
      // call 已經處理過錯誤
    }
  })

  document.getElementById('wsBrowserGoBtn')?.addEventListener('click', navigateBrowser)
  document.getElementById('wsBrowserReloadBtn')?.addEventListener('click', () => {
    const guest = el.browserFrame?.querySelector('webview')
    if (guest) /** @type {any} */ (guest).reload()
  })
  document.getElementById('wsBrowserExternalBtn')?.addEventListener('click', () => {
    const href = safeUrl(/** @type {HTMLInputElement} */ (el.browserUrl)?.value || '')
    if (href) void electronAPI.workspace.openExternal(href)
    else showToast('只支援 http 與 https 的網址', 'error')
  })
  el.browserUrl?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      navigateBrowser()
    }
  })

  window.addEventListener('focus', () => void checkActiveFileExternalChange())
  // 監看說資料夾動過了 → 開著的那個檔案重新對一次版本
  // （提示條該不該跳由 `checkActiveFileExternalChange` 自己判斷）
  document.addEventListener('ws:files-changed', () => {
    void checkActiveFileExternalChange()
    const tab = findTab(activeId)
    if (tab?.kind === 'editor') void refreshEditorDiffButton(tab)
  })
  // `beforeunload` 只夠應付「當掉」那種情況：非同步儲存跑不完視窗就沒了。
  // 正常結束走 main 的 before-quit，它會等這一輪真的寫完。
  window.addEventListener('beforeunload', () => void persistTabsNow())
  electronAPI.workspace.onFlushDrafts?.(async () => {
    let ok = true
    try {
      ok = await persistTabsNow() !== false
    } catch {
      ok = false
    }
    electronAPI.workspace.draftsFlushed(ok)
  })

  renderTabs()
}
