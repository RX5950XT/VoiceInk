/**
 * 工作區 IDE 簡易編輯器輔助模組
 *
 * 提供行號欄同步、Tab 縮排/凸排、成對括號與引號自動補全、
 * 游標行列位置計算與底部狀態列即時更新。
 */

/**
 * 副檔名對應語言名稱
 * @type {Record<string, string>}
 */
const EXT_TO_LANG = {
  js: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  ts: 'TypeScript',
  mts: 'TypeScript',
  cts: 'TypeScript',
  jsx: 'React JSX',
  tsx: 'React TSX',
  html: 'HTML',
  htm: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  less: 'Less',
  json: 'JSON',
  jsonc: 'JSON with Comments',
  md: 'Markdown',
  markdown: 'Markdown',
  py: 'Python',
  rs: 'Rust',
  go: 'Go',
  c: 'C',
  cpp: 'C++',
  h: 'C Header',
  hpp: 'C++ Header',
  cs: 'C#',
  java: 'Java',
  kt: 'Kotlin',
  sql: 'SQL',
  sh: 'Shell Script',
  bash: 'Bash Script',
  ps1: 'PowerShell',
  bat: 'Batch',
  cmd: 'Batch',
  yaml: 'YAML',
  yml: 'YAML',
  toml: 'TOML',
  xml: 'XML',
  svg: 'SVG XML',
  env: 'Properties',
  ini: 'INI',
  dockerfile: 'Dockerfile'
}

/**
 * 取得檔案對應的語言標籤
 * @param {string} relPath
 * @returns {string}
 */
export function getLanguageName(relPath) {
  const name = String(relPath || '').split(/[\\/]/).pop() || ''
  if (name.toLowerCase() === 'dockerfile') return 'Dockerfile'
  const dot = name.lastIndexOf('.')
  if (dot < 0) return '純文字'
  const ext = name.slice(dot + 1).toLowerCase()
  return EXT_TO_LANG[ext] || ext.toUpperCase()
}

/**
 * 更新行號欄內容
 * @param {HTMLTextAreaElement} textarea
 * @param {HTMLElement} gutter
 */
export function updateGutter(textarea, gutter) {
  if (!textarea || !gutter) return
  const lineCount = (textarea.value.split('\n').length) || 1
  let numbers = ''
  for (let i = 1; i <= lineCount; i += 1) {
    numbers += `${i}\n`
  }
  gutter.textContent = numbers
  gutter.scrollTop = textarea.scrollTop
}

/**
 * 更新 IDE 底部狀態列
 * @param {object} params
 * @param {HTMLTextAreaElement} params.textarea
 * @param {string} params.relPath
 * @param {HTMLElement | null} params.cursorPosEl
 * @param {HTMLElement | null} params.selectionEl
 * @param {HTMLElement | null} params.fileInfoEl
 * @param {HTMLElement | null} params.encodingEl
 * @param {HTMLElement | null} params.langEl
 */
export function updateIdeStatus({
  textarea,
  relPath,
  cursorPosEl,
  selectionEl,
  fileInfoEl,
  encodingEl,
  langEl
}) {
  if (!textarea) return
  const value = textarea.value
  const start = textarea.selectionStart
  const end = textarea.selectionEnd

  const upToCursor = value.slice(0, start)
  const lines = upToCursor.split('\n')
  const line = lines.length
  const col = (lines[lines.length - 1]?.length || 0) + 1

  if (cursorPosEl) {
    cursorPosEl.textContent = `第 ${line} 行，第 ${col} 欄`
  }

  if (selectionEl) {
    const selectedLen = Math.abs(end - start)
    selectionEl.textContent = selectedLen > 0 ? `已選 ${selectedLen} 字元` : ''
  }

  if (fileInfoEl) {
    const totalLines = value.split('\n').length
    const bytes = new Blob([value]).size
    const sizeKb = (bytes / 1024).toFixed(1)
    fileInfoEl.textContent = `${totalLines} 行 (${sizeKb} KB)`
  }

  if (encodingEl) {
    encodingEl.textContent = 'UTF-8'
  }

  if (langEl) {
    langEl.textContent = getLanguageName(relPath)
  }
}

