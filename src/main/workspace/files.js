'use strict'

/**
 * 工作區的檔案存取（Main Process）——**整個功能唯一的檔案系統入口**。
 *
 * 信任邊界就在這裡：renderer 一律送 `{ projectId, relPath }`，
 * 絕對路徑由 `store.get(projectId)` 拿到專案根目錄之後在這裡組出來。
 * 收 renderer 給的絕對路徑等於把「讀寫任意檔案」變成一個 API
 * （`hfmodels/index.js` 的註解已經定過這條調）。
 *
 * `resolveIn` 是那道門：組完之後必須仍在根目錄底下，否則一律拒絕。
 */

const fs = require('../raw-fs')
const fsp = require('../raw-fs').promises
const path = require('path')
const { removeTreeSync } = require('../safe-rm')

/** 單層目錄最多列幾筆（`node_modules` 那種一層幾千個的不要把 UI 弄死） */
const MAX_ENTRIES = 2000
/**
 * 純文字的讀檔上限。畫面是 Monaco（虛擬捲動，20MB 以上自己關掉高亮，跟 VS Code 同一套），
 * 幾十萬行的 JSON 開得動。圖片／PDF／影音不受這條管（走 `media.js` 串流）。
 */
const MAX_TEXT_BYTES = 50 * 1024 * 1024
/** 寫檔上限：跟讀檔同一條線，開得起來的就存得回去 */
const MAX_WRITE_CHARS = MAX_TEXT_BYTES
/** 一次拖進來最多幾個頂層項目（檔案或資料夾各算一個） */
const MAX_IMPORT_ITEMS = 50
/** 遞迴展開後最多幾個檔案（跟搜尋的 8000 同一量級，避免整顆磁碟拖進來） */
const MAX_IMPORT_FILES = 8000
/** 單檔上限：比編輯器的 50MB 大，影片／壓縮檔加得進去，但不會去複製幾十 GB 的 ISO */
const MAX_IMPORT_FILE_BYTES = 200 * 1024 * 1024
/** 單次匯入總量上限 */
const MAX_IMPORT_TOTAL_BYTES = 1024 * 1024 * 1024

/** 看得懂的圖片副檔名 → MIME（預覽走 `vi-media://`，見 `media.js`） */
const IMAGE_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml'
}

const AUDIO_MIME = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac'
}

const VIDEO_MIME = {
  mp4: 'video/mp4',
  webm: 'video/webm'
}

/**
 * @param {string} full
 * @returns {string} MIME；不是圖片回空字串
 */
function imageMime(full) {
  const ext = path.extname(full).slice(1).toLowerCase()
  return IMAGE_MIME[ext] || ''
}

/**
 * @param {string} full
 * @returns {string} MIME；不是音訊回空字串
 */
function audioMime(full) {
  const ext = path.extname(full).slice(1).toLowerCase()
  return AUDIO_MIME[ext] || ''
}

/**
 * @param {string} full
 * @returns {string} MIME；不是影片回空字串
 */
function videoMime(full) {
  const ext = path.extname(full).slice(1).toLowerCase()
  return VIDEO_MIME[ext] || ''
}

/**
 * 預覽走 `vi-media://` 的那幾種（見 `media.js`）。
 * @param {string} full
 * @returns {'pdf' | 'audio' | 'video' | 'image' | ''}
 */
function mediaKind(full) {
  if (path.extname(full).slice(1).toLowerCase() === 'pdf') return 'pdf'
  return audioMime(full) ? 'audio' : videoMime(full) ? 'video' : imageMime(full) ? 'image' : ''
}

/**
 * @param {string} full
 * @returns {string} MIME；不是媒體回空字串
 */
function mediaMime(full) {
  const kind = mediaKind(full)
  return kind === 'pdf' ? 'application/pdf' : kind ? (audioMime(full) || videoMime(full) || imageMime(full)) : ''
}

/** 列目錄時直接跳過的名字（點進去只有雜訊，而且動輒上萬筆） */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', '__pycache__', '.next', '.turbo'])

/**
 * @param {string} code
 * @param {string} message
 * @returns {Error}
 */
function fail(code, message) {
  const error = new Error(code)
  error.code = code
  error.userMessage = message
  return error
}

