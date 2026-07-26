/**
 * VoiceInk - CUDA 執行環境偵測與自動安裝（Windows）
 * node-llama-cpp 需要 cudart + cublas + cublasLt（11/12/13）。
 */

const { app, shell } = require('electron')
const { execFile, spawn } = require('child_process')
const { promisify } = require('util')
const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')
const { Readable } = require('stream')
const { pipeline } = require('stream/promises')

const execFileAsync = promisify(execFile)

/** winget 套件（完整 Toolkit，含 runtime） */
const WINGET_PACKAGE_ID = 'Nvidia.CUDA'

/**
 * CUDA 本機安裝包（與 winget Nvidia.CUDA 13.3 對齊）
 * 若 winget 不可用則下載此檔。
 */
const CUDA_INSTALLER = {
  version: '13.3.1',
  url: 'https://developer.download.nvidia.com/compute/cuda/13.3.1/local_installers/cuda_13.3.1_windows.exe',
  fileName: 'cuda_13.3.1_windows.exe'
}

const CUDART_NAMES = ['cudart64_13.dll', 'cudart64_12.dll', 'cudart64_11.dll', 'cudart64_110.dll']
const CUBLAS_NAMES = ['cublas64_13.dll', 'cublas64_12.dll', 'cublas64_11.dll']
const CUBLASLT_NAMES = ['cublasLt64_13.dll', 'cublasLt64_12.dll', 'cublasLt64_11.dll']

/** @type {boolean} */
let installing = false

/**
 * @returns {string[]}
 */
function programFilesRoots() {
  const drive = process.env.SystemDrive || 'C:'
  return [
    process.env['ProgramFiles'],
    process.env['ProgramFiles(x86)'],
    process.env['ProgramFiles(Arm)'],
    `${drive}\\Program Files`,
    `${drive}\\Program Files (x86)`
  ].filter(Boolean)
}

/**
 * 候選 CUDA 安裝根目錄
 * @returns {string[]}
 */
function listCudaInstallRoots() {
  const roots = []
  if (process.env.CUDA_PATH) roots.push(process.env.CUDA_PATH)
  for (const pf of programFilesRoots()) {
    const container = path.join(pf, 'NVIDIA GPU Computing Toolkit', 'CUDA')
    if (!fs.existsSync(container)) continue
    try {
      const vers = fs
        .readdirSync(container)
        .filter((n) => /^v\d/i.test(n))
        .sort()
        .reverse()
      for (const v of vers) roots.push(path.join(container, v))
    } catch { /* ignore */ }
  }
  return roots
}

/**
 * 搜尋路徑：CUDA bin + PATH
 * @returns {string[]}
 */
function librarySearchDirs() {
  const dirs = []
  for (const root of listCudaInstallRoots()) {
    dirs.push(root)
    dirs.push(path.join(root, 'bin'))
    dirs.push(path.join(root, 'bin', 'x64'))
  }
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  return [...new Set([...dirs, ...pathDirs])]
}

/**
 * @param {string[]} names
 * @param {string[]} dirs
 * @returns {string | null}
 */
function findFirstFile(names, dirs) {
  for (const dir of dirs) {
    for (const name of names) {
      const p = path.join(dir, name)
      if (fs.existsSync(p)) return p
    }
  }
  // 也查 System32
  const windir = process.env.windir || 'C:\\Windows'
  for (const name of names) {
    const p = path.join(windir, 'System32', name)
    if (fs.existsSync(p)) return p
  }
  return null
}

/**
 * @returns {{ hasNvidiaDriver: boolean, hasCudaRuntime: boolean, details: object }}
 */
function detectCudaRuntime() {
  const windir = process.env.windir || 'C:\\Windows'
  const hasNvidiaDriver =
    fs.existsSync(path.join(windir, 'System32', 'nvml.dll')) ||
    fs.existsSync(path.join(windir, 'System32', 'nvcuda.dll'))

  const dirs = librarySearchDirs()
  const cudart = findFirstFile(CUDART_NAMES, dirs)
  const cublas = findFirstFile(CUBLAS_NAMES, dirs)
  const cublasLt = findFirstFile(CUBLASLT_NAMES, dirs)
  const hasCudaRuntime = !!(cudart && cublas && cublasLt)

  return {
    hasNvidiaDriver,
    hasCudaRuntime,
    details: {
      cudart,
      cublas,
      cublasLt,
      cudaPath: process.env.CUDA_PATH || listCudaInstallRoots()[0] || null
    }
  }
}

