'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

/** 真正的 renderer 狀態流程；只有 IPC 與畫面容器換成小型測試替身。 */
async function main() {
  const saved = new Map()
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/scripts/ws-tabs.js'), 'utf8')
    .replace(/^import [\s\S]*?from '[^']*'$/gm, '')
    .replace(/^export /gm, '').replaceAll('import.meta.url', "'file:///test.js'")
  let finishWrite
  const editor = { value: 'saving' }
  /** 切分頁時發給檔案樹的通知（workspace-page 用它標出「現在開的是哪一個檔案」） */
  const activeFileEvents = []
  const noop = () => {}
  const context = { console, URL, editor, showToast: noop, setChatPaneMode: noop,
    // 被剝掉的那些 import 都要有替身。Monaco 那組一律回「沒載到」，
    // 這支測的是狀態流程，不是編輯器本身。
    renderMarkdown: noop, showMenu: noop, updateGutter: noop, updateIdeStatus: noop,
    handleEditorKeydown: noop, initFindWidget: () => ({ openFind: noop, closeFind: noop }),
    parseUnifiedDiff: () => [], renderDiffLines: noop,
    loadMonaco: async () => null, ensureEditor: noop, showMonacoTab: noop, runAction: () => false,
    disposeModel: noop, retargetModel: noop, revealLine: noop, cursorInfo: () => null, currentValue: () => null,
    pushValue: noop, showDiff: noop,
    gitStatusShared: async () => ({ ok: false }), invalidateGitStatus: noop,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail } },
    document: { dispatchEvent: (event) => activeFileEvents.push(event) },
    window: { clearTimeout, setTimeout: () => 0 },
    electronAPI: { workspace: {
      saveTabsState: async (id, data) => { saved.set(id, data); return { ok: true } },
      getTabsState: async (id) => ({ ok: true, data: saved.get(id) }),
      readFile: async () => ({ ok: true, data: { content: 'disk', mtimeMs: 1 } }),
      getFileMtime: async () => ({ ok: true, data: { mtimeMs: 1 } })
      ,writeFile: () => new Promise((resolve) => { finishWrite = resolve })
    } } }
  vm.createContext(context)
  vm.runInContext(`${source}\nthis.api = { setActiveProject, persistTabsNow,
    seed: () => { project = {id:'A'}; tabs = [{id:'e:A:a.txt',kind:'editor',projectId:'A',relPath:'a.txt',content:'',dirty:true}]; activeId=tabs[0].id },
    saveActiveFile,
    openEditorTab,
    retargetTabs,
    edit: (value) => { el.editorText = editor; editor.value = value; tabs[0].content = value; tabs[0].dirty = true },
    state: () => ({project,tabs,activeId}) }`, context)
  context.api.seed()
  await context.api.setActiveProject({ id: 'B' })
  assert.equal(context.api.state().tabs.length, 0, '沒有分頁的新專案不可留下舊專案分頁')
  await context.api.setActiveProject({ id: 'A' })
  const restored = context.api.state().tabs[0]
  assert.equal(restored.content, '', '刪光內容的空草稿也要還原')
  assert.equal(restored.dirty, true)
  await context.api.setActiveProject({ id: 'A' })
  assert.equal(context.api.state().tabs[0], restored, '重按同一專案不能重建草稿')
  context.api.edit('saving')
  const saving = context.api.saveActiveFile()
  context.api.edit('new typing')
  finishWrite({ ok: true, data: { mtimeMs: 7 } })
  await saving
  assert.equal(restored.content, 'new typing', '存檔等待期間的輸入不可覆寫')
  assert.equal(restored.dirty, true)
  assert.equal(restored.savedContent, 'saving')
  vm.runInContext('el.editorText = null', context)
  await context.api.setActiveProject({ id: 'B' })
  context.electronAPI.workspace.readFile = async () => ({ ok: false })
  await context.api.setActiveProject({ id: 'A' })
  assert.equal(context.api.state().tabs[0]?.content, 'new typing', '磁碟檔案消失也不能丟掉草稿')
  const lastActive = activeFileEvents[activeFileEvents.length - 1]
  assert.equal(lastActive?.type, 'ws:active-file', '切分頁要通知檔案樹目前開著哪個檔案')
  assert.deepEqual({ ...lastActive.detail }, { projectId: 'A', rel: 'a.txt' })
  // ── 開分頁途中被切走：那份結果要作廢 ──
  // 開一個分頁至少要等一次 IPC。回來照樣 push 的話，B 專案的分頁列上會冒出 A 的檔案。
  let finishRead
  context.electronAPI.workspace.readFile = () => new Promise((resolve) => { finishRead = resolve })
  await context.api.setActiveProject({ id: 'A' })
  const opening = context.api.openEditorTab({ id: 'A', name: 'A' }, 'slow.txt')
  await context.api.setActiveProject({ id: 'B' })
  finishRead({ ok: true, data: { content: 'A 的內容', mtimeMs: 1 } })
  await opening
  assert.equal(
    context.api.state().tabs.some((t) => t.relPath === 'slow.txt'), false,
    '切到別的專案之後，慢回應不可以把 A 的檔案塞進 B 的分頁列'
  )

  // ── 連點同一個檔案不可以開出兩份 ──
  context.electronAPI.workspace.readFile = async () => ({ ok: true, data: { content: 'x', mtimeMs: 1 } })
  await context.api.setActiveProject({ id: 'A' })
  await Promise.all([
    context.api.openEditorTab({ id: 'A', name: 'A' }, 'twice.txt'),
    context.api.openEditorTab({ id: 'A', name: 'A' }, 'twice.txt')
  ])
  assert.equal(
    context.api.state().tabs.filter((t) => t.relPath === 'twice.txt').length, 1,
    '連點同一個檔案只能有一個分頁'
  )

  // ── 改名之後分頁要接到新路徑（不接的話存檔會把舊檔重新建出來）──
  await context.api.openEditorTab({ id: 'A', name: 'A' }, 'dir/old.txt')
  context.api.retargetTabs('A', 'dir/old.txt', 'dir/new.txt')
  const moved = context.api.state().tabs.find((t) => t.relPath === 'dir/new.txt')
  assert.ok(moved, '改名後分頁要指向新路徑')
  assert.equal(moved.id, 'e:A:dir/new.txt', '分頁 id 也要跟著換')
  assert.equal(moved.title, 'new.txt', '標題要換成新名字')
  // 資料夾改名：底下每一個開著的檔案都要跟著換
  await context.api.openEditorTab({ id: 'A', name: 'A' }, 'dir/child.txt')
  context.api.retargetTabs('A', 'dir', 'renamed')
  assert.ok(
    context.api.state().tabs.some((t) => t.relPath === 'renamed/child.txt'),
    '資料夾改名要連子檔案的分頁一起換'
  )

  // ── 存檔被擋下來（外部改過）：草稿一個字都不能動 ──
  const target = context.api.state().tabs.find((t) => t.relPath === 'renamed/child.txt')
  vm.runInContext("activeId = tabs.find((t) => t.relPath === 'renamed/child.txt').id", context)
  context.api.edit = (value) => {
    vm.runInContext(`el.editorText = editor; editor.value = ${JSON.stringify(value)}`, context)
  }
  context.api.edit('我打的內容')
  target.content = '我打的內容'
  context.electronAPI.workspace.writeFile = async () => (
    { ok: false, error: { code: 'STALE', message: '這個檔案在外部被改過了' } }
  )
  await context.api.saveActiveFile()
  assert.equal(target.dirty, true, '存檔被擋下來時草稿仍然是未存狀態')
  assert.equal(target.content, '我打的內容', '被擋下來不可以動到草稿內容')

  console.log('PASS 專案切換隔離、空草稿還原、同專案不重載、切分頁通知檔案樹、慢回應作廢、改名接軌、存檔守衛')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
