/**
 * VoiceInk - 主應用程式邏輯
 */

import { initTranscribe } from './transcribe.js'
import { initLiveCaption, prewarmEngine, cooldownEngine } from './live-caption.js'
import { DEFAULT_API_URL, DEFAULT_MODEL } from './api.js'

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
  translate: async (text) => text // opts 可選，瀏覽器 fallback 直接回原文
}

// ===== 設定 =====

const SETTING_DEFAULTS = {
  translator: 'none',
  /** 即時字幕：bilingual 雙語｜translation 僅翻譯 */
  captionDisplayMode: 'bilingual',
  apiUrl: DEFAULT_API_URL,
  apiKey: '',
  modelId: DEFAULT_MODEL
}

/** 固定本地 ASR 模型 key */
export const ASR_MODEL_KEY = 'qwen3asr'

/** 固定本地翻譯模型 key */
export const TRANSLATE_MODEL_KEY = 'qwen35translate'

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
  return Object.fromEntries(entries)
}

// ===== DOM 元素 =====
const navItems = document.querySelectorAll('.nav-tab')
const pages = document.querySelectorAll('.page')
const themeToggle = document.getElementById('themeToggle')
const settingsBtn = document.getElementById('settingsBtn')
const settingsPanel = document.getElementById('settingsPanel')
const closeSettingsBtn = document.getElementById('closeSettingsBtn')
const settingsOverlay = document.querySelector('.settings-overlay')
const apiUrlInput = document.getElementById('apiUrlInput')
const apiKeyInput = document.getElementById('apiKeyInput')
const modelIdInput = document.getElementById('modelIdInput')
const toggleApiKeyVisibility = document.getElementById('toggleApiKeyVisibility')
const cloudApiSection = document.getElementById('cloudApiSection')
const modelList = document.getElementById('modelList')
const modelsPathText = document.getElementById('modelsPathText')
const toast = document.getElementById('toast')
const asrStatusText = document.getElementById('asrStatusText')
const llmStatusText = document.getElementById('llmStatusText')
const asrDownloadBtn = document.getElementById('asrDownloadBtn')
const llmDownloadBtn = document.getElementById('llmDownloadBtn')
const asrProgress = document.getElementById('asrProgress')
const llmProgress = document.getElementById('llmProgress')

// 分段選擇器目前的值
const segmentValues = {
  translatorSegment: 'none'
}

// 最近一次模型狀態快取（供上方摘要按鈕使用）
let latestModels = {}

// ===== 初始化 =====
document.addEventListener('DOMContentLoaded', async () => {
  await initTheme()
  await initSettings()
  initNavigation()
  initTranscribe()
  initLiveCaption()
})

// ===== 主題管理 =====

async function initTheme() {
  const savedTheme = await electronAPI.store.get('theme', 'dark')
  document.documentElement.setAttribute('data-theme', savedTheme)
  themeToggle.addEventListener('click', toggleTheme)
}

async function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme')
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark'
  document.documentElement.setAttribute('data-theme', newTheme)
  await electronAPI.store.set('theme', newTheme)
}

// ===== 分頁導航 =====

function initNavigation() {
  navItems.forEach(item => {
    item.addEventListener('click', () => switchPage(item.dataset.page))
  })
}

function switchPage(pageName) {
  navItems.forEach(item => {
    item.classList.toggle('active', item.dataset.page === pageName)
  })
  pages.forEach(page => {
    page.classList.toggle('active', page.id === `page-${pageName}`)
  })
  // 進入即時字幕分頁即背景預熱模型；離開且未擷取時卸載
  if (pageName === 'live') prewarmEngine()
  else cooldownEngine()
}

// ===== 設定管理 =====

async function initSettings() {
  const settings = await getSettings()

  apiUrlInput.value = settings.apiUrl
  apiKeyInput.value = settings.apiKey
  modelIdInput.value = settings.modelId
  initSegment('translatorSegment', settings.translator)
  updateCloudApiVisibility(settings.translator)

  settingsBtn.addEventListener('click', openSettings)
  closeSettingsBtn.addEventListener('click', closeSettings)
  settingsOverlay.addEventListener('click', closeSettings)

  toggleApiKeyVisibility.addEventListener('click', () => {
    const isPassword = apiKeyInput.type === 'password'
    apiKeyInput.type = isPassword ? 'text' : 'password'
    toggleApiKeyVisibility.textContent = isPassword ? '🙈' : '👁️'
  })

  document.getElementById('saveSettingsBtn').addEventListener('click', saveSettings)

  asrDownloadBtn.addEventListener('click', () => handleStatusCardAction(ASR_MODEL_KEY))
  llmDownloadBtn.addEventListener('click', () => handleStatusCardAction(TRANSLATE_MODEL_KEY))

  // 模型管理
  document.getElementById('openModelsFolderBtn').addEventListener('click', () => {
    electronAPI.models.openFolder()
  })
  modelsPathText.addEventListener('click', () => electronAPI.models.openFolder())
  electronAPI.models.onProgress(onModelProgress)
  await refreshModels()
}

/**
 * 初始化分段選擇器
 */
function initSegment(id, value) {
  const segment = document.getElementById(id)
  segmentValues[id] = value
  const buttons = segment.querySelectorAll('.seg-btn')
  buttons.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.value === value)
    btn.addEventListener('click', () => {
      segmentValues[id] = btn.dataset.value
      buttons.forEach(b => b.classList.toggle('active', b === btn))
      if (id === 'translatorSegment') {
        updateCloudApiVisibility(btn.dataset.value)
      }
    })
  })
}

/**
 * 翻譯選「雲端 LLM」才展開雲端 API 設定
 * @param {string} translator
 */
