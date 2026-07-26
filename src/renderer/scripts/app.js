/**
 * VoiceInk - 主應用程式邏輯
 */

import { initTranscribe } from './transcribe.js'
import { initLiveCaption, prewarmEngine, cooldownEngine } from './live-caption.js'
import {
  initTranslatePage,
  prewarmTranslatePage,
  cooldownTranslatePage
} from './translate-page.js'
import {
  DEFAULT_API_URL,
  DEFAULT_MODEL,
  DEFAULT_ASR_API_URL,
  DEFAULT_ASR_MODEL
} from './api.js'

/** 預設 TTS 語音（與 main tts-voices.js 對齊） */
export const DEFAULT_TTS_VOICES = {
  'zh-TW': 'zh-TW-HsiaoChenNeural',
  'zh-CN': 'zh-CN-XiaoxiaoNeural',
  en: 'en-US-AvaNeural',
  ja: 'ja-JP-NanamiNeural',
  ko: 'ko-KR-SunHiNeural'
}

// ===== Electron API Fallback =====
// 在純瀏覽器環境開發時提供 fallback
export const electronAPI = window.electronAPI || {
  store: {
    get: async (key, defaultValue) => {
      try {
        const value = localStorage.getItem(key)
        return value ? JSON.parse(value) : defaultValue
      } catch {
        return defaultValue
      }
    },
    set: async (key, value) => {
      localStorage.setItem(key, JSON.stringify(value))
      return true
    }
  },
  subtitle: {
    show: async () => console.log('[Dev Mode] subtitle:show'),
    hide: async () => console.log('[Dev Mode] subtitle:hide'),
    close: async () => console.log('[Dev Mode] subtitle:close'),
    update: async (text) => console.log('[Dev Mode] subtitle:update', text),
    onTextUpdate: () => {},
    onClosed: () => {}
  },
  models: {
    status: async () => ({ models: {}, root: '(僅 Electron 環境可用)' }),
    download: async () => { throw new Error('僅 Electron 環境可用') },
    cancel: async () => true,
    delete: async () => ({ models: {}, root: '' }),
    openFolder: async () => true,
    onProgress: () => {}
  },
  engine: {
    acquire: async () => ({ ok: true, asrLoaded: false, llmLoaded: false, warnings: [] }),
    release: async () => ({ ok: true }),
    status: async () => ({ users: {}, asrLoaded: false, llmLoaded: false })
  },
  localAsr: {
    transcribe: async () => { throw new Error('僅 Electron 環境可用') }
  },
  translate: async (text) => text,
  tts: {
    listVoices: async () => ({
      langs: Object.keys(DEFAULT_TTS_VOICES),
      voicesByLang: {},
      defaults: { ...DEFAULT_TTS_VOICES }
    }),
    synthesize: async () => { throw new Error('僅 Electron 環境可用') },
    cancel: async () => true
  },
  window: {
    minimize: async () => true,
    toggleMaximize: async () => false,
    close: async () => true,
    isMaximized: async () => false,
    onMaximized: () => () => {}
  },
  system: {
    gpuCapability: async () => ({
      ok: false,
      name: '',
      vramMiB: 0,
      reason: '僅 Electron 環境',
      hasCudaRuntime: false,
      hasVulkan: false,
      canInstallCuda: false,
      backends: []
    }),
    refreshGpuCapability: async () => ({
      ok: false,
      name: '',
      vramMiB: 0,
      reason: '僅 Electron 環境',
      hasCudaRuntime: false,
      canInstallCuda: false,
      backends: []
    }),
    installCudaEnv: async () => ({ ok: false, message: '僅 Electron 環境' }),
    openCudaDownloadPage: async () => true,
    onCudaInstallProgress: () => () => {}
  },
  llm: {
    loadInfo: async () => ({ loaded: false, key: null, gpu: false, backend: 'cpu' })
  }
}

// ===== 設定 =====

