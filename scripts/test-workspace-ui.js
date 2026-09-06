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
const app = fs.readFileSync(path.join(ROOT, 'src/renderer/scripts/app.js'), 'utf8')
const tabs = fs.readFileSync(path.join(ROOT, 'src/renderer/scripts/ws-tabs.js'), 'utf8')
const workspacePage = fs.readFileSync(path.join(ROOT, 'src/renderer/scripts/workspace-page.js'), 'utf8')
const diff = fs.readFileSync(path.join(ROOT, 'src/renderer/scripts/ws-diff.js'), 'utf8')
const css = fs.readFileSync(path.join(ROOT, 'src/renderer/styles/main.css'), 'utf8')
const agents = require(path.join(ROOT, 'src/main/workspace/agents.js'))
const browserPainter = tabs.slice(tabs.indexOf('function paintBrowser'), tabs.indexOf('function navigateBrowser'))
const treeStatusPainter = workspacePage.slice(
  workspacePage.indexOf('function treeStatusInfo'),
  workspacePage.indexOf('async function renderTree')
)
const paneMode = app.slice(
  app.indexOf('export function setChatPaneMode'),
  app.indexOf('/**\n * 切換主分頁')
)

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
check('變更檔編輯器有未提交變更按鈕', hasId('wsEditorDiffBtn'))
check('未提交變更按鈕會開既有 Diff', /editorDiffBtn[\s\S]*openDiffTab/.test(tabs))
check('IDE 狀態列有接到 renderer', /el\.ideStatusbar\s*=\s*document\.getElementById\('wsIdeStatusbar'\)/.test(tabs))
check('空白瀏覽器分頁會回到 about:blank', /if \(!href\)[\s\S]*guest\.setAttribute\('src', 'about:blank'\)/.test(browserPainter))
check('檔案樹有 Git 狀態標記', /ws-tree-status/.test(workspacePage))
check('檔案樹會讀 Git 狀態', /loadTreeGitStatus/.test(workspacePage))
check('點 Git 狀態標記會開 Diff', /openDiffTab\(project, entry\.rel/.test(workspacePage))
check('資料夾 Git 狀態說明變更', /if \(entry\.dir\)[\s\S]*?label:\s*['`]改/.test(treeStatusPainter))
// 整個資料夾都沒加入版控時，git 只回一筆 `? newdir/`（沒有底下的檔案），
// 那一筆會落在 files 而不是 dirs：只查 dirs 的話新資料夾在樹上完全沒有標記。
check('未追蹤的整個資料夾也有標記', /if \(entry\.dir\)[\s\S]*?if \(file\)/.test(treeStatusPainter))
// 提示只印得下前幾個檔名，不可以留整份清單（每檔每層複製一次成長中的陣列＝O(n²)）
check('資料夾摘要不留整份檔案清單', !/files:\s*\[\.\.\.previous\.files/.test(workspacePage))
check('切回聊天會收起工作區右欄', /wsRightResizer[\s\S]*classList\.toggle\('hidden'/.test(paneMode))
check('工作區使用緊湊滿版佈局', /is-workspace/.test(app) && /chat-layout\.is-workspace/.test(css))

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
  'ws-ai-prompt-idx', 'ws-ai-prompt-text',
  // 這一輪新增的：可收合的工具細節、對話內容、審閱意見、對話歸屬
  'ws-ai-fold', 'ws-ai-fold-head', 'ws-ai-fold-body', 'ws-ai-note',
  'ws-ai-turns', 'ws-ai-turn', 'ws-ai-turn-role', 'ws-ai-turn-text',
  'ws-ai-turn-tool', 'ws-agent-source', 'ws-agent-resume',
  'ws-review-bar', 'ws-review-files', 'ws-review-file', 'ws-review-panel',
  'ws-review-head', 'ws-review-list', 'ws-review-item', 'ws-review-where',
  'ws-review-text', 'ws-review-del', 'chat-list-proj'
]) {
  check(`AI 卡片 CSS 有 .${selector}`, hasSelector(selector))
}
check('檔案樹狀態 CSS 有 .ws-tree-status', hasSelector('ws-tree-status'))

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
    const all = [...detail.editedFiles, ...detail.readFiles]
    check('專案內絕對路徑轉成相對路徑', all.includes('src/inside.js'))
    check('專案內相對路徑保留', all.includes('src/relative.js'))
    check('專案外路徑不回傳給 renderer', !all.some((file) => file.includes('outside.txt')))
    check('回傳路徑不含反斜線', all.every((file) => !file.includes('\\')))
    // 讀過的不可以被說成改過的（Read 進 readFiles、Edit 進 editedFiles）
    check('Read 只算讀過', detail.readFiles.includes('src/inside.js')
      && !detail.editedFiles.includes('src/inside.js'))
    check('Edit 算改過', detail.editedFiles.includes('src/relative.js'))
  } finally {
    os.homedir = originalHome
    fs.rmSync(home, { recursive: true, force: true })
  }
}

/**
 * 檔案樹與「未提交變更」鈕共用同一趟 `git status`（`ws-git-status.js`）。
 * `git status` 是這裡最貴的一支 git 指令，切一次分頁本來會打兩三趟。
 */
function gitStatusCacheChecks() {
  console.log('\n[D] git status 共用快取')
  const vm = require('node:vm')
  const source = fs.readFileSync(path.join(ROOT, 'src/renderer/scripts/ws-git-status.js'), 'utf8')
    .replace(/^import [\s\S]*?from '[^']*'$/gm, '')
    .replace(/^export /gm, '')
  let calls = 0
  let fail = false
  const context = {
    Date,
    electronAPI: { workspace: { gitStatus: async () => {
      calls += 1
      if (fail) throw new Error('boom')
      return { ok: true }
    } } }
  }
  vm.createContext(context)
  vm.runInContext(`${source}\nthis.api = { gitStatusShared, invalidateGitStatus }`, context)
  const { gitStatusShared, invalidateGitStatus } = context.api

  return (async () => {
    await Promise.all([gitStatusShared('A'), gitStatusShared('A')])
    check('同時要同一個專案只打一趟', calls === 1)
    await gitStatusShared('A')
    check('短時間內重複呼叫重用結果', calls === 1)
    await gitStatusShared('B')
    check('換專案一定要重打', calls === 2)
    invalidateGitStatus()
    await gitStatusShared('B')
    check('動過 git 之後不可以再拿快取', calls === 3)
    fail = true
    await gitStatusShared('C').catch(() => {})
    await gitStatusShared('C').catch(() => {})
    check('失敗不留在快取裡（下一次要能重試）', calls === 5)
  })()
}

runAgentPathChecks().then(gitStatusCacheChecks).then(() => {
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exitCode = failed ? 1 : 0
}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
