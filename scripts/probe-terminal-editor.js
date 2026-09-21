'use strict'

/**
 * Ctrl+G 的編輯器橋接：**真的把那支 batch 跑起來**，走完 CLI 會走的整條路。
 *
 * mock 證明不了對面長什麼樣：Claude Code 是 `spawnSync(\`${EDITOR} "檔案"\`,
 * { shell: true })` 同步等編輯器結束，所以這裡也照樣用 `cmd /c` 跑，然後一項一項量：
 *
 *  [A] batch 會卡住（沒關掉分頁就不會自己結束）
 *  [B] main 收得到請求，內容就是那個檔案現在的樣子
 *  [C] 按下儲存只把內容留著：batch 還卡著、原檔一個字都沒動（分頁還開著要能再改）
 *  [C2] 關掉分頁才寫回原檔（寫的是最後存的那份）並放走 batch
 *  [G] 放走過的請求不可以再發一次（不然關掉的分頁會自己跳回來）
 *  [D] 沒存過就關掉也要放它走，而且一個位元組都不准動
 *  [E] 上一輪留下來的請求不開分頁，但一樣要放走
 *  [F] `EDITOR=notepad`（＝CLI 的預設值）不算「使用者挑過編輯器」，橋接照樣接手
 *  [F2] 環境裡同時有 `PATH` 與 `Path` 時收成一個鍵（不然子程序拿到兩份，生效的看運氣）
 *
 * 用法：node scripts/probe-terminal-editor.js
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { tempDir, removeTree } = require('./lib/test-temp')
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
  const userData = tempDir('voiceink-editbridge-')
  const target = path.join(userData, '提示詞.md')
  fs.writeFileSync(target, '原本的提示詞\n', 'utf8')

  bridge.configure(userData)
  const command = bridge.shimCommand()
  assert.equal(command, 'voiceink-edit.cmd', `EDITOR 必須是不含空白的短檔名：${command}`)
  const folder = bridge.shimDir()
  const shim = path.join(folder, command)
  assert.ok(fs.existsSync(shim), 'batch 要真的落在磁碟上')
  ok('EDITOR 是短檔名 voiceink-edit.cmd，完整路徑靠 PATH')

  /** @type {object[]} */
  const events = []
  bridge.start((channel, payload) => events.push({ channel, payload }))

  // ── CLI 那一端：跟 Claude Code 一模一樣的叫法 ──
  let exited = null
  const child = spawn(`"${shim}" "${target}"`, { shell: true, stdio: 'ignore', windowsHide: true })
  child.on('exit', (code) => { exited = code })

  const request = await until(() => events.find((e) => e.channel === 'terminal:editRequest')?.payload)
  assert.ok(request, 'main 要收到編輯請求')
  assert.equal(request.content, '原本的提示詞\n', '請求要帶著檔案現在的內容')
  ok('[B] main 收到請求，內容一個字都沒變（中文檔名那條路也走得過）')

  await sleep(1500)
  assert.equal(exited, null, 'batch 在使用者關掉分頁之前不可以結束（CLI 會以為編完了）')
  ok('[A] 沒關掉分頁時那支 batch 一直卡著')

  // ── 使用者按了儲存：分頁還開著，CLI 也還要繼續等 ──
  assert.equal(bridge.save(request.id, '改過的提示詞\n'), true)
  await sleep(1500)
  assert.equal(exited, null, '儲存不可以放走 batch（分頁還開著，使用者可能還要再改）')
  assert.equal(fs.readFileSync(target, 'utf8'), '原本的提示詞\n', '儲存還沒動到原檔')
  ok('[C] 儲存只留著內容，CLI 繼續等（分頁沒被收掉）')

  // 再存一次：最後一次存的那份才算數
  assert.equal(bridge.save(request.id, '再改一次\n'), true)

  // ── 使用者關掉分頁＝送回終端機 ──
  const beforeClose = events.length
  assert.equal(bridge.cancel(request.id), true)
  const done = await until(() => exited !== null)
  assert.ok(done, 'batch 要在關掉分頁之後結束')
  assert.equal(fs.readFileSync(target, 'utf8'), '再改一次\n', '關掉分頁才把最後存的那份寫回原檔')
  ok('[C2] 關掉分頁後檔案更新成最後存的那份，batch 退出（CLI 拿得回內容）')

  // 放走過的請求不可以再發一次。`.done` 一落地就叫醒 fs.watch，而 batch 每秒才看一次，
  // 掃描當下 `<id>.in` 還在磁碟上——不擋的話使用者關掉的分頁會當場自己跳回來。
  await sleep(1500)
  const again = events.slice(beforeClose).filter((e) => e.channel === 'terminal:editRequest')
  assert.equal(again.length, 0, `關掉之後又發了 ${again.length} 次編輯請求（分頁會自己跳回來）`)
  ok('[G] 關掉之後不會再發同一筆請求（分頁不會自己跳回來）')

  // ── 什麼都沒存就關掉 ──
  events.length = 0
  let exited2 = null
  const child2 = spawn(`"${shim}" "${target}"`, { shell: true, stdio: 'ignore', windowsHide: true })
  child2.on('exit', () => { exited2 = true })
  const request2 = await until(() => events.find((e) => e.channel === 'terminal:editRequest')?.payload)
  assert.ok(request2, '第二次也要收得到請求')
  assert.equal(bridge.cancel(request2.id), true)
  assert.ok(await until(() => exited2), '取消也要放走那支 batch')
  assert.equal(fs.readFileSync(target, 'utf8'), '再改一次\n', '沒存過就關掉不可以動到檔案')
  ok('[D] 沒存過就關掉：放走 CLI，且一個位元組都沒動')

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
    const shell = require('../src/main/terminal/pty').shellEnvironment(command, folder)
    // 兩個都要蓋：Claude Code 與 Codex 都先看 VISUAL，只蓋 EDITOR 會被它壓過去
    assert.equal(shell.EDITOR, command, 'EDITOR 要被橋接蓋掉')
    assert.equal(shell.VISUAL, command, 'VISUAL 也要被蓋掉')
    // PATH 只能有一個鍵。Windows 的環境變數不分大小寫，而 `{ ...process.env }` 展開出來
    // 的是系統寫的原字（實測是 `Path`）——多寫一個 `PATH` 等於子程序拿到兩份，**生效的是
    // 後寫進去的那個**，整條系統路徑被蓋成 `<editor-bridge>;`，終端機裡 node／python／
    // System32 全部找不到（Claude Code 會噴 `SessionStart hook: node: command not found`）。
    const pathKeys = Object.keys(shell).filter((key) => key.toLowerCase() === 'path')
    assert.equal(pathKeys.length, 1, `PATH 只能有一個鍵，現在有 ${pathKeys.join('／')}`)
    const shellPath = shell[pathKeys[0]]
    assert.ok(shellPath.startsWith(`${folder}${path.delimiter}`), 'PATH 最前面要是 editor-bridge 資料夾')
    const inherited = process.env.PATH || process.env.Path || ''
    if (inherited) assert.ok(shellPath.endsWith(inherited), '原本的 PATH 要原封不動接在後面')
  } finally {
    for (const key of ['EDITOR', 'VISUAL']) {
      if (before[key] === undefined) delete process.env[key]
      else process.env[key] = before[key]
    }
  }
  ok('[F] EDITOR／VISUAL 是 notepad 時橋接照樣接手，真的編輯器則放行')

  // ── 環境裡本來就有兩個大小寫不同的 PATH 鍵 ──
  // 上面那段只量得到「這支測試剛好跑在什麼 shell 底下」有幾個鍵。從 Git Bash／MSYS 啟動
  // App 時 `process.env` 同時有 `PATH` 與 `Path`，而 `node-pty` 是照物件的鍵一個一個拼成
  // 環境區塊的（不像 `child_process` 會先去重），兩份一起送進去，子程序拿到哪一個看運氣。
  const { _prependPath } = require('../src/main/terminal/pty')
  const twoKeys = { PATH: `C:${path.sep}upper`, Path: `C:${path.sep}mixed` }
  _prependPath(twoKeys, folder)
  assert.deepEqual(Object.keys(twoKeys).filter((key) => key.toLowerCase() === 'path'), ['PATH'],
    `PATH 只能剩一個鍵，現在是 ${Object.keys(twoKeys).join('／')}`)
  assert.equal(twoKeys.PATH, `${folder}${path.delimiter}C:${path.sep}upper`, '要接在第一個非空的那份前面')
  // 第一個鍵是空的就不可以拿它當基底，不然整條 PATH 一起沒了
  const emptyFirst = { PATH: '', Path: `C:${path.sep}mixed` }
  _prependPath(emptyFirst, folder)
  assert.equal(emptyFirst.PATH, `${folder}${path.delimiter}C:${path.sep}mixed`, '空字串那份不可以把有值的蓋掉')
  ok('[F2] 環境裡同時有 PATH 與 Path 時收成一個鍵，不送兩份給子程序')

  // ── AGY／Gemini CLI：`command.split(' ')` 再 spawn(..., { shell: true }) ──
  events.length = 0
  let exited3 = null
  // 環境走 `shellEnvironment` 自己產的那一份，才是終端機真的餵給 CLI 的東西
  // （自己在測試裡拼一個 `PATH` 會把真正的 bug 蓋掉）。
  const env3 = require('../src/main/terminal/pty').shellEnvironment(command, folder)
  const [agyExe, ...agyRest] = command.split(' ')
  const child3 = spawn(agyExe, [...agyRest, target], { shell: true, stdio: 'ignore', windowsHide: true, env: env3 })
  child3.on('exit', (code) => { exited3 = code })
  const request3 = await until(() => events.find((e) => e.channel === 'terminal:editRequest')?.payload)
  assert.ok(request3, 'AGY 那種 spawn 也要收得到請求')
  assert.equal(bridge.cancel(request3.id), true)
  assert.ok(await until(() => exited3 !== null), 'AGY 那種 spawn 也要放得走')
  ok('[H] AGY 用 split(EDITOR) + spawn(shell:true) 一樣走得通')

  bridge.stop()
  try { removeTree(userData) } catch { /* 暫存目錄清不掉就算了 */ }
  console.log(`\n${passed} passed, 0 failed`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
