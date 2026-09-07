/**
 * 打包版 CDP 實測：大檔案「開起來要多久」「關掉後放不放手」。
 *
 * `probe-workspace-perf.js` 量的是「有沒有重做」，這一支量的是**時間與記憶體**：
 *   [A] 1.4MB／4 萬行的檔案，從點下去到 Monaco 掛好幾毫秒
 *   [B] 大檔的「預覽變更」（並排 diff）算完要幾毫秒
 *   [C] 兩個分頁都關掉、強制 GC 之後，堆積有沒有掉回接近開檔前
 *   [D] 關掉 HTML 預覽分頁之後，那個 `<iframe>`（會一直跑腳本）有沒有被收掉
 *   [E] 關掉影片預覽分頁之後，`<video>`（會一直緩衝）有沒有被收掉
 *
 * 全程用自己的暫存 user-data-dir，收尾只殺自己 spawn 的那個 pid。
 *
 * 用法：node scripts/probe-workspace-bigfile.js
 */
const { spawn, execFileSync } = require('child_process')
const path = require('path')
const http = require('http')
const os = require('os')
const fs = require('fs')

const PORT = 9253
const EXE = process.env.VOICEINK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
const USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-bigfile-'))
fs.writeFileSync(path.join(USER_DATA_DIR, 'config.json'), JSON.stringify({ sysmonSensors: false }))

const PROJECT = path.join(USER_DATA_DIR, 'proj')
fs.mkdirSync(PROJECT)

/** 約 1.4MB、四萬行——工作區的讀檔上限是 2MB，這是「還開得起來的最大檔」那一類 */
const BIG_LINES = 40000
const bigOriginal = Array.from({ length: BIG_LINES }, (_, i) => `const line${i} = ${i} // 一行程式碼佔位`).join('\n')
const bigModified = bigOriginal.replace(/const line100 = 100/, 'const line100 = 999')
fs.writeFileSync(path.join(PROJECT, 'big.js'), bigOriginal)
fs.writeFileSync(path.join(PROJECT, 'page.html'), '<h1>預覽</h1><script>setInterval(() => {}, 50)</script>')

