/**
 * 打包版 CDP：系統監控 ▸ 磁碟空間
 * 用法：node scripts/e2e-sysmon-disk-cdp.js（會自己啟動 dist/win-unpacked/VoiceInk.exe）
 *
 * 啟動方式對齊 e2e-sysmon-cdp.js：打包版、暫存 userData、關 sysmonSensors、
 * finally 還原設定並只殺自己這棵行程。埠用 9261，避免跟那支的 9247 撞上。
 *
 * 選資料夾是原生對話框，掃描走面板的 window.__diskScan（跟 __viInsertText 同一種測試入口，
 * 裡面就是 sysmon-disk.js 的 scan()）。只會刪暫存資料夾裡的 a.bin，而且走資源回收筒。
 */
const { spawn, spawnSync, execFileSync } = require('child_process')
const path = require('path')
const { pathToFileURL } = require('url')
const { tempDir, removeTree } = require('./lib/test-temp')
const fs = require('fs')
const http = require('http')

const PORT = 9261
const EXE = process.env.VOICEINK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
const USER_DATA_DIR = tempDir('voiceink-cdp-')
fs.writeFileSync(path.join(USER_DATA_DIR, 'config.json'), JSON.stringify({ sysmonSensors: false }))
const RESTORE_KEYS = ['sysmonInterval', 'sysmonSort', 'sysmonSensors']
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const SHOT_DIR = 'C:/Users/rx595/AppData/Local/Temp/claude/D--Workspace-Personal-Project-VoiceInk/d98f4901-bac1-487a-8ef0-81a53369b2ea/scratchpad'
const A = 3 * 1024 * 1024
const B = 2 * 1024 * 1024
const C = 1024
const X = 500 * 1024
const EXPECTED = A + B + C + X
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function previewLocked() {
  const script = "Get-CimInstance Win32_Process -Filter \"Name = 'VoiceInk.exe'\" | ForEach-Object { $_.ExecutablePath }"
  const out = execFileSync(POWERSHELL, ['-NoProfile', '-Command', script], { encoding: 'utf8' })
  return out.split(/\r?\n/).map((line) => line.trim()).filter((line) => /\\dist\\win-unpacked\\VoiceInk\.exe$/i.test(line))
}

function createFixture() {
  const root = tempDir('disk-scan-')
  fs.mkdirSync(path.join(root, 'sub'))
  fs.mkdirSync(path.join(root, 'node_modules'))
  fs.writeFileSync(path.join(root, 'a.bin'), Buffer.alloc(A))
  fs.writeFileSync(path.join(root, 'sub', 'b.bin'), Buffer.alloc(B))
  fs.writeFileSync(path.join(root, 'sub', 'c.txt'), Buffer.alloc(C))
  fs.writeFileSync(path.join(root, 'node_modules', 'x.js'), Buffer.alloc(X))
  return root
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (response) => {
      let body = ''
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (error) { reject(error) }
      })
    })
    req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')) })
    req.on('error', reject)
  })
}

/** 同一份 userData 再開一次會撞單例鎖，第一份因此把視窗顯示出來。隱藏視窗量不到高度，截圖也會卡住。 */
function revealApp() {
  return new Promise((resolve) => {
    const extra = spawn(EXE, [`--user-data-dir=${USER_DATA_DIR}`], { stdio: 'ignore', windowsHide: true })
    const timer = setTimeout(() => {
      try { extra.kill() } catch { /* ignore */ }
      resolve()
    }, 8000)
    extra.on('exit', () => { clearTimeout(timer); resolve() })
  })
}

class Cdp {
  constructor(url) {
    this.url = url
    this.id = 0
    this.pending = new Map()
    this.exceptions = []
    this.consoleErrors = []
  }

  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve)
      this.ws.addEventListener('error', reject)
    })
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(message.params?.exceptionDetails?.exception?.description || 'runtime exception')
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
        const text = (message.params.args || []).map((item) => item.value || item.description || '').join(' ')
        this.consoleErrors.push(text)
      }
      if (!message.id || !this.pending.has(message.id)) return
      const pending = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
    await this.send('Runtime.enable')
  }

  send(method, params = {}, timeoutMs = 20000) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP 逾時：${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) }
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    }
    return result.result?.value
  }

  close() { try { this.ws.close() } catch { /* ignore */ } }
}

async function waitFor(action, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await action()
    if (last) return last
    await sleep(300)
  }
  throw new Error(`等待逾時：${label}${last ? ' — ' + JSON.stringify(last) : ''}`)
}

function noiseCount(cdp) {
  return cdp.exceptions.length + cdp.consoleErrors.length
}

