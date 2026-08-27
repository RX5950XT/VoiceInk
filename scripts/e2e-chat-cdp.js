'use strict'

/**
 * 聊天設定（多組供應商）打包版驗收：`node scripts/e2e-chat-cdp.js`
 *
 * 全程只動草稿、**不按儲存**，所以不會改到使用者的真實設定。
 * 這點很重要：這支會建立／改名／刪除供應商，真的存下去等於幫使用者亂改設定。
 */

const { spawn } = require('child_process')
const path = require('path')
const http = require('http')

const PORT = 9245
const EXE = path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
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

/** 假的 OpenAI 相容 /models 端點：讓掃描完全可控，不打真實供應商 */
function startFakeModels() {
  const models = ['fake/alpha', 'fake/beta', 'fake/gamma-large', 'fake/delta']
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (!String(req.url || '').endsWith('/models')) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: models.map((id) => ({ id })) }))
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, models, url: `http://127.0.0.1:${server.address().port}/v1` })
    })
  })
}

async function main() {
  const fake = await startFakeModels()
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] })
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
      return list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
    }, 40_000, '偵錯目標')

    cdp = new Cdp(target.webSocketDebuggerUrl)
    await cdp.connect()
    await waitFor(
      () => cdp.eval(`document.querySelectorAll('.nav-tab').length >= 7`),
      30_000, 'nav 就緒'
    )

    console.log('\n設定頁：聊天分區')

    // 分兩段等，而且各自只點一次。
    // 把兩次點擊塞進同一個 waitFor 重試會排隊觸發多次非同步 loadChatSettings()，
    // 晚到的那次 replaceChildren 會把剛新增的列與焦點洗掉，測試就時好時壞。
    await waitFor(async () => {
      await cdp.eval(`document.querySelector('.nav-tab[data-page="settings"]').click()`)
      return cdp.eval(`document.getElementById('page-settings')?.classList.contains('active') === true`)
    }, 15_000, '切到設定頁')

    await cdp.eval(`document.querySelector('.settings-nav-item[data-section="chat"]').click()`)
    await waitFor(
      () => cdp.eval(`document.getElementById('set-chat')?.classList.contains('active') === true`),
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
          rows: document.querySelectorAll('#chatModelList input').length,
          placeholder: document.querySelector('#chatModelList input')?.placeholder || ''
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
      const before = document.querySelectorAll('#chatModelList input').length
      document.getElementById('chatAddModelBtn').click()
      const inputs = [...document.querySelectorAll('#chatModelList input')]
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
        rows: document.querySelectorAll('#chatModelList input').length
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
      const input = [...document.querySelectorAll('#chatModelList input')].at(-1)
      input.value = 'draft/model-x'

      select.value = firstId
      select.dispatchEvent(new Event('change', { bubbles: true }))
      const switchedUrl = document.getElementById('chatApiUrlInput').value

      select.value = newId
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return {
        switchedAway: switchedUrl !== 'https://draft.test/v1',
        url: document.getElementById('chatApiUrlInput').value,
        models: [...document.querySelectorAll('#chatModelList input')].map((i) => i.value)
      }
    })()`)
    check('切到別組時欄位確實換掉', draftKept.switchedAway)
    check('切回來時 URL 草稿還在', draftKept.url === 'https://draft.test/v1', draftKept.url)
    check('切回來時模型草稿還在', draftKept.models.includes('draft/model-x'), draftKept.models.join(','))

    const deleted = await cdp.eval(`(() => {
      const original = window.confirm
      window.confirm = () => true
      const select = document.getElementById('chatProviderSelect')
      const before = select.options.length
      document.getElementById('chatDeleteProviderBtn').click()
      window.confirm = original
      return { shrank: select.options.length === before - 1, remaining: select.options.length }
    })()`)
    check('刪除供應商後下拉少一項', deleted.shrank, `remaining=${deleted.remaining}`)

    console.log('\n模型掃描')

    // 掃描會把草稿寫進 store（main 得從 store 讀網址與金鑰），
    // 所以先備份使用者的真實設定，這一段結束一定還原。
    const original = await cdp.eval(`(async () => ({
      providers: await window.electronAPI.store.get('chatProviders', []),
      providerId: await window.electronAPI.store.get('chatProviderId', ''),
      modelId: await window.electronAPI.store.get('chatModelId', '')
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
      check('說明帶出供應商名稱與數量',
        dialog.desc.includes('掃描測試') && dialog.desc.includes(String(fake.models.length)), dialog.desc)
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
          rows: [...document.querySelectorAll('#chatModelList input')].map((i) => i.value)
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
      check('每一列都有改名與刪除兩顆按鈕', buttons === 2, String(buttons))

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

    check('沒有未捕捉的例外', cdp.exceptions.length === 0, cdp.exceptions.join(' | '))
  } catch (error) {
    fail(`執行失敗：${error.message}`)
  } finally {
    cdp?.close()
    child.kill()
    fake.server.close()
    await sleep(500)
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
