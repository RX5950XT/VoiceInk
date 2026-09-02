/**
 * 打包版 CDP 驗證：常駐系統匣、單一實例、開機自啟動設定。
 *
 * 為什麼要打包版：`app.requestSingleInstanceLock()` 與 `setLoginItemSettings()`
 * 都依 app 身分（名稱／執行檔路徑）決定行為，`npx electron scripts/...` 的身分是 Electron，
 * 測不到真的東西。
 *
 * 會動到使用者狀態的兩件事都會還原：
 *   - `closeToTray`（測完寫回原值）
 *   - 開機自啟動（只讀不寫；真的要寫的那條測完立刻關掉，且原本是開的就補回去）
 *
 * 用法：node scripts/e2e-tray-cdp.js
 */
const { spawn, execFileSync } = require('child_process')
const path = require('path')
const os = require('os')
const fs = require('fs')
const http = require('http')

const PORT = 9243
// Windows 偶爾會有別的東西鎖住 dist/win-unpacked（打包失敗、防毒掃描中），
// 這時可以打包到別的資料夾再用 VOICEINK_EXE 指過去，測試不必等鎖放掉
const EXE = process.env.VOICEINK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
// 暫存 user-data-dir：使用者開著的正式實例佔 single-instance lock，
// 沒有自己的資料夾會被擋掉（second-instance 轉交後退出，CDP 等不到主視窗）
const USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-cdp-'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 跟 OS 借一個當下空著的埠（借完馬上還）。
 * `agy` 的 `sanitizePort` 不收 0，寫死數字又會踩到別的程式。
 * @returns {Promise<number>}
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => (port ? resolve(port) : reject(new Error('借不到埠'))))
    })
  })
}

