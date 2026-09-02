'use strict'

/**
 * Claude Code 供應商清單與切換（Main Process）。
 *
 * 存在獨立的 `<userData>/cc-providers.json`（比照 `terminal/store.js`／`chat-store.js`），
 * **不進 `STORE_ALLOWLIST`**：裡面有 API 金鑰，只能走逐一列舉的 `ccswitch:*` IPC。
 *
 * 一筆供應商 = 一個預設 key ＋ 使用者自己的名稱／金鑰／模型／格式。端點一律由
 * `presets.js` 決定，renderer 不能指定內建網址。內建各家由 `list()` 自動播種各一筆、
 * 不可刪到少於一筆；`custom` 是唯一讓使用者自己建的（可以很多筆）。
 */

const presets = require('./presets')
const claudeSettings = require('./claude-settings')

const MAX_PROVIDERS = 30
const MAX_NAME = 60
const MAX_KEY = 512
const MAX_MODEL = 120

const MAX_URL = 200

/**
 * 四個等級各自對應的 env 鍵。使用者可以只填「主模型」（等於兜底），
 * 也可以三個等級各給一顆（Opus 用大的、Haiku 用便宜的，比照 cc-switch 的模型映射）。
 * 留空的那一格就沿用預設表裡那家原本的值。
 */
const MODEL_FIELDS = Object.freeze({
  model: 'ANTHROPIC_MODEL',
  haikuModel: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  sonnetModel: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  opusModel: 'ANTHROPIC_DEFAULT_OPUS_MODEL'
})

/** 舊版相容：以前只有一個 `model` 欄位，語意是「四個等級全套這顆」 */
const MODEL_KEYS = Object.freeze(Object.values(MODEL_FIELDS))

/**
 * 金鑰可以寫進哪個 env 鍵。第三方端點有的只認 `x-api-key`（→ ANTHROPIC_API_KEY）、
 * 有的只認 Bearer（→ ANTHROPIC_AUTH_TOKEN），填錯的症狀是靜默 401，所以要能自己選。
 */
const AUTH_FIELDS = Object.freeze(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'])

/** 上游與驗證都共用這三種協議；上游選擇同時決定是否進本機閘道。 */
const API_FORMATS = Object.freeze(['anthropic', 'openai_chat', 'openai_responses'])

/**
 * 「宣告 1M 上下文」寫進去的窗口大小。Claude Code 看到模型名尾巴的 `[1m]` 就把視窗
 * 當成 1M（跟 cc-switch 同一套約定），兩個窗口鍵一起釘住是為了自動壓縮的門檻——
 * 只加後綴的話，這家 preset 原本釘住的 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`
 * （Codex 是 372000）會把壓縮門檻夾回去，視窗開了也用不到。
 */
const ONE_M_TOKENS = '1000000'

/** 三種上游格式的路徑；內建 `wireBaseUrl` 已含 `/v1`，所以 Messages 只接 `/messages` */
const WIRE_PATHS = Object.freeze({ anthropic: '/messages', chat: '/chat/completions', responses: '/responses' })

const FORMAT_VERSION = 2

/** @type {import('electron-store') | null} */
let store = null
/** @type {Promise<import('electron-store')> | null} */
let storeReady = null
/** 測試注入的 store 工廠（`configure({ getStore })`），仿 mcp／oauth 的慣例 */
let storeFactory = null
let storeChain = Promise.resolve()

/**
 * 整份檔案是 read-modify-write，兩個並行 IPC 各讀各寫會互相蓋掉。
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withStore(fn) {
  const run = storeChain.then(fn, fn)
  storeChain = run.then(() => {}, () => {})
  return run
}

async function getStore() {
  if (store) return store
  if (storeFactory) {
    store = await storeFactory()
    return store
  }
  if (!storeReady) {
    storeReady = import('electron-store').then((mod) => {
      if (!store) store = new mod.default({ name: 'cc-providers' })
      return store
    })
  }
  return storeReady
}

/**
 * 讓 node 直測可以換掉 electron-store（跟 mcp／oauth 的注入點同一個道理）。
 * @param {{ getStore?: () => Promise<object> }} [options]
 */
function configure(options = {}) {
  if (typeof options?.getStore === 'function') storeFactory = options.getStore
}

// ===== 純函式 =====

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

/**
 * 使用者自填的 Base URL。只放行 http(s)——這個字串會寫進使用者的 `~/.claude/settings.json`，
 * 讓 `file:`／`javascript:` 這種進去等於幫別人在別的程式裡埋東西。看不懂就當成沒填。
 * @param {unknown} value
 * @returns {string}
 */
function url(value) {
  const raw = text(value, MAX_URL)
  if (!raw) return ''
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? raw.replace(/\/+$/, '') : ''
  } catch {
    return ''
  }
}

