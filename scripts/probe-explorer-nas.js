#!/usr/bin/env node
'use strict'

// 唯讀驗證已登入的 NAS 分享，不建立連線、不寫入遠端資料。
const assert = require('node:assert/strict')
const paths = require('../src/main/explorer/paths')
const files = require('../src/main/explorer/fs')

async function main() {
  const input = process.argv[2]
  if (!input || !paths.isUnc(input)) throw new Error('請提供已登入的 UNC 分享路徑')
  const full = paths.resolveAbs(input)
  const started = Date.now()
  assert.equal(paths.resolveExisting(full), full)
  const listed = await files.listDir(full)
  const info = await files.inspect(full)
  assert.equal(listed.path, full)
  assert.ok(Array.isArray(listed.entries))
  assert.equal(info.dir, true)
  console.log(JSON.stringify({ status: 'PASS', count: listed.entries.length,
    truncated: Boolean(listed.truncated), elapsedMs: Date.now() - started }))
}

main().catch(error => {
  console.error('FAIL:', error.userMessage || (process.argv[2] ? error.code || 'NAS 讀取驗證失敗' : error.message))
  process.exitCode = 1
})
