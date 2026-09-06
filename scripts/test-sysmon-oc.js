/**
 * 效能調整：sanitize／夾值／panic／sidecar 短鍵解析。不碰硬體。
 * 用法：node scripts/test-sysmon-oc.js
 */
'use strict'

const assert = require('assert')
const oc = require('../src/main/sysmon/oc')

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

console.log('test-sysmon-oc')

check('GPU 偏移超出就夾住', () => {
  const gpu = oc.sanitizeGpu({ coreMHz: 999, memMHz: -900, powerPct: 10 })
  assert.strictEqual(gpu.coreMHz, oc.CORE_MAX)
  assert.strictEqual(gpu.memMHz, oc.MEM_MIN)
  assert.strictEqual(gpu.powerPct, oc.POWER_MIN)
})

check('GPU 缺值退回 0／100', () => {
  const gpu = oc.sanitizeGpu(null)
  assert.strictEqual(gpu.coreMHz, 0)
  assert.strictEqual(gpu.memMHz, 0)
  assert.strictEqual(gpu.powerPct, 100)
  assert.strictEqual(gpu.voltMv, 0)
  assert.strictEqual(gpu.tempC, 90)
})

check('電壓與 CO 夾值', () => {
  const gpu = oc.sanitizeGpu({ voltMv: 400, tempC: 40 })
  assert.strictEqual(gpu.voltMv, oc.VOLT_MAX)
  assert.strictEqual(gpu.tempC, 65)
  const cpu = oc.sanitizeCpu({ coAll: -80, freqMhz: 9000, cores: [99, -99] }, { coreCount: 2 })
  assert.strictEqual(cpu.coAll, oc.CO_MIN)
  assert.strictEqual(cpu.freqMhz, 5000)
  assert.deepStrictEqual(cpu.cores, [30, -30])
})

check('CPU 有工廠值就夾在 50%～150%', () => {
  const cpu = oc.sanitizeCpu({ pptW: 1000, tdcA: 1, edcA: 90, scalarX100: 50 }, { pptW: 88, tdcA: 60, edcA: 90 })
  assert.strictEqual(cpu.pptW, Math.round(88 * 1.5))
  assert.strictEqual(cpu.tdcA, Math.round(60 * 0.5))
  assert.strictEqual(cpu.edcA, 90)
  assert.strictEqual(cpu.scalarX100, oc.SCALAR_MIN)
})

check('沒有工廠值退回絕對上下限', () => {
  assert.strictEqual(oc.clampAround(1000, 0, 15, 400), 400)
  assert.strictEqual(oc.clampAround(1, null, 15, 400), 15)
})

check('sidecar 短鍵解析', () => {
  const live = oc.parseLive({
    c: { w: 1, n: 'Ryzen 7 5700X', t: 52.3, k: 4650, p: 88, d: 60, e: 90, s: 100, fp: 88, a: 0 },
    g: { w: 1, n: 'RTX', t: 45, k: 2100, m: 8000, co: 50, mo: -100, pw: 110, a: 1 }
  })
  assert.strictEqual(live.cpu.writable, true)
  assert.strictEqual(live.cpu.pptW, 88)
  assert.strictEqual(live.gpu.coreMHz, 50)
  assert.strictEqual(live.gpu.applied, true)
})

check('壞掉的框不會炸', () => {
  const live = oc.parseLive(null)
  assert.strictEqual(live.cpu.writable, false)
  assert.strictEqual(live.gpu.clock, null)
})

check('引擎套用前感測器沒開會丟結構化錯誤', () => {
  const engine = oc.createOcEngine({
    sensors: { read: () => ({ available: false, oc: null }), send: () => true }
  })
  let code = ''
  try { engine.apply() } catch (error) { code = error.code }
  assert.strictEqual(code, 'SYSMON_OC_OFF')
})

check('兩路都不可寫會講原因', () => {
  const engine = oc.createOcEngine({
    sensors: {
      read: () => ({ available: true, oc: { c: { w: 0, r: 'cpu no' }, g: { w: 0, r: 'gpu no' } } }),
      send: () => true
    }
  })
  let message = ''
  try { engine.apply() } catch (error) { message = error.userMessage }
  assert.ok(message.includes('還沒接') || message.includes('cpu no') || message.includes('gpu no'))
})

check('套用只送數字指令', () => {
  const sent = []
  const engine = oc.createOcEngine({
    sensors: {
      read: () => ({
        available: true,
        oc: { c: { w: 1, p: 88, d: 60, e: 90, fp: 88, fd: 60, fe: 90 }, g: { w: 1 } }
      }),
      send: (line) => { sent.push(line); return true }
    }
  })
  engine.setDraft({
    gpu: { coreMHz: 75, memMHz: 200, powerPct: 110, voltMv: 25, tempC: 88 },
    cpu: { pptW: 100, tdcA: 70, edcA: 100, scalarX100: 125, coAll: -10, freqMhz: 0, tctlC: 85, cores: [-5, 0] }
  })
  engine.apply()
  assert.ok(sent.some((line) => /^G 75 200 110 25 88$/.test(line)), sent.join('|'))
  assert.ok(sent.some((line) => /^C 100 70 100 125 -10 0 85 0 0$/.test(line)), sent.join('|'))
  assert.ok(sent.some((line) => line.startsWith('K ')), sent.join('|'))
})

