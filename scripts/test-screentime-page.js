'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const pending = []
const rendered = []
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/scripts/sysmon-screentime.js'), 'utf8')
  .replace(/^import .*$/gm, '').replace(/^export /gm, '')
const context = { document: { getElementById: () => null, querySelectorAll: () => [] },
  electronAPI: { screentime: { status: async () => ({ ok: false }),
    stats: (q) => new Promise((resolve) => pending.push({ q, resolve })) } },
  onRender: (data) => rendered.push(data) }
vm.createContext(context)
vm.runInContext(`${source}
  renderCards = onRender;
  this.api = { refresh, shiftDate, hideScreentimePanel,
    seed: (patch) => Object.assign(state, patch), date: () => state.date };`, context)

async function main() {
  let failed = 0
  const check = async (name, fn) => {
    try { await fn(); console.log('PASS ' + name) }
    catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message) }
  }
  await check('月底切換月份不會跳過二月', () => {
    context.api.seed({ date: '2026-01-31', range: 'month' })
    context.api.shiftDate(1)
    assert.match(context.api.date(), /^2026-02-/)
    context.api.seed({ date: '2026-03-31', range: 'month' })
    context.api.shiftDate(-1)
    assert.match(context.api.date(), /^2026-02-/)
  })
  await check('快速切日期以最後一次選擇為準，舊結果不覆蓋', async () => {
    context.api.seed({ date: '2026-09-07', range: 'day' })
    const first = context.api.refresh()
    context.api.seed({ date: '2026-09-08' })
    const second = context.api.refresh()
    if (pending[1]) pending[1].resolve({ ok: true, data: { date: '2026-09-08' } })
    await second
    pending[0].resolve({ ok: true, data: { date: '2026-09-07' } })
    await first
    assert.equal(pending.length, 2)
    assert.equal(rendered.at(-1)?.date, '2026-09-08')
  })
  await check('離頁後不再畫晚到的結果', async () => {
    const before = rendered.length
    const request = context.api.refresh()
    context.api.hideScreentimePanel()
    pending.at(-1).resolve({ ok: true, data: { date: 'hidden' } })
    await request
    assert.equal(rendered.length, before)
  })
  process.exitCode = failed ? 1 : 0
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
