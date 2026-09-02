const {
  app, BrowserWindow, ipcMain, session, desktopCapturer, screen, shell, dialog,
  Menu, Tray, nativeImage
} = require('electron')
const path = require('path')
const fs = require('fs')
const models = require('./models')
const chat = require('./chat')
const modelScope = require('./model-scope')
const chatStore = require('./chat-store')
const { sanitizeTtsVoices, DEFAULT_TTS_VOICES, VOICES_BY_LANG, listVoices } = require('./tts-voices')

/** 設定頁試聽用的範例句（main 的固定表，renderer 不送文字） */
const TTS_PREVIEW_TEXT = Object.freeze({
  'zh-TW': '你好，這是語音試聽，聽起來還可以嗎？',
  'zh-CN': '你好，这是语音试听，听起来还可以吗？',
  en: 'Hi there, this is a voice preview. How does it sound?',
  ja: 'こんにちは。これは音声のプレビューです。',
  ko: '안녕하세요. 이것은 음성 미리 듣기입니다.'
})
const { registerUsageIpc } = require('./usage/ipc')
const { registerAgyIpc } = require('./agy/ipc')
const { registerTerminalIpc } = require('./terminal/ipc')
const { registerSysmonIpc } = require('./sysmon/ipc')
const { registerHfModelsIpc } = require('./hfmodels/ipc')
const { registerCcSwitchIpc } = require('./ccswitch/ipc')
const { registerCodeUsageIpc } = require('./codeusage/ipc')
const { registerDictationIpc } = require('./dictation/ipc')
const dictationHud = require('./dictation/hud')

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

/** 本地 ASR 門面：依各頁自己的 ASR 選擇分流 sherpa（CPU）／llama-server（GPU） */
const loadLocalAsr = lazyLoad('./asr-select')
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
let dictationMod = null
let terminalMod = null
let sysmonMod = null
let ccSwitchMod = null
let codeUsageMod = null
let hfModelsMod = null
let backgroundStarted = false
/** @type {Promise<object>|null} */
let storeReady = null

// 主視窗
let mainWindow = null
// 字幕視窗
let subtitleWindow = null
// 系統匣圖示（第一次縮到背景才建立）
let tray = null
// 設定儲存實例（延遲初始化）
let store = null
/** 正在執行 before-quit 卸載 */
let isQuitting = false

// 開發模式判斷
const isDev = !app.isPackaged

dictationHud.configure({ isDev, preload: path.join(__dirname, '../preload/preload.js') })

// 開機自啟動時帶的旗標：靜靜地縮在系統匣，不要跳一扇窗出來
const HIDDEN_FLAG = '--hidden'
const startHidden = process.argv.includes(HIDDEN_FLAG)

/**
 * 只准跑一份。
 *
 * 常駐背景之後這不是「保險」而是必要條件：視窗藏起來時再點一次捷徑，
 * 第二份會用同一個埠 autoStart 反代（EADDRINUSE），還會跟第一份搶
 * chats.json／usage.json／agy-logs.db。第二份改成把既有視窗叫出來就好。
 */
const hasInstanceLock = app.requestSingleInstanceLock()
// 用 app.quit() 而不是 app.exit()：exit 是立刻砍掉自己，會來不及讓「我來過了」這個
// 通知送達第一份，症狀是藏在系統匣時再點捷徑有時叫不出視窗（實測時好時壞）。
if (!hasInstanceLock) app.quit()
app.on('second-instance', () => showMainWindow())

/** electron-store 允許的 key（防任意讀寫／XSS 後改 apiUrl 外洩 key） */
const STORE_ALLOWLIST = new Set([
  'translator',
  'captionDisplayMode',
  'asrEngine',
  'asrApiUrl',
  'asrApiKey',
  'asrModelId',
  // 雲端 ASR 多組設定（可切換）；asrApiUrl／asrApiKey／asrModelId 是搬移前的舊 key，
  // readConfig 的保底還會讀，所以不刪
  'asrClouds',
  'asrCloudId',
  'theme',
  'closeToTray',
  'subtitleFontScale',
  'subtitleOpacity',
  'subtitleWindowBounds',
  'ttsVoices',
  'ttsRate',
  'localTranslateModel',
  'asrModelKey',
  'llmGpu',
  'chatProviders',
  'chatProviderId',
  'chatModelId',
  'translateProviderId',
  'translateModelId',
  'chatPrompts',
  'chatPromptId',
  'chatThinking',
  'sysmonInterval',
  'sysmonSort',
  'sysmonSensors',
  'dictationEnabled',
  'dictationLang',
  // HF模型：資料夾可自選（大模型放不進 C 碟）、同時載入幾顆、開 App 要不要自動起 router。
  // **`hfToken` 刻意不在這裡**：它是機密，只走 `hfmodels:setToken`，renderer 讀不到
  'hfModelsDir',
  'hfModelsMax',
  'hfAutoStart',
  // 三個子分頁各自的模型選擇（值的格式見 model-scope.js）
  'fileAsr',
  'fileLlm',
  'liveAsr',
  'liveLlm',
  'dictationAsr',
  'dictationLlm'
])

const TRANSLATOR_VALUES = new Set(['cloud', 'local'])
const ASR_ENGINE_VALUES = new Set(['local', 'cloud'])
const THEME_VALUES = new Set(['dark', 'light'])

const TRANSLATE_TARGET_LANGS = new Set(['zh-TW', 'zh-CN', 'en', 'ja', 'ko'])
const MAX_TRANSLATE_CHARS = 1500
const DEFAULT_LLM_KEY = 'linguaforge08q4'
const DEFAULT_ASR_MODEL_KEY = 'qwen3asr'
/** 已下架的模型 key → 接替者（讀到舊值就當成新值，不必寫回）；表在 models.js */
const RETIRED_MODEL_KEYS = models.RETIRED_MODEL_KEYS

