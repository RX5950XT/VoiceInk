/**
 * VoiceInk - 翻譯與 TTS 頁
 * 按鈕式翻譯 + Edge TTS 朗讀；engine owner = translate
 */

import {
  showToast,
  getSettings,
  electronAPI,
  cleanIpcError,
  resolveTranslateModelKey
} from './app.js'

/**
 * 單次送模型的字數上限：本地 context 2048 tokens（prompt + 輸出）共用。
 * 通用預設 600；LinguaForge 對齊出貨用 280（main 亦會再切 ≤280）。
 * IPC 硬防線 1500 字；輸入總長不設限，超過即自動分段依序翻譯。
 */
const CHUNK_CHARS_GENERIC = 600
const CHUNK_CHARS_LINGUAFORGE = 280

/**
 * 依句尾／換行切成單位再貪婪合併到 max（保留原始尾端空白供接回）
 * @param {string} text
 * @param {number} [max]
 * @returns {string[]}
 */
export function splitForTranslate(text, max = CHUNK_CHARS_GENERIC) {
  const units = String(text || '').split(/(?<=[。．.！!？?…；;\n])/)
  const chunks = []
  let buf = ''
  for (const u of units) {
    if (buf && buf.length + u.length > max) {
      chunks.push(buf)
      buf = ''
    }
    if (u.length > max) {
      // 無標點的超長段：硬切
      for (let i = 0; i < u.length; i += max) chunks.push(u.slice(i, i + max))
      continue
    }
    buf += u
  }
  if (buf) chunks.push(buf)
  return chunks.filter((c) => c.trim())
}

// ===== DOM =====
let el = {}

// ===== 狀態 =====
let settings = null
/** 譯文是否因輸入變更而過期 */
let outputStale = false
let isTranslating = false
/** 已成功取得的譯文（done 且未 stale） */
let hasFreshOutput = false

/** prewarm 契約（鏡像 live） */
let prewarmed = false
let prewarmGen = 0
let prewarmInFlight = false
let engineAcquired = false

/** TTS 播放 */
let audioEl = null
let objectUrl = null
let speakGen = 0
/** @type {'input'|'output'|null} */
let speakingPane = null

/**
 * 初始化
 */
export function initTranslatePage() {
  el = {
    banner: document.getElementById('translateBanner'),
    bannerText: document.getElementById('translateBannerText'),
    openSettingsBtn: document.getElementById('translateOpenSettingsBtn'),
    sourceLang: document.getElementById('translateSourceLang'),
    targetLang: document.getElementById('translateTargetLang'),
    swapBtn: document.getElementById('translateSwapBtn'),
    input: document.getElementById('translateInput'),
    output: document.getElementById('translateOutput'),
    inputCount: document.getElementById('translateInputCount'),
    outputState: document.getElementById('translateOutputState'),
    copyInputBtn: document.getElementById('translateCopyInputBtn'),
    speakInputBtn: document.getElementById('translateSpeakInputBtn'),
    clearInputBtn: document.getElementById('translateClearInputBtn'),
    copyOutputBtn: document.getElementById('translateCopyOutputBtn'),
    speakOutputBtn: document.getElementById('translateSpeakOutputBtn'),
    runBtn: document.getElementById('translateRunBtn'),
    status: document.getElementById('translateStatus'),
    error: document.getElementById('translateError')
  }

  el.openSettingsBtn?.addEventListener('click', () => {
    document.querySelector('.nav-tab[data-page="settings"]')?.click()
  })
  el.swapBtn?.addEventListener('click', onSwap)
  el.input?.addEventListener('input', onInputChange)
  el.copyInputBtn?.addEventListener('click', () => copyText(el.input.value, '已複製輸入'))
  el.copyOutputBtn?.addEventListener('click', () => copyText(el.output.value, '已複製譯文'))
  el.clearInputBtn?.addEventListener('click', () => {
    el.input.value = ''
    onInputChange()
  })
  el.speakInputBtn?.addEventListener('click', () => toggleSpeak('input'))
  el.speakOutputBtn?.addEventListener('click', () => toggleSpeak('output'))
  el.runBtn?.addEventListener('click', runTranslate)
  el.input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      runTranslate()
    }
  })

  document.addEventListener('settings-changed', async () => {
    settings = await getSettings()
    await refreshUiState()
    await syncEngineForSettings()
  })

  updateCharCount()
  setOutputState('idle')
  refreshUiState()
}

/**
 * 進入翻譯分頁
 */
