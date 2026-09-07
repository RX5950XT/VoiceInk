'use strict'

const net = require('node:net')
const crypto = require('node:crypto')
const path = require('node:path')
const { connection, PROTOCOL } = require('./host-runtime')
const terminal = require('./pty')
const store = require('./store')

const MAX_FRAME = 4 * 1024 * 1024
const VALID_ID = /^[A-Za-z0-9_-]{1,80}$/

/** 有上限的 JSON 行，壞封包不能默默略過後繼續執行。 */
function readMessages(socket, receive) {
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    buffer += chunk
    let end
    while ((end = buffer.indexOf('\n')) >= 0) {
      if (end > MAX_FRAME) { socket.destroy(); return }
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      let message
      try { message = JSON.parse(line) } catch { socket.destroy(); return }
      if (!message || typeof message !== 'object' || Array.isArray(message)) { socket.destroy(); return }
      receive(message)
      if (socket.destroyed) return
    }
    if (buffer.length > MAX_FRAME) socket.destroy()
  })
}

function send(socket, message) {
  if (socket.destroyed) return
  if (socket.writableLength > MAX_FRAME) { socket.destroy(); return }
  socket.write(`${JSON.stringify(message)}\n`)
}

function dispatch(message) {
  const id = message.sessionId
  if (message.op === 'list') return terminal.sessionStates()
  if (typeof id !== 'string' || !VALID_ID.test(id)) throw new Error('BAD_REQUEST')
  if (message.op === 'open') {
    if (message.meta?.id !== id) throw new Error('BAD_REQUEST')
    if (!terminal.sessionStates().some(item => item.id === id) && terminal.sessionStates().length >= store.MAX_SESSIONS) throw new Error('SESSION_LIMIT')
    const meta = store.sanitizeAll([message.meta])[0]
    if (!meta) throw new Error('BAD_REQUEST')
    return terminal.openSessionWithMeta(meta, message.cols, message.rows)
  }
  if (message.op === 'write') {
    if (typeof message.data !== 'string' || message.data.length > terminal.MAX_WRITE_CHARS) throw new Error('BAD_REQUEST')
    return terminal.writeSession(id, message.data)
  }
  if (message.op === 'resize') return terminal.resizeSession(id, message.cols, message.rows)
  if (message.op === 'kill') return terminal.killSession(id)
  if (message.op === 'forget') return terminal.forgetSession(id)
  throw new Error('BAD_REQUEST')
}

function run(userData) {
  const config = connection(userData)
  if (!config) throw new Error('HOST_CONFIG')
  require('./admin').configureRuntime({ exe: process.execPath, entry: path.join(__dirname, 'host.js') })
  const clients = new Set()
  const sockets = new Set()
  let idleTimer
  const idle = () => {
    clearTimeout(idleTimer)
    if (!clients.size && !terminal.sessionStates().length) {
      idleTimer = setTimeout(() => server.close(() => process.exit(0)), 5000)
    }
  }
  terminal.setEmitter((event, payload) => {
    for (const socket of clients) send(socket, { event, payload })
  })
  const server = net.createServer((socket) => {
    if (sockets.size >= 8) { socket.destroy(); return }
    sockets.add(socket)
    const timeout = setTimeout(() => socket.destroy(), 5000)
    socket.on('error', () => socket.destroy())
    socket.on('close', () => { clearTimeout(timeout); sockets.delete(socket); clients.delete(socket); idle() })
    readMessages(socket, (message) => {
      if (!Number.isSafeInteger(message.id) || message.id < 1) { socket.destroy(); return }
      if (!clients.has(socket)) {
        if (message.op !== 'auth' || message.protocol !== PROTOCOL || typeof message.token !== 'string'
          || !/^[a-f0-9]{64}$/.test(message.token)
          || !crypto.timingSafeEqual(Buffer.from(message.token), Buffer.from(config.token))) { socket.destroy(); return }
        clearTimeout(timeout)
        clearTimeout(idleTimer)
        clients.add(socket)
        send(socket, { id: message.id, ok: true, data: { protocol: PROTOCOL, pid: process.pid } })
        return
      }
      try { send(socket, { id: message.id, ok: true, data: dispatch(message) }) }
      catch { send(socket, { id: message.id, ok: false, error: { code: 'TERMINAL_HOST_REQUEST' } }) }
    })
  })
  server.on('error', () => process.exit(1))
  server.listen(config.pipe, idle)
}

if (require.main === module) {
  const adminArg = process.argv.find(arg => arg.startsWith('--terminal-admin-host='))
  if (adminArg) require('./admin-host').run(adminArg.slice('--terminal-admin-host='.length))
  else {
    const arg = process.argv.find(value => value.startsWith('--user-data-dir='))
    if (!arg) process.exit(1)
    try { run(arg.slice('--user-data-dir='.length)) } catch { process.exit(1) }
  }
}

module.exports = { readMessages, send, MAX_FRAME, dispatch }
