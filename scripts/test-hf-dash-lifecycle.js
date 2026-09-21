'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

async function main() {
  const pending = []
  const timers = new Set()
  const hint = { textContent: '' }
  const context = {
    electronAPI: { hfmodels: { dashboard: () => new Promise(resolve => pending.push(resolve)) } },
    document: { getElementById: id => id === 'hfServerHint' ? hint : null },
    setTimeout(fn) { const timer = { fn }; timers.add(timer); return timer },
    clearTimeout(fn) { timers.delete(fn) }
  }
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/scripts/hf-dash.js'), 'utf8')
    .replace(/^import .*\r?\n/gm, '').replace(/^export /gm, '')
  vm.createContext(context)
  vm.runInContext(source, context)
  context.startDash()
  context.startDash()
  assert.equal(pending.length, 1, '重複進入不能開兩次請求')
  context.stopDash()
  context.startDash()
  pending[1]({ ok: true, data: { running: true, port: 1234 } })
  await new Promise(resolve => setImmediate(resolve))
  const currentHint = hint.textContent
  pending[0]({ ok: true, data: { running: false } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(timers.size, 1, '舊請求完成不能多開輪詢鏈')
  assert.equal(hint.textContent, currentHint, '舊請求不能覆蓋重新進入後的狀態')
  context.stopDash()
  assert.equal(timers.size, 0, '停止後不能留下計時器')
  console.log('PASS HF 儀表板重入、停止重開、過期回覆與計時器清理')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
