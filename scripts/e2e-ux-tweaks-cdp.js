/**
 * 打包版 CDP 驗證：這一輪的四項使用體驗調整。
 *
 *  [A] 系統監控的錯誤訊息會自己收起來（不再一直卡在畫面上）
 *  [B] 風扇「固定轉速」下限預設 20%
 *  [C] 終端機：選取自動複製、右鍵貼上、窄邊框
 *  [D] 聊天側欄可拖寬，終端機跟著縮放
 *
 * 用暫存 user-data-dir，收尾只殺自己這一份，不碰使用者安裝版。
 * 注意：[C] 的剪貼簿檢查需要焦點，跑的時候會把測試視窗叫到最前面。
 * 用法：node scripts/e2e-ux-tweaks-cdp.js
 */
const { spawn, execFileSync } = require('child_process')
const path = require('path')
const http = require('http')
const os = require('os')
const fs = require('fs')

const PORT = 9271
const EXE = process.env.VOICEINK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
const USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-e2e-ux-'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => { try { resolve(JSON.parse(d)) } catch (e) { reject(e) } })
    }).on('error', reject)
  })
}

class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.ws = null; this.id = 0; this.pending = new Map() }
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
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
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

async function waitInPage(cdp, expression, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cdp.eval(`(() => { try { return !!(${expression}) } catch { return false } })()`)) return true
    await sleep(300)
  }
  return false
}

