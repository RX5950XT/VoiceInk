'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const context = { Blob }
vm.createContext(context)
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/scripts/ws-ide.js'), 'utf8')
  .replace(/^export /gm, '') + '; this.init = initFindWidget', context)
let active
const node = (value = '') => ({ value, hidden: false, handlers: {},
  addEventListener(name, fn) { this.handlers[name] = fn }, focus() { active = this }, select() {},
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end } })
const textarea = node('Alpha ALPHA alpha')
textarea.selectionStart = textarea.selectionEnd = 0
const findInput = node('alpha'), replaceInput = node('x'), replaceAllBtn = node()
context.init({ textarea, findInput, replaceInput, replaceAllBtn, widget: node(), countEl: node(), onDirty: () => {} })
findInput.focus()
findInput.handlers.input()
assert.equal(active, findInput, '輸入搜尋字串不可把焦點搶回編輯器')
replaceAllBtn.handlers.click()
assert.equal(textarea.value, 'x x x', '尋找與全部取代必須使用相同大小寫規則')
let dirty = false
const keyContext = { event: { key: 'Enter', isComposing: true, preventDefault() { throw new Error('不可攔截中文選字') } },
  textarea, onDirty: () => { dirty = true } }
Object.assign(context, keyContext)
vm.runInContext('handleEditorKeydown(event, textarea, onDirty, () => {})', context)
assert.equal(dirty, false)
console.log('PASS 搜尋焦點、大小寫一致取代、中文輸入')
