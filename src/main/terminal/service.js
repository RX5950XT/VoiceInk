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
 * Ctrl+G 會不會落在 App 自己的編輯分頁上：橋接命令建得起來，而且使用者沒有自己
 * 設過 `EDITOR`／`VISUAL`（設過的話 `pty.js` 不會覆蓋，開的是他指定的那支）。
 * @returns {boolean}
 */
function bridgeTakesOver() {
  return Boolean(editorBridge.shimCommand()) && !process.env.EDITOR && !process.env.VISUAL
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
  // Ctrl+G 的編輯器橋接：每次開 shell 都帶最新的那條命令過去（見 editor-bridge.js）
  const editor = editorBridge.shimCommand()
  const snapshot = await getClient().request('open', { sessionId: meta.id, meta, cols, rows, editor }, true)
  if (snapshot?.cwd) links.noteCwd(meta.id, snapshot.cwd)
  return snapshot
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
