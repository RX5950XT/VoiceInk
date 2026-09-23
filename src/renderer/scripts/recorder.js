/**
 * VoiceInk - 錄音機（語音轉文字頁的子分頁）
 *
 * 麥克風 → MediaRecorder（webm／opus）→ 每秒一塊送 main append 進 `recordings/`。
 * 不在 renderer 累積整段：錄到一半 App 當掉，檔案裡最多只少最後一秒。
 * 錄好的檔可以直接「轉錄」＝交給檔案轉錄子分頁（main 端 ffmpeg 讀得了 webm）。
 */

import { showToast, electronAPI, cleanIpcError } from './app.js'
import { askConfirm } from './app-dialog.js'

/** 64kbps opus：200MB 上限約 7 小時，語音清楚 */
const BITS_PER_SECOND = 64000
const MIME = 'audio/webm;codecs=opus'

let bound = false
/** @type {MediaRecorder|null} */
let recorder = null
/** @type {MediaStream|null} */
let stream = null
/** @type {AudioContext|null} */
let meterCtx = null
let meterTimer = 0
let fileName = ''
let startedAt = 0
/** 依序 append：每一塊都要等前一塊寫完，順序錯了整個檔就壞了 */
let writeChain = Promise.resolve()
let writeFailed = false
/** 目前在播的那一段（blob URL 要收） */
let playingUrl = ''

const $ = (id) => document.getElementById(id)

/**
 * @param {Promise<{ ok: boolean, data?: any, error?: { message: string } }>} p
 */
async function call(p) {
  const res = await p
  if (!res?.ok) throw new Error(res?.error?.message || '操作失敗')
  return res.data
}

export function isRecording() {
  return recorder !== null
}

function bindOnce() {
  if (bound) return
  bound = true
  $('recStartBtn').addEventListener('click', start)
  $('recStopBtn').addEventListener('click', () => stop())
  $('recOpenFolderBtn').addEventListener('click', () => {
    call(electronAPI.sttArchive.openRecordings()).catch((e) => showToast(cleanIpcError(e), 'error'))
  })
  $('recList').addEventListener('click', onListClick)
}

export async function refreshRecorderPage() {
  bindOnce()
  paintState()
  await renderList()
}

async function start() {
  if (recorder) return
  $('recStartBtn').disabled = true
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const rec = new MediaRecorder(stream, { mimeType: MIME, audioBitsPerSecond: BITS_PER_SECOND })
    startedAt = Date.now()
    fileName = `rec-${startedAt}.webm`
    writeChain = Promise.resolve()
    writeFailed = false
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) queueWrite(e.data)
    }
    rec.onerror = () => stop('錄音裝置出錯，已停止')
    // 麥克風被拔掉／被系統收回
    stream.getAudioTracks().forEach((t) => t.addEventListener('ended', () => stop('麥克風中斷，已停止')))
    rec.start(1000)
    recorder = rec
    startMeter(stream)
  } catch (error) {
    releaseStream()
    showToast(error?.name === 'NotAllowedError' ? '沒有麥克風權限' : `無法開始錄音: ${error.message}`, 'error')
  } finally {
    $('recStartBtn').disabled = false
    paintState()
  }
}

/** @param {Blob} blob */
function queueWrite(blob) {
  const name = fileName
  writeChain = writeChain.then(async () => {
    if (writeFailed) return
    try {
      await call(electronAPI.sttArchive.appendRecording(name, new Uint8Array(await blob.arrayBuffer())))
    } catch (error) {
      writeFailed = true
      showToast(`錄音寫入失敗，已停止：${cleanIpcError(error)}`, 'error')
      stop()
    }
  })
}

/**
 * @param {string} [reason] 不是使用者自己按停止時要講原因
 */
async function stop(reason) {
  const rec = recorder
  if (!rec) return
  recorder = null
  // stop() 會再吐最後一塊 dataavailable，等它出來再等寫完
  const flushed = new Promise((resolve) => rec.addEventListener('stop', resolve, { once: true }))
  if (rec.state !== 'inactive') rec.stop()
  await flushed
  await writeChain
  releaseStream()
  paintState()
  if (reason) showToast(reason, 'error')
  await renderList()
}

function releaseStream() {
  clearInterval(meterTimer)
  meterTimer = 0
  meterCtx?.close().catch(() => {})
  meterCtx = null
  stream?.getTracks().forEach((t) => t.stop())
  stream = null
}

/** @param {MediaStream} s */
function startMeter(s) {
  meterCtx = new AudioContext()
  const analyser = meterCtx.createAnalyser()
  analyser.fftSize = 1024
  meterCtx.createMediaStreamSource(s).connect(analyser)
  const buf = new Float32Array(analyser.fftSize)
  // 用計時器不用 rAF：視窗被遮住時 rAF 不跑，錄音時間也會跟著停
  meterTimer = window.setInterval(() => {
    analyser.getFloatTimeDomainData(buf)
    let peak = 0
    for (const v of buf) peak = Math.max(peak, Math.abs(v))
    $('recLevel').style.width = `${Math.min(100, Math.round(peak * 140))}%`
    $('recTimer').textContent = formatDuration(Date.now() - startedAt)
  }, 100)
}

