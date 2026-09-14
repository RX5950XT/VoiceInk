/**
 * 回歸：遞迴刪除遇到 junction／symlink 時，**不可以刪到連結對面的真資料**。
 * 用法：node scripts/test-safe-rm.js
 *
 * 要看 Node 24 的 `rmSync` 真的會穿過 junction（這支測試存在的原因）：
 *   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/test-safe-rm.js
 * 那時「rmSync 對照組」會印出 followed=true。
 */
const fs = require('fs')
const path = require('path')
const { tempDir } = require('./lib/test-temp')
const { removeTreeSync } = require('../src/main/safe-rm')

let passed = 0
let failed = 0
function ok(name, cond, detail = '') {
  if (cond) passed += 1
  else failed += 1
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` — ${detail}`}`)
}

function fixture() {
  const base = tempDir('safe-rm-')
  const outside = path.join(base, 'outside')
  fs.mkdirSync(path.join(outside, 'nested'), { recursive: true })
  fs.writeFileSync(path.join(outside, 'model.gguf'), 'precious')
  fs.writeFileSync(path.join(outside, 'nested', 'deep.bin'), 'precious')
  fs.writeFileSync(path.join(base, 'outside-file.txt'), 'precious')

  const victim = path.join(base, 'victim')
  fs.mkdirSync(path.join(victim, 'a', 'b'), { recursive: true })
  fs.writeFileSync(path.join(victim, 'a', 'plain.txt'), 'bye')
  fs.writeFileSync(path.join(victim, 'a', 'readonly.txt'), 'bye')
  fs.chmodSync(path.join(victim, 'a', 'readonly.txt'), 0o444)
  fs.symlinkSync(outside, path.join(victim, 'models'), 'junction')
  fs.symlinkSync(outside, path.join(victim, 'a', 'b', 'deep-junction'), 'junction')
  let fileLink = false
  try {
    fs.symlinkSync(path.join(base, 'outside-file.txt'), path.join(victim, 'file-link.txt'), 'file')
    fileLink = true
  } catch {
    // 檔案型 symlink 在沒開發人員模式的 Windows 需要權限，建不起來就不測這一種
  }
  const intact = () => fs.existsSync(path.join(outside, 'model.gguf'))
    && fs.existsSync(path.join(outside, 'nested', 'deep.bin'))
    && fs.readFileSync(path.join(base, 'outside-file.txt'), 'utf8') === 'precious'
  return { outside, victim, intact, fileLink }
}

const t = fixture()
removeTreeSync(t.victim)
ok('刪完之後資料夾本身不見了', !fs.existsSync(t.victim))
ok('junction 對面的真資料一個都沒少（含深層的 junction）', t.intact())
ok('唯讀檔也刪得掉（沒有卡在 EPERM）', !fs.existsSync(t.victim))
if (t.fileLink) ok('檔案型 symlink 只拆連結', t.intact())

// 單獨刪一個 junction 本身
const single = fixture()
removeTreeSync(path.join(single.victim, 'models'))
ok('直接刪 junction：連結消失、對面還在', !fs.existsSync(path.join(single.victim, 'models')) && single.intact())

// 不存在的路徑：安靜結束
let threw = false
try { removeTreeSync(path.join(single.victim, 'no-such')) } catch { threw = true }
ok('不存在的路徑不丟錯', !threw)

// 對照組：這個執行環境的 rmSync 會不會穿過 junction（只印出來，不算成敗）
const control = fixture()
// Node 24 的 rmSync 連唯讀檔都刪不掉（EPERM），對照組先把唯讀拿掉，只看它穿不穿 junction
fs.chmodSync(path.join(control.victim, 'a', 'readonly.txt'), 0o666)
try {
  fs.rmSync(control.victim, { recursive: true, force: true }) // rm-ok: 對照組，就是要看它會不會穿過去
  console.log(`INFO  rmSync 對照組（node ${process.version}）：followed=${!control.intact()}`)
} catch (error) {
  console.log(`INFO  rmSync 對照組（node ${process.version}）丟錯：${error.code}`)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
