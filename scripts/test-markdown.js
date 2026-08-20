/**
 * markdown.js 自檢（node 直跑，零依賴）
 *   node scripts/test-markdown.js
 *
 * markdown.js 是 ESM 而專案 package.json 無 type:module，
 * 直接 import 會被 node 當 CJS 解析而炸；改用 vm 載入原始碼 + DOM shim。
 * shim 的 innerHTML 是會丟例外的 setter → 只要 markdown.js 用到就當場失敗。
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

// ===== 極簡 DOM shim =====

function textNode(data) {
  return { nodeType: 3, data: String(data) }
}

function makeNode(tag) {
  const node = {
    nodeType: tag === '#fragment' ? 11 : 1,
    tagName: tag.toUpperCase(),
    className: '',
    attributes: {},
    childNodes: [],
    appendChild(child) {
      this.childNodes.push(child)
      return child
    },
    setAttribute(key, value) {
      this.attributes[key] = String(value)
    }
  }
  Object.defineProperty(node, 'textContent', {
    get() {
      return textOf(this)
    },
    set(value) {
      this.childNodes = [textNode(value)]
    }
  })
  // 用到 innerHTML 就當場炸 → 「零 innerHTML」是可執行的斷言，不是註解
  Object.defineProperty(node, 'innerHTML', {
    get() {
      throw new Error('markdown.js 讀了 innerHTML')
    },
    set() {
      throw new Error('markdown.js 寫了 innerHTML')
    }
  })
  return node
}

const documentShim = {
  createElement: (tag) => makeNode(tag),
  createTextNode: (t) => textNode(t),
  createDocumentFragment: () => makeNode('#fragment')
}

function textOf(node) {
  if (node.nodeType === 3) return node.data
  if (node.tagName === 'BR') return '\n'
  return node.childNodes.map(textOf).join('')
}

function findAll(node, tagName) {
  const out = []
  const walk = (n) => {
    if (n.nodeType !== 3 && n.tagName === tagName.toUpperCase()) out.push(n)
    if (n.childNodes) n.childNodes.forEach(walk)
  }
  walk(node)
  return out
}

function findByClass(node, cls) {
  const out = []
  const walk = (n) => {
    if (n.nodeType !== 3 && String(n.className).split(/\s+/).includes(cls)) out.push(n)
    if (n.childNodes) n.childNodes.forEach(walk)
  }
  walk(node)
  return out
}

// ===== 載入受測模組 =====

const src = fs
  .readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'scripts', 'markdown.js'), 'utf8')
  .replace(/^export /gm, '')
const sandbox = { document: documentShim }
vm.createContext(sandbox)
vm.runInContext(`${src}\n;globalThis.__render = renderMarkdown;`, sandbox)
/** @type {(text: string) => any} */
const renderMarkdown = sandbox.__render

// ===== 測試 =====

let passed = 0
let failed = 0

function check(name, fn) {
  try {
    fn()
    passed++
    console.log(`  PASS  ${name}`)
  } catch (e) {
    failed++
    console.log(`  FAIL  ${name}\n        ${e.message}`)
  }
}

console.log('\n[A] XSS / 注入')

check('img onerror 不產生 IMG 元素，只留文字', () => {
  const frag = renderMarkdown('看這個 <img src=x onerror=alert(1)> 好嗎')
  assert.strictEqual(findAll(frag, 'img').length, 0)
  assert.ok(textOf(frag).includes('<img src=x onerror=alert(1)>'))
})

check('script 標籤不產生 SCRIPT 元素', () => {
  const frag = renderMarkdown('<script>alert(1)</script>')
  assert.strictEqual(findAll(frag, 'script').length, 0)
  assert.ok(textOf(frag).includes('<script>alert(1)</script>'))
})

check('javascript: 連結不產生 <a>，降級純文字', () => {
  const frag = renderMarkdown('[點我](javascript:alert(1))')
  assert.strictEqual(findAll(frag, 'a').length, 0)
  assert.ok(textOf(frag).includes('javascript:alert(1)'))
})

check('data: 連結不產生 <a>', () => {
  const frag = renderMarkdown('[x](data:text/html;base64,PHNjcmlwdD4=)')
  assert.strictEqual(findAll(frag, 'a').length, 0)
})

check('https 連結產生 <a> 並帶 noopener noreferrer', () => {
  const frag = renderMarkdown('[範例](https://example.com/a?b=1)')
  const links = findAll(frag, 'a')
  assert.strictEqual(links.length, 1)
  assert.strictEqual(links[0].attributes.href, 'https://example.com/a?b=1')
  assert.strictEqual(links[0].attributes.rel, 'noopener noreferrer')
  assert.strictEqual(links[0].attributes.target, '_blank')
  assert.strictEqual(textOf(links[0]), '範例')
})

check('mailto 連結允許', () => {
  assert.strictEqual(findAll(renderMarkdown('[m](mailto:a@b.c)'), 'a').length, 1)
})

console.log('\n[B] 區塊語法')

check('圍欄碼塊：語言標籤、複製鈕、內容不再解析行內語法', () => {
  const frag = renderMarkdown('```js\nconst a = **1**\n```')
  const boxes = findByClass(frag, 'md-code')
  assert.strictEqual(boxes.length, 1)
  assert.strictEqual(findByClass(frag, 'md-code-lang')[0].textContent, 'js')
  assert.strictEqual(findByClass(frag, 'md-copy').length, 1)
  assert.strictEqual(findAll(frag, 'strong').length, 0)
  assert.strictEqual(textOf(findAll(frag, 'code')[0]), 'const a = **1**')
})