function stopTestApp(child) {
  if (!child?.pid) return
  try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 已結束 */ }
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
    '--disable-backgrounding-occluded-windows'
  ], { stdio: 'ignore' })
  let createdId = ''
  let cdp = null

  try {
    const pages = await waitTargets()
    const mainPage = pages.find((p) => /index\.html/i.test(p.url)) || pages[0]
    cdp = new Cdp(mainPage.webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Runtime.enable')
    await sleep(1500)
    // 感測器 sidecar 會跳 UAC，測試一律先關掉
    await cdp.eval(`window.electronAPI.store.set('sysmonSensors', false)`)

    // ===== [B] 風扇下限 =====
    const fans = await cdp.eval(`(async () => {
      const res = await window.electronAPI.sysmon.fanList()
      return { ok: res?.ok === true, minFloor: res?.data?.minFloor,
               floors: (res?.data?.channels || []).map((c) => c.minPwm) }
    })()`)
    ok('[B] 風扇下限的下限是 20%', fans.ok && fans.minFloor === 20, JSON.stringify(fans))
    ok('[B] 偵測到的通道預設下限就是 20（固定轉速拉得到 20%）',
      fans.floors.every((v) => v === 20), JSON.stringify(fans.floors))

    // ===== [C][D] 終端機 =====
    await cdp.eval(`document.querySelector('.nav-tab[data-page="chat"]').click()`)
    ok('聊天頁打開', await waitInPage(cdp, `document.getElementById('page-chat').classList.contains('active')`))
    ok('沒有多餘的 chat-main 外框（窄邊框的根因）',
      await cdp.eval(`document.querySelectorAll('.chat-layout > .chat-main').length === 1`),
      String(await cdp.eval(`document.querySelectorAll('.chat-main').length`)))
    await waitInPage(cdp, `document.getElementById('termNewBtn')`)

    createdId = await cdp.eval(`(async () => {
      document.getElementById('termNewBtn').click()
      await new Promise((r) => setTimeout(r, 400))
      document.getElementById('termNewCreateBtn').click()
      await new Promise((r) => setTimeout(r, 4000))
      const list = await window.electronAPI.terminal.list()
      return list.data[list.data.length - 1]?.id || ''
    })()`)
    ok('建得出終端機', !!createdId, createdId)
    ok('終端機畫面出得來',
      await waitInPage(cdp, `document.querySelector('.term-pane.is-active .xterm-screen')`, 15000))

    const inset = await cdp.eval(`(() => {
      const main = document.getElementById('termMain').getBoundingClientRect()
      const screen = document.querySelector('.term-pane.is-active .xterm-screen').getBoundingClientRect()
      return { left: Math.round(screen.left - main.left), top: Math.round(screen.top - main.top) }
    })()`)
    ok('[C] 終端機是窄邊框（左邊留白 ≤ 20px）', inset.left <= 20, JSON.stringify(inset))

    // 剪貼簿只有在視窗有焦點時讀得到（NotAllowedError: Document is not focused），
    // 而使用者右鍵的當下本來就有焦點——測試這裡要自己把視窗叫到前面。
    await cdp.send('Page.bringToFront')
    await sleep(500)
    // 選取自動複製：用真的滑鼠事件拖過第一行（合成事件不會產生 xterm 選取）
    await cdp.eval(`navigator.clipboard.writeText('__before__')`)
    const box = await cdp.eval(`(() => {
      const r = document.querySelector('.term-pane.is-active .xterm-screen').getBoundingClientRect()
      return { x: Math.round(r.left) + 4, y: Math.round(r.top) + 6, w: Math.round(r.width) }
    })()`)
    const dx = Math.min(300, box.w - 20)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + dx, y: box.y, button: 'left', buttons: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + dx, y: box.y, button: 'left', buttons: 0, clickCount: 1 })
    await sleep(800)
    const copied = await cdp.eval(`navigator.clipboard.readText()`)
    ok('[C] 選取就自動複製',
      typeof copied === 'string' && copied.trim().length > 0 && copied !== '__before__', JSON.stringify(copied))

    // 右鍵貼上：剪貼簿放一段字，右鍵後應該出現在提示字元後面
    const marker = 'ponytail_paste_ok'
    await cdp.eval(`navigator.clipboard.writeText('${marker}')`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x + 20, y: box.y + 20, button: 'right', buttons: 2, clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + 20, y: box.y + 20, button: 'right', buttons: 0, clickCount: 1 })
    const pasted = await waitInPage(cdp,
      `document.querySelector('.term-pane.is-active .xterm-rows').textContent.includes('${marker}')`, 10000)
    ok('[C] 右鍵貼上', pasted, pasted ? ''
      : String(await cdp.eval(`document.querySelector('.term-pane.is-active .xterm-rows').textContent.slice(-120)`)))

    // ===== [D] 側欄拖寬 =====
    const before = await cdp.eval(`(() => ({
      sidebar: Math.round(document.querySelector('.chat-sidebar').getBoundingClientRect().width),
      host: Math.round(document.getElementById('termHost').getBoundingClientRect().width)
    }))()`)
    const handle = await cdp.eval(`(() => {
      const r = document.getElementById('chatSidebarResizer').getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: handle.x, y: handle.y, button: 'left', buttons: 1, clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x + 120, y: handle.y, button: 'left', buttons: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: handle.x + 120, y: handle.y, button: 'left', buttons: 0, clickCount: 1 })
    await sleep(900)
    const after = await cdp.eval(`(() => ({
      sidebar: Math.round(document.querySelector('.chat-sidebar').getBoundingClientRect().width),
      host: Math.round(document.getElementById('termHost').getBoundingClientRect().width),
      saved: localStorage.getItem('chatSidebarWidth')
    }))()`)
    ok('[D] 側欄真的被拖寬', after.sidebar >= before.sidebar + 100, `${before.sidebar} → ${after.sidebar}`)
    ok('[D] 終端機跟著縮小', after.host <= before.host - 100, `${before.host} → ${after.host}`)
    ok('[D] 寬度有存起來', Number(after.saved) === after.sidebar, String(after.saved))

    // 下限夾值：拖到超級左邊也不會消失（把手已經跟著側欄移動了，位置要重讀）
    const handle2 = await cdp.eval(`(() => {
      const r = document.getElementById('chatSidebarResizer').getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: handle2.x, y: handle2.y, button: 'left', buttons: 1, clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: handle2.y, button: 'left', buttons: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 2, y: handle2.y, button: 'left', buttons: 0, clickCount: 1 })
    await sleep(600)
    const clamped = await cdp.eval(`Math.round(document.querySelector('.chat-sidebar').getBoundingClientRect().width)`)
    ok('[D] 拖到最左仍有下限（180px）', clamped >= 175 && clamped <= 190, String(clamped))

    // ===== [A] 系統監控錯誤自己收起來 =====
    await cdp.eval(`document.querySelector('.nav-tab[data-page="sysmon"]').click()`)
    await waitInPage(cdp, `document.getElementById('page-sysmon').classList.contains('active')`)
    // 分頁模組是動態載入的，聽 click 的人可能還沒到——點到真的切過去為止
    const onProcTab = await waitInPage(cdp, `(() => {
      const tab = document.querySelector('.sysmon-tab[data-subtab="processes"]')
      if (!tab.classList.contains('active')) tab.click()
      return tab.classList.contains('active')
    })()`, 20000)
    ok('[A] 切到處理程序子分頁', onProcTab)
    // 先等取樣器吐出第一批處理程序，再用搜尋把 System 撈進畫面（清單只畫看得到的那一段）
    ok('[A] 處理程序清單出得來',
      await waitInPage(cdp, `document.querySelectorAll('[data-pid]').length > 0`, 90000))
    await cdp.eval(`(() => {
      const input = document.getElementById('sysmonSearch')
      input.value = 'System'
      input.dispatchEvent(new Event('input'))
    })()`)
    const gotRow = await waitInPage(cdp, `document.querySelector('[data-pid="4"]')`, 30000)
    ok('[A] 搜尋得到 System（pid 4）', gotRow)
    if (!gotRow) throw new Error('找不到 pid 4 的那一列，無法製造錯誤')
    // pid 4 一定會被 main 擋下來（結束不了系統程序），拿它來製造一則真的錯誤
    await cdp.eval(`(() => {
      document.querySelector('[data-pid="4"]').click()
      document.getElementById('sysmonKillBtn').click()
      document.getElementById('sysmonKillConfirm').click()
    })()`)
    const shown = await waitInPage(cdp, `!document.getElementById('sysmonError').classList.contains('hidden')`, 8000)
    ok('[A] 失敗時真的有顯示錯誤', shown,
      String(await cdp.eval(`document.getElementById('sysmonError').textContent`)))
    const gone = await waitInPage(cdp, `document.getElementById('sysmonError').classList.contains('hidden')`, 15000)
    ok('[A] 8 秒後自己收起來', gone)
  } finally {
    if (cdp && createdId) {
      try { await cdp.eval(`window.electronAPI.terminal.delete('${createdId}')`) } catch { /* 已經沒了 */ }
    }
    cdp?.close()
    stopTestApp(child)
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(USER_DATA_DIR, { recursive: true, force: true }); break } catch { await sleep(600) }
    }
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => { console.error(err); process.exit(1) })
