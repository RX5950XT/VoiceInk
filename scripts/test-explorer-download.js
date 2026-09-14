'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { tempDir, removeTree } = require('./lib/test-temp')
const { spawnSync } = require('node:child_process')

const root = tempDir('voiceink-download-test-')
try {
  fs.mkdirSync(path.join(root, 'uffs', 'uffs-windows-x64.zip.part'), { recursive: true })
  const script = `
    const uffs = require('./src/main/explorer/uffs')
    uffs.configure(process.argv[1])
    global.fetch = async () => ({
      ok: true, headers: { get: () => null },
      body: new ReadableStream({ start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]))
        controller.close()
      } })
    })
    uffs.download().then(() => process.exitCode = 2, error => {
      if (error.code !== 'UFFS_INSTALL') process.exitCode = 3
      console.log(error.code)
    })
  `
  const result = spawnSync(process.execPath, ['-e', script, root], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 10000, windowsHide: true
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /UFFS_INSTALL/)
  console.log('PASS: 下載寫入失敗回傳 UFFS_INSTALL，不產生 uncaughtException')
} finally {
  removeTree(root)
}
