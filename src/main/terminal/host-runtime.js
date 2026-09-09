'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')

const PROTOCOL = 1
const HOST_FILES = ['host.js', 'host-runtime.js', 'pty.js', 'store.js', 'status.js', 'admin.js', 'admin-host.js']
const RUNTIME_FILES = ['icudtl.dat', 'snapshot_blob.bin', 'v8_context_snapshot.bin']

function hostError(code = 'TERMINAL_HOST_ERROR') {
  const error = new Error(code)
  error.code = code
  error.userMessage = '終端機背景程序無法連線，原本的工作階段不會被重新執行。'
  return error
}

const unpacked = (dir) => dir.replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked')

/** 系統工具一律指名 System32：PATH 上可能擺著 MSYS／Cygwin 的同名執行檔。 */
const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\Windows', 'System32')

/** 背景管道的通行證只給目前 Windows 使用者、SYSTEM 與管理員。 */
function protectDirectory(dir) {
  if (process.platform !== 'win32') { fs.chmodSync(dir, 0o700); return }
  const result = execFileSync(path.join(SYSTEM32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true })
  const sid = result.match(/S-1-5-\d+(?:-\d+)+/)?.[0]
  if (!sid) throw hostError('HOST_PERMISSIONS')
  execFileSync(path.join(SYSTEM32, 'icacls.exe'), [dir, '/inheritance:r', '/grant:r',
    `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'
  ], { windowsHide: true, stdio: 'ignore' })
}

function checkedRoot(userData, create) {
  const base = fs.realpathSync.native(userData)
  const root = path.join(base, 'terminal-host')
  if (!fs.existsSync(root)) {
    if (!create) return null
    fs.mkdirSync(root, { mode: 0o700 })
    protectDirectory(root)
  }
  if (fs.lstatSync(root).isSymbolicLink() || fs.realpathSync.native(root) !== root) throw hostError('HOST_PATH')
  return root
}

function connection(userData, create = false) {
  const root = checkedRoot(userData, create)
  if (!root) return null
  const file = path.join(root, 'connection.json')
  if (!fs.existsSync(file)) {
    if (!create) return null
    protectDirectory(root)
    fs.writeFileSync(file, JSON.stringify({ protocol: PROTOCOL, token: crypto.randomBytes(32).toString('hex') }), { flag: 'wx', mode: 0o600 })
  }
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw hostError('HOST_CONFIG')
  const config = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (config.protocol !== PROTOCOL || !/^[a-f0-9]{64}$/.test(config.token)) throw hostError('HOST_CONFIG')
  const name = crypto.createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 24)
  return { root, token: config.token, protocol: PROTOCOL, pipe: `\\\\.\\pipe\\voiceink-terminal-v${PROTOCOL}-${name}` }
}

/**
 * 這一版 App 想要的執行環境資料夾名（＝宿主檔案的內容雜湊）。**只算不複製**：
 * 每次連上宿主都要拿它跟對方回報的名字比，看跑著的是不是舊版程式碼
 * （宿主是獨立程序，App 更新不會把它換掉——見 `service.js` 的 `hostState`）。
 *
 * @param {string} [execPath]
 * @returns {{ name: string, version: string, ptyRoot: string }}
 */
function runtimeName(execPath = process.execPath) {
  const version = process.versions.electron || fs.readFileSync(path.join(path.dirname(execPath), 'version'), 'utf8').trim()
  const hash = crypto.createHash('sha256').update(version)
  for (const name of HOST_FILES) hash.update(fs.readFileSync(path.join(__dirname, name)))
  // 打包後 fs.cpSync 讀不了 asar 裡的檔案（會靜靜地留下半套 node_modules），
  // 所以 node-pty 的 JS 與原生檔都改指 app.asar.unpacked。
  const ptyRoot = unpacked(path.dirname(require.resolve('@lydell/node-pty')))
  hash.update(fs.readFileSync(path.join(ptyRoot, 'package.json')))
  return { name: `runtime-${hash.digest('hex').slice(0, 24)}`, version, ptyRoot }
}

/** 原生檔案不能鎖住安裝目錄；執行環境按內容分版，運行中的版本永不覆寫。 */
function stageRuntime(root, execPath = process.execPath) {
  const { name, version, ptyRoot } = runtimeName(execPath)
  const dir = path.join(root, name)
  if (!fs.existsSync(path.join(dir, 'ready'))) {
    const staging = fs.mkdtempSync(path.join(root, 'runtime-building-'))
    try {
      fs.copyFileSync(execPath, path.join(staging, 'VoiceInkTerminalHost.exe'))
      for (const file of RUNTIME_FILES) fs.copyFileSync(path.join(path.dirname(execPath), file), path.join(staging, file))
      for (const file of HOST_FILES) fs.copyFileSync(path.join(__dirname, file), path.join(staging, file))
      const modules = path.join(staging, 'node_modules/@lydell')
      fs.mkdirSync(modules, { recursive: true })
      fs.cpSync(ptyRoot, path.join(modules, 'node-pty'), { recursive: true })
      const nativeRoot = unpacked(path.resolve(path.dirname(require.resolve('@lydell/node-pty-win32-x64')), '..'))
      fs.cpSync(nativeRoot, path.join(modules, 'node-pty-win32-x64'), { recursive: true })
      fs.writeFileSync(path.join(staging, 'ready'), version)
      fs.renameSync(staging, dir)
    } catch (error) {
      // 半套的執行環境跑不起來又佔 248MB，建到一半就整個收掉。
      fs.rmSync(staging, { recursive: true, force: true })
      throw error
    }
  }
  if (fs.lstatSync(dir).isSymbolicLink() || fs.realpathSync.native(dir) !== dir) throw hostError('HOST_PATH')
  pruneRuntimes(root, path.basename(dir))
  return { exe: path.join(dir, 'VoiceInkTerminalHost.exe'), entry: path.join(dir, 'host.js'), dir }
}

/** 每次改版就多一份 248MB；執行中的宿主鎖著自己的 exe，開得起來才代表沒人在用。 */
function pruneRuntimes(root, keep) {
  for (const name of fs.readdirSync(root)) {
    if (!name.startsWith('runtime-') || name === keep) continue
    const dir = path.join(root, name)
    // 沒有 ready 的是別人正在建立或建到一半的，交給下一次收。
    if (!fs.existsSync(path.join(dir, 'ready'))) continue
    try {
      fs.closeSync(fs.openSync(path.join(dir, 'VoiceInkTerminalHost.exe'), 'r+'))
      fs.rmSync(dir, { recursive: true, force: true })
    } catch { /* 還有宿主跑在這一份，或檔案被鎖住 */ }
  }
}

module.exports = { PROTOCOL, connection, runtimeName, stageRuntime, hostError }
