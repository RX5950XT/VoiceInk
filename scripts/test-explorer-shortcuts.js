const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const Module = require('module')
const { tempDir, removeTree } = require('./lib/test-temp')
const root = tempDir('vi-ex-shortcuts-')
const links = new Map()
const launched = []
const originalLoad = Module._load
Module._load = function (name) {
  if (name === 'electron') return { shell: {
    readShortcutLink: target => ({ target: links.get(target) || '' }),
    openPath: async target => { launched.push(target); return '' }
  } }
  return originalLoad.apply(this, arguments)
}
const explorer = require('../src/main/explorer')
Module._load = originalLoad
function link(name, target) {
  const full = path.join(root, name + '.lnk')
  fs.writeFileSync(full, '')
  links.set(full, target)
  return full
}
;(async () => {
  try {
    const shortcut = link('folder', root)
    const result = await explorer.openPath(shortcut)
    assert.equal(result.path, root, '資料夾捷徑要回傳內部導航目的地')
    assert.equal(result.dir, true)
    assert.equal(launched.length, 0, '不得呼叫原生開啟')
    assert.equal(explorer.resolvePath(shortcut).path, root, '路徑列共用解析')
    assert.deepEqual(await explorer.fileIcon(shortcut), { folder: true }, '資料夾捷徑不能誤用磁碟圖示')
    const chained = link('chain', shortcut)
    assert.equal((await explorer.openPath(chained)).path, root)
    const cycle = link('cycle', '')
    links.set(cycle, cycle)
    await assert.rejects(explorer.openPath(cycle), { code: 'BAD_PATH' })
    await assert.rejects(explorer.openPath(link('missing', path.join(root, 'gone'))), { code: 'NOT_FOUND' })
    const file = path.join(root, 'test.txt')
    fs.writeFileSync(file, 'test')
    const fileLink = link('file', file)
    await explorer.openPath(fileLink)
    assert.deepEqual(launched, [fileLink], '檔案捷徑沿用原捷徑，以保留啟動參數')
    console.log('PASS: folder shortcut, chained shortcut, path input, cycle, missing target, file shortcut')
  } finally { removeTree(root) }
})().catch(error => { console.error(error); process.exitCode = 1 })
