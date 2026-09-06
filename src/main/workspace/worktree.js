'use strict'

/**
 * git worktree（Main Process）。
 *
 * 一個 repo 可以同時攤開好幾個分支在不同資料夾裡——想在 A 分支跑測試、
 * 同時在 B 分支改東西，不必 stash 也不必 clone 第二份。
 *
 * 三條規則跟 `git.js` 完全一樣（參數走陣列、不透傳 stderr、關互動提示），
 * 另外多兩條**只屬於 worktree 的**：
 *
 * 1. **路徑一律由 main 組**：renderer 只送一個「名字」，走 `files.checkName`
 *    那套白名單，實際位置固定是 repo 的**兄弟資料夾**（`<repo>-<名字>`）。
 *    收 renderer 給的路徑等於「幫你在任意位置建一個 git 工作樹」。
 * 2. **要移除哪一個，用列舉出來的清單比對**：`git worktree list` 回什麼、
 *    才准移除什麼。這比自己驗字串可靠——那份清單就是 git 自己認得的東西。
 *
 * 建好之後會**順手加進 `workspaces.json`**，不然使用者要自己再拖一次資料夾進來。
 */

const path = require('path')
const { spawn } = require('child_process')
const store = require('./store')
const files = require('./files')

/** worktree 的建立要 checkout 整棵樹，比一般 git 指令久 */
const TIMEOUT_MS = 120000
/** 最多列幾個（正常人不會超過十幾個，這只是防呆） */
const MAX_TREES = 50

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
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{ code: number, stdout: string }>}
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
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: '',
          SSH_ASKPASS: '',
          GCM_INTERACTIVE: 'Never',
          GIT_OPTIONAL_LOCKS: '0'
        }
      })
    } catch {
      reject(fail('NO_GIT', '這台機器上找不到 git'))
      return
    }
    let stdout = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(fail('TIMEOUT', 'git 沒有在時間內回應'))
    }, TIMEOUT_MS)
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    // stderr 刻意整包丟掉：裡面有遠端網址、使用者名稱，有時候還有 token
    child.stderr.on('data', () => {})
    child.on('error', () => {
      clearTimeout(timer)
      reject(fail('NO_GIT', '這台機器上找不到 git'))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code === null ? 1 : code, stdout })
    })
  })
}

/**
 * @param {string} projectId
 * @returns {Promise<string>}
 */
async function rootOf(projectId) {
  const project = await store.get(projectId)
  if (!project) throw fail('NOT_FOUND', '找不到這個專案')
  return project.path
}

/**
 * 解析 `git worktree list --porcelain`。
 *
 * 格式是「一段一個工作樹、空行分隔」，每段的第一行一定是 `worktree <路徑>`，
 * 之後可能有 `HEAD <sha>`／`branch refs/heads/x`／`detached`／`bare`／`locked`。
 * **逐行看關鍵字、不要數行號**——沒有分支的那種段落會少好幾行。
 *
 * @param {string} raw
 * @returns {Array<{ path: string, branch: string, head: string, detached: boolean, bare: boolean, locked: boolean }>}
 */
