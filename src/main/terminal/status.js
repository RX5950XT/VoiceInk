'use strict'

/**
 * 終端機工作階段的「在運行中／已完成」判定。
 *
 * 純函式模組（零 electron／node-pty 依賴），時間一律由呼叫端傳入，測試能完全決定結果。
 *
 * 判定來源有兩個，缺一不可：
 *
 * 1. **shell integration 標記** `OSC 133;D;<離開碼>;<history id>`——spawn 時把使用者原本的
 *    prompt 包一層注入進去。精確、還帶離開碼，但只有 PowerShell 系列有，而且
 *    **PSReadLine 會在外部輸出時重繪提示字元**，把同一份 prompt 字串（含標記）整個重送；
 *    捲動重播甚至會送出比較舊的 id。實測跑 `ping -n 4` 的三秒內收到 9 次 `D;0`，
 *    全是重繪。所以只認「比看過的最大 id 更大」的那一次，不是「跟上次不同」。
 *
 * 2. **輸出活動**——AI 代理 CLI（claude、codex）多半是常駐 REPL：一旦跑起來，shell 那層
 *    到你離開為止都看不到任何指令結束，只有畫面在動。代理在忙的時候 spinner 每秒重畫
 *    好幾次，停下來等你就完全安靜——所以「靜默夠久」是這個情境唯一的完成訊號。
 *
 * 「安靜＝做完了」只適用**人在裡面來回互動**的前景程式（AI CLI）。送出一行之後就沒再
 * 打過字的（build、測試、下載）不適用——它安靜是因為跑得久，不是做完了。兩者用
 * `interactive` 分開，而且只有拿得到 shell integration 標記的階段才敢這樣壓著不放
 * （沒有標記就沒人來解，會永遠卡在「運行中」）。
 *
 * 另外順手從輸出裡撈兩件 renderer 要用的事實：OSC 0/2 的視窗標題（分頁要跟著跑什麼變）
 * 與 OSC 7 的工作目錄（`cd` 之後連結解析才對得上）。
 */

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

/** `OSC 133;D;<離開碼>;<history id>` ST 可能是 BEL 或 ESC \ */
const DONE_RE = new RegExp(`${ESC}\\]133;D;(\\d+);(\\d+)(?:${BEL}|${ESC}\\\\)`, 'g')

/** 有指令在執行中：靜默這麼久就當它停下來在等使用者（代理 REPL 的主要情境） */
const BUSY_QUIET_MS = 4000
/** 已回到提示字元：只是餘波（例如 Ctrl+C），很快就能收斂 */
const PROMPT_QUIET_MS = 800
/**
 * 跨 chunk 的標記會被切成兩半，保留這麼多字元接續下一塊。
 * 要蓋得住最長的那一種（OSC 7 的整條路徑），不是只蓋 OSC 133。
 */
const TAIL_KEEP = 768

/** `OSC 0;<標題>` 或 `OSC 2;<標題>`——前景程式自己報的視窗標題 */
const TITLE_RE = new RegExp(`${ESC}\\](?:0|2);([^${ESC}${BEL}]{0,200})(?:${BEL}|${ESC}\\\\)`, 'g')
/** `OSC 7;file://<主機>/<路徑>`——前景 shell 報的目前工作目錄 */
const CWD_RE = new RegExp(`${ESC}\\]7;([^${ESC}${BEL}]{0,600})(?:${BEL}|${ESC}\\\\)`, 'g')

/**
 * @typedef {'idle' | 'running' | 'exited'} TerminalState
 */

/**
 * @param {number} now
 * @returns {{
 *   state: TerminalState, exitCode: number | null, lastOutputAt: number,
 *   maxHistoryId: number, inFlight: boolean, tail: string,
 *   pending: string, recalled: boolean, interactive: boolean,
 *   title: string, cwd: string
 * }}
 */
function createTracker(now) {
  return {
    state: 'idle',
    /** 最近一次指令的離開碼；沒有 shell integration 就一直是 null */
    exitCode: null,
    lastOutputAt: now,
    /** 看過的最大 history id；-1 代表還沒收過任何標記 */
    maxHistoryId: -1,
    /** 依標記判斷「目前有指令在跑」 */
    inFlight: false,
    tail: '',
    /** 使用者這一行打到哪了（用來認出「空白 Enter」不算送出指令） */
    pending: '',
    /** 用上下鍵叫回歷史指令：pending 是空的但送出的其實有內容 */
    recalled: false,
    /** 指令跑起來之後人又打過字＝在跟前景程式來回互動，這種才適用「安靜＝做完了」 */
    interactive: false,
    /** 前景程式自己報的視窗標題（OSC 0/2） */
    title: '',
    /** 前景 shell 自己報的工作目錄（OSC 7）；沒報就一直是空字串 */
    cwd: ''
  }
}

/**
 * 有沒有控制字元。標題與路徑都要進 UI 或檔案系統，先擋掉。
 * @param {string} text
 * @returns {boolean}
 */
function hasControlChar(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code < 32 || code === 127) return true
  }
  return false
}