const SETTING_DEFAULTS = {
  /** @type {'cloud'|'local'} */
  translator: 'local',
  /** 即時字幕：bilingual 雙語｜translation 僅翻譯 */
  captionDisplayMode: 'bilingual',
  apiUrl: DEFAULT_API_URL,
  apiKey: '',
  modelId: DEFAULT_MODEL,
  /** @type {'local'|'cloud'} */
  asrEngine: 'local',
  asrApiUrl: DEFAULT_ASR_API_URL,
  asrApiKey: '',
  asrModelId: DEFAULT_ASR_MODEL,
  ttsVoices: { ...DEFAULT_TTS_VOICES },
  /** 語速百分比偏移 -50…100 */
  ttsRate: 0,
  /** @type {'qwen35translate'} */
  localTranslateModel: 'qwen35translate',
  /** 本地 LLM 是否使用 CUDA（需 NVIDIA ≥6GB） */
  llmGpu: false
}

/** 固定本地 ASR 模型 key */
export const ASR_MODEL_KEY = 'qwen3asr'

/** 本地翻譯模型 key 白名單（linguaforge08 屏蔽中，修好後加回） */
export const LLM_MODEL_KEYS = ['qwen35translate']

/** @deprecated 請用 resolveTranslateModelKey(settings, modelsStatus)；保留常數供舊 e2e */
export const TRANSLATE_MODEL_KEY = 'qwen35translate'

const LLM_KEY_SET = new Set(LLM_MODEL_KEYS)

/**
 * @param {unknown} v
 * @returns {'cloud'|'local'}
 */
function normalizeTranslator(v) {
  return v === 'cloud' ? 'cloud' : 'local'
}

/**
 * @param {unknown} v
 * @returns {'local'|'cloud'}
 */
function normalizeAsrEngine(v) {
  return v === 'cloud' ? 'cloud' : 'local'
}

/**
 * @param {unknown} v
 * @returns {number}
 */
function normalizeTtsRate(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.max(-50, Math.min(100, Math.round(n)))
}

/**
 * @param {unknown} v
 * @returns {'qwen35translate'}
 */
export function normalizeLocalTranslateModel(v) {
  return LLM_KEY_SET.has(/** @type {string} */ (v)) ? /** @type {'qwen35translate'} */ (v) : 'qwen35translate'
}

/**
 * 解析實際應檢查／使用的本地翻譯模型 key（選中未下載時 fallback 到已下載的 qwen）
 * @param {{ localTranslateModel?: string }} settings
 * @param {Record<string, { downloaded?: boolean }>|null|undefined} modelsMap
 * @returns {string}
 */
export function resolveTranslateModelKey(settings, modelsMap) {
  const preferred = normalizeLocalTranslateModel(settings?.localTranslateModel)
  if (modelsMap?.[preferred]?.downloaded) return preferred
  if (preferred !== 'qwen35translate' && modelsMap?.qwen35translate?.downloaded) {
    return 'qwen35translate'
  }
  for (const k of LLM_MODEL_KEYS) {
    if (modelsMap?.[k]?.downloaded) return k
  }
  return preferred
}

/**
 * 一次取得所有設定
 * @returns {Promise<typeof SETTING_DEFAULTS>}
 */
export async function getSettings() {
  const entries = await Promise.all(
    Object.entries(SETTING_DEFAULTS).map(async ([key, def]) => [
      key,
      await electronAPI.store.get(key, def)
    ])
  )
  const raw = Object.fromEntries(entries)
  return {
    ...raw,
    translator: normalizeTranslator(raw.translator),
    asrEngine: normalizeAsrEngine(raw.asrEngine),
    ttsRate: normalizeTtsRate(raw.ttsRate),
    ttsVoices: raw.ttsVoices || { ...DEFAULT_TTS_VOICES },
    localTranslateModel: normalizeLocalTranslateModel(raw.localTranslateModel),
    llmGpu: raw.llmGpu === true
  }
}

