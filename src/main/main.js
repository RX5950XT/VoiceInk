const { app, BrowserWindow, ipcMain, session, desktopCapturer, screen, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const models = require('./models')
const chat = require('./chat')
const chatStore = require('./chat-store')
const { sanitizeTtsVoices, DEFAULT_TTS_VOICES, listVoices } = require('./tts-voices')
const { registerUsageIpc } = require('./usage/ipc')
const { registerAgyIpc } = require('./agy/ipc')

const bootStartedAt = Date.now()
function bootLog(step) {
  console.log(`[boot] ${Date.now() - bootStartedAt}ms ${step}`)
}

/**
 * 啟動只載聊天需要的模組。ASR／LLM／額度／AGY／CUDA 第一次用到才 require，
 * 避免 400MB+ 的 unpacked native 與巨大 JS 圖擋住第一扇窗。
 * @param {string} id
 * @returns {() => object}
 */
function lazyLoad(id) {
  let mod
  return () => {
    if (!mod) {
      mod = require(id)
      if (store && typeof mod.setStore === 'function') mod.setStore(store)
    }
    return mod
  }
}

const loadLocalAsr = lazyLoad('./local-asr')
const loadLocalLlm = lazyLoad('./local-llm')
const loadEngine = lazyLoad('./engine')
const loadFileTranscribe = lazyLoad('./file-transcribe')
const loadEdgeTts = lazyLoad('./edge-tts')
const loadCloudAsr = lazyLoad('./cloud-asr')
const loadChatModels = lazyLoad('./chat-models')
const loadChatImages = lazyLoad('./chat-images')
const loadUsage = lazyLoad('./usage')
const loadGpu = lazyLoad('./gpu-capability')
const loadCudaEnv = lazyLoad('./cuda-env')

let agyMod = null
let backgroundStarted = false
/** @type {Promise<object>|null} */
let storeReady = null

// 主視窗
let mainWindow = null
// 字幕視窗
let subtitleWindow = null
// 設定儲存實例（延遲初始化）
let store = null
/** 正在執行 before-quit 卸載 */
let isQuitting = false

// 開發模式判斷
const isDev = !app.isPackaged

/** electron-store 允許的 key（防任意讀寫／XSS 後改 apiUrl 外洩 key） */
const STORE_ALLOWLIST = new Set([
  'translator',
  'captionDisplayMode',
  'apiUrl',
  'apiKey',
  'modelId',
  'asrEngine',
  'asrApiUrl',
  'asrApiKey',
  'asrModelId',
  'theme',
  'subtitleFontScale',
  'subtitleOpacity',
  'subtitleWindowBounds',
  'ttsVoices',
  'ttsRate',
  'localTranslateModel',
  'llmGpu',
  'asrThreads',
  'chatProviders',
  'chatProviderId',
  'chatModelId',
  'chatPrompts',
  'chatPromptId',
  'chatThinking'
])

const TRANSLATOR_VALUES = new Set(['cloud', 'local'])
const ASR_ENGINE_VALUES = new Set(['local', 'cloud'])
const THEME_VALUES = new Set(['dark', 'light'])

const TRANSLATE_TARGET_LANGS = new Set(['zh-TW', 'zh-CN', 'en', 'ja', 'ko'])
const MAX_TRANSLATE_CHARS = 1500
const DEFAULT_LLM_KEY = 'linguaforge08'
const MAX_ASR_THREADS = 16

/**
 * 本地 ASR 推論執行緒：0＝自動。
 * 沒有 GPU 選項——npm 的 sherpa-onnx-win-x64 是 CPU-only 編譯，
 * provider 傳 cuda/directml 只會靜默 fallback（見 local-asr.resolveThreads 註解）。
 * @param {unknown} raw
 * @returns {number}
 */
function sanitizeAsrThreads(raw) {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 2 || n > MAX_ASR_THREADS) return 0
  return n
}

/**
 * @param {unknown} val
 * @returns {number}
 */
