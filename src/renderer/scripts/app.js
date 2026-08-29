/**
 * VoiceInk - 主應用程式邏輯
 */

import {
  initChatPage,
  refreshChatPage,
  loadChatSettings,
  validateChatSettings,
  saveChatSettings
} from './chat-page.js'
import { DEFAULT_ASR_API_URL, DEFAULT_ASR_MODEL } from './api.js'
import { initCustomSelects, syncCustomSelects } from './custom-select.js'

/** @type {typeof import('./live-caption.js') | null} */
let liveCaption = null
/** @type {typeof import('./translate-page.js') | null} */
let translatePage = null
/** @type {typeof import('./transcribe.js') | null} */
let transcribePage = null
/** @type {typeof import('./usage-page.js') | null} */
let usagePage = null
/** @type {typeof import('./agy-page.js') | null} */
let agyPage = null
/** @type {typeof import('./terminal-page.js') | null} */
let terminalPage = null
/** @type {typeof import('./stt-page.js') | null} */
let sttPage = null

/** @returns {Promise<typeof import('./live-caption.js')>} */
async function loadLiveCaption() {
  if (!liveCaption) {
    liveCaption = await import('./live-caption.js')
    liveCaption.initLiveCaption()
  }
  return liveCaption
}

/** @returns {Promise<typeof import('./translate-page.js')>} */
async function loadTranslatePage() {
  if (!translatePage) {
    translatePage = await import('./translate-page.js')
    translatePage.initTranslatePage()
  }
  return translatePage
}

/** @returns {Promise<typeof import('./transcribe.js')>} */
async function loadTranscribePage() {
  if (!transcribePage) {
    transcribePage = await import('./transcribe.js')
    transcribePage.initTranscribe()
  }
  return transcribePage
}

/** @returns {Promise<typeof import('./usage-page.js')>} */
async function loadUsagePage() {
  if (!usagePage) usagePage = await import('./usage-page.js')
  return usagePage
}

/** @returns {Promise<typeof import('./agy-page.js')>} */
async function loadAgyPage() {
  if (!agyPage) agyPage = await import('./agy-page.js')
  return agyPage
}

/** @returns {Promise<typeof import('./terminal-page.js')>} */
async function loadTerminalPage() {
  if (!terminalPage) terminalPage = await import('./terminal-page.js')
  return terminalPage
}

/** @returns {Promise<typeof import('./stt-page.js')>} */
async function loadSttPage() {
  if (!sttPage) sttPage = await import('./stt-page.js')
  return sttPage
}

/**
 * 進「語音轉文字」頁：兩個子分頁的模組都要在（切子分頁不該再等一次 import），
 * 但引擎只給目前這個子分頁用——即時字幕 prewarm 很貴，停在檔案轉錄時不該先付。
 * @param {'file'|'live'} subtab
 */
