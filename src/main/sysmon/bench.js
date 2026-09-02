'use strict'

/**
 * VoiceInk — 磁碟序列讀寫測速（CrystalDiskMark 的 SEQ 那兩條）。
 *
 * 只做序列，而且只有**寫入**的數字是真的：
 * ponytail: 讀取走系統快取，Node 沒有 FILE_FLAG_NO_BUFFERING（Windows 上唯一能繞過快取的方式），
 * 所以讀取值只能當同一台機器上的相對參考。要真數字得寫 native binding 或改用 diskspd.exe，
 * 兩條路都得為了一個附屬功能多養一個依賴，先不做——UI 上直接標「含系統快取」。
 */

const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const crypto = require('crypto')

const CHUNK_BYTES = 8 * 1024 * 1024
const MIN_SIZE_MB = 128
const MAX_SIZE_MB = 8192
const TEST_FILE = '.voiceink-disk-bench.tmp'

let busy = false
let cancelled = false

/** @param {unknown} v */
function clampSizeMb(v) {
  const n = Math.trunc(Number(v))
  if (!Number.isFinite(n)) return 1024
  return Math.max(MIN_SIZE_MB, Math.min(MAX_SIZE_MB, n))
}

function cancelDiskBench() {
  cancelled = true
}

/**
 * @param {{ dir: string, sizeMb?: number }} req  dir 必須是呼叫端（main）已經驗過的資料夾
 * @param {(p: { phase: 'write'|'read', percent: number, mbPerSec: number }) => void} [onProgress]
 * @returns {Promise<{ sizeMb: number, writeMbPerSec: number, readMbPerSec: number, readCached: true }>}
 */
async function runDiskBench(req, onProgress = () => {}) {
  if (busy) {
    const err = new Error('bench busy')
    err.userMessage = '磁碟測速正在進行中'
    throw err
  }
  const dir = String(req?.dir || '')
  if (!dir) {
    const err = new Error('no dir')
    err.userMessage = '請先選擇要測試的磁碟'
    throw err
  }
  const sizeMb = clampSizeMb(req?.sizeMb)
  // 檔名帶亂數：上次崩潰若留下殘骸也不會互相覆蓋（finally 都會刪自己的這個檔）
  const target = path.join(dir, `${TEST_FILE}-${crypto.randomBytes(4).toString('hex')}.tmp`)
  const totalBytes = sizeMb * 1024 * 1024

  busy = true
  cancelled = false
  /** @type {fsp.FileHandle | null} */
  let handle = null
  try {
    // 每次重新產生亂數：全 0 的緩衝在有壓縮的 SSD 上會量出假的高速
    const chunk = crypto.randomBytes(CHUNK_BYTES)

    // ── 寫入 ──────────────────────────────────────────────────────
    handle = await fsp.open(target, 'w')
    let written = 0
    const writeStart = process.hrtime.bigint()
    while (written < totalBytes && !cancelled) {
      const size = Math.min(CHUNK_BYTES, totalBytes - written)
      await handle.write(chunk, 0, size)
      written += size
      const elapsed = Number(process.hrtime.bigint() - writeStart) / 1e9
      onProgress({
        phase: 'write',
        percent: Math.round((written / totalBytes) * 100),
        mbPerSec: elapsed > 0 ? (written / 1024 / 1024) / elapsed : 0
      })
    }
    // fsync 之前的數字只是「寫進快取多快」，不是磁碟多快
    await handle.sync()
    const writeSec = Number(process.hrtime.bigint() - writeStart) / 1e9
    await handle.close()
    handle = null
    if (cancelled) throw Object.assign(new Error('cancelled'), { userMessage: '磁碟測速已取消' })

    // ── 讀取 ──────────────────────────────────────────────────────
    handle = await fsp.open(target, 'r')
    const readBuf = Buffer.allocUnsafe(CHUNK_BYTES)
    let read = 0
    const readStart = process.hrtime.bigint()
    while (read < totalBytes && !cancelled) {
      const { bytesRead } = await handle.read(readBuf, 0, Math.min(CHUNK_BYTES, totalBytes - read), read)
      if (bytesRead <= 0) break
      read += bytesRead
      const elapsed = Number(process.hrtime.bigint() - readStart) / 1e9
      onProgress({
        phase: 'read',
        percent: Math.round((read / totalBytes) * 100),
        mbPerSec: elapsed > 0 ? (read / 1024 / 1024) / elapsed : 0
      })
    }
    const readSec = Number(process.hrtime.bigint() - readStart) / 1e9
    await handle.close()
    handle = null
    if (cancelled) throw Object.assign(new Error('cancelled'), { userMessage: '磁碟測速已取消' })

    return {
      sizeMb,
      writeMbPerSec: writeSec > 0 ? (written / 1024 / 1024) / writeSec : 0,
      readMbPerSec: readSec > 0 ? (read / 1024 / 1024) / readSec : 0,
      readCached: true
    }
  } finally {
    busy = false
    if (handle) { try { await handle.close() } catch { /* 已經關了 */ } }
    // 測試檔一定要刪掉，中途取消或失敗也一樣——不然使用者磁碟就多一個 GB 的垃圾
    try { fs.unlinkSync(target) } catch { /* 檔案本來就沒建起來 */ }
  }
}

module.exports = { runDiskBench, cancelDiskBench, clampSizeMb, MIN_SIZE_MB, MAX_SIZE_MB, TEST_FILE }
