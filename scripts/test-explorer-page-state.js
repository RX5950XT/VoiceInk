const fs = require('fs')
const vm = require('vm')
const assert = require('assert/strict')
const source = fs.readFileSync('src/renderer/scripts/explorer-page.js', 'utf8').replace(/^import[\s\S]*?from '[^']+'\r?\n/gm, '').replace(/^export /gm, '')
const input = { value: 'old' }
const head = { hidden: false, querySelectorAll: () => [] }
const pending = {}
const api = { uffsSearch: () => new Promise(resolve => { pending.search = resolve }), listDir: path => new Promise(resolve => { pending[path] = resolve }), watch: async () => ({ ok: true, data: {} }), saveState: async () => {}, uffsCancel: async () => {} }
const context = { console, setTimeout, clearTimeout, document: { getElementById: id => id === 'exSearch' ? input : id === 'exListHead' ? head : null }, electronAPI: { explorer: api }, showToast: () => {} }
vm.createContext(context)
vm.runInContext(source, context)
const run = code => vm.runInContext(code, context)
run('paintList=paintStatus=paintCrumbs=paintNav=paintSidebar=paintRecycleChrome=()=>{}')
;(async () => {
  const search = run("runSearch('old')")
  input.value = 'new'
  run('onSearchInput()')
  pending.search({ ok: true, data: { hits: [{ name: 'old-result' }] } })
  await search
  assert.equal(run('hits.length'), 0, '修改搜尋字串後，舊回覆不得寫入')
  const a = run("navigate('A')")
  const b = run("navigate('B')")
  pending.B({ ok: true, data: { path: 'B', entries: [] } })
  await b
  pending.A({ ok: true, data: { path: 'A', entries: [] } })
  await a
  assert.equal(run('JSON.stringify(history)'), '["B"]', '過期導航不得新增歷史')
  run("setView('grid'); paintSortHead(); setView('list')")
  assert.equal(head.hidden, false, '切回清單必須恢復排序列')
  console.log('PASS: search invalidation, navigation history, list sort header')
})().catch(error => { console.error(error); process.exitCode = 1 })
