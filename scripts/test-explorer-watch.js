#!/usr/bin/env node
/**
 * VoiceInk — 資料夾監看重新 arm 的回歸（node 直跑）
 *
 * 每重讀一次目錄，UI 就會再呼叫一次 watchDirs()。以前那裡先把 watcher 全關再重開，
 * 剛好卡在那一下的改動就永遠不會送到畫面（e2e-explorer-cdp 的 [C8]／[F] 偶發變紅）。
 * 這支就守這件事：重新 arm 同一個資料夾，事件照送。
 *
 * 用法：node scripts/test-explorer-watch.js
 */

'use strict'

const fs = require('fs')
const path = require('path')
const { tempDir } = require('./lib/test-temp')

const ROOT = path.join(__dirname, '..')
const watch = require(path.join(ROOT, 'src/main/explorer/watch.js'))

let passed = 0
let failed = 0
function ok(name, cond, detail = '') {
  if (cond) {
    passed += 1
    console.log(`  PASS ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitHits(hits, ms = 4_000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (hits.length) return true
    await sleep(50)
  }
  return false
}

async function main() {
  const dir = tempDir('watch-')

  // 1) 改動當下重新 arm：不能把還沒送出的事件吃掉
  {
    const hits = []
    const send = (payload) => hits.push(payload)
    const first = watch.startMany([{ path: dir, send }])
    ok('watchDirs 掛得上', first[0] && first[0].watching === true, JSON.stringify(first))
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a')
    await sleep(30) // 事件進來了，還在 debounce
    const again = watch.startMany([{ path: dir, send }])
    ok('重新 arm 同一個資料夾照樣回 watching', again[0] && again[0].watching === true, JSON.stringify(again))
    ok('改動當下重新 arm，事件不會掉', await waitHits(hits), JSON.stringify(hits))
  }

  // 2) 重新 arm 之後的改動也還看得到（watcher 沒被關掉也沒被換掉）
  {
    const hits = []
    watch.startMany([{ path: dir, send: (payload) => hits.push(payload) }])
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b')
    ok('重新 arm 之後的改動照樣送得出來', await waitHits(hits), JSON.stringify(hits))
    ok('送出來的是這個資料夾', hits.every((h) => h.path.toLowerCase() === dir.toLowerCase()), JSON.stringify(hits))
  }

  // 3) 不在清單裡的資料夾要關掉
  {
    const other = tempDir('watch-other-')
    const stale = []
    watch.startMany([{ path: other, send: (payload) => stale.push(payload) }])
    watch.startMany([{ path: dir, send: () => {} }]) // other 換掉了
    fs.writeFileSync(path.join(other, 'c.txt'), 'c')
    await sleep(600)
    ok('換到別的資料夾之後，舊的不再送事件', stale.length === 0, JSON.stringify(stale))
  }

  watch.stop()
  console.log(`\n${failed ? 'FAILED' : 'OK'} — ${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
