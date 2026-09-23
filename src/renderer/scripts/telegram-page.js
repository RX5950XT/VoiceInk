import { electronAPI } from './app.js'

/**
 * Telegram 頁：官方網頁版（Web A）放進 <webview>，可以並排多開幾格。
 *
 * 每一格都用同一個 `persist:telegram`：Web A 本來就支援同帳號多分頁，
 * 所以登入一次、每一格都是登入狀態。每格頂端一條細列：✕ 關掉這格，
 * 最右邊那格多一顆 ＋ 往右再開一格。每格停在哪個聊天室（網址的 #hash）
 * 存進設定 `telegramPanes`，下次打開接著原本那幾格。
 */

const HOME_URL = 'https://web.telegram.org/a/'
const STORE_KEY = 'telegramPanes'
// ponytail: 每格就是一整份 Web A（約 200–300MB），先卡 4 格；main 的 store:set 也卡 4
const MAX_PANES = 4

let initialized = false

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
  return [HOME_URL]
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
    barButton('telegram-pane-close', '✕', '關掉這一格', () => {
      pane.remove()
      save()
      paintBars()
    })
  )

  const view = document.createElement('webview')
  // partition 建了就不能改，要在插入前設好；popup（外部連結）由 main 轉系統瀏覽器
  view.setAttribute('partition', 'persist:telegram')
  view.setAttribute('allowpopups', '')
  view.setAttribute('src', url)
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
}

/** 第一次切進來才建：沒點過 Telegram 就不去連線 */
export async function refreshTelegramPage() {
  if (initialized || !frame()) return
  initialized = true
  ;(await loadSaved()).forEach(addPane)
}
