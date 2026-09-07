'use strict'

// 打包版背景真流量：只複製翻譯設定，不修改使用者資料；不輸出金鑰或文章內容。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')
const root = path.join(__dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-translate-long-'))
const cfg = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'voiceink/config.json'), 'utf8'))
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
  translator: 'cloud', chatProviders: cfg.chatProviders,
  translateProviderId: cfg.translateProviderId, translateModelId: cfg.translateModelId,
  dictationEnabled: false, agyEnabled: false, closeToTray: false
}))
const port = 9258
const exe = process.env.VOICEINK_EXE || path.join(root, 'dist/win-unpacked/VoiceInk.exe')
const child = spawn(exe, [`--user-data-dir=${dir}`, `--remote-debugging-port=${port}`, '--hidden'], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let ws, next = 0
const pending = new Map()
function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++next
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error('背景頁面執行失敗')
  return r.result?.value
}
async function main() {
  let page
  for (let i = 0; i < 100; i++) {
    const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => [])
    page = pages.find((p) => p.type === 'page' && p.url.includes('index.html'))
    if (page) break
    await sleep(300)
  }
  assert.ok(page, '打包版應能啟動')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data), p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    m.error ? p.reject(new Error('CDP 操作失敗')) : p.resolve(m.result)
  }
  for (let i = 0; i < 100; i++) {
    const ready = await evaluate(`(() => {
      document.querySelector('[data-page="translate"]')?.click()
      return !!document.querySelector('#translateSourceLang .active')
    })()`)
    if (ready) break
    await sleep(300)
  }
  const article = Array.from({ length: 35 }, (_, i) =>
    `Section ${i + 1}\nThe village library opens every morning at nine. Students come here to read about science and history. Last summer, volunteers repaired the windows and planted flowers outside. The librarian keeps a notebook of suggestions and buys new books each month. Families can borrow books for two weeks and return them at the front desk.\nReference: REF${String(i + 1).padStart(3, '0')}`
  ).join('\n\n')
  await evaluate(`(() => {
    const input = document.getElementById('translateInput')
    input.value = ${JSON.stringify(article)}
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.getElementById('translateRunBtn').click()
  })()`)
  const start = Date.now()
  let state
  do {
    await sleep(1000)
    state = await evaluate(`(() => ({
      state: document.getElementById('translateOutputState').textContent,
      error: document.getElementById('translateError').textContent,
      count: document.getElementById('translateInputCount').textContent,
      output: document.getElementById('translateOutput').value
    }))()`)
    if (state.error) throw new Error('翻譯 API 實測失敗（未輸出上游內容）')
  } while (!state.state.includes('完成') && Date.now() - start < 620000)
  assert.ok(state.state.includes('完成'), '全文應完成')
  assert.ok(!state.count.includes('段'), '雲端不能顯示本地分段')
  for (let i = 1; i <= 35; i++) assert.ok(state.output.includes(`REF${String(i).padStart(3, '0')}`), `保留第 ${i} 段`)
  assert.ok(/[\u4e00-\u9fff]/.test(state.output), '回傳中文譯文')
  console.log(`PASS 打包版真實雲端長文 ${article.length} 字，35 段完整，${state.output.length} 字譯文，${Math.round((Date.now() - start) / 1000)} 秒`)
}
main().catch((e) => { console.error(e.message); process.exitCode = 1 }).finally(async () => {
  ws?.close()
  if (child.pid) {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 已結束 */ }
  }
  await sleep(500)
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
})
