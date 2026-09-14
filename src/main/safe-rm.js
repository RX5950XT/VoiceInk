/**
 * 不跟著連結走的遞迴刪除。**遞迴刪資料夾一律用這支，不准用 `fs.rmSync(..., { recursive: true })`**。
 *
 * Node 24（＝Electron 43 內建的那份）的 `rmSync` 遞迴時會**穿過 junction 把對面的真資料一起刪掉**
 * （實測：純 Node 24 與 Electron 主程序都一樣；Node 22 不會；非同步的 `fs.promises.rm` 不會）。
 * 測試的暫存 userData 裡常有 junction 指回使用者的模型資料夾——那一刪就是好幾 GB 的模型。
 *
 * 做法：`lstat` 逐層走，連結（symlink／junction）只拆連結本身，唯讀檔先改可寫再刪。
 * 回歸 `test-safe-rm.js`；守門 `test-temp-hygiene.js`。
 */
const fs = require('./raw-fs')
const path = require('path')

const RETRY_CODES = new Set(['EBUSY', 'ENOTEMPTY', 'EPERM', 'EACCES'])

/** @param {number} ms */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * @param {() => void} op
 * @param {number} retries
 */
function withRetry(op, retries) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      op()
      return
    } catch (error) {
      if (!RETRY_CODES.has(error?.code) || attempt >= retries) throw error
      pause(100 * (attempt + 1))
    }
  }
}

/** @param {string} file */
function unlinkFile(file) {
  try {
    fs.unlinkSync(file)
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error
    // 唯讀檔（例如 git 物件）要先拿掉唯讀才刪得掉
    fs.chmodSync(file, 0o666)
    fs.unlinkSync(file)
  }
}

/**
 * @param {string} target
 * @param {{ retries?: number }} [opts] 被占用（EBUSY 等）時重試幾次
 */
function removeTreeSync(target, opts = {}) {
  const retries = opts.retries ?? 3
  let stat
  try {
    stat = fs.lstatSync(target)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  if (stat.isSymbolicLink()) {
    // 只拆連結：檔案型 symlink 用 unlink，資料夾 junction 在 Windows 要 rmdir
    withRetry(() => {
      try {
        fs.unlinkSync(target)
      } catch {
        fs.rmdirSync(target)
      }
    }, retries)
    return
  }
  if (!stat.isDirectory()) {
    withRetry(() => unlinkFile(target), retries)
    return
  }
  for (const name of fs.readdirSync(target)) removeTreeSync(path.join(target, name), opts)
  withRetry(() => fs.rmdirSync(target), retries)
}

module.exports = { removeTreeSync }
