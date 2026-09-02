#!/usr/bin/env node
/**
 * VoiceInk — 「HF模型」分頁的打包版回歸（CDP）
 *
 * **這支不下載任何模型、也不打 Hugging Face**（搜尋要網路、下載動輒好幾 GB）：
 * 網路那一段由 `probe-hf-hub.js` 打真流量驗，router 生命週期由 `e2e-hfmodels.js` 驗。
 * 這裡只驗打包版的 UI 有沒有接對——三個子分頁、模型庫渲染、參數彈窗、
 * 執行環境資訊，以及幾條 UI 地雷（彈窗會不會捲、沒開的彈窗會不會浮出來、
 * 空的 `<dd>` 會不會讓整列塌掉）。
 *
 * 用暫存 `--user-data-dir`，收尾只以自己的 pid 收程序（禁止 `/IM VoiceInk.exe`）。
 * 模型庫指到暫存資料夾並種一顆真的 gguf 進去，**不碰使用者的模型**。
 */

'use strict'

const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')

const PORT = 9249
const EXE = process.env.VOICEINK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
const USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-e2e-hf-'))
/** 模型庫指到這裡（不是使用者的 hf-models） */
const MODELS_DIR = path.join(USER_DATA_DIR, 'hf-models-test')
/** 種進去的模型 id；用 `[data-id]` 指涉自己建的東西，不用「第一列」 */
const SEED_ID = 'E2E-HF-Probe-Q4_K_M'
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
 * 收掉測試自己開的那份 App。**絕對不能用 `/IM VoiceInk.exe`**：
 * 那會把使用者自己開著的安裝版一起關掉。
 * @param {import('child_process').ChildProcess | null} child
 */
function stopTestApp(child) {
  if (child?.pid) {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch { /* 程序已結束 */ }
  }
  for (const name of ['VoiceInk.exe', 'llama-server.exe']) {
    try {
      execFileSync('powershell', [
        '-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='${name}'" |` +
        // -like 的萬用字元只有 * 與 ?，反斜線是字面值，不要再跳脫
        ` Where-Object { $_.CommandLine -like '*${USER_DATA_DIR}*' } |` +
        ' ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
      ], { stdio: 'ignore' })
    } catch { /* 沒有殘留 */ }
  }
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
    await this.send('Page.enable')
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

/**
 * 種一顆**真的** GGUF 到測試模型庫。
 *
 * 拿使用者已裝的最小那顆做 hard link（同碟不佔空間，跨碟就複製）——
 * 不合成假檔：`gguf.readInfo` 讀不出架構的話整張卡的參數區都是空的，
 * 那就等於沒驗到「參數怎麼顯示」。
 * @returns {boolean} 有沒有種成功
 */
function seedModel() {
  const root = path.join(process.env.APPDATA || os.homedir(), 'voiceink', 'models')
  const candidates = [
    path.join(root, 'linguaforge08q4', 'gguf-v5e', 'linguaforge-v5e-0.8b-Q4_K_M.gguf'),
    path.join(root, 'qwen35translate', 'Qwen3.5-0.8B-Q4_K_M.gguf'),
    path.join(root, 'qwen354b', 'Qwen3.5-4B-Q4_K_M.gguf')
  ]
  const source = candidates.find((p) => fs.existsSync(p))
  if (!source) return false
  const dir = path.join(MODELS_DIR, SEED_ID)
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, path.basename(source))
  try { fs.linkSync(source, target) } catch { fs.copyFileSync(source, target) }
  fs.writeFileSync(
    path.join(dir, 'voiceink-meta.json'),
    JSON.stringify({ source: 'e2e', repoId: 'e2e/probe', quant: 'Q4_K_M', multimodal: false }, null, 2)
  )
  return true
}

