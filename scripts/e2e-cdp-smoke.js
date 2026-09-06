/**
 * 打包版 CDP 煙霧測試：分頁、設定、字幕窗
 * 用法：先啟動 dist/win-unpacked/VoiceInk.exe --remote-debugging-port=9229
 *      再 node scripts/e2e-cdp-smoke.js
 * 或本腳本自動啟動。
 */
const { spawn } = require('child_process')
const path = require('path')
const os = require('os')
const fs = require('fs')
const http = require('http')

const PORT = 9235
// 暫存 user-data-dir：使用者正在用（常駐）的 App 佔著 single-instance lock，
// 沒有自己的資料夾會被它擋掉（second-instance 轉交後退出，CDP 連不上）
const USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-smoke-'))
// 模型 registry 在 userData/models（正式環境 7GB）。暫存環境用 junction 接過去，
// 翻譯那段才跑得起來；junction 刪掉不動原資料夾。
const REAL_MODELS = path.join(process.env.APPDATA, 'voiceink', 'models')
try {
  if (fs.existsSync(REAL_MODELS) && !fs.existsSync(path.join(USER_DATA_DIR, 'models'))) {
    fs.symlinkSync(REAL_MODELS, path.join(USER_DATA_DIR, 'models'), 'junction')
  }
} catch { /* 建不出來就沒模型，翻譯那段會以 FAIL 收場，其餘不受影響 */ }
// Windows 偶爾會有別的東西鎖住 dist/win-unpacked（打包失敗、防毒掃描中），
// 這時可以打包到別的資料夾再用 VOICEINK_EXE 指過去，測試不必等鎖放掉
const EXE = process.env.VOICEINK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')

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
  }
  async connect() {
    const WebSocket = globalThis.WebSocket
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
      // description 才有真正的錯誤與堆疊；text 多半只是 'Uncaught'
      const d = r.exceptionDetails
      throw new Error(d.exception?.description || d.exception?.value || d.text || 'eval error')
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

async function main() {
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA_DIR}`], {
    stdio: 'ignore',
    detached: false
  })

  const results = []
  const ok = (name, pass, detail = '') => {
    results.push({ name, pass: !!pass, detail })
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  }

  try {
    await sleep(2500)
    const pages = await waitTargets()
    // 只認 index.html：語音輸入開著時會多一扇指示器視窗（dictation-hud.html），
    // 而它的路徑同樣含有 "VoiceInk"，用路徑關鍵字比對會抓到那一扇
    const mainPage = pages.find((p) => /index\.html/i.test(p.url))
    ok('main page target', !!mainPage, mainPage?.url)

    const cdp = new Cdp(mainPage.webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Runtime.enable')

    // sandbox + preload：electronAPI 必須存在
    const hasApi = await cdp.eval('typeof window.electronAPI === "object"')
    ok('electronAPI exposed (sandbox ok)', hasApi === true)

    const hasStore = await cdp.eval('typeof window.electronAPI.store?.get === "function"')
    ok('store API', hasStore === true)

    // store allowlist：非法 key 應 reject
    const badKey = await cdp.eval(`
      (async () => {
        try {
          await window.electronAPI.store.get('__evil__', null)
          return 'no-throw'
        } catch (e) {
          return String(e.message || e)
        }
      })()
    `)
    ok('store reject unknown key', /不允許/.test(String(badKey)), String(badKey))

    const visualShell = await cdp.eval(`(() => {
      const root = document.documentElement
      const body = getComputedStyle(document.body)
      const header = getComputedStyle(document.querySelector('.header'))
      return {
        logoBars: document.querySelectorAll('.brand-mark-bar').length,
        font: body.fontFamily,
        radius: getComputedStyle(root).getPropertyValue('--radius-card').trim(),
        surface: getComputedStyle(root).getPropertyValue('--surface-glass').trim(),
        headerBackdrop: header.backdropFilter || header.webkitBackdropFilter || ''
      }
    })()`)
    ok(
      'Token Anxiety visual shell',
      visualShell.logoBars === 3 &&
        /Segoe UI/.test(visualShell.font) &&
        visualShell.radius === '12px' &&
        !!visualShell.surface &&
        /blur/.test(visualShell.headerBackdrop),
      JSON.stringify(visualShell)
    )

    // ===== 額度儀錶板 =====
    const usageUi = await cdp.eval(`(async () => {
      const order = [...document.querySelectorAll('.header-nav .nav-tab')]
        .map((item) => item.dataset.page)
      const chatWasDefault = document.getElementById('page-chat')?.classList.contains('active') === true
      const usageTab = document.querySelector('[data-page="usage"]')
      usageTab?.click()
      for (let attempt = 0; attempt < 15; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 200))
        if (document.querySelectorAll('#usageGrid .usage-card').length) break
        usageTab?.click()
      }
      const usageState = await window.electronAPI.usage.load()
      return {
        order,
        chatWasDefault,
        hasApi: typeof window.electronAPI.usage?.load === 'function',
        active: document.getElementById('page-usage')?.classList.contains('active') === true,
        hasSync: !!document.getElementById('usageSyncBtn'),
        hasGrid: !!document.getElementById('usageGrid'),
        hasSettings: !!document.getElementById('usageSettingsDialog'),
        hasDiagnostics: !!document.getElementById('usageDiagnosticsDialog'),
        accounts: usageState.data.accounts.length,
        visible: usageState.data.settings.visibleProviders.length,
        cards: document.querySelectorAll('#usageGrid .usage-card').length
      }
    })()`)
    ok(
      'eight-tab order + usage page structure',
      JSON.stringify(usageUi?.order) === JSON.stringify([
        'chat', 'ccswitch', 'usage', 'agy', 'stt', 'translate', 'sysmon', 'hfmodels', 'settings'
      ]) &&
        usageUi.hasApi &&
        usageUi.active &&
        usageUi.hasSync &&
        usageUi.hasGrid &&
        usageUi.hasSettings &&
        usageUi.hasDiagnostics &&
        usageUi.accounts === 7 &&
        usageUi.cards === usageUi.visible,
      JSON.stringify(usageUi)
    )

    // ===== 聊天頁 =====
    const chatDefault = usageUi.chatWasDefault
    ok('chat is default page', chatDefault === true)

    // 走 UI 建立新對話，再用 IPC 清掉，不留殘渣在使用者的 chats.json
    const chatUi = await cdp.eval(`(async () => {
      document.querySelector('[data-page="chat"]')?.click()
      await new Promise(r => setTimeout(r, 400))
      // 暫存 user-data-dir 是全新環境：先種一組供應商，模型選單才有東西
      await window.electronAPI.store.set('chatProviders', [
        { id: 'smoke_prov', name: '煙霧測試', apiUrl: 'https://example.invalid/v1', apiKey: 'k', models: ['m-one', 'm-two'] }
      ])
      document.querySelector('[data-page="settings"]')?.click()
      await new Promise(r => setTimeout(r, 250))
      document.querySelector('[data-page="chat"]')?.click()
      await new Promise(r => setTimeout(r, 400))
      const before = (await window.electronAPI.chat.list()).length
      document.getElementById('chatNewBtn')?.click()
      await new Promise(r => setTimeout(r, 600))
      const list = await window.electronAPI.chat.list()
      const created = list.find(c => c.messageCount === 0)
      if (created) await window.electronAPI.chat.delete(created.id)
      return {
        active: document.getElementById('page-chat')?.classList.contains('active'),
        modelCount: document.getElementById('chatModelSelect')?.options.length || 0,
        modelValue: document.getElementById('chatModelSelect')?.value || '',
        grew: list.length > before,
        hasInput: !!document.getElementById('chatInput'),
        hasSend: document.getElementById('chatSendBtn')?.textContent === '送出',
        sidebarRendered: !!document.querySelector('#chatList .chat-list-item')
      }
    })()`)
    ok(
      'chat page usable',
      chatUi?.active &&
        chatUi.modelCount >= 1 &&
        !!chatUi.modelValue &&
        chatUi.grew &&
        chatUi.hasInput &&
        chatUi.hasSend &&
        chatUi.sidebarRendered,
      JSON.stringify(chatUi)
    )

    // markdown.js 在真實 DOM 下的行為（打包版跑的是 src/ 原碼）
    const md = await cdp.eval(`(async () => {
      const m = await import('./scripts/markdown.js')
      const host = document.createElement('div')
      const sample = [
        '# 標題',
        '',
        '<img src=x onerror=alert(1)> 與 [壞連結](javascript:alert(1))',
        '',
        '~~~js',
        'const a = 1',
        '~~~',
        '',
        '| a | b |',
        '|---|---|',
        '| 1 | 2 |'
      ].join('\\n')
      host.appendChild(m.renderMarkdown(sample))
      return {
        imgs: host.querySelectorAll('img').length,
        links: host.querySelectorAll('a').length,
        h1: host.querySelectorAll('h1').length,
        codeBlocks: host.querySelectorAll('.md-code code').length,
        copyBtns: host.querySelectorAll('.md-copy').length,
        tables: host.querySelectorAll('table').length,
        keepsRawText: host.textContent.includes('onerror')
      }
    })()`)
    ok(
      'markdown renderer (no XSS, blocks render)',
      md?.imgs === 0 &&
        md.links === 0 &&
        md.h1 === 1 &&
        md.codeBlocks === 1 &&
        md.copyBtns === 1 &&
        md.tables === 1 &&
        md.keepsRawText === true,
      JSON.stringify(md)
    )

    // 切到語音轉文字分頁（檔案轉錄與即時字幕已合併成子分頁）
    await cdp.eval(`document.querySelector('[data-page="stt"]')?.click()`)
    await sleep(500)
    const sttPage = await cdp.eval(`(() => {
      const page = document.getElementById('page-stt')
      return {
        active: page?.classList.contains('active') === true,
        subtabs: document.querySelectorAll('#sttSubtabs .subtab').length,
        activePanels: document.querySelectorAll('#page-stt .subtab-panel.active').length,
        defaultPanel: document.querySelector('#page-stt .subtab-panel.active')?.id || '',
        hasAsrSelect: !!document.getElementById('fileAsrModel'),
        hasLlmSelect: !!document.getElementById('fileLlmModel'),
        // 三個子分頁各自的 ASR 選單都要在
        perTabAsr: ['fileAsrModel', 'liveAsrModel', 'dictationAsrModel']
          .every((id) => !!document.getElementById(id)),
        noOldPages: !document.getElementById('page-transcribe') && !document.getElementById('page-live')
      }
    })()`)
    ok(
      'stt page merges file + live + dictation into subtabs',
      sttPage?.active && sttPage.subtabs === 3 && sttPage.activePanels === 1 &&
        sttPage.defaultPanel === 'stt-file' && sttPage.hasAsrSelect && sttPage.hasLlmSelect &&
        sttPage.perTabAsr &&
        sttPage.noOldPages,
      JSON.stringify(sttPage)
    )

    // 切到即時字幕子分頁：只有它是 active
    const liveSub = await cdp.eval(`(() => {
      document.querySelector('#sttSubtabs [data-subtab="live"]')?.click()
      return {
        panel: document.querySelector('#page-stt .subtab-panel.active')?.id || '',
        count: document.querySelectorAll('#page-stt .subtab-panel.active').length,
        // 顯示模式 segmented 已搬到字幕窗，這頁不該再有
        noSeg: !document.querySelector('#stt-live .segmented, #captionDisplayMode, #displayModeSegment')
      }
    })()`)
    ok(
      'live subtab switches and has no display-mode segment',
      liveSub?.panel === 'stt-live' && liveSub.count === 1 && liveSub.noSeg === true,
      JSON.stringify(liveSub)
    )

    // 設定為第四分頁（非彈窗）
    await cdp.eval(`document.querySelector('[data-page="settings"]')?.click()`)
    await sleep(400)
    const settingsActive = await cdp.eval(
      `document.getElementById('page-settings')?.classList.contains('active')`
    )
    ok('switch to settings page', settingsActive === true)

    const settingsUi = await cdp.eval(`
      (() => {
        const page = document.getElementById('page-settings')
        const text = page?.innerText || ''
        return {
          noModal: !document.getElementById('settingsPanel'),
          // 後端選擇已搬到各功能頁的模型選單，設定頁不該再有這兩個 segmented
          noTranslatorSeg: !document.getElementById('translatorSegment'),
          noAsrEngineSeg: !document.getElementById('asrEngineSegment'),
          // 翻譯的雲端端點已併進聊天供應商，不該再有第二份 URL／Key 欄位
          noSeparateTranslate: !document.getElementById('apiUrlInput'),
          hasCloudAsr: !!document.getElementById('asrApiUrlInput'),
          hasCloudChat: !!document.getElementById('chatApiUrlInput'),
          hasTtsRate: !!document.getElementById('ttsRateInput'),
          hasTtsPreview: document.querySelectorAll('.tts-preview-btn').length === 5,
          hasModelList: !!document.getElementById('modelList'),
          navSections: [...document.querySelectorAll('#settingsNav .settings-nav-item')]
            .map((b) => b.dataset.section),
          activeSections: document.querySelectorAll('#page-settings .settings-section.active').length,
          hasFooterSave: !!document.getElementById('saveSettingsBtn'),
          textHasModels: /模型/.test(text)
        }
      })()
    `)
    ok(
      'settings page structure',
      settingsUi?.noModal &&
        settingsUi?.noTranslatorSeg &&
        settingsUi?.noAsrEngineSeg &&
        settingsUi?.noSeparateTranslate &&
        settingsUi?.hasCloudAsr &&
        settingsUi?.hasCloudChat &&
        settingsUi?.hasTtsRate &&
        settingsUi?.hasTtsPreview &&
        settingsUi?.hasModelList &&
        JSON.stringify(settingsUi?.navSections) ===
          JSON.stringify(['local', 'cloud', 'voice', 'basic']) &&
        settingsUi?.activeSections === 1 &&
        settingsUi?.hasFooterSave,
      JSON.stringify(settingsUi)
    )

    // 模型清單是 renderer 唯一改寫成 createElement 的地方（原本是 innerHTML 插值），
    // 結構壞掉會讓下載按鈕與進度條整排失效——CSS 與 onModelProgress 都靠這些 class 定位
    const modelItems = await cdp.eval(`(() => {
      const items = [...document.querySelectorAll('#modelList .model-item')]
      if (!items.length) return { count: 0 }
      const first = items[0]
      const name = first.querySelector('.model-name')
      return {
        count: items.length,
        withKey: items.filter((el) => !!el.dataset.key).length,
        withRow: items.filter((el) => !!el.querySelector('.model-row')).length,
        withName: items.filter((el) => (el.querySelector('.model-name')?.textContent || '').trim().length > 0).length,
        // 類別改由分組標題呈現，每列不再重複掛一顆同義的 tag
        groups: [...document.querySelectorAll('#modelList .model-group-title')].map((el) => el.textContent),
        noPerRowTag: !document.querySelector('#modelList .model-tag'),
        withSize: items.filter((el) => (el.querySelector('.model-size')?.textContent || '').trim().length > 0).length,
        withButton: items.filter((el) => !!el.querySelector('.model-actions .btn')).length,
        withProgress: items.filter((el) => !!el.querySelector('.model-progress .model-progress-fill')).length,
        // 沒在下載的項目，進度條必須是收起來的
        hiddenProgress: items.filter((el) => el.querySelector('.model-progress')?.classList.contains('hidden')).length,
        // 名稱節點只放文字：label 前面必須是 text node，不能是被解析出來的元素
        nameFirstIsText: name?.firstChild?.nodeType === Node.TEXT_NODE,
        nameHasText: (name?.textContent || '').trim().length > 0
      }
    })()`)
    ok(
      'model list rendered without innerHTML',
      modelItems?.count > 0 &&
        modelItems.withKey === modelItems.count &&
        modelItems.withRow === modelItems.count &&
        modelItems.withName === modelItems.count &&
        modelItems.noPerRowTag === true &&
        JSON.stringify(modelItems.groups) === JSON.stringify(['語音辨識', '翻譯', '執行環境']) &&
        modelItems.withSize === modelItems.count &&
        modelItems.withButton === modelItems.count &&
        modelItems.withProgress === modelItems.count &&
        modelItems.hiddenProgress === modelItems.count &&
        modelItems.nameFirstIsText === true &&
        modelItems.nameHasText === true,
      JSON.stringify(modelItems)
    )

    // 分類 rail：一次只顯示一區；字級階層 標題 > 欄位 label > 說明
    const settingsNav = await cdp.eval(`(() => {
      document.querySelector('#settingsNav [data-section="local"]')?.click()
      const active = document.querySelector('#page-settings .settings-section.active')
      const title = document.querySelector('#set-local .settings-section-title')
      const label = document.querySelector('#set-local .setting-group label')
      const hint = document.querySelector('#set-local .setting-hint')
      const px = (el) => (el ? parseFloat(getComputedStyle(el).fontSize) : 0)
      return {
        activeId: active?.id || '',
        activeCount: document.querySelectorAll('#page-settings .settings-section.active').length,
        titlePx: px(title),
        labelPx: px(label),
        hintPx: px(hint),
        // 執行緒選項已移除：0.6B 走 CPU、1.7B 走 GPU，選了模型就決定了推論方式
        threadsOptions: document.querySelectorAll('#asrThreadsSegment .seg-btn').length
      }
    })()`)
    ok(
      'settings category rail + type scale',
      settingsNav?.activeId === 'set-local' &&
        settingsNav.activeCount === 1 &&
        settingsNav.titlePx > settingsNav.labelPx &&
        settingsNav.labelPx > settingsNav.hintPx &&
        settingsNav.threadsOptions === 0,
      JSON.stringify(settingsNav)
    )

    const chatSettings = await cdp.eval(`(async () => {
      // 雲端設定區的模型列來自 chatProviders（前面已種過一組）；設定表單要先重載
      await window.electronAPI.store.set('chatProviders', [
        { id: 'smoke_prov', name: '煙霧測試', apiUrl: 'https://example.invalid/v1', apiKey: 'k', models: ['m-one', 'm-two'] }
      ])
      document.querySelector('[data-page="settings"]')?.click()
      await new Promise((r) => setTimeout(r, 300))
      document.querySelector('#settingsNav [data-section="cloud"]')?.click()
      const section = document.getElementById('set-cloud')
      return {
        hasApiUrl: !!document.getElementById('chatApiUrlInput'),
        hasApiKey: !!document.getElementById('chatApiKeyInput'),
        // 系統提示已搬到聊天頁，設定頁不該再有這個欄位
        noPromptField: !document.getElementById('chatSystemPromptInput'),
        modelRows: document.querySelectorAll('#chatModelList .chat-model-row').length,
        hasAddBtn: !!document.getElementById('chatAddModelBtn'),
        titled: section?.classList.contains('active') === true,
        separateFromTranslate:
          document.getElementById('chatApiUrlInput') !== document.getElementById('apiUrlInput')
      }
    })()`)
    ok(
      'chat settings section',
      chatSettings?.hasApiUrl &&
        chatSettings.hasApiKey &&
        chatSettings.noPromptField &&
        chatSettings.modelRows >= 1 &&
        chatSettings.hasAddBtn &&
        chatSettings.titled &&
        chatSettings.separateFromTranslate,
      JSON.stringify(chatSettings)
    )

    // 聊天輸入區：auto-grow、thinking 開關、圖片附件、系統提示彈窗
    const composer = await cdp.eval(`(async () => {
      document.querySelector('[data-page="chat"]')?.click()
      await new Promise((r) => setTimeout(r, 400))
      const input = document.getElementById('chatInput')
      const before = input.getBoundingClientRect().height
      input.value = ['a', 'b', 'c', 'd', 'e', 'f'].join('\\n')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 60))
      const after = input.getBoundingClientRect().height
      input.value = ''
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 60))
      const reset = input.getBoundingClientRect().height

      const think = document.getElementById('chatThinkBtn')
      const wasPressed = think.getAttribute('aria-pressed')
      think.click()
      await new Promise((r) => setTimeout(r, 250))
      const toggled = think.getAttribute('aria-pressed')
      const stored = await window.electronAPI.store.get('chatThinking', false)
      await window.electronAPI.store.set('chatThinking', false)
      think.setAttribute('aria-pressed', 'false')

      const dialog = document.getElementById('chatPromptDialog')
      document.getElementById('chatPromptManageBtn')?.click()
      await new Promise((r) => setTimeout(r, 250))
      const dialogOpen = dialog.open === true
      document.getElementById('promptCancelBtn')?.click()
      await new Promise((r) => setTimeout(r, 200))

      return {
        grew: after > before + 20,
        reset: Math.abs(reset - before) < 4,
        noResizeHandle: getComputedStyle(input).resize === 'none',
        thinkToggled: wasPressed === 'false' && toggled === 'true' && stored === true,
        hasAttach: !!document.getElementById('chatAttachBtn'),
        hasFileInput: !!document.getElementById('chatFileInput'),
        promptOptions: document.getElementById('chatPromptSelect')?.options.length || 0,
        dialogOpen,
        dialogClosed: dialog.open === false
      }
    })()`)
    ok(
      'chat composer (auto-grow / thinking / images / prompts)',
      composer?.grew &&
        composer.reset &&
        composer.noResizeHandle &&
        composer.thinkToggled &&
        composer.hasAttach &&
        composer.hasFileInput &&
        composer.promptOptions >= 1 &&
        composer.dialogOpen &&
        composer.dialogClosed,
      JSON.stringify(composer)
    )

    // 模型 status IPC
    const status = await cdp.eval(`(async () => {
      const s = await window.electronAPI.models.status()
      return { keys: Object.keys(s.models||{}), asr: !!s.models?.qwen3asr?.downloaded }
    })()`)
    ok('models.status', Array.isArray(status?.keys) && status.keys.includes('qwen3asr'), JSON.stringify(status))

    // 模型選單改在使用現場：翻譯頁上方的下拉要列出三顆本地翻譯模型＋一個雲端選項
    const lingua = await cdp.eval(`(async () => {
      document.querySelector('[data-page="translate"]')?.click()
      await new Promise(r => setTimeout(r, 600))
      const sel = document.getElementById('translatePageModel')
      const values = [...(sel?.options || [])].map(o => o.value)
      return {
        statusKeys: Object.keys((await window.electronAPI.models.status()).models || {}),
        values,
        labels: [...(sel?.options || [])].map(o => o.textContent),
        // Q8 已下架，選單與 registry 都不該再看到它
        noQ8: !values.includes('local:linguaforge08')
      }
    })()`)
    ok(
      'translate model picker lists local + cloud',
      lingua?.statusKeys?.includes('linguaforge08q4') &&
        !lingua?.statusKeys?.includes('linguaforge08') &&
        JSON.stringify(lingua?.values.slice(0, 3)) === JSON.stringify([
          'local:linguaforge08q4', 'local:qwen35translate', 'local:qwen354b'
        ]) &&
        // 雲端選項逐一列出供應商的模型（沒有供應商時退回一個「尚未設定」項）
        lingua?.values.slice(3).every((v) => v.startsWith('cloud')) &&
        lingua?.values.length > 3 &&
        lingua?.labels?.some((l) => /LinguaForge/i.test(l)) &&
        lingua?.noQ8 === true,
      JSON.stringify(lingua)
    )

    // 翻譯分段器單元檢查（直接 import 打包內的 renderer 模組）
    const split = await cdp.eval(`(async () => {
      const m = await import('./scripts/translate-page.js')
      const long = ('這是一個測試句子。' .repeat(200))
      const c = m.splitForTranslate(long)
      const noPunct = 'a'.repeat(1500)
      return {
        multi: c.length > 1,
        maxLen: Math.max(...c.map(s => s.length)),
        rejoin: c.join('') === long,
        para: m.splitForTranslate('第一段。\\n第二段。').length,
        hard: m.splitForTranslate(noPunct).length,
        empty: m.splitForTranslate('   ').length
      }
    })()`)
    ok(
      'splitForTranslate',
      split?.multi && split.maxLen <= 600 && split.rejoin && split.hard === 3 && split.empty === 0,
      JSON.stringify(split)
    )

    // 長文（>1500 字，舊上限）實際翻譯：分段依序跑完
    const longRun = await cdp.eval(`(async () => {
      document.querySelector('[data-page="translate"]')?.click()
      await new Promise(r => setTimeout(r, 300))
      const input = document.getElementById('translateInput')
      input.value = 'The patient should take this medication twice a day. '.repeat(36)
      input.dispatchEvent(new Event('input'))
      return {
        len: input.value.length,
        maxlength: input.getAttribute('maxlength'),
        count: document.getElementById('translateInputCount')?.textContent
      }
    })()`)
    ok(
      'long input accepted (no maxlength)',
      longRun?.len > 1500 && longRun.maxlength === null && /段/.test(longRun.count || ''),
      JSON.stringify(longRun)
    )

    // 進頁後 prewarmTranslatePage() 還在跑（載模型／refreshUiState 會把「翻譯」鈕暫時停用），
    // 睡 300ms 就按會撞在準備中的那一段 → 這一輪被自己作廢，狀態停在「（已停止）」。
    // 等鈕真的可按再按（實測那是唯一看得出「準備好了」的訊號）。
    for (let i = 0; i < 60; i++) {
      if (await cdp.eval(`document.getElementById('translateRunBtn').disabled === false`)) break
      await sleep(500)
    }
    // 由 Node 端輪詢（長時間 awaitPromise 會讓 CDP 連線閒置斷開）
    await cdp.eval(`document.getElementById('translateRunBtn').click()`)
    let translated = null
    const tDeadline = Date.now() + 300000
    while (Date.now() < tDeadline) {
      await sleep(2000)
      translated = await cdp.eval(`({
        state: document.getElementById('translateOutputState').textContent,
        out: (document.getElementById('translateOutput').value || '').slice(0, 120),
        outLen: (document.getElementById('translateOutput').value || '').length,
        outLines: (document.getElementById('translateOutput').value || '').split('\\n').filter(Boolean).length,
        err: document.getElementById('translateError')?.textContent || ''
      })`)
      // 「已停止」＝這一輪被作廢（原文／語言變了或切走了頁）：那是失敗，
      // 不要繼續等到 300 秒逾時才發現（等到逾時只會看到同一個字串，但多花五分鐘）。
      if (/完成|失敗|已停止/.test(translated?.state || '')) break
    }
    // 期望段數取自 UI 的「N 字（M 段）」：段長依模型不同（通用 600／LinguaForge 280），不可寫死
    const expectSegs = Number((longRun?.count || '').match(/（(\d+) 段）/)?.[1] || 0)
    ok(
      // 輸入是同句重複 → 每段譯文相同，故驗「段數」而非總長
      'long text translated in chunks',
      /完成/.test(translated?.state || '') &&
        expectSegs > 1 &&
        translated?.outLines === expectSegs &&
        !translated?.err,
      JSON.stringify({ ...translated, expectSegs })
    )

    cdp.close()
  } catch (e) {
    ok('suite', false, e.message || String(e))
  } finally {
    stopChildTree(child)
    // Windows 釋放暫存 SQLite 較慢，有限重試
    for (let i = 0; i < 5; i += 1) {
      try { fs.rmSync(USER_DATA_DIR, { recursive: true, force: true }); break } catch { await sleep(600) }
    }
  }

  const failed = results.filter((r) => !r.pass)
  console.log('\n=== summary ===')
  console.log(`total=${results.length} pass=${results.length - failed.length} fail=${failed.length}`)
  process.exit(failed.length ? 1 : 0)
}

main()
