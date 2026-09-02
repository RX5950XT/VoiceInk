'use strict'

/**
 * VoiceInk — PawnIO 核心驅動的自動安裝。
 *
 * 為什麼需要它：LibreHardwareMonitor 0.9.4 起把 WinRing0 換成 PawnIO，沒裝的話
 * CPU／主機板那一整組感測器**不報錯、只回 0**（跟壞掉一模一樣）。這是 VoiceInk
 * 唯一一個沒辦法自己帶著走的外部相依——它是核心驅動，必須真的安裝到系統裡。
 *
 * 三個實測踩過的地雷，動這支之前先看：
 *  - 靜默安裝參數是 `-install -silent`（**單破折號，而且 `-install` 不能省**）。
 *    `/S`／`/silent`／`/quiet` 全部無效**且不報錯**，只會開一扇要人按的提權視窗。
 *  - PawnIO 2.2.0 把 `PawnIOLib.dll` 裝在 `%ProgramFiles%\PawnIO\` 而且**不加進 PATH**，
 *    所以「裝好了」跟「LoadLibrary 找得到」是兩件事（sidecar 的 PreparePawnIo 負責補）。
 *  - 安裝完 `Computer.Open()` 要載核心模組，第一筆讀數實測約 10 秒才到。
 *
 * 安全：下載網址是本檔的固定常數（renderer 傳不進任何字串），落地後**先驗
 * Authenticode 簽章**——狀態要 Valid、簽署者要是 PawnIO 作者，否則刪檔不執行。
 * 這裡刻意不釘 SHA-256：釘了之後上游一發新版就變成「自動安裝一個過期版本」，
 * 而簽章驗證對每一版都成立。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

/** 官方安裝頁（給使用者自己看的） */
const PAWNIO_URL = 'https://pawnio.eu/'
/** pawnio.eu 首頁上的下載按鈕就指到這裡 */
const SETUP_URL = 'https://github.com/namazso/PawnIO.Setup/releases/latest/download/PawnIO_setup.exe'
/** 實測簽章：E=admin@namazso.eu, CN=namazso.eu, O=namazso, L=Debrecen, C=HU */
const EXPECTED_SIGNER = 'CN=namazso.eu'
/** 安裝檔約 3.4MB；超過這個就不是我們認得的東西 */
const MAX_SETUP_BYTES = 32 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 120_000
const INSTALL_TIMEOUT_MS = 180_000

/** DLL 可能落在的兩個位置（新版在 Program Files，舊版在 System32） */
function libCandidates() {
  const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'PawnIOLib.dll')
  const programFiles = path.join(
    process.env.ProgramFiles || 'C:\\Program Files', 'PawnIO', 'PawnIOLib.dll'
  )
  return [system32, programFiles]
}

/** @returns {boolean} 系統裡有沒有 PawnIO */
function isInstalled() {
  return libCandidates().some((candidate) => {
    try { return fs.existsSync(candidate) } catch { return false }
  })
}

function makeError(code, userMessage) {
  const error = new Error(code)
  error.code = code
  error.userMessage = userMessage
  return error
}

/**
 * 跑一次 PowerShell 並收 stdout。指令字串全部由本檔組出來，沒有外部輸入。
 * @param {string[]} args
 * @param {number} timeoutMs
 * @param {(fn: string, a: string[], o: object) => any} spawnFn
 */
function runPowerShell(args, timeoutMs, spawnFn) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawnFn('powershell.exe', ['-NoProfile', '-NonInteractive', ...args], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
      })
    } catch {
      resolve({ code: -1, out: '' })
      return
    }
    let out = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      if (out.length < 8192) out += chunk
    })
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已經結束了 */ }
      resolve({ code: -1, out })
    }, timeoutMs)
    child.on('error', () => { clearTimeout(timer); resolve({ code: -1, out }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }) })
  })
}

/**
 * 驗 Authenticode。`Get-AuthenticodeSignature` 會走 WinVerifyTrust，
 * 憑證鏈與吊銷都由系統判，我們只要比對狀態與簽署者。
 * @returns {Promise<boolean>}
 */
