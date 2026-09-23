'use strict'

/**
 * `voiceink-probe.exe`（native/voiceink-probe，Rust）：取代系統監控的 `probe.ps1`
 * 與使用時長的 `observer.ps1` 兩支常駐 PowerShell（實測 180MB＋70MB → 各幾 MB）。
 * 協定與輸出格式跟 ps1 一模一樣，所以找不到執行檔（沒跑 `npm run build:probe`）就退回
 * PowerShell，功能不變、只是比較重。
 *
 * 打包後在 `resources/probe/`（`extraResources`），開發時在專案的 `resources/probe/`。
 */

const fs = require('fs')
const path = require('path')

const EXE_NAME = 'voiceink-probe.exe'

/**
 * @param {{ resourcesPath?: string, projectRoot?: string }} [deps]
 * @returns {string} 找不到回空字串
 */
function resolveProbeExe(deps = {}) {
  const resourcesPath = deps.resourcesPath ?? process.resourcesPath ?? ''
  const projectRoot = deps.projectRoot ?? path.join(__dirname, '..', '..')
  const candidates = [
    resourcesPath ? path.join(resourcesPath, 'probe', EXE_NAME) : '',
    path.join(projectRoot, 'resources', 'probe', EXE_NAME)
  ].filter(Boolean)
  return candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate)
    } catch {
      return false
    }
  }) || ''
}

function powershellPath() {
  const root = process.env.SystemRoot || 'C:\\Windows'
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/**
 * 要 spawn 的指令：有原生檔就用它，否則 PowerShell 跑對應的 ps1。
 * @param {'sysmon' | 'observer'} mode
 * @param {string} scriptPath 退路用的 .ps1（已換成 app.asar.unpacked 的路徑）
 * @param {{ exe?: string }} [deps]
 * @returns {{ file: string, args: string[], native: boolean }}
 */
function probeCommand(mode, scriptPath, deps = {}) {
  const exe = deps.exe ?? resolveProbeExe()
  if (exe) return { file: exe, args: [mode], native: true }
  return {
    file: powershellPath(),
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    native: false
  }
}

module.exports = { resolveProbeExe, probeCommand }
