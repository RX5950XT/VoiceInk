'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const file = path.join(__dirname, '../src/main/sysmon/gpu.js')
const timers = new Map()
let timerId = 0
const context = { module: { exports: {} }, require: createRequire(file),
  setTimeout: (fn) => { timers.set(++timerId, fn); return timerId },
  clearTimeout: (id) => timers.delete(id) }
vm.runInNewContext(fs.readFileSync(file, 'utf8'), context)
const children = []
const feed = context.module.exports.createGpuFeed({ spawnFn: (_cmd, args) => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), args, kill() {} })
  children.push(child)
  return child
} })
const row = '0, Test GPU, 8192, 100, 20, 40, 30, 1000, 50\n'
let failed = 0
function check(name, fn) {
  try { fn(); console.log(`PASS ${name}`) }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`) }
  finally { feed.stop(); timers.clear() }
}
check('停止後舊程序的輸出不能把讀數重新標成可用', () => {
  feed.start(2)
  const child = children.at(-1)
  feed.stop()
  child.stdout.emit('data', row)
  assert.equal(feed.read().available, false)
})
check('停止必須取消重啟計時，不干擾下一次啟動', () => {
  feed.start(2)
  children.at(-1).emit('close', 1)
  assert.equal(timers.size, 1)
  feed.stop()
  assert.equal(timers.size, 0)
})
check('舊程序的 error 不能清掉新程序', () => {
  feed.start(2)
  const old = children.at(-1)
  feed.stop()
  feed.start(2)
  old.emit('error', new Error('old process'))
  children.at(-1).emit('close', 1)
  assert.equal(timers.size, 1)
})
check('改取樣間隔會重啟，重複相同間隔不重啟', () => {
  feed.start(2)
  const count = children.length
  feed.start(1)
  assert.equal(children.length, count + 1)
  assert.equal(children.at(-1).args.at(-1), '1')
  feed.start(1)
  assert.equal(children.length, count + 1)
})
check('nvidia-smi 一行都沒吐出來也算卡住', () => {
  feed.start(2)
  const count = children.length
  assert.ok(timers.size >= 1, '開起來就要有看門狗')
  for (const fn of [...timers.values()]) fn()
  assert.ok(children.length > count, `卡住後重開（${children.length}）`)
})
check('讀數卡住會重開 nvidia-smi', () => {
  feed.start(2)
  const child = children.at(-1)
  child.stdout.emit('data', row)
  assert.equal(feed.read().available, true)
  assert.ok(timers.size >= 1, '有卡住看門狗')
  const count = children.length
  for (const fn of [...timers.values()]) fn()
  assert.ok(children.length > count, `卡住後重開（${children.length}）`)
})
process.exitCode = failed ? 1 : 0
