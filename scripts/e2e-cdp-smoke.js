/**
 * 打包版 CDP 煙霧測試：分頁、設定、字幕窗
 * 用法：先啟動 dist/win-unpacked/VoiceInk.exe --remote-debugging-port=9229
 *      再 node scripts/e2e-cdp-smoke.js
 * 或本腳本自動啟動。
 */
const { spawn } = require('child_process')
const path = require('path')
const http = require('http')

const PORT = 9235
const EXE = path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
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
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], {
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
    const mainPage = pages.find((p) => /index\.html|VoiceInk/i.test(p.url + p.title)) || pages[0]
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
      document.querySelector('[data-page="usage"]')?.click()
      await new Promise((resolve) => setTimeout(resolve, 500))
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
      'six-tab order + usage page structure',
      JSON.stringify(usageUi?.order) === JSON.stringify([
        'chat', 'usage', 'transcribe', 'live', 'translate', 'settings'
      ]) &&
        usageUi.hasApi &&
        usageUi.active &&
        usageUi.hasSync &&
        usageUi.hasGrid &&
        usageUi.hasSettings &&
        usageUi.hasDiagnostics &&
        usageUi.accounts === 5 &&
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

    // 切到 live 分頁
    await cdp.eval(`document.querySelector('[data-page="live"]')?.click()`)
    await sleep(500)
    const liveActive = await cdp.eval(
      `document.getElementById('page-live')?.classList.contains('active')`
    )
    ok('switch to live page', liveActive === true)

    // 即時頁無舊的 display mode segmented（已搬到字幕窗）
    const noSeg = await cdp.eval(
      `!document.querySelector('#page-live .segmented, #captionDisplayMode, #displayModeSegment')`
    )
    ok('live page no display-mode segment', noSeg === true)

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
          hasTranslatorCloud: !!document.querySelector('#translatorSegment [data-value="cloud"]'),
          hasTranslatorLocal: !!document.querySelector('#translatorSegment [data-value="local"]'),
          noNone: !document.querySelector('#translatorSegment [data-value="none"]'),
          hasAsrCloud: !!document.querySelector('#asrEngineSegment [data-value="cloud"]'),
          hasTtsRate: !!document.getElementById('ttsRateInput'),
          hasModelList: !!document.getElementById('modelList'),
          navCount: document.querySelectorAll('#settingsNav .settings-nav-item').length,
          activeSections: document.querySelectorAll('#page-settings .settings-section.active').length,
          hasFooterSave: !!document.getElementById('saveSettingsBtn'),
          textHasModels: /模型/.test(text)
        }
      })()
    `)
    ok(
      'settings page structure',
      settingsUi?.noModal &&
        settingsUi?.hasTranslatorCloud &&
        settingsUi?.hasTranslatorLocal &&
        settingsUi?.noNone &&
        settingsUi?.hasAsrCloud &&
        settingsUi?.hasTtsRate &&
        settingsUi?.hasModelList &&
        settingsUi?.navCount === 6 &&
        settingsUi?.activeSections === 1 &&
        settingsUi?.hasFooterSave,
      JSON.stringify(settingsUi)
    )

    // 分類 rail：一次只顯示一區；字級階層 標題 > 欄位 label > 說明
    const settingsNav = await cdp.eval(`(() => {
      document.querySelector('#settingsNav [data-section="asr"]')?.click()
      const active = document.querySelector('#page-settings .settings-section.active')
      const title = document.querySelector('#set-asr .settings-section-title')
      const label = document.querySelector('#set-asr .setting-group label')
      const hint = document.querySelector('#set-asr .setting-hint')
      const px = (el) => (el ? parseFloat(getComputedStyle(el).fontSize) : 0)
      return {
        activeId: active?.id || '',
        activeCount: document.querySelectorAll('#page-settings .settings-section.active').length,
        titlePx: px(title),
        labelPx: px(label),
        hintPx: px(hint),
        threadsOptions: document.querySelectorAll('#asrThreadsSegment .seg-btn').length
      }
    })()`)
    ok(
      'settings category rail + type scale',
      settingsNav?.activeId === 'set-asr' &&
        settingsNav.activeCount === 1 &&
        settingsNav.titlePx > settingsNav.labelPx &&
        settingsNav.labelPx > settingsNav.hintPx &&
        settingsNav.threadsOptions === 4,
      JSON.stringify(settingsNav)
    )

    const chatSettings = await cdp.eval(`(() => {
      document.querySelector('#settingsNav [data-section="chat"]')?.click()
      const section = document.getElementById('set-chat')
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

    // LinguaForge 可選：模型清單／翻譯模型選項都要出現
    const lingua = await cdp.eval(`(async () => {
      const seg = document.getElementById('localTranslateModelSegment')
      return {
        statusKeys: Object.keys((await window.electronAPI.models.status()).models || {}),
        settingsText: /LinguaForge/i.test(document.getElementById('page-settings')?.innerText || ''),
        segBtn: !!seg?.querySelector('[data-value="linguaforge08"]'),
        // 整組不再被 hidden 遮蔽（本地翻譯區塊本身在 translator=cloud 時才隱藏）
        groupShown: !seg?.closest('.setting-group')?.classList.contains('hidden'),
        translator: await window.electronAPI.store.get('translator', 'local')
      }
    })()`)
    ok(
      'linguaforge selectable',
      lingua?.statusKeys?.includes('linguaforge08') &&
        lingua?.settingsText === true &&
        lingua?.segBtn === true &&
        lingua?.groupShown === true,
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
      if (/完成|失敗/.test(translated?.state || '')) break
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
    try { child.kill() } catch {}
    // Windows 強制
    try {
      spawn('taskkill', ['/F', '/IM', 'VoiceInk.exe'], { stdio: 'ignore' })
    } catch {}
  }

  const failed = results.filter((r) => !r.pass)
  console.log('\n=== summary ===')
  console.log(`total=${results.length} pass=${results.length - failed.length} fail=${failed.length}`)
  process.exit(failed.length ? 1 : 0)
}

main()
