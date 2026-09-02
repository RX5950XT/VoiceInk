'use strict'

/**
 * 五家 AI CLI 的 token 用量統計（Main Process）。
 *
 * 跟「額度」頁不同：那邊看的是**訂閱還剩多少**（官方 API），這裡看的是
 * **本機記錄裡實際用掉多少 token、跑了幾次、大概花多少錢**。
 *
 * 資料一律折成「每小時 × 供應商 × 模型」的桶子存進 `<userData>/code-usage.json`，
 * 原始事件不留（幾十萬筆，留了只是白佔硬碟）。時間範圍是 main 的白名單，
 * renderer 只送 key——跟 `agy/logs.js` 的統計同一套規矩。
 *
 * **這裡不打任何網路**：全部來自本機檔案。
 */

const os = require('os')
const path = require('path')
const pricing = require('./pricing')
const parsers = require('./parsers')
const scan = require('./scan')
const dbSources = require('./db-sources')

const HOUR_MS = 3600_000
const DAY_MS = 24 * HOUR_MS
/** 桶子保留多久 */
const RETENTION_DAYS = 90
/** 一次 stats 最多回幾格序列 */
const MAX_SERIES_POINTS = 96
/** 模型分佈最多回幾筆 */
const MAX_MODEL_ROWS = 12

/**
 * 五家供應商。`key` 同時是桶子的欄位值與 UI 的識別。
 * @type {ReadonlyArray<{ key: string, label: string, kind: 'jsonl' | 'sqlite', note?: string }>}
 */
const PROVIDERS = Object.freeze([
  { key: 'claude', label: 'Claude Code', kind: 'jsonl' },
  { key: 'codex', label: 'Codex', kind: 'jsonl' },
  { key: 'grok', label: 'Grok Build', kind: 'jsonl' },
  { key: 'opencode', label: 'OpenCode', kind: 'sqlite' },
  {
    key: 'antigravity',
    label: 'Antigravity',
    kind: 'sqlite',
    // 這條一定要顯示在 UI 上，否則使用者會以為數字是完整的
    note: 'Antigravity 本機沒有 session 記錄，只統計得到經過本 App 的 AGY 反代那部分。'
  }
])

/** 統計時間範圍白名單（跟 AGY 統計一致） */
const STAT_RANGES = Object.freeze({
  '24h': { hours: 24, bucket: 'hour' },
  '7d': { hours: 24 * 7, bucket: 'day' },
  '30d': { hours: 24 * 30, bucket: 'day' },
  all: { hours: 0, bucket: 'day' }
})

/** @type {{ userDataPath: string, homeDir: string }} */
const paths = { userDataPath: '', homeDir: '' }

/** @type {import('electron-store') | null} */
let store = null
/** @type {Promise<import('electron-store')> | null} */
let storeReady = null
let syncing = null

/**
 * @param {{ userDataPath?: string, homeDir?: string }} options
 */
function configure(options = {}) {
  if (typeof options.userDataPath === 'string') paths.userDataPath = options.userDataPath
  if (typeof options.homeDir === 'string') paths.homeDir = options.homeDir
}

function homeDir() {
  return paths.homeDir || os.homedir()
}

async function getStore() {
  if (store) return store
  if (!storeReady) {
    storeReady = import('electron-store').then((mod) => {
      if (!store) store = new mod.default({ name: 'code-usage' })
      return store
    })
  }
  return storeReady
}

// ===== 桶子 =====

/**
 * 桶子的 key：`小時起點|供應商|正規化模型`
 * @param {number} ts
 * @param {string} provider
 * @param {string} model
 * @returns {string}
 */
function bucketKey(ts, provider, model) {
  return `${Math.floor(ts / HOUR_MS) * HOUR_MS}|${provider}|${model}`
}

/**
 * 把用量事件累進桶子表。
 * @param {Map<string, object>} buckets
 * @param {string} provider
 * @param {object} event
 */
function addEvent(buckets, provider, event) {
  if (!event || !Number.isFinite(event.ts) || event.ts <= 0) return
  const model = pricing.normalizeModel(event.model)
  // 不是模型名的 id（某些代理會寫 `model: "m"`）直接不收：留著只會在
  // 「未設單價」那一列上永遠掛著一顆使用者填不了單價的東西
  if (pricing.isJunkModel(model)) return
  const key = bucketKey(event.ts, provider, model)
  let bucket = buckets.get(key)
  if (!bucket) {
    bucket = {
      ts: Math.floor(event.ts / HOUR_MS) * HOUR_MS,
      provider,
      model,
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      requests: 0,
      // 來源自己算好的花費；沒有的話留 null，之後靠單價表推
      reportedCost: null
    }
    buckets.set(key, bucket)
  }
  bucket.input += event.input || 0
  bucket.output += event.output || 0
  bucket.reasoning += event.reasoning || 0
  bucket.cacheRead += event.cacheRead || 0
  bucket.cacheWrite += event.cacheWrite || 0
  bucket.cacheWrite1h += event.cacheWrite1h || 0
  bucket.requests += event.requests || 0
  if (Number.isFinite(event.costUsd)) {
    bucket.reportedCost = (bucket.reportedCost || 0) + event.costUsd
  }
}

