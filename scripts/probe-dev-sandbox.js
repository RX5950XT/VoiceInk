'use strict'

/**
 * 實測 `npm run dev:sandbox` 這件事本身：**沙箱真的不干擾你正在用的那份，而且真的測得到功能**。
 *
 * 這兩件事 mock 證明不了——要真的把打包版用沙箱的 userData 開起來，
 * 一邊確認它讀得到你的模型與供應商，一邊確認你原本那份一個位元組都沒動。
 *
 * 需要先跑過 `npm run electron:pack`（或用 `VOICEINK_EXE` 指到別的建置版）。
 * 收尾只 `taskkill` 自己 spawn 的 pid，**不會碰你開著的 VoiceInk**。
 */

const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const EXE = process.env.VOICEINK_EXE
  || path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
const REAL = path.join(process.env.APPDATA, 'voiceink')
const SANDBOX = path.join(process.env.APPDATA, 'voiceink-dev')
const PORT = 9333
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const hashDir = () => {
  const h = crypto.createHash('sha256')
  for (const f of fs.readdirSync(REAL).sort()) {
    const p = path.join(REAL, f)
    try {
      const s = fs.statSync(p)
      h.update(`${f}:${s.isDirectory() ? 'd' : s.size}:${s.mtimeMs}`)
    } catch { h.update(`${f}:?`) }
  }
  return h.digest('hex').slice(0, 16)
}

let passed = 0
let failed = 0
const ok = (name, cond, detail = '') => {
  if (cond) { passed += 1; console.log(`PASS ${name}${detail ? ' — ' + detail : ''}`) }
  else { failed += 1; console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}

const get = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)) } catch (e) { rej(e) } }) }).on('error', rej)
})

class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.ws = null; this.id = 0; this.pending = new Map() }
  async connect() {
    this.ws = new globalThis.WebSocket(this.wsUrl)
    await new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej) })
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      const slot = msg.id && this.pending.get(msg.id)
      if (!slot) return
      this.pending.delete(msg.id)
      msg.error ? slot.reject(new Error(msg.error.message)) : slot.resolve(msg.result)
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result.value
  }
}

async function main() {
    const before = hashDir()
  console.log(`真 userData 指紋（前）: ${before}`)

  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${SANDBOX}`], { stdio: 'ignore' })
  let exited = null
  child.on('exit', (c) => { exited = c })

  try {
    let pages = []
    for (let i = 0; i < 40 && !pages.length; i += 1) {
      await sleep(700)
      try { pages = (await get(`http://127.0.0.1:${PORT}/json/list`)).filter((p) => /index\.html/i.test(p.url)) } catch {}
    }
    ok('沙箱實例起得來（安裝版同時在跑）', pages.length > 0 && exited === null)
    if (!pages.length) throw new Error('沒有主視窗 target')

    const cdp = new Cdp(pages[0].webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Runtime.enable')
    await sleep(2500)

    const providers = await cdp.eval(`(async()=>{const r=await window.electronAPI.store.get('chatProviders');return Array.isArray(r)?r.length:0})()`)
    ok('聊天供應商接得到（config.json 複製過來了）', providers > 0, `${providers} 組`)

    const models = await cdp.eval(`(async()=>{const r=await window.electronAPI.models.status();const m=r?.models||r?.data?.models;return m?Object.values(m).filter((x)=>x&&x.downloaded).length:-1})()`)
    ok('本機模型看得到（models/ junction 接回去了）', models > 0, `${models} 顆已安裝`)

    const projects = await cdp.eval(`(async()=>{const r=await window.electronAPI.workspace.listProjects();return r?.ok?r.data.length:-1})()`)
    ok('專案清單接得到（workspaces.json 複製過來了）', projects > 0, `${projects} 個專案`)

    const flags = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'config.json'), 'utf8'))
    const offDetail = JSON.stringify({ agyEnabled: flags.agyEnabled, dictationEnabled: flags.dictationEnabled, sysmonSensors: flags.sysmonSensors })
    ok('會跑出 userData 之外的三個開關都關著', flags.agyEnabled === false && flags.dictationEnabled === false && flags.sysmonSensors === false, offDetail)
    const agyRunning = await cdp.eval(`(async()=>{const r=await window.electronAPI.agy.status();return (r?.data?.running ?? r?.running) === true})()`)
    ok('沙箱沒有去搶 AGY 的埠', agyRunning === false)

    const chatOk = await cdp.eval(`(()=>{document.querySelector('.nav-tab[data-page="chat"]')?.click();return !!document.getElementById('page-chat')?.classList.contains('active')})()`)
    ok('聊天頁真的打得開（功能可測，不是空殼）', chatOk === true)
  } finally {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    await sleep(3000)
  }

  const after = hashDir()
  console.log(`真 userData 指紋（後）: ${after}`)
  ok('全程沒有動到你正在用的那份 userData', before === after)
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exitCode = failed ? 1 : 0
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
