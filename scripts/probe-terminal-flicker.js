'use strict'
/**
 * 「串流時游標與選字框跟著閃」到底閃在哪——用真的 Chromium 量，不用猜。
 *
 * DOM renderer 與 WebGL renderer 各跑一次，量四個數字：
 *
 * - **重畫**：xterm 實際刷了幾次畫面（沒有這個數字就分不出「沒問題」與「根本沒在畫」）。
 * - **游標移動**：`onCursorMove` 觸發幾次。xterm 每一次都會**同步**呼叫
 *   `_syncTextArea()`，沒有合到幀。
 * - **游標 DOM 重建**：DOM renderer 把游標畫成
 *   `<span class="xterm-cursor xterm-cursor-blink">`，閃爍是 CSS
 *   `animation: ... 1s step-end infinite`。這顆 span 只要被換成新元素，動畫就從 0%
 *   （游標實心）重來——重建得夠頻繁，游標就永遠跑不完一個週期，看起來是在亂閃。
 * - **textarea 位置變動**：Windows 輸入法的候選字視窗釘在「目前輸入框的游標框」上，
 *   那個隱形 `<textarea>` 被搬一次，候選字視窗就跳一次。**實測結果是「幾乎不動」**
 *   （2.4 秒 88 次游標移動只換來 1 次位置變動）——因為每一輪重畫完游標都回到輸入行
 *   同一格，中間那些移動在同一個同步批次裡就抵銷掉了。所以候選字視窗看起來在閃
 *   **不是位置在抖**，是它底下那顆游標在閃；修對地方是 renderer，不是輸入法對位。
 *
 * 輸出的是**觀測值不是及格線**：兩個 renderer 擺在一起比，差在哪一眼看得出來。
 *
 * 用法：npx electron scripts/probe-terminal-flicker.js
 *
 * **會叫到最前面**，而且是刻意的：xterm 只有在終端機真的有焦點時才畫游標
 * （沒焦點時 `.xterm-cursor` 整顆不存在，量到的會是假的 0）。跑完自己關掉。
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const MODULES = path.join(ROOT, 'node_modules', '@xterm')

/** 串流多久（毫秒）。AI CLI 的 spinner 大約每 80ms 重畫一次。 */
const STREAM_MS = 2400
const FRAME_MS = 80

const url = (rel) => `file:///${path.join(MODULES, rel).replace(/\\/g, '/')}`