/**
 * 讀檔後正規化：code-usage.json 可能被手改或版本不符。
 * @param {unknown} raw
 * @returns {Map<string, object>}
 */
function loadBuckets(raw) {
  const buckets = new Map()
  if (!Array.isArray(raw)) return buckets
  const cutoff = Date.now() - RETENTION_DAYS * DAY_MS
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const ts = Number(item.ts)
    const provider = String(item.provider || '')
    const model = String(item.model || '')
    if (!Number.isFinite(ts) || ts < cutoff || !provider || !model) continue
    // 舊檔裡已經記進去的假 id（`m` 之類）讀檔時就丟掉，不必等使用者去按重掃
    if (pricing.isJunkModel(model)) continue
    buckets.set(`${ts}|${provider}|${model}`, {
      ts,
      provider,
      model,
      input: Number(item.input) || 0,
      output: Number(item.output) || 0,
      reasoning: Number(item.reasoning) || 0,
      cacheRead: Number(item.cacheRead) || 0,
      cacheWrite: Number(item.cacheWrite) || 0,
      cacheWrite1h: Number(item.cacheWrite1h) || 0,
      requests: Number(item.requests) || 0,
      // **不可以寫成 `Number.isFinite(Number(item.reportedCost))`**：`Number(null)` 是 0，
      // 存進 json 的 `reportedCost: null`（＝這家沒自帶花費）會被讀成「來源說花了 0 元」，
      // `withCost` 就直接回 0 而不去查單價表——症狀是整頁花費恆為 0，而且因為不是 null，
      // 連「未設單價」的警語都不會出現（實測 all 範圍算出 1645 美元，實際 46794 美元）
      reportedCost: typeof item.reportedCost === 'number' && Number.isFinite(item.reportedCost)
        ? item.reportedCost
        : null
    })
  }
  return buckets
}

// ===== 同步 =====

/**
 * 三家 JSONL 來源的定義。路徑固定在 main，renderer 碰不到。
 * @returns {Array<object>}
 */
function jsonlSources() {
  const home = homeDir()
  return [
    {
      provider: 'claude',
      roots: [path.join(home, '.claude', 'projects')],
      match: (name) => name.endsWith('.jsonl'),
      parseLine: parsers.parseClaudeLine,
      newState: parsers.newState
    },
    {
      provider: 'codex',
      roots: [
        path.join(home, '.codex', 'sessions'),
        path.join(home, '.codex', 'archived_sessions')
      ],
      match: (name) => name.endsWith('.jsonl'),
      parseLine: parsers.parseCodexLine,
      newState: parsers.newState
    },
    {
      provider: 'grok',
      roots: [
        path.join(home, '.grok', 'sessions'),
        path.join(home, '.grok', 'archived_sessions')
      ],
      match: (name) => name === 'updates.jsonl',
      parseLine: parsers.parseGrokLine,
      newState: parsers.newState
    }
  ]
}

/**
 * 掃一輪本機記錄。第一次會讀滿 5GB 等級的資料（實測），所以**只在使用者按同步時跑**，
 * 而且同時間只准跑一個。
 *
 * @param {{ onProgress?: (payload: object) => void }} [options]
 * @returns {Promise<object>}
 */
function sync(options = {}) {
  if (syncing) return syncing
  syncing = runSync(options).finally(() => {
    syncing = null
  })
  return syncing
}

/**
 * @param {{ onProgress?: (payload: object) => void }} options
 */
