#!/usr/bin/env node
/**
 * VoiceInk — 管理員終端機的提權路徑實測（**會跳一次 UAC**）
 *
 * `probe-terminal-admin.js` 驗的是管道協定（不提權也跑得完），這一支專門驗剩下那一段：
 * `Start-Process -Verb RunAs` 真的把 host 拉到管理員權限，開出來的 shell 完整性等級是 High。
 * 走的是正式那條 `admin.spawnAdmin()`，不是另外抄一份命令。
 *
 * 用法：node_modules/electron/dist/electron.exe scripts/probe-terminal-admin-elevate.js
 */

'use strict'

const path = require('path')
const { app } = require('electron')

const ROOT = path.join(__dirname, '..')
const admin = require(path.join(ROOT, 'src/main/terminal/admin.js'))
const MARK = 'VOICEINK_ELEVATED='

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  console.log('[管理員終端機提權路徑]')
  console.log('  接下來會跳一次 UAC，請按「是」')

  let output = ''
  let exited = null
  const term = admin.spawnAdmin(
    { id: 't_probe_elevate', shell: 'powershell', cwd: ROOT },
    100,
    30
  )
  term.onData((d) => { output += d })
  term.onExit((e) => { exited = e.exitCode })

  const waitFor = async (fn, ms) => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (fn()) return true
      await sleep(200)
    }
    return false
  }

  ok('取得授權並開出 shell', await waitFor(() => output.includes('已取得系統管理員權限'), 120000), output.slice(-200))
  ok('shell 有提示字元', await waitFor(() => output.length > 60, 20000))

  await sleep(1500)
  output = ''
  term.write(`echo ${MARK}$([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrators'))\r`)
  await waitFor(() => output.includes(`${MARK}True`) || output.includes(`${MARK}False`), 30000)
  ok('那顆 shell 真的是管理員', output.includes(`${MARK}True`), output.slice(-200))

  term.kill()
  ok('kill 之後回報 exit', await waitFor(() => exited !== null, 15000))

  admin.shutdown()
  await sleep(1000)

  console.log(`\n${passed} passed, ${failed} failed`)
  app.exit(failed === 0 ? 0 : 1)
}

app.whenReady().then(main).catch((err) => {
  console.error(err)
  app.exit(1)
})
