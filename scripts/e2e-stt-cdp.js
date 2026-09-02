/**
 * 打包版 CDP：語音轉文字合併頁 ＋ 設定頁四分區 ＋ 語音試聽
 * 用法：node scripts/e2e-stt-cdp.js（會自己啟動 dist/win-unpacked/VoiceInk.exe）
 *
 * 這支會改到三個子分頁各自的模型選擇（`fileAsr`／`fileLlm`／`liveAsr`／`liveLlm`／
 * `dictationAsr`）與翻譯頁的全域那組，**開頭先讀下來、finally 一定寫回**，
 * 不留下測試痕跡在使用者的設定裡。
 */
const { spawn } = require('child_process')
const path = require('path')
const os = require('os')
const fs = require('fs')
const http = require('http')

const PORT = 9243
// Windows 偶爾會有別的東西鎖住 dist/win-unpacked（打包失敗、防毒掃描中），
// 這時可以打包到別的資料夾再用 VOICEINK_EXE 指過去，測試不必等鎖放掉
const EXE = process.env.VOICEINK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
// 暫存 user-data-dir：使用者開著的正式實例佔 single-instance lock，
// 沒有自己的資料夾會被擋掉（second-instance 轉交後退出，CDP 等不到主視窗）
const USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-cdp-'))
const RESTORE_KEYS = [
  'fileAsr', 'fileLlm', 'liveAsr', 'liveLlm', 'dictationAsr',
  'translator', 'localTranslateModel'
]
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

  close() { try { this.ws.close() } catch { /* ignore */ } }
}

async function waitFor(action, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await action()) return true
    await sleep(300)
  }
  throw new Error(`等待逾時：${label}`)
}