function sanitizeTtsRate(val) {
  const n = Number(val)
  if (!Number.isFinite(n)) return 0
  return Math.max(-50, Math.min(100, Math.round(n)))
}

/**
 * 只為第一扇窗底色讀 theme，不載 electron-store。
 * @returns {'dark'|'light'}
 */
function peekTheme() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8'))
    return raw?.theme === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

/**
 * 第一次用到 AGY 才載模組並開 SQLite。
 * @returns {Promise<object>}
 */
async function loadAgy() {
  await initStore()
  if (!agyMod) {
    agyMod = require('./agy')
    agyMod.configure({ userDataPath: app.getPath('userData'), store })
  }
  return agyMod
}

/**
 * 第一幀出來之後才自動接續反代，不跟開窗搶磁碟。
 */
function scheduleBackgroundServices() {
  if (backgroundStarted) return
  backgroundStarted = true
  initStore()
    .then(() => {
      if (store.get('agyEnabled') !== true) return { ok: false, error: 'DISABLED' }
      return loadAgy().then((service) => service.autoStart())
    })
    .then((result) => {
      if (result && !result.ok && result.error !== 'DISABLED') {
        console.warn('[agy] autoStart failed:', result.error)
      }
    })
    .catch((err) => console.warn('[agy] autoStart error:', err?.code || err?.message))
}

/**
 * 字幕視窗位置／大小。
 * 這個值直接餵進 `new BrowserWindow()`，來源有兩個——renderer 的 `store:set`，
 * 以及使用者可以手改的設定檔——所以寫入與讀取兩邊都要過這裡：
 * 非有限數（NaN／字串／null）會讓 Electron 建出看不見或超大的視窗。
 * x／y 保留 undefined 代表「交給系統置中」。
 * @param {unknown} raw
 * @returns {{ width: number, height: number, x: number|undefined, y: number|undefined }}
 */
function sanitizeSubtitleBounds(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const clamp = (value, fallback, min, max) => {
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, Math.round(n)))
  }
  const coord = (value) => {
    const n = Number(value)
    return Number.isFinite(n) ? Math.round(n) : undefined
  }
  return {
    width: clamp(src.width, 800, 200, 8000),
    height: clamp(src.height, 200, 80, 8000),
    x: coord(src.x),
    y: coord(src.y)
  }
}

/**
 * 初始化 electron-store（ESM 模組需要動態 import）
 */
async function initStore() {
  if (store) return store
  if (!storeReady) {
    storeReady = (async () => {
      const Store = (await import('electron-store')).default
      store = new Store()
      migrateChatSystemPrompt()
      migrateChatProviders()
      chat.setStore(store)
      bootLog('store ready')
      return store
    })()
  }
  return storeReady
}

/**
 * 一次性搬移：舊版單一 `chatSystemPrompt` → 多組 `chatPrompts` 的第一筆。
 * 搬完刪掉舊 key，之後只讀 chatPrompts / chatPromptId。
 */
function migrateChatSystemPrompt() {
  const legacy = String(store.get('chatSystemPrompt', '') || '').trim()
  if (!legacy) {
    if (store.has('chatSystemPrompt')) store.delete('chatSystemPrompt')
    return
  }
  const existing = chat.sanitizePrompts(store.get('chatPrompts', []))
  if (!existing.length) {
    const prompt = { id: 'p_legacy', name: '預設提示', content: legacy }
    store.set('chatPrompts', [prompt])
    store.set('chatPromptId', prompt.id)
    console.log('[chat] 已將舊的 chatSystemPrompt 搬移為系統提示 preset')
  }
  store.delete('chatSystemPrompt')
}

/**
 * 一次性搬移：舊版單組 `chatApiUrl`／`chatApiKey`／`chatModels` → `chatProviders` 的第一筆。
 * 寫入成功才刪舊 key，中途失敗不會兩邊都沒有。
 */
