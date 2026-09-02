'use strict'

/**
 * 語音輸入 main 端 e2e：`npx electron scripts/e2e-dictation.js`
 *
 * 用 mock 的 OpenAI 相容端點，不打真 API、不用真麥克風，
 * 也**不真的送 Ctrl+V**（插入實作被換掉；真的送會貼進當下的前景視窗）。
 *
 * 驗證：整條管線（ASR → 字典 → 整理 → 插入 → 紀錄）、整理失敗仍插入原文、
 *       錯誤不外洩上游 body、自動學詞到門檻才生效、紀錄與字典落盤、
 *       未啟用時不掛全域熱鍵、`dictations.json` 真的寫在 userData。
 */

const { app } = require('electron')
const http = require('http')
const os = require('os')
const path = require('path')
const fs = require('fs')

let passed = 0
const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}

/** 上游的可切換行為 */
const upstreamState = {
  mode: 'ok',
  reply: '',
  lastBody: null
}

const FAKE_TOKEN = 'sk-should-never-appear-in-any-message'

function startMockUpstream() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => { raw += chunk })
      req.on('end', () => {
        upstreamState.lastBody = raw ? JSON.parse(raw) : null
        if (upstreamState.mode === 'error') {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: `上游壞掉了，你的金鑰是 ${FAKE_TOKEN}` } }))
          return
        }
        if (upstreamState.mode === 'garbage') {
          res.writeHead(200, { 'Content-Type': 'text/plain' })
          res.end('這不是 JSON')
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: upstreamState.reply } }] }))
      })
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

/** 極簡 store 假物件（只要 get；語音輸入不寫設定 store） */
function makeStore(values) {
  return {
    get: (key, def) => (Object.prototype.hasOwnProperty.call(values, key) ? values[key] : def)
  }
}

