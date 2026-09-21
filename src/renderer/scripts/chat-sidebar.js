/**
 * 聊天側欄：資料夾分組、每個對話的回應狀態、改名／刪除／搬移／匯出、拖曳排序。
 *
 * 版面：資料夾（依建立順序）在上、未分類的對話在下。對話在陣列裡的順序＝同一組內的顯示順序。
 * 拖一列到別的資料夾（或它的標題上）＝搬過去；main 那邊一次寫入順序與歸屬。
 */

import { electronAPI, showToast, cleanIpcError } from './app.js'
import { mergeVisibleOrder } from './usage-reorder.js'
import { createListReorder } from './list-reorder.js'
import { askConfirm, askInput } from './app-dialog.js'
import { openChatMenu } from './chat-menu.js'

/** 刪除鈕按下後等待二次確認的時間，逾時自動復原 */
const DELETE_ARM_MS = 3000

/** 側欄圖示：跟 composer 的按鈕同一套線條風格，不用 emoji（Segoe 下的 🗑 會縮成一條細線） */
const ICON_PENCIL = ['M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3Z', 'M14.5 6.5l3 3']
const ICON_TRASH = ['M5 7h14', 'M10 5h4', 'M7 7l1 12h8l1-12', 'M10.5 10.5v6', 'M13.5 10.5v6']
const ICON_CHECK = ['M5 12.5l4.5 4.5L19 7.5']
const ICON_MORE = ['M6 12h.01', 'M12 12h.01', 'M18 12h.01']
const ICON_CHEVRON = ['M9 6l6 6-6 6']
const SVG_NS = 'http://www.w3.org/2000/svg'

const STATUS_TEXT = Object.freeze({ running: '回應中', done: '已完成', error: '失敗' })

/**
 * @typedef {{ id: string, title: string, updatedAt: number, folderId: string, messageCount: number, streaming?: boolean }} ConvSummary
 * @typedef {{ id: string, name: string, collapsed: boolean }} Folder
 * @typedef {'running'|'done'|'error'|''} Status
 */

/**
 * @param {{
 *   listEl: HTMLElement,
 *   searchInput: HTMLInputElement | null,
 *   getCurrentId: () => string,
 *   statusOf: (id: string, conv?: ConvSummary) => Status,
 *   onOpen: (id: string) => void,
 *   onNew: (folderId: string) => void,
 *   onDeleted: (id: string) => Promise<void>
 * }} deps
 */
