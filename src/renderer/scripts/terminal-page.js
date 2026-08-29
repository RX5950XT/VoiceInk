import { electronAPI, showToast } from './app.js'
import { createListReorder } from './list-reorder.js'
// renderer 沒有 bundler，但 xterm 有現成的 ESM 產物，相對路徑直接載就好：
// vendoring 只會多一份得跟著升級的複本（markdown.js 那條慣例同理）。
import { Terminal } from '../../../node_modules/@xterm/xterm/lib/xterm.mjs'
import { FitAddon } from '../../../node_modules/@xterm/addon-fit/lib/addon-fit.mjs'

/**
 * 終端機頁。
 *
 * 真相全在 main：shell 執行檔、啟動指令與工作目錄的驗證、忙碌判定、scrollback 都在
 * `src/main/terminal/`。這裡只負責畫面——把按鍵送過去、把回來的位元組寫進 xterm。
 *
 * 每個工作階段留一份自己的 Terminal 實例（切分頁只換顯示，畫面不重畫），
 * 實例活著的期間 main 送來的資料照收，所以切走再切回來不會漏字。
 */

/** 刪除鈕的二次確認逾時（與聊天側欄一致） */
const DELETE_ARM_MS = 3000

const STATE_LABELS = {
  running: '運行中',
  idle: '已完成',
  exited: '已結束',
  stopped: '未啟動'
}

let initialized = false
let listEl = null
let hostEl = null
let emptyEl = null
let errorEl = null
let newBtn = null
let dialogEl = null
let shellSelect = null
let presetSelect = null
let cwdInput = null

/** @type {Array<{ id: string, title: string, shell: string, preset: string, cwd: string, state: string, exitCode: number | null }>} */
let items = []
let currentId = ''
let catalog = { shells: [], presets: [], maxSessions: 20 }

/**
 * @typedef {{
 *   term: Terminal, fit: FitAddon, pane: HTMLElement,
 *   seq: number, ready: boolean, writing: boolean, queue: Array<{ seq: number, data: string }>
 * }} Pane
 */
/** @type {Map<string, Pane>} */
const panes = new Map()

/** 跑完但使用者不在看的階段 */
const unread = new Set()

/** @type {HTMLButtonElement | null} */
let armedDeleteBtn = null
/** @type {ResizeObserver | null} */
let resizeObserver = null

// ===== 圖示（與聊天側欄同一套線條，不用 emoji）=====
const SVG_NS = 'http://www.w3.org/2000/svg'
const ICON_PENCIL = ['M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3Z', 'M14.5 6.5l3 3']
const ICON_TRASH = ['M5 7h14', 'M10 5h4', 'M7 7l1 12h8l1-12', 'M10.5 10.5v6', 'M13.5 10.5v6']
const ICON_CHECK = ['M5 12.5l4.5 4.5L19 7.5']

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
    onClick()
  })
  return btn
}

/**
 * main 的回覆一律是 { ok, data } / { ok, error }。
 * @param {Promise<{ ok: boolean, data?: any, error?: { message: string } }>} promise
 * @param {string} fallbackMessage
 * @returns {Promise<any>}
 */
async function call(promise, fallbackMessage) {
  const result = await promise
  if (result && result.ok) {
    showError('')
    return result.data
  }
  const message = result?.error?.message || fallbackMessage
  showError(message)
  throw new Error(message)
}

/**
 * @param {string} message
 */
function showError(message) {
  if (!errorEl) return
  errorEl.textContent = message
  errorEl.classList.toggle('hidden', !message)
}

// ===== 側欄 =====

function renderList() {
  if (!listEl) return
  // 重畫會把待確認的刪除鈕整顆換掉，計時器得先收乾淨
  disarmDelete()
  listEl.replaceChildren()
  if (!items.length) {
    const empty = document.createElement('p')
    empty.className = 'prompt-list-empty'
    empty.textContent = '還沒有終端機'
    listEl.appendChild(empty)
    return
  }
  for (const item of items) listEl.appendChild(buildListItem(item))
}

/**
 * @param {object} item
 * @returns {HTMLElement}
 */
