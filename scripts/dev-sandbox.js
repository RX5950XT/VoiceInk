'use strict'

/**
 * 開發／測試用的沙箱實例：跟你正在用的那份**完全不打架**，但接得到原本的資料。
 *
 * 為什麼需要：安裝版、`dist/win-unpacked` 預覽版、`npm run electron:dev` 預設共用同一個
 * `%APPDATA%\voiceink`，於是 ①`requestSingleInstanceLock()` 綁的是 userData 路徑
 * → 第二份直接自己關掉；②`chats.json`／`workspaces.json`／`config.json` 兩邊互相蓋。
 * `main.js` 特地在搶鎖**之前**就處理 `--user-data-dir`，就是為了讓兩份能同時活著。
 *
 * 三種東西分三種接法：
 *
 * | 種類 | 做法 | 為什麼 |
 * |---|---|---|
 * | 大而唯讀（`models`、`hf-models`） | junction 接回真的那份 | 30GB 不可能複製；App 只會讀它 |
 * | 小而想沿用（`config.json`、`workspaces.json`） | **複製**一份 | 沙箱怎麼寫都不會弄髒你的 |
 * | 會累積的紀錄（`usage.json`、`code-usage.json`、`agy-logs.db`、`dictations.json`、`terminals.json`） | 不接 | 沙箱的測試資料混進去就分不出來了；`terminals.json` 指的是**另一份程序**的 pty，接過來只會是死的 |
 *
 * 另外三個鍵一定要在沙箱裡關掉——它們的影響會**跑出 userData 之外**：
 * `agyEnabled`（會去搶同一個埠）、`dictationEnabled`（原生 hook 在全機器層級吞掉右 Alt）、
 * `sysmonSensors`（提權 sidecar 會跳 UAC）。
 *
 * 用法：
 *   node scripts/dev-sandbox.js              # 用原始碼跑（等同 npm run electron:dev 的 electron 那半）
 *   node scripts/dev-sandbox.js --packed     # 改用 dist/win-unpacked/VoiceInk.exe
 *   node scripts/dev-sandbox.js --with-chats # 連對話一起複製（預設不複製）
 *   node scripts/dev-sandbox.js --reset      # 先把沙箱清掉再重種
 *   node scripts/dev-sandbox.js --no-launch  # 只準備，不啟動
 */

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const ROOT = path.join(__dirname, '..')
const APPDATA = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming')
/** 你正在用的那一份 */
const REAL = path.join(APPDATA, 'voiceink')
/**
 * 沙箱放在真 userData 隔壁，不放 `%TEMP%`：`config.json` 裡有 API 金鑰，
 * 留在使用者設定檔目錄底下權限跟原本那份一樣，而且重開機不會被清掉。
 */
const SANDBOX = path.join(APPDATA, 'voiceink-dev')

/** 大而唯讀：接回去，不複製 */
const LINK_DIRS = ['models', 'hf-models']
/** 這幾個鍵的作用會跑出 userData 之外，沙箱一律關掉 */
const FORCED_OFF = { agyEnabled: false, dictationEnabled: false, sysmonSensors: false, closeToTray: false }

const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)

/**
 * 寫進沙箱前先把目的地拆掉。
 *
 * **不可以省**：`writeFileSync`／`copyFileSync` 會**跟著符號連結寫到對面去**，
 * 沙箱裡只要有一條指回真 userData 的連結（上一版接錯、手動測試留下的），
 * 這支「保護你的資料」的腳本就會親手覆寫掉你正在用的設定。
 * 底下的 `verify()` 是最後一道門，但它跑在寫入之後，擋不住這一步。
 * @param {string} name
 */
function unlinkDest(name) {
  const to = path.join(SANDBOX, name)
  try {
    if (fs.lstatSync(to)) fs.rmSync(to, { recursive: true, force: true })
  } catch {
    // 本來就不存在
  }
}

/**
 * 把真的那份的一個檔案複製進沙箱（來源不存在就跳過）。
 * @param {string} name
 * @returns {boolean}
 */
