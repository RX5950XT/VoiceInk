'use strict'

/**
 * 錄音機的錄音檔與即時字幕逐字稿（`src/main/stt-archive.js`）。
 *
 * 守的是信任邊界（renderer 送來的檔名／id 組不出 userData 以外的路徑）、
 * append 的順序與上限、以及逐字稿「同一個 key 最後一行為準」的讀法。
 *
 * 執行：node scripts/test-stt-archive.js
 */

const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { tempDir } = require('./lib/test-temp')
const archive = require('../src/main/stt-archive')

const root = tempDir('stt-archive-')
archive.configure({ userDataPath: root })

let passed = 0
function ok(name, cond) {
  assert.ok(cond, name)
  passed += 1
}

// [A] 檔名樣式擋路徑
for (const bad of ['../x.webm', 'rec-1.webm', 'rec-1234567890123.webm/../../a', 'rec-1234567890123.mp3', 'C:\\rec-1234567890123.webm']) {
  assert.throws(() => archive.appendRecording(bad, new Uint8Array([1])), /錄音檔名無效/, bad)
  passed += 1
}
for (const bad of ['../live-1234567890123', 'live-1', 'live-1234567890123.jsonl']) {
  assert.throws(() => archive.appendTranscript(bad, { key: 'b-1-1', source: 'a', translation: '' }), /字幕紀錄 id 無效/, bad)
  passed += 1
}
assert.throws(() => archive.appendTranscript('live-1234567890123', { key: '../x', source: 'a' }), /字幕資料無效/)
assert.throws(() => archive.appendRecording('rec-1234567890123.webm', 'abc'), /錄音資料無效/)
passed += 2

// [B] 錄音依序 append、讀得回來、清單新到舊、刪得掉
const a = 'rec-1700000000000.webm'
const b = 'rec-1700000100000.webm'
archive.appendRecording(a, new Uint8Array([1, 2]))
archive.appendRecording(a, new Uint8Array([3]))
archive.appendRecording(b, Buffer.from([9]))
ok('[B] 兩塊接起來', Buffer.compare(archive.readRecording(a), Buffer.from([1, 2, 3])) === 0)
const recs = archive.listRecordings()
ok('[B] 新的在前', recs[0].name === b && recs[1].name === a)
ok('[B] 路徑在 recordings 底下', recs[0].path === path.join(root, 'recordings', b))
ok('[B] 開始時間取自檔名', recs[1].startedAt === 1700000000000)
fs.writeFileSync(path.join(root, 'recordings', 'rec-1700000200000.webm'), '')
ok('[B] 空檔不列', archive.listRecordings().length === 2)
archive.deleteRecording(b)
ok('[B] 刪掉', archive.listRecordings().length === 1)

// [C] 單塊上限
assert.throws(() => archive.appendRecording(a, new Uint8Array(8 * 1024 * 1024 + 1)), /錄音資料過大/)
passed += 1

// [D] 逐字稿：同 key 最後一行為準、順序照第一次出現、壞行略過
const id = 'live-1700000000000'
archive.appendTranscript(id, { key: 'b-1-1', source: 'hello', translation: '' })
archive.appendTranscript(id, { key: 'b-1-2', source: 'world', translation: '' })
archive.appendTranscript(id, { key: 'b-1-1', source: 'hello there', translation: '你好' })
fs.appendFileSync(path.join(root, 'live-transcripts', `${id}.jsonl`), '{"k":"b-1-3","s":"半')
const rows = archive.readTranscript(id)
ok('[D] 兩筆', rows.length === 2)
ok('[D] 後寫的蓋掉前面', rows[0].source === 'hello there' && rows[0].translation === '你好')
ok('[D] 順序不變', rows[1].source === 'world')
const list = archive.listTranscripts()
ok('[D] 清單有句數與預覽', list.length === 1 && list[0].count === 2 && list[0].preview === '你好')
archive.appendTranscript('live-1700000300000', { key: 'b-1-1', source: '', translation: '' })
ok('[D] 全空的場次不列', archive.listTranscripts().length === 1)
archive.deleteTranscript(id)
assert.throws(() => archive.readTranscript(id), /找不到/)
passed += 1

// [E] IPC 外殼：非主視窗擋掉、錯誤訊息是我們自己的
const handlers = {}
archive.registerSttArchiveIpc({
  ipcMain: { handle: (ch, fn) => { handlers[ch] = fn } },
  isMainSender: (e) => e === 'main',
  openPath: async () => ''
})
;(async () => {
  const denied = await handlers['sttArchive:recordings']('other')
  ok('[E] 非主視窗擋掉', denied.ok === false && denied.error.code === 'FORBIDDEN')
  const bad = await handlers['sttArchive:readRecording']('main', '../../config.json')
  ok('[E] 壞檔名回固定訊息', bad.ok === false && bad.error.message === '錄音檔名無效')
  const good = await handlers['sttArchive:recordings']('main')
  ok('[E] 正常回清單', good.ok === true && Array.isArray(good.data))
  console.log(`test-stt-archive: ${passed} passed`)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
