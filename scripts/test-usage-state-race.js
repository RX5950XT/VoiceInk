'use strict'

// 延遲額度來源，重現同步期間儲存設定；全部使用記憶體，不讀憑證或連網。
const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { createRequire } = require('module')

const root = path.join(__dirname, '../src/main/usage')
function load(name, overrides = {}, suffix = '', extra = {}) {
  const file = path.join(root, name)
  const localRequire = createRequire(file)
  const context = {
    module: { exports: {} }, process, console: { log() {} }, ...extra,
    require: (id) => overrides[id] || localRequire(id)
  }
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + suffix, context, { filename: file })
  return context.module.exports
}

async function run() {
  let state = null
  const fakeStore = {
    get: () => structuredClone(state),
    set: (_, value) => { state = structuredClone(value) }
  }
  const store = load('store.js', {}, '\ngetStore = async () => fakeStore', { fakeStore })
  const { createBaseAccount } = require('../src/main/usage/shared')
  const { PROVIDER_IDS } = require('../src/main/usage/constants')
  const providers = [
    ['claude', 'syncClaude'], ['codex', 'syncCodex'], ['antigravity', 'syncAntigravity'],
    ['opencode', 'syncOpenCode'], ['grok', 'syncGrok'], ['ollama', 'syncOllama'],
    ['commandcode', 'syncCommandCode']
  ]
  let release
  const pending = new Promise((resolve) => { release = resolve })
  let entered
  const started = new Promise((resolve) => { entered = resolve })
  const overrides = { './store': store }
  providers.forEach(([name, method], index) => {
    overrides[`./${name}`] = { [method]: async ({ nowMs }) => {
      entered()
      await pending
      return createBaseAccount(PROVIDER_IDS[index], nowMs)
    } }
  })
  const service = load('index.js', overrides)
  const sync = service.sync()
  await started
  const settings = { visibleProviders: ['codex'], providerOrder: [...PROVIDER_IDS].reverse() }
  await service.saveSettings(settings)
  release()
  await sync
  assert.deepEqual(state.settings, settings, '同步完成不可蓋回舊的排序與顯示設定')
  assert.ok(state.lastSyncedAt > 0, '設定儲存不可清掉同步結果')

  await Promise.all([service.saveSettings(settings), service.sync()])
  assert.deepEqual(state.settings, settings)
  assert.ok(state.lastSyncedAt > 0)
  console.log('PASS: usage sync preserves settings saved during provider requests and concurrent saves')
}

run().catch((error) => { console.error(error); process.exitCode = 1 })
