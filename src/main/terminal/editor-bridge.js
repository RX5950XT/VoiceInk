'use strict'

/**
 * 讓終端機裡的 AI CLI 按 Ctrl+G 時，用 App 自己的編輯器分頁改提示詞，而不是彈出記事本。
 *
 * Claude Code 那條路是 `spawnSync(\`${EDITOR} "檔案"\`, { shell: true })`——**同步等到
 * 編輯器程序結束**才把檔案讀回輸入框。所以我們要塞給它的不是「開一個視窗」，而是一支
 * 會乖乖卡住的命令：
 *
 *   1. `EDITOR` 指到 `<userData>/editor-bridge/voiceink-edit.cmd`（純 batch，沒有相依）
 *   2. 那支 batch 把**檔案本身**複製成 `<id>.in`，然後每秒看一次 `<id>.done` 出現了沒
 *   3. main 這邊看到 `.in` 就叫 renderer 開一個編輯器分頁
 *   4. 使用者按「儲存」→ main 寫出 `<id>.out`（分頁還開著，可以再改再存）
 *   5. 使用者關掉分頁 → main 寫出 `<id>.done` → batch 把 `.out` 複製回原檔 → batch 結束
 *      → CLI 讀回檔案。**沒存過就沒有 `.out`，關掉等於原樣放行**
 *
 * **路徑一個字都不出 batch**：`echo %~f1` 寫出來的位元組是主控台的 ANSI 字碼頁
 * （這裡是 cp950），使用者名稱或檔名有中文就變亂碼，Node 用 UTF-8 讀回來會指到一個
 * 不存在的檔案——症狀是 Ctrl+G 之後什麼都沒發生。改成搬檔案就完全繞開編碼這件事。
 *
 * **只在使用者沒挑過編輯器時才接手**（見 `isRealEditor` 與 `service.js` 的
 * `bridgeTakesOver`）：已經設好 vim 的人按 Ctrl+G 本來就該進 vim；但 `EDITOR=notepad`
 * 等同沒設（那正是 CLI 的預設值），要接手。
 *
 * 安全邊界：renderer 只拿得到 `id` 與內容，完全碰不到路徑（連 main 都不知道那是哪個
 * 檔案，寫回是 batch 自己做的）。id 只收數字，避免路徑穿越。
 */
const fs = require('node:fs')
const path = require('node:path')

/** batch 內容改版時一起改，舊的會被覆寫 */
const SHIM_VERSION = 1

/**
 * 卡住等 `.done` 的 batch。兩個地雷：
 *
 * - **整支只能是 ASCII**：檔案是 UTF-8，而 cmd.exe 照系統的 ANSI 字碼頁（這裡是 cp950）
 *   讀它，中文註解的位元組會把那一行切壞，錯誤訊息是莫名其妙的
 *   `'idge' is not recognized as an internal or external command`。
 * - 用 `ping` 而不是 `timeout`：`timeout` 在 stdin 被重導向時會直接失敗
 *   （CLI 用 `stdio: 'inherit'` 大多沒事，但管線一包起來就會踩到）。
 */
const SHIM = `@echo off
rem VoiceInk editor bridge v${SHIM_VERSION} - generated file, edits are overwritten
setlocal
set "REQ=%~dp0requests"
if not exist "%REQ%" mkdir "%REQ%"
set "ID=%RANDOM%%RANDOM%%RANDOM%"
copy /y /b "%~f1" "%REQ%\\%ID%.in" > nul
:wait
if exist "%REQ%\\%ID%.done" goto done
ping -n 2 127.0.0.1 > nul
goto wait
:done
if exist "%REQ%\\%ID%.out" copy /y /b "%REQ%\\%ID%.out" "%~f1" > nul
del "%REQ%\\%ID%.in" "%REQ%\\%ID%.out" "%REQ%\\%ID%.done" > nul 2>&1
exit /b 0
`

/**
 * 「使用者其實沒有挑編輯器」的那幾種值。Claude Code 沒設 `EDITOR` 時本來就是跑
 * `start /wait notepad`，所以 `EDITOR=notepad`（Windows 上很常見，安裝別的工具時
 * 順手寫進使用者環境變數的也有）跟沒設是同一件事——那不是「我要用記事本」的決定，
 * 而是預設值被寫成明碼，不該擋掉 App 自己的編輯分頁。
 *
 * @param {string} [value]
 * @returns {boolean} 有值、而且是使用者真的挑過的編輯器
 */
