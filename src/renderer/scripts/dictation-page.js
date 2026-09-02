/**
 * VoiceInk - 語音輸入子分頁（設定、狀態、轉錄紀錄、個人字典）
 *
 * 錄音與整條管線在 `dictation.js`（renderer 常駐）與 main 那一側；
 * 這一支只管畫面：開關、兩個選單、目前狀態、紀錄與字典的增刪。
 *
 * 「要用哪一顆模型」跟其他頁一樣是既有 store key 的扁平視圖，沒有第三份狀態。
 * 這一頁的模型跟檔案轉錄／即時字幕**各存各的**：
 *   語音辨識 → `dictationAsr`（選單由 `stt-page.js` 統一填，三頁同一支）
 *   文字整理 → `dictationLlm`（''／`local:<key>`／`cloud:<供應商 id>:<模型 id>`）
 */

import { electronAPI, showToast, getSettings } from './app.js'
import { syncCustomSelects } from './custom-select.js'

/** 可以拿來整理文字的本地模型。LinguaForge 是翻譯專用的 SFT 模型，餵它整理只會得到譯文。 */
const LOCAL_CLEANUP_KEYS = ['qwen35translate', 'qwen354b']

let bound = false
/** @type {{ ok: boolean, text?: string, raw?: string } | null} */
let lastResult = null

/**
 * @param {string} id
 * @returns {HTMLElement | null}
 */
const $ = (id) => document.getElementById(id)

/**
 * 整理模型的選項：不整理 ＋ 兩顆本地 ＋ 每個雲端供應商的每一顆模型
 * @param {Record<string, { label?: string, downloaded?: boolean }>} modelsMap
 * @param {{ chatProviders?: Array<{ id: string, name?: string, apiUrl?: string, apiKey?: string, models?: string[] }> }} settings
 * @returns {{ value: string, label: string, ready: boolean }[]}
 */
function cleanupOptions(modelsMap, settings) {
  const options = [{ value: '', label: '不整理（只套個人字典）', ready: true }]
  for (const key of LOCAL_CLEANUP_KEYS) {
    const def = modelsMap?.[key]
    if (!def) continue
    const ready = def.downloaded === true
    options.push({
      value: `local:${key}`,
      label: `本地 · ${def.label || key}${ready ? '' : '（未安裝）'}`,
      ready
    })
  }
  const providers = Array.isArray(settings?.chatProviders) ? settings.chatProviders : []
  for (const provider of providers) {
    const ready = Boolean(provider?.apiUrl && provider?.apiKey)
    for (const model of provider?.models || []) {
      options.push({
        value: `cloud:${provider.id}:${model}`,
        label: `雲端 · ${provider.name || '未命名'} / ${model}${ready ? '' : '（缺 API Key）'}`,
        ready
      })
    }
  }
  return options
}

/**
 * @param {HTMLSelectElement | null} select
 * @param {{ value: string, label: string, ready: boolean }[]} options
 * @param {string} current
 */
function fillSelect(select, options, current) {
  if (!select) return
  select.replaceChildren()
  for (const opt of options) {
    const el = document.createElement('option')
    el.value = opt.value
    el.textContent = opt.label
    if (!opt.ready) el.dataset.notReady = '1'
    select.appendChild(el)
  }
  select.value = options.some((o) => o.value === current) ? current : ''
}

/**
 * @param {number} at
 * @returns {string}
 */
