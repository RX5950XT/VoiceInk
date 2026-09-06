# VoiceInk — 前景視窗觀測（每秒一列 JSON）
$ErrorActionPreference = 'SilentlyContinue'
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8
$writer = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$writer.AutoFlush = $true

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class FgWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint a, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder name, ref int size);
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  public static string GetPath(uint pid) {
    IntPtr h = OpenProcess(0x1000, false, pid);
    if (h == IntPtr.Zero) return "";
    try {
      var sb = new StringBuilder(1024);
      int size = sb.Capacity;
      if (!QueryFullProcessImageName(h, 0, sb, ref size)) return "";
      return sb.ToString();
    } finally { CloseHandle(h); }
  }
  public static uint IdleMs() {
    LASTINPUTINFO i = new LASTINPUTINFO();
    i.cbSize = (uint)Marshal.SizeOf(i);
    if (!GetLastInputInfo(ref i)) return 0;
    return unchecked((uint)Environment.TickCount - i.dwTime);
  }
}
"@

while ($true) {
  $hwnd = [FgWin]::GetForegroundWindow()
  $procId = [uint32]0
  [void][FgWin]::GetWindowThreadProcessId($hwnd, [ref]$procId)
  $exe = ''
  $procName = ''
  if ($procId -gt 0) {
    $exe = [FgWin]::GetPath($procId)
    if ($exe) {
      $procName = [IO.Path]::GetFileNameWithoutExtension($exe)
    } else {
      $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
      if ($p) { $procName = $p.ProcessName }
    }
  }
  $idle = [FgWin]::IdleMs()
  $obj = @{ name = $procName; path = $exe; pid = [int]$procId; idleMs = [int64]$idle }
  $writer.WriteLine(($obj | ConvertTo-Json -Compress))
  Start-Sleep -Seconds 1
}
