#!/usr/bin/env node
/**
 * VoiceInk — 系統監控端到端測試（真的拉起 PowerShell 取樣器）
 *
 *   node_modules/electron/dist/electron.exe scripts/e2e-sysmon.js
 *
 * 驗證：
 *  - probe.ps1 真的跑得起來（BOM／AutoFlush／stdin 指令都對）
 *  - 靜態清單有 CPU／記憶體／磁碟區
 *  - 連續兩輪之後 CPU%／記憶體／磁碟數字是活的（不是一整排 0）
 *  - 每進程 GPU 與 VRAM 欄位存在（有 GPU 活動時才會有值）
 *  - 背壓：取樣期間不會有兩輪同時在飛
 *  - 結束工作：**自己 spawn 一顆子程序**再殺掉，絕不碰使用者的程序
 *  - 受保護的 pid 與型別錯誤都擋得住
 *  - shutdown() 之後 PowerShell 與 nvidia-smi 真的收得掉（不留孤兒）
 *
 * userData 指到暫存目錄。
 */

'use strict'

const { app, dialog } = require('electron')
const path = require('path')
const os = require('os')
const fs = require('fs')
const { spawn, execFileSync } = require('child_process')

const SANDBOX = path.join(os.tmpdir(), `voiceink-e2e-sysmon-${process.pid}`)
fs.mkdirSync(SANDBOX, { recursive: true })
app.setPath('userData', SANDBOX)

if (dialog && dialog.showErrorBox) dialog.showErrorBox = () => {}
process.on('uncaughtException', (err) => {
  console.log('UNCAUGHT', err && err.stack)
  process.exit(3)
})

let passed = 0
let failed = 0
function ok(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  PASS ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 這顆 PowerShell 的 pid 還在不在 */
function pidAlive(pid) {
  try {
    const out = execFileSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/NH'], {
      windowsHide: true, encoding: 'utf8'
    })
    return out.includes(String(pid))
  } catch {
    return false
  }
}

