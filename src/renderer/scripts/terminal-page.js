import { electronAPI, showToast, setChatPaneMode } from './app.js'
import { terminalStatusLabel, setTerminalStatuses } from './ws-terminal-status.js'
import { registerTermLinks } from './term-links.js'
import { splitForPty } from './term-write-chunks.js'
import { applyAppearance, normalizeAppearance } from './term-themes.js'
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
  return terminalStatusLabel(item)
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
  setTerminalStatuses(items)
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

/** 目前的終端機外觀（配色 key／桌布檔名／桌布壓暗程度）與桌布的 data: URI */
let appearance = normalizeAppearance({})
let backgroundUri = ''

/**
 * 讀設定並把外觀套到所有已開的分頁上。設定頁改完會發 `voiceink:term-appearance`
 * 事件叫這支，切到終端機頁時也會再對一次（主題可能在別頁被切過）。
 *
 * 桌布的圖片本體不進 store：這裡拿到的是檔名，data: URI 要跟 main 要。
 */
export async function refreshTerminalAppearance() {
  const [theme, image, opacity] = await Promise.all([
    electronAPI.store.get('termTheme', 'black'),
    electronAPI.store.get('termBgImage', ''),
    electronAPI.store.get('termBgOpacity', 20)
  ])
  appearance = normalizeAppearance({ theme, image, opacity })
  backgroundUri = appearance.image
    ? String((await electronAPI.terminal.background(appearance.image))?.data || '')
    : ''
  paintAppearance()
}

/** 把目前的外觀刷到 `.term-host` 與每一個已開的 xterm 上 */
function paintAppearance() {
  const options = applyAppearance(hostEl, appearance, backgroundUri)
  for (const entry of panes.values()) {
    entry.term.options.allowTransparency = options.allowTransparency
    entry.term.options.theme = options.theme
  }
  return options
}

/**
 * 新開一個分頁時要塞給 xterm 的配色與透明度。
 * @returns {{ theme: object, allowTransparency: boolean }}
 */
function themeOptions() {
  return applyAppearance(hostEl, appearance, backgroundUri)
}

/**
 * 把 xterm 那份隱形的輸入框挪到游標所在的那一格。
 *
 * 中文（或任何輸入法）的候選字視窗是 OS 依「現在的輸入框在哪」畫出來的。
 * xterm 平常把那個 `<textarea>` 丟在畫面外（`left: -9999em`），只有游標移動時
 * 才順手挪回游標上——所以剛開分頁、剛切回終端機、還沒打出第一個字之前，
 * 系統看到的輸入框在畫面外，候選字視窗就被夾到螢幕角落去了。
 *
 * 聚焦與開始組字時各對一次位置就夠：組字中途 xterm 自己會跟著調（那時它會
 * 把寬度撐到組字文字的寬度，這裡不要插手）。
 *
 * @param {Terminal} term
 */
function syncImeCaret(term) {
  const area = term.textarea
  const screen = /** @type {HTMLElement | null} */ (term.element?.querySelector('.xterm-screen'))
  if (!area || !screen || !term.cols || !term.rows) return
  const cellW = screen.clientWidth / term.cols
  const cellH = screen.clientHeight / term.rows
  if (!cellW || !cellH) return
  const buffer = term.buffer.active
  const col = Math.min(buffer.cursorX, term.cols - 1)
  area.style.left = `${Math.round(col * cellW)}px`
  area.style.top = `${Math.round(buffer.cursorY * cellH)}px`
  area.style.width = `${Math.max(Math.round(cellW), 1)}px`
  area.style.height = `${Math.max(Math.round(cellH), 1)}px`
  area.style.lineHeight = `${Math.round(cellH)}px`
}

/** @type {Map<string, Promise<any>>} 每個工作階段一條寫入鏈 */
const writeChains = new Map()

/**
 * 把使用者打的（或貼的）東西送進 PTY，超過單次上限就切段（見 `term-write-chunks.js`）。
 *
 * 一定要排隊：`terminal.write` 是非同步的 IPC，直接連發第二段可能先到，
 * 貼上的內容就會前後顛倒。
 *
 * @param {string} id
 * @param {string} data
 */