/**
 * 把 relPath 接到專案根目錄底下，並確認沒有逃出去。
 *
 * 擋的是三種：`..` 往上爬、絕對路徑（`C:\Windows\...`、`/etc/passwd`）、
 * 以及 `D:\Proj-evil` 這種「字首相同但其實是別的資料夾」——所以比對要帶上路徑分隔符號。
 *
 * @param {string} root 專案根目錄（已經是絕對路徑）
 * @param {unknown} relPath
 * @returns {string} 絕對路徑
 */
function resolveIn(root, relPath) {
  const base = path.resolve(root)
  const rel = typeof relPath === 'string' ? relPath : ''
  if (rel.includes('\0')) throw fail('BAD_PATH', '路徑不合法')
  const full = path.resolve(base, rel)
  if (full !== base && !full.startsWith(path.join(base, path.sep))) {
    throw fail('BAD_PATH', '路徑超出專案範圍')
  }
  assertInsideReal(base, full)
  return full
}

/**
 * 解開連結之後的真實路徑；解不開（不存在、權限不足）回空字串。
 * @param {string} target
 * @returns {string}
 */
function realOf(target) {
  try {
    return fs.realpathSync.native(target)
  } catch {
    return ''
  }
}

/**
 * 確認解開所有連結之後仍然在專案裡。
 *
 * **字面比對擋不住資料夾連結**：在專案裡建一個指向 `C:\` 的 junction，
 * `path.resolve` 看到的還是專案內的路徑，實際讀到的卻是整台電腦。
 * 專案根目錄自己住在連結底下是合法的，所以基準也要解開再比。
 * 還不存在的路徑（新增檔案）往上找到第一個存在的祖先，把剩下那段接回去比。
 *
 * @param {string} base 專案根目錄（已 resolve）
 * @param {string} full 已通過字面檢查的絕對路徑
 */
function assertInsideReal(base, full) {
  const realRoot = realOf(base)
  // 根目錄本身解不開（隨身碟拔掉、網路磁碟沒接上）：交給後面的 stat 去報錯，
  // 在這裡拒絕的話錯誤訊息會變成「路徑超出專案範圍」，指不到真正的原因
  if (!realRoot) return
  let probe = full
  let tail = ''
  for (;;) {
    const real = realOf(probe)
    if (real) {
      const target = tail ? path.resolve(real, tail) : real
      if (target !== realRoot && !target.startsWith(path.join(realRoot, path.sep))) {
        throw fail('BAD_PATH', '路徑超出專案範圍')
      }
      return
    }
    const up = path.dirname(probe)
    if (up === probe) return
    tail = tail ? path.join(path.basename(probe), tail) : path.basename(probe)
    probe = up
  }
}

/**
 * 從絕對路徑回推專案內的相對路徑（一律用 `/`，renderer 那邊比對才不會被分隔符號咬到）。
 * @param {string} root
 * @param {string} full
 * @returns {string}
 */
function toRel(root, full) {
  return path.relative(path.resolve(root), full).split(path.sep).join('/')
}

/**
 * 列一層目錄。**不遞迴、不追 symlink**（用 `withFileTypes` 的 dirent 判斷，
 * symlink 一律當檔案不展開，免得繞著循環走）。
 *
 * @param {string} root
 * @param {unknown} relPath
 * @returns {Promise<{ path: string, entries: Array<{ name: string, rel: string, dir: boolean }>, truncated: boolean }>}
 */
