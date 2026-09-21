'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')

const { removeTree } = require('./lib/test-temp')
const operations = require('../src/main/explorer/operations')
const files = require('../src/main/explorer/fs')
const rawFs = require('../src/main/raw-fs')

const C_ROOT = 'C:\\'
const D_ROOT = 'D:\\'
const RUN_PREFIX = `voiceink-ops-probe-${process.pid}-${Date.now()}-`

function makeRunDir(root) {
  assert.equal(fs.existsSync(root), true, `drive is unavailable: ${root}`)
  const dir = path.join(root, `${RUN_PREFIX}${crypto.randomBytes(4).toString('hex')}`)
  fs.mkdirSync(dir)
  return dir
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const input = fs.createReadStream(filePath)
    input.on('error', reject)
    input.on('data', chunk => hash.update(chunk))
    input.on('end', () => resolve(hash.digest('hex')))
  })
}

async function writePayload(filePath, megabytes) {
  const chunk = Buffer.alloc(1024 * 1024, 0x6d)
  const output = await fsp.open(filePath, 'w')
  try {
    for (let index = 0; index < megabytes; index += 1) {
      await output.write(chunk)
    }
  } finally {
    await output.close()
  }
}

function expectDriveRoots(cRun, dRun) {
  const cRoot = path.parse(cRun).root.toUpperCase()
  const dRoot = path.parse(dRun).root.toUpperCase()
  assert.equal(cRoot, C_ROOT.toUpperCase())
  assert.equal(dRoot, D_ROOT.toUpperCase())
  const cStat = fs.statSync(cRun)
  const dStat = fs.statSync(dRun)
  console.log(`drives: ${cRoot} (dev=${cStat.dev}) -> ${dRoot} (dev=${dStat.dev})`)
  assert.notEqual(cRoot, dRoot)
}

async function testCrossVolumeMove(cRun, dRun) {
  const source = path.join(cRun, 'move-source.bin')
  await writePayload(source, 4)
  const sourceHash = await sha256(source)
  const events = []
  const result = await operations.run({
    mode: 'move',
    destination: dRun,
    sources: [source],
    onEvent: event => events.push(event),
  })
  assert.equal(result.status, 'completed')
  assert.equal(result.items[0].status, 'completed')
  const destination = result.items[0].destination
  assert.equal(fs.existsSync(source), false, 'source must be removed only after a complete move')
  assert.equal(await sha256(destination), sourceHash)
  assert.equal(events.some(event => event.type === 'progress' && event.bytes > 0), true)
  console.log(`move: ${path.basename(source)} -> ${path.basename(destination)} sha256=${sourceHash}`)
}

async function testCancellationKeepsSource(cRun, dRun) {
  const source = path.join(cRun, 'cancel-source.bin')
  await writePayload(source, 8)
  const sourceHash = await sha256(source)
  let cancelled = false
  const result = await operations.run({
    mode: 'move',
    destination: dRun,
    sources: [source],
    onEvent: event => {
      if (!cancelled && event.type === 'progress' && event.bytes > 0) {
        cancelled = true
        operations.cancel(event.id)
      }
    },
  })
  assert.equal(result.status, 'cancelled')
  assert.equal(result.items[0].status, 'cancelled')
  assert.equal(fs.existsSync(source), true, 'cancelled move must retain the source')
  assert.equal(await sha256(source), sourceHash)
  assert.equal(fs.existsSync(path.join(dRun, path.basename(source))), false)
  console.log(`cancel: source retained sha256=${sourceHash}`)
}

async function testInjectedWriteFailure(cRun, dRun) {
  const source = path.join(cRun, 'failed-source.bin')
  await writePayload(source, 4)
  const sourceHash = await sha256(source)
  const originalOpen = rawFs.promises.open
  const destinationPrefix = dRun.toLowerCase()
  rawFs.promises.open = async (...args) => {
    const handle = await originalOpen(...args)
    const target = String(args[0]).toLowerCase()
    if (args[1] === 'wx' && target.startsWith(destinationPrefix)) {
      return new Proxy(handle, {
        get(fileHandle, property) {
          if (property === 'write') {
            return async () => {
              const error = new Error('injected write failure')
              error.code = 'EIO'
              throw error
            }
          }
          const value = fileHandle[property]
          return typeof value === 'function' ? value.bind(fileHandle) : value
        },
      })
    }
    return handle
  }
  try {
    const result = await operations.run({
      mode: 'move',
      destination: dRun,
      sources: [source],
    })
    assert.equal(result.status, 'failed')
    assert.equal(result.items[0].status, 'failed')
    assert.equal(fs.existsSync(source), true, 'failed move must retain the source')
    assert.equal(await sha256(source), sourceHash)
    assert.equal(fs.existsSync(path.join(dRun, path.basename(source))), false)
    console.log(`injected failure: item=${result.items[0].status} source-retained=true`)
  } finally {
    rawFs.promises.open = originalOpen
  }
}

async function testPerItemResults(cRun, dRun) {
  const source = path.join(cRun, 'batch-source.txt')
  await fsp.writeFile(source, 'batch-result')
  const missing = path.join(cRun, 'batch-missing.txt')
  const result = await operations.run({
    mode: 'copy',
    destination: dRun,
    sources: [source, missing],
  })
  assert.equal(result.status, 'partial')
  assert.equal(result.items.length, 2)
  assert.equal(result.items[0].status, 'completed')
  assert.equal(result.items[1].status, 'failed')
  assert.equal(fs.existsSync(result.items[0].destination), true)
  console.log(`per-item: ${result.items.map(item => `${path.basename(item.source)}=${item.status}`).join(', ')}`)
}

async function main() {
  let cRun = null
  let dRun = null
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    for (const target of [cRun, dRun].filter(Boolean)) {
      try {
        removeTree(target)
      } catch (error) {
        console.error(`cleanup failed: ${target} (${error.code || 'error'})`)
        process.exitCode = 1
      }
    }
  }
  process.once('exit', cleanup)
  process.once('SIGINT', () => process.exit(130))
  try {
    cRun = makeRunDir(C_ROOT)
    dRun = makeRunDir(D_ROOT)
    expectDriveRoots(cRun, dRun)
    await testCrossVolumeMove(cRun, dRun)
    await testCancellationKeepsSource(cRun, dRun)
    await testInjectedWriteFailure(cRun, dRun)
    await testPerItemResults(cRun, dRun)
    console.log('PASS: real C:/D: cross-volume operation probe')
  } finally {
    cleanup()
  }
}

main().catch(error => {
  console.error(`FAIL: ${error.message}`)
  process.exitCode = 1
})
