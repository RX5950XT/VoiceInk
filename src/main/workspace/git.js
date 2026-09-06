'use strict'

/**
 * 工作區的 Git 狀態（Main Process）。
 *
 * 只做三件事：看狀態、提交、推送。**沒有 git 套件**（simple-git／isomorphic-git 都不裝），
 * 直接 spawn 系統上的 `git`——本來就要有 git 才會有 repo。
 *
 * 三條規則：
 * 1. **參數一律走陣列、`shell` 不開**。commit message 是使用者輸入，
 *    串成字串丟給 shell 就是注入。
 * 2. **不透傳 git 的 stderr**：那裡面有遠端 URL、使用者名稱，有時候還有 token。
 *    回給 renderer 的一律是我們自己寫死的句子（跟雲端路徑的錯誤衛生同一條）。
 * 3. **關掉所有互動提示**：`GIT_TERMINAL_PROMPT=0` 之類的，否則要密碼時
 *    git 會安安靜靜地等一個永遠不會來的輸入，UI 看起來就是「按了沒反應」。
 */

const { spawn } = require('child_process')
const fsp = require('fs/promises')
const store = require('./store')
const files = require('./files')

/** 單次 git 指令的逾時（push 會走網路，給寬一點） */
const TIMEOUT_MS = 60000
/** 變更檔案最多列幾筆（幾萬筆的 repo 不要把 UI 弄死） */
const MAX_FILES = 500

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
 * 執行一次 git。回 `{ code, stdout, stderr }`，**呼叫端只准看 code 與 stdout**。
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function run(cwd, args) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn('git', args, {
        cwd,
        shell: false,
        windowsHide: true,
        env: {
          ...process.env,
          // 要密碼時直接失敗，不要卡在那裡等一個沒有終端機可以輸入的提示
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: '',
          SSH_ASKPASS: '',
          GCM_INTERACTIVE: 'Never',
          GIT_OPTIONAL_LOCKS: '0'
        }
      })
    } catch {
      reject(fail('GIT_MISSING', '找不到 git，請先安裝'))
      return
    }
    let stdout = ''
    let stderr = ''
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      try {
        child.kill()
      } catch {
        // 已經死了就算了
      }
      reject(fail('GIT_TIMEOUT', 'git 沒有在時間內回應'))
    }, TIMEOUT_MS)
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', () => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(fail('GIT_MISSING', '找不到 git，請先安裝'))
    })
    child.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code: code === null ? -1 : code, stdout, stderr })
    })
  })
}

/**
 * 解析 `git status --porcelain=v2 -b -z` 的輸出。純函式，可以直接 node 測。
 *
 * 用 `-z` 是因為預設格式會把含空白／非 ASCII 的檔名加引號再跳脫，
 * 自己反解那套跳脫規則遲早會錯；NUL 分隔沒有這個問題。
 *
 * 記錄型別：`1` 一般變更、`2` 改名（**後面跟著一格原檔名**）、`u` 衝突、`?` 未追蹤、`!` 忽略。
 *
 * @param {string} raw
 * @returns {{ branch: string, upstream: string, ahead: number, behind: number, files: Array<{ path: string, index: string, worktree: string, from: string }>, truncated: boolean }}
 */
