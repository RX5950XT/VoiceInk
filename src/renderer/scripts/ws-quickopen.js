import { electronAPI, showToast } from './app.js'

/**
 * 快速開檔（Ctrl+P），比照 Orca 的 QuickOpen。
 *
 * 打的字拿去跟**整條相對路徑**做模糊比對（字元照順序出現就算命中），
 * 分數越小越前面：中間跳過的字元加分（連在一起最好），落在 `/ . - _`
 * 後面的字元減 5（那是「一段的開頭」，人通常在找那個），
 * 檔名本身整段命中直接減 100（多數時候使用者打的就是檔名）。
 *
 * 檔案清單在打開面板時抓一次就丟——main 的 walk 已經跳掉 `.git`／`node_modules`，
 * 個人專案幾千個檔案一趟 readdir 就回來了，**不做背景索引**（要維護失效與監看，
 * 換來的只是省下這一趟）。
 */

/** 最多列幾筆（再多使用者也不會往下看） */
const MAX_ROWS = 50

/** @type {{ host: HTMLElement, input: HTMLInputElement, list: HTMLElement } | null} */
let ui = null
/** @type {Array<{ rel: string, lowerPath: string, lowerName: string }>} */
let indexed = []
/** @type {string[]} 目前列出來的相對路徑（依序） */
let shown = []
let cursor = 0
/** @type {((rel: string) => void) | null} */
let onPick = null

/**
 * 一條路徑的分數；比不上就回 null（**不用 -1 當哨兵**——
 * 真的算得出 -1 分，那樣會把一筆合法命中當成沒命中丟掉）。
 *
 * @param {string} query 已經小寫、`\` 換成 `/` 的查詢字串
 * @param {string} lowerPath
 * @param {string} lowerName 檔名（不含資料夾）
 * @returns {number | null}
 */
export function scorePath(query, lowerPath, lowerName) {
  let qi = 0
  let score = 0
  let last = -1
  for (let ti = 0; ti < lowerPath.length && qi < query.length; ti += 1) {
    if (lowerPath[ti] !== query[qi]) continue
    if (last !== -1) score += ti - last - 1
    const prev = ti > 0 ? lowerPath[ti - 1] : ''
    if (prev === '/' || prev === '.' || prev === '-' || prev === '_') score -= 5
    last = ti
    qi += 1
  }
  if (qi < query.length) return null
  if (lowerName.includes(query)) score -= 100
  return score
}

/**
 * @param {string} rel
 * @returns {{ rel: string, lowerPath: string, lowerName: string }}
 */
function prepare(rel) {
  const slashed = rel.replace(/\\/g, '/')
  const lowerPath = slashed.toLowerCase()
  return { rel, lowerPath, lowerName: lowerPath.slice(lowerPath.lastIndexOf('/') + 1) }
}

/**
 * 排出前 `MAX_ROWS` 名。查詢是空的就照原本的順序給前幾筆。
 *
 * @param {string} rawQuery
 * @param {Array<{ rel: string, lowerPath: string, lowerName: string }>} files
 * @returns {string[]}
 */
export function rankPaths(rawQuery, files) {
  const query = rawQuery.trim().replace(/\\/g, '/').toLowerCase()
  if (!query) return files.slice(0, MAX_ROWS).map((item) => item.rel)
  /** @type {Array<{ rel: string, score: number }>} */
  const hits = []
  for (const file of files) {
    const score = scorePath(query, file.lowerPath, file.lowerName)
    if (score !== null) hits.push({ rel: file.rel, score })
  }
  hits.sort((a, b) => a.score - b.score || a.rel.localeCompare(b.rel))
  return hits.slice(0, MAX_ROWS).map((item) => item.rel)
}

