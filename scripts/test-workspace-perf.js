'use strict'
/**
 * 大檔案不卡頓的幾條保證，全是純函式層級跑得完的。
 *
 * 這裡量的不是「有沒有畫出來」而是「有沒有重做」：
 * 切回同一個分頁不可以再建一次 model、再解析一次整份檔案。
 * 舊版每次切回 diff 分頁都重建兩顆 model（Monaco 得重新斷行＋重算差異），
 * 大檔案就是這樣一切分頁就停半秒。
 *
 * 用法：node scripts/test-workspace-perf.js
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

let passed = 0
function ok(label) {
  passed += 1
  console.log(`  PASS ${label}`)
}

/**
 * 把一支 renderer 的 ESM 剝成可以在 vm 裡跑的形狀。
 * @param {string} rel
 * @returns {string}
 */
function readModule(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')
    .replace(/^import [\s\S]*?from '[^']*'$/gm, '')
    .replace(/^export /gm, '')
    .replaceAll('import.meta.url', "'file:///test.js'")
}

/** 記帳用的假 monaco：只要能數出「建了幾顆 model」「setValue 幾次」就夠 */
function fakeMonaco(counters) {
  const makeModel = (value, language) => ({
    _value: value,
    _language: language,
    _disposed: false,
    getValue() { counters.getValue += 1; return this._value },
    setValue(next) { counters.setValue += 1; this._value = next },
    getLanguageId() { return this._language },
    getFullModelRange() { return {} },
    getLineCount() { return this._value.split('\n').length },
    isDisposed() { return this._disposed },
    dispose() { counters.dispose += 1; this._disposed = true }
  })
  return {
    editor: {
      createModel(value, language) { counters.createModel += 1; return makeModel(value, language) },
      setModelLanguage(model, language) { counters.setLanguage += 1; model._language = language },
      create() { throw new Error('這支測試不建真的編輯器') },
      createDiffEditor() { throw new Error('這支測試不建真的編輯器') },
      defineTheme() {},
      setTheme() {}
    },
    languages: { getLanguages: () => [{ id: 'plaintext', extensions: ['.txt'] }] }
  }
}

function loadMonacoModule() {
  const counters = { createModel: 0, setValue: 0, getValue: 0, dispose: 0, setLanguage: 0 }
  const context = { console, URL, document: undefined, window: undefined }
  vm.createContext(context)
  vm.runInContext(`${readModule('src/renderer/scripts/ws-monaco.js')}
this.api = {
  showTab, showDiff, disposeModel, disposeModelsExcept, retargetModel,
  seedEditor: (fake) => { editor = fake },
  seedDiff: (fake) => { diffEditor = fake },
  models, diffModels
}`, context)
  return { api: context.api, counters }
}

// ── 編輯器分頁：切回來不重建、也不整份 getValue() 比對 ──
{
  const { api, counters } = loadMonacoModule()
  const monaco = fakeMonaco(counters)
  let attached = null
  api.seedEditor({
    getModel: () => attached,
    setModel: (m) => { attached = m },
    updateOptions: () => {}
  })

  const big = 'x'.repeat(4096)
  const tab = { id: 'e:A:big.txt', relPath: 'big.txt', content: big }
  api.showTab(monaco, tab)
  assert.equal(counters.createModel, 1, '第一次要建 model')
  const first = attached

  api.showTab(monaco, tab)
  api.showTab(monaco, tab)
  assert.equal(counters.createModel, 1, '同一個分頁切回來不可以重建 model')
  assert.equal(attached, first, '切回來要接回同一顆 model')
  assert.equal(counters.setValue, 0, '內容沒變不可以 setValue（復原歷程會被清掉）')
  assert.equal(counters.getValue, 0, '不可以靠 getValue() 比對——那是把整份檔案再複製一次')
  ok('編輯器分頁切回來：不重建、不 setValue、不整份比對')

  // 外部改過（磁碟重載）→ 這一次必須推進去
  tab.content = `${big}!`
  api.showTab(monaco, tab)
  assert.equal(counters.setValue, 1, '內容真的變了要推進 model')
  assert.equal(counters.createModel, 1, '推內容不必重建 model')
  ok('外部改過的內容照樣推得進去')
}

