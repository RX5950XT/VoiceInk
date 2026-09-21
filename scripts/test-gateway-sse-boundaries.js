'use strict'

// 真 ReadableStream 分成單一位元組，確認 CRLF 與 EOF 不會吃掉回覆。
const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { createRequire } = require('module')

async function check(relative, name) {
  const file = path.join(__dirname, '..', relative)
  const context = {
    module: { exports: {} }, require: createRequire(file), Buffer, TextDecoder,
    setTimeout, clearTimeout, process, console
  }
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + `\nmodule.exports = ${name}`, context)
  const expected = [{ text: '你好' }, { text: '尾端' }]
  for (const separator of ['\r\n\r\n', '\n\n']) {
    const bytes = Buffer.from(`data: ${JSON.stringify(expected[0])}${separator}data: ${JSON.stringify(expected[1])}`)
    let index = 0
    const body = new ReadableStream({ pull(controller) {
      if (index === bytes.length) controller.close()
      else controller.enqueue(bytes.subarray(index, ++index))
    } })
    const actual = []
    await context.module.exports({ body }, (frame) => actual.push(frame), () => {})
    assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, `${relative}: ${JSON.stringify(separator)}`)
    assert.equal(body.locked, false)
  }
  console.log(`PASS: ${relative} preserves CRLF, UTF-8 chunks and final data`)
}

async function checkAgyTimeout(withFrame = false) {
  const file = path.join(__dirname, '..', 'src/main/agy/upstream.js')
  let now = 0
  let controller
  let cancelled = false
  const timers = new Set()
  const context = {
    module: { exports: {} }, require: createRequire(file), Buffer, TextDecoder,
    Date: { now: () => now },
    setTimeout(callback, delay) {
      const timer = { callback, at: now + delay }
      timers.add(timer)
      return timer
    },
    clearTimeout(timer) { timers.delete(timer) }, process, console
  }
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + '\nmodule.exports = { pumpSse, UpstreamError }', context)
  const body = new ReadableStream({ start(value) { controller = value }, cancel() { cancelled = true } })
  const pumping = context.module.exports.pumpSse({ body }, () => {})
  now = 30_000
  controller.enqueue(Buffer.from(withFrame ? 'data: {"text":"first"}\n\n' : ': keep-alive\n\n'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(timers.size, 1)
  const timer = [...timers][0]
  assert.equal(timer.at, withFrame ? 150_000 : 60_000, '只有有效首格能切換到 idle deadline')
  const checked = assert.rejects(pumping, error => error?.code === (withFrame ? 'UPSTREAM_IDLE' : 'UPSTREAM_TIMEOUT'))
  now = timer.at
  timer.callback()
  await checked
  assert.equal(cancelled, true)
  assert.equal(timers.size, 0)
  assert.equal(body.locked, false)
  console.log(`PASS: AGY ${withFrame ? 'idle' : 'first-token keep-alive'} timeout, cancelled and unlocked`)
}

async function run() {
  for (const [file, name] of [
    ['src/main/ccswitch/gateway/server.js', 'readSse'],
    ['src/main/agy/upstream.js', 'pumpSse']
  ]) {
    try { await check(file, name) } catch (error) {
      console.error(error)
      process.exitCode = 1
    }
  }
  try { await checkAgyTimeout(); await checkAgyTimeout(true) } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1 })