/**
 * 這一筆能不能自己填 Base URL。**只有 `custom` 可以。**
 *
 * 內建各家的端點都是實測查證過的事實（走閘道的更是寫在 `gateway/server.js` 的固定表裡、
 * 還帶各自的專屬標頭，填了也不會生效），多一個輸入格只多一種「填錯了但看不出來」的失敗方式；
 * 官方訂閱那筆的意義本來就是「什麼都不寫」。要接自架端點就開一筆自訂。
 * @param {{ id: string }} preset
 * @returns {boolean}
 */
function allowsCustomUrl(preset) {
  return preset.id === 'custom'
}

/**
 * 這一筆的上游講哪種協議。內建與自訂都能選，壞值回到該預設。
 * @param {{ apiFormat?: unknown }} provider
 * @param {{ id: string, apiFormat: string }} preset
 * @returns {string}
 */
function apiFormatFor(provider, preset) {
  const picked = text(provider?.apiFormat, 40)
  return API_FORMATS.includes(picked) ? picked : preset.apiFormat
}


/**
 * 路由：講 Anthropic 的直連，其餘一律經本機閘道轉換。
 * @param {object} provider
 * @param {{ id: string, route: string, apiFormat: string }} preset
 * @returns {'direct' | 'gateway'}
 */
function routeFor(provider, preset) {
  if (!preset || preset.auth === 'none') return 'direct'
  return apiFormatFor(provider, preset) === 'anthropic' ? 'direct' : 'gateway'
}

/**
 * 閘道路徑上的那一段。內建預設用 preset id（一家一條，沿用舊網址）；
 * **自訂用 provider id**——多筆自訂各有各的端點，共用 `custom` 會互相蓋掉。
 * @param {{ id?: string }} provider
 * @param {{ id: string }} preset
 * @returns {string}
 */
function routeKeyFor(provider, preset) {
  return preset.id === 'custom' ? text(provider?.id, 40) : preset.id
}

/**
 * 這一筆實際要用的上游 Base URL（**不是**寫進 settings.json 的那個——走閘道的會被
 * 換成本機閘道位址）。內建直連用預設表的；自訂用使用者填的。
 *
 * 官方訂閱回空；其餘直連才回預設 Base URL，走閘道的上游 URL 由 `resolveRoute()` 組出。
 * @param {{ baseUrl?: unknown }} provider
 * @param {{ id: string, auth: string, route: string, baseUrl: string }} preset
 * @returns {string}
 */
function baseUrlFor(provider, preset) {
  if (preset.auth === 'none') return ''
  if (allowsCustomUrl(preset)) return url(provider?.baseUrl)
  return routeFor(provider, preset) === 'gateway' ? '' : preset.baseUrl
}

/**
 * @param {string} format
 * @returns {'anthropic' | 'chat' | 'responses'}
 */
function wireForFormat(format) {
  return format === 'anthropic' ? 'anthropic' : format === 'openai_chat' ? 'chat' : 'responses'
}

