'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { execFileSync } = require('node:child_process')
function read(file) {
  return process.argv.includes('--baseline')
    ? execFileSync('git', ['show', `HEAD:${file}`], { encoding: 'utf8' })
    : fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
}
function extract(file, name) {
  const source = read(file).replaceAll('\r\n', '\n')
  const start = source.indexOf(`async function ${name}(`)
  return source.slice(start, source.indexOf('\n}', start) + 2)
}
async function main() {
  let failed = 0
  async function check(name, code) {
    try { await code(); console.log(`PASS ${name}`) }
    catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`) }
  }
  await check('SSE 結尾沒有換行仍保留中文', async () => {
    const context = { TextDecoder, MAX_SSE_BUFFER: 1024, MAX_INPUT_CHARS: 1024,
      extractDelta: text => ({ images: [], content: JSON.parse(text).choices[0].delta.content }) }
    vm.createContext(context)
    vm.runInContext(extract('src/main/chat.js', 'readSseStream'), context)
    const response = new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: '最後一段' } }] }))
    const chunks = []
    assert.equal(await context.readSseStream(response, text => chunks.push(text), () => {}), '最後一段')
    assert.equal(chunks.join(''), '最後一段')
  })
  await check('同批拖入重複資料夾只計算一次', async () => {
    const context = { process, readAll: async () => [], create: async ({ path }) => ({ path, id: 'project' }) }
    vm.createContext(context)
    vm.runInContext(extract('src/main/workspace/store.js', 'addDropped'), context)
    const result = await context.addDropped(['D:/project', 'D:/project'])
    assert.equal(result.added, 1)
    assert.equal(result.skipped, 1)
  })
  await check('Git 中文檔案以位元組判斷大小上限', async () => {
    const context = { Buffer, MAX_DIFF_BYTES: 2 * 1024 * 1024,
      run: async () => ({ code: 0, stdout: '中'.repeat(800000) }) }
    vm.createContext(context)
    vm.runInContext(extract('src/main/workspace/git.js', 'showAt'), context)
    assert.equal((await context.showAt('unused', 'HEAD', 'file.txt')).truncated, true)
  })
  await check('檔案樹有效拖放會搬檔，禁止搬進自己底下', async () => {
    let moves = 0
    const context = { dragging: ['file.txt'], projectSeq: 1, clearDropMarks() {}, dropDirOf: entry => entry.rel,
      canDropInto: dir => context.dragging.length > 0 && context.dragging.every(rel => !dir.startsWith(rel)),
      electronAPI: { workspace: { moveEntry: async () => { moves++; return { rel: 'folder/file.txt' } } } },
      call: async value => value, retargetTabs() {}, expanded: new Set(), isCurrentProject: () => true,
      renderTree: async () => {}, showToast() {} }
    vm.createContext(context)
    vm.runInContext(extract('src/renderer/scripts/workspace-page.js', 'onTreeDrop'), context)
    const event = { preventDefault() {}, stopPropagation() {} }
    await context.onTreeDrop(event, { id: 'project' }, { rel: 'folder' })
    assert.equal(moves, 1)
    context.dragging = ['folder']
    await context.onTreeDrop(event, { id: 'project' }, { rel: 'folder/sub' })
    assert.equal(moves, 1)
  })
  process.exitCode = failed ? 1 : 0
}
main().catch(error => { console.error(error); process.exitCode = 1 })
