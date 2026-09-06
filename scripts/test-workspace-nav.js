'use strict'
/**
 * 檔案樹鍵盤導覽 ＋ 快速開檔排序（node 直跑）
 *   node scripts/test-workspace-nav.js
 *
 * 兩支都是 renderer 的 ESM，而專案沒有 type:module → 照 test-workspace-editor.js
 * 的做法用 vm 載原始碼，把 `export`／`import` 兩行剝掉再跑。
 * DOM 用最小 shim：只要被測的程式碼多碰一個真 DOM API 就會當場失敗。
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')

/**
 * @param {string} relFile
 * @param {object} context
 * @param {string} tail 額外跑的一行（把 module 內部的東西掛到 context 上）
 * @param {string} head 被剝掉的 import 要補的替身
 */
function load(relFile, context, tail, head = '') {
  const source = fs.readFileSync(path.join(ROOT, relFile), 'utf8')
    .replace(/^import[\s\S]*?from '[^']+'\n/gm, '')
    .replace(/^export /gm, '')
  vm.createContext(context)
  vm.runInContext(`${head}\n${source}\n;${tail}`, context)
}

// ===== [A] 快速開檔的模糊排序 =====

const qo = {}
load('src/renderer/scripts/ws-quickopen.js', qo,
  'this.rank = rankPaths; this.score = scorePath; this.prep = prepare')

const files = [
  'src/main/workspace/index.js',
  'src/renderer/scripts/workspace-page.js',
  'src/main/workspace/store.js',
  'docs/workspace-notes.md',
  'src/main/sysmon/index.js'
].map(qo.prep)

let ranked = qo.rank('wsindex', files)
assert.equal(ranked[0], 'src/main/workspace/index.js',
  '路徑片段跳著打也要找得到，而且最貼的那筆要排第一')

ranked = qo.rank('store', files)
assert.equal(ranked[0], 'src/main/workspace/store.js', '檔名本身命中要壓過只在路徑上命中的')

ranked = qo.rank('index.js', files)
assert.ok(ranked.includes('src/main/sysmon/index.js') && ranked.includes('src/main/workspace/index.js'),
  '同名檔案兩筆都要列出來')

assert.equal(qo.rank('zzzz', files).length, 0, '完全對不上就是空清單')
assert.equal(qo.rank('', files).length, files.length, '沒打字時列全部（未超過上限）')

// -1 不可以被當成「沒有命中」的哨兵：真的算得出 -1 分
const negativeOne = qo.score('c', 'abc', 'abc')
assert.notEqual(negativeOne, null, 'lowerName 含 query 時仍是一筆命中')
assert.equal(qo.score('q', 'abc', 'abc'), null, '對不上要回 null，不是回 -1')

// ===== [B] 檔案樹的鍵盤導覽 =====

/**
 * 一列 = 一個假的 button。`click` 直接呼叫我們登記的 handler。
 * @param {{ rel: string, depth: number, dir?: boolean, open?: boolean }} spec
 */
function makeRow(spec) {
  const classes = new Set(['ws-tree-row'])
  if (spec.open) classes.add('is-open')
  const attrs = spec.dir ? { 'aria-expanded': spec.expanded ? 'true' : 'false' } : {}
  return {
    dataset: { rel: spec.rel, depth: String(spec.depth), ...(spec.dir ? { dir: '1' } : {}) },
    tabIndex: -1,
    focused: false,
    clicked: 0,
    classList: {
      add: (name) => classes.add(name),
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
      contains: (name) => classes.has(name)
    },
    getAttribute: (name) => attrs[name] ?? null,
    setAttribute: (name, value) => { attrs[name] = value },
    focus() { this.focused = true; page.doc.activeElement = this },
    click() { this.clicked += 1 },
    scrollIntoView() {},
    closest(sel) { return sel === '.ws-tree-row' ? this : null }
  }
}

const rows = [
  makeRow({ rel: 'src', depth: 0, dir: true, expanded: true }),
  makeRow({ rel: 'src/a.js', depth: 1 }),
  makeRow({ rel: 'src/sub', depth: 1, dir: true }),
  makeRow({ rel: 'README.md', depth: 0 })
]

const page = {
  doc: { activeElement: null },
  console,
  window: { clearTimeout: () => {}, setTimeout: () => 0 },
  setTimeout: () => 0,
  clearTimeout: () => {}
}
page.document = {
  get activeElement() { return page.doc.activeElement },
  getElementById: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {}
}
// 被剝掉的 import 全部給一個什麼都不做的替身；這一段只驗鍵盤導覽，
// 真的碰到別的模組就代表測試寫錯了（會當場 TypeError，不會靜靜通過）。
const stubs = ['electronAPI', 'showToast', 'setChatPaneMode', 'createListReorder', 'initWsTabs',
  'openEditorTab', 'openDiffTab', 'openBrowserTab', 'openAiSessionTab', 'setActiveProject',
  'newTerminalWithCommand', 'closeActiveTab', 'cycleTab', 'showMenu', 'openQuickOpen',
  'isQuickOpenOpen'].map((name) => `const ${name} = () => ({})`).join('\n')
load('src/renderer/scripts/workspace-page.js', page,
  'this.el = el; this.onKey = onTreeKeydown; this.reset = resetTreeCursor', stubs)
page.el.tree = { querySelectorAll: (sel) => (sel === '.ws-tree-row' ? rows : []) }

/** @param {string} key */
const press = (key, extra = {}) => {
  let prevented = false
  page.onKey({ key, preventDefault: () => { prevented = true }, ...extra })
  return prevented
}

page.doc.activeElement = rows[0]
assert.ok(press('ArrowDown'), '方向鍵要吃掉預設行為（不然整個面板會跟著捲）')
assert.equal(page.doc.activeElement, rows[1], '↓ 走到下一列')

press('ArrowUp')
assert.equal(page.doc.activeElement, rows[0], '↑ 走回上一列')

press('End')
assert.equal(page.doc.activeElement, rows[3], 'End 跳到最後一列')

press('Home')
assert.equal(page.doc.activeElement, rows[0], 'Home 跳回第一列')

// roving tabindex：只有一列可以用 Tab 進來
assert.equal(rows.filter((row) => row.tabIndex === 0).length, 1, '整棵樹只能有一列 tabindex=0')

// → 在已展開的資料夾上是「走進第一個子項」，不是再展開一次
page.doc.activeElement = rows[0]
press('ArrowRight')
assert.equal(rows[0].clicked, 0, '已展開的資料夾按 → 不可以再切換一次（會變成收起來）')
assert.equal(page.doc.activeElement, rows[1], '→ 走進第一個子項')

// → 在收合的資料夾上＝展開
page.doc.activeElement = rows[2]
press('ArrowRight')
assert.equal(rows[2].clicked, 1, '收合的資料夾按 → 要展開')

// ← 在子項上＝退回父層（不是走上一列）
page.doc.activeElement = rows[1]
press('ArrowLeft')
assert.equal(page.doc.activeElement, rows[0], '← 從子項退回父資料夾')

// ← 在展開中的資料夾上＝收合
page.doc.activeElement = rows[0]
press('ArrowLeft')
assert.equal(rows[0].clicked, 1, '← 在展開中的資料夾上要收合')

// 沒有按到方向鍵時不可以吃掉事件（打字還要用）
assert.equal(press('a'), false, '一般按鍵不可以被攔截')

console.log('PASS 快速開檔排序、檔案樹鍵盤導覽、roving tabindex')