const PAGE = [
  '<!doctype html>',
  '<meta charset="utf-8" />',
  `<link rel="stylesheet" href="${url('xterm/css/xterm.css')}" />`,
  '<style>html,body{margin:0;background:#0d1012}#host{width:900px;height:400px}</style>',
  '<div id="host"></div>',
  '<script type="module">',
  `import { Terminal } from '${url('xterm/lib/xterm.mjs')}'`,
  `import { FitAddon } from '${url('addon-fit/lib/addon-fit.mjs')}'`,
  `import { WebglAddon } from '${url('addon-webgl/lib/addon-webgl.mjs')}'`,
  'const ESC = String.fromCharCode(27)',
  'const sleep = (ms) => new Promise((r) => setTimeout(r, ms))',
  'window.measure = async (useWebgl, streamMs, frameMs) => {',
  '  const host = document.getElementById("host")',
  '  host.replaceChildren()',
  '  const term = new Terminal({',
  '    allowProposedApi: true, cursorBlink: true, fontSize: 17, scrollback: 5000,',
  '    theme: { background: "#0d1012", foreground: "#f4f1e8" }',
  '  })',
  '  const fit = new FitAddon()',
  '  term.loadAddon(fit)',
  '  term.open(host)',
  '  let renderer = "dom"',
  '  if (useWebgl) {',
  '    try {',
  '      const webgl = new WebglAddon()',
  '      webgl.onContextLoss(() => webgl.dispose())',
  '      term.loadAddon(webgl)',
  '      renderer = "webgl"',
  '    } catch (error) { renderer = "webgl-failed" }',
  '  }',
  '  fit.fit()',
  '  term.focus()',
  '  await sleep(150)',
  '',
  '  let renders = 0, cursorMoves = 0, cursorRebuilds = 0, caretMoves = 0',
  '  let lastCursorEl = null, lastCaret = ""',
  '  const screen = term.element.querySelector(".xterm-screen")',
  '  const area = term.textarea',
  '  term.onRender(() => { renders += 1 })',
  '  term.onCursorMove(() => { cursorMoves += 1 })',
  '  // 游標那顆 DOM 有沒有被換成新元素：直接比物件身分，比 MutationObserver 不會漏。',
  '  const sample = () => {',
  '    const el = screen.querySelector(".xterm-cursor")',
  '    if (el && el !== lastCursorEl) { cursorRebuilds += 1; lastCursorEl = el }',
  '    const at = area.style.left + "," + area.style.top',
  '    if (at !== lastCaret) { lastCaret = at; caretMoves += 1 }',
  '  }',
  '  new MutationObserver(sample).observe(area, { attributes: true, attributeFilter: ["style"] })',
  '  let polling = true',
  '  const poll = () => { if (!polling) return; sample(); requestAnimationFrame(poll) }',
  '  requestAnimationFrame(poll)',
  '',
  '  // Ink（Claude Code／Codex 用的那套）是整塊重畫：往上幾行、逐行清掉重印、',
  '  // 游標再回到輸入行。每一輪游標橫跨整個區塊好幾趟，正是使用者看到在閃的情況。',
  '  const spin = ["\\u280b", "\\u2819", "\\u2839", "\\u2838", "\\u283c", "\\u2834"]',
  '  const started = Date.now()',
  '  let frames = 0',
  '  term.write("$ claude\\r\\n\\r\\n\\r\\n")',
  '  while (Date.now() - started < streamMs) {',
  '    const s = spin[frames % spin.length]',
  '    const dots = ".".repeat(frames % 4)',
  '    term.write(ESC + "[3A\\r" + ESC + "[2K" + s + " Thinking" + dots + " (" + frames + "s \\u00b7 " + (frames * 37) + " tokens)")',
  '    term.write("\\r\\n" + ESC + "[2K  \\u00b7 \\u8b80\\u53d6 src/main/terminal/pty.js".slice(0, 22 + (frames % 12)))',
  '    term.write("\\r\\n" + ESC + "[2K> ")',
  '    frames += 1',
  '    await sleep(frameMs)',
  '  }',
  '  await sleep(80)',
  '  polling = false',
  '  term.dispose()',
  '  return { renderer, frames, renders, cursorMoves, cursorRebuilds, caretMoves }',
  '}',
  '</script>'
].join('\n')

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-flicker-'))
  const page = path.join(dir, 'probe.html')
  fs.writeFileSync(page, PAGE, 'utf8')

  const win = new BrowserWindow({
    width: 940,
    height: 460,
    show: false,
    webPreferences: { contextIsolation: true, backgroundThrottling: false }
  })
  // 一定要顯示而且要有焦點：藏起來的視窗不會真的畫，沒焦點的終端機不會畫游標，
  // 兩種情況量到的都是假的 0。
  win.show()
  win.focus()
  await win.loadFile(page)
  win.focus()
  await new Promise((resolve) => setTimeout(resolve, 400))

  /** @type {Array<object>} */
  const results = []
  for (const useWebgl of [false, true]) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await win.webContents.executeJavaScript(
      `window.measure(${useWebgl}, ${STREAM_MS}, ${FRAME_MS})`
    ))
  }

  console.log(`\n串流 ${STREAM_MS}ms，每 ${FRAME_MS}ms 重畫一整塊（模擬 Ink 式的 AI CLI）\n`)
  console.log('renderer  幀數  重畫  游標移動  游標DOM重建  textarea位置變動')
  for (const r of results) {
    console.log([
      r.renderer.padEnd(9),
      String(r.frames).padStart(4),
      String(r.renders).padStart(5),
      String(r.cursorMoves).padStart(9),
      String(r.cursorRebuilds).padStart(12),
      String(r.caretMoves).padStart(17)
    ].join(' '))
  }

  const [dom, webgl] = results
  let failed = 0
  const check = (label, pass) => {
    console.log(`  ${pass ? 'PASS' : 'FAIL'} ${label}`)
    if (!pass) failed += 1
  }
  console.log('')
  check('量得到東西（真的有在重畫，不是視窗沒畫出來的假 0）', dom.renders > 5 && webgl.renders > 5)
  check('WebGL renderer 載得起來', webgl.renderer === 'webgl')
  check('WebGL 不再用 DOM 畫游標（DOM renderer 有重建、WebGL 是 0）',
    webgl.cursorRebuilds === 0 && dom.cursorRebuilds > 0)
  // 反向斷言：這條**故意**釘住「textarea 幾乎不動」。哪天有人改動輸入法對位、
  // 讓它開始每幀被搬，候選字視窗才會真的抖起來——那時這條要紅。
  check('textarea 幾乎沒被搬動（候選字視窗的抖動來源不在這裡，別往輸入法對位修）',
    dom.caretMoves <= 3 && webgl.caretMoves <= 3)

  win.destroy()
  fs.rmSync(dir, { recursive: true, force: true })
  console.log(`\n${failed ? `${failed} failed` : '全部通過'}`)
  app.exit(failed ? 1 : 0)
}

app.setPath('userData', path.join(app.getPath('appData'), 'voiceink-probe-flicker'))
app.whenReady().then(main).catch((error) => {
  console.error(error)
  app.exit(1)
})