/**
 * 依內建表的 API 根位址接上格式路徑；custom 的 Anthropic baseUrl 由 UI 說明要求接在 /v1/messages 前。
 * @param {object} provider
 * @param {object} preset
 * @param {string} format
 * @returns {string}
 */
function wireUrlFor(provider, preset, format) {
  const base = preset.id === 'custom'
    ? url(provider?.baseUrl)
    : text(preset.wireBaseUrl || preset.baseUrl, MAX_URL)
  if (!base) return ''
  const path = preset.id === 'custom' && format === 'anthropic'
    ? '/v1/messages'
    : WIRE_PATHS[wireForFormat(format)]
  return `${base.replace(/\/+$/, '')}${path}`
}

/**
 * @param {{ authField?: unknown }} provider
 * @param {{ keyField: string }} preset
 * @returns {string}
 */
function authFieldFor(provider, preset) {
  const picked = text(provider?.authField, 40)
  return AUTH_FIELDS.includes(picked) ? picked : preset.keyField
}

/**
 * 讀檔後正規化：cc-providers.json 可能被手改，或是預設被下架。
 * 預設不存在的那一筆**整筆丟掉**（沒有端點就沒有意義），與 `chatProviders`
 * 「壞網址只清空欄位」的處置不同——那邊丟掉會連使用者的金鑰與模型清單一起沒。
 * @param {unknown} raw
 * @returns {Array<{ id: string, presetId: string, name: string, apiKey: string, model: string, createdAt: number }>}
 */
function sanitizeAll(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const id = text(item.id, 40)
    const preset = presets.getPreset(item.presetId)
    if (!id || !preset || seen.has(id)) continue
    seen.add(id)
    const model = text(item.model, MAX_MODEL)
    const migrateBuiltinFormat = preset.id !== 'custom' && item.formatVersion !== FORMAT_VERSION
    // 舊檔只有一個 `model`，語意是四個等級全套這顆。三個等級鍵**一個都沒有**才算舊檔——
    // 用「值是不是空字串」判斷的話，使用者刻意清空某一格會在下次讀檔時被塞回去。
    const legacy = !('haikuModel' in item || 'sonnetModel' in item || 'opusModel' in item)
    out.push({
      id,
      presetId: preset.id,
      name: text(item.name, MAX_NAME) || preset.name,
      baseUrl: allowsCustomUrl(preset) ? url(item.baseUrl) : '',
      apiFormat: migrateBuiltinFormat ? preset.apiFormat : apiFormatFor(item, preset),
      formatVersion: FORMAT_VERSION,
      authField: preset.auth === 'key' ? authFieldFor(item, preset) : '',
      apiKey: preset.auth === 'key' ? text(item.apiKey, MAX_KEY) : '',
      // 這一筆綁哪個在本 App 登入的帳號（空＝退回讀已安裝 CLI 的憑證）
      oauthAccountId: preset.auth === 'cli' ? text(item.oauthAccountId, 60) : '',
      context1m: item.context1m === true,
      model,
      haikuModel: legacy ? model : text(item.haikuModel, MAX_MODEL),
      sonnetModel: legacy ? model : text(item.sonnetModel, MAX_MODEL),
      opusModel: legacy ? model : text(item.opusModel, MAX_MODEL),
      createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now()
    })
    if (out.length >= MAX_PROVIDERS) break
  }
  return out
}

/**
 * 算出這一筆供應商要寫進 settings.json 的 env。
 *
 * @param {{ presetId: string, apiKey: string, model: string }} provider
 * @param {{ baseUrl: string, apiKey: string }} [gateway] 本機閘道（route 為 gateway 的預設才會用到）
 * @returns {Record<string, string>}
 */
