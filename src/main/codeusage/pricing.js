'use strict'

/**
 * 模型 id 正規化與單價表（Main Process，純函式，可 node 直測）。
 *
 * **為什麼要正規化**：同一顆模型在不同來源的 id 不一樣——Claude Code 記
 * `claude-opus-5`、OpenRouter 記 `anthropic/claude-opus-5`、Grok CLI 記
 * `grok-4.5-build`、有些還帶日期後綴 `-20260101`。不合併的話統計會把同一顆模型
 * 拆成好幾條，金額也各算各的。
 *
 * **單價只放我們真的查證過的**。查不到的一律 `null`，UI 顯示「未設單價」讓使用者自己填，
 * **不要隨便填一個數字**：那會算出一個看起來很像真的、但完全錯的金額，比空著更糟。
 * Grok 與 OpenCode 的記錄本來就自帶花費，那兩家不靠這張表。
 */

/** 單價的單位：每 100 萬 token 的美金 */
const PER_TOKENS = 1_000_000

/**
 * 正規化規則的版本。**改了 `normalizeModel` 或 `ALIASES` 就要 +1。**
 *
 * 桶子存的是「正規化後」的模型名，所以規則改了之後舊桶子還是掛在舊 key 上，
 * 增量掃描永遠碰不到它們。版本一對不上，`index.js` 的 sync 就自己整份重讀一次
 * ——這是唯一的修復路徑（UI 上沒有「全部重讀」那顆鈕）。單價表本身改動**不必**動這個版本
 * （金額是每次 stats 現算的）。
 *
 * v4：既有的壞桶子只能靠這個版本號自己修——
 * 舊版增量掃描把 Codex 的模型記成 `unknown`（實測 7.8 萬筆算不出錢），那批桶子
 * 還掛在使用者的 code-usage.json 裡。
 *
 * v5：`isJunkModel` 開始擋「一兩個字元的假 id」（實測有代理往 Claude Code 的記錄寫了
 * `model: "m"`），既有的那些桶子要靠這個版本號重讀才會消失。
 *
 * v6：Codex 子代理／fork 的 rollout 開頭會重播母 thread 的整份歷史，舊版把那些
 * 當成新用量收下來（實測 7.8 萬筆假請求，全記成 `unknown`）。桶子已經落盤，
 * 一樣只能靠這個版本號整份重讀才會消失。
 */
const RULES_VERSION = 6

/**
 * @typedef {object} Price
 * @property {number} input
 * @property {number} output
 * @property {number} [cacheWrite] 5 分鐘快取寫入；省略時用 input × 1.25（Anthropic 的公開規則）
 * @property {number} [cacheWrite1h] 1 小時快取寫入；省略時用 cacheWrite × 1.6（＝input × 2）
 * @property {number} [cacheRead] 快取讀取；省略時用 input × 0.1
 */

/**
 * 內建單價（USD / 1M tokens）。`null`＝我們沒有查證過的公開報價，等使用者自己填。
 *
 * **快取價要寫出來**：Claude Code 這種長對話有九成以上的 token 走快取
 * （實測本機記錄：cache read 是一般 input 的數百倍），只填 input／output 的話
 * 金額會整個算錯。Anthropic 的規則是 read = input × 0.1、5m write = input × 1.25、
 * **1h write = input × 2**——本機記錄實測寫的幾乎都是 1h，用 5m 價算會低估三成多。
 * @type {Record<string, Price | null>}
 */
