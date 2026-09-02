'use strict'

/**
 * VoiceInk - 語音輸入的桌面指示器（Main Process）
 *
 * 一扇很小的懸浮視窗，貼在「滑鼠所在那一面螢幕」的底部中央，告訴使用者
 * 「現在正在聽你講話」。錄音中顯示波形、處理中顯示脈動、失敗顯示錯誤。
 *
 * 三個不可以改的地方：
 *
 * 1. **`focusable: false` ＋ `showInactive()`**：語音輸入最後是模擬 Ctrl+V 貼進
 *    「當下的前景視窗」。指示器只要搶到一次焦點，使用者的文字就會貼進這扇
 *    指示器而不是他正在打字的程式。所以它從頭到尾不准被啟用。
 * 2. **`resizable: false`**：字幕視窗那條「Windows 上透明視窗會白條殘留＋
 *    resizable 失效」的教訓，坑在 transparent × resizable 的組合。這扇是固定
 *    尺寸、由 main 用 `setBounds` 改，不走使用者拖拉，所以可以透明（要透明才
 *    有圓角藥丸外型）。
 * 3. **位置在 show 之前算好**：先 show 再移動會看到它在錯的螢幕上閃一下。
 */

const { BrowserWindow, screen } = require('electron')
const path = require('path')

/**
 * 視窗固定這麼大，**不隨狀態改尺寸**：藥丸本身在裡面置中、寬度由內容決定，
 * 藥丸以外的區域是透明且 `pointer-events: none`，不會擋到底下的程式。
 * 這樣就不必為了「錯誤訊息比較長」去 resize——`resizable: false` 會讓 setBounds
 * 的寬高被忽略（實測過），而為了改寬臨時開 resizable 又正好踩到
 * 「Windows 上 transparent × resizable 會出事」那條教訓。
 */
const SIZE = Object.freeze({ width: 540, height: 104 })
/** 離工作區底部的距離（避開工作列，也不要壓在最下緣） */
const MARGIN_BOTTOM = 44
/** 錯誤訊息停留多久。使用者多半正在別的程式裡，Toast 看不到，這裡是唯一會看到的地方 */
const ERROR_MS = 5000
/** 錯誤字數上限：這是要塞進一顆藥丸的，太長就截斷（頁面那邊是三行的容器） */
const MAX_ERROR_CHARS = 90

/** @type {BrowserWindow | null} */
let win = null
/** @type {NodeJS.Timeout | null} */
let hideTimer = null
/** 只有換螢幕才 setBounds：level 事件每秒 8 次，每次都動視窗是白費工 */
let lastDisplayId = -1
let devMode = false
let preloadPath = ''
/** 頁面載好之前先把最後一次狀態存著，載好再補送（不然開窗那一瞬間的事件會掉） */
let pending = null
let ready = false

/**
 * @param {{ isDev: boolean, preload: string }} opts
 */
function configure(opts) {
  devMode = opts.isDev === true
  preloadPath = String(opts.preload || '')
}

function clearHideTimer() {
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
}

/**
 * 底部中央的座標。純算術，才好測——`workArea` 的 x／y 在多螢幕時不是 0
 * （副螢幕在左邊時甚至是負的），直接用 width/height 算會把視窗放到主螢幕上。
 * @param {{ x: number, y: number, width: number, height: number }} workArea
 * @param {{ width: number, height: number }} size
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
function hudBounds(workArea, size) {
  return {
    x: Math.round(workArea.x + (workArea.width - size.width) / 2),
    y: Math.round(workArea.y + workArea.height - size.height - MARGIN_BOTTOM),
    width: size.width,
    height: size.height
  }
}

/**
 * 把視窗擺到「滑鼠所在那一面螢幕」的底部中央。
 * 這就是「跟著滑鼠換螢幕」的全部實作：每次狀態更新都問一次游標在哪面螢幕，
 * 換了才動視窗。錄音中 level 每秒來 8 次，反應夠即時，也不必另外開輪詢計時器。
 */
function place() {
  if (!win || win.isDestroyed()) return
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  if (display.id === lastDisplayId) return
  lastDisplayId = display.id
  win.setBounds(hudBounds(display.workArea, SIZE))
}

function create() {
  win = new BrowserWindow({
    width: SIZE.width,
    height: SIZE.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    acceptFirstMouse: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: preloadPath
    }
  })
  win.setMenu(null)
  // 'screen-saver' 這一層才蓋得過全螢幕的程式；指示器沒蓋住東西就沒有用
  win.setAlwaysOnTop(true, 'screen-saver')
  // 這扇視窗沒有任何連結或導覽，一律擋掉
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())

  ready = false
  win.webContents.once('did-finish-load', () => {
    ready = true
    if (pending) send(pending)
  })
  win.on('closed', () => {
    win = null
    ready = false
    lastDisplayId = -1
  })

  if (devMode) {
    win.loadURL('http://localhost:5173/pages/dictation-hud.html')
  } else {
    win.loadFile(path.join(__dirname, '../../renderer/pages/dictation-hud.html'))
  }
}

/**
 * 先把視窗建好（維持隱藏），第一次按右 Alt 時才不會看著一扇空白視窗等頁面載完。
 * 語音輸入一啟用就叫一次；重複呼叫是 no-op。
 */
function warm() {
  if (!win || win.isDestroyed()) create()
}

/**
 * @param {{ state: string, level?: number, message?: string }} payload
 */
function send(payload) {
  if (!win || win.isDestroyed() || !ready) return
  win.webContents.send('dictation:hud', payload)
}

/**
 * 狀態進來就更新畫面／位置／顯示與否。
 * @param {{ state?: unknown, level?: unknown, message?: unknown }} raw
 * @returns {boolean}
 */
function update(raw) {
  const state = String(raw?.state || 'idle')
  const visible = state === 'recording' || state === 'processing' || state === 'error'
  if (!visible) {
    clearHideTimer()
    pending = null
    if (win && !win.isDestroyed()) win.hide()
    return true
  }

  const levelRaw = Number(raw?.level)
  const payload = {
    state,
    level: Number.isFinite(levelRaw) ? Math.min(1, Math.max(0, levelRaw)) : 0,
    message: state === 'error' ? String(raw?.message || '語音輸入失敗').slice(0, MAX_ERROR_CHARS) : ''
  }

  if (!win || win.isDestroyed()) create()
  pending = payload

  place()
  if (!win.isVisible()) win.showInactive()
  send(payload)

  clearHideTimer()
  if (state === 'error') hideTimer = setTimeout(() => update({ state: 'idle' }), ERROR_MS)
  return true
}

/**
 * `dictation:hudAction` 只准指示器自己送（它按了 ✕／✓）。
 * @param {{ sender: unknown }} event
 * @returns {boolean}
 */
function isSender(event) {
  if (!win || win.isDestroyed()) return false
  return event?.sender === win.webContents
}

function close() {
  clearHideTimer()
  pending = null
  if (win && !win.isDestroyed()) win.destroy()
  win = null
}

/** 測試用：拿得到視窗才驗得了 focusable／bounds／可見性 */
function _window() {
  return win
}

module.exports = {
  configure, warm, update, isSender, close, hudBounds, _window,
  SIZE, MARGIN_BOTTOM, MAX_ERROR_CHARS
}