function resolveEnv(provider, gateway) {
  const preset = presets.getPreset(provider?.presetId)
  if (!preset) return {}
  // 官方訂閱：一個鍵都不寫，`applyEnv` 會把我們管的那組整批清掉。模型四格也不套——
  // 這一筆的定義是「回到動手前的狀態」，多寫任何一個鍵都不算切乾淨
  if (preset.auth === 'none') return {}
  /** @type {Record<string, string>} */
  const env = { ...preset.env }
  const route = routeFor(provider, preset)
  const upstream = baseUrlFor(provider, preset)

  // 自訂那筆沒有預設端點，沒填就沒得打——這裡擋掉，總比寫出一個空的 Base URL
  // 讓 Claude Code 去打 Anthropic 官方然後回 401 好
  if (preset.id === 'custom' && !upstream) {
    const error = new Error('MISSING_BASE_URL')
    error.code = 'MISSING_BASE_URL'
    error.userMessage = '自訂供應商要先填 Base URL'
    throw error
  }

  if (route === 'gateway') {
    // Claude Code 自己會接 /v1/messages，所以這裡給的是根位址加一段路由前綴
    const base = text(gateway?.baseUrl, 200)
    if (!base) {
      const error = new Error('GATEWAY_OFFLINE')
      error.code = 'GATEWAY_OFFLINE'
      error.userMessage = '這家要經本機閘道轉換，請先啟動閘道'
      throw error
    }
    env.ANTHROPIC_BASE_URL = `${base.replace(/\/+$/, '')}/${routeKeyFor(provider, preset)}`
    env.ANTHROPIC_AUTH_TOKEN = text(gateway?.apiKey, MAX_KEY)
  } else if (upstream) {
    env.ANTHROPIC_BASE_URL = upstream
  }

  if (preset.auth === 'key' && preset.keyField) {
    const key = text(provider?.apiKey, MAX_KEY)
    if (!key) {
      const error = new Error('MISSING_API_KEY')
      error.code = 'MISSING_API_KEY'
      error.userMessage = '這家需要 API 金鑰，請先填好再切換'
      throw error
    }
    // gateway 路由的金鑰欄位是閘道自己的（上面已寫），使用者的金鑰由閘道去取，不進 settings.json
    if (route === 'direct') env[authFieldFor(provider, preset)] = key
  }

  for (const [field, key] of Object.entries(MODEL_FIELDS)) {
    const value = text(provider?.[field], MAX_MODEL)
    if (value) env[key] = value
  }

  // 宣告 1M：四個等級的模型名尾巴都補 `[1m]`（已經有就不再疊一層），窗口兩個鍵一起放大。
  // 上游真的沒有 1M 的話不會因此變大，只是 Claude Code 會比較晚壓縮；閘道送出前會把
  // 後綴剝掉（`convert.stripContextMarker`），不會拿一個上游不認得的模型名去打。
  if (provider?.context1m === true) {
    for (const key of MODEL_KEYS) {
      if (env[key]) env[key] = `${String(env[key]).replace(/\[1m\]$/i, '')}[1m]`
    }
    env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = ONE_M_TOKENS
    env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = ONE_M_TOKENS
  }

  return env
}

/**
 * 這一筆套用之後，會不會在 settings.json 寫一個 `ANTHROPIC_BASE_URL`？
 *
 * 只有兩種不會寫：官方訂閱（什麼都不寫）與沒填端點的自訂。走閘道的一定會寫
 * （閘道位址），直連的則看有沒有端點。
 * @param {object} item
 * @param {{ id: string, route: string, apiFormat: string, baseUrl: string }} preset
 * @returns {boolean}
 */
function writesBaseUrl(item, preset) {
  return routeFor(item, preset) === 'gateway' || Boolean(baseUrlFor(item, preset))
}

