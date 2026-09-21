'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const tick = () => new Promise(resolve => setImmediate(resolve))
function element() {
  return { children: [], events: {}, style: {}, classList: { add() {} },
    append(...nodes) { this.children.push(...nodes) },
    replaceChildren(...nodes) { this.children = nodes },
    addEventListener(name, fn) { this.events[name] = fn },
    getContext() { return {} }
  }
}
async function scenario(closeWhileLoading) {
  const requests = []
  const painted = []
  const host = element()
  // pdfjs 6 的 PDFDocumentProxy 沒有 destroy()，要從 loadingTask 收；假物件照著長才擋得住回鍋。
  let destroyed = 0
  const doc = { numPages: 3, loadingTask: { destroy: async () => { destroyed += 1 } }, getPage: pageNo => new Promise(resolve => {
    requests.push({ pageNo, resolve: () => resolve({
      getViewport: () => ({ width: 100, height: 100 }),
      render() { painted.push(pageNo); return { promise: Promise.resolve(), cancel() {} } }
    }) })
  }) }
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/scripts/explorer-preview.js'), 'utf8')
    .replace(/^import .*\r?\n/gm, '').replace(/^export /gm, '')
    .replaceAll('import.meta.url', "'file:///preview.js'")
  const context = { document: { createElement: element }, doc, host }
  vm.createContext(context)
  vm.runInContext(source, context)
  vm.runInContext('ui = { stage: host }; pdfLib = { getDocument: () => ({ promise: Promise.resolve(doc) }) }', context)
  const loading = context.loadPdf('file.pdf', host, 0)
  await tick()
  if (closeWhileLoading) {
    vm.runInContext('generation++; clearRelease(); ui = null', context)
    requests[0].resolve()
    await loading
    assert.deepEqual(painted, [], '關閉後晚到的 PDF 頁面不能繼續繪製')
    assert.equal(destroyed, 1, '關閉預覽要收掉 pdf loadingTask')
    return
  }
  requests[0].resolve()
  await loading
  const next = host.children[0].children[2]
  next.events.click()
  next.events.click()
  requests[2].resolve()
  await tick()
  requests[1].resolve()
  await tick()
  assert.deepEqual(painted, [1, 3], '快速翻頁時舊頁不能蓋掉新頁')
}
async function main() {
  let failures = 0
  for (const closed of [true, false]) {
    try { await scenario(closed) } catch (error) { failures++; console.error(error.message) }
  }
  assert.equal(failures, 0)
  const imageContext = { document: {
    body: { appendChild() {} }, addEventListener() {},
    createElement() {
      return { ...element(), classList: { add() {}, remove() {} },
        appendChild() {}, removeAttribute() {}, focus() {}, naturalWidth: 0, clientWidth: 125 }
    }
  } }
  vm.createContext(imageContext)
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/scripts/image-viewer.js'), 'utf8')
    .replace(/^import .*\r?\n/gm, '').replace(/^export /gm, ''), imageContext)
  imageContext.openImageViewer({ items: [{ path: 'photo.png', name: 'photo.png' }],
    mediaUrl: async () => ({ ok: true, data: { url: 'image-url' } }) })
  await tick()
  const img = vm.runInContext('ui.img', imageContext)
  img.naturalWidth = 500
  img.events.load?.()
  assert.equal(vm.runInContext('ui.zoomLabel.textContent', imageContext), '25%', '圖片載入後倍率必須反映實際顯示大小')
  console.log('PASS Quick Look PDF 關閉清理與快速翻頁的過期回覆')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