async function activateSttSubtab(subtab) {
  await loadTranscribePage()
  if (subtab === 'live') {
    const live = await loadLiveCaption()
    live.prewarmEngine()
  } else {
    liveCaption?.cooldownEngine()
  }
}

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
  usage: {
    load: async () => ({ ok: true, data: {
      accounts: ['claude-code', 'codex', 'antigravity', 'opencode-go', 'grok'].map((provider, order) => ({
        id: provider,
        provider,
        accountName: provider,
        planName: provider,
        status: 'disconnected',
        accuracy: 'estimated',
        lastUpdated: new Date(0).toISOString(),
        windows: [],
        notes: '僅 Electron 環境可同步',
        order
      })),
      settings: {
        visibleProviders: ['claude-code', 'codex', 'antigravity', 'opencode-go', 'grok'],
        providerOrder: ['claude-code', 'codex', 'antigravity', 'opencode-go', 'grok'],
        opencodeWeeklyReset: { day: 1, hour: 7, minute: 0 },
        opencodeMonthlyReset: { day: 29, hour: 0, minute: 0 }
      },
      lastSyncedAt: null,
      diagnostics: []
    } }),
    sync: async () => ({ ok: false, error: { code: 'ELECTRON_ONLY', message: '僅 Electron 環境可同步' } }),
    saveSettings: async (settings) => ({ ok: true, data: { ...(await electronAPI.usage.load()).data, settings } }),
    getDiagnostics: async () => ({ ok: true, data: [] })
  },
  agy: {
    status: async () => ({ ok: true, data: {
      running: false,
      host: '127.0.0.1',
      port: 8788,
      uptimeMs: 0,
      activeRequests: 0,
      baseUrl: 'http://127.0.0.1:8788/v1',
      apiKey: '',
      logBodies: false,
      retentionDays: 30,
      credential: { connected: false, tier: '', code: 'ELECTRON_ONLY', message: '僅 Electron 環境可用' },
      db: { ready: false, lastError: '' }
    } }),
    start: async () => ({ ok: false, error: { code: 'ELECTRON_ONLY', message: '僅 Electron 環境可用' } }),
    stop: async () => ({ ok: false, error: { code: 'ELECTRON_ONLY', message: '僅 Electron 環境可用' } }),
    saveSettings: async () => ({ ok: false, error: { code: 'ELECTRON_ONLY', message: '僅 Electron 環境可用' } }),
    regenerateKey: async () => ({ ok: false, error: { code: 'ELECTRON_ONLY', message: '僅 Electron 環境可用' } }),
    logs: async () => ({ ok: true, data: { logs: [], total: 0 } }),
    stats: async () => ({ ok: true, data: {
      summary: { requests: 0, success: 0, errors: 0, input: 0, output: 0, thought: 0, cached: 0 },
      hourly: [], daily: [], models: []
    } }),
    clearLogs: async () => ({ ok: true, data: { ok: true } })
  },
  chat: {
    list: async () => [],
    get: async () => null,
    create: async () => ({ id: 'dev', title: '新對話', createdAt: 0, updatedAt: 0, messages: [] }),
    delete: async () => true,
    rename: async () => true,
    send: async () => ({ ok: false, error: '僅 Electron 環境可用' }),
    abort: async () => true,
    image: async () => '',
    onDelta: () => () => {}
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
  /** 雲端翻譯＝聊天供應商清單裡的一組（設定→雲端模型），模型在翻譯頁上方選 */
  chatProviders: [],
  translateProviderId: '',
  translateModelId: '',
  /** @type {'local'|'cloud'} */
  asrEngine: 'local',
  asrApiUrl: DEFAULT_ASR_API_URL,
  asrApiKey: '',
  asrModelId: DEFAULT_ASR_MODEL,
  ttsVoices: { ...DEFAULT_TTS_VOICES },
  /** 語速百分比偏移 -50…100 */
  ttsRate: 0,
  /** @type {'linguaforge08q4'|'qwen35translate'|'qwen354b'} */
  localTranslateModel: 'linguaforge08q4',
  /** 本地 ASR 模型：qwen3asr（sherpa，CPU）/ qwen3asrgpu（llama-server，GPU） */
  asrModelKey: 'qwen3asr',
  /** 本地 LLM 是否使用 CUDA（需 NVIDIA ≥6GB）。全域：任何一頁用到本地翻譯都吃這個設定 */
  llmGpu: false
}

/** 預設本地 ASR 模型 key（實際用哪顆由 main 讀 `asrModelKey` 決定） */
export const ASR_MODEL_KEY = 'qwen3asr'

/** 本地 ASR 模型 key 白名單（順序：推薦在前） */
export const ASR_MODEL_KEYS = ['qwen3asr', 'qwen3asrgpu']

/** 本地翻譯模型 key 白名單（順序：推薦在前） */
export const LLM_MODEL_KEYS = ['linguaforge08q4', 'qwen35translate', 'qwen354b']

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
 * @returns {'linguaforge08q4'|'qwen35translate'|'qwen354b'}
 */
