#!/usr/bin/env node
/**
 * VoiceInk — 「檔案」分頁打包版回歸（CDP）
 *
 * 不點畫面上的「第一列」、不刪使用者的檔。自種暫存資料夾只走 IPC，測完刪掉。
 * 收尾只 taskkill 自己的 pid。
 */

'use strict'

const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { tempDir, removeTree } = require('./lib/test-temp')
const http = require('http')

const PORT = 9281
const EXE = process.env.VOICEINK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
const USER_DATA_DIR = tempDir('voiceink-e2e-ex-')
const SEED_DIR = path.join(USER_DATA_DIR, 'seed-folder')
fs.mkdirSync(SEED_DIR, { recursive: true })
fs.writeFileSync(path.join(SEED_DIR, 'hello.txt'), 'hello')
fs.mkdirSync(path.join(SEED_DIR, 'sub'))
fs.writeFileSync(path.join(USER_DATA_DIR, 'config.json'), JSON.stringify({ sysmonSensors: false }))
fs.writeFileSync(path.join(USER_DATA_DIR, 'explorer.json'), JSON.stringify({
  uffsAuto: false,
  lastPath: SEED_DIR,
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

function stopTestApp(child) {
  if (child?.pid) {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch { /* 程序已結束 */ }
  }
}

class Cdp {
  constructor(url) {
    this.url = url
    this.id = 0
    this.pending = new Map()
    this.errors = []
  }

  async connect(page = true) {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve)
      this.ws.addEventListener('error', () => reject(new Error('CDP WebSocket 連不上')))
    })
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Runtime.exceptionThrown') this.errors.push(message.params.exceptionDetails.text)
      if (!message.id || !this.pending.has(message.id)) return
      const pending = this.pending.get(message.id)
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
    await this.send('Runtime.enable')
    if (page) await this.send('Page.enable')
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
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
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
  let last
  while (Date.now() < deadline) {
    last = await fn()
    if (last) return last
    await sleep(200)
  }
  throw new Error(`逾時：${label}`)
}

function assert(cond, name, detail) {
  if (!cond) throw new Error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`  PASS ${name}`)
}