const BUILTIN_PRICES = {
  // Anthropic 官方公開報價（2026-09 查證）
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, cacheWrite1h: 20 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  'claude-opus-4.8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  'claude-opus-4.7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  'claude-opus-4.6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, cacheWrite1h: 4 },
  'claude-sonnet-4.6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
  'claude-sonnet-4.5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
  'claude-haiku-4.5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2 },
  // OpenAI（developers.openai.com/api/docs/pricing，2026-09 查證；cacheRead 是官方的 cached input）。
  // 自動快取不另收寫入費，所以 cacheWrite 是 0（不是「沒填」）
  'gpt-5.6-sol': { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 0, cacheWrite1h: 0 },
  'gpt-5.6-terra': { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0, cacheWrite1h: 0 },
  'gpt-5.6-luna': { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0, cacheWrite1h: 0 },
  'gpt-5.5': { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0, cacheWrite1h: 0 },
  'gpt-5.4-mini': { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0, cacheWrite1h: 0 },
  // xAI（Grok CLI 的記錄自帶花費，這裡只給沒帶的那些路徑用）。同樣是自動快取，無寫入費
  'grok-4.6': { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0, cacheWrite1h: 0 },
  'grok-4.5': { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 0, cacheWrite1h: 0 },
  'grok-4.3': { input: 1.25, output: 2.5, cacheRead: 0.125, cacheWrite: 0, cacheWrite1h: 0 },
  // Google（ai.google.dev/gemini-api/docs/pricing，2026-09 查證；
  // 3.7／3.6 Flash 現在是introductory 價，2027-01-01 起翻倍）。
  // 顯式快取是按「存多久」收錢、不是按寫入 token，所以這裡的寫入價是 0
  'gemini-3.7-flash': { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0, cacheWrite1h: 0 },
  'gemini-3.6-flash': { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0, cacheWrite1h: 0 },
  'gemini-3.5-flash': { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0, cacheWrite1h: 0 },
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.5, cacheRead: 0.025, cacheWrite: 0, cacheWrite1h: 0 },
  'gemini-3.1-pro': { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0, cacheWrite1h: 0 },
  // Z.ai（docs.z.ai/guides/overview/pricing，2026-09 查證）。快取只收讀取（cached input），
  // 寫入不另外計費 → 0 不是「沒填」。經 Claude Code 打的話 id 是 `z-ai/glm-5.3`，前綴會被剝掉
  'glm-5.3': { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0, cacheWrite1h: 0 },
  'glm-5.3-flash': { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0, cacheWrite1h: 0 },
  // Antigravity 的 `gemini-pro-agent` 就是 Gemini 3.1 Pro 的 agent 檔位，
  // 沒有另外的公開報價 → 直接套 3.1 Pro 的價
  'gemini-pro-agent': { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0, cacheWrite1h: 0 }
}

/**
 * 正規化後仍然對不上、但實際是同一顆的別名。
 * key 是正規化結果，value 是要合併過去的正規化結果。
 * @type {Record<string, string>}
 */
const ALIASES = {
  // Grok CLI 記的是端點別名，不是模型本身
  'grok-4.5-build': 'grok-4.5',
  'grok-4.6-build': 'grok-4.6',
  // Codex 反代的模型名
  'gpt-5.6-sol-high': 'gpt-5.6-sol',
  'gpt-5.6-sol-low': 'gpt-5.6-sol'
}

/**
 * 把各來源的模型 id 收斂成同一個 key。
 *
 * 步驟：小寫 → 去掉供應商前綴（`anthropic/`、`xai/`）→ 去掉日期後綴（`-20260101`）
 * → 去掉 `-latest`／`-preview` → 查別名表。
 *
 * @param {unknown} raw
 * @returns {string} 正規化後的 id；空輸入回 `'unknown'`
 */
function normalizeModel(raw) {
  if (typeof raw !== 'string') return 'unknown'
  let id = raw.trim().toLowerCase()
  if (!id) return 'unknown'
  // 供應商前綴：`anthropic/claude-opus-5`、`openai/gpt-5.6-sol`
  const slash = id.lastIndexOf('/')
  if (slash >= 0) id = id.slice(slash + 1)
  // 日期後綴：`claude-opus-5-20260101`
  id = id.replace(/-\d{8}$/, '')
  // 通道後綴
  id = id.replace(/-(latest|preview|beta)$/, '')
  // 思考檔位是同一顆模型的不同設定（`claude-opus-4-6-thinking`、`gemini-3.7-flash-high`），
  // 價錢一樣，要合起來算。**`lite` 不在這裡**：Flash-Lite 是另一顆模型，
  // 價格只有 Flash 的三分之一，剝掉就會把它算成貴的那顆（實測 732 筆全被算錯）
  id = id.replace(/-thinking$/, '')
  if (id.startsWith('gemini')) id = id.replace(/-(extra-low|low|medium|high|tiered)$/, '')
  // 「大版本-小版本」寫法收斂成小數點：Claude Code 實際寫的是 `claude-haiku-4-5`，
  // 但公開報價與別的來源都寫 `claude-haiku-4.5`，不轉的話這顆永遠對不到單價（實測踩過）
  id = id.replace(/-(\d+)-(\d+)$/, '-$1.$2')
  return ALIASES[id] || id || 'unknown'
}

/**
 * 這個 id 根本不是模型名嗎。
 *
 * 實測有代理往 Claude Code 的記錄寫了 `model: "m"`（2 次請求、4 個 token），
 * 它會永遠掛在「未設單價」那一列上，而使用者根本填不了單價——沒有這顆模型。
 *
 * **判準是「不是模型名」，不是「我不認得」**：真實的模型 id 沒有一兩個字元的，
 * 而 `unknown`（真的有用量、只是讀不到是哪顆）要留著，丟掉等於少算。
 *
 * @param {string} model 已正規化的 id
 * @returns {boolean}
 */