/**
 * OSC 7 的值（`file://<主機>/<路徑>`）轉成 Windows 路徑。
 *
 * 這是**終端機裡跑的程式自己講的**，不是我們算出來的：只收「磁碟機開頭的絕對路徑」，
 * 其餘（UNC、相對路徑、含控制字元、過長）一律回空字串當作沒報過。
 *
 * @param {string} value
 * @returns {string}
 */
function parseOsc7(value) {
  const text = String(value || '')
  if (!text.startsWith('file://')) return ''
  const slash = text.indexOf('/', 'file://'.length)
  if (slash < 0) return ''
  let raw
  try {
    raw = decodeURIComponent(text.slice(slash + 1))
  } catch {
    return ''
  }
  if (!/^[A-Za-z]:[\\/]/.test(raw)) return ''
  const full = raw.replace(/\//g, '\\')
  return full.length <= 260 && !hasControlChar(full) ? full : ''
}

/**
 * 使用者送進 pty 的按鍵。
 * @param {ReturnType<typeof createTracker>} t
 * @param {string} data
 * @param {number} now
 */
function onInput(t, data, now) {
  if (t.state === 'exited') return
  for (const ch of data) {
    if (ch === '\r' || ch === '\n') {
      // 空白 Enter 只是換一行提示字元，不是送出指令——標成運行中會卡住不回來
      if (t.pending.trim() || t.recalled) {
        // 已經有東西在跑的時候又送出一行＝人在跟前景程式來回互動（AI CLI 那類）。
        // 只有這種情境「安靜」才代表做完了；送出去就沒再打字的（build）不算。
        if (t.inFlight) t.interactive = true
        t.state = 'running'
        t.inFlight = true
        t.exitCode = null
        t.lastOutputAt = now
      }
      t.pending = ''
      t.recalled = false
    } else if (ch === String.fromCharCode(127) || ch === '\b') {
      t.pending = t.pending.slice(0, -1)
    } else if (ch === ESC) {
      // 方向鍵／功能鍵：多半是叫回歷史指令，送出的內容看不到但確實有東西
      t.recalled = true
    } else if (ch >= ' ') {
      t.pending += ch
    }
  }
}

/**
 * pty 吐出來的資料。
 * @param {ReturnType<typeof createTracker>} t
 * @param {string} chunk
 * @param {number} now
 */
function onOutput(t, chunk, now) {
  if (t.state === 'exited') return
  t.lastOutputAt = now
  if (t.state !== 'running') t.state = 'running'

  const buf = t.tail + chunk
  DONE_RE.lastIndex = 0
  let m
  while ((m = DONE_RE.exec(buf))) {
    const code = Number(m[1])
    const historyId = Number(m[2])
    // 重繪與捲動重播都會重送舊的 id，只有更大的才是真的跑完一條
    if (historyId <= t.maxHistoryId) continue
    const firstEver = t.maxHistoryId < 0
    t.maxHistoryId = historyId
    // 第一個標記是「現在這個提示字元」而不是「有東西跑完了」——在知道 id 從哪裡起跳之前
    // 不能拿它下結論，否則指令送出後看到的第一個重繪就會被當成完成。
    if (firstEver) continue
    t.inFlight = false
    // 回到提示字元＝剛才那個前景程式收工了，互動狀態跟著歸零
    t.interactive = false
    t.exitCode = Number.isFinite(code) ? code : null
    t.state = 'idle'
  }

  // 標題與工作目錄：整段掃完取最後一次，中間的都是過程
  TITLE_RE.lastIndex = 0
  let hit
  while ((hit = TITLE_RE.exec(buf))) {
    const title = hit[1].trim()
    if (title && !hasControlChar(title)) t.title = title
  }
  CWD_RE.lastIndex = 0
  while ((hit = CWD_RE.exec(buf))) {
    const cwd = parseOsc7(hit[1])
    if (cwd) t.cwd = cwd
  }

  t.tail = buf.slice(-TAIL_KEEP)
}

/**
 * 定時檢查靜默。呼叫端每秒跑一次即可。
 * @param {ReturnType<typeof createTracker>} t
 * @param {number} now
 * @returns {boolean} 狀態有沒有變
 */
function tick(t, now) {
  if (t.state !== 'running') return false
  // 送出指令之後就沒再打過字：安靜只代表它跑得久（build、測試、下載），不是做完了。
  // 只有拿得到 shell integration 標記的階段才敢這樣一直壓著——沒有標記就沒人來解，
  // 會永遠卡在「運行中」（`cmd.exe` 沒有標記，維持原本的靜默判定）。
  if (t.maxHistoryId >= 0 && t.inFlight && !t.interactive) return false
  const quiet = now - t.lastOutputAt
  if (quiet < (t.inFlight ? BUSY_QUIET_MS : PROMPT_QUIET_MS)) return false
  t.state = 'idle'
  return true
}

/**
 * @param {ReturnType<typeof createTracker>} t
 * @param {number | null} code
 */
function onExit(t, code) {
  t.state = 'exited'
  t.exitCode = Number.isFinite(code) ? code : null
  t.inFlight = false
  t.interactive = false
}

module.exports = {
  BUSY_QUIET_MS,
  PROMPT_QUIET_MS,
  parseOsc7,
  createTracker,
  onInput,
  onOutput,
  onExit,
  tick
}
