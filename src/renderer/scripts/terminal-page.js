import { electronAPI, showToast, setChatPaneMode } from './app.js'
import {
  initWsTabs, showSurface, trackTerminal, paintTerminalTab, currentProjectId
} from './ws-tabs.js'
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
 *
 * **側欄沒有終端機清單**（那裡只列專案）：狀態徽章、未讀點、改名與刪除
 * 全在 `ws-tabs.js` 的分頁上，這裡只把 main 的狀態推過去。
 */

const STATE_LABELS = {
  running: '運行中',
  idle: '已完成',
  exited: '已結束',
  stopped: '未啟動'
}

let initialized = false
let hostEl = null
let emptyEl = null
let errorEl = null
let dialogEl = null
let shellSelect = null
let presetSelect = null
let cwdInput = null
let adminInput = null

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

/** @type {ResizeObserver | null} */
let resizeObserver = null

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

// ===== 分頁上的狀態 =====

/**
 * 狀態徽章的文字。分頁上只有一顆點，滑過去才看得到這一行。
 * @param {{ state: string, exitCode?: number }} item
 * @returns {string}
 */
function stateLabel(item) {
  const base = STATE_LABELS[item.state] || item.state
  if (item.state === 'idle' && Number.isFinite(item.exitCode) && item.exitCode !== 0) {
    return `${base} · 離開碼 ${item.exitCode}`
  }
  return base
}

/**
 * 把一個工作階段現在的樣子推給分頁列。找不到（清單還沒同步）就不動。
 * @param {string} id
 */
function pushTabState(id) {
  const item = items.find((entry) => entry.id === id)
  if (!item) return
  paintTerminalTab(id, {
    title: item.title,
    state: item.state,
    stateLabel: stateLabel(item),
    admin: Boolean(item.admin),
    cwd: item.cwd || '',
    unread: unread.has(id)
  })
}

/** 全部推一次（清單重讀之後） */
function pushAllTabStates() {
  for (const item of items) pushTabState(item.id)
}

/**
 * 分頁的右鍵選單按「重新命名」時走這裡。
 * @param {string} id
 * @param {string} title
 */
export async function renameTerminalSession(id, title) {
  const next = String(title || '').trim()
  const item = items.find((entry) => entry.id === id)
  if (!next || !item || next === item.title) return
  await call(electronAPI.terminal.rename(id, next), '改名失敗')
  await reloadList()
}

/**
 * 關掉終端機分頁＝真的把工作階段刪掉（側欄已經沒有清單接住它了）。
 * 二次確認與分頁本身的移除都在 `ws-tabs.js` 的 `closeTab`。
 * @param {string} id
 */
