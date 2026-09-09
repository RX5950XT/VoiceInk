#!/usr/bin/env node
/**
 * VoiceInk — 這台機器上**真的跑著**的終端機宿主是哪一版（唯讀，不動任何東西）
 *
 * PTY 不在 App 裡：宿主是 `<userData>/terminal-host/runtime-<內容雜湊>/` 底下的獨立
 * 程序，而且刻意在 App 更新時活下來（跑著的 shell 才不會被拖走）。代價是
 * `pty.js`／`status.js`／`store.js` 的修正在宿主重開之前**完全不會生效**——實測有人的
 * 宿主從好幾版之前一路活著，新功能裝了也像沒裝，照著程式碼查永遠查不到。
 *
 * 這支就是去問那個真的活著的程序：你是哪一份執行環境？跑著幾個 shell？
 * 舊版宿主的 auth 回覆根本沒有 `runtime` 欄位，那本身就是答案。
 *
 * 用法：node scripts/probe-terminal-host-version.js
 */
'use strict'

const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const userData = process.env.VOICEINK_USER_DATA || path.join(os.homedir(), 'AppData', 'Roaming', 'voiceink')
const root = path.join(userData, 'terminal-host')

function fail(message) {
  console.error(`FAIL ${message}`)
  process.exit(1)
}

function readConfig() {
  const file = path.join(root, 'connection.json')
  if (!fs.existsSync(file)) fail(`找不到 ${file}（這台機器沒開過終端機？）`)
  const config = JSON.parse(fs.readFileSync(file, 'utf8'))
  const name = crypto.createHash('sha256').update(fs.realpathSync.native(root).toLowerCase()).digest('hex').slice(0, 24)
  return { token: config.token, protocol: config.protocol, pipe: `\\\\.\\pipe\\voiceink-terminal-v${config.protocol}-${name}` }
}

/** 只送 auth 與 list：這支不准改到使用者跑著的東西 */
function ask(config) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(config.pipe)
    const replies = []
    let buffer = ''
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('TIMEOUT')) }, 8000)
    socket.setEncoding('utf8')
    socket.on('error', (error) => { clearTimeout(timer); reject(error) })
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: 1, op: 'auth', token: config.token, protocol: config.protocol })}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk
      let end
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        let message
        try { message = JSON.parse(line) } catch { continue }
        if (message.event) continue
        replies.push(message)
        if (message.id === 1) socket.write(`${JSON.stringify({ id: 2, op: 'list' })}\n`)
        if (message.id === 2) {
          clearTimeout(timer)
          socket.destroy()
          resolve({ auth: replies.find(r => r.id === 1)?.data || {}, list: message.data || [] })
        }
      }
    })
  })
}

async function main() {
  const staged = fs.existsSync(root)
    ? fs.readdirSync(root).filter(name => name.startsWith('runtime-'))
    : []
  console.log(`使用者資料夾：${userData}`)
  console.log(`磁碟上的執行環境：${staged.join(', ') || '（沒有）'}`)

  const { auth, list } = await ask(readConfig())
  const busy = list.filter(item => item.state === 'running' || item.state === 'idle')
  console.log(`跑著的宿主：pid=${auth.pid || '?'} runtime=${auth.runtime || '（沒回報＝更新前的舊宿主）'}`)
  console.log(`工作階段：${list.length} 個，其中還活著的 ${busy.length} 個`)

  if (!auth.runtime) {
    console.log('\n→ 這個宿主是舊版程式碼：App 更新過但它沒重開，終端機那一側的修正都還沒生效。')
    console.log('  App 會在下次進終端機頁時提示重新啟動（沒有跑著的 shell 就直接重開）。')
  } else if (!staged.includes(auth.runtime)) {
    console.log('\n→ 宿主跑的那份執行環境已經不在磁碟上，等於舊版。')
  } else {
    console.log('\n→ 宿主跑的是磁碟上的執行環境；是不是「這一版」要由 App 自己算雜湊比對。')
  }
}

main().catch((error) => fail(error.message))