function parseStatus(raw) {
  const out = {
    branch: '',
    upstream: '',
    ahead: 0,
    behind: 0,
    files: [],
    truncated: false
  }
  const fields = String(raw || '').split('\0')
  for (let i = 0; i < fields.length; i += 1) {
    const line = fields[i]
    if (!line) continue
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length)
      // detached HEAD 時 git 寫的是字面上的 "(detached)"
      out.branch = head === '(detached)' ? '' : head
      continue
    }
    if (line.startsWith('# branch.upstream ')) {
      out.upstream = line.slice('# branch.upstream '.length)
      continue
    }
    if (line.startsWith('# branch.ab ')) {
      const m = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line)
      if (m) {
        out.ahead = Number(m[1])
        out.behind = Number(m[2])
      }
      continue
    }
    if (line.startsWith('# ')) continue

    const kind = line[0]
    if (kind === '!') continue
    if (kind === '?') {
      pushFile(out, { path: line.slice(2), index: '?', worktree: '?', from: '' })
      continue
    }
    if (kind === '1' || kind === '2' || kind === 'u') {
      const parts = line.split(' ')
      const xy = parts[1] || '..'
      // 1/u 是第 8 欄開始是路徑；2 多一個 <X><score> 欄位 → 第 9 欄
      const pathStart = kind === '2' ? 9 : kind === 'u' ? 10 : 8
      const filePath = parts.slice(pathStart).join(' ')
      let from = ''
      if (kind === '2') {
        // 改名的原檔名是**下一格**（-z 的規定）
        from = fields[i + 1] || ''
        i += 1
      }
      pushFile(out, {
        path: filePath,
        index: kind === 'u' ? 'U' : xy[0] || '.',
        worktree: kind === 'u' ? 'U' : xy[1] || '.',
        from
      })
    }
  }
  return out
}

/**
 * @param {{ files: Array<object>, truncated: boolean }} out
 * @param {object} file
 */
function pushFile(out, file) {
  if (out.files.length >= MAX_FILES) {
    out.truncated = true
    return
  }
  if (file.path) out.files.push(file)
}

/**
 * @param {string} projectId
 * @returns {Promise<string>} 專案根目錄
 */
async function rootOf(projectId) {
  const project = await store.get(projectId)
  if (!project) throw fail('NO_PROJECT', '找不到這個專案')
  if (!store.pathExists(project.path)) throw fail('NO_PROJECT', '找不到專案資料夾')
  return project.path
}

/**
 * @param {string} projectId
 * @returns {Promise<{ repo: boolean, branch?: string, upstream?: string, ahead?: number, behind?: number, files?: Array<object>, truncated?: boolean }>}
 */
async function status(projectId) {
  const cwd = await rootOf(projectId)
  const res = await run(cwd, ['status', '--porcelain=v2', '-b', '-z'])
  // 不是 repo 不是錯誤，是一種正常狀態（使用者就是加了一個普通資料夾）
  if (res.code !== 0) return { repo: false }
  return { repo: true, ...parseStatus(res.stdout) }
}

/**
 * 提交。`stageAll` 為 true 時先 `add -A`；false 只提交已暫存的內容
 * （沒有 staged 變更會拿到 NOTHING_TO_COMMIT）。
 * @param {string} projectId
 * @param {unknown} message
 * @param {boolean} [stageAll]
 * @returns {Promise<{ committed: true }>}
 */
async function commit(projectId, message, stageAll) {
  const text = typeof message === 'string' ? message.trim() : ''
  if (!text) throw fail('NO_MESSAGE', '請先填提交訊息')
  if (text.length > 2000) throw fail('NO_MESSAGE', '提交訊息太長')
  const cwd = await rootOf(projectId)
  if (stageAll === true) {
    const staged = await run(cwd, ['add', '-A'])
    if (staged.code !== 0) throw fail('COMMIT_FAILED', '暫存變更失敗')
  }
  const res = await run(cwd, ['commit', '-m', text])
  if (res.code !== 0) {
    // git 對「沒東西可提交」也回非 0，但那不是失敗，訊息要講得不一樣
    if (/nothing to commit|no changes added/i.test(res.stdout)) {
      throw fail('NOTHING_TO_COMMIT', stageAll ? '沒有可提交的變更' : '沒有已暫存的變更（先按「全部暫存」或逐檔暫存）')
    }
    throw fail('COMMIT_FAILED', '提交失敗（可能是 pre-commit hook 擋下來了，細節看終端機）')
  }
  return { committed: true }
}

/**
 * @param {string} projectId
 * @returns {Promise<{ pushed: true }>}
 */
async function push(projectId) {
  const cwd = await rootOf(projectId)
  const res = await run(cwd, ['push'])
  if (res.code !== 0) throw fail('PUSH_FAILED', '推送失敗（可能是沒有權限或需要先 pull，細節看終端機）')
  return { pushed: true }
}

