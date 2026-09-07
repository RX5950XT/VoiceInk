/**
 * 打包版 CDP 實測：大檔案切分頁、預覽變更、專案隔離、輸入法游標、選單圖示。
 *
 * 為什麼要打包版：Monaco 是從 `node_modules/monaco-editor/min/vs` 載的，
 * `build.files` 有沒有把它放行、CSP 有沒有擋住 blob worker，只有打包版看得出來。
 *
 * 量的不是「快幾毫秒」（背景視窗的計時本來就不準）而是**有沒有重做**：
 * 切回同一個分頁時 `monaco.editor.createModel` 不該再被呼叫。
 *
 * 全程用自己的暫存 user-data-dir，收尾只殺自己 spawn 的那個 pid。
 *
 * 用法：node scripts/probe-workspace-perf.js
 */
const { spawn, execFileSync } = require('child_process')
const path = require('path')
const http = require('http')
const os = require('os')
const fs = require('fs')

const PORT = 9251
const EXE = process.env.VOICEINK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
const USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-perf-'))
fs.writeFileSync(path.join(USER_DATA_DIR, 'config.json'), JSON.stringify({ sysmonSensors: false }))

const PROJECT_A = path.join(USER_DATA_DIR, 'proj-a')
const PROJECT_B = path.join(USER_DATA_DIR, 'proj-b')
fs.mkdirSync(PROJECT_A)
fs.mkdirSync(PROJECT_B)

/** 約 1.4MB、四萬行——工作區的讀檔上限是 2MB，這是「還開得起來的最大檔」那一類 */
const BIG_LINES = 40000
const bigOriginal = Array.from({ length: BIG_LINES }, (_, i) => `const line${i} = ${i} // 一行程式碼佔位`).join('\n')
const bigModified = bigOriginal.replace(/const line100 = 100/, 'const line100 = 999')
fs.writeFileSync(path.join(PROJECT_A, 'big.js'), bigOriginal)
fs.writeFileSync(path.join(PROJECT_B, 'small.js'), 'const b = 1\n')

// A 是 git repo：committed 大檔 → 改一行，這樣才有「預覽變更」可以看
const git = (...args) => execFileSync('git', args, { cwd: PROJECT_A, stdio: 'ignore', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
git('init', '-q')
git('config', 'user.email', 'probe@example.invalid')
git('config', 'user.name', 'probe')
git('add', '-A')
git('commit', '-qm', 'seed')
fs.writeFileSync(path.join(PROJECT_A, 'big.js'), bigModified)

fs.writeFileSync(path.join(USER_DATA_DIR, 'workspaces.json'), JSON.stringify({
  projects: [
    { id: 'w_perf_a', name: '效能 A', path: PROJECT_A, createdAt: Date.now() },
    { id: 'w_perf_b', name: '效能 B', path: PROJECT_B, createdAt: Date.now() }
  ]
}))

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
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) {
      const d = r.exceptionDetails
      throw new Error(d.exception?.description || d.exception?.value || d.text || 'eval error')
    }
    return r.result?.value
  }
  close() { try { this.ws.close() } catch { /* 已斷線 */ } }
}

async function waitTargets(timeoutMs = 40000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const pages = (await getJson(`http://127.0.0.1:${PORT}/json/list`)).filter((t) => t.type === 'page')
      if (pages.length) return pages
    } catch { /* 還沒起來 */ }
    await sleep(400)
  }
  throw new Error('timeout waiting for CDP targets')
}