check('串流中未封閉的碼塊不丟例外，標記 md-code-open', () => {
  const frag = renderMarkdown('說明：\n```python\nprint(1)')
  assert.strictEqual(findByClass(frag, 'md-code-open').length, 1)
  assert.ok(textOf(frag).includes('print(1)'))
})

check('無語言的碼塊標 text', () => {
  const frag = renderMarkdown('```\nplain\n```')
  assert.strictEqual(findByClass(frag, 'md-code-lang')[0].textContent, 'text')
})

check('表格：thead 1 列、tbody 2 列、對齊 class', () => {
  const md = '| 名稱 | 數量 |\n|:---|---:|\n| a | 1 |\n| b | 2 |'
  const frag = renderMarkdown(md)
  assert.strictEqual(findAll(frag, 'table').length, 1)
  assert.strictEqual(findAll(frag, 'th').length, 2)
  assert.strictEqual(findAll(frag, 'td').length, 4)
  assert.strictEqual(findAll(frag, 'th')[1].className, 'md-right')
  assert.strictEqual(textOf(findAll(frag, 'td')[0]), 'a')
})

check('--- 是分隔線，不是表格', () => {
  const frag = renderMarkdown('上\n\n---\n\n下')
  assert.strictEqual(findAll(frag, 'hr').length, 1)
  assert.strictEqual(findAll(frag, 'table').length, 0)
})

check('標題層級正確、行內語法生效', () => {
  const frag = renderMarkdown('### 標題 **粗**')
  assert.strictEqual(findAll(frag, 'h3').length, 1)
  assert.strictEqual(findAll(frag, 'strong').length, 1)
})

check('無序與有序清單，ol 帶 start', () => {
  const ul = renderMarkdown('- a\n- b\n- c')
  assert.strictEqual(findAll(ul, 'ul').length, 1)
  assert.strictEqual(findAll(ul, 'li').length, 3)
  const ol = renderMarkdown('3. x\n4. y')
  assert.strictEqual(findAll(ol, 'ol')[0].attributes.start, '3')
  assert.strictEqual(findAll(ol, 'li').length, 2)
})

check('引用可遞迴，深層不爆堆疊', () => {
  const frag = renderMarkdown('> 一層\n> > 二層')
  assert.ok(findAll(frag, 'blockquote').length >= 1)
  assert.doesNotThrow(() => renderMarkdown('> > > > > > 深'))
})

check('段落內換行變 <br>', () => {
  const frag = renderMarkdown('第一行\n第二行')
  assert.strictEqual(findAll(frag, 'p').length, 1)
  assert.strictEqual(findAll(frag, 'br').length, 1)
})

console.log('\n[C] 行內語法')

check('行內碼優先於粗體', () => {
  const frag = renderMarkdown('`**不是粗體**`')
  assert.strictEqual(findAll(frag, 'strong').length, 0)
  assert.strictEqual(textOf(findAll(frag, 'code')[0]), '**不是粗體**')
})

check('粗體 / 斜體 / 刪除線', () => {
  const frag = renderMarkdown('**粗** *斜* ~~刪~~')
  assert.strictEqual(findAll(frag, 'strong').length, 1)
  assert.strictEqual(findAll(frag, 'em').length, 1)
  assert.strictEqual(findAll(frag, 'del').length, 1)
})

check('snake_case 不會被誤判成斜體', () => {
  const frag = renderMarkdown('變數 foo_bar_baz 與 my_var_name 保持原樣')
  assert.strictEqual(findAll(frag, 'em').length, 0)
  assert.ok(textOf(frag).includes('foo_bar_baz'))
})

check('乘法星號不會被誤判成斜體', () => {
  const frag = renderMarkdown('2 * 3 * 4 = 24')
  assert.strictEqual(findAll(frag, 'em').length, 0)
})

console.log('\n[D] 邊界輸入')

check('null / undefined / 空字串不丟例外', () => {
  assert.doesNotThrow(() => renderMarkdown(null))
  assert.doesNotThrow(() => renderMarkdown(undefined))
  assert.strictEqual(renderMarkdown('').childNodes.length, 0)
})

check('CRLF 正規化', () => {
  const frag = renderMarkdown('a\r\n\r\nb')
  assert.strictEqual(findAll(frag, 'p').length, 2)
})

check('未配對的標記原樣輸出', () => {
  const frag = renderMarkdown('這裡有 ** 和 ` 沒配對')
  assert.strictEqual(findAll(frag, 'strong').length, 0)
  assert.strictEqual(findAll(frag, 'code').length, 0)
  assert.ok(textOf(frag).includes('**'))
})

check('長輸入（5000 行）在 2 秒內完成', () => {
  const big = Array.from({ length: 5000 }, (_, i) => `第 ${i} 行 **粗體** 與 \`碼\``).join('\n')
  const t0 = Date.now()
  renderMarkdown(big)
  assert.ok(Date.now() - t0 < 2000, `耗時 ${Date.now() - t0}ms`)
})

console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILED'}  ${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