async function main() {
  // 紀錄與字典會落在 userData，測試用暫存目錄，不碰使用者的檔案
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-dictation-'))
  app.setPath('userData', tmp)
  await app.whenReady()

  const upstream = await startMockUpstream()
  const port = upstream.address().port
  const apiUrl = `http://127.0.0.1:${port}/v1`

  const dictation = require(path.join(__dirname, '..', 'src', 'main', 'dictation'))
  const text = require(path.join(__dirname, '..', 'src', 'main', 'dictation', 'text'))
  const hotkey = require(path.join(__dirname, '..', 'src', 'main', 'dictation', 'hotkey'))

  const settings = {
    dictationEnabled: false,
    dictationLang: 'zh-TW',
    dictationLlm: `cloud:p1:gpt-test`,
    dictationAsr: 'local:qwen3asr',
    chatProviders: [
      { id: 'p1', name: 'Mock', apiUrl, apiKey: 'k-1', models: ['gpt-test'], imageModels: [] }
    ]
  }
  dictation.setStore(makeStore(settings))

  /** @type {string[]} */
  const inserted = []
  /** @type {object[]} */
  const events = []
  let asrText = ''
  dictation.configure({
    emit: (payload) => events.push(payload),
    transcribe: async () => asrText,
    insert: async (t) => {
      inserted.push(t)
      return { ok: true, chars: t.length }
    }
  })

  console.log('\n[A] 狀態與熱鍵')
  {
    const before = dictation.status()
    check('未啟用時不掛全域熱鍵', before.enabled === false && before.listening === false)
    check('狀態回報目前語言', before.lang === 'zh-TW')
    check('狀態回報整理模型', before.cleaner.mode === 'cloud' && before.cleaner.modelId === 'gpt-test')

    // refresh 是 async（原生熱鍵 sidecar 的啟動要等它回 READY）
    const off = await dictation.refresh()
    check('關閉時 refresh 不會掛 hook', off.ok === true && off.enabled === false && !hotkey.isRunning())
  }

  console.log('\n[B] 完整管線（雲端整理）')
  {
    asrText = '嗯那個我今天想說我們來做一下語音輸入這個功能'
    upstreamState.mode = 'ok'
    upstreamState.reply = '我今天想做語音輸入這個功能。'
    const result = await dictation.submit({ samples: new Float32Array(16000), sampleRate: 16000, durationMs: 1000 })

    check('回報成功', result.ok === true, JSON.stringify(result))
    check('回傳整理後的文字', result.text === '我今天想做語音輸入這個功能。', result.text)
    check('原文一併回傳', result.raw === asrText)
    check('真的插入了整理後的文字', inserted[inserted.length - 1] === result.text)
    check('送給上游的是 ASR 原文', upstreamState.lastBody?.messages?.[1]?.content === asrText)
    check('system prompt 有整理規則', String(upstreamState.lastBody?.messages?.[0]?.content).includes('贅詞'))
    // exclude 而不是 enabled:false：後者對強制思考的模型會被上游直接回 400
    check('整理要求不回思考內容', upstreamState.lastBody?.reasoning?.exclude === true)

    const records = await dictation.listRecords({ limit: 10 })
    check('紀錄有落盤', records.length === 1 && records[0].text === result.text)
    check('紀錄記得原文', records[0].raw === asrText)
    check('紀錄記得是否插入成功', records[0].inserted === true)
    check('紀錄標了有整理', records[0].llm === '已整理')

    const types = events.map((e) => e.type)
    check('有送出處理中的事件', types.includes('processing') && types.includes('transcribed'))
    check('最後回到 idle', types[types.length - 1] === 'idle')
  }

  console.log('\n[C] 整理失敗仍要把話交出去')
  {
    inserted.length = 0
    asrText = '整理服務掛掉的時候講的話'
    upstreamState.mode = 'error'
    const result = await dictation.submit({ samples: new Float32Array(16000), sampleRate: 16000, durationMs: 900 })

    check('仍然回報成功', result.ok === true)
    check('用的是 ASR 原文', result.text === asrText)
    check('原文照樣插入', inserted[0] === asrText)
    check('有帶警告', Boolean(result.warning))
    check(
      '錯誤訊息不含上游 body 與金鑰',
      !JSON.stringify(result).includes(FAKE_TOKEN) && !JSON.stringify(result).includes('上游壞掉了'),
      JSON.stringify(result)
    )
  }

  console.log('\n[D] 上游回非 JSON')
  {
    inserted.length = 0
    asrText = '上游回垃圾的時候'
    upstreamState.mode = 'garbage'
    const result = await dictation.submit({ samples: new Float32Array(16000), sampleRate: 16000, durationMs: 800 })
    check('照樣插入原文', result.ok === true && inserted[0] === asrText)
    check('訊息不含回應內容', !JSON.stringify(result).includes('這不是 JSON'))
  }

  console.log('\n[E] 空的 ASR 結果')
  {
    inserted.length = 0
    asrText = '   '
    const result = await dictation.submit({ samples: new Float32Array(16000), sampleRate: 16000, durationMs: 500 })
    check('沒聽到內容就不插入', result.ok === false && inserted.length === 0, JSON.stringify(result))
  }

  console.log('\n[F] 自動學詞（要兩次才生效）')
  {
    upstreamState.mode = 'ok'
    asrText = '我在用克勞德扣的寫程式'
    upstreamState.reply = '我在用Claude Code寫程式'
    await dictation.submit({ samples: new Float32Array(16000), sampleRate: 16000, durationMs: 1200 })

    let dict = await dictation.listDictionary()
    const learned = dict.find((e) => e.from === '克勞德扣的')
    check('第一次就記下來', Boolean(learned), JSON.stringify(dict))
    check('第一次還沒啟用', learned?.active === false)
    check('尚未啟用的詞不會參與取代', text.applyDictionary('克勞德扣的', text.activeEntries(dict)) === '克勞德扣的')

    await dictation.submit({ samples: new Float32Array(16000), sampleRate: 16000, durationMs: 1200 })
    dict = await dictation.listDictionary()
    const promoted = dict.find((e) => e.from === '克勞德扣的')
    check('第二次就啟用', promoted?.active === true && promoted.count === 2, JSON.stringify(promoted))

    // 啟用之後，ASR 原文在送去整理之前就先被換掉
    asrText = '克勞德扣的很好用'
    upstreamState.reply = 'Claude Code 很好用。'
    const result = await dictation.submit({ samples: new Float32Array(16000), sampleRate: 16000, durationMs: 900 })
    check(
      '啟用後的詞在送去整理前就替換掉',
      upstreamState.lastBody?.messages?.[1]?.content === 'Claude Code很好用',
      String(upstreamState.lastBody?.messages?.[1]?.content)
    )
    check('字典也寫進 system prompt', String(upstreamState.lastBody?.messages?.[0]?.content).includes('克勞德扣的 → Claude Code'))
    check('結果仍是整理後的文字', result.text === 'Claude Code 很好用。')
  }

  console.log('\n[F2] 字典壓過整理模型（模型把換好的詞改回去也沒用）')
  {
    // 上一段已經把「克勞德扣的 → Claude Code」學成啟用中的詞
    asrText = '克勞德扣的真好用'
    upstreamState.reply = '克勞德扣的真好用。'   // 模型把字典換過的詞又改了回去
    const result = await dictation.submit({ samples: new Float32Array(16000), sampleRate: 16000, durationMs: 900 })
    check('最後出去的還是字典的寫法', result.text === 'Claude Code真好用。', result.text)
    check('真的插入的也是字典的寫法', inserted[inserted.length - 1] === result.text)

    // 而且模型的反對意見要被記下來：這一條退回「觀察中」，之後不再自動替換
    const dict = await dictation.listDictionary()
    const entry = dict.find((e) => e.from === '克勞德扣的')
    check('被推翻就退回觀察中', entry?.active === false && entry.count === 1, JSON.stringify(entry))
    check('退回觀察中之後不再參與替換',
      text.applyDictionary('克勞德扣的', text.activeEntries(dict)) === '克勞德扣的')
  }

  console.log('\n[F3] 長篇走重寫模式')
  {
    const short = '幫我把設定打開'
    asrText = short
    upstreamState.reply = '幫我把設定打開。'
    await dictation.submit({ samples: new Float32Array(16000), sampleRate: 16000, durationMs: 900 })
    const shortPrompt = String(upstreamState.lastBody?.messages?.[0]?.content || '')
    check('短句用保守整理', shortPrompt.includes('不要換掉使用者原本的用詞或重寫整句'))

    const long = '那個我們今天先講一下進度啊就是那個登入的部分做完了然後嗯註冊還沒註冊那邊卡在簡訊驗證對然後我剛剛想到登入那邊還有一個記住我的功能沒做要補一下'.repeat(3)
    asrText = long
    upstreamState.reply = '今天先講進度。登入做完了，「記住我」還沒做。\n\n註冊卡在簡訊驗證。'
    await dictation.submit({ samples: new Float32Array(16000), sampleRate: 16000, durationMs: 60000 })
    const longPrompt = String(upstreamState.lastBody?.messages?.[0]?.content || '')
    check('長篇切到重寫模式', longPrompt.includes('重新組織') && longPrompt.includes('長篇範例'),
      `len=${long.length}`)
    check('重寫模式仍然不准加料', longPrompt.includes('不可以自己補上他沒講的內容'))
  }

  console.log('\n[G] 手動字典')
  {
    const bad = await dictation.upsertDictionary({ from: '有，標點', to: 'x' })
    check('帶標點的詞被擋下', bad.ok === false)

    await dictation.upsertDictionary({ from: '歐印', to: 'All in' })
    const dict = await dictation.listDictionary()
    const manual = dict.find((e) => e.from === '歐印')
    check('手動加的直接啟用', manual?.active === true)

    await dictation.removeDictionary('歐印')
    const after = await dictation.listDictionary()
    check('刪得掉', !after.some((e) => e.from === '歐印'))
  }

  console.log('\n[H] 不整理模式')
  {
    inserted.length = 0
    dictation.setStore(makeStore({ ...settings, dictationLlm: '' }))
    asrText = '不整理的時候原文直接出去'
    const result = await dictation.submit({ samples: new Float32Array(16000), sampleRate: 16000, durationMs: 700 })
    check('原文直接插入', result.ok === true && inserted[0] === asrText)
    const records = await dictation.listRecords({ limit: 1 })
    check('紀錄標了未整理', records[0].llm === '未整理')
  }

  console.log('\n[I] 落盤位置與清理')
  {
    const file = path.join(tmp, 'dictations.json')
    check('dictations.json 寫在 userData', fs.existsSync(file))
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    check('檔案裡同時有紀錄與字典', Array.isArray(raw.records) && Array.isArray(raw.dictionary))

    await dictation.clearRecords()
    const records = await dictation.listRecords({ limit: 10 })
    check('清得掉', records.length === 0)
    const dict = await dictation.listDictionary()
    check('清紀錄不會連字典一起清掉', dict.length > 0)
  }

  console.log('\n[J] 供應商不見時不打任何端點')
  {
    inserted.length = 0
    dictation.setStore(makeStore({ ...settings, dictationLlm: 'cloud:gone:gpt-test' }))
    asrText = '供應商被刪掉之後'
    const result = await dictation.submit({ samples: new Float32Array(16000), sampleRate: 16000, durationMs: 600 })
    check('退回原文', result.ok === true && result.text === asrText)
    check('有警告', Boolean(result.warning))
  }

  console.log('\n[K] 桌面指示器（真的開一扇視窗）')
  {
    const { screen } = require('electron')
    const hud = require(path.join(__dirname, '..', 'src', 'main', 'dictation', 'hud.js'))
    hud.configure({ isDev: false, preload: path.join(__dirname, '..', 'src', 'preload', 'preload.js') })

    // 純算術：底部中央，而且要吃 workArea 的原點（副螢幕的 x／y 不是 0）
    const wa = { x: -1920, y: 120, width: 1920, height: 1080 }
    const b = hud.hudBounds(wa, hud.SIZE)
    check('指示器水平置中於該螢幕', b.x === Math.round(-1920 + (1920 - hud.SIZE.width) / 2))
    check('指示器貼在該螢幕工作區底部', b.y === 120 + 1080 - hud.SIZE.height - hud.MARGIN_BOTTOM)

    check('idle 不會白開一扇視窗', hud.update({ state: 'idle' }) === true && hud._window() === null)

    hud.update({ state: 'recording', level: 0.4 })
    const win = hud._window()
    check('錄音時視窗開起來了', Boolean(win) && !win.isDestroyed())
    // 這條是整個功能的地雷：指示器搶到焦點的話，Ctrl+V 會貼進指示器而不是使用者的程式
    check('指示器不可被啟用（focusable=false）', win.isFocusable() === false)
    check('指示器沒有搶走焦點', win.isFocused() === false)
    check('指示器不進工作列', win.isVisible() === true)

    const cur = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const want = hud.hudBounds(cur.workArea, hud.SIZE)
    const got = win.getBounds()
    check('擺在滑鼠所在那一面螢幕的底部中央',
      got.x === want.x && got.y === want.y, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`)
    // DPI 縮放會讓 DIP↔px 換算差個一兩 px，所以給容差；重點是「有沒有變」
    const near = (a, b) => Math.abs(a - b) <= 2
    check('視窗開出來就是設定的尺寸',
      near(got.width, hud.SIZE.width) && near(got.height, hud.SIZE.height), JSON.stringify(got))

    hud.update({ state: 'error', message: 'x'.repeat(500) })
    const wide = hud._window().getBounds()
    check('錯誤狀態不改視窗尺寸（藥丸在固定的透明方框裡自己撐寬）',
      wide.width === got.width && wide.height === got.height,
      `${JSON.stringify(got)} → ${JSON.stringify(wide)}`)

    hud.update({ state: 'idle' })
    check('回 idle 就收起來', hud._window().isVisible() === false)

    check('非指示器送來的 ✕／✓ 一律不收', hud.isSender({ sender: {} }) === false)

    // 藥丸上的兩顆鈕：從 renderer 一路走到 main，而且 main 認得出是它送的
    const { ipcMain } = require('electron')
    const actions = []
    ipcMain.handle('dictation:hudAction', (event, action) => {
      actions.push({ action, fromHud: hud.isSender(event) })
      return true
    })
    hud.update({ state: 'recording', level: 0.3 })
    await new Promise((r) => setTimeout(r, 900))
    const hudWin = hud._window()
    await hudWin.webContents.executeJavaScript("document.getElementById('hudStop').click()")
    await hudWin.webContents.executeJavaScript("document.getElementById('hudCancel').click()")
    await new Promise((r) => setTimeout(r, 250))
    check('按 ✓ 送出 stop', actions[0]?.action === 'stop', JSON.stringify(actions))
    check('按 ✕ 送出 cancel', actions[1]?.action === 'cancel', JSON.stringify(actions))
    check('main 認得出這兩則來自指示器視窗',
      actions.length === 2 && actions.every((a) => a.fromHud === true))

    const bars = await hudWin.webContents.executeJavaScript(
      "[...document.querySelectorAll('#hudWave span')].length"
    )
    check('波形有畫出來', bars === 17, `bars=${bars}`)

    hud.update({ state: 'idle' })
    hud.close()
    check('close 之後不留視窗', hud._window() === null)
  }

  dictation.shutdown()
  upstream.close()

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) console.log('failed:', failures.join(', '))
  // 暫存目錄留給 OS 清（Windows 上 electron-store 釋放檔案有延遲）
  app.exit(failures.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  app.exit(1)
})
