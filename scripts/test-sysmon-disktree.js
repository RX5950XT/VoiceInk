#!/usr/bin/env node
/**
 * 磁碟空間：假的子程序測逐行解析，有 voiceink-probe.exe 再對暫存資料夾掃一次。
 */
'use strict'

const { EventEmitter } = require('events')
const fs = require('fs')
const path = require('path')
const { tempDir } = require('./lib/test-temp')

const ROOT = path.join(__dirname, '..')
const { createDiskTree } = require(path.join(ROOT, 'src/main/sysmon/disktree'))

let passed = 0
let failed = 0
function ok(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  PASS ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve))
}

function makeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stdout.setEncoding = () => {}
  child.kill = () => {
    child.killed = true
    setImmediate(() => child.emit('close', 1))
  }
  return child
}

/** 立刻接上，避免取消發生在下一個 await 之前被當成 unhandled rejection。 */
function capture(promise) {
  return promise.then(() => null, (err) => err)
}

/**
 * `capture` 把拒絕轉成一般的值；沒包過的 promise 則在這裡接住。
 * @param {Promise<any>} promise
 * @param {string} code
 * @param {string} [message]
 */
async function rejects(promise, code, message) {
  const err = await Promise.resolve(promise).then(
    (value) => (value && value.code ? value : null),
    (caught) => caught
  )
  ok(`拒絕 ${code}`, err?.code === code, err?.code || '沒有拒絕')
  if (message) ok(`訊息 ${message}`, err?.userMessage === message, err?.userMessage)
  return err
}

function harness(emit) {
  const children = []
  const calls = []
  const tree = createDiskTree({
    exe: 'C:\\voiceink-probe.exe',
    emit,
    statFn: async () => ({ isDirectory: () => true }),
    spawnFn: (file, args, opts) => {
      calls.push({ file, args, opts })
      const child = makeChild()
      children.push(child)
      return child
    }
  })
  return { tree, children, calls }
}

const SAMPLE = {
  root: 'D:\\data',
  bytes: 20,
  files: 2,
  dirs: 1,
  incomplete: false,
  reason: '',
  ms: 3,
  tree: { n: 'D:\\data', s: 20, f: 2, k: 'd' }
}

async function testParse() {
  console.log('\n[逐行解析]')
  const events = []
  const { tree, children, calls } = harness((payload) => events.push(payload))
  const pending = tree.scan('D:\\data')
  await tick()
  ok('只開一顆', children.length === 1)
  ok('指令是 disk-tree', calls[0].args[0] === 'disk-tree' && calls[0].args[1] === 'D:\\data')
  ok('上限 180 秒／深度 12／留 200', calls[0].args.slice(2).join(',') === '180000,12,200')
  ok('視窗藏起來', calls[0].opts.windowsHide === true && calls[0].opts.stdio[1] === 'pipe')

  const child = children[0]
  child.stdout.emit('data', 'P 10 1 0\r\nP 20 2 ')
  child.stdout.emit('data', '1\n')
  ok('進度兩筆', events.length === 2 && events[0].data.bytes === 10 && events[1].data.files === 2)
  ok('進度形狀', events[1].type === 'diskTreeProgress' && events[1].data.dirs === 1)

  const json = JSON.stringify(SAMPLE)
  child.stdout.emit('data', `J ${json.slice(0, 8)}`)
  child.stdout.emit('data', `${json.slice(8)}\n`)
  child.emit('close', 0)
  const result = await pending
  ok('J 解析後 resolve', result.bytes === 20 && result.tree.k === 'd' && result.files === 2)
}

async function testErrors() {
  console.log('\n[錯誤與取消]')
  const bad = harness(() => {})
  const badScan = capture(bad.tree.scan('D:\\data'))
  await tick()
  bad.children[0].stdout.emit('data', 'J {not-json}\n')
  await rejects(badScan, 'DISKTREE_BAD_JSON', '掃描結果無法解析')

  const missing = harness(() => {})
  const missingScan = capture(missing.tree.scan('D:\\data'))
  await tick()
  missing.children[0].stdout.emit('data', 'E read\n')
  await rejects(missingScan, 'DISKTREE_READ', '讀不到這個資料夾')

  const running = harness(() => {})
  const first = capture(running.tree.scan('D:\\data'))
  await tick()
  running.tree.cancel()
  await rejects(first, 'DISKTREE_CANCELLED', '掃描已取消')
  ok('取消會砍程序', running.children[0].killed === true)

  const again = harness(() => {})
  const older = capture(again.tree.scan('D:\\old'))
  await tick()
  const newer = again.tree.scan('D:\\new')
  await tick()
  ok('新的掃描砍掉舊的', again.children[0].killed === true && again.children.length === 2)
  again.children[1].stdout.emit('data', `J ${JSON.stringify(SAMPLE)}\n`)
  const got = await newer
  ok('新的那次有結果', got.bytes === 20)
  await rejects(older, 'DISKTREE_CANCELLED')
}

