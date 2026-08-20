/**
 * VoiceInk - 最小安全 Markdown 渲染器
 *
 * 只用 createElement / createTextNode / textContent，**全程零 innerHTML**
 * → 任何模型輸出（含 <script>、onerror=）都只會變成文字節點，XSS 先天不可能。
 *
 * 支援：圍欄碼塊、標題、清單、引用、表格、分隔線、段落；
 *       行內 code / 粗體 / 斜體 / 刪除線 / 連結（僅 http(s)、mailto）。
 * 不支援（原樣輸出，不壞版）：巢狀清單、內嵌 HTML、reference link、腳註。
 */

/** 允許建成 <a> 的協定 */
const SAFE_PROTO = /^(?:https?:|mailto:)/i

/** 引用遞迴上限，防惡意深度 */
const MAX_DEPTH = 3

const RE_FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/
const RE_HEADING = /^ {0,3}(#{1,6})\s+(.*)$/
const RE_HR = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/
const RE_QUOTE = /^ {0,3}>\s?/
const RE_BULLET = /^ {0,3}[-*+]\s+(.*)$/
const RE_ORDERED = /^ {0,3}(\d{1,9})[.)]\s+(.*)$/
const RE_TABLE_SEP = /^ {0,3}\|?(?:\s*:?-+:?\s*\|)+\s*:?-*:?\s*\|?\s*$/

/**
 * 行內語法來源。renderInline 會遞迴，**不可共用同一個 g-regex 實例**
 * （子呼叫重置 lastIndex → 外層迴圈從頭再跑 → 無限迴圈）。每次呼叫另建。
 */
const INLINE_SRC = [
  '`([^`\\n]+)`', // 1 行內碼
  '\\[([^\\]\\n]*)\\]\\(\\s*([^)\\s]+)\\s*\\)', // 2 文字 3 URL
  // 標記內側不得為空白，否則 `2 * 3 * 4`、`a ** b` 會被當成強調
  '\\*\\*(?!\\s)([^\\n]+?)(?<!\\s)\\*\\*', // 4 粗體
  '(?<!\\w)__(?!\\s)([^\\n]+?)(?<!\\s)__(?!\\w)', // 5 粗體
  '~~(?!\\s)([^\\n]+?)(?<!\\s)~~', // 6 刪除線
  '(?<![\\w*])\\*(?!\\s)([^*\\n]+?)(?<!\\s)\\*(?![\\w*])', // 7 斜體
  '(?<![\\w_])_(?!\\s)([^_\\n]+?)(?<!\\s)_(?![\\w_])' // 8 斜體
].join('|')

/**
 * @param {string} tag
 * @param {string} [className]
 * @returns {HTMLElement}
 */
function el(tag, className) {
  const node = document.createElement(tag)
  if (className) node.className = className
  return node
}

/**
 * 純文字寫入（\n → <br>）
 * @param {Node} parent
 * @param {string} text
 */
function appendText(parent, text) {
  const parts = text.split('\n')
  parts.forEach((part, idx) => {
    if (idx > 0) parent.appendChild(el('br'))
    if (part) parent.appendChild(document.createTextNode(part))
  })
}

/**
 * 行內語法 → DOM
 * @param {Node} parent
 * @param {string} text
 */
function renderInline(parent, text) {
  const re = new RegExp(INLINE_SRC, 'g')
  let last = 0
  let m
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) appendText(parent, text.slice(last, m.index))
    last = re.lastIndex
    if (m[1] !== undefined) {
      const code = el('code', 'md-inline-code')
      code.textContent = m[1]
      parent.appendChild(code)
    } else if (m[3] !== undefined) {
      appendLink(parent, m[2], m[3])
    } else if (m[4] !== undefined || m[5] !== undefined) {
      const strong = el('strong')
      renderInline(strong, m[4] ?? m[5])
      parent.appendChild(strong)
    } else if (m[6] !== undefined) {
      const del = el('del')
      renderInline(del, m[6])
      parent.appendChild(del)
    } else {
      const em = el('em')
      renderInline(em, m[7] ?? m[8])
      parent.appendChild(em)
    }
  }
  if (last < text.length) appendText(parent, text.slice(last))
}

/**
 * 連結：協定不在白名單就降級成純文字（不建 <a>）
 * @param {Node} parent
 * @param {string} label
 * @param {string} url
 */
function appendLink(parent, label, url) {
  if (!SAFE_PROTO.test(url)) {
    appendText(parent, `[${label}](${url})`)
    return
  }
  const a = el('a', 'md-link')
  a.setAttribute('href', url)
  a.setAttribute('target', '_blank')
  a.setAttribute('rel', 'noopener noreferrer')
  renderInline(a, label || url)
  parent.appendChild(a)
}

/**
 * 圍欄碼塊；未封閉（串流中）也照樣輸出，額外標記 md-code-open
 * @returns {number} 下一行索引；非碼塊回 -1
 */