function migrateChatProviders() {
  const legacyKeys = ['chatApiUrl', 'chatApiKey', 'chatModels']
  const hasLegacy = legacyKeys.some((key) => store.has(key))
  if (!hasLegacy) return

  const existing = chat.sanitizeProviders(store.get('chatProviders', []))
  if (!existing.length) {
    const provider = chat.providerFromLegacy(
      store.get('chatApiUrl', ''),
      store.get('chatApiKey', ''),
      store.get('chatModels', [])
    )
    if (provider) {
      store.set('chatProviders', [provider])
      store.set('chatProviderId', provider.id)
      const currentModel = String(store.get('chatModelId', '') || '')
      if (!provider.models.includes(currentModel)) store.set('chatModelId', provider.models[0] || '')
      console.log('[chat] 已將舊的單組聊天設定搬移為供應商')
    }
  }
  for (const key of legacyKeys) if (store.has(key)) store.delete(key)
}

/**
 * 依主題決定視窗底色（frameless 避免淺色主題閃黑）
 * @returns {string}
 */
function mainBackgroundColor() {
  const theme = store ? store.get('theme', 'dark') : peekTheme()
  return theme === 'light' ? '#f5f5f5' : '#1a1a1a'
}

/**
 * 僅允許主視窗呼叫的 window 控制
 * @param {Electron.IpcMainInvokeEvent} event
 */
function assertMainWindowSender(event) {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  return event.sender === mainWindow.webContents
}

/**
 * 建立主視窗（frameless：標題列合併進 app header）
 */
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    title: 'VoiceInk',
    // Windows：保留 thickFrame 以支援邊緣縮放與陰影（勿關）
    thickFrame: true,
    hasShadow: true,
    transparent: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
      preload: path.join(__dirname, '../preload/preload.js')
    },
    backgroundColor: mainBackgroundColor(),
    autoHideMenuBar: true,
    show: true
  })

  // 隱藏 File/Edit/View… 系統選單列
  mainWindow.setMenu(null)

  mainWindow.once('ready-to-show', () => {
    bootLog('ready-to-show')
    scheduleBackgroundServices()
  })
  mainWindow.webContents.once('did-finish-load', () => {
    bootLog('did-finish-load')
    scheduleBackgroundServices()
  })

  // 載入頁面（先掛事件，避免 loadFile 太快把 ready-to-show 漏掉）
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  const sendMaximized = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:maximized', mainWindow.isMaximized())
    }
  }
  mainWindow.on('maximize', sendMaximized)
  mainWindow.on('unmaximize', sendMaximized)

  attachWindowSecurity(mainWindow)

  mainWindow.on('closed', () => {
    mainWindow = null
    if (subtitleWindow) {
      subtitleWindow.close()
    }
  })
}

/**
 * 禁止任意導覽／開窗；外連改系統瀏覽器
 * @param {BrowserWindow} win
 */
function attachWindowSecurity(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url)
      if (u.protocol === 'https:' || u.protocol === 'http:') {
        shell.openExternal(url).catch(() => {})
      }
    } catch { /* ignore bad url */ }
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    // 允許 dev Vite 與 file:// 本機頁；其餘擋下
    if (isDev && url.startsWith('http://localhost:5173')) return
    if (url.startsWith('file://')) return
    event.preventDefault()
  })
}

/**
 * 儲存的視窗位置是否仍落在某個螢幕的可視範圍內（外接螢幕拔除後座標會失效）
 */
function isBoundsOnScreen(bounds) {
  if (bounds.x === undefined || bounds.y === undefined) return true
  return screen.getAllDisplays().some((d) => {
    const wa = d.workArea
    return (
      bounds.x < wa.x + wa.width &&
      bounds.x + bounds.width > wa.x &&
      bounds.y < wa.y + wa.height &&
      bounds.y + bounds.height > wa.y
    )
  })
}

/**
 * 建立懸浮字幕視窗
 */
