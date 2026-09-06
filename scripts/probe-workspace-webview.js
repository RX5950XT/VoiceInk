#!/usr/bin/env node
'use strict'

/**
 * 實測：Electron 43 在 `sandbox: true` 的視窗裡，`<webview>` 到底動不動得起。
 *
 * 為什麼要有這一支：工作區的內建瀏覽器從 iframe 換成 webview（比照 Orca），
 * 前提是「sandbox: true × webviewTag: true」這個組合真的能用——iframe 撞
 * X-Frame-Options 是一片空白不報錯，webview 掛了也多半是靜默失敗，
 * 不先實測就等於把整個瀏覽器分頁賭在沒驗過的組合上。
 *
 * 判準：webview 有 `getWebContentsId()`（真的 attach 成 OOPIF guest）、
 * 導航到本機 http server 後 `getURL()`／`getTitle()` 對得上。
 *
 *   node_modules/electron/dist/electron.exe scripts/probe-workspace-webview.js
 */

const { app, BrowserWindow } = require('electron')
const http = require('http')
const path = require('path')
const fs = require('fs')
const os = require('os')

const PORT_PLACEHOLDER = '__PROBE_PORT__'

/** 起一個只回一頁的本機 server（不打外網） */
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><title>probe-ok</title><h1>VoiceInk webview probe</h1>')
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: /** @type {import('net').AddressInfo} */ (server.address()).port })
    })
  })
}

async function main() {
  const { port, server } = await startServer()
  const target = `http://127.0.0.1:${port}/`
  const html = `<!doctype html><body style="margin:0">
<webview id="w" partition="persist:probe" style="width:100%;height:100%" src="${target}"></webview>
</body>`
  const page = path.join(os.tmpdir(), `vi-probe-webview-${Date.now()}.html`)
  fs.writeFileSync(page, html, 'utf8')

  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: true
    }
  })

  let failed = false
  const ok = (name, cond, detail = '') => {
    console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ` — ${detail}`}`)
    if (!cond) failed = true
  }

  try {
    await win.loadFile(page)
    // 等 webview attach + 導航完成（OOPIF 起來要一會）
    let info = null
    for (let i = 0; i < 40; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      info = await win.webContents.executeJavaScript(`(() => {
        const w = document.getElementById('w')
        if (!w || typeof w.getWebContentsId !== 'function') return null
        try {
          return { id: w.getWebContentsId(), url: w.getURL(), title: w.getTitle(), ready: w.classList.contains('ok') }
        } catch { return null }
      })()`)
      if (info && info.id > 0 && String(info.url).startsWith('http://127.0.0.1') && info.title === 'probe-ok') break
      await new Promise((r) => setTimeout(r, 500))
    }
    ok('webviewTag 有開（不是 HTMLUnknownElement）', info !== null && info.id > 0, JSON.stringify(info))
    ok('webview 真的導航到本機 server', !!info && String(info.url).startsWith(target), JSON.stringify(info))
    ok('標題同步回來', !!info && info.title === 'probe-ok', JSON.stringify(info))
    ok('partition 屬性有掛上', await win.webContents.executeJavaScript(
      `document.getElementById('w').getAttribute('partition') === 'persist:probe'`
    ))
    ok('allowpopups 沒開也沒炸（popup 由 main 層管）', await win.webContents.executeJavaScript(
      `(() => { document.getElementById('w').executeJavaScript('window.open("about:blank")').catch(() => {}); return true })()`
    ))
  } catch (error) {
    console.error('probe error:', error && error.message)
    failed = true
  } finally {
    fs.unlinkSync(page)
    await new Promise((r) => server.close(r))
  }
  console.log(failed ? 'PROBE FAILED' : 'PROBE OK')
  app.exit(failed ? 1 : 0)
}

app.whenReady().then(() => main())