async function runSync(options) {
  const s = await getStore()
  // 正規化規則改過 → 舊桶子掛在舊 key 上，增量掃描永遠碰不到它們。
  // 自己整份重讀一次，不必使用者去按「全部重讀」。
  const fullRescan = pricing.needsFullRescan(s.get('rulesVersion', 0))
  if (fullRescan) await reset()
  const buckets = loadBuckets(s.get('buckets', []))
  const cursors = s.get('cursors', {}) || {}
  const dbCursors = s.get('dbCursors', {}) || {}
  const sinceMs = Date.now() - scan.SCAN_WINDOW_DAYS * DAY_MS
  const report = { providers: {}, scannedBytes: 0 }

  for (const source of jsonlSources()) {
    options.onProgress?.({ provider: source.provider, state: 'scanning' })
    const result = await scan.scanSource(
      source,
      cursors,
      (event) => addEvent(buckets, source.provider, event),
      sinceMs
    )
    report.providers[source.provider] = result
    report.scannedBytes += result.scannedBytes
  }

  // OpenCode：SQL 直接依時間增量，不需要檔案游標
  options.onProgress?.({ provider: 'opencode', state: 'scanning' })
  const opencodeSince = Number(dbCursors.opencode) || (Date.now() - RETENTION_DAYS * DAY_MS)
  const opencodeEvents = dbSources.readOpencode(opencodeSince)
  for (const event of opencodeEvents) addEvent(buckets, 'opencode', event)
  if (opencodeEvents.length) {
    dbCursors.opencode = opencodeEvents[opencodeEvents.length - 1].ts
  }
  report.providers.opencode = { files: 1, events: opencodeEvents.length }

  // Antigravity：只有 AGY 反代日誌
  options.onProgress?.({ provider: 'antigravity', state: 'scanning' })
  const agyDb = paths.userDataPath ? path.join(paths.userDataPath, 'agy-logs.db') : ''
  const agySince = Number(dbCursors.antigravity) || (Date.now() - RETENTION_DAYS * DAY_MS)
  const agyEvents = agyDb ? dbSources.readAntigravity(agySince, agyDb) : []
  for (const event of agyEvents) addEvent(buckets, 'antigravity', event)
  if (agyEvents.length) {
    dbCursors.antigravity = agyEvents[agyEvents.length - 1].ts
  }
  report.providers.antigravity = { files: 1, events: agyEvents.length }

  scan.pruneCursors(cursors)
  const cutoff = Date.now() - RETENTION_DAYS * DAY_MS
  const rows = [...buckets.values()].filter((bucket) => bucket.ts >= cutoff)
  s.set('buckets', rows)
  s.set('cursors', cursors)
  s.set('dbCursors', dbCursors)
  s.set('rulesVersion', pricing.RULES_VERSION)
  s.set('syncedAt', Date.now())

  return { ...report, fullRescan, buckets: rows.length, syncedAt: Date.now() }
}

// ===== 統計 =====

/**
 * 一格（時間桶／模型／供應商）的空累加器。
 *
 * **四種 token 要分開留著**：長對話九成以上的量走快取，只回一個總數的話
 * 使用者看到幾十億 token 完全無從判斷那是真的在打模型還是在讀快取（價差 10 倍）。
 * `tokens` 是四項的總和，圖表的長度還是照它算。
 * @returns {object}
 */
function emptyTotals() {
  return {
    requests: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0
  }
}

/**
 * 把一個桶子累進累加器。5 分鐘與 1 小時的快取寫入在 UI 上合成一項
 * （價錢在 `pricing.costOf` 已經各算各的，這裡只是顯示用）。
 * @param {object} item
 * @param {object} row
 * @returns {object}
 */
function addTotals(item, row) {
  const cacheWrite = (row.cacheWrite || 0) + (row.cacheWrite1h || 0)
  item.requests += row.requests || 0
  item.input += row.input || 0
  item.output += row.output || 0
  item.cacheRead += row.cacheRead || 0
  item.cacheWrite += cacheWrite
  item.tokens += (row.input || 0) + (row.output || 0) + (row.cacheRead || 0) + cacheWrite
  return item
}

/**
 * SQL 只會回「有資料的桶」，直接畫等於把 3 小時的量攤成整條時間軸。
 * 這裡照 `agy/logs.js` 的做法把中間的空格補零。
 *
 * @param {Array<object>} rows
 * @param {number} from
 * @param {number} to
 * @param {'hour'|'day'} bucket
 * @returns {Array<object>}
 */
function fillSeries(rows, from, to, bucket) {
  const step = bucket === 'hour' ? HOUR_MS : DAY_MS
  const start = Math.floor(from / step) * step
  const end = Math.floor(to / step) * step
  const byTs = new Map()
  for (const row of rows) {
    const slot = Math.floor(row.ts / step) * step
    const item = byTs.get(slot) || { ts: slot, ...emptyTotals() }
    addTotals(item, row)
    item.costUsd += row.costUsd || 0
    byTs.set(slot, item)
  }
  const out = []
  const points = Math.min(MAX_SERIES_POINTS, Math.floor((end - start) / step) + 1)
  const first = end - (points - 1) * step
  for (let ts = first; ts <= end; ts += step) {
    out.push(byTs.get(ts) || { ts, ...emptyTotals() })
  }
  return out
}