// ===== DOM 元素 =====
const navItems = document.querySelectorAll('.nav-tab')
const pages = document.querySelectorAll('.page')
const apiUrlInput = document.getElementById('apiUrlInput')
const apiKeyInput = document.getElementById('apiKeyInput')
const modelIdInput = document.getElementById('modelIdInput')
const asrApiUrlInput = document.getElementById('asrApiUrlInput')
const asrApiKeyInput = document.getElementById('asrApiKeyInput')
const asrModelIdInput = document.getElementById('asrModelIdInput')
const toggleApiKeyVisibility = document.getElementById('toggleApiKeyVisibility')
const toggleAsrApiKeyVisibility = document.getElementById('toggleAsrApiKeyVisibility')
const cloudApiSection = document.getElementById('cloudApiSection')
const localLlmSection = document.getElementById('localLlmSection')
const cloudAsrSection = document.getElementById('cloudAsrSection')
const localAsrSection = document.getElementById('localAsrSection')
const modelList = document.getElementById('modelList')
const modelsPathText = document.getElementById('modelsPathText')
const ttsRateInput = document.getElementById('ttsRateInput')
const ttsRateLabel = document.getElementById('ttsRateLabel')
const llmGpuHint = document.getElementById('llmGpuHint')
const llmGpuBtn = document.getElementById('llmGpuBtn')
const cudaEnvRow = document.getElementById('cudaEnvRow')
const cudaEnvStatus = document.getElementById('cudaEnvStatus')
const installCudaEnvBtn = document.getElementById('installCudaEnvBtn')
const refreshGpuEnvBtn = document.getElementById('refreshGpuEnvBtn')
const cudaInstallProgress = document.getElementById('cudaInstallProgress')
const cudaInstallProgressFill = document.getElementById('cudaInstallProgressFill')
const toast = document.getElementById('toast')

/** @type {object | null} */
let gpuCapability = null
let cudaInstallInProgress = false

// 分段選擇器目前的值
const segmentValues = {
  translatorSegment: 'local',
  asrEngineSegment: 'local',
  localTranslateModelSegment: 'qwen35translate',
  llmGpuSegment: 'cpu',
  themeSegment: 'dark'
}

// 最近一次模型狀態快取
let latestModels = {}

// ===== 初始化 =====
document.addEventListener('DOMContentLoaded', async () => {
  await initTheme()
  initWindowControls()
  await initSettings()
  initNavigation()
  initTranscribe()
  initLiveCaption()
  initTranslatePage()
})

// ===== 主題管理 =====

/**
 * @param {'dark'|'light'} theme
 */
function applyTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark'
  document.documentElement.setAttribute('data-theme', t)
  segmentValues.themeSegment = t
  setSegmentValue('themeSegment', t)
}

async function initTheme() {
  const savedTheme = await electronAPI.store.get('theme', 'dark')
  applyTheme(savedTheme === 'light' ? 'light' : 'dark')
}

/**
 * 即時套用主題（設定頁 segmented）
 * @param {string} value
 */
async function onThemeSegmentChange(value) {
  const t = value === 'light' ? 'light' : 'dark'
  applyTheme(t)
  await electronAPI.store.set('theme', t)
}

// ===== 視窗控制（frameless）=====

function initWindowControls() {
  const win = electronAPI.window
  if (!win) return

  document.getElementById('winMin')?.addEventListener('click', () => win.minimize())
  document.getElementById('winClose')?.addEventListener('click', () => win.close())

  const maxBtn = document.getElementById('winMax')
  const syncMax = (maximized) => {
    document.body.classList.toggle('is-maximized', !!maximized)
    if (maxBtn) {
      maxBtn.textContent = maximized ? '❐' : '□'
      maxBtn.setAttribute('aria-label', maximized ? '還原' : '最大化')
      maxBtn.title = maximized ? '還原' : '最大化'
    }
  }
  maxBtn?.addEventListener('click', async () => {
    const m = await win.toggleMaximize()
    syncMax(m)
  })
  win.isMaximized?.().then(syncMax).catch(() => {})
  win.onMaximized?.(syncMax)

  // 雙擊 drag spacer / brand 切換最大化
  const toggleMax = () => maxBtn?.click()
  document.querySelector('.header-drag-spacer')?.addEventListener('dblclick', toggleMax)
  document.querySelector('.header-brand')?.addEventListener('dblclick', toggleMax)
}

// ===== 分頁導航 =====