function buildListItem(item) {
  const el = document.createElement('div')
  el.className = item.id === currentId ? 'chat-list-item term-list-item active' : 'chat-list-item term-list-item'
  el.dataset.id = item.id
  el.tabIndex = 0

  const open = document.createElement('button')
  open.type = 'button'
  open.className = 'chat-list-open'

  const titleRow = document.createElement('span')
  titleRow.className = 'term-title-row'
  const title = document.createElement('span')
  title.className = 'chat-list-title'
  title.textContent = item.title
  titleRow.appendChild(title)
  if (unread.has(item.id)) {
    const dot = document.createElement('span')
    dot.className = 'term-unread'
    dot.title = '跑完了，還沒看過'
    dot.setAttribute('aria-label', '有新輸出')
    titleRow.appendChild(dot)
  }

  const meta = document.createElement('span')
  meta.className = 'chat-list-meta term-meta'
  const badge = document.createElement('span')
  badge.className = `term-state term-state-${item.state}`
  badge.textContent = STATE_LABELS[item.state] || item.state
  if (item.state === 'idle' && Number.isFinite(item.exitCode) && item.exitCode !== 0) {
    badge.textContent = `${STATE_LABELS.idle} · 離開碼 ${item.exitCode}`
    badge.classList.add('term-state-bad')
  }
  const cwd = document.createElement('span')
  cwd.className = 'term-cwd'
  cwd.textContent = shortenPath(item.cwd)
  cwd.title = item.cwd
  meta.append(badge, cwd)

  open.append(titleRow, meta)
  open.addEventListener('click', () => void openSession(item.id))

  const actions = document.createElement('span')
  actions.className = 'chat-list-actions'
  const trash = listActionButton(ICON_TRASH, '刪除終端機', () => armDelete(trash, item))
  actions.append(listActionButton(ICON_PENCIL, '重新命名', () => startRename(el, item)), trash)

  el.append(open, actions)
  el.addEventListener('pointerdown', reorder.onPointerDown)
  el.addEventListener('keydown', reorder.onKeydown)
  return el
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
 * @param {HTMLElement} el
 * @param {{ id: string, title: string }} item
 */
function startRename(el, item) {
  const title = el.querySelector('.chat-list-title')
  if (!title || el.querySelector('.chat-list-rename')) return
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'chat-list-rename'
  input.value = item.title
  input.maxLength = 60
  input.setAttribute('aria-label', '終端機名稱')
  let done = false
  const finish = async (commit) => {
    if (done) return
    done = true
    const next = input.value.trim()
    if (commit && next && next !== item.title) {
      await call(electronAPI.terminal.rename(item.id, next), '改名失敗')
      await reloadList()
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
 * 刪除的二次確認：按鈕就地變紅勾，再按一次才真的刪，逾時自動復原。
 * 不用 `window.confirm`——原生彈窗會擋住整個 App，樣式也跟 Aurora 不搭。
 * @param {HTMLButtonElement} btn
 * @param {{ id: string, title: string }} item
 */
function armDelete(btn, item) {
  if (btn.dataset.armed === '1') {
    clearTimeout(Number(btn.dataset.timer))
    void deleteSession(item)
    return
  }
  disarmDelete()
  btn.dataset.armed = '1'
  btn.classList.add('is-armed')
  btn.title = '再按一次確認刪除'
  btn.setAttribute('aria-label', `再按一次確認刪除「${item.title}」`)
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
  btn.title = '刪除終端機'
  btn.setAttribute('aria-label', '刪除終端機')
  setIconPaths(btn, ICON_TRASH)
}

/**
 * @param {{ id: string }} item
 */
async function deleteSession(item) {
  disarmDelete()
  await call(electronAPI.terminal.delete(item.id), '刪除失敗')
  disposePane(item.id)
  unread.delete(item.id)
  if (currentId === item.id) currentId = ''
  await reloadList()
  if (!currentId) showHost(false)
}

/**
 * 拖曳／Alt+↑↓ 排序。實作與聊天側欄共用（`list-reorder.js`）——DOM 結構與 class 都一樣，
 * 差別只在存哪一份順序。
 */
const reorder = createListReorder({
  getList: () => listEl,
  itemSelector: '.term-list-item',
  ignoreSelector: '.chat-list-btn, .chat-list-rename',
  onCommit: () => void persistOrder()
})

/** DOM 上的順序才是真相（剛拖完還沒重畫），記憶體的 items 跟著它排 */
async function persistOrder() {
  const ids = [...listEl.querySelectorAll('.term-list-item')].map((el) => el.dataset.id)
  items = ids.map((id) => items.find((item) => item.id === id)).filter(Boolean)
  try {
    await call(electronAPI.terminal.reorder(ids), '排序儲存失敗')
  } catch {
    // 訊息已顯示；畫面順序先留著，下次 reloadList 會以 main 為準
  }
}

// ===== 終端機本體 =====

/**
 * xterm 的配色從主題 token 拿，切主題時整批重上。
 * @returns {object}
 */
function themeColors() {
  const css = getComputedStyle(document.documentElement)
  const pick = (name, fallback) => (css.getPropertyValue(name).trim() || fallback)
  return {
    background: pick('--term-bg', '#0d1012'),
    foreground: pick('--term-fg', '#f4f1e8'),
    cursor: pick('--accent-primary', '#78a3b5'),
    selectionBackground: pick('--term-selection', 'rgba(120, 163, 181, 0.35)')
  }
}

/**
 * @param {string} id
 * @returns {Pane}
 */
function createPane(id) {
  const pane = document.createElement('div')
  pane.className = 'term-pane'
  pane.dataset.id = id
  hostEl.appendChild(pane)
  // `term.open()` 要量得到尺寸才畫得出東西。掛在 display:none 的格子上會開出一個
  // 0×0 的終端機，第一段輸出（提示字元）就這樣消失了——所以先切成可見再 open。
  for (const other of panes.values()) other.pane.classList.remove('is-active')
  pane.classList.add('is-active')

  const term = new Terminal({
    allowProposedApi: true,
    convertEol: false,
    cursorBlink: true,
    fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "微軟正黑體", monospace',
    fontSize: 13,
    scrollback: 5000,
    theme: themeColors()
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(pane)
  term.onData((data) => {
    void electronAPI.terminal.write(id, data)
  })

  /** @type {Pane} */
  const entry = { term, fit, pane, seq: 0, ready: false, writing: false, queue: [] }
  panes.set(id, entry)
  return entry
}

/**
 * @param {string} id
 */
function disposePane(id) {
  const entry = panes.get(id)
  if (!entry) return
  panes.delete(id)
  entry.term.dispose()
  entry.pane.remove()
}

/**
 * @param {boolean} on
 */
function showHost(on) {
  hostEl?.classList.toggle('hidden', !on)
  emptyEl?.classList.toggle('hidden', on)
}

/**
 * 點側欄某一列：沒開過就開一顆 pty，開過就把畫面切回來。
 * @param {string} id
 */
async function openSession(id) {
  currentId = id
  unread.delete(id)
  showHost(true)

  let entry = panes.get(id)
  const fresh = !entry
  // createPane 自己會把新格子切成可見（open 前必須量得到尺寸）
  if (!entry) entry = createPane(id)
  else for (const [key, pane] of panes) pane.pane.classList.toggle('is-active', key === id)
  fitPane(entry)

  if (fresh) {
    try {
      const snapshot = await call(
        electronAPI.terminal.open(id, entry.term.cols, entry.term.rows),
        '開啟終端機失敗'
      )
      // 掛上之後、快照回來之前收到的片段先排隊，免得順序顛倒；
      // 快照本身已含 seq 以前的內容，重疊的要丟掉。
      if (snapshot.buffer) await writeOutput(entry, snapshot.buffer)
      entry.seq = snapshot.seq
      entry.ready = true
      await drainOutput(entry)
    } catch {
      disposePane(id)
      currentId = ''
      showHost(false)
      await reloadList()
      return
    }
  }

  entry.term.focus()
  await reloadList()
}

/**
 * @param {Pane} entry
 */
function fitPane(entry) {
  try {
    entry.fit.fit()
  } catch {
    // 分頁還沒顯示、量不到尺寸；下次切過來會再 fit 一次
  }
}

function fitCurrent() {
  const entry = panes.get(currentId)
  if (!entry || !hostEl || hostEl.classList.contains('hidden')) return
  fitPane(entry)
  void electronAPI.terminal.resize(currentId, entry.term.cols, entry.term.rows)
}

// ===== 新終端機 =====

function fillCatalogSelects() {
  shellSelect.replaceChildren()
  for (const shell of catalog.shells) {
    const option = document.createElement('option')
    option.value = shell.key
    option.textContent = shell.available ? shell.label : `${shell.label}（未安裝）`
    option.disabled = !shell.available
    shellSelect.appendChild(option)
  }
  const firstAvailable = catalog.shells.find((s) => s.available)
  if (firstAvailable) shellSelect.value = firstAvailable.key

  presetSelect.replaceChildren()
  for (const preset of catalog.presets) {
    const option = document.createElement('option')
    option.value = preset.key
    option.textContent = preset.label
    presetSelect.appendChild(option)
  }
}

function openNewDialog() {
  if (items.length >= catalog.maxSessions) {
    showToast(`最多 ${catalog.maxSessions} 個終端機，請先刪掉一些`, 'error')
    return
  }
  fillCatalogSelects()
  dialogEl.showModal()
}

async function createSession() {
  try {
    const created = await call(electronAPI.terminal.create({
      shell: shellSelect.value,
      preset: presetSelect.value,
      cwd: cwdInput.value
    }), '建立終端機失敗')
    dialogEl.close()
    await reloadList()
    await openSession(created.id)
  } catch {
    // call() 已經把訊息顯示出來了
  }
}

// ===== 生命週期 =====

async function reloadList() {
  const next = await call(electronAPI.terminal.list(), '讀取終端機清單失敗')
  items = Array.isArray(next) ? next : []
  renderList()
}

/**
 * 背景視窗的 xterm 會把第一個 `write` 的 timer 節流到很晚，畫面就會一直空白。
 * 只有背景時走它現成的同步 parser；可見時仍保留 xterm 原本的非同步批次處理。
 * @param {Pane} entry
 * @param {string} data
 * @returns {Promise<void>}
 */
function writeOutput(entry, data) {
  if (document.hidden && typeof entry.term._core?._writeBuffer?.writeSync === 'function') {
    entry.term._core._writeBuffer.writeSync(data)
    return Promise.resolve()
  }
  return new Promise((resolve) => entry.term.write(data, resolve))
}

/**
 * 每段輸出都等 xterm 解析完才推進 seq，快照和即時事件就不會互相略過。
 * @param {Pane} entry
 * @returns {Promise<void>}
 */
async function drainOutput(entry) {
  if (!entry.ready || entry.writing) return
  entry.writing = true
  try {
    while (entry.queue.length) {
      const payload = entry.queue.shift()
      if (!payload || payload.seq <= entry.seq) continue
      await writeOutput(entry, payload.data)
      entry.seq = payload.seq
    }
  } finally {
    entry.writing = false
  }
}

/**
 * @param {{ id: string, seq: number, data: string }} payload
 */
function onData(payload) {
  const entry = panes.get(payload.id)
  if (!entry) return
  entry.queue.push(payload)
  void drainOutput(entry)
}

/**
 * @param {{ id: string, state: string, exitCode: number | null }} payload
 */
function onStatus(payload) {
  const item = items.find((entry) => entry.id === payload.id)
  // 清單還沒同步到這個階段（例如剛建立）：補讀一次，否則它的狀態永遠不會出現
  if (!item) {
    void reloadList().catch(() => {})
    return
  }
  const wasRunning = item.state === 'running'
  item.state = payload.state === 'exited' && !panes.has(payload.id) ? 'stopped' : payload.state
  item.exitCode = payload.exitCode
  // 跑完的當下不在看它 → 亮未讀點（這是「哪個代理做完了」的提示）。
  // 「不在看」包含兩種：看的是別的工作階段，或人根本在別的分頁。
  const watching = payload.id === currentId
    && document.getElementById('page-terminal')?.classList.contains('active')
  if (wasRunning && payload.state !== 'running' && !watching) unread.add(payload.id)
  renderList()
}

export function initTerminalPage() {
  if (initialized) return
  initialized = true

  listEl = document.getElementById('termList')
  hostEl = document.getElementById('termHost')
  emptyEl = document.getElementById('termEmpty')
  errorEl = document.getElementById('termError')
  newBtn = document.getElementById('termNewBtn')
  dialogEl = document.getElementById('termNewDialog')
  shellSelect = document.getElementById('termShellSelect')
  presetSelect = document.getElementById('termPresetSelect')
  cwdInput = document.getElementById('termCwdInput')

  newBtn?.addEventListener('click', openNewDialog)
  document.getElementById('termNewCancelBtn')?.addEventListener('click', () => dialogEl.close())
  document.getElementById('termNewCreateBtn')?.addEventListener('click', () => void createSession())
  document.getElementById('termCwdBtn')?.addEventListener('click', async () => {
    const picked = await call(electronAPI.terminal.pickDirectory(), '選擇資料夾失敗')
    if (picked) cwdInput.value = picked
  })

  electronAPI.terminal.onData(onData)
  electronAPI.terminal.onStatus(onStatus)

  // 視窗或側欄寬度變了就重新量欄列數；xterm 不會自己跟著容器縮放
  resizeObserver = new ResizeObserver(() => fitCurrent())
  if (hostEl) resizeObserver.observe(hostEl)

  void (async () => {
    try {
      catalog = await call(electronAPI.terminal.catalog(), '讀取設定失敗')
      cwdInput.value = catalog.homeDir || ''
      await reloadList()
    } catch {
      // 訊息已顯示
    }
  })()
}

export function refreshTerminalPage() {
  initTerminalPage()
  // 主題可能在別頁被切過
  const colors = themeColors()
  for (const entry of panes.values()) entry.term.options.theme = colors
  // 回到這一頁＝看到了目前這個階段，未讀點該清掉
  if (currentId) unread.delete(currentId)
  void reloadList()
  // 分頁剛顯示，這一幀才量得到尺寸
  requestAnimationFrame(() => fitCurrent())
}
