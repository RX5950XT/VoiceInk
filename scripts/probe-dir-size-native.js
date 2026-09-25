#!/usr/bin/env node
'use strict'

/**
 * 資料夾大小：原生版（voiceink-probe dir-size）與 JS `walk` 比對＋計時，外加取消與根目錄讀不到。
 * 需要先 `npm run build:probe`。改 dirsize.rs 或 explorer/size.js 任何一邊都要跑。
 */

const assert = require('assert')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { tempDir, removeTree } = require('./lib/test-temp')

const ROOT = path.join(__dirname, '..')
const size = require(path.join(ROOT, 'src/main/explorer/size.js'))
const exe = require(path.join(ROOT, 'src/main/native-probe.js')).resolveProbeExe()

async function timed(dir, opts) {
  const started = Date.now()
  const result = await size.folderSize(dir, 'probe', { maxMs: 60_000, ...opts })
  return { ...result, ms: Date.now() - started }
}

async function main() {
  assert.ok(exe, '找不到 voiceink-probe.exe，先跑 npm run build:probe')

  // 自種一棵樹：巢狀、空資料夾、junction（兩邊都不能跟進去）
  const tmp = tempDir('vi-dirsize-')
  try {
    fs.mkdirSync(path.join(tmp, 'a', 'b', 'c'), { recursive: true })
    fs.mkdirSync(path.join(tmp, 'empty'))
    fs.writeFileSync(path.join(tmp, 'x.bin'), Buffer.alloc(100))
    fs.writeFileSync(path.join(tmp, 'a', 'b', 'c', 'y.bin'), Buffer.alloc(23))
    fs.symlinkSync(path.join(tmp, 'a'), path.join(tmp, 'link'), 'junction')
    const js = await timed(tmp, {})
    const native = await timed(tmp, { exe })
    assert.deepStrictEqual([native.bytes, native.files, native.dirs], [123, 2, 4], JSON.stringify(native))
    assert.deepStrictEqual([native.bytes, native.files, native.dirs], [js.bytes, js.files, js.dirs])
    const shallow = await timed(tmp, { exe, maxDepth: 1 })
    assert.equal(shallow.incomplete, true, '超過深度要標不完整')
    assert.equal(shallow.reason, 'depth')
  } finally {
    removeTree(tmp)
  }

  // 真實資料夾：完整算完的兩邊要一樣
  for (const dir of [path.join(ROOT, 'node_modules'), path.join(ROOT, 'src')]) {
    const js = await timed(dir, {})
    const native = await timed(dir, { exe })
    console.log(`${dir}: ${native.files} 檔 ${(native.bytes / 1e9).toFixed(2)}GB｜JS ${js.ms}ms／原生 ${native.ms}ms`)
    assert.equal(native.incomplete, false)
    assert.deepStrictEqual([native.bytes, native.files, native.dirs], [js.bytes, js.files, js.dirs], dir)
  }

  // 取消：新請求蓋掉舊的，舊的要回 cancelled 而且程序被砍掉（不會拖到 maxMs）
  const big = process.env.SystemRoot || 'C:\\Windows'
  const started = Date.now()
  const first = size.folderSize(big, 'one', { exe, maxMs: 60_000 })
  await new Promise((resolve) => setTimeout(resolve, 150))
  size.folderSizeCancel('one')
  const cancelled = await first
  assert.equal(cancelled.cancelled, true)
  assert.ok(Date.now() - started < 3000, `取消後要馬上回來（${Date.now() - started}ms）`)

  // 根目錄 lstat 得到、列不出內容 → READ_FAILED（跟 JS 版同一個錯）
  const locked = tempDir('vi-dirsize-locked-')
  const icacls = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe')
  execFileSync(icacls, [locked, '/deny', '*S-1-1-0:(RD)'])
  try {
    await assert.rejects(size.folderSize(locked, 't', { exe }), (error) => error.code === 'READ_FAILED')
  } finally {
    execFileSync(icacls, [locked, '/remove:d', '*S-1-1-0'])
    removeTree(locked)
  }

  console.log('PASS 原生資料夾大小與 JS 一致、取消與讀不到都正常')
}

main().catch((error) => {
  console.error(`FAIL ${error.message}`)
  process.exitCode = 1
})
