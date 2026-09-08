'use strict'

/**
 * 讓終端機裡叫出來的 GUI 程式（Claude Code 按 Ctrl+G 開的記事本就是）跳到最前面並置頂。
 *
 * 為什麼不會自己跳：Windows 只准「現在在前景的那個程序」把視窗搶到前面。ConPTY 沒有
 * 視窗，而真正跑 shell 的是 App 外面那個獨立宿主（`terminal/host.js`），兩個都不是前景，
 * 所以記事本開起來只會在工作列閃一下，視窗留在 VoiceInk 後面。
 *
 * 作法：使用者按下 Ctrl+G（PTY 收到的是 `\x07`）時，先記下現在每個有視窗的程序長怎樣，
 * 接下來幾秒裡「多出來的視窗」就把它抬到前面並設成最上層。抬的手法是標準的
 * `AttachThreadInput` ＋ `SetForegroundWindow`——不接上前景執行緒的輸入佇列，
 * 連 PowerShell 自己也搶不到前景。
 *
 * **快照記的是「pid → 視窗代碼＋標題」不是「有哪些 pid」**：Windows 11 的記事本第二次
 * 開檔案時**沿用同一個程序、同一個視窗**，只是多開一個分頁（實測 pid 5380／HWND 394578
 * 兩次完全相同）。只比對 pid 的話，記事本只要開過一次，之後每一次 Ctrl+G 都抬不到——
 * 症狀就是「昨天還會跳，今天又不跳了」。
 *
 * 但「標題變了」對一般程式太寬鬆（瀏覽器切分頁、播影片都在改標題），所以標題這條路
 * 只認 `REUSE_WINDOW` 裡那幾支會重用視窗的編輯器。新程序開新視窗那條路照舊不設限。
 *
 * ponytail: 用一次性的 PowerShell 代跑，不引進 FFI 或原生模組。代價是慢一點
 * （PowerShell 冷啟約 0.3～0.7 秒，反正記事本本來就要開一下）。真的要更快再說。
 */
const { spawn } = require('child_process')
const path = require('path')

/** 同一時間只留一個等待中的抬窗器（連按 Ctrl+G 不要疊出一堆 PowerShell） */
let pending = null

/**
 * 會「重用既有視窗」的編輯器程序名（小寫、不含 `.exe`）。
 * 只有這幾支才准用「標題變了」當成新視窗，其餘一律要有新程序。
 */
const REUSE_WINDOW = ['notepad', 'code', 'code - insiders', 'cursor', 'windsurf', 'notepad++', 'sublime_text']

const POWERSHELL = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
)

/**
 * 等新視窗出現並把它抬到前面＋置頂的腳本。
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
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  const uint SWP_NOMOVE = 0x0002, SWP_NOSIZE = 0x0001, SWP_SHOWWINDOW = 0x0040;
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
    // 使用者要的是「置頂」：留在最上層，關掉那個視窗就沒事了。
    // 只 SetForegroundWindow 的話，回頭點一下 VoiceInk 記事本就被蓋掉。
    SetWindowPos(target, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
  }
}
"@
$reuse = @(__REUSE__)
$known = @{}
foreach ($p in Get-Process) {
  if ($p.MainWindowHandle -ne 0) { $known[$p.Id] = "$($p.MainWindowHandle)|$($p.MainWindowTitle)" }
}
$deadline = (Get-Date).AddSeconds(8)
while ((Get-Date) -lt $deadline) {
  foreach ($p in Get-Process) {
    $h = $p.MainWindowHandle
    if ($h -eq 0) { continue }
    $now = "$h|$($p.MainWindowTitle)"
    if (-not $known.ContainsKey($p.Id)) {
      # 全新的程序開了視窗：不設限，這是最可靠的一條
      [VoiceInkFg]::Raise($h)
      exit 0
    }
    # 既有程序換了視窗或換了標題：只有會重用視窗的編輯器算數
    if ($known[$p.Id] -ne $now -and $reuse -contains $p.ProcessName.ToLower()) {
      [VoiceInkFg]::Raise($h)
      exit 0
    }
  }
  Start-Sleep -Milliseconds 150
}
`.replace('__REUSE__', REUSE_WINDOW.map((name) => `'${name}'`).join(','))

/**
 * 開始盯著「接下來出現的新視窗」，出現就抬到最前面並置頂。
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

module.exports = { raiseChildWindow, stop, SCRIPT, REUSE_WINDOW }
