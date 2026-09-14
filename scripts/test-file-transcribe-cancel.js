'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

async function main() {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/file-transcribe.js'), 'utf8')
  const start = source.indexOf('async function transcribeFileCloud(')
  let finishAsr
  let enteredAsr
  const entered = new Promise(resolve => { enteredAsr = resolve })
  const context = {
    path, os: { tmpdir: () => 'unused' }, process, randomBytes: () => 'test',
    activeJob: null, jobGen: 0, MAX_DURATION_SEC: 14400, CLOUD_CHUNK_SECONDS: 50,
    cancel() { context.activeJob?.kill(); context.activeJob = null },
    validateFilePath: () => ({ size: 1 }), resolveFfmpegPath: () => 'unused',
    parseDurationSec: () => 1, formatDuration: () => '1 秒',
    runFfmpeg: async () => ({ code: 0, stderr: '' }),
    fsp: { mkdir: async () => {}, readdir: async () => ['seg_000.mp3'],
      readFile: async () => Buffer.from('audio'), rm: async () => {} },
    cloudAsr: { transcribeEncoded: () => new Promise(resolve => { finishAsr = resolve; enteredAsr() }) }
  }
  vm.createContext(context)
  vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), context)
  const pending = context.transcribeFileCloud({ filePath: 'test.mp3', store: {} })
  const rejected = assert.rejects(pending, /轉錄已取消/)
  await entered
  context.cancel()
  finishAsr('已取消的最後一段')
  await rejected
  assert.equal(context.activeJob, null)
  console.log('PASS 雲端最後一段完成前取消，不可回報成功')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
