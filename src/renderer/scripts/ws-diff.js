/**
 * 工作區 Git Diff 檢視模組
 *
 * 解析並渲染 Unified Diff，提供語法高亮行、增減統計徽章、
 * 暫存/取消暫存動作以及跳轉至編輯器。
 */

/**
 * @typedef {{
 *   oldLine: number | null,
 *   newLine: number | null,
 *   type: 'add' | 'del' | 'hunk' | 'ctx' | 'meta',
 *   text: string
 * }} DiffLine
 */

/**
 * 解析 unified diff 字串為結構化行
 * @param {string} raw
 * @returns {DiffLine[]}
 */
export function parseUnifiedDiff(raw) {
  if (!raw || !raw.trim()) return []
  const lines = raw.split('\n')
  const result = []

  let oldNum = 0
  let newNum = 0

  for (const line of lines) {
    if (line.startsWith('@@')) {
      // @@ -a,b +c,d @@ 或 @@ -a +c @@
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (match) {
        oldNum = parseInt(match[1], 10)
        newNum = parseInt(match[2], 10)
      }
      result.push({
        oldLine: null,
        newLine: null,
        type: 'hunk',
        text: line
      })
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      result.push({
        oldLine: null,
        newLine: newNum,
        type: 'add',
        text: line
      })
      newNum += 1
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      result.push({
        oldLine: oldNum,
        newLine: null,
        type: 'del',
        text: line
      })
      oldNum += 1
    } else if (line.startsWith(' ') || line === '') {
      result.push({
        oldLine: oldNum,
        newLine: newNum,
        type: 'ctx',
        text: line
      })
      oldNum += 1
      newNum += 1
    } else {
      // Diff metadata headers (diff --git, index, ---, +++)
      result.push({
        oldLine: null,
        newLine: null,
        type: 'meta',
        text: line
      })
    }
  }

  return result
}

/**
 * 渲染 Diff 內容至 DOM 容器
 * @param {HTMLElement} host
 * @param {DiffLine[]} lines
 */
export function renderDiffLines(host, lines) {
  host.replaceChildren()
  if (!lines.length) {
    const empty = document.createElement('div')
    empty.className = 'ws-diff-empty'
    empty.textContent = '沒有差異'
    host.appendChild(empty)
    return
  }

  const table = document.createElement('div')
  table.className = 'ws-diff-table'

  for (const item of lines) {
    // 忽略非必要的 git 前置 meta 行，保持畫面如 Orca 般清爽
    if (item.type === 'meta' && (item.text.startsWith('diff --git') || item.text.startsWith('index '))) {
      continue
    }

    const row = document.createElement('div')
    const lineClass = item.type === 'add'
      ? 'ws-diff-line-add'
      : item.type === 'del'
        ? 'ws-diff-line-del'
        : item.type === 'hunk'
          ? 'ws-diff-hunk'
          : ''
    row.className = `ws-diff-line${lineClass ? ` ${lineClass}` : ''}`

    const oldCol = document.createElement('span')
    oldCol.className = 'ws-diff-num ws-diff-num-old'
    oldCol.textContent = item.oldLine !== null ? String(item.oldLine) : ''

    const newCol = document.createElement('span')
    newCol.className = 'ws-diff-num ws-diff-num-new'
    newCol.textContent = item.newLine !== null ? String(item.newLine) : ''

    const textCol = document.createElement('span')
    textCol.className = 'ws-diff-content'
    textCol.textContent = item.text

    row.append(oldCol, newCol, textCol)
    table.appendChild(row)
  }

  host.appendChild(table)
}
