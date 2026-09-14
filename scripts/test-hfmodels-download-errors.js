'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { tempDir, removeTree } = require('./lib/test-temp')
const { spawnSync } = require('node:child_process')
const { getEventListeners } = require('node:events')
const { downloadFile } = require('../src/main/hfmodels/download')
const library = require('../src/main/hfmodels/library')

async function main() {
  if (process.argv[2] === '--write-failure') {
    await assert.rejects(downloadFile({
      url: 'https://example.test/model.gguf', dest: process.argv[3],
      fetchImpl: async () => new Response(Buffer.alloc(128 * 1024))
    }), error => ['EISDIR', 'EPERM', 'EACCES'].includes(error.code))
    console.log('PASS 寫入失敗回傳 rejection')
    return
  }
  const dir = tempDir('voiceink-hf-errors-')
  let failed = 0
  async function check(name, fn) {
    try { await fn(); console.log(`PASS ${name}`) }
    catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`) }
  }
  try {
    await check('磁碟寫入失敗不會讓程序崩潰', () => {
      const dest = path.join(dir, 'unwritable.gguf')
      fs.mkdirSync(`${dest}.part`)
      const result = spawnSync(process.execPath, [__filename, '--write-failure', dest], { encoding: 'utf8', timeout: 5000 })
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /PASS 寫入失敗/)
    })
    await check('連線失敗會移除取消監聽', async () => {
      const controller = new AbortController()
      await assert.rejects(downloadFile({
        url: 'https://example.test/model.gguf', dest: path.join(dir, 'offline.gguf'), signal: controller.signal,
        fetchImpl: async () => { throw new Error('offline') }
      }), /offline/)
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    })
    await check('多片下載中斷後仍可續傳，只有完整模型算已安裝', () => {
      library.setRoot(dir)
      const modelDir = library.dirFor('sharded')
      fs.mkdirSync(modelDir)
      fs.writeFileSync(path.join(modelDir, 'model-00001-of-00002.gguf'), 'one')
      assert.equal(library.has('sharded'), false)
      assert.equal(library.list().some(model => model.id === 'sharded'), false)
      fs.writeFileSync(path.join(modelDir, 'model-00002-of-00002.gguf'), 'two')
      assert.equal(library.has('sharded'), true)
      assert.equal(library.list().some(model => model.id === 'sharded'), true)
    })
    await check('續傳多檔時跳過已完整下載的分片', async () => {
      const dest = path.join(dir, 'complete.gguf')
      fs.writeFileSync(dest, 'complete')
      const result = await downloadFile({ url: 'https://example.test/model.gguf', dest, expectedBytes: 8,
        fetchImpl: async () => { throw new Error('不應再次下載') } })
      assert.equal(result.bytes, 8)
      assert.equal(fs.readFileSync(dest, 'utf8'), 'complete')
    })
    await check('投影檔未完成不能標已安裝，模型庫也不列出', () => {
      const files = [{ name: 'model.gguf', size: 3 }, { name: 'mmproj.gguf', size: 3 }]
      const modelDir = library.dirFor('vision')
      library.writeMeta('vision', { files })
      fs.writeFileSync(path.join(modelDir, 'model.gguf'), 'one')
      assert.equal(library.has('vision', files), false)
      assert.equal(library.list().some(model => model.id === 'vision'), false)
      fs.writeFileSync(path.join(modelDir, 'mmproj.gguf'), 'x')
      assert.equal(library.has('vision', files), false)
      fs.writeFileSync(path.join(modelDir, 'mmproj.gguf'), 'two')
      assert.equal(library.has('vision', files), true)
      assert.equal(library.list().some(model => model.id === 'vision'), true)
    })
  } finally { removeTree(dir) }
  process.exitCode = failed ? 1 : 0
}
main().catch(error => { console.error(error); process.exitCode = 1 })
