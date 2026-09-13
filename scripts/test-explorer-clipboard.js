'use strict'

const assert = require('node:assert/strict')
const Module = require('node:module')
const paths = require('../src/main/explorer/paths')
const files = require('../src/main/explorer/fs')
const load = Module._load
Module._load = function (name) {
  return name === 'electron' ? {} : load.apply(this, arguments)
}
const explorer = require('../src/main/explorer')
Module._load = load

async function main() {
  const original = { resolve: paths.resolveExisting, copy: files.copyEntry, move: files.moveEntry }
  paths.resolveExisting = value => value
  const actions = []
  files.moveEntry = async src => { actions.push(`move:${src}`); return { path: src } }
  files.copyEntry = async src => {
    actions.push(`copy:${src}`)
    if (src === 'a') explorer.setClipboard(['new'], 'cut')
    return { path: src }
  }
  try {
    explorer.setClipboard(['a', 'b'], 'copy')
    await explorer.paste('dest')
    assert.deepEqual(actions, ['copy:a', 'copy:b'], '貼上途中更換剪貼簿不能把複製變成搬移')
    actions.length = 0
    await explorer.paste('dest')
    assert.deepEqual(actions, ['move:new'], '舊貼上不能清掉新剪貼簿')

    actions.length = 0
    let fail = true
    files.moveEntry = async src => {
      if (src === 'b' && fail) { fail = false; throw new Error('blocked') }
      actions.push(src)
      return { path: src }
    }
    explorer.setClipboard(['a', 'b'], 'cut')
    await assert.rejects(explorer.paste('dest'), /blocked/)
    await explorer.paste('dest')
    assert.deepEqual(actions, ['a', 'b'], '部分搬移失敗後重試只處理剩餘檔案')
    console.log('3 passed, 0 failed')
  } finally {
    paths.resolveExisting = original.resolve
    files.copyEntry = original.copy
    files.moveEntry = original.move
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