function writeToPty(id, data) {
  if (!data) return
  // Ctrl+G（BEL）＝ Claude Code 要開外部編輯器（Windows 上是記事本）。
  // 那個視窗會開在 App 後面（見 main 的 `terminal/foreground.js`），先請 main 準備抬它。
  if (data.includes('\x07')) void electronAPI.terminal.raiseChildWindow?.()
  let chain = writeChains.get(id) || Promise.resolve()
  for (const piece of splitForPty(data)) {
    chain = chain.then(() => electronAPI.terminal.write(id, piece)).catch(() => {})
  }
  writeChains.set(id, chain)
}

/**
 * @param {string} id
 * @returns {Pane}
 */
function initTerminalDrop(pane, term, id) {
  pane.addEventListener('dragover', (event) => {
    if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
  })
  pane.addEventListener('drop', (event) => {
    const files = Array.from(event.dataTransfer?.files ?? [])
    if (!files.length) return
    event.preventDefault()
    event.stopPropagation()
    const paths = files.map((file) => electronAPI.getPathForFile(file))
    if (paths.some((path) => !path || /[\x00-\x1f\x7f"]/.test(path))) {
      showToast('無法取得可貼上的本機路徑，請從檔案總管拖入', 'error')
      return
    }
    const cmd = items.find((item) => item.id === id)?.shell === 'cmd'
    const text = paths.map((path) => cmd ? `"${path}"` : `'${path.replace(/'/g, "''")}'`).join(' ') + ' '
    term.paste(text)
    term.focus()
  })
}

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
    fontSize: 17,
    scrollback: 5000,
    ...themeOptions()
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(pane)
  registerTermLinks(term, id)
  initTerminalDrop(pane, term, id)
  term.onData((data) => {
    writeToPty(id, data)
  })
  term.attachCustomKeyEventHandler((event) => {
    if (event.key !== 'Enter' || !event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return true
    event.preventDefault()
    // 送 `ESC` ＋ `CR`（＝ Alt+Enter 的序列）。這是 Claude Code 的 `/terminal-setup`
    // 幫 VSCode／iTerm2 綁的同一個東西，Codex 那些 CLI 也認得。
    //
    // **不可以送 CSI u（`\x1b[13;2u`）**：那要終端機與 CLI 先協商過 kitty keyboard
    // protocol，xterm.js 不會宣告支援、CLI 也就不會啟用，於是那串序列會被當成一般字元，
    // 輸入框裡直接冒出 `[13;2u`——這就是使用者說的「Shift+Enter 不能換行」。
    if (event.type === 'keydown') term.input('\x1b\r', true)
    return false
  })
  // 輸入法的候選字視窗要跟著游標，不要跑到螢幕角落（見 `syncImeCaret`）。
  // `compositionupdate` 刻意不接：組字中途由 xterm 自己撐寬度，接了會被我們縮回一格。
  const placeIme = () => syncImeCaret(term)
  term.textarea?.addEventListener('focus', placeIme)
  term.textarea?.addEventListener('compositionstart', placeIme)

  // 一般終端機的習慣：選起來就進剪貼簿、右鍵就貼上
  pane.addEventListener('mouseup', (event) => {
    if (event.button !== 0) return
    const selection = term.getSelection()
    if (selection) void navigator.clipboard.writeText(selection).catch(() => {})
  })
  // 右鍵是終端機自己的（貼上），不可以同時當成滑鼠事件轉給 CLI：AI CLI 開著 SGR 滑鼠回報時
  // 會收到右鍵，然後自己再貼一次系統剪貼簿——使用者看到的就是同一段貼了兩份。
  // 攔在 capture：xterm 的滑鼠處理掛在 pane 底下的 screen 元素上。
  for (const type of ['mousedown', 'mouseup']) {
    pane.addEventListener(type, (event) => {
      if (event.button !== 2) return
      // 連 native 的焦點轉移一起擋：不然 textarea 會 blur 一次，CLI 收到假的失焦／回焦重畫
      event.preventDefault()
      event.stopPropagation()
    }, true)
  }
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
  writeChains.delete(id)
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
async function openSession(id, isActive = () => true) {
  const projectId = currentProjectId()
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
  entry.term.scrollToBottom()
  const isCurrent = () => currentId === id && currentProjectId() === projectId
    && panes.get(id) === entry && !hostEl.classList.contains('hidden') && isActive()

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
      const active = isCurrent()
      disposePane(id)
      if (active) {
        currentId = ''
        showHost(false)
      }
      await reloadList()
      return
    }
  }

  if (!isCurrent()) return
  entry.term.scrollToBottom()
  entry.term.focus()
  try { localStorage.setItem('termLastSession', id) } catch { /* 版面偏好不影響工作階段 */ }
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
    syncImeCaret(entry.term)
  } catch {
    // 分頁還沒顯示、量不到尺寸；下次切過來會再 fit 一次
  }
}

