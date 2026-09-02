'use strict'

/**
 * 產生 router 的 `--models-preset` INI。
 *
 * 實測（`probe-hf-router.js` 的 [E]）：
 *   - `[*]` 套用到全部，`[<model id>]` 蓋掉它
 *   - key 用**長選項名**（`ctx-size = 3072` → `--ctx-size 3072`、`gpu-layers = 0` → `--n-gpu-layers 0`）
 *     也可以用短名（`c = 2048`）。我們一律寫長名——短名在檔案裡看起來像亂碼。
 *   - 值原樣接到命令列，所以 key 與 id 都不能夾雜換行或 `]`
 */

const fs = require('fs')
const path = require('path')

/** 跟 `library.isValidId` 同一套 */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/
const KEY_RE = /^[a-z][a-z0-9-]{0,40}$/

/**
 * @param {any} value
 * @returns {string}
 */
function safeValue(value) {
  // 只清換行：換行會把後面的東西變成另一個設定項（甚至另一個區段）。
  //
  // **`[` `]` 一定要留著**：`override-tensor` 的值是 llama.cpp 自己產的正規表示式
  // （像 `blk\.(1[0-9])\.ffn_.*=CPU`），把中括號換成空白會把它默默改成另一條規則——
  // 不會報錯，只會變成「MoE 的層搬錯了」。INI 的區段判定是「整行以 `[` 開頭」，
  // 而我們永遠寫成 `key = value`，值不可能在行首，所以留著是安全的。
  return String(value === undefined || value === null ? '' : value)
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 1024)
}

/**
 * @param {Record<string, any>} args
 * @returns {string[]}
 */
function renderArgs(args) {
  const lines = []
  for (const [key, value] of Object.entries(args || {})) {
    if (!KEY_RE.test(key)) continue
    const text = safeValue(value)
    if (!text) continue
    lines.push(`${key} = ${text}`)
  }
  return lines
}

/**
 * @param {Array<{ id: string, args: Record<string, any> }>} entries
 * @param {Record<string, any>} [globals] `[*]` 區段（例如全機共用的 `device`）
 * @returns {string}
 */
function render(entries, globals = {}) {
  const lines = ['version = 1', '']
  const globalLines = renderArgs(globals)
  if (globalLines.length) lines.push('[*]', ...globalLines, '')
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || !ID_RE.test(String(entry.id || ''))) continue
    const argLines = renderArgs(entry.args)
    if (!argLines.length) continue
    lines.push(`[${entry.id}]`, ...argLines, '')
  }
  return lines.join('\n')
}

/**
 * 原子寫入（router 啟動時會讀它，寫到一半被讀走就會拿到半份設定）
 * @param {string} filePath
 * @param {Array<{ id: string, args: Record<string, any> }>} entries
 * @param {Record<string, any>} [globals]
 * @returns {string} 寫出去的內容
 */
function write(filePath, entries, globals = {}) {
  const text = render(entries, globals)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, filePath)
  return text
}

module.exports = { render, write }
