'use strict'

/**
 * 取樣器常駐：再次 start() 必須立刻把上一筆送出來（進頁不必等下一輪 tick）。
 * 純 node，mock spawn，不開 PowerShell。
 */

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const path = require('node:path')
const { createSysmonService } = require(path.join(__dirname, '../src/main/sysmon'))

function fakeProc() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    pid: 1,
    kill() {}
  })
}

const probes = []
const service = createSysmonService({
  samplerDeps: {
    spawnFn() {
      const proc = fakeProc()
      probes.push(proc)
      return proc
    },
    cpusFn: () => [{ times: { user: 1, nice: 0, sys: 0, idle: 1, irq: 0 } }]
  },
  gpuDeps: { spawnFn: () => fakeProc() },
  sensorDeps: { resolveExe: () => '', spawnFn: () => fakeProc() }
})

const samples = []
service.setEmitter((payload) => {
  if (payload.type === 'sample') samples.push(payload.data)
})

async function main() {
  service.start('fast')
  const proc = probes[0]
  assert.ok(proc, '有開取樣器')
  proc.stdin.on('data', (chunk) => {
    const cmd = String(chunk).trim()
    if (cmd.startsWith('tick ')) {
      proc.stdout.write(`#B ${cmd}\nT|1000\n#E ${cmd}\n`)
    } else if (cmd.startsWith('static ')) {
      proc.stdout.write(`#B ${cmd}\n#E ${cmd}\n`)
    }
  })
  proc.stdout.write('#READY\n')
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(samples.length >= 1, `有收到取樣（${samples.length}）`)
  const before = samples.length
  const cpuBefore = samples[samples.length - 1].cpu
  service.start('fast')
  assert.equal(samples.length, before + 1, '再次 start 立刻重送上一筆')
  assert.equal(samples[samples.length - 1].cpu, cpuBefore, '重送帶著上一筆的 CPU 讀數')
  await service.shutdown()
  console.log('PASS 再次 start 立刻重送上一筆')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