export function createChatSidebar(deps) {
  const { listEl, searchInput } = deps
  /** @type {ConvSummary[]} */
  let conversations = []
  /** @type {Folder[]} */
  let folders = []
  let searchTerm = ''
  /** 改名輸入框開著時不重畫（會把輸入框換掉），等它結束再補 */
  let renderPending = false
  /** @type {HTMLButtonElement | null} */
  let armedDeleteBtn = null

  const reorder = createListReorder({
    getList: () => listEl,
    itemSelector: '.chat-list-item',
    ignoreSelector: '.chat-list-btn, .chat-list-rename',
    onCommit: () => void persistOrder(),
    dropZone: (x, y) => {
      const head = document.elementFromPoint(x, y)?.closest?.('.chat-folder-head, .chat-root-head')
      return head && listEl.contains(head) ? /** @type {HTMLElement} */ (head.nextElementSibling) : null
    }
  })

  // 資料夾整組拖曳：抓的是標題列，裡面的對話列另有自己的排序，所以 body 要排除
  const folderReorder = createListReorder({
    getList: () => listEl,
    itemSelector: '.chat-folder',
    ignoreSelector: '.chat-list-btn, .chat-list-rename, .chat-folder-body',
    onCommit: () => void persistFolderOrder()
  })
  /** 拖曳放開時瀏覽器還會補一個 click，別讓它順手把資料夾收起來 */
  let justDraggedFolder = false

  searchInput?.addEventListener('input', () => {
    searchTerm = (searchInput.value || '').trim().toLowerCase()
    render()
  })

  async function reload() {
    try {
      const [list, folderList] = await Promise.all([electronAPI.chat.list(), electronAPI.chat.folders()])
      conversations = Array.isArray(list) ? list : []
      folders = Array.isArray(folderList) ? folderList : []
    } catch (e) {
      conversations = []
      showToast(cleanIpcError(e), 'error')
    }
    render()
  }

  function render() {
    if (listEl.querySelector('.chat-list-rename')) {
      renderPending = true
      return
    }
    renderPending = false
    // 重畫會把待確認的刪除鈕整顆換掉，計時器得先收乾淨
    disarmDelete()
    const visible = searchTerm
      ? conversations.filter((c) => c.title.toLowerCase().includes(searchTerm))
      : conversations
    const nodes = []
    for (const folder of folders) {
      const inside = visible.filter((c) => c.folderId === folder.id)
      if (searchTerm && !inside.length) continue
      nodes.push(buildFolder(folder, inside))
    }
    const root = visible.filter((c) => !c.folderId)
    if (folders.length || root.length) nodes.push(buildRoot(root))
    if (!visible.length && !folders.length) {
      const empty = document.createElement('p')
      empty.className = 'prompt-list-empty'
      empty.textContent = searchTerm ? '沒有符合的對話' : '還沒有對話'
      nodes.push(empty)
    }
    listEl.replaceChildren(...nodes)
  }

  /**
   * @param {Folder} folder
   * @param {ConvSummary[]} inside
   */
  function buildFolder(folder, inside) {
    const expanded = !folder.collapsed || !!searchTerm
    const wrap = document.createElement('div')
    wrap.className = expanded ? 'chat-folder' : 'chat-folder is-collapsed'
    wrap.dataset.folderId = folder.id
    // list-reorder 認 `data-id`
    wrap.dataset.id = folder.id
    wrap.addEventListener('pointerdown', folderReorder.onPointerDown)
    wrap.addEventListener('keydown', (event) => {
      // 裡面對話列的 Alt+↑↓ 會冒泡上來，那是在排對話不是排資料夾
      if (!/** @type {HTMLElement} */ (event.target).closest('.chat-folder-body')) folderReorder.onKeydown(event)
    })

    const head = document.createElement('div')
    head.className = 'chat-folder-head'
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'chat-folder-toggle'
    toggle.setAttribute('aria-expanded', String(expanded))
    const chevron = document.createElement('span')
    chevron.className = 'chat-folder-chevron'
    setIconPaths(chevron, ICON_CHEVRON)
    const name = document.createElement('span')
    name.className = 'chat-folder-name'
    name.textContent = folder.name
    const count = document.createElement('span')
    count.className = 'chat-folder-count'
    count.textContent = String(inside.length)
    toggle.append(chevron, name, count)
    // 收起來時看不到裡面的列，至少把「裡面有東西在跑／跑完了」掛在標題上
    const summary = folderStatus(inside)
    if (!expanded && summary) toggle.appendChild(statusDot(summary))
    toggle.addEventListener('click', () => {
      if (!justDraggedFolder) void setCollapsed(folder, expanded)
    })

    const more = listActionButton(ICON_MORE, '資料夾選項', () => openFolderMenu(more, folder, name))
    more.classList.add('is-persistent')
    more.setAttribute('aria-haspopup', 'menu')
    head.append(toggle, more)

    const body = document.createElement('div')
    body.className = 'chat-folder-body'
    body.hidden = !expanded
    if (expanded) for (const conv of inside) body.appendChild(buildListItem(conv))
    wrap.append(head, body)
    return wrap
  }

  /** @param {ConvSummary[]} root */
  function buildRoot(root) {
    const wrap = document.createElement('div')
    wrap.className = 'chat-root'
    if (folders.length) {
      // 有資料夾時才出現：它同時是「拖到這裡＝移出資料夾」的落點
      const head = document.createElement('div')
      head.className = 'chat-root-head'
      head.textContent = '未分類'
      wrap.appendChild(head)
    }
    const body = document.createElement('div')
    body.className = 'chat-root-body'
    for (const conv of root) body.appendChild(buildListItem(conv))
    wrap.appendChild(body)
    return wrap
  }

  /**
   * @param {ConvSummary[]} inside
   * @returns {Status}
   */
  function folderStatus(inside) {
    const states = inside.map((c) => deps.statusOf(c.id, c))
    return states.includes('running') ? 'running' : states.includes('error') ? 'error' : states.includes('done') ? 'done' : ''
  }

  /**
   * 側欄的一列：開啟鈕 ＋ 改名／刪除／更多，整列可拖曳排序
   * @param {ConvSummary} conv
   */
  function buildListItem(conv) {
    const item = document.createElement('div')
    item.className = conv.id === deps.getCurrentId() ? 'chat-list-item active' : 'chat-list-item'
    item.dataset.id = conv.id

    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'chat-list-open'
    const title = document.createElement('span')
    title.className = 'chat-list-title'
    title.textContent = conv.title
    const meta = document.createElement('span')
    meta.className = 'chat-list-meta'
    fillMeta(meta, conv)
    open.append(title, meta)
    open.addEventListener('click', () => deps.onOpen(conv.id))

    const actions = document.createElement('span')
    actions.className = 'chat-list-actions'
    const rename = listActionButton(ICON_PENCIL, '重新命名', () => {
      startRename(title, conv.title, 60, async (next) => {
        await electronAPI.chat.rename(conv.id, next)
        await reload()
      })
    })
    rename.dataset.action = 'rename'
    const trash = listActionButton(ICON_TRASH, '刪除對話', () => armDelete(trash, conv))
    trash.dataset.action = 'delete'
    const more = listActionButton(ICON_MORE, '更多', () => openConversationMenu(more, conv))
    more.dataset.action = 'more'
    more.setAttribute('aria-haspopup', 'menu')
    actions.append(rename, trash, more)

    item.append(open, actions)
    item.addEventListener('pointerdown', reorder.onPointerDown)
    item.addEventListener('keydown', reorder.onKeydown)
    return item
  }

  /**
   * @param {HTMLElement} meta
   * @param {ConvSummary} conv
   */
  function fillMeta(meta, conv) {
    const state = deps.statusOf(conv.id, conv)
    meta.replaceChildren()
    if (state) {
      const badge = statusDot(state)
      badge.append(document.createTextNode(STATUS_TEXT[state]))
      meta.append(badge, document.createTextNode(' · '))
    }
    meta.append(document.createTextNode(`${conv.messageCount} 則`))
  }

  /**
   * @param {Exclude<Status, ''>} state
   * @returns {HTMLElement}
   */
  function statusDot(state) {
    const badge = document.createElement('span')
    badge.className = 'chat-status'
    badge.dataset.state = state
    badge.title = STATUS_TEXT[state]
    return badge
  }

  /**
   * 狀態變動只就地改那一列（整份重畫會把改名輸入框與待確認的刪除鈕換掉）
   * @param {string} id
   */
  function paintStatus(id) {
    const conv = conversations.find((c) => c.id === id)
    const meta = listEl.querySelector(`.chat-list-item[data-id="${CSS.escape(id)}"] .chat-list-meta`)
    if (conv && meta) fillMeta(/** @type {HTMLElement} */ (meta), conv)
    else if (conv?.folderId) render()
  }

  // ===== 選單 =====

  /**
   * @param {HTMLElement} anchor
   * @param {ConvSummary} conv
   */
  function openConversationMenu(anchor, conv) {
    openChatMenu(anchor, [
      { label: '匯出 Markdown…', onSelect: () => void exportConversation(conv) },
      { separator: true },
      { label: '未分類', checked: !conv.folderId, onSelect: () => void moveTo(conv, '') },
      ...folders.map((f) => ({ label: f.name, checked: conv.folderId === f.id, onSelect: () => void moveTo(conv, f.id) })),
      { label: '＋ 新資料夾並移入…', onSelect: () => void createFolder(conv) }
    ])
  }

  /**
   * @param {HTMLElement} anchor
   * @param {Folder} folder
   * @param {HTMLElement} nameEl
   */
  function openFolderMenu(anchor, folder, nameEl) {
    openChatMenu(anchor, [
      { label: '在這裡新增對話', onSelect: () => deps.onNew(folder.id) },
      {
        label: '重新命名',
        onSelect: () => startRename(nameEl, folder.name, 40, async (next) => {
          await electronAPI.chat.updateFolder(folder.id, { name: next })
          await reload()
        })
      },
      { separator: true },
      { label: '刪除資料夾', danger: true, onSelect: () => void deleteFolder(folder) }
    ])
  }

  /**
   * @param {ConvSummary} conv
   * @param {string} folderId
   */
  async function moveTo(conv, folderId) {
    if (conv.folderId === folderId) return
    await electronAPI.chat.moveToFolder(conv.id, folderId)
    await reload()
  }

  /** @param {ConvSummary} [conv] 有給就順便把它搬進去 */
  async function createFolder(conv) {
    const name = await askInput('新資料夾', { placeholder: '資料夾名稱', confirmText: '建立' })
    if (name === null) return
    const folder = await electronAPI.chat.createFolder(name.trim())
    if (!folder) {
      showToast('資料夾數量已達上限', 'error')
      return
    }
    if (conv) await electronAPI.chat.moveToFolder(conv.id, folder.id)
    await reload()
  }

  /** @param {Folder} folder */
  async function deleteFolder(folder) {
    const yes = await askConfirm(`刪除資料夾「${folder.name}」？`, {
      desc: '裡面的對話不會刪除，會移回未分類。',
      confirmText: '刪除',
      danger: true
    })
    if (!yes) return
    await electronAPI.chat.deleteFolder(folder.id)
    await reload()
  }

  /**
   * @param {Folder} folder
   * @param {boolean} collapsed
   */
  async function setCollapsed(folder, collapsed) {
    if (searchTerm) return
    folders = folders.map((f) => (f.id === folder.id ? { ...f, collapsed } : f))
    render()
    await electronAPI.chat.updateFolder(folder.id, { collapsed })
  }

  /** @param {ConvSummary} conv */
  async function exportConversation(conv) {
    try {
      const result = await electronAPI.chat.export(conv.id)
      if (!result?.ok) showToast(result?.error || '匯出失敗', 'error')
      else if (result.saved) showToast('已匯出')
    } catch (e) {
      showToast(cleanIpcError(e), 'error')
    }
  }

  // ===== 改名／刪除 =====

  /**
   * 就地改名：文字換成輸入框，Enter／失焦送出，Esc 取消。
   * @param {HTMLElement} textEl
   * @param {string} current
   * @param {number} maxLength
   * @param {(next: string) => Promise<void>} commit
   */
  function startRename(textEl, current, maxLength, commit) {
    if (textEl.parentElement?.querySelector('.chat-list-rename')) return
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'chat-list-rename'
    input.value = current
    input.maxLength = maxLength
    input.setAttribute('aria-label', '名稱')
    let done = false
    const finish = async (save) => {
      if (done) return
      done = true
      const next = input.value.trim()
      input.replaceWith(textEl)
      if (save && next && next !== current) await commit(next)
      else if (renderPending) render()
    }
    input.addEventListener('keydown', (event) => {
      if (event.isComposing || event.keyCode === 229) return
      if (event.key === 'Enter') { event.preventDefault(); void finish(true) }
      else if (event.key === 'Escape') { event.preventDefault(); void finish(false) }
    })
    input.addEventListener('blur', () => void finish(true))
    // 輸入框裡的拖曳／點擊不該被當成排序、切換對話或收合資料夾
    input.addEventListener('pointerdown', (event) => event.stopPropagation())
    input.addEventListener('click', (event) => event.stopPropagation())
    textEl.replaceWith(input)
    input.focus()
    input.select()
  }

  /**
   * 刪除的二次確認：按鈕就地變成紅色的勾，再按一次才真的刪，逾時自動復原。
   * @param {HTMLButtonElement} btn
   * @param {ConvSummary} conv
   */
  function armDelete(btn, conv) {
    if (btn.dataset.armed === '1') {
      disarmDelete()
      void deleteConversation(conv)
      return
    }
    disarmDelete()
    btn.dataset.armed = '1'
    btn.classList.add('is-armed')
    btn.title = '再按一次確認刪除'
    btn.setAttribute('aria-label', `再按一次確認刪除「${conv.title}」`)
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
    btn.title = '刪除對話'
    btn.setAttribute('aria-label', '刪除對話')
    setIconPaths(btn, ICON_TRASH)
  }

  /** @param {ConvSummary} conv */
  async function deleteConversation(conv) {
    // 回應中的對話也可以刪：main 會先把那條串流停掉
    await electronAPI.chat.delete(conv.id)
    await deps.onDeleted(conv.id)
  }

  // ===== 排序 =====

  /**
   * 目前 DOM 上的順序與歸屬。被搜尋藏起來、或收在資料夾裡的列不在 DOM 上，
   * 維持原相對位置與原歸屬（`mergeVisibleOrder`）。
   */
  async function persistOrder() {
    const shown = [...listEl.querySelectorAll('.chat-list-item')]
    const folderOf = new Map(shown.map((el) => [
      el.dataset.id, /** @type {HTMLElement | null} */ (el.closest('.chat-folder'))?.dataset.folderId || ''
    ]))
    const ids = mergeVisibleOrder(conversations.map((c) => c.id), shown.map((el) => el.dataset.id))
    conversations = ids
      .map((id) => conversations.find((c) => c.id === id))
      .filter(Boolean)
      .map((c) => (folderOf.has(c.id) ? { ...c, folderId: folderOf.get(c.id) } : c))
    await electronAPI.chat.reorder(ids.map((id) => (folderOf.has(id) ? { id, folderId: folderOf.get(id) } : id)))
    render()
  }

  /**
   * 資料夾順序寫回 main。搜尋中被藏起來的資料夾維持原相對位置。
   */
  async function persistFolderOrder() {
    justDraggedFolder = true
    setTimeout(() => { justDraggedFolder = false }, 0)
    const shown = [...listEl.querySelectorAll('.chat-folder')].map((el) => /** @type {HTMLElement} */ (el).dataset.folderId)
    const ids = mergeVisibleOrder(folders.map((f) => f.id), shown)
    folders = ids.map((id) => folders.find((f) => f.id === id)).filter(Boolean)
    await electronAPI.chat.reorderFolders(ids)
    render()
  }

  return {
    reload,
    render,
    paintStatus,
    createFolder: () => createFolder(),
    list: () => conversations
  }
}

/**
 * @param {HTMLElement} el
 * @param {string[]} paths SVG path 的 d
 */
function setIconPaths(el, paths) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.appendChild(path)
  }
  el.querySelector('svg')?.remove()
  el.appendChild(svg)
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
    onClick()
  })
  return btn
}
