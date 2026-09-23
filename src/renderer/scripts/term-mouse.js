/**
 * 擋掉 CLI 開的滑鼠回報，讓左鍵拖曳永遠是「本地選取」。
 *
 * xterm.js 只要收到 `CSI ? 1000 h`（或 1002／1003）就把左鍵交給應用程式，自己不再做選取
 * ——畫面上拖曳連反白都不會出現，使用者說的是「選取文字自動複製壞掉了」，其實是根本選不
 * 起來。Claude Code v2.1 起會送 `?1000h` ＋ `?1006h`，於是整個工作階段都選不了字。
 *
 * 各家終端機的慣例是「Shift＋拖曳」強制本地選取，但這個 App 的終端機幾乎只拿來跑 AI CLI，
 * 複製訊息比點選單常用得多，所以直接不讓那幾個模式打開。**擋在 parser 而不是擋 DOM 事件**：
 * 模式沒開起來，xterm 的選取、右鍵貼上、滾輪捲 scrollback 就全部照原本的路走，不必去複製
 * 或改寫滑鼠事件（那會連帶改掉 Shift＋點擊「延伸選取」的語意）。
 *
 * 代價說清楚：CLI 收不到滑鼠點擊，Claude Code 那種用滑鼠點選單／點按鈕的互動會失效，要改用鍵盤。
 *
 * **滾輪例外，要自己轉給 CLI**：模式沒開的話，xterm 在備用畫面（沒有 scrollback）會把滾輪
 * 換成 ↑↓ 方向鍵——Claude Code 全螢幕模式正是備用畫面，於是滾輪變成在輸入框翻提示詞歷史，
 * 畫面完全捲不動。所以這裡記住「CLI 原本想要滑鼠」與「要 SGR 編碼」，只在備用畫面時把滾輪
 * 包成 SGR 滾輪事件送出去（CLI 自己捲它的畫面）；一般畫面照舊捲 scrollback。
 */

/** 會讓 xterm 把滑鼠交給應用程式的那幾個 DEC private mode。 */
const MOUSE_MODES = new Set([9, 1000, 1001, 1002, 1003])

/** 一格滾輪在各種 `deltaMode` 下的量：像素／行／頁。 */
const NOTCH = [100, 3, 1]

/**
 * 不回傳收掉的函式：parser 處理器與滾輪處理器都跟著 `term.dispose()` 一起走，不像
 * `term-ime.js` 那樣掛在 DOM 上需要自己解。
 *
 * @param {import('@xterm/xterm').Terminal} term
 */
export function blockMouseReporting(term) {
  // CLI 想要滑鼠（被我們擋掉的那個模式）／要 SGR 編碼（`?1006h` 沒擋，只是順便記）
  let wantsMouse = false
  let sgr = false
  /** @param {'h' | 'l'} final */
  const handle = (final) => (/** @type {(number | number[])[]} */ params) => {
    const modes = params.map((param) => (Array.isArray(param) ? param[0] : param))
    if (modes.includes(1006)) sgr = final === 'h'
    const rest = modes.filter((mode) => !MOUSE_MODES.has(mode))
    // 這串裡沒有滑鼠模式就別插手，交給 xterm 原本的處理器
    if (rest.length === modes.length) return false
    wantsMouse = final === 'h'
    // `?1002;1006h` 這種混在一起的，把非滑鼠的那幾個原樣送回去。寫進去的那串已經不含滑鼠
    // 模式，再經過這支也是走上面那條 `return false`，不會繞回來。
    if (rest.length) term.write(`\x1b[?${rest.join(';')}${final}`)
    return true
  }
  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, handle('h'))
  term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, handle('l'))

  let pending = 0
  term.attachCustomWheelEventHandler((event) => {
    // Ctrl+滾輪是字級（`terminal-page.js` 掛在外層），不可以讓 xterm 順手送出方向鍵
    if (event.ctrlKey) return false
    if (!wantsMouse || !sgr || term.buffer.active.type !== 'alternate') return true
    event.preventDefault()
    // 觸控板一次只給幾個像素，累積滿一格才送；滑鼠一格就是一次
    pending += event.deltaY / (NOTCH[event.deltaMode] || NOTCH[0])
    const steps = Math.trunc(pending)
    if (!steps) return false
    pending -= steps
    term.input(sgrWheel(term, event, steps).repeat(Math.min(Math.abs(steps), 10)), false)
    return false
  })
}

/**
 * 一格 SGR 滾輪事件：`ESC [ < 64／65 ; 欄 ; 列 M`（欄列從 1 起算，Shift／Alt 疊在按鍵碼上）。
 * @param {import('@xterm/xterm').Terminal} term
 * @param {WheelEvent} event
 * @param {number} steps 負數往上
 */
function sgrWheel(term, event, steps) {
  const rect = term.element?.querySelector('.xterm-screen')?.getBoundingClientRect()
  const cell = (offset, size, count) => {
    const at = rect && size ? Math.floor((offset / size) * count) : 0
    return Math.min(Math.max(at, 0), count - 1) + 1
  }
  const col = cell(event.clientX - (rect?.left || 0), rect?.width, term.cols)
  const row = cell(event.clientY - (rect?.top || 0), rect?.height, term.rows)
  const button = (steps < 0 ? 64 : 65) + (event.shiftKey ? 4 : 0) + (event.altKey ? 8 : 0)
  return `\x1b[<${button};${col};${row}M`
}
