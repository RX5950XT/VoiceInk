const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const source = fs.readFileSync('src/renderer/scripts/terminal-page.js', 'utf8')
  .replace(/^import [\s\S]*?from '[^']*'$/gm, '').replace(/^export /gm, '')
const handlers = {}, writes = [], errors = []
const context = vm.createContext({
  electronAPI: { getPathForFile: f => f.path },
  showToast: x => errors.push(x),
  document: { getElementById: () => null },
  // 被剝掉的 import 裡，只有外觀那兩支在模組載入當下就會被呼叫
  normalizeAppearance: () => ({ theme: 'black', image: '', opacity: 20 }),
  applyAppearance: () => ({ theme: {}, allowTransparency: false })
})
vm.runInContext(source + '\nthis.bind = initTerminalDrop', context)
context.bind({ addEventListener: (type, fn) => { handlers[type] = fn } }, {
  paste: text => writes.push(text), focus() {}
}, 'test')
const event = files => ({ dataTransfer: { types: ['Files'], files }, preventDefault() {}, stopPropagation() {} })
handlers.drop(event([{ path: 'C:\\圖片 空白.png' }, { path: "C:\\it's $file.txt" }]))
assert.equal(writes[0], "'C:\\圖片 空白.png' 'C:\\it''s $file.txt' ")
assert.equal(writes.length, 1)
handlers.drop(event([{ path: '' }]))
handlers.drop(event([{ path: 'C:\\bad\nfile' }]))
assert.equal(writes.length, 1)
assert.equal(errors.length, 2)
// 以前超過 8180 字會被擋下來（main 單次只收 8192）。現在送進 PTY 的那一段自己會切，
// 所以長路徑照樣貼得進去，一個字都不少（見 `term-write-chunks.js`）。
const longPath = 'C:\\' + 'x'.repeat(8180)
handlers.drop(event([{ path: longPath }]))
assert.equal(writes.length, 2)
assert.equal(writes[1], `'${longPath}' `)
vm.runInContext("items = [{ id: 'test', shell: 'cmd' }]", context)
handlers.drop(event([{ path: 'C:\\圖片 空白.png' }]))
assert.equal(writes[2], '"C:\\圖片 空白.png" ')
handlers.dragover(event([]))
console.log('PASS 多檔、圖片、PowerShell／cmd 引號、拒絕無路徑／控制字元、長路徑照貼不截斷；不自動送出')
