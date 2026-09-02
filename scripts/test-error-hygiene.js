#!/usr/bin/env node
/**
 * VoiceInk — 錯誤訊息衛生與輸入校驗回歸測試（node 直跑，無需 electron）
 *
 * 專案規範：「額度與聊天的 HTTP 錯誤只記安全狀態摘要，禁止把 response body／token／
 * 外部 error message 寫進 console、diagnostics 或 IPC」。cloud-asr 與 local-llm 的
 * 雲端翻譯原本沒跟上這條，會把上游 body（200／120 字）與 `error.message` 原樣顯示。
 *
 * 一併涵蓋：
 * - `subtitleWindowBounds` 是 STORE_ALLOWLIST 裡唯一沒校驗、卻直接餵進 BrowserWindow 的 key
 * - AGY Anthropic 串流中途出錯時要先收掉開著的 content block
 * - 額度的 OpenCode Go／Ollama Cloud／Command Code 三支 API provider（上游 body 與金鑰不外洩）
 */

'use strict'

const http = require('http')
const os = require('os')
const path = require('path')
const fs = require('fs')
const Module = require('module')
const vm = require('vm')

const ROOT = path.join(__dirname, '..')

// local-llm 會 require('electron')（只為了 app.getPath）：用 stub 讓它能在純 node 載入
const realResolve = Module._resolveFilename
const STUB = path.join(__dirname, '_electron-stub-error-hygiene.js')
fs.writeFileSync(STUB, "module.exports = { app: { getPath: () => require('os').tmpdir(), isPackaged: false } }\n")
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return STUB
  return realResolve.call(this, request, ...rest)
}
process.on('exit', () => { try { fs.unlinkSync(STUB) } catch { /* best effort */ } })

let passed = 0
let failed = 0
function ok(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  PASS ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// 上游 body 裡塞進「絕對不該出現在使用者訊息裡」的字串
const SECRETS = ['sk-LEAKED-abcdef123456', 'ya29.FAKE-ACCESS-TOKEN', 'Bearer sk-echo-of-request']
const LEAKY_BODY = JSON.stringify({
  error: {
    message: `invalid request; received headers: {"authorization":"${SECRETS[2]}"} key=${SECRETS[0]} token=${SECRETS[1]}`,
    type: 'invalid_request_error'
  }
})

function leaks(message) {
  return SECRETS.filter((s) => String(message).includes(s))
}

/** 依 handler 起一個一次性 mock 上游 */
function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      url: `http://127.0.0.1:${server.address().port}/v1`,
      close: () => new Promise((r) => server.close(r))
    }))
  })
}

async function testCloudAsr() {
  console.log('\n[cloud-asr] 上游錯誤 body 不得進使用者訊息')
  const cloudAsr = require(path.join(ROOT, 'src/main/cloud-asr.js'))

  for (const status of [400, 401, 403, 429, 500]) {
    const up = await startServer((req, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(LEAKY_BODY)
    })
    const store = {
      get: (key, fallback) => ({
        asrApiUrl: up.url,
        asrApiKey: 'sk-local-user-key',
        asrModelId: 'openai/whisper-1'
      }[key] ?? fallback)
    }
    let message = ''
    try {
      await cloudAsr.transcribeAudio({
        buffer: cloudAsr.float32ToWav(new Float32Array(1600), 16000),
        format: 'wav',
        store
      })
      message = '(沒有丟例外)'
    } catch (e) {
      message = e.message
    }
    await up.close()
    const found = leaks(message)
    ok(`HTTP ${status} 的訊息不含上游 body`, found.length === 0, `洩漏 ${JSON.stringify(found)}｜訊息=${message}`)
    ok(`HTTP ${status} 的訊息仍帶得出狀態碼／可行動說明`,
      /雲端語音辨識/.test(message) && (message.includes(String(status)) || /API Key|請稍後|API URL/.test(message)),
      `訊息=${message}`)
  }

  // 純函式層：classifyHttpError 已不接受 body 參數（modelId 有預設值，不算進 arity）
  ok('classifyHttpError 只吃 status（簽章不再收 body）', cloudAsr.classifyHttpError.length === 1,
    `arity=${cloudAsr.classifyHttpError.length}`)

  // 403 曾經跟 401 合併成「請檢查 API Key」，害人去查一個根本正確的東西。
  // 實測 OpenRouter 對沒開通的轉錄模型就是回 403，同一把金鑰換一顆模型立刻 200。
  const m401 = cloudAsr.classifyHttpError(401, 'x-ai/grok-stt-1.0').message
  const m403 = cloudAsr.classifyHttpError(403, 'x-ai/grok-stt-1.0').message
  ok('401 才講金鑰', /API Key/.test(m401), m401)
  ok('403 不可以叫人去檢查金鑰', !/API Key/.test(m403), m403)
  ok('403 要指名是哪一顆模型', m403.includes('x-ai/grok-stt-1.0'), m403)

  // modelId 是使用者自填的設定，不是上游 body——可以進訊息，但不能因此漏掉別的東西
  ok('模型名沒填時不會出現空引號', !/「」/.test(cloudAsr.classifyHttpError(403).message))

  // 雲端轉錄模型講中文一樣會吐簡體（實測 openai/gpt-4o-transcribe 全簡體）
  const zhs = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ text: '今天天气很好，我们一起去公园散步吧。' }))
  })
  const zhStore = {
    get: (key, fallback) => ({
      asrApiUrl: zhs.url, asrApiKey: 'sk-local-user-key', asrModelId: 'openai/gpt-4o-transcribe'
    }[key] ?? fallback)
  }
  const zhOut = await cloudAsr.transcribeAudio({
    buffer: cloudAsr.float32ToWav(new Float32Array(1600), 16000),
    format: 'wav',
    language: 'zh-TW',
    store: zhStore
  })
  const jaOut = await cloudAsr.transcribeAudio({
    buffer: cloudAsr.float32ToWav(new Float32Array(1600), 16000),
    format: 'wav',
    language: 'ja',
    store: zhStore
  })
  await zhs.close()
  ok('目標語是繁中時把雲端的簡體轉過來', zhOut === '今天天氣很好，我們一起去公園散步吧。', zhOut)
  ok('目標語不是繁中就原樣放行（日文漢字不可被 opencc 弄髒）',
    jaOut === '今天天气很好，我们一起去公园散步吧。', jaOut)
}