/**
 * 鍵盤增強：支援 Tab 縮排、成對符號補全與自動換行縮排
 * @param {KeyboardEvent} event
 * @param {HTMLTextAreaElement} textarea
 * @param {() => void} onDirty
 * @param {() => void} onSave
 */
export function handleEditorKeydown(event, textarea, onDirty, onSave, onFind) {
  if (!textarea || event.isComposing || event.keyCode === 229) return

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    onSave()
    return
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault()
    if (onFind) onFind(false)
    return
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'h') {
    event.preventDefault()
    if (onFind) onFind(true)
    return
  }

  if (textarea.readOnly || event.ctrlKey || event.metaKey || event.altKey) return

  const start = textarea.selectionStart
  const end = textarea.selectionEnd
  const value = textarea.value

  if (event.key === 'Tab') {
    event.preventDefault()
    handleTabIndent(event, textarea, onDirty)
    return
  }

  if (event.key === 'Enter') {
    event.preventDefault()
    handleEnterIndent(textarea, onDirty)
    return
  }

  const PAIRS = {
    '(': ')',
    '[': ']',
    '{': '}',
    '"': '"',
    "'": "'",
    '`': '`'
  }

  if (PAIRS[event.key]) {
    const closeChar = PAIRS[event.key]
    if (start !== end) {
      event.preventDefault()
      const selected = value.slice(start, end)
      textarea.setRangeText(`${event.key}${selected}${closeChar}`, start, end, 'select')
      textarea.setSelectionRange(start + 1, end + 1)
      onDirty()
      return
    }
    if (event.key === closeChar && value[start] === closeChar) {
      event.preventDefault()
      textarea.setSelectionRange(start + 1, start + 1)
      return
    }
    event.preventDefault()
    textarea.setRangeText(`${event.key}${closeChar}`, start, end, 'end')
    textarea.setSelectionRange(start + 1, start + 1)
    onDirty()
    return
  }

  if (event.key === 'Backspace' && start === end && start > 0) {
    const prev = value[start - 1]
    const next = value[start]
    if (
      (prev === '(' && next === ')') ||
      (prev === '[' && next === ']') ||
      (prev === '{' && next === '}') ||
      (prev === '"' && next === '"') ||
      (prev === "'" && next === "'") ||
      (prev === '`' && next === '`')
    ) {
      event.preventDefault()
      textarea.setRangeText('', start - 1, start + 1, 'end')
      textarea.setSelectionRange(start - 1, start - 1)
      onDirty()
    }
  }
}

/**
 * 處理 Tab 縮排
 * @param {KeyboardEvent} event
 * @param {HTMLTextAreaElement} textarea
 * @param {() => void} onDirty
 */
function handleTabIndent(event, textarea, onDirty) {
  const start = textarea.selectionStart
  const end = textarea.selectionEnd
  const value = textarea.value
  const indent = '  '

  if (start === end && !event.shiftKey) {
    textarea.setRangeText(indent, start, end, 'end')
    textarea.setSelectionRange(start + indent.length, start + indent.length)
    onDirty()
    return
  }

  const lineStart = value.lastIndexOf('\n', start - 1) + 1
  const lineEnd = value.indexOf('\n', end)
  const effectiveEnd = lineEnd === -1 ? value.length : lineEnd
  const block = value.slice(lineStart, effectiveEnd)
  const lines = block.split('\n')

  let newLines
  if (event.shiftKey) {
    newLines = lines.map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l.startsWith(' ') ? l.slice(1) : l))
  } else {
    newLines = lines.map((l) => indent + l)
  }

  const replacement = newLines.join('\n')
  textarea.setRangeText(replacement, lineStart, effectiveEnd, 'preserve')
  onDirty()
}

/**
 * 處理 Enter 自動縮排
 * @param {HTMLTextAreaElement} textarea
 * @param {() => void} onDirty
 */
