'use strict'

/**
 * 下載一顆模型（多 GB、可能好幾片）。
 *
 * 三件事是這裡的重點，其餘一律從簡：
 *   1. **續傳**：寫進 `<檔名>.part`，中斷後帶 `Range` 從斷點接。多 GB 的東西斷一次就重來，
 *      使用者只會覺得這個功能不能用。上游不支援 Range（回 200 不是 206）就從頭來，不硬接。
 *   2. **大小要對得上**：截斷的 gguf 不會在下載時報錯，只會在**載入時**變成一句看不懂的錯誤。
 *      HF 的 tree 端點給得出每個檔案的真實大小，收完比一次。
 *   3. **取消要真的停**：`AbortController` 一路傳到 fetch，`.part` 留著給下次續傳。
 *
 * ponytail: 只比大小不驗雜湊。HF 的 `lfs.oid` 就是內容的 sha256，真的遇到「大小對但內容壞」
 * 再把它接上（成本是整顆檔案再讀一遍）。
 */

const fs = require('fs')
const path = require('path')

const TIMEOUT_MS = 60_000
/** 進度回報節流：多 GB 的下載每個 chunk 都送一次等於在洗 IPC */
const PROGRESS_INTERVAL_MS = 250

/**
 * @param {string} filePath
 * @returns {number}
 */
function sizeOf(filePath) {
  try {
    return fs.statSync(filePath).size
  } catch {
    return 0
  }
}

/**
 * 下載單一檔案（支援續傳）
 *
 * @param {{
 *   url: string, dest: string, expectedBytes?: number,
 *   headers?: Record<string, string>, signal?: AbortSignal,
 *   onProgress?: (info: { received: number, total: number }) => void,
 *   fetchImpl?: typeof fetch
 * }} options
 * @returns {Promise<{ bytes: number, resumed: boolean }>}
 */
async function downloadFile(options) {
  const { url, dest } = options
  if (typeof url !== 'string' || !url.startsWith('https://')) {
    throw new Error('下載網址不正確')
  }
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const part = `${dest}.part`
  fs.mkdirSync(path.dirname(dest), { recursive: true })

  let already = sizeOf(part)
  const expected = Number(options.expectedBytes) || 0
  if (expected && already > expected) {
    // 上次寫壞了（或換了一版檔案），接下去只會拿到一個大小對不上的檔案
    fs.rmSync(part, { force: true })
    already = 0
  }
  if (expected && already === expected) {
    fs.renameSync(part, dest)
    return { bytes: already, resumed: true }
  }

  const headers = { ...(options.headers || {}) }
  if (already > 0) headers.range = `bytes=${already}-`

  // 逾時只管「連得上、開始吐資料」；下載本體有多久算多久，不能用一個 timeout 砍掉長連線
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (options.signal) {
    if (options.signal.aborted) throw new Error('下載已取消')
    options.signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  let response
  try {
    response = await fetchImpl(url, { headers, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
  if (!response?.ok) {
    options.signal?.removeEventListener('abort', onAbort)
    throw new Error(`下載失敗（HTTP ${Number(response?.status) || 0}）`)
  }

  // 要了 Range 卻回 200 → 上游不支援續傳，這一份是從頭開始的整包
  let resumed = already > 0 && response.status === 206
  if (already > 0 && response.status !== 206) {
    fs.rmSync(part, { force: true })
    already = 0
    resumed = false
  }

  const total = expected
    || (Number(response.headers?.get?.('content-length')) || 0) + already
  const stream = fs.createWriteStream(part, { flags: already > 0 ? 'a' : 'w' })
  let received = already
  let lastReport = 0

  try {
    for await (const chunk of response.body) {
      if (!stream.write(Buffer.from(chunk))) {
        await new Promise((resolve) => stream.once('drain', resolve))
      }
      received += chunk.length
      const now = Date.now()
      if (options.onProgress && now - lastReport >= PROGRESS_INTERVAL_MS) {
        lastReport = now
        options.onProgress({ received, total })
      }
    }
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
    await new Promise((resolve) => stream.end(resolve))
  }

  const finalBytes = sizeOf(part)
  if (expected && finalBytes !== expected) {
    // 留著 .part 讓下一次續傳；直接刪掉等於每次網路抖一下就從頭來
    throw new Error(`下載沒有完成（拿到 ${finalBytes} / 應為 ${expected} 位元組）`)
  }
  fs.rmSync(dest, { force: true })
  fs.renameSync(part, dest)
  if (options.onProgress) options.onProgress({ received: finalBytes, total: finalBytes })
  return { bytes: finalBytes, resumed }
}

/**
 * 一個變體的所有檔案（分片 ＋ mmproj）逐一下載到同一個資料夾。
 *
 * **逐一、不併發**：多 GB 的檔案同時拉三份只會互相搶頻寬，而且進度條會變成一團看不懂的數字。
 *
 * @param {{
 *   files: Array<{ url: string, name: string, size?: number }>,
 *   dir: string, signal?: AbortSignal,
 *   headers?: Record<string, string>,
 *   onProgress?: (info: { received: number, total: number, fileIndex: number, fileCount: number, name: string }) => void,
 *   fetchImpl?: typeof fetch
 * }} options
 * @returns {Promise<{ bytes: number }>}
 */
async function downloadVariant(options) {
  const files = Array.isArray(options.files) ? options.files : []
  const totalBytes = files.reduce((sum, f) => sum + (Number(f.size) || 0), 0)
  let doneBytes = 0
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i]
    await downloadFile({
      url: file.url,
      dest: path.join(options.dir, file.name),
      expectedBytes: Number(file.size) || 0,
      headers: options.headers,
      signal: options.signal,
      fetchImpl: options.fetchImpl,
      onProgress: options.onProgress
        ? ({ received }) => options.onProgress({
          received: doneBytes + received,
          total: totalBytes,
          fileIndex: i,
          fileCount: files.length,
          name: file.name
        })
        : undefined
    })
    doneBytes += Number(file.size) || 0
  }
  return { bytes: doneBytes }
}

module.exports = { downloadFile, downloadVariant }