export async function prewarmTranslatePage() {
  settings = await getSettings()
  await refreshUiState()
  if (!electronAPI.engine) return
  if (settings.translator !== 'local') {
    // 非 local：確保不佔 owner
    await releaseTranslateEngine()
    return
  }
  if (prewarmed || prewarmInFlight || engineAcquired) return

  const gen = ++prewarmGen
  prewarmInFlight = true
  if (el.status) el.status.textContent = '翻譯：準備模型…'
  try {
    const r = await electronAPI.engine.acquire('translate', { asr: false, llm: true })
    if (gen !== prewarmGen) {
      if (r && r.ok) {
        await electronAPI.engine.release('translate').catch(() => {})
      }
      return
    }
    prewarmed = !!(r && r.ok)
    engineAcquired = prewarmed
  } catch (e) {
    console.warn('[翻譯頁預熱] 失敗:', e)
    if (gen === prewarmGen) {
      prewarmed = false
      engineAcquired = false
    }
  } finally {
    prewarmInFlight = false
    if (gen === prewarmGen) await refreshUiState()
  }
}

/**
 * 離開翻譯分頁
 */
export async function cooldownTranslatePage() {
  prewarmGen++
  stopSpeak()
  await electronAPI.tts?.cancel?.().catch(() => {})
  await releaseTranslateEngine()
}

async function releaseTranslateEngine() {
  if (!electronAPI.engine) {
    prewarmed = false
    engineAcquired = false
    return
  }
  if (!prewarmed && !engineAcquired) return
  prewarmed = false
  engineAcquired = false
  try {
    await electronAPI.engine.release('translate')
  } catch (e) {
    console.warn('[翻譯頁卸載] 失敗:', e)
  }
}

/**
 * 設定變更後：在翻譯頁且 translator=local 時強制重載（模型／GPU 才會立刻生效）
 * 非 local 則 release
 */
async function syncEngineForSettings() {
  if (!electronAPI.engine) return
  const page = document.getElementById('page-translate')
  const onTranslatePage = !!page?.classList.contains('active')

  if (settings?.translator === 'local' && onTranslatePage) {
    // 已 prewarm 也要卸再載：localTranslateModel / llmGpu 指紋變更靠 getSession，
    // 但使用者存檔後應立刻看到「準備模型」而非沿用舊權重
    prewarmGen++
    prewarmInFlight = false
    await releaseTranslateEngine()
    await prewarmTranslatePage()
  } else {
    prewarmGen++
    await releaseTranslateEngine()
  }
}

async function refreshUiState() {
  settings = settings || (await getSettings())
  const translator = settings.translator === 'cloud' ? 'cloud' : 'local'
  let statusLabel = '翻譯：檢查中…'
  let canTranslate = false
  let bannerMsg = ''

  if (translator === 'local') {
    statusLabel = '翻譯：本地 LLM'
    const st = await electronAPI.models.status().catch(() => null)
    const llmKey = resolveTranslateModelKey(settings, st?.models)
    if (!st?.models?.[llmKey]?.downloaded) {
      bannerMsg = '本地翻譯模型尚未下載，請到設定下載。'
      statusLabel = '翻譯：本地 LLM（模型未下載）'
    } else {
      canTranslate = true
    }
  } else {
    statusLabel = '翻譯：雲端 LLM'
    if (!settings.apiKey) {
      bannerMsg = '雲端翻譯需要 API Key，請到設定填寫。'
      statusLabel = '翻譯：雲端 LLM（未設定 Key）'
    } else {
      canTranslate = true
    }
  }

  if (el.banner) {
    el.banner.classList.toggle('hidden', !bannerMsg)
    if (el.bannerText && bannerMsg) el.bannerText.textContent = bannerMsg
  }
  if (el.status) el.status.textContent = statusLabel
  if (el.runBtn) {
    el.runBtn.disabled = !canTranslate || isTranslating
  }
  updateSpeakOutputEnabled()
}

/**
 * 依當前本地翻譯模型選分段上限（LinguaForge 對齊出貨 250–300）
 */
function resolveChunkChars() {
  const key = settings?.localTranslateModel
  // 兩個量化（Q8／Q4）是同一顆模型，切段長度相同
  return String(key || '').startsWith('linguaforge08')
    ? CHUNK_CHARS_LINGUAFORGE
    : CHUNK_CHARS_GENERIC
}

function updateCharCount() {
  const n = (el.input?.value || '').length
  if (el.inputCount) {
    const max = resolveChunkChars()
    const parts = n > max ? `（${splitForTranslate(el.input.value, max).length} 段）` : ''
    el.inputCount.textContent = `${n} 字${parts}`
  }
}

function onInputChange() {
  updateCharCount()
  if (hasFreshOutput || el.output?.value) {
    outputStale = true
    hasFreshOutput = false
    setOutputState('stale')
    updateSpeakOutputEnabled()
  }
}

