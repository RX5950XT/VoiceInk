#!/usr/bin/env node
/**
 * VoiceInk — Claude Code 工作台頁的打包版回歸（CDP）
 *
 * **這支刻意不碰 `~/.claude/settings.json` 與 `~/.claude.json`**：那是使用者的真實設定，
 * 測試把它改壞的代價遠大於多驗一條。寫入路徑由 `scripts/test-ccswitch.js` 用暫存家目錄涵蓋，
 * 這裡只驗 UI 有沒有接對——清單渲染、彈窗、供應商增修刪（只落到暫存 profile 的
 * `cc-providers.json`）、MCP 與版本清單讀得出來。
 *
 * 用暫存 `--user-data-dir`，收尾只以自己的 pid 收程序（禁止 `/IM VoiceInk.exe`，
 * 那會把使用者的安裝版一起關掉）。
 */

'use strict'

const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')

const PORT = 9247
// Windows 偶爾會有別的東西鎖住 dist/win-unpacked（打包失敗、防毒掃描中），
// 這時可以打包到別的資料夾再用 VOICEINK_EXE 指過去，測試不必等鎖放掉
const EXE = process.env.VOICEINK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
const USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-e2e-ccswitch-'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = ''
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (error) { reject(error) }
      })
    })
    request.setTimeout(2_000, () => request.destroy(new Error('CDP HTTP 逾時')))
    request.on('error', reject)
  })
}

/**
 * 收掉測試自己開的那份 App。
 *
 * 先砍 pid 樹；實測有時候還會剩下幾個孤兒（常駐系統匣讓主程序活著，子程序被重新收養），
 * 所以再掃一次「命令列帶著我們這個暫存 user-data-dir」的程序——那是這一份 App 獨有的指紋。
 * **絕對不能用 `/IM VoiceInk.exe`**：那會把使用者自己開著的安裝版一起關掉。
 * 沒收乾淨的話下一次 `electron:pack` 會卡在 `d3dcompiler_47.dll: Access is denied`。
 *
 * @param {import('child_process').ChildProcess | null} child
 */
function stopTestApp(child) {
  if (child?.pid) {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch { /* 程序已結束 */ }
  }
  try {
    execFileSync('powershell', [
      '-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='VoiceInk.exe'" |` +
      // -like 的萬用字元只有 * 與 ?，反斜線是字面值，不要再跳脫
      ` Where-Object { $_.CommandLine -like '*${USER_DATA_DIR}*' } |` +
      ' ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
    ], { stdio: 'ignore' })
  } catch { /* 沒有殘留就什麼都不用做 */ }
}

class Cdp {
  constructor(url) {
    this.url = url
    this.id = 0
    this.pending = new Map()
    this.exceptions = []
    this.consoleErrors = []
  }

  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve)
      this.ws.addEventListener('error', () => reject(new Error('CDP WebSocket 連不上')))
    })
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(message.params?.exceptionDetails?.exception?.description || 'runtime exception')
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
        this.consoleErrors.push((message.params.args || [])
          .map((item) => item.value || item.description || '').join(' '))
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
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    }
    return result.result?.value
  }

  close() {
    try { this.ws.close() } catch { /* 已關閉 */ }
  }
}

/**
 * 選單改值＋派發 change。`Runtime.evaluate` 每次都在同一個全域範圍求值，
 * 直接寫 `const s = ...` 第二次呼叫就會撞 "Identifier 's' has already been declared"。
 * @param {string} id
 * @param {string} value
 * @returns {string}
 */
function pickSelect(id, value) {
  return `(() => {
    const select = document.getElementById(${JSON.stringify(id)})
    select.value = ${JSON.stringify(value)}
    select.dispatchEvent(new Event('change'))
    return select.value
  })()`
}

async function waitFor(action, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let result = null
    try {
      result = await action()
    } catch { /* 還沒好，下一輪再試 */ }
    if (result) return result
    await sleep(300)
  }
  throw new Error(`等待逾時：${label}`)
}

