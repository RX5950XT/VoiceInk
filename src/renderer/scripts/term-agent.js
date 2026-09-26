/**
 * 從終端機「現在這一面」判斷 Claude 在忙、在等你，還是已經回到輸入框。
 *
 * 純函式，不碰 DOM。宿主的靜默計時看不見「想很久沒輸出」和「跳出權限在等人」，
 * 所以顯示狀態要再看畫面，以及（有的話）main 的 hook。
 *
 * 規則是資料表：每支 CLI 一組。現在只有 Claude；之後加 Codex 只要再放一組。
 * 視窗是畫面非空行由下往上數，比對不分大小寫。
 * 轉圈符號 ·✢✳✶✻✽ 刻意不在表裡——做完的總結行「✳ Baked for …」也用它們。
 *
 * Claude Code 2.1.283 實測（`scripts/fixtures/term-agent/`）：
 * - 等人：信任對話框底部是 `Enter to confirm · Esc to cancel`，游標行是 `❯ No, exit`。
 *   這台機器的 `echo hi` 在 `--permission-mode manual` 下會直接跑完，沒有跳出第二種確認框。
 *   二進位裡沒有 `tab to amend` 這句，表上仍留著，之後的版本若印出來才用得到。
 * - 進行中：狀態列是 `✶ Concocting…`／`✶ Catapulting…`，括號裡是 hook
 *   （`running UserPromptSubmit hooks…`／`running Stop hook`）。這一輪沒有印出
 *   `esc to interrupt`——顏色閃爍還把單字從中切開。總結行是
 *   `✻ Brewed for 7s`／`✻ Baked for 2s`／`✻ Cogitated for 5s`，同樣有轉圈符號，
 *   所以進行中要「轉圈符號＋現在分詞＋…」，不能只看那顆符號。
 * - 輸入框：`❯ Try "…"`（`❯` 後面是空白，含不換行空白）。
 */

/** @typedef {'working' | 'waiting' | 'idle'} AgentState */
/** @typedef {'running' | 'waiting' | 'idle' | 'exited' | 'stopped'} ViewState */

/**
 * @type {Array<{
 *   id: string,
 *   waiting: { lines: number, has: string, any: string[] },
 *   working: { lines: number, any: string[], line?: RegExp },
 *   idle: { lines: number, prompt: RegExp, absent: string[] }
 * }>}
 */
const SCREEN_RULES = [
  {
    id: 'claude',
    // 權限／信任選單。`esc to cancel` 單獨出現不算（可能是說明文字）。
    waiting: {
      lines: 12,
      has: 'esc to cancel',
      any: ['enter to select', 'enter to confirm', 'do you want to proceed?', 'tab to amend']
    },
    // `esc to interrupt` 是說明書上的那句。2.1.283 這台實測常被 hook 狀態換掉，
    // 畫面底部變成 `✶ Concocting…`。轉圈符號要跟 `ing…` 在同一行，總結行的
    // `✻ Brewed for 7s` 才不會被當成還在跑。中間那個 `·` 到處都有，不拿來當符號。
    working: {
      lines: 8,
      any: ['esc to interrupt'],
      line: /^\s*[✢✳✶✻✽].*ing…/
    },
    // 行首 ❯ 才是輸入框。2.1.283 的狀態列（模型、manual、/rc）佔掉最底三、四行，
    // ❯ 不在最底 4 行裡，所以視窗放到 8。選單的 `❯ No, exit` 也長這樣，
    // 範圍內不能有上面那些確認提示。
    idle: {
      lines: 8,
      prompt: /^\s*❯(?:\s|$)/,
      absent: ['esc to cancel', 'enter to select', 'esc to interrupt']
    }
  }
]

const AGENT_VIEW = { working: 'running', waiting: 'waiting', idle: 'idle' }

/**
 * @param {unknown} lines
 * @returns {string[]}
 */
