'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

async function main() {
  const events = new Map()
  const audio = {
    pause() {}, load() {}, removeAttribute() {}, play: async () => {},
    addEventListener(type, fn) {
      if (!events.has(type)) events.set(type, new Set())
      events.get(type).add(fn)
    },
    removeEventListener(type, fn) { events.get(type)?.delete(fn) }
  }
  let requests = 0
  const context = {
    console, Uint8Array, ArrayBuffer, Blob,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    Audio: function () { return audio },
    electronAPI: { tts: { cancel: async () => {}, synthesize: async () => {
      requests++
      return { data: [1], totalChunks: 2 }
    } } },
    showToast() {}, cleanIpcError: error => error.message
  }
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/scripts/translate-page.js'), 'utf8')
    .replace(/^import[\s\S]*?from '[^']+'\r?\n/gm, '').replace(/^export /gm, '')
  vm.createContext(context)
  vm.runInContext(source, context)
  vm.runInContext("el = { output: { value: '譯文' }, targetLang: { value: 'zh-TW' } }", context)
  let settled = false
  const playback = context.toggleSpeak('output').then(() => { settled = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(events.get('ended').size, 1)
  context.stopSpeak()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(events.get('ended').size, 0, '停止朗讀必須移除前一次播放監聽')
  assert.equal(events.get('error').size, 0)
  assert.equal(settled, true, '停止朗讀必須結束等待播放的工作')
  await playback
  assert.equal(requests, 1, '停止後不能繼續合成下一段')
  const next = context.toggleSpeak('output')
  await new Promise(resolve => setImmediate(resolve))
  for (const fn of [...events.get('ended')]) fn()
  await new Promise(resolve => setImmediate(resolve))
  for (const fn of [...events.get('ended')]) fn()
  await next
  assert.equal(requests, 3, '重新朗讀仍能正常播完兩段')
  assert.equal(events.get('ended').size, 0)
  console.log('PASS TTS 停止清理、工作結束、停止後不合成與重新播放')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
