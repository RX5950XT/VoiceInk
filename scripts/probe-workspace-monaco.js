'use strict'

/**
 * 實測：Monaco 在**跟正式視窗一模一樣的條件下**（`sandbox: true`、`file://`、
 * 我們那份 CSP）到底載不載得起來、高亮有沒有真的出現。
 *
 * 為什麼一定要先跑這一支：
 * - ESM 那份 build 有 98 個 `import './x.css'`，沒有 bundler 一 import 就死，
 *   所以走 AMD 的 `min/vs`——那條路要靠 `loader.js` 自己注入 `<script>`，
 *   會不會被 `script-src 'self'` 擋下來只有實測才知道。
 * - codicon 字型是 `data:` 內嵌的，`font-src` 沒放行的話**不會報錯**，
 *   只會看到一排小方框。
 * - `file://` 開不出 Worker。判斷「有沒有因此炸掉」也只能實測。
 *
 * 判準：`monaco` 拿得到、`.mtk` token 元素真的長出來（有高亮）、
 * 並排 diff 編輯器兩邊都畫得出來。
 *
 *   node_modules/electron/dist/electron.exe scripts/probe-workspace-monaco.js
 */

const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')

const ROOT = path.resolve(__dirname, '..')
/** 探針頁要跟 `src/renderer/` 同一層才算得出 `../../node_modules`（跟正式路徑一致） */
const PAGE = path.join(ROOT, 'src', 'renderer', `probe-monaco-${process.pid}.html`)
/** 探針的 module 要另外一支檔案——`script-src 'self'` 連 inline module 都擋（實測） */
const PROBE_JS = path.join(ROOT, 'src', 'renderer', `probe-monaco-${process.pid}.js`)

/** 跟 `src/renderer/index.html` 同一份 CSP（改了那邊記得改這裡） */
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
  + "font-src 'self' data:; worker-src 'self' blob:; img-src 'self' data: blob:; connect-src 'self' https: http:; "
  + "media-src 'self' blob:; frame-src http: https:"

const HTML = `<!doctype html>
<html><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${CSP}" />
<style>html,body{margin:0;height:100%}#a,#b{height:45%}</style>
</head><body>
<div id="a"></div><div id="b"></div>
<script type="module" src="./${path.basename(PROBE_JS)}"></script>
</body></html>`

const PROBE_SRC = `
import { loadMonaco, ensureEditor, showTab, showDiff, languageFor } from './scripts/ws-monaco.js'
const out = (data) => { window.__probe = data }
try {
  const monaco = await loadMonaco()
  if (!monaco) { out({ ok: false, why: 'loadMonaco 回 null' }); throw new Error('stop') }
  ensureEditor(monaco, document.getElementById('a'), () => {}, () => {})
  const NL = String.fromCharCode(10)
  showTab(monaco, { id: 't', relPath: 'demo.js', content: ['const answer = 42', '// note', 'function hi() { return 1 }', ''].join(NL) })
  showDiff(monaco, document.getElementById('b'), {
    relPath: 'demo.js',
    original: ['const a = 1', 'keep()', ''].join(NL),
    modified: ['const a = 2', 'keep()', 'added()', ''].join(NL)
  })
  await new Promise((r) => setTimeout(r, 1200))
  const tokens = [...document.querySelectorAll('#a span[class*="mtk"]')]
  const colours = new Map()
  for (const node of tokens) colours.set(getComputedStyle(node).color, (colours.get(getComputedStyle(node).color) || 0) + 1)
  const diffClasses = new Set()
  for (const node of document.querySelectorAll('#b *')) {
    for (const c of node.classList) if (/insert|delete|diff|modified/i.test(c)) diffClasses.add(c)
  }
  out({
    ok: true,
    language: languageFor(monaco, 'demo.js'),
    theme: document.querySelector('#a .monaco-editor')?.className || '',
    tokenNodes: tokens.length,
    tokenClasses: [...new Set(tokens.map((n) => n.className))].join(' | '),
    distinctColours: [...colours.keys()].join(' | '),
    tokenizeSample: JSON.stringify(monaco.editor.tokenize('const answer = 42', 'javascript')[0].map((t) => t.type)),
    languagesLoaded: monaco.languages.getLanguages().length,
    diffPanes: document.querySelectorAll('#b .monaco-editor').length,
    diffClasses: [...diffClasses].slice(0, 12).join(' | ')
  })
} catch (error) {
  if (!window.__probe) out({ ok: false, why: String(error && error.stack || error) })
}`

async function main() {
  fs.writeFileSync(PROBE_JS, PROBE_SRC, 'utf8')
  fs.writeFileSync(PAGE, HTML, 'utf8')
  const win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 800,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
  })
  /** @type {string[]} */
  const consoleErrors = []
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) consoleErrors.push(message)
  })
  await win.loadFile(PAGE)
  // **視窗藏著的話 Monaco 的背景 tokenize 不會跑**（requestIdleCallback 不觸發），
  // 量到的會是「整份都沒有高亮」的假紅燈。用 showInactive 不搶前景焦點。
  win.showInactive()

  let probe = null
  for (let i = 0; i < 60 && !probe; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    probe = await win.webContents.executeJavaScript('window.__probe || null')
    // eslint-disable-next-line no-await-in-loop
    if (!probe) await new Promise((r) => setTimeout(r, 250))
  }

  console.log('=== Monaco 實測 ===')
  console.log(JSON.stringify(probe, null, 2))
  if (consoleErrors.length) {
    console.log('--- console 錯誤（前 5 筆）---')
    for (const line of consoleErrors.slice(0, 5)) console.log(' ', line)
  }

  const pass = Boolean(
    probe && probe.ok
    && probe.tokenNodes > 0
    && String(probe.distinctColours).split(' | ').length > 1
    && probe.diffPanes >= 2
    && Boolean(probe.diffClasses)
  )
  console.log(pass ? 'PASS 語法高亮與並排 diff 都畫得出來' : 'FAIL')
  for (const one of [PAGE, PROBE_JS]) { try { fs.unlinkSync(one) } catch { /* 已經沒了 */ } }
  win.destroy()
  app.exit(pass ? 0 : 1)
}

app.setPath('userData', path.join(app.getPath('appData'), 'voiceink-probe-monaco'))
app.whenReady().then(main).catch((error) => {
  console.error(error)
  for (const one of [PAGE, PROBE_JS]) { try { fs.unlinkSync(one) } catch { /* 已經沒了 */ } }
  app.exit(1)
})

// 沒用到，只是避免 lint 抱怨 os 沒用
void os
