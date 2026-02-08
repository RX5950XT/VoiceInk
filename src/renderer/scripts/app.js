/**
 * VoiceInk - 主應用程式邏輯
 */

import { initTranscribe } from './transcribe.js'
import { initLiveCaption } from './live-caption.js'

// ===== Electron API Fallback =====
// 在純瀏覽器環境開發時提供 fallback
const electronAPI = window.electronAPI || {
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
    onTextUpdate: (callback) => {}
  }
}

// ===== DOM 元素 =====
const navItems = document.querySelectorAll('.nav-tab')
const pages = document.querySelectorAll('.page')
const themeToggle = document.getElementById('themeToggle')
const settingsBtn = document.getElementById('settingsBtn')
const settingsPanel = document.getElementById('settingsPanel')
const closeSettingsBtn = document.getElementById('closeSettingsBtn')
const settingsOverlay = document.querySelector('.settings-overlay')
const apiKeyInput = document.getElementById('apiKeyInput')
const toggleApiKeyVisibility = document.getElementById('toggleApiKeyVisibility')
const toast = document.getElementById('toast')

// ===== 初始化 =====
document.addEventListener('DOMContentLoaded', async () => {
  await initTheme()
  await initSettings()
  initNavigation()
  initTranscribe()
  initLiveCaption()
})

// ===== 主題管理 =====

/**
 * 初始化主題
 */
async function initTheme() {
  const savedTheme = await electronAPI.store.get('theme', 'dark')
  document.documentElement.setAttribute('data-theme', savedTheme)
  
  themeToggle.addEventListener('click', toggleTheme)
}

/**
 * 切換主題
 */
async function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme')
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark'
  
  document.documentElement.setAttribute('data-theme', newTheme)
  await electronAPI.store.set('theme', newTheme)
}

// ===== 分頁導航 =====

/**
 * 初始化導航
 */
function initNavigation() {
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const targetPage = item.dataset.page
      switchPage(targetPage)
    })
  })
}

/**
 * 切換頁面
 * @param {string} pageName - 頁面名稱
 */
function switchPage(pageName) {
  // 更新導航項目
  navItems.forEach(item => {
    item.classList.toggle('active', item.dataset.page === pageName)
  })
  
  // 更新頁面顯示
  pages.forEach(page => {
    page.classList.toggle('active', page.id === `page-${pageName}`)
  })
}

// ===== 設定管理 =====

// 預設模型 ID
const DEFAULT_MODEL_ID = 'google/gemini-3-flash-preview'

/**
 * 初始化設定
 */
async function initSettings() {
  // 載入已儲存的 API Key
  const savedApiKey = await electronAPI.store.get('apiKey', '')
  apiKeyInput.value = savedApiKey
  
  // 載入已儲存的模型 ID
  const modelIdInput = document.getElementById('modelIdInput')
  const savedModelId = await electronAPI.store.get('modelId', DEFAULT_MODEL_ID)
  modelIdInput.value = savedModelId
  
  // 設定按鈕
  settingsBtn.addEventListener('click', openSettings)
  closeSettingsBtn.addEventListener('click', closeSettings)
  settingsOverlay.addEventListener('click', closeSettings)
  
  // API Key 可見性切換
  toggleApiKeyVisibility.addEventListener('click', () => {
    const isPassword = apiKeyInput.type === 'password'
    apiKeyInput.type = isPassword ? 'text' : 'password'
    toggleApiKeyVisibility.textContent = isPassword ? '🙈' : '👁️'
  })
  
  // 儲存按鈕（ID 已改為 saveSettingsBtn）
  const saveSettingsBtn = document.getElementById('saveSettingsBtn')
  if (saveSettingsBtn) {
    saveSettingsBtn.addEventListener('click', saveSettings)
  }
}

/**
 * 開啟設定面板
 */
function openSettings() {
  settingsPanel.classList.remove('hidden')
}

/**
 * 關閉設定面板
 */
function closeSettings() {
  settingsPanel.classList.add('hidden')
}

/**
 * 儲存設定
 */
async function saveSettings() {
  const apiKey = apiKeyInput.value.trim()
  const modelIdInput = document.getElementById('modelIdInput')
  const modelId = modelIdInput.value.trim() || DEFAULT_MODEL_ID
  
  if (!apiKey) {
    showToast('請輸入 API Key', 'error')
    return
  }
  
  await electronAPI.store.set('apiKey', apiKey)
  await electronAPI.store.set('modelId', modelId)
  showToast('設定已儲存', 'success')
  closeSettings()
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
  
  // 自動隱藏
  setTimeout(() => {
    toast.classList.add('hidden')
  }, 3000)
}

// ===== 導出工具函數 =====

/**
 * 取得 API Key
 * @returns {Promise<string>}
 */
export async function getApiKey() {
  return await electronAPI.store.get('apiKey', '')
}

/**
 * 取得模型 ID
 * @returns {Promise<string>}
 */
export async function getModelId() {
  return await electronAPI.store.get('modelId', DEFAULT_MODEL_ID)
}
