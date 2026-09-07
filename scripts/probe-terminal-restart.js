'use strict'

// 真正關閉 App、替換安裝檔案，再開回來；用 shell PID 與磁碟心跳確認不是重跑。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { spawn, execFileSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const sourceExe = process.env.VOICEINK_EXE || path.join(root, 'dist/win-unpacked/VoiceInk.exe')
const testRoot = fs.mkdtempSync(path.join(root, 'dist/terminal-restart-'))
const install = path.join(testRoot, 'install')
const userData = path.join(testRoot, 'user-data')
const project = path.join(testRoot, 'project')
const exe = path.join(install, 'VoiceInk.exe')
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
let child, cdp, sessionId = '', shellPid = 0

async function waitFor(fn, label, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await fn()) return
    await sleep(150)
  }
  throw new Error(label)
}

class Cdp {
  constructor(url) { this.ws = new WebSocket(url); this.id = 0; this.pending = new Map() }
  async connect() {
    await new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject })
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data), pending = this.pending.get(msg.id)
      if (!pending) return
      this.pending.delete(msg.id)
      if (msg.error) pending.reject(new Error(msg.error.message))
      else pending.resolve(msg.result)
    }
    this.ws.onclose = () => {
      for (const p of this.pending.values()) p.reject(new Error('CDP closed'))
      this.pending.clear()
    }
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'eval failed')
    return result.result?.value
  }
}

let port = 0

async function launch() {
  const server = net.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
  await new Promise(resolve => server.close(resolve))
  // 隱藏視窗會被節流（計時器 89ms → 19828ms），跟其他 CDP 腳本一樣關掉遮蔽節流。
  child = spawn(exe, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, '--hidden', '--disable-backgrounding-occluded-windows'], { windowsHide: true, stdio: 'ignore' })
  let target
  await waitFor(async () => {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      target = list.find(item => item.type === 'page' && /index\.html/.test(item.url))
      return Boolean(target)
    } catch { return false }
  }, 'App did not start')
  cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.connect()
  await waitFor(() => cdp.eval('Boolean(window.electronAPI && document.getElementById("sidebarModeProjects"))'), 'App UI not ready')
  // 模組還沒掛上監聽時點下去會被吞掉，清單就永遠不重畫；點到真的列出來為止。
  await waitFor(async () => {
    await cdp.eval('document.getElementById("sidebarModeProjects").click()')
    return cdp.eval('Boolean(document.querySelector("#projList [data-id=restart_project]"))')
  }, 'project UI not ready')
}

function alive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function closeApp() {
  const pid = child.pid
  await cdp.eval('window.electronAPI.window.close()').catch(() => {})
  await waitFor(() => !alive(pid), 'App did not fully exit')
  cdp = null
  child = null
}

