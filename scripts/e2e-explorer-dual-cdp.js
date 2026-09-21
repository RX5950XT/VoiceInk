#!/usr/bin/env node
/**
 * VoiceInk — 檔案總管「雙欄」的真畫面驗收（CDP）。
 *
 * 雙欄原本只有一份唯讀清單：上面那排指令列、右鍵選單、鍵盤、拖放、側欄導覽
 * 全部只服務左欄。這支驗的是「作用欄」——點哪一欄，那些東西就對哪一欄生效：
 *   1 點右欄＝右欄變作用欄，狀態列與指令列跟著換
 *   2 右欄有右鍵選單、方向鍵、可拖曳
 *   3 新增資料夾／貼上建在作用欄，不是永遠建在左欄
 *   4 側欄的位置／磁碟導覽送到作用欄
 *   5 大資料夾（未載入頁面是洞）捲到底雙擊不丟例外
 *   6 左欄單欄模式照舊，四顆跨欄鈕的來源不會被作用欄帶偏
 *
 * 只動自種的暫存資料夾，測完刪掉；收尾只 taskkill 自己的 pid。
 */

'use strict'

const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const http = require('http')
const { tempDir, removeTree } = require('./lib/test-temp')

// 與其他 explorer e2e 平行跑時不能共用埠或 profile。
const PORT = 9297
const INSPECT_PORT = 9298
const EXE = process.env.VOICEINK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
const USER_DATA_DIR = tempDir('voiceink-e2e-dual-')

/** 超過一頁（BROWSE_PAGE_SIZE=500）才會出現「未載入頁面是洞」的稀疏陣列。 */
const BIG_COUNT = 2600
const BIG = path.join(USER_DATA_DIR, 'big')
const LEFT = path.join(USER_DATA_DIR, 'left')
const RIGHT = path.join(USER_DATA_DIR, 'right')

for (const dir of [BIG, LEFT, RIGHT]) fs.mkdirSync(dir, { recursive: true })
for (let i = 0; i < BIG_COUNT; i += 1) {
  fs.writeFileSync(path.join(BIG, `item-${String(i).padStart(5, '0')}.txt`), String(i))
}
for (const name of ['L1.txt', 'L2.txt', 'L3.txt']) fs.writeFileSync(path.join(LEFT, name), name)
fs.writeFileSync(path.join(RIGHT, 'R1.txt'), 'R1')

fs.writeFileSync(path.join(USER_DATA_DIR, 'config.json'), JSON.stringify({ sysmonSensors: false }))
fs.writeFileSync(path.join(USER_DATA_DIR, 'explorer.json'), JSON.stringify({
  uffsAuto: false,
  lastPath: LEFT,
  view: 'list'
}))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = ''
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (error) { reject(error) }
      })
    })
    request.setTimeout(2_000, () => request.destroy(new Error('CDP HTTP 逾時')))
    request.on('error', reject)
  })
}

