/**
 * CDP UI：選檔 → 開始轉錄 → 讀 toast / 結果 / console
 */
const http = require('http')
const path = require('path')
const os = require('os')
const fs = require('fs')
const { spawn } = require('child_process')

const PORT = 9251
// Windows 偶爾會有別的東西鎖住 dist/win-unpacked（打包失敗、防毒掃描中），
// 這時可以打包到別的資料夾再用 VOICEINK_EXE 指過去，測試不必等鎖放掉
const EXE = process.env.VOICEINK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
// 暫存 user-data-dir：使用者開著的正式實例佔 single-instance lock，
// 沒有自己的資料夾會被擋掉（second-instance 轉交後退出，CDP 等不到主視窗）
const USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-cdp-'))
// 模型放在 `<userData>/models`，換了 user-data-dir 就等於一顆模型都沒裝（轉錄會直接失敗）。
// 用 junction 把真正的模型資料夾接進來——只讀不寫，設定仍然各自獨立。
{
  const real = path.join(process.env.APPDATA || os.homedir(), 'voiceink', 'models')
  if (fs.existsSync(real)) {
    try { fs.symlinkSync(real, path.join(USER_DATA_DIR, 'models'), 'junction') } catch { /* 沒有就當沒裝 */ }
  }
}
const SAMPLE = path.join(__dirname, 'test-sample.wav')

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
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
    this.logs = []
  }
  async connect() {
    this.ws = new WebSocket(this.wsUrl)
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
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args || []).map((a) => a.value ?? a.description).join(' ')
        this.logs.push(text)
        if (/error|fail|JSON|Syntax/i.test(text)) console.log('[console]', text)
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const t = msg.params.exceptionDetails?.exception?.description ||
          msg.params.exceptionDetails?.text
        this.logs.push('EXC ' + t)
        console.log('[exc]', t)
      }
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
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (r.exceptionDetails) {
      throw new Error(
        r.exceptionDetails.exception?.description ||
        r.exceptionDetails.text ||
        'eval error'
      )
    }
    return r.result?.value
  }
  close() {
    try { this.ws.close() } catch { /* */ }
  }
}

async function main() {
  if (!fs.existsSync(EXE)) throw new Error('missing ' + EXE)
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA_DIR}`], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let mainLog = ''
  child.stderr.on('data', (d) => { mainLog += d.toString() })
  child.stdout.on('data', (d) => { mainLog += d.toString() })

  try {
    let pages
    for (let i = 0; i < 40; i++) {
      await sleep(250)
      try {
        pages = await getJson(`http://127.0.0.1:${PORT}/json`)
        if (pages?.length) break
      } catch { /* retry */ }
    }
    if (!pages?.length) throw new Error('no cdp pages')

    const page = pages.find((p) => p.url?.includes('index.html')) || pages[0]
    const cdp = new Cdp(page.webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Runtime.enable')
    await cdp.send('DOM.enable')
    await cdp.send('Page.enable')

    // 切到語音轉文字頁的「檔案轉錄」子分頁。
    // stt-page 與 transcribe 都是 dynamic import，要等 transcribe.js 真的綁好
    // （模型選單填出來就代表那一串 then 跑完了），否則 setFileInputFiles 的 change 沒人接。
    await cdp.eval(`document.querySelector('[data-page="stt"]')?.click(), 'ok'`)
    for (let i = 0; i < 40; i++) {
      await sleep(250)
      const ready = await cdp.eval(`!!document.getElementById('fileAsrModel')?.options.length`)
      if (ready) break
    }
    await cdp.eval(`document.querySelector('#sttSubtabs [data-subtab="file"]')?.click(), 'ok'`)
    await sleep(400)

    // 設檔案
    const { root } = await cdp.send('DOM.getDocument', { depth: 1 })
    const { nodeId } = await cdp.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: '#fileInput'
    })
    if (!nodeId) throw new Error('no fileInput')
    await cdp.send('DOM.setFileInputFiles', { nodeId, files: [SAMPLE] })
    await sleep(400)

    const pre = await cdp.eval(`({
      file: document.querySelector('.file-name')?.textContent,
      opts: !document.getElementById('transcribeOptions')?.classList.contains('hidden'),
      btn: document.getElementById('startTranscribeBtn')?.disabled
    })`)
    console.log('pre', pre)

    // 這支從背景程序 spawn，Windows 通常不給前景權 → 視窗被遮住、rAF 完全不觸發。
    // 那正是 waitForPaint 卡死的條件，順手把它記下來，之後看 log 就知道有沒有測到這條路徑。
    const vis = await cdp.eval(`({ hidden: document.hidden, state: document.visibilityState })`)
    const raf = await cdp.eval(
      `new Promise((r) => { const t = setTimeout(() => r('no-raf'), 3000); requestAnimationFrame(() => { clearTimeout(t); r('raf-ok') }) })`
    )
    console.log('visibility', vis, 'raf', raf)
    await cdp.eval(`document.getElementById('startTranscribeBtn')?.click()`)

    let last = null
    for (let i = 0; i < 60; i++) {
      await sleep(500)
      last = await cdp.eval(`({
        progress: !document.getElementById('transcribeProgress')?.classList.contains('hidden'),
        pText: document.querySelector('#transcribeProgress .progress-text')?.textContent,
        pPct: document.querySelector('#transcribeProgress .progress-percent')?.textContent,
        result: !document.getElementById('transcribeResult')?.classList.contains('hidden'),
        resultText: document.getElementById('resultText')?.textContent?.slice(0, 100),
        toast: document.getElementById('toast')?.classList.contains('hidden') === false
          ? document.querySelector('#toast .toast-message')?.textContent
          : null,
        opts: !document.getElementById('transcribeOptions')?.classList.contains('hidden')
      })`)
      if (i % 4 === 0) console.log('tick', last)
      if (last.result || last.toast || (last.opts && !last.progress && i > 4)) break
    }

    console.log('FINAL', last)
    console.log('logs with error', cdp.logs.filter((l) => /error|JSON|Syntax|fail|轉錄/i.test(l)))
    console.log('mainLog tail', mainLog.slice(-1500))
    cdp.close()
  } finally {
    try { child.kill() } catch { /* */ }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