function createSubtitleWindow() {
  // 取得儲存的位置
  // 設定檔可能是舊版寫的或被手改壞，讀取時同樣要過一次校驗
  const bounds = sanitizeSubtitleBounds(store ? store.get('subtitleWindowBounds', null) : null)

  // 座標已不在任何螢幕內（拔掉外接螢幕）→ 回到置中，避免視窗開在看不見的地方
  if (!isBoundsOnScreen(bounds)) {
    bounds.x = undefined
    bounds.y = undefined
  }

  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    frame: false,
    transparent: false,
    backgroundColor: '#1a1a1a',
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, '../preload/preload.js')
    }
  })
  subtitleWindow = win

  // 強制移除選單，避免出現白色選單列
  subtitleWindow.setMenu(null)
  attachWindowSecurity(subtitleWindow)

  if (isDev) {
    subtitleWindow.loadURL('http://localhost:5173/pages/subtitle.html')
  } else {
    subtitleWindow.loadFile(path.join(__dirname, '../renderer/pages/subtitle.html'))
  }

  // 儲存視窗位置
  subtitleWindow.on('moved', () => {
    if (store && subtitleWindow) {
      const bounds = subtitleWindow.getBounds()
      store.set('subtitleWindowBounds', bounds)
    }
  })

  subtitleWindow.on('resized', () => {
    if (store && subtitleWindow) {
      const bounds = subtitleWindow.getBounds()
      store.set('subtitleWindowBounds', bounds)
    }
  })

  win.on('closed', () => {
    // subtitle:close 會先同步把 subtitleWindow 設 null；此處仍 === win 代表是 OS 層關閉
    // （Alt+F4／主視窗連帶關閉），需通知 renderer 停止擷取，否則管線在無視窗下空轉
    if (subtitleWindow !== win) return
    subtitleWindow = null
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('subtitle:closed')
    }
  })
}

// ===== IPC 處理器 =====

// 設定相關
ipcMain.handle('store:get', async (event, key, defaultValue) => {
  if (typeof key !== 'string' || !STORE_ALLOWLIST.has(key)) {
    throw new Error(`不允許的設定鍵: ${key}`)
  }
  if (!store) await initStore()
  const val = store.get(key, defaultValue)
  if (key === 'ttsVoices') return sanitizeTtsVoices(val)
  if (key === 'ttsRate') return sanitizeTtsRate(val)
  if (key === 'translator') {
    return TRANSLATOR_VALUES.has(val) ? val : (TRANSLATOR_VALUES.has(defaultValue) ? defaultValue : 'local')
  }
  if (key === 'asrEngine') {
    return ASR_ENGINE_VALUES.has(val) ? val : (ASR_ENGINE_VALUES.has(defaultValue) ? defaultValue : 'local')
  }
  if (key === 'localTranslateModel') {
    return models.isLlmKey(val) ? val : (models.isLlmKey(defaultValue) ? defaultValue : DEFAULT_LLM_KEY)
  }
  if (key === 'llmGpu') {
    return val === true
  }
  if (key === 'theme') {
    return THEME_VALUES.has(val) ? val : (THEME_VALUES.has(defaultValue) ? defaultValue : 'dark')
  }
  if (key === 'chatProviders') return chat.sanitizeProviders(val)
  if (key === 'chatProviderId') {
    const list = chat.sanitizeProviders(store.get('chatProviders', []))
    return list.some((p) => p.id === val) ? val : (list[0]?.id || '')
  }
  if (key === 'chatModelId') {
    // 只認「目前這個供應商」的清單——跨供應商沿用會拿 A 的模型名打 B 的端點
    const models = chat.readProvider()?.models || []
    return models.includes(val) ? val : (models[0] || '')
  }
  if (key === 'chatPrompts') return chat.sanitizePrompts(val)
  if (key === 'chatPromptId') {
    const list = chat.sanitizePrompts(store.get('chatPrompts', []))
    return list.some((p) => p.id === val) ? val : ''
  }
  if (key === 'chatThinking') return val === true
  if (key === 'asrThreads') return sanitizeAsrThreads(val)
  return val
})