function initNavigation() {
  navItems.forEach(item => {
    item.addEventListener('click', () => switchPage(item.dataset.page))
  })
}

/**
 * 切換主分頁
 * @param {string} pageName
 */
export function switchPage(pageName) {
  navItems.forEach(item => {
    item.classList.toggle('active', item.dataset.page === pageName)
  })
  pages.forEach(page => {
    page.classList.toggle('active', page.id === `page-${pageName}`)
  })
  // 先啟動新頁 acquire，再 release 舊頁，避免中間 owner 歸零觸發 unload＋重付 warm
  if (pageName === 'live') prewarmEngine()
  if (pageName === 'translate') prewarmTranslatePage()
  if (pageName === 'settings') {
    loadSettingsForm()
    refreshModels()
  }
  if (pageName !== 'live') cooldownEngine()
  if (pageName !== 'translate') cooldownTranslatePage()
}

/** 供翻譯頁「前往設定」等呼叫 */
export function openSettingsPage() {
  switchPage('settings')
}

// ===== 設定管理 =====

async function initSettings() {
  await loadSettingsForm()

  if (toggleApiKeyVisibility) {
    toggleApiKeyVisibility.addEventListener('click', () => {
      const isPassword = apiKeyInput.type === 'password'
      apiKeyInput.type = isPassword ? 'text' : 'password'
      toggleApiKeyVisibility.textContent = isPassword ? '🙈' : '👁️'
    })
  }
  if (toggleAsrApiKeyVisibility) {
    toggleAsrApiKeyVisibility.addEventListener('click', () => {
      const isPassword = asrApiKeyInput.type === 'password'
      asrApiKeyInput.type = isPassword ? 'text' : 'password'
      toggleAsrApiKeyVisibility.textContent = isPassword ? '🙈' : '👁️'
    })
  }

  if (ttsRateInput) {
    ttsRateInput.addEventListener('input', () => {
      updateTtsRateLabel(Number(ttsRateInput.value))
    })
  }

  document.getElementById('saveSettingsBtn')?.addEventListener('click', saveSettings)

  installCudaEnvBtn?.addEventListener('click', () => onInstallCudaEnv())
  refreshGpuEnvBtn?.addEventListener('click', () => refreshGpuCapabilityUi(true))

  // 模型管理
  document.getElementById('openModelsFolderBtn')?.addEventListener('click', () => {
    electronAPI.models.openFolder()
  })
  modelsPathText?.addEventListener('click', () => electronAPI.models.openFolder())
  electronAPI.models.onProgress(onModelProgress)
  await refreshModels()
}

/** @type {{ langs: string[], voicesByLang: Record<string, {id:string,label:string}[]>, defaults: Record<string,string> } | null} */
let ttsVoiceCatalog = null

async function populateTtsVoiceSelects() {
  try {
    ttsVoiceCatalog = await electronAPI.tts.listVoices()
  } catch {
    ttsVoiceCatalog = {
      langs: Object.keys(DEFAULT_TTS_VOICES),
      voicesByLang: {},
      defaults: { ...DEFAULT_TTS_VOICES }
    }
  }
  document.querySelectorAll('select[data-tts-lang]').forEach((sel) => {
    const lang = sel.dataset.ttsLang
    const list = ttsVoiceCatalog?.voicesByLang?.[lang] || []
    sel.innerHTML = ''
    if (list.length === 0) {
      const id = DEFAULT_TTS_VOICES[lang]
      const opt = document.createElement('option')
      opt.value = id
      opt.textContent = id
      sel.appendChild(opt)
      return
    }
    for (const v of list) {
      const opt = document.createElement('option')
      opt.value = v.id
      opt.textContent = v.label
      sel.appendChild(opt)
    }
  })
}

/**
 * @param {Record<string, string>} voices
 */
function applyTtsVoicesToForm(voices) {
  const v = { ...DEFAULT_TTS_VOICES, ...(voices || {}) }
  document.querySelectorAll('select[data-tts-lang]').forEach((sel) => {
    const lang = sel.dataset.ttsLang
    const want = v[lang] || DEFAULT_TTS_VOICES[lang]
    if ([...sel.options].some((o) => o.value === want)) sel.value = want
  })
}

