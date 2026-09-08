'use strict'

/**
 * 讓終端機裡叫出來的 GUI 程式（Claude Code 按 Ctrl+G 開的記事本就是）跳到最前面。
 *
 * 為什麼不會自己跳：Windows 只准「現在在前景的那個程序」把視窗搶到前面。ConPTY 沒有
 * 視窗，而真正跑 shell 的是 App 外面那個獨立宿主（`terminal/host.js`），兩個都不是前景，
 * 所以記事本開起來只會在工作列閃一下，視窗留在 VoiceInk 後面。
 *
 * 作法：使用者按下 Ctrl+G（PTY 收到的是 `\x07`）時，先記下現在有哪些程序有視窗，
 * 接下來幾秒裡出現的第一個新視窗就把它抬到前面。抬的手法是標準的
 * `AttachThreadInput` ＋ `SetForegroundWindow`——不接上前景執行緒的輸入佇列，
 * 連 PowerShell 自己也搶不到前景。
 *
 * ponytail: 用一次性的 PowerShell 代跑，不引進 FFI 或原生模組。代價是慢一點
 * （PowerShell 冷啟約 0.3～0.7 秒，反正記事本本來就要開一下）。真的要更快再說。
 */
const { spawn } = require('child_process')
const path = require('path')

/** 同一時間只留一個等待中的抬窗器（連按 Ctrl+G 不要疊出一堆 PowerShell） */
let pending = null

const POWERSHELL = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
)

/**
 * 等新視窗出現並把它抬到前面的腳本。
 *
 * 用 `-EncodedCommand` 送進去：不必落地成 `.ps1`（打包後在 asar 裡的檔案外部程序讀不到），
 * 也不用煩惱引號怎麼跳脫。
 */
const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class VoiceInkFg {
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  public static void Raise(IntPtr target) {
    if (target == IntPtr.Zero) return;
    uint junk;
    uint front = GetWindowThreadProcessId(GetForegroundWindow(), out junk);
    uint mine = GetCurrentThreadId();
    // 不接上前景執行緒的輸入佇列的話，SetForegroundWindow 會被系統靜靜地忽略
    AttachThreadInput(mine, front, true);
    if (IsIconic(target)) ShowWindow(target, 9);
    SetForegroundWindow(target);
    AttachThreadInput(mine, front, false);
  }
}
"@
$known = @{}
foreach ($p in Get-Process) { if ($p.MainWindowHandle -ne 0) { $known[$p.Id] = $true } }
$deadline = (Get-Date).AddSeconds(8)
while ((Get-Date) -lt $deadline) {
  foreach ($p in Get-Process) {
    if ($p.MainWindowHandle -ne 0 -and -not $known.ContainsKey($p.Id)) {
      [VoiceInkFg]::Raise($p.MainWindowHandle)
      exit 0
    }
  }
  Start-Sleep -Milliseconds 150
}
`

/**
 * 開始盯著「接下來出現的新視窗」，出現就抬到最前面。
 *
 * 重複呼叫時前一個還在等就直接沿用（不重開一支 PowerShell）。
 * 失敗一律吞掉：抬不動視窗只是不方便，不該讓終端機的輸入報錯。
 *
 * @returns {boolean} 有沒有真的起了一個等待器
 */
function raiseChildWindow() {
  if (process.platform !== 'win32') return false
  if (pending && !pending.killed && pending.exitCode === null) return true
  try {
    const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64')
    const child = spawn(POWERSHELL, [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded
    ], { stdio: 'ignore', windowsHide: true })
    child.on('error', () => { pending = null })
    child.on('exit', () => { if (pending === child) pending = null })
    child.unref()
    pending = child
    return true
  } catch {
    pending = null
    return false
  }
}

/** App 要關了：等在那裡的 PowerShell 沒必要留 */
function stop() {
  if (pending && pending.exitCode === null) {
    try { pending.kill() } catch { /* 已經結束了 */ }
  }
  pending = null
}

module.exports = { raiseChildWindow, stop }
