'use strict'

/**
 * 聊天設定（多組供應商）打包版驗收：`node scripts/e2e-chat-cdp.js`
 *
 * 全程只動草稿、**不按儲存**，所以不會改到使用者的真實設定。
 * 這點很重要：這支會建立／改名／刪除供應商，真的存下去等於幫使用者亂改設定。
 */

const { spawn, execFileSync } = require('child_process')
const path = require('path')
const { tempDir, removeTree } = require('./lib/test-temp')
const os = require('os')
const fs = require('fs')
const http = require('http')

const PORT = 9245
// Windows 偶爾會有別的東西鎖住 dist/win-unpacked（打包失敗、防毒掃描中），
// 這時可以打包到別的資料夾再用 VOICEINK_EXE 指過去，測試不必等鎖放掉
const EXE = process.env.VOICEINK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
// 暫存 user-data-dir：使用者開著的正式實例佔 single-instance lock，
// 沒有自己的資料夾會被擋掉（second-instance 轉交後退出，CDP 等不到主視窗）
const USER_DATA_DIR = tempDir('voiceink-cdp-')
const DEFAULT_CHAT_MODEL = 'google/gemini-3-flash-preview'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let body = ''
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (error) { reject(error) }
      })
    }).on('error', reject)
  })
}

class Cdp {
  constructor(url) {
    this.url = url
    this.id = 0
    this.pending = new Map()
    this.exceptions = []
  }

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
    const result = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    }
    return result.result?.value
  }

  close() {
    try { this.ws.close() } catch {}
  }
}

async function waitFor(action, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const result = await action()
      if (result) return result
    } catch (error) {
      lastError = error
    }
    await sleep(300)
  }
  throw new Error(`等待逾時：${label}${lastError ? ` (${lastError.message})` : ''}`)
}

/**
 * 慢慢吐字的 chat completions：約 2.4 秒才講完，兩個對話才有機會真的同時跑
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {object[]} bodies
 */
function streamSlowReply(req, res, bodies) {
  let raw = ''
  req.on('data', (chunk) => { raw += chunk })
  req.on('end', () => {
    let parsed = null
    try { parsed = JSON.parse(raw) } catch {}
    // AI 取標題那一發是非串流的，另外記，不混進對話請求的計數
    if (parsed?.stream === false) {
      bodies.titles = (bodies.titles || 0) + 1
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: '「CDP 自動標題」' } }] }))
      return
    }
    bodies.push(parsed)
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    let n = 0
    const timer = setInterval(() => {
      n += 1
      if (n > 12 || res.writableEnded) {
        clearInterval(timer)
        if (!res.writableEnded) res.end('data: [DONE]\n\n')
        return
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `字${n}` } }] })}\n\n`)
    }, 200)
  })
}

/** 假的 OpenAI 相容 /models 端點：讓掃描完全可控，不打真實供應商 */
function startFakeModels() {
  const models = ['fake/alpha', 'fake/beta', 'fake/gamma-large', 'fake/delta']
  const bodies = []
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (String(req.url || '').endsWith('/chat/completions')) {
        streamSlowReply(req, res, bodies)
        return
      }
      if (!String(req.url || '').endsWith('/models')) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: models.map((id) => ({ id })) }))
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, models, bodies, url: `http://127.0.0.1:${server.address().port}/v1` })
    })
  })
}

/**
 * 真的在 UI 上點：兩個對話同時回應、側欄狀態、資料夾選單、對話參數。
 * 跑在暫存 user-data-dir，種一組指到假端點的供應商不會碰到使用者設定；建的東西最後都刪掉。
 */