/**
 * @returns {Record<string, string>}
 */
function readTtsVoicesFromForm() {
  const out = { ...DEFAULT_TTS_VOICES }
  document.querySelectorAll('select[data-tts-lang]').forEach((sel) => {
    const lang = sel.dataset.ttsLang
    if (sel.value) out[lang] = sel.value
  })
  return out
}

/**
 * @param {number} rate
 */
function updateTtsRateLabel(rate) {
  if (!ttsRateLabel) return
  const mult = 1 + normalizeTtsRate(rate) / 100
  ttsRateLabel.textContent = `${mult.toFixed(2)}×`
}

/**
 * 初始化分段選擇器（只綁一次）
 * @param {string} id
 * @param {string} value
 * @param {(v: string) => void} [onChange]
 */
function initSegment(id, value, onChange) {
  const segment = document.getElementById(id)
  if (!segment) return
  segmentValues[id] = value
  const buttons = segment.querySelectorAll('.seg-btn')
  buttons.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.value === value)
    btn.addEventListener('click', () => {
      segmentValues[id] = btn.dataset.value
      buttons.forEach(b => b.classList.toggle('active', b === btn))
      onChange?.(btn.dataset.value)
    })
  })
}

/**
 * 只更新 active，不重複綁事件
 * @param {string} id
 * @param {string} value
 */
function setSegmentValue(id, value) {
  segmentValues[id] = value
  const segment = document.getElementById(id)
  if (!segment) return
  segment.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === value)
  })
}

/**
 * @param {string} translator
 */
function updateTranslatorPanels(translator) {
  const isCloud = translator === 'cloud'
  cloudApiSection?.classList.toggle('hidden', !isCloud)
  localLlmSection?.classList.toggle('hidden', isCloud)
}

/**
 * @param {string} asrEngine
 */
function updateAsrPanels(asrEngine) {
  const isCloud = asrEngine === 'cloud'
  cloudAsrSection?.classList.toggle('hidden', !isCloud)
  localAsrSection?.classList.toggle('hidden', isCloud)
}

/**
 * 更新 GPU 選項可用性、CUDA 環境列與提示
 * @param {boolean} [forceRefresh]
 */
async function refreshGpuCapabilityUi(forceRefresh = false) {
  try {
    gpuCapability = forceRefresh
      ? await electronAPI.system.refreshGpuCapability()
      : await electronAPI.system.gpuCapability()
  } catch {
    gpuCapability = {
      ok: false,
      name: '',
      vramMiB: 0,
      reason: '無法偵測 GPU',
      hasCudaRuntime: false,
      canInstallCuda: false,
      backends: []
    }
  }
  const ok = !!gpuCapability?.ok
  const hasCuda = !!gpuCapability?.hasCudaRuntime
  const hasVulkan = !!gpuCapability?.hasVulkan
  const backends = Array.isArray(gpuCapability?.backends) ? gpuCapability.backends : []

  if (llmGpuBtn) {
    llmGpuBtn.disabled = !ok
    llmGpuBtn.classList.toggle('disabled', !ok)
    llmGpuBtn.title = ok
      ? `${gpuCapability.name}（${gpuCapability.vramMiB} MiB）· ${backends.join('/') || '—'}`
      : (gpuCapability?.reason || 'GPU 不可用')
  }
  if (llmGpuHint) {
    if (ok) {
      const be = backends.filter((b) => b !== 'cpu-fallback').join(' / ') || '將自動選擇'
      llmGpuHint.textContent = `可用：${gpuCapability.name}，${gpuCapability.vramMiB} MiB。後端優先：${be}（僅本地翻譯；ASR 仍為 CPU）。`
    } else {
      llmGpuHint.textContent = gpuCapability?.reason
        ? `${gpuCapability.reason}。將使用 CPU 推論。`
        : '未達 GPU 門檻（需 NVIDIA 且 VRAM ≥ 6GB）。'
    }
  }

  // CUDA 環境列：有 NVIDIA 夠 VRAM 就顯示
  const showCudaRow = ok || !!gpuCapability?.canInstallCuda || !!gpuCapability?.hasNvidiaDriver
  cudaEnvRow?.classList.toggle('hidden', !showCudaRow)
  if (cudaEnvStatus) {
    if (cudaInstallInProgress) {
      // 進度文案由 onProgress 更新
    } else if (hasCuda) {
      cudaEnvStatus.textContent = 'CUDA Runtime：已就緒（可走 CUDA 加速）'
    } else if (ok && hasVulkan) {
      cudaEnvStatus.textContent =
        'CUDA Runtime：未安裝（目前可用 Vulkan）。點「安裝 CUDA 環境」可啟用 CUDA。'
    } else if (ok) {
      cudaEnvStatus.textContent = 'CUDA Runtime：未安裝。建議安裝以獲得最佳 GPU 效能。'
    } else {
      cudaEnvStatus.textContent = gpuCapability?.reason || '無法使用 GPU'
    }
  }
  if (installCudaEnvBtn) {
    installCudaEnvBtn.disabled = cudaInstallInProgress || hasCuda || !gpuCapability?.canInstallCuda
    installCudaEnvBtn.textContent = hasCuda ? 'CUDA 已就緒' : '安裝 CUDA 環境'
  }

  if (!ok && segmentValues.llmGpuSegment === 'gpu') {
    setSegmentValue('llmGpuSegment', 'cpu')
  }
}