function parseList(raw) {
  const out = []
  let current = null
  const flush = () => {
    if (current) out.push(current)
    current = null
  }
  for (const line of String(raw || '').split('\n')) {
    const text = line.replace(/\r$/, '')
    if (!text) {
      flush()
      continue
    }
    if (text.startsWith('worktree ')) {
      flush()
      current = {
        path: text.slice(9),
        branch: '',
        head: '',
        detached: false,
        bare: false,
        locked: false
      }
      continue
    }
    if (!current) continue
    if (text.startsWith('HEAD ')) current.head = text.slice(5).slice(0, 12)
    else if (text.startsWith('branch ')) current.branch = text.slice(7).replace(/^refs\/heads\//, '')
    else if (text === 'detached') current.detached = true
    else if (text === 'bare') current.bare = true
    else if (text === 'locked' || text.startsWith('locked ')) current.locked = true
  }
  flush()
  return out.slice(0, MAX_TREES)
}

/**
 * 這個專案底下有哪些工作樹。第一個一定是主工作樹（git 自己這樣排）。
 *
 * @param {string} projectId
 * @returns {Promise<{ supported: boolean, trees: Array<any> }>}
 */
async function list(projectId) {
  const cwd = await rootOf(projectId)
  const res = await run(cwd, ['worktree', 'list', '--porcelain'])
  if (res.code !== 0) return { supported: false, trees: [] }
  const trees = parseList(res.stdout)
  const here = path.resolve(cwd)
  // 側欄裡已經有哪幾棵：沒有的那幾棵 UI 要給一顆「加入」，不然只看得到卻切不過去
  const known = new Map()
  try {
    for (const project of await store.list()) known.set(keyOf(project.path), project.id)
  } catch {
    // 讀不到清單就當成都沒加過
  }
  return {
    supported: true,
    trees: trees.map((tree, index) => ({
      ...tree,
      main: index === 0,
      current: path.resolve(tree.path) === here,
      projectId: known.get(keyOf(tree.path)) || ''
    }))
  }
}

/**
 * 路徑比對的鍵（Windows 不分大小寫，尾巴的分隔符號也要收掉）。
 * @param {string} value
 * @returns {string}
 */
function keyOf(value) {
  const full = path.resolve(String(value || ''))
  return process.platform === 'win32' ? full.toLowerCase() : full
}

/**
 * 用列舉出來的清單當白名單，把 renderer 給的路徑對回一棵真的工作樹。
 * @param {string} projectId
 * @param {unknown} treePath
 * @returns {Promise<{ tree: object, index: number, trees: Array<object> }>}
 */
async function locate(projectId, treePath) {
  const { trees } = await list(projectId)
  const wanted = keyOf(String(treePath || ''))
  const index = trees.findIndex((tree) => keyOf(tree.path) === wanted)
  if (index < 0) throw fail('NOT_FOUND', '找不到這個工作樹')
  return { tree: trees[index], index, trees }
}

/**
 * 把一棵**已經存在**的工作樹加進側欄（`git worktree add` 是別的地方跑的、
 * 或是上一次移除專案時被拿掉了）。路徑一樣走「列舉當白名單」，
 * renderer 給的字串只能對應到 git 自己列得出來的那幾棵。
 * @param {string} projectId
 * @param {unknown} treePath
 * @returns {Promise<{ projectId: string, path: string, branch: string }>}
 */
async function adopt(projectId, treePath) {
  const { tree } = await locate(projectId, treePath)
  const project = await store.create({ path: tree.path })
  return { projectId: project.id, path: tree.path, branch: tree.branch }
}

/**
 * 數 `git status --porcelain -z` 有幾個檔案擋著，順便挑幾個檔名講出來。
 *
 * **改名／複製是兩格**（`R  <新檔>\0<原檔>\0`）：把每一格都當成一個檔案的話，
 * 一次改名會被算成兩個，而且原檔名那一格沒有 `XY ` 前綴，`slice(3)` 會把它砍掉三個字，
 * 使用者看到的是一個被切了頭的檔名。
 *
 * @param {string} stdout
 * @returns {{ dirty: number, samples: string[] }}
 */
function parseDirty(stdout) {
  let dirty = 0
  /** @type {string[]} */
  const samples = []
  const records = String(stdout || '').split('\0')
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]
    if (!record.trim()) continue
    dirty += 1
    if (samples.length < 5) samples.push(record.slice(3))
    if (record[0] === 'R' || record[0] === 'C') i += 1
  }
  return { dirty, samples }
}

/**
 * 移除前先問「有沒有東西擋著」。git 自己會擋，但那時只回一個非 0，
 * 使用者看到的是「移不掉」——講不出是**哪幾個檔案**還沒提交。
 *
 * @param {string} projectId
 * @param {unknown} treePath
 * @returns {Promise<{ path: string, branch: string, main: boolean, locked: boolean, dirty: number, samples: string[], removable: boolean, reason: string }>}
 */
async function check(projectId, treePath) {
  const { tree, index } = await locate(projectId, treePath)
  const res = await run(tree.path, ['status', '--porcelain', '-z'])
  const { dirty, samples } = parseDirty(res.code === 0 ? res.stdout : '')
  const main = index === 0
  const reason = main
    ? '這是主工作樹，不能從這裡移除'
    : tree.locked
      ? '這棵樹被 git 鎖住了（先 git worktree unlock）'
      : dirty
        ? `裡面有 ${dirty} 個還沒提交的變更，移掉就沒了`
        : ''
  return {
    path: tree.path,
    branch: tree.branch,
    main,
    locked: Boolean(tree.locked),
    dirty,
    samples,
    removable: !main && !tree.locked && dirty === 0,
    reason
  }
}

