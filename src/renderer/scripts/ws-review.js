/**
 * 審閱：逐行意見，以及「把意見交回 AI」。
 *
 * 借 Orca 的 `shared/diff-comments-format.ts` 那個想法：**意見本身就是一段
 * 人看得懂的純文字**，不另外發明一種格式。這樣貼進聊天、貼進終端機裡的 CLI、
 * 甚至直接貼給同事都能用，也不必動上游 API 的契約。
 *
 * 意見存在 `localStorage`（每個專案一份）：它是「還沒交出去的草稿」，
 * 跟著這台機器的這個使用者走就夠了，不值得為它多開一份 main 的 store。
 * 交給 AI 之後由使用者自己清（審到一半關掉 App 還在，才不會白審一輪）。
 */

/** localStorage 的 key */
const KEY = 'wsReviewComments'
/** 每個專案最多留幾則（審一輪不會超過這個數，純防呆） */
const MAX_PER_PROJECT = 200
/** 單則意見的長度上限 */
const MAX_TEXT = 2000
/** 引用的原始碼片段最多留幾個字 */
const MAX_SNIPPET = 300

/** @type {Record<string, Array<{ id: string, relPath: string, line: number, endLine: number, snippet: string, text: string, at: number }>>} */
let all = {}

try {
  const raw = JSON.parse(localStorage.getItem(KEY) || '{}')
  if (raw && typeof raw === 'object') all = raw
} catch {
  all = {}
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    // 沒有 storage（或滿了）就只有這次有效，不要因此讓審閱功能整個不能用
  }
}

/**
 * @param {string} projectId
 * @param {string} [relPath] 只要這個檔案的
 * @returns {Array<{ id: string, relPath: string, line: number, endLine: number, snippet: string, text: string, at: number }>}
 */
export function listComments(projectId, relPath) {
  const rows = all[projectId] || []
  const scoped = relPath ? rows.filter((one) => one.relPath === relPath) : rows
  return [...scoped].sort((a, b) => (
    a.relPath === b.relPath ? a.line - b.line : a.relPath.localeCompare(b.relPath)
  ))
}

/**
 * @param {string} projectId
 * @param {{ relPath: string, line: number, endLine?: number, snippet?: string, text: string }} input
 * @returns {boolean} 有沒有真的加進去
 */
export function addComment(projectId, input) {
  const text = String(input?.text || '').trim().slice(0, MAX_TEXT)
  const relPath = String(input?.relPath || '')
  if (!projectId || !relPath || !text) return false
  const rows = all[projectId] || []
  if (rows.length >= MAX_PER_PROJECT) return false
  const line = Number(input.line) > 0 ? Math.floor(Number(input.line)) : 1
  rows.push({
    id: `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    relPath,
    line,
    endLine: Number(input.endLine) > line ? Math.floor(Number(input.endLine)) : line,
    snippet: String(input.snippet || '').slice(0, MAX_SNIPPET),
    text,
    at: Date.now()
  })
  all[projectId] = rows
  persist()
  return true
}

/**
 * @param {string} projectId
 * @param {string} id
 */
export function removeComment(projectId, id) {
  const rows = all[projectId] || []
  all[projectId] = rows.filter((one) => one.id !== id)
  persist()
}

/**
 * @param {string} projectId
 */
export function clearComments(projectId) {
  delete all[projectId]
  persist()
}

/**
 * @param {string} projectId
 * @returns {number}
 */
export function countComments(projectId) {
  return (all[projectId] || []).length
}

/**
 * 把意見排成一段可以直接交給 AI 的文字。
 *
 * 格式刻意樸素：一個檔案一段、標出行號、引用那幾行、再寫意見。
 * 加了行號 AI 才知道要改哪裡；引用原文是因為它手上那份可能已經又動過了。
 *
 * @param {string} projectId
 * @param {string} [ref] 這輪是跟哪條分支比的
 * @returns {string}
 */
export function formatComments(projectId, ref = '') {
  const rows = listComments(projectId)
  if (!rows.length) return ''
  const head = ref
    ? `以下是我對「跟 ${ref} 相比的這批變更」的逐行意見，共 ${rows.length} 則：`
    : `以下是我對這批變更的逐行意見，共 ${rows.length} 則：`
  const blocks = []
  let lastFile = ''
  for (const row of rows) {
    if (row.relPath !== lastFile) {
      lastFile = row.relPath
      blocks.push(`\n## ${row.relPath}`)
    }
    const where = row.endLine > row.line ? `${row.line}-${row.endLine}` : `${row.line}`
    const quote = row.snippet
      ? `\n\`\`\`\n${row.snippet.replace(/```/g, "'''")}\n\`\`\``
      : ''
    blocks.push(`\n### 第 ${where} 行${quote}\n${row.text}`)
  }
  return `${head}\n${blocks.join('\n')}\n`
}

/**
 * 把一段文字丟進聊天輸入框（`chat-page.js` 在聽這個事件）。
 *
 * 用事件而不是直接 import：兩個模組是各自 lazy load 的，誰先進來不固定，
 * 互相 import 會把聊天頁的載入時機綁到工作區上。
 *
 * @param {string} text
 */
export function sendToChat(text) {
  if (!text) return
  document.dispatchEvent(new CustomEvent('chat:insert', { detail: { text } }))
}