ipcMain.handle('store:set', async (event, key, value) => {
  if (typeof key !== 'string' || !STORE_ALLOWLIST.has(key)) {
    throw new Error(`不允許的設定鍵: ${key}`)
  }
  if (!store) await initStore()
  // ttsVoices 深度校驗（五語 + allowlist shortName）
  if (key === 'ttsVoices') {
    store.set(key, sanitizeTtsVoices(value))
    return true
  }
  if (key === 'ttsRate') {
    store.set(key, sanitizeTtsRate(value))
    return true
  }
  if (key === 'translator') {
    const t = TRANSLATOR_VALUES.has(value) ? value : 'local'
    store.set(key, t)
    return true
  }
  if (key === 'asrEngine') {
    const e = ASR_ENGINE_VALUES.has(value) ? value : 'local'
    store.set(key, e)
    return true
  }
  if (key === 'localTranslateModel') {
    store.set(key, models.isLlmKey(value) ? value : DEFAULT_LLM_KEY)
    return true
  }
  if (key === 'llmGpu') {
    // 硬體不符時強制 false
    if (value === true) {
      const cap = await loadGpu().detectGpuCapability()
      store.set(key, !!cap.ok)
    } else {
      store.set(key, false)
    }
    return true
  }
  if (key === 'theme') {
    const t = THEME_VALUES.has(value) ? value : 'dark'
    store.set(key, t)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor(t === 'light' ? '#f5f5f5' : '#1a1a1a')
    }
    return true
  }
  if (key === 'asrApiUrl' || key === 'apiUrl') {
    store.set(key, typeof value === 'string' ? value.trim() : value)
    return true
  }
  if (key === 'asrModelId' || key === 'modelId') {
    store.set(key, typeof value === 'string' ? value.trim() : value)
    return true
  }
  if (key === 'chatProviders') {
    const list = chat.sanitizeProviders(value)
    store.set(key, list)
    // 供應商可能被刪掉或改名 → 選取與模型都要跟著收斂，否則聊天請求會被自己的驗證擋下
    const providerId = String(store.get('chatProviderId', '') || '')
    const active = list.find((p) => p.id === providerId) || list[0] || null
    store.set('chatProviderId', active?.id || '')
    const model = String(store.get('chatModelId', '') || '')
    if (!active?.models.includes(model)) store.set('chatModelId', active?.models[0] || '')
    return true
  }
  if (key === 'chatProviderId') {
    const list = chat.sanitizeProviders(store.get('chatProviders', []))
    const active = list.find((p) => p.id === value) || list[0] || null
    store.set(key, active?.id || '')
    // 換供應商就換模型池，舊選擇不再有效
    const model = String(store.get('chatModelId', '') || '')
    if (!active?.models.includes(model)) store.set('chatModelId', active?.models[0] || '')
    return true
  }
  if (key === 'chatModelId') {
    const models = chat.readProvider()?.models || []
    store.set(key, models.includes(value) ? value : (models[0] || ''))
    return true
  }
  if (key === 'chatPrompts') {
    const list = chat.sanitizePrompts(value)
    store.set(key, list)
    // 清單變動後選用的提示可能已被刪掉 → 收斂成「不使用」
    if (!list.some((p) => p.id === store.get('chatPromptId', ''))) store.set('chatPromptId', '')
    return true
  }
  if (key === 'chatPromptId') {
    const list = chat.sanitizePrompts(store.get('chatPrompts', []))
    store.set(key, list.some((p) => p.id === value) ? value : '')
    return true
  }
  if (key === 'chatThinking') {
    store.set(key, value === true)
    return true
  }
  if (key === 'asrThreads') {
    store.set(key, sanitizeAsrThreads(value))
    return true
  }
  if (key === 'subtitleWindowBounds') {
    store.set(key, sanitizeSubtitleBounds(value))
    return true
  }
  store.set(key, value)
  return true
})