async function listDir(root, relPath) {
  const full = resolveIn(root, relPath)
  let dirents
  try {
    dirents = await fsp.readdir(full, { withFileTypes: true })
  } catch {
    throw fail('READ_FAILED', '讀不到這個資料夾')
  }
  const entries = []
  let truncated = false
  for (const dirent of dirents) {
    if (dirent.isDirectory() && SKIP_DIRS.has(dirent.name.toLowerCase())) continue
    if (entries.length >= MAX_ENTRIES) {
      truncated = true
      break
    }
    entries.push({
      name: dirent.name,
      rel: toRel(root, path.join(full, dirent.name)),
      dir: dirent.isDirectory()
    })
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
  return { path: toRel(root, full), entries, truncated }
}

/**
 * 讀一個檔案。二進位檔（含 NUL byte）與過大的檔案都不回內容——
 * 回一個旗標讓 UI 講清楚，比丟一堆亂碼進 textarea 好。
 *
 * 圖片／PDF／影音是例外：它們一定含 NUL byte，被判成「二進位檔」的話點開等於什麼都沒有，
 * 所以**先看副檔名**，只回 `media` 種類、不讀內容——畫面由 `index.js` 補上的
 * `vi-media://` 網址串流（見 `media.js`），所以沒有大小上限。
 *
 * @param {string} root
 * @param {unknown} relPath
 * @returns {Promise<{ rel: string, content: string, binary: boolean, tooLarge: boolean, size: number, media?: string }>}
 */
async function readFile(root, relPath) {
  const full = resolveIn(root, relPath)
  let stat
  try {
    stat = await fsp.stat(full)
  } catch {
    throw fail('READ_FAILED', '讀不到這個檔案')
  }
  if (!stat.isFile()) throw fail('NOT_A_FILE', '這不是一個檔案')
  const rel = toRel(root, full)
  const ext = path.extname(full).slice(1).toLowerCase()
  const base = { rel, content: '', binary: false, tooLarge: false, size: stat.size, ext, mtimeMs: stat.mtimeMs }
  const media = mediaKind(full)
  // SVG 也是純文字：同時回 content，讓使用者可以切換「預覽」或「編輯原始碼」
  if (media && (ext !== 'svg' || stat.size > MAX_TEXT_BYTES)) return { ...base, media }
  if (stat.size > MAX_TEXT_BYTES) return { ...base, tooLarge: true }
  const buf = await fsp.readFile(full)
  if (media) return { ...base, media, content: buf.includes(0) ? '' : buf.toString('utf8') }
  if (buf.includes(0)) return { ...base, binary: true }
  return { ...base, content: buf.toString('utf8') }
}

/** 暫存檔的流水號：同一個檔案同時被存兩次時，兩份暫存檔不可以撞在一起 */
let tmpSeq = 0

/**
 * 同一個檔案的寫入佇列。
 *
 * 光把暫存檔取成不同名字還不夠：**Windows 上兩個 rename 同時指向同一個目的地會直接失敗**
 * （實測併發存檔會拿到 EPERM，UI 看到的是「存檔失敗」，而使用者只是連按了兩次儲存）。
 * 一個檔案一條鏈，排隊跑完就把鏈拿掉。
 *
 * @type {Map<string, Promise<any>>}
 */
const writeChains = new Map()

/**
 * @template T
 * @param {string} full
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function queueWrite(full, task) {
  const prev = writeChains.get(full) || Promise.resolve()
  const next = prev.then(task, task)
  writeChains.set(full, next)
  const done = () => {
    if (writeChains.get(full) === next) writeChains.delete(full)
  }
  next.then(done, done)
  return next
}

/**
 * 存檔。先寫暫存再 rename（原子替換）——中途失敗不會留下寫到一半的原檔。
 *
 * `expectedMtimeMs` 是**開檔（或上次存檔）當下磁碟的版本**：對不上就代表這份檔案
 * 在外面被改過或被刪掉了，這時一律拒絕，讓 UI 去問使用者要比較、重載還是覆寫。
 * 沒帶這個參數＝明確要求覆寫（使用者按過「覆寫」那顆）。
 *
 * @param {string} root
 * @param {unknown} relPath
 * @param {unknown} content
 * @param {unknown} [expectedMtimeMs]
 * @returns {Promise<{ rel: string, size: number }>}
 */
async function writeFile(root, relPath, content, expectedMtimeMs) {
  if (typeof content !== 'string') throw fail('BAD_CONTENT', '內容不合法')
  if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_CHARS) throw fail('TOO_LARGE', '檔案太大，存不下')
  const full = resolveIn(root, relPath)
  return queueWrite(full, async () => {
    let stat = null
    try {
      stat = await fsp.stat(full)
    } catch {
      // 不存在 → 允許新建（但目錄必須已經在）
    }
    if (stat && !stat.isFile()) throw fail('NOT_A_FILE', '這不是一個檔案')
    const expected = Number(expectedMtimeMs)
    if (Number.isFinite(expected) && expected > 0) {
      if (!stat) throw fail('STALE', '原本的檔案已經不在了（被刪除或改名）')
      // mtime 是浮點毫秒，某些檔案系統的精度只到毫秒 → 差 1ms 以內當成同一版
      if (Math.abs(stat.mtimeMs - expected) > 1) throw fail('STALE', '這個檔案在外部被改過了')
    }
    const tmp = `${full}.${process.pid}-${(tmpSeq += 1)}.voiceink-tmp`
    try {
      await fsp.writeFile(tmp, content, 'utf8')
      await fsp.rename(tmp, full)
    } catch {
      try {
        await fsp.unlink(tmp)
      } catch {
        // 暫存檔清不掉就算了，不要蓋掉真正的錯誤
      }
      throw fail('WRITE_FAILED', '存檔失敗')
    }
    const after = await fsp.stat(full)
    return { rel: toRel(root, full), size: Buffer.byteLength(content, 'utf8'), mtimeMs: after.mtimeMs }
  })
}

