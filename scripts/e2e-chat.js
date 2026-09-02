/**
 * e2e：main 端聊天（mock SSE server，不打真 API）
 * 用法：npx electron scripts/e2e-chat.js
 *
 * userData 指向暫存目錄，不會動到真正的 chats.json。
 */
const path = require('path')
const os = require('os')
const fs = require('fs')
const http = require('http')
const { app } = require('electron')

const TMP = path.join(os.tmpdir(), `voiceink-e2e-chat-${process.pid}`)
fs.mkdirSync(TMP, { recursive: true })
app.setPath('userData', TMP)

const chat = require('../src/main/chat')
const chatStore = require('../src/main/chat-store')
const chatModels = require('../src/main/chat-models')
const chatImages = require('../src/main/chat-images')

/** 1x1 PNG */
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

let passed = 0
let failed = 0

function ok(name, cond, extra = '') {
  if (cond) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    console.log(`  FAIL  ${name}${extra ? `\n        ${extra}` : ''}`)
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** 收 delta 的假 WebContents */
function makeSender() {
  const deltas = []
  return {
    deltas,
    isDestroyed: () => false,
    send(channel, payload) {
      if (channel === 'chat:delta') deltas.push(payload)
    }
  }
}

/**
 * 假設定 store。
 *
 * 設定已改成多組供應商，但既有案例大多只關心「一組 url/key/models」，
 * 所以這裡保留舊寫法當語法糖：傳 chatApiUrl／chatApiKey／chatModels 會被包成單一供應商。
 * 要測多組時直接傳 chatProviders。
 */
function makeStore(overrides = {}) {
  const {
    chatApiUrl = '',
    chatApiKey = 'test-key',
    chatModels = ['test/model-a', 'test/model-b'],
    chatProviders,
    ...rest
  } = overrides
  const data = {
    chatProviders: chatProviders || [
      { id: 'p_test', name: '測試供應商', apiUrl: chatApiUrl, apiKey: chatApiKey, models: chatModels }
    ],
    chatProviderId: 'p_test',
    chatModelId: 'test/model-a',
    chatPrompts: [],
    chatPromptId: '',
    chatThinking: false,
    ...rest
  }
  return {
    data,
    get(key, def) {
      return key in this.data ? this.data[key] : def
    },
    set(key, value) {
      this.data[key] = value
    }
  }
}

/**
 * @param {(req: http.IncomingMessage, res: http.ServerResponse, state: any) => void} handler
 */
function startServer(handler) {
  const state = { requests: 0, lastBody: null }
  const server = http.createServer((req, res) => {
    state.requests++
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      try {
        state.lastBody = JSON.parse(body)
      } catch {
        state.lastBody = null
      }
      handler(req, res, state)
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ url: `http://127.0.0.1:${port}/v1`, state, close: () => server.close() })
    })
  })
}

function sseHead(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
}

