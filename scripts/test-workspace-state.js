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
    disposeModel: noop, revealLine: noop, cursorInfo: () => null, currentValue: () => null,
    pushValue: noop, showDiff: noop,
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
  console.log('PASS 專案切換隔離、空草稿還原、同專案不重載、切分頁通知檔案樹')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
