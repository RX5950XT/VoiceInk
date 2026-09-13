'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const source = fs.readFileSync(path.join(__dirname, '../src/main/sysmon/probe.ps1'), 'utf8')
const block = source.slice(source.indexOf('  # 最近幾筆 Windows 更新'), source.indexOf('  # 擴充插槽'))
assert(block.includes('InstalledOn'))
const script = `
$ErrorActionPreference = 'Stop'
$bad = [pscustomobject]@{ HotFixID = 'KB0000000' }
$bad | Add-Member ScriptProperty InstalledOn { throw 'invalid date' }
function Get-CimInstance { @(
  [pscustomobject]@{ HotFixID = 'KB0000001'; InstalledOn = [datetime]'2026-08-12' },
  $bad,
  [pscustomobject]@{ HotFixID = 'KB0000002'; InstalledOn = [datetime]'2026-09-09' }
) }
function Esc($s) { $s }
$sb = [Text.StringBuilder]::new()
$add = { param($line) [void]$sb.Append($line).Append([char]10) }
${block}
[Console]::Write($sb.ToString())
`
const result = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
  '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')
], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
assert.equal(result.status, 0, result.stderr)
assert.deepEqual(result.stdout.trim().split(/\r?\n/), [
  'QFE|KB0000002|2026-09-09', 'QFE|KB0000001|2026-08-12', 'QFE|KB0000000|', 'QFEC|3'
])
console.log('PASS: 壞更新日期保留空值，其餘更新按日期排序，總數不變')
