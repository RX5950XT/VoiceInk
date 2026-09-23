'use strict'

/**
 * 工作區新增 UI 的最小契約回歸。
 * 不啟動 Electron，只檢查 renderer 的 DOM/CSS 契約與 agent 路徑邊界。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { tempDir, removeTree } = require('./lib/test-temp')

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
  'ws-review-text', 'ws-review-del'
]) {
  check(`AI 卡片 CSS 有 .${selector}`, hasSelector(selector))
}
check('檔案樹狀態 CSS 有 .ws-tree-status', hasSelector('ws-tree-status'))

async function runAgentPathChecks() {
  console.log('\n[C] AI 會話檔案路徑')
  const home = tempDir('vi-agent-ui-')
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
    removeTree(home)
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
    let now = 0
    context.Date = { now: () => now }
    let complete
    context.electronAPI.workspace.gitStatus = () => {
      calls += 1
      return new Promise((resolve) => { complete = resolve })
    }
    const slow = gitStatusShared('slow')
    now = 1000
    const repeated = gitStatusShared('slow')
    check('慢請求超過 500ms 仍只打一趟', calls === 6 && repeated === slow)
    complete({ ok: true })
    await repeated
    now = 1200
    check('快取從完成時計算，剛回來的結果可重用', gitStatusShared('slow') === repeated)
    now = 1600
    check('完成後超過 500ms 會重新讀取', gitStatusShared('slow') !== repeated)
    complete({ ok: true })
  })()
}

/**
 * Ctrl+滾輪縮放：倍率算法（`ws-zoom.js`）＋三個接線點（程式碼／預覽／PDF）。
 */
function zoomChecks() {
  console.log('\n[E] Ctrl+滾輪縮放')
  const vm = require('node:vm')
  const source = fs.readFileSync(path.join(ROOT, 'src/renderer/scripts/ws-zoom.js'), 'utf8')
    .replace(/^export /gm, '')
  const context = {}
  vm.createContext(context)
  vm.runInContext(`${source}\nthis.api = { nextZoom, ZOOM_MIN, ZOOM_MAX }`, context)
  const { nextZoom, ZOOM_MIN, ZOOM_MAX } = context.api

  check('往上滾放大', nextZoom(1, -120) > 1)
  check('往下滾縮小', nextZoom(1, 120) < 1)
  check('放大再縮小回得到原點', nextZoom(nextZoom(1, -120), 120) === 1)
  check('一直放大會停在上限', [...Array(80)].reduce((z) => nextZoom(z, -120), 1) === ZOOM_MAX)
  check('一直縮小會停在下限', [...Array(80)].reduce((z) => nextZoom(z, 120), 1) === ZOOM_MIN)
  check('沒有滾動就不動', nextZoom(1.3, 0) === 1.3)
  check('壞掉的倍率當成 100%', nextZoom(NaN, -120) > 1 && nextZoom(0, 0) === 1)

  const monaco = fs.readFileSync(path.join(ROOT, 'src/renderer/scripts/ws-monaco.js'), 'utf8')
  check('程式碼與 diff 共用的選項打開 mouseWheelZoom', /mouseWheelZoom:\s*true/.test(monaco))

  const zoomFn = tabs.slice(tabs.indexOf('function ensurePreviewZoom'), tabs.indexOf('function paintPreview'))
  check('預覽只在按著 Ctrl 時縮放', /event\.ctrlKey/.test(zoomFn))
  check('預覽要吃掉事件，不然整個視窗跟著縮',
    /preventDefault\(\)/.test(zoomFn) && /passive: false/.test(zoomFn))
  check('PDF 不走 CSS 放大（會糊掉）', /!previewIsPdf/.test(zoomFn))
  const paintFn = tabs.slice(tabs.indexOf('function paintPreview'), tabs.indexOf('/** pdf.js'))
  // 每一次套倍率之前都要先標記這一份是不是 PDF，否則會沿用上一份的旗標
  const beforeZoom = paintFn.split('ensurePreviewZoom(box)').slice(0, -1)
  const lastLine = (chunk) => chunk.trimEnd().split('\n').pop().trim()
  check('切成 PDF 前就標記，才不會沿用上一份的 CSS 倍率',
    beforeZoom.length > 0 && beforeZoom.every((chunk) => lastLine(chunk).startsWith('previewIsPdf =')))
  check('PDF 改用更大的 scale 重畫', /scale: 1\.5 \* zoom/.test(tabs))
  check('放大時要放開圖片的尺寸上限', /\.ws-editor-preview\.is-zoomed \.ws-editor-img/.test(css))
}