/** 語音輸入的整理語言（跟翻譯的目標語言同一組） */
const DICTATION_LANGS = new Set(['zh-TW', 'zh-CN', 'en', 'ja', 'ko'])

/**
 * 某一頁的 LLM 選擇：''（不使用）／`local:<llm key>`／`cloud:<供應商 id>:<模型 id>`。
 *
 * 跟聊天／翻譯同一個規矩——只認「目前真的存在」的供應商與模型，
 * 不然刪掉一組供應商之後，這裡還會拿舊的 id 去打別人的端點。
 * @param {import('./model-scope').Scope} scope
 * @param {unknown} raw
 * @returns {string}
 */
function sanitizeScopedLlm(scope, raw) {
  // `allProviders` 才看得到「本機模型」那一筆（router 跑著時才有）：
  // 用 `sanitizeProviders` 的話，三個子分頁選了本機模型會在下一次收斂時被清掉
  return modelScope.sanitizeLlm(
    raw,
    chat.allProviders(),
    modelScope.LLM_OPTIONAL[scope]
  )
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
 * 語音辨識的共用入口。scope 決定讀哪一頁的選擇（三頁各存一份），
 * 本地再由 `asr-select` 依那一頁選的模型分流。scope 由呼叫點決定，
 * **不接受 renderer 傳進來**。
 * @param {import('./model-scope').Scope} scope
 * @param {{ samples: unknown, sampleRate?: number, lang?: string }} req
 * @returns {Promise<string>}
 */
async function transcribeSamples(scope, req) {
  if (!store) await initStore()
  if (modelScope.readAsr(store, scope).engine === 'cloud') {
    return loadCloudAsr().transcribeSamples(req || {}, store, scope)
  }
  return loadLocalAsr().transcribe(scope, req)
}

/**
 * 第一次用到語音輸入才載模組（會 require 低階鍵盤 hook 的原生模組）。
 * @returns {Promise<object>}
 */
async function loadDictation() {
  await initStore()
  if (!dictationMod) {
    dictationMod = require('./dictation')
    dictationMod.setStore(store)
    dictationMod.configure({
      emit: (payload) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dictation:event', payload)
      },
      transcribe: (req) => transcribeSamples('dictation', req)
    })
  }
  return dictationMod
}

/**
 * 第一次用到終端機才載模組（node-pty 是原生模組，不該擋啟動）。
 * @returns {object}
 */
function loadTerminal() {
  if (!terminalMod) {
    terminalMod = require('./terminal/pty')
    terminalMod.setEmitter((channel, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
    })
  }
  return terminalMod
}

/**
 * 第一次進 Claude Code 頁才載模組（會讀使用者家目錄的設定檔，不該擋啟動）。
 * @returns {object}
 */
function loadCcSwitch() {
  if (!ccSwitchMod) {
    ccSwitchMod = require('./ccswitch')
    ccSwitchMod.configure({
      userDataPath: app.getPath('userData'),
      // OAuth 登入要把使用者帶去系統瀏覽器；只放行我們自己組出來的 https 授權網址
      openExternal: (url) => {
        if (typeof url === 'string' && url.startsWith('https://')) void shell.openExternal(url)
      }
    })
  }
  return ccSwitchMod
}

/**
 * 第一次看用量統計才載模組（會掃 GB 等級的本機 session 記錄，不該擋啟動）。
 * @returns {object}
 */
function loadCodeUsage() {
  if (!codeUsageMod) {
    codeUsageMod = require('./codeusage')
    codeUsageMod.configure({ userDataPath: app.getPath('userData') })
  }
  return codeUsageMod
}

/**
 * 第一次進系統監控頁才載模組（會開 PowerShell 與 nvidia-smi 子程序，不該擋啟動）。
 * @returns {object}
 */
function loadSysmon() {
  if (!sysmonMod) {
    sysmonMod = require('./sysmon').createSysmonService()
    sysmonMod.setEmitter((payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('sysmon:event', payload)
    })
  }
  // 每次都重帶：風扇設定要 store，而 loadSysmon 可能比 initStore 早發生
  sysmonMod.configure({
    store: store || undefined,
    userDataPath: app.getPath('userData'),
    packaged: app.isPackaged
  })
  return sysmonMod
}

/**
 * 「HF模型」服務。第一次用到才 require——它會拉進 llama.cpp router 那一整串。
 * @returns {object}
 */
function loadHfModels() {
  if (!hfModelsMod) {
    hfModelsMod = require('./hfmodels')
    hfModelsMod.init({
      userDataPath: app.getPath('userData'),
      store: store || undefined,
      onEvent: (payload) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('hfmodels:event', payload)
      }
    })
  }
  // store 可能比第一次呼叫還晚好（IPC 進得來的時間點不保證）
  if (store) hfModelsMod.setStore(store)
  return hfModelsMod
}

/**
 * 讓聊天看得到「本機模型」。
 *
 * **只在 router 已經跑著時才回東西**：`localSource` 不可以自己去啟動 router，
 * 那會讓「打開聊天頁」變成「載入一顆 20GB 的模型」。真的要用時
 * `chat.send` 會走 `ensureLocalModel` 把它叫起來。
 */
function wireChatLocalProvider() {
  chat.setLocalSource(
    () => {
      if (!hfModelsMod) return null
      const endpoint = hfModelsMod.endpoint()
      if (!endpoint) return null
      return { ...endpoint, models: hfLocalModelIds }
    },
    async (modelId) => {
      try {
        await loadHfModels().ensureRuntime()
        return await loadHfModels().loadModel(modelId)
      } catch {
        return false
      }
    }
  )
}