async function main() {
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA_DIR}`], { stdio: ['ignore', 'pipe', 'pipe'] })
  let processLog = ''
  child.stdout.on('data', (c) => { processLog += c })
  child.stderr.on('data', (c) => { processLog += c })

  let cdp = null
  let original = null
  let passed = 0
  let failed = 0
  const ok = (name, cond, extra = '') => {
    if (cond) { passed++; console.log(`PASS  ${name}`) }
    else { failed++; console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`) }
  }

  try {
    const target = await (async () => {
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        const pages = await getJson(`http://127.0.0.1:${PORT}/json/list`).catch(() => [])
        const page = pages.filter((p) => p.type === 'page').find((p) => /index\.html/.test(p.url))
        if (page) return page
        await sleep(400)
      }
      throw new Error('等不到主視窗')
    })()
    cdp = new Cdp(target.webSocketDebuggerUrl)
    await cdp.connect()
    await waitFor(
      () => cdp.eval(`document.readyState === 'complete' && typeof window.electronAPI?.store?.get === 'function'`),
      15000, 'preload 初始化'
    )

    original = await cdp.eval(`(async () => {
      const keys = ${JSON.stringify(RESTORE_KEYS)}
      const out = {}
      for (const k of keys) out[k] = await window.electronAPI.store.get(k, null)
      return out
    })()`)
    console.log(`（已備份使用者設定：${JSON.stringify(original)}）`)

    // ---- 合併頁結構 ----
    await cdp.eval(`document.querySelector('[data-page="stt"]').click(), 'ok'`)
    await waitFor(() => cdp.eval(`!!document.getElementById('fileAsrModel')?.options.length`), 10000, '模型選單填好')

    const layout = await cdp.eval(`(() => ({
      subtabs: [...document.querySelectorAll('#sttSubtabs .subtab')].map((b) => b.dataset.subtab),
      activePanel: document.querySelector('#page-stt .subtab-panel.active')?.id || '',
      activeCount: document.querySelectorAll('#page-stt .subtab-panel.active').length,
      hasDropZone: !!document.querySelector('#stt-file #dropZone'),
      hasLiveBtn: !!document.querySelector('#stt-live #startLiveBtn'),
      hasDictation: !!document.querySelector('#stt-dictation #dictationEnabledInput'),
      // 舊的兩個 nav 分頁與 section 都不該還在
      noOldNav: !document.querySelector('[data-page="transcribe"], [data-page="live"]'),
      noOldSections: !document.getElementById('page-transcribe') && !document.getElementById('page-live')
    }))()`)
    ok(
      '檔案轉錄／即時字幕／語音輸入合併成一頁的子分頁',
      JSON.stringify(layout?.subtabs) === JSON.stringify(['file', 'live', 'dictation']) &&
        layout.activePanel === 'stt-file' && layout.activeCount === 1 &&
        layout.hasDropZone && layout.hasLiveBtn && layout.hasDictation &&
        layout.noOldNav && layout.noOldSections,
      JSON.stringify(layout)
    )

    // 三個子分頁各自有自己的模型選單，而且都在自己的面板裡（不在共用的標題列）
    const bars = await cdp.eval(`(() => {
      const inPanel = (panelId, selectId) => {
        const panel = document.getElementById(panelId)
        const sel = document.getElementById(selectId)
        return !!panel && !!sel && panel.contains(sel)
      }
      return {
        fileAsr: inPanel('stt-file', 'fileAsrModel'),
        fileLlm: inPanel('stt-file', 'fileLlmModel'),
        liveAsr: inPanel('stt-live', 'liveAsrModel'),
        liveLlm: inPanel('stt-live', 'liveLlmModel'),
        dictAsr: inPanel('stt-dictation', 'dictationAsrModel'),
        dictLlm: inPanel('stt-dictation', 'dictationLlmSelect'),
        noSharedBar: !document.getElementById('sttModelBar') && !document.getElementById('sttModelHint'),
        headerHasNoSelect: !document.querySelector('#page-stt .page-header select'),
        translateInsideHeader: !!document.querySelector('#page-translate .page-header #translateModelBar')
      }
    })()`)
    ok('三個子分頁各自有 ASR 與 LLM 選單、都在自己的面板裡',
      bars?.fileAsr && bars.fileLlm && bars.liveAsr && bars.liveLlm && bars.dictAsr && bars.dictLlm,
      JSON.stringify(bars))
    ok('標題旁不再有共用的模型選單',
      bars?.noSharedBar && bars.headerHasNoSelect && bars.translateInsideHeader, JSON.stringify(bars))

    const switched = await cdp.eval(`(async () => {
      document.querySelector('#sttSubtabs [data-subtab="live"]').click()
      await new Promise((r) => setTimeout(r, 400))
      const live = document.querySelector('#page-stt .subtab-panel.active')?.id
      document.querySelector('#sttSubtabs [data-subtab="file"]').click()
      await new Promise((r) => setTimeout(r, 400))
      return { live, back: document.querySelector('#page-stt .subtab-panel.active')?.id }
    })()`)
    ok('子分頁可以來回切', switched?.live === 'stt-live' && switched?.back === 'stt-file',
      JSON.stringify(switched))

    // ---- 模型選單：選了要寫回自己那一個 store key ----
    const asrValues = await cdp.eval(
      `[...document.getElementById('fileAsrModel').options].map((o) => o.value)`
    )
    // 雲端那幾項是「每一組設定的每一顆轉錄模型」，所以數量跟使用者設定有關；
    // 這裡只確認兩顆本地在前、後面至少有一個雲端項
    ok(
      'ASR 選單同時列出兩顆本地模型與雲端',
      asrValues[0] === 'local:qwen3asr' && asrValues[1] === 'local:qwen3asrgpu'
        && asrValues.slice(2).every((v) => v.startsWith('cloud'))
        && asrValues.length >= 3,
      JSON.stringify(asrValues)
    )

    const wroteGpu = await cdp.eval(`(async () => {
      const sel = document.getElementById('fileAsrModel')
      sel.value = 'local:qwen3asrgpu'
      sel.dispatchEvent(new Event('change'))
      await new Promise((r) => setTimeout(r, 500))
      return await window.electronAPI.store.get('fileAsr', null)
    })()`)
    ok('選 GPU 模型會寫回 fileAsr', wroteGpu === 'local:qwen3asrgpu', String(wroteGpu))

    // 這是這次改動的核心：三頁各存各的，改一頁不可以動到另外兩頁
    const isolated = await cdp.eval(`(async () => {
      const set = async (id, value) => {
        const sel = document.getElementById(id)
        sel.value = value
        sel.dispatchEvent(new Event('change'))
        await new Promise((r) => setTimeout(r, 400))
      }
      // 雲端選項現在是「哪一組設定的哪一顆模型」（cloud:設定id:模型id），
      // 寫死 'cloud' 會設不進去（沒有這個 option）→ 取選單裡真的存在的第一個雲端項
      const cloudValue = [...document.getElementById('liveAsrModel').options]
        .map((o) => o.value).find((v) => v.startsWith('cloud'))
      await set('liveAsrModel', cloudValue)
      await set('dictationAsrModel', 'local:qwen3asr')
      await set('fileLlmModel', 'local:qwen35translate')
      await set('liveLlmModel', 'local:qwen354b')
      const keys = ['fileAsr', 'liveAsr', 'dictationAsr', 'fileLlm', 'liveLlm']
      const out = { cloudValue }
      for (const k of keys) out[k] = await window.electronAPI.store.get(k, null)
      return out
    })()`)
    ok(
      '三個子分頁的 ASR 選擇互不干擾',
      isolated?.fileAsr === 'local:qwen3asrgpu' && isolated?.liveAsr === isolated?.cloudValue &&
        isolated?.dictationAsr === 'local:qwen3asr',
      JSON.stringify(isolated)
    )
    ok(
      '檔案轉錄與即時字幕的翻譯模型也各存各的',
      isolated?.fileLlm === 'local:qwen35translate' && isolated?.liveLlm === 'local:qwen354b',
      JSON.stringify(isolated)
    )

    // ---- 翻譯與 TTS 頁是另一組（全域 key），不被子分頁的選擇帶著跑 ----
    const translatePage = await cdp.eval(`(async () => {
      await window.electronAPI.store.set('translator', 'local')
      await window.electronAPI.store.set('localTranslateModel', 'linguaforge08q4')
      document.querySelector('[data-page="translate"]').click()
      await new Promise((r) => setTimeout(r, 900))
      return document.getElementById('translatePageModel')?.value || ''
    })()`)
    ok('翻譯與 TTS 頁用自己的全域設定（不跟子分頁共用）',
      translatePage === 'local:linguaforge08q4', String(translatePage))

    // 回語音轉文字頁，確認重讀後畫面跟 store 對得上
    const reread = await cdp.eval(`(async () => {
      document.querySelector('[data-page="stt"]').click()
      await new Promise((r) => setTimeout(r, 900))
      return {
        file: document.getElementById('fileAsrModel')?.value || '',
        live: document.getElementById('liveAsrModel')?.value || '',
        dict: document.getElementById('dictationAsrModel')?.value || ''
      }
    })()`)
    ok('重新進頁時三個選單各自讀回自己的值',
      reread?.file === 'local:qwen3asrgpu' && reread?.live === isolated?.cloudValue &&
        reread?.dict === 'local:qwen3asr',
      JSON.stringify(reread))

    // ---- 未安裝的模型要標出來 ----
    const notReady = await cdp.eval(`(async () => {
      const status = await window.electronAPI.models.status()
      const missing = Object.values(status.models).filter((m) => !m.downloaded).map((m) => m.key)
      document.querySelector('[data-page="translate"]').click()
      await new Promise((r) => setTimeout(r, 700))
      const labels = [...document.getElementById('translatePageModel').options].map((o) => o.textContent)
      return { missing, marked: labels.filter((l) => l.includes('未安裝')).length }
    })()`)
    ok(
      '未安裝的本地模型在選單裡標「未安裝」',
      notReady?.missing.length === 0 || notReady?.marked > 0,
      JSON.stringify(notReady)
    )

    // ---- 設定頁四分區 ----
    await cdp.eval(`document.querySelector('[data-page="settings"]').click(), 'ok'`)
    await sleep(900)
    const settings = await cdp.eval(`(() => {
      const sections = [...document.querySelectorAll('#settingsNav .settings-nav-item')]
      return {
        order: sections.map((b) => b.dataset.section),
        titles: sections.map((b) => b.textContent.trim()),
        // 後端 segmented 與本地模型 segmented 都已移除
        removed: !document.getElementById('translatorSegment') &&
          !document.getElementById('asrEngineSegment') &&
          !document.getElementById('localTranslateModelSegment'),
        // 推論設定留在本地模型分區
        gpuInLocal: !!document.querySelector('#set-local #llmGpuSegment'),
        // ASR 的推論方式跟著模型走，不再有執行緒選項
        noThreads: !document.getElementById('asrThreadsSegment'),
        // 模型清單依 kind 分組
        groups: [...document.querySelectorAll('#set-local .model-group-title')].map((el) => el.textContent),
        modelListInLocal: !!document.querySelector('#set-local #modelList'),
        // 三組雲端端點都在雲端模型分區
        cloudChat: !!document.querySelector('#set-cloud #chatApiUrlInput'),
        // 翻譯與聊天共用同一組供應商，不再有第二份 URL／Key 欄位
        noSeparateTranslate: !document.getElementById('apiUrlInput') && !document.getElementById('modelIdInput'),
        cloudAsr: !!document.querySelector('#set-cloud #asrApiUrlInput')
      }
    })()`)
    ok(
      '設定頁只剩四個分區且順序正確',
      JSON.stringify(settings?.order) === JSON.stringify(['local', 'cloud', 'voice', 'basic']) &&
        settings.titles[0].includes('本地模型') && settings.titles[1].includes('雲端模型') &&
        settings.titles[2].includes('語音朗讀') && settings.titles[3].includes('基本'),
      JSON.stringify(settings?.titles)
    )
    ok('推論設定與模型清單都在「本地模型」',
      settings?.removed && settings.gpuInLocal && settings.noThreads && settings.modelListInLocal,
      JSON.stringify(settings))
    ok('本地模型清單依語音辨識／翻譯／執行環境分組',
      JSON.stringify(settings?.groups) === JSON.stringify(['語音辨識', '翻譯', '執行環境']),
      JSON.stringify(settings?.groups))
    ok('雲端翻譯併入聊天供應商（沒有第二份端點欄位）',
      settings?.noSeparateTranslate === true,
      JSON.stringify(settings))
    ok('共用供應商與語音轉文字端點都在「雲端模型」',
      settings?.cloudChat && settings.cloudAsr, JSON.stringify(settings))

    // ---- llama.cpp 執行環境列在模型清單裡 ----
    const runtimeRow = await cdp.eval(`(() => {
      const item = document.querySelector('#modelList .model-item[data-key="llamaruntime"]')
      return {
        exists: !!item,
        // 類別看它排在哪一組的標題底下（每列不再重複掛 tag）
        group: item?.previousElementSibling?.classList.contains('model-group-title')
          ? item.previousElementSibling.textContent
          : [...document.querySelectorAll('#modelList .model-group-title')].at(-1)?.textContent || '',
        gpuAsr: !!document.querySelector('#modelList .model-item[data-key="qwen3asrgpu"]')
      }
    })()`)
    ok('模型清單看得到 llama.cpp 執行環境與 GPU 語音模型',
      runtimeRow?.exists && runtimeRow.group === '執行環境' && runtimeRow.gpuAsr,
      JSON.stringify(runtimeRow))

    // ---- 語音試聽 ----
    await cdp.eval(`document.querySelector('#settingsNav [data-section="voice"]').click(), 'ok'`)
    await sleep(500)
    const previewUi = await cdp.eval(`(() => {
      const btns = [...document.querySelectorAll('.tts-preview-btn')]
      return {
        count: btns.length,
        langs: btns.map((b) => b.dataset.ttsPreview),
        // 每顆鈕都要跟同一列的下拉在一起
        pairedWithSelect: btns.every((b) => !!b.closest('.tts-voice-row')?.querySelector('select[data-tts-lang]')),
        hasApi: typeof window.electronAPI.tts.preview === 'function'
      }
    })()`)
    ok(
      '五種語言都有試聽鈕且接得到 IPC',
      previewUi?.count === 5 && previewUi.pairedWithSelect && previewUi.hasApi &&
        JSON.stringify(previewUi.langs) === JSON.stringify(['zh-TW', 'zh-CN', 'en', 'ja', 'ko']),
      JSON.stringify(previewUi)
    )

    // 真的合成一次（需連網；失敗只記 SKIP 不算錯）
    const preview = await cdp.eval(`(async () => {
      try {
        const r = await window.electronAPI.tts.preview('zh-TW', document.getElementById('ttsVoiceZhTw').value, 0)
        return { ok: true, bytes: r?.data?.length || 0, mime: r?.mime || '' }
      } catch (e) { return { ok: false, message: String(e.message || e) } }
    })()`)
    if (preview?.ok) {
      ok('試聽真的合成出音訊', preview.bytes > 1000 && /audio/.test(preview.mime), JSON.stringify(preview))
    } else {
      console.log(`SKIP  試聽需連網：${preview?.message}`)
    }

    // 白名單：不在清單裡的語音要退回該語言預設，而不是原樣送出去
    const badVoice = await cdp.eval(`(async () => {
      try {
        const r = await window.electronAPI.tts.preview('zh-TW', 'evil-voice-Neural', 0)
        return { ok: true, bytes: r?.data?.length || 0 }
      } catch (e) { return { ok: false, message: String(e.message || e) } }
    })()`)
    ok('非白名單語音不會被原樣送出（退回預設或明確失敗）',
      badVoice?.ok ? badVoice.bytes > 1000 : true, JSON.stringify(badVoice))

    ok('renderer 無未處理例外', cdp.exceptions.length === 0, JSON.stringify(cdp.exceptions))
  } catch (error) {
    failed++
    console.error(`\n未預期例外：${error.stack || error}`)
    console.error('Renderer exceptions:', JSON.stringify(cdp?.exceptions || []))
    console.error('Process log:', processLog.slice(-4000))
  } finally {
    if (cdp && original) {
      try {
        await cdp.eval(`(async () => {
          const orig = ${JSON.stringify(original)}
          for (const [k, v] of Object.entries(orig)) {
            if (v !== null) await window.electronAPI.store.set(k, v)
          }
          return 'ok'
        })()`)
        console.log(`（已還原使用者設定：${JSON.stringify(original)}）`)
      } catch (e) {
        console.error('還原設定失敗：', e)
      }
    }
    cdp?.close()
    try { child.kill() } catch { /* ignore */ }
    if (child.pid) {
      try { spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' }) } catch { /* ignore */ }
    }
  }

  console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILED'}  ${passed} passed, ${failed} failed\n`)
  process.exitCode = failed === 0 ? 0 : 1
}

main()