class Cdp {
  constructor(url) {
    this.url = url
    this.id = 0
    this.pending = new Map()
    this.errors = []
  }

  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve)
      this.ws.addEventListener('error', () => reject(new Error('CDP WebSocket 連不上')))
    })
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Runtime.exceptionThrown') {
        this.errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text)
      }
      if (!message.id || !this.pending.has(message.id)) return
      const pending = this.pending.get(message.id)
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
    await this.send('Runtime.enable')
    await this.send('Page.enable')
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP 逾時：${method}`))
      }, 30_000)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    }
    return result.result?.value
  }

  close() {
    for (const item of this.pending.values()) clearTimeout(item.timer)
    try { this.ws.close() } catch { /* 已關 */ }
  }
}

async function waitFor(fn, ms, label) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = await fn().catch(() => null)
    if (value) return value
    await sleep(150)
  }
  throw new Error(`逾時：${label}`)
}

let passed = 0
function assert(cond, name, detail) {
  if (!cond) throw new Error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  passed += 1
  console.log(`  PASS ${name}`)
}

const json = (value) => JSON.stringify(value)

/** 把 app-dialog 的輸入框填一填按確定。 */
function fillDialog(cdp, value) {
  return cdp.eval(`(() => {
    const dialog = document.querySelector('dialog[open]')
    if (!dialog) return false
    const input = dialog.querySelector('input')
    input.value = ${json(value)}
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const ok = [...dialog.querySelectorAll('button')].find((b) => /確定|建立|新增|前往|OK/.test(b.textContent))
    ;(ok || dialog.querySelector('form button')).click()
    return true
  })()`)
}

let child
;(async () => {
  // VOICEINK_EXE 指到 electron.exe 時是跑原始碼（要先起 vite），得補上 app 目錄。
  const args = /electron\.exe$/i.test(EXE) ? ['.'] : []
  child = spawn(EXE, [
    ...args,
    '--hidden',
    `--inspect=127.0.0.1:${INSPECT_PORT}`,
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DATA_DIR}`
  ], { cwd: path.join(__dirname, '..'), stdio: 'ignore' })
  await waitFor(() => getJson(`http://127.0.0.1:${PORT}/json/version`), 90_000, 'CDP 起來')
  const target = await waitFor(async () => {
    const list = await getJson(`http://127.0.0.1:${PORT}/json/list`)
    return list.find((t) => t.type === 'page' && /(index\.html|5173)/.test(t.url))
  }, 30_000, '主視窗')
  const cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.connect()
  await waitFor(
    () => cdp.eval(`document.readyState === 'complete' && typeof window.electronAPI?.explorer?.listDir === 'function'`),
    40_000,
    'preload'
  )
  await cdp.eval(`document.querySelector('[data-page="explorer"]').click()`)
  await waitFor(() => cdp.eval(`document.getElementById('page-explorer')?.classList.contains('active')`), 15_000, '檔案頁')
  await waitFor(() => cdp.eval(`document.querySelectorAll('#exList .ex-row').length > 0`), 40_000, '第一批列出來')
  await sleep(1_000)

  console.log('\n[1] 單欄照舊')
  const single = await cdp.eval(`({
    status: (document.getElementById('exStatusText') || {}).textContent || '',
    paste: !([...document.querySelectorAll('#exCmdBar button')].find((b) => b.textContent.trim() === '貼上') || {}).disabled,
    dualHidden: document.getElementById('exSecondPane').hidden
  })`)
  assert(/3 個項目/.test(single.status) && !/^右欄：/.test(single.status), '狀態列還是左欄的', json(single.status))
  assert(single.paste === true && single.dualHidden === true, '貼上鈕可按、右欄收著', json(single))
  await cdp.eval(`document.getElementById('exNewFolderBtn').click()`)
  await waitFor(() => cdp.eval(`!!document.querySelector('dialog[open] input')`), 8_000, '新增資料夾對話框')
  await fillDialog(cdp, '左欄建的')
  await sleep(2_000)
  assert(fs.existsSync(path.join(LEFT, '左欄建的')), '新增資料夾建在左欄')
  await cdp.eval(`(() => { document.querySelector('#exList .ex-row').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 })); return true })()`)
  assert(await waitFor(() => cdp.eval(`document.querySelectorAll('.ws-menu').length`), 8_000, '左欄右鍵').catch(() => 0), '左欄右鍵選單照舊')
  await cdp.eval(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
  await sleep(400)

  console.log('\n[2] 作用欄')
  await cdp.eval(`document.getElementById('exDualBtn').click()`)
  await waitFor(() => cdp.eval(`document.querySelectorAll('#exSecondList .ex-row').length > 0`), 30_000, '右欄列出來')
  await sleep(1_000)
  const picked = await cdp.eval(`(() => {
    const row = document.querySelector('#exSecondList .ex-row')
    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return {
      status: (document.getElementById('exStatusText') || {}).textContent || '',
      right: document.getElementById('exSecondPane').classList.contains('is-active-pane'),
      left: document.getElementById('exContent').classList.contains('is-active-pane'),
      draggable: row.draggable
    }
  })()`)
  assert(picked.right && !picked.left, '點右欄＝右欄變作用欄', json(picked))
  assert(/^右欄：/.test(picked.status) && /已選取 1 個/.test(picked.status), '狀態列跟著換', json(picked.status))
  assert(picked.draggable === true, '右欄列可拖曳')
  await cdp.eval(`(() => { document.querySelector('#exSecondList .ex-row').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 600, clientY: 300 })); return true })()`)
  assert(await waitFor(() => cdp.eval(`document.querySelectorAll('.ws-menu').length`), 8_000, '右欄右鍵').catch(() => 0), '右欄有右鍵選單')
  await cdp.eval(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
  await sleep(400)
  const keyed = await cdp.eval(`(() => {
    const list = document.getElementById('exSecondList')
    list.focus()
    const before = [...document.querySelectorAll('#exSecondList .ex-row.is-selected')].map((r) => r.dataset.name)
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    const after = [...document.querySelectorAll('#exSecondList .ex-row.is-selected')].map((r) => r.dataset.name)
    return { before, after }
  })()`)
  assert(keyed.after.length === 1 && keyed.after[0] !== keyed.before[0], '右欄方向鍵換選取', json(keyed))

  console.log('\n[3] 新增與側欄導覽跟著作用欄')
  const rightPath = await cdp.eval(`(document.getElementById('exSecondPath') || {}).textContent || ''`)
  await cdp.eval(`document.getElementById('exNewFolderBtn').click()`)
  await waitFor(() => cdp.eval(`!!document.querySelector('dialog[open] input')`), 8_000, '對話框')
  await fillDialog(cdp, '從右欄建的')
  await sleep(2_500)
  assert(fs.existsSync(path.join(rightPath, '從右欄建的')), '新增資料夾建在右欄', rightPath)
  const before = await cdp.eval(`({ left: (document.querySelector('.ex-tab.is-active') || {}).dataset?.path || '', right: (document.getElementById('exSecondPath') || {}).textContent || '' })`)
  await cdp.eval(`(() => { const item = document.querySelector('#exDrives .ex-side-item'); if (!item) return false; item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); item.click(); return true })()`)
  await sleep(2_000)
  const after = await cdp.eval(`({ left: (document.querySelector('.ex-tab.is-active') || {}).dataset?.path || '', right: (document.getElementById('exSecondPath') || {}).textContent || '' })`)
  assert(after.left === before.left && after.right !== before.right, '側欄導覽只動右欄', json({ before, after }))

  console.log('\n[4] 大資料夾的洞')
  await cdp.eval(`document.getElementById('exSecondPath').click()`)
  await waitFor(() => cdp.eval(`!!document.querySelector('dialog[open] input')`), 8_000, '右欄路徑框')
  await fillDialog(cdp, BIG)
  await waitFor(() => cdp.eval(`((document.getElementById('exSecondPath') || {}).textContent || '').toLowerCase() === ${json(BIG.toLowerCase())}`), 20_000, '右欄切到大資料夾')
  await sleep(1_500)
  cdp.errors.length = 0
  await cdp.eval(`(() => { const l = document.getElementById('exSecondList'); l.scrollTop = l.scrollHeight; l.dispatchEvent(new Event('scroll')); return true })()`)
  await sleep(3_000)
  await cdp.eval(`(() => { const rows = [...document.querySelectorAll('#exSecondList .ex-row')]; const last = rows[rows.length - 1]; if (last) last.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })); return true })()`)
  await sleep(2_000)
  assert(cdp.errors.length === 0, '捲到底雙擊不丟例外', json(cdp.errors))

  console.log('\n[5] 跨欄鈕的來源不會被作用欄帶偏')
  await cdp.eval(`document.getElementById('exSecondPath').click()`)
  await waitFor(() => cdp.eval(`!!document.querySelector('dialog[open] input')`), 8_000, '右欄路徑框')
  await fillDialog(cdp, RIGHT)
  await waitFor(() => cdp.eval(`((document.getElementById('exSecondPath') || {}).textContent || '').toLowerCase() === ${json(RIGHT.toLowerCase())}`), 20_000, '右欄切到 right')
  await sleep(800)
  await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('#exList .ex-row')].filter((r) => /^L[12]\\.txt$/.test(r.dataset.name || ''))
    rows.forEach((row, i) => {
      row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: i > 0 }))
    })
    return rows.length
  })()`)
  await sleep(400)
  await cdp.eval(`document.getElementById('exMoveToSecond').click()`)
  await sleep(2_500)
  assert(
    ['L1.txt', 'L2.txt'].every((n) => fs.existsSync(path.join(RIGHT, n)) && !fs.existsSync(path.join(LEFT, n))),
    '左→右搬移搬的是左欄選取',
    json({ right: fs.readdirSync(RIGHT), left: fs.readdirSync(LEFT) })
  )
  await cdp.eval(`(() => {
    const row = [...document.querySelectorAll('#exSecondList .ex-row')].find((r) => r.dataset.name === 'R1.txt')
    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return true
  })()`)
  await sleep(400)
  await cdp.eval(`document.getElementById('exCopyFromSecond').click()`)
  await sleep(2_500)
  assert(
    fs.existsSync(path.join(LEFT, 'R1.txt')) && fs.existsSync(path.join(RIGHT, 'R1.txt')),
    '右→左複製複製的是右欄選取',
    json({ left: fs.readdirSync(LEFT) })
  )

  console.log('\n[6] 關雙欄回左欄')
  await cdp.eval(`document.getElementById('exDualBtn').click()`)
  await sleep(800)
  const off = await cdp.eval(`({ status: (document.getElementById('exStatusText') || {}).textContent || '' })`)
  assert(!/^右欄：/.test(off.status), '狀態列回左欄', json(off))

  console.log(`\n全部通過（${passed}）`)
  console.log('全程例外', json(cdp.errors))
  cdp.close()
})().catch((error) => {
  console.error(`\n${error.message}`)
  process.exitCode = 1
}).finally(async () => {
  await sleep(300)
  if (child?.pid) {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 已結束 */ }
  }
  await sleep(1_200)
  try { removeTree(USER_DATA_DIR) } catch { /* 下次開機清 */ }
})
