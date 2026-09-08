'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/scripts/sysmon-page.js'), 'utf8')
  .replace(/^import .*$/gm, '').replace(/^export /gm, '')
const activePanels = new Set()
const noop = () => {}
let resolveStatus
let sensorStarts = 0
const context = {
  document: { getElementById: () => null, querySelectorAll: () => [] },
  electronAPI: { sysmon: {
    onEvent: () => noop, start: noop, stop: noop, cpuStress: noop, memStress: noop,
    stressStatus: async () => ({ ok: false }),
    status: () => new Promise((resolve) => { resolveStatus = resolve })
  }, store: { get: async () => true } },
  showFanPanel: () => activePanels.add('fans'), hideFanPanel: () => activePanels.delete('fans'),
  showOcPanel: () => activePanels.add('oc'), hideOcPanel: () => activePanels.delete('oc'),
  showScreentimePanel: () => activePanels.add('screentime'), hideScreentimePanel: () => activePanels.delete('screentime')
}
vm.createContext(context)
vm.runInContext(`${source}
  initSysmonPage = () => {}; stopStress = () => {}; loadInventory = () => {};
  showSensorNote = () => {}; enableSensors = () => { sensorStarted() };
  this.api = { refreshSysmonPage, cooldownSysmonPage,
    seed: (subtab) => { state.subtab = subtab; state.active = true } };`,
  Object.assign(context, { sensorStarted: () => sensorStarts++ }))

async function main() {
  let failed = 0
  for (const panel of ['fans', 'oc', 'screentime']) {
    context.api.seed(panel)
    activePanels.add(panel)
    try {
      context.api.cooldownSysmonPage()
      assert.equal(activePanels.has(panel), false, '離頁要停止更新')
      context.api.refreshSysmonPage()
      assert.equal(activePanels.has(panel), true, '回頁要恢復更新')
      console.log(`PASS ${panel} 離頁與回頁`)
    } catch (error) { failed++; console.error(`FAIL ${panel}: ${error.message}`) }
    activePanels.clear()
  }
  context.api.refreshSysmonPage()
  context.api.cooldownSysmonPage()
  resolveStatus({ ok: true, data: { sensors: { installed: true, state: 'off' } } })
  await new Promise(setImmediate)
  try {
    assert.equal(sensorStarts, 0, '離頁後晚到的回應不得啟動感測器')
    console.log('PASS 離頁後晚到的回應不得啟動感測器')
  } catch (error) { failed++; console.error(`FAIL ${error.message}`) }
  process.exitCode = failed ? 1 : 0
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
