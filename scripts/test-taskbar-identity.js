'use strict'

/**
 * 工作列身分與圖示的回歸測試。
 *
 * 擋兩個實際發生過的症狀：
 *  - 更新後工作列多出第二顆 VoiceInk（app 沒設 AppUserModelID，跟 NSIS 捷徑上的對不起來）
 *  - 那顆的圖示一片白（frameless 視窗沒給 icon，Windows 拿不到視窗圖示）
 *
 * 用法：node scripts/test-taskbar-identity.js [專案根目錄]
 */

const fs = require('fs')
const path = require('path')
const assert = require('assert')

const root = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

// [A] AppUserModelID 要跟 build.appId 一字不差（捷徑上寫的就是它）
const called = main.match(/app\.setAppUserModelId\(\s*'([^']+)'\s*\)/)
assert.ok(called, '[A] main.js 沒有呼叫 app.setAppUserModelId()')
assert.strictEqual(called[1], pkg.build.appId, '[A] AppUserModelID 與 package.json 的 build.appId 不一致')

// [B] 要在搶 single instance lock 之前設定（之後才設，第一扇窗已經帶著錯的身分開出去了）
assert.ok(
  main.indexOf(called[0]) < main.indexOf('app.requestSingleInstanceLock()'),
  '[B] setAppUserModelId 必須排在 requestSingleInstanceLock 之前'
)

// [C] 主視窗（frameless）必須自己帶 icon
const winOpts = main.slice(main.indexOf('mainWindow = new BrowserWindow({'))
const optsBlock = winOpts.slice(0, winOpts.indexOf('\n  })'))
assert.ok(/^\s*frame:\s*false,/m.test(optsBlock), '[C] 前提變了：主視窗已經不是 frameless，請重看這條測試')
const iconOpt = optsBlock.match(/^\s*icon:\s*([A-Za-z_$][\w$]*)\s*,/m)
assert.ok(iconOpt, '[C] 主視窗少了 icon（frameless 視窗不給就是工作列一片白）')

// [D] 那個常數要指到真的存在、載得起來的 .ico
const iconConst = main.match(new RegExp(`const ${iconOpt[1]} = path\\.join\\(__dirname, '([^']+)'\\)`))
assert.ok(iconConst, `[D] 找不到 ${iconOpt[1]} 的定義`)
const icoPath = path.join(root, 'src/main', iconConst[1])
assert.ok(fs.existsSync(icoPath), `[D] 圖示檔不存在：${icoPath}`)
const ico = fs.readFileSync(icoPath)
assert.strictEqual(ico.readUInt16LE(2), 1, '[D] 不是合法的 ICO')
const count = ico.readUInt16LE(4)
assert.ok(count > 0, '[D] ICO 裡沒有任何圖')
for (let i = 0; i < count; i++) {
  const off = 6 + i * 16
  const size = ico.readUInt32LE(off + 8)
  const start = ico.readUInt32LE(off + 12)
  assert.ok(start + size <= ico.length, `[D] ICO 第 ${i} 張被截斷`)
}
// 工作列要的是小圖（16／32），只有 256 那張會被縮成糊的
const widths = Array.from({ length: count }, (_, i) => ico[6 + i * 16] || 256)
assert.ok(widths.includes(16) && widths.includes(32), `[D] ICO 缺 16／32 尺寸：${widths.join(',')}`)

// [E] 換 AUMID 會連帶換掉開機自啟動在登錄檔的值名稱，舊的那筆一定要搬過來
assert.ok(
  /const LEGACY_LOGIN_ITEM = 'electron\.app\.VoiceInk'/.test(main),
  '[E] 少了舊的開機自啟動值名稱（換 AUMID 之後那筆會變孤兒：關不掉但照樣開機啟動）'
)
assert.ok(/function migrateLoginItemName\(\)/.test(main), '[E] 少了 migrateLoginItemName()')
assert.ok(
  main.indexOf('migrateLoginItemName()\n') > main.indexOf('function migrateLoginItemName()'),
  '[E] migrateLoginItemName() 定義了卻沒有人呼叫'
)
// 系統工具要指名 System32（PATH 上可能是 MSYS 的同名執行檔）
assert.ok(/System32', 'reg\.exe'/.test(main), '[E] reg.exe 要用 System32 的絕對路徑')

console.log('test-taskbar-identity: 全部通過（[A][B][C][D][E]）')
