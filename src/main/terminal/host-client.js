'use strict'

const net = require('node:net')
const { spawn } = require('node:child_process')
const { connection, runtimeName, stageRuntime, hostError, PROTOCOL } = require('./host-runtime')
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
    /** 連上之後才知道：宿主的 pid 與它跑的那份執行環境 */
    this.host = { pid: 0, runtime: '' }
  }

  /**
   * 跑著的宿主是不是更新前的舊程式碼。宿主刻意在 App 更新時活下來（跑著的 shell 才不會
   * 被拖走），代價是 `pty.js` 那一側的修正**永遠不會生效**，除非它重開一次。
   * @param {string} [wanted] 這一版想要的執行環境名（測試用；正式路徑自己算）
   * @returns {boolean} 沒連上時回 false（沒有宿主就沒有舊程式碼）
   */
  stale(wanted = '') {
    if (!this.socket || this.socket.destroyed) return false
    try { return this.host.runtime !== (wanted || runtimeName().name) }
    catch { return false }
  }

  /**
   * 把宿主收掉再連一份新的。**跑著的 shell 會一起結束**，所以呼叫端要先問過使用者
   * （見 `service.js` 的 `restartHost`）。
   *
   * 用 pid 直接收，不另外開一個 op：舊版宿主根本不認得新的 op，而會卡在舊程式碼的
   * 正是它們。
   * @returns {Promise<boolean>}
   */
  async restart() {
    const pid = this.host.pid
    if (!pid) return false
    try { process.kill(pid) } catch { /* 已經不在了，照樣往下重連 */ }
    this.socket?.destroy()
    this.socket = null
    this.host = { pid: 0, runtime: '' }
    // 管道要等舊程序真的放掉，不然會連回同一個正在收尾的宿主
    for (let i = 0; i < 50; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 100))
      try { process.kill(pid, 0) } catch { break }
    }
    return this.ensure(true)
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
        // 標題與 cwd 是宿主從 PTY 輸出裡撈出來的（前景程式自己講的），型別一樣要驗：
        // 收進來之後會進分頁標題，也會當成連結解析的基準路徑。
        const text = (value, max) => value === undefined || (typeof value === 'string' && value.length <= max)
        const valid = typeof payload?.id === 'string' && (message.event === 'terminal:data'
          ? typeof payload.data === 'string' && Number.isSafeInteger(payload.seq) && payload.seq > 0
          : ['running', 'idle', 'exited'].includes(payload.state)
            && text(payload.title, 200) && text(payload.cwd, 260))
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
      // 舊版宿主不回報 runtime／pid，留空字串與 0：`stale()` 會把它當成舊版。
      this.host = { pid: Number.isSafeInteger(reply.pid) ? reply.pid : 0, runtime: typeof reply.runtime === 'string' ? reply.runtime : '' }
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
