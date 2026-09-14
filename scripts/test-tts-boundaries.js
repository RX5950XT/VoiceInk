'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

async function main() {
  const file = path.join(__dirname, '../src/main/edge-tts.js')
  const localRequire = createRequire(file)
  let failure = new Error('upstream-secret-echo')
  let spoken = ''
  const context = { module: { exports: {} }, process, Uint8Array,
    require(id) {
      if (id !== 'node-edge-tts') return localRequire(id)
      return { EdgeTTS: class { async ttsPromise(text, target) {
        if (failure) throw failure
        spoken = text
        fs.writeFileSync(target, 'audio')
      } } }
    } }
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file })
  const tts = context.module.exports
  const voice = tts.DEFAULT_TTS_VOICES['zh-TW']
  let failures = 0
  try {
    await assert.rejects(tts.synthesize({ text: '你好', voice }), error => {
      assert.equal(error.message.includes('upstream-secret-echo'), false, 'TTS 不可回送外部錯誤內容')
      return error.code === 'REJECTED'
    })
  } catch (error) { failures++; console.error(error.message) }
  failure = null
  try {
    const result = await tts.synthesize({ text: 'a'.repeat(1801), voice, chunkIndex: 0.5 })
    assert.equal(result.chunkIndex, 0)
    assert.equal(spoken.length, 1800)
  } catch (error) { failures++; console.error(error.message) }
  assert.equal(failures, 0)
  console.log('PASS TTS 外部錯誤不外洩，段落編號收斂為整數')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