function copyFile(name) {
  const from = path.join(REAL, name)
  if (!fs.existsSync(from)) return false
  unlinkDest(name)
  fs.copyFileSync(from, path.join(SANDBOX, name))
  return true
}

/**
 * 用 junction 接回真的資料夾。接不起來（權限、來源不存在）不是錯誤，
 * 沙箱照樣能開，只是那一區是空的。
 * @param {string} name
 * @returns {boolean}
 */
function linkDir(name) {
  const from = path.join(REAL, name)
  const to = path.join(SANDBOX, name)
  if (!fs.existsSync(from) || fs.existsSync(to)) return false
  try {
    fs.symlinkSync(from, to, 'junction')
    return true
  } catch {
    return false
  }
}

/**
 * 種一份沙箱 userData。
 * @returns {string[]} 做了哪幾件事（印給使用者看）
 */
function seed() {
  const done = []
  if (has('--reset') && fs.existsSync(SANDBOX)) {
    fs.rmSync(SANDBOX, { recursive: true, force: true })
    done.push('清掉舊沙箱')
  }
  fs.mkdirSync(SANDBOX, { recursive: true })

  for (const dir of LINK_DIRS) if (linkDir(dir)) done.push(`接回 ${dir}/`)

  // config.json 沿用你的設定（供應商、金鑰、模型選擇），但強制關掉三個會跑出去的開關
  let config = {}
  try {
    config = JSON.parse(fs.readFileSync(path.join(REAL, 'config.json'), 'utf8'))
    done.push('沿用 config.json')
  } catch {
    done.push('沒有 config.json，用空設定')
  }
  unlinkDest('config.json')
  fs.writeFileSync(path.join(SANDBOX, 'config.json'), JSON.stringify({ ...config, ...FORCED_OFF }, null, 2))

  if (copyFile('workspaces.json')) done.push('複製專案清單')
  if (has('--with-chats')) {
    if (copyFile('chats.json')) done.push('複製對話')
    // 訊息只存檔名，圖片實體在這個資料夾——不接的話對話裡的圖全裂開
    if (linkDir('chat-images')) done.push('接回 chat-images/')
  }
  return done
}

/**
 * 種完之後自己驗一次。這支腳本唯一的價值就是「不會碰到你正在用的那份」，
 * 所以這幾條不成立就不該啟動。
 */
function verify() {
  const real = fs.realpathSync(REAL)
  for (const name of ['config.json', 'workspaces.json', 'chats.json', 'usage.json', 'agy-logs.db']) {
    const file = path.join(SANDBOX, name)
    if (!fs.existsSync(file)) continue
    const resolved = fs.realpathSync(file)
    if (resolved.startsWith(real + path.sep)) {
      throw new Error(`沙箱的 ${name} 指回真的那份（${resolved}）——寫下去會弄髒你正在用的資料`)
    }
  }
  const config = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'config.json'), 'utf8'))
  for (const [key, value] of Object.entries(FORCED_OFF)) {
    if (config[key] !== value) throw new Error(`沙箱的 ${key} 沒有被關掉`)
  }
}

function main() {
  if (!fs.existsSync(REAL)) {
    console.log(`找不到你的 userData（${REAL}），沙箱會從空的開始`)
  }
  for (const line of seed()) console.log(`  ${line}`)
  verify()
  console.log(`\n沙箱：${SANDBOX}`)

  if (has('--no-launch')) return
  const packed = has('--packed')
  const exe = packed
    ? path.join(ROOT, 'dist', 'win-unpacked', 'VoiceInk.exe')
    : path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  if (!fs.existsSync(exe)) {
    console.error(`找不到 ${exe}${packed ? '——先跑 npm run electron:pack' : ''}`)
    process.exitCode = 1
    return
  }
  const argv = packed ? [] : [ROOT]
  console.log(`啟動：${path.basename(exe)}\n`)
  spawn(exe, [...argv, `--user-data-dir=${SANDBOX}`], { stdio: 'inherit' })
    .on('exit', (code) => { process.exitCode = code || 0 })
}

main()
