import { electronAPI } from './app.js'

/**
 * Telegram 頁：官方網頁版（Web A）放進 <webview>，可以並排多開幾格。
 *
 * 每一格都用同一個 `persist:telegram`：Web A 本來就支援同帳號多分頁，
 * 所以登入一次、每一格都是登入狀態。每格頂端一條細列：✕ 關掉這格，
 * 最右邊那格多一顆 ＋ 往右再開一格。每格停在哪個聊天室（網址的 #hash）
 * 存進設定 `telegramPanes`，下次打開接著原本那幾格；沒存過就開兩格。
 * 每格寬度卡在 600px（CSS），Web A 一律是手機版版面。
 */

const HOME_URL = 'https://web.telegram.org/a/'
const STORE_KEY = 'telegramPanes'
// ponytail: 每格就是一整份 Web A（約 200–300MB），先卡 4 格；main 的 store:set 也卡 4
const MAX_PANES = 4
// 前一格載完再等一下才開下一格：Web A 靠 BroadcastChannel 在 100ms 內選出唯一連線的主分頁，
// 選不出來就「先連再說」。幾格同時開會有好幾格拿同一把金鑰一起連，Web A 本來只預期分頁一個一個開
const SETTLE_MS = 1500
const LOAD_TIMEOUT_MS = 10000

let initialized = false
let loadChain = Promise.resolve()

/** 只收 Telegram 網頁版自己的網址；設定檔壞掉或被改過就回首頁 */
function safeUrl(value) {
  return typeof value === 'string' && value.startsWith(HOME_URL) ? value : HOME_URL
}

async function loadSaved() {
  try {
    const list = await electronAPI.store.get(STORE_KEY, [])
    if (Array.isArray(list) && list.length) return list.slice(0, MAX_PANES).map(safeUrl)
  } catch (error) {
    console.error('[telegram] 讀不到上次的格子:', error)
  }
  return [HOME_URL, HOME_URL]
}

function frame() {
  return document.getElementById('telegramFrame')
}

function save() {
  const urls = [...frame().querySelectorAll('webview')].map((view) => view.dataset.src)
  electronAPI.store.set(STORE_KEY, urls).catch((error) => {
    console.error('[telegram] 存不了格子:', error)
  })
}

/** ✕ 只剩一格時不給關；＋ 只放在最右邊那格、滿了就收起來 */
function paintBars() {
  const panes = [...frame().querySelectorAll('.telegram-pane')]
  panes.forEach((pane, index) => {
    pane.querySelector('.telegram-pane-close').hidden = panes.length <= 1
    pane.querySelector('.telegram-pane-add').hidden = index !== panes.length - 1 || panes.length >= MAX_PANES
  })
}

function barButton(className, text, label, onClick) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = `btn-icon ${className}`
  btn.textContent = text
  btn.title = label
  btn.setAttribute('aria-label', label)
  btn.addEventListener('click', onClick)
  return btn
}

/** 格子先放上去，網址排隊一格一格載（理由見 SETTLE_MS） */
function loadInTurn(view, url) {
  loadChain = loadChain.then(() => new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      setTimeout(resolve, SETTLE_MS)
    }
    const timer = setTimeout(done, LOAD_TIMEOUT_MS)
    view.addEventListener('did-finish-load', done, { once: true })
    view.setAttribute('src', url)
  }))
}

/**
 * 直接拿掉 webview 不會觸發頁面的 beforeunload：這格若是 Web A 負責連線的主分頁，
 * 其他格收不到交棒通知、全部卡在連線中。先導到 about:blank 讓它正常卸載再拿掉。
 */
function closePane(pane, view) {
  let removed = false
  const remove = () => {
    if (removed) return
    removed = true
    pane.remove()
    save()
    paintBars()
  }
  view.addEventListener('did-navigate', remove, { once: true })
  setTimeout(remove, 1500)
  try {
    view.loadURL('about:blank').catch(remove)
  } catch {
    remove() // 還在排隊、沒載過的格子：沒有頁面要卸載
  }
}

/** @param {string} url */
function addPane(url) {
  const pane = document.createElement('div')
  pane.className = 'telegram-pane'

  const bar = document.createElement('div')
  bar.className = 'telegram-pane-bar'
  bar.append(
    barButton('telegram-pane-add', '＋', '往右再開一格', () => {
      addPane(HOME_URL)
      save()
    }),
    barButton('telegram-pane-close', '✕', '關掉這一格', () => closePane(pane, view))
  )

  const view = document.createElement('webview')
  // partition 建了就不能改，要在插入前設好；popup（外部連結）由 main 轉系統瀏覽器
  view.setAttribute('partition', 'persist:telegram')
  view.setAttribute('allowpopups', '')
  view.dataset.src = url
  const remember = (event) => {
    view.dataset.src = safeUrl(/** @type {any} */ (event).url)
    save()
  }
  view.addEventListener('did-navigate', remember)
  view.addEventListener('did-navigate-in-page', remember)

  pane.append(bar, view)
  frame().appendChild(pane)
  paintBars()
  loadInTurn(view, url)
}

/** 第一次切進來才建：沒點過 Telegram 就不去連線 */
export async function refreshTelegramPage() {
  if (initialized || !frame()) return
  initialized = true
  ;(await loadSaved()).forEach(addPane)
}
