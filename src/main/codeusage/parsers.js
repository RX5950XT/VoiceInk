'use strict'

/**
 * 各家 CLI session 記錄的逐行解析（Main Process，純函式，可 node 直測）。
 *
 * 三家的記錄都是 JSONL，但形狀完全不同，而且各有一個很容易搞錯的地方：
 *
 * - **Claude Code**：`assistant` 訊息的 `message.usage`。同一則訊息會因為串流而
 *   重複出現好幾行（`requestId` 相同），要靠 id 去重，否則 token 會被算好幾倍。
 * - **Codex**：`event_msg` / `token_count` 帶兩份數字——`total_token_usage` 是**累計**、
 *   `last_token_usage` 是**這一輪**。要加的是後者；把累計值逐行相加會得到天文數字。
 * - **Grok**：`turn_completed` 的 `usage` 是**這一輪的總量**（不是累計快照），直接相加就對。
 *   它還自帶 `costUsdTicks`（1 USD = 1e9 ticks）與逐模型細目，不必靠單價表。
 *
 * 每個解析器吃「一行字串 ＋ 一份跨行狀態」，回傳 0 到多筆標準用量事件：
 * `{ ts, model, input, output, reasoning, cacheRead, cacheWrite, requests, costUsd }`
 */

/**
 * 一行的長度上限。**本機實測有 4.2MB 的單行**（貼了整份大檔的工具結果），舊的 2MB
 * 上限會把那一行連同它的 `usage` 一起丟掉——那是真的少算，而且完全看不出來。
 * 留一個上限只是防「整個檔案就是一行」的異常；不含 `"usage"` 的行在 parse 之前就被
 * 字串比對擋掉了，所以放寬不會變慢。
 */
const MAX_LINE = 16 * 1024 * 1024
/** Grok 的花費單位：1 USD = 1e9 ticks */
const USD_TICKS = 1e9

/**
 * @typedef {object} UsageEvent
 * @property {number} ts 毫秒
 * @property {string} model 原始 model id（正規化交給 pricing）
 * @property {number} input
 * @property {number} output
 * @property {number} reasoning
 * @property {number} cacheRead
 * @property {number} cacheWrite 5 分鐘快取寫入
 * @property {number} [cacheWrite1h] 1 小時快取寫入（價錢是 5m 的 1.6 倍，要分開記）
 * @property {number} requests
 * @property {number | null} costUsd 來源自己算好的花費；沒有就 null
 */

/**
 * @param {unknown} value
 * @returns {number}
 */
function num(value) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

/**
 * @param {unknown} value ISO 字串或毫秒／秒的數字
 * @returns {number} 毫秒；解析不出來回 0
 */
function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // 10 位數是秒、13 位數是毫秒
    return value > 1e11 ? value : value * 1000
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

/**
 * 建一個新的跨行狀態。每個檔案一份。
 * @returns {{ seen: Set<string>, model: string, replay: boolean }}
 */
function newState() {
  return { seen: new Set(), model: '', replay: false }
}

// ===== Claude Code =====

/**
 * `~/.claude/projects/<專案>/<session>.jsonl`
 *
 * 只有 `type: 'assistant'` 的行帶 `message.usage`。串流過程中同一則訊息會被寫好幾次，
 * `message.id`（或 `requestId`）相同 → 用它去重，只留第一次看到的那一筆。
 *
 * @param {string} line
 * @param {{ seen: Set<string>, model: string }} state
 * @returns {UsageEvent[]}
 */
