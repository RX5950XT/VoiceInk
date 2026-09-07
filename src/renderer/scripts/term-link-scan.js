/**
 * 終端機連結的「掃描」那半：純字串運算，不碰 DOM 也不碰 IPC，好單獨回歸。
 *
 * xterm 的一列畫面可能是上一列折下來的，所以要先把整條邏輯行接起來再掃，
 * 之後才用「每一折剛好等於 cols 格」把字元位移換回 (row, col)。
 */

/** 一條邏輯行最多接幾折（超長輸出不值得為了畫底線整份掃過去） */
export const MAX_WRAP_ROWS = 50

const URL_RE = /\bhttps?:\/\/[^\s"'<>{}\\^|`]+/g
// 「含有斜線或反斜線的一團字」就當成路徑候選：存不存在交給主行程判斷，
// 這裡寧可寬鬆（`git status` 的 `modified:   src/a.js`、`ls` 的 `./b/` 都要接得住）。
const PATH_RE = /[^\s"'<>|*?`]*[\\/][^\s"'<>|*?`]*/g
const TRIM_HEAD = /^[('"[{<]+/
const TRIM_TAIL = /[.,;:!?)\]}'"><]+$/
/** `foo.js:12:5` 這種行號後綴不是路徑的一部分 */
const LINE_COL = /(?::\d+){1,2}$/

/**
 * 剝掉前後的標點，回傳修剪後的位移。整段都是標點就回 null。
 * @param {string} raw
 * @param {number} index
 * @returns {{ start: number, end: number, text: string } | null}
 */
function trimToken(raw, index) {
  const head = raw.match(TRIM_HEAD)?.[0].length ?? 0
  const body = raw.slice(head).replace(TRIM_TAIL, '')
  if (!body) return null
  return { start: index + head, end: index + head + body.length, text: body }
}

/**
 * 掃一條邏輯行，回傳網址與路徑候選（位移相對這條邏輯行的字元位置）。
 * `url` 有值＝網址，空字串＝路徑候選。
 * @param {string} line
 * @returns {Array<{ start: number, end: number, text: string, url: string }>}
 */
export function scanLine(line) {
  /** @type {Array<{ start: number, end: number, text: string, url: string }>} */
  const out = []
  for (const match of line.matchAll(URL_RE)) {
    const token = trimToken(match[0], match.index)
    if (token) out.push({ ...token, url: token.text })
  }
  for (const match of line.matchAll(PATH_RE)) {
    const token = trimToken(match[0], match.index)
    if (!token) continue
    // 網址裡的斜線不要再被當成路徑（`https://a/b` 會整段命中 PATH_RE）
    if (out.some((hit) => token.start < hit.end && hit.start < token.end)) continue
    const text = token.text.replace(LINE_COL, '')
    if (!text || !/[\\/]/.test(text) || /^[\\/]+$/.test(text)) continue
    out.push({ ...token, text, url: '' })
  }
  return out
}

/**
 * 把某一列所屬的整條邏輯行（含折行）接起來。
 * 除了最後一折，每折都保留右邊的空白：位移要跟 cols 對得上才算得回欄位。
 * @param {{ getLine: (i: number) => ({ isWrapped: boolean, translateToString: (trim: boolean) => string } | undefined) }} buf
 * @param {number} lineNumber 1-based 的緩衝區列號
 * @returns {{ startY: number, text: string } | null}
 */
export function logicalLine(buf, lineNumber) {
  const index = lineNumber - 1
  if (index < 0 || !buf.getLine(index)) return null
  let start = index
  while (start > 0 && index - start < MAX_WRAP_ROWS && buf.getLine(start)?.isWrapped) start -= 1
  let end = index
  while (end - start < MAX_WRAP_ROWS && buf.getLine(end + 1)?.isWrapped) end += 1
  const parts = []
  for (let i = start; i <= end; i += 1) parts.push(buf.getLine(i).translateToString(i === end))
  return { startY: start + 1, text: parts.join('') }
}