/**
 * 檔名守衛：這些字串來自 renderer（雖然只該是 status 回過的清單），
 * `--` 之後 git 不再吃選項，但 repo 外的相對路徑與絕對路徑照樣擋掉。
 * @param {unknown} value
 * @returns {string}
 */
function relPathOf(value) {
  const text = typeof value === 'string' ? value : ''
  if (!text || text.length > 1024) throw fail('BAD_PATH', '檔名不合法')
  if (text.startsWith('/') || text.startsWith('\\') || /^[a-zA-Z]:/.test(text)) {
    throw fail('BAD_PATH', '只收專案內的相對路徑')
  }
  if (text.split(/[\\/]/).includes('..')) throw fail('BAD_PATH', '只收專案內的相對路徑')
  return text
}

/**
 * 解析 `git log --pretty=format:%h%x1f%at%x1f%s` 的輸出（記錄以換行分隔、欄位以 %x1f）。
 * 純函式，可直接 node 測。**不能也用 -z**：NUL 同時是記錄與欄位的界線，整包會變成一鍋粥。
 * @param {string} raw
 * @returns {Array<{ short: string, subject: string, at: number }>}
 */
function parseLog(raw) {
  const out = []
  for (const line of String(raw || '').split('\n')) {
    if (!line) continue
    const parts = line.split('\x1f')
    if (parts.length < 3) continue
    const at = Number(parts[1])
    out.push({
      short: parts[0],
      at: Number.isFinite(at) ? at : 0,
      subject: parts[2]
    })
    if (out.length >= 10) break
  }
  return out
}

/**
 * @param {string} projectId
 * @returns {Promise<Array<{ short: string, subject: string, at: number }>>}
 */
async function log(projectId) {
  const cwd = await rootOf(projectId)
  const res = await run(cwd, ['log', '--pretty=format:%h%x1f%at%x1f%s', '-n', '10'])
  // 空 repo（還沒有 commit）不是錯誤，回空清單
  if (res.code !== 0) return []
  return parseLog(res.stdout)
}

/**
 * @param {string} projectId
 * @param {string} relPath
 * @returns {Promise<{ staged: true }>}
 */
async function stage(projectId, relPath) {
  const path = relPathOf(relPath)
  const cwd = await rootOf(projectId)
  const res = await run(cwd, ['add', '--', path])
  if (res.code !== 0) throw fail('STAGE_FAILED', '暫存失敗（細節看終端機）')
  return { staged: true }
}

/**
 * @param {string} projectId
 * @param {string} relPath
 * @returns {Promise<{ unstaged: true }>}
 */
async function unstage(projectId, relPath) {
  const path = relPathOf(relPath)
  const cwd = await rootOf(projectId)
  // `restore` 要 git 2.23+；`reset` 相容性最好
  const res = await run(cwd, ['reset', '-q', 'HEAD', '--', path])
  if (res.code !== 0) throw fail('STAGE_FAILED', '取消暫存失敗')
  return { unstaged: true }
}

/**
 * 全部暫存
 * @param {string} projectId
 * @returns {Promise<{ stagedAll: true }>}
 */
async function stageAll(projectId) {
  const cwd = await rootOf(projectId)
  const res = await run(cwd, ['add', '-A'])
  if (res.code !== 0) throw fail('STAGE_FAILED', '全部暫存失敗')
  return { stagedAll: true }
}

/**
 * 全部取消暫存
 * @param {string} projectId
 * @returns {Promise<{ unstagedAll: true }>}
 */
async function unstageAll(projectId) {
  const cwd = await rootOf(projectId)
  const res = await run(cwd, ['reset', '-q', 'HEAD'])
  if (res.code !== 0) throw fail('STAGE_FAILED', '全部取消暫存失敗')
  return { unstagedAll: true }
}

/**
 * 捨棄一個檔案的變更：已追蹤退回 HEAD 版本、未追蹤直接刪掉。**救不回來**，
 * renderer 那層要做二次確認。
 * @param {string} projectId
 * @param {string} relPath
 * @returns {Promise<{ discarded: true }>}
 */
