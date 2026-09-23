/**
 * 打包版 CDP：錄音機子分頁 ＋ 檔案轉錄接錄音 ＋ 即時字幕的紀錄
 * 用法：node scripts/e2e-recorder-cdp.js（會自己啟動 dist/win-unpacked/VoiceInk.exe）
 *
 * 暫存 user-data-dir ＋ Chromium 假麥克風（`--use-fake-device-for-media-stream`，一段 beep），
 * 不碰使用者的錄音與設定。錄出來的檔再用 ffmpeg 量一次「真的是 opus、解得出聲音」。
 * 字幕紀錄不跑真的擷取（要系統音訊與模型），而是從 renderer 經同一條 IPC 種兩句進去。
 */
const { spawn, spawnSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const http = require('http')
const { tempDir } = require('./lib/test-temp')

const PORT = 9247
const EXE = process.env.VOICEINK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
const USER_DATA_DIR = tempDir('voiceink-rec-cdp-')
/** 設了才截圖（會把視窗秀出來，不搶焦點但看得到） */
const SHOT_DIR = process.env.VOICEINK_SHOT_DIR || ''
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => { try { resolve(JSON.parse(body)) } catch (e) { reject(e) } })
    }).on('error', reject)
  })
}

class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.exceptions = []; this.logs = [] }
  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve)
      this.ws.addEventListener('error', reject)
    })
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(msg.params?.exceptionDetails?.exception?.description || 'runtime exception')
      }
      if (msg.method === 'Runtime.consoleAPICalled' && /error|warn/.test(msg.params.type)) {
        this.logs.push(msg.params.args.map((a) => a.value ?? a.description).join(' '))
      }
      if (!msg.id || !this.pending.has(msg.id)) return
      const p = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message))
      else p.resolve(msg.result)
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
    // userGesture：AudioContext 沒有使用者手勢會停在 suspended（音量條永遠 0）
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result?.value
  }
  /** 只在設了 VOICEINK_SHOT_DIR 時截（那時才秀視窗；--hidden 的視窗不出畫面，截圖會一直等） */
  async shot(name) {
    if (!SHOT_DIR) return
    const r = await Promise.race([
      this.send('Page.captureScreenshot', { format: 'png' }),
      sleep(8000).then(() => null)
    ])
    if (!r) return console.log(`      截圖逾時 ${name}`)
    const file = path.join(SHOT_DIR, name)
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
    console.log(`      截圖 ${file}`)
  }
  close() { try { this.ws.close() } catch { /* ignore */ } }
}

async function waitFor(action, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await action()) return true
    await sleep(250)
  }
  throw new Error(`等待逾時：${label}`)
}

/** 用 ffmpeg 解一次：編碼是不是 opus、解出來的 PCM 有沒有東西 */
function probeWebm(file) {
  const ffmpeg = require('ffmpeg-static')
  const r = spawnSync(ffmpeg, ['-hide_banner', '-i', file, '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'], {
    maxBuffer: 64 * 1024 * 1024
  })
  return { opus: /Audio: opus/.test(String(r.stderr)), pcmBytes: r.stdout?.length || 0 }
}

