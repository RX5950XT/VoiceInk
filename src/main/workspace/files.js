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

const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')

/** 單層目錄最多列幾筆（`node_modules` 那種一層幾千個的不要把 UI 弄死） */
const MAX_ENTRIES = 2000
/** 讀檔上限：超過就不給編輯（textarea 塞 10MB 會把畫面卡死） */
const MAX_READ_BYTES = 2 * 1024 * 1024
/** 寫檔上限 */
const MAX_WRITE_CHARS = 4 * 1024 * 1024

/**
 * 看得懂的圖片副檔名 → MIME。點開圖片時直接回一個 `data:` URI，
 * 讓 UI 顯示得出來（否則 NUL byte 偵測會把它判成「二進位檔」，等於點開了什麼都沒有）。
 * **不另外開一個 IPC**：走既有的 `readFile`，大小照樣受 `MAX_READ_BYTES` 管。
 */
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
  if (full !== base && !full.startsWith(base + path.sep)) {
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
      if (target !== realRoot && !target.startsWith(realRoot + path.sep)) {
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
    if (dirent.isDirectory() && SKIP_DIRS.has(dirent.name)) continue
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
 * 圖片與 PDF 是例外：它們一定含 NUL byte，被判成「二進位檔」的話點開等於什麼都沒有，
 * 所以**先看副檔名**，回 base64 讓 UI 自己畫（大小照樣受 `MAX_READ_BYTES` 管）。
 *
 * @param {string} root
 * @param {unknown} relPath
 * @returns {Promise<{ rel: string, content: string, binary: boolean, tooLarge: boolean, size: number, image?: string, pdf?: string }>}
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
  if (stat.size > MAX_READ_BYTES) {
    return { rel, content: '', binary: false, tooLarge: true, size: stat.size }
  }
  const buf = await fsp.readFile(full)
  const ext = path.extname(full).slice(1).toLowerCase()
  if (ext === 'pdf') {
    return { rel, content: '', binary: false, tooLarge: false, size: stat.size, ext, pdf: buf.toString('base64'), mtimeMs: stat.mtimeMs }
  }
  const aMime = audioMime(full)
  if (aMime) {
    const audio = `data:${aMime};base64,${buf.toString('base64')}`
    return { rel, content: '', binary: false, tooLarge: false, size: stat.size, ext, audio, mtimeMs: stat.mtimeMs }
  }
  const vMime = videoMime(full)
  if (vMime) {
    const video = `data:${vMime};base64,${buf.toString('base64')}`
    return { rel, content: '', binary: false, tooLarge: false, size: stat.size, ext, video, mtimeMs: stat.mtimeMs }
  }
  const mime = imageMime(full)
  if (mime) {
    const image = `data:${mime};base64,${buf.toString('base64')}`
    // SVG 也是純文字，同時回傳 content，讓使用者可以切換「預覽」或「編輯原始碼」
    const content = ext === 'svg' && !buf.includes(0) ? buf.toString('utf8') : ''
    return { rel, content, binary: false, tooLarge: false, size: stat.size, ext, image, isSvg: ext === 'svg', mtimeMs: stat.mtimeMs }
  }
  if (buf.includes(0)) return { rel, content: '', binary: true, tooLarge: false, size: stat.size, ext, mtimeMs: stat.mtimeMs }
  return { rel, content: buf.toString('utf8'), binary: false, tooLarge: false, size: stat.size, ext, mtimeMs: stat.mtimeMs }
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
  if (content.length > MAX_WRITE_CHARS) throw fail('TOO_LARGE', '檔案太大，存不下')
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
  if (fs.existsSync(next)) throw fail('EXISTS', '這個名字已經有東西了')
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
  if (dir === from || dir.startsWith(from + path.sep)) {
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

module.exports = {
  IMAGE_MIME,
  imageMime,
  MAX_ENTRIES,
  MAX_READ_BYTES,
  MAX_WRITE_CHARS,
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
  removeEntry,
  getFileMtime
}
