'use strict'

const assert = require('node:assert/strict')
const net = require('node:net')
const { createSensorBridge } = require('../src/main/sysmon/sensors')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 真管道、假 helper；不提權、不碰硬體。 */
async function main() {
  let client
  const bridge = createSensorBridge({ resolveExe: () => __filename, task: {
    run: (pipe) => new Promise((resolve) => {
      client = net.connect(pipe, () => resolve(true))
      client.on('error', () => {})
    })
  } })
  try {
    const first = bridge.enable()
    const second = bridge.enable()
    assert.equal(first, second, '同時啟動必須等待同一次連線')
    await sleep(80)
    assert.equal(bridge.status().state, 'starting', '只有連線、還沒讀數不能說已啟動')
    client.write('{"h":[],"c":[]}\n')
    assert.equal((await first).state, 'on')
    assert.equal(bridge.status().available, true)
    client.on('data', () => client.write('{"reset":1}\n'))
    await bridge.stop()
    assert.equal(bridge.status().state, 'off')
    console.log('PASS 共用啟動、首筆讀數、停止交還')
  } finally {
    client?.destroy()
    await bridge.stop()
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