/**
 * 分支名的白名單。那個字串會變成 `git worktree add -b <名字>` 的參數，
 * 雖然走陣列不會被 shell 吃掉，但 `-` 開頭會被 git 當成選項。
 *
 * @param {string} raw
 * @returns {string}
 */
function checkBranch(raw) {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (!name || name.length > 100) throw fail('BAD_BRANCH', '分支名稱不合法')
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/')) {
    throw fail('BAD_BRANCH', '分支名稱不合法')
  }
  if (name.includes('..') || !/^[A-Za-z0-9._/-]+$/.test(name)) {
    throw fail('BAD_BRANCH', '分支名稱只能用英數字與 . _ / -')
  }
  return name
}

/**
 * 開一個新的工作樹。
 *
 * 位置固定在 repo 的**兄弟資料夾**（`<repo 名>-<名字>`）——放在 repo 裡面的話
 * 那棵樹會出現在自己的檔案清單、被搜尋掃到、還可能被誤 commit 進去。
 *
 * `base` 留空就從目前 HEAD 開新分支；填了就從那個 ref 開。
 *
 * @param {string} projectId
 * @param {string} rawName 新分支與資料夾的名字（同一個）
 * @param {string} [base] 從哪個 ref 開（空＝目前 HEAD）
 * @returns {Promise<{ path: string, branch: string }>}
 */
async function add(projectId, rawName, base = '') {
  const cwd = await rootOf(projectId)
  // 資料夾名走跟「新增檔案」同一套白名單（擋掉路徑分隔、Windows 保留字…）
  const name = files.checkName(rawName)
  const branch = checkBranch(name)
  const target = path.join(path.dirname(path.resolve(cwd)), `${path.basename(path.resolve(cwd))}-${name}`)

  const args = ['worktree', 'add', '-b', branch, target]
  if (base) args.push(checkBranch(base))
  const res = await run(cwd, args)
  if (res.code !== 0) {
    throw fail('ADD_FAILED', '建不出工作樹（名字重複，或這個資料夾已經有東西了）')
  }
  // 順手加進側欄，不然使用者還要自己再拖一次資料夾進來。
  // **id 要回給 renderer**：建完馬上切過去，不必再重載一次清單去猜是哪一個。
  let addedId = ''
  try {
    addedId = (await store.create({ path: target })).id
  } catch {
    // 超過上限：工作樹本身建好了就算成功，只是側欄裡沒有
  }
  return { path: target, branch, projectId: addedId }
}

/**
 * 移掉一個工作樹。**只准移 `git worktree list` 列得出來的**（用列舉當白名單），
 * 而且不准移主工作樹——那是 repo 本身。
 *
 * 有未提交的變更時 git 自己會擋下來（我們不加 `--force`）：
 * 那些改動只存在那個資料夾裡，強制刪掉就沒了。
 *
 * @param {string} projectId
 * @param {string} treePath
 */
async function remove(projectId, treePath) {
  const cwd = await rootOf(projectId)
  const state = await check(projectId, treePath)
  // 先講清楚是什麼擋著（git 只會回一個非 0，使用者看到的是「移不掉」三個字）
  if (!state.removable) throw fail('BLOCKED', state.reason || '這個工作樹現在移不掉')

  const res = await run(cwd, ['worktree', 'remove', state.path])
  if (res.code !== 0) {
    throw fail('REMOVE_FAILED', '移不掉（git 拒絕了，細節看終端機）')
  }
  try {
    const wanted = keyOf(state.path)
    const project = (await store.list()).find((one) => keyOf(one.path) === wanted)
    if (project) await store.remove(project.id)
  } catch {
    // 側欄沒清掉不影響工作樹本身已經移除
  }
  return { path: state.path }
}

module.exports = {
  TIMEOUT_MS,
  MAX_TREES,
  parseList,
  parseDirty,
  checkBranch,
  keyOf,
  list,
  adopt,
  check,
  add,
  remove
}
