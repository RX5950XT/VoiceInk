'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const files = require('../src/main/explorer/fs')

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-copy-race-'))
  const copy = fsp.cp
  const rename = fsp.rename
  try {
    const source = path.join(root, 'keep.txt')
    const dest = path.join(root, 'dest')
    fs.mkdirSync(dest)
    fs.writeFileSync(source, 'source')
    fsp.cp = async (from, to, opts) => {
      fs.writeFileSync(to, 'created-elsewhere')
      return copy(from, to, opts)
    }
    await assert.rejects(files.copyEntry(source, dest), { code: 'COPY_FAILED' })
    assert.equal(fs.readFileSync(path.join(dest, 'keep.txt'), 'utf8'), 'created-elsewhere')
    fsp.rename = async () => { throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }) }
    await assert.rejects(files.moveEntry(source, dest), { code: 'MOVE_FAILED' })
    assert.equal(fs.readFileSync(source, 'utf8'), 'source')
    assert.equal(fs.readFileSync(path.join(dest, 'keep (2).txt'), 'utf8'), 'created-elsewhere')
    console.log('2 passed, 0 failed')
  } finally {
    fsp.cp = copy
    fsp.rename = rename
    fs.rmSync(root, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
