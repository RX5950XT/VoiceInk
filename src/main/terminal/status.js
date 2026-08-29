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
 * ponytail: 靜默門檻是啟發式的。安靜地跑很久又不吐字的批次指令（某些 build）會被提早
 * 標成已完成；真要更準得偵測 alt-screen 或掛 PSReadLine 的按鍵處理器，目前不值得。
 */

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

/** `OSC 133;D;<離開碼>;<history id>` ST 可能是 BEL 或 ESC \ */
const DONE_RE = new RegExp(`${ESC}\\]133;D;(\\d+);(\\d+)(?:${BEL}|${ESC}\\\\)`, 'g')

/** 有指令在執行中：靜默這麼久就當它停下來在等使用者（代理 REPL 的主要情境） */
const BUSY_QUIET_MS = 4000
/** 已回到提示字元：只是餘波（例如 Ctrl+C），很快就能收斂 */
const PROMPT_QUIET_MS = 800
/** 跨 chunk 的標記會被切成兩半，保留這麼多字元接續下一塊 */
const TAIL_KEEP = 64

/**
 * @typedef {'idle' | 'running' | 'exited'} TerminalState
 */

/**
 * @param {number} now
 * @returns {{
 *   state: TerminalState, exitCode: number | null, lastOutputAt: number,
 *   maxHistoryId: number, inFlight: boolean, tail: string,
 *   pending: string, recalled: boolean
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
    recalled: false
  }
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
    t.exitCode = Number.isFinite(code) ? code : null
    t.state = 'idle'
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
}

module.exports = {
  BUSY_QUIET_MS,
  PROMPT_QUIET_MS,
  createTracker,
  onInput,
  onOutput,
  onExit,
  tick
}