function nonempty(lines) {
  /** @type {string[]} */
  const out = []
  if (!Array.isArray(lines)) return out
  for (const line of lines) {
    const text = String(line ?? '')
    if (text.trim() !== '') out.push(text)
  }
  return out
}

/**
 * @param {string[]} lines
 * @param {number} count
 * @returns {string[]}
 */
function tailLines(lines, count) {
  const n = count > 0 ? count : 0
  return lines.slice(Math.max(0, lines.length - n))
}

/**
 * @param {string[]} lines
 * @param {string} phrase
 * @returns {boolean}
 */
function hasPhrase(lines, phrase) {
  const needle = String(phrase).toLowerCase()
  for (const line of lines) {
    if (line.toLowerCase().includes(needle)) return true
  }
  return false
}

/**
 * @param {string[]} lines
 * @param {string[]} phrases
 * @returns {boolean}
 */
function hasAny(lines, phrases) {
  for (const phrase of phrases) {
    if (hasPhrase(lines, phrase)) return true
  }
  return false
}

/**
 * @param {string[]} lines 已經拿掉空行，由上到下
 * @param {(typeof SCREEN_RULES)[number]} rule
 * @returns {AgentState | null}
 */
function matchRule(lines, rule) {
  const wait = tailLines(lines, rule.waiting.lines)
  if (hasPhrase(wait, rule.waiting.has) && hasAny(wait, rule.waiting.any)) return 'waiting'
  const work = tailLines(lines, rule.working.lines)
  if (hasAny(work, rule.working.any)) return 'working'
  if (rule.working.line && work.some((line) => rule.working.line.test(line))) return 'working'
  const idle = tailLines(lines, rule.idle.lines)
  let prompted = false
  for (const line of idle) {
    if (rule.idle.prompt.test(line)) {
      prompted = true
      break
    }
  }
  if (prompted && !hasAny(idle, rule.idle.absent)) return 'idle'
  return null
}

/**
 * @param {string[]} lines 由上到下的畫面列（空行會被忽略）
 * @returns {AgentState | null}
 */
export function detectScreen(lines) {
  const rows = nonempty(lines)
  for (const rule of SCREEN_RULES) {
    const hit = matchRule(rows, rule)
    if (hit) return hit
  }
  return null
}

/**
 * 顯示用狀態。程序已經結束就聽宿主；否則 hook 優先，再來是畫面，都沒有才回到宿主。
 * hook／畫面的 `working` 畫面上叫 `running`（跟宿主的「運行中」同一個字）。
 *
 * @param {{ host?: string, hook?: string | null, screen?: string | null }} input
 * @returns {ViewState | string}
 */
export function mergeState({ host, hook, screen } = {}) {
  if (host === 'exited' || host === 'stopped') return host
  if (hook != null && AGENT_VIEW[hook]) return AGENT_VIEW[hook]
  if (screen != null && AGENT_VIEW[screen]) return AGENT_VIEW[screen]
  return host
}

/**
 * xterm 目前這一頁：`baseY` 起 `rows` 列，`translateToString(true)`。
 * 折行（`isWrapped`）接回同一行，避免「esc to interrupt」被寬度切成兩半。
 *
 * @param {{ baseY?: number, getLine?: (y: number) => { isWrapped?: boolean, translateToString?: (trim?: boolean) => string } | undefined } | null | undefined} buffer
 * @param {number} rows
 * @returns {string[]}
 */
export function viewportLines(buffer, rows) {
  const count = Number.isFinite(rows) ? Math.max(0, Math.floor(rows)) : 0
  const start = Number.isFinite(buffer?.baseY) ? buffer.baseY : 0
  /** @type {string[]} */
  const lines = []
  for (let i = 0; i < count; i += 1) {
    const line = buffer?.getLine?.(start + i)
    const text = typeof line?.translateToString === 'function' ? line.translateToString(true) : ''
    if (line?.isWrapped && lines.length) lines[lines.length - 1] += text
    else lines.push(text)
  }
  return lines
}