async function main() {
  const ROOT = path.join(__dirname, '..')
  const { createSysmonService } = require(path.join(ROOT, 'src/main/sysmon'))
  const metrics = require(path.join(ROOT, 'src/main/sysmon/metrics.js'))

  // 記下取樣器開了哪些子程序，收尾時驗證真的收掉
  /** @type {number[]} */
  const spawned = []
  const service = createSysmonService({
    samplerDeps: {
      spawnFn: (cmd, args, opts) => {
        const child = spawn(cmd, args, opts)
        if (child.pid) spawned.push(child.pid)
        return child
      }
    }
  })

  /** @type {any[]} */
  const samples = []
  /** @type {any[]} */
  const errors = []
  service.setEmitter((payload) => {
    if (payload.type === 'sample') samples.push(payload.data)
    if (payload.type === 'error') errors.push(payload.data)
  })

  console.log('\n[啟動]')
  const started = service.start('fast')
  ok('start 回報執行中', started.running === true && started.intervalKey === 'fast')
  ok('未知的間隔 key 退回 normal', (() => {
    const s = service.start('這不是合法的 key')
    return s.intervalKey === 'normal'
  })())
  service.start('fast')

  // 冷啟動 ~190ms + 每輪 ~310ms。**不要寫死 sleep**：機器忙的時候（例如同時在跑別的
  // 測試）一輪會拖到一秒以上，固定等 4 秒就會偶發只收到一筆，看起來像產品壞掉。
  {
    const deadline = Date.now() + 30_000
    while (samples.length < 3 && Date.now() < deadline) await sleep(250)
  }

  console.log('\n[取樣]')
  ok('有收到取樣', samples.length >= 2, `只有 ${samples.length} 筆`)
  ok('取樣期間沒有錯誤', errors.length === 0, JSON.stringify(errors))

  const last = samples[samples.length - 1]
  ok('進程數量像一台真的機器', last.processes.length > 50, `只有 ${last.processes?.length}`)
  ok('每一列都有 pid 與名稱', last.processes.every((p) => p.pid >= 0 && typeof p.name === 'string'))
  ok('CPU% 落在 0–100', last.processes.every((p) => p.cpu >= 0 && p.cpu <= 100))
  ok('至少有一個進程用到 CPU', last.processes.some((p) => p.cpu > 0),
    '第一輪之後全 0 代表差值算錯了')
  ok('記憶體是有意義的數字', last.processes.some((p) => p.memory > 1024 * 1024))
  ok('整機 CPU 有值', last.cpu && last.cpu.perCore.length === os.cpus().length)
  ok('整機 CPU 總量落在 0–100', last.cpu.total >= 0 && last.cpu.total <= 100)
  ok('可用記憶體小於總量', last.memory && last.memory.available > 0 && last.memory.available < os.totalmem())
  ok('有磁碟計數器', Array.isArray(last.disks) && last.disks.length > 0)
  ok('有網路介面', Array.isArray(last.nets))
  ok('每進程有 GPU 與 VRAM 欄位', last.processes.every((p) => 'gpu' in p && 'gpuMemory' in p))
  ok('沒有負速率', last.processes.every((p) => p.diskRead >= 0 && p.diskWrite >= 0))
  ok('進程名沒有 #1 後綴', last.processes.every((p) => !/#\d+$/.test(p.name)))

  console.log('\n[硬體清單]')
  const inv = service.inventory()
  ok('有拿到硬體清單', Boolean(inv))
  ok('CPU 有型號與核心數', inv.cpus.length > 0 && inv.cpus[0].name.length > 0 && inv.cpus[0].threads > 0)
  ok('CPU 邏輯核心數與 os.cpus() 一致',
    inv.cpus.reduce((n, c) => n + c.threads, 0) === os.cpus().length)
  ok('有記憶體模組', inv.memoryModules.length > 0)
  ok('記憶體模組容量加起來接近實體記憶體',
    Math.abs(inv.memoryModules.reduce((n, m) => n + m.capacity, 0) - os.totalmem()) < os.totalmem() * 0.1)
  ok('有 GPU', inv.gpus.length > 0)
  ok('有磁碟區', inv.volumes.length > 0 && inv.volumes[0].size > 0)
  ok('有 OS 資訊', inv.os && inv.os.build.length > 0)

  // ── S.M.A.R.T.：這一段是真的打 IOCTL，mock 證明不了它讀不讀得到 ──────
  // NVMe 一定要讀得到（access=0 免提權）；整台都是 SATA 的機器可能拿不到，
  // 所以「有沒有 NVMe」先自己判斷再決定要不要嚴格斷言
  const nvme = inv.physicalDisks.filter((d) => /nvme/i.test(d.busType))
  ok('實體磁碟帶磁區大小與分割配置',
    inv.physicalDisks.length > 0 && inv.physicalDisks.every((d) => d.logicalSector > 0 && d.partitionStyle.length > 0))
  ok('有一顆是開機碟', inv.physicalDisks.some((d) => d.isBoot))
  if (nvme.length === 0) {
    console.log('  SKIP 這台沒有 NVMe，跳過 SMART 斷言')
  } else {
    const sm = nvme.map((d) => inv.smart.find((x) => x.id === d.id)).filter(Boolean)
    ok('每顆 NVMe 都讀得到 SMART（不必提權）', sm.length === nvme.length)
    ok('SMART 有通電時數與通電次數', sm.every((x) => x.powerOnHours > 0 && x.powerCycles > 0))
    // 換算錯的症狀是「17134 度」而不是報錯，所以要卡合理範圍
    ok('溫度落在合理範圍（0～110 °C）', sm.every((x) => x.tempC > 0 && x.tempC < 110))
    ok('有寫入總量且不為負', sm.every((x) => x.bytesWritten > 0 && x.bytesRead > 0))
    ok('已用壽命是 0～100 的百分比', sm.every((x) => x.usedPct >= 0 && x.usedPct <= 100))
    ok('main 已算好健康度', sm.every((x) => ['good', 'caution', 'bad'].includes(x.health?.level)))
    ok('NVMe 規格版本讀得到', sm.every((x) => /^\d+\.\d+\.\d+$/.test(x.specVersion)))
    ok('tick 也帶得到即時溫度', (last.driveTemps || []).length > 0 && last.driveTemps.every((t) => t.tempC > 0 && t.tempC < 110))
  }

  console.log('\n[狀態]')
  const status = service.status()
  ok('status 回報執行中', status.running === true)
  ok('status 有邏輯核心數', status.logicalCores === os.cpus().length)
  ok('status 有 GPU feed 旗標', typeof status.gpuFeed === 'boolean')
  ok('status 有感測器狀態', status.sensors && typeof status.sensors.state === 'string')
  ok('感測器沒啟用時不是 on', status.sensors.state !== 'on')

  console.log('\n[進程細節]')
  const detail = await service.detail(process.pid)
  ok('查得到自己的細節', detail && detail.pid === process.pid)
  ok('細節有執行檔路徑', detail && detail.path.toLowerCase().includes('electron'))
  ok('壞 pid 回 null 不丟例外', (await service.detail('x')) === null)

  console.log('\n[結束工作]')
  // 自己開一顆才殺，絕不碰使用者的程序
  const victim = spawn('cmd.exe', ['/c', 'ping -n 30 127.0.0.1 > nul'], {
    windowsHide: true, stdio: 'ignore'
  })
  await sleep(400)
  ok('測試用的子程序活著', pidAlive(victim.pid))
  const killed = await service.killProcess(victim.pid, true)
  ok('強制結束回報成功', killed.pid === victim.pid && killed.forced === true)
  await sleep(600)
  ok('子程序真的不見了', !pidAlive(victim.pid))

  let threw = null
  try { await service.killProcess(4, true) } catch (e) { threw = e }
  ok('pid 4（System）擋下來', threw && threw.code === 'SYSMON_BAD_PID')
  ok('擋下來時有給使用者看得懂的訊息', threw && threw.userMessage.includes('系統核心'))

  threw = null
  try { await service.killProcess('1234', true) } catch (e) { threw = e }
  ok('字串 pid 擋下來', threw && threw.code === 'SYSMON_BAD_PID')

  threw = null
  try { await service.killProcess(process.pid, true) } catch (e) { threw = e }
  ok('不准砍自己', threw && threw.code === 'SYSMON_SELF')

  threw = null
  try { await service.killProcess(999_999_999, false) } catch (e) { threw = e }
  ok('不存在的 pid 回結構化錯誤', threw && threw.code === 'SYSMON_KILL_DENIED')
  ok('錯誤訊息不外洩系統文字', threw && !/taskkill/i.test(threw.userMessage))

  console.log('\n[磁碟測速]')
  const bench = await service.diskBench({ dir: SANDBOX, sizeMb: 128 })
  ok('寫入速度是正數', bench.writeMbPerSec > 0, String(bench.writeMbPerSec))
  ok('讀取速度是正數', bench.readMbPerSec > 0, String(bench.readMbPerSec))
  ok('明講讀取值含快取', bench.readCached === true)
  ok('大小被夾到下限', bench.sizeMb === 128)
  ok('測試檔已刪除',
    !fs.readdirSync(SANDBOX).some((f) => f.includes('disk-bench')),
    fs.readdirSync(SANDBOX).join(','))

  console.log('\n[收程序]')
  const probePids = spawned.filter((pid) => pid)
  ok('取樣器有開過 PowerShell', probePids.length > 0)
  service.shutdown()
  await sleep(1500)
  const alive = probePids.filter(pidAlive)
  ok('shutdown 之後沒有孤兒 PowerShell', alive.length === 0, `還活著：${alive.join(',')}`)
  ok('stop 之後 status 是停止', service.status().running === false)

  console.log('\n[排序與純函式仍一致]')
  ok('metrics 的排序鍵有涵蓋 UI 用得到的欄位',
    ['cpu', 'memory', 'diskTotal', 'gpu', 'gpuMemory', 'name', 'pid'].every((k) => k in metrics.SORT_KEYS))

  console.log(`\n${passed} passed, ${failed} failed`)
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* Windows 有時晚一點才放手 */ }
  app.exit(failed === 0 ? 0 : 1)
}

app.whenReady().then(main).catch((err) => {
  console.log('FATAL', err && err.stack)
  app.exit(3)
})