check('CPU 電壓 0＝自動，低於 0.8V 也當自動', () => {
  assert.strictEqual(oc.sanitizeCpu({ voltMv: 0 }, {}).voltMv, 0)
  assert.strictEqual(oc.sanitizeCpu({ voltMv: 775 }, {}).voltMv, 0)
  assert.strictEqual(oc.sanitizeCpu({ voltMv: 1200 }, {}).voltMv, 1200)
  assert.strictEqual(oc.sanitizeCpu({ voltMv: 1800 }, {}).voltMv, oc.CPU_VOLT_MAX)
})

check('即時讀數解析負載／每核／實際功耗', () => {
  const live = oc.parseLive({
    c: { w: 1, p: 42, pl: 88, u: 17, v: 1.21, ck: [4200, 4100, 0], fp: 88 },
    g: { w: 1, k: 2100, pd: 91, u: 55, vl: 0.95, h: 62 }
  })
  assert.strictEqual(live.cpu.powerW, 42)
  assert.strictEqual(live.cpu.pptW, 88)
  assert.strictEqual(live.cpu.load, 17)
  assert.strictEqual(live.cpu.volt, 1.21)
  assert.deepStrictEqual(live.cpu.cores, [4200, 4100, 0])
  assert.strictEqual(live.gpu.powerW, 91)
  assert.strictEqual(live.gpu.load, 55)
  assert.strictEqual(live.gpu.hotspot, 62)
})

check('套用手動超頻會帶 CPU 電壓', () => {
  const sent = []
  const engine = oc.createOcEngine({
    sensors: {
      read: () => ({
        available: true,
        oc: { c: { w: 1, p: 88, d: 60, e: 90, fp: 88, fd: 60, fe: 90 }, g: { w: 0 } }
      }),
      send: (line) => { sent.push(line); return true }
    }
  })
  engine.setDraft({ cpu: { freqMhz: 4200, voltMv: 1200, pptW: 88, tdcA: 60, edcA: 90 } })
  engine.apply()
  assert.ok(sent.some((line) => /^C 88 60 90 100 0 4200 90 1200 0$/.test(line)), sent.join('|'))
})

check('SoC 電壓與每核時脈夾值', () => {
  const cpu = oc.sanitizeCpu({ socMv: 2000, freqCores: [0, 4200, 9000] }, { coreCount: 3 })
  assert.strictEqual(cpu.socMv, oc.SOC_MAX)
  assert.deepStrictEqual(cpu.freqCores, [0, 4200, 5000])
  assert.strictEqual(oc.sanitizeCpu({ socMv: 875 }, {}).socMv, 0)
})

check('V/F 點偏移夾在核心範圍', () => {
  const gpu = oc.sanitizeGpu({ vfDeltas: [10, 999, -400] })
  assert.deepStrictEqual(gpu.vfDeltas, [10, 200, -200])
})

check('套用會送每核時脈與 V/F 點', () => {
  const sent = []
  const engine = oc.createOcEngine({
    sensors: {
      read: () => ({
        available: true,
        oc: { c: { w: 1, p: 88, d: 60, e: 90, fp: 88, fd: 60, fe: 90 }, g: { w: 1 } }
      }),
      send: (line) => { sent.push(line); return true }
    }
  })
  engine.setDraft({
    cpu: { pptW: 88, tdcA: 60, edcA: 90, freqMhz: 4200, freqCores: [0, 4300], socMv: 1050 },
    gpu: { coreMHz: 50, vfDeltas: [0, 25, -10] }
  })
  engine.apply()
  assert.ok(sent.some((line) => line.startsWith('F ') && line.includes('4300')), sent.join('|'))
  assert.ok(sent.some((line) => /^V 3 0 25 -10$/.test(line)), sent.join('|'))
  assert.ok(sent.some((line) => / 1050$/.test(line) && line.startsWith('C ')), sent.join('|'))
})

check('解析 V/F 與 SoC 短鍵', () => {
  const live = oc.parseLive({
    c: { so: 1.05, sv: 1050 },
    g: { vf: [[12, 800, 1500, 40], [13, 900, 1800, 0]] }
  })
  assert.strictEqual(live.cpu.soc, 1.05)
  assert.strictEqual(live.gpu.vf.length, 2)
  assert.strictEqual(live.gpu.vf[0].v, 800)
})

check('panic 用未平滑的原始溫度', () => {
  assert.strictEqual(oc.isPanic(96, 40, 95), true)
  assert.strictEqual(oc.isPanic(80, 40, 95), false)
  assert.strictEqual(oc.isPanic(null, null, 95), true)
  assert.strictEqual(oc.isPanic(null, 40, 95), false)
})

check('shutdown 已套用時會還原', () => {
  const sent = []
  const engine = oc.createOcEngine({
    sensors: {
      read: () => ({
        available: true,
        oc: { c: { w: 0 }, g: { w: 1 } }
      }),
      send: (line) => { sent.push(line); return true }
    }
  })
  engine.apply()
  sent.length = 0
  engine.shutdown()
  assert.ok(sent.includes('X'))
})

if (failed) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nall passed')
