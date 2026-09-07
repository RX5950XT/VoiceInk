'use strict'

const net = require('node:net')
const { spawn } = require('node:child_process')
const { connection, stageRuntime, hostError, PROTOCOL } = require('./host-runtime')
const { readMessages, send } = require('./host')

/** 一個 App 只持有連線；真正的 PTY 由不在安裝目錄裡的宿主持有。 */
class HostClient {
  constructor(userData, emit) {
    this.userData = userData
    this.emit = emit
    this.socket = null
    this.connecting = null
    this.pending = new Map()
    this.nextId = 0
    this.closed = false
  }

  async attach(config) {
    const socket = net.connect(config.pipe)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(hostError()) }, 2000)
      socket.once('connect', () => { clearTimeout(timer); resolve() })
      socket.once('error', (error) => { clearTimeout(timer); reject(error) })
    })
    this.socket = socket
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.socket = null
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(hostError()) }
      this.pending.clear()
    })
    readMessages(socket, (message) => {
      if (message.event === 'terminal:data' || message.event === 'terminal:status') {
        const payload = message.payload
        const valid = typeof payload?.id === 'string' && (message.event === 'terminal:data'
          ? typeof payload.data === 'string' && Number.isSafeInteger(payload.seq) && payload.seq > 0
          : ['running', 'idle', 'exited'].includes(payload.state))
        if (!valid) { socket.destroy(); return }
        this.emit(message.event, payload)
        return
      }
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.ok === true) pending.resolve(message.data)
      else pending.reject(hostError())
    })
    try {
      const reply = await this.send('auth', { token: config.token, protocol: PROTOCOL })
      if (reply?.protocol !== PROTOCOL || this.closed) throw hostError()
    } catch (error) { socket.destroy(); throw error }
  }

  async ensure(start) {
    if (this.closed) throw hostError()
    if (this.connecting) {
      const connected = await this.connecting
      return connected || !start ? connected : this.ensure(true)
    }
    if (this.socket && !this.socket.destroyed) return true
    this.connecting = this.connect(start).finally(() => { this.connecting = null })
    return this.connecting
  }

  async connect(start) {
    const config = connection(this.userData, start)
    if (!config) return false
    try { await this.attach(config); return true }
    catch (error) {
      // 認證或協定出錯不能另起一份，把原本的程序誤當成不見了。
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw hostError()
      if (!start) return false
    }
    const runtime = stageRuntime(config.root)
    const child = spawn(runtime.exe, [runtime.entry, `--user-data-dir=${this.userData}`], {
      cwd: runtime.dir, detached: true, windowsHide: true, stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1', NODE_OPTIONS: '', NODE_PATH: '' }
    })
    let failed = false
    child.once('error', () => { failed = true })
    child.unref()
    const deadline = Date.now() + 15000
    while (Date.now() < deadline && !failed && !this.closed) {
      try { await this.attach(config); return true }
      catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw hostError() }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw hostError()
  }

  send(op, data = {}) {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) { reject(hostError()); return }
      const timer = setTimeout(() => { this.pending.delete(id); reject(hostError('TERMINAL_HOST_TIMEOUT')) }, 10000)
      this.pending.set(id, { resolve, reject, timer })
      send(this.socket, { ...data, id, op })
    })
  }

  async request(op, data = {}, start = false) {
    if (!await this.ensure(start)) return null
    return this.send(op, data)
  }

  disconnect() {
    this.closed = true
    this.socket?.destroy()
  }
}

module.exports = { HostClient }
