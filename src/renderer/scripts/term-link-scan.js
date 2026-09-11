/**
 * 終端機連結的「掃描」那半：純字串運算，不碰 DOM 也不碰 IPC，好單獨回歸。
 *
 * xterm 的一列畫面可能是上一列折下來的，所以要先把整條邏輯行接起來再掃。
 * 回去的 range 是 cell 欄位：CJK／emoji 一格佔兩欄，不能用字元位移 % cols。
 */

/** 一條邏輯行最多接幾折（超長輸出不值得為了畫底線整份掃過去） */
export const MAX_WRAP_ROWS = 50

// 全形／CJK 標點與表意文字：網址裡幾乎不會出現，黏在前後就是無關的字。
const CJK = '\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF'
const URL_RE = new RegExp(`\\bhttps?:\\/\\/[^\\s"'<>{}\\\\^|\`${CJK}]+`, 'g')
// 空白、引號、萬用字元，再加上會黏在路徑前後的括號／等號／逗號、
// 全形標點與盒線（樹狀輸出 `├──src/foo`）。中文檔名本身要留著，不放進這組。
const PATH_STOP = `\\s"'<>|*?\`()\\[\\]{}=,;\\u3000-\\u303F\\u2500-\\u257F\\uFF00-\\uFFEF`
const PATH_RE = new RegExp(`[^${PATH_STOP}]*[\\\\/][^${PATH_STOP}]*`, 'g')
const TRIM_HEAD = /^[('"[{<（【「『《]+/
const TRIM_TAIL = /[.,;:!?)\]}'"><）】」』》]+$/
/** `foo.js:12:5` 這種行號後綴不是路徑的一部分 */
const LINE_COL = /(?::\d+){1,2}$/

/**
 * @param {string} ch
 */
function isCjkLetter(ch) {
  if (!ch) return false
  const c = ch.charCodeAt(0)
  return (c >= 0x3040 && c <= 0x30FF)
    || (c >= 0x3400 && c <= 0x4DBF)
    || (c >= 0x4E00 && c <= 0x9FFF)
    || (c >= 0xAC00 && c <= 0xD7AF)
    || (c >= 0xF900 && c <= 0xFAFF)
}

/**
 * @param {string} ch
 */
function isAsciiPathChar(ch) {
  return !!ch && /[A-Za-z0-9._~]/.test(ch)
}

/**
 * 剝掉前後的標點，回傳修剪後的位移。整段都是標點就回 null。
 * @param {string} raw
 * @param {number} index
 * @returns {{ start: number, end: number, text: string } | null}
 */
function trimPunct(raw, index) {
  const head = raw.match(TRIM_HEAD)?.[0].length ?? 0
  const body = raw.slice(head).replace(TRIM_TAIL, '')
  if (!body) return null
  return { start: index + head, end: index + head + body.length, text: body }
}

/**
 * 路徑還要再剝兩層：黏在 ASCII 路徑前後的中文，以及 `error:C:\foo` 這種前綴。
 * @param {string} raw
 * @param {number} index
 * @returns {{ start: number, end: number, text: string } | null}
 */
function trimPath(raw, index) {
  const token = trimPunct(raw, index)
  if (!token) return null
  let { start, text } = token
  const drive = text.search(/[A-Za-z]:[\\/]/)
  if (drive > 0) {
    start += drive
    text = text.slice(drive)
  }
  let i = 0
  while (i < text.length && isCjkLetter(text[i])) i += 1
  if (i > 0 && i < text.length && isAsciiPathChar(text[i])) {
    start += i
    text = text.slice(i)
  }
  let j = text.length
  while (j > 0 && isCjkLetter(text[j - 1])) j -= 1
  if (j < text.length && j > 0 && isAsciiPathChar(text[j - 1])) text = text.slice(0, j)
  if (!text) return null
  return { start, end: start + text.length, text }
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
    const token = trimPunct(match[0], match.index)
    if (token) out.push({ ...token, url: token.text })
  }
  for (const match of line.matchAll(PATH_RE)) {
    const token = trimPath(match[0], match.index)
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
 * @param {{ getChars?: () => string, getWidth?: () => number, chars?: string, width?: number }} cell
 */
function cellChars(cell) {
  if (typeof cell.getChars === 'function') return cell.getChars()
  return cell.chars || ''
}

/**
 * @param {{ getChars?: () => string, getWidth?: () => number, chars?: string, width?: number }} cell
 */
function cellWidth(cell) {
  if (typeof cell.getWidth === 'function') return cell.getWidth()
  return Number(cell.width) || 1
}

/**
 * @param {{ length?: number, getCell?: (x: number) => ({ getChars?: () => string, getWidth?: () => number, chars?: string, width?: number } | undefined), translateToString: (trim: boolean) => string }} line
 * @param {number} y 1-based
 * @param {boolean} trim
 * @param {Array<{ x: number, y: number, width: number }>} map
 */
function appendRow(line, y, trim, map) {
  if (typeof line.getCell !== 'function' || !line.length) {
    const chunk = line.translateToString(trim)
    for (let k = 0; k < chunk.length; k += 1) map.push({ x: k + 1, y, width: 1 })
    return chunk
  }
  let text = ''
  let col = 0
  let kept = map.length
  while (col < line.length) {
    const cell = line.getCell(col)
    if (!cell) break
    const width = cellWidth(cell)
    if (width === 0) { col += 1; continue }
    const chars = cellChars(cell)
    const chunk = chars || ' '
    const w = width || 1
    for (let k = 0; k < chunk.length; k += 1) map.push({ x: col + 1, y, width: w })
    text += chunk
    if (chars) kept = map.length
    col += w
  }
  if (!trim) return text
  map.length = kept
  return text.slice(0, kept)
}

/**
 * 把某一列所屬的整條邏輯行（含折行）接起來，並記住每個字元落在哪一格。
 * 有 `getCell` 就逐格對（寬字元佔兩欄）；測試用的假 buffer 沒有就退回 1 字 = 1 欄。
 * @param {{ getLine: (i: number) => ({ isWrapped: boolean, length?: number, getCell?: (x: number) => ({ getChars?: () => string, getWidth?: () => number, chars?: string, width?: number } | undefined), translateToString: (trim: boolean) => string } | undefined) }} buf
 * @param {number} lineNumber 1-based 的緩衝區列號
 * @returns {{ startY: number, text: string, at: (offset: number) => { x: number, y: number }, endAt: (offset: number) => { x: number, y: number } } | null}
 */
export function logicalLine(buf, lineNumber) {
  const index = lineNumber - 1
  if (index < 0 || !buf.getLine(index)) return null
  let start = index
  while (start > 0 && index - start < MAX_WRAP_ROWS && buf.getLine(start)?.isWrapped) start -= 1
  let end = index
  while (end - start < MAX_WRAP_ROWS && buf.getLine(end + 1)?.isWrapped) end += 1

  let text = ''
  /** @type {Array<{ x: number, y: number, width: number }>} */
  const map = []
  for (let i = start; i <= end; i += 1) text += appendRow(buf.getLine(i), i + 1, i === end, map)

  const startY = start + 1
  /** @param {number} offset */
  const pick = (offset) => {
    if (!map.length) return { x: 1, y: startY, width: 1 }
    if (offset < 0) return map[0]
    if (offset >= map.length) return map[map.length - 1]
    return map[offset]
  }
  return {
    startY,
    text,
    at: (offset) => { const p = pick(offset); return { x: p.x, y: p.y } },
    endAt: (offset) => { const p = pick(offset); return { x: p.x + p.width - 1, y: p.y } }
  }
}
