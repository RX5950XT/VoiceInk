#!/usr/bin/env node
/**
 * VoiceInk — 打包版「從 API 載入模型」的實機 probe（CDP）
 *
 * 這是 UI 層的端到端驗證：點 Codex tile 的編輯 → 模型下拉自動掃一次（真的打
 * ChatGPT 後端的 GET /models，會用 ~/.codex/auth.json 的憑證，不花對話額度）→
 * 確認四個下拉真的裝了模型。main 層的路徑由 `probe-ccswitch-models.js` 驗，
 * 這支只補「按鈕 → IPC → 下拉」那一段。
 *
 *     node scripts/probe-ccswitch-scan-ui.js
 */

'use strict'

const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')

const PORT = 9253
const EXE = process.env.VOICEINK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
const USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-probe-scan-'))
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

class Cdp {
  constructor(url) {
    this.url = url
    this.id = 0
    this.pending = new Map()
  }

  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve)
      this.ws.addEventListener('error', () => reject(new Error('CDP WebSocket 連不上')))
    })
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (!message.id || !this.pending.has(message.id)) return
      const pending = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
    await this.send('Runtime.enable')
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    }
    return result.result?.value
  }

  close() {
    try { this.ws.close() } catch { /* 已斷線 */ }
  }
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
  } catch { /* 沒有殘留 */ }
}

async function main() {
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA_DIR}`], {
    stdio: 'ignore', detached: false
  })

  let targets = null
  for (let i = 0; i < 60; i += 1) {
    await sleep(500)
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json/list`)
      targets = list.filter((t) => t.type === 'page' && t.url.includes('index.html'))
      if (targets.length) break
    } catch { /* 還沒起來 */ }
  }
  if (!targets?.length) throw new Error('等不到主視窗')

  const cdp = new Cdp(targets[0].webSocketDebuggerUrl)
  await cdp.connect()
  try {
    await cdp.eval('document.querySelector(\'[data-page="ccswitch"]\').click()')
    for (let i = 0; i < 40; i += 1) {
      if (await cdp.eval("document.querySelectorAll('#ccProviderList .cc-tile').length >= 6")) break
      await sleep(250)
    }

    const codexTile = await cdp.eval(`(() => {
      // 找 Codex 那張 tile 的編輯鈕
      return window.electronAPI.ccswitch.listProviders().then((r) => {
        const codex = (r.data?.providers || []).find((p) => p.presetId === 'codex')
        return codex?.id || ''
      })
    })()`)
    if (!codexTile) throw new Error('找不到 Codex tile')
    await cdp.eval(`document.querySelector('#ccProviderList .cc-tile[data-id="${codexTile}"] .cc-tile-edit').click()`)

    // 開彈窗會自動掃一次；等到下拉長出模型或逾時
    let loaded = null
    for (let i = 0; i < 40; i += 1) {
      loaded = await cdp.eval(`(() => {
        const select = document.getElementById('ccModelSelect')
        return {
          options: select ? [...select.options].map((o) => o.value) : [],
          hint: document.getElementById('ccScanHint')?.textContent || ''
        }
      })()`)
      // 「（預設：…）」那格不算掃到
      if (loaded.options.filter(Boolean).length > 1) break
      await sleep(500)
    }

    const models = loaded.options.filter(Boolean)
    console.log(`模型下拉選項：${models.length} 顆`)
    console.log(`前 5 顆：${models.slice(0, 5).join(', ')}`)
    console.log(`hint：${loaded.hint}`)
    const ok = models.length > 1 && loaded.hint.includes('已載入')
    console.log(ok ? '\n=> 自動掃描有把模型裝進下拉' : '\n=> 沒掃到（憑證沒登入或上游失敗）')
    process.exitCode = ok ? 0 : 1
  } finally {
    cdp.close()
    stopTestApp(child)
    try { fs.rmSync(USER_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }) } catch { /* 慢慢釋放 */ }
  }
}

main().catch((error) => {
  console.error(String(error.message))
  process.exitCode = 1
})
