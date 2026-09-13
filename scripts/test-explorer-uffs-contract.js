'use strict'

const assert = require('node:assert/strict')
const Module = require('node:module')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const originalLoad = Module._load
const calls = []
let uffs
try {
  Module._load = function (request, ...args) {
    if (request === 'fs') return { statSync: () => ({ isFile: () => true }) }
    if (request === 'child_process') return { spawn: (exe, argv) => {
      calls.push(argv)
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = () => {}
      setImmediate(() => { child.stdout.emit('data', Buffer.from('[]')); child.emit('close', 0) })
      return child
    } }
    return originalLoad.call(this, request, ...args)
  }
  uffs = require('../src/main/explorer/uffs')
} finally {
  Module._load = originalLoad
}

async function main() {
  uffs.configure(__dirname)
  for (const [query, expected] of [
    ['test-sysmon-hotfix-date.js', '>.*test-sysmon-hotfix-date\\.js.*'],
    ['report.(old)+$.txt', '>.*report\\.\\(old\\)\\+\\$\\.txt.*'],
    ['報告', '報告'], ['*.txt', '>(?:^|[\\\\/])[^\\\\/]*\\.txt$'],
    ['test?.js', '>(?:^|[\\\\/])test[^\\\\/]\\.js$'],
    ['test[12].js', 'test[12].js'], ['*.{js,ts}', '*.{js,ts}'],
    ['foo.js|bar.js', 'foo.js|bar.js'], ['folder/*.js', 'folder/*.js']
  ]) {
    await uffs.search(query)
    assert.equal(calls.at(-1)[0], expected)
  }
  assert.throws(() => uffs.sanitizePattern('>.*'), { code: 'BAD_QUERY' })
  await uffs.search('*test-sysmon-hotfix-date.js*')
  const glob = new RegExp(calls.at(-1)[0].slice(1), 'i')
  assert(glob.test('D:\\project\\test-sysmon-hotfix-date.js'))
  assert(glob.test('D:\\project\\TEST-SYSMON-HOTFIX-DATE.JS'))
  assert(!glob.test('D:\\project\\test-sysmon-hotfix-dateXjs'))
  assert(!glob.test('D:\\project\\test-sysmon-hotfix-date.js\\other.txt'))
  // UFFS 0.6.40 真 CLI sample；fs.statSync 的 mtimeMs 為 1789232329004.623。
  const raw = { path: 'D:\\Workspace\\Personal_Project\\VoiceInk\\scripts\\test-sysmon-hotfix-date.js',
    name: 'test-sysmon-hotfix-date.js', size: 1528, is_directory: false, modified: 134337059290046231 }
  const hit = uffs.sanitizeHit(raw)
  assert.ok(Math.abs(hit.mtimeMs - 1789232329004.623) < 1)
  assert.equal(uffs.sanitizeHit({ ...raw, is_directory: true }).dir, true)
  const legacy = uffs.sanitizeHit({ path: raw.path, type: 'directory', written: '2026-09-12T00:00:00Z' })
  assert.equal(legacy.dir, true)
  assert.equal(legacy.mtimeMs, Date.parse('2026-09-12T00:00:00Z'))
  for (const modified of [-1, Infinity, NaN, 1e308]) {
    assert.equal(uffs.sanitizeHit({ path: raw.path, modified }).mtimeMs, 0)
  }
  assert.equal(uffs.sanitizeHit({ path: raw.path, written: raw.modified }).mtimeMs, 0)
  console.log('PASS: 帶點文字安全轉譯；保留 literal/glob；真 UFFS 目錄與 FILETIME 正確')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
