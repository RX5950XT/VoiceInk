#!/usr/bin/env node
/**
 * VoiceInk — 終端機連結的座標探針（`npx electron scripts/probe-terminal-links.js`）
 *
 * 單元測試只驗得到「掃出哪些字」，驗不到 xterm 那邊的座標約定：
 * `provideLinks` 收到的列號是**整個緩衝區**的 1-based 列號（不是畫面上的第幾列），
 * 回去的 range 也是同一套。這條猜錯不會報錯，只會變成「點得到卻點錯地方」。
 *
 * 所以這裡開一顆真的 xterm，寫幾行進去，用真的滑鼠事件點在字上面，
 * 看 activate 收到的是不是那一段字。
 */

'use strict'

const path = require('path')
const fs = require('fs')
const os = require('os')
const { app, BrowserWindow } = require('electron')

const ROOT = path.join(__dirname, '..')
app.setPath('userData', path.join(os.tmpdir(), `voiceink-probe-links-${process.pid}`))

const url = (p) => require('url').pathToFileURL(path.join(ROOT, p)).href

const PAGE = `<!doctype html>
<meta charset="utf-8">
<link rel="stylesheet" href="${url('node_modules/@xterm/xterm/css/xterm.css')}">
<style>html,body{margin:0;background:#111}#host{width:900px;height:400px}</style>
<div id="host"></div>
<script type="module">
import { Terminal } from '${url('node_modules/@xterm/xterm/lib/xterm.mjs')}'
import { scanLine, logicalLine } from '${url('src/renderer/scripts/term-link-scan.js')}'

window.__fired = []
const term = window.__term = new Terminal({ cols: 40, rows: 10, fontSize: 16, convertEol: true })
term.open(document.getElementById('host'))
// 主行程的存在性檢查在這支探針裡不重要，這裡一律當成存在（要驗的是座標）。
term.registerLinkProvider({
  provideLinks(lineNumber, callback) {
    (window.__calls = window.__calls || []).push(lineNumber)
    const info = logicalLine(term.buffer.active, lineNumber)
    const hits = info ? scanLine(info.text) : []
    if (!hits.length) { callback(undefined); return }
    callback(hits.map((hit) => ({
      range: { start: info.at(hit.start), end: info.endAt(hit.end - 1) },
      text: hit.text,
      activate: (event) => { event.preventDefault(); window.__fired.push(hit.text) }
    })))
  }
})

window.__ready = new Promise((resolve) => {
  // 第 3 行刻意讓網址折到下一列（40 欄），才驗得到折行後的座標
  // 先灌滿一整頁把畫面捲起來：viewportY > 0 時「緩衝區列號」才跟「畫面上第幾列」不同，
  // 座標約定弄反才驗得出來（不捲的話兩種算法剛好一樣，測了等於沒測）。
  const filler = Array.from({ length: 20 }, (unused, i) => 'filler ' + i).join('\\n') + '\\n'
  term.write(filler + 'line one\\nsee src/main/terminal/links.js here\\n', () => {
    term.write('go http://localhost:5173/a/very/long/path/x end\\n', () => {
      term.write('\\u770bsrc/renderer/app.js end\\n', () => resolve(true))
    })
  })
})

/**
 * 點在某個緩衝區座標上。隱藏視窗不跑 rAF，DOM renderer 一列都沒畫出來，
 * 所以不能靠找 span——改用「螢幕區塊的尺寸 ÷ 欄列數」自己算格子的中心點。
 */
window.__clickCell = (col, row) => {
  const screen = document.querySelector('.xterm-screen')
  const box = screen.getBoundingClientRect()
  const cellW = box.width / term.cols
  const cellH = box.height / term.rows
  const top = term.buffer.active.viewportY
  const point = {
    clientX: box.left + (col - 0.5) * cellW,
    clientY: box.top + (row - 1 - top + 0.5) * cellH,
    bubbles: true
  }
  screen.dispatchEvent(new MouseEvent('mousemove', point))
  return new Promise((resolve) => setTimeout(() => {
    screen.dispatchEvent(new MouseEvent('mousedown', point))
    screen.dispatchEvent(new MouseEvent('mouseup', point))
    screen.dispatchEvent(new MouseEvent('click', point))
    setTimeout(() => resolve('ok'), 80)
  }, 80))
}

/** 在緩衝區裡找到這段字，點它中間那一格 */
window.__clickText = (needle) => {
  const buf = term.buffer.active
  for (let i = 0; i < buf.length; i += 1) {
    const text = buf.getLine(i)?.translateToString(false) || ''
    const at = text.indexOf(needle)
    if (at >= 0) return window.__clickCell(at + Math.floor(needle.length / 2) + 1, i + 1)
  }
  return Promise.resolve('not-found:' + needle)
}

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

  // 隱藏視窗不會跑 rAF，xterm 的 DOM renderer 就一個字都不畫；離屏渲染可以照畫又不會跳到使用者面前
  const win = new BrowserWindow({ show: false, width: 1000, height: 600, webPreferences: { sandbox: false, offscreen: true } })
  win.webContents.setFrameRate(30)
  await win.loadFile(file)
  const run = (code) => win.webContents.executeJavaScript(code)
  await run('window.__ready')
  if (process.env.PROBE_DEBUG) {
    console.log('buffer:', await run("[1,2,3,4].map((i) => window.__term.buffer.active.getLine(i - 1)?.translateToString(true))"))
    console.log('dom:', await run("document.getElementById('host').innerHTML.slice(0, 600)"))
    console.log('spans:', await run("Array.from(document.querySelectorAll('.xterm-rows span')).length"))
    console.log('click:', await run("window.__clickText('links.js')"))
    console.log('fired:', await run('window.__fired'))
    console.log('provide calls:', await run('window.__calls'))
  }

  console.log('\n[真的點下去]')
  await run("window.__clickText('links.js')")
  let fired = await run('window.__fired')
  ok('點路徑會叫到那一段路徑', fired.includes('src/main/terminal/links.js'), JSON.stringify(fired))

  await run('window.__fired = []')
  await run("window.__clickText('localhost')")
  fired = await run('window.__fired')
  ok('點折行的網址會叫到整段網址', fired.includes('http://localhost:5173/a/very/long/path/x'), JSON.stringify(fired))

  // 折行後半段也要點得到：座標若算成「畫面上的第幾列」，這一下就會落空
  await run('window.__fired = []')
  await run("window.__clickText('h/x')")
  fired = await run('window.__fired')
  ok('折到下一列的後半段也點得到', fired.includes('http://localhost:5173/a/very/long/path/x'), JSON.stringify(fired))

  await run('window.__fired = []')
  await run("window.__clickText('line one')")
  fired = await run('window.__fired')
  ok('沒有連結的字點了不會叫任何東西', fired.length === 0, JSON.stringify(fired))

  // 「看」佔兩欄。座標若用字元位移，底線會蓋到這個字上，點下去會誤開路徑。
  await run('window.__fired = []')
  await run("window.__clickText('\\u770b')")
  fired = await run('window.__fired')
  ok('寬字元本身點了不是路徑', fired.length === 0, JSON.stringify(fired))

  await run('window.__fired = []')
  await run("window.__clickText('app.js')")
  fired = await run('window.__fired')
  ok('寬字元後面的路徑仍點得到', fired.includes('src/renderer/app.js'), JSON.stringify(fired))

  console.log(`\n${passed} passed, ${failed} failed`)
  win.destroy()
  try { fs.rmSync(app.getPath('userData'), { recursive: true, force: true }) } catch {}
  app.exit(failed === 0 ? 0 : 1)
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
