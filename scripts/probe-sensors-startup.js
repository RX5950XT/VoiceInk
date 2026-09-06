'use strict'

// 只讀實機感測值；不接管風扇、不套用效能設定、不彈 UAC。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { createSensorBridge } = require('../src/main/sysmon/sensors')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 只取 helper 的 PID 與視窗數，不列使用者的其他程序。 */
function helpers() {
  const command = "@(Get-Process VoiceInkSensors -ErrorAction SilentlyContinue | Select-Object Id,MainWindowHandle) | ConvertTo-Json -Compress"
  const text = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
    { encoding: 'utf8', windowsHide: true }).trim()
  return text ? [].concat(JSON.parse(text)) : []
}

async function main() {
  const exe = path.resolve('resources/sensors/VoiceInkSensors.exe')
  const binary = fs.readFileSync(exe)
  assert.equal(binary.readUInt16LE(binary.readUInt32LE(0x3c) + 24 + 68), 2, '必須為無主控台的 WinExe')
  const before = helpers().map((item) => item.Id)
  const bridge = createSensorBridge({ resolveExe: () => exe })
  bridge.configure({ packaged: true, userDataPath: path.join(process.env.APPDATA, 'voiceink') })
  try {
    for (let round = 1; round <= 2; round++) {
      assert.equal((await bridge.enable()).state, 'on', '免 UAC 啟動必須收到讀數')
      const first = bridge.read()
      await sleep(3200)
      const next = bridge.read()
      assert.ok(next.available && next.groups.length > 0)
      const owned = helpers().filter((item) => !before.includes(item.Id))
      assert.ok(owned.length > 0 && owned.every((item) => Number(item.MainWindowHandle) === 0))
      console.log(JSON.stringify({ round, groups: next.groups.length, controls: next.controls.length,
        firstGroups: first.groups.length, available: next.available, windows: 0, scheduled: bridge.launchedByTask() }))
      await bridge.stop()
      for (let i = 0; i < 25 && helpers().some((item) => owned.some((own) => own.Id === item.Id)); i++) await sleep(400)
      assert.ok(helpers().every((item) => !owned.some((own) => own.Id === item.Id)), '停止後不可留下 helper')
    }
    console.log('PASS 兩次免 UAC 啟動、持續讀數、無視窗、停止無殘留')
  } finally { await bridge.stop() }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1 })