// ── diff 分頁：同一份切回來不重建兩顆 model ──
{
  const { api, counters } = loadMonacoModule()
  const monaco = fakeMonaco(counters)
  let pair = null
  api.seedDiff({ getModel: () => pair, setModel: (p) => { pair = p } })

  const data = { id: 'd:A:w:big.txt', relPath: 'big.txt', original: 'a\nb\nc', modified: 'a\nB\nc' }
  api.showDiff(monaco, {}, data)
  assert.equal(counters.createModel, 2, '第一次要建原始／修改兩顆')
  const before = pair

  api.showDiff(monaco, {}, data)
  api.showDiff(monaco, {}, data)
  assert.equal(counters.createModel, 2, '切回同一個 diff 分頁不可以重建 model（舊版每次都重建）')
  assert.equal(counters.dispose, 0, '沒重建就不該有東西被收掉')
  assert.equal(pair.original, before.original, '接回同一顆原始版 model')
  assert.equal(pair.modified, before.modified, '接回同一顆修改版 model')
  ok('diff 分頁切回來：不重建、不重算差異')

  // 內容真的變了（暫存、重新讀 git）→ 推進去但仍不重建
  api.showDiff(monaco, {}, { ...data, modified: 'a\nB\nc\nd' })
  assert.equal(counters.createModel, 2, '內容變了也不必重建')
  assert.equal(counters.setValue, 1, '只推變動的那一側')
  ok('diff 內容變了只推變動的那一側')

  // 分頁關掉 → 兩顆都要收
  api.disposeModel(data.id)
  assert.equal(counters.dispose, 2, '關掉 diff 分頁要把兩顆 model 都收掉')
  ok('關掉 diff 分頁兩顆 model 都收掉')
}

// ── 切專案：上一個專案的 model 不可以一直留著 ──
{
  const { api, counters } = loadMonacoModule()
  const monaco = fakeMonaco(counters)
  let attached = null
  let pair = null
  api.seedEditor({ getModel: () => attached, setModel: (m) => { attached = m }, updateOptions: () => {} })
  api.seedDiff({ getModel: () => pair, setModel: (p) => { pair = p } })

  api.showTab(monaco, { id: 'e:A:one.txt', relPath: 'one.txt', content: 'one' })
  api.showTab(monaco, { id: 'e:A:two.txt', relPath: 'two.txt', content: 'two' })
  api.showDiff(monaco, {}, { id: 'd:A:w:one.txt', relPath: 'one.txt', original: 'x', modified: 'y' })
  assert.equal(api.models.size, 2)
  assert.equal(api.diffModels.size, 1)

  // 切到 B 專案：分頁 id 一個都不留（id 內嵌 projectId，本來就不會相同）
  api.disposeModelsExcept([])
  assert.equal(api.models.size, 0, '上一個專案的編輯器 model 要收乾淨')
  assert.equal(api.diffModels.size, 0, '上一個專案的 diff model 也要收乾淨')
  assert.equal(counters.dispose, 4, '兩顆編輯器 model ＋ 一組 diff 兩顆')
  assert.equal(attached, null, '收掉的 model 不可以還掛在編輯器上')
  assert.equal(pair, null, '收掉的 model 不可以還掛在 diff 編輯器上')
  ok('切專案把上一個專案的 model 收乾淨')

  // 留下來的那些不可以被誤收
  api.showTab(monaco, { id: 'e:B:keep.txt', relPath: 'keep.txt', content: 'k' })
  api.showTab(monaco, { id: 'e:B:drop.txt', relPath: 'drop.txt', content: 'd' })
  const disposedBefore = counters.dispose
  api.disposeModelsExcept(['e:B:keep.txt'])
  assert.equal(counters.dispose, disposedBefore + 1, '只收沒留下來的那一顆')
  assert.equal(api.models.size, 1)
  ok('留下來的分頁不會被誤收')
}