async function main() {
  if (!fs.existsSync(EXE)) {
    console.log(`SKIP 找不到 ${EXE}（先 npm run electron:pack）`)
    return
  }
  let child = null
  let cdp = null
  let mainCdp = null
  // 與 workspace 探針相同，使用 Electron 的隱藏視窗擷取，避免 CDP 等不到畫格。
  const screenshot = () => mainCdp.eval(`process.mainModule.require('electron').BrowserWindow.getAllWindows()
    .find(win => /index\\.html/.test(win.webContents.getURL())).webContents
    .capturePage(undefined, { stayHidden: true, stayAwake: true }).then(image => image.toPNG().toString('base64'))`)
  try {
    child = spawn(EXE, [
      '--hidden',
      '--inspect=127.0.0.1:9282',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${USER_DATA_DIR}`
    ], { stdio: 'ignore' })
    const version = await waitFor(async () => {
      try {
        return await getJson(`http://127.0.0.1:${PORT}/json/version`)
      } catch {
        return null
      }
    }, 40_000, 'CDP 起來')
    const targets = await waitFor(async () => {
      const list = await getJson(`http://127.0.0.1:${PORT}/json/list`)
      return list.find((t) => t.type === 'page' && /index\.html/.test(t.url))
    }, 20_000, '主視窗')
    cdp = new Cdp(targets.webSocketDebuggerUrl)
    await cdp.connect()
    const mainTarget = await waitFor(async () => {
      try { return (await getJson('http://127.0.0.1:9282/json/list'))[0] } catch { return null }
    }, 10_000, '主程序 inspector')
    mainCdp = new Cdp(mainTarget.webSocketDebuggerUrl)
    await mainCdp.connect(false)
    await waitFor(
      () => cdp.eval('document.readyState === \'complete\' && typeof window.electronAPI?.explorer?.listDir === \'function\''),
      20_000,
      'preload'
    )

    console.log('\n[A] nav')
    const order = await cdp.eval(`[...document.querySelectorAll('.header-nav .nav-tab')].map((el) => el.dataset.page)`)
    assert(order[0] === 'chat' && order[1] === 'explorer', '檔案排在聊天後面', JSON.stringify(order))
    assert(order.includes('settings') && !order.includes('terminal'), '仍有設定、沒有 terminal 分頁', JSON.stringify(order))

    console.log('\n[B] 頁面結構')
    await cdp.eval('document.querySelector(\'[data-page="explorer"]\').click()')
    const ui = await waitFor(() => cdp.eval(`(() => {
      const page = document.getElementById('page-explorer')
      if (!page || !page.classList.contains('active')) return null
      const side = document.querySelector('#page-explorer .ex-sidebar')
      const s = side ? getComputedStyle(side) : null
      return {
        search: !!document.getElementById('exSearch'),
        list: !!document.getElementById('exList'),
        places: !!document.getElementById('exPlaces'),
        radius: s && s.borderRadius,
        blur: s && (s.backdropFilter || s.webkitBackdropFilter || ''),
        surface: s && s.backgroundColor
      }
    })()`), 15_000, '檔案頁')
    assert(ui.search && ui.list && ui.places, '搜尋框／清單／側欄都在', JSON.stringify(ui))
    assert(ui.radius === '12px', '側欄 12px 圓角', ui.radius)
    assert(/blur/.test(ui.blur || ''), '側欄有玻璃 blur', ui.blur)

    console.log('\n[C] IPC 只動自種資料夾')
    const listed = await cdp.eval(`window.electronAPI.explorer.listDir(${JSON.stringify(SEED_DIR)})`)
    assert(listed.ok === true, 'listDir 成功', JSON.stringify(listed.error))
    const names = (listed.data.entries || []).map((e) => e.name).sort()
    assert(names.includes('hello.txt') && names.includes('sub'), '列得出自種檔案', names.join(','))

    const seedUi = await waitFor(() => cdp.eval(`(() => {
      const row = document.querySelector('#exList [data-id="hello.txt"]')
      if (!row || row.offsetHeight < 8) return null
      return { path: row.dataset.path, draggable: row.draggable === true, height: row.offsetHeight }
    })()`), 15_000, '畫面列出自種檔案')
    assert(seedUi.draggable, '列可拖曳', JSON.stringify(seedUi))

    const chrome = await cdp.eval(`(() => {
      const rec = document.querySelector('#exPlaces [data-id="recycle"]')
      const head = document.getElementById('exListHead')
      return {
        recycle: rec ? rec.textContent : '',
        recyclePath: rec ? rec.dataset.path : '',
        newFile: !!document.getElementById('exNewFileBtn'),
        sortHead: !!(head && head.querySelectorAll('.ex-sort').length === 3),
        emptyBin: !!document.getElementById('exEmptyBinBtn')
      }
    })()`)
    assert(/資源回收筒/.test(chrome.recycle), '側欄有資源回收筒', JSON.stringify(chrome))
    assert(chrome.recyclePath === 'recyclebin', '回收筒是虛擬位置', JSON.stringify(chrome))
    assert(chrome.newFile && chrome.sortHead && chrome.emptyBin, '新增檔案／排序列／清空鈕都在', JSON.stringify(chrome))

    const menu = await cdp.eval(`(() => {
      const row = document.querySelector('#exList [data-id="hello.txt"]')
      if (!row) return { open: false, labels: [] }
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 140, clientY: 180 }))
      const el = document.querySelector('.ws-menu')
      const labels = el ? [...el.querySelectorAll('.ws-menu-item')].map((n) => n.textContent) : []
      return { open: !!(el && el.offsetHeight > 0), labels }
    })()`)
    assert(menu.open, '右鍵選單開得出來', JSON.stringify(menu))
    assert(menu.labels.includes('開啟') && menu.labels.includes('複製') && menu.labels.includes('刪除'),
      '選單有開啟／複製／刪除', JSON.stringify(menu.labels))
    await cdp.eval(`(() => { document.querySelector('.ws-menu')?.remove() })()`)

    const clicked = await cdp.eval(`(() => {
      document.getElementById('exSearch')?.blur()
      const row = document.querySelector('#exList [data-id="sub"]')
      if (!row) return { ok: false, reason: 'no-row' }
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      const next = document.querySelector('#exList [data-id="sub"]')
      if (next && typeof next.focus === 'function') next.focus()
      return {
        ok: true,
        selected: !!(next && next.classList.contains('is-selected')),
        focusId: document.activeElement && document.activeElement.getAttribute('data-id'),
        pageActive: document.getElementById('page-explorer')?.classList.contains('active')
      }
    })()`)
    assert(clicked.ok && clicked.selected, '點了 sub 資料夾', JSON.stringify(clicked))
    await cdp.eval(`(() => {
      const row = document.querySelector('#exList [data-id="sub"]')
      if (row) row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })()`)
    const entered = await waitFor(() => cdp.eval(`(() => {
      const crumbs = [...document.querySelectorAll('#exCrumbs .ex-crumb')].map((el) => el.textContent)
      if (!crumbs.includes('sub')) return null
      return {
        crumbs,
        helloGone: !document.querySelector('#exList [data-id="hello.txt"]')
      }
    })()`), 10_000, 'Enter 進入 sub')
    assert(entered.helloGone, '點資料夾再 Enter 進入該資料夾', JSON.stringify(entered))
    await cdp.eval(`document.getElementById('exUpBtn').click()`)
    await waitFor(() => cdp.eval(`!!document.querySelector('#exList [data-id="hello.txt"]')`), 10_000, '回到種子資料夾')

    const created = await cdp.eval(
      `window.electronAPI.explorer.createEntry(${JSON.stringify(SEED_DIR)}, 'e2e-folder', true)`
    )
    assert(created.ok === true, '新增資料夾', JSON.stringify(created.error))
    const renamed = await cdp.eval(
      `window.electronAPI.explorer.renameEntry(${JSON.stringify(created.data.path)}, 'e2e-renamed')`
    )
    assert(renamed.ok === true, '改名', JSON.stringify(renamed.error))
    const removed = await cdp.eval(
      `window.electronAPI.explorer.removeEntry(${JSON.stringify(renamed.data.path)})`
    )
    assert(removed.ok === true, '刪掉自種資料夾', JSON.stringify(removed.error))

    console.log('\n[D] 路徑逃逸')
    const device = await cdp.eval(`window.electronAPI.explorer.listDir('\\\\\\\\.\\\\C:')`)
    assert(device.ok === false && device.error && device.error.code === 'BAD_PATH', '裝置路徑被擋', JSON.stringify(device))
    assert(!String(device.error.message || '').includes('C:'), '錯誤訊息不含路徑', JSON.stringify(device.error))

    console.log('\n[E] UFFS 狀態是結構化物件')
    const st = await cdp.eval('window.electronAPI.explorer.uffsStatus()')
    assert(st.ok === true && typeof st.data.installed === 'boolean', 'uffsStatus', JSON.stringify(st))
    assert(st.data.broker && typeof st.data.broker.installed === 'boolean', 'broker.installed 是布林', JSON.stringify(st.data.broker))
    const ensured = await cdp.eval('window.electronAPI.explorer.uffsEnsure()')
    assert(ensured.ok === true, 'uffsEnsure 在暫存 userData 不跳 UAC', JSON.stringify(ensured.error))
    const enableBtn = await cdp.eval(`(() => {
      const btn = document.getElementById('exUffsEnableBtn')
      return { exists: !!btn, hidden: btn ? btn.hidden : null }
    })()`)
    assert(enableBtn.exists === true, '啟用鈕在 DOM 裡', JSON.stringify(enableBtn))

    console.log('\n[F] 捷徑、圖示與滑鼠側鍵')
    cdp.errors.length = 0
    const shortcut = await cdp.eval(`window.electronAPI.explorer.createShortcut(${JSON.stringify(path.join(SEED_DIR, 'sub'))}, ${JSON.stringify(SEED_DIR)})`)
    assert(shortcut.ok, '建立真實 Windows 資料夾捷徑', JSON.stringify(shortcut.error))
    await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'F5', bubbles:true, cancelable:true}))`)
    const linkName = path.basename(shortcut.data.path)
    await waitFor(() => cdp.eval(`!![...document.querySelectorAll('#exList .ex-row')].find(r => r.dataset.name === ${JSON.stringify(linkName)})`), 10_000, '捷徑出現在清單')
    const resolved = await cdp.eval(`window.electronAPI.explorer.resolvePath(${JSON.stringify(shortcut.data.path)})`)
    assert(resolved.ok && resolved.data.dir && resolved.data.path === path.join(SEED_DIR, 'sub'), '真實捷徑解析為資料夾')
    await waitFor(() => cdp.eval(`[...document.querySelectorAll('#exList .ex-row')].find(r => r.dataset.name === ${JSON.stringify(linkName)})?.querySelector('.ex-row-icon.is-shortcut')?.textContent === '📁'`), 10_000, '捷徑顯示資料夾與箭頭')
    await waitFor(() => cdp.eval(`document.querySelector('#exList [data-id="hello.txt"] .ex-row-icon img')?.naturalWidth > 0`), 10_000, 'Windows 檔案圖示')
    assert(await cdp.eval(`document.querySelector('#exList [data-id="hello.txt"] .ex-row-icon img').src.startsWith('data:image/png;base64,')`), '文字檔使用 Windows 圖示')
    const iconShots = path.join(__dirname, '..', 'dist', 'explorer-tabs-qa')
    fs.mkdirSync(iconShots, { recursive: true })
    for (const mode of ['list', 'grid']) {
      await cdp.eval(`document.getElementById('${mode === 'grid' ? 'exViewGridBtn' : 'exViewListBtn'}').click()`)
      await sleep(300)
      const shot = await screenshot()
      fs.writeFileSync(path.join(iconShots, `icons-${mode}.png`), Buffer.from(shot, 'base64'))
      assert(await cdp.eval(`document.querySelector('#exList [data-id="hello.txt"] .ex-row-icon img')?.naturalWidth > 0`), `${mode} 圖示正常顯示`)
    }
    await cdp.eval(`document.getElementById('exViewListBtn').click()`)
    const pageUrl = await cdp.eval('location.href')
    await cdp.eval(`[...document.querySelectorAll('#exList .ex-row')].find(r => r.dataset.name === ${JSON.stringify(linkName)}).dispatchEvent(new MouseEvent('dblclick', {bubbles:true}))`)
    await waitFor(() => cdp.eval(`document.querySelector('.ex-tab.is-active').dataset.path === ${JSON.stringify(path.join(SEED_DIR, 'sub'))}`), 10_000, '捷徑在目前分頁開啟')
    assert(await cdp.eval(`document.querySelectorAll('.ex-tab').length === 1`), '開啟捷徑沿用目前分頁')
    const point = await cdp.eval(`(() => { const r = document.getElementById('exList').getBoundingClientRect(); return {x:r.x+40,y:r.y+40} })()`)
    for (const button of ['back', 'forward', 'back']) {
      await cdp.send('Input.dispatchMouseEvent', { type:'mousePressed', button, buttons:button === 'back' ? 8 : 16, clickCount:1, ...point })
      await cdp.send('Input.dispatchMouseEvent', { type:'mouseReleased', button, buttons:0, clickCount:1, ...point })
      const dest = button === 'back' ? SEED_DIR : path.join(SEED_DIR, 'sub')
      await waitFor(() => cdp.eval(`document.querySelector('.ex-tab.is-active').dataset.path === ${JSON.stringify(dest)}`), 10_000, `滑鼠側鍵 ${button}`)
      assert(await cdp.eval('location.href') === pageUrl, `側鍵 ${button} 只改資料夾，不離開 App`)
    }

    console.log('\n[G] 分頁與本機首頁')
    const firstId = await cdp.eval(`document.querySelector('.ex-tab.is-active').dataset.id`)
    await cdp.eval(`document.getElementById('exTabAddBtn').click()`)
    await waitFor(() => cdp.eval(`document.querySelectorAll('.ex-tab').length === 2 && document.getElementById('exHome').offsetHeight > 0`), 10_000, '新增分頁開首頁')
    const homeUi = await cdp.eval(`({
      path: document.querySelector('.ex-tab.is-active').dataset.path,
      listHidden: document.getElementById('exList').offsetHeight === 0,
      createHidden: document.getElementById('exNewFileBtn').offsetHeight === 0,
      detailHidden: document.getElementById('exDetail').offsetHeight === 0,
      upDisabled: document.getElementById('exUpBtn').disabled,
      pasteDisabled: [...document.querySelectorAll('#exCmdBar button')].find(b => b.textContent === '貼上').disabled
    })`)
    assert(homeUi.path === 'thispc' && homeUi.listHidden && homeUi.createHidden && homeUi.detailHidden && homeUi.upDisabled && homeUi.pasteDisabled,
      '首頁顯示正確並關閉無效操作', JSON.stringify(homeUi))
    const info = await cdp.eval(`window.electronAPI.explorer.driveInfo()`)
    assert(info.ok && info.data.some(d => d.total > 0 && d.free >= 0 && d.free <= d.total), '真實磁碟容量讀取成功')
    await waitFor(() => cdp.eval(`!!document.querySelector('.ex-home-bar-fill')`), 12_000, '磁碟容量條')
    const homeId = await cdp.eval(`document.querySelector('.ex-tab.is-active').dataset.id`)
    await cdp.eval(`document.querySelector('.ex-home-card').dispatchEvent(new MouseEvent('auxclick', {button: 1, bubbles: true, cancelable: true}))`)
    await waitFor(() => cdp.eval(`document.querySelectorAll('.ex-tab').length === 3 && document.querySelector('.ex-tab.is-active').dataset.path !== 'thispc'`), 10_000, '首頁中鍵另開資料夾')
    await cdp.eval(`document.querySelector('.ex-tab.is-active .ex-tab-close').click()`)
    await waitFor(() => cdp.eval(`document.querySelectorAll('.ex-tab').length === 2 && document.getElementById('exHome').offsetHeight > 0`), 10_000, '關閉回首頁')
    await cdp.eval(`document.querySelector('[data-id="${firstId}"] .ex-tab-open').click()`)
    await waitFor(() => cdp.eval(`document.getElementById('exList').offsetHeight > 0 && !!document.querySelector('#exList [data-id="hello.txt"]')`), 10_000, '原分頁仍在原位置')
    await cdp.eval(`document.querySelector('#exList [data-id="sub"]').dispatchEvent(new MouseEvent('dblclick', {bubbles: true}))`)
    await waitFor(() => cdp.eval(`document.querySelector('.ex-tab.is-active').dataset.path.endsWith('sub')`), 10_000, '原分頁進子資料夾')
    await cdp.eval(`document.querySelector('[data-id="${homeId}"] .ex-tab-open').click()`)
    await waitFor(() => cdp.eval(`document.getElementById('exHome').offsetHeight > 0`), 10_000, '切首頁')
    assert(await cdp.eval(`document.getElementById('exBackBtn').disabled`), '新分頁沒有混入原分頁歷史')
    await cdp.eval(`document.querySelector('[data-id="${firstId}"] .ex-tab-open').click()`)
    await waitFor(() => cdp.eval(`document.querySelector('.ex-tab.is-active').dataset.path.endsWith('sub') && !document.getElementById('exBackBtn').disabled`), 10_000, '歷史保留')
    await cdp.eval(`document.getElementById('exBackBtn').click()`)
    await waitFor(() => cdp.eval(`!!document.querySelector('#exList [data-id="hello.txt"]')`), 10_000, '獨立上一頁')
    assert(await cdp.eval(`!document.getElementById('exForwardBtn').disabled`), '上一頁／下一頁可用')
    await cdp.eval(`document.querySelector('[data-page="chat"]').click()`)
    await cdp.eval(`document.querySelector('[data-page="explorer"]').click()`)
    await waitFor(() => cdp.eval(`document.querySelectorAll('.ex-tab').length === 2 && document.getElementById('exList').offsetHeight > 0`), 10_000, '切回檔案頁保留分頁')
    assert(await cdp.eval(`!document.getElementById('exForwardBtn').disabled`), '切換 App 頁面保留瀏覽歷史')
    await cdp.eval(`document.querySelector('[data-id="${homeId}"] .ex-tab-open').click()`)
    await waitFor(() => cdp.eval(`document.getElementById('exHome').offsetHeight > 0`), 10_000, '截圖首頁')
    const shots = path.join(__dirname, '..', 'dist', 'explorer-tabs-qa')
    fs.mkdirSync(shots, { recursive: true })
    for (const [name, width, theme] of [['dark', 1280, 'dark'], ['light', 1280, 'light'], ['narrow', 800, 'dark']]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })
      await cdp.eval(`document.documentElement.setAttribute('data-theme', '${theme}')`)
      await sleep(400)
      const shot = await screenshot()
      fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(shot, 'base64'))
      assert(await cdp.eval(`document.getElementById('page-explorer').scrollWidth <= document.getElementById('page-explorer').clientWidth + 1`), `${name} 無水平溢出`)
    }
    await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', {key: 't', ctrlKey: true, bubbles: true, cancelable: true}))`)
    await waitFor(() => cdp.eval(`document.querySelectorAll('.ex-tab').length === 3`), 10_000, 'Ctrl+T')
    await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', {key: 'w', ctrlKey: true, bubbles: true, cancelable: true}))`)
    await waitFor(() => cdp.eval(`document.querySelectorAll('.ex-tab').length === 2`), 10_000, 'Ctrl+W')
    assert(true, 'Ctrl+T／Ctrl+W 新增與關閉')
    const bootHome = await cdp.eval(`(async () => { await window.electronAPI.explorer.saveState({lastPath: ''}); return window.electronAPI.explorer.bootstrap() })()`)
    assert(bootHome.ok && bootHome.data.lastPath === 'thispc', '未存路徑時預設本機首頁')
    assert(cdp.errors.length === 0, '分頁操作沒有未處理的 renderer 例外', cdp.errors.join(', '))
  } finally {
    if (mainCdp) mainCdp.close()
    if (cdp) cdp.close()
    stopTestApp(child)
    try { removeTree(USER_DATA_DIR) } catch { /* 暫存 */ }
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
