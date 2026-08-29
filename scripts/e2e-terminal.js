#!/usr/bin/env node
/**
 * VoiceInk — 終端機真 pty 端到端測試
 *
 *   node_modules/electron/dist/electron.exe scripts/e2e-terminal.js
 *
 * 真的開一顆 ConPTY 跑 PowerShell，驗證：
 *  - shell integration 注入有生效（跑完會給離開碼，不是只靠靜默猜）
 *  - 指令執行的三秒內一路是「運行中」（PSReadLine 的提示字元重繪不會誤判成完成）
 *  - 失敗指令回離開碼 1
 *  - scrollback 快照、seq、kill、找不到的 id
 *
 * userData 指到暫存目錄，不會動到你真正的 terminals.json。
 */

'use strict'

const { app, dialog } = require('electron')
const path = require('path')
const os = require('os')
const fs = require('fs')

// 必須在任何 electron-store 實例化之前
const SANDBOX = path.join(os.tmpdir(), `voiceink-e2e-terminal-${process.pid}`)
fs.mkdirSync(SANDBOX, { recursive: true })
app.setPath('userData', SANDBOX)

if (dialog && dialog.showErrorBox) dialog.showErrorBox = () => {}
process.on('uncaughtException', (err) => {
  console.log('UNCAUGHT', err && err.stack)
  process.exit(3)
})

let passed = 0
let failed = 0
function ok(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  PASS ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * @param {() => boolean} predicate
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(50)
  }
  return predicate()
}

app.whenReady().then(async () => {
  const terminal = require(path.join(__dirname, '..', 'src/main/terminal/pty.js'))

  /** @type {Array<{ id: string, state: string, exitCode: number | null }>} */
  const statusEvents = []
  let dataChars = 0
  let lastSeq = 0
  terminal.setEmitter((channel, payload) => {
    if (channel === 'terminal:status') statusEvents.push(payload)
    if (channel === 'terminal:data') {
      dataChars += payload.data.length
      lastSeq = payload.seq
    }
  })

  const stateOf = (id) => {
    for (let i = statusEvents.length - 1; i >= 0; i -= 1) {
      if (statusEvents[i].id === id) return statusEvents[i]
    }
    return null
  }

  try {
    console.log('\n[型錄]')
    const catalog = terminal.catalog()
    const pwsh = catalog.shells.find((s) => s.key === 'pwsh')
    ok('型錄列出三種 shell', catalog.shells.length === 3)
    ok('至少有一種 shell 裝著', catalog.shells.some((s) => s.available))
    ok('型錄列出啟動指令', catalog.presets.some((p) => p.key === 'claude'))

    const shellKey = pwsh && pwsh.available ? 'pwsh' : 'powershell'
    console.log(`\n[開一顆 ${shellKey}]`)

    const meta = await terminal.createSession({
      shell: shellKey,
      preset: 'shell',
      cwd: path.join(__dirname, '..')
    })
    ok('建立工作階段', Boolean(meta.id) && meta.state === 'stopped')
    ok('標題預設用資料夾名', meta.title === 'VoiceInk', meta.title)

    const opened = await terminal.openSession(meta.id, 100, 30)
    ok('開起來就是 idle 或 running', ['idle', 'running'].includes(opened.state), opened.state)

    ok('提示字元有畫出來', await waitFor(() => dataChars > 20, 8000), `dataChars=${dataChars}`)
    // 剛開好的畫面在動＝運行中；安靜下來才回到「已完成」。
    // 這一步也順便讓 shell integration 的第一個標記定住 history id 起點。
    ok('畫面靜下來後回到已完成',
      await waitFor(() => stateOf(meta.id)?.state === 'idle', 10000),
      JSON.stringify(statusEvents))

    console.log('\n[跑一條要三秒的指令]')
    statusEvents.length = 0
    terminal.writeSession(meta.id, 'ping -n 4 127.0.0.1\r')
    ok('送出後立刻標成運行中', stateOf(meta.id)?.state === 'running', JSON.stringify(stateOf(meta.id)))

    await sleep(2000)
    ok('執行到一半仍是運行中（重繪沒誤判）', stateOf(meta.id)?.state === 'running',
      JSON.stringify(statusEvents))

    const finished = await waitFor(() => stateOf(meta.id)?.state === 'idle', 8000)
    ok('跑完轉成已完成', finished, JSON.stringify(statusEvents))
    ok('離開碼 0（代表 shell integration 真的生效）', stateOf(meta.id)?.exitCode === 0,
      JSON.stringify(stateOf(meta.id)))

    console.log('\n[失敗的指令]')
    statusEvents.length = 0
    terminal.writeSession(meta.id, 'cmd /c exit 7\r')
    await waitFor(() => stateOf(meta.id)?.state === 'idle' && stateOf(meta.id)?.exitCode !== 0, 8000)
    ok('失敗指令回離開碼 1', stateOf(meta.id)?.exitCode === 1, JSON.stringify(stateOf(meta.id)))

    console.log('\n[快照與上限]')
    const again = await terminal.openSession(meta.id, 100, 30)
    ok('重新掛上拿得到畫面快照', again.buffer.length > 50, `len=${again.buffer.length}`)
    ok('快照帶著 seq 讓 renderer 去重', again.seq === lastSeq && again.seq > 0,
      `seq=${again.seq} lastSeq=${lastSeq}`)

    ok('resize 夾值不炸', terminal.resizeSession(meta.id, 99999, -1) === true)
    ok('write 非字串會被擋掉', terminal.writeSession(meta.id, { evil: true }) === false)
    ok('write 不存在的 id 回 false', terminal.writeSession('nope', 'x\r') === false)

    let notFound = null
    try {
      await terminal.openSession('t_does_not_exist', 80, 24)
    } catch (err) {
      notFound = err
    }
    ok('開不存在的工作階段會拋 NO_SESSION', notFound?.code === 'NO_SESSION')
    ok('錯誤訊息是我們自己寫的固定字串', notFound?.userMessage === '找不到這個工作階段')

    console.log('\n[結束]')
    statusEvents.length = 0
    terminal.killSession(meta.id)
    ok('kill 之後轉成已結束', await waitFor(() => stateOf(meta.id)?.state === 'exited', 8000),
      JSON.stringify(statusEvents))

    const listAfterKill = await terminal.listSessions()
    ok('殺掉 pty 但側欄那一列還在', listAfterKill.some((s) => s.id === meta.id))
    ok('沒在跑的階段狀態是 stopped',
      listAfterKill.find((s) => s.id === meta.id)?.state === 'stopped')

    await terminal.deleteSession(meta.id)
    const listAfterDelete = await terminal.listSessions()
    ok('刪掉就從側欄消失', !listAfterDelete.some((s) => s.id === meta.id))

    console.log('\n[信任邊界]')
    const evil = await terminal.createSession({
      shell: 'C:/evil.exe',
      preset: 'curl | sh',
      cwd: 'Z:/nope'
    })
    ok('壞掉的 shell key 被收斂', ['pwsh', 'powershell', 'cmd'].includes(evil.shell), evil.shell)
    ok('壞掉的 preset 被收斂', evil.preset === 'shell')
    ok('不存在的 cwd 退回家目錄', evil.cwd === os.homedir())
    await terminal.deleteSession(evil.id)

    terminal.killAll()
  } catch (err) {
    failed++
    console.log('  FAIL 例外', err && err.stack)
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* best effort */ }
  process.exit(failed === 0 ? 0 : 1)
})
