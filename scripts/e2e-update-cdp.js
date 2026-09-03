/**
 * 打包版自動更新 UI 的 CDP 回歸。
 *
 * 驗三件事：設定 → 基本真的有那組控制項（量得到尺寸，不是只有 DOM 在）、
 * 「檢查更新」按下去會真的走到 main 並回一個合法狀態、以及自動更新開關寫得進 store。
 * **會真的連一次 GitHub**（發行版還沒附 latest.yml 時回 error 也算通過——那是正確的降級）。
 *
 * 用暫存 user-data-dir，不碰使用者的設定；收尾只殺自己 spawn 出來的 pid。
 */
const { spawn } = require('child_process')
const path = require('path')
const os = require('os')
const fs = require('fs')
const http = require('http')

const PORT = 9243
const USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-update-'))
const EXE = process.env.VOICEINK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')

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
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map() }
  async connect() {
    this.ws = new globalThis.WebSocket(this.wsUrl)
    await new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej) })
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      const p = msg.id && this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
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
  close() { try { this.ws.close() } catch {} }
}

async function waitTargets(timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const pages = (await getJson(`http://127.0.0.1:${PORT}/json/list`)).filter((t) => t.type === 'page')
      if (pages.length) return pages
    } catch {}
    await sleep(400)
  }
  throw new Error('timeout waiting for CDP targets')
}

async function main() {
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA_DIR}`], { stdio: 'ignore' })
  const results = []
  const ok = (name, pass, detail = '') => {
    results.push(!!pass)
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  }
  let cdp = null
  try {
    await sleep(2500)
    const pages = await waitTargets()
    // 指示器（dictation-hud.html）也是一個 page target，主視窗一律用 index.html 認
    const mainPage = pages.find((p) => /index\.html/i.test(p.url))
    if (!mainPage) throw new Error('找不到主視窗 target')
    cdp = new Cdp(mainPage.webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Runtime.enable')

    // 進設定 → 基本，等控制項量得到尺寸（不睡固定時間）
    const laid = await cdp.eval(`(async () => {
      document.querySelector('[data-page="settings"]')?.click()
      // 等的是「loadSettings 真的跑完」——版本字串是 main 回來才填的，
      // 只等按鈕量得到尺寸會在事件還沒綁上去的時候就往下走
      for (let i = 0; i < 80; i++) {
        await new Promise((r) => setTimeout(r, 200))
        document.querySelector('.settings-nav-item[data-section="basic"]')?.click()
        const btn = document.getElementById('updateCheckBtn')
        const ver = document.getElementById('updateVersion')?.textContent || ''
        if (btn && btn.offsetWidth > 0 && /v\d+\./.test(ver)) break
      }
      const btn = document.getElementById('updateCheckBtn')
      const box = btn?.getBoundingClientRect()
      const ver = document.getElementById('updateVersion')
      return {
        w: Math.round(box?.width || 0),
        h: Math.round(box?.height || 0),
        wider: (box?.width || 0) > (box?.height || 0),
        version: ver?.textContent || '',
        auto: !!document.getElementById('autoUpdateInput'),
        installHidden: document.getElementById('updateInstallBtn')?.classList.contains('hidden')
      }
    })()`)
    ok('設定 → 基本有更新控制項且量得到尺寸',
      laid.w > 0 && laid.h > 0 && laid.wider && laid.auto === true, JSON.stringify(laid))
    ok('顯示目前版本', /目前版本 v\d+\.\d+\.\d+/.test(laid.version), laid.version)
    ok('尚未下載時不顯示「重新啟動並安裝」', laid.installHidden === true)

    // 真的按一次「檢查更新」（會連 GitHub）
    const checked = await cdp.eval(`(async () => {
      document.getElementById('updateCheckBtn').click()
      let st = null
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 400))
        st = await window.electronAPI.update.status()
        if (st && st.state !== 'checking') break
      }
      return { st, msg: document.getElementById('updateStatus')?.textContent || '' }
    })()`)
    const st = checked.st || {}
    ok('檢查更新回得到合法狀態',
      ['none', 'available', 'downloading', 'downloaded', 'error'].includes(st.state),
      JSON.stringify(st))
    ok('狀態文字有畫到畫面上', checked.msg.length > 0, checked.msg)
    ok('錯誤訊息不夾帶上游原文', !/http(s)?:\/\/|Error:|\bECONN/i.test(checked.msg), checked.msg)

    // 自動更新開關：寫得進 store 且讀得回來
    const toggled = await cdp.eval(`(async () => {
      const el = document.getElementById('autoUpdateInput')
      el.checked = false
      el.dispatchEvent(new Event('change'))
      await new Promise((r) => setTimeout(r, 400))
      const off = await window.electronAPI.store.get('autoUpdate', true)
      el.checked = true
      el.dispatchEvent(new Event('change'))
      await new Promise((r) => setTimeout(r, 400))
      const on = await window.electronAPI.store.get('autoUpdate', true)
      return { off, on, live: (await window.electronAPI.update.status()).autoUpdate }
    })()`)
    ok('自動更新開關存得起來', toggled.off === false && toggled.on === true && toggled.live === true,
      JSON.stringify(toggled))
  } catch (err) {
    ok('腳本沒有中途炸掉', false, String(err.message || err))
  } finally {
    cdp?.close()
    // 只殺自己 spawn 的那棵樹，不可以用 /IM（會關掉使用者的安裝版）
    try { spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' }) } catch {}
    await sleep(1500)
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(USER_DATA_DIR, { recursive: true, force: true }); break } catch { await sleep(800) }
    }
  }
  const failed = results.filter((r) => !r).length
  console.log(`\n${results.length - failed}/${results.length} 通過`)
  process.exit(failed ? 1 : 0)
}

main()