function isRealEditor(value) {
  const raw = String(value || '').trim().replace(/^["']|["']$/g, '')
  if (!raw) return false
  const name = raw.toLowerCase().replace(/^start\s+(\/wait\s+)?/, '').trim()
  const base = name.split(/[\\/]/).pop().replace(/\.exe$/, '')
  return base !== 'notepad'
}

let dir = ''
let watcher = null
/** 這次啟動當下就已經躺在那裡的請求（上一輪留下來的），一律放走不開分頁 */
let stale = new Set()
let emit = () => {}
/** @type {Map<string, string>} 還在等使用者的請求：id → 那張 `.in` 的路徑 */
const pending = new Map()

/** @param {string} userData */
function configure(userData) {
  dir = path.join(String(userData || ''), 'editor-bridge')
}

/**
 * 確保 batch 在磁碟上且是最新版，回傳可以直接塞進 `EDITOR` 的字串（自帶引號：
 * CLI 是把它跟檔名接成一行給 cmd 跑的，路徑裡有空白就會斷成兩段）。
 *
 * @returns {string} 失敗時回空字串（Ctrl+G 就退回原本的記事本，不是壞掉）
 */
function shimCommand() {
  if (!dir) return ''
  try {
    fs.mkdirSync(path.join(dir, 'requests'), { recursive: true })
    const file = path.join(dir, 'voiceink-edit.cmd')
    let current = ''
    try { current = fs.readFileSync(file, 'utf8') } catch { current = '' }
    if (current !== SHIM) fs.writeFileSync(file, SHIM, 'utf8')
    return `"${file}"`
  } catch {
    return ''
  }
}

/**
 * 開始監看請求資料夾。`fs.watch` 在 Windows 上偶爾會漏事件，所以另外留一顆低頻輪詢
 * （5 秒一次）當保險——漏掉一張 `.req` 的代價是使用者的 CLI 整個卡在那裡。
 *
 * @param {(channel: string, payload: object) => void} emitter
 */
function start(emitter) {
  emit = typeof emitter === 'function' ? emitter : () => {}
  if (!dir || watcher) return
  const requests = path.join(dir, 'requests')
  try {
    fs.mkdirSync(requests, { recursive: true })
    // 這一輪開始前就存在的請求＝上一輪留下來的（宿主是獨立程序，關 App 不會把
    // 那些 batch 帶走）。**不可以拿檔案時間來判斷**：`.in` 是 `copy` 出來的，
    // 而 copy 會把來源檔的最後修改時間一起帶過去，看起來永遠是「很舊」。
    stale = new Set(fs.readdirSync(requests).filter((name) => name.endsWith('.in')))
    for (const name of stale) release(name.slice(0, -3))
    const scan = () => scanRequests(requests)
    const fsWatcher = fs.watch(requests, () => scan())
    const timer = setInterval(scan, 5000)
    timer.unref?.()
    watcher = { close() { fsWatcher.close(); clearInterval(timer) } }
    scan()
  } catch {
    watcher = null
  }
}

function stop() {
  try { watcher?.close() } catch { /* 關不掉就算了，程序要結束了 */ }
  watcher = null
  // 卡住的 CLI 要放走，不然 App 關了它們還在那裡等
  for (const id of [...pending.keys()]) cancel(id)
}

/**
 * 掃出還沒處理過的請求，一張一張叫 renderer 開分頁。
 * @param {string} requests
 */
function scanRequests(requests) {
  let names = []
  try { names = fs.readdirSync(requests) } catch { return }
  for (const name of names) {
    const match = /^(\d{1,24})\.in$/.exec(name)
    if (!match) continue
    const id = match[1]
    if (pending.has(id)) continue
    if (stale.has(name)) continue
    const file = path.join(requests, name)
    let content = ''
    try { content = fs.readFileSync(file, 'utf8') } catch { continue }
    pending.set(id, file)
    emit('terminal:editRequest', { id, content })
  }
}

/** @param {string} id */
function doneFile(id) {
  return path.join(dir, 'requests', `${id}.done`)
}

/**
 * 使用者按了「儲存」：內容先落地成 `.out`，但**不放走**那支 batch——分頁還開著，
 * 他可能還要再改。真正送回終端機是關掉分頁那一刻（`cancel` → `.done` → batch 自己
 * 把 `.out` 蓋回原檔）。
 *
 * 存兩次就覆寫，最後一次存的那份才算數。
 *
 * @param {string} id
 * @param {string} content
 * @returns {boolean}
 */
function save(id, content) {
  const key = String(id || '')
  if (!pending.has(key)) return false
  if (typeof content !== 'string') return false
  try {
    // `.out` 一定要在 `.done` 之前落地：batch 看到 `.done` 就會馬上把 `.out` 蓋回原檔
    fs.writeFileSync(path.join(dir, 'requests', `${key}.out`), content, 'utf8')
  } catch {
    const error = new Error('EDIT_WRITE_FAILED')
    error.userMessage = '存不起來，這次的內容沒有留下'
    throw error
  }
  return true
}

/**
 * 使用者關掉分頁：放走那支 batch。**存過就送、沒存過就照原樣**——batch 看到 `.done`
 * 之後只在 `.out` 存在時才蓋回原檔，所以「改完存檔再關」與「什麼都沒動就關」自然分開。
 * 不放走的話 CLI 會一直卡在 Ctrl+G。
 * @param {string} id
 * @returns {boolean}
 */
function cancel(id) {
  const key = String(id || '')
  if (!pending.has(key)) return false
  release(key)
  return true
}

/**
 * 放走那支卡住的 batch。過期請求（上一輪留下來的）也走這裡，所以不要求 `pending` 有這一筆。
 * @param {string} key
 */
function release(key) {
  pending.delete(key)
  try { fs.writeFileSync(doneFile(key), '1', 'utf8') } catch { /* batch 會等到逾時，不再多做 */ }
}

module.exports = { configure, shimCommand, isRealEditor, start, stop, save, cancel }