export async function deleteTerminalSession(id) {
  await call(electronAPI.terminal.delete(id), '刪除失敗')
  disposePane(id)
  unread.delete(id)
  if (currentId === id) currentId = ''
  await reloadList()
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
  // 一般終端機的習慣：選起來就進剪貼簿、右鍵就貼上
  pane.addEventListener('mouseup', (event) => {
    if (event.button !== 0) return
    const selection = term.getSelection()
    if (selection) void navigator.clipboard.writeText(selection).catch(() => {})
  })
  pane.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    navigator.clipboard.readText().then((text) => { if (text) term.paste(text) }, () => {})
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
 * 顯示終端機那一格。**實際的切換交給 `ws-tabs.js`**——工作區主區現在還裝著
 * 編輯器與瀏覽器，各自 toggle 自己的 hidden 會互相疊在一起。
 * @param {boolean} on
 */
function showHost(on) {
  showSurface(on ? 'terminal' : 'empty')
}

/**
 * 點側欄某一列：沒開過就開一顆 pty，開過就把畫面切回來。
 * @param {string} id
 */
async function openSession(id) {
  // 聊天與工作區同頁：點終端機就是切到工作區主區（同步切 DOM，xterm 才量得到尺寸）
  setChatPaneMode('workspace')
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
  // 分頁列要有這一格（還原專案分頁時也走這裡）
  trackTerminal(id, items.find((item) => item.id === id)?.title || '終端機')
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

/**
 * 「自訂…」：分頁列的「＋」選單裡唯一還要選 shell 與工作目錄的入口。
 * @param {string} [cwd] 預設工作目錄（工作區傳專案路徑進來）
 */
export function openNewTerminalDialog(cwd = '') {
  initTerminalPage()
  if (items.length >= catalog.maxSessions) {
    showToast(`最多 ${catalog.maxSessions} 個終端機，請先刪掉一些`, 'error')
    return
  }
  fillCatalogSelects()
  if (adminInput) adminInput.checked = false
  if (cwd && cwdInput) cwdInput.value = cwd
  dialogEl.showModal()
}

async function createSession() {
  try {
    const created = await call(electronAPI.terminal.create({
      shell: shellSelect.value,
      preset: presetSelect.value,
      cwd: cwdInput.value,
      // 工作階段跟著專案走（缺值＝未分類）
      projectId: currentProjectId(),
      admin: Boolean(adminInput?.checked)
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
  pushAllTabStates()
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
  // 「不在看」包含兩種：看的是別的工作階段，或終端機主區沒開著
  // （聊天跟終端機同頁：主區顯示對話時＝人不在終端機）。
  // 主區顯示的是對話時 `termMain` 被藏起來（`termHost` 自己不會變），少這一條的話
  // 人在對話裡，背景終端機跑完永遠不亮未讀點。
  const watching = payload.id === currentId
    && document.getElementById('page-chat')?.classList.contains('active')
    && !document.getElementById('termMain')?.classList.contains('hidden')
    && !hostEl?.classList.contains('hidden')
  if (wasRunning && payload.state !== 'running' && !watching) unread.add(payload.id)
  // 指令跑完了（多半是 agent 收工）→ 讓工作區重讀一次 Git 狀態。
  // 用事件不用 import：terminal-page 不該知道右側欄長什麼樣子。
  if (wasRunning && payload.state !== 'running') {
    document.dispatchEvent(new CustomEvent('ws:terminal-idle', { detail: { id: payload.id } }))
  }
  pushTabState(payload.id)
}

export function initTerminalPage() {
  if (initialized) return
  initialized = true
  initWsTabs()

  hostEl = document.getElementById('termHost')
  emptyEl = document.getElementById('termEmpty')
  errorEl = document.getElementById('termError')
  dialogEl = document.getElementById('termNewDialog')
  shellSelect = document.getElementById('termShellSelect')
  presetSelect = document.getElementById('termPresetSelect')
  cwdInput = document.getElementById('termCwdInput')
  adminInput = /** @type {HTMLInputElement | null} */ (document.getElementById('termAdminInput'))

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

/**
 * 開一個新工作階段並送出一行指令。
 *
 * 給 Claude Code 頁的「更新 CLI」用：整個 npm 安裝過程使用者看得到，出錯也自己看得懂，
 * 比 App 偷偷在背景裝全域套件好。指令字串由 main 的固定表組出來（`ccswitch:updateCommand`），
 * 這裡只負責轉交。
 *
 * @param {string} title 側欄顯示的名稱
 * @param {string} command 送出的那一行（不含換行）
 * @returns {Promise<string>} 新工作階段的 id
 */
export async function runInNewTerminal(title, command) {
  initTerminalPage()
  const created = await call(electronAPI.terminal.create({
    shell: shellSelect?.value || '',
    preset: 'shell',
    cwd: cwdInput?.value || '',
    projectId: currentProjectId(),
    title
  }), '建立終端機失敗')
  await reloadList()
  await openSession(created.id)
  await electronAPI.terminal.write(created.id, `${command}\r`)
  return created.id
}

/**
 * 給 `ws-tabs.js` 用：切到（或開啟）某個工作階段。
 * @param {string} id
 */
export async function openTerminalSession(id) {
  initTerminalPage()
  await openSession(id)
}

/**
 * 關掉一個終端機**分頁**：只收掉畫面那一格，工作階段本身還在側欄裡活著
 * （下次點側欄會重新掛上，scrollback 由 main 那邊留著）。
 * @param {string} id
 */
export function detachTerminalPane(id) {
  disposePane(id)
  if (currentId === id) currentId = ''
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
