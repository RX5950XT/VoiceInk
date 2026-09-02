'use strict'

/**
 * 八組模組 ipc.js 的共用外殼：只有主視窗能呼叫，回傳一律 `{ ok, data }` / `{ ok, error }`。
 *
 * 收掉的只是那段八份一字不差的 try/catch——**每組 IPC 仍然要逐一列舉自己的 handler**
 * （service 加了方法卻在 ipc.js 漏一行，renderer 只會拿到通用訊息，那個坑照舊存在）。
 *
 * 錯誤訊息走 `userMessage` 白名單：只有我們自己建構、內容固定的錯誤才准原樣送出去，
 * 其餘一律換成 `message`，免得檔案路徑或上游 body 被原樣送到 renderer。
 * 要換一套收斂規則就傳 `publicError`（usage 與 hfmodels 各有自己的一套）。
 *
 * @param {{
 *   isMainSender: (event: any) => boolean,
 *   forbidden: string,
 *   code?: string,
 *   message?: string,
 *   publicError?: (error: any) => { code: string, message: string }
 * }} options
 * @returns {(event: any, action: () => any) => Promise<{ ok: true, data: any } | { ok: false, error: { code: string, message: string } }>}
 */
function makeInvoke({ isMainSender, forbidden, code = 'IPC_ERROR', message = '操作失敗', publicError }) {
  return async (event, action) => {
    if (!isMainSender(event)) {
      return { ok: false, error: { code: 'FORBIDDEN', message: forbidden } }
    }
    try {
      return { ok: true, data: await action() }
    } catch (error) {
      if (publicError) return { ok: false, error: publicError(error) }
      return {
        ok: false,
        error: { code: error?.code || code, message: error?.userMessage || message }
      }
    }
  }
}

module.exports = { makeInvoke }