/**
 * 一鍵安裝 CUDA Toolkit／Runtime
 */
async function onInstallCudaEnv() {
  if (cudaInstallInProgress) return
  if (!electronAPI.system?.installCudaEnv) {
    showToast('目前環境不支援自動安裝', 'error')
    return
  }
  cudaInstallInProgress = true
  if (installCudaEnvBtn) installCudaEnvBtn.disabled = true
  cudaInstallProgress?.classList.remove('hidden')
  if (cudaInstallProgressFill) cudaInstallProgressFill.style.width = '5%'
  if (cudaEnvStatus) cudaEnvStatus.textContent = '準備安裝…將跳出系統管理員確認（UAC）'

  const unsub = electronAPI.system.onCudaInstallProgress?.((p) => {
    if (cudaEnvStatus && p?.message) cudaEnvStatus.textContent = p.message
    if (cudaInstallProgressFill && typeof p?.percent === 'number') {
      cudaInstallProgressFill.style.width = `${Math.max(0, Math.min(100, p.percent))}%`
    }
  })

  try {
    const result = await electronAPI.system.installCudaEnv()
    if (result?.capability) gpuCapability = result.capability
    await refreshGpuCapabilityUi(true)
    if (result?.ok) {
      showToast(result.message || 'CUDA 環境已安裝')
    } else {
      showToast(result?.message || '安裝失敗', 'error')
      // 提供官網後備
      if (result?.message && /手動|失敗|代碼/.test(result.message)) {
        /* 使用者可再點官網；此處不強制開瀏覽器 */
      }
    }
  } catch (e) {
    showToast(`安裝失敗：${cleanIpcError(e)}`, 'error')
  } finally {
    cudaInstallInProgress = false
    if (typeof unsub === 'function') unsub()
    cudaInstallProgress?.classList.add('hidden')
    if (cudaInstallProgressFill) cudaInstallProgressFill.style.width = '0%'
    await refreshGpuCapabilityUi(true)
  }
}

let segmentsInited = false

/**
 * 從 store 重灌設定表單
 */