function setOutputState(state, detail = '') {
  if (!el.outputState || !el.output) return
  el.output.classList.remove('is-stale', 'is-loading')
  const map = {
    idle: '—',
    stale: '原文已變更，請重新翻譯',
    loading: '翻譯中…',
    done: '完成',
    error: '失敗'
  }
  el.outputState.textContent = (map[state] || '—') + (detail ? ` ${detail}` : '')
  if (state === 'stale') el.output.classList.add('is-stale')
  if (state === 'loading') el.output.classList.add('is-loading')
}

function setError(msg) {
  if (!el.error) return
  if (!msg) {
    el.error.classList.add('hidden')
    el.error.textContent = ''
  } else {
    el.error.classList.remove('hidden')
    el.error.textContent = msg
  }
}

function hasLinguisticContent(text) {
  return (text || '').replace(/[^\p{L}]/gu, '').length >= 2
}

/**
 * 啟發式語言（TTS 用；非可靠偵測）
 * @param {string} text
 * @returns {'zh-TW'|'zh-CN'|'en'|'ja'|'ko'}
 */
export function detectScriptLang(text) {
  const t = text || ''
  if (/[\u3040-\u30ff]/.test(t)) return 'ja'
  if (/[\uac00-\ud7af]/.test(t)) return 'ko'
  const han = (t.match(/[\u4e00-\u9fff]/g) || []).length
  const latin = (t.match(/[A-Za-z]/g) || []).length
  if (han > 0 && han >= latin) return 'zh-TW'
  return 'en'
}

function resolveInputSpeakLang() {
  const src = el.sourceLang?.value || 'auto'
  if (src !== 'auto') return src
  return detectScriptLang(el.input?.value || '')
}

async function runTranslate() {
  // 翻譯中再按＝停止（長文分段可能跑很久）
  if (isTranslating) {
    el._translateRequestId = 0
    return
  }
  settings = await getSettings()
  await refreshUiState()
  if (el.runBtn?.disabled) {
    showToast(el.bannerText?.textContent || '翻譯尚未就緒，請到設定檢查', 'error')
    return
  }

  const text = (el.input?.value || '').trim()
  if (!text) {
    showToast('請輸入要翻譯的文字', 'error')
    return
  }
  if (!hasLinguisticContent(text)) {
    showToast('內容缺少可翻譯的文字', 'error')
    return
  }

  const target = el.targetLang?.value || 'zh-TW'
  const source = el.sourceLang?.value || 'auto'
  if (source !== 'auto' && source === target) {
    el.output.value = text
    outputStale = false
    hasFreshOutput = true
    setOutputState('done')
    setError(null)
    updateSpeakOutputEnabled()
    showToast('來源與目標相同，已直接帶入')
    return
  }

  const chunks = splitForTranslate(text, resolveChunkChars())
  isTranslating = true
  el.runBtn.disabled = false
  el.runBtn.textContent = '停止'
  setOutputState('loading', chunks.length > 1 ? `(0/${chunks.length})` : '')
  setError(null)
  const requestId = Date.now()
  el._translateRequestId = requestId

  try {
    // local 確保引擎
    if (settings.translator === 'local' && !engineAcquired) {
      await prewarmTranslatePage()
    }

    let joined = ''
    let prevSource = ''
    let prevTranslation = ''
    for (let i = 0; i < chunks.length; i++) {
      if (el._translateRequestId !== requestId) break
      const raw = chunks[i]
      const src = raw.trim()
      // 原始尾端空白（換行）原樣接回，保留段落結構
      const sep = raw.slice(raw.trimEnd().length)
      const result = await electronAPI.translate(src, target, {
        mode: 'file',
        previousSource: prevSource,
        previousTranslation: prevTranslation
      })
      if (el._translateRequestId !== requestId) break

      const piece = (result || '').trim()
      joined += piece + (i < chunks.length - 1 ? sep || '\n' : '')
      prevSource = src
      prevTranslation = piece
      el.output.value = joined
      if (chunks.length > 1) setOutputState('loading', `(${i + 1}/${chunks.length})`)
    }

    const cancelled = el._translateRequestId !== requestId
    const out = joined.trim()
    el.output.value = out
    outputStale = cancelled
    hasFreshOutput = !cancelled && !!out
    setOutputState(cancelled ? 'stale' : 'done', cancelled ? '（已停止）' : '')
    updateSpeakOutputEnabled()
  } catch (e) {
    if (el._translateRequestId !== requestId) return
    console.error('[翻譯]', e)
    setOutputState(el.output.value ? 'stale' : 'error')
    setError(cleanIpcError(e))
    showToast(`翻譯失敗: ${cleanIpcError(e)}`, 'error')
  } finally {
    isTranslating = false
    el.runBtn.textContent = '翻譯'
    await refreshUiState()
  }
}

function onSwap() {
  const src = el.sourceLang.value
  const tgt = el.targetLang.value

  // 只交換語言下拉，不交換輸入／譯文欄位
  // 來源為 auto 時，目標改為啟發式語言（避免目標被設成 auto）
  el.sourceLang.value = tgt
  el.targetLang.value =
    src === 'auto' ? detectScriptLang(el.input?.value || '') : src
}

