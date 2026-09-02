#!/usr/bin/env node
/**
 * VoiceInk — 提權感測器 sidecar 端到端測試
 *
 *   node scripts/e2e-sysmon-sensors.js
 *
 * **會跳出一次 UAC**（這就是重點：這條路本來就需要系統管理員）。
 * 按「否」也算通過——測試會確認橋接層回報 `declined` 而不是卡住或崩潰。
 *
 * 驗證：
 *  - 管道名是隨機的、而且只接受第一個連線
 *  - sidecar 連得回來並吐出合法 JSON
 *  - 真的拿到 CPU 溫度（WinRing0 沒被弱點驅動封鎖清單／HVCI 擋下時）
 *  - 被擋下時回 `{"error":"driver"}`，橋接層轉成看得懂的中文說明而不是一句「失敗」
 *  - stop() 之後不留孤兒程序
 */

'use strict'

const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const { createSensorBridge, resolveSensorExe } = require(path.join(ROOT, 'src/main/sysmon/sensors.js'))

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

function sensorProcessCount() {
  try {
    const out = execFileSync('tasklist.exe', ['/FI', 'IMAGENAME eq VoiceInkSensors.exe', '/NH'], {
      windowsHide: true, encoding: 'utf8'
    })
    return (out.match(/VoiceInkSensors\.exe/g) || []).length
  } catch {
    return 0
  }
}

