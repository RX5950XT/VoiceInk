/**
 * 打包版 CDP：系統監控 ▸ 風扇控制
 * 用法：node scripts/e2e-sysmon-fans-cdp.js（自己啟動 dist/win-unpacked/VoiceInk.exe）
 *
 * **不接管真風扇**（會改到使用者正在用的機器）：關掉感測器自動啟用，
 * 只驗 UI 骨架與 IPC 守衛。真的去轉風扇是 `probe-sysmon-fans.js` 的職責。
 *
 * 驗證重點：
 *  - 風扇控制子分頁存在、點得開（`.sysmon-panel.active` 由 `.active` 控制，裸 display 會疊頁）
 *  - 沒啟用感測器時顯示「請先啟用感測器」而不是留白
 *  - IPC：fanList 回 ok；fanSetChannel 擋掉不存在的 identifier（renderer 是敵意輸入）
 *  - 圖示、提示列、RWD 900px 收一欄
 */
const { spawn } = require('child_process')
const path = require('path')
const os = require('os')
const fs = require('fs')
const http = require('http')

const PORT = 9248
const EXE = process.env.VOICEINK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
const USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-fans-cdp-'))
fs.writeFileSync(path.join(USER_DATA_DIR, 'config.json'), JSON.stringify({ sysmonSensors: false }))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let body = ''
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => { try { resolve(JSON.parse(body)) } catch (error) { reject(error) } })
    }).on('error', reject)
  })
}

class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.exceptions = [] }
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
      if (!message.id || !this.pending.has(message.id)) return
      const pending = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
    await this.send('Runtime.enable')
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
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
  close() { try { this.ws.close() } catch { /* ignore */ } }
}

async function waitFor(action, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await action()) return true
    await sleep(300)
  }
  throw new Error(`等待逾時：${label}`)
}