/**
 * 把桶子加上金額。**沒有單價又沒有來源花費的，`costUsd` 留 null 並記進
 * `uncostedModels`**——填 0 會讓總額少一截而且完全看不出來。
 *
 * @param {object} bucket
 * @param {Record<string, object>} custom
 * @returns {object}
 */
function withCost(bucket, custom) {
  if (Number.isFinite(bucket.reportedCost)) {
    return { ...bucket, costUsd: bucket.reportedCost, costSource: 'reported' }
  }
  const price = pricing.priceFor(bucket.model, custom)
  const cost = pricing.costOf(bucket, price)
  return {
    ...bucket,
    costUsd: cost,
    costSource: cost === null ? 'none' : 'estimated'
  }
}

/**
 * 統計。renderer 只送 range key，小時數與分桶格式由這裡決定。
 * @param {{ range?: string, provider?: string }} [query]
 * @returns {Promise<object>}
 */
async function stats(query = {}) {
  const s = await getStore()
  const custom = pricing.sanitizeCustomPrices(s.get('customPrices', {}))
  const rangeKey = Object.prototype.hasOwnProperty.call(STAT_RANGES, query.range)
    ? query.range
    : '7d'
  const range = STAT_RANGES[rangeKey]
  const to = Date.now()
  const from = range.hours ? to - range.hours * HOUR_MS : 0

  const all = loadBuckets(s.get('buckets', []))
  const providerFilter = PROVIDERS.some((item) => item.key === query.provider)
    ? query.provider
    : ''

  const rows = [...all.values()]
    .filter((bucket) => bucket.ts >= from && (!providerFilter || bucket.provider === providerFilter))
    .map((bucket) => withCost(bucket, custom))

  const summary = {
    requests: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    costUsd: 0,
    uncostedRequests: 0
  }
  const byModel = new Map()
  const byProvider = new Map()
  const uncosted = new Set()

  for (const row of rows) {
    summary.requests += row.requests
    summary.input += row.input
    summary.output += row.output
    summary.reasoning += row.reasoning
    summary.cacheRead += row.cacheRead
    summary.cacheWrite += row.cacheWrite
    summary.cacheWrite1h += row.cacheWrite1h
    if (row.costUsd === null) {
      summary.uncostedRequests += row.requests
      uncosted.add(row.model)
    } else {
      summary.costUsd += row.costUsd
    }

    for (const [map, key] of [[byModel, row.model], [byProvider, row.provider]]) {
      const item = map.get(key) || { key, ...emptyTotals(), uncosted: false }
      addTotals(item, row)
      if (row.costUsd === null) item.uncosted = true
      else item.costUsd += row.costUsd
      map.set(key, item)
    }
  }

  const seriesFrom = from || (rows.length ? Math.min(...rows.map((row) => row.ts)) : to)
  return {
    range: rangeKey,
    bucket: range.bucket,
    from: seriesFrom,
    to,
    syncedAt: Number(s.get('syncedAt', 0)) || 0,
    summary,
    series: fillSeries(rows, seriesFrom, to, range.bucket),
    models: [...byModel.values()].sort((a, b) => b.tokens - a.tokens).slice(0, MAX_MODEL_ROWS),
    providers: PROVIDERS.map((item) => ({
      key: item.key,
      label: item.label,
      note: item.note || '',
      ...(byProvider.get(item.key) || { ...emptyTotals(), uncosted: false })
    })),
    uncostedModels: [...uncosted].sort(),
    prices: pricing.priceList(custom)
  }
}

/**
 * 存使用者自訂單價。
 * @param {unknown} raw
 */
async function savePrices(raw) {
  const s = await getStore()
  const clean = pricing.sanitizeCustomPrices(raw)
  s.set('customPrices', clean)
  return pricing.priceList(clean)
}

/** 重新掃描：把游標清掉，下一次同步從頭讀 */
async function reset() {
  const s = await getStore()
  s.set('buckets', [])
  s.set('cursors', {})
  s.set('dbCursors', {})
  s.set('syncedAt', 0)
  return true
}

module.exports = {
  PROVIDERS,
  STAT_RANGES,
  RETENTION_DAYS,
  HOUR_MS,
  DAY_MS,
  configure,
  bucketKey,
  addEvent,
  loadBuckets,
  fillSeries,
  withCost,
  sync,
  stats,
  savePrices,
  reset
}
