#!/usr/bin/env node
/**
 * 「免 UAC 啟動」排程工作的實機 probe（**會跳一次 UAC**：建立工作時）。
 *
 * 用法：node scripts/probe-sensors-task.js
 *
 * 這條路是開機自啟動接管風扇的前提，而它的成敗**完全看不出來**——沒有工作時
 * `sensors.enable()` 會安靜地退回 `-Verb RunAs`（每次彈 UAC），功能照樣「能用」，
 * 只是開機時會卡在一扇沒人按的對話框前面。所以要用真的 schtasks 驗一次：
 *
 *   1. 建立工作（一次 UAC）
 *   2. 觸發它 → **不該再跳 UAC**，而且 sidecar 要真的連上來
 *   3. 確認 sidecar 是提權的（讀得到只有管理員拿得到的 Super I/O 風扇通道）
 *   4. 移除工作（再一次 UAC）
 *
 * 收尾一定會把工作移除，不留在使用者的排程裡。
 */

'use strict'

const { createSensorTask } = require('../src/main/sysmon/sensors-task')
const { createSensorBridge, resolveSensorExe } = require('../src/main/sysmon/sensors')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let passed = 0
let failed = 0
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`PASS  ${name}`) } else { failed++; console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`) }
}

async function main() {
  const userDataPath = require('path').join(process.env.APPDATA || '', 'voiceink')
  const exe = resolveSensorExe({})
  if (!exe) {
    console.log('找不到 VoiceInkSensors.exe，先跑 npm run build:sensors')
    process.exitCode = 1
    return
  }
  console.log('sidecar：', exe)

  // packaged: true 才准安裝。這支 probe 是開發者手動跑的，明白自己在做什麼。
  const task = createSensorTask({ userDataPath, packaged: true })

  const before = await task.status(exe)
  console.log('目前狀態：', JSON.stringify(before))
  if (before.installed) {
    console.log('已經有一個同名工作，先移除（會跳 UAC）…')
    await task.remove()
  }

  try {
    console.log('\n[1] 建立排程工作（會跳一次 UAC，請按「是」）…')
    const created = await task.install(exe)
    ok('工作建立成功', created.installed === true, JSON.stringify(created))
    ok('工作指向現在這支執行檔（不是 stale）', created.stale === false)
    if (!created.installed) {
      process.exitCode = 1
      return
    }

    console.log('\n[2] 用工作啟動 sidecar（**不該再跳 UAC**）…')
    const bridge = createSensorBridge({})
    bridge.configure({ userDataPath, packaged: true })
    const t0 = Date.now()
    const state = await bridge.enable()
    ok('橋接進入 on', state.state === 'on', JSON.stringify(state))
    ok('是走排程工作起來的（不是退回 RunAs）', bridge.launchedByTask() === true)

    let controls = []
    for (let i = 0; i < 30; i += 1) {
      await sleep(1000)
      const data = bridge.read()
      if (data.available) { controls = data.controls; break }
    }
    ok('sidecar 有送資料回來', controls.length > 0, `等了 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    // 讀得到 Super I/O 的風扇通道就代表它真的是提權跑的（未提權那組會整組消失）
    ok('sidecar 確實是提權的（讀得到 Super I/O 通道）',
      controls.some((c) => /lpc/i.test(String(c.id))), JSON.stringify(controls.slice(0, 2)))
    console.log(`    偵測到 ${controls.length} 條可控通道`)

    await bridge.stop()

    console.log('\n[3] 交接檔用完就刪（管道名是密鑰，不留在硬碟上）')
    ok('handoff 檔已被 sidecar 刪掉',
      !require('fs').existsSync(task.handoffPath()), task.handoffPath())
  } finally {
    console.log('\n[4] 移除排程工作（會再跳一次 UAC）…')
    await task.remove()
    const after = await task.status(exe)
    ok('工作已移除（沒有留在使用者的排程裡）', after.installed === false, JSON.stringify(after))
  }

  console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILED'}  ${passed} passed, ${failed} failed\n`)
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((error) => {
  console.error('例外：', error.stack || error)
  process.exitCode = 1
})
