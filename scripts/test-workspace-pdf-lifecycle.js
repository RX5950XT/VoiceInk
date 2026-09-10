'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const src = fs.readFileSync(path.join(__dirname, '../src/renderer/scripts/ws-tabs.js'), 'utf8')
const code = src.slice(src.indexOf('let previewIsPdf ='), src.indexOf('\nfunction hint('))
  .replaceAll('import.meta.url', "'file:///app/ws-tabs.js'")
const tick = () => new Promise(resolve => setImmediate(resolve))
function element() {
  return { children: [], events: {}, style: {}, dataset: {}, classList: { toggle() {} },
    append(...nodes) { this.children.push(...nodes) },
    replaceChildren(...nodes) { this.children = nodes },
    querySelectorAll() { return [] },
    get firstChild() { return this.children[0] },
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
  let destroyed = 0
  let collisions = 0
  const doc = { numPages: 2, destroy() { destroyed++; }, async getPage() {
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
    previewGeneration: 1, previewZoom: 1, previewKey: { id: tab.id, source: tab.pdf }, activeId: 'pdf',
    findTab: () => activeTab, document: { createElement: element }, hint: text => ({ text }),
    atob, Uint8Array, nextZoom: value => value + 0.1 }
  vm.createContext(context)
  vm.runInContext(`${code}
this.releasePdf = releasePdf
this.releasePreviewMedia = releasePreviewMedia
this.paintPdf = paintPdf
this.paintPreview = paintPreview
this.configurePdf = (generation, key, lib) => {
  previewGeneration = generation
  previewKey = key
  pdfLib = lib
}`, context)
  context.configurePdf(1, { id: tab.id, source: tab.pdf }, context.pdfLib)
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
  context.releasePreviewMedia(box)
  assert.equal(destroyed, 1, '關掉 PDF 預覽時要 destroy 文件，釋放 pdf.js 資源')

  const pendingTab = { id: 'pending', pdf: 'Yg==' }
  const pendingBox = element()
  const pendingDoc = { numPages: 1, destroy() { destroyed++; } }
  context.configurePdf(2, { id: pendingTab.id, source: pendingTab.pdf }, context.pdfLib)
  const pendingPainting = context.paintPdf(pendingTab, pendingBox, 2)
  context.releasePreviewMedia(pendingBox)
  resolveDoc(pendingDoc)
  await pendingPainting
  assert.equal(destroyed, 2, '載入中的 PDF 被切走時也要 destroy 文件')

  context.el = { ideContainer: {}, editorPreview: box, editorText: null, editorFindBtn: null }
  context.extOf = () => 'pdf'
  const reopenTab = { id: 'reopen', pdf: 'YQ==', preview: true }
  const reopenDoc = { numPages: 1, destroy() { destroyed++; }, async getPage() {
    return { getViewport: ({ scale }) => ({ width: scale * 100, height: scale * 100 }),
      render({ canvasContext }) {
        const promise = Promise.resolve()
        return { promise, cancel() {} }
      } }
  } }
  context.configurePdf(3, { id: reopenTab.id, source: reopenTab.pdf }, context.pdfLib)
  context.paintPreview(reopenTab)
  resolveDoc(reopenDoc)
  await tick()
  await tick()
  assert.equal(box.children.length, 2, 'PDF 預覽關閉後重新開啟要重新畫出頁面')
  assert.ok(Math.abs(box.children[1].width - 150) < 0.001)
  context.releasePreviewMedia(box)
  assert.equal(destroyed, 3, '重新開啟的 PDF 關閉時也要 destroy 文件')
  console.log('PASS PDF 隱藏載入與連續縮放')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