async function loadSettingsForm() {
  const settings = await getSettings()

  if (apiUrlInput) apiUrlInput.value = settings.apiUrl || DEFAULT_API_URL
  if (apiKeyInput) apiKeyInput.value = settings.apiKey || ''
  if (modelIdInput) modelIdInput.value = settings.modelId || DEFAULT_MODEL
  if (asrApiUrlInput) asrApiUrlInput.value = settings.asrApiUrl || DEFAULT_ASR_API_URL
  if (asrApiKeyInput) asrApiKeyInput.value = settings.asrApiKey || ''
  if (asrModelIdInput) asrModelIdInput.value = settings.asrModelId || DEFAULT_ASR_MODEL

  const llmGpuSeg = settings.llmGpu ? 'gpu' : 'cpu'
  const theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'

  if (!segmentsInited) {
    initSegment('translatorSegment', settings.translator, updateTranslatorPanels)
    initSegment('asrEngineSegment', settings.asrEngine, updateAsrPanels)
    initSegment('localTranslateModelSegment', settings.localTranslateModel)
    initSegment('llmGpuSegment', llmGpuSeg)
    initSegment('themeSegment', theme, onThemeSegmentChange)
    segmentsInited = true
  } else {
    setSegmentValue('translatorSegment', settings.translator)
    setSegmentValue('asrEngineSegment', settings.asrEngine)
    setSegmentValue('localTranslateModelSegment', settings.localTranslateModel)
    setSegmentValue('llmGpuSegment', llmGpuSeg)
    setSegmentValue('themeSegment', theme)
  }
  updateTranslatorPanels(settings.translator)
  updateAsrPanels(settings.asrEngine)
  await refreshGpuCapabilityUi()

  if (ttsRateInput) {
    ttsRateInput.value = String(settings.ttsRate)
    updateTtsRateLabel(settings.ttsRate)
  }

  if (!ttsVoiceCatalog?.voicesByLang || !Object.keys(ttsVoiceCatalog.voicesByLang).length) {
    await populateTtsVoiceSelects()
  }
  applyTtsVoicesToForm(settings.ttsVoices || DEFAULT_TTS_VOICES)
}

async function saveSettings() {
  const translator = normalizeTranslator(segmentValues.translatorSegment)
  const asrEngine = normalizeAsrEngine(segmentValues.asrEngineSegment)
  const localTranslateModel = normalizeLocalTranslateModel(segmentValues.localTranslateModelSegment)
  let llmGpu = segmentValues.llmGpuSegment === 'gpu'
  const apiKey = (apiKeyInput?.value || '').trim()
  const asrApiKey = (asrApiKeyInput?.value || '').trim()

  if (translator === 'cloud' && !apiKey) {
    showToast('雲端翻譯需要 API Key', 'error')
    return
  }
  if (asrEngine === 'cloud' && !asrApiKey) {
    showToast('雲端語音轉文字需要 API Key', 'error')
    return
  }
  if (llmGpu) {
    if (!gpuCapability) await refreshGpuCapabilityUi()
    if (!gpuCapability?.ok) {
      showToast(gpuCapability?.reason || '此裝置無法使用 GPU 推論', 'error')
      llmGpu = false
      setSegmentValue('llmGpuSegment', 'cpu')
    }
  }

  const ttsRate = normalizeTtsRate(ttsRateInput ? Number(ttsRateInput.value) : 0)

  await Promise.all([
    electronAPI.store.set('translator', translator),
    electronAPI.store.set('apiUrl', (apiUrlInput?.value || '').trim() || DEFAULT_API_URL),
    electronAPI.store.set('apiKey', apiKey),
    electronAPI.store.set('modelId', (modelIdInput?.value || '').trim() || DEFAULT_MODEL),
    electronAPI.store.set('asrEngine', asrEngine),
    electronAPI.store.set('asrApiUrl', (asrApiUrlInput?.value || '').trim() || DEFAULT_ASR_API_URL),
    electronAPI.store.set('asrApiKey', asrApiKey),
    electronAPI.store.set('asrModelId', (asrModelIdInput?.value || '').trim() || DEFAULT_ASR_MODEL),
    electronAPI.store.set('ttsVoices', readTtsVoicesFromForm()),
    electronAPI.store.set('ttsRate', ttsRate),
    electronAPI.store.set('localTranslateModel', localTranslateModel),
    electronAPI.store.set('llmGpu', llmGpu)
  ])

  document.dispatchEvent(new CustomEvent('settings-changed'))
  showToast('設定已儲存')
}

// ===== 模型管理 UI =====

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
  return Math.round(bytes / (1024 * 1024)) + ' MB'
}

