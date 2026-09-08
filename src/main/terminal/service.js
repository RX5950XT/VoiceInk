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
  if (!client) client = new HostClient(require('electron').app.getPath('userData'), (event, payload) => emit(event, payload))
  return client
}

async function listSessions() {
  const items = await store.list()
  const states = await getClient().request('list') || []
  const byId = new Map(states.map(item => [item.id, item]))
  return items.map(item => ({ ...item, state: 'stopped', exitCode: null, ...byId.get(item.id) }))
}

async function openSession(id, cols, rows) {
  const meta = await store.get(String(id || ''))
  if (!meta) {
    const error = new Error('NO_SESSION')
    error.code = 'NO_SESSION'
    error.userMessage = '找不到這個工作階段'
    throw error
  }
  return getClient().request('open', { sessionId: meta.id, meta, cols, rows }, true)
}

async function deleteSession(id) {
  await getClient().request('forget', { sessionId: String(id || '') })
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
