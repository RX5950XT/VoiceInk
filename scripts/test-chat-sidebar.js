/**
 * chat-sidebar.js 的改名輸入框回歸：IME 選字期間的 Enter 不得送出改名。
 * 只載入 startRename，不啟動 renderer 或 Electron。
 */
const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const file = path.join(__dirname, '..', 'src/renderer/scripts/chat-sidebar.js')
const source = fs.readFileSync(file, 'utf8')
const start = source.indexOf('  function startRename(')
const endMatch = /\r?\n  \/\*\*\r?\n   \* 刪除的二次確認/.exec(source.slice(start))
const end = endMatch ? start + endMatch.index : -1
assert(start >= 0 && end > start, '找不到 startRename 函式')
const functionSource = source.slice(start, end).replace('  function startRename(', 'function startRename(')

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName
    this.listeners = new Map()
    this.parentElement = { querySelector: () => null }
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener)
  }

  setAttribute() {}

  dispatch(type, event) {
    return this.listeners.get(type)?.(event)
  }

  replaceWith(element) {
    this.replacedWith = element
  }

  focus() {}
  select() {}
}

const document = { createElement: (tagName) => new FakeElement(tagName) }
let renderCount = 0
const context = { document, renderPending: false, render: () => { renderCount++ } }
vm.runInNewContext(`${functionSource}\nthis.startRename = startRename`, context)

async function renameWithKeydown(props) {
  const text = new FakeElement('span')
  const commits = []
  context.startRename(text, '舊名稱', 40, async (next) => { commits.push(next) })
  const input = text.replacedWith
  input.value = '新名稱'
  let prevented = false
  input.dispatch('keydown', {
    key: 'Enter',
    preventDefault: () => { prevented = true },
    ...props
  })
  await Promise.resolve()
  return { commits, prevented, input, text }
}

async function run() {
  for (const props of [{ isComposing: true }, { isComposing: false, keyCode: 229 }]) {
    const result = await renameWithKeydown(props)
    assert.deepEqual(result.commits, [])
    assert.equal(result.prevented, false)
    assert.equal(result.input.replacedWith, undefined)
  }
  const normal = await renameWithKeydown({ isComposing: false, keyCode: 13 })
  assert.deepEqual(normal.commits, ['新名稱'])
  assert.equal(normal.prevented, true)
  assert.equal(normal.input.replacedWith, normal.text)
  assert.equal(renderCount, 0)
  console.log('PASS: chat-sidebar 改名在 IME Enter 不送出，普通 Enter 仍送出')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
