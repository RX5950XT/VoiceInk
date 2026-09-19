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
const URL_BODY = `[^\\s"'<>{}\\\\^|\`${CJK}]+`
const URL_RE = new RegExp(`\\bhttps?:\\/\\/${URL_BODY}`, 'gi')
const FILE_RE = new RegExp(`\\bfile:\\/\\/${URL_BODY}`, 'gi')
const WWW_RE = new RegExp(`\\bwww\\.${URL_BODY}`, 'gi')
const LOCAL_RE = /\b(?:localhost|127\.0\.0\.1):\d{2,5}(?:\/[^\s"'<>{}\\^|`]*)?/gi
const CONT_HEAD = /^[A-Za-z0-9._~%+\-@]/
// 空白、引號、萬用字元，再加上會黏在路徑前後的括號／等號／逗號、
// 全形標點與盒線（樹狀輸出 `├──src/foo`）。中文檔名本身要留著，不放進這組。
const PATH_STOP = `\\s"'<>|*?\`()\\[\\]{}=,;\\u3000-\\u303F\\u2500-\\u257F\\uFF00-\\uFFEF`
const PATH_RE = new RegExp(`[^${PATH_STOP}]*[\\\\/][^${PATH_STOP}]*`, 'g')
const TRIM_HEAD = /^[('"[{<（【「『《]+/
const TRIM_TAIL = /[.,;:!?)\]}'"><）】」』》]+$/
/** `foo.js:12:5` 這種行號後綴不是路徑的一部分 */
const LINE_COL = /:(\d+)(?::\d+)?$/

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
 * `file:///C:/foo` → `C:/foo`。失敗回空字串。
 * @param {string} url
 */
function fileToPath(url) {
  let rest = url.replace(/^file:\/\//i, '')
  rest = rest.replace(/^localhost/i, '')
  if (rest.startsWith('/') && /^\/[A-Za-z]:/.test(rest)) rest = rest.slice(1)
  try { rest = decodeURIComponent(rest) } catch { /* 解不開就用原樣 */ }
  return rest
}

/**
 * @param {Array<{ start: number, end: number }>} out
 * @param {{ start: number, end: number }} token
 */
function overlaps(out, token) {
  return out.some((hit) => token.start < hit.end && hit.start < token.end)
}

/**
 * 掃一條邏輯行，回傳網址與路徑候選（位移相對這條邏輯行的字元位置）。
 * `url` 有值＝網址，空字串＝路徑候選。`line` 是 `file.js:12` 那種行號。
 * @param {string} line
 * @returns {Array<{ start: number, end: number, text: string, url: string, line: number }>}
 */
export function scanLine(line) {
  /** @type {Array<{ start: number, end: number, text: string, url: string, line: number }>} */
  const out = []
  for (const match of line.matchAll(URL_RE)) {
    const token = trimPunct(match[0], match.index)
    if (token) out.push({ ...token, url: token.text, line: 0 })
  }
  for (const match of line.matchAll(FILE_RE)) {
    const token = trimPunct(match[0], match.index)
    if (!token || overlaps(out, token)) continue
    const text = fileToPath(token.text)
    if (text) out.push({ ...token, text, url: '', line: 0 })
  }
  for (const match of line.matchAll(WWW_RE)) {
    const token = trimPunct(match[0], match.index)
    if (token && !overlaps(out, token)) out.push({ ...token, url: `https://${token.text}`, line: 0 })
  }
  for (const match of line.matchAll(LOCAL_RE)) {
    const token = trimPunct(match[0], match.index)
    if (token && !overlaps(out, token)) out.push({ ...token, url: `http://${token.text}`, line: 0 })
  }
  for (const match of line.matchAll(PATH_RE)) {
    const token = trimPath(match[0], match.index)
    if (!token || overlaps(out, token)) continue
    const col = token.text.match(LINE_COL)
    const text = col ? token.text.slice(0, col.index) : token.text
    if (!text || !/[\\/]/.test(text) || /^[\\/]+$/.test(text)) continue
    out.push({ ...token, text, url: '', line: col ? Number(col[1]) : 0 })
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
 * CLI 自己印了換行（沒設 isWrapped）時，斜線結尾或剛好滿列的網址／路徑要接下一列。
 * @param {string} prev
 * @param {string} next
 * @param {number} cols
 */
function hardWrapCont(prev, next, cols) {
  const a = prev.replace(/\s+$/, '')
  const b = next.replace(/^\s+/, '')
  if (!a || !b) return false
  if (/^[A-Za-z]:[\\/]/.test(b) || /^https?:\/\//i.test(b) || /^file:/i.test(b)) return false
  if (!/[\\/]|https?:\/\//i.test(a)) return false
  if (/[\\/]$/.test(a) && CONT_HEAD.test(b)) return true
  return Boolean(cols && a.length >= cols && /^[A-Za-z0-9._~/?#&=%+\-\\]/.test(b))
}

/**
 * @param {{ translateToString: (trim: boolean) => string }} line
 * @param {boolean} trim
 */
function rowText(line, trim) {
  return line.translateToString(trim)
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
  const cols = buf.getLine(start)?.length || 0
  while (start > 0 && end - (start - 1) <= MAX_WRAP_ROWS) {
    const prev = buf.getLine(start - 1)
    const cur = buf.getLine(start)
    if (!prev || !cur || prev.isWrapped) break
    if (!hardWrapCont(rowText(prev, false), rowText(cur, true), cols)) break
    start -= 1
  }
  while (end - start < MAX_WRAP_ROWS) {
    const cur = buf.getLine(end)
    const next = buf.getLine(end + 1)
    if (!cur || !next || next.isWrapped) break
    if (!hardWrapCont(rowText(cur, false), rowText(next, true), cols)) break
    end += 1
  }

  let text = ''
  /** @type {Array<{ x: number, y: number, width: number }>} */
  const map = []
  for (let i = start; i <= end; i += 1) {
    const xtermCont = i < end && buf.getLine(i + 1)?.isWrapped
    text += appendRow(buf.getLine(i), i + 1, !xtermCont, map)
  }

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