export function normalizeLocalTranslateModel(v) {
  return LLM_KEY_SET.has(/** @type {string} */ (v))
    ? /** @type {'linguaforge08q4'|'qwen35translate'|'qwen354b'} */ (v)
    : 'linguaforge08q4'
}

/**
 * @param {unknown} v
 * @returns {'qwen3asr'|'qwen3asrgpu'}
 */
export function normalizeAsrModelKey(v) {
  return v === 'qwen3asrgpu' ? 'qwen3asrgpu' : 'qwen3asr'
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
    asrModelKey: normalizeAsrModelKey(raw.asrModelKey),
    llmGpu: raw.llmGpu === true,
    chatProviders: Array.isArray(raw.chatProviders) ? raw.chatProviders : []
  }
}

// ===== DOM 元素 =====
const navItems = document.querySelectorAll('.nav-tab')
const pages = document.querySelectorAll('.page')
const asrApiUrlInput = document.getElementById('asrApiUrlInput')
const asrApiKeyInput = document.getElementById('asrApiKeyInput')
const asrModelIdInput = document.getElementById('asrModelIdInput')
const toggleAsrApiKeyVisibility = document.getElementById('toggleAsrApiKeyVisibility')
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

// 分段選擇器目前的值（翻譯／辨識後端與模型已移到各功能頁的選單，這裡只剩推論設定）
const segmentValues = {
  llmGpuSegment: 'cpu',
  themeSegment: 'dark'
}

// 最近一次模型狀態快取
let latestModels = {}

// ===== 初始化 =====
document.addEventListener('DOMContentLoaded', async () => {
  initCustomSelects()
  await initTheme()
  initWindowControls()
  bindSettingsControls()
  initNavigation()
  initChatPage()
  refreshChatPage()
  // 子分頁切換要跟著換引擎擁有者：停在檔案轉錄時不該預熱即時字幕
  document.addEventListener('stt-subtab-changed', (e) => {
    activateSttSubtab(/** @type {CustomEvent} */ (e).detail?.subtab)
  })
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

// ===== 視窗與啟動（跟主題一樣即時套用，不用按儲存）=====

/** 只綁一次，之後每次進設定頁只重讀值 */
let startupBound = false

async function loadStartupSettings() {
  const trayInput = document.getElementById('closeToTrayInput')
  const loginInput = document.getElementById('startAtLoginInput')
  const hint = document.getElementById('startupHint')
  if (!trayInput || !loginInput) return

  trayInput.checked = (await electronAPI.store.get('closeToTray', true)) !== false

  // 開機自啟動的真相在 OS，不是 store：使用者可能在工作管理員直接停用
  const startup = await electronAPI.system?.getStartup?.().catch(() => null)
  loginInput.checked = startup?.openAtLogin === true
  loginInput.disabled = startup?.supported !== true
  if (hint) {
    hint.classList.toggle('hidden', startup?.supported === true)
    hint.textContent = startup?.supported === true ? '' : '開發模式下不註冊開機自啟動（只有打包版才會寫入）。'
  }

  if (startupBound) return
  startupBound = true

  trayInput.addEventListener('change', async () => {
    await electronAPI.store.set('closeToTray', trayInput.checked)
    showToast(trayInput.checked ? '關閉視窗後會留在系統匣' : '關閉視窗會結束 VoiceInk')
  })

  loginInput.addEventListener('change', async () => {
    const result = await electronAPI.system?.setStartup?.(loginInput.checked).catch(() => null)
    // 寫入失敗（權限／政策）就把勾勾轉回實際狀態，不要讓 UI 說謊
    loginInput.checked = result?.openAtLogin === true
    showToast(loginInput.checked ? '已設定開機自動啟動' : '已取消開機自動啟動')
  })
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
    const on = item.dataset.page === pageName
    item.classList.toggle('active', on)
    if (on) item.setAttribute('aria-current', 'page')
    else item.removeAttribute('aria-current')
  })
  pages.forEach(page => {
    page.classList.toggle('active', page.id === `page-${pageName}`)
  })
  // 先啟動新頁 acquire，再 release 舊頁，避免中間 owner 歸零觸發 unload＋重付 warm
  if (pageName === 'chat') refreshChatPage()
  if (pageName === 'terminal') loadTerminalPage().then((m) => m.refreshTerminalPage())
  if (pageName === 'usage') loadUsagePage().then((m) => m.refreshUsagePage())
  if (pageName === 'agy') loadAgyPage().then((m) => m.refreshAgyPage())
  if (pageName === 'stt') {
    loadSttPage().then((m) => {
      m.refreshSttPage()
      activateSttSubtab(m.currentSubtab())
    })
  }
  if (pageName === 'translate') loadTranslatePage().then((m) => m.prewarmTranslatePage())
  if (pageName === 'settings') {
    loadSettingsForm()
    refreshModels()
  }
  if (pageName !== 'stt') liveCaption?.cooldownEngine()
  if (pageName !== 'translate') translatePage?.cooldownTranslatePage()
  if (pageName !== 'usage') usagePage?.cooldownUsagePage()
  if (pageName !== 'agy') agyPage?.cooldownAgyPage()
}

