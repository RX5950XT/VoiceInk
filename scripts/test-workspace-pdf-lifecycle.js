'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const src = fs.readFileSync(path.join(__dirname, '../src/renderer/scripts/ws-tabs.js'), 'utf8')
const code = src.slice(src.indexOf('async function paintPdf('), src.indexOf('\nfunction hint('))
  .replaceAll('import.meta.url', "'file:///app/ws-tabs.js'")
const tick = () => new Promise(resolve => setImmediate(resolve))
function element() {
  return { children: [], events: {}, style: {}, classList: { toggle() {} },
    append(...nodes) { this.children.push(...nodes) },
    replaceChildren(...nodes) { this.children = nodes },
    addEventListener(name, fn) { this.events[name] = fn },
    getContext() { return { canvas: this } } }
}
async function main() {
  const tab = { id: 'pdf', pdf: 'YQ==' }
  const box = element()
  let resolveDoc
  let activeTab = tab
  const pending = []
  const rendering = new Set()
  let collisions = 0
  const doc = { numPages: 2, destroy() {}, async getPage() {
    return { getViewport: ({ scale }) => ({ width: scale * 100, height: scale * 100 }),
      render({ canvasContext }) {
        const canvas = canvasContext.canvas
        if (rendering.has(canvas)) { collisions++; throw new Error('same canvas') }
        rendering.add(canvas)
        let finish
        const promise = new Promise(resolve => { finish = () => { rendering.delete(canvas); resolve() } })
        pending.push(finish)
        return { promise, cancel: finish }
      } }
  } }
  const context = { pdfLib: { getDocument: () => ({ promise: new Promise(resolve => { resolveDoc = resolve }) }) },
    previewGeneration: 1, previewKey: { id: tab.id, source: tab.pdf }, activeId: 'pdf',
    findTab: () => activeTab, document: { createElement: element }, hint: text => ({ text }),
    atob, Uint8Array, nextZoom: value => value + 0.1 }
  vm.createContext(context)
  vm.runInContext(code, context)
  const painting = context.paintPdf(tab, box, 1)
  activeTab = { id: 'text' }
  resolveDoc(doc)
  await tick()
  assert.equal(box.children.length, 2, '切去文字編輯器時，隱藏中的 PDF 仍須完成，切回才不會卡在載入中')
  pending.shift()()
  await painting
  activeTab = tab
  const canvas = box.children[1]
  canvas.events.wheel({ ctrlKey: true, preventDefault() {} })
  await tick()
  canvas.events.wheel({ ctrlKey: true, preventDefault() {} })
  await tick()
  assert.equal(collisions, 0, '快速縮放不可同時使用同一張 canvas 繪圖')
  for (let i = 0; i < 3; i++) { pending.splice(0).forEach(resolve => resolve()); await tick() }
  assert.ok(Math.abs(box.children[1].width - 180) < 0.001)
  console.log('PASS PDF 隱藏載入與連續縮放')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
