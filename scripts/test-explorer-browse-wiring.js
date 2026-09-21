'use strict'

/**
 * 檢查 explorer-browse helper 是否真的接到 Explorer renderer。
 *
 * 這支故意讀原始碼，不啟動 Electron；它會抓到「helper 有測試，但頁面仍把
 * 50k 筆全部載入／只存一個右欄 state／日期篩選沒有送出」的回歸。整合後在
 * repo 根目錄重跑：node scripts/test-explorer-browse-wiring.js
 */

const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(process.argv[2] || process.cwd())
const page = fs.readFileSync(path.join(root, 'src/renderer/scripts/explorer-page.js'), 'utf8')
const browse = fs.readFileSync(path.join(root, 'src/renderer/scripts/explorer-browse.js'), 'utf8')
const index = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8')

const failures = []

function has(source, pattern, label) {
  if (!pattern.test(source)) failures.push(label)
}

function absent(source, pattern, label) {
  if (pattern.test(source)) failures.push(label)
}

has(page, /from ['"]\.\/explorer-browse\.js['"]/, '頁面有載入 browse helper')
has(page, /BROWSE_PAGE_SIZE/, '頁面使用統一分頁大小')
has(page, /mergeBrowsePage\(/, '頁面合併稀疏分頁')
has(page, /visibleBrowseRange\(/, '頁面只畫可見列')
has(page, /pageOffsetsForRange/, '捲動時能計算需要補載的頁面')
has(page, /pageOffsetsForRange\(/, '捲動流程真的呼叫補頁計算')
has(page, /selectBrowseRange/, 'Shift 選取走跨頁選取 helper')
absent(page, /while \(guard\+\+ < 1000\)/, 'renderer 不在首次導航逐頁載完整目錄')
absent(page, /const canVirtualize = view === ['"]list['"] && !inSearch\(\)/,
  'grid 檢視也不會把整個大目錄畫進 DOM')
has(page, /offset[\s\S]{0,160}limit|limit[\s\S]{0,160}offset/, 'listDir 請求帶 offset／limit')

has(page, /boot\.tabs/, '啟動讀取 tabs')
has(page, /activeTabId/, '啟動還原 active tab')
has(page, /syncTab\([\s\S]{0,600}selected/, '分頁狀態保存選取')
has(page, /scrollTop/, '分頁狀態保存捲動')
has(page, /searchFilters|fromMs|toMs/, '分頁狀態保存搜尋篩選')
has(page, /navSeq/, '導航有 sequence guard')
// 切資料夾還在飛的時候 cwd 還是舊的，監看事件拿舊 cwd 重讀會把切換蓋回去
has(page, /navTarget/, '監看事件比的是要去的資料夾，不是舊 cwd')
has(page, /searchSeq/, '搜尋有 sequence guard')

// 雙欄不可共用一個永久 secondPane；必須依 tab/panel id 保存與還原。
has(page, /(secondPaneBy|secondPaneStates|paneStates|panelStates|panelStateBy|panesByTab)/,
  '雙欄狀態依 tab／panel id 保存')

has(page, /fromMs/, 'renderer 送出日期起點')
has(page, /toMs/, 'renderer 送出日期終點')
has(index, /exSearch(?:From|To|Date)/, '畫面有日期篩選欄位')

// 捲到已經載好的頁面時仍要重畫，不然虛擬清單會一直停在最初那幾列。
has(page, /if \(!pending\.length\) \{[\s\S]{0,200}paintList\(\)/,
  '捲到已載入的頁面也會重畫可見列')

// helper 本身仍應保留純函式 contract，避免 wiring 測試只通過巧合文字。
has(browse, /export function mergeBrowsePage/, 'helper 保留 merge API')
has(browse, /export function visibleBrowseRange/, 'helper 保留 virtual range API')
has(browse, /export function pageOffsetsForRange/, 'helper 保留補頁 API')
has(browse, /export function selectBrowseRange/, 'helper 保留跨頁選取 API')

if (failures.length) {
  console.error(`FAIL: explorer renderer wiring (${failures.length})`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log('PASS: explorer renderer wiring uses paged loading, visible rows, per-panel state, filters, and stale guards')
}
