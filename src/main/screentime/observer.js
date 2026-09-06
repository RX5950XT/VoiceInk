'use strict'

/**
 * 前景視窗觀測：常駐 PowerShell 每秒吐一列 JSON。
 * 打包後 .ps1 在 asar 裡，powershell.exe 執行不了，路徑要換成 app.asar.unpacked。
 */

const { spawn } = require('child_process')
const path = require('path')

function resolveScript(baseDir = __dirname) {
  const script = path.join(baseDir, 'observer.ps1')
  const asarSegment = `${path.sep}app.asar${path.sep}`
  return script.replace(asarSegment, `${path.sep}app.asar.unpacked${path.sep}`)
}

function powershellPath() {
  const root = process.env.SystemRoot || 'C:\\Windows'
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/**
 * @param {{ onTick: (info: { name: string, path: string, pid: number, idleMs: number }) => void, spawnFn?: typeof spawn }} deps
 */
function createObserver(deps = {}) {
  const spawnFn = deps.spawnFn || spawn
  const onTick = deps.onTick || (() => {})
  /** @type {import('child_process').ChildProcess | null} */
  let child = null
  let buf = ''

  function start() {
    if (child) return
    buf = ''
    try {
      child = spawnFn(powershellPath(), [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', resolveScript()
      ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch {
      child = null
      return
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', onData)
    child.on('exit', () => { child = null })
  }

  function onData(chunk) {
    buf += chunk
    let nl = buf.indexOf('\n')
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line.startsWith('{')) {
        try {
          const row = JSON.parse(line)
          onTick({
            name: String(row.name || row.Name || ''),
            path: String(row.path || row.Path || ''),
            pid: Number(row.pid || row.Pid) || 0,
            idleMs: Number(row.idleMs || row.IdleMs) || 0
          })
        } catch { /* 壞列丟掉 */ }
      }
      nl = buf.indexOf('\n')
    }
  }

  function stop() {
    const proc = child
    child = null
    if (!proc) return
    try { proc.stdin.end() } catch { /* 已關 */ }
    try { proc.kill() } catch { /* 已死 */ }
  }

  return {
    start,
    stop,
    get running() { return Boolean(child) }
  }
}

module.exports = { createObserver, resolveScript }