function fitCurrent() {
  const entry = panes.get(currentId)
  if (!entry || !hostEl || hostEl.classList.contains('hidden')) return
  const before = `${entry.term.cols}x${entry.term.rows}`
  fitPane(entry)
  // 拖側欄寬度時 ResizeObserver 一秒送幾十次，欄列數其實大多沒變：
  // 每一次都往 main 送 resize 等於連累 ConPTY 一起重排。
  if (`${entry.term.cols}x${entry.term.rows}` === before) return
  void electronAPI.terminal.resize(currentId, entry.term.cols, entry.term.rows)
}

/** ResizeObserver 一次拖曳會噴幾十發；合併到下一幀再量一次就夠 */
let fitFrame = 0
function scheduleFit() {
  if (fitFrame) return
  fitFrame = requestAnimationFrame(() => {
    fitFrame = 0
    fitCurrent()
  })
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
      // 排隊的片段先接成一段再寫。AI CLI 串流時一秒有上百個小封包，
      // 逐段等 xterm 解析完＝每段都排一次 timer，畫面就是一格一格地跳。
      let seq = entry.seq
      let data = ''
      while (entry.queue.length) {
        const payload = entry.queue.shift()
        if (!payload || payload.seq <= seq) continue
        data += payload.data
        seq = payload.seq
      }
      if (!data) break
      await writeOutput(entry, data)
      entry.seq = seq
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
  item.state = payload.state
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
  setTerminalStatuses(items)
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

  // 外觀（配色＋桌布）先讀一次；設定頁存檔後會再發這個事件叫我們重讀
  void refreshTerminalAppearance()
  window.addEventListener('voiceink:term-appearance', () => void refreshTerminalAppearance())

  // 視窗或側欄寬度變了就重新量欄列數；xterm 不會自己跟著容器縮放
  resizeObserver = new ResizeObserver(() => scheduleFit())
  if (hostEl) resizeObserver.observe(hostEl)

  void (async () => {
    try {
      catalog = await call(electronAPI.terminal.catalog(), '讀取設定失敗')
      cwdInput.value = catalog.homeDir || ''
      await reloadList()
      await restorePreviousTerminals()
    } catch {
      // 訊息已顯示
    }
  })()
}

async function restorePreviousTerminals() {
  if (currentId || !items.length) return
  let lastId = ''
  try { lastId = localStorage.getItem('termLastSession') || '' } catch { /* 改用清單最後一個 */ }
  const last = items.find(item => item.id === lastId) || items[items.length - 1]
  const workspace = await import('./workspace-page.js')
  if (currentId || await workspace.restoreLastProject(last.projectId)) return
  if (currentProjectId()) return
  const unassigned = items.filter(item => !item.projectId)
  for (const item of unassigned) trackTerminal(item.id, item.title)
  const target = unassigned.find(item => item.id === last.id) || unassigned[unassigned.length - 1]
  if (target) await openSession(target.id)
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
export async function openTerminalSession(id, isActive = () => true) {
  initTerminalPage()
  await openSession(id, isActive)
}

export function refreshTerminalPage() {
  initTerminalPage()
  // 主題（App 的深／淺色，或設定頁的終端機外觀）可能在別頁被切過
  void refreshTerminalAppearance()
  // 回到這一頁＝看到了目前這個階段，未讀點該清掉
  if (currentId) unread.delete(currentId)
  void reloadList()
  // 分頁剛顯示，這一幀才量得到尺寸
  panes.get(currentId)?.term.scrollToBottom()
  requestAnimationFrame(() => {
    fitCurrent()
    panes.get(currentId)?.term.scrollToBottom()
  })
}
