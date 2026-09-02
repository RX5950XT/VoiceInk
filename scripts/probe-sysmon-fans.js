#!/usr/bin/env node
/**
 * 實機風扇控制 probe（**會跳一次 UAC**，且**真的會轉你的風扇**）。
 *
 * 用法：node scripts/probe-sysmon-fans.js
 *
 * 做什麼：走正式管線（sensors.js 橋接 + fans.js 引擎）——
 *  1. 列出偵測到的可控通道與目前轉速
 *  2. 對每一條「有接風扇的」通道：100% 量一次、40% 量一次（各等 4 秒）
 *  3. 全部交還 BIOS、驗證引擎的 dirty 旗標清乾淨
 *
 * 收尾走 sensors.stop() 的正式路徑（先送 R 等 {"reset":1} 再斷線），
 * 跟 App 關閉時做的事一樣——這支 probe 同時也在驗證那條路真的走得通。
 */

'use strict'

const { createSensorBridge } = require('../src/main/sysmon/sensors')
const { createFanEngine } = require('../src/main/sysmon/fans')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  const sensors = createSensorBridge({ resourcesPath: null })
  const store = {
    _data: {},
    get(key) { return this._data[key] },
    set(key, value) { this._data[key] = value }
  }
  const fans = createFanEngine({ sensors, store })
  fans.configure({ store })

  console.log('啟動感測器 sidecar（會跳 UAC）…')
  const status = await sensors.enable()
  console.log(`狀態：${status.state} ${status.message || ''}`)
  if (status.state !== 'on') {
    process.exitCode = 1
    return
  }

  try {
    // 等 indexControls 之後的第一框
    let list = null
    for (let i = 0; i < 15; i += 1) {
      await sleep(1000)
      list = fans.list()
      if (list.available && list.channels.length) break
    }
    if (!list.channels.length) {
      console.log('沒有偵測到可控通道。available =', list.available)
      process.exitCode = 1
      return
    }

    console.log(`\n偵測到 ${list.channels.length} 條可控通道：`)
    for (const channel of list.channels) {
      console.log(`  ${channel.name}  [${channel.hardware}]  rpm=${channel.rpm}  pwm=${channel.pwm}  hwRange=[${channel.hwMin}~${channel.hwMax}]`)
    }

    const withFan = list.channels.filter((c) => (c.rpm || 0) > 200)
    console.log(`\n其中 ${withFan.length} 條有接風扇（rpm > 200），逐條做 100%/40% 實測：`)
    for (const channel of withFan) {
      const rpm = async () => (fans.list().channels.find((c) => c.id === channel.id) || {}).rpm
      // 直接送指令（不經引擎的斜率上限——這裡要的是「一口氣到底」）
      sensors.send(`S ${channel.id} 100`)
      await sleep(4000)
      const hi = await rpm()
      sensors.send(`S ${channel.id} 40`)
      await sleep(4000)
      const lo = await rpm()
      console.log(`  ${channel.name}: @100%=${hi}  @40%=${lo}  => ${hi - lo > 100 ? 'CONTROLLABLE' : 'no response'}`)
    }

    // 引擎接管 → 走曲線 → 全部交還：驗收正式路徑
    console.log('\n引擎接管 5 秒（曲線模式、CPU 溫度來源）…')
    await fans.setChannel(withFan[0].id, { mode: 'curve', source: 'cpu-temp', minPwm: 30 })
    await fans.setEnabled(true)
    await sleep(5000)
    const mid = fans.list().channels.find((c) => c.id === withFan[0].id)
    console.log(`  ${mid.name}: applied=${mid.applied}%  rpm=${mid.rpm}  panic=${mid.panic}`)
    console.log('  store dirty =', store._data.fanControl?.dirty)

    console.log('\n全部交還 BIOS …')
    await fans.setEnabled(false)
    await sensors.stop()
    console.log('  store dirty after release =', store._data.fanControl?.dirty)
    console.log('  （若 >0，引擎有寫入過；正常關閉路徑清掉了它就代表收尾正確）')
    console.log('DONE')
  } catch (error) {
    console.error('例外：', error.stack || error)
    process.exitCode = 1
    try { await sensors.stop() } catch { /* 收尾 */ }
  }
}

main()