// ===== 主視窗控制（frameless）=====
ipcMain.handle('window:minimize', (event) => {
  if (!assertMainWindowSender(event)) return false
  mainWindow.minimize()
  return true
})

ipcMain.handle('window:toggleMaximize', (event) => {
  if (!assertMainWindowSender(event)) return false
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  else mainWindow.maximize()
  return mainWindow.isMaximized()
})

ipcMain.handle('window:close', (event) => {
  if (!assertMainWindowSender(event)) return false
  mainWindow.close()
  return true
})

ipcMain.handle('window:isMaximized', (event) => {
  if (!assertMainWindowSender(event)) return false
  return mainWindow.isMaximized()
})

// GPU 能力（設定頁）
ipcMain.handle('system:gpuCapability', async () => {
  return loadGpu().detectGpuCapability()
})

ipcMain.handle('system:refreshGpuCapability', async () => {
  loadGpu().clearGpuCapabilityCache()
  return loadGpu().detectGpuCapability()
})

/**
 * 自動安裝 CUDA Runtime／Toolkit（UAC 提升）
 */
ipcMain.handle('system:installCudaEnv', async (event) => {
  if (!assertMainWindowSender(event)) {
    return { ok: false, message: '僅主視窗可安裝' }
  }
  const send = (p) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('system:cudaInstallProgress', p)
    }
  }
  try {
    const result = await loadCudaEnv().installCudaEnv(send)
    loadGpu().clearGpuCapabilityCache()
    const cap = await loadGpu().detectGpuCapability()
    return { ...result, capability: cap }
  } catch (e) {
    return { ok: false, message: e.message || String(e) }
  }
})

ipcMain.handle('system:openCudaDownloadPage', async () => {
  return loadCudaEnv().openCudaDownloadPage()
})

ipcMain.handle('llm:loadInfo', () => loadLocalLlm().getLoadInfo())

// 字幕視窗控制
ipcMain.handle('subtitle:show', () => {
  if (!subtitleWindow) {
    createSubtitleWindow()
  } else {
    subtitleWindow.show()
  }
  return true
})

ipcMain.handle('subtitle:hide', () => {
  if (subtitleWindow) {
    subtitleWindow.hide()
  }
  return true
})

ipcMain.handle('subtitle:close', () => {
  if (subtitleWindow) {
    subtitleWindow.close()
    subtitleWindow = null
  }
  // 通知主視窗字幕已關閉，讓 UI 同步更新
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('subtitle:closed')
  }
  return true
})

ipcMain.handle('subtitle:update', (event, text) => {
  if (subtitleWindow && !subtitleWindow.isDestroyed()) {
    subtitleWindow.webContents.send('subtitle:text', text)
  }
  return true
})

ipcMain.handle('subtitle:setOpacity', (event, value) => {
  if (subtitleWindow && !subtitleWindow.isDestroyed()) {
    const n = Number(value)
    const opacity = Number.isFinite(n) ? Math.min(1, Math.max(0.3, n)) : 1
    subtitleWindow.setOpacity(opacity)
  }
  return true
})

// ===== 本地模型相關 =====

ipcMain.handle('models:status', () => models.status())

ipcMain.handle('models:download', async (event, key) => {
  return models.download(key, (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('models:progress', progress)
    }
  })
})

ipcMain.handle('models:cancel', (event, key) => models.cancelDownload(key))

ipcMain.handle('models:delete', (event, key) => models.remove(key))

ipcMain.handle('models:openFolder', (event, key) => models.openFolder(key))

ipcMain.handle('localAsr:transcribe', async (event, req) => {
  if (!store) await initStore()
  const engine = store.get('asrEngine', 'local')
  if (engine === 'cloud') {
    return loadCloudAsr().transcribeSamples(req || {}, store)
  }
  return loadLocalAsr().transcribe(req)
})