async function main() {
  fs.mkdirSync(userData, { recursive: true })
  fs.mkdirSync(project)
  fs.cpSync(path.dirname(sourceExe), install, { recursive: true })
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ closeToTray: false, sysmonSensors: false, dictationEnabled: false, agyEnabled: false, autoUpdate: false }))
  fs.writeFileSync(path.join(userData, 'workspaces.json'), JSON.stringify({ projects: [
    { id: 'restart_project', name: 'Restart test', path: project, createdAt: Date.now() }
  ] }))
  await launch()
  await cdp.eval('document.querySelector("#projList [data-id=restart_project] .chat-list-open").click()')
  await waitFor(() => cdp.eval('document.querySelector("#projList [data-id=restart_project]")?.classList.contains("active")'), 'project not selected')
  sessionId = await cdp.eval(`(async () => {
    const result = await window.electronAPI.terminal.create({ shell: 'powershell', preset: 'shell', cwd: ${JSON.stringify(project)}, projectId: 'restart_project' })
    if (!result.ok) throw new Error(result.error.message)
    const page = await import('./scripts/terminal-page.js')
    await page.openTerminalSession(result.data.id)
    return result.data.id
  })()`)
  await sleep(1500)
  const command = "& { Set-Content -LiteralPath 'shell-pid.txt' $PID; 1..240 | ForEach-Object { Add-Content -LiteralPath 'heartbeat.txt' $_; Write-Output ('CONTINUING_' + $_); Start-Sleep -Milliseconds 250 } }\r"
  await cdp.eval(`window.electronAPI.terminal.write(${JSON.stringify(sessionId)}, ${JSON.stringify(command)})`)
  const heartbeat = () => fs.existsSync(path.join(project, 'heartbeat.txt')) ? fs.readFileSync(path.join(project, 'heartbeat.txt'), 'utf8').trim().split(/\r?\n/).length : 0
  await waitFor(() => heartbeat() >= 3, 'shell heartbeat missing')
  shellPid = Number(fs.readFileSync(path.join(project, 'shell-pid.txt'), 'utf8').replace(/^\uFEFF/, '').trim())
  assert.ok(shellPid > 0 && alive(shellPid))
  const before = heartbeat()
  await closeApp()
  assert.ok(alive(shellPid), 'App 完全結束後，同一個 shell 必須繼續運行')
  await waitFor(() => heartbeat() >= before + 4, '關閉 App 期間指令沒有繼續執行', 5000)
  console.log('PASS App 已結束，原 shell PID 與磁碟心跳繼續')

  // 只覆寫本測試自己的安裝副本。這些檔案若仍被宿主使用，Windows 會拒絕覆寫。
  for (const rel of ['VoiceInk.exe', 'resources/app.asar']) {
    fs.copyFileSync(path.join(path.dirname(sourceExe), rel), path.join(install, rel))
  }
  const nativeRoot = 'resources/app.asar.unpacked/node_modules/@lydell/node-pty-win32-x64'
  fs.cpSync(path.join(path.dirname(sourceExe), nativeRoot), path.join(install, nativeRoot), { recursive: true, force: true })
  assert.ok(alive(shellPid), '替換安裝檔案不可以結束 shell')
  console.log('PASS 可替換 exe／asar／PTY native 檔案，shell 不受影響')

  await launch()
  await waitFor(() => cdp.eval(`Boolean(document.querySelector('.ws-tab[data-id="${sessionId}"].is-active'))`), '重開沒有自動還原終端機分頁')
  const snapshot = await cdp.eval(`window.electronAPI.terminal.open(${JSON.stringify(sessionId)}, 100, 30)`)
  assert.equal(snapshot.ok, true)
  assert.ok(snapshot.data.buffer.includes('CONTINUING_'), '重開必須拿到之前與關閉期間的輸出')
  assert.ok(alive(shellPid))
  assert.equal(Number(fs.readFileSync(path.join(project, 'shell-pid.txt'), 'utf8').replace(/^\uFEFF/, '').trim()), shellPid, '不可重新執行原本的啟動指令')
  console.log('PASS 自動還原原分頁與輸出，同一個 shell 持續運行')
  await cdp.eval(`window.electronAPI.terminal.delete(${JSON.stringify(sessionId)})`)
  sessionId = ''
  await waitFor(() => !alive(shellPid), '明確刪除終端機後仍在運行')
  console.log('PASS 只有明確關閉終端機才結束程序')
  await closeApp()
  console.log('PASS terminal restart/update continuity')
}

main().catch(error => { console.error('FAIL', error.message); process.exitCode = 1 }).finally(async () => {
  if (sessionId && cdp) await cdp.eval(`window.electronAPI.terminal.delete(${JSON.stringify(sessionId)})`).catch(() => {})
  cdp?.ws.close()
  if (child?.pid && alive(child.pid)) {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* own process already exited */ }
  }
  if (shellPid && alive(shellPid)) {
    try { execFileSync('taskkill', ['/PID', String(shellPid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* own shell already exited */ }
  }
  console.log(`Evidence: ${testRoot}`)
})
