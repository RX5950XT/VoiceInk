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
 * 代價說清楚：CLI 收不到滑鼠，Claude Code 那種用滑鼠點選單／點按鈕的互動會失效，要改用鍵盤。
 */

/** 會讓 xterm 把滑鼠交給應用程式的那幾個 DEC private mode。 */
const MOUSE_MODES = new Set([9, 1000, 1001, 1002, 1003])

/**
 * 不回傳收掉的函式：parser 處理器跟著 `term.dispose()` 一起走，不像 `term-ime.js` 那樣
 * 掛在 DOM 上需要自己解。
 *
 * @param {import('@xterm/xterm').Terminal} term
 */
export function blockMouseReporting(term) {
  /** @param {'h' | 'l'} final */
  const handle = (final) => (/** @type {(number | number[])[]} */ params) => {
    const modes = params.map((param) => (Array.isArray(param) ? param[0] : param))
    const rest = modes.filter((mode) => !MOUSE_MODES.has(mode))
    // 這串裡沒有滑鼠模式就別插手，交給 xterm 原本的處理器
    if (rest.length === modes.length) return false
    // `?1002;1006h` 這種混在一起的，把非滑鼠的那幾個原樣送回去。寫進去的那串已經不含滑鼠
    // 模式，再經過這支也是走上面那條 `return false`，不會繞回來。
    if (rest.length) term.write(`\x1b[?${rest.join(';')}${final}`)
    return true
  }
  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, handle('h'))
  term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, handle('l'))
}