/**
 * Git 面板那一列的版面契約。
 *
 * 面板只有 280px：徽章、檔名、增刪行數與兩顆動作鈕擠在同一列，任何一段
 * 「不准縮」都會讓長檔名把後面的東西推到疊在一起（實測畫面上文字壓在按鈕上）。
 * 這裡把「哪些東西可以縮、誰先縮、什麼時候才印資料夾」釘住。
 */
function gitRowLayoutChecks() {
  console.log('\n[F] Git 面板的列版面')
  // 目錄只在檔名撞名時才印（跟 VS Code 一樣）——每一列都掛路徑的話，
  // 被截掉的會是真正要認的檔名
  check('目錄只在撞名時才印', /ambiguous\?\.has\(fileName\)/.test(workspacePage))
  check('撞名清單是照「同一個檔名有幾條不同路徑」算的',
    /paths\.size > 1/.test(workspacePage) && /const ambiguous = new Set\(/.test(workspacePage))
  check('撞名清單有傳到每一列', /gitRow\(project, file, side, ambiguous\)/.test(workspacePage))

  // 兩段都要能縮，而且目錄先被壓掉
  const base = css.slice(css.indexOf('.ws-git-basename {'), css.indexOf('.ws-git-dir {'))
  const dir = css.slice(css.indexOf('.ws-git-dir {'), css.indexOf('.ws-git-lines {'))
  check('檔名可以縮，不會把後面的東西擠出去', /flex:\s*0 1 auto/.test(base) && /min-width:\s*0/.test(base))
  check('檔名超長時截斷而不是溢出', /text-overflow:\s*ellipsis/.test(base))
  check('目錄先被壓掉（flex-shrink 大很多）', /flex:\s*0 999 auto/.test(dir))
  check('目錄截的是開頭不是結尾（`…/scripts` 才認得出來）', /direction:\s*rtl/.test(dir))

  // 行數那一段不准縮（縮了會變成看不懂的半個數字）
  const lines = css.slice(css.indexOf('.ws-git-lines {'), css.indexOf('.ws-git-added {'))
  check('增刪行數不縮', /flex:\s*none/.test(lines))
  check('行數用等寬數字（重畫時不跳動）', /font-variant-numeric:\s*tabular-nums/.test(lines))

  // 動作鈕常駐，不做 hover-only（CLAUDE.md：hover 才出現的操作等於沒有）
  const act = css.slice(css.indexOf('.ws-git-act {'), css.indexOf('.ws-git-act:hover'))
  check('動作鈕常駐（沒有靠 opacity 藏起來）', !/opacity:\s*0/.test(act))
  check('動作鈕不縮', /flex:\s*none/.test(act))

  check('變更區段有總增刪的掛點', hasId('wsGitChangesStat'))
  check('總增刪畫在變更區段標題，不塞進收合鈕裡',
    /id=["']wsGitChangesStat["']/.test(html)
    && !/<button[^>]*ws-git-sec-toggle[^>]*>[^<]*wsGitChangesStat/.test(html)
    && /textContent === '變更'/.test(fs.readFileSync(path.join(ROOT, 'scripts/e2e-workspace-cdp.js'), 'utf8')))
  check('變更清單會畫總增刪', /paintGitChangesStat\(/.test(workspacePage))
  check('分組標題也帶該組總增刪',
    /function gitGroup[\s\S]*gitLineTotals\(files\)/.test(workspacePage))
}

/**
 * 最近提交：主旨要整段看得到（面板窄也不准 ellipsis），還要作者、每筆增刪、點 hash 複製。
 */
function gitLogLayoutChecks() {
  console.log('\n[F2] Git 最近提交的顯示')
  const logFn = workspacePage.slice(
    workspacePage.indexOf('function gitLogRow'),
    workspacePage.indexOf('async function stageAll')
  )
  check('提交列有主旨／作者／hash',
    /ws-git-log-subject/.test(logFn) && /ws-git-log-author/.test(logFn) && /ws-git-log-hash/.test(logFn))
  check('hash 是常駐按鈕（點一下複製）',
    /ws-git-log-hash/.test(logFn) && /clipboard\.writeText\(entry\.short\)/.test(logFn))
  check('每筆提交畫得出增刪', /gitLineCounts\(/.test(logFn) && /entry\.added/.test(logFn))

  const subject = css.slice(css.indexOf('.ws-git-log-subject {'), css.indexOf('.ws-git-log-meta {'))
  check('提交主旨換行，不准截成省略號',
    /overflow-wrap:\s*anywhere/.test(subject) && !/text-overflow:\s*ellipsis/.test(subject))
  check('不再用單一列省略號把主旨截掉',
    !/\.ws-git-log-row span \{[\s\S]{0,120}text-overflow:\s*ellipsis/.test(css))
  const hash = css.slice(css.indexOf('.ws-git-log-hash {'), css.indexOf('.ws-git-log-hash:hover'))
  check('複製 hash 的按鈕常駐（沒有靠 opacity 藏起來）',
    css.includes('.ws-git-log-hash {') && !/opacity:\s*0/.test(hash))

  // 展開看這筆改了哪些檔案（資料是 `git log --numstat` 本來就帶著的那幾列）
  check('提交列可以展開', /aria-expanded/.test(logFn) && /gitLogFiles\(/.test(logFn))
  check('清單第一次展開才建（十筆 × 幾百個檔案不先畫出來）',
    /if \(!open && !files\)[\s\S]{0,120}gitLogFiles\(/.test(logFn))
  const filesFn = workspacePage.slice(
    workspacePage.indexOf('function gitLogFiles'),
    workspacePage.indexOf('function gitLogRow')
  )
  check('每個檔案各自畫得出增刪', /gitLineCounts\(file\)/.test(filesFn))
  check('點檔案開得起來', /openEditorTab\(project, file\.path\)/.test(filesFn))
  check('超過上限時講得出還有幾個', /entry\.more/.test(filesFn))
  check('展開的清單收得起來（`[hidden]` 要自己補 display:none）',
    /\.ws-git-log-files\[hidden\]\s*\{\s*display:\s*none/.test(css))
}

/**
 * Git 面板那幾顆動作鈕。側欄拖得到 180px（`SIDEBAR_MIN_W`），
 * 三顆鈕擺不下一列時要**換行**——縮的話字會溢出按鈕框，看起來就是字疊在一起。
 */
function gitActionsWrapChecks() {
  console.log('\n[F3] Git 動作鈕跟著側欄寬度走')
  const actions = css.slice(css.indexOf('.ws-git-actions {'), css.indexOf('/* ── AI 對話記錄 ── */'))
  check('動作鈕會換行', /flex-wrap:\s*wrap/.test(actions))
  check('按鈕不准縮到比字窄（縮了就是字疊在一起）',
    /flex:\s*1 1 auto/.test(actions) && !/min-width:\s*0/.test(actions))
  check('按鈕裡的字不折行', /white-space:\s*nowrap/.test(actions))
  const review = css.slice(css.indexOf('.ws-review-bar {'), css.indexOf('.ws-review-files {'))
  check('分支比較那一列也會換行', /flex-wrap:\s*wrap/.test(review))
  check('分支名長起來不會把圖示鈕壓扁',
    /\.ws-right-head \.btn-icon \{[^}]*flex:\s*none/.test(css))
}

/**
 * 「檢視變更」不再開第二個分頁：同一個分頁在 editor ⇄ diff 之間換面。
 */
function diffToggleChecks() {
  console.log('\n[H] 編輯 ⇄ 變更 就地切換')
  check('開 diff 前先找這個檔案的編輯分頁', /findTab\(`e:\$\{proj\.id\}:\$\{relPath\}`\)/.test(tabs))
  check('就地換面只換 kind，不新增分頁',
    /tab\.kind = 'diff'[\s\S]{0,80}tab\.diffView = true/.test(tabs)
    && !/showDiffInEditorTab[\s\S]{0,400}tabs\.push/.test(tabs))
  check('換面前先把草稿收回分頁（不然回來會被蓋掉）',
    /if \(activeId === tab\.id\) stash\(\)[\s\S]{0,60}tab\.kind = 'diff'/.test(tabs))
  check('有回得去的路', /function backToEditorTab/.test(tabs) && /回到編輯/.test(tabs))
  check('點檔案樹同一個檔案會換回編輯那一面',
    /if \(existing\.diffView\) await backToEditorTab\(existing\)/.test(tabs))
  check('存檔時要存回 editor（存 diff 的話下次開專案接不回草稿）',
    /kind: t\.diffView \? 'editor' : t\.kind/.test(tabs))
  check('未存草稿的關閉確認不再綁 kind === editor',
    /\/\/ `dirty` 只有編輯分頁會有[\s\S]{0,80}if \(tab\.dirty\) \{/.test(tabs))
  check('檔案樹的高亮在變更那一面不掉', /tab\.kind === 'editor' \|\| tab\.diffView/.test(tabs))
}

/**
 * 內建瀏覽器：**每個分頁一顆 webview**。共用一顆的話切回來整頁重載，
 * 而且「上一頁」會走進別的分頁逛過的歷史。
 */
function browserChecks() {
  console.log('\n[I] 內建瀏覽器')
  check('webview 照分頁 id 找', /webview\[data-tab-id="\$\{CSS\.escape\(tab\.id\)\}"\]/.test(tabs))
  check('切分頁只藏不搬（不重新 attach）', /\(node\)\.hidden = node !== guest/.test(tabs))
  check('webview 的 [hidden] 要自己寫 display:none（UA 是 display:flex）',
    /\.ws-browser-frame webview\[hidden\]\s*\{\s*display:\s*none/.test(css))
  check('導航事件從 guest 自己的 data-tab-id 找分頁，不是 activeId',
    /guest\?\.dataset\.tabId/.test(tabs))
  check('關掉分頁會收掉 webview',
    /parkedBrowsers\.delete\(guestKey/.test(tabs) && (tabs.match(/pruneBrowserGuests\(\)/g) || []).length >= 3)
  check('webview 用專案 id 加上分頁 id 找，避免兩個專案的 b:1 撞在一起',
    /data-project-id/.test(tabs) && /guestKey\(/.test(tabs))
  check('換專案先停放瀏覽器分頁，不拆掉 webview',
    /parkCurrentBrowsers\(/.test(tabs)
    && /parkCurrentBrowsers\(\)/.test(tabs.slice(tabs.indexOf('export async function setActiveProject'))))
  check('移除專案才忘掉那個專案停放的 webview',
    /export function forgetProjectBrowsers/.test(tabs)
    && /forgetProjectBrowsers\(item\.id\)/.test(workspacePage))
  check('上一頁／下一頁在 DOM 上', hasId('wsBrowserBackBtn') && hasId('wsBrowserFwdBtn'))
  check('重新整理鈕在載入中會變成停止', /guest\.isLoading\(\)[\s\S]{0,60}guest\.stop\(\)/.test(tabs))
  check('載入中有看得見的指示', hasId('wsBrowserProgress') && hasSelector('ws-browser-progress'))
  check('載不起來時講得出原因', hasId('wsBrowserErrorNote') && /errorDescription/.test(tabs))
  check('使用者自己中斷（-3）與子框架不算載入失敗',
    /errorCode === -3 \|\| detail\.isMainFrame === false/.test(tabs))
  check('背景分頁載入中不會改正在看的工具列',
    /did-start-loading[\s\S]{0,220}activeId === target\.id/.test(tabs)
    && /did-stop-loading[\s\S]{0,220}activeId === target\.id/.test(tabs))
  check('Alt+←／→ 只在瀏覽器分頁收', /tab\.kind !== 'browser'[\s\S]{0,400}ArrowLeft/.test(tabs))
  check('有開發人員工具', hasId('wsBrowserDevBtn') && /openDevTools\(\)/.test(tabs))
}

/**
 * 檔案樹跑得動 EXE 與一鍵啟動腳本。
 * IPC 要三份清單都對得上（`index.js` 匯出／`main.js` 白名單／`preload.js`）。
 */
async function runFileChecks() {
  console.log('\n[J] 執行檔案')
  const mainJs = fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf8')
  const preload = fs.readFileSync(path.join(ROOT, 'src/preload/preload.js'), 'utf8')
  const ipc = fs.readFileSync(path.join(ROOT, 'src/main/workspace/ipc.js'), 'utf8')
  const service = fs.readFileSync(path.join(ROOT, 'src/main/workspace/index.js'), 'utf8')
  check('service 有 openEntry', /async function openEntry/.test(service) && /^ {2}openEntry,$/m.test(service))
  check('openEntry 走 resolveExisting（只收專案內的路徑）',
    /function openEntry[\s\S]{0,200}files\.resolveExisting/.test(service))
  check('openPath 回字串＝失敗，要當錯誤處理',
    /function openEntry[\s\S]{0,320}if \(error\) throw fail/.test(service))
  check('IPC 有 workspace:openEntry', /ipcMain\.handle\('workspace:openEntry'/.test(ipc))
  check('main.js 的白名單有 openEntry', /openEntry: \(\.\.\.args\) => loadWorkspace\(\)\.openEntry/.test(mainJs))
  check('preload 接得到 openEntry', /openEntry: \(id, relPath\) =>/.test(preload))

  check('右鍵選單有「在終端機執行」與「用預設程式開啟」',
    /在終端機執行/.test(workspacePage) && /用預設程式開啟/.test(workspacePage))
  check('只有腳本類才給「在終端機執行」', /isTerminalRunnable\(entry\.rel\)/.test(workspacePage))
  check('點執行檔直接用系統開啟（不開「無法預覽」分頁）',
    /isDirectRunnable\(entry\.rel\)/.test(workspacePage)
    && /openWithSystem\(project\.id, entry\.rel\)/.test(workspacePage))
  check('點啟動腳本開終端機跑',
    /isLaunchScript\(entry\.rel\)/.test(workspacePage)
    && /runInTerminal\(entry\.rel\)/.test(workspacePage))
  check('啟動腳本的右鍵有「開啟」（點下去是跑，編輯走右鍵）',
    /isLaunchScript\(entry\.rel\)[\s\S]{0,180}label: '開啟'/.test(workspacePage))
  check('`.js`／`.py` 不在點擊就跑的清單裡',
    /const LAUNCH_EXTS = \['bat', 'cmd', 'ps1', 'sh'\]/.test(tabs)
    && /const DIRECT_EXTS = \['exe', 'com', 'msi', 'lnk'\]/.test(tabs))
  const runFn = tabs.slice(tabs.indexOf('export async function runInTerminal'), tabs.indexOf('export async function openEditorTab'))
  const commands = []
  const run = new Function('newTerminalWithCommand', 'extOf', `${runFn.replace('export ', '')}; return runInTerminal`)(
    async (_title, command) => commands.push(command), (rel) => rel.split('.').pop().toLowerCase())
  for (const [file, expected] of [
    ['hello.js', "node './hello.js'"], ['hello.mjs', "node './hello.mjs'"],
    ['hello.py', "python './hello.py'"], ['hello.jar', "java -jar './hello.jar'"],
    ['hello.sh', "bash './hello.sh'"], ["it's.ps1", "& './it''s.ps1'"]
  ]) {
    await run(file)
    check(`執行 ${file} 使用對應程式`, commands.pop() === expected)
  }
  check('終端機指令用 PowerShell 的 & 與單引號（路徑有空白也跑得動）',
    /\|\| '&'/.test(runFn) && /rel\.replace\(\/'\/g, "''"\)/.test(runFn))
  check('路徑有換行就不送（送進終端機的是按鍵）', /\/\[\\r\\n\]\/\.test\(rel\)/.test(runFn))
  check('開不了的檔案畫面上有「執行」鈕', hasId('wsEditorUnsupportedOpenBtn'))
  check('只有執行檔才顯示那顆鈕', /el\.unsupportedOpen\.hidden = !isRunnable\(/.test(tabs))
  check('藏起來的按鈕真的不見（`.btn` 有寫 display）',
    /\.ws-unsupported-actions \.btn\[hidden\]\s*\{\s*display:\s*none/.test(css))
}

/** 文件類（md／html／svg）開起來就停在預覽那一面，Ctrl+S 在 Monaco／預覽下也存得到 */
/**
 * 檔案樹監看刷新若先 `replaceChildren()` 再非同步補列，畫面會閃白。
 * 側欄轉圈圈若每次 `terminal:status` 都拆掉 SVG 重建，動畫永遠從 0% 重來。
 */
function treeRefreshAndStatusSpinChecks() {
  console.log('\n[G] 檔案樹刷新與側欄轉圈圈')
  const renderTreeFn = workspacePage.slice(
    workspacePage.indexOf('async function renderTree'),
    workspacePage.indexOf('async function appendLevel')
  )
  check('同專案刷新走就地同步，不在 git status 之後整棵清空',
    /syncLevel/.test(renderTreeFn)
    && !/loadTreeGitStatus[\s\S]{0,240}el\.tree\.replaceChildren\(\)/.test(renderTreeFn))
  check('換專案才清空檔案樹',
    /treeProjectId !== project\.id[\s\S]{0,120}replaceChildren\(\)/.test(renderTreeFn))

  const paintFn = workspacePage.slice(
    workspacePage.indexOf('function paintProjectStatuses'),
    workspacePage.indexOf('function buildListItem')
  )
  check('終端機狀態更新不整組拆掉重建',
    /patchSessionChip/.test(paintFn) && !/host\.replaceChildren\(\)/.test(paintFn))
  check('狀態沒變就留下正在轉的那顆 SVG',
    /querySelector\(['"]\.ws-status-icon['"]\)/.test(paintFn)
    && /dataset\.state/.test(paintFn))

  const spin = css.slice(
    css.indexOf('.ws-status-icon.is-spin'),
    css.indexOf('@keyframes ws-status-spin')
  )
  check('轉圈圈以 viewBox 中心為軸（SVG 的 50% 會繞錯點）',
    /transform-box:\s*view-box/.test(spin) && /transform-origin:\s*center/.test(spin))
}

function editorDefaultsChecks() {
  const openFn = tabs.slice(tabs.indexOf('export async function openEditorTab'), tabs.indexOf('function goToLine'))
  check('文件類開檔預設就是預覽模式', /preview:[\s\S]{0,160}PREVIEWABLE_EXTS\.includes\(extOf\(relPath\)\)/.test(openFn))
  check('預覽副檔名只有一份清單', !/\['md', 'markdown'/.test(tabs.slice(tabs.indexOf('function paintEditor'))))

  const save = tabs.slice(tabs.indexOf("if (event.key.toLowerCase() !== 's'") - 400,
    tabs.indexOf('// Alt+↑／↓ 在 diff 分頁上'))
  check('Ctrl+S 掛在 document 上（Monaco 與預覽模式也收得到）', /document\.addEventListener\('keydown'/.test(save))
  check('textarea 已處理過的那一次不重複存檔', /event\.defaultPrevented/.test(save))
  check('焦點在終端機裡不搶 Ctrl+S', /#termHost/.test(save))
  check('Ctrl+S 真的呼叫存檔', /saveActiveFile\(\)/.test(save))
}

runAgentPathChecks().then(gitStatusCacheChecks).then(zoomChecks).then(gitRowLayoutChecks).then(gitLogLayoutChecks).then(gitActionsWrapChecks).then(treeRefreshAndStatusSpinChecks).then(editorDefaultsChecks).then(diffToggleChecks).then(browserChecks).then(runFileChecks).then(() => {
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exitCode = failed ? 1 : 0
}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
