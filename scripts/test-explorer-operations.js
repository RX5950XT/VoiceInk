'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { tempDir, removeTree } = require('./lib/test-temp')

const files = require('../src/main/explorer/fs')
const operations = require('../src/main/explorer/operations')
const recycle = require('../src/main/explorer/recycle')

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

async function main() {
  const root = tempDir('vi-ex-ops-')
  const sourceDir = path.join(root, 'source')
  const destinationDir = path.join(root, 'destination')
  fs.mkdirSync(sourceDir)
  fs.mkdirSync(destinationDir)
  const source = path.join(sourceDir, 'large.bin')
  const sourceBytes = Buffer.alloc(2 * 1024 * 1024, 0x5a)
  fs.writeFileSync(source, sourceBytes)
  const sourceHash = digest(source)
  try {
    const progress = []
    const copied = await operations.run({
      mode: 'copy',
      destination: destinationDir,
      sources: [source],
      onEvent: (event) => { if (event.type === 'progress') progress.push(event) }
    })
    assert.equal(copied.status, 'completed')
    assert.equal(copied.items[0].status, 'completed')
    assert.equal(digest(copied.items[0].destination), sourceHash)
    assert.ok(progress.some((event) => event.bytes > 0 && event.totalBytes >= event.bytes))

    const skipped = await operations.run({
      mode: 'copy',
      destination: destinationDir,
      sources: [source],
      collision: 'skip'
    })
    assert.equal(skipped.items[0].status, 'skipped')

    const kept = await operations.run({
      mode: 'copy',
      destination: destinationDir,
      sources: [source]
    })
    assert.equal(kept.items[0].status, 'completed')
    assert.equal(path.basename(kept.items[0].destination), 'large (2).bin')

    // 同名時覆蓋：舊的那份先進回收筒（救得回來），新的放回原本的名字
    const overwriteTarget = path.join(destinationDir, 'large.bin')
    fs.writeFileSync(overwriteTarget, Buffer.alloc(16, 0x11))
    const overwritten = await operations.run({
      mode: 'copy',
      destination: destinationDir,
      sources: [source],
      collision: 'overwrite'
    })
    assert.equal(overwritten.items[0].status, 'completed')
    assert.equal(overwritten.items[0].destination, overwriteTarget)
    assert.equal(digest(overwriteTarget), sourceHash, '覆蓋後留下的是新的那份')
    const binned = (await recycle.list()).entries.filter((entry) => entry.originalPath === overwriteTarget)
    assert.ok(binned.length >= 1, '被覆蓋掉的舊檔進了回收筒')
    for (const entry of binned) await recycle.purge(entry.recycleKey)

    const cancelController = new AbortController()
    let cancelAtProgress = false
    const cancelled = operations.run({
      mode: 'copy',
      destination: destinationDir,
      sources: [source],
      signal: cancelController.signal,
      onEvent: (event) => {
        if (event.type === 'progress' && event.bytes > 0 && !cancelAtProgress) {
          cancelAtProgress = true
          cancelController.abort()
        }
      }
    })
    const cancelledResult = await cancelled
    assert.equal(cancelledResult.status, 'cancelled')
    assert.equal(cancelledResult.items[0].status, 'cancelled')
    assert.equal(digest(source), sourceHash)

    const missing = path.join(sourceDir, 'retry.txt')
    const retryResult = await operations.run({ mode: 'copy', destination: destinationDir, sources: [missing] })
    assert.equal(retryResult.status, 'failed')
    fs.writeFileSync(missing, 'retry')
    const retried = await operations.retry(retryResult.id)
    assert.equal(retried.status, 'completed')
    assert.equal(fs.readFileSync(retried.items[0].destination, 'utf8'), 'retry')

    const moved = path.join(sourceDir, 'move.txt')
    fs.writeFileSync(moved, 'cross-device')
    const originalRename = fsp.rename
    fsp.rename = async () => { throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }) }
    let movedResult
    try {
      movedResult = await operations.run({ mode: 'move', destination: destinationDir, sources: [moved] })
    } finally {
      fsp.rename = originalRename
    }
    assert.equal(movedResult.status, 'completed')
    assert.equal(fs.existsSync(moved), false)
    assert.equal(fs.readFileSync(movedResult.items[0].destination, 'utf8'), 'cross-device')
    const undone = await operations.undo(movedResult.id)
    assert.equal(undone.status, 'completed')
    assert.equal(fs.readFileSync(moved, 'utf8'), 'cross-device')

    const linkedTarget = path.join(sourceDir, 'linked-target')
    const linked = path.join(sourceDir, 'linked')
    fs.mkdirSync(linkedTarget)
    fs.writeFileSync(path.join(linkedTarget, 'outside.txt'), 'outside')
    const linkResult = require('node:child_process').spawnSync(
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'),
      ['/c', 'mklink', '/J', linked, linkedTarget],
      { windowsHide: true, encoding: 'utf8' }
    )
    if (linkResult.status === 0) {
      const linkedCopy = await operations.run({ mode: 'copy', destination: destinationDir, sources: [linked] })
      assert.equal(linkedCopy.status, 'completed')
      assert.equal(fs.lstatSync(linkedCopy.items[0].destination).isSymbolicLink(), true)
      assert.equal(fs.existsSync(path.join(linkedCopy.items[0].destination, 'outside.txt')), true)
    }
    console.log('PASS: operation center copy progress, collision policy, cancellation, retry, cross-device move, undo')
  } finally {
    await removeTree(root)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
