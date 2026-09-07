'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { spawn } = require('node:child_process')
const root = path.resolve(__dirname, '..')

if (!process.versions.electron) {
  const child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [__filename], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: 'inherit'
  })
  child.on('exit', code => { process.exitCode = code || 0 })
  child.on('error', error => { console.error(error); process.exitCode = 1 })
} else {
  const { HostClient } = require('../src/main/terminal/host-client')
  const { connection, stageRuntime } = require('../src/main/terminal/host-runtime')
  const userData = fs.mkdtempSync(path.join(root, 'dist/terminal-host-test-'))
  const id = 't_host_continuity'
  const meta = { id, shell: 'powershell', preset: 'shell', cwd: userData, title: 'Host test' }
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  let client = new HostClient(userData, () => {})
  let pid = 0

  async function waitFor(fn, label, timeout = 15000) {
    const until = Date.now() + timeout
    while (Date.now() < until) {
      if (await fn()) return
      await sleep(100)
    }
    throw new Error(label)
  }

  async function rejected(message) {
    const config = connection(userData)
    const socket = net.connect(config.pipe)
    let data = ''
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { socket.destroy(); reject(new Error('未拒絕壞封包')) }, 5000)
      socket.on('connect', () => socket.write(`${JSON.stringify(message)}\n`))
      socket.on('data', chunk => { data += chunk })
      socket.on('error', () => socket.destroy())
      socket.on('close', () => { clearTimeout(timeout); resolve() })
    })
    assert.equal(data, '', '未認證的連線不可以取得終端機資料')
  }

  async function main() {
    // PATH 被別的 whoami.exe／icacls.exe 佔走（Git Bash 的 MSYS 版）時也要建得起宿主資料夾
    const poisoned = fs.mkdtempSync(path.join(root, 'dist/terminal-host-path-'))
    const savedPath = process.env.PATH
    process.env.PATH = ''
    try { assert.ok(connection(poisoned, true)?.token, '找不到 whoami／icacls 就建不出宿主資料夾') }
    finally { process.env.PATH = savedPath; fs.rmSync(poisoned, { recursive: true, force: true }) }
    console.log('PASS 建立宿主資料夾不靠 PATH 找 whoami／icacls')

    const snapshots = await Promise.all([
      client.request('open', { sessionId: id, meta, cols: 100, rows: 30 }, true),
      client.request('open', { sessionId: id, meta, cols: 100, rows: 30 }, true)
    ])
    await waitFor(async () => {
      const states = await client.request('list')
      pid = states[0]?.pid
      return Number.isInteger(pid) && pid > 0
    }, 'ConPTY 沒有啟動 shell')
    assert.ok(Number.isInteger(pid) && pid > 0)
    assert.equal(snapshots[1].id, snapshots[0].id)
    assert.equal((await client.request('list')).length, 1, '同時開啟同一工作階段不可以生出兩顆 shell')
    assert.equal((await client.request('open', { sessionId: id, meta, cols: 100, rows: 30 }, true)).pid, pid)
    console.log('PASS 獨立 runtime 與真 ConPTY，同時開啟沿用同一個 PID')
    await rejected({ id: 1, op: 'list' })
    await rejected({ id: 1, op: 'auth', protocol: 1, token: '界'.repeat(64) })
    await rejected({ id: 1, op: 'auth', protocol: 1, token: '0'.repeat(64) })
    assert.equal((await client.request('list'))[0].pid, pid)
    console.log('PASS 未認證／錯誤通行證／多位元組封包被拒絕，宿主仍可用')
    await assert.rejects(client.request('unknown', { sessionId: id }))
    await assert.rejects(client.request('open', { sessionId: '../escape', meta }))
    await assert.rejects(client.request('write', { sessionId: id, data: {} }))
    console.log('PASS 操作、工作階段 id 與輸入型別驗證')

    await sleep(1500)
    await client.request('write', { sessionId: id, data: "& { Set-Content -LiteralPath 'env.txt' ($env:ELECTRON_RUN_AS_NODE + '|' + $env:ELECTRON_NO_ASAR); 1..24 | ForEach-Object { Add-Content -LiteralPath 'beat.txt' $_; Write-Output ('HOST_KEEP_' + $_); Start-Sleep -Milliseconds 200 } }\r" })
    // shell 正在 Add-Content 時讀會拿到 EBUSY，等下一輪再讀就好。
    let lastBeats = 0
    const beats = () => {
      try { lastBeats = fs.readFileSync(path.join(userData, 'beat.txt'), 'utf8').trim().split(/\r?\n/).length } catch { /* 檔案還沒建立或正被寫入 */ }
      return lastBeats
    }
    await waitFor(() => beats() >= 3, '沒有收到 shell 心跳')
    const before = beats()
    client.disconnect()
    await waitFor(() => beats() >= before + 3, 'App 斷線後 shell 沒有持續執行')
    client = new HostClient(userData, () => {})
    const reattached = await client.request('open', { sessionId: id, meta, cols: 100, rows: 30 }, true)
    assert.equal(reattached.pid, pid)
    assert.ok(reattached.buffer.includes('HOST_KEEP_'))
    assert.equal(fs.readFileSync(path.join(userData, 'env.txt'), 'utf8').trim(), '|', 'Node 宿主環境變數不可污染 shell')
    console.log('PASS App 斷線期間繼續執行，重新接回同一個 PID 與輸出')
    await waitFor(() => beats() === 24, '心跳指令未完成')
    await client.request('write', { sessionId: id, data: 'exit\r' })
    await waitFor(async () => (await client.request('list')).some(item => item.id === id && item.state === 'exited'), '退出後沒有保留已結束狀態')
    client.disconnect()
    client = new HostClient(userData, () => {})
    const ended = await client.request('open', { sessionId: id, meta, cols: 100, rows: 30 }, true)
    assert.equal(ended.state, 'exited')
    assert.equal(ended.pid, pid)
    assert.ok(ended.buffer.includes('HOST_KEEP_'))
    console.log('PASS 已結束的終端機保留畫面，不會因重新接回而重跑')
    await client.request('forget', { sessionId: id })
    assert.equal((await client.request('list')).length, 0)
    console.log('PASS 明確關閉才移除工作階段')

    // 每次改版都會多一份 248MB 的執行環境；舊的沒人用就要清掉，還在跑的不准動。
    const hostRoot = connection(userData).root
    const stale = path.join(hostRoot, 'runtime-0000000000000000000stale')
    fs.mkdirSync(stale, { recursive: true })
    fs.writeFileSync(path.join(stale, 'VoiceInkTerminalHost.exe'), 'x')
    fs.writeFileSync(path.join(stale, 'ready'), '0.0.0')
    const current = stageRuntime(hostRoot)
    assert.ok(fs.existsSync(current.exe), '目前使用的執行環境不可以被清掉')
    assert.equal(fs.existsSync(stale), false, '沒人使用的舊執行環境要清掉')
    console.log('PASS 舊版執行環境會被清掉，目前這份留著')
  }

  main().catch(error => { console.error('FAIL', error); process.exitCode = 1 }).finally(async () => {
    try {
      client.disconnect()
      const cleanup = new HostClient(userData, () => {})
      await cleanup.request('forget', { sessionId: id })
      cleanup.disconnect()
    } catch { /* 未啟動成功就沒有需要清理的測試宿主 */ }
    console.log(`Evidence: ${userData}`)
  })
}
