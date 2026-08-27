/**
 * 量打包版「點 exe → 主窗 CDP 可連、聊天頁可用」的時間。
 * 用法：node scripts/probe-startup.js
 */
const { spawn } = require('child_process')
const path = require('path')
const http = require('http')

const PORT = 9247
const EXE = path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = ''
      res.on('data', (c) => { d += c })
      res.on('end', () => {
        try { resolve(JSON.parse(d)) } catch (e) { reject(e) }
      })
    }).on('error', reject)
  })
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitTargets(timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json/list`)
      const pages = list.filter((t) => t.type === 'page')
      if (pages.length) return { pages, ms: Date.now() - start }
    } catch { /* 還在起 */ }
    await sleep(50)
  }
  throw new Error('timeout waiting for CDP')
}

async function main() {
  const t0 = Date.now()
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  child.stdout.on('data', (c) => { log += c })
  child.stderr.on('data', (c) => { log += c })

  try {
    const { pages, ms: cdpMs } = await waitTargets(30000)
    const mainPage = pages.find((p) => /index\.html|VoiceInk/i.test(p.url + p.title)) || pages[0]
    const WebSocket = globalThis.WebSocket
    const ws = new WebSocket(mainPage.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res)
      ws.addEventListener('error', rej)
    })
    let id = 0
    const pending = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      }
    })
    const send = (method, params = {}) => {
      const n = ++id
      return new Promise((resolve, reject) => {
        pending.set(n, { resolve, reject })
        ws.send(JSON.stringify({ id: n, method, params }))
      })
    }
    const evalExpr = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
      return r.result?.value
    }

    const ready = await evalExpr(`(async () => {
      const start = Date.now()
      while (Date.now() - start < 20000) {
        const chat = document.getElementById('page-chat')
        const api = typeof window.electronAPI?.chat?.list === 'function'
        if (document.readyState === 'complete' && chat?.classList.contains('active') && api) {
          return {
            readyMs: Date.now() - start,
            title: document.title,
            chatActive: true
          }
        }
        await new Promise((r) => setTimeout(r, 20))
      }
      return { readyMs: -1, title: document.title, chatActive: false }
    })()`)

    const wall = Date.now() - t0
    const marks = [...log.matchAll(/\[boot\] (\d+)ms ([^\r\n]+)/g)].map((m) => `${m[1]} ${m[2]}`)
    console.log(JSON.stringify({
      wallMs: wall,
      cdpTargetMs: cdpMs,
      rendererReadyMs: ready.readyMs,
      chatActive: ready.chatActive,
      title: ready.title,
      bootMarks: marks
    }, null, 2))
    ws.close()
  } finally {
    child.kill()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
