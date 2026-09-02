/**
 * VoiceInk - 語音輸入的紀錄與個人字典（Main Process）
 *
 * 獨立於設定用的 electron-store，寫在 `<userData>/dictations.json`：
 * 設定那顆有 key allowlist，不適合塞會一直長大的紀錄。
 * 跟 chats.json 同一套做法——整檔讀寫，所以上限寫死，並且所有讀寫走同一條 chain。
 */

const text = require('./text')

/** 最多留幾筆轉錄紀錄（整檔讀寫，沒上限就會越存越慢） */
const MAX_RECORDS = 500
/** 單筆文字上限（ASR 一次講不了這麼多；超過多半是壞掉的迴圈輸出） */
const MAX_TEXT = 8000

/** @type {import('electron-store') | null} */
let store = null
/** @type {Promise<import('electron-store')> | null} */
let storeReady = null
let chain = Promise.resolve()

/**
 * @template T
 * @param {() => Promise<T>|T} fn
 * @returns {Promise<T>}
 */
function withStore(fn) {
  const run = chain.then(fn, fn)
  chain = run.then(() => {}, () => {})
  return run
}

async function getStore() {
  if (store) return store
  if (!storeReady) {
    storeReady = import('electron-store').then((mod) => {
      if (!store) store = new mod.default({ name: 'dictations' })
      return store
    })
  }
  return storeReady
}

/**
 * @returns {string}
 */
function newId() {
  return `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function clip(value) {
  return typeof value === 'string' ? value.slice(0, MAX_TEXT) : ''
}

/**
 * 讀檔後正規化：檔案可能被手改或版本不符
 * @param {unknown} raw
 */
function sanitizeRecords(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const final = clip(item.text)
    if (!final) continue
    out.push({
      id: typeof item.id === 'string' && item.id ? item.id : newId(),
      at: Number.isFinite(item.at) ? Number(item.at) : Date.now(),
      raw: clip(item.raw),
      text: final,
      durationMs: Number.isFinite(item.durationMs) ? Number(item.durationMs) : 0,
      asr: typeof item.asr === 'string' ? item.asr.slice(0, 80) : '',
      llm: typeof item.llm === 'string' ? item.llm.slice(0, 80) : '',
      inserted: item.inserted === true
    })
  }
  return out.slice(-MAX_RECORDS)
}

/**
 * @param {unknown} raw
 */
function sanitizeDictionary(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const item of raw) {
    const from = typeof item?.from === 'string' ? item.from.trim() : ''
    const to = typeof item?.to === 'string' ? item.to.trim() : ''
    if (!from || !to || from === to || seen.has(from)) continue
    if (!text.isLearnableTerm(from) || !text.isLearnableTerm(to)) continue
    seen.add(from)
    out.push({
      from,
      to,
      count: Number.isFinite(item.count) ? Number(item.count) : 1,
      active: item.active === true,
      // 手動加的不會被自動學詞的反向證據扣分（見 text.mergeLearned）
      manual: item.manual === true,
      at: Number.isFinite(item.at) ? Number(item.at) : Date.now()
    })
  }
  return out.slice(0, text.MAX_DICT_ENTRIES)
}

/**
 * 最新的在前
 * @param {{ limit?: number }} [query]
 */
async function listRecords(query = {}) {
  const s = await getStore()
  const limit = Math.max(1, Math.min(MAX_RECORDS, Number(query?.limit) || 100))
  const records = sanitizeRecords(s.get('records', []))
  return records.slice(-limit).reverse()
}

/**
 * @param {{ raw?: string, text?: string, durationMs?: number, asr?: string, llm?: string, inserted?: boolean }} record
 */
async function addRecord(record) {
  return withStore(async () => {
    const s = await getStore()
    const records = sanitizeRecords(s.get('records', []))
    const entry = {
      id: newId(),
      at: Date.now(),
      raw: clip(record?.raw),
      text: clip(record?.text),
      durationMs: Number.isFinite(record?.durationMs) ? Number(record.durationMs) : 0,
      asr: typeof record?.asr === 'string' ? record.asr.slice(0, 80) : '',
      llm: typeof record?.llm === 'string' ? record.llm.slice(0, 80) : '',
      inserted: record?.inserted === true
    }
    if (!entry.text) return null
    records.push(entry)
    s.set('records', records.slice(-MAX_RECORDS))
    return entry
  })
}

/**
 * @param {string} id
 */
async function removeRecord(id) {
  return withStore(async () => {
    const s = await getStore()
    const records = sanitizeRecords(s.get('records', []))
    const next = records.filter((r) => r.id !== id)
    s.set('records', next)
    return { ok: true, removed: records.length - next.length }
  })
}

async function clearRecords() {
  return withStore(async () => {
    const s = await getStore()
    s.set('records', [])
    return { ok: true }
  })
}

async function listDictionary() {
  const s = await getStore()
  return sanitizeDictionary(s.get('dictionary', []))
}

/**
 * 自動學詞：只累計次數，到門檻才會真的拿去取代
 * @param {Array<{ from: string, to: string }>} pairs
 */
async function learn(pairs) {
  if (!Array.isArray(pairs) || !pairs.length) return []
  return withStore(async () => {
    const s = await getStore()
    const merged = text.mergeLearned(sanitizeDictionary(s.get('dictionary', [])), pairs, Date.now())
    const list = sanitizeDictionary(merged)
    s.set('dictionary', list)
    return list
  })
}

/**
 * 手動新增／修改一筆（手動加的直接啟用：使用者自己打的不需要再觀察）
 * @param {{ from: string, to: string }} entry
 */
async function upsertDictionary(entry) {
  const from = typeof entry?.from === 'string' ? entry.from.trim() : ''
  const to = typeof entry?.to === 'string' ? entry.to.trim() : ''
  if (!from || !to || from === to) return { ok: false, error: 'INVALID' }
  if (!text.isLearnableTerm(from) || !text.isLearnableTerm(to)) return { ok: false, error: 'INVALID' }
  return withStore(async () => {
    const s = await getStore()
    const list = sanitizeDictionary(s.get('dictionary', []))
    const found = list.find((e) => e.from === from)
    if (found) {
      found.to = to
      found.active = true
      found.manual = true
      found.at = Date.now()
    } else {
      list.push({ from, to, count: text.PROMOTE_COUNT, active: true, manual: true, at: Date.now() })
    }
    s.set('dictionary', list.slice(0, text.MAX_DICT_ENTRIES))
    return { ok: true }
  })
}

/**
 * @param {string} from
 */
async function removeDictionary(from) {
  return withStore(async () => {
    const s = await getStore()
    const list = sanitizeDictionary(s.get('dictionary', []))
    const next = list.filter((e) => e.from !== from)
    s.set('dictionary', next)
    return { ok: true, removed: list.length - next.length }
  })
}

module.exports = {
  listRecords,
  addRecord,
  removeRecord,
  clearRecords,
  listDictionary,
  learn,
  upsertDictionary,
  removeDictionary,
  sanitizeRecords,
  sanitizeDictionary,
  MAX_RECORDS
}
