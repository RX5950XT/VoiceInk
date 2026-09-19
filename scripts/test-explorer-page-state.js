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
vm.runInContext(fs.readFileSync('src/renderer/scripts/explorer-dnd.js', 'utf8').replace(/^import.*\r?\n/gm, '').replace(/^export /gm, ''), context)
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
  api.unwatch = async () => ({ ok: true })
  api.driveInfo = () => new Promise(resolve => { pending.drive = resolve })
  run("tabs = [{ id: 't1', cwd, history, histIndex }]; activeId = 't1'; tabSeq = 1")
  const home = run('newTab()')
  await Promise.resolve()
  const backToFirst = run("switchTab('t1')")
  pending.B({ ok: true, data: { path: 'B', entries: [] } })
  await backToFirst
  pending.drive({ ok: true, data: [] })
  await home
  assert.equal(run('JSON.stringify(history)'), '["B"]', '首頁容量晚到不能污染另一分頁歷史')
  assert.equal(run("JSON.stringify(tabs[1].history)"), '["thispc"]', '首頁歷史不等容量查詢')
  await run("closeTab('t2')")
  assert.equal(run('tabs.length'), 1)
  let pasted = false
  api.paste = async () => { pasted = true; return { ok: true } }
  run("cwd = 'thispc'")
  await run('pasteHere()')
  assert.equal(pasted, false, '本機首頁不是可以貼上檔案的資料夾')
  run("cwd = 'B'; tabs = [{ id: 't1', cwd: 'B', history: ['B'], histIndex: 0 }]; activeId = 't1'; history = tabs[0].history; histIndex = 0")
  const slow = run("navigate('slow')")
  const another = run("newTab('C')")
  pending.C({ ok: true, data: { path: 'C', entries: [] } })
  await another
  pending.slow({ ok: true, data: { path: 'slow', entries: [] } })
  await slow
  assert.equal(run('cwd'), 'C', '舊分頁讀取晚到不能取代新分頁')
  assert.equal(run('JSON.stringify(tabs[0].history)'), '["B"]')
  const closed = run('closeTab(activeId)')
  pending.B({ ok: true, data: { path: 'B', entries: [] } })
  await closed
  assert.equal(run('cwd'), 'B', '關掉目前分頁回到鄰近分頁')
  const badHistory = run("history = ['missing', 'B']; histIndex = 1; goHistory(-1)")
  pending.missing({ ok: false, error: { message: 'missing' } })
  await badHistory
  assert.equal(run('histIndex'), 1, '上一頁載入失敗要保留原歷史位置')
  console.log('PASS: search invalidation, independent tabs/history, stale home/directory replies, close tab, home paste guard, failed history, list header')
})().catch(error => { console.error(error); process.exitCode = 1 })
