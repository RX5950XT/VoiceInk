'use strict'

/**
 * VoiceInk — 感測器 sidecar 的「免 UAC 啟動」排程工作。
 *
 * 為什麼要這個：sidecar 必須提權（讀 Super I/O 與寫風扇 PWM），而 `Start-Process -Verb RunAs`
 * **每次啟動都會彈 UAC**。風扇控制要在開機自啟動時就接管，那條路等於不可用。
 *
 * 做法跟 FanControl／Rainmeter 一樣：註冊一個**沒有觸發程序**（僅隨選）、`RunLevel Highest`
 * 的排程工作，註冊時彈**一次** UAC；之後 `schtasks /run` 就會用提權權杖執行而**不再提示**。
 *
 * 管道名怎麼傳進去：工作的參數在註冊時就寫死（要改得再提權一次），所以改用交接檔——
 * 主程式把本次的隨機管道名寫進 `<userData>/sensors-handoff.txt`，sidecar 讀完立刻刪。
 *
 * **只在打包版提供安裝**：開發版的執行檔在使用者可寫的目錄，替換掉它就等於一條
 * 「免 UAC 執行任意程式」的後門。打包版在 Program Files，一般使用者寫不進去。
 *
 * 沒有這個工作時，`sensors.js` 會退回舊的 `-Verb RunAs`（每次一個 UAC），功能不消失。
 */

const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')
const { spawn } = require('child_process')

const TASK_NAME = 'VoiceInk Sensors'
const RUN_TIMEOUT_MS = 15_000
/** 註冊要等使用者按 UAC */
const INSTALL_TIMEOUT_MS = 120_000

/** 單檔 helper 固定放在受保護位置，預覽／per-user 安裝也能共用。 */
function protectedExe() {
  const root = process.env.ProgramW6432 || process.env.ProgramFiles
  return root ? path.join(root, 'VoiceInk Sensors', 'VoiceInkSensors.exe') : ''
}

/** 比對本版 helper，避免新版 App 靜默連到舊協議。 */
function sameBinary(source, target) {
  try {
    const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    return hash(source) === hash(target)
  } catch { return false }
}

/**
 * 免 UAC 工作只能指向系統保護的安裝目錄。`app.isPackaged` 不代表真的在 Program Files；
 * per-user 安裝仍可被目前使用者改寫，註冊成最高權限工作會變成提權後門。
 * @param {string} exePath
 * @returns {boolean}
 */
function isProtectedInstall(exePath) {
  const roots = [process.env.ProgramFiles, process.env.ProgramW6432, process.env['ProgramFiles(x86)']]
    .filter((value) => typeof value === 'string' && value.length > 0)
  try {
    const exe = fs.realpathSync(exePath)
    return roots.some((root) => {
      const base = fs.realpathSync(root)
      const relative = path.relative(base, exe)
      return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    })
  } catch {
    return false
  }
}

/** PowerShell 單引號字串的跳脫：只有單引號要處理 */
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * 跑一段 PowerShell。`elevate` 為真時走 `Start-Process -Verb RunAs`（會彈 UAC）。
 * @returns {Promise<{ code: number }>}
 */
function runPowerShell(script, { elevate = false, timeoutMs = RUN_TIMEOUT_MS, spawnFn = spawn } = {}) {
  const command = elevate
    ? `$p = Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -PassThru `
      + `-ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',`
      + psQuote(Buffer.from(script, 'utf16le').toString('base64'))
      + `; exit $p.ExitCode`
    : script

  return new Promise((resolve) => {
    let child
    try {
      child = spawnFn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command
      ], { windowsHide: true, stdio: 'ignore' })
    } catch {
      resolve({ code: -1 })
      return
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已經結束了 */ }
      resolve({ code: -1 })
    }, timeoutMs)
    child.on('error', () => { clearTimeout(timer); resolve({ code: -1 }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: Number(code) }) })
  })
}