async function main() {
  const seeded = seedModel()
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
  const seedSel = JSON.stringify(SEED_ID)

  try {
    const target = await waitFor(async () => {
      const pages = await getJson(`http://127.0.0.1:${PORT}/json/list`).catch(() => [])
      // 語音輸入的指示器也是 page target，一律用 index.html 挑主視窗
      return pages.find((page) => page.type === 'page' && /index\.html/.test(page.url)) || null
    }, 30_000, '主視窗')
    cdp = new Cdp(target.webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Page.bringToFront', {})
    await waitFor(
      () => cdp.eval("document.readyState === 'complete' && typeof window.electronAPI?.hfmodels?.list === 'function'"),
      20_000,
      'preload 初始化'
    )

    // 模型庫指到暫存資料夾。**要在進頁之前**，不然第一次 list 會掃到使用者真的模型
    await cdp.eval(`window.electronAPI.store.set('hfModelsDir', ${JSON.stringify(MODELS_DIR)})`)

    console.log('\n[A] nav 與子分頁')
    await cdp.eval("document.querySelector('[data-page=\"hfmodels\"]').click(), 'ok'")
    const structure = await waitFor(() => cdp.eval(`(() => {
      const page = document.getElementById('page-hfmodels')
      if (!page || !page.classList.contains('active')) return null
      return {
        order: [...document.querySelectorAll('.header-nav .nav-tab')].map((item) => item.dataset.page),
        subtabs: [...document.querySelectorAll('#hfSubtabs .subtab')].map((el) => el.dataset.subtab),
        activePanels: [...document.querySelectorAll('#page-hfmodels .subtab-panel.active')].map((el) => el.id)
      }
    })()`), 15_000, 'HF模型頁')
    assert(structure.order.includes('hfmodels'), 'nav 有 HF模型分頁', JSON.stringify(structure.order))
    assert(
      JSON.stringify(structure.subtabs) === JSON.stringify(['discover', 'library', 'runtime']),
      '三個子分頁：探索／模型庫／執行環境',
      JSON.stringify(structure.subtabs)
    )
    assert(
      structure.activePanels.length === 1 && structure.activePanels[0] === 'hf-discover',
      '同時只有一個子分頁 active（兩個一起 active 會疊在一起）',
      JSON.stringify(structure.activePanels)
    )

    // 頂層面板要是 12px radius ＋ blur 的 glass（跟 e2e-visual-cdp 的 SIGNATURES 同一條規矩）
    const glass = await cdp.eval(`(() => {
      const el = document.querySelector('#page-hfmodels .hf-panel')
      if (!el) return null
      const s = getComputedStyle(el)
      return {
        radius: parseFloat(s.borderTopLeftRadius),
        blur: s.backdropFilter || s.webkitBackdropFilter || '',
        h: el.offsetHeight
      }
    })()`)
    assert(
      glass && glass.radius >= 10 && /blur/.test(glass.blur) && glass.h > 0,
      '頂層面板是 glass（radius ≥ 10px ＋ blur）且量得到高度',
      JSON.stringify(glass)
    )

    console.log('\n[B] 模型庫')
    await cdp.eval("document.querySelector('#hfSubtabs .subtab[data-subtab=\"library\"]').click(), 'ok'")
    if (seeded) {
      const card = await waitFor(() => cdp.eval(`(() => {
        const el = document.querySelector('#hfLibraryList .hf-model[data-id=${seedSel}]')
        if (!el) return null
        return {
          chips: [...el.querySelectorAll('.hf-chip')].map((c) => c.textContent),
          actions: [...el.querySelectorAll('.hf-model-actions .btn')].map((b) => b.textContent),
          h: el.offsetHeight,
          status: el.querySelector('.hf-status')?.textContent,
          nameOverflow: (() => {
            const n = el.querySelector('.hf-model-name')
            return n ? getComputedStyle(n).textOverflow : ''
          })()
        }
      })()`), 25_000, '種進去的模型出現在清單')
      assert(card.h > 0, '模型卡量得到高度（不是 0 高的塌掉列）', String(card.h))
      assert(card.chips.some((c) => /qwen/i.test(c)), '有顯示架構', JSON.stringify(card.chips))
      assert(card.chips.some((c) => /Q4_K_M/.test(c)), '有顯示量化', JSON.stringify(card.chips))
      assert(card.chips.some((c) => /MB|GB/.test(c)), '有顯示檔案大小', JSON.stringify(card.chips))
      assert(card.chips.some((c) => /ctx 上限/.test(c)), '有顯示 context 上限', JSON.stringify(card.chips))
      // 模型 id 很長又沒有空白可斷，截成「…」等於看不出是哪一顆
      assert(card.nameOverflow !== 'ellipsis', '模型名不用 ellipsis 截斷', card.nameOverflow)
      // hover 才出現的操作等於沒有（觸控裝置沒有 hover）
      assert(
        ['載入', '參數', '刪除'].every((label) => card.actions.includes(label)),
        '載入／參數／刪除都是常駐按鈕',
        JSON.stringify(card.actions)
      )
      assert(card.status === '未載入', '狀態徽章顯示未載入', String(card.status))

      console.log('\n[C] 參數彈窗')
      await cdp.eval(`(() => {
        const el = document.querySelector('#hfLibraryList .hf-model[data-id=${seedSel}]')
        const btn = [...el.querySelectorAll('.hf-model-actions .btn')].find((b) => b.textContent === '參數')
        btn.click()
      })()`)
      const dialog = await waitFor(() => cdp.eval(`(() => {
        const d = document.getElementById('hfParamsDialog')
        if (!d?.open) return null
        const body = d.querySelector('.hf-dialog-body')
        const bs = getComputedStyle(body)
        const actions = d.querySelector('.dialog-actions')
        return {
          title: document.getElementById('hfParamsTitle').textContent,
          overflowY: bs.overflowY,
          padLeft: parseFloat(bs.paddingLeft),
          // 「取消／儲存」有沒有被擠出可視範圍
          actionsBottom: Math.round(actions.getBoundingClientRect().bottom),
          dialogBottom: Math.round(d.getBoundingClientRect().bottom),
          preview: document.getElementById('hfParamsPreview').textContent,
          ctxPlaceholder: document.getElementById('hfFieldCtx').placeholder,
          ctkOptions: [...document.getElementById('hfFieldCtk').options].map((o) => o.value)
        }
      })()`), 10_000, '參數彈窗打開')
      assert(dialog.title.includes(SEED_ID), '標題帶模型名', dialog.title)
      assert(dialog.overflowY === 'auto', '彈窗 body 會捲（否則按鈕被擠出去）', dialog.overflowY)
      assert(dialog.padLeft >= 20, '彈窗 body 有自己的左右留白', String(dialog.padLeft))
      assert(
        dialog.actionsBottom <= dialog.dialogBottom + 1,
        '「取消／儲存」在可視範圍內',
        JSON.stringify({ actions: dialog.actionsBottom, dialog: dialog.dialogBottom })
      )
      assert(/--ctx-size/.test(dialog.preview), '有顯示實際會送出的參數', dialog.preview)
      assert(/自動：\d+/.test(dialog.ctxPlaceholder), '空欄位的 placeholder 顯示自動值', dialog.ctxPlaceholder)
      assert(
        dialog.ctkOptions[0] === '' && dialog.ctkOptions.includes('q8_0'),
        'KV 檔位選單有「自動」與量化選項',
        JSON.stringify(dialog.ctkOptions)
      )

      // 覆寫一項存回去，再讀一次看有沒有真的套上
      await cdp.eval(`(() => {
        document.getElementById('hfFieldCtx').value = '4096'
        document.getElementById('hfParamsSaveBtn').click()
      })()`)
      const saved = await waitFor(() => cdp.eval(`(async () => {
        if (document.getElementById('hfParamsDialog').open) return null
        const r = await window.electronAPI.hfmodels.list()
        const m = (r.data || []).find((x) => x.id === ${seedSel})
        return m ? { requested: m.meta?.requested || {}, args: m.args || {} } : null
      })()`), 40_000, '參數存回去')
      assert(saved.requested.ctxSize === 4096, '覆寫的上下文有存起來', JSON.stringify(saved.requested))
      assert(saved.args['ctx-size'] === '4096', '覆寫的值真的進到送出的參數', JSON.stringify(saved.args))

      // 原始參數直通：這是「比 LM Studio 自由」的那一項
      await cdp.eval(`window.electronAPI.hfmodels.updateSettings(${seedSel}, { rawArgs: 'ubatch-size = 160' })`)
      const rawApplied = await waitFor(() => cdp.eval(`(async () => {
        const r = await window.electronAPI.hfmodels.list()
        const m = (r.data || []).find((x) => x.id === ${seedSel})
        return m?.args?.['ubatch-size'] === '160' ? m.args : null
      })()`), 30_000, '原始參數套上')
      assert(!!rawApplied, '原始參數直通到送出的參數', JSON.stringify(rawApplied))

      // 還原，免得留著影響後面的斷言
      await cdp.eval(`window.electronAPI.hfmodels.updateSettings(${seedSel}, { requested: {}, rawArgs: '' })`)
    } else {
      console.log('  SKIP  本機沒有可種的 GGUF，模型庫與參數彈窗這段跳過')
    }

    console.log('\n[D] 執行環境')
    await cdp.eval("document.querySelector('#hfSubtabs .subtab[data-subtab=\"runtime\"]').click(), 'ok'")
    const runtime = await waitFor(() => cdp.eval(`(() => {
      const specs = document.getElementById('hfHardwareSpecs')
      if (!specs || !specs.children.length) return null
      return {
        rows: [...specs.children].map((row) => ({
          label: row.querySelector('dt')?.textContent || '',
          value: row.querySelector('dd')?.textContent || '',
          // 空的 <dd> 沒有 inline content，grid item 高度會是 0、整列在版面上塌掉
          h: row.offsetHeight
        })),
        runtimeItems: document.querySelectorAll('#hfRuntimeList .hf-setting-row').length,
        modelsDir: document.getElementById('hfModelsDirText').textContent,
        chip: document.getElementById('hfRuntimeText').textContent
      }
    })()`), 25_000, '硬體資訊')
    assert(
      runtime.rows.every((r) => r.h > 0),
      '規格列沒有 0 高的（空 dd 會整列塌掉）',
      JSON.stringify(runtime.rows.filter((r) => !r.h))
    )
    assert(
      runtime.rows.every((r) => r.value.trim()),
      '每一列都有值（沒值也要給破折號）',
      JSON.stringify(runtime.rows.filter((r) => !r.value.trim()))
    )
    assert(
      runtime.rows.some((r) => /推論後端/.test(r.label)),
      '有列出推論後端',
      JSON.stringify(runtime.rows.map((r) => r.label))
    )
    assert(runtime.runtimeItems >= 2, '推論引擎列出 Vulkan 與 CUDA 兩種', String(runtime.runtimeItems))
    // 「一鍵安裝最佳配置」：按鈕要在、要有字，而且旁邊要講清楚會裝哪一顆、為什麼
    const autoInstall = await cdp.eval(`(() => {
      const btn = document.getElementById('hfAutoInstallBtn')
      const hint = document.getElementById('hfAutoInstallHint')
      return {
        text: btn ? btn.textContent.trim() : '',
        h: btn ? btn.offsetHeight : 0,
        hint: hint ? hint.textContent.trim() : ''
      }
    })()`)
    assert(autoInstall.h > 0 && autoInstall.text.length > 0, '一鍵安裝按鈕看得到', JSON.stringify(autoInstall))
    assert(autoInstall.hint.length > 0, '有講會裝哪一顆（或已經是最佳）', autoInstall.hint)
    assert(runtime.modelsDir.includes('hf-models-test'), '模型資料夾指到測試資料夾（沒碰使用者的）', runtime.modelsDir)
    assert(/未啟動|執行中/.test(runtime.chip), 'router 狀態徽章有字', runtime.chip)

    // token 只寫不讀：畫面與 store 兩邊都不該撈得到
    await cdp.eval(`(() => {
      document.getElementById('hfTokenInput').value = 'hf_e2e_secret_token'
      document.getElementById('hfTokenSaveBtn').click()
    })()`)
    const tokenState = await waitFor(() => cdp.eval(`(async () => {
      const input = document.getElementById('hfTokenInput')
      if (input.value !== '') return null
      const status = await window.electronAPI.hfmodels.tokenStatus()
      return { value: input.value, placeholder: input.placeholder, hasToken: status.data?.hasToken }
    })()`), 10_000, 'token 儲存')
    assert(tokenState.hasToken === true, 'token 存得起來')
    assert(tokenState.value === '', '存完就清空輸入框')
    assert(!/hf_e2e_secret_token/.test(tokenState.placeholder), 'token 不會回填到畫面上', tokenState.placeholder)
    // `hfToken` 刻意不在 STORE_ALLOWLIST 裡：renderer 連問都不該問得到，
    // 所以正確行為是 `store:get` 直接拋「不允許的設定鍵」而不是回一個值
    const leaked = await cdp.eval(`(async () => {
      try {
        return { value: await window.electronAPI.store.get('hfToken', '__none__') }
      } catch (error) {
        return { rejected: String(error && error.message || error) }
      }
    })()`)
    assert(
      !!leaked.rejected && /hfToken/.test(leaked.rejected),
      'token 不在 store allowlist 裡（renderer 連讀都被擋）',
      JSON.stringify(leaked)
    )
    await cdp.eval("window.electronAPI.hfmodels.setToken('')")

    console.log('\n[E] 探索頁')
    await cdp.eval("document.querySelector('#hfSubtabs .subtab[data-subtab=\"discover\"]').click(), 'ok'")
    const discover = await cdp.eval(`(() => {
      const bar = document.querySelector('#page-hfmodels .hf-searchbar')
      const input = document.getElementById('hfSearchInput')
      const sort = document.getElementById('hfSearchSort')
      const btn = document.getElementById('hfSearchBtn')
      const split = document.querySelector('#page-hfmodels .hf-split')
      const detail = document.getElementById('hfDetail')
      return {
        h: bar ? bar.offsetHeight : 0,
        placeholder: input ? input.placeholder : '',
        sorts: [...(sort ? sort.options : [])].map((o) => o.value),
        overflow: bar ? bar.scrollWidth - bar.clientWidth : -1,
        btn: btn ? { w: btn.offsetWidth, h: btn.offsetHeight } : null,
        columns: split ? getComputedStyle(split).gridTemplateColumns.split(' ').length : 0,
        detailH: detail ? detail.offsetHeight : 0
      }
    })()`)
    assert(discover.h > 0, '搜尋列量得到高度', String(discover.h))
    assert(/owner\/repo/.test(discover.placeholder), '提示可以直接貼 owner/repo', discover.placeholder)
    assert(
      JSON.stringify(discover.sorts) === JSON.stringify(['downloads', 'likes', 'lastModified']),
      '排序選項三種',
      JSON.stringify(discover.sorts)
    )
    assert(discover.overflow <= 1, '搜尋列沒有水平溢出', String(discover.overflow))
    // 曾經壞在這裡：custom-select 接管之後 flex 子項換成 .custom-select，
    // 「搜尋」被擠成一條，文字直排疊在排序下拉上面。寬 > 高才代表它是正常橫排的按鈕。
    assert(
      discover.btn && discover.btn.w > discover.btn.h,
      '搜尋按鈕沒有被擠成直排',
      JSON.stringify(discover.btn)
    )
    assert(discover.columns === 2, '探索是左清單右模型卡兩欄', String(discover.columns))
    assert(discover.detailH > 0, '模型卡面板量得到高度', String(discover.detailH))

    console.log('\n[F] 沒開的彈窗不可以浮出來')
    // `.app-dialog` 寫了 display 就必須帶 `[open]`，否則沒開的彈窗會全部疊在頁面上。
    // **只斷言 `dialog.open === false` 抓不到**，要量 offsetHeight。
    const floating = await cdp.eval(`(() => (
      [...document.querySelectorAll('dialog.app-dialog')]
        .filter((d) => !d.open && d.offsetHeight > 0)
        .map((d) => d.id)
    ))()`)
    assert(floating.length === 0, '所有沒開的彈窗高度都是 0', JSON.stringify(floating))

    console.log('\n[G] 640px 下不溢出')
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 640, height: 900, deviceScaleFactor: 1, mobile: false
    })
    await sleep(500)
    const narrow = await cdp.eval(`(() => {
      const page = document.getElementById('page-hfmodels')
      return {
        body: document.body.scrollWidth - document.body.clientWidth,
        page: page.scrollWidth - page.clientWidth
      }
    })()`)
    assert(narrow.body <= 1 && narrow.page <= 1, '640px 下沒有水平溢出', JSON.stringify(narrow))
    await cdp.send('Emulation.clearDeviceMetricsOverride', {})

    assert(cdp.exceptions.length === 0, 'renderer 沒有未捕捉例外', JSON.stringify(cdp.exceptions))

    console.log(`\nALL PASS  ${checks} checks`)
  } catch (error) {
    console.error(`\nFAILED  ${error.stack || error}`)
    console.error('Renderer exceptions:', JSON.stringify(cdp?.exceptions || []))
    console.error('Renderer console errors:', JSON.stringify(cdp?.consoleErrors || []))
    console.error('Process log:', processLog.slice(-6000))
    process.exitCode = 1
  } finally {
    cdp?.close()
    stopTestApp(child)
    fs.rmSync(USER_DATA_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}

main()