function updateCloudApiVisibility(translator) {
  cloudApiSection.classList.toggle('hidden', translator !== 'cloud')
}

function openSettings() {
  settingsPanel.classList.remove('hidden')
  refreshModels()
}

function closeSettings() {
  settingsPanel.classList.add('hidden')
}

async function saveSettings() {
  const translator = segmentValues.translatorSegment
  const apiKey = apiKeyInput.value.trim()

  if (translator === 'cloud' && !apiKey) {
    showToast('雲端翻譯需要 API Key', 'error')
    return
  }

  await Promise.all([
    electronAPI.store.set('translator', translator),
    electronAPI.store.set('apiUrl', apiUrlInput.value.trim() || DEFAULT_API_URL),
    electronAPI.store.set('apiKey', apiKey),
    electronAPI.store.set('modelId', modelIdInput.value.trim() || DEFAULT_MODEL)
  ])

  closeSettings()
  document.dispatchEvent(new CustomEvent('settings-changed'))
}

// ===== 模型管理 UI =====

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
  return Math.round(bytes / (1024 * 1024)) + ' MB'
}

async function refreshModels() {
  const status = await electronAPI.models.status()
  latestModels = status.models || {}
  modelsPathText.textContent = status.root
  modelsPathText.title = status.root

  updateStatusCards(latestModels)

  modelList.innerHTML = ''
  for (const model of Object.values(latestModels)) {
    modelList.appendChild(renderModelItem(model))
  }
}

/**
 * 更新上方 ASR / 翻譯狀態卡
 * @param {Record<string, object>} models
 */
function updateStatusCards(models) {
  updateOneStatusCard(
    models[ASR_MODEL_KEY],
    asrStatusText,
    asrDownloadBtn,
    asrProgress
  )
  updateOneStatusCard(
    models[TRANSLATE_MODEL_KEY],
    llmStatusText,
    llmDownloadBtn,
    llmProgress
  )
}

/**
 * 更新單一狀態卡的文字、按鈕與進度條
 */
function updateOneStatusCard(model, statusEl, btn, progressEl) {
  if (!model) {
    statusEl.textContent = '狀態未知'
    statusEl.className = 'engine-status-meta'
    btn.textContent = '重新整理'
    btn.className = 'btn btn-secondary btn-sm engine-status-btn'
    btn.disabled = false
    progressEl.classList.add('hidden')
    return
  }

  const size = formatBytes(model.totalBytes)
  if (model.downloading) {
    statusEl.textContent = `${size} · 下載中…`
    statusEl.className = 'engine-status-meta is-busy'
    btn.textContent = '取消'
    btn.className = 'btn btn-secondary btn-sm engine-status-btn'
    btn.disabled = false
    progressEl.classList.remove('hidden')
  } else if (model.downloaded) {
    statusEl.textContent = `${size} · 已下載`
    statusEl.className = 'engine-status-meta is-ready'
    btn.textContent = '已就緒'
    btn.className = 'btn btn-secondary btn-sm engine-status-btn'
    btn.disabled = true
    progressEl.classList.add('hidden')
    progressEl.querySelector('.model-progress-fill').style.width = '0%'
  } else {
    statusEl.textContent = `${size} · 未下載`
    statusEl.className = 'engine-status-meta'
    btn.textContent = '下載'
    btn.className = 'btn btn-primary btn-sm engine-status-btn'
    btn.disabled = false
    progressEl.classList.add('hidden')
    progressEl.querySelector('.model-progress-fill').style.width = '0%'
  }
}

/**
 * 上方狀態卡按鈕：下載／取消
 * @param {string} key
 */
async function handleStatusCardAction(key) {
  const model = latestModels[key]
  if (!model) {
    await refreshModels()
    return
  }
  if (model.downloading) {
    await electronAPI.models.cancel(key)
    await refreshModels()
    return
  }
  if (model.downloaded) return
  await startDownload(model)
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
      await electronAPI.models.delete(model.key)
      refreshModels()
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
 * 下載進度：同步更新下方列表與上方狀態卡
 */
function onModelProgress({ key, receivedBytes, totalBytes }) {
  const percent = Math.min(100, (receivedBytes / totalBytes) * 100)
  const text = `${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)} (${percent.toFixed(0)}%)`

  const item = modelList.querySelector(`.model-item[data-key="${key}"]`)
  if (item) {
    const progress = item.querySelector('.model-progress')
    progress.classList.remove('hidden')
    progress.querySelector('.model-progress-fill').style.width = percent + '%'
    item.querySelector('.model-size').textContent = text
  }

  if (key === ASR_MODEL_KEY) {
    asrStatusText.textContent = text
    asrStatusText.className = 'engine-status-meta is-busy'
    asrProgress.classList.remove('hidden')
    asrProgress.querySelector('.model-progress-fill').style.width = percent + '%'
    asrDownloadBtn.textContent = '取消'
    asrDownloadBtn.className = 'btn btn-secondary btn-sm engine-status-btn'
    asrDownloadBtn.disabled = false
  } else if (key === TRANSLATE_MODEL_KEY) {
    llmStatusText.textContent = text
    llmStatusText.className = 'engine-status-meta is-busy'
    llmProgress.classList.remove('hidden')
    llmProgress.querySelector('.model-progress-fill').style.width = percent + '%'
    llmDownloadBtn.textContent = '取消'
    llmDownloadBtn.className = 'btn btn-secondary btn-sm engine-status-btn'
    llmDownloadBtn.disabled = false
  }

  // 更新快取，讓取消按鈕可立刻生效
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
export function showToast(message, type = 'success') {
  const toastMessage = toast.querySelector('.toast-message')
  toastMessage.textContent = message

  toast.className = 'toast ' + type

  setTimeout(() => {
    toast.classList.add('hidden')
  }, 3000)
}
