'use strict'

/**
 * VoiceInk - 語音轉文字頁的兩份存檔：錄音機的錄音檔、即時字幕的逐字稿。
 *
 * 都在 userData 底下、檔名由規則決定（renderer 只送得出符合樣式的名字，組不出別的路徑）：
 * - `recordings/rec-<毫秒時間戳>.webm`：MediaRecorder 每秒一塊，邊錄邊 append，當掉也只少最後一秒。
 * - `live-transcripts/live-<毫秒時間戳>.jsonl`：一行一筆字幕 upsert，同一個 key 以最後一行為準。
 *
 * 寫檔用同步 append：同一個檔案的兩次非同步 append 在 Windows 上不保證順序，字幕會錯位。
 */

const fs = require('fs')
const path = require('path')
const { makeInvoke } = require('./ipc-invoke')

const REC_NAME = /^rec-\d{13}\.webm$/
const LIVE_ID = /^live-\d{13}$/
const ENTRY_KEY = /^[\w-]{1,64}$/
/** 跟檔案轉錄的上限一致：錄出來的檔一定轉得了 */
const MAX_RECORDING_BYTES = 200 * 1024 * 1024
const MAX_CHUNK_BYTES = 8 * 1024 * 1024
const MAX_TEXT_CHARS = 8000
/** ponytail: 清單每次重讀每一場的檔案；場數真的破百再改成索引檔 */
const MAX_TRANSCRIPTS = 200

let baseDir = ''

/** @param {{ userDataPath: string }} opts */
function configure({ userDataPath }) {
  baseDir = userDataPath
}

/**
 * 我們自己組的錯誤訊息才送得到 renderer（見 ipc-invoke 的 userMessage）
 * @param {string} message
 */
function fail(message) {
  const err = new Error(message)
  err.userMessage = message
  return err
}

/** @param {'recordings'|'live-transcripts'} sub */
function dirOf(sub) {
  if (!baseDir) throw fail('存檔位置尚未設定')
  const dir = path.join(baseDir, sub)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function recordingPath(name) {
  if (typeof name !== 'string' || !REC_NAME.test(name)) throw fail('錄音檔名無效')
  return path.join(dirOf('recordings'), name)
}

function transcriptPath(id) {
  if (typeof id !== 'string' || !LIVE_ID.test(id)) throw fail('字幕紀錄 id 無效')
  return path.join(dirOf('live-transcripts'), `${id}.jsonl`)
}

/** 檔名裡的時間戳就是開始時間 */
function startedAtOf(name) {
  return Number(/\d{13}/.exec(name)?.[0] || 0)
}

// ===== 錄音 =====

function listRecordings() {
  const dir = dirOf('recordings')
  return fs.readdirSync(dir)
    .filter((n) => REC_NAME.test(n))
    .map((name) => {
      const full = path.join(dir, name)
      const st = fs.statSync(full)
      return { name, path: full, size: st.size, startedAt: startedAtOf(name), endedAt: st.mtimeMs }
    })
    .filter((r) => r.size > 0)
    .sort((a, b) => b.startedAt - a.startedAt)
}

/**
 * @param {string} name
 * @param {Uint8Array} bytes
 */
function appendRecording(name, bytes) {
  const file = recordingPath(name)
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw fail('錄音資料無效')
  if (bytes.length > MAX_CHUNK_BYTES) throw fail('錄音資料過大')
  const size = fs.existsSync(file) ? fs.statSync(file).size : 0
  if (size + bytes.length > MAX_RECORDING_BYTES) throw fail('錄音已達 200 MB 上限')
  fs.appendFileSync(file, bytes)
  return { size: size + bytes.length }
}

function readRecording(name) {
  return fs.readFileSync(recordingPath(name))
}

function deleteRecording(name) {
  fs.rmSync(recordingPath(name), { force: true })
  return true
}

// ===== 字幕逐字稿 =====

/**
 * 同一個 key 的 upsert 以最後一行為準，順序照第一次出現
 * @param {string} text
 * @returns {{ source: string, translation: string, t: number }[]}
 */
function parseTranscript(text) {
  /** @type {Map<string, { source: string, translation: string, t: number }>} */
  const rows = new Map()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue // 當掉時寫到一半的最後一行
    }
    if (!row || typeof row.k !== 'string') continue
    const prev = rows.get(row.k)
    rows.set(row.k, {
      source: String(row.s || ''),
      translation: String(row.tr || ''),
      t: prev?.t || Number(row.t) || 0
    })
  }
  return [...rows.values()].filter((r) => r.source || r.translation)
}