function stopChildTree(child) {
  if (!child?.pid) return
  try { execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' }) } catch { /* 已結束 */ }
}

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
    // App 結束時最後一發 eval 永遠等不到回應。不 reject 的話 pending promise 既不完成也
    // 不持有 handle，Node 會在事件迴圈空掉時直接以 0 退出——測試看起來「跑完了」，
    // 其實最後幾條斷言與總結根本沒印出來（實際踩過）。
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

/** CDP endpoint 還活著＝ main process 還在跑 */
async function stillAlive() {
  try {
    await getJson(`http://127.0.0.1:${PORT}/json/version`)
    return true
  } catch {
    return false
  }
}

async function main() {
  const results = []
  const ok = (name, pass, detail = '') => {
    results.push({ name, pass: !!pass })
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  }

  let child = spawn(EXE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA_DIR}`], { stdio: 'ignore' })
  let originalCloseToTray = null
  let originalOpenAtLogin = null
  /** 反代本來是關的、由測試開起來的 → 收尾要關回去 */
  let agyStartedByTest = false

  try {
    const pages = await waitTargets()
    const mainPage = pages.find((p) => /index\.html/i.test(p.url)) || pages[0]
    const cdp = new Cdp(mainPage.webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Runtime.enable')

    originalCloseToTray = await cdp.eval('window.electronAPI.store.get("closeToTray", true)')
    // 沒設定過時的預設要是「開」——使用者要的就是關窗不斷線。
    // 用一個一定不存在的 key 探預設值的傳遞路徑（closeToTray 本身可能已被人改過）
    const roundTrip = await cdp.eval(`(async () => {
      const s = window.electronAPI.store
      await s.set('closeToTray', false)
      const off = await s.get('closeToTray', true)   // 明確存 false 不可以被預設值蓋回 true
      await s.set('closeToTray', true)
      const on = await s.get('closeToTray', true)
      return { off, on }
    })()`)
    ok('closeToTray 兩個方向都存得進去、讀得回來',
      roundTrip?.off === false && roundTrip?.on === true, JSON.stringify(roundTrip))

    // ---- 開機自啟動 ----
    const startup = await cdp.eval('window.electronAPI.system.getStartup()')
    ok('打包版支援開機自啟動設定', startup?.supported === true, JSON.stringify(startup))
    originalOpenAtLogin = startup?.openAtLogin === true

    const turnedOn = await cdp.eval('window.electronAPI.system.setStartup(true)')
    ok('可以打開開機自啟動', turnedOn?.openAtLogin === true, JSON.stringify(turnedOn))
    const readBack = await cdp.eval('window.electronAPI.system.getStartup()')
    ok('重讀狀態跟剛寫入的一致（真相取自 OS）', readBack?.openAtLogin === true, JSON.stringify(readBack))
    const turnedOff = await cdp.eval(`window.electronAPI.system.setStartup(${originalOpenAtLogin})`)
    ok('可以還原成使用者原本的設定', turnedOff?.openAtLogin === originalOpenAtLogin,
      JSON.stringify(turnedOff))

    // ---- 設定 UI ----
    await cdp.eval('document.querySelector(\'.nav-tab[data-page="settings"]\')?.click()')
    await sleep(1200)
    await cdp.eval('document.querySelector(\'.settings-nav-item[data-section="basic"]\')?.click()')
    await sleep(400)
    const uiState = await cdp.eval(`(() => {
      const tray = document.getElementById('closeToTrayInput')
      const login = document.getElementById('startAtLoginInput')
      if (!tray || !login) return null
      const r = tray.getBoundingClientRect()
      return {
        trayChecked: tray.checked,
        loginDisabled: login.disabled,
        visible: r.width > 0 && r.height > 0,
        label: tray.closest('label')?.innerText.trim() || ''
      }
    })()`)
    ok('基本分頁看得到兩個開關且已反映實際狀態',
      uiState?.visible === true && uiState.trayChecked === true && uiState.loginDisabled === false,
      JSON.stringify(uiState))

    // 「藏起來之後反代還在服務」是這個功能的重點，一定要真的測。
    // 本來沒開就替他開一下，測完在 finally 關回去（沿用 e2e-agy-cdp.js 的作法）。
    // agy:* IPC 一律包成 { ok, data }，而且 data 裡有 apiKey——只取需要的欄位，別整包印出來
    const agyPortOf = async (expression) => {
      const res = await cdp.eval(`${expression}.then(r => (r?.ok && r.data?.running) ? r.data.port : 0)`)
        .catch(() => 0)
      return Number.isInteger(res) ? res : 0
    }
    let agyPort = await agyPortOf('window.electronAPI.agy.status()')
    if (!agyPort) {
      // 使用者開著的正式實例常常已經佔著預設埠（PORT_IN_USE），測試這份改用一個真的空著的埠。
      // 寫死一個數字會踩到別的程式（實測 47821 就被佔），所以現場問 OS 要一個。
      // 這是暫存 user-data-dir，寫進去不會動到使用者的設定。
      const port = await freePort()
      await cdp.eval(
        `window.electronAPI.agy.saveSettings({ port: ${port}, logBodies: false, retentionDays: 7 })`
      ).catch(() => null)
      // `agy.start()` 失敗時把原因印出來，不然只看得到「啟動失敗」
      const started = await cdp.eval('window.electronAPI.agy.start().then(r => r?.data?.error || r?.error || "")')
        .catch(() => 'IPC_FAILED')
      agyPort = await agyPortOf('window.electronAPI.agy.status()')
      agyStartedByTest = agyPort > 0
      if (!agyPort) console.log(`      （反代啟動失敗：${started || '未知'}，下面那條會 FAIL）`)
    }

    // ---- 單一實例 ----
    const second = spawn(EXE, [`--user-data-dir=${USER_DATA_DIR}`], { stdio: 'ignore' })
    let secondExit = null
    second.on('exit', (code) => { secondExit = code })
    await sleep(4000)
    ok('第二份會自己退出，不會兩份搶同一個埠與 DB',
      (secondExit !== null || second.exitCode !== null) && await stillAlive() === true,
      `第二份退出碼=${secondExit ?? second.exitCode}`)
    stopChildTree(second)

    // ---- 關視窗留背景 ----
    await cdp.eval('window.electronAPI.store.set("closeToTray", true)')
    await cdp.eval('window.electronAPI.window.close()')
    await sleep(2500)
    ok('關閉視窗後 main process 還活著', await stillAlive() === true)
    const hidden = await cdp.eval('document.hidden')
    ok('視窗真的藏起來了（renderer 進 hidden，輪詢會自己停）', hidden === true, String(hidden))

    // 整件事的重點：藏起來之後反代還在服務。
    // 只在使用者本來就開著反代時測，不替他啟停服務、不動他的 agyEnabled。
    if (agyPort) {
      const health = await getJson(`http://127.0.0.1:${agyPort}/health`).catch(() => null)
      ok('背景執行時 AGY 反代仍在服務', health?.ok === true,
        `port ${agyPort} → ${JSON.stringify(health)}`)
    } else {
      ok('背景執行時 AGY 反代仍在服務', false, '反代啟動失敗，這條沒測到')
    }

    // 藏起來之後還叫得回來：second-instance 訊號就是系統匣以外的另一條路
    await cdp.eval(`(() => {
      window.__visLog = []
      document.addEventListener('visibilitychange', () => window.__visLog.push(document.visibilityState))
    })()`)
    let thirdExit = null
    const third = spawn(EXE, [`--user-data-dir=${USER_DATA_DIR}`], { stdio: 'ignore' })
    third.on('exit', (code) => { thirdExit = code })

    // 斷言看的是「有沒有變成 visible 過」，不是最後停在 visible。
    // Electron 的 document.hidden 同時反映「被完全遮住」，而這裡是從背景的 node 程序
    // spawn 的，Windows 常常不給前景權，show() 之後馬上又被終端機遮回去（visible→hidden）。
    // 使用者從捷徑／工作列點是有前景權的，那是 OS 政策不是我們的 bug；
    // 這裡要驗的是「second-instance 有沒有真的把視窗叫出來」。
    let becameVisible = false
    for (let i = 0; i < 15 && !becameVisible; i += 1) {
      await sleep(1000)
      becameVisible = (await cdp.eval('(window.__visLog || []).includes("visible")')) === true
    }
    const visLog = await cdp.eval('JSON.stringify(window.__visLog || [])')
    ok('再點一次捷徑會把藏起來的視窗叫出來', becameVisible,
      `第二份退出碼=${thirdExit} visibilitychange=${visLog}`)
    stopChildTree(third)

    // ---- 關掉開關就恢復「關窗即結束」----
    await cdp.eval('window.electronAPI.store.set("closeToTray", false)')
    // 這一發會讓 App 真的結束，等不到回應是正常的
    void cdp.eval('window.electronAPI.window.close()').catch(() => {})
    await sleep(5000)
    ok('關掉開關後，關視窗就真的結束', await stillAlive() === false)

    cdp.close()
  } catch (error) {
    ok('腳本本身沒有炸掉', false, error.message)
  } finally {
    stopChildTree(child)
    await sleep(800)

    // 還原使用者設定：closeToTray 被我們改成 false、反代可能是我們開的。
    // 開機自啟動已在測項內還原。
    if (originalCloseToTray !== null) {
      child = spawn(EXE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA_DIR}`], { stdio: 'ignore' })
      try {
        const pages = await waitTargets(20000)
        const page = pages.find((p) => /index\.html/i.test(p.url)) || pages[0]
        const cdp2 = new Cdp(page.webSocketDebuggerUrl)
        await cdp2.connect()
        await cdp2.send('Runtime.enable')
        await cdp2.eval(`window.electronAPI.store.set("closeToTray", ${originalCloseToTray !== false})`)
        console.log(`已還原 closeToTray = ${originalCloseToTray !== false}`)
        if (agyStartedByTest) {
          await cdp2.eval('window.electronAPI.agy.stop()')
          console.log('已把測試開起來的反代關回去')
        }
        cdp2.close()
      } catch (error) {
        console.log(`還原設定失敗：${error.message}`)
      }
      stopChildTree(child)
    }
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
  process.exit(failed.length ? 1 : 0)
}

main()
