'use strict'

/**
 * 工作區新增 UI 的最小契約回歸。
 * 不啟動 Electron，只檢查 renderer 的 DOM/CSS 契約與 agent 路徑邊界。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const html = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8')
const tabs = fs.readFileSync(path.join(ROOT, 'src/renderer/scripts/ws-tabs.js'), 'utf8')
const diff = fs.readFileSync(path.join(ROOT, 'src/renderer/scripts/ws-diff.js'), 'utf8')
const css = fs.readFileSync(path.join(ROOT, 'src/renderer/styles/main.css'), 'utf8')
const agents = require(path.join(ROOT, 'src/main/workspace/agents.js'))
const browserPainter = tabs.slice(tabs.indexOf('function paintBrowser'), tabs.indexOf('function navigateBrowser'))

let passed = 0
let failed = 0

/** @param {string} name @param {boolean} condition */
function check(name, condition) {
  if (condition) {
    passed += 1
    console.log(`PASS ${name}`)
  } else {
    failed += 1
    console.log(`FAIL ${name}`)
  }
}

/** @param {string} id @returns {boolean} */
function hasId(id) {
  return new RegExp(`\\bid=["']${id}["']`).test(html)
}

/** @param {string} selector @returns {boolean} */
function hasSelector(selector) {
  return new RegExp(`\\.${selector}(?=[\\s,{:])`).test(css)
}

console.log('\n[A] renderer DOM 與資料契約')
check('Diff 統計 ID 對得上', hasId('wsDiffStats'))
check('Diff 開啟編輯器 ID 對得上', hasId('wsDiffOpenEditorBtn'))
check('Diff 內容 ID 對得上', hasId('wsDiffContent'))
check('Diff 使用 main 回傳的 diff 欄位', /parseUnifiedDiff\(tab\.diffData\.diff\)/.test(tabs))
check('不支援檔案有名稱欄位', hasId('wsEditorUnsupportedName'))
check('不支援檔案有大小欄位', hasId('wsEditorUnsupportedSize'))
check('不支援檔案有類型欄位', hasId('wsEditorUnsupportedType'))
check('不支援檔案有檔案總管按鈕', hasId('wsEditorUnsupportedRevealBtn'))
check('IDE 狀態列有接到 renderer', /el\.ideStatusbar\s*=\s*document\.getElementById\('wsIdeStatusbar'\)/.test(tabs))
check('空白瀏覽器分頁會回到 about:blank', /if \(!href\)[\s\S]*guest\.setAttribute\('src', 'about:blank'\)/.test(browserPainter))

console.log('\n[B] Diff CSS 契約')
for (const selector of [
  'ws-diff-line', 'ws-diff-line-add', 'ws-diff-line-del', 'ws-diff-hunk',
  'ws-diff-content', 'ws-diff-empty', 'ws-diff-add', 'ws-diff-del'
]) {
  check(`CSS 有 .${selector}`, hasSelector(selector))
}
for (const selector of [
  'ws-ai-card', 'ws-ai-card-title', 'ws-ai-meta-grid', 'ws-ai-meta-item',
  'ws-ai-meta-label', 'ws-ai-meta-value', 'ws-ai-sub-title', 'ws-ai-files-list',
  'ws-ai-file-pill', 'ws-ai-tools-grid', 'ws-ai-tool-badge', 'ws-ai-tool-name',
  'ws-ai-tool-count', 'ws-ai-prompts-timeline', 'ws-ai-prompt-item',
  'ws-ai-prompt-idx', 'ws-ai-prompt-text'
]) {
  check(`AI 卡片 CSS 有 .${selector}`, hasSelector(selector))
}

async function runAgentPathChecks() {
  console.log('\n[C] AI 會話檔案路徑')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-agent-ui-'))
  const project = path.join(home, 'project')
  const outside = path.join(home, 'outside.txt')
  const sessionId = 'ui-test-123'
  const sessionDir = path.join(home, '.claude', 'projects', agents.encodeClaudeDir(project))
  fs.mkdirSync(sessionDir, { recursive: true })
  fs.writeFileSync(outside, 'outside')
  fs.writeFileSync(path.join(sessionDir, `${sessionId}.jsonl`), [
    JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'tool_use', name: 'Read', input: { path: path.join(project, 'src', 'inside.js') } },
      { type: 'tool_use', name: 'Write', input: { file_path: outside } },
      { type: 'tool_use', name: 'Edit', input: { path: 'src/relative.js' } }
    ] } })
  ].join('\n'))

  const originalHome = os.homedir
  os.homedir = () => home
  try {
    const detail = await agents.sessionDetail(project, 'claude', sessionId)
    check('專案內絕對路徑轉成相對路徑', detail.modifiedFiles.includes('src/inside.js'))
    check('專案內相對路徑保留', detail.modifiedFiles.includes('src/relative.js'))
    check('專案外路徑不回傳給 renderer', !detail.modifiedFiles.some((file) => file.includes('outside.txt')))
    check('回傳路徑不含反斜線', detail.modifiedFiles.every((file) => !file.includes('\\')))
  } finally {
    os.homedir = originalHome
    fs.rmSync(home, { recursive: true, force: true })
  }
}

runAgentPathChecks().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exitCode = failed ? 1 : 0
}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