async function checkConcurrentUi(cdp, fake, check) {
  console.log('\n併發對話、側欄狀態、資料夾、對話參數')
  const made = await cdp.eval(`(async () => {
    const api = window.electronAPI
    await api.store.set('chatProviders', [{ id: 'p_cdp', name: 'CDP 串流', apiUrl: ${JSON.stringify(fake.url)},
      apiKey: 'k', models: ['fake/alpha'], imageModels: [] }])
    await api.store.set('chatProviderId', 'p_cdp')
    await api.store.set('chatModelId', 'fake/alpha')
    const a = await api.chat.create()
    await api.chat.rename(a.id, 'CDP-併發甲')
    const b = await api.chat.create()
    await api.chat.rename(b.id, 'CDP-併發乙')
    return { a: a.id, b: b.id }
  })()`)
  const row = (id) => `#chatList .chat-list-item[data-id="${id}"]`
  const statusOf = (id) => cdp.eval(`document.querySelector('${row(id)} .chat-status')?.dataset.state || ''`)
  const openRow = async (id) => {
    await cdp.eval(`document.querySelector('${row(id)} .chat-list-open').click()`)
    await waitFor(() => cdp.eval(`!!document.querySelector('${row(id)}.active')`), 10_000, `切到 ${id}`)
  }
  const sendText = (text) => cdp.eval(`(() => {
    const input = document.getElementById('chatInput')
    input.value = ${JSON.stringify(text)}
    document.getElementById('chatSendBtn').click()
    return true
  })()`)
  let folderId = ''
  let autoConv = ''
  const extraFolders = []
  try {
    await cdp.eval(`document.querySelector('.nav-tab[data-page="usage"]').click()`)
    await cdp.eval(`document.querySelector('.nav-tab[data-page="chat"]').click()`)
    await waitFor(() => cdp.eval(`!!document.querySelector('${row(made.b)}')`), 15_000, '側欄出現測試對話')
    const before = fake.bodies.length

    await openRow(made.a)
    await sendText('甲的問題')
    await waitFor(async () => (await statusOf(made.a)) === 'running', 5_000, '甲進入回應中')
    await openRow(made.b)
    await sendText('乙的問題')
    await waitFor(() => fake.bodies.length >= before + 2, 5_000, '兩個請求都送到上游')
    check('切走之後甲仍在回應中', (await statusOf(made.a)) === 'running')
    check('乙也在回應中（兩條同時跑）', (await statusOf(made.b)) === 'running')
    check('送出鈕只看目前對話：乙回應中＝停止',
      (await cdp.eval(`document.getElementById('chatSendBtn').textContent`)) === '停止')

    await waitFor(async () => !(await statusOf(made.b)), 15_000, '乙回應結束')
    await waitFor(async () => (await statusOf(made.a)) === 'done', 15_000, '甲在背景完成')
    check('背景跑完的甲標成已完成', (await statusOf(made.a)) === 'done')
    const bView = await cdp.eval(`(() => {
      const last = [...document.querySelectorAll('#chatMessages .chat-msg-assistant')].at(-1)
      return { text: last?.textContent || '', meta: last?.querySelector('.chat-msg-meta')?.textContent || '' }
    })()`)
    check('乙的回覆完整畫出來', bView.text.includes('字12'), bView.text)
    check('回覆下面標出模型與耗時', bView.meta.includes('fake/alpha') && bView.meta.includes('秒'), bView.meta)

    await openRow(made.a)
    check('打開甲之後已完成標記消失', (await statusOf(made.a)) === '')
    const aText = await cdp.eval(`[...document.querySelectorAll('#chatMessages .chat-msg-assistant')].at(-1)?.textContent || ''`)
    check('甲在背景收到的回覆完整', aText.includes('字12'), aText)

    // 資料夾：側欄按鈕開得出命名彈窗 → 從「⋯」選單把甲搬進去 → 收合
    // 命名彈窗靠 `close` 事件回結果，而視窗在背景時 Chromium 會延後派發它（見 e2e-app-dialog-cdp.js
    // 要叫到最前面的原因），所以這裡只驗「開得出來」，資料夾本身走 API 建
    await cdp.eval(`document.getElementById('chatNewFolderBtn').click()`)
    const asked = await waitFor(() => cdp.eval(`(() => {
      const dialog = [...document.querySelectorAll('dialog.app-dialog[open]')].find((d) => d.getAttribute('aria-label') === '新資料夾')
      if (!dialog?.querySelector('input')) return false
      dialog.close('')
      return true
    })()`), 5_000, '新資料夾輸入框')
    check('側欄按鈕開出命名彈窗', asked === true)
    await cdp.eval(`(async () => {
      await window.electronAPI.chat.createFolder('CDP-資料夾')
      document.querySelector('.nav-tab[data-page="usage"]').click()
      document.querySelector('.nav-tab[data-page="chat"]').click()
    })()`)
    folderId = await waitFor(() => cdp.eval(`(() => {
      const head = [...document.querySelectorAll('#chatList .chat-folder')]
        .find((f) => f.querySelector('.chat-folder-name')?.textContent === 'CDP-資料夾')
      return head?.dataset.folderId || ''
    })()`), 5_000, '資料夾出現在側欄')
    check('資料夾出現在側欄', !!folderId)

    await cdp.eval(`document.querySelector('${row(made.a)} [data-action="more"]').click()`)
    await waitFor(() => cdp.eval(`(() => {
      const item = [...document.querySelectorAll('.chat-menu .chat-menu-item')].find((b) => b.textContent === 'CDP-資料夾')
      item?.click()
      return !!item
    })()`), 5_000, '更多選單出現資料夾')
    await waitFor(() => cdp.eval(
      `!!document.querySelector('#chatList .chat-folder[data-folder-id="${folderId}"] ${row(made.a).replace('#chatList ', '')}')`
    ), 5_000, '甲搬進資料夾')
    check('從選單搬進資料夾', (await cdp.eval(`(async () => (await window.electronAPI.chat.get('${made.a}')).folderId)()`)) === folderId)

    await cdp.eval(`document.querySelector('#chatList .chat-folder[data-folder-id="${folderId}"] .chat-folder-toggle').click()`)
    const collapsed = await waitFor(() => cdp.eval(`(() => {
      const f = document.querySelector('#chatList .chat-folder[data-folder-id="${folderId}"]')
      const body = f?.querySelector('.chat-folder-body')
      return f?.classList.contains('is-collapsed') ? { height: body.offsetHeight, rows: f.querySelectorAll('.chat-list-item').length } : null
    })()`), 5_000, '資料夾收合')
    check('收合後裡面的列不佔高度', collapsed.height === 0 && collapsed.rows === 0, JSON.stringify(collapsed))
    await cdp.eval(`document.querySelector('#chatList .chat-folder[data-folder-id="${folderId}"] .chat-folder-toggle').click()`)
    await waitFor(() => cdp.eval(`!!document.querySelector('${row(made.a)}')`), 5_000, '資料夾展開')

    // 資料夾拖曳排序：把後建的乙拖到甲上面
    const folderB = await cdp.eval(`(async () => {
      const f = await window.electronAPI.chat.createFolder('CDP-資料夾乙')
      document.querySelector('.nav-tab[data-page="usage"]').click()
      document.querySelector('.nav-tab[data-page="chat"]').click()
      return f.id
    })()`)
    extraFolders.push(folderB)
    await waitFor(() => cdp.eval(`!!document.querySelector('#chatList .chat-folder[data-folder-id="${folderB}"]')`), 5_000, '資料夾乙出現')
    await cdp.eval(`(() => {
      const src = document.querySelector('#chatList .chat-folder[data-folder-id="${folderB}"] .chat-folder-name')
      const dst = document.querySelector('#chatList .chat-folder[data-folder-id="${folderId}"] .chat-folder-head')
      const from = src.getBoundingClientRect()
      const to = dst.getBoundingClientRect()
      const opts = { bubbles: true, button: 0, pointerId: 2 }
      src.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: from.left + 5, clientY: from.top + 5 }))
      window.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: to.left + 20, clientY: to.top + 4 }))
      window.dispatchEvent(new PointerEvent('pointerup', opts))
      return true
    })()`)
    const folderOrder = await waitFor(async () => {
      const ids = await cdp.eval(`(async () => (await window.electronAPI.chat.folders()).map((f) => f.id))()`)
      return ids.indexOf(folderB) < ids.indexOf(folderId) ? ids : null
    }, 5_000, '資料夾順序落盤').catch(() => null)
    check('拖曳資料夾會改順序並寫回 main', Array.isArray(folderOrder), '順序沒變')
    check('畫面上的資料夾順序跟著變', await cdp.eval(`(() => {
      const ids = [...document.querySelectorAll('#chatList .chat-folder')].map((f) => f.dataset.folderId)
      return ids.indexOf('${folderB}') < ids.indexOf('${folderId}')
    })()`))

    // 對話參數：勾 Temperature 設 0.4 → 套用 → 送出時真的帶上
    await openRow(made.a)
    await cdp.eval(`document.getElementById('chatParamsBtn').click()`)
    await waitFor(() => cdp.eval(`!!document.querySelector('.chat-params-dialog[open]')`), 5_000, '參數彈窗')
    await cdp.eval(`(() => {
      const check = document.getElementById('chatParam-temperature')
      check.click()
      const number = check.closest('.chat-param-row').querySelector('.chat-param-number')
      number.value = '0.4'
      number.dispatchEvent(new Event('input', { bubbles: true }))
      document.querySelector('.chat-params-dialog .dialog-actions .btn-primary').click()
      return true
    })()`)
    await waitFor(() => cdp.eval(
      `(async () => (await window.electronAPI.chat.get('${made.a}')).params?.temperature === 0.4)()`
    ), 5_000, '參數落盤')
    check('參數鈕顯示已設定的數量',
      (await cdp.eval(`document.getElementById('chatParamsBtn').textContent.trim()`)) === '參數 1')
    const sentBefore = fake.bodies.length
    await sendText('帶參數')
    await waitFor(() => fake.bodies.length > sentBefore, 5_000, '帶參數的請求')
    const body = fake.bodies.at(-1)
    check('送出的請求帶 temperature、沒勾的不送', body?.temperature === 0.4 && !('top_k' in body), JSON.stringify(body))
    await waitFor(async () => !(await statusOf(made.a)), 15_000, '帶參數的回覆結束')

    // AI 自動取標題：沒改過名的新對話，第一輪回覆後側欄換成模型取的標題
    await cdp.eval(`document.getElementById('chatNewBtn').click()`)
    autoConv = await waitFor(() => cdp.eval(`(() => {
      const row = document.querySelector('#chatList .chat-list-item.active')
      return row && !['${made.a}', '${made.b}'].includes(row.dataset.id) ? row.dataset.id : ''
    })()`), 5_000, '新對話')
    await sendText('幫我想一個標題')
    const autoTitle = await waitFor(() => cdp.eval(
      `document.querySelector('${row('__ID__')} .chat-list-title')?.textContent === 'CDP 自動標題'`.replace('__ID__', autoConv)
    ), 20_000, '側欄出現 AI 標題').catch(() => false)
    check('第一輪回覆後側欄換成 AI 取的標題', autoTitle === true)
    check('取標題只打一次', fake.bodies.titles === 1, String(fake.bodies.titles))
  } finally {
    await cdp.eval(`(async () => {
      const api = window.electronAPI
      await api.chat.delete('${made.a}')
      await api.chat.delete('${made.b}')
      if ('${folderId}') await api.chat.deleteFolder('${folderId}')
      if ('${autoConv}') await api.chat.delete('${autoConv}')
      for (const id of ${JSON.stringify(extraFolders)}) await api.chat.deleteFolder(id)
    })()`)
  }
}

