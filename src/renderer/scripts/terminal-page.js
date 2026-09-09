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
import { SearchAddon } from '../../../node_modules/@xterm/addon-search/lib/addon-search.mjs'
import { Unicode11Addon } from '../../../node_modules/@xterm/addon-unicode11/lib/addon-unicode11.mjs'
import { WebglAddon } from '../../../node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs'

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
let findEl = null
let findInput = null
let findCountEl = null

/** 終端機字級（Ctrl+滾輪／Ctrl+加減調的那個），跟 main 的 `sanitizeFontSize` 同一組上下限 */
const FONT_MIN = 8
const FONT_MAX = 40
const FONT_DEFAULT = 17
let fontSize = FONT_DEFAULT

/** 最多同時並排幾個工作階段。再多每一格就窄到看不出東西了。 */
const MAX_VISIBLE = 3

/** @type {Array<{ id: string, title: string, shell: string, preset: string, cwd: string, state: string, exitCode: number | null }>} */
let items = []
let currentId = ''
let catalog = { shells: [], presets: [], maxSessions: 20 }

/**
 * @typedef {{
 *   term: Terminal, fit: FitAddon, search: SearchAddon, pane: HTMLElement,
 *   seq: number, ready: boolean, writing: boolean, queue: Array<{ seq: number, data: string }>
 * }} Pane
 */
/** @type {Map<string, Pane>} */
const panes = new Map()

/**
 * 現在並排顯示哪幾個工作階段。長度 1 ＝一般的單格，2 以上就是分割顯示。
 * 第一個是「作用中」的那一格（`currentId`）。
 * @type {string[]}
 */
let visibleIds = []

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
/**
 * 分頁上顯示的名字。使用者自己改過就一定用他改的；沒改過才讓前景程式自己報的
 * 標題（OSC 0/2，例如 `npm run build`）蓋上去——不然改完名字下一秒就被蓋掉。
 * @param {{ renamed?: boolean, title: string, osTitle?: string }} item
 * @returns {string}
 */
function displayTitle(item) {
  return item.renamed ? item.title : (item.osTitle || item.title)
}