async function verifySignature(file, spawnFn) {
  const literal = file.replace(/'/g, "''")
  const script = [
    // git-bash 之類的環境會污染 PSModulePath，害 Security 模組載不起來（實測過）
    "$env:PSModulePath = Join-Path $env:SystemRoot 'system32\\WindowsPowerShell\\v1.0\\Modules';",
    `$s = Get-AuthenticodeSignature -LiteralPath '${literal}';`,
    "Write-Output ('STATUS=' + $s.Status);",
    "Write-Output ('SUBJECT=' + $s.SignerCertificate.Subject)"
  ].join(' ')
  const { out } = await runPowerShell(['-ExecutionPolicy', 'Bypass', '-Command', script], 30_000, spawnFn)
  const status = /STATUS=(\w+)/.exec(out)?.[1] || ''
  const subject = /SUBJECT=(.*)/.exec(out)?.[1] || ''
  return status === 'Valid' && subject.includes(EXPECTED_SIGNER)
}

/**
 * 下載安裝檔。用 fetch 是因為 GitHub releases 會 302 到 objects.githubusercontent.com，
 * 自己接 https.get 得手動追轉址。
 * @returns {Promise<Buffer>}
 */
async function download(url, fetchFn) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const response = await fetchFn(url, { signal: controller.signal, redirect: 'follow' })
    if (!response.ok) {
      // 只留狀態碼：body 的內容由對方決定，不進訊息也不進 log
      throw makeError('PAWNIO_DOWNLOAD_FAILED', `下載 PawnIO 安裝檔失敗（HTTP ${response.status}），請檢查網路後再試一次。`)
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (!buffer.length || buffer.length > MAX_SETUP_BYTES) {
      throw makeError('PAWNIO_BAD_SETUP', '下載到的安裝檔大小不正常，已中止安裝。')
    }
    return buffer
  } catch (error) {
    if (error.userMessage) throw error
    throw makeError('PAWNIO_DOWNLOAD_FAILED', '下載 PawnIO 安裝檔失敗，請檢查網路後再試一次。')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 下載 → 驗簽 → 提權靜默安裝 → 確認 DLL 真的出現。
 * @param {{ fetchFn?: typeof fetch, spawnFn?: typeof spawn, tmpDir?: string,
 *           isInstalledFn?: () => boolean }} deps
 * @returns {Promise<{ installed: boolean, already: boolean }>}
 */
async function install(deps = {}) {
  const fetchFn = deps.fetchFn || globalThis.fetch
  const spawnFn = deps.spawnFn || spawn
  const installedFn = deps.isInstalledFn || isInstalled
  if (installedFn()) return { installed: true, already: true }

  const tmpDir = deps.tmpDir || os.tmpdir()
  const file = path.join(tmpDir, `voiceink-pawnio-${process.pid}.exe`)
  try {
    fs.writeFileSync(file, await download(SETUP_URL, fetchFn), { mode: 0o600 })

    if (!await verifySignature(file, spawnFn)) {
      throw makeError('PAWNIO_BAD_SIGNATURE', '下載到的安裝檔簽章不符，已中止安裝。請改由官方網站手動安裝。')
    }

    // -install -silent：單破折號，而且 -install 不能省（其餘寫法會靜靜開一扇要人按的視窗）
    const literal = file.replace(/'/g, "''")
    const { code } = await runPowerShell([
      '-ExecutionPolicy', 'Bypass', '-Command',
      `$p = Start-Process -FilePath '${literal}' -ArgumentList '-install','-silent' -Verb RunAs -Wait -PassThru; exit $p.ExitCode`
    ], INSTALL_TIMEOUT_MS, spawnFn)

    if (!installedFn()) {
      throw code === 0
        ? makeError('PAWNIO_INSTALL_FAILED', 'PawnIO 安裝沒有完成，請改由官方網站手動安裝。')
        : makeError('PAWNIO_DECLINED', '安裝 PawnIO 需要系統管理員權限；你也可以到官方網站手動安裝。')
    }
    return { installed: true, already: false }
  } finally {
    try { fs.unlinkSync(file) } catch { /* 檔案沒建起來或已被清掉 */ }
  }
}

module.exports = {
  install, isInstalled, verifySignature,
  PAWNIO_URL, SETUP_URL, EXPECTED_SIGNER, MAX_SETUP_BYTES
}
