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
 *   7 兩欄各有一條指令列與一組搜尋篩選條件，各算各的
 *   8 右欄自己有一排磁碟鈕，換槽不必先點右欄再去側欄
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
// 拖到資料夾列要有個資料夾可以停；名字排前面，第一屏就看得到。
fs.mkdirSync(path.join(BIG, 'aa-subfolder'), { recursive: true })
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

/** 右欄導覽：點路徑列打字進去，跟使用者的走法一樣。 */
async function gotoSecond(cdp, dir) {
  await cdp.eval(`(() => {
    document.getElementById('exSecondPathBar').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const input = document.getElementById('exSecondPathInput')
    input.value = ${json(dir)}
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    return true
  })()`)
  await waitFor(
    () => cdp.eval(`((document.getElementById('exSecondCrumbs') || {}).dataset.path || '').toLowerCase() === ${json(dir.toLowerCase())}`),
    20_000,
    `右欄切到 ${dir}`
  )
  await sleep(600)
}

/** 就地改名的輸入框（新增／改名都不跳對話框）：出現在哪一欄、目前帶的值 */
function inlineState(cdp) {
  return cdp.eval(`(() => {
    const input = document.activeElement
    if (!input || !input.classList.contains('inline-edit-input')) return null
    return {
      value: input.value,
      pane: input.closest('#exSecondList') ? 'right' : input.closest('#exList') ? 'left' : input.closest('#exPlaces') ? 'places' : 'other',
      dialog: !!document.querySelector('dialog[open]')
    }
  })()`)
}

/** 在就地輸入框打字，按 Enter（或 Esc）結束。 */
function fillInline(cdp, value, key = 'Enter') {
  return cdp.eval(`(() => {
    const input = document.activeElement
    if (!input || !input.classList.contains('inline-edit-input')) return false
    input.value = ${json(value)}
    input.dispatchEvent(new KeyboardEvent('keydown', { key: ${json(key)}, bubbles: true }))
    return true
  })()`)
}