async function testPaths() {
  console.log('\n[路徑]')
  const none = createDiskTree({ exe: '' })
  await rejects(none.scan('D:\\data'), 'DISKTREE_NO_PROBE', '需要先建置 voiceink-probe（npm run build:probe）')

  let spawned = false
  const tree = createDiskTree({
    exe: 'C:\\voiceink-probe.exe',
    spawnFn: () => { spawned = true; return makeChild() }
  })
  await rejects(tree.scan('relative\\dir'), 'DISKTREE_BAD_PATH', '請選擇一個資料夾')
  await rejects(tree.scan('\\\\.\\PhysicalDrive0'), 'DISKTREE_BAD_PATH')
  await rejects(tree.scan(12), 'DISKTREE_BAD_PATH')
  const dir = tempDir('disktree-path-')
  const file = path.join(dir, 'note.txt')
  fs.writeFileSync(file, 'hi')
  await rejects(tree.scan(file), 'DISKTREE_BAD_PATH', '請選擇一個資料夾')
  await rejects(tree.scan(path.join(dir, 'missing')), 'DISKTREE_BAD_PATH', '讀不到這個資料夾')
  ok('壞路徑不啟動', spawned === false)

  const { tree: live, children } = harness(() => {})
  await rejects(capture(live.scan('not-absolute')), 'DISKTREE_BAD_PATH')
  const running = capture(live.scan('D:\\data'))
  await tick()
  ok('相對路徑不會砍掉正在掃的', children.length === 1 && children[0].killed !== true)
  live.stop()
  await rejects(running, 'DISKTREE_CANCELLED')
}

async function testService() {
  console.log('\n[服務接線]')
  const { createSysmonService } = require(path.join(ROOT, 'src/main/sysmon'))
  const events = []
  let child = null
  const service = createSysmonService({
    diskTreeExe: 'C:\\voiceink-probe.exe',
    diskTreeStat: async () => ({ isDirectory: () => true }),
    diskTreeSpawn: () => {
      child = makeChild()
      return child
    }
  })
  service.setEmitter((payload) => events.push(payload))
  const pending = capture(service.diskTree('D:\\VoiceInk'))
  await tick()
  child.stdout.emit('data', 'P 5 1 0\n')
  await tick()
  ok('進度走 sysmon emit', events[0]?.type === 'diskTreeProgress' && events[0].data.bytes === 5)
  await service.shutdown()
  await rejects(pending, 'DISKTREE_CANCELLED')
  ok('shutdown 砍掉掃描', child.killed === true)
  ok('取消回 true', service.diskTreeCancel() === true)
}

function testLists() {
  console.log('\n[三份清單]')
  const ipc = fs.readFileSync(path.join(ROOT, 'src/main/sysmon/ipc.js'), 'utf8')
  const preload = fs.readFileSync(path.join(ROOT, 'src/preload/preload.js'), 'utf8')
  const main = fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf8')
  ok('ipc 有 diskTree', ipc.includes("'sysmon:diskTree'") && ipc.includes('service.diskTree('))
  ok('ipc 有 diskTreeCancel', ipc.includes("'sysmon:diskTreeCancel'") && ipc.includes('service.diskTreeCancel()'))
  ok('preload 有兩支', preload.includes('diskTree: (rootPath)') && preload.includes('diskTreeCancel:'))
  ok('main 白名單有兩支', main.includes('diskTree: (...args)') && main.includes('diskTreeCancel: (...args)'))
}

async function testRealExe() {
  console.log('\n[真的 probe]')
  const exe = path.join(ROOT, 'resources', 'probe', 'voiceink-probe.exe')
  if (!fs.existsSync(exe)) {
    console.log('  SKIP 沒有 voiceink-probe.exe')
    return
  }
  const dir = tempDir('disktree-live-')
  const outside = tempDir('disktree-live-out-')
  fs.writeFileSync(path.join(dir, 'a.txt'), Buffer.alloc(1000))
  fs.mkdirSync(path.join(dir, 'sub'))
  fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), Buffer.alloc(500))
  fs.writeFileSync(path.join(outside, 'secret.bin'), Buffer.alloc(5000))
  fs.symlinkSync(outside, path.join(dir, 'link'), 'junction')

  const events = []
  const tree = createDiskTree({ exe, emit: (payload) => events.push(payload) })
  const result = await tree.scan(dir)
  tree.stop()
  ok('位元組', result.bytes === 1500, String(result.bytes))
  ok('檔案數', result.files === 2, String(result.files))
  ok('資料夾數', result.dirs === 1, String(result.dirs))
  ok('樹的總量跟合計一樣', result.tree.s === 1500 && result.tree.f === 2)
  ok('根名稱是路徑', result.root === dir && result.tree.n === dir, result.root)
  ok('沒被截斷', result.incomplete === false && result.tree.t === undefined)
  const names = (result.tree.c || []).map((node) => node.n)
  ok('不跟著連結走', !names.includes('link') && result.bytes === 1500, names.join(','))
  const file = (result.tree.c || []).find((node) => node.n === 'a.txt')
  const sub = (result.tree.c || []).find((node) => node.n === 'sub')
  ok('檔案在前', file?.s === 1000 && file?.k === 'f' && sub?.s === 500 && sub?.k === 'd')
  ok('子資料夾裡有 b.txt', sub?.c?.[0]?.n === 'b.txt' && sub.c[0].s === 500)
  ok('進度是數字', events.every((event) => event.type === 'diskTreeProgress'
    && Number.isFinite(event.data.bytes)))
}

testParse()
  .then(testErrors)
  .then(testPaths)
  .then(testService)
  .then(testLists)
  .then(testRealExe)
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed === 0 ? 0 : 1)
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