/**
 * router 現在有哪幾顆模型可以用（含還沒載入的——選了才載）。
 * 用快取而不是每次去問：`chat.readConfig` 是同步的，而問 router 要走 HTTP。
 * @type {string[]}
 */
let hfLocalModelIds = []

/**
 * @returns {Promise<string[]>}
 */
async function refreshHfLocalModels() {
  if (!hfModelsMod || !hfModelsMod.runtimeStatus().running) {
    hfLocalModelIds = []
    return hfLocalModelIds
  }
  try {
    const rows = await hfModelsMod.refreshModels()
    hfLocalModelIds = rows.map((row) => String(row?.id || '')).filter(Boolean)
  } catch {
    hfLocalModelIds = []
  }
  return hfLocalModelIds
}

/**
 * 第一幀出來之後才自動接續反代，不跟開窗搶磁碟。
 */
function scheduleBackgroundServices() {
  if (backgroundStarted) return
  backgroundStarted = true
  initStore()
    .then(() => {
      // 語音輸入的熱鍵要在背景也活著（使用者多半是在別的程式裡按右 Alt）
      if (store.get('dictationEnabled') === true) {
        loadDictation()
          .then((d) => {
            // refresh 是 async（原生熱鍵 sidecar 要等它回 READY），失敗只記錄不影響其他功能
            void d.refresh().catch((err) => console.warn('[dictation] refresh failed:', err?.message || err))
            // 指示器視窗先建好（維持隱藏）：第一次按右 Alt 才不會先看到一扇空白視窗
            dictationHud.warm()
          })
          .catch((err) => console.warn('[dictation] autoStart failed:', err?.message || err))
      }
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
      wireChatLocalProvider()
      migrateTranslateProvider()
      migrateAsrClouds(await loadCloudAsr())
      // 三個子分頁各自的模型選擇：舊版只有一組全域設定，第一次啟動時拿它當起點
      modelScope.seedFromLegacy(store)
      // 語音辨識執行緒的選項已移除（一律「自動」）：舊值留著會讓 sherpa 永遠鎖在
      // 使用者當年隨手選的數字，而且畫面上再也沒有地方看得到
      if (store.has('asrThreads')) store.delete('asrThreads')
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
 * 一次性搬移：舊版獨立的雲端翻譯設定（`apiUrl`／`apiKey`／`modelId`）
 * → `chatProviders` 裡的一組。翻譯與聊天都是 OpenAI 相容的 chat completions，
 * 沒有理由讓同一組網址與金鑰在設定頁出現兩次。
 *
 * 網址與金鑰都一樣的供應商已經存在就直接沿用，不重複建一組。
 */
function migrateTranslateProvider() {
  const legacyKeys = ['apiUrl', 'apiKey', 'modelId']
  if (!legacyKeys.some((key) => store.has(key))) return

  const apiUrl = String(store.get('apiUrl', '') || '').trim()
  const apiKey = String(store.get('apiKey', '') || '').trim()
  const modelId = String(store.get('modelId', '') || '').trim()

  if (apiKey && /^https?:\/\//i.test(apiUrl)) {
    const providers = chat.sanitizeProviders(store.get('chatProviders', []))
    let target = providers.find((p) => p.apiUrl === apiUrl && p.apiKey === apiKey)
    if (!target) {
      target = { id: 'p_legacy_tr', name: '翻譯', apiUrl, apiKey, models: [], imageModels: [] }
      providers.push(target)
    }
    if (modelId && !target.models.includes(modelId)) target.models.push(modelId)
    const list = chat.sanitizeProviders(providers)
    store.set('chatProviders', list)
    const saved = list.find((p) => p.id === target.id) || list[0]
    if (saved) {
      store.set('translateProviderId', saved.id)
      store.set('translateModelId', saved.models.includes(modelId) ? modelId : (saved.models[0] || ''))
    }
    console.log('[translate] 已將舊的雲端翻譯設定併入聊天供應商清單')
  }
  for (const key of legacyKeys) if (store.has(key)) store.delete(key)
}

/**
 * 雲端 ASR 多組設定的起點：`asrClouds` 還沒有值時，把舊的單組
 * （asrApiUrl／asrApiKey／asrModelId）搬成「預設」那筆。舊 key **不刪**——
 * readConfig 對 asrClouds 空清單仍會退回舊 key 保底（手改設定檔、測試 mock 都靠它），
 * 而三個字串留在設定檔的成本是零。
 */
function migrateAsrClouds(asrCloudMod) {
  const existing = asrCloudMod.sanitizeAsrClouds(store.get('asrClouds', []))
  if (existing.length) {
    // 已經有清單了，但可能還是舊形狀（單一 `modelId`）。sanitize 會把它讀成只有一顆的
    // `models` 陣列，這裡寫回去——不寫的話 renderer 直接讀 store 會看到沒有 models 的列，
    // 功能頁的雲端選項就整個不見了（實測踩過）
    store.set('asrClouds', existing)
    return
  }
  const seed = asrCloudMod.asrCloudsFromLegacy(
    store.get('asrApiUrl', ''),
    store.get('asrApiKey', ''),
    store.get('asrModelId', '')
  )
  if (!seed.length) return
  store.set('asrClouds', seed)
  store.set('asrCloudId', seed[0].id)
}

/**
 * 目前翻譯供應商的模型清單（`translateProviderId` 失效時退回第一組）
 * @returns {string[]}
 */
function translateProviderModels() {
  const list = chat.allProviders()
  const wanted = String(store.get('translateProviderId', '') || '')
  return (list.find((p) => p.id === wanted) || list[0])?.models || []
}

/**
 * 供應商清單變動後把「選了哪一組／哪一顆」收斂回合法值
 * @param {Array<{ id: string, models: string[] }>} list
 * @param {string} providerKey
 * @param {string} modelKey
 */
function reconcileProviderSelection(list, providerKey, modelKey) {
  const wanted = String(store.get(providerKey, '') || '')
  // 選著「本機模型」的時候不要動它：那一筆只有 router 跑著才在清單裡，
  // 收斂掉的話「編輯任何一組雲端供應商」就會順手把使用者的本機模型選擇改掉
  if (wanted === chat.LOCAL_PROVIDER_ID) return
  const active = list.find((p) => p.id === wanted) || list[0] || null
  store.set(providerKey, active?.id || '')
  const model = String(store.get(modelKey, '') || '')
  if (!active?.models.includes(model)) store.set(modelKey, active?.models[0] || '')
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

/** 關視窗要不要留在背景（反代不中斷）。預設開，隨時可在設定關掉。 */
function closeToTrayEnabled() {
  return store ? store.get('closeToTray', true) === true : true
}

/** 把主視窗叫回前景；被關掉過就重建 */
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/**
 * 系統匣圖示。第一次縮到背景才建立——沒有常駐需求時不該多一顆圖示。
 * 視窗藏起來後，這是唯一能叫回來或真的結束的入口，所以兩個項目都必須有。
 */
function ensureTray() {
  if (tray) return
  const icon = nativeImage.createFromPath(path.join(__dirname, '../../assets/icon.ico'))
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('VoiceInk（背景執行中）')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '顯示 VoiceInk', click: showMainWindow },
    { type: 'separator' },
    { label: '結束 VoiceInk', click: () => app.quit() }
  ]))
  tray.on('click', showMainWindow)
  tray.on('double-click', showMainWindow)
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
    show: !startHidden
  })
  if (startHidden) ensureTray()

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

  // 關視窗 ≠ 結束：藏起來讓 AGY 反代繼續服務，真正的結束走系統匣選單。
  // isQuitting 這條一定要留——before-quit 會走到 app.exit()，但 app.quit() 途中
  // 若還攔著關窗，就變成永遠關不掉。
  mainWindow.on('close', (event) => {
    if (isQuitting || !closeToTrayEnabled()) return
    event.preventDefault()
    ensureTray()
    mainWindow.hide()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    if (subtitleWindow) {
      subtitleWindow.close()
    }
    // 錄音在主視窗那一側，主視窗沒了就不可能還在錄——指示器留著只會浮在桌面上
    dictationHud.close()
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
    const migrated = RETIRED_MODEL_KEYS[val] || val
    return models.isLlmKey(migrated)
      ? migrated
      : (models.isLlmKey(defaultValue) ? defaultValue : DEFAULT_LLM_KEY)
  }
  if (key === 'asrModelKey') {
    return models.isAsrKey(val) ? val : DEFAULT_ASR_MODEL_KEY
  }
  if (key === 'llmGpu') {
    return val === true
  }
  if (key === 'theme') {
    return THEME_VALUES.has(val) ? val : (THEME_VALUES.has(defaultValue) ? defaultValue : 'dark')
  }
  if (key === 'chatProviders') return chat.sanitizeProviders(val)
  if (key === 'chatProviderId') {
    // 「本機模型」永遠算合法：它只有在 router 跑著時才出現在清單裡，
    // 用清單判斷的話「關掉 router → 選擇被改成別家 → 重開也回不來」
    if (val === chat.LOCAL_PROVIDER_ID) return val
    const list = chat.sanitizeProviders(store.get('chatProviders', []))
    return list.some((p) => p.id === val) ? val : (list[0]?.id || '')
  }
  if (key === 'chatModelId') {
    // 只認「目前這個供應商」的清單——跨供應商沿用會拿 A 的模型名打 B 的端點
    const models = chat.readProvider()?.models || []
    return models.includes(val) ? val : (models[0] || '')
  }
  if (key === 'translateProviderId') {
    if (val === chat.LOCAL_PROVIDER_ID) return val
    const list = chat.sanitizeProviders(store.get('chatProviders', []))
    return list.some((p) => p.id === val) ? val : (list[0]?.id || '')
  }
  if (key === 'translateModelId') {
    const models = translateProviderModels()
    return models.includes(val) ? val : (models[0] || '')
  }
  if (key === 'chatPrompts') return chat.sanitizePrompts(val)
  if (key === 'chatPromptId') {
    const list = chat.sanitizePrompts(store.get('chatPrompts', []))
    return list.some((p) => p.id === val) ? val : ''
  }
  if (key === 'chatThinking') return val === true
  if (key === 'dictationEnabled') return val === true
  if (key === 'dictationLang') return DICTATION_LANGS.has(val) ? val : 'zh-TW'
  if (key === 'fileAsr' || key === 'liveAsr' || key === 'dictationAsr') {
    // 帶著雲端 ASR 設定清單去驗：不帶的話 `cloud:<設定>:<模型>` 會被當成不認得而降級
    return modelScope.sanitizeAsr(val, modelScope.cloudsOf(store))
  }
  if (key === 'fileLlm') return sanitizeScopedLlm('file', val)
  if (key === 'liveLlm') return sanitizeScopedLlm('live', val)
  if (key === 'dictationLlm') return sanitizeScopedLlm('dictation', val)
  // closeToTray 預設開：使用者要的就是「關掉視窗反代不斷」，沒設定過時不該退回關閉
  if (key === 'closeToTray') return val !== false
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
    const migrated = RETIRED_MODEL_KEYS[value] || value
    store.set(key, models.isLlmKey(migrated) ? migrated : DEFAULT_LLM_KEY)
    return true
  }
  if (key === 'asrModelKey') {
    store.set(key, models.isAsrKey(value) ? value : DEFAULT_ASR_MODEL_KEY)
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
  if (key === 'asrApiUrl') {
    store.set(key, typeof value === 'string' ? value.trim() : value)
    return true
  }
  if (key === 'asrModelId') {
    store.set(key, typeof value === 'string' ? value.trim() : value)
    return true
  }
  if (key === 'asrClouds') {
    const cloudAsr = await loadCloudAsr()
    const list = cloudAsr.sanitizeAsrClouds(value)
    store.set(key, list)
    // 清單變動後當前選用可能已被刪掉 → 收斂，否則 readConfig 會退回第一筆而 UI 不知道
    const cur = String(store.get('asrCloudId', '') || '')
    store.set('asrCloudId', list.some((c) => c.id === cur) ? cur : (list[0]?.id || ''))
    // 三個子分頁各自選的「哪一組設定的哪一顆模型」也要跟著收斂（同 chatProviders 那條）
    modelScope.reconcileAll(store)
    return true
  }
  if (key === 'asrCloudId') {
    const cloudAsr = await loadCloudAsr()
    const list = cloudAsr.sanitizeAsrClouds(store.get('asrClouds', []))
    const active = list.find((c) => c.id === value) || list[0] || null
    store.set(key, active?.id || '')
    return true
  }
  if (key === 'chatProviders') {
    const list = chat.sanitizeProviders(value)
    store.set(key, list)
    // 供應商可能被刪掉或改名 → 選取與模型都要跟著收斂，否則聊天請求會被自己的驗證擋下。
    // 翻譯用的是同一份清單，所以兩組選擇都要收
    reconcileProviderSelection(list, 'chatProviderId', 'chatModelId')
    reconcileProviderSelection(list, 'translateProviderId', 'translateModelId')
    // 三個子分頁的 LLM 選擇都是「供應商 id + 模型 id」的字串，同樣可能指到已刪掉的那一組
    modelScope.reconcileAll(store)
    return true
  }
  if (key === 'chatProviderId' || key === 'translateProviderId') {
    const list = chat.allProviders()
    const active = list.find((p) => p.id === value) || list[0] || null
    store.set(key, active?.id || '')
    // 換供應商就換模型池，舊選擇不再有效
    const modelKey = key === 'chatProviderId' ? 'chatModelId' : 'translateModelId'
    const model = String(store.get(modelKey, '') || '')
    if (!active?.models.includes(model)) store.set(modelKey, active?.models[0] || '')
    return true
  }
  if (key === 'chatModelId') {
    const models = chat.readProvider()?.models || []
    store.set(key, models.includes(value) ? value : (models[0] || ''))
    return true
  }
  if (key === 'translateModelId') {
    const models = translateProviderModels()
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
  if (key === 'dictationEnabled') {
    store.set(key, value === true)
    // 全域鍵盤 hook 的開關就是這個 key，寫完立刻套用（不必再按儲存）
    loadDictation().then(async (d) => {
      await d.refresh()
      // 開著就順手把指示器視窗建起來（隱藏著），省掉第一次按下時的載入空窗
      if (value === true) dictationHud.warm()
      else dictationHud.close()
    }).catch((err) => {
      console.error('[dictation] refresh failed:', err?.message || err)
    })
    return true
  }
  if (key === 'dictationLang') {
    store.set(key, DICTATION_LANGS.has(value) ? value : 'zh-TW')
    return true
  }
  if (key === 'fileAsr' || key === 'liveAsr' || key === 'dictationAsr') {
    store.set(key, modelScope.sanitizeAsr(value, modelScope.cloudsOf(store)))
    return true
  }
  if (key === 'fileLlm' || key === 'liveLlm' || key === 'dictationLlm') {
    const scope = key.slice(0, -3)
    store.set(key, sanitizeScopedLlm(scope, value))
    return true
  }
  if (key === 'closeToTray') {
    store.set(key, value === true)
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

// ===== 開機自啟動 =====
// 真相在 OS（HKCU\...\Run），不進 electron-store：使用者可能在工作管理員的
// 「開機」分頁直接停用，存一份自己的布林值只會跟系統對不上、UI 說謊。
// 開發模式不註冊：那會把 node_modules 裡的 electron.exe 排進使用者的開機清單。
const LOGIN_ITEM_OPTIONS = { args: [HIDDEN_FLAG] }

ipcMain.handle('system:getStartup', (event) => {
  if (!assertMainWindowSender(event)) return { openAtLogin: false, supported: false }
  if (isDev) return { openAtLogin: false, supported: false }
  return { openAtLogin: app.getLoginItemSettings(LOGIN_ITEM_OPTIONS).openAtLogin === true, supported: true }
})

ipcMain.handle('system:setStartup', (event, enabled) => {
  if (!assertMainWindowSender(event)) return { openAtLogin: false, supported: false }
  if (isDev) return { openAtLogin: false, supported: false }
  app.setLoginItemSettings({ ...LOGIN_ITEM_OPTIONS, openAtLogin: enabled === true })
  return { openAtLogin: app.getLoginItemSettings(LOGIN_ITEM_OPTIONS).openAtLogin === true, supported: true }
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

// 語音輸入的桌面指示器。
// 狀態只信主視窗（錄音在那一側）；指示器自己只送得出 ✕／✓ 兩個動作，而且要證明
// 那則訊息真的來自指示器那扇視窗——否則任何 renderer 都能偽造「使用者按了送出」。
ipcMain.handle('dictation:hudState', (event, payload) => {
  if (!assertMainWindowSender(event)) return false
  return dictationHud.update(payload || {})
})

ipcMain.handle('dictation:hudAction', (event, action) => {
  if (!dictationHud.isSender(event)) return false
  if (action !== 'cancel' && action !== 'stop') return false
  if (!mainWindow || mainWindow.isDestroyed()) return false
  // 走跟全域熱鍵同一條路：主視窗的 dictation.js 已經在處理 stop／cancel
  mainWindow.webContents.send('dictation:event', { type: action, data: {} })
  return true
})

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

// 這條只有即時字幕在用（檔案走 transcribeFile、語音輸入走 dictation 服務）
ipcMain.handle('localAsr:transcribe', async (event, req) => transcribeSamples('live', req))

/** 長檔案串流轉錄（ffmpeg 切段，支援 ≥2h / ≥100MB；雲端走 mp3 segment） */
ipcMain.handle('localAsr:transcribeFile', async (event, req) => {
  if (!store) await initStore()
  const engine = modelScope.readAsr(store, 'file').engine
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
  // scope 是白名單：renderer 只能說「我是哪一頁」，模型與金鑰仍由 main 從 store 取
  const scope = modelScope.isScope(opts?.scope) && opts.scope !== 'dictation' ? opts.scope : ''
  return loadLocalLlm().translate(store, trimmed, lang, { ...(opts || {}), scope })
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

/**
 * 設定頁的語音試聽：唸固定的一句範例，用「使用者當下選到但還沒儲存」的語音。
 * `voice` 是新增的參數，但它一樣是 main 的固定表白名單（`tts-voices.js`），
 * 不是自由字串；語速仍讀 store（滑桿未儲存時前端會一併送 rate）。
 */
ipcMain.handle('tts:preview', async (event, req) => {
  if (!store) await initStore()
  const lang = typeof req?.lang === 'string' ? req.lang : 'zh-TW'
  const safeLang = Object.prototype.hasOwnProperty.call(DEFAULT_TTS_VOICES, lang) ? lang : 'en'
  const candidate = typeof req?.voice === 'string' ? req.voice : ''
  const allowed = VOICES_BY_LANG[safeLang].some((v) => v.id === candidate)
  const voice = allowed ? candidate : DEFAULT_TTS_VOICES[safeLang]
  const tts = loadEdgeTts()
  const rate = tts.formatTtsRate(sanitizeTtsRate(req?.rate))
  try {
    return await tts.synthesize({ text: TTS_PREVIEW_TEXT[safeLang], voice, rate })
  } catch (err) {
    const e = new Error(err?.message || String(err))
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
 * 聊天模型選單的選項來源。
 *
 * renderer 以前是自己讀 `chatProviders`——那樣看不到「本機模型」（它是 main 在 router
 * 跑著時合成的一筆，刻意不落盤）。改成跟 main 要一份，兩邊就只有一個真相。
 * **不回 apiKey**（連雲端那幾組的也不回）：選單只需要名字與模型清單。
 */
ipcMain.handle('chat:providerOptions', async () => {
  if (!store) await initStore()
  return {
    providers: chat.allProviders().map((p) => ({
      id: p.id,
      name: p.name,
      models: p.models,
      imageModels: p.imageModels,
      local: p.id === chat.LOCAL_PROVIDER_ID
    })),
    providerId: String(store.get('chatProviderId', '') || ''),
    modelId: String(store.get('chatModelId', '') || '')
  }
})

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

// ===== 終端機 =====
// shell 執行檔、啟動指令與工作目錄的驗證全在 main；renderer 只送 key 與由系統對話框選出的路徑。
registerTerminalIpc({
  ipcMain,
  service: {
    catalog: (...args) => loadTerminal().catalog(...args),
    listSessions: (...args) => loadTerminal().listSessions(...args),
    createSession: (...args) => loadTerminal().createSession(...args),
    renameSession: (...args) => loadTerminal().renameSession(...args),
    deleteSession: (...args) => loadTerminal().deleteSession(...args),
    reorderSessions: (...args) => loadTerminal().reorderSessions(...args),
    openSession: (...args) => loadTerminal().openSession(...args),
    writeSession: (...args) => loadTerminal().writeSession(...args),
    resizeSession: (...args) => loadTerminal().resizeSession(...args),
    killSession: (...args) => loadTerminal().killSession(...args)
  },
  isMainSender: assertMainWindowSender,
  dialog,
  getWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null)
})

// ===== HF模型（本機 llama.cpp router）=====
// renderer 只送 repoId／variantId／模型 id；下載網址由 hub.fileUrl 在 main 組，
// router 的 api key 不出 main（`runtimeStatus` 只回 running 與 port）。
registerHfModelsIpc({
  ipcMain,
  service: {
    search: (...args) => loadHfModels().search(...args),
    inspect: (...args) => loadHfModels().inspect(...args),
    preview: (...args) => loadHfModels().preview(...args),
    detail: (...args) => loadHfModels().detail(...args),
    install: (...args) => loadHfModels().install(...args),
    cancelInstall: (...args) => loadHfModels().cancelInstall(...args),
    listLocal: (...args) => loadHfModels().listLocal(...args),
    removeLocal: (...args) => loadHfModels().removeLocal(...args),
    pickAndImport: (...args) => loadHfModels().pickAndImport(...args),
    openModelsDir: (...args) => loadHfModels().openModelsDir(...args),
    rescan: (...args) => loadHfModels().rescan(...args),
    updateModelSettings: (...args) => loadHfModels().updateModelSettings(...args),
    refreshFit: (...args) => loadHfModels().refreshFit(...args),
    tune: (...args) => loadHfModels().tune(...args),
    autoTune: (...args) => loadHfModels().autoTune(...args),
    cancelTune: (...args) => loadHfModels().cancelTune(...args),
    chooseModelsDir: (...args) => loadHfModels().chooseModelsDir(...args),
    setToken: (...args) => loadHfModels().setToken(...args),
    tokenStatus: (...args) => loadHfModels().tokenStatus(...args),
    hardwareInfo: (...args) => loadHfModels().hardwareInfo(...args),
    runtimeReady: (...args) => loadHfModels().runtimeReady(...args),
    runtimeStatus: (...args) => loadHfModels().runtimeStatus(...args),
    // router 起停都要同步「聊天看得到哪幾顆」，不然選單會停在上一輪的狀態
    startRuntime: async (...args) => {
      const status = await loadHfModels().startRuntime(...args)
      await refreshHfLocalModels()
      return status
    },
    stopRuntime: (...args) => {
      const status = loadHfModels().stopRuntime(...args)
      hfLocalModelIds = []
      return status
    },
    currentDevice: (...args) => loadHfModels().currentDevice(...args),
    applyPresets: (...args) => loadHfModels().applyPresets(...args),
    loadModel: (...args) => loadHfModels().loadModel(...args),
    unloadModel: (...args) => loadHfModels().unloadModel(...args),
    refreshModels: () => refreshHfLocalModels().then(() => loadHfModels().refreshModels())
  },
  isMainSender: assertMainWindowSender
})

// ===== 系統監控 =====
// PowerShell 腳本、nvidia-smi 參數、taskkill 參數與測速目錄的驗證全在 main；
// renderer 只送取樣間隔的 key 與要結束的 pid。
registerSysmonIpc({
  ipcMain,
  service: {
    status: (...args) => loadSysmon().status(...args),
    start: (...args) => loadSysmon().start(...args),
    stop: (...args) => loadSysmon().stop(...args),
    inventory: (...args) => loadSysmon().inventory(...args),
    detail: (...args) => loadSysmon().detail(...args),
    killProcess: (...args) => loadSysmon().killProcess(...args),
    enableSensors: (...args) => loadSysmon().enableSensors(...args),
    installPawnIo: (...args) => loadSysmon().installPawnIo(...args),
    openPawnIoPage: (...args) => loadSysmon().openPawnIoPage(...args),
    cpuStress: (...args) => loadSysmon().cpuStress(...args),
    memStress: (...args) => loadSysmon().memStress(...args),
    stressStatus: (...args) => loadSysmon().stressStatus(...args),
    diskBench: (...args) => loadSysmon().diskBench(...args),
    cancelDiskBench: (...args) => loadSysmon().cancelDiskBench(...args),
    // 風扇控制（identifier 由 main 對照即時通道清單驗過，見 sysmon/fans.js）
    fanList: (...args) => loadSysmon().fanList(...args),
    fanEnable: (...args) => loadSysmon().fanEnable(...args),
    fanSetChannel: (...args) => loadSysmon().fanSetChannel(...args),
    fanIdentify: (...args) => loadSysmon().fanIdentify(...args),
    fanResetAll: (...args) => loadSysmon().fanResetAll(...args),
    fanTaskStatus: (...args) => loadSysmon().fanTaskStatus(...args),
    fanTaskInstall: (...args) => loadSysmon().fanTaskInstall(...args),
    fanTaskRemove: (...args) => loadSysmon().fanTaskRemove(...args),
    // GPU 壓力測試期間把 renderer 的背景節流關掉，測完立刻打開。
    //
    // 視窗被別的視窗遮住時，Chromium 會把這個 renderer 降級——GPU 指令跟著被降優先，
    // 壓力測試就安靜地垮掉（實測 nvidia-smi 從 100% 掉到 3%，畫面上還寫著「執行中」）。
    // **不可以改成建視窗時就 `backgroundThrottling: false`**：那會連帶讓最小化到系統匣時
    // `document.hidden` 不再變成 true（實測過），而 AGY 頁那條五秒輪詢——每輪都會開一次
    // PowerShell 去讀 Credential Manager——正是靠它自己停下來的。
    // 順帶一提：關掉節流時 `document.hidden` 會跟著變成 false（縮小與 hide 都一樣，
    // `scripts/probe-dictation-latency.js` 有量），所以它只能是「跑測試那幾秒」的暫時狀態。
    setGpuStress: (active) => {
      if (!mainWindow || mainWindow.isDestroyed()) return { active: false }
      mainWindow.webContents.setBackgroundThrottling(active !== true)
      return { active: active === true }
    }
  },
  isMainSender: assertMainWindowSender
})

// ===== Claude Code 工作台（供應商切換／MCP／CLI 版本） =====
// 端點與 npm 套件名都是 main 的固定表；格式值由白名單驗證後才送入路由，renderer 只送 preset key 與工具 key。
// 寫入的是使用者家目錄的 ~/.claude/settings.json 與 ~/.claude.json，一律備份＋原子替換，
// 而且只動我們管的那幾個 env 鍵與 mcpServers。
registerCcSwitchIpc({
  ipcMain,
  service: {
    catalog: (...args) => loadCcSwitch().catalog(...args),
    listProviders: (...args) => loadCcSwitch().listProviders(...args),
    createProvider: (...args) => loadCcSwitch().createProvider(...args),
    updateProvider: (...args) => loadCcSwitch().updateProvider(...args),
    deleteProvider: (...args) => loadCcSwitch().deleteProvider(...args),
    reorderProviders: (...args) => loadCcSwitch().reorderProviders(...args),
    activateProvider: (...args) => loadCcSwitch().activateProvider(...args),
    testProvider: (...args) => loadCcSwitch().testProvider(...args),
    scanProviderModels: (...args) => loadCcSwitch().scanProviderModels(...args),
    gatewayStatus: (...args) => loadCcSwitch().gatewayStatus(...args),
    startGateway: (...args) => loadCcSwitch().startGateway(...args),
    stopGateway: (...args) => loadCcSwitch().stopGateway(...args),
    listMcp: (...args) => loadCcSwitch().listMcp(...args),
    saveMcp: (...args) => loadCcSwitch().saveMcp(...args),
    toggleMcp: (...args) => loadCcSwitch().toggleMcp(...args),
    deleteMcp: (...args) => loadCcSwitch().deleteMcp(...args),
    listAccounts: (...args) => loadCcSwitch().listAccounts(...args),
    beginLogin: (...args) => loadCcSwitch().beginLogin(...args),
    loginStatus: (...args) => loadCcSwitch().loginStatus(...args),
    cancelLogin: (...args) => loadCcSwitch().cancelLogin(...args),
    removeAccount: (...args) => loadCcSwitch().removeAccount(...args),
    checkVersions: (...args) => loadCcSwitch().checkVersions(...args),
    versionUpdateCommand: (...args) => loadCcSwitch().versionUpdateCommand(...args)
  },
  isMainSender: assertMainWindowSender
})

// ===== 語音輸入（全域右 Alt）=====
// 熱鍵、麥克風以外的每一段都在 main：ASR 模型、整理用的供應商金鑰、剪貼簿與模擬按鍵。
// renderer 只送得出「錄好的一段 PCM」與字典的兩個字串。
registerDictationIpc({
  ipcMain,
  service: {
    status: async (...args) => (await loadDictation()).status(...args),
    refresh: async (...args) => (await loadDictation()).refresh(...args),
    submit: async (...args) => (await loadDictation()).submit(...args),
    listRecords: async (...args) => (await loadDictation()).listRecords(...args),
    removeRecord: async (...args) => (await loadDictation()).removeRecord(...args),
    clearRecords: async (...args) => (await loadDictation()).clearRecords(...args),
    listDictionary: async (...args) => (await loadDictation()).listDictionary(...args),
    upsertDictionary: async (...args) => (await loadDictation()).upsertDictionary(...args),
    removeDictionary: async (...args) => (await loadDictation()).removeDictionary(...args)
  },
  isMainSender: assertMainWindowSender
})

// ===== 本機 token 用量統計 =====
// 讀的是使用者家目錄的 session 記錄與本 App 的 AGY 日誌；路徑與 SQL 固定在 main，
// 回給 renderer 的只有彙總數字，對話內容與專案名稱一律不出 main。
registerCodeUsageIpc({
  ipcMain,
  service: {
    stats: (...args) => loadCodeUsage().stats(...args),
    sync: (...args) => loadCodeUsage().sync(...args),
    savePrices: (...args) => loadCodeUsage().savePrices(...args),
    reset: (...args) => loadCodeUsage().reset(...args)
  },
  isMainSender: assertMainWindowSender
})

// 設定系統音訊擷取的媒體請求處理器
app.whenReady().then(() => {
  // 沒搶到鎖的那份只負責把訊號送出去就結束，不可以建窗、更不可以 autoStart 反代（撞埠）
  if (!hasInstanceLock) return
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
  initStore()
    .then(() => {
      // 風扇接管：使用者上次開著就在開機自啟動時直接接手，**不必等他點開系統監控頁**。
      // 這之前的幾秒由 BIOS 曲線負責，那是安全的預設值。
      if (store?.get('fanControl')?.enabled !== true) return undefined
      return loadSysmon().ensureFanControl()
        .catch((err) => console.error('[sysmon] fan takeover failed:', err?.message || err))
    })
    .catch((err) => console.error('[store] init failed:', err?.message || err))
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
  // 終端機先收：每個工作階段都是一顆真的 conhost，不砍就會留在工作管理員裡
  if (terminalMod) terminalMod.killAll()
  // 系統監控有三顆子程序（probe.ps1／nvidia-smi／感測器 sidecar），少收一顆就變孤兒。
  // **這條是 await 得到的**：風扇的手動 PWM 留在晶片裡，沒等它交還就退出等於把風扇
  // 釘在最後的轉速（事後 SetDefault 也救不回來，只有重開機）。
  const stopSysmon = sysmonMod
    ? Promise.resolve(sysmonMod.shutdown()).catch((err) => console.error('[sysmon] shutdown failed:', err))
    : Promise.resolve()
  // 低階鍵盤 hook 有自己的執行緒，不收掉會擋住程序真的結束
  if (dictationMod) dictationMod.shutdown()
  // llama.cpp router：它自己會帶走底下跑模型的子程序，但沒人收它就會留一台在背景吃顯存
  if (hfModelsMod) hfModelsMod.shutdown()
  // 指示器是 alwaysOnTop 的獨立視窗：留著就會浮在桌面上關不掉
  dictationHud.close()
  // 反代先關：留著監聽的 socket 會讓下次啟動撞到 EADDRINUSE
  // Claude Code 的轉換閘道同理（跟 AGY 是兩個不同的埠）
  const stopGateway = ccSwitchMod
    ? ccSwitchMod.stopGateway().catch((err) => console.error('[ccswitch] gateway stop failed:', err))
    : Promise.resolve()
  const stopAgy = Promise.all([
    stopSysmon,
    stopGateway,
    agyMod ? agyMod.shutdown() : Promise.resolve()
  ])
  stopAgy
    .catch((err) => console.error('[agy] shutdown on quit failed:', err))
    .then(() => {
      if (require.cache[require.resolve('./engine')]) return loadEngine().unloadAll()
      // engine 沒被載過但 ASR 被直接叫過：llama-server sidecar 是獨立程序，不收會變孤兒
      if (require.cache[require.resolve('./asr-select')]) return loadLocalAsr().unload()
      return undefined
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

