'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const source = fs.readFileSync(path.join(root, 'src/renderer/scripts/explorer-operations.js'), 'utf8')
const style = fs.readFileSync(path.join(root, 'src/renderer/styles/explorer-operations.css'), 'utf8')

assert.match(source, /export function mountExplorerOperations/)
assert.match(source, /onOperation\(update\)/)
for (const name of ['operationCancel', 'operationRetry', 'operationUndo', 'setOperationPolicy']) {
  assert.match(source, new RegExp(`['"]${name}['"]`))
}
assert.doesNotMatch(source, /\.innerHTML\s*=/)
assert.match(style, /prefers-reduced-motion: reduce/)
assert.match(style, /overflow-wrap: anywhere/)
console.log('PASS: operation center renderer contract and accessible state styling')

// 打包版是用 file:// 直接載原始 ES module，CSS 不是 JS module——
// renderer 的 JS 只要 `import './x.css'`，整條 import 鏈都會 Failed to fetch。
// 樣式一律掛在 index.html 的 <link>。
const scriptsDir = path.join(root, 'src/renderer/scripts')
const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8')
for (const name of fs.readdirSync(scriptsDir)) {
  if (!name.endsWith('.js')) continue
  const text = fs.readFileSync(path.join(scriptsDir, name), 'utf8')
  for (const match of text.matchAll(/^\s*import\s+(?:[^'"]*from\s*)?['"]([^'"]+)['"]/gm)) {
    assert.ok(
      /\.[cm]?js$/.test(match[1]),
      `${name} 靜態 import 了非 JS 模組：${match[1]}（樣式請改掛 index.html 的 <link>）`
    )
  }
}
assert.match(html, /href="\.\/styles\/explorer-operations\.css"/)
console.log('PASS: renderer 沒有 CSS import，操作中心樣式由 index.html 掛載')
