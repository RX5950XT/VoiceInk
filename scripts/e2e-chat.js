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

/** 假設定 store */
function makeStore(overrides = {}) {
  const data = {
    chatApiUrl: '',
    chatApiKey: 'test-key',
    chatModels: ['test/model-a', 'test/model-b'],
    chatModelId: 'test/model-a',
    chatPrompts: [],
    chatPromptId: '',
    chatThinking: false,
    ...overrides
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
}

async function main() {
  await app.whenReady()
  try {
    await caseA()
    await caseB()
    caseC()
    await caseD()
    await caseE()
    await caseF()
    await caseG()
    await caseH()
    await caseI()
    await caseJ()
  } catch (e) {
    failed++
    console.error('\n未預期例外：', e)
  }
  console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILED'}  ${passed} passed, ${failed} failed\n`)
  fs.rmSync(TMP, { recursive: true, force: true })
  app.exit(failed === 0 ? 0 : 1)
}

main()
