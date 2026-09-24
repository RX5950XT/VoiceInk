'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

async function main() {
  for (const [file, name] of [['workspace-page.js', 'startRename'], ['ws-tabs.js', 'startTabRename']]) {
    const source = fs.readFileSync(path.join(__dirname, '../src/renderer/scripts', file), 'utf8')
    const section = source.slice(source.indexOf(`function ${name}(`))
    const handler = section.match(/input.addEventListener\('keydown', \(event\) => \{[\s\S]*?\r?\n  \}\)/)[0]
    let keydown
    let actions = 0
    vm.runInNewContext(handler, { input: { addEventListener(type, fn) { keydown = fn } }, finish() { actions++ } })
    for (const props of [{ isComposing: true }, { keyCode: 229 }]) {
      keydown({ key: 'Enter', ...props, preventDefault() {}, stopPropagation() {} })
      assert.equal(actions, 0, `${file} 選字時不能完成改名`)
    }
    keydown({ key: 'Enter', preventDefault() {}, stopPropagation() {} })
    assert.equal(actions, 1)
  }
  for (const [file, handler, setup] of [
    ['ws-quickopen.js', 'onKeydown', 'pick = close = paintCursor = touched; shown = ["a", "b"]; cursor = 0'],
    ['explorer-page.js', 'onPathKey', 'endEditPath = goToTyped = touched']
  ]) {
    let actions = 0
    const env = { touched() { actions++ } }
    vm.createContext(env)
    const source = fs.readFileSync(path.join(__dirname, '../src/renderer/scripts', file), 'utf8')
      .replace(/^import[\s\S]*?from '[^']+'\r?\n/gm, '').replace(/^export /gm, '')
    vm.runInContext(source, env)
    vm.runInContext(setup, env)
    for (const key of ['Enter', 'Escape', 'ArrowDown']) {
      for (const props of [{ isComposing: true }, { keyCode: 229 }]) {
        env[handler]({ key, ...props, preventDefault() {}, target: { value: '中文' } })
        assert.equal(actions, 0, `${file} 組字時 ${key} 不得觸發導覽`)
      }
    }
    env[handler]({ key: 'Enter', preventDefault() {}, target: { value: '中文' } })
    assert.ok(actions > 0, `${file} 組字結束後可正常導覽`)
  }
  // Enter 由 openDialog 掛在 dialog 上的 capture 監聽統一處理，所以用真的 openDialog 跑
  let input
  let dialog
  function node(tag) {
    const listeners = {}
    return {
      tagName: tag.toUpperCase(), value: '', returnValue: '',
      appendChild() {}, setAttribute() {}, focus() {}, select() {}, remove() {}, showModal() {},
      querySelector() { return null },
      addEventListener(type, fn) { listeners[type] = fn },
      fire(type, event) { listeners[type]?.(event) },
      close(value) { this.returnValue = value; this.closed = (this.closed || 0) + 1; this.fire('close') }
    }
  }
  const context = {
    document: {
      body: { appendChild() {} },
      createElement(tag) {
        const made = node(tag)
        if (tag === 'input') input = made
        if (tag === 'dialog') dialog = made
        return made
      }
    }
  }
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/scripts/app-dialog.js'), 'utf8')
    .replace(/^export /gm, ''), context)
  const answer = context.askInput('重新命名')
  for (const event of [{ isComposing: true }, { isComposing: false, keyCode: 229 }]) {
    dialog.fire('keydown', { key: 'Enter', target: input, preventDefault() {}, ...event })
    assert.equal(dialog.closed || 0, 0, '選中文字時 Enter 不得提交或關閉輸入框')
  }
  input.value = '中文檔名'
  dialog.fire('keydown', { key: 'Enter', isComposing: false, keyCode: 13, target: input, preventDefault() {} })
  assert.equal(await answer, '中文檔名')
  assert.equal(dialog.closed, 1)
  console.log('PASS 輸入彈窗組字 Enter 保留、組字完成後 Enter 提交')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
