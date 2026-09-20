'use strict'

/**
 * 檔案總管把檔案拖出去（main 端）：`npx electron scripts/e2e-explorer-drag.js`
 *
 * `webContents.startDrag` 底下是 Windows 的 DoDragDrop，真的呼叫會**一路阻塞到
 * 使用者放手**——所以這裡用假的 sender，只驗 main 交出去的東西對不對：
 * 路徑有沒有過守衛、單檔與多檔的欄位、icon 是不是空的（空的 Electron 直接丟例外）。
 * 「真的拖進瀏覽器上傳框」沒辦法自動化，只能人工試一次。
 */

const { app } = require('electron')
const path = require('path')
const fs = require('fs')
const { tempDir } = require('./lib/test-temp')

let passed = 0
const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}

function fakeSender() {
  const calls = []
  return {
    calls,
    isDestroyed: () => false,
    startDrag: (spec) => calls.push(spec)
  }
}

async function main() {
  await app.whenReady()
  const tmp = tempDir('explorer-drag')
  app.setPath('userData', path.join(tmp, 'userData'))

  const explorer = require('../src/main/explorer')
  const fileA = path.join(tmp, 'a.txt')
  const fileB = path.join(tmp, 'b.txt')
  const dirC = path.join(tmp, 'c-dir')
  fs.writeFileSync(fileA, 'A')
  fs.writeFileSync(fileB, 'B')
  fs.mkdirSync(dirC, { recursive: true })

  console.log('\n[D] startDrag 交給 OS 的內容')
  {
    const sender = fakeSender()
    const done = await explorer.startDrag([fileA], sender)
    const spec = sender.calls[0] || {}
    check('單檔回報成功', done === true)
    check('單檔用 file 欄位', spec.file === fileA, `file=${spec.file}`)
    check('帶得出 icon', Boolean(spec.icon) && !spec.icon.isEmpty(), String(spec.icon && spec.icon.isEmpty()))
  }
  {
    const sender = fakeSender()
    await explorer.startDrag([fileA, dirC], sender)
    const spec = sender.calls[0] || {}
    check('多個項目用 files 陣列', Array.isArray(spec.files) && spec.files.join('|') === `${fileA}|${dirC}`,
      JSON.stringify(spec.files))
    check('資料夾也拿得到 icon', Boolean(spec.icon) && !spec.icon.isEmpty())
  }

  console.log('\n[D2] 守衛')
  {
    const sender = fakeSender()
    const done = await explorer.startDrag([path.join(tmp, 'nope.txt')], sender)
    check('路徑不存在就不拖', done === false && sender.calls.length === 0)
  }
  {
    const sender = fakeSender()
    const done = await explorer.startDrag(['\\\\?\\C:\\Windows\\notepad.exe'], sender)
    check('裝置路徑過不了 resolveExisting', done === false && sender.calls.length === 0)
  }
  {
    const sender = fakeSender()
    const done = await explorer.startDrag([], sender)
    check('空清單不拖', done === false && sender.calls.length === 0)
  }
  {
    const sender = fakeSender()
    const done = await explorer.startDrag('D:\\a.txt', sender)
    check('不是陣列也不會爆', done === false && sender.calls.length === 0)
  }
  {
    const done = await explorer.startDrag([fileA], null)
    check('沒有 webContents 就算了', done === false)
  }
  {
    const sender = fakeSender()
    const many = Array.from({ length: 150 }, () => fileB)
    await explorer.startDrag(many, sender)
    const spec = sender.calls[0] || {}
    check('一次最多 100 個', Array.isArray(spec.files) && spec.files.length === 100, String(spec.files && spec.files.length))
  }
  {
    const sender = fakeSender()
    const done = await explorer.startDrag([fileA, path.join(tmp, 'nope.txt')], sender)
    const spec = sender.calls[0] || {}
    check('列出來之後被刪掉的那個跳過就好', done === true && spec.file === fileA, JSON.stringify(spec.files || spec.file))
  }

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) console.log('failed:', failures.join(', '))
  app.exit(failures.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  app.exit(1)
})