// ── 改名／搬檔：diff 分頁的 model 也要跟著換鍵 ──
{
  const { api, counters } = loadMonacoModule()
  const monaco = fakeMonaco(counters)
  let pair = null
  api.seedDiff({ getModel: () => pair, setModel: (p) => { pair = p } })
  api.showDiff(monaco, {}, { id: 'd:A:w:old.txt', relPath: 'old.txt', original: 'a', modified: 'b' })
  api.retargetModel('d:A:w:old.txt', 'd:A:w:new.txt')
  assert.ok(api.diffModels.has('d:A:w:new.txt'), 'diff model 要跟著新的分頁 id 走')
  assert.equal(api.diffModels.has('d:A:w:old.txt'), false, '舊鍵要拿掉，不然沒人收得到')
  ok('改名後 diff model 跟著換鍵')
}

// ── 行號欄：行數沒變就不重組那一整欄 ──
{
  const context = { console }
  vm.createContext(context)
  vm.runInContext(`${readModule('src/renderer/scripts/ws-ide.js')}
this.api = { updateGutter }`, context)
  let writes = 0
  const gutter = {
    dataset: {},
    scrollTop: 0,
    set textContent(v) { writes += 1; this._t = v },
    get textContent() { return this._t }
  }
  const textarea = { value: 'a\nb\nc', scrollTop: 0 }
  context.api.updateGutter(textarea, gutter)
  assert.equal(writes, 1)
  assert.equal(gutter.textContent, '1\n2\n3\n')
  textarea.value = 'aa\nbb\ncc'
  context.api.updateGutter(textarea, gutter)
  assert.equal(writes, 1, '行數沒變不可以重組整欄行號')
  textarea.value = 'a\nb\nc\nd'
  context.api.updateGutter(textarea, gutter)
  assert.equal(writes, 2, '行數變了要重組')
  assert.equal(gutter.textContent, '1\n2\n3\n4\n')
  ok('行號欄只有行數變了才重組')
}

// ── 「＋」選單每一項都要有圖示 ──
{
  const context = {
    console,
    document: {
      createElementNS: (ns, name) => ({
        ns,
        name,
        children: [],
        classList: { list: [], add(c) { this.list.push(c) } },
        setAttribute() {},
        appendChild(child) { this.children.push(child) }
      })
    }
  }
  vm.createContext(context)
  vm.runInContext(`${readModule('src/renderer/scripts/ws-tool-icons.js')}
this.api = { toolIcon, stateIconName }`, context)

  const tabsSource = fs.readFileSync(path.join(__dirname, '../src/renderer/scripts/ws-tabs.js'), 'utf8')
  const block = tabsSource.slice(tabsSource.indexOf('const NEW_ITEMS'), tabsSource.indexOf('const NEW_ITEMS') + 600)
  const presets = [...block.matchAll(/preset: '([a-z]+)'/g)].map((m) => m[1])
  assert.ok(presets.length >= 6, `NEW_ITEMS 抓不到（抓到 ${presets.length} 項）`)
  for (const preset of [...presets, 'custom', 'browser']) {
    const svg = context.api.toolIcon(preset)
    assert.ok(svg, `${preset} 沒有對應的圖示`)
    assert.ok(svg.children.length > 0, `${preset} 的圖示是空的`)
  }
  assert.equal(context.api.toolIcon('沒這個'), null, '不認得的名字要回 null，不要塞空方框')
  ok(`「＋」選單 ${presets.length + 2} 個項目都有圖示`)

  // 側欄的狀態只剩圖示（沒有文字），對錯一個就等於在騙人：跑著的說跑完了、失敗的說成功。
  const cases = [
    [{ state: 'running' }, 'state-running'],
    [{ state: 'idle', exitCode: null }, 'state-idle'],
    [{ state: 'idle' }, 'state-idle'],
    [{ state: 'idle', exitCode: 0 }, 'state-done'],
    [{ state: 'idle', exitCode: 1 }, 'state-fail'],
    [{ state: 'exited', exitCode: 0 }, 'state-exited'],
    [{ state: 'stopped' }, 'state-exited']
  ]
  for (const [item, expected] of cases) {
    assert.equal(context.api.stateIconName(item), expected, `${JSON.stringify(item)} 應該畫 ${expected}`)
    assert.ok(context.api.toolIcon(expected), `${expected} 沒有對應的圖示`)
  }
  ok(`${cases.length} 種執行狀態各對到自己的圖示`)
}

console.log(`\n${passed} passed, 0 failed`)