/** 用畫面上的格子做 hit-test，點到名稱／種類都對、且不會落在更深子塊上的那一點。 */
function clickCellExpr(name, kind) {
  return `(() => {
    const cells = window.__diskView?.().cells || []
    const index = cells.findIndex((cell) => cell.n === ${JSON.stringify(name)} && cell.k === ${JSON.stringify(kind)})
    if (index < 0) return { ok: false, reason: 'no-cell', names: cells.map((cell) => cell.n + ':' + cell.k) }
    const cell = cells[index]
    const hitAt = (x, y) => {
      for (let i = cells.length - 1; i >= 0; i--) {
        const item = cells[i]
        if (x >= item.x && y >= item.y && x < item.x + item.w && y < item.y + item.h) return i
      }
      return -1
    }
    let point = null
    for (let gy = 0; gy < 16 && !point; gy++) {
      for (let gx = 0; gx < 16; gx++) {
        const x = cell.x + (cell.w * (gx + 0.5)) / 16
        const y = cell.y + (cell.h * (gy + 0.5)) / 16
        if (hitAt(x, y) === index) { point = { x, y }; break }
      }
    }
    if (!point) return { ok: false, reason: 'covered', cell }
    const canvas = document.getElementById('diskCanvas')
    const rect = canvas.getBoundingClientRect()
    canvas.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, view: window,
      clientX: rect.left + point.x, clientY: rect.top + point.y
    }))
    return {
      ok: true,
      crumbs: [...document.querySelectorAll('#diskCrumbs button')].map((btn) => btn.textContent)
    }
  })()`
}

async function shoot(cdp, theme, file) {
  await cdp.eval(`(() => {
    document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)})
    document.getElementById('diskFilter').dispatchEvent(new Event('input', { bubbles: true }))
    document.getElementById('diskMapHost').scrollIntoView({ block: 'center' })
    return document.documentElement.getAttribute('data-theme')
  })()`)
  // 主題切換有顏色過場，太早截會拍到半淡的按鈕
  await sleep(800)
  const result = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.from(result.data, 'base64'))
  return fs.statSync(file).size
}

async function openDisk(cdp, ok) {
  const tab = await cdp.eval(`(() => {
    const btn = document.querySelector('#sysmonTabs [data-subtab="disk"]')
    return { text: btn ? btn.textContent : '', exists: Boolean(btn) }
  })()`)
  ok('系統監控有「磁碟空間」子分頁', tab.exists && tab.text === '磁碟空間', JSON.stringify(tab))
  // 系統監控是動態 import。監聽器掛上之前點子分頁不會切過去，所以重試到面板真的亮。
  await cdp.eval(`document.querySelector('[data-page="sysmon"]').click()`)
  const deadline = Date.now() + 25000
  let snap = null
  while (Date.now() < deadline) {
    snap = await cdp.eval(`(() => {
      document.querySelector('#sysmonTabs [data-subtab="disk"]')?.click()
      const host = document.getElementById('sysmon-disk')
      return {
        pageActive: document.getElementById('page-sysmon').classList.contains('active'),
        panelActive: Boolean(host?.classList.contains('active')),
        height: host?.offsetHeight || 0,
        drives: document.querySelectorAll('#diskDrives .disk-drive').length,
        driveText: (document.getElementById('diskDrives')?.innerText || '').slice(0, 80),
        inner: window.innerWidth + 'x' + window.innerHeight
      }
    })()`)
    if (snap.panelActive && snap.height > 0 && snap.drives > 0) break
    await sleep(300)
  }
  const ready = Boolean(snap?.panelActive && snap.height > 0 && snap.drives > 0)
  ok('點下去面板有高度', Boolean(snap && snap.height > 0), JSON.stringify(snap))
  ok('磁碟清單至少一顆', Boolean(snap && snap.drives >= 1), JSON.stringify(snap))
  return ready
}