/** 視窗寬度會影響版面（詳情欄在 900px 以下整個收掉），驗收前先固定成同一個尺寸。 */
async function fitWindow(cdp) {
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1280, height: 860, deviceScaleFactor: 1, mobile: false
    })
    await sleep(500)
  } catch {
    // 沒有 Emulation domain 就照預設尺寸跑
  }
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
  await fitWindow(cdp)
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
  const leftInline = await waitFor(() => inlineState(cdp), 8_000, '新增資料夾的就地輸入框')
  assert(leftInline.pane === 'left' && leftInline.value === '新增資料夾' && !leftInline.dialog,
    '新增資料夾：先建「新增資料夾」再就地改名，沒有對話框', json(leftInline))
  assert(fs.existsSync(path.join(LEFT, '新增資料夾')), '「新增資料夾」已先建好（跟檔案總管一樣）')
  await fillInline(cdp, '左欄建的')
  await sleep(2_000)
  assert(fs.existsSync(path.join(LEFT, '左欄建的')) && !fs.existsSync(path.join(LEFT, '新增資料夾')), '就地改名後資料夾建在左欄')

  await cdp.eval(`document.getElementById('exNewFileBtn').click()`)
  const fileInline = await waitFor(() => inlineState(cdp), 8_000, '新增檔案的就地輸入框')
  assert(fileInline.value === '新文字文件.txt', '新增檔案先建「新文字文件.txt」', json(fileInline))
  await fillInline(cdp, 'ignored', 'Escape')
  await sleep(1_500)
  assert(fs.existsSync(path.join(LEFT, '新文字文件.txt')) && !fs.existsSync(path.join(LEFT, 'ignored')),
    'Esc＝保留預設名稱（跟檔案總管一樣）')
  await cdp.eval(`(() => {
    const row = [...document.querySelectorAll('#exList .ex-row')].find((r) => r.dataset.name === '新文字文件.txt')
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    document.getElementById('exList').focus()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }))
  })()`)
  const f2 = await waitFor(() => inlineState(cdp), 8_000, 'F2 就地改名')
  assert(f2.value === '新文字文件.txt' && f2.pane === 'left', 'F2 在那一列就地改名', json(f2))
  await fillInline(cdp, '改過名.txt')
  await sleep(1_500)
  assert(fs.existsSync(path.join(LEFT, '改過名.txt')) && !fs.existsSync(path.join(LEFT, '新文字文件.txt')), 'F2 改名落到磁碟')
  fs.rmSync(path.join(LEFT, '改過名.txt'), { force: true })
  await cdp.eval(`(() => { document.querySelector('#exList .ex-row').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 })); return true })()`)
  assert(await waitFor(() => cdp.eval(`document.querySelectorAll('.ws-menu').length`), 8_000, '左欄右鍵').catch(() => 0), '左欄右鍵選單照舊')
  await cdp.eval(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
  await sleep(400)

  console.log('\n[2] 作用欄')
  await cdp.eval(`document.getElementById('exDualBtn').click()`)
  await waitFor(() => cdp.eval(`document.querySelectorAll('#exSecondList .ex-row').length > 0`), 30_000, '右欄列出來')
  await sleep(1_000)
  // 還沒點過右欄，右欄的指令列就該長出來了（以前要點一下才畫）
  const freshBar = await cdp.eval(`[...document.querySelectorAll('#exSecondCmdBar button')].map((b) => b.textContent.trim())`)
  assert(freshBar.length >= 9 && freshBar.includes('貼上'), '一開雙欄右欄指令列就在', json(freshBar))
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
  const rightPath = await cdp.eval(`(document.getElementById('exSecondCrumbs') || {}).dataset.path || ''`)
  await cdp.eval(`document.getElementById('exNewFolderBtn').click()`)
  const rightInline = await waitFor(() => inlineState(cdp), 8_000, '右欄就地輸入框')
  assert(rightInline.pane === 'right', '右欄作用時，輸入框開在右欄', json(rightInline))
  await fillInline(cdp, '從右欄建的')
  await sleep(2_500)
  assert(fs.existsSync(path.join(rightPath, '從右欄建的')), '新增資料夾建在右欄', rightPath)
  const before = await cdp.eval(`({ left: (document.querySelector('#exTabStrip .ex-tab.is-active') || {}).dataset?.path || '', right: (document.getElementById('exSecondCrumbs') || {}).dataset.path || '' })`)
  await cdp.eval(`(() => { const item = document.querySelector('#exDrives .ex-side-item'); if (!item) return false; item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); item.click(); return true })()`)
  await sleep(2_000)
  const after = await cdp.eval(`({ left: (document.querySelector('#exTabStrip .ex-tab.is-active') || {}).dataset?.path || '', right: (document.getElementById('exSecondCrumbs') || {}).dataset.path || '' })`)
  assert(after.left === before.left && after.right !== before.right, '側欄導覽只動右欄', json({ before, after }))

  // 側欄位置改名也是就地打字
  const openPlaceRename = async () => {
    await cdp.eval(`(() => {
      const item = document.querySelector('#exPlaces .ex-side-item')
      item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 200 }))
    })()`)
    await waitFor(() => cdp.eval(`document.querySelectorAll('.ws-menu-item').length`), 8_000, '位置右鍵')
    await cdp.eval(`[...document.querySelectorAll('.ws-menu-item')].find((b) => b.textContent === '重新命名').click()`)
    return waitFor(() => inlineState(cdp), 8_000, '位置就地改名')
  }
  const placeInline = await openPlaceRename()
  assert(placeInline.pane === 'places' && !placeInline.dialog, '側欄位置就地改名，沒有對話框', json(placeInline))
  const oldLabel = placeInline.value
  await fillInline(cdp, 'E2E 位置')
  await waitFor(() => cdp.eval(`document.querySelector('#exPlaces .ex-side-item .ex-side-label')?.textContent === 'E2E 位置'`), 8_000, '位置改名生效')
  passed += 1
  console.log('  PASS 位置改名生效')
  await openPlaceRename()
  await fillInline(cdp, oldLabel)
  await sleep(800)

  console.log('\n[4] 大資料夾的洞')
  await gotoSecond(cdp, BIG)
  await sleep(900)
  cdp.errors.length = 0
  // 這段驗的是稀疏陣列，不是 shell 開檔：先把 openPath 換掉，免得雙擊真的叫起記事本。
  await cdp.eval(`(() => { window.__openPath = window.electronAPI.explorer.openPath
    window.electronAPI.explorer.openPath = async () => ({ ok: true, data: {} })
    return true })()`)
  await cdp.eval(`(() => { const l = document.getElementById('exSecondList'); l.scrollTop = l.scrollHeight; l.dispatchEvent(new Event('scroll')); return true })()`)
  await sleep(3_000)
  await cdp.eval(`(() => { const rows = [...document.querySelectorAll('#exSecondList .ex-row')]; const last = rows[rows.length - 1]; if (last) last.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })); return true })()`)
  await sleep(2_000)
  assert(cdp.errors.length === 0, '捲到底雙擊不丟例外', json(cdp.errors))
  await cdp.eval(`(() => { window.electronAPI.explorer.openPath = window.__openPath; return true })()`)

  console.log('\n[5] 跨欄鈕的來源不會被作用欄帶偏')
  await gotoSecond(cdp, RIGHT)
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

  console.log('\n[6] 右欄的分頁、麵包屑、圖示檢視、整機搜尋、拖到資料夾列')
  // 分頁：開第二個右欄分頁，兩個分頁各記各的路徑
  const firstTab = await cdp.eval(`(document.querySelector('#exSecondTabStrip .ex-tab.is-active') || {}).dataset?.id || ''`)
  await cdp.eval(`document.getElementById('exSecondTabAddBtn').click()`)
  await waitFor(() => cdp.eval(`document.querySelectorAll('#exSecondTabStrip .ex-tab').length === 2`), 15_000, '右欄第二個分頁')
  await sleep(800)
  await gotoSecond(cdp, LEFT)
  const tabs = await cdp.eval(`({
    count: document.querySelectorAll('#exSecondTabStrip .ex-tab').length,
    active: (document.querySelector('#exSecondTabStrip .ex-tab.is-active') || {}).dataset?.id || '',
    path: (document.getElementById('exSecondCrumbs') || {}).dataset.path || ''
  })`)
  assert(tabs.count === 2 && tabs.active !== firstTab && tabs.path.toLowerCase() === LEFT.toLowerCase(),
    '右欄第二個分頁自己一條路徑', json(tabs))
  await cdp.eval(`(() => {
    const tab = [...document.querySelectorAll('#exSecondTabStrip .ex-tab')].find((t) => t.dataset.id === ${json(firstTab)})
    tab.querySelector('.ex-tab-open').click()
    return true
  })()`)
  await waitFor(() => cdp.eval(`((document.getElementById('exSecondCrumbs') || {}).dataset.path || '').toLowerCase() === ${json(RIGHT.toLowerCase())}`), 15_000, '切回第一個右欄分頁')
  assert(true, '切回右欄分頁路徑還在')

  // 麵包屑：點上一層那顆真的上去
  const crumb = await cdp.eval(`(() => {
    const crumbs = [...document.querySelectorAll('#exSecondCrumbs .ex-crumb')]
    const target = crumbs[crumbs.length - 2]
    if (!target) return ''
    const want = target.title
    target.click()
    return want
  })()`)
  await sleep(1_800)
  const afterCrumb = await cdp.eval(`(document.getElementById('exSecondCrumbs') || {}).dataset.path || ''`)
  assert(crumb && afterCrumb.toLowerCase() === crumb.toLowerCase(), '麵包屑點得動', json({ crumb, afterCrumb }))
  await gotoSecond(cdp, BIG)

  // 圖示檢視
  await cdp.eval(`document.getElementById('exSecondViewGridBtn').click()`)
  await sleep(1_000)
  const grid = await cdp.eval(`({
    isGrid: document.getElementById('exSecondList').classList.contains('is-grid'),
    tile: document.getElementById('exSecondList').dataset.tile,
    pressed: document.getElementById('exSecondViewGridBtn').getAttribute('aria-pressed'),
    rows: document.querySelectorAll('#exSecondList .ex-row').length
  })`)
  assert(grid.isGrid && grid.pressed === 'true' && grid.rows > 0, '右欄切得到圖示檢視', json(grid))
  await cdp.eval(`document.getElementById('exSecondViewListBtn').click()`)
  await sleep(600)
  assert(await cdp.eval(`!document.getElementById('exSecondList').classList.contains('is-grid')`), '右欄切得回清單')

  // 整機搜尋：這台測試機沒裝 UFFS，驗範圍切得過去、提示講得出原因、切回來清單回來
  await cdp.eval(`document.getElementById('exSecondScopeBtn').click()`)
  await cdp.eval(`(() => {
    const input = document.getElementById('exSecondSearch')
    input.value = 'item-00001'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(1_500)
  const scoped = await cdp.eval(`({
    label: document.getElementById('exSecondScopeBtn').title,
    pressed: document.getElementById('exSecondScopeBtn').getAttribute('aria-pressed'),
    placeholder: document.getElementById('exSecondSearch').placeholder,
    hint: document.getElementById('exSecondSearchHint').textContent.trim()
  })`)
  assert(/整機/.test(scoped.label) && scoped.pressed === 'true' && /整機/.test(scoped.placeholder),
    '右欄切得到整機搜尋', json(scoped))
  assert(scoped.hint.length > 0, '沒有索引時講得出原因', json(scoped))
  await cdp.eval(`(() => {
    document.getElementById('exSecondScopeBtn').click()
    const input = document.getElementById('exSecondSearch')
    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(1_000)
  assert(await cdp.eval(`document.querySelectorAll('#exSecondList .ex-row').length > 0`), '切回本資料夾清單回來')

  // 拖到資料夾列：合成一個帶 Files 的 dragover，列要變成放置目標，停久了自己進去
  const hover = await cdp.eval(`(() => {
    const row = [...document.querySelectorAll('#exSecondList .ex-row')].find((r) => r.dataset.name === 'aa-subfolder')
    if (!row) return { found: false }
    const dt = new DataTransfer()
    dt.items.add(new File([''], 'x.txt'))
    row.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
    return { found: true, drop: row.classList.contains('is-drop'), path: row.dataset.path }
  })()`)
  assert(hover.found && hover.drop, '資料夾列是放置目標', json(hover))
  await sleep(1_200)
  const entered = await cdp.eval(`(document.getElementById('exSecondCrumbs') || {}).dataset.path || ''`)
  assert(entered.toLowerCase() === String(hover.path).toLowerCase(), '拖著停在資料夾上會進去', json({ entered, hover }))

  console.log('\n[7] 右欄自己的指令列與篩選面板')
  await gotoSecond(cdp, RIGHT)
  // 指令列：兩條各算各的選取。右欄選 R1、左欄不選，兩邊的「刪除」狀態就該相反。
  await cdp.eval(`(() => {
    const row = [...document.querySelectorAll('#exSecondList .ex-row')].find((r) => r.dataset.name === 'R1.txt')
    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return true
  })()`)
  await sleep(600)
  const bars = await cdp.eval(`(() => {
    const read = (id) => [...document.querySelectorAll('#' + id + ' button')]
      .map((b) => ({ label: b.textContent.trim(), off: b.disabled }))
    return { right: read('exSecondCmdBar'), left: read('exCmdBar') }
  })()`)
  const cmd = (bar, label) => bar.find((b) => b.label === label)
  assert(bars.right.length === bars.left.length && bars.right.length >= 9, '右欄有自己一整條指令列', json(bars.right.map((b) => b.label)))
  assert(cmd(bars.right, '刪除') && !cmd(bars.right, '刪除').off, '右欄指令列吃右欄選取', json(bars.right))
  assert(cmd(bars.left, '刪除') && cmd(bars.left, '刪除').off, '左欄指令列不吃右欄選取', json(bars.left))
  // 按右欄的「刪除」要刪右欄的東西（Enter 確認）
  await cdp.eval(`[...document.querySelectorAll('#exSecondCmdBar button')].find((b) => b.textContent.trim() === '刪除').click()`)
  await waitFor(() => cdp.eval(`!!document.querySelector('dialog[open]')`), 8_000, '刪除確認')
  await cdp.eval(`document.querySelector('dialog[open]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`)
  await sleep(2_500)
  assert(!fs.existsSync(path.join(RIGHT, 'R1.txt')), '右欄指令列刪的是右欄的檔案', json(fs.readdirSync(RIGHT)))
  assert(fs.existsSync(path.join(LEFT, 'R1.txt')), '左欄那份沒被動到')
  // 篩選面板：只有整機搜尋時出現，而且跟左欄各記各的
  assert(await cdp.eval(`document.getElementById('exSecondSearchFilters').hidden === true`), '篩目前資料夾時右欄篩選面板收著')
  await cdp.eval(`document.getElementById('exSecondScopeBtn').click()`)
  await sleep(600)
  const filters = await cdp.eval(`(() => {
    document.getElementById('exSearchType').value = 'image'
    document.getElementById('exSecondSearchType').value = 'video'
    return {
      hidden: document.getElementById('exSecondSearchFilters').hidden,
      left: document.getElementById('exSearchType').value,
      right: document.getElementById('exSecondSearchType').value,
      head: Math.round(document.querySelector('.ex-second-head').getBoundingClientRect().height)
    }
  })()`)
  assert(filters.hidden === false, '切整機就看得到右欄篩選面板', json(filters))
  assert(filters.left === 'image' && filters.right === 'video', '兩欄的篩選條件各記各的', json(filters))
  assert(filters.head <= 110, '多一顆篩選鈕標頭沒有變胖', json(filters))
  await cdp.eval(`(() => {
    document.getElementById('exSearchType').value = 'all'
    document.getElementById('exSecondSearchType').value = 'all'
    document.getElementById('exSecondScopeBtn').click()
    return true
  })()`)
  await sleep(600)

  console.log('\n[8] 右欄自己的磁碟鈕')
  const drives = await cdp.eval(`[...document.querySelectorAll('#exSecondDrives .ex-second-drive')]
    .map((b) => ({ label: b.textContent.trim(), path: b.dataset.path, on: b.getAttribute('aria-pressed') }))`)
  assert(drives.length > 0, '右欄列得出磁碟', json(drives))
  assert(drives.some((d) => d.on === 'true'), '目前那顆磁碟有標起來', json(drives))
  // 挑一顆「不是現在這顆」的。優先挑專案所在那顆（一定是本機實體碟、列得出東西），
  // 不然遇到對應出來的網路磁碟會逾時，測到的是網路不是這排鈕。
  const repoDrive = `${__dirname[0].toUpperCase()}:`
  const others = drives.filter((d) => d.on !== 'true')
  const other = others.find((d) => d.label.toUpperCase() === repoDrive) || others[0]
  if (other) {
    const leftBefore = await cdp.eval(`(document.getElementById('exCrumbs') || {}).dataset.path || ''`)
    await cdp.eval(`[...document.querySelectorAll('#exSecondDrives .ex-second-drive')]
      .find((b) => b.dataset.path === ${json(other.path)}).click()`)
    await waitFor(
      () => cdp.eval(`((document.getElementById('exSecondCrumbs') || {}).dataset.path || '').toLowerCase() === ${json(other.path.toLowerCase())}`),
      20_000,
      '右欄換磁碟'
    )
    const after = await cdp.eval(`({
      left: (document.getElementById('exCrumbs') || {}).dataset.path || '',
      on: [...document.querySelectorAll('#exSecondDrives .ex-second-drive')].find((b) => b.getAttribute('aria-pressed') === 'true')?.dataset.path || '',
      active: document.getElementById('exSecondPane').classList.contains('is-active-pane')
    })`)
    assert(after.left === leftBefore, '換右欄磁碟不會動到左欄', json({ leftBefore, after }))
    assert(after.on.toLowerCase() === other.path.toLowerCase(), '換過去之後標記跟著換', json(after))
    assert(after.active === true, '按磁碟鈕順便把作用欄切成右欄', json(after))
  }
  await cdp.eval(`document.getElementById('exSecondUp').click()`)
  await sleep(1_500)
  const atHome = await cdp.eval(`({
    crumb: (document.getElementById('exSecondCrumbs') || {}).dataset.path || '',
    empty: (document.getElementById('exSecondEmpty') || {}).textContent || '',
    hidden: (document.getElementById('exSecondEmpty') || {}).hidden
  })`)
  assert(/選一顆磁碟/.test(atHome.empty) && atHome.hidden === false, '右欄在本機時會指路去磁碟鈕', json(atHome))

  console.log('\n[9] 關雙欄回左欄')
  await cdp.eval(`document.getElementById('exDualBtn').click()`)
  await sleep(800)
  const off = await cdp.eval(`({
    status: (document.getElementById('exStatusText') || {}).textContent || '',
    rightBar: document.querySelectorAll('#exSecondCmdBar button').length
  })`)
  assert(!/^右欄：/.test(off.status), '狀態列回左欄', json(off))
  assert(off.rightBar === 0, '關掉雙欄右欄指令列也清空', json(off))

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
