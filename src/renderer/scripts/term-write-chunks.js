/**
 * 送進 PTY 的內容切段（純字串，沒有 DOM 也沒有 IPC，好測）。
 *
 * main 單次只收 `pty.MAX_WRITE_CHARS`（8192）個字，**超過的部分是直接 slice 掉的，
 * 而且不會有任何訊息**——貼一段長文字進 AI CLI 就這樣被截半。這裡先切好，
 * 呼叫端照順序送出去。
 */

/** 跟 main 的 `pty.MAX_WRITE_CHARS` 同一個數字 */
export const MAX_WRITE_CHARS = 8192

/**
 * @param {string} data
 * @param {number} [max]
 * @returns {string[]} 照順序接回去會等於原字串
 */
export function splitForPty(data, max = MAX_WRITE_CHARS) {
  const text = String(data || '')
  if (!text) return []
  if (text.length <= max) return [text]
  const out = []
  for (let at = 0; at < text.length;) {
    let end = Math.min(at + max, text.length)
    // 不要把一組代理對（emoji、罕用字）從中間剖開：切成兩半再送出去，
    // 兩邊都是無效的半個字元，對面收到的是亂碼
    const code = text.charCodeAt(end - 1)
    if (end < text.length && code >= 0xd800 && code <= 0xdbff) end -= 1
    out.push(text.slice(at, end))
    at = end
  }
  return out
}
