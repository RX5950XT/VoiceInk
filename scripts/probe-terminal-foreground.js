'use strict'

/**
 * Ctrl+G 抬窗器的實機探針：**記事本已經開著**的情況下再開一次，量前景視窗是不是它、
 * 而且真的被設成最上層（`WS_EX_TOPMOST`）。
 *
 * 這條路徑用 mock 證明不了任何事：以前那版「找新出現的有視窗 pid」在乾淨機器上是綠的，
 * 但 Windows 11 的記事本第二次開檔案會**沿用同一個 pid 與同一個 HWND**（只多一個分頁），
 * 所以使用者手上永遠是壞的。這支就是在重現那個情境。
 *
 *   node scripts/probe-terminal-foreground.js
 *
 * 會搶焦點，也會開／關記事本。跑完自己收乾淨。
 */
const { spawn, spawnSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

// `VOICEINK_FG` 是給「修復前先跑一次確認會紅」用的：指到 git 取出來的舊版檔案
const foreground = require(process.env.VOICEINK_FG || '../src/main/terminal/foreground')

const POWERSHELL = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
)

/** @param {string} script @returns {string} */
function ps(script) {
  const res = spawnSync(POWERSHELL, [
    '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')
  ], { encoding: 'utf8', windowsHide: true })
  return String(res.stdout || '').trim()
}

/**
 * 回 `記事本被設成置頂|記事本是不是前景|現在的前景是誰`。
 *
 * 斷言只看**記事本那個視窗**的 `WS_EX_TOPMOST`，不看前景是誰：全螢幕獨佔的遊戲
 * （實測 BlueArchive）在的時候 Windows 不准任何人搶前景，那不是這支功能的問題，
 * 而置頂旗標照樣設得上去——遊戲一關記事本就在最上面。前景只當成參考資訊印出來。
 */
const FRONT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class VIProbe {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", SetLastError=true)] public static extern int GetWindowLong(IntPtr h, int index);
}
"@
$front = [VIProbe]::GetForegroundWindow()
$frontPid = 0
[void][VIProbe]::GetWindowThreadProcessId($front, [ref]$frontPid)
$frontName = (Get-Process -Id $frontPid -ErrorAction SilentlyContinue).ProcessName
$np = Get-Process notepad -ErrorAction SilentlyContinue | Where-Object MainWindowHandle -ne 0 | Select-Object -First 1
# GWL_EXSTYLE = -20, WS_EX_TOPMOST = 0x8
$ex = if ($np) { [VIProbe]::GetWindowLong($np.MainWindowHandle, -20) } else { 0 }
"$([bool]($ex -band 0x8))|$([bool]($np -and $np.MainWindowHandle -eq $front))|$frontName"
`

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

let failures = 0
/** @param {string} label @param {boolean} ok @param {string} [detail] */
function check(label, ok, detail) {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('只在 Windows 上有意義，略過')
    return
  }
  const file = path.join(os.tmpdir(), `voiceink-fg-probe-${Date.now()}.txt`)
  fs.writeFileSync(file, '提示詞測試\n', 'utf8')

  console.log('[A] 記事本先開著（重現使用者手上的狀態）')
  spawn('notepad.exe', [], { detached: true, stdio: 'ignore' }).unref()
  await sleep(2500)
  const before = ps('(Get-Process notepad -ErrorAction SilentlyContinue | Where-Object MainWindowHandle -ne 0 | Select-Object -First 1 -Expand Id)')
  check('[A] 記事本已經在跑', Boolean(before), `pid=${before || '無'}`)

  // 這支腳本自己就是「沒有視窗、不在前景」的程序，第二次記事本由它 detached 開出來，
  // 天然重現使用者的情境（ConPTY 宿主也搶不到前景），不必動使用者的桌面。
  console.log('[B] 起抬窗器，然後從「非前景」的地方開第二次記事本')
  foreground.raiseChildWindow()
  await sleep(900)
  spawn('notepad.exe', [file], { detached: true, stdio: 'ignore' }).unref()
  await sleep(3500)

  const [topmost, isFront, frontName] = ps(FRONT).split('|')
  check('[C] 記事本被設成置頂', String(topmost).toLowerCase() === 'true', `WS_EX_TOPMOST=${topmost}`)
  console.log(`  info  記事本是不是前景=${isFront}，現在的前景=${frontName}（全螢幕獨佔時搶不到前景是 Windows 的規則，不算失敗）`)

  console.log("[D] 收尾")
  foreground.stop()
  ps('Stop-Process -Name notepad -Force -ErrorAction SilentlyContinue')
  try { fs.unlinkSync(file) } catch { /* 已經沒了 */ }

  console.log(failures ? `\n${failures} 項失敗` : '\n全部通過')
  process.exit(failures ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
