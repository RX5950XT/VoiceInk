#!/usr/bin/env node
/**
 * VoiceInk — 管理員終端機的宿主協定實測（node 直跑，**不需要 UAC**）
 *
 * 提權那一段只差在 `Start-Process -Verb RunAs`；管道協定、pty 轉發與「主程序斷線
 * 就自己收掉」這三件事在一般權限下就驗得完，所以這裡自己當一次主程序：
 * 建管道 → 直接 spawn 一份 `--terminal-admin-host=` 的 VoiceInk → 開 shell → 對話 → 收工。
 *
 * 真的要看提權有沒有生效，跑起來的 shell 會印自己的完整性等級（提權時是 High）。
 *
 * 用法：node scripts/probe-terminal-admin.js
 */

'use strict'

const net = require('net')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')

const ROOT = path.join(__dirname, '..')
const ELECTRON = path.join(ROOT, 'node_modules/electron/dist/electron.exe')
const PIPE = `\\\\.\\pipe\\voiceink-term-probe-${crypto.randomBytes(8).toString('hex')}`
const SESSION_ID = 't_probe'
const MARK = 'VOICEINK_PROBE_OK'

let passed = 0
let failed = 0
/** @param {string} name @param {boolean} cond @param {string} detail */
function ok(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  PASS ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  console.log('[管理員終端機宿主]')
  console.log(`  管道 ${PIPE}`)

  /** @type {import('net').Socket | null} */
  let socket = null
  let ready = false
  let output = ''
  let exitCode = null
  let buf = ''

  const server = net.createServer((conn) => {
    socket = conn
    conn.setEncoding('utf8')
    conn.on('data', (chunk) => {
      buf += chunk
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        let msg = null
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.ev === 'ready') ready = true
        else if (msg.ev === 'data') output += msg.data
        else if (msg.ev === 'exit') exitCode = msg.code
      }
    })
  })
  await new Promise((resolve) => server.listen(PIPE, resolve))

  const child = spawn(ELECTRON, [ROOT, `--terminal-admin-host=${PIPE}`], {
    stdio: 'ignore',
    windowsHide: true
  })
  let hostAlive = true
  child.on('exit', () => { hostAlive = false })

  const send = (msg) => socket?.write(`${JSON.stringify(msg)}\n`)
  /** @param {() => boolean} fn @param {number} ms */
  const waitFor = async (fn, ms) => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (fn()) return true
      await sleep(100)
    }
    return false
  }

  ok('宿主連上管道並回報 ready', await waitFor(() => ready, 30000))
  if (!ready) {
    child.kill()
    server.close()
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(1)
  }

  // shell 只送 key：宿主自己解析執行檔，renderer／對面給的路徑一律不採用
  send({ op: 'spawn', id: SESSION_ID, shell: 'powershell', cwd: ROOT, cols: 100, rows: 30 })
  ok('shell 有輸出（提示字元）', await waitFor(() => output.length > 0, 20000))

  await sleep(1500)
  output = ''
  send({ op: 'write', id: SESSION_ID, data: `echo ${MARK}$([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrators'))\r` })
  const echoed = await waitFor(() => output.includes(`${MARK}True`) || output.includes(`${MARK}False`), 20000)
  ok('送進去的指令真的在那顆 shell 跑了', echoed, output.slice(-200))
  console.log(`  （本次是否為管理員：${output.includes(`${MARK}True`) ? '是' : '否，這支 probe 沒有提權，正常'}）`)

  // 不存在的 id 不該讓宿主當掉
  send({ op: 'write', id: 'nope', data: 'x' })
  send({ op: 'resize', id: SESSION_ID, cols: 120, rows: 40 })
  await sleep(300)
  ok('亂送的 id 不影響宿主', hostAlive)

  send({ op: 'kill', id: SESSION_ID })
  ok('kill 之後回報 exit', await waitFor(() => exitCode !== null, 10000))

  // 主程序斷線 → 宿主要自己走，不能留一顆（正式情境下是提權的）shell 在背景
  socket?.destroy()
  server.close()
  ok('主程序斷線後宿主自己結束', await waitFor(() => !hostAlive, 15000))
  if (hostAlive) child.kill()

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
