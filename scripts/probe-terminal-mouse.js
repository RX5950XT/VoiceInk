#!/usr/bin/env node
/**
 * VoiceInk — 擋掉 CLI 滑鼠回報的探針（`npx electron scripts/probe-terminal-mouse.js`）
 *
 * 要證明的是「xterm 收到 `CSI ? 1000 h` 之後**沒有**進入滑鼠模式」——而 `mouseTrackingMode`
 * 正是 xterm 自己用來決定「左鍵要交給應用程式還是拿來選字」的那個開關，所以量它就夠，
 * 不必去模擬拖曳（離屏視窗沒畫過字，xterm 量不到字元尺寸，`getCoords()` 一律回 undefined，
 * 模擬出來的拖曳永遠選不起來——那量的是探針自己，不是這次的修改）。
 *
 * **一定要有對照組**：同一顆 xterm 沒掛 `blockMouseReporting` 時 `?1000h` 會讓
 * `mouseTrackingMode` 變成 `x10`。少了這半邊，「永遠是 none」這條斷言就是恆真。
 *
 *  [A] 沒掛的對照組：`?1000h` 真的會進滑鼠模式（CLI 送的那串確實有效）
 *  [B] 掛上之後 `?9h`／`?1000h`／`?1002h`／`?1003h` 都進不了滑鼠模式
 *  [C] 混在同一串裡的非滑鼠模式（`?1002;1004h`）照常生效，只有滑鼠那幾個被丟掉
 *  [D] 跟滑鼠無關的私有模式（`?1049h` 備用畫面）一個字都不准被吃掉
 *  [E] 關閉（`?1000l`）也要吞掉，不可以漏出去變成畫面上的亂碼
 */

'use strict'

const path = require('path')
const fs = require('fs')
const { tempDir, removeTree } = require('./lib/test-temp')
const { app, BrowserWindow } = require('electron')

const ROOT = path.join(__dirname, '..')
app.setPath('userData', tempDir('probe-mouse-'))

const url = (p) => require('url').pathToFileURL(path.join(ROOT, p)).href

const PAGE = `<!doctype html>
<meta charset="utf-8">
<link rel="stylesheet" href="${url('node_modules/@xterm/xterm/css/xterm.css')}">
<style>html,body{margin:0;background:#111}.host{width:900px;height:200px}</style>
<div id="plain" class="host"></div>
<div id="blocked" class="host"></div>
<script type="module">
import { Terminal } from '${url('node_modules/@xterm/xterm/lib/xterm.mjs')}'
import { blockMouseReporting } from '${url('src/renderer/scripts/term-mouse.js')}'

const make = (hostId, block) => {
  const term = new Terminal({ cols: 40, rows: 5, fontSize: 16, convertEol: true })
  if (block) blockMouseReporting(term)
  term.open(document.getElementById(hostId))
  return term
}
// 對照組：什麼都沒做的 xterm
window.__plain = make('plain', false)
// 實驗組：掛上擋滑鼠回報的那支
window.__blocked = make('blocked', true)

window.__write = (which, text) => new Promise((resolve) => window[which].write(text, () => resolve(true)))
window.__line = (which) => window[which].buffer.active.getLine(window[which].buffer.active.cursorY)?.translateToString(true) || ''
</script>`

let passed = 0
let failed = 0
function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS ${name}`) } else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}

app.whenReady().then(async () => {
  const file = path.join(app.getPath('userData'), 'probe.html')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, PAGE, 'utf8')

  const win = new BrowserWindow({ show: false, width: 1000, height: 600, webPreferences: { sandbox: false, offscreen: true } })
  win.webContents.setFrameRate(30)
  await win.loadFile(file)
  const run = (code) => win.webContents.executeJavaScript(code)
  const write = (which, seq) => run(`window.__write('__${which}', '${seq}')`)
  const tracking = (which) => run(`window.__${which}.modes.mouseTrackingMode`)

  console.log('\n[對照組：沒掛擋滑鼠回報的 xterm]')
  await write('plain', '\\x1b[?1000h')
  const plainMode = await tracking('plain')
  ok('?1000h 真的會讓 xterm 進滑鼠模式', plainMode === 'vt200', `mouseTrackingMode=${plainMode}`)

  console.log('\n[實驗組：掛上 blockMouseReporting]')
  for (const [mode, name] of [[9, 'X10'], [1000, 'VT200'], [1002, '拖曳'], [1003, '全部移動']]) {
    await write('blocked', `\\x1b[?${mode}h`)
    const mouse = await tracking('blocked')
    ok(`?${mode}h（${name}）進不了滑鼠模式`, mouse === 'none', `mouseTrackingMode=${mouse}`)
  }

  await write('blocked', '\\x1b[?1002;1004h')
  const mixed = await run('({ tracking: window.__blocked.modes.mouseTrackingMode, focus: window.__blocked.modes.sendFocusMode })')
  ok('?1002;1004h 只丟掉滑鼠那個，焦點回報照常打開', mixed.tracking === 'none' && mixed.focus === true, JSON.stringify(mixed))

  await write('blocked', '\\x1b[?1049h')
  const alt = await run('window.__blocked.buffer.active.type')
  ok('?1049h（備用畫面）沒有被一起吃掉', alt === 'alternate', `buffer=${alt}`)
  await write('blocked', '\\x1b[?1049l')

  // 關閉那一串也要吞掉：漏出去的話畫面上會冒出 `[?1000l` 這種亂碼
  await write('blocked', '\\x1b[?1000l\\x1b[?1002lX')
  const line = await run("window.__line('__blocked')")
  ok('關閉滑鼠回報的序列不會漏成畫面上的字', line.trim() === 'X', JSON.stringify(line))

  console.log(`\n${passed} passed, ${failed} failed`)
  win.destroy()
  try { removeTree(app.getPath('userData')) } catch { /* 暫存目錄清不掉就算了 */ }
  app.exit(failed === 0 ? 0 : 1)
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
