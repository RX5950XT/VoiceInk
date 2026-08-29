/**
 * 重現檔案轉錄黑屏：CDP 選檔 → 開始轉錄 → 觀察 console / DOM / 崩潰
 */
const { spawn } = require('child_process')
const path = require('path')
const http = require('http')
const fs = require('fs')

const PORT = 9241
const EXE = path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
const SAMPLE = path.join(__dirname, 'test-sample.wav')

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function stopChildTree(child) {
  if (!child?.pid) return
  try { spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' }) } catch {}
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
    this.exceptions = []
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
        this.logs.push({ type: msg.params.type, text })
      } else if (msg.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(msg.params.exceptionDetails?.text || JSON.stringify(msg.params))
      } else if (msg.method === 'Inspector.targetCrashed') {
        this.exceptions.push('TARGET_CRASHED')
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
      throw new Error(r.exceptionDetails.text || r.exceptionDetails.exception?.description || 'eval error')
    }
    return r.result?.value
  }
  close() {
    try { this.ws.close() } catch {}
  }
}

async function waitTargets(timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json/list`)
      const pages = list.filter((t) => t.type === 'page')
      if (pages.length) return pages
    } catch {}
    await sleep(400)
  }
  throw new Error('timeout waiting for CDP targets')
}

async function snapshot(cdp, label) {
  const state = await cdp.eval(`(() => {
    const g = (id) => {
      const el = document.getElementById(id)
      if (!el) return null
      return {
        hidden: el.classList.contains('hidden'),
        display: getComputedStyle(el).display,
        text: (el.innerText || '').slice(0, 120)
      }
    }
    return {
      bodyBg: getComputedStyle(document.body).backgroundColor,
      bodyText: getComputedStyle(document.body).color,
      bodyChildren: document.body.children.length,
      appHtmlLen: (document.getElementById('app')?.innerHTML || '').length,
      pageActive: document.getElementById('page-stt')?.classList.contains('active'),
      dropZone: g('dropZone'),
      fileInfo: g('fileInfo'),
      options: g('transcribeOptions'),
      progress: g('transcribeProgress'),
      result: g('transcribeResult'),
      toast: g('toast'),
      progressText: document.querySelector('#transcribeProgress .progress-text')?.textContent || null,
      resultText: (document.getElementById('resultText')?.textContent || '').slice(0, 200),
      selectedHint: document.querySelector('#fileInfo .file-name')?.textContent || null
    }
  })()`)
  console.log(`\n--- snapshot: ${label} ---`)
  console.log(JSON.stringify(state, null, 2))
  return state
}

async function main() {
  if (!fs.existsSync(SAMPLE)) {
    console.error('missing sample', SAMPLE)
    process.exit(1)
  }
  console.log('sample', SAMPLE, fs.statSync(SAMPLE).size)

  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], {
    stdio: 'pipe',
    detached: false
  })
  let mainLog = ''
  child.stderr?.on('data', (d) => { mainLog += d.toString(); process.stderr.write(d) })
  child.stdout?.on('data', (d) => { mainLog += d.toString(); process.stdout.write(d) })

  try {
    await sleep(3000)
    const pages = await waitTargets()
    const mainPage = pages.find((p) => /index\.html|VoiceInk/i.test(p.url + p.title)) || pages[0]
    console.log('page', mainPage.url)

    const cdp = new Cdp(mainPage.webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    await cdp.send('Log.enable').catch(() => {})

    await snapshot(cdp, 'initial')

    // set file via CDP
    const doc = await cdp.send('DOM.getDocument', { depth: 0 })
    const rootId = doc.root?.nodeId
    if (!rootId) throw new Error('DOM root missing: ' + JSON.stringify(doc))
    const { nodeId } = await cdp.send('DOM.querySelector', {
      nodeId: rootId,
      selector: '#fileInput'
    })
    if (!nodeId) throw new Error('fileInput not found')
    await cdp.send('DOM.setFileInputFiles', {
      nodeId,
      files: [SAMPLE]
    })
    await sleep(500)
    await snapshot(cdp, 'after file select')

    // click start
    const clickResult = await cdp.eval(`(() => {
      const btn = document.getElementById('startTranscribeBtn')
      if (!btn) return 'no-btn'
      if (btn.disabled) return 'disabled'
      btn.click()
      return 'clicked'
    })()`)
    console.log('click start:', clickResult)

    // poll for ~2 min while model loads + transcribes
    let sawProgressVisible = false
    let finished = false
    for (let i = 0; i < 60; i++) {
      await sleep(2000)
      let state
      try {
        state = await snapshot(cdp, `t=${(i + 1) * 2}s`)
      } catch (e) {
        console.error('snapshot failed (possible crash):', e.message)
        console.log('exceptions', cdp.exceptions)
        console.log('logs', cdp.logs.slice(-20))
        console.log('mainLog tail', mainLog.slice(-2000))
        throw new Error('snapshot failed during transcription')
      }

      if (cdp.exceptions.length) {
        console.log('exceptions so far:', cdp.exceptions)
      }
      if (cdp.logs.filter((l) => l.type === 'error').length) {
        console.log('console errors:', cdp.logs.filter((l) => l.type === 'error'))
      }

      // detect "black screen": app emptied or page gone
      if (!state.appHtmlLen || state.appHtmlLen < 100) {
        console.error('BLACK SCREEN: app HTML collapsed')
        throw new Error('BLACK SCREEN: app HTML collapsed')
      }
      if (state.progress && !state.progress.hidden) {
        sawProgressVisible = true
      }
      if (state.result && !state.result.hidden) {
        console.log('SUCCESS result:', state.resultText || '(empty)')
        finished = true
        break
      }
      if (state.toast && !state.toast.hidden) {
        console.log('toast visible:', state.toast.text)
      }
      // if options back without result, failed
      if (state.options && !state.options.hidden && state.progress?.hidden && i > 2) {
        console.log('returned to options (likely failed)')
        finished = true
        break
      }
    }
    console.log('sawProgressVisible', sawProgressVisible, 'finished', finished)
    if (!sawProgressVisible) {
      console.error('FAIL: progress panel never visible (black-screen symptom)')
      throw new Error('progress panel never visible')
    }

    console.log('\n=== final console errors ===')
    console.log(cdp.logs.filter((l) => l.type === 'error' || l.type === 'warning'))
    console.log('exceptions', cdp.exceptions)
    console.log('mainLog tail', mainLog.slice(-3000))

    cdp.close()
  } catch (e) {
    console.error('FAIL', e)
    console.log('mainLog', mainLog.slice(-3000))
    process.exitCode = 1
  } finally {
    stopChildTree(child)
  }
}

main()
