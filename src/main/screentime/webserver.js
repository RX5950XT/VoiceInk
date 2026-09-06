'use strict'

/**
 * 相容 Tai 瀏覽器外掛：ws://127.0.0.1:8908/TaiWebSentry
 * 只收文字 JSON 與純文字 ping；只綁 127.0.0.1。
 */

const http = require('http')
const crypto = require('crypto')
const { WS_PORT, WS_PATH, sanitizeWebNotify } = require('./util')

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_FRAME = 64 * 1024

function acceptKey(key) {
  return crypto.createHash('sha1').update(String(key) + GUID).digest('base64')
}

/**
 * @param {Buffer} buf
 * @returns {{ opcode: number, payload: Buffer, rest: Buffer } | null}
 */
function decodeFrame(buf) {
  if (buf.length < 2) return null
  const opcode = buf[0] & 0x0f
  const masked = (buf[1] & 0x80) !== 0
  let len = buf[1] & 0x7f
  let offset = 2
  if (len === 126) {
    if (buf.length < 4) return null
    len = buf.readUInt16BE(2)
    offset = 4
  } else if (len === 127) {
    return { opcode: 8, payload: Buffer.alloc(0), rest: Buffer.alloc(0) }
  }
  if (len > MAX_FRAME) {
    return { opcode: 8, payload: Buffer.alloc(0), rest: Buffer.alloc(0) }
  }
  const maskLen = masked ? 4 : 0
  if (buf.length < offset + maskLen + len) return null
  let payload = buf.subarray(offset + maskLen, offset + maskLen + len)
  if (masked) {
    const mask = buf.subarray(offset, offset + 4)
    payload = Buffer.from(payload)
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
  }
  return { opcode, payload, rest: buf.subarray(offset + maskLen + len) }
}

/**
 * @param {{ onNotify: (rec: ReturnType<typeof sanitizeWebNotify>) => void, port?: number, host?: string }} deps
 */
function createWebServer(deps = {}) {
  const onNotify = deps.onNotify || (() => {})
  const port = deps.port || WS_PORT
  const host = deps.host || '127.0.0.1'
  /** @type {import('http').Server | null} */
  let server = null
  /** @type {Set<import('net').Socket>} */
  const sockets = new Set()
  let lastError = ''

  function handleSocket(socket) {
    sockets.add(socket)
    let buf = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      if (buf.length > MAX_FRAME * 4) { socket.destroy(); return }
      let frame = decodeFrame(buf)
      while (frame) {
        buf = frame.rest
        if (frame.opcode === 8) { socket.end(); return }
        if (frame.opcode === 9) {
          const pong = Buffer.concat([Buffer.from([0x8a, frame.payload.length]), frame.payload])
          socket.write(pong)
        } else if (frame.opcode === 1) {
          const text = frame.payload.toString('utf8')
          if (text && text !== 'ping') {
            try {
              const rec = sanitizeWebNotify(JSON.parse(text))
              if (rec) onNotify(rec)
            } catch { /* ping 或壞 JSON */ }
          }
        }
        frame = decodeFrame(buf)
      }
    })
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => sockets.delete(socket))
  }

  function start() {
    if (server) return Promise.resolve({ ok: true, port })
    lastError = ''
    return new Promise((resolve) => {
      const httpServer = http.createServer((_req, res) => {
        res.writeHead(404)
        res.end()
      })
      httpServer.on('upgrade', (req, socket) => {
        const url = req.url || ''
        const pathOnly = url.split('?')[0]
        if (pathOnly !== WS_PATH) { socket.destroy(); return }
        const key = req.headers['sec-websocket-key']
        if (!key) { socket.destroy(); return }
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
        )
        handleSocket(socket)
      })
      httpServer.on('error', (err) => {
        lastError = err.code === 'EADDRINUSE' ? 'in-use' : 'listen-failed'
        server = null
        resolve({ ok: false, error: lastError, port })
      })
      httpServer.listen(port, host, () => {
        server = httpServer
        lastError = ''
        resolve({ ok: true, port })
      })
    })
  }

  function stop() {
    for (const socket of sockets) {
      try { socket.destroy() } catch { /* ignore */ }
    }
    sockets.clear()
    const current = server
    server = null
    if (!current) return Promise.resolve()
    return new Promise((resolve) => current.close(() => resolve()))
  }

  return {
    start,
    stop,
    get listening() { return Boolean(server) },
    get lastError() { return lastError },
    get clients() { return sockets.size }
  }
}

module.exports = { createWebServer, acceptKey, decodeFrame }
