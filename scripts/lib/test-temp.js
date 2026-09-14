/**
 * 測試／探針腳本共用的暫存資料夾。**腳本裡不准自己 `os.tmpdir()`／`mkdtemp`**（`test-temp-hygiene.js` 會擋）。
 *
 * - 全部放在 `%TEMP%\voiceink-tests\<這次執行>\` 底下，使用者看 `%TEMP%` 只會多一個資料夾。
 * - 程序結束（正常結束、例外、Ctrl+C）整個刪掉。
 * - 上一次當掉、或子程序還抓著檔案沒刪成功的，下一支用到這裡的腳本會把超過 `STALE_MS` 的順手清掉。
 *
 * 仍在 `os.tmpdir()` 底下：`uffs.inTempUserData()` 靠這個判斷「暫存 userData 不自動跳 UAC」。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
// 暫存 userData 裡常有 junction 指回真的模型資料夾：Node 24 的 rmSync 遞迴會穿過去刪掉，一律用這支
const { removeTreeSync } = require('../../src/main/safe-rm')

const ROOT = path.join(os.tmpdir(), 'voiceink-tests')
// ponytail: 靠時間判斷別的執行是不是還活著；同時跑超過 6 小時的測試才會被誤清
const STALE_MS = 6 * 60 * 60 * 1000

/** @type {string} */
let runDir = ''

function removeQuietly(dir) {
  try {
    removeTreeSync(dir, { retries: 5 })
    return true
  } catch {
    return false
  }
}

function sweepStale() {
  let entries = []
  try {
    entries = fs.readdirSync(ROOT, { withFileTypes: true })
  } catch {
    return
  }
  const now = Date.now()
  for (const entry of entries) {
    const full = path.join(ROOT, entry.name)
    try {
      if (now - fs.statSync(full).mtimeMs > STALE_MS) removeQuietly(full)
    } catch {
      // 別的執行剛好在刪同一個
    }
  }
}

function ensureRunDir() {
  if (runDir) return runDir
  fs.mkdirSync(ROOT, { recursive: true })
  sweepStale()
  runDir = fs.mkdtempSync(path.join(ROOT, `run-${process.pid}-`))
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    if (!removeQuietly(runDir)) console.warn(`[test-temp] 暫存資料夾還被占用，下次執行會清掉：${runDir}`)
  }
  process.once('exit', cleanup)
  // `npx electron` 跑的腳本用 `app.exit()` 收尾，那條路不會觸發 Node 的 'exit'
  if (process.versions.electron && process.type === 'browser') {
    const { app } = require('electron')
    const exit = app.exit.bind(app)
    app.exit = (code) => {
      cleanup()
      exit(code)
    }
  }
  // 沒有這兩行，Ctrl+C 與未捕捉的例外不會觸發 'exit'
  process.once('SIGINT', () => process.exit(130))
  process.once('SIGTERM', () => process.exit(143))
  return runDir
}

/**
 * 建一個新的暫存資料夾（同一次執行裡每次呼叫都是不同的資料夾）
 * @param {string} [prefix]
 * @returns {string}
 */
function tempDir(prefix = 'tmp-') {
  return fs.mkdtempSync(path.join(ensureRunDir(), prefix))
}

/**
 * 暫存資料夾裡的一個檔案路徑（只給路徑，不建檔）
 * @param {string} name
 * @returns {string}
 */
function tempFile(name) {
  return path.join(ensureRunDir(), name)
}

module.exports = { tempDir, tempFile, removeTree: removeTreeSync, ROOT, STALE_MS }
