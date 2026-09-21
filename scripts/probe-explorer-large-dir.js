'use strict'

const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const files = require('../src/main/explorer/fs')
const { tempDir } = require('./lib/test-temp')

async function makeDirectory(count) {
  const dir = tempDir(`vi-explorer-${count}-`)
  for (let i = 0; i < count; i += 1) {
    const name = `item-${String(i).padStart(6, '0')}.txt`
    fs.writeFileSync(path.join(dir, name), i === count - 1 ? Buffer.alloc(9) : Buffer.alloc(1))
  }
  return dir
}

async function probe(count) {
  const dir = await makeDirectory(count)
  const started = Date.now()
  const first = await files.listDir(dir, { sort: 'name', limit: 500, offset: 0 })
  const firstMs = Date.now() - started
  assert.equal(first.total, count)
  assert.equal(first.entries.length, Math.min(500, count))
  assert.equal(first.hasMore, count > 500)

  const last = await files.listDir(dir, {
    sort: 'name', limit: 500, offset: Math.max(0, count - 500)
  })
  assert.equal(last.entries.length, Math.min(500, count))
  assert.equal(last.entries[last.entries.length - 1].name, `item-${String(count - 1).padStart(6, '0')}.txt`)

  const sortStarted = Date.now()
  const bySize = await files.listDir(dir, { sort: 'size', desc: true, limit: 1 })
  const sortMs = Date.now() - sortStarted
  assert.equal(bySize.entries[0].name, `item-${String(count - 1).padStart(6, '0')}.txt`)
  console.log(JSON.stringify({ count, firstMs, sortMs, total: first.total, last: last.entries[last.entries.length - 1].name }))
}

;(async () => {
  for (const count of [2000, 10000, 50000]) await probe(count)
  console.log('PASS: explorer 2k/10k/50k complete ordering and last-page access')
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