async function discard(projectId, relPath) {
  const path = relPathOf(relPath)
  const cwd = await rootOf(projectId)
  const stat = await run(cwd, ['status', '--porcelain=v2', '-z', '--', path])
  const wanted = path.replace(/\\/g, '/')
  const entry = parseStatus(stat.stdout).files.find((file) => file.path.replace(/\\/g, '/') === wanted)
  if (!entry) throw fail('BAD_PATH', '找不到這個檔案的變更')
  const untracked = entry.index === '?' && entry.worktree === '?'
  const res = untracked
    ? await run(cwd, ['clean', '-f', '--', path])
    : await run(cwd, ['checkout', '--', path])
  if (res.code !== 0) throw fail('DISCARD_FAILED', '捨棄變更失敗')
  return { discarded: true }
}

/**
 * @param {string} projectId
 * @returns {Promise<{ pulled: true }>}
 */
async function pull(projectId) {
  const cwd = await rootOf(projectId)
  const res = await run(cwd, ['pull', '--ff-only'])
  if (res.code !== 0) throw fail('PULL_FAILED', '拉取失敗（可能需要先處理本機變更，細節看終端機）')
  return { pulled: true }
}

/**
 * 取得指定檔案的變更 diff。
 * @param {string} projectId
 * @param {string} relPath
 * @param {boolean} [staged]
 * @returns {Promise<{ path: string, diff: string, staged: boolean, additions: number, deletions: number }>}
 */
async function diff(projectId, relPath, staged = false) {
  const path = relPathOf(relPath)
  const cwd = await rootOf(projectId)
  const args = staged ? ['diff', '--cached', '--', path] : ['diff', '--', path]
  const res = await run(cwd, args)
  let diffText = res.stdout || ''
  if (!diffText && !staged) {
    // 檢查是否為未追蹤檔案（untracked）
    const stat = await run(cwd, ['status', '--porcelain=v2', '-z', '--', path])
    const wanted = path.replace(/\\/g, '/')
    const entry = parseStatus(stat.stdout).files.find((f) => f.path.replace(/\\/g, '/') === wanted)
    if (entry && entry.index === '?' && entry.worktree === '?') {
      try {
        // 讀磁碟一律走 files.resolveIn（它會連資料夾連結一起解開再比）
        const full = files.resolveIn(cwd, path)
        const content = await fsp.readFile(full, 'utf8')
        const lines = content.split('\n')
        diffText = `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n` +
          lines.map((l) => `+${l}`).join('\n')
      } catch {
        diffText = ''
      }
    }
  }
  let additions = 0
  let deletions = 0
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1
  }
  return { path, diff: diffText, staged: Boolean(staged), additions, deletions }
}

/** diff 編輯器單邊最多讀多少（跟 `files.readFile` 的上限一致） */
const MAX_DIFF_BYTES = 2 * 1024 * 1024

/**
 * 拿某個版本的檔案內容。`git show <rev>:<path>` 在檔案不存在於那個版本時
 * 會回非 0（新檔案就是這樣），那不是錯誤——回空字串就好。
 *
 * @param {string} cwd
 * @param {string} rev 例如 `HEAD` 或 `''`（空＝暫存區，也就是 `:path`）
 * @param {string} relPath
 * @returns {Promise<string>}
 */
async function showAt(cwd, rev, relPath) {
  const res = await run(cwd, ['show', `${rev}:${relPath.replace(/\\/g, '/')}`])
  if (res.code !== 0) return { text: '', truncated: false }
  // 截斷過的內容不可以直接拿去並排：後面那一大段會被畫成「整段刪掉」
  if (res.stdout.length > MAX_DIFF_BYTES) return { text: '', truncated: true }
  return { text: res.stdout, truncated: false }
}

/**
 * diff 編輯器要的是**兩份完整內容**，不是一段 unified diff。
 *
 * 兩種比較的兩端不一樣，不能混：
 * - 工作區（未暫存）＝ 暫存區 → 磁碟上的檔案
 * - 已暫存　　　　　＝ HEAD　 → 暫存區
 *
 * 二進位檔（含 NUL）不回內容——把一堆亂碼餵進編輯器只會卡住。
 *
 * @param {string} projectId
 * @param {string} relPath
 * @param {boolean} [staged]
 * @returns {Promise<{ original: string, modified: string, binary: boolean }>}
 */