function ensureUi() {
  if (ui) return ui
  const host = document.createElement('div')
  host.className = 'ws-qo'
  host.hidden = true

  const box = document.createElement('div')
  box.className = 'ws-qo-box'
  box.setAttribute('role', 'dialog')
  box.setAttribute('aria-label', '快速開檔')

  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'input input-sm ws-qo-input'
  input.placeholder = '輸入檔名或路徑片段…'
  input.setAttribute('aria-label', '快速開檔')

  const list = document.createElement('div')
  list.className = 'ws-qo-list'
  list.setAttribute('role', 'listbox')

  box.append(input, list)
  host.appendChild(box)
  // 點面板以外的地方＝關掉（跟右鍵選單同一套手感）
  host.addEventListener('mousedown', (event) => {
    if (event.target === host) close()
  })
  input.addEventListener('input', () => paint())
  input.addEventListener('keydown', onKeydown)
  document.body.appendChild(host)
  ui = { host, input, list }
  return ui
}

/**
 * @param {KeyboardEvent} event
 */
function onKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
    return
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    if (!shown.length) return
    cursor = event.key === 'ArrowDown'
      ? Math.min(shown.length - 1, cursor + 1)
      : Math.max(0, cursor - 1)
    paintCursor()
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    pick(shown[cursor])
  }
}

/**
 * @param {string | undefined} rel
 */
function pick(rel) {
  if (!rel || !onPick) return
  const open = onPick
  close()
  open(rel)
}

function paintCursor() {
  if (!ui) return
  const rows = ui.list.querySelectorAll('.ws-qo-row')
  rows.forEach((row, i) => {
    const on = i === cursor
    row.classList.toggle('is-active', on)
    row.setAttribute('aria-selected', on ? 'true' : 'false')
    if (on) row.scrollIntoView({ block: 'nearest' })
  })
}

function paint() {
  if (!ui) return
  shown = rankPaths(ui.input.value, indexed)
  cursor = 0
  ui.list.replaceChildren()
  if (!shown.length) {
    const empty = document.createElement('p')
    empty.className = 'ws-qo-empty'
    empty.textContent = indexed.length ? '沒有符合的檔案' : '這個專案沒有檔案'
    ui.list.appendChild(empty)
    return
  }
  for (const rel of shown) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'ws-qo-row'
    row.setAttribute('role', 'option')
    const cut = rel.lastIndexOf('/')
    const name = document.createElement('span')
    name.className = 'ws-qo-name'
    name.textContent = cut < 0 ? rel : rel.slice(cut + 1)
    const dir = document.createElement('span')
    dir.className = 'ws-qo-dir'
    dir.textContent = cut < 0 ? '' : rel.slice(0, cut)
    row.append(name, dir)
    row.addEventListener('click', () => pick(rel))
    ui.list.appendChild(row)
  }
  paintCursor()
}

/** 關掉面板，焦點還給原本的地方（不主動搶） */
export function close() {
  if (!ui || ui.host.hidden) return
  ui.host.hidden = true
  ui.list.replaceChildren()
  shown = []
  onPick = null
}

export function isOpen() {
  return Boolean(ui && !ui.host.hidden)
}

/**
 * 打開快速開檔面板。
 *
 * @param {{ id: string }} project
 * @param {(rel: string) => void} pickHandler 選到一個檔案時要做什麼
 */
export async function openQuickOpen(project, pickHandler) {
  const view = ensureUi()
  onPick = pickHandler
  indexed = []
  view.host.hidden = false
  view.input.value = ''
  view.input.placeholder = '輸入檔名或路徑片段…'
  view.list.replaceChildren()
  view.input.focus()

  const result = await electronAPI.workspace.listFiles(project.id)
  // 抓清單的途中使用者可能已經按 Esc 了，別把畫面再叫回來
  if (!onPick || view.host.hidden) return
  if (!result || !result.ok) {
    showToast(result?.error?.message || '讀不到檔案清單', 'error')
    close()
    return
  }
  indexed = result.data.paths.map(prepare)
  if (result.data.truncated) view.input.placeholder = '檔案很多，只索引了前面一部分'
  paint()
}
