'use strict'
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const file = path.join(__dirname, '../src/main/sysmon/sampler.js')
const timers = new Map()
let id = 0
const context = { module: { exports: {} }, require: createRequire(file), process, __dirname: path.dirname(file),
  setTimeout(fn, ms) { timers.set(++id, { fn, ms }); return id },
  clearTimeout(key) { timers.delete(key) } }
vm.runInNewContext(fs.readFileSync(file, 'utf8'), context)
const children = []
const sampler = context.module.exports.createSampler({ cpusFn: () => [], spawnFn() {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill() {} })
  proc.commands = []
  proc.stdin.on('data', data => proc.commands.push(data.toString().trim()))
  children.push(proc)
  return proc
} })
try {
  sampler.start()
  const proc = children.at(-1)
  for (const [key, timer] of [...timers]) {
    if (timer.ms === 0) { timers.delete(key); timer.fn() }
  }
  assert.deepEqual(proc.commands, [], 'READY 前不可啟動取樣逾時計時')
  proc.stdout.emit('data', '#READY\n')
  assert.match(proc.commands[0], /^tick /)
  proc.stdout.emit('data', `#B ${proc.commands[0]}\n#E ${proc.commands[0]}\n`)
  assert.match(proc.commands[1], /^static /)
  assert.ok(![...timers.values()].some(timer => timer.ms === 8000), '靜態查詢不套用 tick 的 8 秒上限')
  const periodic = [...timers.values()].find(timer => timer.ms === 2000)
  periodic.fn()
  assert.equal(proc.commands.length, 2, 'static 未完成不能排入 tick')
  proc.stdout.emit('data', `#B ${proc.commands[1]}\n#E ${proc.commands[1]}\n`)
  assert.match(proc.commands[2], /^tick /)
  sampler.stop()
  sampler.start()
  proc.stdout.emit('data', '#READY\n')
  assert.deepEqual(children.at(-1).commands, [], '舊程序不能驅動新程序')
  children.at(-1).stdin.emit('error', new Error('broken pipe'))
  console.log('PASS READY、static 背壓、舊程序與 stdin 錯誤')
} finally { sampler.stop() }