function handleEnterIndent(textarea, onDirty) {
  const start = textarea.selectionStart
  const end = textarea.selectionEnd
  const value = textarea.value

  const lineStart = value.lastIndexOf('\n', start - 1) + 1
  const currentLine = value.slice(lineStart, start)
  const match = currentLine.match(/^\s*/)
  const indent = match ? match[0] : ''

  const trimmed = currentLine.trimEnd()
  const extraIndent = (trimmed.endsWith('{') || trimmed.endsWith('(') || trimmed.endsWith('[')) ? '  ' : ''

  const insertion = `\n${indent}${extraIndent}`
  textarea.setRangeText(insertion, start, end, 'end')
  textarea.setSelectionRange(start + insertion.length, start + insertion.length)
  onDirty()
}

/**
 * 初始化尋找與取代浮動元件
 * @param {object} params
 */
export function initFindWidget({
  textarea,
  widget,
  findInput,
  replaceInput,
  countEl,
  replaceRow,
  prevBtn,
  nextBtn,
  toggleReplaceBtn,
  closeBtn,
  replaceBtn,
  replaceAllBtn,
  onDirty
}) {
  if (!textarea || !widget || !findInput) return null

  let matches = []
  let currentIndex = -1

  function updateMatches() {
    const query = findInput.value
    matches = []
    if (!query) {
      if (countEl) countEl.textContent = '0/0'
      currentIndex = -1
      return
    }
    const text = textarea.value.toLowerCase()
    const q = query.toLowerCase()
    let pos = 0
    while ((pos = text.indexOf(q, pos)) !== -1) {
      matches.push(pos)
      pos += q.length
    }
    if (countEl) {
      countEl.textContent = matches.length ? `${currentIndex >= 0 ? currentIndex + 1 : 1}/${matches.length}` : '無匹配'
    }
  }

  function goToMatch(index) {
    if (!matches.length) return
    currentIndex = (index + matches.length) % matches.length
    const pos = matches[currentIndex]
    const len = findInput.value.length
    textarea.setSelectionRange(pos, pos + len)
    if (countEl) countEl.textContent = `${currentIndex + 1}/${matches.length}`
  }

  function openFind(withReplace = false) {
    widget.hidden = false
    if (replaceRow) replaceRow.hidden = !withReplace
    const selected = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)
    if (selected && !selected.includes('\n')) {
      findInput.value = selected
    }
    findInput.focus()
    findInput.select()
    updateMatches()
    if (matches.length) goToMatch(0)
  }

  function closeFind() {
    widget.hidden = true
    textarea.focus()
  }

  findInput.addEventListener('input', () => {
    updateMatches()
    if (matches.length) goToMatch(0)
  })

  findInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      event.shiftKey ? goToMatch(currentIndex - 1) : goToMatch(currentIndex + 1)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      closeFind()
    }
  })

  replaceInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      doReplace()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      closeFind()
    }
  })

  prevBtn?.addEventListener('click', () => goToMatch(currentIndex - 1))
  nextBtn?.addEventListener('click', () => goToMatch(currentIndex + 1))
  closeBtn?.addEventListener('click', closeFind)
  toggleReplaceBtn?.addEventListener('click', () => {
    if (replaceRow) {
      replaceRow.hidden = !replaceRow.hidden
      if (!replaceRow.hidden) replaceInput?.focus()
    }
  })

  function doReplace() {
    if (textarea.readOnly) return
    if (!matches.length || currentIndex < 0 || !replaceInput) return
    const pos = matches[currentIndex]
    const len = findInput.value.length
    const rep = replaceInput.value
    textarea.setRangeText(rep, pos, pos + len, 'end')
    onDirty()
    updateMatches()
    if (matches.length) goToMatch(currentIndex)
  }

  replaceBtn?.addEventListener('click', doReplace)

  replaceAllBtn?.addEventListener('click', () => {
    const q = findInput.value
    if (!q || !replaceInput || textarea.readOnly) return
    const rep = replaceInput.value
    const val = textarea.value
    updateMatches()
    let nextVal = val
    for (const pos of [...matches].reverse()) {
      nextVal = nextVal.slice(0, pos) + rep + nextVal.slice(pos + q.length)
    }
    if (nextVal !== val) {
      textarea.value = nextVal
      onDirty()
      updateMatches()
    }
  })

  return { openFind, closeFind }
}
