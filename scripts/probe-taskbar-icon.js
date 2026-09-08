'use strict'

/**
 * 量「安裝好的那份」在工作列上真的長什麼樣。
 *
 * 為什麼要有這支：test-taskbar-identity.js 只看得到原始碼，看不到 Windows 到底解析出哪顆圖示。
 * 實際炸過的症狀是——更新把 VoiceInk.exe 換掉之後，捷徑 .lnk 裡記著的舊時間戳對不上，
 * Windows 解析不到目標，工作列與開始功能表直接退回「一張白紙加捷徑箭頭」，而且完全不報錯。
 *
 * 作法：問 shell 要 exe 自己的圖示，再問它要每份捷徑的圖示，比對是不是同一格系統影像清單。
 * 不同 ＝ 那份捷徑壞了（重跑一次安裝程式就會被 build/installer.nsh 重寫回來）。
 *
 * 用法：node scripts/probe-taskbar-icon.js
 *   VOICEINK_EXE 可覆寫要檢查的執行檔路徑。
 */

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const exe = process.env.VOICEINK_EXE ||
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'VoiceInk', 'VoiceInk.exe')

if (!fs.existsSync(exe)) {
  console.error(`找不到安裝好的 VoiceInk.exe：${exe}`)
  console.error('（還沒安裝過就跳過這支；要指定別的路徑請設 VOICEINK_EXE）')
  process.exit(2)
}

const appData = process.env.APPDATA || ''
const targets = [
  ['開始功能表', path.join(appData, 'Microsoft/Windows/Start Menu/Programs/VoiceInk.lnk')],
  ['工作列（已釘選）', path.join(appData, 'Microsoft/Internet Explorer/Quick Launch/User Pinned/TaskBar/VoiceInk.lnk')],
  ['桌面', path.join(process.env.USERPROFILE || '', 'Desktop/VoiceInk.lnk')]
].filter(([, p]) => fs.existsSync(p))

/** 問 shell：這些路徑各自解析到系統影像清單的第幾格 */
function iconIndexes(paths) {
  const script = `
$src = @'
using System;using System.Runtime.InteropServices;
public class Probe {
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct INFO {
    public IntPtr hIcon; public int iIcon; public uint dwAttributes;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string name;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=80)] public string type; }
  [DllImport("shell32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr SHGetFileInfo(string p,uint a,ref Probe.INFO i,uint c,uint f);
}
'@
Add-Type -TypeDefinition $src
foreach ($p in @(${paths.map((p) => `'${p.replace(/'/g, "''")}'`).join(',')})) {
  $i = New-Object Probe+INFO
  [Probe]::SHGetFileInfo($p, 0, [ref]$i, [uint32][System.Runtime.InteropServices.Marshal]::SizeOf($i), 0x100) | Out-Null
  Write-Output $i.iIcon
}`
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true
  })
  return out.trim().split(/\r?\n/).map((n) => Number(n))
}

const [exeIcon, ...linkIcons] = iconIndexes([exe, ...targets.map(([, p]) => p)])
console.log(`exe 本身的圖示格 = ${exeIcon}  (${exe})`)

let bad = 0
targets.forEach(([label, p], i) => {
  const ok = linkIcons[i] === exeIcon
  if (!ok) bad++
  console.log(`  ${ok ? '✓' : '✗'} ${label}：格 ${linkIcons[i]}${ok ? '' : '（不是 App 圖示，多半是一張白紙）'}`)
})

if (!targets.length) {
  console.log('  找不到任何捷徑，沒東西可量')
}
if (bad) {
  console.error(`\nprobe-taskbar-icon: ${bad} 份捷徑解析不到 App 圖示`)
  process.exit(1)
}
console.log('\nprobe-taskbar-icon: 全部通過')