/**
 * 讀出現有排程工作寫死的交接檔路徑（測試暫存 userData 裝過之後會對不上現在的 userData）。
 * @param {typeof spawn} spawnFn
 * @returns {Promise<string>}
 */
function readTaskHandoffArg(spawnFn) {
  return new Promise((resolve) => {
    let out = ''
    let child
    try {
      child = spawnFn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        `$ErrorActionPreference='SilentlyContinue'; $t=Get-ScheduledTask -TaskName ${psQuote(TASK_NAME)}; [string]$t.Actions[0].Arguments`
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      resolve('')
      return
    }
    if (!child.stdout || typeof child.stdout.on !== 'function') {
      resolve('')
      return
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      resolve('')
    }, 4000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('error', () => { clearTimeout(timer); resolve('') })
    child.on('close', () => {
      clearTimeout(timer)
      const arg = out.trim().replace(/^["']+|["']+$/g, '')
      resolve(arg.toLowerCase().endsWith('.txt') ? arg : '')
    })
  })
}

function createSensorTask(deps = {}) {
  const spawnFn = deps.spawnFn || spawn
  /** 打包版才准安裝（開發版執行檔在可寫目錄＝提權後門） */
  const packaged = deps.packaged === true
  const userDataPath = deps.userDataPath || ''

  /** 交接檔：只裝一個管道名，sidecar 讀完就刪 */
  function handoffPath() {
    return userDataPath ? path.join(userDataPath, 'sensors-handoff.txt') : ''
  }

  /**
   * 工作在不在，而且指向的是不是**現在這個**執行檔（重裝到別的目錄後會對不上）。
   * @param {string} exePath
   * @returns {Promise<{ installed: boolean, stale: boolean }>}
   */
  async function query(exePath) {
    const script = `$ErrorActionPreference='Stop'; `
      + `try { $t = Get-ScheduledTask -TaskName ${psQuote(TASK_NAME)} } catch { exit 3 }; `
      + `if ($t.Actions[0].Execute -ne ${psQuote(exePath)}) { exit 4 }; exit 0`
    const { code } = await runPowerShell(script, { spawnFn })
    if (code === 0) return { installed: true, stale: false }
    if (code === 4) return { installed: true, stale: true }
    return { installed: false, stale: false }
  }

  return {
    TASK_NAME,
    handoffPath,

    /**
     * @param {string} exePath sidecar 執行檔（由 main 解析，renderer 碰不到）
     * @returns {Promise<{ installed: boolean, stale: boolean, canInstall: boolean, reason: string }>}
     */
    async status(exePath) {
      if (!exePath || !userDataPath) {
        return { installed: false, stale: false, canInstall: false, reason: '沒有可用的感測器元件。' }
      }
      const target = protectedExe()
      const found = await query(target)
      const current = isProtectedInstall(target) && sameBinary(exePath, target)
      return {
        ...found,
        stale: found.installed && (found.stale || !current),
        canInstall: packaged && Boolean(target),
        reason: !packaged
          ? '開發版不提供免 UAC 啟動：執行檔放在可寫入的目錄，註冊成提權工作等於留下後門。'
            + '打包版（npm run electron:pack）才會出現這個選項。'
          : ''
      }
    },

    /**
     * 註冊排程工作。會彈**一次** UAC。
     * @param {string} exePath
     */
    async install(exePath) {
      if (!packaged) {
        const err = new Error('dev build')
        err.code = 'SYSMON_TASK_DEV'
        err.userMessage = '開發版不提供免 UAC 啟動，請用打包版。'
        throw err
      }
      const handoff = handoffPath()
      const target = protectedExe()
      if (!exePath || !fs.existsSync(exePath) || !handoff || !target) {
        const err = new Error('missing exe')
        err.code = 'SYSMON_TASK_MISSING'
        err.userMessage = '找不到感測器元件，無法建立排程工作。'
        throw err
      }
      // 沒有 -Trigger：這個工作只由主程式隨選觸發，不常駐、不開機自己跑。
      // ExecutionTimeLimit 0 = 不限時（預設 3 天到期會被砍掉，風扇就沒人管了）。
      // MultipleInstances Parallel：換管道重連時舊的那顆還在收尾，擋掉新的會讓連線逾時。
      const script = [
        `$ErrorActionPreference='Stop'`,
        `$target = ${psQuote(target)}; $dir = Split-Path -LiteralPath $target`,
        `foreach ($p in @($dir,$target)) { if ((Test-Path -LiteralPath $p) -and ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe helper path' } }`,
        `New-Item -ItemType Directory -Force -Path $dir | Out-Null`,
        `icacls.exe $dir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'Helper ACL failed' }`,
        `Copy-Item -LiteralPath ${psQuote(exePath)} -Destination $target -Force`,
        `icacls.exe $target /reset | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'Helper ACL failed' }`,
        `if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne ${psQuote(crypto.createHash('sha256').update(fs.readFileSync(exePath)).digest('hex'))}) { throw 'Helper hash mismatch' }`,
        `$action = New-ScheduledTaskAction -Execute $target -Argument ${psQuote(`"${handoff}"`)}`,
        `$principal = New-ScheduledTaskPrincipal -UserId ${psQuote(`${process.env.USERDOMAIN || '.'}\\${process.env.USERNAME || ''}`)} -LogonType Interactive -RunLevel Highest`,
        `$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries`
          + ` -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances Parallel -StartWhenAvailable`,
        `Register-ScheduledTask -TaskName ${psQuote(TASK_NAME)} -Action $action -Principal $principal -Settings $settings -Force | Out-Null`
      ].join('; ')

      const { code } = await runPowerShell(script, { elevate: true, timeoutMs: INSTALL_TIMEOUT_MS, spawnFn })
      if (code !== 0) {
        const err = new Error(`register failed ${code}`)
        err.code = 'SYSMON_TASK_FAILED'
        err.userMessage = '建立排程工作失敗（可能是在 UAC 按了「否」，或系統原則禁止排程工作）。'
        throw err
      }
      return query(target)
    },

    /** 移除排程工作（會彈一次 UAC）。移除後 sidecar 退回每次 UAC 的舊路。 */
    async remove() {
      const script = `$ErrorActionPreference='SilentlyContinue'; `
        + `Unregister-ScheduledTask -TaskName ${psQuote(TASK_NAME)} -Confirm:$false; exit 0`
      await runPowerShell(script, { elevate: true, timeoutMs: INSTALL_TIMEOUT_MS, spawnFn })
      return { installed: false, stale: false }
    },

    /**
     * 用排程工作把 sidecar 拉起來——**不會彈 UAC**。
     * @param {string} pipeName 本次 session 的隨機管道名
     * @param {string} [exePath] 目前 sidecar 執行檔；安全工作只能指向受保護的安裝位置
     * @returns {Promise<boolean>} 成功觸發才回 true；false 時呼叫端要退回 -Verb RunAs
     */
    async run(pipeName, exePath = '') {
      const target = protectedExe()
      if (!isProtectedInstall(target) || !sameBinary(exePath, target)) return false
      const found = await query(target)
      if (!found.installed || found.stale) return false
      const taskArg = await readTaskHandoffArg(spawnFn)
      const file = taskArg || handoffPath() || path.join(os.tmpdir(), 'voiceink-sensors-handoff.txt')
      let wrote = 0
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, String(pipeName), 'utf8')
        wrote = 1
      } catch { /* 交接檔寫不進去就退回 UAC */ }
      if (!wrote) return false
      const { code } = await runPowerShell(
        `$ErrorActionPreference='Stop'; Start-ScheduledTask -TaskName ${psQuote(TASK_NAME)}; exit 0`,
        { spawnFn }
      )
      if (code !== 0) {
        try { fs.unlinkSync(file) } catch { /* 沒建成也沒關係 */ }
        return false
      }
      return true
    }
  }
}

module.exports = { createSensorTask, TASK_NAME }
