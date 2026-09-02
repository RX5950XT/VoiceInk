'use strict'

/**
 * JSONL session 記錄的增量掃描（Main Process）。
 *
 * 本機這三家加起來是 **5 GB 等級**（實測：Codex 4.2GB／Claude 543MB／Grok 444MB 都在 90 天內），
 * 每次同步整份重讀不可行。所以：
 *
 * 1. **只看保留期內修改過的檔案**（`SCAN_WINDOW_DAYS`）。
 * 2. **每個檔案記一個位移游標**，下次只從上次讀到的地方往後讀。JSONL 是附加寫入，
 *    所以位移永遠有效；檔案變小（Grok 的 rewind 會截斷）就整份重讀。
 * 3. **逐行串流**，不把整個檔案讀進記憶體；解析器自己會先用字串比對擋掉九成的行。
 *
 * 掃描結果不留原始事件，直接折成「每小時 × 供應商 × 模型」的桶子——原始事件有幾十萬筆，
 * 桶子只有幾千筆，存成 JSON 也才 1～2MB。
 */

const fs = require('fs')
const path = require('path')
const readline = require('readline')

/** 只掃這麼多天內修改過的檔案 */
const SCAN_WINDOW_DAYS = 90
/**
 * 單一檔案的讀取上限。**不能設太小**：讀取是逐行串流、不佔記憶體，而超過上限的檔案
 * 會被整個跳過——本機實測就有一個 50MB 以上的 Claude session，那一整份用量憑空消失
 * 而且畫面上看不出來（使用者回報「統計好像少了」）。這條只是防「資料夾裡混進奇怪的大檔」。
 */
const MAX_FILE_BYTES = 1024 * 1024 * 1024
/** 一次掃描最多處理幾個檔案（防止資料夾異常膨脹時卡住 UI） */
const MAX_FILES = 4000

/**
 * 遞迴找檔案。**不跟隨符號連結**（Grok 的 session 目錄實際遇過連結成環）。
 *
 * @param {string} dir
 * @param {(name: string) => boolean} match
 * @param {number} sinceMs 只收這個時間之後修改過的
 * @param {string[]} out
 * @param {number} depth
 */
function collectFiles(dir, match, sinceMs, out, depth = 0) {
  if (depth > 8 || out.length >= MAX_FILES) return
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return
    const full = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      collectFiles(full, match, sinceMs, out, depth + 1)
      continue
    }
    if (!entry.isFile() || !match(entry.name)) continue
    let stat
    try {
      stat = fs.statSync(full)
    } catch {
      continue
    }
    if (stat.mtimeMs < sinceMs || stat.size > MAX_FILE_BYTES) continue
    out.push(full)
  }
}

/**
 * 從 `offset` 開始逐行讀，把解析器吐出來的事件交給 `onEvent`。
 *
 * @param {string} file
 * @param {number} offset 上次讀到哪
 * @param {(line: string, state: object) => Array<object>} parseLine
 * @param {object} state 跨行狀態（模型名、去重集合）
 * @param {(event: object) => void} onEvent
 * @returns {Promise<number>} 這次讀到哪（下次的 offset）
 */
async function streamFile(file, offset, parseLine, state, onEvent) {
  let size = 0
  try {
    size = fs.statSync(file).size
  } catch {
    return offset
  }
  if (size <= offset) return size

  const stream = fs.createReadStream(file, { start: offset, encoding: 'utf8' })
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of reader) {
      if (!line) continue
      for (const event of parseLine(line, state)) onEvent(event)
    }
  } catch {
    // 讀到一半檔案被砍或編碼壞掉：把已經收到的留著，位移不推進，下次重試
    return offset
  } finally {
    reader.close()
    stream.destroy()
  }
  return size
}

/**
 * 掃一個來源（一個根目錄 ＋ 一種檔名 ＋ 一個解析器）。
 *
 * 跨行狀態（去重集合、目前模型）**每個檔案一份，而且要跟游標一起留著**：
 * 檔案是附加寫入的，下一次只讀新的那一段，如果去重集合重新開始，
 * 那些「同一則訊息的後續串流行」就會被當成新的再算一次。這裡的做法是
 * 只在**同一次掃描**內共用狀態，並把「已推進的位移」當成去重的邊界——
 * 已經讀過的行不會再被讀到，所以不需要跨次保留集合。
 *
 * @param {object} source
 * @param {string} source.provider
 * @param {string[]} source.roots
 * @param {(name: string) => boolean} source.match
 * @param {(line: string, state: object) => Array<object>} source.parseLine
 * @param {() => object} source.newState
 * @param {Record<string, { offset: number, mtimeMs: number }>} cursors 就地更新
 * @param {(event: object) => void} onEvent
 * @param {number} sinceMs
 * @returns {Promise<{ files: number, scannedBytes: number }>}
 */
async function scanSource(source, cursors, onEvent, sinceMs) {
  /** @type {string[]} */
  const files = []
  for (const root of source.roots) {
    collectFiles(root, source.match, sinceMs, files)
  }

  let scannedBytes = 0
  for (const file of files) {
    const key = file
    const previous = cursors[key]
    let offset = previous && Number.isFinite(previous.offset) ? previous.offset : 0
    let size = 0
    try {
      size = fs.statSync(file).size
    } catch {
      continue
    }
    // 檔案變小＝被截斷或換過一份，整份重讀
    if (size < offset) offset = 0
    if (size === offset) continue

    const state = source.newState()
    // 模型名要跨次留著：Codex 只在 `session_meta`／`turn_context` 寫一次模型，
    // 而增量掃描下一次只讀新附加的那一段——那幾行早就被上一次讀掉了，
    // 不把它接回來，同一個 session 之後的每一筆用量都會變成 `unknown`（實測 7.8 萬筆）
    if (previous && typeof previous.model === 'string') state.model = previous.model
    // 「還在重播母 thread 的歷史」同理要跨次留著：檔案還在寫的時候可能掃到重播的一半，
    // 下一次不接回來的話，剩下那半份重播就會被當成新用量收進去（而且記成 unknown）
    if (previous && previous.replay === true) state.replay = true
    const next = await streamFile(file, offset, source.parseLine, state, onEvent)
    scannedBytes += Math.max(0, next - offset)
    cursors[key] = {
      offset: next,
      mtimeMs: Date.now(),
      model: String(state.model || ''),
      replay: state.replay === true
    }
  }

  return { files: files.length, scannedBytes }
}

/**
 * 清掉已經不存在的檔案的游標，免得 `code-usage.json` 無限長大。
 * @param {Record<string, object>} cursors
 */
function pruneCursors(cursors) {
  for (const key of Object.keys(cursors)) {
    if (!fs.existsSync(key)) delete cursors[key]
  }
}

module.exports = {
  SCAN_WINDOW_DAYS,
  MAX_FILE_BYTES,
  MAX_FILES,
  collectFiles,
  streamFile,
  scanSource,
  pruneCursors
}