async function fileVersions(projectId, relPath, staged = false) {
  const rel = relPathOf(relPath)
  const cwd = await rootOf(projectId)
  const left = await showAt(cwd, staged ? 'HEAD' : '', rel)
  let right
  if (staged) {
    right = await showAt(cwd, '', rel)
  } else {
    try {
      // 走 files.resolveIn，不自己 path.resolve（資料夾連結那條也要擋）
      const buf = await fsp.readFile(files.resolveIn(cwd, rel))
      right = buf.length > MAX_DIFF_BYTES
        ? { text: '', truncated: true }
        : { text: buf.toString('utf8'), truncated: false }
    } catch (error) {
      // 檔案不在了（刪除／改名）＝工作區那一邊是空的，這是正常的一種 diff。
      // 其他錯誤（權限、路徑被擋）不可以畫成空檔——那會看起來像「整份被刪光」，
      // 一律往上丟，讓 UI 退回逐行檢視並講出錯誤。
      if (error?.code !== 'ENOENT') throw error
      right = { text: '', truncated: false }
    }
  }
  const truncated = left.truncated || right.truncated
  const binary = left.text.includes('\u0000') || right.text.includes('\u0000')
  return (binary || truncated)
    ? { original: '', modified: '', binary, truncated }
    : { original: left.text, modified: right.text, binary: false, truncated: false }
}

// ===== 跟某個分支整體比較（審閱）=====

/** 分支清單最多幾筆 */
const MAX_BRANCHES = 100

/**
 * ref 的白名單。那個字串會變成 `git merge-base <ref> HEAD` 的參數——走陣列不會被 shell
 * 吃掉，但 `-` 開頭會被 git 當成選項，`..` 會變成範圍語法。
 * @param {unknown} raw
 * @returns {string}
 */
function checkRef(raw) {
  const ref = typeof raw === 'string' ? raw.trim() : ''
  if (!ref || ref.length > 200) throw fail('BAD_REF', '分支名稱不合法')
  if (ref.startsWith('-') || ref.endsWith('/') || ref.includes('..')) {
    throw fail('BAD_REF', '分支名稱不合法')
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(ref)) throw fail('BAD_REF', '分支名稱只能用英數字與 . _ / -')
  return ref
}

/**
 * 本機與遠端分支清單（給「跟哪個分支比」的下拉）。依最後提交時間排，
 * 常用的那幾個會在最前面。
 * @param {string} projectId
 * @returns {Promise<{ current: string, branches: Array<{ name: string, remote: boolean }> }>}
 */
