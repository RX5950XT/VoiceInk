'use strict'

/**
 * 工作區的圖片／PDF／影音預覽走自訂協定 `vi-media://`，**邊讀邊送**。
 *
 * 以前是整份讀進來轉 base64 塞進 IPC（再變成 `data:` URI），記憶體是檔案的好幾倍，
 * 只能卡 2MB；影片也拖不了進度條。改成協定之後由 Chromium 自己發 Range 請求，
 * 幾 GB 的影片一樣只讀看得到的那一段。
 *
 * 安全：
 * - 網址的主機名是**每次啟動隨機產生的 token**，只透過主視窗的 `workspace:readFile` 發出去；
 *   內建瀏覽器（`<webview>`）裡的網頁猜不到它。
 * - 路徑一律經 `rootOf` ＋ `files.resolveIn`（跟讀檔同一個入口），只送媒體副檔名。
 */

const crypto = require('crypto')
const { Readable } = require('stream')
const rawFs = require('../raw-fs')
const files = require('./files')

const SCHEME = 'vi-media'
const TOKEN = crypto.randomBytes(16).toString('hex')

/** registerSchemesAsPrivileged 要的設定（必須在 app ready 之前註冊） */
const PRIVILEGES = { scheme: SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } }

/** pdf.js 是用 fetch 讀的（跨來源、帶 Range 標頭會先送 OPTIONS） */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges'
}

/**
 * 檔案總管的大預覽走這個假專案 id：後面接的是**絕對路徑**，由 `register` 收到的
 * `resolveLocal` 把關（檔案總管本來就讀得到那些路徑，這裡沒有放寬任何東西）。
 */
const LOCAL_ID = '~local'

/**
 * @param {string} projectId
 * @param {string} rel 專案內的相對路徑（`/` 分隔）
 */
function urlFor(projectId, rel) {
  const encoded = String(rel).split('/').map(encodeURIComponent).join('/')
  return `${SCHEME}://${TOKEN}/${encodeURIComponent(projectId)}/${encoded}`
}

/**
 * 檔案總管的大預覽網址。整條絕對路徑當成一段，所以反斜線、空白、中文都不會被切壞。
 * @param {string} full 本機絕對路徑
 */
function localUrlFor(full) {
  return `${SCHEME}://${TOKEN}/${LOCAL_ID}/${encodeURIComponent(String(full || ''))}`
}

/**
 * 解析 `Range: bytes=a-b`。只支援單一區段（瀏覽器的媒體與 pdf.js 都只送一段）。
 * @param {string | null} header
 * @param {number} size
 * @returns {{ start: number, end: number } | null | 'invalid'} null＝沒有要 Range
 */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim())
  if (!m || (!m[1] && !m[2])) return null
  let start
  let end
  if (m[1]) {
    start = Number(m[1])
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
  } else {
    start = Math.max(0, size - Number(m[2]))
    end = size - 1
  }
  if (start > end || start >= size) return 'invalid'
  return { start, end }
}

/**
 * @param {string} full 已經過 resolveIn 的絕對路徑
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function serve(full, request) {
  const stat = await rawFs.promises.stat(full)
  if (!stat.isFile()) return new Response(null, { status: 404 })
  const size = stat.size
  const headers = { ...CORS, 'Content-Type': files.mediaMime(full), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' }
  const range = parseRange(request.headers.get('range'), size)
  if (range === 'invalid') {
    return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } })
  }
  const { start, end } = range || { start: 0, end: size - 1 }
  headers['Content-Length'] = String(size ? end - start + 1 : 0)
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  const body = size ? Readable.toWeb(rawFs.createReadStream(full, { start, end })) : null
  return new Response(body, { status: range ? 206 : 200, headers })
}

/**
 * @param {Electron.Protocol} protocol
 * @param {(projectId: string) => Promise<string>} rootOf
 * @param {((full: string) => string) | undefined} [resolveLocal] 檔案總管的大預覽：
 *   把使用者給的絕對路徑驗過再回正規化的那一條（沒給就不開放 `~local`）
 */
function register(protocol, rootOf, resolveLocal) {
  protocol.handle(SCHEME, async (request) => {
    try {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
      const url = new URL(request.url)
      if (url.hostname !== TOKEN) return new Response(null, { status: 404 })
      const [projectId, ...segments] = url.pathname.slice(1).split('/').map(decodeURIComponent)
      // 檔案總管那一條：後面就是一整條絕對路徑，驗證交給呼叫端給的 `resolveLocal`
      if (projectId === LOCAL_ID) {
        if (typeof resolveLocal !== 'function') return new Response(null, { status: 404 })
        const target = resolveLocal(segments.join('/'))
        if (!files.mediaMime(target)) return new Response(null, { status: 404 })
        return await serve(target, request)
      }
      const root = await rootOf(projectId)
      const full = files.resolveIn(root, segments.join('/'))
      if (!files.mediaMime(full)) return new Response(null, { status: 404 })
      return await serve(full, request)
    } catch (error) {
      // 找不到專案／路徑越界／檔案不見都一樣回 404，不透露是哪一種
      console.warn('[workspace] 媒體預覽讀取失敗', error?.code || 'ERROR')
      return new Response(null, { status: 404 })
    }
  })
}

module.exports = { SCHEME, PRIVILEGES, LOCAL_ID, urlFor, localUrlFor, parseRange, register }
