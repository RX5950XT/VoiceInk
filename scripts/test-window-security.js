'use strict'

// 執行 main 真正掛上的視窗守衛，不啟動 App 或碰使用者資料。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8')
const body = source.slice(source.indexOf('function attachWindowSecurity('), source.indexOf('/**\n * 儲存的視窗位置'))
const handlers = {}
const context = { URL, isDev: false, shell: { openExternal: async () => {} } }
vm.runInNewContext(`${body}; this.attach = attachWindowSecurity`, context)
const current = 'file:///C:/VoiceInk/src/renderer/index.html'
context.attach({ webContents: { on: (name, fn) => { handlers[name] = fn },
  getURL: () => current, setWindowOpenHandler: () => {} } })
let blocked = false
const event = { preventDefault: () => { blocked = true } }
handlers['will-navigate'](event, 'file:///C:/Users/Public/untrusted.html')
assert.ok(blocked, '主視窗不可載入其他本機 HTML 並帶上 preload')
blocked = false
handlers['will-navigate'](event, `${current}#settings`)
assert.equal(blocked, false, '同一份 App 頁面的錨點可通行')
context.isDev = true
blocked = false
handlers['will-navigate'](event, 'http://localhost:5173.evil.test/')
assert.ok(blocked, '開發站台必須比 origin，不能比字首')
assert.equal(typeof handlers['will-attach-webview'], 'function')
const preferences = { preload: '/evil.js', preloadURL: 'file:///evil.js', nodeIntegration: true,
  contextIsolation: false, sandbox: false, webSecurity: false }
blocked = false
handlers['will-attach-webview'](event, preferences, { src: 'https://example.com/' })
assert.equal(blocked, false)
assert.equal(preferences.preload, undefined)
assert.equal(preferences.preloadURL, undefined)
assert.equal(preferences.nodeIntegration, false)
assert.equal(preferences.contextIsolation, true)
assert.equal(preferences.sandbox, true)
assert.equal(preferences.webSecurity, true)
for (const src of ['file:///C:/secret.txt', 'javascript:alert(1)', 'data:text/html,hello']) {
  blocked = false
  handlers['will-attach-webview'](event, {}, { src })
  assert.ok(blocked, `拒絕 guest 協議 ${src.split(':')[0]}`)
}
console.log('PASS 視窗導覽、webview preload 與沙箱守衛')
