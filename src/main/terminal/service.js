'use strict'

const store = require('./store')
const terminal = require('./pty')
const links = require('./links')
const foreground = require('./foreground')
const editorBridge = require('./editor-bridge')
const background = require('./background')
const { HostClient } = require('./host-client')

let client
let emit = () => {}

function getClient() {
  if (!client) client = new HostClient(require('electron').app.getPath('userData'), forward)
  return client
}

/**
 * 宿主送上來的事件轉給 renderer。
 *
 * 宿主講的 `title`／`cwd` 是**前景程式自己報的**（OSC 0/2 與 OSC 7），跟 store 裡
 * 使用者自己取的名字、開檔當下的工作目錄是兩回事——換個欄位名往上送，免得在
 * `listSessions` 的展開裡把 store 那份無聲蓋掉。
 *
 * @param {string} event
 * @param {object} payload
 */
function forward(event, payload) {
  if (event !== 'terminal:status') { emit(event, payload); return }
  const { title, cwd, ...rest } = payload
  if (cwd) links.noteCwd(payload.id, cwd)
  emit(event, { ...rest, osTitle: title || '', liveCwd: cwd || '' })
}

/**
 * Ctrl+G 會不會落在 App 自己的編輯分頁上：橋接命令建得起來，而且使用者沒有真的挑過
 * 編輯器。`VISUAL` 排在前面是因為 Claude Code 與 Codex 都先看它。
 *
 * `EDITOR=notepad` 不算挑過（那就是 CLI 沒設時的預設值）——實測使用者環境變數裡躺著
 * 這一條，Ctrl+G 就永遠彈記事本。
 * @returns {boolean}
 */
function bridgeTakesOver() {
  const picked = process.env.VISUAL || process.env.EDITOR
  return Boolean(editorBridge.shimCommand()) && !editorBridge.isRealEditor(picked)
}

async function listSessions() {
  const items = await store.list()
  const states = await getClient().request('list') || []
  const byId = new Map(states.map(item => [item.id, item]))
  return items.map(item => {
    const state = byId.get(item.id)
    if (state?.cwd) links.noteCwd(item.id, state.cwd)
    return {
      ...item,
      state: state?.state || 'stopped',
      exitCode: state?.exitCode ?? null,
      osTitle: state?.title || '',
      liveCwd: state?.cwd || ''
    }
  })
}

async function openSession(id, cols, rows) {
  const meta = await store.get(String(id || ''))
  if (!meta) {
    const error = new Error('NO_SESSION')
    error.code = 'NO_SESSION'
    error.userMessage = '找不到這個工作階段'
    throw error
  }
  // Ctrl+G 的編輯器橋接：每次開 shell 都帶最新的那條命令過去（見 editor-bridge.js）。
  // 接不接手在這裡決定，宿主拿到空字串就完全不動 EDITOR／VISUAL。
  const editor = bridgeTakesOver() ? editorBridge.shimCommand() : ''
  const snapshot = await getClient().request('open', { sessionId: meta.id, meta, cols, rows, editor }, true)
  if (snapshot?.cwd) links.noteCwd(meta.id, snapshot.cwd)
  return snapshot
}

/**
 * 跑著的宿主是不是舊版程式碼，以及現在收不收得起。
 *
 * 宿主活得比 App 久（更新只斷線），所以 `pty.js` 這一側的修正在使用者按下重新啟動
 * 之前完全不會生效——Ctrl+G 的編輯器橋接就是這樣整整幾版都沒作用。
 *
 * `busy` ＝還有跑著的 shell（`running`／`idle`）。沒有的話直接重開，不用煩使用者。
 * @returns {Promise<{ stale: boolean, busy: boolean }>}
 */
async function hostState() {
  if (!await getClient().ensure(false)) return { stale: false, busy: false }
  const states = await getClient().request('list') || []
  return {
    stale: getClient().stale(),
    busy: states.some(item => item.state === 'running' || item.state === 'idle')
  }
}

/**
 * 收掉舊宿主再連一份新的。**跑著的 shell 會一起結束**：renderer 在 `busy` 時要先問過
 * 使用者（見 `terminal-page.js` 的 `checkHostRuntime`）。
 * @returns {Promise<boolean>}
 */
async function restartHost() {
  if (!await getClient().ensure(false)) return false
  return getClient().restart()
}

async function deleteSession(id) {
  await getClient().request('forget', { sessionId: String(id || '') })
  links.noteCwd(String(id || ''), '')
  return store.remove(String(id || ''))
}

function writeSession(id, data) {
  if (typeof data !== 'string' || !data) return false
  return getClient().request('write', { sessionId: String(id || ''), data: data.slice(0, terminal.MAX_WRITE_CHARS) })
}

module.exports = {
  setEmitter(fn) {
    emit = typeof fn === 'function' ? fn : () => {}
    editorBridge.configure(require('electron').app.getPath('userData'))
    editorBridge.start((channel, payload) => emit(channel, payload))
  },
  // Ctrl+G 開的那個編輯分頁：renderer 只送得出 id，改哪個檔由 main 說了算
  editorSubmit: (id, content) => editorBridge.submit(id, content),
  editorCancel: (id) => editorBridge.cancel(id),
  catalog: terminal.catalog,
  createSession: terminal.createSession,
  renameSession: terminal.renameSession,
  listSessions,
  hostState,
  restartHost,
  openSession,
  deleteSession,
  writeSession,
  resolveLinks: links.resolveLinks,
  revealLink: links.revealLink,
  // Ctrl+G：橋接接手時根本不會有新視窗冒出來，不用再叫一支 PowerShell 去等
  raiseChildWindow: () => (bridgeTakesOver() ? false : foreground.raiseChildWindow()),
  // 終端機桌布：檔案在 main 手上，renderer 只拿得到 data: URI（見 background.js）
  backgroundImage: background.dataUri,
  adoptBackground: background.adopt,
  clearBackground: background.remove,
  resizeSession: (id, cols, rows) => getClient().request('resize', { sessionId: String(id || ''), cols, rows }),
  killSession: (id) => getClient().request('kill', { sessionId: String(id || '') }),
  disconnect() { foreground.stop(); editorBridge.stop(); client?.disconnect(); client = null }
}