/**
 * 檢查一個「單層名字」（新增與改名都用它）。
 *
 * 這個字串是使用者打的，會被接到路徑上——**不准含任何分隔符號**，
 * 也不准是 `.` 或 `..`。`resolveIn` 是最後一道門，但在這裡就擋掉才講得出人話。
 * Windows 另外有一批保留字元與保留檔名（`CON`、`PRN`…），建出來會是個刪不掉的東西。
 *
 * @param {unknown} raw
 * @returns {string}
 */
function checkName(raw) {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (!name || name.length > 255) throw fail('BAD_NAME', '名稱不合法')
  if (name === '.' || name === '..') throw fail('BAD_NAME', '名稱不合法')
  // eslint-disable-next-line no-control-regex
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(name)) {
    throw fail('BAD_NAME', '名稱不能含 \\ / : * ? " < > | 這些字元')
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) throw fail('BAD_NAME', '這是 Windows 的保留名稱')
  if (/[. ]$/.test(name)) throw fail('BAD_NAME', '名稱不能以句點或空白結尾')
  return name
}

/**
 * 在 `relDir` 底下新增一個空檔案或資料夾。已經存在就拒絕（不覆蓋別人的東西）。
 * @param {string} root
 * @param {unknown} relDir 要建在哪個資料夾（空字串＝專案根目錄）
 * @param {unknown} rawName
 * @param {boolean} dir true＝資料夾
 * @returns {Promise<{ rel: string, dir: boolean }>}
 */
async function createEntry(root, relDir, rawName, dir) {
  const name = checkName(rawName)
  const parent = resolveIn(root, relDir)
  const full = resolveIn(root, path.join(toRel(root, parent), name))
  if (fs.existsSync(full)) throw fail('EXISTS', '這個名字已經有東西了')
  try {
    if (dir) await fsp.mkdir(full)
    else await fsp.writeFile(full, '', { flag: 'wx' })
  } catch {
    throw fail('CREATE_FAILED', dir ? '建不了資料夾' : '建不了檔案')
  }
  return { rel: toRel(root, full), dir: Boolean(dir) }
}

/**
 * 改名（只換名字，不搬家）。
 * @param {string} root
 * @param {unknown} relPath
 * @param {unknown} rawName
 * @returns {Promise<{ rel: string }>}
 */
async function renameEntry(root, relPath, rawName) {
  const name = checkName(rawName)
  const full = resolveExisting(root, relPath)
  if (full === path.resolve(root)) throw fail('BAD_PATH', '不能改專案資料夾本身的名字')
  const next = resolveIn(root, path.join(path.dirname(toRel(root, full)), name))
  if (next === full) return { rel: toRel(root, full) }
  // 大小寫別名可以改；若目錄區分大小寫、確實有另一筆同名項目，仍拒絕覆蓋。
  if (fs.existsSync(next) && (next.toLowerCase() !== full.toLowerCase()
    || fs.readdirSync(path.dirname(full)).includes(name))) throw fail('EXISTS', '這個名字已經有東西了')
  try {
    await fsp.rename(full, next)
  } catch {
    throw fail('RENAME_FAILED', '改名失敗')
  }
  return { rel: toRel(root, next) }
}

/**
 * 刪除檔案或資料夾（資料夾連內容一起）。**專案根目錄本身刪不得**。
 * 二次確認在 UI 那一層做，這裡只負責不越界。
 * @param {string} root
 * @param {unknown} relPath
 * @returns {Promise<{ rel: string }>}
 */
/**
 * 把一個檔案或資料夾搬進另一個資料夾（檔案樹拖曳用）。
 *
 * 兩件事一定要擋，少一件就會弄丟東西：
 * 1. **不能搬進自己底下**（`src` 拖到 `src/lib` 裡）——`rename` 在 Windows 上
 *    對這種情況的行為不一致，最壞會把整棵子樹變成孤兒。
 * 2. **目的地已經有同名的東西就拒絕**，不覆蓋。覆蓋救不回來，
 *    而使用者只是手滑放錯一格。
 *
 * 名字沿用原本的（這是「搬家」不是「改名」，改名走 `renameEntry`）。
 *
 * @param {string} root
 * @param {string} fromRel
 * @param {string} toRelDir 目的地資料夾的相對路徑（空字串＝專案根目錄）
 * @returns {Promise<{ rel: string }>}
 */