async function scanFixture(cdp, ok, root, formatBytes) {
  const started = await cdp.eval(`typeof window.__diskScan === 'function'`)
  ok('掃描走面板的 __diskScan', started === true)
  if (!started) return null
  await cdp.eval(`window.__diskScan(${JSON.stringify(root)})`)
  const view = await waitFor(
    () => cdp.eval(`(() => {
      const view = window.__diskView?.()
      if (!view || view.scanning) return null
      return view
    })()`),
    60000,
    '掃描結束'
  )
  const progress = await cdp.eval(`document.getElementById('diskProgress').textContent`)
  ok('掃描總量等於檔案大小總和',
    view.bytes === EXPECTED && view.files === 4 && progress.startsWith(formatBytes(EXPECTED)),
    `bytes=${view.bytes} files=${view.files} progress=${progress} error=${view.error}`)
  const paint = await cdp.eval(`(() => {
    const canvas = document.getElementById('diskCanvas')
    if (!canvas || canvas.width < 2 || canvas.height < 2) {
      return { opaque: 0, width: canvas?.width || 0, height: canvas?.height || 0, hidden: Boolean(canvas?.hidden) }
    }
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    let opaque = 0
    for (let i = 3; i < data.length; i += 64) if (data[i] > 10) opaque += 1
    return { opaque, width: canvas.width, height: canvas.height, hidden: canvas.hidden }
  })()`)
  ok('canvas 有畫東西', paint.opaque > 0 && paint.hidden === false, JSON.stringify(paint))
  return view
}

async function drill(cdp, ok) {
  const clicked = await cdp.eval(clickCellExpr('sub', 'd'))
  ok('點 sub 後面包屑變兩層',
    clicked.ok === true && clicked.crumbs?.length === 2 && clicked.crumbs[1] === 'sub',
    JSON.stringify(clicked))
  const back = await cdp.eval(`(() => {
    const active = document.activeElement
    if (active && active !== document.body && active.blur) active.blur()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }))
    return [...document.querySelectorAll('#diskCrumbs button')].map((btn) => btn.textContent)
  })()`)
  ok('Backspace 回上層', Array.isArray(back) && back.length === 1, JSON.stringify(back))
}

async function modes(cdp, ok) {
  const before = noiseCount(cdp)
  await cdp.eval(`document.querySelector('#diskModes [data-disk-mode="count"]').click()`)
  await sleep(200)
  const countOn = await cdp.eval(`document.querySelector('#diskModes [data-disk-mode="count"]').getAttribute('aria-selected')`)
  ok('切「檔案數」模式不報錯', countOn === 'true' && noiseCount(cdp) === before, `aria=${countOn}`)
  const beforeFilter = noiseCount(cdp)
  await cdp.eval(`(() => {
    const input = document.getElementById('diskFilter')
    input.value = 'b.bin'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return input.value
  })()`)
  await sleep(200)
  ok('名稱篩選 b.bin 不報錯', noiseCount(cdp) === beforeFilter)
  await cdp.eval(`(() => {
    const input = document.getElementById('diskFilter')
    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return input.value
  })()`)
}