function tryFence(lines, i, out) {
  const m = RE_FENCE.exec(lines[i])
  if (!m) return -1
  const close = new RegExp(`^ {0,3}\\${m[1][0]}{${m[1].length},}\\s*$`)
  const body = []
  let j = i + 1
  let closed = false
  for (; j < lines.length; j++) {
    if (close.test(lines[j])) {
      closed = true
      break
    }
    body.push(lines[j])
  }
  const box = el('div', closed ? 'md-code' : 'md-code md-code-open')
  const head = el('div', 'md-code-head')
  const lang = el('span', 'md-code-lang')
  lang.textContent = m[2] || 'text'
  const copy = el('button', 'md-copy')
  copy.setAttribute('type', 'button')
  copy.textContent = '複製'
  head.appendChild(lang)
  head.appendChild(copy)
  const pre = el('pre', 'md-pre')
  const code = el('code')
  code.textContent = body.join('\n')
  pre.appendChild(code)
  box.appendChild(head)
  box.appendChild(pre)
  out.appendChild(box)
  return closed ? j + 1 : j
}

function tryHeading(lines, i, out) {
  const m = RE_HEADING.exec(lines[i])
  if (!m) return -1
  const h = el(`h${m[1].length}`, 'md-h')
  renderInline(h, m[2].replace(/\s+#+\s*$/, ''))
  out.appendChild(h)
  return i + 1
}

function tryHr(lines, i, out) {
  if (!RE_HR.test(lines[i])) return -1
  out.appendChild(el('hr', 'md-hr'))
  return i + 1
}

function tryQuote(lines, i, out, depth) {
  if (!RE_QUOTE.test(lines[i])) return -1
  const inner = []
  let j = i
  for (; j < lines.length && RE_QUOTE.test(lines[j]); j++) {
    inner.push(lines[j].replace(RE_QUOTE, ''))
  }
  const quote = el('blockquote', 'md-quote')
  if (depth < MAX_DEPTH) {
    quote.appendChild(renderMarkdown(inner.join('\n'), depth + 1))
  } else {
    appendText(quote, inner.join('\n'))
  }
  out.appendChild(quote)
  return j
}

/** 不支援巢狀：縮排的標記視為同層 */
function tryList(lines, i, out) {
  const ordered = RE_ORDERED.test(lines[i])
  if (!ordered && !RE_BULLET.test(lines[i])) return -1
  const list = el(ordered ? 'ol' : 'ul', 'md-list')
  if (ordered) list.setAttribute('start', RE_ORDERED.exec(lines[i])[1])
  const items = []
  let j = i
  for (; j < lines.length; j++) {
    const m = ordered ? RE_ORDERED.exec(lines[j]) : RE_BULLET.exec(lines[j])
    if (m) {
      items.push(ordered ? m[2] : m[1])
    } else if (items.length && lines[j].trim() && !isBlockStart(lines, j)) {
      items[items.length - 1] += `\n${lines[j].trim()}` // 續行
    } else {
      break
    }
  }
  for (const text of items) {
    const li = el('li')
    renderInline(li, text)
    list.appendChild(li)
  }
  out.appendChild(list)
  return j
}

function tryTable(lines, i, out) {
  if (i + 1 >= lines.length) return -1
  if (!lines[i].includes('|') || !lines[i + 1].includes('|')) return -1
  if (!RE_TABLE_SEP.test(lines[i + 1])) return -1
  const align = splitRow(lines[i + 1]).map(cellAlign)
  const table = el('table', 'md-table')
  const thead = el('thead')
  thead.appendChild(buildRow(splitRow(lines[i]), align, 'th'))
  table.appendChild(thead)
  const tbody = el('tbody')
  let j = i + 2
  for (; j < lines.length && lines[j].trim() && lines[j].includes('|'); j++) {
    tbody.appendChild(buildRow(splitRow(lines[j]), align, 'td'))
  }
  table.appendChild(tbody)
  const wrap = el('div', 'md-table-wrap')
  wrap.appendChild(table)
  out.appendChild(wrap)
  return j
}

function splitRow(line) {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((c) => c.trim())
}

function cellAlign(cell) {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':')
  if (left && right) return 'md-center'
  if (right) return 'md-right'
  return ''
}

function buildRow(cells, align, tag) {
  const tr = el('tr')
  cells.forEach((cell, idx) => {
    const td = el(tag, align[idx] || '')
    renderInline(td, cell)
    tr.appendChild(td)
  })
  return tr
}

function isBlockStart(lines, i) {
  const line = lines[i]
  return (
    RE_FENCE.test(line) ||
    RE_HEADING.test(line) ||
    RE_HR.test(line) ||
    RE_QUOTE.test(line) ||
    RE_BULLET.test(line) ||
    RE_ORDERED.test(line)
  )
}

/**
 * Markdown → DocumentFragment（零 innerHTML）
 * @param {string} text
 * @param {number} [depth] 內部遞迴用
 * @returns {DocumentFragment}
 */
export function renderMarkdown(text, depth = 0) {
  const out = document.createDocumentFragment()
  const lines = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
  let i = 0
  while (i < lines.length) {
    if (!lines[i].trim()) {
      i++
      continue
    }
    let next = -1
    for (const handler of [tryFence, tryHeading, tryHr, tryQuote, tryList, tryTable]) {
      next = handler(lines, i, out, depth)
      if (next >= 0) break
    }
    if (next >= 0) {
      i = next
      continue
    }
    // 段落：吃到空行或下一個區塊為止
    const buf = []
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines, i)) {
      buf.push(lines[i])
      i++
    }
    const p = el('p', 'md-p')
    renderInline(p, buf.join('\n'))
    out.appendChild(p)
  }
  return out
}