/**
 * 雲端翻譯用的假 store：一組供應商 ＋ 指定它為翻譯來源
 * @param {string} url
 * @param {string} key
 */
function cloudStore(url, key) {
  const data = {
    translator: 'cloud',
    chatProviders: [{
      id: 'p_test',
      name: '測試',
      apiUrl: url,
      apiKey: key,
      models: ['google/gemini-3-flash-preview'],
      imageModels: []
    }],
    translateProviderId: 'p_test',
    translateModelId: 'google/gemini-3-flash-preview'
  }
  return { get: (k, fallback) => (k in data ? data[k] : fallback) }
}

async function testCloudTranslate() {
  console.log('\n[local-llm] 雲端翻譯的上游錯誤不得進使用者訊息')
  const localLlm = require(path.join(ROOT, 'src/main/local-llm.js'))

  // 1) 上游回結構化 JSON 錯誤 → 不得透傳 error.message
  let requestBody = null
  const bad = await startServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      try { requestBody = JSON.parse(raw) } catch { requestBody = null }
      res.writeHead(402, { 'Content-Type': 'application/json' })
      res.end(LEAKY_BODY)
    })
  })
  // 雲端翻譯的端點與金鑰跟聊天共用同一份供應商清單（chat.readTranslateConfig）
  const store = cloudStore(bad.url, 'sk-local-user-key')
  require(path.join(ROOT, 'src/main/chat.js')).setStore(store)
  let message = ''
  try {
    await localLlm.translate(store, '今天天氣很好。', 'en')
    message = '(沒有丟例外)'
  } catch (e) {
    message = e.message
  }
  await bad.close()
  // exclude 而不是 enabled:false：強制思考的模型收到後者會直接回 400
  // （實測 OpenRouter 的 grok-4.6／glm-5.3-flash："Reasoning is mandatory for this endpoint"）
  ok('雲端翻譯固定不要思考內容', requestBody?.reasoning?.exclude === true, JSON.stringify(requestBody))
  ok('JSON 錯誤不透傳 error.message', leaks(message).length === 0, `訊息=${message}`)
  ok('仍留下狀態碼', message.includes('402'), `訊息=${message}`)

  // 2) 上游回無法解析的 body → 不得夾帶 preview
  const garbage = await startServer((req, res) => {
    res.writeHead(400, { 'Content-Type': 'text/plain' })
    res.end(`<html>proxy debug: ${SECRETS[0]}  ${SECRETS[1]}</html>`)
  })
  const store2 = cloudStore(garbage.url, 'k')
  require(path.join(ROOT, 'src/main/chat.js')).setStore(store2)
  let message2 = ''
  try {
    await localLlm.translate(store2, '今天天氣很好。', 'en')
    message2 = '(沒有丟例外)'
  } catch (e) {
    message2 = e.message
  }
  await garbage.close()
  ok('無法解析的 body 不夾帶 preview', leaks(message2).length === 0, `訊息=${message2}`)
  ok('無法解析時仍留下狀態碼', message2.includes('400'), `訊息=${message2}`)
}