/**
 * 目前 settings.json 真的指向哪一筆。
 *
 * 只認 `currentId` 是不夠的：使用者可能自己去改 settings.json，或跑了別的工具。
 * 所以拿設定檔裡真正的 Base URL 回頭比對，對不上就回空字串，UI 顯示「外部修改」。
 *
 * 兩條規則：
 *  1. **設定檔沒有 Base URL ＝ 沒指向任何第三方端點 ＝ 就是官方登入**。選用中的那一筆
 *     若本來就不寫 Base URL（官方訂閱、沒填端點的自訂），答案就是它自己。
 *     反過來，選用中的是走閘道那幾家而設定檔卻空的，代表它根本沒被套用——不能算它作用中
 *     （少了這條，使用者只要曾經切過 Codex，之後把 env 清乾淨畫面上還是寫著「Codex 使用中」，
 *     實際截圖抓到過）。
 *  2. 設定檔有 Base URL 就回頭比對，一模一樣才算。
 *
 * @param {Array<object>} items
 * @param {string} currentId
 * @param {string} liveBaseUrl
 * @param {{ baseUrl: string }} [gateway]
 * @returns {string}
 */
function detectActiveId(items, currentId, liveBaseUrl, gateway) {
  const live = text(liveBaseUrl, 200)
  const current = items.find((item) => item.id === currentId) || null
  const preset = current ? presets.getPreset(current.presetId) : null
  if (!live) {
    return current && preset && !writesBaseUrl(current, preset) ? current.id : officialId(items)
  }
  if (!current || !preset) return ''
  let expected = baseUrlFor(current, preset)
  if (routeFor(current, preset) === 'gateway') {
    const base = text(gateway?.baseUrl, 200)
    // 閘道沒起來就不知道位址，無從比對
    expected = base ? `${base.replace(/\/+$/, '')}/${routeKeyFor(current, preset)}` : ''
  }
  return expected && live === expected ? current.id : ''
}

/**
 * 清單裡「官方訂閱」那一筆的 id（`seedBuiltins` 保證有）。
 * @param {Array<object>} items
 * @returns {string}
 */
function officialId(items) {
  return items.find((item) => presets.getPreset(item.presetId)?.auth === 'none')?.id || ''
}

/**
 * @returns {string}
 */