async function main() {
  const fake = await startFakeModels()
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA_DIR}`], { stdio: ['ignore', 'pipe', 'pipe'] })
  let cdp = null
  let assertions = 0
  const failures = []

  const pass = (label) => { assertions += 1; console.log(`  PASS  ${label}`) }
  const fail = (label) => { failures.push(label); console.log(`  FAIL  ${label}`) }
  const check = (label, condition, detail = '') => {
    if (condition) pass(label)
    else fail(`${label}${detail ? `：${detail}` : ''}`)
  }

  try {
    const target = await waitFor(async () => {
      const list = await getJson(`http://127.0.0.1:${PORT}/json/list`)
      // 只認主視窗：語音輸入開著時還會有一扇指示器視窗（dictation-hud.html）
      return list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl
        && /index\.html/i.test(item.url))
    }, 40_000, '偵錯目標')

    cdp = new Cdp(target.webSocketDebuggerUrl)
    await cdp.connect()
    await waitFor(
      () => cdp.eval(`document.querySelectorAll('.nav-tab').length >= 7`),
      30_000, 'nav 就緒'
    )

    console.log('\n設定頁：聊天分區')

    // 暫存 user-data-dir 是全新環境，`chatProviders` 本來是空的（供應商下拉會沒有選項）：
    // 先種一組，後面的欄位／模型列才有東西可測。
    await cdp.eval(`window.electronAPI.store.set('chatProviders', [
      { id: 'e2e_prov', name: 'E2E 測試', apiUrl: 'https://example.invalid/v1', apiKey: 'k', models: ['m-one', 'm-two'] }
    ])`)

    // 分兩段等，而且各自只點一次。
    // 把兩次點擊塞進同一個 waitFor 重試會排隊觸發多次非同步 loadChatSettings()，
    // 晚到的那次 replaceChildren 會把剛新增的列與焦點洗掉，測試就時好時壞。
    await waitFor(async () => {
      await cdp.eval(`document.querySelector('.nav-tab[data-page="settings"]').click()`)
      return cdp.eval(`document.getElementById('page-settings')?.classList.contains('active') === true`)
    }, 15_000, '切到設定頁')

    await cdp.eval(`document.querySelector('.settings-nav-item[data-section="cloud"]').click()`)
    await waitFor(
      () => cdp.eval(`document.getElementById('set-cloud')?.classList.contains('active') === true`),
      15_000, '切到聊天設定分區'
    )
    // 設定表單是非同步載入的，等它安定後再開始操作，避免重繪洗掉待測狀態
    await sleep(800)
    pass('可切到聊天設定分區')

    const initial = await waitFor(async () => {
      const snapshot = await cdp.eval(`(() => {
        const select = document.getElementById('chatProviderSelect')
        return {
          providers: [...(select?.options || [])].map((o) => o.textContent),
          name: document.getElementById('chatProviderNameInput')?.value || '',
          apiUrl: document.getElementById('chatApiUrlInput')?.value || '',
          rows: document.querySelectorAll('#chatModelList input[type="text"]').length,
          placeholder: document.querySelector('#chatModelList input[type="text"]')?.placeholder || ''
        }
      })()`)
      return snapshot.providers.length ? snapshot : null
    }, 15_000, '供應商清單載入')

    check('搬移來的供應商有出現在下拉', initial.providers.length >= 1, initial.providers.join(', '))
    check('名稱欄位有帶入', Boolean(initial.name), initial.name)
    check('API URL 有帶入', /^https?:\/\//.test(initial.apiUrl), initial.apiUrl)
    check('模型清單有列出', initial.rows >= 1, `rows=${initial.rows}`)

    // 這是使用者回報的 UI bug：空列 placeholder 複誦預設模型名，看起來像重複項
    check('模型列 placeholder 不再複誦預設模型',
      initial.placeholder !== DEFAULT_CHAT_MODEL && initial.placeholder.length > 0,
      `placeholder=${initial.placeholder}`)

    console.log('\n新增模型列')

    const added = await cdp.eval(`(() => {
      const before = document.querySelectorAll('#chatModelList input[type="text"]').length
      document.getElementById('chatAddModelBtn').click()
      const inputs = [...document.querySelectorAll('#chatModelList input[type="text"]')]
      return {
        grew: inputs.length === before + 1,
        lastIsEmpty: inputs.at(-1).value === '',
        focused: document.activeElement === inputs.at(-1),
        placeholder: inputs.at(-1).placeholder
      }
    })()`)
    check('按下新增會多一列', added.grew)
    check('新列是空的', added.lastIsEmpty)
    check('新列自動 focus', added.focused)
    check('新列 placeholder 是中性字樣', added.placeholder !== DEFAULT_CHAT_MODEL, added.placeholder)

    console.log('\n供應商增刪與草稿保留')

    const afterAdd = await cdp.eval(`(() => {
      const select = document.getElementById('chatProviderSelect')
      const before = select.options.length
      document.getElementById('chatAddProviderBtn').click()
      const nameInput = document.getElementById('chatProviderNameInput')
      return {
        grew: select.options.length === before + 1,
        selectedIsNew: select.value === select.options[select.options.length - 1].value,
        focused: document.activeElement === nameInput,
        name: nameInput.value,
        rows: document.querySelectorAll('#chatModelList input[type="text"]').length
      }
    })()`)
    check('新增供應商後下拉多一項', afterAdd.grew)
    check('新增後自動選中新的那組', afterAdd.selectedIsNew)
    check('名稱欄位自動 focus', afterAdd.focused)
    check('新供應商的模型清單是空的', afterAdd.rows === 0, `rows=${afterAdd.rows}`)

    const renamed = await cdp.eval(`(() => {
      const nameInput = document.getElementById('chatProviderNameInput')
      nameInput.value = '測試用供應商'
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
      const select = document.getElementById('chatProviderSelect')
      return select.options[select.selectedIndex].textContent
    })()`)
    check('改名即時反映到下拉', renamed === '測試用供應商', renamed)

    // 草稿保留：在新供應商填東西 → 切走 → 切回來，內容要還在
    const draftKept = await cdp.eval(`(() => {
      const select = document.getElementById('chatProviderSelect')
      const newId = select.value
      const firstId = select.options[0].value
      document.getElementById('chatApiUrlInput').value = 'https://draft.test/v1'
      document.getElementById('chatAddModelBtn').click()
      const input = [...document.querySelectorAll('#chatModelList input[type="text"]')].at(-1)
      input.value = 'draft/model-x'

      select.value = firstId
      select.dispatchEvent(new Event('change', { bubbles: true }))
      const switchedUrl = document.getElementById('chatApiUrlInput').value

      select.value = newId
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return {
        switchedAway: switchedUrl !== 'https://draft.test/v1',
        url: document.getElementById('chatApiUrlInput').value,
        models: [...document.querySelectorAll('#chatModelList input[type="text"]')].map((i) => i.value)
      }
    })()`)
    check('切到別組時欄位確實換掉', draftKept.switchedAway)
    check('切回來時 URL 草稿還在', draftKept.url === 'https://draft.test/v1', draftKept.url)
    check('切回來時模型草稿還在', draftKept.models.includes('draft/model-x'), draftKept.models.join(','))

    // 生圖標記跟模型 ID 在同一列（不另開「圖片模型」欄位），切走再切回也要留著
    const imageFlag = await cdp.eval(`(() => {
      const rows = [...document.querySelectorAll('#chatModelList .chat-model-row')]
      const row = rows.at(-1)
      const box = row?.querySelector('input[data-image-flag]')
      if (!box) return { hasBox: false }
      box.checked = true
      const select = document.getElementById('chatProviderSelect')
      const mine = select.value
      select.value = select.options[0].value
      select.dispatchEvent(new Event('change', { bubbles: true }))
      select.value = mine
      select.dispatchEvent(new Event('change', { bubbles: true }))
      const back = [...document.querySelectorAll('#chatModelList .chat-model-row')]
        .find((r) => r.querySelector('input[type="text"]')?.value === 'draft/model-x')
      return {
        hasBox: true,
        kept: back?.querySelector('input[data-image-flag]')?.checked === true
      }
    })()`)
    check('模型列有「生圖」勾選框', imageFlag.hasBox)
    check('生圖標記切換供應商後仍在', imageFlag.kept, JSON.stringify(imageFlag))

    // 走 app-dialog 的 askConfirm；背景視窗裡 Chromium 會延後派發 `close`，按完「刪除」手動補送一次
    const deleted = await cdp.eval(`(async () => {
      const select = document.getElementById('chatProviderSelect')
      const before = select.options.length
      document.getElementById('chatDeleteProviderBtn').click()
      await new Promise((r) => setTimeout(r, 100))
      const dialog = document.querySelector('dialog.app-dialog[open]')
      dialog?.querySelector('.btn-danger')?.click()
      dialog?.dispatchEvent(new Event('close'))
      await new Promise((r) => setTimeout(r, 100))
      return { dialog: !!dialog, shrank: select.options.length === before - 1, remaining: select.options.length }
    })()`)
    check('刪除供應商後下拉少一項', deleted.shrank, `remaining=${deleted.remaining}`)

    console.log('\n模型掃描')

    // 掃描會把草稿寫進 store（main 得從 store 讀網址與金鑰），
    // 所以先備份使用者的真實設定，這一段結束一定還原。
    const original = await cdp.eval(`(async () => ({
      providers: await window.electronAPI.store.get('chatProviders', []),
      providerId: await window.electronAPI.store.get('chatProviderId', ''),
      modelId: await window.electronAPI.store.get('chatModelId', ''),
      // 翻譯跟聊天共用這份清單：中途改動供應商會連帶把翻譯的選擇收斂掉，一起還原
      translateProviderId: await window.electronAPI.store.get('translateProviderId', ''),
      translateModelId: await window.electronAPI.store.get('translateModelId', '')
    }))()`)

    try {
      await cdp.eval(`(() => {
        document.getElementById('chatAddProviderBtn').click()
        const name = document.getElementById('chatProviderNameInput')
        name.value = '掃描測試'
        name.dispatchEvent(new Event('input', { bubbles: true }))
        document.getElementById('chatApiUrlInput').value = ${JSON.stringify(fake.url)}
      })()`)

      await cdp.eval(`document.getElementById('chatScanModelsBtn').click()`)
      const dialog = await waitFor(() => cdp.eval(`(() => {
        const box = document.getElementById('chatScanDialog')
        if (!box?.open) return null
        return {
          items: [...document.querySelectorAll('#chatScanList .chat-scan-id')].map((n) => n.textContent),
          desc: document.getElementById('chatScanDesc')?.textContent || '',
          count: document.getElementById('chatScanCount')?.textContent || ''
        }
      })()`), 20_000, '掃描彈窗開啟')

      check('掃描列出所有模型', dialog.items.length === fake.models.length, dialog.items.join(','))
      check('說明帶出掃到的數量',
        dialog.desc.includes(String(fake.models.length)), dialog.desc)
      check('預設一個都沒勾', dialog.count.includes('已勾選 0'), dialog.count)

      const filtered = await cdp.eval(`(() => {
        const search = document.getElementById('chatScanSearch')
        search.value = 'gamma'
        search.dispatchEvent(new Event('input', { bubbles: true }))
        return [...document.querySelectorAll('#chatScanList .chat-scan-id')].map((n) => n.textContent)
      })()`)
      check('搜尋可過濾', filtered.length === 1 && filtered[0] === 'fake/gamma-large', filtered.join(','))

      // 全選只該作用在目前搜尋結果上，否則搜尋後按全選會把沒看到的也勾進去
      const scopedAll = await cdp.eval(`(() => {
        document.getElementById('chatScanAllBtn').click()
        return document.getElementById('chatScanCount').textContent
      })()`)
      check('全選只作用於搜尋結果', scopedAll.includes('已勾選 1'), scopedAll)

      const applied = await cdp.eval(`(() => {
        document.getElementById('chatScanApplyBtn').click()
        return {
          open: document.getElementById('chatScanDialog').open,
          rows: [...document.querySelectorAll('#chatModelList input[type="text"]')].map((i) => i.value)
        }
      })()`)
      check('套用後彈窗關閉', applied.open === false)
      check('勾選的模型進了清單', applied.rows.includes('fake/gamma-large'), applied.rows.join(','))

      // 已經在清單裡的要標出來，免得使用者重複勾
      await cdp.eval(`document.getElementById('chatScanModelsBtn').click()`)
      const badges = await waitFor(() => cdp.eval(`(() => {
        const box = document.getElementById('chatScanDialog')
        if (!box?.open) return null
        return [...document.querySelectorAll('#chatScanList .chat-scan-item')]
          .filter((n) => n.querySelector('.chat-scan-badge'))
          .map((n) => n.querySelector('.chat-scan-id').textContent)
      })()`), 20_000, '第二次掃描')
      check('已在清單的模型有標記', badges.includes('fake/gamma-large'), badges.join(','))
      await cdp.eval(`document.getElementById('chatScanCancelBtn').click()`)
    } finally {
      await cdp.eval(`(async () => {
        await window.electronAPI.store.set('chatProviders', ${JSON.stringify(original.providers)})
        await window.electronAPI.store.set('chatProviderId', ${JSON.stringify(original.providerId)})
        await window.electronAPI.store.set('chatModelId', ${JSON.stringify(original.modelId)})
        await window.electronAPI.store.set('translateProviderId', ${JSON.stringify(original.translateProviderId)})
        await window.electronAPI.store.set('translateModelId', ${JSON.stringify(original.translateModelId)})
      })()`)
    }

    const restored = await cdp.eval(`(async () => {
      const providers = await window.electronAPI.store.get('chatProviders', [])
      return providers.some((p) => p.name === '掃描測試')
    })()`)
    check('測試用供應商已從真實設定清除', restored === false)

    console.log('\n聊天頁模型下拉')

    const modelSelect = await waitFor(async () => {
      await cdp.eval(`document.querySelector('.nav-tab[data-page="chat"]').click()`)
      const snapshot = await cdp.eval(`(() => {
        const select = document.getElementById('chatModelSelect')
        if (!select) return null
        const groups = [...select.querySelectorAll('optgroup')]
        const options = [...select.querySelectorAll('option')]
        return {
          groups: groups.map((g) => g.label),
          hasDataset: options.every((o) => !!o.dataset.providerId && !!o.dataset.model),
          count: options.length
        }
      })()`)
      return snapshot?.count ? snapshot : null
    }, 15_000, '聊天頁模型下拉')

    check('模型依供應商分組（optgroup）', modelSelect.groups.length >= 1, modelSelect.groups.join(', '))
    check('每個選項都帶 providerId 與 model', modelSelect.hasDataset)

    // 草稿沒存下去，所以真實設定不該被這支測試改到
    const untouched = await cdp.eval(`(async () => {
      const providers = await window.electronAPI.store.get('chatProviders', [])
      return providers.some((p) => p.name === '測試用供應商')
    })()`)
    check('未按儲存 → 真實設定沒有被寫入測試資料', untouched === false)

    console.log('\n聊天頁版面：上方工具列已清空')

    const layout = await cdp.eval(`(() => {
      const bar = document.querySelector('.chat-composer-bar')
      return {
        toolbar: !!document.querySelector('.chat-main > .chat-toolbar'),
        title: !!document.getElementById('chatTitleInput'),
        topDelete: !!document.getElementById('chatDeleteBtn'),
        promptInBar: !!bar?.contains(document.getElementById('chatPromptSelect')),
        manageInBar: !!bar?.contains(document.getElementById('chatPromptManageBtn')),
        modelInBar: !!bar?.contains(document.getElementById('chatModelSelect'))
      }
    })()`)
    check('上方工具列已移除', !layout.toolbar && !layout.title && !layout.topDelete, JSON.stringify(layout))
    check('系統提示（含設定鈕）移到輸入框那排', layout.promptInBar && layout.manageInBar)
    check('模型選單移到輸入框那排', layout.modelInBar)

    console.log('\n側欄：改名／刪除／拖曳排序')

    // 只動自己新建的兩個對話，最後全部刪掉，不碰使用者原有的紀錄
    const made = await cdp.eval(`(async () => {
      const a = await window.electronAPI.chat.create()
      await window.electronAPI.chat.rename(a.id, 'CDP-甲')
      const b = await window.electronAPI.chat.create()
      await window.electronAPI.chat.rename(b.id, 'CDP-乙')
      return { a: a.id, b: b.id }
    })()`)
    try {
      await cdp.eval(`document.querySelector('.nav-tab[data-page="usage"]').click()`)
      await cdp.eval(`document.querySelector('.nav-tab[data-page="chat"]').click()`)
      await waitFor(() => cdp.eval(
        `!!document.querySelector('.chat-list-item[data-id="${made.b}"] .chat-list-btn')`
      ), 15_000, '側欄列渲染')

      const buttons = await cdp.eval(
        `document.querySelectorAll('.chat-list-item[data-id="${made.a}"] .chat-list-btn').length`
      )
      check('每一列都有改名、刪除、更多三顆按鈕', buttons === 3, String(buttons))

      // 改名：按 ✎ → 就地輸入框 → Enter
      await cdp.eval(`document.querySelector('.chat-list-item[data-id="${made.a}"] .chat-list-btn').click()`)
      const renamed = await waitFor(async () => {
        const done = await cdp.eval(`(() => {
          const input = document.querySelector('.chat-list-item[data-id="${made.a}"] .chat-list-rename')
          if (!input) return false
          input.value = 'CDP-改過'
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
          return true
        })()`)
        if (!done) return null
        return cdp.eval(`(async () => (await window.electronAPI.chat.get('${made.a}')).title)()`)
      }, 15_000, '側欄改名')
      check('側欄可就地改名', renamed === 'CDP-改過', String(renamed))

      // 拖曳：把乙拖到甲上面（甲原本在乙上面，因為 create 是插在最前）
      const order = await cdp.eval(`(() => {
        const items = [...document.querySelectorAll('.chat-list-item')]
        return items.map((el) => el.dataset.id)
      })()`)
      check('新對話插在清單最前面', order[0] === made.b && order[1] === made.a, order.slice(0, 2).join(','))

      await cdp.eval(`(() => {
        const src = document.querySelector('.chat-list-item[data-id="${made.b}"]')
        const dst = document.querySelector('.chat-list-item[data-id="${made.a}"]')
        const from = src.getBoundingClientRect()
        const to = dst.getBoundingClientRect()
        const opts = { bubbles: true, button: 0, pointerId: 1 }
        src.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: from.left + 20, clientY: from.top + 10 }))
        window.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: to.left + 20, clientY: to.top + to.height / 2 }))
        window.dispatchEvent(new PointerEvent('pointerup', opts))
        return true
      })()`)
      const persisted = await waitFor(async () => {
        const ids = await cdp.eval(`(async () => (await window.electronAPI.chat.list()).map((c) => c.id))()`)
        return ids[0] === made.a ? ids : null
      }, 10_000, '拖曳後的順序落盤').catch(() => null)
      check('拖曳排序會寫回 main', Array.isArray(persisted) && persisted[0] === made.a && persisted[1] === made.b,
        Array.isArray(persisted) ? persisted.slice(0, 2).join(',') : '未落盤')

      // 刪除：二次確認在按鈕上，不開原生 confirm（原生彈窗會卡死整個 CDP session）
      const armed = await cdp.eval(`(async () => {
        const btn = document.querySelectorAll('.chat-list-item[data-id="${made.b}"] .chat-list-btn')[1]
        btn.click()
        await new Promise((r) => setTimeout(r, 200))
        return {
          armed: btn.classList.contains('is-armed'),
          stillThere: !!(await window.electronAPI.chat.get('${made.b}'))
        }
      })()`)
      check('第一次按刪除只進入待確認、不刪東西', armed.armed && armed.stillThere, JSON.stringify(armed))

      const removed = await cdp.eval(`(async () => {
        document.querySelectorAll('.chat-list-item[data-id="${made.b}"] .chat-list-btn')[1].click()
        await new Promise((r) => setTimeout(r, 800))
        return !(await window.electronAPI.chat.get('${made.b}'))
      })()`)
      check('再按一次才真的刪除', removed === true)
    } finally {
      await cdp.eval(`(async () => {
        await window.electronAPI.chat.delete('${made.a}')
        await window.electronAPI.chat.delete('${made.b}')
      })()`)
    }
    const leftovers = await cdp.eval(
      `(async () => (await window.electronAPI.chat.list()).filter((c) => c.title.startsWith('CDP-')).length)()`
    )
    check('測試用對話已清乾淨', leftovers === 0, String(leftovers))

    await checkConcurrentUi(cdp, fake, check)

    check('沒有未捕捉的例外', cdp.exceptions.length === 0, cdp.exceptions.join(' | '))
  } catch (error) {
    fail(`執行失敗：${error.message}`)
  } finally {
    cdp?.close()
    // 只收自己 spawn 的那棵程序樹（renderer／GPU 子程序還抓著暫存 userData 就刪不掉）
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      child.kill()
    }
    fake.server.close()
    await sleep(500)
    try {
      removeTree(USER_DATA_DIR)
    } catch {
      console.warn(`暫存資料夾刪不掉，請手動刪：${USER_DATA_DIR}`)
    }
  }

  console.log('')
  if (failures.length) {
    console.log(`FAILED  ${assertions} passed, ${failures.length} failed`)
    for (const item of failures) console.log(`  - ${item}`)
    process.exit(1)
  }
  console.log(`ALL PASS  ${assertions} passed, 0 failed`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