/** 長檔案串流轉錄（ffmpeg 切段，支援 ≥2h / ≥100MB；雲端走 mp3 segment） */
ipcMain.handle('localAsr:transcribeFile', async (event, req) => {
  if (!store) await initStore()
  const engine = store.get('asrEngine', 'local')
  const onProgress = (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('localAsr:fileProgress', progress)
    }
  }
  if (engine === 'cloud') {
    return loadFileTranscribe().transcribeFileCloud({ ...(req || {}), store }, onProgress)
  }
  return loadFileTranscribe().transcribeFile(req || {}, onProgress)
})

ipcMain.handle('localAsr:cancelFileTranscribe', () => loadFileTranscribe().cancel())

ipcMain.handle('translate', async (event, text, targetLang, opts) => {
  if (!store) await initStore()
  if (typeof text !== 'string') throw new Error('翻譯文字必須是字串')
  const trimmed = text.trim()
  if (!trimmed) return ''
  if (trimmed.length > MAX_TRANSLATE_CHARS) {
    throw new Error(`文字過長（上限 ${MAX_TRANSLATE_CHARS} 字），請縮短後再翻譯`)
  }
  const lang = typeof targetLang === 'string' ? targetLang : 'zh-TW'
  if (!TRANSLATE_TARGET_LANGS.has(lang)) {
    throw new Error(`不支援的目標語言: ${lang}`)
  }
  return loadLocalLlm().translate(store, trimmed, lang, opts || {})
})

// ===== Edge TTS =====
ipcMain.handle('tts:listVoices', () => listVoices())

ipcMain.handle('tts:synthesize', async (event, req) => {
  if (!store) await initStore()
  const text = typeof req?.text === 'string' ? req.text : ''
  const lang = typeof req?.lang === 'string' ? req.lang : 'zh-TW'
  const safeLang = Object.prototype.hasOwnProperty.call(DEFAULT_TTS_VOICES, lang) ? lang : 'en'
  const tts = loadEdgeTts()
  const voice = tts.resolveVoice(store, safeLang)
  const rate = tts.formatTtsRate(tts.resolveTtsRate(store))
  try {
    return await tts.synthesize({
      text,
      voice,
      rate,
      chunkIndex: req?.chunkIndex
    })
  } catch (err) {
    const msg = err?.message || String(err)
    const e = new Error(msg)
    e.code = err?.code || 'REJECTED'
    throw e
  }
})

ipcMain.handle('tts:cancel', () => {
  loadEdgeTts().cancelAll()
  return true
})

// 引擎生命週期：acquire / release / status
ipcMain.handle('engine:acquire', async (event, owner, needs) => {
  return loadEngine().acquire(owner, needs || {})
})

ipcMain.handle('engine:release', async (event, owner) => {
  return loadEngine().release(owner)
})

ipcMain.handle('engine:status', () => loadEngine().status())

// ===== 聊天 =====
// 會話內容與 model 都由 main 擁有；renderer 只給 conversationId 與文字
ipcMain.handle('chat:list', () => chatStore.list())
ipcMain.handle('chat:get', (event, id) => chatStore.get(id))
ipcMain.handle('chat:create', () => chatStore.create())
ipcMain.handle('chat:delete', (event, id) => chatStore.remove(id))
ipcMain.handle('chat:rename', (event, id, title) => chatStore.rename(id, title))
ipcMain.handle('chat:reorder', (event, ids) => chatStore.reorder(ids))

/**
 * 掃描某個供應商的模型清單。
 *
 * renderer 只給 providerId，網址與金鑰一律由 main 從 store 取——
 * 讓 renderer 指定 URL 等於把 App 變成「幫你打任意網址」的跳板。
 */