async function copyText(text, okMsg) {
  const t = (text || '').trim()
  if (!t) {
    showToast('沒有可複製的內容', 'error')
    return
  }
  try {
    await navigator.clipboard.writeText(t)
    showToast(okMsg || '已複製')
  } catch {
    showToast('複製失敗', 'error')
  }
}

function updateSpeakOutputEnabled() {
  const ok = !!(el.output?.value || '').trim() && !outputStale
  if (el.speakOutputBtn) {
    el.speakOutputBtn.disabled = !ok && speakingPane !== 'output'
    el.speakOutputBtn.title = ok || speakingPane === 'output' ? '朗讀譯文' : '請先翻譯'
  }
}

function stopSpeak() {
  speakGen++
  speakingPane = null
  if (audioEl) {
    audioEl.pause()
    audioEl.removeAttribute('src')
    audioEl.load()
  }
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl)
    objectUrl = null
  }
  setSpeakBtnState('input', false)
  setSpeakBtnState('output', false)
  electronAPI.tts?.cancel?.().catch(() => {})
}

function setSpeakBtnState(pane, active) {
  const btn = pane === 'input' ? el.speakInputBtn : el.speakOutputBtn
  if (!btn) return
  btn.setAttribute('aria-pressed', active ? 'true' : 'false')
  btn.textContent = active ? '⏹ 停止' : '🔊 朗讀'
}

/**
 * IPC 回傳音訊 bytes 正規化為獨立 Uint8Array
 * @param {unknown} data
 * @returns {Uint8Array}
 */
function toAudioBytes(data) {
  if (data instanceof Uint8Array) {
    return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
      ? data
      : new Uint8Array(data)
  }
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  // 少數序列化形狀
  if (data && typeof data === 'object' && Array.isArray(/** @type {{ data?: unknown }} */ (data).data)) {
    return new Uint8Array(/** @type {{ data: number[] }} */ (data).data)
  }
  if (Array.isArray(data)) return new Uint8Array(data)
  return new Uint8Array(0)
}

/**
 * @param {'input'|'output'} pane
 */
async function toggleSpeak(pane) {
  if (speakingPane === pane) {
    stopSpeak()
    return
  }
  stopSpeak()

  const text =
    pane === 'input' ? (el.input?.value || '').trim() : (el.output?.value || '').trim()
  if (!text) {
    showToast('沒有可朗讀的文字', 'error')
    return
  }
  if (pane === 'output' && outputStale) {
    showToast('譯文已過期，請重新翻譯', 'error')
    return
  }

  const lang = pane === 'input' ? resolveInputSpeakLang() : el.targetLang?.value || 'zh-TW'
  const myGen = ++speakGen
  speakingPane = pane
  setSpeakBtnState(pane, true)

  try {
    if (!audioEl) audioEl = new Audio()
    let chunkIndex = 0
    let totalChunks = 1

    while (chunkIndex < totalChunks) {
      if (myGen !== speakGen) return
      const res = await electronAPI.tts.synthesize(text, lang, { chunkIndex })
      if (myGen !== speakGen) return
      totalChunks = res.totalChunks || 1
      const bytes = toAudioBytes(res.data)
      if (!bytes.length) throw new Error('語音資料為空')

      if (objectUrl) URL.revokeObjectURL(objectUrl)
      const blob = new Blob([bytes], { type: res.mime || 'audio/mpeg' })
      objectUrl = URL.createObjectURL(blob)
      audioEl.src = objectUrl

      await new Promise((resolve, reject) => {
        const onEnded = () => {
          cleanup()
          resolve()
        }
        const onError = () => {
          const code = audioEl?.error?.code
          const detail = code != null ? ` (MediaError ${code})` : ''
          console.error('[TTS] media error', audioEl?.error)
          cleanup()
          reject(new Error(`音訊播放失敗${detail}`))
        }
        const cleanup = () => {
          audioEl.removeEventListener('ended', onEnded)
          audioEl.removeEventListener('error', onError)
        }
        audioEl.addEventListener('ended', onEnded)
        audioEl.addEventListener('error', onError)
        audioEl.play().catch((err) => {
          console.error('[TTS] play()', err)
          cleanup()
          reject(new Error(err?.message || '音訊播放失敗'))
        })
      })

      chunkIndex++
    }
  } catch (e) {
    if (myGen !== speakGen) return
    console.error('[TTS]', e)
    showToast(cleanIpcError(e) || '朗讀失敗', 'error')
  } finally {
    if (myGen === speakGen) {
      speakingPane = null
      setSpeakBtnState(pane, false)
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
        objectUrl = null
      }
    }
  }
}
