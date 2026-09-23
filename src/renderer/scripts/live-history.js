/**
 * VoiceInk - 即時字幕的紀錄（過去每一場的逐字稿）
 *
 * 寫入在 `live-caption.js`：每次字幕 upsert 就 append 一行到 main 的 `live-transcripts/`。
 * 這支只管讀：列出每一場、展開看全文、複製／下載／刪除。
 */

import { showToast, electronAPI, cleanIpcError } from './app.js'
import { askConfirm } from './app-dialog.js'

let bound = false
/** @type {{ id: string, startedAt: number, endedAt: number, count: number, preview: string }[]} */
let sessions = []

const $ = (id) => document.getElementById(id)

/**
 * @param {Promise<{ ok: boolean, data?: any, error?: { message: string } }>} p
 */
async function call(p) {
  const res = await p
  if (!res?.ok) throw new Error(res?.error?.message || '操作失敗')
  return res.data
}

/**
 * 這一場字幕的 id（開始字幕時產生）；main 只收 `live-<13 位毫秒>`
 * @returns {string}
 */
export function newTranscriptId() {
  return `live-${Date.now()}`
}

/**
 * 寫一筆字幕（同一個 key 之後的 upsert 會蓋掉前面的）。失敗只記 log：字幕本身不能因為存檔卡住
 * @param {string} transcriptId
 * @param {string} key
 * @param {string} source
 * @param {string} translation
 */
export function logTranscript(transcriptId, key, source, translation) {
  if (!transcriptId || !electronAPI.sttArchive) return
  electronAPI.sttArchive.appendTranscript(transcriptId, { key, source, translation })
    .then((res) => { if (!res?.ok) console.warn('[字幕紀錄] 寫入失敗:', res?.error?.message) })
    .catch((e) => console.warn('[字幕紀錄] 寫入失敗:', e))
}

function bindOnce() {
  if (bound) return
  bound = true
  $('liveHistoryList').addEventListener('click', onClick)
}

export async function refreshLiveHistory() {
  if (!$('liveHistoryList') || !electronAPI.sttArchive) return
  bindOnce()
  try {
    sessions = await call(electronAPI.sttArchive.transcripts())
  } catch (error) {
    sessions = []
    showToast(`讀不到字幕紀錄：${cleanIpcError(error)}`, 'error')
  }
  const list = $('liveHistoryList')
  if (sessions.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'dict-empty'
    empty.textContent = '還沒有字幕紀錄'
    list.replaceChildren(empty)
    return
  }
  list.replaceChildren(...sessions.map(renderSession))
}

/** @param {number} ms */
function formatDuration(ms) {
  const min = Math.max(0, Math.round(ms / 60000))
  return min < 1 ? '不到 1 分鐘' : min < 60 ? `${min} 分鐘` : `${Math.floor(min / 60)} 小時 ${min % 60} 分`
}

/** @param {typeof sessions[number]} s */
function renderSession(s) {
  const row = document.createElement('div')
  row.className = 'dict-record rec-item'
  row.dataset.id = s.id

  const head = document.createElement('div')
  head.className = 'dict-record-head'
  const label = document.createElement('div')
  label.className = 'rec-item-label'
  const title = document.createElement('span')
  title.className = 'rec-item-title'
  title.textContent = new Date(s.startedAt).toLocaleString()
  const meta = document.createElement('span')
  meta.className = 'dict-record-time'
  meta.textContent = `${formatDuration(s.endedAt - s.startedAt)} · ${s.count} 句`
  label.append(title, meta)

  const actions = document.createElement('div')
  actions.className = 'rec-item-actions'
  for (const [act, text] of [['view', '查看'], ['copy', '複製'], ['save', '下載'], ['delete', '刪除']]) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'btn btn-secondary btn-sm'
    btn.dataset.act = act
    btn.textContent = text
    actions.append(btn)
  }
  head.append(label, actions)

  const preview = document.createElement('p')
  preview.className = 'dict-record-raw'
  preview.textContent = s.preview
  row.append(head, preview)
  return row
}

/** @param {{ source: string, translation: string }[]} rows */
function toText(rows) {
  return rows.map((r) => (r.translation ? `${r.source}\n${r.translation}` : r.source)).join('\n\n')
}

/** @param {MouseEvent} e */
async function onClick(e) {
  const btn = /** @type {HTMLElement} */ (e.target).closest('button[data-act]')
  const row = btn?.closest('.rec-item')
  const s = sessions.find((x) => x.id === row?.dataset.id)
  if (!btn || !row || !s) return
  try {
    const act = btn.dataset.act
    if (act === 'delete') return await remove(s)
    if (act === 'view' && row.querySelector('.live-history-body')) {
      row.querySelector('.live-history-body').remove()
      btn.textContent = '查看'
      return
    }
    const rows = await call(electronAPI.sttArchive.readTranscript(s.id))
    if (act === 'view') {
      row.append(renderBody(rows))
      btn.textContent = '收起'
    }
    if (act === 'copy') {
      await navigator.clipboard.writeText(toText(rows))
      showToast('已複製逐字稿')
    }
    if (act === 'save') download(s, toText(rows))
  } catch (error) {
    showToast(cleanIpcError(error), 'error')
  }
}

/** @param {{ source: string, translation: string }[]} rows */
function renderBody(rows) {
  const body = document.createElement('div')
  body.className = 'live-history-body'
  for (const r of rows) {
    const line = document.createElement('p')
    line.className = 'dict-record-text'
    line.textContent = r.source
    body.append(line)
    if (r.translation) {
      const tr = document.createElement('p')
      tr.className = 'dict-record-raw live-history-tr'
      tr.textContent = r.translation
      body.append(tr)
    }
  }
  return body
}

/**
 * @param {typeof sessions[number]} s
 * @param {string} text
 */
function download(s, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  const a = document.createElement('a')
  const d = new Date(s.startedAt)
  const pad = (n) => String(n).padStart(2, '0')
  a.href = url
  a.download = `字幕_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.txt`
  document.body.append(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** @param {typeof sessions[number]} s */
async function remove(s) {
  const ok = await askConfirm('刪除這份字幕紀錄？', {
    desc: `${new Date(s.startedAt).toLocaleString()}，${s.count} 句`,
    confirmText: '刪除',
    danger: true
  })
  if (!ok) return
  await call(electronAPI.sttArchive.deleteTranscript(s.id))
  await refreshLiveHistory()
}
