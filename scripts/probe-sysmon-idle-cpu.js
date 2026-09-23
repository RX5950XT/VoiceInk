/**
 * 量「沒開系統監控頁」時常駐取樣子程序吃多少 CPU／記憶體（背景 30 秒一輪＋Rust 取樣器的驗收）。
 * 用法：node scripts/probe-sysmon-idle-cpu.js（啟動 dist/win-unpacked/VoiceInk.exe，暫存 userData）
 * 同時量正在跑的正式版當對照（沒有就只印打包版）。
 */
const { spawn, execFileSync } = require('child_process')
const path = require('path')
const { tempDir, removeTree } = require('./lib/test-temp')

const EXE = process.env.VOICEINK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
const WINDOW_MS = 60_000
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 常駐取樣子程序（Rust 的 voiceink-probe.exe，或退回時的 probe.ps1／observer.ps1）的
 * { pid, parent, kind, cpuSec, privMB }
 */
function probes() {
  const script = "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'voiceink-probe.exe' -or $_.CommandLine -like '*probe.ps1*' -or $_.CommandLine -like '*observer.ps1*' } | ForEach-Object { $p = Get-Process -Id $_.ProcessId -EA SilentlyContinue; $k = if ($_.CommandLine -match 'observer') { 'observer' } else { 'sysmon' }; if ($p) { '{0}|{1}|{2}|{3}|{4}|{5}' -f $_.ProcessId, $_.ParentProcessId, $p.CPU, [math]::Round($p.PrivateMemorySize64/1MB, 1), $k, $_.Name } }"
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
  return out.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [pid, parent, cpu, mb, kind, name] = line.split('|')
    return { pid: Number(pid), parent: Number(parent), cpuSec: Number(cpu), privMB: Number(mb), kind: `${kind}（${name}）` }
  })
}

async function main() {
  const userData = tempDir('voiceink-idle-')
  const app = spawn(EXE, ['--hidden', `--user-data-dir=${userData}`], { stdio: 'ignore', windowsHide: true })
  try {
    let mine = null
    for (let i = 0; i < 60 && !mine; i++) {
      await sleep(1000)
      mine = probes().find((p) => p.parent === app.pid && p.kind.startsWith('sysmon')) || null
    }
    if (!mine) throw new Error('打包版沒有拉起系統監控取樣器')
    await sleep(15_000) // 讓開機那一輪與 static 查詢跑完，只量穩態
    const before = probes()
    await sleep(WINDOW_MS)
    const after = probes()
    for (const b of before) {
      const a = after.find((p) => p.pid === b.pid)
      if (!a) continue
      const pct = ((a.cpuSec - b.cpuSec) / (WINDOW_MS / 1000)) * 100
      const who = b.parent === app.pid ? '打包版（背景）' : '正式版（對照）'
      console.log(`${who} ${b.kind} pid=${b.pid} CPU=${pct.toFixed(2)}% 單核 · 私有記憶體 ${a.privMB}MB`)
    }
  } finally {
    try { execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 已經結束 */ }
    await sleep(1500)
    removeTree(userData)
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
