/**
 * VoiceInk - 語音轉文字頁（檔案轉錄／即時字幕／語音輸入）
 *
 * 這一頁只負責兩件事：子分頁切換、**每個子分頁各自的模型選單**。
 *
 * 三個子分頁做的是三件不同的事，共用一組模型會互相打架（即時字幕想用 GPU 那顆、
 * 語音輸入想用 CPU 那顆），所以各存一份選擇（`fileAsr`/`fileLlm`、`liveAsr`/`liveLlm`、
 * `dictationAsr`/`dictationLlm`），選單就放在各自的頁面內容裡、不擺在標題旁。
 *
 * 檔案轉錄與即時字幕的邏輯留在 `transcribe.js`／`live-caption.js`，
 * 語音輸入留在 `dictation-page.js`；那三支的 DOM id 都沒動。
 */

import { electronAPI, getSettings } from './app.js'
import {
  asrOptions,
  translateOptions,
  fillSelect,
  readScope,
  writeScope,
  readinessHint,
  warnNotReady
} from './model-picker.js'
import { syncCustomSelects } from './custom-select.js'

/** 子分頁：檔案轉錄／即時字幕／語音輸入 */
const SUBTABS = new Set(['file', 'live', 'dictation'])

/**
 * 每個 scope 的選單 DOM id。語音輸入的整理模型選單與提示列由 `dictation-page.js`
 * 自己畫（它還要處理「不整理」與啟用狀態），所以這裡只接手它的 ASR 那一格。
 * @type {Record<'file'|'live'|'dictation', { asr: string, llm: string|null, hint: string|null }>}
 */
const PICKERS = {
  file: { asr: 'fileAsrModel', llm: 'fileLlmModel', hint: 'fileModelHint' },
  live: { asr: 'liveAsrModel', llm: 'liveLlmModel', hint: 'liveModelHint' },
  dictation: { asr: 'dictationAsrModel', llm: null, hint: null }
}

/** @type {'file'|'live'|'dictation'} */
let activeSubtab = 'file'
let bound = false

/** 各 scope 目前的選項清單（給「選到還沒裝好的東西」提示用） */
const opts = {
  file: { asr: [], llm: [] },
  live: { asr: [], llm: [] },
  dictation: { asr: [], llm: [] }
}

/**
 * @returns {'file'|'live'|'dictation'}
 */
export function currentSubtab() {
  return activeSubtab
}

/**
 * @param {'file'|'live'|'dictation'} name
 */
export function showSubtab(name) {
  activeSubtab = SUBTABS.has(name) ? name : 'file'
  document.querySelectorAll('#sttSubtabs .subtab').forEach((btn) => {
    const on = btn.dataset.subtab === activeSubtab
    btn.classList.toggle('active', on)
    btn.setAttribute('aria-selected', on ? 'true' : 'false')
  })
  document.querySelectorAll('#page-stt .subtab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.subtab === activeSubtab)
  })
}

/**
 * @param {'file'|'live'|'dictation'} scope
 * @param {'asr'|'llm'} kind
 */
function bindPicker(scope, kind) {
  const id = PICKERS[scope][kind]
  if (!id) return
  const select = /** @type {HTMLSelectElement|null} */ (document.getElementById(id))
  select?.addEventListener('change', async () => {
    await writeScope(scope, kind, select.value)
    updateHint(scope)
    warnNotReady(readinessHint(select, opts[scope][kind]))
    document.dispatchEvent(new CustomEvent('settings-changed'))
  })
}

function bindOnce() {
  if (bound) return
  bound = true

  document.querySelectorAll('#sttSubtabs .subtab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const name = /** @type {'file'|'live'|'dictation'} */ (btn.dataset.subtab)
      showSubtab(name)
      document.dispatchEvent(new CustomEvent('stt-subtab-changed', { detail: { subtab: name } }))
    })
  })

  for (const scope of /** @type {const} */ (['file', 'live', 'dictation'])) {
    bindPicker(scope, 'asr')
    bindPicker(scope, 'llm')
  }
}

/**
 * @param {'file'|'live'|'dictation'} scope
 */
function updateHint(scope) {
  const hintId = PICKERS[scope].hint
  if (!hintId) return
  const hint = document.getElementById(hintId)
  if (!hint) return
  const msgs = [
    readinessHint(document.getElementById(PICKERS[scope].asr), opts[scope].asr),
    PICKERS[scope].llm
      ? readinessHint(document.getElementById(PICKERS[scope].llm), opts[scope].llm)
      : ''
  ].filter(Boolean)
  // 沒問題時整條收起來：這一行只是為了「選到還沒裝好的東西」而存在，
  // 常駐一句說明文字只是把版面吃掉
  hint.textContent = msgs.join(' ')
  hint.classList.toggle('is-warning', msgs.length > 0)
  hint.classList.toggle('hidden', msgs.length === 0)
}

/**
 * 進頁時重讀（模型可能剛下載完、設定可能剛改過）
 */
export async function refreshSttPage() {
  bindOnce()
  const [settings, status] = await Promise.all([getSettings(), electronAPI.models.status()])
  const map = status.models || {}

  for (const scope of /** @type {const} */ (['file', 'live', 'dictation'])) {
    const chosen = await readScope(scope)
    opts[scope].asr = asrOptions(map, settings)
    fillSelect(document.getElementById(PICKERS[scope].asr), opts[scope].asr, chosen.asr)
    if (PICKERS[scope].llm) {
      opts[scope].llm = translateOptions(map, settings)
      fillSelect(document.getElementById(PICKERS[scope].llm), opts[scope].llm, chosen.llm)
    }
    updateHint(scope)
  }
  // fillSelect 只改原始 <select>；畫面上的 listbox 要跟著換文字
  syncCustomSelects()
  showSubtab(activeSubtab)
}
