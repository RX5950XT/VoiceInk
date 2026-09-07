'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const { createRequire } = require('node:module')
const root = path.join(__dirname, '..')
const file = path.join(root, 'src/main/local-llm.js')
const localRequire = createRequire(file)
const source = fs.readFileSync(file, 'utf8')
let request, timeout, bodyError, finishReason = 'stop'
const box = {
  require: (id) => id === './models' ? {} : localRequire(id),
  module: { exports: {} }, console, process,
  AbortSignal: { timeout: (ms) => { timeout = ms; return undefined } },
  fetch: async (_url, opts) => {
    request = JSON.parse(opts.body)
    return { ok: true, status: 200, text: async () => {
      if (bodyError) throw bodyError
      return JSON.stringify({ choices: [{ finish_reason: finishReason, message: { content: '完整譯文' } }] })
    } }
  }
}
vm.createContext(box)
vm.runInContext(source + '\nthis.run = translateCloud', box)
const cfg = { apiUrl: 'http://127.0.0.1/v1', apiKey: 'test', modelId: 'test' }
async function main() {
  const page = fs.readFileSync(path.join(root, 'src/renderer/scripts/translate-page.js'), 'utf8')
  const chunkFn = page.match(/function resolveChunkChars\(\) \{[\s\S]*?\n\}/)[0]
  const chunks = vm.runInNewContext(chunkFn + '\nresolveChunkChars()', {
    settings: { translator: 'cloud', localTranslateModel: 'linguaforge08q4' },
    CHUNK_CHARS_GENERIC: 600, CHUNK_CHARS_LINGUAFORGE: 280
  })
  assert.equal(chunks, Infinity, '雲端不應沿用本地的 280 字分段')
  for (const [key, expected] of [['linguaforge08q4', 280], ['qwen35translate', 600]]) {
    assert.equal(vm.runInNewContext(chunkFn + '\nresolveChunkChars()', {
      settings: { translator: 'local', localTranslateModel: key },
      CHUNK_CHARS_GENERIC: 600, CHUNK_CHARS_LINGUAFORGE: 280
    }), expected, '本地保留模型容量上限')
  }
  const article = 'This is a long article.\n\n'.repeat(1000)
  const mainSource = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8')
  let handler, translator = 'cloud'
  vm.runInNewContext(mainSource.match(/ipcMain.handle\('translate', [\s\S]*?\n\}\)/)[0], {
    ipcMain: { handle: (_name, fn) => { handler = fn } },
    store: { get: () => translator },
    modelScope: { isScope: () => false },
    MAX_TRANSLATE_CHARS: 1500, MAX_CLOUD_TRANSLATE_CHARS: 200000,
    TRANSLATE_TARGET_LANGS: new Set(['en']),
    loadLocalLlm: () => ({ translate: (_store, text) => text })
  })
  assert.equal(await handler({}, article, 'en'), article.trim(), 'IPC 不得截斷雲端長文')
  await assert.rejects(handler({}, 'a'.repeat(200001), 'en'), /文字過長/)
  translator = 'local'
  await assert.rejects(handler({}, article, 'en'), /文字過長/, '本地 IPC 上限仍有效')
  assert.equal(await box.run(article, 'zh-TW', cfg, {}, { mode: 'file' }), '完整譯文')
  assert.equal(request.messages.at(-1).content, article)
  assert.ok(timeout >= 600000, '長文不可在 20 秒中止')
  assert.equal(request.max_tokens, undefined, '長文不可套用本地 1024 token 上限')
  bodyError = Object.assign(new Error('secret'), { name: 'TimeoutError' })
  await assert.rejects(box.run(article, 'en', cfg), /翻譯逾時/)
  bodyError = null
  finishReason = 'length'
  await assert.rejects(box.run(article, 'en', cfg), /輸出上限/)
  finishReason = 'stop'
  const normalFetch = box.fetch
  let cancelled = false
  box.fetch = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)) },
    pull(controller) { controller.close() },
    cancel() { cancelled = true }
  }, { highWaterMark: 0 }))
  await assert.rejects(box.run(article, 'en', cfg), /回應過大/)
  assert.ok(cancelled, '過大回應必須停止讀取')
  box.fetch = normalFetch
  await box.run('Hello world', 'en', cfg, {}, { mode: 'live' })
  assert.equal(request.max_tokens, 256, '即時字幕仍維持短輸出')
  const originalFetch = box.fetch
  let release
  const waiting = new Promise((resolve) => { release = resolve })
  box.fetch = async (...args) => { await waiting; return originalFetch(...args) }
  box.require = (id) => id === './chat' ? { readTranslateConfig: () => cfg } :
    id === './models' ? {} : localRequire(id)
  const active = box.module.exports.translate({ get: () => 'cloud' }, article, 'en')
  const unloaded = await Promise.race([
    box.module.exports.unload().then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 100))
  ])
  release()
  await active
  assert.ok(unloaded, '等待雲端不能鎖住本地模型卸載')
  console.log('PASS 長文整篇、等待期限、輸出上限、body 逾時與截斷偵測')
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