/**
 * 供聊天／翻譯頁的「前往設定」呼叫。
 * @param {'local'|'cloud'|'voice'|'basic'} [section]
 */
export function openSettingsPage(section = 'local') {
  switchPage('settings')
  activateSettingsSection(section)
}

/**
 * 顯示指定設定分類。
 * @param {string} target
 */
function activateSettingsSection(target) {
  const nav = document.getElementById('settingsNav')
  const item = nav?.querySelector(`.settings-nav-item[data-section="${target}"]`)
  if (!nav || !item) return
  const items = [...nav.querySelectorAll('.settings-nav-item')]
  const sections = [...document.querySelectorAll('#page-settings .settings-section')]
  items.forEach((candidate) => candidate.classList.toggle('active', candidate === item))
  sections.forEach((section) => section.classList.toggle('active', section.dataset.section === target))
  const scroll = document.getElementById('settingsScroll')
  if (scroll) scroll.scrollTop = 0
}

/**
 * 設定頁左側分類：六區一次只顯示一區（原本全部堆在同一欄捲到底）
 */
function initSettingsNav() {
  const nav = document.getElementById('settingsNav')
  if (!nav) return
  const items = [...nav.querySelectorAll('.settings-nav-item')]
  items.forEach((item) => {
    item.addEventListener('click', () => {
      activateSettingsSection(item.dataset.section)
    })
  })
}

// ===== 設定管理 =====

/**
 * 啟動時只綁事件，不打 nvidia-smi／掃模型檔。
 * 表單內容在進設定頁時才 loadSettingsForm + refreshModels。
 */
