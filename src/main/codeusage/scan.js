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
const { StringDecoder } = require('string_decoder')

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

  // 固定 end，這一輪只看 stat() 時已存在的位元組；新追加的內容留給下一輪。
  const stream = fs.createReadStream(file, { start: offset, end: size - 1 })
  const decoder = new StringDecoder('utf8')
  let pending = ''
  let completeOffset = offset
  try {
    for await (const chunk of stream) {
      pending += decoder.write(chunk)
      let index
      while ((index = pending.indexOf('\n')) >= 0) {
        const rawLine = pending.slice(0, index)
        pending = pending.slice(index + 1)
        completeOffset += Buffer.byteLength(rawLine, 'utf8') + 1
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
        if (!line) continue
        for (const event of parseLine(line, state)) onEvent(event)
      }
    }
    pending += decoder.end()
  } catch {
    // 讀到一半檔案被砍：已交出去的完整行可以記住，下一輪會依新檔案大小判斷是否 rewind。
    return completeOffset
  } finally {
    stream.destroy()
  }
  // 沒有換行的尾端可能只是尚未寫完的 JSON，不能把游標推過去。
  return completeOffset
}

/**
 * 掃一個來源（一個根目錄 ＋ 一種檔名 ＋ 一個解析器）。
 *
 * 跨行狀態（去重集合、目前模型）**每個檔案一份，而且要跟游標一起留著**：
 * 檔案是附加寫入的，下一次只讀新的那一段；如果去重集合重新開始，
 * 那些「同一則訊息的後續串流行」就會被當成新的再算一次。
 *
 * @param {object} source
 * @param {string} source.provider
 * @param {string[]} source.roots
 * @param {(name: string) => boolean} source.match
 * @param {(line: string, state: object) => Array<object>} source.parseLine
 * @param {() => object} source.newState
 * @param {((file: string) => string) | undefined} source.keyOf
 *   這個檔案的**穩定游標 key**。Codex／Grok 的 session 檔會從 `sessions/` 搬進
 *   `archived_sessions/`——游標若認絕對路徑，搬完之後整份檔案會從 0 重讀、
 *   整個 session 的用量算兩次（實測重現）。key 必須跟著檔案走：Codex 與
 *   Claude 用檔名（唯一 UUID），Grok 用上一層資料夾名（session UUID，
 *   檔名一律叫 updates.jsonl 不能用）。省略時退回絕對路徑（相容舊行為）。
 * @param {Record<string, { offset: number, mtimeMs: number, seen?: string[] }>} cursors 就地更新
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
    const key = source.keyOf ? `${source.provider}:${source.keyOf(file)}` : file
    const previous = cursors[key]
    let offset = previous && Number.isFinite(previous.offset)
      ? Math.max(0, Math.floor(previous.offset)) : 0
    let size = 0
    try {
      size = fs.statSync(file).size
    } catch {
      continue
    }
    // 檔案變小＝被截斷或換過一份，整份重讀，連同舊的去重狀態一起清掉
    const rewound = size < offset
    if (rewound) offset = 0
    if (size === offset && !rewound) {
      // 穩定 key 可能讓 session 從 sessions/ 搬到 archived_sessions/；即使沒有新位元組，
      // 也要把游標的實際路徑換過去，否則下一次 pruneCursors 會誤刪，之後整份重讀。
      if (previous && typeof previous === 'object') {
        cursors[key] = { ...previous, path: file }
      }
      continue
    }

    const state = source.newState()
    // 模型名要跨次留著：Codex 只在 `session_meta`／`turn_context` 寫一次模型，
    // 而增量掃描下一次只讀新附加的那一段——那幾行早就被上一次讀掉了，
    // 不把它接回來，同一個 session 之後的每一筆用量都會變成 `unknown`（實測 7.8 萬筆）
    if (!rewound && previous && typeof previous.model === 'string') state.model = previous.model
    // 「還在重播母 thread 的歷史」同理要跨次留著：檔案還在寫的時候可能掃到重播的一半，
    // 下一次不接回來的話，剩下那半份重播就會被當成新用量收進去（而且記成 unknown）
    if (!rewound && previous && previous.replay === true) state.replay = true
    if (!rewound && previous && previous.isFork === true) state.isFork = true
    if (!rewound && previous && Number.isFinite(previous.sessionStartMs)) state.sessionStartMs = previous.sessionStartMs
    if (!rewound && previous && Number.isFinite(previous.lastTotalTokens)) state.lastTotalTokens = previous.lastTotalTokens
    if (!rewound && previous && Array.isArray(previous.seen) && state.seen instanceof Set) {
      for (const id of previous.seen) {
        if (typeof id === 'string') state.seen.add(id)
      }
    }
    const next = await streamFile(file, offset, source.parseLine, state, onEvent)
    scannedBytes += Math.max(0, next - offset)
    cursors[key] = {
      offset: next,
      mtimeMs: Date.now(),
      model: String(state.model || ''),
      replay: state.replay === true,
      isFork: state.isFork === true,
      sessionStartMs: Number(state.sessionStartMs || 0),
      lastTotalTokens: Number(state.lastTotalTokens || 0),
      seen: state.seen instanceof Set ? [...state.seen] : [],
      // 穩定 key 不是路徑，清游標時要另外知道檔案在哪
      path: file
    }
  }

  return { files: files.length, scannedBytes }
}

/**
 * 清掉已經不存在的檔案的游標，免得 `code-usage.json` 無限長大。
 * 穩定 key（`provider:檔名`）本身不是路徑，檔案位置存在游標的 `path` 欄位；
 * 舊格式（key 就是路徑、沒有 `path` 欄）一併視為過期丟掉。
 * @param {Record<string, object>} cursors
 */
function pruneCursors(cursors) {
  for (const key of Object.keys(cursors)) {
    const cursor = cursors[key]
    if (!cursor || typeof cursor.path !== 'string' || !fs.existsSync(cursor.path)) {
      delete cursors[key]
    }
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
