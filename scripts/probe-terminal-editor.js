'use strict'

/**
 * Ctrl+G 的編輯器橋接：**真的把那支 batch 跑起來**，走完 CLI 會走的整條路。
 *
 * mock 證明不了對面長什麼樣：Claude Code 是 `spawnSync(\`${EDITOR} "檔案"\`,
 * { shell: true })` 同步等編輯器結束，所以這裡也照樣用 `cmd /c` 跑，然後量四件事：
 *
 *  [A] batch 會卡住（沒人按送出就不會自己結束）
 *  [B] main 收得到請求，內容就是那個檔案現在的樣子
 *  [C] 按下送出＝內容寫回原檔，而且那支 batch 真的退出了（CLI 才拿得回內容）
 *  [D] 取消（關分頁）也要放它走，不然 CLI 會永遠停在 Ctrl+G
 *  [E] 上一輪留下來的請求不開分頁，但一樣要放走
 *  [F] `EDITOR=notepad`（＝CLI 的預設值）不算「使用者挑過編輯器」，橋接照樣接手
 *
 * 用法：node scripts/probe-terminal-editor.js
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const bridge = require('../src/main/terminal/editor-bridge')

let passed = 0
const ok = (label) => { passed += 1; console.log(`  PASS ${label}`) }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 等到 check() 回真，或逾時 */
async function until(check, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await sleep(120)
  }
  return null
}

async function main() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-editbridge-'))
  const target = path.join(userData, '提示詞.md')
  fs.writeFileSync(target, '原本的提示詞\n', 'utf8')

  bridge.configure(userData)
  const command = bridge.shimCommand()
  assert.ok(command.startsWith('"') && command.endsWith('.cmd"'), `EDITOR 要是帶引號的 .cmd 路徑：${command}`)
  const shim = command.slice(1, -1)
  assert.ok(fs.existsSync(shim), 'batch 要真的落在磁碟上')
  ok('EDITOR 指到一支存在的 .cmd（路徑自己帶引號）')

  /** @type {object[]} */
  const events = []
  bridge.start((channel, payload) => events.push({ channel, payload }))

  // ── CLI 那一端：跟 Claude Code 一模一樣的叫法 ──
  let exited = null
  const child = spawn(`${command} "${target}"`, { shell: true, stdio: 'ignore', windowsHide: true })
  child.on('exit', (code) => { exited = code })

  const request = await until(() => events.find((e) => e.channel === 'terminal:editRequest')?.payload)
  assert.ok(request, 'main 要收到編輯請求')
  assert.equal(request.content, '原本的提示詞\n', '請求要帶著檔案現在的內容')
  ok('[B] main 收到請求，內容一個字都沒變（中文檔名那條路也走得過）')

  await sleep(1500)
  assert.equal(exited, null, 'batch 在使用者按送出之前不可以結束（CLI 會以為編完了）')
  ok('[A] 沒按送出時那支 batch 一直卡著')

  // ── 使用者按了送出 ──
  assert.equal(bridge.submit(request.id, '改過的提示詞\n'), true)
  const done = await until(() => exited !== null)
  assert.ok(done, 'batch 要在送出之後結束')
  assert.equal(fs.readFileSync(target, 'utf8'), '改過的提示詞\n', '內容要寫回原檔')
  ok('[C] 送出後檔案更新，batch 退出（CLI 拿得回內容）')

  // ── 取消（使用者關掉分頁）──
  events.length = 0
  let exited2 = null
  const child2 = spawn(`${command} "${target}"`, { shell: true, stdio: 'ignore', windowsHide: true })
  child2.on('exit', () => { exited2 = true })
  const request2 = await until(() => events.find((e) => e.channel === 'terminal:editRequest')?.payload)
  assert.ok(request2, '第二次也要收得到請求')
  assert.equal(bridge.cancel(request2.id), true)
  assert.ok(await until(() => exited2), '取消也要放走那支 batch')
  assert.equal(fs.readFileSync(target, 'utf8'), '改過的提示詞\n', '取消不可以動到檔案')
  ok('[D] 取消放走 CLI，且一個位元組都沒動')

  // ── 上一輪留下來的請求 ──
  bridge.stop()
  const requests = path.join(userData, 'editor-bridge', 'requests')
  const stale = path.join(requests, '424242.in')
  fs.writeFileSync(stale, `${target}\n`, 'utf8')
  fs.utimesSync(stale, new Date(Date.now() - 600000), new Date(Date.now() - 600000))
  events.length = 0
  bridge.start((channel, payload) => events.push({ channel, payload }))
  await sleep(400)
  assert.equal(events.length, 0, '過期的請求不可以開分頁（App 重開後跳出幽靈分頁）')
  assert.ok(fs.existsSync(path.join(requests, '424242.done')), '過期的請求還是要補 .done 放走那支 batch')
  ok('[E] 上一輪留下來的請求：不開分頁，但一樣放走')

  // ── 接不接手：EDITOR=notepad 等同沒設 ──
  assert.equal(bridge.isRealEditor(''), false)
  assert.equal(bridge.isRealEditor('notepad'), false, 'EDITOR=notepad 是 CLI 的預設值，不是使用者挑的')
  assert.equal(bridge.isRealEditor('Notepad.exe'), false)
  assert.equal(bridge.isRealEditor('"C:\\Windows\\System32\\notepad.exe"'), false)
  assert.equal(bridge.isRealEditor('start /wait notepad'), false)
  assert.equal(bridge.isRealEditor('vim'), true, '設過 vim 的人按 Ctrl+G 本來就該進 vim')
  assert.equal(bridge.isRealEditor('notepad++.exe'), true, 'Notepad++ 是另一支編輯器，不可以一起吃掉')
  const env = { EDITOR: 'notepad', VISUAL: 'notepad' }
  const before = { EDITOR: process.env.EDITOR, VISUAL: process.env.VISUAL }
  Object.assign(process.env, env)
  try {
    const shell = require('../src/main/terminal/pty').shellEnvironment(command)
    // 兩個都要蓋：Claude Code 與 Codex 都先看 VISUAL，只蓋 EDITOR 會被它壓過去
    assert.equal(shell.EDITOR, command, 'EDITOR 要被橋接蓋掉')
    assert.equal(shell.VISUAL, command, 'VISUAL 也要被蓋掉')
  } finally {
    for (const key of ['EDITOR', 'VISUAL']) {
      if (before[key] === undefined) delete process.env[key]
      else process.env[key] = before[key]
    }
  }
  ok('[F] EDITOR／VISUAL 是 notepad 時橋接照樣接手，真的編輯器則放行')

  bridge.stop()
  try { fs.rmSync(userData, { recursive: true, force: true }) } catch { /* 暫存目錄清不掉就算了 */ }
  console.log(`\n${passed} passed, 0 failed`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