async function main() {
  const child = spawn(EXE, [
    // 不秀視窗、不搶焦點（跟 e2e-app-dialog-cdp 同一套）；要截圖才秀
    ...(SHOT_DIR ? [] : ['--hidden']),
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DATA_DIR}`,
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    // 視窗被使用者的其他視窗蓋住時 Chromium 不出畫面，<dialog> 的 close 事件就排不到
    '--disable-backgrounding-occluded-windows'
  ], { stdio: 'ignore' })

  let cdp = null
  let passed = 0
  let failed = 0
  const ok = (name, cond, extra = '') => {
    if (cond) { passed++; console.log(`PASS  ${name}`) } else { failed++; console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`) }
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
    await cdp.send('Page.enable')
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
    await waitFor(() => cdp.eval(`document.readyState === 'complete' && !!window.electronAPI?.sttArchive`), 15000, 'preload')
    await cdp.eval(`window.electronAPI.store.set('sysmonSensors', false)`)

    // ---- 錄音機 ----
    await cdp.eval(`document.querySelector('[data-page="stt"]').click(), 'ok'`)
    // 子分頁的 click 是 stt-page.js 動態載入後才掛上的
    await waitFor(() => cdp.eval(`!!document.getElementById('fileAsrModel')?.options.length`), 10000, '語音轉文字頁載入')
    await cdp.eval(`document.querySelector('#sttSubtabs [data-subtab="recorder"]').click(), 'ok'`)
    await waitFor(() => cdp.eval(`!!document.querySelector('#recList .dict-empty')`), 10000, '錄音清單畫好（空）')
    ok('錄音機子分頁顯示且只有它 active', await cdp.eval(`(() => {
      const act = [...document.querySelectorAll('#page-stt .subtab-panel.active')].map((p) => p.id)
      return act.length === 1 && act[0] === 'stt-recorder' && document.getElementById('stt-recorder').offsetHeight > 0
    })()`))
    await cdp.shot('rec-empty.png')

    await cdp.eval(`document.getElementById('recStartBtn').click(), 'ok'`)
    await waitFor(() => cdp.eval(`document.getElementById('recStatus').classList.contains('active')`), 8000, '開始錄音')
    // 假麥克風一秒才嗶一下、其餘靜音：錄音期間一直量，取最大值
    let peak = 0
    for (let i = 0; i < 26; i++) {
      peak = Math.max(peak, await cdp.eval(`parseFloat(document.getElementById('recLevel').style.width) || 0`))
      await sleep(100)
    }
    const during = await cdp.eval(`({
      timer: document.getElementById('recTimer').textContent,
      level: ${peak},
      stopShown: document.getElementById('recStopBtn').offsetHeight > 0,
      startHidden: document.getElementById('recStartBtn').offsetHeight === 0
    })`)
    ok('錄音中：計時在走、停止鈕出現', during.timer !== '00:00' && during.stopShown && during.startHidden, JSON.stringify(during))
    ok('錄音中：音量條有動（假麥克風是 beep）', during.level > 0, JSON.stringify(during))
    await cdp.shot('rec-recording.png')

    await cdp.eval(`document.getElementById('recStopBtn').click(), 'ok'`)
    await waitFor(() => cdp.eval(`document.querySelectorAll('#recList .rec-item').length === 1`), 10000, '清單出現一筆')
    const recName = await cdp.eval(`document.querySelector('#recList .rec-item').dataset.name`)
    const recFile = path.join(USER_DATA_DIR, 'recordings', recName)
    ok('錄音檔落在 userData/recordings', /^rec-\d{13}\.webm$/.test(recName) && fs.existsSync(recFile))
    const probe = probeWebm(recFile)
    if (!probe.opus && process.env.VOICEINK_SHOT_DIR) fs.copyFileSync(recFile, path.join(process.env.VOICEINK_SHOT_DIR, 'bad.webm'))
    // 16kHz s16 mono ＝ 32000 bytes/秒；錄了約 2.6 秒，至少要有 1.5 秒
    ok('ffmpeg 解得開：opus 且約兩秒以上的聲音', probe.opus && probe.pcmBytes > 48000, JSON.stringify(probe))
    await cdp.shot('rec-list.png')

    await cdp.eval(`document.querySelector('#recList .rec-item [data-act="play"]').click(), 'ok'`)
    await waitFor(() => cdp.eval(`!!document.querySelector('#recList audio')?.src`), 8000, '播放器')
    ok('播放：audio 讀得到長度', await waitFor(
      () => cdp.eval(`(() => { const a = document.querySelector('#recList audio'); return a && a.readyState >= 1 })()`),
      8000, 'audio metadata'
    ))

    // ---- 轉錄 → 檔案轉錄 ----
    await cdp.eval(`document.querySelector('#recList .rec-item [data-act="transcribe"]').click(), 'ok'`)
    await waitFor(() => cdp.eval(`document.getElementById('stt-file').classList.contains('active') && document.querySelector('#fileInfo .file-name').textContent === ${JSON.stringify(recName)}`), 8000, '切到檔案轉錄並帶入')
    ok('轉錄鈕：切到檔案轉錄、檔案帶進來、開始轉錄鈕可按', await cdp.eval(`(() =>
      !document.getElementById('fileInfo').classList.contains('hidden') &&
      !document.getElementById('transcribeOptions').classList.contains('hidden') &&
      document.getElementById('dropZone').classList.contains('hidden')
    )()`))

    // 檔案轉錄那一側：下拉也選得到同一份
    await cdp.eval(`document.getElementById('clearFileBtn').click(), 'ok'`)
    await cdp.eval(`document.querySelector('#sttSubtabs [data-subtab="recorder"]').click(), 'ok'`)
    await cdp.eval(`document.querySelector('#sttSubtabs [data-subtab="file"]').click(), 'ok'`)
    await waitFor(() => cdp.eval(`document.getElementById('recordingPick').options.length === 2`), 8000, '錄音下拉')
    const pickVisible = await cdp.eval(`document.getElementById('recordingPickGroup').offsetHeight > 0`)
    ok('檔案轉錄的「或選一段錄音」看得到', pickVisible)
    await cdp.shot('file-pick.png')
    await cdp.eval(`(() => { const s = document.getElementById('recordingPick'); s.value = ${JSON.stringify(recName)}; s.dispatchEvent(new Event('change')); return 1 })()`)
    ok('從下拉選錄音也帶得進來', await cdp.eval(`document.querySelector('#fileInfo .file-name').textContent === ${JSON.stringify(recName)} && document.getElementById('recordingPick').value === ''`))
    await cdp.eval(`document.getElementById('clearFileBtn').click(), 'ok'`)

    // ---- 字幕紀錄 ----
    const liveId = await cdp.eval(`(async () => {
      const id = 'live-' + (Date.now() - 125000)
      const api = window.electronAPI.sttArchive
      await api.appendTranscript(id, { key: 'b-1-1', source: 'Hello everyone', translation: '' })
      await api.appendTranscript(id, { key: 'b-1-2', source: 'Welcome back', translation: '歡迎回來' })
      await api.appendTranscript(id, { key: 'b-1-1', source: 'Hello everyone', translation: '大家好' })
      return id
    })()`)
    await cdp.eval(`document.querySelector('#sttSubtabs [data-subtab="live"]').click(), 'ok'`)
    await waitFor(() => cdp.eval(`document.querySelectorAll('#liveHistoryList .rec-item').length === 1`), 8000, '字幕紀錄一筆')
    const meta = await cdp.eval(`document.querySelector('#liveHistoryList .dict-record-time').textContent`)
    ok('字幕紀錄：句數與長度', /2 句/.test(meta) && /分鐘/.test(meta), meta)
    await cdp.eval(`document.querySelector('#liveHistoryList [data-act="view"]').click(), 'ok'`)
    await waitFor(() => cdp.eval(`!!document.querySelector('#liveHistoryList .live-history-body')`), 5000, '展開')
    const body = await cdp.eval(`[...document.querySelectorAll('#liveHistoryList .live-history-body p')].map((p) => p.textContent)`)
    ok('展開看得到原文＋譯文，後寫的譯文蓋掉空的', JSON.stringify(body) === JSON.stringify(['Hello everyone', '大家好', 'Welcome back', '歡迎回來']), JSON.stringify(body))
    ok('字幕紀錄面板量得到高度', await cdp.eval(`document.querySelector('.live-history').offsetHeight > 60`))
    await cdp.eval(`document.querySelector('.live-history').scrollIntoView({ block: 'end' }), 'ok'`)
    await cdp.shot('live-history.png')

    // 刪除走 app-dialog
    await cdp.eval(`document.querySelector('#liveHistoryList [data-act="delete"]').click(), 'ok'`)
    await waitFor(() => cdp.eval(`!!document.querySelector('dialog.app-dialog[open] .btn-danger')`), 5000, '確認框')
    await cdp.eval(`document.querySelector('dialog.app-dialog[open] .btn-danger').click(), 'ok'`)
    await waitFor(() => cdp.eval(`!!document.querySelector('#liveHistoryList .dict-empty')`), 5000, '刪掉後變空')
    ok('字幕紀錄刪得掉（檔案也不在了）', !fs.existsSync(path.join(USER_DATA_DIR, 'live-transcripts', `${liveId}.jsonl`)))

    await cdp.eval(`document.querySelector('#sttSubtabs [data-subtab="recorder"]').click(), 'ok'`)
    await waitFor(() => cdp.eval(`document.querySelectorAll('#recList .rec-item').length === 1`), 5000, '回到錄音清單')
    await cdp.eval(`document.querySelector('#recList [data-act="delete"]').click(), 'ok'`)
    await waitFor(() => cdp.eval(`!!document.querySelector('dialog.app-dialog[open] .btn-danger')`), 5000, '確認框')
    await cdp.eval(`document.querySelector('dialog.app-dialog[open] .btn-danger').click(), 'ok'`)
    await waitFor(() => cdp.eval(`!!document.querySelector('#recList .dict-empty')`), 5000, '錄音刪掉後變空')
    ok('錄音刪得掉', !fs.existsSync(recFile))

    ok('過程沒有未處理的例外', cdp.exceptions.length === 0, cdp.exceptions.join(' | '))
  } catch (error) {
    failed++
    console.log(`FAIL  ${error.message}`)
    if (cdp?.exceptions.length) console.log(`      例外：${cdp.exceptions.join(' | ')}`)
    if (cdp?.logs.length) console.log(`      console：${cdp.logs.slice(-5).join(' | ')}`)
    const state = await cdp?.eval(`({
      active: [...document.querySelectorAll('#page-stt .subtab-panel.active')].map((p) => p.id),
      recList: document.getElementById('recList')?.innerHTML.slice(0, 200),
      history: document.getElementById('liveHistoryList')?.innerHTML.slice(0, 300),
      toast: document.getElementById('toast')?.textContent,
      dialogs: document.querySelectorAll('dialog[open]').length
    })`).catch((e) => e.message)
    console.log(`      狀態：${JSON.stringify(state)}`)
    for (const sub of ['recordings', 'live-transcripts']) {
      const dir = path.join(USER_DATA_DIR, sub)
      console.log(`      ${sub}：${fs.existsSync(dir) ? fs.readdirSync(dir).join(', ') : '(無)'}`)
    }
  } finally {
    cdp?.close()
    // 只殺自己 spawn 的那一顆
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  }
  console.log(`\n${failed ? 'FAILED' : 'ALL PASS'} — ${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main()