async function trashFile(cdp, ok, root) {
  const aPath = path.join(root, 'a.bin')
  const picked = await cdp.eval(`(() => {
    const row = [...document.querySelectorAll('#diskLargest .disk-row')]
      .find((btn) => btn.querySelector('.disk-row-name')?.textContent === 'a.bin')
    if (!row) return { ok: false, rows: [...document.querySelectorAll('#diskLargest .disk-row-name')].map((n) => n.textContent) }
    row.click()
    return {
      ok: true,
      name: document.getElementById('diskSelName').textContent,
      path: document.getElementById('diskSelPath').textContent
    }
  })()`)
  ok('選到 a.bin', picked.ok === true && picked.name === 'a.bin' && picked.path === aPath, JSON.stringify(picked))
  if (!picked.ok || picked.path !== aPath) return
  await cdp.eval(`document.getElementById('diskMark').click()`)
  const opened = await cdp.eval(`(() => {
    document.getElementById('diskTrash').click()
    const dialog = document.querySelector('dialog[open]')
    return {
      shown: Boolean(dialog),
      desc: dialog?.querySelector('.dialog-desc')?.textContent || '',
      confirm: dialog?.querySelector('.btn-danger')?.textContent || ''
    }
  })()`)
  const norm = (value) => String(value || '').replace(/\//g, '\\').toLowerCase()
  ok('確認框裡有 a.bin 的完整路徑',
    opened.shown && norm(opened.desc).includes(norm(aPath)),
    opened.desc)
  if (!opened.shown || !norm(opened.desc).includes(norm(aPath))) return
  const before = await cdp.eval(`window.__diskView().bytes`)
  await cdp.eval(`document.querySelector('dialog[open] .btn-danger').click()`)
  const after = await waitFor(
    async () => {
      const view = await cdp.eval(`window.__diskView()`)
      const gone = !fs.existsSync(aPath)
      if (gone && view && view.bytes === before - A) return view
      return null
    },
    20000,
    'a.bin 進資源回收筒'
  )
  ok('a.bin 從磁碟消失', !fs.existsSync(aPath))
  ok('總量扣掉 3MB', after.bytes === EXPECTED - A, `before=${before} after=${after.bytes}`)
}

async function main() {
  const locked = previewLocked()
  if (locked.length) {
    console.error('dist/win-unpacked 的 VoiceInk.exe 還在跑，這次不啟動、也不結束它：')
    for (const line of locked) console.error(line)
    process.exitCode = 1
    return
  }
  const formatBytes = (await import(pathToFileURL(path.join(__dirname, '../src/renderer/scripts/disk-treemap.js')).href)).formatBytes
  const root = createFixture()
  const child = spawn(EXE, ['--hidden', `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA_DIR}`], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  })
  let processLog = ''
  child.stdout.on('data', (chunk) => { processLog = (processLog + chunk).slice(-8000) })
  child.stderr.on('data', (chunk) => { processLog = (processLog + chunk).slice(-8000) })

  let cdp = null
  let original = null
  let passed = 0
  let failed = 0
  const ok = (name, cond, extra = '') => {
    const line = cond ? `PASS  ${name}` : `FAIL  ${name}${extra ? ' — ' + extra : ''}`
    console.error(line)
    if (cond) passed += 1
    else failed += 1
  }

  try {
    const target = await (async () => {
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        const pages = await getJson(`http://127.0.0.1:${PORT}/json/list`).catch(() => [])
        const page = pages.filter((item) => item.type === 'page').find((item) => /index\.html/.test(item.url))
        if (page) return page
        await sleep(400)
      }
      throw new Error('等不到主視窗')
    })()
    cdp = new Cdp(target.webSocketDebuggerUrl)
    await cdp.connect()
    await waitFor(
      () => cdp.eval(`document.readyState === 'complete' && typeof window.electronAPI?.sysmon?.status === 'function'`),
      15000, 'preload 初始化'
    )
    await revealApp()
    await cdp.eval(`Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })`)
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false
    })
    original = await cdp.eval(`(async () => {
      const keys = ${JSON.stringify(RESTORE_KEYS)}
      const out = {}
      for (const key of keys) out[key] = await window.electronAPI.store.get(key, null)
      return out
    })()`)
    await cdp.eval(`window.electronAPI.store.set('sysmonSensors', false)`)

    const opened = await openDisk(cdp, ok)
    if (opened) {
      await scanFixture(cdp, ok, root, formatBytes)
      await drill(cdp, ok)
      await modes(cdp, ok)
      await trashFile(cdp, ok, root)
    }

    const dark = path.join(SHOT_DIR, 'shot-dark.png')
    const light = path.join(SHOT_DIR, 'shot-light.png')
    const darkSize = await shoot(cdp, 'dark', dark)
    const lightSize = await shoot(cdp, 'light', light)
    ok('深色主題截圖', darkSize > 5000, `${dark} ${darkSize}`)
    ok('淺色主題截圖', lightSize > 5000, `${light} ${lightSize}`)

    const problems = [...cdp.exceptions, ...cdp.consoleErrors]
    ok('沒有 console error', problems.length === 0, problems.join(' | '))
  } catch (error) {
    failed += 1
    console.error(`FAIL  未預期例外 — ${error.stack || error}`)
    console.error('Renderer exceptions:', JSON.stringify(cdp?.exceptions || []))
    console.error('Console errors:', JSON.stringify(cdp?.consoleErrors || []))
    console.error('Process log:', processLog.slice(-4000))
  } finally {
    if (cdp && original) {
      try {
        await cdp.eval(`(async () => {
          const orig = ${JSON.stringify(original)}
          const defaults = { sysmonInterval: 'normal', sysmonSort: 'cpu:desc', sysmonSensors: true }
          for (const [key, value] of Object.entries(orig)) {
            await window.electronAPI.store.set(key, value === null ? defaults[key] : value)
          }
          return 'ok'
        })()`)
        console.log(`（已還原使用者設定：${JSON.stringify(original)}）`)
      } catch (error) {
        console.error('還原設定失敗：', error)
      }
    }
    cdp?.close()
    // 先趁主程序還活著整棵殺（同步等完）：先 kill 主程序的話樹就斷了，detached 的 nvidia-smi 會活下來、
    // 抱著繼承到的 CDP 埠，下一輪就「等不到主視窗」
    if (child.pid) {
      try { spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' }) } catch { /* ignore */ }
    }
    try { child.kill() } catch { /* ignore */ }
    for (let i = 0; i < 5; i += 1) {
      try { removeTree(USER_DATA_DIR); break } catch { await sleep(600) }
    }
  }

  console.error(`\n${failed === 0 ? 'ALL PASS' : 'FAILED'}  ${passed} passed, ${failed} failed\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main()
