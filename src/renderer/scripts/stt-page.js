/**
 * VoiceInk - 語音轉文字頁（檔案轉錄 ＋ 即時字幕合併）
 *
 * 這一頁只負責兩件事：子分頁切換、頁面上方的模型選單。
 * 檔案轉錄與即時字幕的邏輯留在原本的 `transcribe.js`／`live-caption.js`，
 * 兩邊的 DOM id 都沒動，所以那兩支不必改。
 */

import { electronAPI, getSettings } from './app.js'
import {
  asrOptions,
  translateOptions,
  currentAsrValue,
  currentTranslateValue,
  fillSelect,
  applyAsrChoice,
  applyTranslateChoice,
  readinessHint,
  warnNotReady
} from './model-picker.js'

/** @type {'file'|'live'} */
let activeSubtab = 'file'
let bound = false

/** @type {{ value: string, label: string, ready: boolean }[]} */
let asrOpts = []
/** @type {{ value: string, label: string, ready: boolean }[]} */
let llmOpts = []

/**
 * @returns {'file'|'live'}
 */
export function currentSubtab() {
  return activeSubtab
}

/**
 * @param {'file'|'live'} name
 */
export function showSubtab(name) {
  activeSubtab = name === 'live' ? 'live' : 'file'
  document.querySelectorAll('#sttSubtabs .subtab').forEach((btn) => {
    const on = btn.dataset.subtab === activeSubtab
    btn.classList.toggle('active', on)
    btn.setAttribute('aria-selected', on ? 'true' : 'false')
  })
  document.querySelectorAll('#page-stt .subtab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.subtab === activeSubtab)
  })
}

function bindOnce() {
  if (bound) return
  bound = true

  document.querySelectorAll('#sttSubtabs .subtab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const name = /** @type {'file'|'live'} */ (btn.dataset.subtab)
      showSubtab(name)
      document.dispatchEvent(new CustomEvent('stt-subtab-changed', { detail: { subtab: name } }))
    })
  })

  const asrSelect = document.getElementById('sttAsrModel')
  asrSelect?.addEventListener('change', async () => {
    await applyAsrChoice(asrSelect.value)
    updateHint()
    warnNotReady(readinessHint(asrSelect, asrOpts))
    document.dispatchEvent(new CustomEvent('settings-changed'))
  })

  const llmSelect = document.getElementById('sttTranslateModel')
  llmSelect?.addEventListener('change', async () => {
    await applyTranslateChoice(llmSelect.value)
    updateHint()
    warnNotReady(readinessHint(llmSelect, llmOpts))
    document.dispatchEvent(new CustomEvent('settings-changed'))
  })
}

function updateHint() {
  const hint = document.getElementById('sttModelHint')
  if (!hint) return
  const msgs = [
    readinessHint(document.getElementById('sttAsrModel'), asrOpts),
    readinessHint(document.getElementById('sttTranslateModel'), llmOpts)
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
  asrOpts = asrOptions(map, settings)
  llmOpts = translateOptions(map, settings)
  fillSelect(document.getElementById('sttAsrModel'), asrOpts, currentAsrValue(settings))
  fillSelect(document.getElementById('sttTranslateModel'), llmOpts, currentTranslateValue(settings))
  updateHint()
  showSubtab(activeSubtab)
}
