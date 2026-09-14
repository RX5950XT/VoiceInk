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
}
run().catch((error) => { console.error(error); process.exitCode = 1 })
