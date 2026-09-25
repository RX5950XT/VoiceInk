#!/usr/bin/env node
'use strict'

/**
 * 用量統計：原生解析（voiceink-probe usage-scan）與 JS（parsers.js）逐筆比對。
 *
 * 1. 本機真實記錄（~/.claude、~/.codex、~/.grok）各掃一次：事件、游標（含去重集合／模型／重播旗標）要完全一樣。
 * 2. 把 test-code-usage.js 的增量掃描案例改成走原生再跑一次（截斷、半行、跨次去重、fork 重播、搬檔）。
 *
 * 需要先 `npm run build:probe`。改 usage.rs 或 parsers.js 任何一邊都要跑。
 */

const assert = require('assert')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const scan = require(path.join(ROOT, 'src/main/codeusage/scan.js'))
const parsers = require(path.join(ROOT, 'src/main/codeusage/parsers.js'))
const nativeProbe = require(path.join(ROOT, 'src/main/native-probe.js'))

const SINCE = Date.now() - scan.SCAN_WINDOW_DAYS * 86400_000

function sources() {
  const home = os.homedir()
  const base = (name) => ({ newState: parsers.newState, keyOf: (f) => path.basename(f), native: name, provider: name })
  return [
    { ...base('claude'), roots: [path.join(home, '.claude', 'projects')], match: (n) => n.endsWith('.jsonl'), parseLine: parsers.parseClaudeLine },
    { ...base('codex'), roots: [path.join(home, '.codex', 'sessions'), path.join(home, '.codex', 'archived_sessions')], match: (n) => n.endsWith('.jsonl'), parseLine: parsers.parseCodexLine },
    {
      ...base('grok'),
      roots: [path.join(home, '.grok', 'sessions'), path.join(home, '.grok', 'archived_sessions')],
      match: (n) => n === 'updates.jsonl',
      parseLine: parsers.parseGrokLine,
      keyOf: (f) => path.basename(path.dirname(f))
    }
  ]
}

async function run(source) {
  const cursors = {}
  const events = []
  const started = Date.now()
  const result = await scan.scanSource(source, cursors, (event) => events.push(event), SINCE)
  for (const cursor of Object.values(cursors)) delete cursor.mtimeMs
  const KEYS = ['ts', 'model', 'input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'requests', 'costUsd']
  // JS 版 Codex／Grok 的事件沒有 cacheWrite1h（addEvent 當 0），原生版一律帶 0
  const norm = (e) => JSON.stringify(KEYS.map((k) => (k === 'cacheWrite1h' ? e[k] || 0 : e[k])))
  return { ms: Date.now() - started, result, cursors, events: events.map(norm).sort() }
}

async function realData() {
  let jsTotal = 0
  let nativeTotal = 0
  for (const source of sources()) {
    const js = await run({ ...source, native: undefined })
    const native = await run(source)
    jsTotal += js.ms
    nativeTotal += native.ms
    console.log(`${source.provider}: ${js.result.files} 檔 ${(js.result.scannedBytes / 1e6).toFixed(0)}MB ${js.events.length} 筆｜JS ${js.ms}ms／原生 ${native.ms}ms`)
    assert.equal(native.result.scannedBytes, js.result.scannedBytes, `${source.provider} scannedBytes`)
    assert.equal(native.events.length, js.events.length, `${source.provider} 事件數`)
    for (let i = 0; i < js.events.length; i += 1) {
      assert.equal(native.events[i], js.events[i], `${source.provider} 第 ${i} 筆事件不同
原生 ${native.events[i]}
JS   ${js.events[i]}`)
    }
    assert.deepStrictEqual(native.cursors, js.cursors, `${source.provider} 游標不同`)
  }
  console.log(`PASS 真實記錄逐筆一致（JS ${jsTotal}ms → 原生 ${nativeTotal}ms）`)
}

async function suiteThroughNative() {
  // test-code-usage.js 透過 `scan.scanSource` 呼叫；換成一律帶 native 的版本再跑一次
  const original = scan.scanSource
  scan.scanSource = (source, ...rest) => original({ ...source, native: source.provider }, ...rest)
  require('./test-code-usage.js')
}

// 原生失敗會安靜退回 JS（結果一樣），所以要另外盯著退路有沒有被走到
let fallbacks = 0
const warn = console.warn
console.warn = (...args) => {
  if (String(args[0]).includes('[codeusage]')) fallbacks += 1
  warn(...args)
}
process.on('exit', () => {
  if (fallbacks) {
    console.error(`FAIL 原生掃描退回 JS ${fallbacks} 次`)
    process.exitCode = 1
  }
})

async function main() {
  if (!nativeProbe.resolveProbeExe()) throw new Error('找不到 voiceink-probe.exe，先跑 npm run build:probe')
  await realData()
  console.log('\n--- test-code-usage.js（原生路徑）---')
  await suiteThroughNative()
}

main().catch((error) => {
  console.error(`FAIL ${error.message}`)
  process.exitCode = 1
})