async function branches(projectId) {
  const cwd = await rootOf(projectId)
  // **`for-each-ref` 不吃 `%x1f`**（那是 `git log` 的 pretty-format）——寫了只會
  // 原樣留在字串裡，分支名整條變成「name%x1frefs/heads/name」。只要 refname，
  // 短名自己剝前綴就好。
  const res = await run(cwd, [
    'for-each-ref',
    '--sort=-committerdate',
    `--count=${MAX_BRANCHES}`,
    '--format=%(refname)',
    'refs/heads',
    'refs/remotes'
  ])
  if (res.code !== 0) return { current: '', branches: [] }
  const head = await run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const out = []
  for (const line of res.stdout.split('\n')) {
    const full = line.trim()
    if (!full) continue
    const remote = full.startsWith('refs/remotes/')
    const name = full.replace(/^refs\/(heads|remotes)\//, '')
    // `origin/HEAD` 只是個指標，列出來按下去會很困惑
    if (!name || name.endsWith('/HEAD')) continue
    out.push({ name, remote })
  }
  return {
    current: head.code === 0 ? head.stdout.trim() : '',
    branches: out
  }
}

/**
 * 解析 `git diff --numstat -z --no-renames`：每筆是 `新增\t刪除\t路徑\0`。
 * 二進位檔的兩個數字是 `-`。純函式，可直接 node 測。
 *
 * **一定要 `--no-renames`**：帶改名偵測時那一筆會變成三格（`add\0from\0to`），
 * 欄位一錯位後面每一筆檔名都跟著錯。
 *
 * @param {string} raw
 * @returns {Array<{ path: string, additions: number, deletions: number, binary: boolean }>}
 */
function parseNumstat(raw) {
  const out = []
  for (const record of String(raw || '').split('\0')) {
    if (!record) continue
    const parts = record.split('\t')
    if (parts.length < 3) continue
    const binary = parts[0] === '-' || parts[1] === '-'
    out.push({
      path: parts.slice(2).join('\t'),
      additions: binary ? 0 : Number(parts[0]) || 0,
      deletions: binary ? 0 : Number(parts[1]) || 0,
      binary
    })
    if (out.length >= MAX_FILES) break
  }
  return out
}

/**
 * 「我這條分支跟 <ref> 差在哪」——審閱整包變更用的。
 *
 * 比的基準是**合併基準點**（`merge-base`），不是那個分支的最新一筆：
 * 直接跟分支頂端比的話，對方後來的提交會被算成「我刪掉的」。
 * 右邊是**工作區**（含還沒提交的改動），因為要審的就是手上這份。
 *
 * @param {string} projectId
 * @param {string} ref
 * @returns {Promise<{ base: string, ref: string, files: Array<object>, truncated: boolean }>}
 */
async function compareBranch(projectId, ref) {
  const target = checkRef(ref)
  const cwd = await rootOf(projectId)
  const merge = await run(cwd, ['merge-base', target, 'HEAD'])
  if (merge.code !== 0) throw fail('NO_BASE', '這兩條分支沒有共同的起點（或分支不存在）')
  const base = merge.stdout.trim()
  const res = await run(cwd, ['diff', '--numstat', '-z', '--no-renames', base, '--'])
  if (res.code !== 0) throw fail('DIFF_FAILED', '比較失敗')
  const files = parseNumstat(res.stdout)
  return {
    base: base.slice(0, 12),
    ref: target,
    files,
    truncated: files.length >= MAX_FILES
  }
}

/**
 * 審閱用的兩份完整內容：左邊是合併基準點那一版，右邊是工作區現在的樣子。
 * 跟 `fileVersions` 的差別只在左邊是哪一版，其餘規則（二進位、截斷）完全一樣。
 *
 * @param {string} projectId
 * @param {string} relPath
 * @param {string} ref
 * @returns {Promise<{ original: string, modified: string, binary: boolean, truncated: boolean }>}
 */
async function fileVersionsAgainst(projectId, relPath, ref) {
  const rel = relPathOf(relPath)
  const target = checkRef(ref)
  const cwd = await rootOf(projectId)
  const merge = await run(cwd, ['merge-base', target, 'HEAD'])
  if (merge.code !== 0) throw fail('NO_BASE', '這兩條分支沒有共同的起點（或分支不存在）')
  const left = await showAt(cwd, merge.stdout.trim(), rel)
  let right
  try {
    const buf = await fsp.readFile(files.resolveIn(cwd, rel))
    right = buf.length > MAX_DIFF_BYTES
      ? { text: '', truncated: true }
      : { text: buf.toString('utf8'), truncated: false }
  } catch (error) {
    // 檔案在這條分支上被刪掉了＝右邊是空的；其他錯誤不可以畫成空檔
    if (error?.code !== 'ENOENT') throw error
    right = { text: '', truncated: false }
  }
  const truncated = left.truncated || right.truncated
  const binary = left.text.includes('\u0000') || right.text.includes('\u0000')
  return (binary || truncated)
    ? { original: '', modified: '', binary, truncated }
    : { original: left.text, modified: right.text, binary: false, truncated: false }
}

module.exports = {
  MAX_FILES,
  MAX_BRANCHES,
  TIMEOUT_MS,
  checkRef,
  parseNumstat,
  branches,
  compareBranch,
  fileVersionsAgainst,
  fileVersions,
  parseStatus,
  parseLog,
  status,
  log,
  stage,
  unstage,
  stageAll,
  unstageAll,
  discard,
  commit,
  push,
  pull,
  diff
}