function bindSettingsControls() {
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

  document.querySelectorAll('.tts-preview-btn').forEach((btn) => {
    btn.addEventListener('click', () => previewVoice(/** @type {HTMLButtonElement} */ (btn)))
  })

  installCudaEnvBtn?.addEventListener('click', () => onInstallCudaEnv())
  refreshGpuEnvBtn?.addEventListener('click', () => refreshGpuCapabilityUi(true))

  // 模型管理
  document.getElementById('openModelsFolderBtn')?.addEventListener('click', () => {
    electronAPI.models.openFolder()
  })
  modelsPathText?.addEventListener('click', () => electronAPI.models.openFolder())
  electronAPI.models.onProgress(onModelProgress)
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

// ===== 語音試聽 =====

/** 同時只播一段：再按一次（或按別顆）就把上一段收掉 */
/** @type {{ audio: HTMLAudioElement, url: string, btn: HTMLButtonElement } | null} */
let previewPlaying = null

function stopPreview() {
  if (!previewPlaying) return
  const { audio, url, btn } = previewPlaying
  previewPlaying = null
  audio.pause()
  URL.revokeObjectURL(url)
  btn.textContent = '▶ 試聽'
  btn.setAttribute('aria-pressed', 'false')
}

/**
 * 用「現在選到但還沒儲存」的語音與語速唸一句範例。
 * 文字由 main 決定（固定表），這裡只送 lang／voice／rate。
 * @param {HTMLButtonElement} btn
 */
async function previewVoice(btn) {
  const lang = btn.dataset.ttsPreview
  const wasThisOne = previewPlaying?.btn === btn
  stopPreview()
  if (wasThisOne) return
  if (typeof electronAPI.tts?.preview !== 'function') {
    showToast('目前環境不支援語音試聽', 'error')
    return
  }

  const select = document.querySelector(`select[data-tts-lang="${lang}"]`)
  const voice = select?.value || ''
  const rate = normalizeTtsRate(ttsRateInput ? Number(ttsRateInput.value) : 0)

  btn.disabled = true
  btn.textContent = '載入中…'
  try {
    await electronAPI.tts.cancel?.()
    const res = await electronAPI.tts.preview(lang, voice, rate)
    const url = URL.createObjectURL(new Blob([res.data], { type: res.mime || 'audio/mpeg' }))
    const audio = new Audio(url)
    previewPlaying = { audio, url, btn }
    btn.textContent = '⏹ 停止'
    btn.setAttribute('aria-pressed', 'true')
    audio.addEventListener('ended', stopPreview)
    audio.addEventListener('error', stopPreview)
    await audio.play()
  } catch (e) {
    stopPreview()
    showToast(`試聽失敗：${cleanIpcError(e)}`, 'error')
  } finally {
    btn.disabled = false
    if (previewPlaying?.btn !== btn) btn.textContent = '▶ 試聽'
  }
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
    const on = btn.dataset.value === value
    btn.classList.toggle('active', on)
    btn.setAttribute('aria-pressed', on ? 'true' : 'false')
    btn.addEventListener('click', () => {
      segmentValues[id] = btn.dataset.value
      buttons.forEach(b => {
        const isOn = b === btn
        b.classList.toggle('active', isOn)
        b.setAttribute('aria-pressed', isOn ? 'true' : 'false')
      })
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
    const on = btn.dataset.value === value
    btn.classList.toggle('active', on)
    btn.setAttribute('aria-pressed', on ? 'true' : 'false')
  })
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

  if (asrApiUrlInput) asrApiUrlInput.value = settings.asrApiUrl || DEFAULT_ASR_API_URL
  if (asrApiKeyInput) asrApiKeyInput.value = settings.asrApiKey || ''
  if (asrModelIdInput) asrModelIdInput.value = settings.asrModelId || DEFAULT_ASR_MODEL

  const llmGpuSeg = settings.llmGpu ? 'gpu' : 'cpu'
  const theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'

  if (!segmentsInited) {
    initSegment('llmGpuSegment', llmGpuSeg)
    initSegment('themeSegment', theme, onThemeSegmentChange)
    initSettingsNav()
    segmentsInited = true
  } else {
    setSegmentValue('llmGpuSegment', llmGpuSeg)
    setSegmentValue('themeSegment', theme)
  }
  await refreshGpuCapabilityUi()

  if (ttsRateInput) {
    ttsRateInput.value = String(settings.ttsRate)
    updateTtsRateLabel(settings.ttsRate)
  }

  if (!ttsVoiceCatalog?.voicesByLang || !Object.keys(ttsVoiceCatalog.voicesByLang).length) {
    await populateTtsVoiceSelects()
  }
  applyTtsVoicesToForm(settings.ttsVoices || DEFAULT_TTS_VOICES)
  syncCustomSelects()
  await loadStartupSettings()
  await loadChatSettings()
}

async function saveSettings() {
  let llmGpu = segmentValues.llmGpuSegment === 'gpu'
  const asrApiKey = (asrApiKeyInput?.value || '').trim()

  // 後端選擇已移到各功能頁的模型選單，這裡只在「目前真的選了雲端」時擋空金鑰
  const current = await getSettings()
  if (current.asrEngine === 'cloud' && !asrApiKey) {
    showToast('目前語音轉文字選的是雲端，需要 API Key', 'error')
    return
  }
  const chatValidation = validateChatSettings()
  if (!chatValidation.ok) return
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
    electronAPI.store.set('asrApiUrl', (asrApiUrlInput?.value || '').trim() || DEFAULT_ASR_API_URL),
    electronAPI.store.set('asrApiKey', asrApiKey),
    electronAPI.store.set('asrModelId', (asrModelIdInput?.value || '').trim() || DEFAULT_ASR_MODEL),
    electronAPI.store.set('ttsVoices', readTtsVoicesFromForm()),
    electronAPI.store.set('ttsRate', ttsRate),
    electronAPI.store.set('llmGpu', llmGpu),
    saveChatSettings(chatValidation)
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

  // 分類列出：語音辨識／翻譯／執行環境混在一起時，看不出哪顆是誰的，
  // 尤其 llama.cpp 執行環境夾在模型中間會像是「又一顆模型」
  modelList.replaceChildren()
  const known = new Set(MODEL_GROUPS.map(([kind]) => kind))
  for (const [kind, title] of MODEL_GROUPS) {
    // 最後一組收容未知 kind：registry 加了新類別卻忘了補這張表時，
    // 那顆模型不該從安裝清單裡憑空消失
    const group = Object.values(latestModels).filter((m) => (
      kind === 'runtime' ? (m.kind === kind || !known.has(m.kind)) : m.kind === kind
    ))
    if (!group.length) continue
    const heading = document.createElement('p')
    heading.className = 'model-group-title'
    heading.textContent = title
    modelList.appendChild(heading)
    for (const model of group) modelList.appendChild(renderModelItem(model))
  }
}

/** registry 的 kind → 顯示分組（順序即顯示順序） */
const MODEL_GROUPS = [
  ['asr', '語音辨識'],
  ['llm', '翻譯'],
  ['runtime', '執行環境']
]

function renderModelItem(model) {
  const item = document.createElement('div')
  item.className = 'model-item'
  item.dataset.key = model.key

  const needsRuntime = model.requires && !latestModels[model.requires]?.downloaded
  const stateText = model.downloaded
    ? needsRuntime
      ? `${formatBytes(model.totalBytes)} · 已下載，還缺「${latestModels[model.requires]?.label || model.requires}」`
      : `${formatBytes(model.totalBytes)} · 已下載`
    : model.downloading
      ? '下載中…'
      : needsRuntime
        ? `${formatBytes(model.totalBytes)} · 需搭配「${latestModels[model.requires]?.label || model.requires}」`
        : formatBytes(model.totalBytes)

  // createElement + textContent：renderer 其餘各頁都零 innerHTML，這裡不留唯一的例外
  const name = document.createElement('p')
  name.className = 'model-name'
  name.textContent = model.label

  const size = document.createElement('p')
  size.className = model.downloaded ? 'model-size downloaded' : 'model-size'
  size.textContent = stateText

  const info = document.createElement('div')
  info.className = 'model-info'
  info.append(name, size)

  const actions = document.createElement('div')
  actions.className = 'model-actions'

  const row = document.createElement('div')
  row.className = 'model-row'
  row.append(info, actions)

  const progressFill = document.createElement('div')
  progressFill.className = 'model-progress-fill'
  const progress = document.createElement('div')
  progress.className = 'model-progress hidden'
  progress.appendChild(progressFill)

  item.append(row, progress)

  if (model.downloading) {
    actions.appendChild(actionBtn('取消', 'btn-secondary', () => electronAPI.models.cancel(model.key)))
    progress.classList.remove('hidden')
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