/**
 * @returns {boolean}
 */
function detectVulkan() {
  const windir = process.env.windir || 'C:\\Windows'
  return (
    fs.existsSync(path.join(windir, 'System32', 'vulkan-1.dll')) ||
    fs.existsSync(path.join(windir, 'SysWOW64', 'vulkan-1.dll'))
  )
}

/**
 * @returns {Promise<boolean>}
 */
async function hasWinget() {
  try {
    await execFileAsync('winget', ['--version'], { windowsHide: true, timeout: 8000 })
    return true
  } catch {
    return false
  }
}

/**
 * @returns {string}
 */
function installerCachePath() {
  return path.join(app.getPath('userData'), 'cache', 'cuda-installer', CUDA_INSTALLER.fileName)
}

/**
 * @param {(p: { phase: string, message: string, percent?: number }) => void} onProgress
 */
async function downloadInstaller(onProgress) {
  const dest = installerCachePath()
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  if (fs.existsSync(dest)) {
    const st = await fsp.stat(dest)
    if (st.size > 100 * 1024 * 1024) {
      onProgress({ phase: 'download', message: '已有本機安裝包，略過下載', percent: 100 })
      return dest
    }
  }
  onProgress({ phase: 'download', message: '正在下載 CUDA Toolkit 安裝包…', percent: 0 })
  const res = await fetch(CUDA_INSTALLER.url)
  if (!res.ok) throw new Error(`下載失敗 HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length') || 0)
  let received = 0
  let lastEmit = 0
  const part = dest + '.part'
  const counter = new (require('stream').Transform)({
    transform(chunk, _enc, cb) {
      received += chunk.length
      const now = Date.now()
      if (now - lastEmit > 400) {
        lastEmit = now
        const percent = total > 0 ? Math.min(99, Math.round((received / total) * 100)) : undefined
        onProgress({
          phase: 'download',
          message: total
            ? `下載中 ${Math.round(received / 1048576)} / ${Math.round(total / 1048576)} MB`
            : `下載中 ${Math.round(received / 1048576)} MB`,
          percent
        })
      }
      cb(null, chunk)
    }
  })
  await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(part))
  await fsp.rename(part, dest)
  onProgress({ phase: 'download', message: '下載完成', percent: 100 })
  return dest
}

/**
 * 以系統管理員執行命令並等待結束
 * @param {string} file
 * @param {string[]} args
 * @returns {Promise<number>} exit code
 */
function runElevated(file, args) {
  return new Promise((resolve, reject) => {
    // PowerShell Start-Process -Verb RunAs -Wait
    const argList = args.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(',')
    const ps = `
$p = Start-Process -FilePath '${file.replace(/'/g, "''")}' -ArgumentList @(${argList}) -Verb RunAs -Wait -PassThru
exit $p.ExitCode
`
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { windowsHide: true }
    )
    let stderr = ''
    child.stderr?.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === null) reject(new Error(stderr || 'elevated process failed'))
      else resolve(code)
    })
  })
}

/**
 * 安裝 CUDA 環境（winget 優先，否則下載官方 installer）
 * @param {(p: { phase: string, message: string, percent?: number }) => void} [onProgress]
 * @returns {Promise<{ ok: boolean, message: string, needsRestart?: boolean }>}
 */
async function installCudaEnv(onProgress = () => {}) {
  if (process.platform !== 'win32') {
    return { ok: false, message: '僅支援 Windows' }
  }
  if (installing) {
    return { ok: false, message: '安裝進行中，請稍候' }
  }

  const before = detectCudaRuntime()
  if (before.hasCudaRuntime) {
    return { ok: true, message: 'CUDA Runtime 已就緒，無需安裝' }
  }
  if (!before.hasNvidiaDriver) {
    return { ok: false, message: '未偵測到 NVIDIA 驅動，請先安裝顯示卡驅動' }
  }

  installing = true
  try {
    // 1) winget
    if (await hasWinget()) {
      onProgress({
        phase: 'install',
        message: '正在以 winget 安裝 NVIDIA CUDA Toolkit（需系統管理員權限）…',
        percent: 10
      })
      try {
        const code = await runElevated('winget', [
          'install',
          '--id',
          WINGET_PACKAGE_ID,
          '-e',
          '--accept-package-agreements',
          '--accept-source-agreements',
          '--disable-interactivity'
        ])
        onProgress({ phase: 'install', message: `winget 結束（code ${code}）`, percent: 90 })
        // 重新掃 PATH 可能仍是舊的；直接看檔案系統
        const after = detectCudaRuntime()
        if (after.hasCudaRuntime) {
          onProgress({ phase: 'done', message: 'CUDA Runtime 安裝成功', percent: 100 })
          return {
            ok: true,
            message: 'CUDA Toolkit 已安裝。建議重新啟動 VoiceInk 後再啟用 GPU。',
            needsRestart: true
          }
        }
        // winget 可能回 0 但元件未齊，或使用者取消 UAC
        if (code !== 0 && code !== 3010) {
          onProgress({
            phase: 'install',
            message: `winget 未成功（${code}），改下載官方安裝包…`,
            percent: 20
          })
        } else {
          onProgress({
            phase: 'install',
            message: 'winget 已執行，但尚未偵測到 Runtime，改試官方安裝包…',
            percent: 20
          })
        }
      } catch (e) {
        onProgress({
          phase: 'install',
          message: `winget 失敗：${e.message || e}，改下載官方安裝包…`,
          percent: 20
        })
      }
    }

    // 2) 官方 local installer（安靜安裝 runtime 相關元件盡量精簡）
    const installer = await downloadInstaller(onProgress)
    onProgress({
      phase: 'install',
      message: '正在啟動 CUDA 安裝程式（需系統管理員權限，可能需數分鐘）…',
      percent: 50
    })
    // -s 安靜模式；完整 toolkit 較穩，避免元件名稱隨版本變動
    const code = await runElevated(installer, ['-s'])
    // 3010 = 成功但需重開機
    if (code !== 0 && code !== 3010) {
      return {
        ok: false,
        message: `CUDA 安裝程式結束代碼 ${code}。可手動安裝：${CUDA_INSTALLER.url}`
      }
    }
    const after = detectCudaRuntime()
    if (after.hasCudaRuntime) {
      onProgress({ phase: 'done', message: 'CUDA Runtime 安裝成功', percent: 100 })
      return {
        ok: true,
        message:
          code === 3010
            ? '安裝完成，請先重新開機再啟動 VoiceInk。'
            : 'CUDA Toolkit 已安裝。請重新啟動 VoiceInk 後啟用 GPU。',
        needsRestart: true
      }
    }
    return {
      ok: false,
      message:
        '安裝程式已執行，但仍偵測不到 cudart/cublas。請重新開機後再試，或手動安裝 CUDA Toolkit。',
      needsRestart: true
    }
  } finally {
    installing = false
  }
}

/**
 * 開啟官方下載頁（後備）
 */
async function openCudaDownloadPage() {
  await shell.openExternal('https://developer.nvidia.com/cuda-downloads')
  return true
}

function isInstalling() {
  return installing
}

/**
 * 將 CUDA bin 前置到 process.env.PATH（給 llama-addon 載入 cudart/cublas）
 * @returns {string[]} 新加入的目錄
 */
function prependCudaBinToPath() {
  const added = []
  const roots = listCudaInstallRoots()
  const dirs = []
  for (const root of roots) {
    dirs.push(path.join(root, 'bin', 'x64'))
    dirs.push(path.join(root, 'bin'))
  }
  const current = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  const lower = new Set(current.map((d) => d.toLowerCase()))
  const prefix = []
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue
    if (lower.has(d.toLowerCase())) continue
    prefix.push(d)
    lower.add(d.toLowerCase())
    added.push(d)
  }
  if (prefix.length) {
    process.env.PATH = [...prefix, ...current].join(path.delimiter)
  }
  // 補 CUDA_PATH（部分工具會讀）
  if (!process.env.CUDA_PATH && roots[0]) {
    process.env.CUDA_PATH = roots[0]
  }
  return added
}

module.exports = {
  WINGET_PACKAGE_ID,
  CUDA_INSTALLER,
  detectCudaRuntime,
  detectVulkan,
  installCudaEnv,
  openCudaDownloadPage,
  isInstalling,
  hasWinget,
  prependCudaBinToPath,
  listCudaInstallRoots
}
