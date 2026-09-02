/**
 * 打包版 CDP：語音輸入子分頁
 * 用法：node scripts/e2e-dictation-cdp.js（會自己啟動 dist/win-unpacked/VoiceInk.exe）
 *
 * 用**暫存 user-data-dir**：這一頁會寫紀錄與字典，不該在使用者的資料裡留測試痕跡；
 * 收尾也只以自己的 PID 收程序（禁止 taskkill /IM，會把使用者的安裝版一起關掉）。
 *
 * 這支會短暫真的掛上全域鍵盤 hook（驗證「開關打開＝熱鍵真的在聽」），
 * 但**不會模擬按鍵、也不會貼上任何文字**——真的送 Ctrl+V 會貼進當下的前景視窗。
 */
const { spawn } = require('child_process')
const path = require('path')
const http = require('http')
const os = require('os')
const fs = require('fs')

const PORT = 9247
// Windows 偶爾會有別的東西鎖住 dist/win-unpacked（打包失敗、防毒掃描中），
// 這時可以打包到別的資料夾再用 VOICEINK_EXE 指過去，測試不必等鎖放掉
const EXE = process.env.VOICEINK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
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
    request.setTimeout(3000, () => request.destroy(new Error('CDP HTTP 逾時')))
    request.on('error', reject)
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
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-dict-cdp-'))
  const child = spawn(EXE, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    // 假麥克風：這樣「錄音端拿不拿得到 16kHz PCM」在 CI／無麥克風的機器上也驗得到
    '--use-fake-device-for-media-stream'
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let processLog = ''
  child.stdout.on('data', (c) => { processLog += c })
  child.stderr.on('data', (c) => { processLog += c })

  let cdp = null
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
      () => cdp.eval(`document.readyState === 'complete' && typeof window.electronAPI?.dictation?.status === 'function'`),
      15000, 'preload 初始化'
    )

    // ---- 進頁 ----
    await cdp.eval(`document.querySelector('[data-page="stt"]').click(), 'ok'`)
    await sleep(600)
    await cdp.eval(`document.querySelector('#sttSubtabs [data-subtab="dictation"]').click(), 'ok'`)
    await waitFor(
      () => cdp.eval(`!!document.getElementById('dictationLlmSelect')?.options.length`),
      10000, '整理模型選單填好'
    )

    const layout = await cdp.eval(`(() => {
      const panel = document.getElementById('stt-dictation')
      return {
        active: panel?.classList.contains('active'),
        activeCount: document.querySelectorAll('#page-stt .subtab-panel.active').length,
        hasSwitch: !!document.getElementById('dictationEnabledInput'),
        hasLlm: !!document.getElementById('dictationLlmSelect'),
        hasLang: !!document.getElementById('dictationLangSelect'),
        hasRecords: !!document.getElementById('dictationRecords'),
        hasTerms: !!document.getElementById('dictationTerms')
      }
    })()`)
    ok('語音輸入子分頁是唯一顯示的面板',
      layout?.active && layout.activeCount === 1 && layout.hasSwitch && layout.hasLlm &&
        layout.hasLang && layout.hasRecords && layout.hasTerms,
      JSON.stringify(layout))

    const glass = await cdp.eval(`(() => {
      const s = getComputedStyle(document.querySelector('#stt-dictation .dict-hero'))
      return { radius: s.borderRadius, blur: s.backdropFilter }
    })()`)
    ok('面板是 12px 圓角的 glass', parseInt(glass?.radius, 10) >= 12 && /blur/.test(glass?.blur || ''),
      JSON.stringify(glass))

    // ---- 整理模型選單 ----
    const options = await cdp.eval(`[...document.getElementById('dictationLlmSelect').options]
      .map((o) => ({ value: o.value, label: o.textContent, notReady: o.dataset.notReady === '1' }))`)
    ok('第一項是「不整理」', options?.[0]?.value === '' && options[0].label.includes('不整理'),
      JSON.stringify(options?.[0]))
    ok('兩顆本地通用模型都在（LinguaForge 是翻譯專用，不列）',
      options?.some((o) => o.value === 'local:qwen35translate') &&
        options.some((o) => o.value === 'local:qwen354b') &&
        !options.some((o) => o.value.includes('linguaforge')),
      JSON.stringify(options?.map((o) => o.value)))
    ok('未安裝的本地模型有標記',
      options.filter((o) => o.value.startsWith('local:')).every((o) => o.notReady === o.label.includes('未安裝')),
      JSON.stringify(options?.filter((o) => o.value.startsWith('local:'))))

    // ---- 語言寫回 store ----
    const lang = await cdp.eval(`(async () => {
      const sel = document.getElementById('dictationLangSelect')
      sel.value = 'ja'
      sel.dispatchEvent(new Event('change'))
      await new Promise((r) => setTimeout(r, 400))
      const saved = await window.electronAPI.store.get('dictationLang', null)
      sel.value = 'zh-TW'
      sel.dispatchEvent(new Event('change'))
      await new Promise((r) => setTimeout(r, 400))
      return { saved, back: await window.electronAPI.store.get('dictationLang', null) }
    })()`)
    ok('輸出語言選了就寫回 store', lang?.saved === 'ja' && lang?.back === 'zh-TW', JSON.stringify(lang))

    // ---- 整理模型寫回 store（不存在的值要被收斂掉）----
    const llm = await cdp.eval(`(async () => {
      await window.electronAPI.store.set('dictationLlm', 'cloud:nope:ghost-model')
      const bogus = await window.electronAPI.store.get('dictationLlm', null)
      await window.electronAPI.store.set('dictationLlm', 'local:qwen35translate')
      const good = await window.electronAPI.store.get('dictationLlm', null)
      await window.electronAPI.store.set('dictationLlm', '')
      return { bogus, good }
    })()`)
    ok('指到不存在的供應商會被收斂成「不整理」', llm?.bogus === '', JSON.stringify(llm))
    ok('本地模型 key 收得下', llm?.good === 'local:qwen35translate', JSON.stringify(llm))

    // ---- 開關真的掛上全域熱鍵 ----
    const toggled = await cdp.eval(`(async () => {
      const box = document.getElementById('dictationEnabledInput')
      const before = await window.electronAPI.dictation.status()
      box.checked = true
      box.dispatchEvent(new Event('change'))
      await new Promise((r) => setTimeout(r, 1200))
      const on = await window.electronAPI.dictation.status()
      box.checked = false
      box.dispatchEvent(new Event('change'))
      await new Promise((r) => setTimeout(r, 800))
      const off = await window.electronAPI.dictation.status()
      return {
        before: before?.data,
        on: on?.data,
        off: off?.data,
        stored: await window.electronAPI.store.get('dictationEnabled', null)
      }
    })()`)
    ok('預設沒有掛全域熱鍵', toggled?.before?.listening === false, JSON.stringify(toggled?.before))
    ok('打開開關後熱鍵真的在聽', toggled?.on?.listening === true && toggled?.on?.enabled === true,
      JSON.stringify(toggled?.on))
    ok('關掉開關就拔掉熱鍵', toggled?.off?.listening === false && toggled?.stored === false,
      JSON.stringify(toggled?.off))
    // 打包版一定要走原生 sidecar：那是「右 Alt 真的被吞掉、不會影響前景程式」的前提。
    // 退回 uiohook 代表 resources/hook/VoiceInkHook.exe 沒進打包或起不來
    ok('熱鍵走原生 sidecar（真的攔下按鍵）', toggled?.on?.mode === 'native',
      JSON.stringify(toggled?.on?.mode))


    // ---- 字典 ----
    const dict = await cdp.eval(`(async () => {
      const from = document.getElementById('dictationTermFrom')
      const to = document.getElementById('dictationTermTo')
      const form = document.getElementById('dictationTermForm')
      from.value = '克勞德'
      to.value = 'Claude'
      form.dispatchEvent(new Event('submit', { cancelable: true }))
      await new Promise((r) => setTimeout(r, 600))
      const rows = [...document.querySelectorAll('#dictationTerms .dict-term')].map((r) => ({
        from: r.dataset.from,
        text: r.textContent,
        pending: r.classList.contains('is-pending')
      }))
      return { rows, cleared: from.value === '' && to.value === '' }
    })()`)
    ok('手動加的詞出現在清單且直接啟用',
      dict?.rows?.length === 1 && dict.rows[0].from === '克勞德' &&
        dict.rows[0].text.includes('Claude') && dict.rows[0].pending === false,
      JSON.stringify(dict))
    ok('送出後把輸入框清空', dict?.cleared === true)

    const badTerm = await cdp.eval(`(async () => {
      const from = document.getElementById('dictationTermFrom')
      const to = document.getElementById('dictationTermTo')
      from.value = '有，標點'
      to.value = 'x'
      document.getElementById('dictationTermForm').dispatchEvent(new Event('submit', { cancelable: true }))
      await new Promise((r) => setTimeout(r, 600))
      return document.querySelectorAll('#dictationTerms .dict-term').length
    })()`)
    ok('帶標點的詞不會被收進字典', badTerm === 1, String(badTerm))

    const removed = await cdp.eval(`(async () => {
      document.querySelector('#dictationTerms .dict-term [data-action="delete-term"]').click()
      await new Promise((r) => setTimeout(r, 600))
      return {
        rows: document.querySelectorAll('#dictationTerms .dict-term').length,
        empty: !!document.querySelector('#dictationTerms .dict-empty')
      }
    })()`)
    ok('刪得掉，而且空的時候有說明文字', removed?.rows === 0 && removed?.empty === true,
      JSON.stringify(removed))

    ok('紀錄是空的時候有說明文字',
      await cdp.eval(`!!document.querySelector('#dictationRecords .dict-empty')`))

    // ---- 錄音端：真的拿得到 16kHz PCM ----
    // 刻意不觸發整條管線：那會走到插入，而插入是模擬 Ctrl+V，會貼進前景視窗。
    const mic = await cdp.eval(`(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } })
        const ctx = new AudioContext({ sampleRate: 16000 })
        const source = ctx.createMediaStreamSource(stream)
        const processor = ctx.createScriptProcessor(2048, 1, 1)
        const mute = ctx.createGain()
        mute.gain.value = 0
        source.connect(processor)
        processor.connect(mute)
        mute.connect(ctx.destination)
        const got = await new Promise((resolve) => {
          let frames = 0
          let peak = 0
          const timer = setTimeout(() => resolve({ frames, peak }), 3000)
          processor.onaudioprocess = (e) => {
            const data = e.inputBuffer.getChannelData(0)
            frames++
            for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]))
            if (frames >= 10) {
              clearTimeout(timer)
              resolve({ frames, peak })
            }
          }
        })
        processor.onaudioprocess = null
        stream.getTracks().forEach((t) => t.stop())
        const rate = ctx.sampleRate
        await ctx.close()
        return { ok: true, rate, ...got }
      } catch (e) {
        return { ok: false, message: String(e.name || e.message || e) }
      }
    })()`)
    ok('拿得到麥克風且是 16kHz', mic?.ok === true && mic.rate === 16000, JSON.stringify(mic))
    ok('ScriptProcessor 真的收到音訊frame', mic?.frames >= 10, JSON.stringify(mic))
    ok('收到的不是數位靜音', (mic?.peak || 0) > 0.001, JSON.stringify(mic))

    // ---- RWD ----
    for (const width of [1440, 900, 560]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width, height: 900, deviceScaleFactor: 1, mobile: false
      })
      await sleep(400)
      const overflow = await cdp.eval(`(() => {
        const doc = document.documentElement
        const offenders = [...document.querySelectorAll('#stt-dictation *')]
          .filter((el) => {
            const r = el.getBoundingClientRect()
            return r.width > 0 && (r.right > doc.clientWidth + 1 || r.left < -1)
          })
          .slice(0, 5)
          .map((el) => el.className)
        return { scroll: doc.scrollWidth > doc.clientWidth, offenders }
      })()`)
      ok(`${width}px 沒有水平溢出`, overflow?.scroll === false && overflow.offenders.length === 0,
        JSON.stringify(overflow))
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride')

    // ---- 桌面指示器（另一扇視窗，只有打包版測得出 asar 裡的頁面載不載得起來）----
    {
      await cdp.eval(`window.electronAPI.dictation.hudState({ state: 'recording', level: 0.5 }), 'ok'`)
      let hudTarget = null
      await waitFor(async () => {
        const pages = await getJson(`http://127.0.0.1:${PORT}/json/list`).catch(() => [])
        hudTarget = pages.find((p) => p.type === 'page' && /dictation-hud\.html/.test(p.url))
        return Boolean(hudTarget)
      }, 10000, '指示器視窗出現').catch(() => {})
      ok('錄音狀態會開出指示器視窗（asar 裡的頁面載得起來）', Boolean(hudTarget),
        hudTarget ? '' : '找不到 dictation-hud.html 的 target')

      if (hudTarget) {
        const hudCdp = new Cdp(hudTarget.webSocketDebuggerUrl)
        await hudCdp.connect()
        await waitFor(() => hudCdp.eval(`document.readyState === 'complete'`), 8000, '指示器載入')
        const shape = await hudCdp.eval(`(() => {
          const pill = document.getElementById('pill')
          const r = pill.getBoundingClientRect()
          const bars = [...document.querySelectorAll('#hudWave span')]
          return {
            bars: bars.length,
            shown: pill.classList.contains('is-shown'),
            // 藥丸以外的區域不吃滑鼠，不然這扇透明方框會擋住底下的程式
            bodyPointer: getComputedStyle(document.body).pointerEvents,
            pillPointer: getComputedStyle(pill).pointerEvents,
            wider: r.width < window.innerWidth,
            hasApi: typeof window.electronAPI?.dictation?.hudAction === 'function'
          }
        })()`)
        ok('指示器畫出波形且藥丸不佔滿整扇視窗',
          shape?.bars === 17 && shape.shown === true && shape.wider === true, JSON.stringify(shape))
        ok('藥丸以外不吃滑鼠（不會擋住底下的程式）',
          shape?.bodyPointer === 'none' && shape.pillPointer === 'auto', JSON.stringify(shape))
        ok('指示器拿得到 preload 的 hudAction', shape?.hasApi === true)
        ok('指示器沒有未處理例外', hudCdp.exceptions.length === 0, JSON.stringify(hudCdp.exceptions))
        hudCdp.close?.()
      }

      await cdp.eval(`window.electronAPI.dictation.hudState({ state: 'idle' }), 'ok'`)
      await sleep(400)
    }

    // 常駐背景時的反應速度（**放最後**：這一段會把視窗縮起來，之後量不到版面尺寸；
    // 也刻意不還原視窗——把視窗叫回前景會搶走使用者當下的焦點）。
    //
    // 視窗縮起來之後 Chromium 會把這個 renderer 的**計時器**節流到十幾秒才跑一次
    // （實測 20×setTimeout(4ms)：89ms → 19828ms，見 scripts/probe-dictation-latency.js），
    // 但 main→renderer 的訊息派送**不受影響**（實測 0～1ms）。語音輸入的熱鍵路徑
    // （dictation:event → startRecording → 已經開著的 AudioContext）全程沒有計時器，
    // 所以常駐背景時照樣即時。這條就是守住「不要有人往熱鍵路徑上加 setTimeout」。
    const bg = await cdp.eval(`(async () => {
      const box = document.getElementById('dictationEnabledInput')
      box.checked = true
      box.dispatchEvent(new Event('change'))
      await new Promise((r) => setTimeout(r, 800))
      await window.electronAPI.window.minimize()
      await new Promise((r) => setTimeout(r, 3000))
      const t0 = Date.now()
      const status = await window.electronAPI.dictation.status()
      const ipcMs = Date.now() - t0
      box.checked = false
      box.dispatchEvent(new Event('change'))
      return { hidden: document.hidden, ipcMs, listening: status?.data?.listening }
    })()`)
    ok('縮起來時 document.hidden 是 true（AGY 與系統監控的輪詢靠它停）',
      bg?.hidden === true, JSON.stringify(bg))
    ok('藏起來的 renderer 走 IPC 仍然是即時的（<500ms）', Number(bg?.ipcMs) < 500, JSON.stringify(bg))
    ok('藏起來時熱鍵還掛著', bg?.listening === true, JSON.stringify(bg))

    ok('renderer 無未處理例外', cdp.exceptions.length === 0, JSON.stringify(cdp.exceptions))
  } catch (error) {
    failed++
    console.error(`\n未預期例外：${error.stack || error}`)
    console.error('Renderer exceptions:', JSON.stringify(cdp?.exceptions || []))
    console.error('Process log:', processLog.slice(-4000))
  } finally {
    cdp?.close()
    // 只殺自己 spawn 出來的那棵樹（禁止 /IM：會把使用者的安裝版一起關掉）
    try { child.kill() } catch { /* ignore */ }
    if (child.pid) {
      try { spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' }) } catch { /* ignore */ }
    }
    // SQLite／electron-store 在 Windows 上釋放檔案有延遲，刪不掉就留給 OS 清
    for (let i = 0; i < 5; i++) {
      await sleep(500)
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true })
        break
      } catch { /* retry */ }
    }
  }

  console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILED'}  ${passed} passed, ${failed} failed\n`)
  process.exitCode = failed === 0 ? 0 : 1
}

main()