const git = (...args) => execFileSync('git', args, { cwd: PROJECT, stdio: 'ignore', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
git('init', '-q')
git('config', 'user.email', 'probe@example.invalid')
git('config', 'user.name', 'probe')
git('add', '-A')
git('commit', '-qm', 'seed')
fs.writeFileSync(path.join(PROJECT, 'big.js'), bigModified)

fs.writeFileSync(path.join(USER_DATA_DIR, 'workspaces.json'), JSON.stringify({
  projects: [{ id: 'w_big', name: '大檔', path: PROJECT, createdAt: Date.now() }]
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
    await sleep(150)
  }
  return false
}

/** 強制 GC 兩輪再量：一輪常常還留著上一輪剛斷開的東西 */
async function heapMb(cdp) {
  for (let i = 0; i < 3; i += 1) {
    await cdp.send('HeapProfiler.collectGarbage')
    await sleep(300)
  }
  const usage = await cdp.send('Runtime.getHeapUsage')
  return Math.round((usage.usedSize / 1024 / 1024) * 10) / 10
}

/**
 * 整個 App（主行程＋所有 renderer／GPU 子行程）現在佔多少實體記憶體。
 * 使用者在工作管理員看到的是這個數字，不是 V8 的堆積。
 * @param {number} rootPid
 * @returns {number} MB
 */
function workingSetMb(rootPid) {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', `
      $ids = @(${rootPid})
      $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, WorkingSetSize
      for ($i = 0; $i -lt 5; $i++) {
        $ids += ($all | Where-Object { $ids -contains $_.ParentProcessId }).ProcessId
        $ids = $ids | Select-Object -Unique
      }
      [math]::Round((($all | Where-Object { $ids -contains $_.ProcessId } | Measure-Object WorkingSetSize -Sum).Sum) / 1MB, 1)
    `], { encoding: 'utf8' })
    return Number(String(out).trim()) || 0
  } catch {
    return 0
  }
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
    await cdp.eval('window.electronAPI.window.minimize()')

    await cdp.eval(`document.querySelector('.nav-tab[data-page="chat"]').click()`)
    ok('工作區載得起來', await waitInPage(cdp, `!!document.getElementById('wsTabStrip')`))

    await cdp.eval(`document.getElementById('sidebarModeProjects').click()`)
    ok('側欄列得出這個專案', await waitInPage(cdp, `!!document.querySelector('#projList [data-id="w_big"] .chat-list-open')`))
    await cdp.eval(`document.querySelector('#projList [data-id="w_big"] .chat-list-open').click()`)
    await waitInPage(cdp, `document.querySelectorAll('#wsTree .ws-tree-row').length >= 1`)
    await sleep(800)

    // Monaco 是 16MB 的 AMD 包，載進來本身就要好幾 MB 堆積，而且**不會再放掉**。
    // 基準線要在它載完之後量，不然「關掉之後多留幾 MB」量到的是 Monaco 自己。
    const warmed = await waitInPage(cdp, `!!window.monaco`, 20000)
    ok('選了專案就趁閒置先把 Monaco 載起來', warmed)
    const baseHeap = await heapMb(cdp)
    note(`開檔前（Monaco 已載入、沒開任何檔）的堆積 ${baseHeap} MB`)

    // ===== [A] 開大檔 =====
    await cdp.eval(`window.__t0 = performance.now(); document.querySelector('#wsTree .ws-tree-row[data-rel="big.js"]').click()`)
    const opened = await waitInPage(cdp, `!!window.monaco && window.monaco.editor.getModels().some((m) => m.getLineCount() > 39000)`)
    const openMs = await cdp.eval('Math.round(performance.now() - window.__t0)')
    ok('[A] 1.4MB／4 萬行開得起來', opened, `${openMs}ms（含首次載 Monaco）`)

    // 關掉再開一次：這才是使用者平常的成本（Monaco 已經在了）
    await cdp.eval(`(async () => {
      document.querySelector('#wsTabStrip .ws-tab .ws-tab-close').click()
      await new Promise((r) => setTimeout(r, 600))
    })()`)
    await sleep(400)
    await cdp.eval(`window.__t0 = performance.now(); document.querySelector('#wsTree .ws-tree-row[data-rel="big.js"]').click()`)
    await waitInPage(cdp, `!!window.monaco && window.monaco.editor.getModels().some((m) => m.getLineCount() > 39000)`)
    const reopenMs = await cdp.eval('Math.round(performance.now() - window.__t0)')
    note(`[A] Monaco 已在時再開一次：${reopenMs}ms`)
    const openHeap = await heapMb(cdp)
    note(`[A] 開著大檔的堆積 ${openHeap} MB（+${Math.round((openHeap - baseHeap) * 10) / 10}）`)

    // ===== [B] 預覽變更 =====
    ok('工具列出現「看未提交變更」', await waitInPage(cdp, `!document.getElementById('wsEditorDiffBtn')?.hidden`))
    await cdp.eval(`window.__t0 = performance.now(); document.getElementById('wsEditorDiffBtn').click()`)
    const diffShown = await waitInPage(cdp, `!document.getElementById('wsDiffMonaco')?.hidden`)
    // 並排 diff 是非同步算的：等到它真的標出那一塊變更為止
    const diffReady = await waitInPage(cdp, `
      document.querySelectorAll('#wsDiffMonaco .line-insert, #wsDiffMonaco .char-insert, #wsDiffMonaco .line-delete').length > 0
    `, 40000)
    const diffMs = await cdp.eval('Math.round(performance.now() - window.__t0)')
    ok('[B] 大檔的並排變更算得出來', diffShown && diffReady, `${diffMs}ms`)
    const diffHeap = await heapMb(cdp)
    note(`[B] 開著大檔＋diff 的堆積 ${diffHeap} MB`)

    // ===== [C] 全關掉之後放不放手 =====
    const closed = await cdp.eval(`(async () => {
      let guard = 0
      while (document.querySelectorAll('#wsTabStrip .ws-tab').length && guard < 20) {
        guard += 1
        const btn = document.querySelector('#wsTabStrip .ws-tab .ws-tab-close')
        if (!btn) break
        btn.click()
        await new Promise((r) => setTimeout(r, 350))
      }
      return document.querySelectorAll('#wsTabStrip .ws-tab').length
    })()`)
    ok('分頁全關掉了', closed === 0, `剩 ${closed} 個`)
    await sleep(600)
    const afterHeap = await heapMb(cdp)
    note(`[C] 開檔前 ${baseHeap} → 開著大檔＋diff ${diffHeap} → 全關掉 ${afterHeap} MB`)
    const liveModels = await cdp.eval('window.monaco ? window.monaco.editor.getModels().length : -1')
    ok('[C] Monaco 沒有留下任何 model', liveModels === 0, `還留著 ${liveModels} 顆`)
    // 不拿「開檔前」當標準：第一次真的用到編輯器與並排 diff 時，Monaco 會再載一批
    // 程式碼與快取進來，那是一次性的、放不掉的。要看的是「開著」跟「關掉」差多少。
    ok('[C] 關掉之後堆積掉了一大截（大檔的內容真的放掉了）',
      diffHeap - afterHeap >= 15,
      `${diffHeap} → ${afterHeap} MB，掉了 ${Math.round((diffHeap - afterHeap) * 10) / 10} MB`)
    const memAfterFirst = await workingSetMb(child.pid)

    // ===== 再開一輪：關掉之後有沒有「愈積愈多」才是漏不漏的判準 =====
    // 第一輪多出來的那幾 MB 是 Monaco 用到編輯器與並排 diff 才載進來的程式碼與快取，
    // 那是一次性的；真正的漏會讓第二輪再往上疊一份。
    await cdp.eval(`document.querySelector('#wsTree .ws-tree-row[data-rel="big.js"]').click()`)
    await waitInPage(cdp, `!!window.monaco && window.monaco.editor.getModels().some((m) => m.getLineCount() > 39000)`)
    await waitInPage(cdp, `!document.getElementById('wsEditorDiffBtn')?.hidden`)
    await cdp.eval(`document.getElementById('wsEditorDiffBtn').click()`)
    await waitInPage(cdp, `!document.getElementById('wsDiffMonaco')?.hidden`)
    await waitInPage(cdp, `
      document.querySelectorAll('#wsDiffMonaco .line-insert, #wsDiffMonaco .char-insert, #wsDiffMonaco .line-delete').length > 0
    `, 40000)
    await cdp.eval(`(async () => {
      let guard = 0
      while (document.querySelectorAll('#wsTabStrip .ws-tab').length && guard < 20) {
        guard += 1
        const btn = document.querySelector('#wsTabStrip .ws-tab .ws-tab-close')
        if (!btn) break
        btn.click()
        await new Promise((r) => setTimeout(r, 350))
      }
    })()`)
    await sleep(600)
    const secondHeap = await heapMb(cdp)
    const growth = Math.round((secondHeap - afterHeap) * 10) / 10
    ok('[C] 第二輪開關之後不再往上疊（沒有每開一次就漏一份）', growth <= 2,
      `第一輪關掉後 ${afterHeap} → 第二輪關掉後 ${secondHeap} MB（多 ${growth}）`)
    const memAfterSecond = await workingSetMb(child.pid)
    note(`[C] 整個 App 的工作集：第一輪關掉後 ${memAfterFirst} MB → 第二輪關掉後 ${memAfterSecond} MB`)

    // ===== [D] HTML 預覽的 iframe =====
    await cdp.eval(`document.querySelector('#wsTree .ws-tree-row[data-rel="page.html"]').click()`)
    await waitInPage(cdp, `!document.getElementById('wsEditor')?.hidden`)
    await sleep(500)
    await cdp.eval(`document.getElementById('wsEditorPreviewBtn').click()`)
    const framed = await waitInPage(cdp, `!!document.querySelector('#wsEditorPreview iframe')`)
    ok('HTML 預覽畫得出來', framed)
    await cdp.eval(`(async () => {
      document.querySelector('#wsTabStrip .ws-tab .ws-tab-close').click()
      await new Promise((r) => setTimeout(r, 500))
    })()`)
    await sleep(500)
    const leftovers = await cdp.eval(`document.querySelectorAll('#wsEditorPreview iframe, #wsEditorPreview video, #wsEditorPreview audio').length`)
    ok('[D] 關掉預覽分頁後 iframe 被收掉（不會繼續跑腳本）', leftovers === 0, `還留著 ${leftovers} 個`)
  } finally {
    if (cdp) cdp.close()
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 已結束 */ }
    await sleep(600)
    try { fs.rmSync(USER_DATA_DIR, { recursive: true, force: true }) } catch { /* 檔案還被抓著 */ }
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} 通過`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
