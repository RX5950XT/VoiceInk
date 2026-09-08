'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const catalog = require('../src/main/hfmodels/catalog')
const source = fs.readFileSync(path.join(__dirname, '../src/main/hfmodels/index.js'), 'utf8')
const bodies = ['inspect', 'install'].map(name => {
  const start = source.indexOf(`async function ${name}(`)
  return source.slice(start, source.indexOf('\n}', start) + 2)
}).join('\n')
async function main() {
  let files = [{ name: 'model-Q4_K_M-00001-of-00002.gguf', size: 1 }]
  const pending = []
  const context = { catalog, path, AbortController, installs: new Map(), emit() {},
    hub: { listFiles: async () => files, fileUrl: () => 'unused', authHeaders: () => ({}) },
    library: { has: () => false, dirFor: () => 'unused' },
    download: { downloadVariant: () => new Promise((resolve, reject) => pending.push(reject)) } }
  vm.createContext(context)
  vm.runInContext(bodies, context)
  const incomplete = catalog.groupVariants(files, { repoName: 'model' })[0]
  const invalid = assert.rejects(context.install('owner/model', incomplete.id), /分片不完整/, '缺少分片不能開始下載')
  await new Promise(resolve => setImmediate(resolve))
  pending.splice(0).forEach(reject => reject(new Error('test cleanup')))
  await invalid
  files = [{ name: 'model-Q4_K_M.gguf', size: 1 }]
  const variant = catalog.groupVariants(files, { repoName: 'model' })[0]
  const results = Promise.allSettled([context.install('owner/model', variant.id), context.install('owner/model', variant.id)])
  await new Promise(resolve => setImmediate(resolve))
  const started = pending.length
  pending.splice(0).forEach(reject => reject(new Error('test cleanup')))
  const settled = await results
  assert.equal(started, 1, '同時要求下載時只能有一個寫入者')
  assert.match(settled[1].reason.message, /正在下載/)
  assert.equal(context.installs.size, 0)
  console.log('PASS 缺片拒絕與重複下載互斥')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