ipcMain.handle('chat:scanModels', async (event, providerId) => {
  if (!store) await initStore()
  const providers = chat.sanitizeProviders(store.get('chatProviders', []))
  const provider = providers.find((p) => p.id === providerId)
  if (!provider) return { ok: false, code: 'NO_PROVIDER', error: '找不到這個供應商' }
  return loadChatModels().fetchModels({ apiUrl: provider.apiUrl, apiKey: provider.apiKey })
})
ipcMain.handle('chat:send', async (event, req) => {
  if (!store) await initStore()
  return chat.send(req || {}, event.sender)
})
ipcMain.handle('chat:abort', (event, reqId) => chat.abort(reqId))
// 圖片實體存在 <userData>/chat-images/；renderer 只拿得到檔名，讀取由 main 驗證
ipcMain.handle('chat:image', (event, name) => loadChatImages().toDataUrl(name))

// ===== 額度儀錶板 =====
// URL、憑證路徑、SQL 與 provider 清單固定在 main；renderer 只能觸發整體同步。
registerUsageIpc({
  ipcMain,
  service: {
    load: (...args) => loadUsage().load(...args),
    sync: (...args) => loadUsage().sync(...args),
    saveSettings: (...args) => loadUsage().saveSettings(...args),
    getDiagnostics: (...args) => loadUsage().getDiagnostics(...args),
    publicError: (error) => loadUsage().publicError(error)
  },
  isMainSender: assertMainWindowSender
})

// ===== AGY 反向代理 =====
// 憑證、上游 URL、project id 與 API key 全在 main；agy* 設定刻意不進 STORE_ALLOWLIST，
// renderer 只能透過 agy:* 操作，沒有任何路徑能直接改掉金鑰。
registerAgyIpc({
  ipcMain,
  service: {
    status: async (...args) => (await loadAgy()).status(...args),
    start: async (...args) => (await loadAgy()).start(...args),
    stop: async (...args) => (await loadAgy()).stop(...args),
    saveSettings: async (...args) => (await loadAgy()).saveSettings(...args),
    regenerateApiKey: async (...args) => (await loadAgy()).regenerateApiKey(...args),
    getLogs: async (...args) => (await loadAgy()).getLogs(...args),
    getStats: async (...args) => (await loadAgy()).getStats(...args),
    listModels: async (...args) => (await loadAgy()).listModels(...args),
    clearLogs: async (...args) => (await loadAgy()).clearLogs(...args),
    selfTest: async (...args) => (await loadAgy()).selfTest(...args)
  },
  isMainSender: assertMainWindowSender
})

// 設定系統音訊擷取的媒體請求處理器
app.whenReady().then(() => {
  bootLog('whenReady')
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] })
      .then((sources) => {
        if (!sources || sources.length === 0) {
          // 拒絕：無可用畫面來源（callback 空物件）
          callback({})
          return
        }
        callback({ video: sources[0], audio: 'loopback' })
      })
      .catch((err) => {
        console.error('[displayMedia] getSources failed:', err)
        callback({})
      })
  }, { useSystemPicker: false })

  createMainWindow()
  bootLog('window created')
  initStore().catch((err) => console.error('[store] init failed:', err?.message || err))
})

// 關閉前同步卸載模型，再真正退出
app.on('before-quit', (e) => {
  if (isQuitting) {
    // 卸載進行中再次 quit：繼續擋，只允許 app.exit 那條路結束
    e.preventDefault()
    return
  }
  e.preventDefault()
  isQuitting = true
  // 反代先關：留著監聽的 socket 會讓下次啟動撞到 EADDRINUSE
  const stopAgy = agyMod ? agyMod.shutdown() : Promise.resolve()
  stopAgy
    .catch((err) => console.error('[agy] shutdown on quit failed:', err))
    .then(() => {
      if (!require.cache[require.resolve('./engine')]) return
      return loadEngine().unloadAll()
    })
    .catch((err) => console.error('[engine] unloadAll on quit failed:', err))
    .finally(() => {
      app.exit(0)
    })
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('activate', () => {
  if (mainWindow === null) {
    createMainWindow()
  }
})

