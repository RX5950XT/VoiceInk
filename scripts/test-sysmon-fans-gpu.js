/**
 * 風扇控制：第二張 GPU 的槽位與溫度來源。
 * 用法：node scripts/test-sysmon-fans-gpu.js
 */
'use strict'

const assert = require('assert')
const fans = require('../src/main/sysmon/fans')

let failed = 0
function check(name, fn) {
  try {
    fn()
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${error.message}`)
  }
}

console.log('test-sysmon-fans-gpu')

check('有 gpu 與 gpu-2 兩個槽位', () => {
  assert.ok(fans.SLOTS.some((s) => s.id === 'gpu'))
  assert.ok(fans.SLOTS.some((s) => s.id === 'gpu-2'))
})

check('有第二張卡的溫度／負載來源', () => {
  assert.ok(fans.SOURCES.some((s) => s.id === 'gpu2-temp'))
  assert.ok(fans.SOURCES.some((s) => s.id === 'gpu2-load'))
})

check('兩張 Gpu 硬體時 gpu-temp 讀第一張、gpu2-temp 讀第二張', () => {
  const groups = [
    { t: 'Cpu', n: 'Ryzen', s: [{ t: 'Temperature', n: 'Package', v: 50 }] },
    {
      t: 'GpuNvidia', n: 'NVIDIA GeForce RTX 4090',
      s: [{ t: 'Temperature', n: 'GPU Core', v: 62 }, { t: 'Load', n: 'GPU Core', v: 80 }]
    },
    {
      t: 'GpuNvidia', n: 'NVIDIA GeForce RTX 4060',
      s: [{ t: 'Temperature', n: 'GPU Core', v: 41 }, { t: 'Load', n: 'GPU Core', v: 10 }]
    }
  ]
  assert.strictEqual(fans.readSource(groups, 'gpu-temp'), 62)
  assert.strictEqual(fans.readSource(groups, 'gpu2-temp'), 41)
  assert.strictEqual(fans.readSource(groups, 'gpu-load'), 80)
  assert.strictEqual(fans.readSource(groups, 'gpu2-load'), 10)
})

check('只有一張卡時 gpu2 來源是 null 不是 0', () => {
  const groups = [{
    t: 'GpuNvidia', n: 'RTX',
    s: [{ t: 'Temperature', n: 'GPU Core', v: 55 }]
  }]
  assert.strictEqual(fans.readSource(groups, 'gpu2-temp'), null)
})

check('第三張卡有獨立槽位與溫度來源', () => {
  assert.ok(fans.SLOTS.some((s) => s.id === 'gpu-3'))
  assert.ok(fans.SOURCES.some((s) => s.id === 'gpu3-temp'))
  const groups = [
    { t: 'GpuNvidia', n: 'A', s: [{ t: 'Temperature', n: 'GPU Core', v: 60 }] },
    { t: 'GpuNvidia', n: 'B', s: [{ t: 'Temperature', n: 'GPU Core', v: 50 }] },
    { t: 'GpuNvidia', n: 'C', s: [{ t: 'Temperature', n: 'GPU Core', v: 40 }] }
  ]
  assert.strictEqual(fans.readSource(groups, 'gpu3-temp'), 40)
  assert.deepStrictEqual(fans.guessChannel('GPU Fan', 2), { slot: 'gpu-3', source: 'gpu3-temp' })
})

if (failed) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nall passed')