/**
 * @param {string} id
 * @param {{ key: string, source: string, translation: string }} entry
 */
function appendTranscript(id, entry) {
  const file = transcriptPath(id)
  const key = entry?.key
  if (typeof key !== 'string' || !ENTRY_KEY.test(key)) throw fail('字幕資料無效')
  const s = typeof entry.source === 'string' ? entry.source.slice(0, MAX_TEXT_CHARS) : ''
  const tr = typeof entry.translation === 'string' ? entry.translation.slice(0, MAX_TEXT_CHARS) : ''
  fs.appendFileSync(file, JSON.stringify({ k: key, s, tr, t: Date.now() }) + '\n', 'utf8')
  return true
}

function listTranscripts() {
  const dir = dirOf('live-transcripts')
  return fs.readdirSync(dir)
    .filter((n) => n.endsWith('.jsonl') && LIVE_ID.test(n.slice(0, -6)))
    .sort()
    .reverse()
    .slice(0, MAX_TRANSCRIPTS)
    .map((n) => {
      const full = path.join(dir, n)
      const rows = parseTranscript(fs.readFileSync(full, 'utf8'))
      return {
        id: n.slice(0, -6),
        startedAt: startedAtOf(n),
        endedAt: fs.statSync(full).mtimeMs,
        count: rows.length,
        preview: (rows[0]?.translation || rows[0]?.source || '').slice(0, 80)
      }
    })
    .filter((t) => t.count > 0)
}

function readTranscript(id) {
  const file = transcriptPath(id)
  if (!fs.existsSync(file)) throw fail('找不到這份字幕紀錄')
  return parseTranscript(fs.readFileSync(file, 'utf8'))
}

function deleteTranscript(id) {
  fs.rmSync(transcriptPath(id), { force: true })
  return true
}

// ===== IPC =====

/**
 * @param {{ ipcMain: any, isMainSender: (event: any) => boolean, openPath: (dir: string) => Promise<string> }} deps
 */
function registerSttArchiveIpc({ ipcMain, isMainSender, openPath }) {
  const invoke = makeInvoke({
    isMainSender,
    forbidden: '僅主視窗可操作錄音與字幕紀錄',
    code: 'STT_ARCHIVE_ERROR',
    message: '存檔操作失敗'
  })
  ipcMain.handle('sttArchive:recordings', (e) => invoke(e, () => listRecordings()))
  ipcMain.handle('sttArchive:appendRecording', (e, name, bytes) => invoke(e, () => appendRecording(name, bytes)))
  ipcMain.handle('sttArchive:readRecording', (e, name) => invoke(e, () => readRecording(name)))
  ipcMain.handle('sttArchive:deleteRecording', (e, name) => invoke(e, () => deleteRecording(name)))
  ipcMain.handle('sttArchive:openRecordings', (e) => invoke(e, () => openPath(dirOf('recordings'))))
  ipcMain.handle('sttArchive:transcripts', (e) => invoke(e, () => listTranscripts()))
  ipcMain.handle('sttArchive:appendTranscript', (e, id, entry) => invoke(e, () => appendTranscript(id, entry)))
  ipcMain.handle('sttArchive:readTranscript', (e, id) => invoke(e, () => readTranscript(id)))
  ipcMain.handle('sttArchive:deleteTranscript', (e, id) => invoke(e, () => deleteTranscript(id)))
}

module.exports = {
  configure,
  registerSttArchiveIpc,
  listRecordings,
  appendRecording,
  readRecording,
  deleteRecording,
  listTranscripts,
  appendTranscript,
  readTranscript,
  deleteTranscript,
  parseTranscript
}