function formatTime(at) {
  const d = new Date(at)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * @param {{ state: string, message?: string, level?: number, ms?: number }} detail
 */
function renderState(detail) {
  const box = $('dictationStatus')
  const level = $('dictationLevel')
  if (!box) return
  const label = box.querySelector('.dict-status-text')
  const map = {
    off: '未啟用',
    idle: '待命中（按住右 Alt）',
    recording: '錄音中…',
    processing: '轉文字與整理中…',
    error: detail.message || '出了點問題',
    result: '完成'
  }
  if (label) label.textContent = map[detail.state] || map.idle
  box.classList.toggle('is-active', detail.state === 'recording' || detail.state === 'processing')
  box.classList.toggle('is-error', detail.state === 'error')
  if (level && detail.state !== 'level') level.style.width = detail.state === 'recording' ? level.style.width : '0%'
}

/**
 * @param {{ text?: string, raw?: string, inserted?: boolean }} data
 */
function renderResult(data) {
  lastResult = data
  const textEl = $('dictationResultText')
  const rawEl = $('dictationResultRaw')
  if (textEl) textEl.textContent = data?.text || '（空）'
  if (rawEl) {
    const changed = data?.raw && data.raw !== data.text
    rawEl.textContent = changed ? `原文：${data.raw}` : ''
    rawEl.classList.toggle('hidden', !changed)
  }
}

async function refreshRecords() {
  const host = $('dictationRecords')
  if (!host) return
  const res = await electronAPI.dictation.records({ limit: 50 }).catch(() => null)
  const records = res?.ok ? res.data : []
  host.replaceChildren()
  if (!records.length) {
    const empty = document.createElement('p')
    empty.className = 'dict-empty'
    empty.textContent = '還沒有紀錄。'
    host.appendChild(empty)
    return
  }
  for (const record of records) {
    const row = document.createElement('div')
    row.className = 'dict-record'
    row.dataset.id = record.id

    const head = document.createElement('div')
    head.className = 'dict-record-head'
    const time = document.createElement('span')
    time.className = 'dict-record-time'
    time.textContent = `${formatTime(record.at)} · ${(record.durationMs / 1000).toFixed(1)}s · ${record.llm || '未整理'}`
    const actions = document.createElement('div')
    actions.className = 'dict-record-actions'
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'btn-icon'
    copy.dataset.action = 'copy'
    copy.title = '複製'
    copy.textContent = '📋'
    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'btn-icon'
    del.dataset.action = 'delete'
    del.title = '刪除'
    del.textContent = '🗑'
    actions.append(copy, del)
    head.append(time, actions)

    const body = document.createElement('p')
    body.className = 'dict-record-text'
    body.textContent = record.text

    row.append(head, body)
    if (record.raw && record.raw !== record.text) {
      const raw = document.createElement('p')
      raw.className = 'dict-record-raw'
      raw.textContent = `原文：${record.raw}`
      row.appendChild(raw)
    }
    host.appendChild(row)
  }
}

async function refreshTerms() {
  const host = $('dictationTerms')
  if (!host) return
  const res = await electronAPI.dictation.dictionary().catch(() => null)
  const terms = res?.ok ? res.data : []
  host.replaceChildren()
  if (!terms.length) {
    const empty = document.createElement('p')
    empty.className = 'dict-empty'
    empty.textContent = '還沒有詞。自己加，或者讓它從整理結果慢慢學。'
    host.appendChild(empty)
    return
  }
  for (const term of terms) {
    const row = document.createElement('div')
    row.className = 'dict-term'
    row.dataset.from = term.from
    if (!term.active) row.classList.add('is-pending')

    const pair = document.createElement('span')
    pair.className = 'dict-term-pair'
    pair.textContent = `${term.from} → ${term.to}`
    const meta = document.createElement('span')
    meta.className = 'dict-term-meta'
    meta.textContent = term.active ? `已啟用 · ${term.count} 次` : `觀察中 · ${term.count} 次`
    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'btn-icon'
    del.dataset.action = 'delete-term'
    del.title = '刪除'
    del.textContent = '🗑'

    row.append(pair, meta, del)
    host.appendChild(row)
  }
}

function bindOnce() {
  if (bound) return
  bound = true

  const enabledInput = /** @type {HTMLInputElement | null} */ ($('dictationEnabledInput'))
  enabledInput?.addEventListener('change', async () => {
    await electronAPI.store.set('dictationEnabled', enabledInput.checked)
    // main 收到這個 key 就會掛上／拔掉全域熱鍵；renderer 這邊負責麥克風
    const { refreshDictationRuntime } = await import('./dictation.js')
    await refreshDictationRuntime()
    const status = await electronAPI.dictation.status().catch(() => null)
    if (enabledInput.checked && status?.ok && status.data?.listening !== true) {
      showToast('全域熱鍵沒有掛上，請重開 VoiceInk 再試一次', 'error')
    } else {
      showToast(enabledInput.checked ? '語音輸入已啟用，按住右 Alt 講話' : '語音輸入已停用')
    }
  })

  const llmSelect = /** @type {HTMLSelectElement | null} */ ($('dictationLlmSelect'))
  llmSelect?.addEventListener('change', async () => {
    await electronAPI.store.set('dictationLlm', llmSelect.value)
    // main 會把不合法的值收斂掉，所以寫完再讀回來對齊畫面
    const saved = await electronAPI.store.get('dictationLlm', '')
    if (saved !== llmSelect.value) {
      llmSelect.value = saved
      syncCustomSelects()
      showToast('這個模型已經不在清單裡了', 'error')
    }
    updateHint()
  })

  const langSelect = /** @type {HTMLSelectElement | null} */ ($('dictationLangSelect'))
  langSelect?.addEventListener('change', async () => {
    await electronAPI.store.set('dictationLang', langSelect.value)
  })

  $('dictationCopyBtn')?.addEventListener('click', async () => {
    if (!lastResult?.text) return
    await navigator.clipboard.writeText(lastResult.text)
    showToast('已複製')
  })

  $('dictationClearBtn')?.addEventListener('click', async () => {
    await electronAPI.dictation.clearRecords()
    await refreshRecords()
    showToast('紀錄已清空')
  })

  $('dictationRecords')?.addEventListener('click', async (event) => {
    const btn = /** @type {HTMLElement} */ (event.target).closest('[data-action]')
    if (!btn) return
    const row = btn.closest('.dict-record')
    const id = row?.dataset.id
    if (!id) return
    if (btn.dataset.action === 'copy') {
      await navigator.clipboard.writeText(row.querySelector('.dict-record-text')?.textContent || '')
      showToast('已複製')
      return
    }
    await electronAPI.dictation.deleteRecord(id)
    await refreshRecords()
  })

  $('dictationTerms')?.addEventListener('click', async (event) => {
    const btn = /** @type {HTMLElement} */ (event.target).closest('[data-action="delete-term"]')
    if (!btn) return
    const from = btn.closest('.dict-term')?.dataset.from
    if (!from) return
    await electronAPI.dictation.deleteTerm(from)
    await refreshTerms()
  })

  $('dictationTermForm')?.addEventListener('submit', async (event) => {
    event.preventDefault()
    const fromInput = /** @type {HTMLInputElement} */ ($('dictationTermFrom'))
    const toInput = /** @type {HTMLInputElement} */ ($('dictationTermTo'))
    const res = await electronAPI.dictation.saveTerm({ from: fromInput.value, to: toInput.value })
    if (!res?.ok || res.data?.ok === false) {
      showToast('這組詞不能用（只收沒有標點的短詞）', 'error')
      return
    }
    fromInput.value = ''
    toInput.value = ''
    await refreshTerms()
  })

  document.addEventListener('dictation-state', (event) => {
    const detail = /** @type {CustomEvent} */ (event).detail || {}
    if (detail.state === 'level') {
      const level = $('dictationLevel')
      if (level) level.style.width = `${Math.min(100, (detail.level || 0) * 400)}%`
      return
    }
    renderState(detail)
    if (detail.state === 'result') {
      renderResult(detail)
      refreshRecords()
      refreshTerms()
    }
  })
}

function updateHint() {
  const hint = $('dictationHint')
  const select = /** @type {HTMLSelectElement | null} */ ($('dictationLlmSelect'))
  if (!hint || !select) return
  const option = select.selectedOptions[0]
  const notReady = option?.dataset.notReady === '1'
  hint.textContent = notReady
    ? '這顆模型還沒準備好：本地的請到設定 → 本地模型下載，雲端的請補上 API Key。'
    : ''
  hint.classList.toggle('is-warning', notReady)
  hint.classList.toggle('hidden', !notReady)
}

/**
 * 進子分頁時重讀（模型可能剛下載完、設定可能剛改過）
 */
export async function refreshDictationPage() {
  bindOnce()
  const [settings, status, state] = await Promise.all([
    getSettings(),
    electronAPI.models.status(),
    electronAPI.dictation.status().catch(() => null)
  ])

  const enabledInput = /** @type {HTMLInputElement | null} */ ($('dictationEnabledInput'))
  if (enabledInput) enabledInput.checked = settings.dictationEnabled === true

  const llmSelect = /** @type {HTMLSelectElement | null} */ ($('dictationLlmSelect'))
  fillSelect(llmSelect, cleanupOptions(status.models || {}, settings), settings.dictationLlm || '')

  const langSelect = /** @type {HTMLSelectElement | null} */ ($('dictationLangSelect'))
  if (langSelect) langSelect.value = settings.dictationLang || 'zh-TW'

  syncCustomSelects()
  updateHint()
  renderState({ state: settings.dictationEnabled === true ? (state?.data?.recording ? 'recording' : 'idle') : 'off' })
  await Promise.all([refreshRecords(), refreshTerms()])
}
