#!/usr/bin/env node
/**
 * VoiceInk — 「我開的到底是不是新版」的現場證據
 *
 * 把指定的 VoiceInk.exe 用暫存 `--user-data-dir` 拉起來，切到 Claude Code 工作台，
 * 直接把畫面上真的渲染出來的東西讀回來：供應商預設清單有幾筆、分組標題是什麼、
 * 「上游協議」下拉在不在、彈窗關著的時候高度是不是 0。
 *
 * 收尾只以自己的 pid 收程序（禁止 `/IM VoiceInk.exe`）。
 */

'use strict'

const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')

const PORT = 9271
const EXE = process.env.VOICEINK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
const USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-probe-preview-'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = ''
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (error) { reject(error) }
      })
    })
    request.setTimeout(2_000, () => request.destroy(new Error('CDP HTTP 逾時')))
    request.on('error', reject)
  })
}

function stopTestApp(child) {
  if (child?.pid) {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 已結束 */ }
  }
  try {
    execFileSync('powershell', [
      '-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='VoiceInk.exe'" |` +
      ` Where-Object { $_.CommandLine -like '*${USER_DATA_DIR}*' } |` +
      ' ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
    ], { stdio: 'ignore' })
  } catch { /* 沒殘留 */ }
}

class Cdp {
  constructor(url) {
    this.url = url
    this.id = 0
    this.pending = new Map()
  }

  connect() {
    this.ws = new WebSocket(this.url)
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result)
    })
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve())
      this.ws.addEventListener('error', () => reject(new Error('CDP 連線失敗')))
    })
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || '求值失敗')
    return result.result.value
  }

  close() { this.ws?.close() }
}

async function main() {
  console.log(`exe: ${EXE}`)
  console.log(`asar: ${fs.statSync(path.join(path.dirname(EXE), 'resources', 'app.asar')).mtime.toISOString()}`)

  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA_DIR}`], {
    stdio: 'ignore', detached: false
  })

  let cdp = null
  try {
    let targets = null
    for (let i = 0; i < 40; i += 1) {
      await sleep(500)
      try {
        const list = await getJson(`http://127.0.0.1:${PORT}/json/list`)
        targets = list.filter((t) => t.type === 'page' && t.url.includes('index.html'))
        if (targets.length) break
      } catch { /* 還沒起來 */ }
    }
    if (!targets?.length) throw new Error('等不到主視窗（App 沒起來或 asar 壞了）')

    cdp = new Cdp(targets[0].webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Runtime.enable')

    // 等 renderer 掛好
    for (let i = 0; i < 40; i += 1) {
      const ready = await cdp.eval('!!document.querySelector(\'[data-page="ccswitch"]\')')
      if (ready) break
      await sleep(250)
    }

    await cdp.eval('document.querySelector(\'[data-page="ccswitch"]\').click()')
    await sleep(1_500)

    // 供應商 tile 是「開頁面時」就該畫出來的（播種＋清單）；「＋」tile 開的是純自訂彈窗
    await cdp.eval('document.querySelector("#ccProviderList .cc-tile.is-add .cc-tile-main")?.click()')
    await sleep(600)

    const report = await cdp.eval(`(() => {
      const dialogs = [...document.querySelectorAll('.app-dialog')]
      return {
        version: document.querySelector('#settingsVersion')?.textContent?.trim() || null,
        tileCount: document.querySelectorAll('#ccProviderList .cc-tile').length,
        addTitle: document.getElementById('ccProviderDialogTitle')?.textContent?.trim() || '',
        hasApiFormatSelect: !!document.getElementById('ccApiFormatSelect'),
        hasScanBtn: !!document.getElementById('ccScanModelsBtn'),
        dialogCount: dialogs.length,
        visibleClosedDialogs: dialogs.filter((d) => !d.open && d.offsetHeight > 0).length
      }
    })()`)

    console.log('\n--- 畫面上真的渲染出來的東西 ---')
    console.log('供應商 tile 筆數（五家＋「＋」）:', report.tileCount)
    console.log('「＋」開的彈窗標題:', report.addTitle)
    console.log('「上游協議」下拉存在:', report.hasApiFormatSelect)
    console.log('「從 API 載入模型」按鈕存在:', report.hasScanBtn)
    console.log('彈窗總數:', report.dialogCount, '／關著卻看得到的:', report.visibleClosedDialogs)

    const ok = report.tileCount >= 6 && report.addTitle === '新增自訂供應商' && report.visibleClosedDialogs === 0
    console.log(ok ? '\n=> 這份是新版' : '\n=> 這份是舊版或壞的')
    process.exitCode = ok ? 0 : 1
  } finally {
    cdp?.close()
    stopTestApp(child)
    try { fs.rmSync(USER_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }) } catch { /* 慢慢釋放 */ }
  }
}

main().catch((error) => {
  console.error(String(error.message))
  process.exitCode = 1
})