async function main() {
  const child = spawn(EXE, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DATA_DIR}`,
    '--hidden',
    '--disable-backgrounding-occluded-windows'
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let processLog = ''
  child.stdout.on('data', (chunk) => { processLog += chunk })
  child.stderr.on('data', (chunk) => { processLog += chunk })

  let cdp = null
  let checks = 0
  const pass = (message) => {
    checks++
    console.log(`PASS  ${message}`)
  }
  const assert = (condition, message, detail = '') => {
    if (!condition) throw new Error(`${message}${detail ? ` — ${detail}` : ''}`)
    pass(message)
  }
  /** 這一輪自己建出來的供應商 id，收尾要刪掉 */
  let createdId = ''

  try {
    const target = await waitFor(async () => {
      const pages = await getJson(`http://127.0.0.1:${PORT}/json/list`).catch(() => [])
      return pages.find((page) => page.type === 'page' && /index\.html/.test(page.url)) || null
    }, 30_000, '主視窗')
    cdp = new Cdp(target.webSocketDebuggerUrl)
    await cdp.connect()
    await waitFor(
      () => cdp.eval("document.readyState === 'complete' && typeof window.electronAPI?.ccswitch?.catalog === 'function'"),
      15_000,
      'preload 就緒'
    )

    // ===== 分頁存在且切得過去 =====
    assert(
      await cdp.eval("Boolean(document.querySelector('.nav-tab[data-page=\"ccswitch\"]'))"),
      'nav 有 Claude Code 分頁'
    )
    await cdp.eval("document.querySelector('.nav-tab[data-page=\"ccswitch\"]').click()")
    await waitFor(
      () => cdp.eval("document.getElementById('page-ccswitch').classList.contains('active')"),
      10_000,
      '切到 Claude Code 分頁'
    )
    pass('切到 Claude Code 分頁')

    // ===== 預設表 =====
    const catalog = await cdp.eval('window.electronAPI.ccswitch.catalog()')
    assert(catalog?.ok === true, 'catalog 讀得到', JSON.stringify(catalog?.error || {}))
    const presetIds = (catalog.data.presets || []).map((preset) => preset.id)
    // 順序就是 tile 那一排的順序：官方訂閱（切回去的那一筆）排第一、自訂收尾。
    // 筆數不寫死——加一家就得改測試的話，改的人會直接把數字調大而不去看順序對不對
    assert(presetIds[0] === 'official' && presetIds.at(-1) === 'custom',
      '官方訂閱排第一、自訂收尾', presetIds.join(','))
    // 內建各家都要有實測過的 modelsUrl（掃描按鈕的開關）；custom 由 baseUrl 推導、不該有
    const byId = Object.fromEntries(catalog.data.presets.map((preset) => [preset.id, preset]))
    for (const id of presetIds.filter((key) => key !== 'custom' && key !== 'official')) {
      assert(/^https?:\/\//.test(byId[id]?.modelsUrl || ''), `${id} 有 modelsUrl`, byId[id]?.modelsUrl)
    }
    assert(!byId.custom.modelsUrl, '自訂沒有 modelsUrl')
    assert(!byId.official.modelsUrl, '官方訂閱沒有 modelsUrl（它沒有上游可掃）')
    assert(byId.official.auth === 'none' && !byId.official.baseUrl, '官方訂閱不需金鑰也沒有端點')
    assert(byId.codex.modelsUrl.includes('client_version='), 'Codex 的掃描端點帶 client_version')
    assert(
      (catalog.data.apiFormats || []).join(',') === 'anthropic,openai_chat,openai_responses',
      'catalog 帶得出三種上游協議',
      JSON.stringify(catalog.data.apiFormats)
    )
    assert(
      (catalog.data.mcpTemplates || []).length > 0,
      'MCP 範本有內容'
    )
    // 預設表只描述「金鑰要寫到哪個 env 鍵」（keyField），不可以夾帶金鑰本身
    assert(
      !/"apiKey"|"secret"|"token":/i.test(JSON.stringify(catalog.data)),
      'catalog 不夾帶金鑰值'
    )

    // ===== tile 那一排：官方訂閱＋內建六家＋「＋」，點卡片就是切換 =====
    const before = await cdp.eval('window.electronAPI.ccswitch.listProviders()')
    assert(before?.ok === true, '供應商清單讀得到')
    const beforeCount = before.data.providers.length
    // 播種：六家內建各至少一筆（清單裡不會有第二筆之前留下的）
    const seeded = before.data.providers.filter((item) => item.presetId !== 'custom')
    assert(seeded.length >= 6, '官方訂閱與六家內建都有實例', String(seeded.length))
    assert(seeded.some((item) => item.presetId === 'official'), '有「官方訂閱」那張 tile')
    assert(
      before.data.providers.some((item) => item.presetId === 'codex'),
      '有 Codex 那張 tile'
    )
    const codexSeed = seeded.find((item) => item.presetId === 'codex')

    await waitFor(
      () => cdp.eval("document.querySelectorAll('#ccProviderList .cc-tile').length >= 7"),
      10_000,
      'tile 那一排畫出來'
    )
    const tiles = await cdp.eval(`(() => ({
      count: document.querySelectorAll('#ccProviderList .cc-tile').length,
      add: document.querySelectorAll('#ccProviderList .cc-tile.is-add').length,
      active: document.querySelectorAll('#ccProviderList .cc-tile.is-active').length,
      // 內建那六張沒有刪除鈕（main 有守衛，UI 乾脆不放）
      // 常駐按鈕（啟用／測試／編輯）都要看得見，而且不能靠 hover
      codexSwitch: document.querySelector('#ccProviderList .cc-tile[data-id="${codexSeed.id}"] .cc-tile-switch')?.offsetHeight || 0,
      codexTest: document.querySelector('#ccProviderList .cc-tile[data-id="${codexSeed.id}"] .cc-tile-test')?.offsetHeight || 0,
      codexEdit: document.querySelector('#ccProviderList .cc-tile[data-id="${codexSeed.id}"] .cc-tile-edit')?.offsetHeight || 0,
      // 內建那幾家刪不掉，所以不放刪除鈕（唯一的 .cc-icon-btn 就是刪除）
      codexDelete: document.querySelectorAll('#ccProviderList .cc-tile[data-id="${codexSeed.id}"] .cc-tile-actions .cc-icon-btn').length
    }))()`)
    assert(tiles.count >= 8, '官方訂閱＋六家＋「＋」都在', JSON.stringify(tiles))
    assert(tiles.add === 1, '只有一個「＋」tile')
    assert(tiles.codexSwitch > 0 && tiles.codexTest > 0 && tiles.codexEdit > 0,
      '啟用／測試／編輯按鈕不必 hover 就看得見', JSON.stringify(tiles))
    assert(tiles.codexDelete === 0, '內建 tile 沒有刪除鈕', JSON.stringify(tiles))
    // 卡片上不放金鑰與模型細節（要看就進編輯彈窗），完整金鑰永遠不出 main
    assert(!JSON.stringify(before.data).includes('sk-'), '清單 IPC 不含完整金鑰')

    // ===== tile 拖曳排序（跟額度卡片一樣可以自由換位置）=====
    // 拖曳的最後一步跟鍵盤搬動走同一條 onCommit，所以用 Alt+↓ 驗（模擬 pointer 事件
    // 在 CDP 上很容易寫成「事件發出去了但沒人接」的恆真斷言）
    {
      const order0 = await cdp.eval(
        "[...document.querySelectorAll('#ccProviderList .cc-tile:not(.is-add)')].map((t) => t.dataset.id)"
      )
      assert(order0.length >= 6, 'tile 有可排序的項目', String(order0.length))
      assert(
        await cdp.eval("document.querySelector('#ccProviderList .cc-tile.is-add') === document.querySelector('#ccProviderList .cc-tile:last-child')"),
        '「＋」固定收在最後（不參與排序）'
      )
      await cdp.eval(`(() => {
        const el = document.querySelector('#ccProviderList .cc-tile[data-id="${order0[0]}"]')
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }))
      })()`)
      const order1 = await cdp.eval(
        "[...document.querySelectorAll('#ccProviderList .cc-tile:not(.is-add)')].map((t) => t.dataset.id)"
      )
      assert(order1[1] === order0[0] && order1[0] === order0[1],
        'Alt+↓ 把第一張搬到第二個位置', `${order0.slice(0, 2)} → ${order1.slice(0, 2)}`)
      // 順序要真的寫回 main，不是只有畫面動一下
      await waitFor(
        () => cdp.eval(`window.electronAPI.ccswitch.listProviders().then((r) => r.data.providers[0].id === '${order0[1]}')`),
        5000,
        '新順序寫回 store'
      )
      // 重新整理之後畫面要照 store 的順序畫回來
      await cdp.eval("document.getElementById('ccRefreshBtn').click()")
      await waitFor(
        () => cdp.eval(`[...document.querySelectorAll('#ccProviderList .cc-tile:not(.is-add)')][0]?.dataset.id === '${order0[1]}'`),
        5000,
        '重畫之後順序沒有跳回去'
      )
      // 搬回原位，後面的斷言才不受影響
      await cdp.eval(`window.electronAPI.ccswitch.reorderProviders(${JSON.stringify(order0)})`)
      await cdp.eval("document.getElementById('ccRefreshBtn').click()")
      await waitFor(
        () => cdp.eval(`[...document.querySelectorAll('#ccProviderList .cc-tile:not(.is-add)')][0]?.dataset.id === '${order0[0]}'`),
        5000,
        '順序還原'
      )

      // ===== 真的用滑鼠拖一次（跟額度儀錶板同一套：跟手 overlay ＋ 鬼影，而且不准反白）=====
      // 這裡一定要走 `Input.dispatchMouseEvent`：合成的 PointerEvent 不會產生文字選取，
      // 「拖曳會反白」這條用合成事件驗就是恆真的假綠燈。
      const rects = await cdp.eval(`[...document.querySelectorAll('#ccProviderList .cc-tile:not(.is-add)')]
        .slice(0, 3).map((el) => { const r = el.getBoundingClientRect()
          return { id: el.dataset.id, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })`)
      const mouse = (type, x, y, extra = {}) => cdp.send('Input.dispatchMouseEvent', {
        type, x, y, button: 'left', clickCount: 1, ...extra
      })
      await mouse('mousePressed', rects[0].x, rects[0].y)
      await mouse('mouseMoved', rects[0].x + 12, rects[0].y + 4, { buttons: 1 })
      await mouse('mouseMoved', rects[2].x, rects[2].y, { buttons: 1 })
      await sleep(60)
      const mid = await cdp.eval(`(() => ({
        overlay: document.querySelectorAll('.reorder-overlay').length,
        ghost: document.querySelectorAll('#ccProviderList .cc-tile.is-ghost').length,
        sorting: document.getElementById('ccProviderList').classList.contains('is-sorting'),
        selected: String(window.getSelection())
      }))()`)
      await mouse('mouseReleased', rects[2].x, rects[2].y)
      await sleep(60)
      assert(mid.overlay === 1 && mid.ghost === 1 && mid.sorting,
        '拖曳中有跟手 overlay ＋ 鬼影（額度儀錶板那套）', JSON.stringify(mid))
      assert(mid.selected.trim() === '', '拖曳不會把 tile 上的文字反白', JSON.stringify(mid.selected))
      const dropped = await cdp.eval(
        "[...document.querySelectorAll('#ccProviderList .cc-tile:not(.is-add)')].map((t) => t.dataset.id)"
      )
      assert(dropped[2] === order0[0], '放開後真的換到第三個位置', `${order0.slice(0, 3)} → ${dropped.slice(0, 3)}`)
      assert(await cdp.eval("document.querySelectorAll('.reorder-overlay').length === 0"), 'overlay 收乾淨')

      await cdp.eval(`window.electronAPI.ccswitch.reorderProviders(${JSON.stringify(order0)})`)
      await cdp.eval("document.getElementById('ccRefreshBtn').click()")
      await waitFor(
        () => cdp.eval(`[...document.querySelectorAll('#ccProviderList .cc-tile:not(.is-add)')][0]?.dataset.id === '${order0[0]}'`),
        5000,
        '拖曳後順序還原'
      )
    }

    // 缺金鑰的 tile：點下去是帶去填金鑰，不是送 IPC 吃 MISSING_API_KEY
    const keyless = before.data.providers.find((item) => item.presetId === 'openrouter' && !item.hasKey)
    if (keyless) {
      await cdp.eval(`document.querySelector('#ccProviderList .cc-tile[data-id="${keyless.id}"] .cc-tile-switch').click()`)
      assert(
        await cdp.eval("document.getElementById('ccProviderDialog').open === true"),
        '缺金鑰的 tile 點下去開編輯彈窗'
      )
      assert(
        await cdp.eval("document.getElementById('ccProviderDialogTitle').textContent === '編輯供應商'"),
        '缺金鑰的 tile 開的是編輯彈窗'
      )
      await cdp.eval("document.getElementById('ccProviderCancelBtn').click()")
    }

    // ===== 供應商：新增 → 出現在清單 → 編輯 → 刪除 =====
    const created = await cdp.eval(
      "window.electronAPI.ccswitch.createProvider({ presetId: 'openrouter', name: 'CDP 測試用', apiKey: 'sk-cdp-test', model: 'test/model' })"
    )
    assert(created?.ok === true, '新增供應商成功', JSON.stringify(created?.error || {}))
    createdId = created.data.id

    await cdp.eval("document.getElementById('ccRefreshBtn').click()")
    await waitFor(
      () => cdp.eval(`Boolean(document.querySelector('#ccProviderList .cc-tile[data-id="${createdId}"]'))`),
      10_000,
      '新增的供應商出現在清單'
    )
    pass('新增的供應商出現在清單')

    const tileText = await cdp.eval(
      `document.querySelector('#ccProviderList .cc-tile[data-id="${createdId}"]').textContent`
    )
    assert(tileText.includes('CDP 測試用'), 'tile 顯示自訂名稱')
    // 卡片刻意不放模型與金鑰細節；完整金鑰更是任何地方都不能出現
    assert(!tileText.includes('sk-cdp-test'), '完整金鑰不出現在畫面上')
    const listed = await cdp.eval('window.electronAPI.ccswitch.listProviders()')
    assert(
      !JSON.stringify(listed.data).includes('sk-cdp-test'),
      'IPC 回應不含完整金鑰'
    )

    // 編輯彈窗：改名之後留在同一筆
    await cdp.eval(
      `document.querySelector('#ccProviderList .cc-tile[data-id="${createdId}"] .cc-tile-edit').click()`
    )
    assert(
      await cdp.eval("document.getElementById('ccProviderDialog').open === true"),
      '編輯彈窗打得開'
    )
    assert(
      await cdp.eval("document.getElementById('ccProviderDialogTitle').textContent === '編輯供應商'"),
      '編輯彈窗標題正確'
    )
    assert(
      await cdp.eval("document.getElementById('ccKeyInput').value === ''"),
      '編輯時金鑰欄留空（不回填完整金鑰）'
    )
    // 「宣告支援 1M 上下文」：勾了要真的存進去（tile 第二行也會多一段 `· 1M`）。
    // 只斷言 checkbox 在不在抓不到「被 CSS 收掉了」，所以量得到高度才算數
    assert(
      await cdp.eval("document.getElementById('ccContext1mCheck').offsetHeight > 0"),
      '1M 勾選框看得見'
    )
    await cdp.eval("document.getElementById('ccContext1mCheck').checked = true")
    await cdp.eval("document.getElementById('ccNameInput').value = 'CDP 改過的名稱'")
    await cdp.eval("document.getElementById('ccProviderSaveBtn').click()")
    await waitFor(
      () => cdp.eval(
        `document.querySelector('#ccProviderList .cc-tile[data-id="${createdId}"]')?.textContent.includes('CDP 改過的名稱')`
      ),
      10_000,
      '改名生效'
    )
    pass('改名生效')

    const oneM = await cdp.eval('window.electronAPI.ccswitch.listProviders()')
    assert(
      oneM.data.providers.find((item) => item.id === createdId)?.context1m === true,
      '1M 宣告有存進去'
    )
    assert(
      await cdp.eval(
        `document.querySelector('#ccProviderList .cc-tile[data-id="${createdId}"]').textContent.includes('1M')`
      ),
      'tile 上看得出宣告了 1M'
    )

    // 金鑰留空儲存不可以把原本的金鑰清掉
    const afterRename = await cdp.eval('window.electronAPI.ccswitch.listProviders()')
    const renamed = afterRename.data.providers.find((item) => item.id === createdId)
    assert(renamed?.hasKey === true, '金鑰留空儲存不會清掉原金鑰')

    // 刪除是就地二次確認：按一次只會變成待確認
    const delSelector = `#ccProviderList .cc-tile[data-id="${createdId}"] .cc-tile-actions .cc-icon-btn`
    await cdp.eval(`document.querySelector('${delSelector}').click()`)
    assert(
      await cdp.eval(`document.querySelector('${delSelector}').classList.contains('is-armed')`),
      '刪除第一次按只是待確認'
    )
    assert(
      await cdp.eval(`Boolean(document.querySelector('#ccProviderList .cc-tile[data-id="${createdId}"]'))`),
      '待確認狀態下資料還在'
    )
    await cdp.eval(`document.querySelector('${delSelector}').click()`)
    await waitFor(
      () => cdp.eval(`!document.querySelector('#ccProviderList .cc-tile[data-id="${createdId}"]')`),
      10_000,
      '再按一次才真的刪掉'
    )
    createdId = ''
    pass('再按一次才真的刪掉')

    const after = await cdp.eval('window.electronAPI.ccswitch.listProviders()')
    assert(after.data.providers.length === beforeCount, '刪完之後數量回到原點')

    // 內建那六家刪到剩最後一筆要擋（IPC 層面；UI 本來就沒放刪除鈕）
    const guard = await cdp.eval(`(async () => {
      const r = await window.electronAPI.ccswitch.deleteProvider(${JSON.stringify(codexSeed.id)})
      return { ok: r?.ok === true, code: r?.error?.code || '' }
    })()`)
    assert(guard.ok === false && guard.code === 'PROVIDER_REQUIRED',
      '內建供應商不可刪除', JSON.stringify(guard))

    // ===== 新增彈窗：只剩自訂（preset 下拉已拿掉） =====
    assert(
      await cdp.eval("document.getElementById('ccAddProviderBtn') === null"),
      '「新增供應商」按鈕已移除（改由「＋」tile）'
    )
    await cdp.eval("document.querySelector('#ccProviderList .cc-tile.is-add .cc-tile-main').click()")
    assert(
      await cdp.eval("document.getElementById('ccProviderDialogTitle').textContent === '新增自訂供應商'"),
      '「＋」開的是新增自訂供應商'
    )
    const customForm = await cdp.eval(`(() => {
      const fmt = document.getElementById('ccApiFormatSelect')
      return {
        formatShown: !document.getElementById('ccApiFormatGroup').classList.contains('hidden'),
        baseUrlShown: !document.getElementById('ccBaseUrlGroup').classList.contains('hidden'),
        keyShown: !document.getElementById('ccKeyGroup').classList.contains('hidden'),
        options: [...fmt.options].map((o) => o.value),
        value: fmt.value,
        hint: document.getElementById('ccApiFormatHint').textContent,
        placeholder: document.getElementById('ccBaseUrlInput').placeholder
      }
    })()`)
    assert(customForm.formatShown, '自訂顯示協議選擇（路由開關）')
    assert(customForm.baseUrlShown, '自訂顯示 Base URL 欄')
    assert(customForm.keyShown, '自訂顯示金鑰欄')
    assert(
      customForm.options.join(',') === 'anthropic,openai_chat,openai_responses',
      '三種協議都在', JSON.stringify(customForm.options)
    )
    assert(customForm.value === 'anthropic', '預設是 Anthropic', customForm.value)
    assert(customForm.hint.includes('不經閘道'), 'Anthropic 說明講「直連」', customForm.hint)
    assert(customForm.placeholder.includes('必填'), 'Base URL 標示必填', customForm.placeholder)

    // 換成 OpenAI 協議 → 同一句話要改口說「會走閘道」，這就是使用者要的那個路由開關
    await cdp.eval(pickSelect('ccApiFormatSelect', 'openai_chat'))
    const gwHint = await cdp.eval("document.getElementById('ccApiFormatHint').textContent")
    assert(gwHint.includes('本機轉換閘道'), '換成 OpenAI 協議會說要走閘道', gwHint)

    // 模型四格是下拉＋掃描按鈕；手動輸入是逃生口
    assert(
      await cdp.eval("Boolean(document.getElementById('ccScanModelsBtn'))"),
      '有「從 API 載入模型」按鈕'
    )
    const modelUi = await cdp.eval(`(() => {
      const selects = ['ccModelSelect', 'ccHaikuSelect', 'ccSonnetSelect', 'ccOpusSelect']
      return {
        selects: selects.filter((id) => document.getElementById(id)?.tagName === 'SELECT').length,
        selectShown: selects.every((id) => {
          const el = document.getElementById(id)
          return el && !el.closest('.custom-select').classList.contains('hidden')
        }),
        inputsHidden: ['ccModelInput', 'ccHaikuInput', 'ccSonnetInput', 'ccOpusInput']
          .every((id) => document.getElementById(id)?.classList.contains('hidden'))
      }
    })()`)
    assert(modelUi.selects === 4, '四個模型等級都是下拉', JSON.stringify(modelUi))
    assert(modelUi.selectShown, '下拉模式是預設')
    assert(modelUi.inputsHidden, '手動輸入欄預設藏著')
    await cdp.eval("document.getElementById('ccManualModelsBtn').click()")
    assert(
      await cdp.eval(`(() => {
        const inputs = ['ccModelInput', 'ccHaikuInput', 'ccSonnetInput', 'ccOpusInput']
        return inputs.every((id) => !document.getElementById(id)?.classList.contains('hidden')) &&
          document.getElementById('ccManualModelsBtn').textContent.includes('改用下拉')
      })()`),
      '手動輸入切得過去、值帶得走'
    )
    await cdp.eval("document.getElementById('ccManualModelsBtn').click()")

    // 沒填 Base URL 不准存：錯誤要出現在填錯的地方，不是等到切換才報
    await cdp.eval("document.getElementById('ccBaseUrlInput').value = ''")
    await cdp.eval("document.getElementById('ccProviderSaveBtn').click()")
    await sleep(150)
    assert(
      await cdp.eval("document.getElementById('ccProviderDialog').open === true"),
      '自訂沒填端點時彈窗不會關掉'
    )
    assert(
      (await cdp.eval("document.getElementById('ccStatus').textContent")).includes('Base URL'),
      '自訂沒填端點有明講'
    )

    // 真的建一筆自訂的（走閘道那種），確認存得下來、清單看得到協議
    const customId = await cdp.eval(`(async () => {
      const r = await window.electronAPI.ccswitch.createProvider({
        presetId: 'custom', name: 'CDP 自訂測試', apiFormat: 'openai_chat',
        baseUrl: 'https://api.example.com/v1', apiKey: 'sk-cdp-test', model: 'demo-model'
      })
      return r.data?.id || ''
    })()`)
    assert(Boolean(customId), '建得出自訂供應商')
    const customSaved = await cdp.eval(`(async () => {
      const r = await window.electronAPI.ccswitch.listProviders()
      const item = (r.data?.providers || []).find((p) => p.id === ${JSON.stringify(customId)})
      return { item, raw: JSON.stringify(r.data?.providers || []) }
    })()`)
    assert(customSaved.item?.apiFormat === 'openai_chat', '協議存得下來', JSON.stringify(customSaved.item))
    assert(customSaved.item?.baseUrl === 'https://api.example.com/v1', '端點存得下來')
    // 路由是 main 算的：renderer 自己推的話會漏掉整組自訂供應商
    assert(customSaved.item?.route === 'gateway', '路由由 main 依協議算好', String(customSaved.item?.route))
    assert(!customSaved.raw.includes('sk-cdp-test'), '清單不含完整金鑰')
    await cdp.eval(`window.electronAPI.ccswitch.deleteProvider(${JSON.stringify(customId)})`)
    pass('自訂供應商收尾刪掉')
    // 彈窗還開著（剛才那次儲存被擋下來），重開之前要先關——對已開的 dialog 呼叫
    // showModal() 會丟 InvalidStateError
    await cdp.eval("document.getElementById('ccProviderCancelBtn').click()")
    // 下面整段講 Codex：從內建那張 tile 的編輯鈕進去
    await cdp.eval(
      `document.querySelector('#ccProviderList .cc-tile[data-id="${codexSeed.id}"] .cc-tile-edit').click()`
    )

    // ===== OAuth 登入區 =====
    // Codex／Grok 可以在本 App 直接登入；沒登入時仍要留「沿用 CLI 憑證」這條路
    assert(
      !(await cdp.eval("document.getElementById('ccOauthGroup').classList.contains('hidden')")),
      'Codex 顯示登入區'
    )
    const codexFormats = await cdp.eval(`(() => {
      const api = document.getElementById('ccApiFormatSelect')
      return {
        shown: !document.getElementById('ccApiFormatGroup').classList.contains('hidden'),
        api: api.value,
        options: [...api.options].map((option) => option.value)
      }
    })()`)
    assert(codexFormats.shown && codexFormats.api === 'openai_responses' &&
      codexFormats.options.join(',') === 'anthropic,openai_chat,openai_responses',
    'Codex 可手動選上游格式且預設 Responses', JSON.stringify(codexFormats))
    const oauthUi = await cdp.eval(`(() => {
      const select = document.getElementById('ccAccountSelect')
      return {
        fallback: select.options[0]?.value === '' && select.options[0]?.textContent.includes('CLI'),
        waitHidden: document.getElementById('ccOauthWait').classList.contains('hidden'),
        hasLoginBtn: Boolean(document.getElementById('ccLoginBtn'))
      }
    })()`)
    assert(oauthUi.fallback, '第一項是「使用已登入的 CLI 憑證」', JSON.stringify(oauthUi))
    assert(oauthUi.waitHidden, '還沒按登入時不顯示等待區')
    assert(oauthUi.hasLoginBtn, '有登入按鈕')
    // 帳號清單絕不可以帶出 token（IPC 層面驗一次，不只看畫面）
    const accountsResp = await cdp.eval("window.electronAPI.ccswitch.listAccounts()")
    assert(accountsResp?.ok === true, '帳號清單讀得到', JSON.stringify(accountsResp))
    assert(
      !/accessToken|refreshToken|"refresh_token"/.test(JSON.stringify(accountsResp.data)),
      '帳號清單不含任何 token'
    )
    // 型錄要講得出兩家各自是哪種流程（Codex 只能 PKCE，OpenAI 沒有 device code）
    const flows = await cdp.eval(`(async () => {
      const r = await window.electronAPI.ccswitch.catalog()
      return r.data?.oauthFlows || []
    })()`)
    assert(
      flows.find((f) => f.key === 'codex')?.kind === 'pkce' &&
      flows.find((f) => f.key === 'grok-build')?.kind === 'device',
      '兩家各自用官方支援的流程',
      JSON.stringify(flows)
    )
    const badLogin = await cdp.eval("window.electronAPI.ccswitch.beginLogin('nope')")
    assert(badLogin?.ok === false, '不認得的登入 provider 擋下來')
    // 等待區展開後不可以撐破彈窗（驗證碼是等寬大字，最容易溢出的就是它）
    const waitBox = await cdp.eval(`(() => {
      const wait = document.getElementById('ccOauthWait')
      const code = document.getElementById('ccOauthCode')
      wait.classList.remove('hidden')
      code.classList.remove('hidden')
      code.textContent = 'ABCD-1234'
      document.getElementById('ccOauthStep').textContent = '測試用文字'
      const body = document.querySelector('#ccProviderDialog .cc-dialog-body').getBoundingClientRect()
      const box = wait.getBoundingClientRect()
      const result = { within: box.left >= body.left - 1 && box.right <= body.right + 1, codeVisible: code.getBoundingClientRect().width > 0 }
      wait.classList.add('hidden')
      code.classList.add('hidden')
      code.textContent = ''
      return result
    })()`)
    assert(waitBox.within, '登入等待區沒有撐破彈窗', JSON.stringify(waitBox))
    assert(waitBox.codeVisible, '驗證碼顯示得出來')
    // 直連的供應商沒有登入區：換編輯 OpenRouter 那張 tile
    await cdp.eval("document.getElementById('ccProviderCancelBtn').click()")
    const orSeed = seeded.find((item) => item.presetId === 'openrouter')
    await cdp.eval(
      `document.querySelector('#ccProviderList .cc-tile[data-id="${orSeed.id}"] .cc-tile-edit').click()`
    )
    assert(
      await cdp.eval("document.getElementById('ccOauthGroup').classList.contains('hidden')"),
      '直連供應商不顯示登入區'
    )
    assert(
      await cdp.eval(`document.getElementById('ccApiFormatSelect').value === 'anthropic'`),
      'OpenRouter 可手動選格式且預設 Anthropic'
    )
    // 內建預設一律不顯示端點欄（連直連這幾家也不顯示）：表上的位址是實測查證過的事實，
    // 多一個輸入格只多一種「填錯了但看不出來」的失敗方式。用 `.hidden` 判不夠——
    // 作者規則壓得過 `[hidden]{display:none}`，要量 offsetHeight
    const builtinUrl = await cdp.eval(`(() => {
      const group = document.getElementById('ccBaseUrlGroup')
      return {
        hiddenClass: group.classList.contains('hidden'),
        height: group.offsetHeight,
        keyShown: document.getElementById('ccKeyGroup').offsetHeight > 0,
        modelShown: document.getElementById('ccModelGroup').offsetHeight > 0
      }
    })()`)
    assert(builtinUrl.hiddenClass && builtinUrl.height === 0,
      '內建供應商不顯示 Base URL 欄', JSON.stringify(builtinUrl))
    assert(builtinUrl.keyShown && builtinUrl.modelShown,
      '內建供應商仍留著金鑰與模型設定', JSON.stringify(builtinUrl))
    await cdp.eval("document.getElementById('ccProviderCancelBtn').click()")
    await cdp.eval(
      `document.querySelector('#ccProviderList .cc-tile[data-id="${codexSeed.id}"] .cc-tile-edit').click()`
    )
    // 四個等級各一格下拉；沒掃描前選項＝空值＋這家的預設
    const modelFields = await cdp.eval(`(() => {
      const ids = ['ccModelSelect', 'ccHaikuSelect', 'ccSonnetSelect', 'ccOpusSelect']
      return ids.map((id) => document.getElementById(id)?.options[0]?.textContent ?? null)
    })()`)
    assert(
      modelFields.length === 4 &&
        modelFields[0].includes('gpt-5.6-sol') && modelFields[1].includes('gpt-5.6-luna'),
      '四個模型等級各有一格下拉且帶這家預設',
      JSON.stringify(modelFields)
    )
    // 內容再高，「取消／儲存」都要留在彈窗裡；.app-dialog 是 overflow:hidden，
    // 中間那塊不會捲的話按鈕會被擠到看不見也滑不下去（實際出貨過）。
    // 壓成矮視窗才量得到——視窗夠高的話內容根本不會超過 86vh。
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1280, height: 560, deviceScaleFactor: 1, mobile: false
    })
    await sleep(80)
    const footer = await cdp.eval(`(() => {
      const dialog = document.getElementById('ccProviderDialog')
      const body = dialog.querySelector('.cc-dialog-body')
      const actions = dialog.querySelector('.dialog-actions')
      const measure = () => {
        const d = dialog.getBoundingClientRect()
        const a = actions.getBoundingClientRect()
        return {
          inside: a.bottom <= d.bottom + 1 && a.top >= d.top,
          visible: a.height > 0 && a.bottom <= window.innerHeight + 1
        }
      }
      // 先把修法拿掉量一次，確認這個視窗高度真的會重現「按鈕列被擠出去」，
      // 否則下面那組 PASS 只是因為內容剛好沒超過，等於什麼都沒驗到。
      body.style.overflowY = 'visible'
      body.style.flex = '0 0 auto'
      const broken = measure()
      body.style.overflowY = ''
      body.style.flex = ''
      const fixed = measure()
      return {
        reproduced: !broken.inside,
        actionsInside: fixed.inside,
        actionsVisible: fixed.visible,
        bodyScrolls: body.scrollHeight > body.clientHeight &&
          getComputedStyle(body).overflowY === 'auto',
        broken,
        fixed
      }
    })()`)
    assert(footer.reproduced, '矮視窗真的會擠爆按鈕列（沒修法時）', JSON.stringify(footer))
    assert(footer.actionsInside, '按鈕列沒有被擠出彈窗', JSON.stringify(footer))
    assert(footer.actionsVisible, '按鈕列在畫面內看得到', JSON.stringify(footer))
    assert(footer.bodyScrolls, '內容超出時中間那塊自己捲', JSON.stringify(footer))
    await cdp.send('Emulation.clearDeviceMetricsOverride')
    await cdp.eval("document.getElementById('ccProviderCancelBtn').click()")
    assert(
      await cdp.eval("document.getElementById('ccProviderDialog').open === false"),
      '取消關得掉彈窗'
    )

    // ===== 轉換閘道 =====
    // OpenAI 協議要經本機閘道。閘道不會因切換供應商自動啟動，只驗手動開關與 /health，
    // **不打真的上游**（那要花使用者的訂閱額度）。
    const gwProvider = await cdp.eval(
      "window.electronAPI.ccswitch.createProvider({ presetId: 'ollama-cloud', name: 'CDP 閘道測試', apiKey: 'k' })"
    )
    assert(gwProvider?.ok === true, '建得出需要閘道的供應商')
    createdId = gwProvider.data.id

    await cdp.eval("document.getElementById('ccRefreshBtn').click()")
    await waitFor(
      () => cdp.eval("!document.getElementById('ccGateway').classList.contains('hidden')"),
      10_000,
      '閘道狀態列出現'
    )
    const gatewayBefore = await cdp.eval('window.electronAPI.ccswitch.gatewayStatus()')
    assert(gatewayBefore?.ok === true && gatewayBefore.data.running === false,
      '新增需要閘道的供應商不會自動開閘道', JSON.stringify(gatewayBefore))
    assert(
      await cdp.eval("document.getElementById('ccGatewayToggleBtn').getAttribute('aria-checked') === 'false'"),
      '閘道關閉時開關是關閉狀態'
    )
    const activateWhileOff = await cdp.eval(
      `window.electronAPI.ccswitch.activateProvider(${JSON.stringify(createdId)})`
    )
    assert(activateWhileOff?.ok === false && activateWhileOff.error?.code === 'GATEWAY_OFFLINE',
      '閘道關閉時不會偷偷啟動，切換會明說要先開閘道', JSON.stringify(activateWhileOff))
    pass('閘道只由使用者手動開啟')

    await cdp.eval("document.getElementById('ccGatewayToggleBtn').click()")
    await waitFor(
      () => cdp.eval("document.getElementById('ccGatewayToggleBtn').getAttribute('aria-checked') === 'true'"),
      10_000,
      '按開關啟動閘道'
    )
    const started = await cdp.eval('window.electronAPI.ccswitch.gatewayStatus()')
    assert(started?.ok === true && started.data.running === true, '閘道啟動成功',
      JSON.stringify(started?.error || {}))
    assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(started.data.baseUrl), '閘道只綁 127.0.0.1',
      started.data.baseUrl)
    assert(typeof started.data.apiKey === 'string' && started.data.apiKey.length >= 32,
      '閘道有自己的金鑰')
    // 狀態不可以夾帶上游 token
    assert(!/access_token|refresh_token/.test(JSON.stringify(started.data)),
      '閘道狀態不含上游 token')

    const health = await new Promise((resolve) => {
      http.get(`${started.data.baseUrl}/health`, (res) => {
        let text = ''
        res.on('data', (chunk) => { text += chunk })
        res.on('end', () => resolve({ status: res.statusCode, text }))
      }).on('error', () => resolve({ status: 0, text: '' }))
    })
    assert(health.status === 200, '/health 回得出來（不需鑑權）', String(health.status))

    await cdp.eval("document.getElementById('ccGatewayToggleBtn').click()")
    await waitFor(
      () => cdp.eval("document.getElementById('ccGatewayToggleBtn').getAttribute('aria-checked') === 'false'"),
      10_000,
      '按開關停止閘道'
    )
    const stopped = await cdp.eval('window.electronAPI.ccswitch.gatewayStatus()')
    assert(stopped?.ok === true && stopped.data.running === false, '閘道停得掉')

    await cdp.eval(`window.electronAPI.ccswitch.deleteProvider(${JSON.stringify(createdId)})`)
    createdId = ''

    // ===== MCP 子分頁（唯讀，不寫使用者的 ~/.claude.json） =====
    await cdp.eval("document.querySelector('#ccSubtabs .subtab[data-subtab=\"mcp\"]').click()")
    assert(
      await cdp.eval("document.getElementById('cc-mcp').classList.contains('active')"),
      'MCP 子分頁切得過去'
    )
    await waitFor(
      () => cdp.eval("document.getElementById('ccMcpPath').textContent.includes('.claude.json')"),
      10_000,
      'MCP 顯示設定檔路徑'
    )
    pass('MCP 顯示設定檔路徑')
    const mcpCount = await cdp.eval("document.querySelectorAll('#ccMcpList .cc-row').length")
    const mcpEmptyHidden = await cdp.eval("!document.getElementById('ccMcpEmpty').classList.contains('hidden')")
    assert(mcpCount > 0 || mcpEmptyHidden, 'MCP 清單有內容或顯示空狀態', `rows=${mcpCount}`)

    // 範本會把名稱與定義填好
    await cdp.eval("document.getElementById('ccAddMcpBtn').click()")
    await cdp.eval(pickSelect('ccMcpTemplate', 'context7'))
    assert(
      await cdp.eval("document.getElementById('ccMcpIdInput').value === 'context7'"),
      '選範本會填好名稱'
    )
    assert(
      await cdp.eval("document.getElementById('ccMcpSpecInput').value.includes('context7-mcp')"),
      '選範本會填好定義'
    )
    // 壞 JSON 要擋在前端，不送 IPC
    await cdp.eval("document.getElementById('ccMcpSpecInput').value = '{ not json'")
    await cdp.eval("document.getElementById('ccMcpSaveBtn').click()")
    await sleep(300)
    assert(
      await cdp.eval("document.getElementById('ccMcpDialog').open === true"),
      '壞 JSON 不會關掉彈窗'
    )
    assert(
      await cdp.eval("document.getElementById('ccMcpSpecHint').textContent.includes('不是合法 JSON')"),
      '壞 JSON 有明確提示'
    )
    await cdp.eval("document.getElementById('ccMcpCancelBtn').click()")
    assert(
      await cdp.eval("document.getElementById('ccMcpDialog').open === false"),
      'MCP 彈窗取消關得掉'
    )

    // ===== CLI 版本子分頁（唯讀） =====
    await cdp.eval("document.querySelector('#ccSubtabs .subtab[data-subtab=\"version\"]').click()")
    await waitFor(
      () => cdp.eval("document.querySelectorAll('#ccVersionList .cc-row').length >= 5"),
      40_000,
      'CLI 版本清單'
    )
    pass('CLI 版本清單渲染出五個工具')
    const versionText = await cdp.eval("document.getElementById('ccVersionList').textContent")
    assert(versionText.includes('Claude Code'), '版本清單有 Claude Code')
    assert(versionText.includes('Antigravity CLI'), '版本清單有 Antigravity CLI')
    // 沒發 npm 的工具照樣有更新鈕（走它自己的 `agy update`），只有「本機找不到」才沒有
    const agyRow = await cdp.eval(`(() => {
      const row = document.querySelector('#ccVersionList .cc-row[data-tool="agy"]')
      return { buttons: row?.querySelectorAll('.cc-row-actions button').length ?? -1, text: row?.textContent || '' }
    })()`)
    assert(
      agyRow.buttons === (agyRow.text.includes('本機找不到') ? 0 : 1),
      'Antigravity 裝了就有更新鈕、沒裝就沒有',
      JSON.stringify(agyRow)
    )
    // 查不到最新版時不可以再顯示誤導人的「離線？」
    assert(!versionText.includes('離線'), '版本清單不再出現「離線？」')

    // 更新指令由 main 組出來，renderer 不自己拼字串；一律用各家自己的 updater
    const command = await cdp.eval("window.electronAPI.ccswitch.updateCommand('claude')")
    assert(
      command?.ok === true && command.data === 'claude update',
      '更新指令由 main 的固定表提供',
      JSON.stringify(command)
    )
    const agyCommand = await cdp.eval("window.electronAPI.ccswitch.updateCommand('agy')")
    assert(
      agyCommand?.ok === true && agyCommand.data === 'agy update',
      '沒發 npm 的工具走自己的 update 子指令',
      JSON.stringify(agyCommand)
    )
    const rejected = await cdp.eval("window.electronAPI.ccswitch.updateCommand('rm -rf /')")
    assert(rejected?.ok === false, '不認得的工具 key 拿不到指令')

    assert(cdp.exceptions.length === 0, 'renderer 沒有未捕捉例外', JSON.stringify(cdp.exceptions))

    console.log(`\nALL PASS  ${checks} checks`)
  } catch (error) {
    console.error(`\nFAILED  ${error.stack || error}`)
    console.error('Renderer exceptions:', JSON.stringify(cdp?.exceptions || []))
    console.error('Renderer console errors:', JSON.stringify(cdp?.consoleErrors || []))
    console.error('Process log:', processLog.slice(-8000))
    process.exitCode = 1
  } finally {
    // 中途失敗時把自己建的那筆刪掉，免得留在暫存 profile 裡（雖然整個資料夾等一下就砍了）
    if (createdId && cdp) {
      try {
        await cdp.eval(`window.electronAPI.ccswitch.deleteProvider(${JSON.stringify(createdId)})`)
      } catch { /* 收尾盡力而為 */ }
    }
    cdp?.close()
    stopTestApp(child)
    fs.rmSync(USER_DATA_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}

main()