function paintState() {
  const on = recorder !== null
  $('recStartBtn').classList.toggle('hidden', on)
  $('recStopBtn').classList.toggle('hidden', !on)
  $('recStatus').classList.toggle('active', on)
  $('recStatus').querySelector('.status-text').textContent = on ? '錄音中' : '未錄音'
  if (!on) {
    $('recLevel').style.width = '0%'
    $('recTimer').textContent = '00:00'
  }
}

/** @param {number} ms */
function formatDuration(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(sec / 3600)
  const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, '0')
  const ss = String(sec % 60).padStart(2, '0')
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** @param {number} bytes */
function formatSize(bytes) {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** @type {{ name: string, path: string, size: number, startedAt: number, endedAt: number }[]} */
let items = []

async function renderList() {
  const list = $('recList')
  try {
    items = await call(electronAPI.sttArchive.recordings())
  } catch (error) {
    items = []
    showToast(`讀不到錄音清單：${cleanIpcError(error)}`, 'error')
  }
  // 正在錄的那一份還在長，不列進來（轉錄到一半的檔沒意義）
  const shown = items.filter((r) => !(recorder && r.name === fileName))
  if (shown.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'dict-empty'
    empty.textContent = '還沒有錄音'
    list.replaceChildren(empty)
    return
  }
  list.replaceChildren(...shown.map(renderItem))
}

/** @param {typeof items[number]} r */
function renderItem(r) {
  const row = document.createElement('div')
  row.className = 'dict-record rec-item'
  row.dataset.name = r.name

  const head = document.createElement('div')
  head.className = 'dict-record-head'
  const time = document.createElement('span')
  time.className = 'rec-item-title'
  time.textContent = new Date(r.startedAt).toLocaleString()
  const meta = document.createElement('span')
  meta.className = 'dict-record-time'
  meta.textContent = `${formatDuration(r.endedAt - r.startedAt)} · ${formatSize(r.size)}`
  const label = document.createElement('div')
  label.className = 'rec-item-label'
  label.append(time, meta)

  const actions = document.createElement('div')
  actions.className = 'rec-item-actions'
  for (const [act, text] of [['play', '▶ 播放'], ['transcribe', '轉錄'], ['delete', '刪除']]) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'btn btn-secondary btn-sm'
    btn.dataset.act = act
    btn.textContent = text
    actions.append(btn)
  }
  head.append(label, actions)
  row.append(head)
  return row
}

/** @param {MouseEvent} e */
async function onListClick(e) {
  const btn = /** @type {HTMLElement} */ (e.target).closest('button[data-act]')
  const row = btn?.closest('.rec-item')
  const rec = items.find((r) => r.name === row?.dataset.name)
  if (!btn || !row || !rec) return
  try {
    if (btn.dataset.act === 'play') await play(row, rec)
    if (btn.dataset.act === 'transcribe') transcribe(rec)
    if (btn.dataset.act === 'delete') await remove(rec)
  } catch (error) {
    showToast(cleanIpcError(error), 'error')
  }
}

/**
 * 播放：main 讀出整個檔變成 blob（CSP 不給 file://）；同一時間只留一個播放器
 * @param {HTMLElement} row
 * @param {typeof items[number]} rec
 */
async function play(row, rec) {
  document.querySelectorAll('#recList audio').forEach((a) => a.remove())
  if (playingUrl) URL.revokeObjectURL(playingUrl)
  const bytes = await call(electronAPI.sttArchive.readRecording(rec.name))
  playingUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/webm' }))
  const audio = document.createElement('audio')
  audio.controls = true
  audio.className = 'rec-audio'
  audio.src = playingUrl
  row.append(audio)
  await audio.play().catch(() => {})
}

/** @param {typeof items[number]} rec */
function transcribe(rec) {
  // 交給檔案轉錄：先切子分頁（那一頁會載入 transcribe.js），再把檔放上去
  document.querySelector('#sttSubtabs .subtab[data-subtab="file"]')?.dispatchEvent(new MouseEvent('click'))
  import('./transcribe.js').then((m) => m.useRecording(rec))
}

/** @param {typeof items[number]} rec */
async function remove(rec) {
  const ok = await askConfirm('刪除這段錄音？', {
    desc: `${new Date(rec.startedAt).toLocaleString()}，刪了就找不回來`,
    confirmText: '刪除',
    danger: true
  })
  if (!ok) return
  await call(electronAPI.sttArchive.deleteRecording(rec.name))
  await renderList()
}
