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
      throw new Error(r.exceptionDetails.text || 'eval error')
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
          textHasAsr: /語音轉文字/.test(text),
          textHasTranslate: /翻譯設定/.test(text)
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
        settingsUi?.hasModelList,
      JSON.stringify(settingsUi)
    )

    // 模型 status IPC
    const status = await cdp.eval(`(async () => {
      const s = await window.electronAPI.models.status()
      return { keys: Object.keys(s.models||{}), asr: !!s.models?.qwen3asr?.downloaded }
    })()`)
    ok('models.status', Array.isArray(status?.keys) && status.keys.includes('qwen3asr'), JSON.stringify(status))

    // LinguaForge 屏蔽：模型清單／翻譯模型選項／store 值都不得出現
    const hidden = await cdp.eval(`(async () => {
      const seg = document.getElementById('localTranslateModelSegment')
      return {
        statusKeys: Object.keys((await window.electronAPI.models.status()).models || {}),
        settingsText: /LinguaForge/i.test(document.getElementById('page-settings')?.innerText || ''),
        segBtn: !!seg?.querySelector('[data-value="linguaforge08"]'),
        segVisible: !!seg?.offsetParent,
        stored: await window.electronAPI.store.get('localTranslateModel', 'qwen35translate')
      }
    })()`)
    ok(
      'linguaforge hidden',
      !hidden?.statusKeys?.includes('linguaforge08') &&
        hidden?.settingsText === false &&
        hidden?.segBtn === false &&
        hidden?.segVisible === false &&
        hidden?.stored === 'qwen35translate',
      JSON.stringify(hidden)
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
    ok(
      // 輸入是同句重複 → 每段譯文相同，故驗「段數」而非總長
      'long text translated in chunks',
      /完成/.test(translated?.state || '') && translated?.outLines === 4 && !translated?.err,
      JSON.stringify(translated)
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