function parseClaudeLine(line, state) {
  if (line.length > MAX_LINE) return []
  // 先用字串比對擋掉九成以上的行，比 JSON.parse 便宜非常多
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return []
  let row
  try {
    row = JSON.parse(line)
  } catch {
    return []
  }
  if (row?.type !== 'assistant') return []
  const usage = row.message?.usage
  if (!usage || typeof usage !== 'object') return []

  // Claude Code 遇到本機錯誤／中斷時會補一則 `model: "<synthetic>"` 的假訊息，
  // 那不是真的呼叫，算進去會在模型分佈多出一條看不懂的列（實測資料裡真的有）
  const model = String(row.message?.model || 'unknown')
  if (model.startsWith('<')) return []

  const id = String(row.message?.id || row.requestId || row.uuid || '')
  if (id) {
    if (state.seen.has(id)) return []
    state.seen.add(id)
  }

  const output = num(usage.output_tokens)
  // 快取寫入分兩種存活時間，**價錢不一樣**（5m = input × 1.25、1h = input × 2）。
  // `cache_creation` 這個細目在新版才有；沒有的話整包當 5m（舊版只支援 5m）
  const write1h = num(usage.cache_creation?.ephemeral_1h_input_tokens)
  const writeTotal = num(usage.cache_creation_input_tokens)
  return [{
    ts: toMs(row.timestamp),
    model,
    input: num(usage.input_tokens),
    output,
    // thinking token 已經含在 output_tokens 裡，另外記只是給人看，不重複計價
    reasoning: num(usage.output_tokens_details?.thinking_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite: Math.max(0, writeTotal - write1h),
    cacheWrite1h: write1h,
    requests: 1,
    costUsd: null
  }]
}

// ===== Codex =====

/**
 * `~/.codex/{sessions,archived_sessions}/<年>/<月>/<日>/rollout-*.jsonl`
 *
 * 模型名在 `turn_context.payload.model`（舊版只有 `session_meta`），token 在
 * `event_msg` / `token_count` 的 `info.last_token_usage`。
 *
 * **子代理／fork 的 rollout 開頭是「母 thread 整份歷史的重播」**：`session_meta` 帶
 * `forked_from_id`／`parent_thread_id` 時，接下來幾千行都是從母檔複製過來的舊記錄，
 * 而且每一行都蓋上 fork 當下的時間戳。照收的話同一批用量會被算第二次（實測本機 60 份
 * 子代理檔重播出 7.8 萬筆假請求，全部塞進 fork 那一個小時的桶子裡），而重播段落沒有
 * `turn_context` 所以連模型都讀不到 → 全記成 `unknown`，看起來像「有一顆模型沒設單價」。
 * 重播的結束點就是第一個 `turn_context`（＝新的一輪真的開始了）。
 *
 * @param {string} line
 * @param {{ seen: Set<string>, model: string, replay: boolean }} state
 * @returns {UsageEvent[]}
 */
function parseCodexLine(line, state) {
  if (line.length > MAX_LINE) return []
  // 只有這三種行有東西可讀。**`session_meta` 不能靠 `"model"` 過濾**：fork 的那份
  // 沒有 `model` 欄位（只有 `model_provider`），會在這裡就被擋掉 → 重播標記設不起來
  if (!line.includes('"token_count"')
    && !line.includes('"turn_context"')
    && !line.includes('"session_meta"')) return []
  let row
  try {
    row = JSON.parse(line)
  } catch {
    return []
  }

  // 記住目前這一輪用的是哪顆模型（同一個 session 中途可以換）
  if (row?.type === 'turn_context' || row?.type === 'session_meta') {
    state.replay = row.type === 'session_meta'
      && !!(row.payload?.forked_from_id || row.payload?.parent_thread_id)
    const model = row.payload?.model
    if (typeof model === 'string' && model) state.model = model
    return []
  }

  if (row?.type !== 'event_msg' || row.payload?.type !== 'token_count') return []
  // 母檔已經算過這一批了
  if (state.replay) return []
  // last_token_usage 才是這一輪的量；total_token_usage 是累計，逐行相加會爆掉
  const usage = row.payload?.info?.last_token_usage
  if (!usage || typeof usage !== 'object') return []
  if (!num(usage.input_tokens) && !num(usage.output_tokens)) return []

  return [{
    ts: toMs(row.timestamp),
    model: state.model || 'unknown',
    // input_tokens 已含 cached_input_tokens，扣掉才不會重複計價
    input: Math.max(0, num(usage.input_tokens) - num(usage.cached_input_tokens)),
    output: num(usage.output_tokens),
    reasoning: num(usage.reasoning_output_tokens),
    cacheRead: num(usage.cached_input_tokens),
    cacheWrite: num(usage.cache_write_input_tokens),
    requests: 1,
    costUsd: null
  }]
}

// ===== Grok =====

/**
 * `~/.grok/{sessions,archived_sessions}/<編碼過的 cwd>/<session>/updates.jsonl`
 *
 * `turn_completed` 的 `usage` 是這一輪的總量，還帶 `modelUsage` 逐模型細目與
 * `costUsdTicks`。有細目就照細目拆開記，沒有就記整輪。
 *
 * @param {string} line
 * @param {{ seen: Set<string>, model: string }} state
 * @returns {UsageEvent[]}
 */
function parseGrokLine(line, state) {
  if (line.length > MAX_LINE) return []
  if (!line.includes('"turn_completed"')) return []
  let row
  try {
    row = JSON.parse(line)
  } catch {
    return []
  }
  const update = row?.params?.update
  if (update?.sessionUpdate !== 'turn_completed') return []
  const usage = update.usage
  if (!usage || typeof usage !== 'object') return []

  // 同一輪可能因為重播被寫兩次；prompt_id 是這一輪的識別
  const id = String(update.prompt_id || row.params?._meta?.eventId || '')
  if (id) {
    if (state.seen.has(id)) return []
    state.seen.add(id)
  }

  const ts = toMs(row.timestamp) || toMs(row.params?._meta?.agentTimestampMs)
  const detail = usage.modelUsage && typeof usage.modelUsage === 'object' ? usage.modelUsage : null
  const toEvent = (model, part) => ({
    ts,
    model,
    // inputTokens 含 cachedReadTokens，扣掉避免重複
    input: Math.max(0, num(part.inputTokens) - num(part.cachedReadTokens)),
    output: num(part.outputTokens),
    reasoning: num(part.reasoningTokens),
    cacheRead: num(part.cachedReadTokens),
    cacheWrite: num(part.cacheCreationTokens),
    requests: num(part.modelCalls) || 1,
    costUsd: Number.isFinite(Number(part.costUsdTicks)) ? Number(part.costUsdTicks) / USD_TICKS : null
  })

  if (detail) {
    const events = Object.entries(detail)
      .filter(([, part]) => part && typeof part === 'object')
      .map(([model, part]) => toEvent(model, part))
    if (events.length) return events
  }
  return [toEvent('unknown', usage)]
}

module.exports = {
  MAX_LINE,
  USD_TICKS,
  newState,
  toMs,
  parseClaudeLine,
  parseCodexLine,
  parseGrokLine
}