function testSubtitleBounds() {
  console.log('\n[main] subtitleWindowBounds 校驗')
  // main.js 頂層有大量 electron 依賴，這裡只把純函式抽出來在 vm 裡跑
  const src = fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf-8')
  const start = src.indexOf('function sanitizeSubtitleBounds(')
  ok('main.js 有 sanitizeSubtitleBounds', start >= 0)
  if (start < 0) return
  const end = src.indexOf('\n}', start) + 2
  const sanitize = vm.runInNewContext(`${src.slice(start, end)}; sanitizeSubtitleBounds`)

  const cases = [
    ['undefined', undefined],
    ['null', null],
    ['字串', 'x'],
    ['NaN 寬高', { width: NaN, height: NaN, x: NaN, y: NaN }],
    ['字串寬高', { width: '900', height: 'abc', x: '10', y: null }],
    ['負數與超大值', { width: -5, height: 1e9, x: -3000, y: 0 }],
    ['Infinity', { width: Infinity, height: -Infinity, x: Infinity, y: 5 }]
  ]
  for (const [label, input] of cases) {
    const out = sanitize(input)
    const sizeOk = Number.isInteger(out.width) && Number.isInteger(out.height) &&
      out.width >= 200 && out.width <= 8000 && out.height >= 80 && out.height <= 8000
    const posOk = (out.x === undefined || Number.isInteger(out.x)) &&
      (out.y === undefined || Number.isInteger(out.y))
    ok(`${label} → BrowserWindow 收得下的值`, sizeOk && posOk, JSON.stringify(out))
  }
  const kept = sanitize({ width: 1024, height: 260, x: 120, y: 80 })
  ok('正常值原樣保留', kept.width === 1024 && kept.height === 260 && kept.x === 120 && kept.y === 80,
    JSON.stringify(kept))

  // 兩個入口都要走校驗：store:set 的寫入路徑與 createSubtitleWindow 的讀取路徑
  ok('store:set 走 sanitizeSubtitleBounds',
    /key === 'subtitleWindowBounds'[\s\S]{0,120}sanitizeSubtitleBounds\(value\)/.test(src))
  ok('createSubtitleWindow 讀取時也走 sanitizeSubtitleBounds',
    /const bounds = sanitizeSubtitleBounds\(store \? store\.get\('subtitleWindowBounds'/.test(src))
}

function testAnthropicErrorStream() {
  console.log('\n[agy/anthropic] 串流中途出錯要先收掉開著的 content block')
  const anthropic = require(path.join(ROOT, 'src/main/agy/anthropic.js'))

  // 已經開了一個 text block（上游吐過內容後才炸）
  const open = anthropic.createCollector('claude-sonnet-4-5')
  const frames = anthropic.consume(open, { candidates: [{ content: { parts: [{ text: '嗨' }] } }] })
  ok('前置：確實開了一個 content block', /content_block_start/.test(frames), frames.slice(0, 80))
  const errOpen = anthropic.errorStream(open, 'UPSTREAM_ERROR')
  ok('先送 content_block_stop 再送 error',
    errOpen.indexOf('content_block_stop') >= 0 &&
    errOpen.indexOf('content_block_stop') < errOpen.indexOf('event: error'),
    JSON.stringify(errOpen))
  ok('錯誤格只帶內部代碼，不帶上游訊息',
    errOpen.includes('UPSTREAM_ERROR') && leaks(errOpen).length === 0)

  // 還沒開任何 block（連線就失敗）→ 不能憑空補一個 content_block_stop
  const fresh = anthropic.createCollector('claude-sonnet-4-5')
  const errFresh = anthropic.errorStream(fresh, 'TOKEN_EXPIRED')
  ok('沒開過 block 時不補 content_block_stop', !errFresh.includes('content_block_stop'),
    JSON.stringify(errFresh))
  ok('沒開過 block 時仍送得出 error', errFresh.includes('event: error'))
}

/**
 * OpenCode Go／Ollama Cloud／Command Code 的額度端點都吃一把 API 金鑰，回什麼字串由對方決定。
 * 上游 body 與金鑰都不可以流進 notes（會顯示在卡片上）或診斷日誌。
 */
async function testUsageApiProviders() {
  console.log('\n[usage] OpenCode Go／Ollama／Command Code 的上游錯誤與金鑰不外洩')
  const { syncOpenCode } = require(path.join(ROOT, 'src/main/usage/opencode.js'))
  const { syncOllama } = require(path.join(ROOT, 'src/main/usage/ollama.js'))
  const { syncCommandCode } = require(path.join(ROOT, 'src/main/usage/commandcode.js'))
  const KEY = 'sk-hygiene-sentinel-key'
  const BODY = '<<upstream-secret-echo sk-hygiene-sentinel-key>>'
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-hygiene-usage-'))
  try {
    for (const [name, sync, envVar] of [
      ['opencode-go', syncOpenCode, 'OPENCODE_API_KEY'],
      ['ollama', syncOllama, 'OLLAMA_API_KEY'],
      ['commandcode', syncCommandCode, 'COMMAND_CODE_API_KEY']
    ]) {
      for (const status of [401, 403, 500]) {
        const logs = []
        const account = await sync({
          homeDir,
          env: { [envVar]: KEY },
          nowMs: 0,
          fetchImpl: async () => new Response(BODY, { status }),
          log: (line) => logs.push(line)
        })
        const text = JSON.stringify({ account, logs })
        ok(`${name} HTTP ${status} 不回送上游 body`, !text.includes('upstream-secret-echo'), text)
        ok(`${name} HTTP ${status} 不外洩金鑰`, !text.includes(KEY), text)
        ok(`${name} HTTP ${status} 有給使用者看得懂的說明`, account.notes.trim().length > 0)
      }
    }
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
}

/**
 * HF模型的 HF Hub 查詢：上游（HF）回什麼字串由對方決定，錯誤訊息只能有狀態摘要。
 * 同機碼 `KEY` 會被塞進偽造的上游 body：UI 若把 body 印出來就等於把使用者輸入的 token 回音。
 */
async function testHfHub() {
  console.log('\n[HF] Hugging Face 查詢的上游錯誤與金鑰不外洩')
  const hub = require(path.join(ROOT, 'src/main/hfmodels/hub.js'))
  const KEY = 'hf_hygiene_sentinel_token'
  hub.setToken(KEY)
  const BODY = `<<upstream-secret-echo ${KEY}>>`
  for (const status of [401, 403, 500]) {
    let logged = ''
    const original = globalThis.fetch
    try {
      globalThis.fetch = async () => new Response(BODY, { status })
      // peekFile：直接打 fetch 的那條路（searchModels／listFiles 走 fetchJson，那支有獨立的上限與包裝）
      let message = ''
      try {
        await hub.peekFile('owner/repo', 'model.gguf')
      } catch (error) {
        message = String(error?.message || error)
      }
      ok(`HF peekFile HTTP ${status} 不回送上游 body`, !message.includes('upstream-secret-echo'), message)
      ok(`HF peekFile HTTP ${status} 不外洩 token`, !message.includes(KEY), message)
      ok(`HF peekFile HTTP ${status} 有給使用者看得懂的說明`, message.trim().length > 0, message)
    } finally {
      globalThis.fetch = original
    }
  }
  // fetchJson 那條（searchModels）：讓它打到假網址不行——HOST 是固定的，
  // 所以改抓「帶金鑰的請求頭不會出現在錯誤訊息」這一點：整個 hub 的錯誤都是固定字串，
  // 這裡驗的是格式正規化：repoId／路徑不合法要拒絕，不能把任意字串接進 huggingface.co 的網址
  for (const bad of ['../etc/passwd', 'owner/', '/name', 'owner/../..', 'a/b?x=1', 'a/b#c']) {
    const id = hub.isRepoId(bad)
    const p = hub.isRepoPath(bad)
    ok(`格式正規化擋下 ${JSON.stringify(bad)}（repo=${id} path=${p}）`, !id && !p)
  }
  for (const good of ['unsloth/Qwen3.5-4B-GGUF', 'a/b.c_d-e']) {
    ok(`格式正規化放行 ${JSON.stringify(good)}`, hub.isRepoId(good))
  }
  hub.setToken('')
}

async function main() {
  console.log('=== 錯誤訊息衛生與輸入校驗 ===')
  await testCloudAsr()
  await testCloudTranslate()
  testSubtitleBounds()
  testAnthropicErrorStream()
  await testUsageApiProviders()
  await testHfHub()
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('測試本身出錯：', e)
  process.exit(1)
})