async function refreshModels() {
  if (!modelList || !modelsPathText) return
  const status = await electronAPI.models.status()
  latestModels = status.models || {}
  modelsPathText.textContent = status.root
  modelsPathText.title = status.root

  modelList.innerHTML = ''
  for (const model of Object.values(latestModels)) {
    modelList.appendChild(renderModelItem(model))
  }
}

function renderModelItem(model) {
  const item = document.createElement('div')
  item.className = 'model-item'
  item.dataset.key = model.key

  const roleTag = model.kind === 'asr' ? 'ASR' : '翻譯'
  const stateText = model.downloaded
    ? `${formatBytes(model.totalBytes)} · 已下載`
    : model.downloading
      ? '下載中…'
      : formatBytes(model.totalBytes)

  item.innerHTML = `
    <div class="model-row">
      <div class="model-info">
        <p class="model-name">${model.label}<span class="model-tag">${roleTag}</span></p>
        <p class="model-size ${model.downloaded ? 'downloaded' : ''}">${stateText}</p>
      </div>
      <div class="model-actions"></div>
    </div>
    <div class="model-progress hidden"><div class="model-progress-fill"></div></div>
  `

  const actions = item.querySelector('.model-actions')
  if (model.downloading) {
    actions.appendChild(actionBtn('取消', 'btn-secondary', () => electronAPI.models.cancel(model.key)))
    item.querySelector('.model-progress').classList.remove('hidden')
  } else if (model.downloaded) {
    actions.appendChild(actionBtn('📂', 'btn-secondary', () => electronAPI.models.openFolder(model.key)))
    actions.appendChild(actionBtn('刪除', 'btn-secondary', async () => {
      try {
        const st = await electronAPI.engine.status()
        if (st.asrLoaded || st.llmLoaded) {
          showToast('請先停止字幕／轉錄並離開即時分頁後再刪除模型', 'error')
          return
        }
        await electronAPI.models.delete(model.key)
        refreshModels()
      } catch (e) {
        showToast(`刪除失敗: ${cleanIpcError(e)}`, 'error')
      }
    }))
  } else {
    actions.appendChild(actionBtn('下載', 'btn-primary', () => startDownload(model)))
  }
  return item
}

function actionBtn(text, cls, onClick) {
  const btn = document.createElement('button')
  btn.className = `btn ${cls} btn-sm`
  btn.textContent = text
  btn.addEventListener('click', onClick)
  return btn
}

async function startDownload(model) {
  try {
    await refreshModelsAfter(() => electronAPI.models.download(model.key))
  } catch (error) {
    showToast(`下載失敗: ${cleanIpcError(error)}`, 'error')
    refreshModels()
  }
}

async function refreshModelsAfter(fn) {
  const promise = fn()
  promise.catch(() => {}) // 先標記已處理，避免 refresh 期間出現 unhandled rejection
  await refreshModels() // 立刻顯示「下載中」狀態
  await promise
  await refreshModels()
}

/**
 * 下載進度
 */
function onModelProgress({ key, receivedBytes, totalBytes }) {
  const percent = totalBytes > 0
    ? Math.min(100, (receivedBytes / totalBytes) * 100)
    : 0
  const text = `${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)} (${percent.toFixed(0)}%)`

  const item = modelList?.querySelector(`.model-item[data-key="${key}"]`)
  if (item) {
    const progress = item.querySelector('.model-progress')
    progress.classList.remove('hidden')
    progress.querySelector('.model-progress-fill').style.width = percent + '%'
    item.querySelector('.model-size').textContent = text
  }

  if (latestModels[key]) {
    latestModels[key] = { ...latestModels[key], downloading: true }
  }
}

/**
 * 去除 Electron IPC 錯誤前綴
 */
export function cleanIpcError(error) {
  return String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

// ===== Toast 訊息 =====

/**
 * 顯示 Toast 訊息
 * @param {string} message - 訊息內容
 * @param {string} type - 類型 (success/error)
 */
let toastTimer = null

export function showToast(message, type = 'success') {
  const toastMessage = toast.querySelector('.toast-message')
  toastMessage.textContent = message

  toast.className = 'toast ' + type
  toast.classList.remove('hidden')

  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.classList.add('hidden')
    toastTimer = null
  }, 3000)
}