async function moveEntry(root, fromRel, toRelDir) {
  const from = resolveExisting(root, fromRel)
  if (from === path.resolve(root)) throw fail('BAD_PATH', '不能搬專案資料夾本身')
  const dir = resolveIn(root, toRelDir || '')
  let stat
  try {
    stat = await fsp.stat(dir)
  } catch {
    throw fail('BAD_PATH', '目的地不存在')
  }
  if (!stat.isDirectory()) throw fail('BAD_PATH', '只能放進資料夾裡')
  if (isIntoSelf(from, dir)) {
    throw fail('BAD_PATH', '不能把資料夾搬進它自己底下')
  }
  const next = path.join(dir, path.basename(from))
  if (next === from) return { rel: toRel(root, from) }
  if (fs.existsSync(next)) throw fail('EXISTS', '那裡已經有同名的東西了')
  try {
    await fsp.rename(from, next)
  } catch {
    throw fail('MOVE_FAILED', '搬不過去')
  }
  return { rel: toRel(root, next) }
}

async function removeEntry(root, relPath) {
  const full = resolveExisting(root, relPath)
  if (full === path.resolve(root)) throw fail('BAD_PATH', '不能刪掉專案資料夾本身')
  try {
    await fsp.rm(full, { recursive: true, force: false })
  } catch {
    throw fail('DELETE_FAILED', '刪不掉')
  }
  return { rel: toRel(root, full) }
}

/**
 * 這個路徑存不存在（給「在檔案總管顯示」之類的前置檢查）。
 * @param {string} root
 * @param {unknown} relPath
 * @returns {string} 絕對路徑；不存在丟錯
 */
function resolveExisting(root, relPath) {
  const full = resolveIn(root, relPath)
  if (!fs.existsSync(full)) throw fail('NOT_FOUND', '找不到這個檔案')
  return full
}
/**
 * 取得檔案的最後修改時間與大小（供外部檔案變更偵測，耗時 <1ms）
 * @param {string} root
 * @param {unknown} relPath
 * @returns {Promise<{ exists: boolean, mtimeMs: number, size: number }>}
 */
async function getFileMtime(root, relPath) {
  const full = resolveIn(root, relPath)
  try {
    const stat = await fsp.stat(full)
    return { exists: stat.isFile(), mtimeMs: stat.mtimeMs, size: stat.size }
  } catch {
    return { exists: false, mtimeMs: 0, size: 0 }
  }
}

/**
 * 同名時變成 `name (2).ext`，不覆寫。回的是檔名不是完整路徑。
 * @param {string} dir
 * @param {string} basename
 * @returns {string}
 */
function uniqueDestName(dir, basename) {
  const ext = path.extname(basename)
  const stem = ext ? basename.slice(0, -ext.length) : basename
  let n = 2
  let name = basename
  while (fs.existsSync(path.join(dir, name))) {
    name = `${stem} (${n})${ext}`
    n += 1
    if (n > 9999) throw fail('EXISTS', '那裡已經有同名的東西了')
  }
  return name
}

/**
 * 來源是使用者電腦上的任意路徑，只放行磁碟機絕對路徑與 UNC，不跟連結走。
 * @param {unknown} raw
 * @returns {string}
 */
function resolveSource(raw) {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (!s || s.includes('\0') || s.length > 32767) throw fail('BAD_PATH', '路徑不合法')
  if (/^\\\\[.?]\\/.test(s)) throw fail('BAD_PATH', '路徑不合法')
  if (!/^[A-Za-z]:[\\/]/.test(s) && !s.startsWith('\\\\')) throw fail('BAD_PATH', '路徑不合法')
  let full
  try {
    full = path.resolve(s)
  } catch {
    throw fail('BAD_PATH', '路徑不合法')
  }
  if (!fs.existsSync(full)) throw fail('NOT_FOUND', '找不到這個檔案')
  return full
}

/**
 * @param {string} from
 * @param {string} dir
 * @returns {boolean}
 */
function isIntoSelf(from, dir) {
  const a = path.resolve(from).toLowerCase()
  const b = path.resolve(dir).toLowerCase()
  return Boolean(a) && (b === a || b.startsWith(a + path.sep))
}