function newId() {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

// ===== 讀寫 =====

async function readAll() {
  const s = await getStore()
  return sanitizeAll(s.get('providers', []))
}

/**
 * @param {Array<object>} items
 */
async function writeAll(items) {
  const s = await getStore()
  s.set('providers', items)
  return items
}

/** @returns {Promise<string>} */
async function readCurrentId() {
  const s = await getStore()
  return text(s.get('currentId', ''), 40)
}

/**
 * 內建各家至少一筆：清單裡缺哪一家就補一筆空殼（冪等，有就不動）。
 * 這是 UI 那一排 tile 的資料來源——被下架的舊預設會在 `sanitizeAll` 丟掉，
 * 新錶上線或清單被清空時靠這裡補齊。
 * @param {Array<object>} items 正規化過的清單
 * @returns {Promise<Array<object>>}
 */
async function seedBuiltins(items) {
  let seeded = false
  for (const preset of presets.PRESETS) {
    if (preset.id === 'custom') continue
    if (items.some((item) => item.presetId === preset.id)) continue
    if (items.length >= MAX_PROVIDERS) break
    items.push({
      id: newId(),
      presetId: preset.id,
      name: preset.name,
      baseUrl: '',
      apiFormat: preset.apiFormat,
      formatVersion: FORMAT_VERSION,
      authField: '',
      apiKey: '',
      oauthAccountId: '',
      context1m: false,
      model: '',
      haikuModel: '',
      sonnetModel: '',
      opusModel: '',
      createdAt: Date.now()
    })
    seeded = true
  }
  if (seeded) await writeAll(items)
  return items
}

/**
 * 完整實例（含金鑰）。只給 main 內部用（模型掃描），不接 IPC。
 * @param {string} id
 * @returns {Promise<object | null>}
 */
function getRaw(id) {
  return withStore(async () => {
    const items = await readAll()
    return items.find((item) => item.id === id) || null
  })
}

/**
 * 清單 ＋ 目前狀態。金鑰只回「有沒有填」與末四碼，完整值不出 main。
 * @param {{ gateway?: { baseUrl: string } }} [options]
 */
function list(options = {}) {
  return withStore(async () => {
    const items = await seedBuiltins(await readAll())
    // currentId 指向已不存在的實例（預設被下架、清單被手改）就清掉，
    // 不然 `detectActiveId` 永遠回空，UI 會一直顯示誤導的「被外部修改」
    const s = await getStore()
    let currentId = await readCurrentId()
    if (currentId && !items.some((item) => item.id === currentId)) {
      currentId = ''
      s.set('currentId', '')
    }
    const live = claudeSettings.readManagedEnv()
    return {
      providers: items.map((item) => ({
        id: item.id,
        presetId: item.presetId,
        name: item.name,
        baseUrl: item.baseUrl,
        apiFormat: item.apiFormat,
        // UI 要講「這筆會直連還是經閘道」，自訂那筆是算出來的，renderer 別自己推
        route: routeFor(item, presets.getPreset(item.presetId)),
        authField: item.authField,
        oauthAccountId: item.oauthAccountId,
        context1m: item.context1m,
        model: item.model,
        haikuModel: item.haikuModel,
        sonnetModel: item.sonnetModel,
        opusModel: item.opusModel,
        hasKey: Boolean(item.apiKey),
        keyTail: item.apiKey ? item.apiKey.slice(-4) : '',
        createdAt: item.createdAt
      })),
      currentId,
      activeId: detectActiveId(items, currentId, live.baseUrl, options.gateway),
      settingsPath: live.path,
      settingsExists: live.exists,
      liveBaseUrl: live.baseUrl
    }
  })
}

/**
 * @param {{ presetId?: string, name?: string, apiKey?: string, model?: string, apiFormat?: string }} req
 */
function create(req) {
  return withStore(async () => {
    const preset = presets.getPreset(req?.presetId)
    if (!preset) {
      const error = new Error('UNKNOWN_PRESET')
      error.code = 'UNKNOWN_PRESET'
      error.userMessage = '不認得的供應商'
      throw error
    }
    const items = await readAll()
    if (items.length >= MAX_PROVIDERS) {
      const error = new Error('PROVIDER_LIMIT')
      error.code = 'PROVIDER_LIMIT'
      error.userMessage = `供應商最多 ${MAX_PROVIDERS} 個`
      throw error
    }
    const item = {
      id: newId(),
      presetId: preset.id,
      name: text(req?.name, MAX_NAME) || preset.name,
      baseUrl: allowsCustomUrl(preset) ? url(req?.baseUrl) : '',
      apiFormat: apiFormatFor(req, preset),
      formatVersion: FORMAT_VERSION,
      authField: preset.auth === 'key' ? authFieldFor(req, preset) : '',
      apiKey: preset.auth === 'key' ? text(req?.apiKey, MAX_KEY) : '',
      oauthAccountId: preset.auth === 'cli' ? text(req?.oauthAccountId, 60) : '',
      context1m: req?.context1m === true,
      model: text(req?.model, MAX_MODEL),
      haikuModel: text(req?.haikuModel, MAX_MODEL),
      sonnetModel: text(req?.sonnetModel, MAX_MODEL),
      opusModel: text(req?.opusModel, MAX_MODEL),
      createdAt: Date.now()
    }
    await writeAll([...items, item])
    return { id: item.id }
  })
}

/**
 * 更新一筆。`apiKey` 沒帶就保留原值（UI 顯示遮罩，不會把完整金鑰送回來）。
 * @param {string} id
 * @param {{ name?: string, apiKey?: string, model?: string, apiFormat?: string }} patch
 */
function update(id, patch) {
  return withStore(async () => {
    const items = await readAll()
    let found = false
    const next = items.map((item) => {
      if (item.id !== id) return item
      found = true
      const preset = presets.getPreset(item.presetId)
      const next = {
        ...item,
        name: text(patch?.name, MAX_NAME) || item.name,
        apiKey: preset?.auth === 'key' && typeof patch?.apiKey === 'string'
          ? text(patch.apiKey, MAX_KEY)
          : item.apiKey
      }
      if (preset && allowsCustomUrl(preset) && typeof patch?.baseUrl === 'string') {
        next.baseUrl = url(patch.baseUrl)
      }
      if (preset && typeof patch?.apiFormat === 'string') {
        next.apiFormat = apiFormatFor(patch, preset)
        next.formatVersion = FORMAT_VERSION
      }
      if (preset?.auth === 'key' && typeof patch?.authField === 'string') {
        next.authField = authFieldFor(patch, preset)
      }
      if (preset?.auth === 'cli' && typeof patch?.oauthAccountId === 'string') {
        next.oauthAccountId = text(patch.oauthAccountId, 60)
      }
      if (typeof patch?.context1m === 'boolean') next.context1m = patch.context1m
      // 四個等級各自可改；沒帶那一格就維持原值（跟金鑰同一條規矩）
      for (const field of Object.keys(MODEL_FIELDS)) {
        if (typeof patch?.[field] === 'string') next[field] = text(patch[field], MAX_MODEL)
      }
      return next
    })
    if (!found) {
      const error = new Error('NOT_FOUND')
      error.code = 'NOT_FOUND'
      error.userMessage = '找不到這個供應商'
      throw error
    }
    await writeAll(next)
    return true
  })
}

/**
 * @param {string} id
 */
function remove(id) {
  return withStore(async () => {
    const items = await readAll()
    // 內建各家不可刪到少於一筆——tile 那一排是靠「每家至少一筆」撐起來的。
    // 同一家建了第二筆（兩把金鑰）時可以刪，刪到剩一筆為止。
    const target = items.find((item) => item.id === id)
    if (target) {
      const preset = presets.getPreset(target.presetId)
      if (preset && preset.id !== 'custom' && items.filter((item) => item.presetId === preset.id).length <= 1) {
        const error = new Error('PROVIDER_REQUIRED')
        error.code = 'PROVIDER_REQUIRED'
        error.userMessage = '內建供應商不可刪除'
        throw error
      }
    }
    await writeAll(items.filter((item) => item.id !== id))
    const s = await getStore()
    if (text(s.get('currentId', ''), 40) === id) s.set('currentId', '')
    return true
  })
}

/**
 * 拖曳排序：只接受既有 id，漏掉的接在後面。
 * @param {string[]} ids
 */
function reorder(ids) {
  return withStore(async () => {
    const items = await readAll()
    if (!Array.isArray(ids)) return true
    const byId = new Map(items.map((item) => [item.id, item]))
    const next = []
    for (const id of ids) {
      const item = byId.get(id)
      if (!item) continue
      byId.delete(id)
      next.push(item)
    }
    next.push(...byId.values())
    await writeAll(next)
    return true
  })
}

/**
 * 閘道要用的金鑰：先看目前選用的那一筆是不是這家，不是就挑第一筆有填金鑰的。
 *
 * 同一個預設可以建很多筆（兩把金鑰各一筆），但閘道的路由是「一家一條」，
 * 所以要有個明確的挑法，不能隨便拿一筆。
 *
 * @param {string} presetId
 * @returns {Promise<string>}
 */
function keyForPreset(presetId) {
  return withStore(async () => {
    const items = await readAll()
    // 自訂供應商的路由 key 是 provider id，先按 id 找；找得到就是那一筆的金鑰，
    // 不必再去猜「這家的第一筆」（自訂本來就一筆一個端點）
    const byId = items.find((item) => item.id === presetId)
    if (byId) return byId.apiKey || ''
    const currentId = await readCurrentId()
    const current = items.find((item) => item.id === currentId)
    if (current?.presetId === presetId && current.apiKey) return current.apiKey
    return items.find((item) => item.presetId === presetId && item.apiKey)?.apiKey || ''
  })
}

/**
 * 閘道要打的上游位址與形狀。內建供應商依目前實例的上游格式選路；自訂供應商的
 * 位址則從 store 讀出（存檔時過 `url()` 只放行 http(s)）。
 *
 * @param {string} routeKey 網址路徑上那一段（自訂＝provider id）
 * @returns {Promise<{ wire?: string, auth?: string, url?: string, disabled?: boolean } | null>}
 */
function resolveRoute(routeKey) {
  return withStore(async () => {
    const items = await readAll()
    const custom = items.find((entry) => entry.id === routeKey)
    const preset = custom ? presets.getPreset(custom.presetId) : presets.getPreset(routeKey)
    if (!preset) return null
    let item = custom
    if (preset.id !== 'custom') {
      const currentId = await readCurrentId()
      item = items.find((entry) => entry.id === currentId && entry.presetId === preset.id) ||
        items.find((entry) => entry.presetId === preset.id)
    }
    if (!item) return null
    if (routeFor(item, preset) !== 'gateway') return { disabled: true }
    const format = apiFormatFor(item, preset)
    const wire = wireForFormat(format)
    const auth = preset.auth === 'cli'
      ? (preset.id === 'codex' ? 'codex' : 'grok')
      : 'key'
    const url = wireUrlFor(item, preset, format)
    return url ? { wire, auth, url } : { disabled: true }
  })
}

/**
 * 閘道要用哪一組登入帳號。挑法跟 `keyForPreset` 一樣：
 * 先看目前選用的那一筆是不是這家，不是就挑第一筆有綁帳號的。
 * 回空字串＝沒綁，閘道會退回讀已安裝 CLI 的憑證。
 *
 * @param {string} presetId
 * @returns {Promise<string>}
 */
function accountForPreset(presetId) {
  return withStore(async () => {
    const items = await readAll()
    const currentId = await readCurrentId()
    const current = items.find((item) => item.id === currentId)
    if (current?.presetId === presetId && current.oauthAccountId) return current.oauthAccountId
    return items.find((item) => item.presetId === presetId && item.oauthAccountId)?.oauthAccountId || ''
  })
}

/**
 * 某個登入帳號被刪掉時，把綁著它的供應商解綁——留著一個指向不存在帳號的 id，
 * 症狀會是「切過去之後莫名其妙說找不到登入帳號」。
 * @param {string} accountId
 */
function unbindAccount(accountId) {
  return withStore(async () => {
    const items = await readAll()
    if (!items.some((item) => item.oauthAccountId === accountId)) return true
    await writeAll(items.map((item) => (
      item.oauthAccountId === accountId ? { ...item, oauthAccountId: '' } : item
    )))
    return true
  })
}

/**
 * 切換：把這一筆的 env 寫進 `~/.claude/settings.json`。
 * @param {string} id
 * @param {{ gateway?: { baseUrl: string, apiKey: string } }} [options]
 */
function activate(id, options = {}) {
  return withStore(async () => {
    const items = await readAll()
    const item = items.find((entry) => entry.id === id)
    if (!item) {
      const error = new Error('NOT_FOUND')
      error.code = 'NOT_FOUND'
      error.userMessage = '找不到這個供應商'
      throw error
    }
    const env = resolveEnv(item, options.gateway)
    const result = claudeSettings.applyEnv(env)
    const s = await getStore()
    s.set('currentId', item.id)
    return { id: item.id, path: result.path, backup: Boolean(result.backup) }
  })
}

module.exports = {
  MAX_PROVIDERS,
  MODEL_KEYS,
  MODEL_FIELDS,
  AUTH_FIELDS,
  API_FORMATS,
  apiFormatFor,
  wireForFormat,
  wireUrlFor,
  routeFor,
  routeKeyFor,
  resolveRoute,
  // MCP 的停用清單借用同一個 electron-store 實例（同一份 cc-providers.json）
  getStore,
  sanitizeAll,
  resolveEnv,
  detectActiveId,
  configure,
  list,
  getRaw,
  create,
  update,
  remove,
  reorder,
  activate,
  keyForPreset,
  accountForPreset,
  unbindAccount
}