async function main() {
  const child = spawn(EXE, ['--hidden', `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA_DIR}`], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let cdp = null
  let originalSensors = null
  let passed = 0
  let failed = 0
  const ok = (name, cond, extra = '') => {
    if (cond) { passed++; console.log(`PASS  ${name}`) }
    else { failed++; console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`) }
  }

  try {
    const target = await (async () => {
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        const pages = await getJson(`http://127.0.0.1:${PORT}/json/list`).catch(() => [])
        const page = pages.filter((p) => p.type === 'page').find((p) => /index\.html/.test(p.url))
        if (page) return page
        await sleep(400)
      }
      throw new Error('等不到主視窗')
    })()
    cdp = new Cdp(target.webSocketDebuggerUrl)
    await cdp.connect()
    await waitFor(
      () => cdp.eval(`document.readyState === 'complete' && typeof window.electronAPI?.sysmon?.fanList === 'function'`),
      15000, 'preload 初始化（fanList 要在 preload 白名單裡）'
    )

    // 自動化測試不能停在 UAC 對話框前；還原使用者的值
    originalSensors = await cdp.eval(`window.electronAPI.store.get('sysmonSensors', null)`)
    await cdp.eval(`window.electronAPI.store.set('sysmonSensors', false)`)

    await cdp.eval(`document.querySelector('[data-page="sysmon"]').click()`)
    ok('風扇控制子分頁存在',
      await cdp.eval(`Boolean(document.querySelector('#sysmonTabs .sysmon-tab[data-subtab="fans"]')` +
        `&& document.getElementById('sysmon-fans'))`))
    ok('風扇分頁排在壓力測試旁邊',
      await cdp.eval(`(() => {
        const tabs = [...document.querySelectorAll('#sysmonTabs .sysmon-tab')].map((t) => t.dataset.subtab)
        return Math.abs(tabs.indexOf('stress') - tabs.indexOf('fans')) === 1
      })()`))

    // 切到風扇分頁：顯示由 .active 控制。
    // **要等到真的切過去，不能睡固定時間**：分頁監聽是在 sysmon-page.js 動態載入完才掛上的，
    // 睡 150ms 的版本在機器忙的時候會點在監聽掛上之前（點了沒反應，看起來像 CSS 壞掉）。
    await waitFor(async () => {
      await cdp.eval(`document.querySelector('#sysmonTabs .sysmon-tab[data-subtab="fans"]').click()`)
      return cdp.eval(`document.getElementById('sysmon-fans').classList.contains('active')`)
    }, 15000, '切到風扇分頁').catch(() => {})
    ok('切過去之後面板是 active',
      await cdp.eval(`document.getElementById('sysmon-fans').classList.contains('active')`))
    ok('面板真的佔版面（display 沒被蓋掉）',
      await cdp.eval(`document.getElementById('sysmon-fans').offsetHeight > 0`))
    ok('其他面板是隱藏的（不會疊頁）',
      await cdp.eval(`document.getElementById('sysmon-overview').offsetHeight === 0`))

    // 沒啟用感測器：要講原因，不是留白
    await waitFor(() => cdp.eval(`(document.getElementById('fanList')?.textContent || '').includes('感測器')`), 5000, '空狀態說明')
    // 空狀態文案 ≤12 字是規定（CLAUDE.md 的 UI 那條），所以**不可以拿字數當門檻**——
    // 「請先啟用感測器」只有 7 字，量長度會在文案收乾淨之後變成假紅燈。
    // 要驗的是「有沒有講原因」：文字裡要出現「感測器」或「風扇通道」。
    ok('沒啟用感測器時顯示說明而不是留白',
      await cdp.eval(`(() => {
        const text = document.getElementById('fanList')?.textContent || ''
        return /感測器|風扇通道/.test(text)
      })()`))

    const bar = await cdp.eval(`(() => ({
      toggle: Boolean(document.getElementById('fanEnabled')),
      reset: Boolean(document.getElementById('fanResetBtn')),
      chassis: Boolean(document.getElementById('fanChassis')),
      editor: Boolean(document.getElementById('fanEditor'))
    }))()`)
    ok('上方操作列齊全（接管／還原／示意圖／編輯器）',
      bar.toggle && bar.reset && bar.chassis && bar.editor, JSON.stringify(bar))

    // IPC 守衛：fanSetChannel 只收目前真的存在的 identifier
    const guards = await cdp.eval(`(async () => {
      const api = window.electronAPI.sysmon
      return {
        list: await api.fanList(),
        setBad: await api.fanSetChannel('/etc/passwd', { mode: 'fixed', fixed: 100 }),
        setEmpty: await api.fanSetChannel('', { mode: 'fixed' }),
        task: await api.fanTaskStatus()
      }
    })()`)
    ok('fanList 回 ok', guards.list.ok === true, JSON.stringify(guards.list).slice(0, 120))
    ok('fanList 的 channels 在沒感測器時是空陣列（不是 undefined）',
      Array.isArray(guards.list.data?.channels) && guards.list.data.channels.length === 0)
    ok('slots／sources 有給（UI 要畫示意圖與下拉）',
      Array.isArray(guards.list.data?.slots) && guards.list.data.slots.length >= 10
      && Array.isArray(guards.list.data?.sources) && guards.list.data.sources.length >= 4)
    ok('fanSetChannel 擋掉不存在的 identifier',
      guards.setBad.ok === false && guards.setBad.error.code === 'SYSMON_FAN_UNKNOWN', JSON.stringify(guards.setBad))
    ok('fanSetChannel 擋掉空 identifier', guards.setEmpty.ok === false)
    ok('fanTaskStatus 回 ok', guards.task.ok === true, JSON.stringify(guards.task).slice(0, 120))

    // 示意圖骨架：切換前就建好了嗎？——showFanPanel 之後 chassis 應該有 SVG
    await waitFor(() => cdp.eval(`Boolean(document.querySelector('#fanChassis svg.fan-chassis-svg'))`), 5000, '示意圖')
    const chassis = await cdp.eval(`(() => ({
      slots: document.querySelectorAll('#fanChassis .fan-slot').length,
      labels: [...document.querySelectorAll('#fanChassis .fan-slot')].some((g) => g.getAttribute('aria-label')),
      blades: document.querySelectorAll('#fanChassis .fan-blades').length
    }))()`)
    ok('示意圖建出全部槽位（≥10）', chassis.slots >= 10, `slots=${chassis.slots}`)
    ok('槽位有 aria-label（可及性）', chassis.labels)
    ok('每個槽位都有扇葉圖示', chassis.blades === chassis.slots)

    // **CSS 變數打錯不會報錯，只會安靜地變成透明或黑色**（`--surface`／`--accent`／`--border`
    // 這三個名字在 themes.css 裡根本不存在，正確的是 `-glass`／`-primary`／`-color`）。
    // 症狀是玻璃面板整片消失、SVG 填色變純黑，而 DevTools 只會顯示一個無效值。
    const paint = await cdp.eval(`(() => {
      const cs = (sel, prop) => getComputedStyle(document.querySelector(sel))[prop]
      const toggle = document.getElementById('fanEnabled')
      const was = toggle.checked
      toggle.checked = true
      const on = cs('.fan-switch-track', 'borderTopColor')
      toggle.checked = was
      return {
        bar: cs('.fan-bar', 'backgroundColor'),
        barBorder: cs('.fan-bar', 'borderTopColor'),
        card: cs('.fan-card', 'backgroundColor'),
        accent: on
      }
    })()`)
    const painted = (value) => Boolean(value) && value !== 'rgba(0, 0, 0, 0)' && value !== 'transparent'
    ok('面板底色與強調色有畫出來（CSS 變數名沒打錯）',
      painted(paint.bar) && painted(paint.barBorder) && painted(paint.card) && painted(paint.accent),
      JSON.stringify(paint))

    // 示意圖：短代碼 + <title> 放全名（十三個全名印上去會糊成一團）
    const labels = await cdp.eval(`(() => ({
      titles: document.querySelectorAll('#fanChassis .fan-slot > title').length,
      longest: Math.max(...[...document.querySelectorAll('#fanChassis .fan-slot-label')].map((t) => t.textContent.length)),
      aria: document.querySelector('#fanChassis .fan-slot').getAttribute('aria-label')
    }))()`)
    ok('每個槽位都有 <title>（滑鼠停留看得到全名）', labels.titles === chassis.slots, JSON.stringify(labels))
    ok('槽位上只印短代碼（不印會互相疊到的全名）', labels.longest <= 4, `longest=${labels.longest}`)
    ok('槽位 aria-label 帶得出位置名稱', /：/.test(labels.aria || ''), labels.aria)

    // 沒有通道時編輯器要收起來，而且**仍留在 DOM 裡**
    // （被搬出文件的話 getElementById 就再也找不回來，下一輪展開會是空的）
    const editorState = await cdp.eval(`(() => {
      const editor = document.getElementById('fanEditor')
      return { exists: Boolean(editor), hidden: editor?.hidden, h: editor?.offsetHeight, inList: Boolean(editor?.closest('#fanList')) }
    })()`)
    ok('沒有通道時編輯器收起來但沒被丟出 DOM',
      editorState.exists && editorState.hidden === true && editorState.h === 0 && editorState.inList,
      JSON.stringify(editorState))

    // RWD：900px 以下收一欄
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width: 760, height: 900, deviceScaleFactor: 1, mobile: false })
    await sleep(400)
    const narrow = await cdp.eval(`(() => {
      const layout = document.querySelector('.fan-layout')
      return layout ? layout.offsetHeight : 0
    })()`)
    ok('900px 以下版面存在（收成一欄不爆版）', narrow > 100, `height=${narrow}`)
    await cdp.send('Emulation.clearDeviceMetricsOverride', {})

    ok('renderer 無未處理例外', cdp.exceptions.length === 0, JSON.stringify(cdp.exceptions))
  } catch (error) {
    failed++
    console.error(`\n未預期例外：${error.stack || error}`)
    console.error('Renderer exceptions:', JSON.stringify(cdp?.exceptions || []))
  } finally {
    if (cdp && originalSensors !== null) {
      try {
        await cdp.eval(`window.electronAPI.store.set('sysmonSensors', ${JSON.stringify(originalSensors)})`)
        console.log('（已還原 sysmonSensors）')
      } catch { /* 視窗已關就算了 */ }
    }
    cdp?.close()
    try { child.kill() } catch { /* ignore */ }
    if (child.pid) {
      try { spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' }) } catch { /* ignore */ }
    }
    for (let i = 0; i < 5; i += 1) {
      try { fs.rmSync(USER_DATA_DIR, { recursive: true, force: true }); break } catch { await sleep(600) }
    }
  }

  console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILED'}  ${passed} passed, ${failed} failed\n`)
  process.exitCode = failed === 0 ? 0 : 1
}

main()