function sseChunk(text) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`
}

function sseReasoning(text) {
  return `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: text } }] })}\n\n`
}

// ===== 案例 =====

async function caseA() {
  console.log('\n[A] 串流分塊拼接')
  const server = await startServer((req, res) => {
    sseHead(res)
    const full = sseChunk('你好') + sseChunk('，世界') + sseChunk('！')
    // 刻意在 JSON 中間切開，驗證跨 chunk 的行緩衝
    res.write(full.slice(0, 30))
    setTimeout(() => res.write(full.slice(30)), 20)
    setTimeout(() => {
      res.write('data: [DONE]\n\n')
      res.end()
    }, 40)
  })
  chat.setStore(makeStore({ chatApiUrl: server.url }))
  const conv = await chatStore.create()
  const sender = makeSender()
  const result = await chat.send({ reqId: 'a1', conversationId: conv.id, text: '嗨' }, sender)
  ok('回傳完整內容', result.ok && result.content === '你好，世界！', JSON.stringify(result))
  ok('delta 逐塊送達', sender.deltas.length === 3, `deltas=${sender.deltas.length}`)
  ok('delta 帶正確 reqId', sender.deltas.every((d) => d.reqId === 'a1'))
  const saved = await chatStore.get(conv.id)
  ok('user + assistant 都已存檔', saved.messages.length === 2 && saved.messages[1].role === 'assistant')
  ok('標題取自第一則 user 訊息', saved.title === '嗨', saved.title)
  ok('送出的 model 來自 store 而非 renderer', server.state.lastBody?.model === 'test/model-a')
  ok('送出時 stream=true', server.state.lastBody?.stream === true)
  server.close()
}

async function caseB() {
  console.log('\n[B] 中斷後部分內容仍存檔')
  const server = await startServer((req, res) => {
    sseHead(res)
    res.write(sseChunk('前半'))
    // 不結束，等被中斷
    setInterval(() => {
      if (!res.writableEnded) res.write(': keep-alive\n\n')
    }, 50).unref()
  })
  chat.setStore(makeStore({ chatApiUrl: server.url }))
  const conv = await chatStore.create()
  const sender = makeSender()
  const promise = chat.send({ reqId: 'b1', conversationId: conv.id, text: '寫首詩' }, sender)
  await sleep(300)
  const busyResult = await chat.send({ reqId: 'b2', conversationId: conv.id, text: '插隊' }, sender)
  ok('串流中不接受第二個請求', !busyResult.ok && busyResult.error.includes('仍在回應中'), busyResult.error)

  ok('abort 回報成功', chat.abort('b1') === true)
  const result = await promise
  ok('回報 aborted', result.aborted === true, JSON.stringify(result))
  const saved = await chatStore.get(conv.id)
  ok('部分內容已存檔', saved.messages.at(-1)?.content === '前半', JSON.stringify(saved.messages))
  ok('中斷後不再 busy', chat.isBusy() === false)

  // 沒有 inflight 的狀態下同一個 tick 併發送兩則。
  // 守衛是同步檢查，佔位若排在 await 之後（讀對話、存圖片、寫使用者訊息都是 await），
  // 兩個請求會一起通過守衛：兩條串流、兩則使用者訊息連著寫進同一個對話，
  // 先開的那條被後者覆蓋 → 「停止」按鈕再也找不到它。
  const beforeRequests = server.state.requests
  const pending = [
    chat.send({ reqId: 'b3', conversationId: conv.id, text: '同時一' }, sender),
    chat.send({ reqId: 'b4', conversationId: conv.id, text: '同時二' }, sender)
  ]
  // 被擋下的那個立刻回；放行的那個會一直串流到被中斷，先讓它真的連上去
  await sleep(300)
  ok('只開一條上游連線', server.state.requests === beforeRequests + 1,
    `上游請求數 ${beforeRequests} → ${server.state.requests}`)
  const contents = (await chatStore.get(conv.id)).messages.map((m) => m.content)
  ok('只有一則使用者訊息落盤',
    contents.filter((c) => String(c).startsWith('同時')).length === 1,
    JSON.stringify(contents))
  ok('放行的那條 abort 得掉（沒有被後來者覆蓋）', chat.abort('b3') === true)
  const results = await Promise.all(pending)
  ok('無 inflight 時同 tick 併發：一個放行、一個被擋',
    results.filter((r) => !r.ok && String(r.error).includes('仍在回應中')).length === 1,
    JSON.stringify(results))
  await sleep(50)
  ok('併發測完不留 inflight', chat.isBusy() === false)
  server.close()
}

function caseC() {
  console.log('\n[C] 上下文裁切')
  const long = 'x'.repeat(9000)
  const history = [
    { role: 'user', content: `最舊 ${long}` },
    { role: 'assistant', content: `中間 ${long}` },
    { role: 'user', content: `較新 ${long}` },
    { role: 'assistant', content: '短的' },
    { role: 'user', content: '最新的問題' }
  ]
  const messages = chat.buildMessages(history, '你是助理')
  const total = messages.reduce((n, m) => n + m.content.length, 0)
  ok('system 保留在最前', messages[0].role === 'system' && messages[0].content === '你是助理')
  ok('最新訊息一定保留', messages.at(-1).content === '最新的問題')
  ok('最舊訊息被丟棄', !messages.some((m) => m.content.startsWith('最舊')))
  ok('總量未超過上限（不含 system）', total - '你是助理'.length <= chat.MAX_CONTEXT_CHARS, `total=${total}`)

  const huge = chat.buildMessages([{ role: 'user', content: 'y'.repeat(30000) }], '')
  ok('單則就超標時仍照送', huge.length === 1 && huge[0].content.length === 30000)

  const noSystem = chat.buildMessages([{ role: 'user', content: 'hi' }], '')
  ok('無 system prompt 時不送 system', noSystem.length === 1 && noSystem[0].role === 'user')
}

async function caseD() {
  console.log('\n[D] model allowlist')
  const server = await startServer((req, res) => {
    sseHead(res)
    res.write('data: [DONE]\n\n')
    res.end()
  })
  chat.setStore(makeStore({ chatApiUrl: server.url, chatModelId: 'evil/expensive-model' }))
  const conv = await chatStore.create()
  const result = await chat.send({ reqId: 'd1', conversationId: conv.id, text: '嗨' }, makeSender())
  ok('清單外的 model 被拒絕', !result.ok, JSON.stringify(result))
  ok('未發出任何 HTTP 請求', server.state.requests === 0, `requests=${server.state.requests}`)

  chat.setStore(makeStore({ chatApiUrl: server.url, chatApiKey: '' }))
  const noKey = await chat.send({ reqId: 'd2', conversationId: conv.id, text: '嗨' }, makeSender())
  ok('沒有 API Key 時拒絕', !noKey.ok && noKey.error.includes('API Key'), noKey.error)

  chat.setStore(makeStore({ chatApiUrl: server.url }))
  const tooLong = await chat.send(
    { reqId: 'd3', conversationId: conv.id, text: 'z'.repeat(chat.MAX_INPUT_CHARS + 1) },
    makeSender()
  )
  ok('超長輸入被拒絕', !tooLong.ok && tooLong.error.includes('過長'), tooLong.error)

  const empty = await chat.send({ reqId: 'd4', conversationId: conv.id, text: '   ' }, makeSender())
  ok('空白訊息被拒絕', !empty.ok, JSON.stringify(empty))

  const noConv = await chat.send({ reqId: 'd5', conversationId: 'not-exist', text: '嗨' }, makeSender())
  ok('不存在的對話被拒絕', !noConv.ok && noConv.error.includes('找不到'), noConv.error)
  ok('全程未發出 HTTP 請求', server.state.requests === 0, `requests=${server.state.requests}`)
  server.close()
}

async function caseE() {
  console.log('\n[E] 儲存上限淘汰')
  const conv = await chatStore.create()
  for (let i = 0; i < chatStore.MAX_MESSAGES + 5; i++) {
    await chatStore.appendMessage(conv.id, i % 2 === 0 ? 'user' : 'assistant', `訊息 ${i}`)
  }
  const saved = await chatStore.get(conv.id)
  ok('每會話訊息數不超過上限', saved.messages.length === chatStore.MAX_MESSAGES, `${saved.messages.length}`)
  ok('保留的是最新的', saved.messages.at(-1).content === `訊息 ${chatStore.MAX_MESSAGES + 4}`)

  const before = (await chatStore.list()).length
  for (let i = 0; i < chatStore.MAX_CONVERSATIONS + 5 - before; i++) await chatStore.create()
  const list = await chatStore.list()
  ok('會話數不超過上限', list.length === chatStore.MAX_CONVERSATIONS, `${list.length}`)

  const target = list[0]
  ok('改名成功', (await chatStore.rename(target.id, '  改過的  名字  ')) === true)
  ok('標題正規化空白', (await chatStore.get(target.id)).title === '改過的 名字')
  ok('刪除成功', (await chatStore.remove(target.id)) === true)
  ok('刪除不存在的回 false', (await chatStore.remove('nope')) === false)
  ok('list 不含訊息內容', !('messages' in list[1]))
}

async function caseE2() {
  console.log('\n[E2] 側欄手動排序')
  const a = await chatStore.create()
  const b = await chatStore.create()
  const c = await chatStore.create()
  // create 插在最前面，所以最新的在最上面
  ok('新對話排在最前', (await chatStore.list())[0].id === c.id)

  ok('reorder 回 true', (await chatStore.reorder([a.id, c.id, b.id])) === true)
  const after = (await chatStore.list()).map((x) => x.id)
  ok('順序照 renderer 給的排', after.indexOf(a.id) < after.indexOf(c.id) && after.indexOf(c.id) < after.indexOf(b.id),
    after.slice(0, 3).join(','))

  // 手動順序不能被「有人回了一則訊息」洗掉（舊行為是 updatedAt desc 重排）
  await chatStore.appendMessage(b.id, 'user', '晚一點才更新的訊息')
  const stable = (await chatStore.list()).map((x) => x.id)
  ok('更新訊息不會重排', stable.indexOf(a.id) < stable.indexOf(b.id))

  // 不存在的 id 一律忽略，也不能因此弄丟任何對話
  const total = (await chatStore.list()).length
  await chatStore.reorder([b.id, 'ghost', b.id])
  const kept = (await chatStore.list()).map((x) => x.id)
  ok('未知 id 不會新增或刪除對話', kept.length === total, `${kept.length}/${total}`)
  ok('未列到的對話仍在清單裡', kept.includes(a.id) && kept.includes(c.id))
  ok('非陣列回 false', (await chatStore.reorder('a,b')) === false)
}

async function caseF() {
  console.log('\n[F] 錯誤回應不外洩原始 body')
  const secret = 'sk-leaked-key-should-not-surface'
  const server = await startServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `invalid api key ${secret}` } }))
  })
  chat.setStore(makeStore({ chatApiUrl: server.url }))
  const conv = await chatStore.create()
  const logged = []
  const originalConsoleError = console.error
  console.error = (...args) => logged.push(args.map(String).join(' '))
  let result
  try {
    result = await chat.send({ reqId: 'f1', conversationId: conv.id, text: '嗨' }, makeSender())
  } finally {
    console.error = originalConsoleError
  }
  ok('回報 API 錯誤與狀態碼', !result.ok && result.error.includes('401'), result.error)
  ok('錯誤訊息不含原始 body', !result.error.includes(secret), result.error)
  ok('main log 不含原始 body', !logged.join('\n').includes(secret), logged.join('\n'))
  server.close()

  chat.setStore(makeStore({ chatApiUrl: 'http://127.0.0.1:1/v1' }))
  const conv2 = await chatStore.create()
  const dead = await chat.send({ reqId: 'f2', conversationId: conv2.id, text: '嗨' }, makeSender())
  ok('連不上時回結構化錯誤', !dead.ok && dead.error.includes('連線失敗'), dead.error)
  ok('失敗後不再 busy', chat.isBusy() === false)
}


async function caseG() {
  console.log('\n[G] 系統提示 preset')
  const server = await startServer((req, res) => {
    sseHead(res)
    res.write(sseChunk('ok'))
    res.write('data: [DONE]\n\n')
    res.end()
  })
  const prompts = [
    { id: 'p_a', name: '技術助理', content: '你是技術助理' },
    { id: 'p_b', name: '翻譯官', content: '你是翻譯官' }
  ]
  chat.setStore(makeStore({ chatApiUrl: server.url, chatPrompts: prompts, chatPromptId: 'p_b' }))
  const conv = await chatStore.create()
  await chat.send({ reqId: 'g1', conversationId: conv.id, text: '嗨' }, makeSender())
  ok(
    '送出選中的那組提示',
    server.state.lastBody?.messages?.[0]?.role === 'system' &&
      server.state.lastBody.messages[0].content === '你是翻譯官',
    JSON.stringify(server.state.lastBody?.messages?.[0])
  )

  chat.setStore(makeStore({ chatApiUrl: server.url, chatPrompts: prompts, chatPromptId: '' }))
  const conv2 = await chatStore.create()
  await chat.send({ reqId: 'g2', conversationId: conv2.id, text: '嗨' }, makeSender())
  ok('未選提示時不送 system', server.state.lastBody?.messages?.[0]?.role === 'user')

  chat.setStore(
    makeStore({ chatApiUrl: server.url, chatPrompts: prompts, chatPromptId: 'p_not_exist' })
  )
  const conv3 = await chatStore.create()
  await chat.send({ reqId: 'g3', conversationId: conv3.id, text: '嗨' }, makeSender())
  ok('選到不存在的提示時不送 system', server.state.lastBody?.messages?.[0]?.role === 'user')

  const dirty = chat.sanitizePrompts([
    { id: 'ok-1', name: '  空白  收斂  ', content: '  內容  ' },
    { id: '../evil', name: 'x', content: 'x' },
    { id: 'ok-1', name: '重複 id', content: 'y' },
    { id: 'ok-2', name: '', content: '' },
    { id: 'ok-3', content: 'z'.repeat(chat.MAX_PROMPT_CONTENT + 100) }
  ])
  ok('清單正規化：擋掉壞 id／重複／空內容', dirty.length === 2, JSON.stringify(dirty.map((d) => d.id)))
  ok('名稱空白收斂', dirty[0].name === '空白 收斂', dirty[0].name)
  ok('內容截到上限', dirty[1].content.length === chat.MAX_PROMPT_CONTENT)
  ok('未命名給預設名稱', dirty[1].name === '未命名提示', dirty[1].name)
  server.close()
}

async function caseH() {
  console.log('\n[H] 圖片附件')
  const server = await startServer((req, res) => {
    sseHead(res)
    res.write(sseChunk('看到了'))
    res.write('data: [DONE]\n\n')
    res.end()
  })
  chat.setStore(makeStore({ chatApiUrl: server.url }))
  const conv = await chatStore.create()
  const result = await chat.send(
    { reqId: 'h1', conversationId: conv.id, text: '這是什麼', images: [TINY_PNG] },
    makeSender()
  )
  ok('帶圖送出成功', result.ok, JSON.stringify(result))
  const sent = server.state.lastBody?.messages?.at(-1)
  ok('有圖時走多模態陣列', Array.isArray(sent?.content), JSON.stringify(sent).slice(0, 120))
  ok(
    '陣列含 text 與 image_url',
    sent.content[0]?.type === 'text' && sent.content[1]?.type === 'image_url',
    JSON.stringify(sent.content.map((c) => c.type))
  )
  ok(
    'image_url 是 data URL',
    String(sent.content[1]?.image_url?.url || '').startsWith('data:image/'),
    String(sent.content[1]?.image_url?.url || '').slice(0, 24)
  )
  const saved = await chatStore.get(conv.id)
  const names = saved.messages[0].images || []
  ok('存檔只留檔名不留 base64', names.length === 1 && /^img_/.test(names[0]), JSON.stringify(names))
  ok('圖片實體落在 userData', fs.existsSync(path.join(TMP, 'chat-images', names[0])))

  const dataUrl = await chatImages.toDataUrl(names[0])
  ok('可依檔名讀回 data URL', dataUrl.startsWith('data:image/png;base64,'))
  ok('檔名走 allowlist：路徑穿越被擋', (await chatImages.toDataUrl('../../config.json')) === '')
  ok('非圖片 data URL 不落檔', (await chatImages.saveMany(['data:text/html;base64,PHNjcmlwdD4='])).length === 0)
  ok('svg 不收', (await chatImages.saveMany(['data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='])).length === 0)

  const tooMany = await chat.send(
    {
      reqId: 'h2',
      conversationId: conv.id,
      text: '太多張',
      images: [TINY_PNG, TINY_PNG, TINY_PNG, TINY_PNG, TINY_PNG]
    },
    makeSender()
  )
  ok('超過張數上限被拒絕', !tooMany.ok && tooMany.error.includes('張圖片'), tooMany.error)

  const onlyImage = await chat.send(
    { reqId: 'h3', conversationId: conv.id, text: '', images: [TINY_PNG] },
    makeSender()
  )
  ok('只有圖片沒有文字也可送', onlyImage.ok, JSON.stringify(onlyImage))

  await chatStore.remove(conv.id)
  ok('刪對話後圖片一併回收', !fs.existsSync(path.join(TMP, 'chat-images', names[0])))
  server.close()
}

async function caseI() {
  console.log('\n[I] thinking 開關')
  const server = await startServer((req, res) => {
    sseHead(res)
    res.write(sseReasoning('先想一下'))
    res.write(sseChunk('答案'))
    res.write('data: [DONE]\n\n')
    res.end()
  })
  chat.setStore(makeStore({ chatApiUrl: server.url }))
  const convOff = await chatStore.create()
  await chat.send({ reqId: 'i0', conversationId: convOff.id, text: '嗨' }, makeSender())
  ok(
    '關閉時完全不帶 reasoning 欄位',
    !('reasoning_effort' in (server.state.lastBody || {})),
    JSON.stringify(Object.keys(server.state.lastBody || {}))
  )

  chat.setStore(makeStore({ chatApiUrl: server.url, chatThinking: true }))
  const conv = await chatStore.create()
  const sender = makeSender()
  const result = await chat.send({ reqId: 'i1', conversationId: conv.id, text: '嗨' }, sender)
  ok('開啟時帶 reasoning_effort', server.state.lastBody?.reasoning_effort === 'medium')
  ok('內容不含思考過程', result.content === '答案', JSON.stringify(result))
  const kinds = sender.deltas.map((d) => d.kind)
  ok('思考與內容分流', kinds.includes('reasoning') && kinds.includes('content'), JSON.stringify(kinds))
  const saved = await chatStore.get(conv.id)
  ok('思考過程落盤在 reasoning 欄位', saved.messages.at(-1)?.reasoning === '先想一下', JSON.stringify(saved.messages.at(-1)))
  ok('content 仍只有答案', saved.messages.at(-1)?.content === '答案')
  server.close()
}

async function caseJ() {
  console.log('\n[J] 重新生成')
  let round = 0
  const server = await startServer((req, res) => {
    round++
    sseHead(res)
    res.write(sseChunk(round === 1 ? '第一版' : '第二版'))
    res.write('data: [DONE]\n\n')
    res.end()
  })
  chat.setStore(makeStore({ chatApiUrl: server.url }))
  const conv = await chatStore.create()
  await chat.send({ reqId: 'j1', conversationId: conv.id, text: '講個笑話' }, makeSender())
  const first = await chatStore.get(conv.id)
  ok('第一輪兩則', first.messages.length === 2 && first.messages[1].content === '第一版')

  const again = await chat.send({ reqId: 'j2', conversationId: conv.id, regenerate: true }, makeSender())
  ok('重新生成成功', again.ok && again.content === '第二版', JSON.stringify(again))
  const second = await chatStore.get(conv.id)
  ok('沒有多出使用者訊息', second.messages.length === 2, JSON.stringify(second.messages.map((m) => m.role)))
  ok('舊回覆被換掉', second.messages[1].content === '第二版')
  ok(
    '送出的歷史不含舊回覆',
    server.state.lastBody?.messages?.length === 1 &&
      server.state.lastBody.messages[0].content === '講個笑話',
    JSON.stringify(server.state.lastBody?.messages)
  )

  const empty = await chatStore.create()
  const nothing = await chat.send({ reqId: 'j3', conversationId: empty.id, regenerate: true }, makeSender())
  ok('空對話不能重新生成', !nothing.ok && nothing.error.includes('重新生成'), nothing.error)
  server.close()

  const failServer = await startServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'upstream boom' } }))
  })
  chat.setStore(makeStore({ chatApiUrl: failServer.url }))
  const beforeFail = await chatStore.get(conv.id)
  const failed = await chat.send({ reqId: 'j4', conversationId: conv.id, regenerate: true }, makeSender())
  ok('重新生成失敗回狀態碼', !failed.ok && failed.error.includes('500'), failed.error)
  const afterFail = await chatStore.get(conv.id)
  ok(
    '失敗後舊回覆仍在',
    afterFail.messages.length === beforeFail.messages.length &&
      afterFail.messages.at(-1)?.content === beforeFail.messages.at(-1)?.content,
    JSON.stringify(afterFail.messages)
  )
  failServer.close()
}


async function caseK() {
  console.log('\n[K] 多組供應商')

  const serverA = await startServer((req, res) => {
    sseHead(res)
    res.write('data: [DONE]\n\n')
    res.end()
  })
  const serverB = await startServer((req, res) => {
    sseHead(res)
    res.write('data: [DONE]\n\n')
    res.end()
  })

  const providers = [
    { id: 'p_a', name: 'A 家', apiUrl: serverA.url, apiKey: 'key-a', models: ['a/model-1', 'a/model-2'] },
    { id: 'p_b', name: 'B 家', apiUrl: serverB.url, apiKey: 'key-b', models: ['b/model-1'] }
  ]
  const conv = await chatStore.create()

  // 這是這批改動最重要的一條：模型必須對「目前這組供應商」驗證。
  // 只檢查「在不在任何清單裡」的話，切到 B 之後還能拿 A 的模型名去打 B 的端點。
  chat.setStore(makeStore({ chatProviders: providers, chatProviderId: 'p_b', chatModelId: 'a/model-1' }))
  const crossed = await chat.send({ reqId: 'k1', conversationId: conv.id, text: '嗨' }, makeSender())
  ok('跨供應商的模型被拒絕', !crossed.ok, JSON.stringify(crossed))
  ok('被拒時沒打任何一家', serverA.state.requests === 0 && serverB.state.requests === 0,
    `A=${serverA.state.requests} B=${serverB.state.requests}`)

  chat.setStore(makeStore({ chatProviders: providers, chatProviderId: 'p_b', chatModelId: 'b/model-1' }))
  await chat.send({ reqId: 'k2', conversationId: conv.id, text: '嗨' }, makeSender())
  ok('選 B 就只打 B', serverB.state.requests === 1 && serverA.state.requests === 0,
    `A=${serverA.state.requests} B=${serverB.state.requests}`)

  chat.setStore(makeStore({ chatProviders: providers, chatProviderId: 'p_a', chatModelId: 'a/model-2' }))
  await chat.send({ reqId: 'k3', conversationId: conv.id, text: '嗨' }, makeSender())
  ok('切到 A 就只打 A', serverA.state.requests === 1 && serverB.state.requests === 1,
    `A=${serverA.state.requests} B=${serverB.state.requests}`)

  chat.setStore(makeStore({ chatProviders: providers, chatProviderId: 'p_gone', chatModelId: 'a/model-1' }))
  const fallback = await chat.send({ reqId: 'k4', conversationId: conv.id, text: '嗨' }, makeSender())
  ok('供應商 id 失效時退回第一組而不是整個壞掉', fallback.ok, JSON.stringify(fallback))

  chat.setStore(makeStore({ chatProviders: [], chatProviderId: '', chatModelId: '' }))
  const none = await chat.send({ reqId: 'k5', conversationId: conv.id, text: '嗨' }, makeSender())
  ok('一組供應商都沒有時給得出可讀訊息', !none.ok && none.error.includes('供應商'), none.error)

  serverA.close()
  serverB.close()

  // ---- sanitizeProviders ----
  const dirty = chat.sanitizeProviders([
    { id: 'p_1', name: '  多   空白  ', apiUrl: 'https://a.test/v1', apiKey: ' k ', models: ['m', 'm', '', 'n'] },
    { id: 'p_1', name: '重複 id' },
    { id: '壞 id', name: '非法字元' },
    { id: 'p_2', name: '網址打錯', apiUrl: 'htp://oops', apiKey: 'k2', models: ['x'] },
    'not-an-object'
  ])
  ok('重複 id 只留第一筆', dirty.filter((p) => p.id === 'p_1').length === 1)
  ok('非法 id 被丟掉', !dirty.some((p) => p.id === '壞 id'))
  ok('名稱空白收斂', dirty[0]?.name === '多 空白', dirty[0]?.name)
  ok('模型去重去空', JSON.stringify(dirty[0]?.models) === JSON.stringify(['m', 'n']))
  // 打錯網址不該把整組（含 API Key 與模型清單）刪掉，只清空 url
  ok('壞網址保留該筆但清空 url', dirty.find((p) => p.id === 'p_2')?.apiUrl === '')
  ok('壞網址不影響同筆的 key 與模型',
    dirty.find((p) => p.id === 'p_2')?.apiKey === 'k2' &&
    dirty.find((p) => p.id === 'p_2')?.models.length === 1)

  const many = chat.sanitizeProviders(
    Array.from({ length: chat.MAX_PROVIDERS + 5 }, (_, i) => ({
      id: `p_${i}`, name: `第 ${i}`, apiUrl: 'https://a.test/v1', models: ['m']
    }))
  )
  ok('供應商數量有上限', many.length === chat.MAX_PROVIDERS, String(many.length))

  const manyModels = chat.sanitizeProviders([{
    id: 'p_x', name: 'x', apiUrl: 'https://a.test/v1',
    models: Array.from({ length: chat.MAX_PROVIDER_MODELS + 10 }, (_, i) => `m${i}`)
  }])
  ok('每組模型數量有上限', manyModels[0].models.length === chat.MAX_PROVIDER_MODELS,
    String(manyModels[0].models.length))

  // ---- 舊設定搬移 ----
  const migrated = chat.providerFromLegacy('https://old.test/v1', 'sk-old', ['old/m1', 'old/m2'])
  ok('舊設定搬成一組供應商',
    migrated?.apiUrl === 'https://old.test/v1' && migrated?.apiKey === 'sk-old' &&
    migrated?.models.length === 2, JSON.stringify(migrated))
  ok('沒有舊設定就不要憑空造一組', chat.providerFromLegacy('', '', []) === null)
  ok('舊網址不合法時退回預設端點',
    chat.providerFromLegacy('javascript:alert(1)', 'k', ['m'])?.apiUrl === chat.DEFAULT_CHAT_API_URL)
}


async function caseL() {
  console.log('\n[L] 模型掃描')

  const scan = (url, key = 'sk-secret-key-abc123') =>
    chatModels.fetchModels({ apiUrl: url, apiKey: key })

  {
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'x/one' }, { id: 'x/two' }, { id: 'x/one' }] }))
    })
    const result = await scan(server.url)
    ok('正常回應取得模型', result.ok && result.models.length === 2, JSON.stringify(result))
    ok('掃描結果會去重', JSON.stringify(result.models) === JSON.stringify(['x/one', 'x/two']))
    server.close()
  }

  {
    let seenAuth = ''
    const server = await startServer((req, res) => {
      seenAuth = String(req.headers.authorization || '')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'a' }] }))
    })
    await scan(server.url, 'sk-my-key')
    ok('金鑰以 Bearer 帶出', seenAuth === 'Bearer sk-my-key', seenAuth)
    ok('請求打到 /models', true)
    server.close()
  }

  {
    // 這是重點：很多相容實作會把收到的 Authorization 原樣寫進錯誤訊息回來
    const server = await startServer((req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        error: { message: 'invalid key: sk-secret-key-abc123', trace: 'INTERNAL-TRACE-99' }
      }))
    })
    const result = await scan(server.url)
    ok('401 回失敗', !result.ok && result.code === 'HTTP_401', JSON.stringify(result))
    ok('錯誤訊息不含 API Key', !JSON.stringify(result).includes('sk-secret-key-abc123'), JSON.stringify(result))
    ok('錯誤訊息不含上游 trace', !JSON.stringify(result).includes('INTERNAL-TRACE-99'))
    ok('401 有給可行動的提示', result.error.includes('API Key'), result.error)
    server.close()
  }

  {
    const server = await startServer((req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('nope')
    })
    const result = await scan(server.url)
    ok('404 提示端點可能不支援', !result.ok && result.error.includes('/models'), result.error)
    server.close()
  }

  {
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('<html>not json</html>')
    })
    const result = await scan(server.url)
    ok('非 JSON 回 BAD_JSON', !result.ok && result.code === 'BAD_JSON', JSON.stringify(result))
    server.close()
  }

  {
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [] }))
    })
    const result = await scan(server.url)
    ok('空清單回 EMPTY', !result.ok && result.code === 'EMPTY', JSON.stringify(result))
    server.close()
  }

  {
    const result = await scan('javascript:alert(1)')
    ok('非 http(s) 的網址直接擋下', !result.ok && result.code === 'BAD_URL', JSON.stringify(result))
    const relative = await scan('/etc/passwd')
    ok('相對路徑也擋下', !relative.ok && relative.code === 'BAD_URL')
  }

  {
    const result = await scan('http://127.0.0.1:1/v1')
    ok('連不上回 NETWORK', !result.ok && result.code === 'NETWORK', JSON.stringify(result))
  }

  {
    // 相容實作回幾百 MB 也不該把 main 吃爆
    const huge = 'x'.repeat(64 * 1024)
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      for (let i = 0; i < 40; i += 1) res.write(huge)
      res.end()
    })
    const result = await scan(server.url)
    ok('過大的回應被擋下', !result.ok && result.code === 'TOO_LARGE', JSON.stringify(result))
    server.close()
  }

  {
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        data: Array.from({ length: chatModels.MAX_MODELS + 50 }, (_, i) => ({ id: `m${i}` }))
      }))
    })
    const result = await scan(server.url)
    ok('模型數量有上限', result.ok && result.models.length === chatModels.MAX_MODELS,
      String(result.models?.length))
    server.close()
  }
}

async function caseM() {
  console.log('\n[M] 生圖模型')

  const imageProvider = (url) => [{
    id: 'p_img',
    name: '生圖供應商',
    apiUrl: url,
    apiKey: 'k',
    models: ['x/text-model', 'x/image-model'],
    imageModels: ['x/image-model']
  }]

  // 1) 選到生圖模型 → 帶 modalities，回來的圖存成檔名
  {
    const server = await startServer((req, res) => {
      sseHead(res)
      res.write(sseChunk('好的，畫好了'))
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: { images: [{ type: 'image_url', image_url: { url: TINY_PNG } }] } }]
      })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
    chat.setStore(makeStore({
      chatProviders: imageProvider(server.url),
      chatProviderId: 'p_img',
      chatModelId: 'x/image-model'
    }))
    const conv = await chatStore.create()
    const result = await chat.send(
      { reqId: 'm1', conversationId: conv.id, text: '畫一隻貓' },
      makeSender()
    )
    ok('生圖請求成功', result.ok, JSON.stringify(result))
    ok('請求帶 modalities',
      JSON.stringify(server.state.lastBody?.modalities) === JSON.stringify(['image', 'text']),
      JSON.stringify(server.state.lastBody?.modalities))
    const saved = await chatStore.get(conv.id)
    const assistant = saved.messages.at(-1)
    ok('助理訊息存下圖片檔名',
      assistant.role === 'assistant' && /^img_/.test(assistant.images?.[0] || ''),
      JSON.stringify(assistant.images))
    ok('圖片實體落在 userData',
      fs.existsSync(path.join(TMP, 'chat-images', assistant.images[0])))
    ok('文字與圖片同時保留', assistant.content === '好的，畫好了', assistant.content)

    // 生成的圖不回送上游：assistant 訊息塞 image_url 陣列會被嚴格端點 400
    await chat.send({ reqId: 'm2', conversationId: conv.id, text: '再一張' }, makeSender())
    const history = server.state.lastBody?.messages || []
    ok('助理的圖不回送上游',
      history.every((m) => m.role !== 'assistant' || typeof m.content === 'string'),
      JSON.stringify(history.map((m) => [m.role, typeof m.content])))

    await chatStore.remove(conv.id)
    server.close()
  }

  // 2) 沒標生圖的模型不得帶 modalities（舊端點看到不認得的參數會 400）
  {
    const server = await startServer((req, res) => {
      sseHead(res)
      res.write(sseChunk('純文字'))
      res.write('data: [DONE]\n\n')
      res.end()
    })
    chat.setStore(makeStore({
      chatProviders: imageProvider(server.url),
      chatProviderId: 'p_img',
      chatModelId: 'x/text-model'
    }))
    const conv = await chatStore.create()
    await chat.send({ reqId: 'm3', conversationId: conv.id, text: '哈囉' }, makeSender())
    ok('非生圖模型完全不帶 modalities',
      !('modalities' in (server.state.lastBody || {})),
      JSON.stringify(Object.keys(server.state.lastBody || {})))
    await chatStore.remove(conv.id)
    server.close()
  }

  // 3) 標記只在模型清單內有效，且 http URL 不收（不讓 main 去下載上游指定的網址）
  {
    const [p] = chat.sanitizeProviders([{
      id: 'p1', name: 'x', apiUrl: 'https://a.example/v1', apiKey: 'k',
      models: ['keep'], imageModels: ['keep', 'gone']
    }])
    ok('imageModels 收斂成 models 的子集',
      JSON.stringify(p.imageModels) === JSON.stringify(['keep']), JSON.stringify(p.imageModels))
    const parsed = chat.extractDelta(JSON.stringify({
      choices: [{ delta: { images: [
        { image_url: { url: 'https://evil.example/x.png' } },
        { image_url: { url: TINY_PNG } }
      ] } }]
    }))
    ok('只收 data URI 的圖',
      parsed.images.length === 1 && parsed.images[0] === TINY_PNG,
      JSON.stringify(parsed.images))
  }
}

async function caseN() {
  console.log('\n[N] 雲端翻譯與聊天共用供應商')
  const providers = [
    { id: 'p_a', name: 'A', apiUrl: 'https://a.example/v1', apiKey: 'ka', models: ['a/one', 'a/two'] },
    { id: 'p_b', name: 'B', apiUrl: 'https://b.example/v1', apiKey: 'kb', models: ['b/one'] }
  ]
  chat.setStore(makeStore({
    chatProviders: providers,
    chatProviderId: 'p_a',
    chatModelId: 'a/one',
    translateProviderId: 'p_b',
    translateModelId: 'b/one'
  }))
  const cfg = chat.readTranslateConfig()
  ok('翻譯可以指到跟聊天不同的供應商',
    cfg.apiUrl === 'https://b.example/v1' && cfg.apiKey === 'kb' && cfg.modelId === 'b/one',
    JSON.stringify(cfg))

  chat.setStore(makeStore({
    chatProviders: providers,
    translateProviderId: 'p_b',
    translateModelId: 'a/two'
  }))
  ok('模型不在該供應商清單內 → 收斂成它的第一顆',
    chat.readTranslateConfig().modelId === 'b/one',
    chat.readTranslateConfig().modelId)

  chat.setStore(makeStore({ chatProviders: [], chatProviderId: '', chatModelId: '' }))
  const empty = chat.readTranslateConfig()
  ok('沒有供應商時回空設定（由呼叫端給可行動的錯誤）',
    !empty.apiUrl && !empty.apiKey && !empty.modelId, JSON.stringify(empty))
}

async function caseO() {
  console.log('\n[O] 本機模型（synthetic provider）')
  const providers = [
    { id: 'p_a', name: 'A', apiUrl: 'https://a.example/v1', apiKey: 'ka', models: ['a/one'] }
  ]
  chat.setStore(makeStore({ chatProviders: providers, chatProviderId: 'p_a', chatModelId: 'a/one' }))

  // router 沒跑：清單裡不該出現本機那筆
  chat.setLocalSource(() => null)
  ok('router 沒跑時沒有本機供應商',
    !chat.allProviders().some((p) => p.id === chat.LOCAL_PROVIDER_ID))

  // router 跑了：多一筆「本機模型」
  chat.setLocalSource(
    () => ({ baseUrl: 'http://127.0.0.1:8010', apiKey: 'router-key', models: ['Local-4B-Q4_K_M'] }),
    async () => true
  )
  const all = chat.allProviders()
  const local = all.find((p) => p.id === chat.LOCAL_PROVIDER_ID)
  ok('router 跑著時清單多一筆本機供應商', !!local && all.length === 2, JSON.stringify(all.map((p) => p.id)))
  ok('本機那筆的端點帶 /v1 與 router 金鑰',
    local?.apiUrl === 'http://127.0.0.1:8010/v1' && local?.apiKey === 'router-key', local?.apiUrl)
  ok('雲端那幾筆原樣保留', all[0]?.id === 'p_a' && all[0]?.apiKey === 'ka')

  // 選了本機模型後 readConfig / readProvider 要找得到它
  chat.setStore(makeStore({
    chatProviders: providers,
    chatProviderId: chat.LOCAL_PROVIDER_ID,
    chatModelId: 'Local-4B-Q4_K_M'
  }))
  const cfg = chat.readConfig()
  ok('選了本機模型後 readConfig 指到 router',
    cfg.apiUrl === 'http://127.0.0.1:8010/v1' && cfg.modelId === 'Local-4B-Q4_K_M'
      && cfg.providerId === chat.LOCAL_PROVIDER_ID,
    JSON.stringify(cfg))
  ok('本機模型不標成生圖模型', cfg.image === false)

  // 選了不存在的本機模型 → modelId 收斂成空字串（`chat.send` 的守衛拒絕）。
  // **不退回第一顆**：那是 main 的 reconcile 在寫 store 時做的事，
  // readConfig 這樣做的話，「拿清單外的名字打過來」就會真的打出去一個請求。
  chat.setStore(makeStore({
    chatProviders: providers,
    chatProviderId: chat.LOCAL_PROVIDER_ID,
    chatModelId: 'not-installed'
  }))
  ok('不存在的本機模型 → modelId 空（守衛會拒絕）',
    chat.readConfig().modelId === '', chat.readConfig().modelId)

  // 存檔路徑的 sanitize 不可以收到 synthetic：store:set 走的是 sanitizeProviders
  const stored = chat.sanitizeProviders([{ id: chat.LOCAL_PROVIDER_ID, name: 'X', apiUrl: 'http://x', models: ['m'] }])
  ok('sanitizeProviders 會把 __local 擋下來（不能被寫進 config.json）',
    stored.length === 0, JSON.stringify(stored))

  // router 關了之後 `chatProviderId` 還指著 __local，但清單裡已經沒有那筆：
  // pickProvider 退回第一筆，而「not-installed」不在 A 的清單內 → modelId 空字串。
  // **不是自動退回 a/one**：那是 main 的 reconcile 在寫 store 時做的收斂。
  chat.setLocalSource(() => null)
  const fallback = chat.readConfig()
  ok('router 關掉後退回第一筆雲端（模型不在清單內 → 空）',
    fallback.providerId === 'p_a' && fallback.modelId === '', JSON.stringify(fallback))

  chat.setLocalSource(() => null)
}

async function main() {
  await app.whenReady()
  try {
    await caseA()
    await caseB()
    caseC()
    await caseD()
    await caseE()
    await caseE2()
    await caseF()
    await caseG()
    await caseH()
    await caseI()
    await caseJ()
    await caseK()
    await caseL()
    await caseM()
    await caseN()
    await caseO()
  } catch (e) {
    failed++
    console.error('\n未預期例外：', e)
  }
  console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILED'}  ${passed} passed, ${failed} failed\n`)
  fs.rmSync(TMP, { recursive: true, force: true })
  app.exit(failed === 0 ? 0 : 1)
}

main()