function pushTabState(id) {
  const item = items.find((entry) => entry.id === id)
  if (!item) return
  paintTerminalTab(id, {
    title: displayTitle(item),
    state: item.state,
    stateLabel: stateLabel(item),
    admin: Boolean(item.admin),
    // 前景 shell 報到哪就顯示哪（OSC 7）；沒報過才退回開起來時的那個目錄
    cwd: item.liveCwd || item.cwd || '',
    split: isTerminalSplit(id),
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

/**
 * 換上 WebGL renderer。
 *
 * 預設的 DOM renderer 把每一格字畫成一個 `<span>`，游標是帶 CSS `animation` 的那一顆——
 * **串流時那一列每一幀都被重建，動畫就每一幀從 0% 重來**，游標永遠跑不完一個閃爍週期，
 * 看起來就是在亂閃（AI CLI 的 spinner 一秒重畫好幾次，正是最糟的情況）。WebGL renderer
 * 把整個畫面畫在一張 canvas 上，游標閃爍走它自己的計時器，不受重繪影響。
 *
 * 顯示卡驅動更新、GPU 重置都會讓 context 掉；掉了就把 addon 收掉退回 DOM renderer
 * （xterm 自己會接手），**不能放著不管**——context 沒了畫面就是一片空白。
 *
 * @param {Terminal} term
 */
function attachRenderer(term) {
  try {
    const webgl = new WebglAddon()
    webgl.onContextLoss(() => webgl.dispose())
    term.loadAddon(webgl)
  } catch {
    // 沒有 GPU（遠端桌面、`--disable-gpu`）：留著 DOM renderer，功能不受影響
  }
}

function createPane(id) {
  const pane = document.createElement('div')
  pane.className = 'term-pane'
  pane.dataset.id = id
  hostEl.appendChild(pane)
  // `term.open()` 要量得到尺寸才畫得出東西。掛在 display:none 的格子上會開出一個
  // 0×0 的終端機，第一段輸出（提示字元）就這樣消失了——所以先切成可見再 open。
  //
  // **這裡不可以改成呼叫 `paintPanes()`**：那支會把還沒登記進 `panes` 的 id 過濾掉
  // （新的這一格正是還沒登記的那個），結果就是開在一個 `display: none` 的格子上。
  for (const other of panes.values()) other.pane.classList.remove('is-active')
  pane.classList.add('is-active')
  hostEl.classList.remove('is-split')
  visibleIds = [id]

  const term = new Terminal({
    allowProposedApi: true,
    convertEol: false,
    cursorBlink: true,
    fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "微軟正黑體", monospace',
    fontSize,
    scrollback: 5000,
    ...themeOptions()
  })
  const fit = new FitAddon()
  const search = new SearchAddon()
  term.loadAddon(fit)
  term.loadAddon(search)
  // 預設的字寬表是 Unicode 6 的：emoji 與一部分框線字元會被算成一格，
  // AI CLI 畫的方框就會歪掉。載了還要真的切過去，只 `loadAddon` 不會生效。
  const unicode11 = new Unicode11Addon()
  term.loadAddon(unicode11)
  term.unicode.activeVersion = '11'
  term.open(pane)
  attachRenderer(term)
  registerTermLinks(term, id)
  initTerminalDrop(pane, term, id)
  term.onData((data) => {
    writeToPty(id, data)
  })
  // 命中幾筆／現在第幾筆。addon 是每一格各一份，所以只有作用中那格的結果才畫上去。
  search.onDidChangeResults(({ resultIndex, resultCount }) => {
    if (!findCountEl || currentId !== id) return
    findCountEl.textContent = resultCount ? `${resultIndex + 1}/${resultCount}` : '沒有符合的'
  })

  term.attachCustomKeyEventHandler((event) => {
    if (event.isComposing) return true
    if (event.ctrlKey && !event.altKey && !event.metaKey) {
      // Ctrl+F 搜尋。PSReadLine 的 Windows 編輯模式沒有綁 Ctrl+F（實測
      // `Get-PSReadLineKeyHandler -Bound` 沒有這一條），拿來當搜尋不會擋到編輯。
      // Ctrl+Shift+F 也收：那是 Windows 終端機的習慣。
      if (event.key === 'f' || event.key === 'F') {
        if (event.type === 'keydown') showFind(true)
        return false
      }
      // 字級：`=` 與 `+` 是同一顆，兩個 key 都要收
      if (['=', '+', '-', '_', '0'].includes(event.key)) {
        if (event.type === 'keydown') {
          if (event.key === '0') applyFontSize(FONT_DEFAULT)
          else applyFontSize(fontSize + (event.key === '-' || event.key === '_' ? -1 : 1))
        }
        return false
      }
    }
    // Esc 關搜尋列——**但只有搜尋列開著時才吞**，不然 AI CLI 收不到 Esc（那是中斷鍵）
    if (event.key === 'Escape' && findOpen()) {
      if (event.type === 'keydown') showFind(false)
      return false
    }
    if (event.key !== 'Enter' || !event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return true
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

  // 分割顯示時點哪一格，哪一格就是作用中的那個（打字、resize、未讀點都跟著它走）。
  // 用 pointerdown 不用 click：選取文字放開時 click 不一定會來。
  pane.addEventListener('pointerdown', () => {
    if (currentId === id) return
    currentId = id
    visibleIds = [id, ...visibleIds.filter((key) => key !== id)]
    unread.delete(id)
    paintPanes()
    pushTabState(id)
  })

  /** @type {Pane} */
  const entry = { term, fit, search, pane, seq: 0, ready: false, writing: false, queue: [] }
  panes.set(id, entry)
  // 登記好了才畫得出來（`order`、並排狀態都要有這一格在 `panes` 裡才算得出來）
  paintPanes()
  return entry
}

/**
 * 把 `visibleIds` 畫出來：哪幾格看得到、誰排在前面、要不要切成並排版面。
 *
 * 刻意**不搬 DOM**（每一格都留在 `#termHost` 底下不動）：搬 xterm 的節點等於讓它整份
 * 重新量尺寸，而順序用 CSS `order` 就排得出來。
 */
function paintPanes() {
  visibleIds = visibleIds.filter((id) => panes.has(id)).slice(0, MAX_VISIBLE)
  if (!visibleIds.length && currentId && panes.has(currentId)) visibleIds = [currentId]
  hostEl?.classList.toggle('is-split', visibleIds.length > 1)
  for (const [id, entry] of panes) {
    const at = visibleIds.indexOf(id)
    entry.pane.classList.toggle('is-active', at >= 0)
    entry.pane.classList.toggle('is-current', id === currentId && visibleIds.length > 1)
    entry.pane.style.order = at >= 0 ? String(at) : ''
  }
}

/**
 * 把某個工作階段加進（或移出）並排顯示。
 *
 * 加進來的那一格會變成作用中的那個——是使用者剛剛說要看它的。
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function toggleTerminalSplit(id) {
  const already = visibleIds.includes(id)
  if (already) {
    // 只剩自己就不用收了，收掉會變成一格都沒有
    if (visibleIds.length < 2) return
    visibleIds = visibleIds.filter((key) => key !== id)
    if (currentId === id) currentId = visibleIds[0]
  } else {
    if (visibleIds.length >= MAX_VISIBLE) {
      showToast(`最多並排 ${MAX_VISIBLE} 個終端機`, 'error')
      return
    }
    const keep = [...visibleIds]
    // 沒開過的先真的開起來（要跟 main 要一顆 pty 與畫面快照）。`openSession` 會把
    // 畫面切成只剩它一格，所以開完再把原本並排的那幾格接回去。
    if (!panes.has(id)) await openSession(id)
    if (!panes.has(id)) return
    visibleIds = [...keep.filter((key) => key !== id), id].slice(-MAX_VISIBLE)
    currentId = id
    unread.delete(id)
  }
  paintPanes()
  fitVisible()
  panes.get(currentId)?.term.focus()
  for (const key of [...visibleIds, id]) pushTabState(key)
}

/**
 * 這個工作階段現在有沒有被並排顯示（`ws-tabs.js` 畫右鍵選單要問）。
 * @param {string} id
 * @returns {boolean}
 */
export function isTerminalSplit(id) {
  return visibleIds.length > 1 && visibleIds.includes(id)
}

/**
 * @param {string} id
 */
function disposePane(id) {
  const entry = panes.get(id)
  if (!entry) return
  panes.delete(id)
  writeChains.delete(id)
  visibleIds = visibleIds.filter((key) => key !== id)
  entry.term.dispose()
  entry.pane.remove()
  paintPanes()
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
  // 換工作階段就把搜尋列收掉：命中的標示是畫在**上一格**的 addon 上，
  // 留著它只會在別的終端機上顯示一組跟畫面對不起來的計數。
  if (currentId !== id && findOpen()) showFind(false)
  // 聊天與工作區同頁：點終端機就是切到工作區主區（同步切 DOM，xterm 才量得到尺寸）
  setChatPaneMode('workspace')
  currentId = id
  unread.delete(id)
  showHost(true)

  let entry = panes.get(id)
  const fresh = !entry
  // createPane 自己會把新格子切成可見（open 前必須量得到尺寸）
  if (!entry) entry = createPane(id)
  else {
    // 已經在並排裡的話只是把焦點換過去，不要把並排收掉
    visibleIds = visibleIds.includes(id)
      ? [id, ...visibleIds.filter((key) => key !== id)]
      : [id]
    paintPanes()
  }
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

/**
 * 量看得到的每一格。並排時每一格都要各自 fit——只 fit 作用中那個的話，
 * 旁邊那格的 ConPTY 還以為自己有整個寬度，換行會全部亂掉。
 */
function fitVisible() {
  if (!hostEl || hostEl.classList.contains('hidden')) return
  for (const id of visibleIds) {
    const entry = panes.get(id)
    if (!entry) continue
    const before = `${entry.term.cols}x${entry.term.rows}`
    fitPane(entry)
    // 拖側欄寬度時 ResizeObserver 一秒送幾十次，欄列數其實大多沒變：
    // 每一次都往 main 送 resize 等於連累 ConPTY 一起重排。
    if (`${entry.term.cols}x${entry.term.rows}` === before) continue
    void electronAPI.terminal.resize(id, entry.term.cols, entry.term.rows)
  }
}

/** ResizeObserver 一次拖曳會噴幾十發；合併到下一幀再量一次就夠 */
let fitFrame = 0
function scheduleFit() {
  if (fitFrame) return
  fitFrame = requestAnimationFrame(() => {
    fitFrame = 0
    fitVisible()
  })
}

// ===== 字級 =====

/**
 * 套用字級。**所有分頁一起改**：同一個終端機的每一格忽大忽小只會讓人分心。
 * 改完欄列數就變了，要重新 fit 並把輸入法游標對回去。
 *
 * @param {number} next
 * @param {boolean} [persist] 開頁時從 store 讀回來的那次不用再寫回去
 */
function applyFontSize(next, persist = true) {
  const size = Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(Number(next) || FONT_DEFAULT)))
  if (size === fontSize) return
  fontSize = size
  for (const entry of panes.values()) entry.term.options.fontSize = size
  fitVisible()
  for (const entry of panes.values()) syncImeCaret(entry.term)
  if (persist) void electronAPI.store.set('termFontSize', size)
}

// ===== 搜尋 =====

/**
 * 命中的底色。**不要用 `--accent-primary` 當底色**：那是文字色系，壓在終端機的字底下
 * 讀不出來；用它的半透明版本當底、選中的那一筆再加深。
 * @returns {object}
 */
function findDecorations() {
  const css = getComputedStyle(document.documentElement)
  const accent = css.getPropertyValue('--accent-primary').trim() || '#78a3b5'
  return {
    matchBackground: 'rgba(120, 163, 181, 0.35)',
    matchBorder: 'transparent',
    matchOverviewRuler: accent,
    activeMatchBackground: accent,
    activeMatchBorder: 'transparent',
    activeMatchColorOverviewRuler: accent
  }
}

/**
 * 往前／往後找一筆。空字串就把既有的標示清掉（不然關掉搜尋列還留著一片高亮）。
 * @param {1 | -1} direction
 */
function runFind(direction) {
  const entry = panes.get(currentId)
  if (!entry) return
  const text = findInput?.value || ''
  if (!text) {
    entry.search.clearDecorations()
    if (findCountEl) findCountEl.textContent = ''
    return
  }
  const options = { decorations: findDecorations() }
  if (direction > 0) entry.search.findNext(text, options)
  else entry.search.findPrevious(text, options)
}

/**
 * @param {boolean} on
 */
function showFind(on) {
  if (!findEl) return
  findEl.classList.toggle('hidden', !on)
  if (on) {
    findInput?.focus()
    findInput?.select()
    runFind(1)
    return
  }
  // 關掉就把高亮收乾淨，再把鍵盤還給終端機
  panes.get(currentId)?.search.clearDecorations()
  if (findCountEl) findCountEl.textContent = ''
  panes.get(currentId)?.term.focus()
}

/** 搜尋列現在開著嗎（`refreshTerminalPage` 換分頁時要收掉） */
function findOpen() {
  return Boolean(findEl) && !findEl.classList.contains('hidden')
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
  // 前景程式自己報的標題與工作目錄。**空的不要蓋回去**：清單只送「現在知道的」，
  // 收到一次空值就把好不容易撈到的標題洗掉，分頁名字會一直閃。
  if (payload.osTitle) item.osTitle = payload.osTitle
  if (payload.liveCwd) item.liveCwd = payload.liveCwd
  // 跑完的當下不在看它 → 亮未讀點（這是「哪個代理做完了」的提示）。
  // 「不在看」包含兩種：看的是別的工作階段，或終端機主區沒開著
  // （聊天跟終端機同頁：主區顯示對話時＝人不在終端機）。
  // 主區顯示的是對話時 `termMain` 被藏起來（`termHost` 自己不會變），少這一條的話
  // 人在對話裡，背景終端機跑完永遠不亮未讀點。
  // 並排時每一格都看得到，不是只有作用中那格才算「在看」
  const watching = visibleIds.includes(payload.id)
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
  findEl = document.getElementById('termFind')
  findInput = /** @type {HTMLInputElement | null} */ (document.getElementById('termFindInput'))
  findCountEl = document.getElementById('termFindCount')

  // ── 搜尋列 ──
  findInput?.addEventListener('input', () => runFind(1))
  findInput?.addEventListener('keydown', (event) => {
    // 搜尋列的按鍵不可以漏回終端機（Enter 會被當成送出指令）
    event.stopPropagation()
    if (event.key === 'Enter') {
      event.preventDefault()
      runFind(event.shiftKey ? -1 : 1)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      showFind(false)
    }
  })
  document.getElementById('termFindPrev')?.addEventListener('click', () => runFind(-1))
  document.getElementById('termFindNext')?.addEventListener('click', () => runFind(1))
  document.getElementById('termFindClose')?.addEventListener('click', () => showFind(false))

  // ── 字級：Ctrl+滾輪。掛在 host 上而不是各分頁，並排時滾哪一格都一樣 ──
  hostEl?.addEventListener('wheel', (event) => {
    if (!event.ctrlKey) return
    event.preventDefault()
    applyFontSize(fontSize + (event.deltaY < 0 ? 1 : -1))
  }, { passive: false })

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
      // 字級要在第一個分頁開起來之前讀好，不然會先用預設值畫一次再跳大小
      applyFontSize(await electronAPI.store.get('termFontSize', FONT_DEFAULT), false)
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
    fitVisible()
    panes.get(currentId)?.term.scrollToBottom()
  })
}
