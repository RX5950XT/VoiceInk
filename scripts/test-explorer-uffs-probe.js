'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const home = path.join(__dirname, 'isolated-user-data')
const script = `
  const Module = require('node:module')
  const uffsPath = require('node:path').join(process.cwd(), 'src/main/explorer/uffs.js')
  const original = Module._load
  let configured = ''
  Module._load = function(request, ...args) {
    if (request === uffsPath) return {
      configure: value => configured = value,
      findUffs: () => configured === process.env.VOICEINK_USER_DATA ? 'test-uffs.exe' : '',
      status: async () => ({ installed: true, daemon: {}, broker: {} }),
      search: async () => ({ hits: [{ path: 'C:\\\\test.txt', name: 'test.txt' }], warming: false })
    }
    return original.call(this, request, ...args)
  }
  require('./scripts/probe-explorer-uffs.js')
`
const result = spawnSync(process.execPath, ['-e', script], {
  cwd: path.join(__dirname, '..'), encoding: 'utf8', windowsHide: true,
  env: { ...process.env, VOICEINK_USER_DATA: home }
})
assert.equal(result.status, 0, result.stderr)
assert.match(result.stdout, /PASS 真搜尋/)
assert.doesNotMatch(result.stdout, /SKIP/)
console.log('PASS: UFFS probe 先設定 userData，再尋找與搜尋')