function isJunkModel(model) {
  return /^[a-z0-9]{1,2}$/.test(String(model || ''))
}

/**
 * 取單價：使用者自訂優先，其次內建表。
 * @param {string} model 已正規化的 id
 * @param {Record<string, Price>} [custom] 使用者自訂單價
 * @returns {Price | null}
 */
function priceFor(model, custom = {}) {
  const own = custom && custom[model]
  if (own && Number.isFinite(own.input) && Number.isFinite(own.output)) return own
  return BUILTIN_PRICES[model] || null
}

/**
 * 算一筆用量的錢。**沒有單價就回 null，不回 0**——0 會被當成「免費」加進總額，
 * 使用者看到的總花費就會少一截而且完全看不出來。
 *
 * @param {{ input: number, output: number, cacheRead?: number, cacheWrite?: number,
 *           cacheWrite1h?: number }} usage
 * @param {Price | null} price
 * @returns {number | null}
 */
function costOf(usage, price) {
  if (!price) return null
  const cacheWrite = Number.isFinite(price.cacheWrite) ? price.cacheWrite : price.input * 1.25
  // 1h 快取是 5m 的 1.6 倍（input × 2 ÷ input × 1.25）。使用者只填得起一格 5m 價時用它推
  const cacheWrite1h = Number.isFinite(price.cacheWrite1h) ? price.cacheWrite1h : cacheWrite * 1.6
  const cacheRead = Number.isFinite(price.cacheRead) ? price.cacheRead : price.input * 0.1
  const total = (usage.input || 0) * price.input
    + (usage.output || 0) * price.output
    + (usage.cacheWrite || 0) * cacheWrite
    + (usage.cacheWrite1h || 0) * cacheWrite1h
    + (usage.cacheRead || 0) * cacheRead
  return total / PER_TOKENS
}

/**
 * 使用者自訂單價的正規化（來自 IPC，一律不可信）。
 * @param {unknown} raw
 * @returns {Record<string, Price>}
 */
function sanitizeCustomPrices(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  /** @type {Record<string, Price>} */
  const out = {}
  let count = 0
  for (const [key, value] of Object.entries(raw)) {
    if (count >= 200) break
    const model = normalizeModel(key)
    if (model === 'unknown' || !value || typeof value !== 'object') continue
    const num = (field) => {
      const n = Number(value[field])
      return Number.isFinite(n) && n >= 0 && n <= 10000 ? n : undefined
    }
    const input = num('input')
    const output = num('output')
    if (input === undefined || output === undefined) continue
    /** @type {Price} */
    const price = { input, output }
    const cacheWrite = num('cacheWrite')
    const cacheWrite1h = num('cacheWrite1h')
    const cacheRead = num('cacheRead')
    if (cacheWrite !== undefined) price.cacheWrite = cacheWrite
    if (cacheWrite1h !== undefined) price.cacheWrite1h = cacheWrite1h
    if (cacheRead !== undefined) price.cacheRead = cacheRead
    out[model] = price
    count++
  }
  return out
}

/**
 * 給 UI 列「哪些模型有單價、哪些還沒填」。
 * @param {Record<string, Price>} [custom]
 * @returns {Array<{ model: string, price: Price | null, source: 'custom' | 'builtin' | 'none' }>}
 */
function priceList(custom = {}) {
  const models = new Set([...Object.keys(BUILTIN_PRICES), ...Object.keys(custom)])
  return [...models].sort().map((model) => {
    if (custom[model]) return { model, price: custom[model], source: 'custom' }
    const builtin = BUILTIN_PRICES[model]
    return { model, price: builtin || null, source: builtin ? 'builtin' : 'none' }
  })
}

/**
 * 存在檔案裡的規則版本跟現在的對不上嗎（對不上就要整份重讀）。
 * @param {unknown} storedVersion
 * @returns {boolean}
 */
function needsFullRescan(storedVersion) {
  return Number(storedVersion) !== RULES_VERSION
}

module.exports = {
  PER_TOKENS,
  RULES_VERSION,
  needsFullRescan,
  BUILTIN_PRICES,
  ALIASES,
  normalizeModel,
  isJunkModel,
  priceFor,
  costOf,
  sanitizeCustomPrices,
  priceList
}