async function waitInPage(cdp, expression, timeoutMs = 30000) {
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
  const note = (text) => console.log(`      · ${text}`)

  const child = spawn(EXE, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DATA_DIR}`,
    '--hidden',
    '--disable-backgrounding-occluded-windows'
  ], { stdio: 'ignore' })
  let cdp = null

  try {
    const pages = await waitTargets()
    const mainPage = pages.find((p) => /index\.html/i.test(p.url)) || pages[0]
    cdp = new Cdp(mainPage.webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Runtime.enable')
    await sleep(1500)
    // 只縮小自己這份暫存 App，不去搶使用者正在用的那扇視窗
    await cdp.eval('window.electronAPI.window.minimize()')

    await cdp.eval(`document.querySelector('.nav-tab[data-page="chat"]').click()`)
    ok('工作區載得起來', await waitInPage(cdp, `!!document.getElementById('wsTabStrip')`))

    // ===== 「＋」選單的圖示 =====
    const menu = await cdp.eval(`(async () => {
      document.getElementById('wsNewBtn').click()
      await new Promise((r) => setTimeout(r, 300))
      const items = [...document.querySelectorAll('.ws-new-item')].map((btn) => {
        const svg = btn.querySelector('svg.ws-tool-icon')
        const box = svg ? svg.getBoundingClientRect() : null
        const stroke = svg ? getComputedStyle(svg).stroke : ''
        const fill = svg ? getComputedStyle(svg).fill : ''
        return {
          label: btn.textContent.trim(),
          paths: svg ? svg.querySelectorAll('path').length : 0,
          w: box ? Math.round(box.width) : 0,
          h: box ? Math.round(box.height) : 0,
          painted: svg ? (stroke !== 'none' || fill !== 'none') : false
        }
      })
      // 選單靠 window 上的 pointerdown 關；事件要發在真的 Node 上（發在 window 上
      // 那支 listener 的 menuEl.contains(target) 會拋 TypeError，選單反而關不掉）
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 100))
      return items
    })()`)
    ok(`選單 ${menu.length} 項全部有圖示`, menu.length >= 8 && menu.every((i) => i.paths > 0),
      menu.map((i) => `${i.label}:${i.paths}`).join(' '))
    ok('圖示量得到 16×16 而且真的有顏色',
      menu.every((i) => i.w === 16 && i.h === 16 && i.painted),
      JSON.stringify(menu[0]))

    // ===== 開專案 A、開大檔 =====
    await cdp.eval(`document.getElementById('sidebarModeProjects').click()`)
    await waitInPage(cdp, `!!document.querySelector('#projList [data-id="w_perf_a"]')`)
    await cdp.eval(`document.querySelector('#projList [data-id="w_perf_a"] .chat-list-open').click()`)
    await sleep(1200)

    // 打包版的 renderer 是 vite bundle，模組路徑不能直接 import——一律走 UI
    await waitInPage(cdp, `document.querySelectorAll('#wsTree .ws-tree-row').length >= 1`)
    await cdp.eval(`document.querySelector('#wsTree .ws-tree-row[data-rel="big.js"]').click()`)
    ok('1.4MB／4 萬行的檔案開得起來（Monaco 接手）',
      await waitInPage(cdp, `!!window.monaco && window.monaco.editor.getModels().some((m) => m.getLineCount() > 39000)`))

    // 從這裡開始數 createModel：切回同一個分頁不該再建
    await cdp.eval(`(() => {
      window.__made = 0
      const original = window.monaco.editor.createModel
      window.monaco.editor.createModel = function (...args) { window.__made += 1; return original.apply(this, args) }
    })()`)

    // ===== 預覽變更（diff 分頁）=====
    // 「看未提交變更」＝編輯器工具列那顆（大檔的 diff 就是這條路）
    ok('工具列出現「看未提交變更」', await waitInPage(cdp, `!document.getElementById('wsEditorDiffBtn')?.hidden`))
    await cdp.eval(`document.getElementById('wsEditorDiffBtn').click()`)
    ok('大檔的「看未提交變更」開得起來',
      await waitInPage(cdp, `!document.getElementById('wsDiffMonaco')?.hidden`))
    const madeForDiff = await cdp.eval('window.__made')
    note(`第一次開 diff 建了 ${madeForDiff} 顆 model`)

    // 編輯器 ⇄ diff 來回五趟：不該再建任何一顆
    const swap = await cdp.eval(`(async () => {
      const t0 = performance.now()
      const strip = document.getElementById('wsTabStrip')
      const tabs = [...strip.querySelectorAll('.ws-tab .ws-tab-open')]
      for (let i = 0; i < 5; i += 1) {
        for (const tab of tabs) {
          tab.click()
          await new Promise((r) => setTimeout(r, 120))
        }
      }
      return { made: window.__made, ms: Math.round(performance.now() - t0), tabs: tabs.length }
    })()`)
    ok('編輯器 ⇄ diff 來回 5 趟不再重建任何 model',
      swap.made === madeForDiff, `切換後 ${swap.made} 顆（切換前 ${madeForDiff}）`)
    note(`${swap.tabs} 個分頁來回 5 趟共 ${swap.ms}ms（含每次 120ms 的等待）`)

    // ===== 輸入法游標：xterm 的隱形輸入框要在終端機裡面 =====
    await cdp.eval(`(async () => {
      if (!document.querySelector('.ws-new-menu')) document.getElementById('wsNewBtn').click()
      await new Promise((r) => setTimeout(r, 300))
      const item = [...document.querySelectorAll('.ws-new-item')].find((b) => b.textContent.trim() === '終端機')
      if (!item) throw new Error('選單沒開起來：' + document.querySelectorAll('.ws-new-item').length)
      item.click()
    })()`)
    ok('終端機開得起來', await waitInPage(cdp, `!!document.querySelector('.term-pane.is-active .xterm-screen')`))
    await sleep(2500)
    const ime = await cdp.eval(`(() => {
      const pane = document.querySelector('.term-pane.is-active')
      const area = pane.querySelector('textarea.xterm-helper-textarea')
      area.focus()
      const a = area.getBoundingClientRect()
      const p = pane.getBoundingClientRect()
      return {
        left: Math.round(a.left), top: Math.round(a.top),
        w: Math.round(a.width), h: Math.round(a.height),
        paneLeft: Math.round(p.left), paneTop: Math.round(p.top),
        paneRight: Math.round(p.right), paneBottom: Math.round(p.bottom),
        style: area.style.left
      }
    })()`)
    const inside = ime.left >= ime.paneLeft - 2 && ime.left <= ime.paneRight
      && ime.top >= ime.paneTop - 2 && ime.top <= ime.paneBottom
    ok('輸入法的輸入框在終端機裡（不是被丟到畫面外 -9999em）', inside, JSON.stringify(ime))
    ok('輸入框有一格的大小（OS 才畫得出候選字視窗）', ime.w >= 1 && ime.h >= 1, `${ime.w}×${ime.h}`)

    // 上面那兩條有可能是 xterm 自己（游標移動時）擺對的。底下兩段才是我們加的那些：
    // 把輸入框丟回 xterm 預設的畫面外位置，走一次真的使用者動作，它要自己回到游標上。
    //
    // 這裡刻意不用 focus：視窗被最小化時 Chromium 不派送 focus／blur 事件
    // （activeElement 換了但事件要等視窗回前景才補），在 CDP 背景測試裡驗不到。
    const rescue = await cdp.eval(`(async () => {
      const pane = document.querySelector('.term-pane.is-active')
      const area = pane.querySelector('textarea.xterm-helper-textarea')
      area.style.left = '-9999em'
      const away = Math.round(area.getBoundingClientRect().left)
      // 切去別的分頁再切回終端機（fitPane 會重新對位）
      const tabs = [...document.querySelectorAll('#wsTabStrip .ws-tab')]
      const term = tabs.find((t) => t.dataset.kind === 'terminal')
      const other = tabs.find((t) => t.dataset.kind !== 'terminal')
      other.querySelector('.ws-tab-open').click()
      await new Promise((r) => setTimeout(r, 400))
      term.querySelector('.ws-tab-open').click()
      await new Promise((r) => setTimeout(r, 800))
      const p = pane.getBoundingClientRect()
      return {
        away,
        back: Math.round(area.getBoundingClientRect().left),
        paneLeft: Math.round(p.left),
        style: area.style.left
      }
    })()`)
    ok('丟到畫面外之後，切回終端機分頁就自己回到游標那一格',
      rescue.away < -1000 && rescue.back >= rescue.paneLeft - 2 && !/em$/.test(rescue.style),
      JSON.stringify(rescue))

    // 組字開始的那一刻也要對位（候選字視窗的位置就是那時決定的）
    const onComposition = await cdp.eval(`(() => {
      const pane = document.querySelector('.term-pane.is-active')
      const area = pane.querySelector('textarea.xterm-helper-textarea')
      area.style.left = '-9999em'
      area.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      const p = pane.getBoundingClientRect()
      return { left: Math.round(area.getBoundingClientRect().left), paneLeft: Math.round(p.left), style: area.style.left }
    })()`)
    ok('開始組字的那一刻也對位', onComposition.left >= onComposition.paneLeft - 2 && !/em$/.test(onComposition.style),
      JSON.stringify(onComposition))

    // ===== 專案隔離 =====
    const before = await cdp.eval(`(() => ({
      tabs: [...document.querySelectorAll('#wsTabStrip .ws-tab')].map((t) => t.dataset.id),
      models: window.monaco.editor.getModels().length
    }))()`)
    ok('專案 A 有自己的分頁', before.tabs.length >= 3, JSON.stringify(before.tabs))
    ok('A 的分頁 id 全部掛在 A 底下',
      before.tabs.every((id) => !/^[ed]:/.test(id) || id.includes('w_perf_a')), JSON.stringify(before.tabs))

    await cdp.eval(`document.querySelector('#projList [data-id="w_perf_b"] .chat-list-open').click()`)
    await sleep(2000)
    const after = await cdp.eval(`(() => ({
      tabs: [...document.querySelectorAll('#wsTabStrip .ws-tab')].map((t) => t.dataset.id),
      models: window.monaco.editor.getModels().length
    }))()`)
    ok('切到 B 之後看不到任何 A 的檔案分頁',
      after.tabs.every((id) => !id.includes('w_perf_a')), JSON.stringify(after.tabs))
    ok('A 的 Monaco model 被收掉了（不然每切一次專案就多留一整份檔案）',
      after.models < before.models, `${before.models} → ${after.models}`)
    note(`切專案前 ${before.models} 顆 model，切完 ${after.models} 顆`)

    // 來回切三趟：model 數不可以一路往上長
    const churn = await cdp.eval(`(async () => {
      const counts = []
      for (let i = 0; i < 3; i += 1) {
        document.querySelector('#projList [data-id="w_perf_a"] .chat-list-open').click()
        await new Promise((r) => setTimeout(r, 1800))
        document.querySelector('#projList [data-id="w_perf_b"] .chat-list-open').click()
        await new Promise((r) => setTimeout(r, 1800))
        counts.push(window.monaco.editor.getModels().length)
      }
      return counts
    })()`)
    ok('來回切三趟專案，model 數不會愈積愈多',
      churn.every((n) => n <= churn[0]), JSON.stringify(churn))

    const errors = await cdp.eval(`(() => (window.__perfErrors || []).length)()`)
    ok('過程中沒有 renderer 例外', !errors)
  } finally {
    cdp?.close()
    // 只殺自己 spawn 的那一個 pid，絕不用 /IM
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 已結束 */ }
    await sleep(1200)
    try { fs.rmSync(USER_DATA_DIR, { recursive: true, force: true }) } catch { /* 佔用中 */ }
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
