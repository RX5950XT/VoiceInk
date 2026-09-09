'use strict'

const store = require('./store')
const terminal = require('./pty')
const links = require('./links')
const foreground = require('./foreground')
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
  const snapshot = await getClient().request('open', { sessionId: meta.id, meta, cols, rows }, true)
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
  setEmitter(fn) { emit = typeof fn === 'function' ? fn : () => {} },
  catalog: terminal.catalog,
  createSession: terminal.createSession,
  renameSession: terminal.renameSession,
  listSessions,
  openSession,
  deleteSession,
  writeSession,
  resolveLinks: links.resolveLinks,
  revealLink: links.revealLink,
  raiseChildWindow: foreground.raiseChildWindow,
  // 終端機桌布：檔案在 main 手上，renderer 只拿得到 data: URI（見 background.js）
  backgroundImage: background.dataUri,
  adoptBackground: background.adopt,
  clearBackground: background.remove,
  resizeSession: (id, cols, rows) => getClient().request('resize', { sessionId: String(id || ''), cols, rows }),
  killSession: (id) => getClient().request('kill', { sessionId: String(id || '') }),
  disconnect() { foreground.stop(); client?.disconnect(); client = null }
}