/**
 * 預先量檔數與總量；超過上限整批拒絕，一個都不複製。
 * @param {string} full
 * @param {{ files: number, bytes: number }} acc
 */
function measureEntry(full, acc) {
  let st
  try {
    st = fs.lstatSync(full)
  } catch {
    throw fail('NOT_FOUND', '找不到這個檔案')
  }
  if (st.isSymbolicLink() || st.isFile()) {
    if (st.isFile() && st.size > MAX_IMPORT_FILE_BYTES) {
      throw fail('TOO_LARGE', '檔案太大，加不進去')
    }
    acc.files += 1
    acc.bytes += st.isFile() ? st.size : 0
    if (acc.files > MAX_IMPORT_FILES) throw fail('TOO_MANY', '檔案太多，加不進去')
    if (acc.bytes > MAX_IMPORT_TOTAL_BYTES) throw fail('TOO_LARGE', '檔案太大，加不進去')
    return
  }
  if (!st.isDirectory()) return
  let names
  try {
    names = fs.readdirSync(full)
  } catch {
    throw fail('READ_FAILED', '讀不到這個資料夾')
  }
  for (const name of names) measureEntry(path.join(full, name), acc)
}

/**
 * @param {string} from
 * @param {string} destDir
 * @param {string} root
 * @returns {Promise<string>} 專案內相對路徑
 */
async function copyOne(from, destDir, root) {
  const name = uniqueDestName(destDir, path.basename(from))
  const next = resolveIn(root, path.join(toRel(root, destDir), name))
  try {
    await fsp.cp(from, next, {
      recursive: true,
      force: false,
      errorOnExist: true,
      verbatimSymlinks: true
    })
  } catch {
    if (fs.existsSync(next)) {
      try {
        removeTreeSync(next)
      } catch {
        // 清不掉就留著，不要蓋掉真正的錯誤
      }
    }
    throw fail('COPY_FAILED', '複製失敗')
  }
  return toRel(root, next)
}

/**
 * 從專案外複製檔案／資料夾進來（檔案樹接受外部拖放）。
 * **複製不是搬移**；撞名變成 `name (2).ext`。目的地走 `resolveIn`。
 *
 * @param {string} root
 * @param {unknown} relDir 目的地資料夾的相對路徑（空字串＝專案根目錄）
 * @param {unknown} sourcePaths 來源絕對路徑陣列
 * @returns {Promise<{ imported: number, rels: string[] }>}
 */
async function importDropped(root, relDir, sourcePaths) {
  const dir = resolveIn(root, relDir || '')
  let stat
  try {
    stat = await fsp.stat(dir)
  } catch {
    throw fail('BAD_PATH', '目的地不存在')
  }
  if (!stat.isDirectory()) throw fail('BAD_PATH', '只能放進資料夾裡')
  if (!Array.isArray(sourcePaths)) throw fail('BAD_PATH', '沒有可加入的檔案')
  const sources = []
  for (const raw of sourcePaths) {
    if (typeof raw !== 'string' || !raw.trim()) continue
    sources.push(resolveSource(raw))
  }
  if (!sources.length) throw fail('BAD_PATH', '沒有可加入的檔案')
  if (sources.length > MAX_IMPORT_ITEMS) {
    throw fail('TOO_MANY', `一次最多加入 ${MAX_IMPORT_ITEMS} 個項目`)
  }
  const acc = { files: 0, bytes: 0 }
  for (const from of sources) {
    if (isIntoSelf(from, dir)) throw fail('BAD_PATH', '不能把資料夾複製進它自己底下')
    measureEntry(from, acc)
  }
  const rels = []
  for (const from of sources) rels.push(await copyOne(from, dir, root))
  return { imported: rels.length, rels }
}

module.exports = {
  IMAGE_MIME,
  imageMime,
  mediaKind,
  mediaMime,
  MAX_ENTRIES,
  MAX_TEXT_BYTES,
  MAX_WRITE_CHARS,
  MAX_IMPORT_ITEMS,
  MAX_IMPORT_FILES,
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_TOTAL_BYTES,
  SKIP_DIRS,
  resolveIn,
  resolveExisting,
  toRel,
  listDir,
  readFile,
  writeFile,
  checkName,
  createEntry,
  renameEntry,
  moveEntry,
  importDropped,
  removeEntry,
  getFileMtime
}