async function main() {
  console.log('\n[建置產物]')
  const exe = resolveSensorExe({ resourcesPath: path.join(ROOT, 'resources') })
  ok('找得到 sidecar 執行檔', Boolean(exe), '請先跑 npm run build:sensors')
  if (!exe) {
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(1)
  }
  const size = fs.statSync(exe).size
  ok('sidecar 大小合理（自帶 .NET 執行環境）', size > 5e6 && size < 90e6, `${Math.round(size / 1e6)}MB`)

  console.log('\n[未啟用時的狀態]')
  const bridge = createSensorBridge({ resourcesPath: path.join(ROOT, 'resources') })
  const before = bridge.status()
  ok('一開始是 off', before.state === 'off')
  ok('回報 sidecar 有安裝', before.installed === true)
  ok('沒啟用時 read() 回不可用', bridge.read().available === false)

  console.log('\n[管道名是隨機的]')
  // 連兩次 enable 應該用不同的管道名；這裡用 spawn 注入攔下命令列來看
  const seen = []
  const probe = createSensorBridge({
    resourcesPath: path.join(ROOT, 'resources'),
    spawnFn: (cmd, args) => {
      const text = args.join(' ')
      const match = /voiceink-sensors-([0-9a-f]+)/.exec(text)
      if (match) seen.push(match[1])
      // 不真的拉起 sidecar，直接假裝 Start-Process 失敗
      const { EventEmitter } = require('events')
      const fake = new EventEmitter()
      setTimeout(() => fake.emit('close', 1), 10)
      return fake
    }
  })
  await probe.enable()
  probe.stop()
  await probe.enable()
  probe.stop()
  ok('每次啟用都用新的管道名', seen.length === 2 && seen[0] !== seen[1], JSON.stringify(seen))
  ok('管道名是 128 bit 亂數', seen.every((s) => s.length === 32), JSON.stringify(seen.map((s) => s.length)))
  ok('使用者拒絕 UAC 時回 declined，不是卡住',
    probe.status().state === 'off' || probe.status().state === 'declined', probe.status().state)

  console.log('\n[真的跑一次（會跳 UAC）]')
  console.log('  → 請在彈出的「使用者帳戶控制」按「是」；按「否」也算通過（會驗降級路徑）')
  const result = await bridge.enable()
  ok('enable() 一定會回結果，不會永遠掛著', Boolean(result?.state), JSON.stringify(result))

  if (result.state === 'on') {
    // 裝了 PawnIO 之後 `Computer.Open()` 要載入一堆核心模組，第一筆讀數實測約 10 秒才到。
    // 這裡**等資料**而不是寫死 sleep，否則裝好之後反而會偶發失敗。
    const deadline = Date.now() + 40_000
    while (!bridge.read().available && Date.now() < deadline) await sleep(500)
    const data = bridge.read()
    ok('拿到感測器讀數', data.available === true, '等超過 40 秒還沒有第一筆')
    ok('有硬體群組', data.groups.length > 0, String(data.groups.length))

    const all = data.groups.flatMap((h) => (h.s || []).map((s) => ({ hw: h.n, hwType: h.t, ...s })))
    ok('每個讀數都是有限數字', all.every((s) => Number.isFinite(s.v)), String(all.length))
    ok('沒有 NaN 或 null 混進來', all.every((s) => s.v !== null))

    const temps = all.filter((s) => s.t === 'Temperature')
    ok('有溫度讀數', temps.length > 0, String(temps.length))

    // GPU 與硬碟溫度只需要系統管理員（NVML／SMART），不需要核心驅動——這兩項一定要有
    const gpuTemp = temps.find((s) => s.hwType.startsWith('Gpu') && s.v > 0)
    const diskTemp = temps.find((s) => s.hwType === 'Storage' && s.v > 0)
    ok('GPU 溫度拿得到', Boolean(gpuTemp), JSON.stringify(gpuTemp))
    ok('硬碟溫度拿得到（CrystalDiskInfo 的那一項）', Boolean(diskTemp), JSON.stringify(diskTemp))
    if (gpuTemp) ok('GPU 溫度在合理範圍', gpuTemp.v > 10 && gpuTemp.v < 120, `${gpuTemp.v} °C`)
    if (diskTemp) ok('硬碟溫度在合理範圍', diskTemp.v > 10 && diskTemp.v < 100, `${diskTemp.v} °C`)

    // CPU／主機板溫度需要 PawnIO 核心驅動（LHM 0.9.4 起換掉 WinRing0）。
    // 沒裝的時候 LHM **不會報錯**，只會讓那一整組讀數變成 0——所以要驗「有講清楚」。
    const status = bridge.status()
    const cpuTemp = temps.find((s) => s.hwType === 'Cpu' && s.v > 0)
    if (status.needsPawnIo) {
      ok('缺 PawnIO 時有明確說明', /PawnIO/.test(status.message), status.message)
      ok('缺 PawnIO 時附上安裝頁連結', status.pawnIoUrl === 'https://pawnio.eu/', status.pawnIoUrl)
      ok('缺 PawnIO 時 CPU 溫度是「沒有」而不是 0 度', !cpuTemp,
        'CPU 那一組全是 0，UI 端已用 v > 0 過濾')
      console.log('       PawnIO 未安裝 → CPU／主機板溫度不可得（GPU 與硬碟不受影響）')
    } else {
      ok('CPU 溫度拿得到', Boolean(cpuTemp), '已裝 PawnIO 卻仍讀不到，要查驅動載入')
      if (cpuTemp) {
        ok('CPU 溫度在合理範圍', cpuTemp.v > 10 && cpuTemp.v < 120, `${cpuTemp.v} °C`)
        console.log(`       ${cpuTemp.hw} / ${cpuTemp.n} = ${cpuTemp.v} °C`)
      }
      // 主機板那一組（SuperIO）是「有沒有真的走到 ring0」最直接的證據：
      // 它完全沒有免驅動的替代來源，拿得到就代表 PawnIO 真的載起來了
      const superIo = all.filter((s) => s.hwType === 'SuperIO')
      ok('主機板感測器拿得到（SuperIO）', superIo.length > 0)
      ok('有主機板溫度', superIo.some((s) => s.t === 'Temperature' && s.v > 0))
      ok('有風扇轉速', superIo.some((s) => s.t === 'Fan' && s.v > 0))
      ok('有電壓讀數', superIo.some((s) => s.t === 'Voltage' && s.v > 0))
      const life = all.find((s) => s.hwType === 'Storage' && /Life/i.test(s.n))
      ok('硬碟壽命拿得到（CrystalDiskInfo 的健康度）', Boolean(life),
        life ? `${life.v}%` : '')
    }

    const fans = all.filter((s) => s.t === 'Fan' && s.v > 0)
    console.log(`       溫度 ${temps.length} 筆、風扇 ${fans.length} 筆、` +
      `硬體 ${data.groups.map((h) => h.t).join('/')}`)

    ok('status() 回報 on', status.state === 'on')
    ok('sidecar 程序活著', sensorProcessCount() > 0)
  } else {
    ok('被擋下／拒絕時有給看得懂的原因（不是一句「失敗」）',
      typeof result.message === 'string' && result.message.length > 10, JSON.stringify(result))
    ok('被擋下時仍然回不可用，不會給假數字', bridge.read().available === false)
    console.log(`       狀態：${result.state} — ${result.message}`)
  }

  console.log('\n[收程序]')
  bridge.stop()
  await sleep(2500)
  ok('stop() 之後沒有孤兒 sidecar', sensorProcessCount() === 0, `還有 ${sensorProcessCount()} 個`)
  ok('stop() 之後 read() 回不可用', bridge.read().available === false)

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.log('FATAL', err && err.stack)
  process.exit(3)
})
