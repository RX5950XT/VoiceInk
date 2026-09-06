'use strict'

/**
 * 專案工作區的門面（Main Process）。
 *
 * 把 `projectId` 換成絕對路徑這件事**只在這裡做一次**，底下的 `files.js` 只收根目錄。
 * renderer 從頭到尾看不到絕對路徑以外的東西（除了顯示用的專案路徑本身）。
 */

const { shell } = require('electron')
const store = require('./store')
const files = require('./files')
const git = require('./git')
const worktree = require('./worktree')
const agents = require('./agents')
const search = require('./search')
const ports = require('./ports')
const watch = require('./watch')

/**
 * @param {string} code
 * @param {string} message
 */
function fail(code, message) {
  const error = new Error(code)
  error.code = code
  error.userMessage = message
  return error
}

/**
 * @param {unknown} projectId
 * @returns {Promise<string>} 專案根目錄
 */
async function rootOf(projectId) {
  if (typeof projectId !== 'string' || !projectId) throw fail('NO_PROJECT', '請先選一個專案')
  const project = await store.get(projectId)
  if (!project) throw fail('NO_PROJECT', '找不到這個專案')
  if (!store.pathExists(project.path)) throw fail('NO_PROJECT', '找不到專案資料夾')
  return project.path
}

// ===== 專案 =====

const listProjects = () => store.list()
const addProject = (req) => store.create(req)
const addDropped = (paths) => store.addDropped(paths)
const renameProject = (id, name) => store.rename(id, name)
const removeProject = (id) => store.remove(id)
const reorderProjects = (ids) => store.reorder(ids)

/**
 * 終端機要用的工作目錄。renderer 拿它去 `terminal:create` 的 `cwd`——
 * 那一端自己還會再 `statSync().isDirectory()` 驗一次。
 * @param {unknown} projectId
 */
const projectPath = (projectId) => rootOf(projectId)

// ===== 檔案 =====

async function listDir(projectId, relPath) {
  return files.listDir(await rootOf(projectId), relPath)
}

async function readFile(projectId, relPath) {
  return files.readFile(await rootOf(projectId), relPath)
}

async function writeFile(projectId, relPath, content, expectedMtimeMs) {
  return files.writeFile(await rootOf(projectId), relPath, content, expectedMtimeMs)
}

async function createEntry(projectId, relDir, name, dir) {
  return files.createEntry(await rootOf(projectId), relDir, name, dir === true)
}

async function renameEntry(projectId, relPath, name) {
  return files.renameEntry(await rootOf(projectId), relPath, name)
}

/**
 * 檔案樹拖曳搬檔。目的地一律是**專案內的相對資料夾路徑**，絕對路徑由 main 自己組。
 * @param {string} projectId
 * @param {string} fromRel
 * @param {string} toRelDir
 */
async function moveEntry(projectId, fromRel, toRelDir) {
  return files.moveEntry(await rootOf(projectId), fromRel, toRelDir)
}

async function removeEntry(projectId, relPath) {
  return files.removeEntry(await rootOf(projectId), relPath)
}

async function searchFiles(projectId, query, caseSensitive) {
  return search.search(await rootOf(projectId), query, caseSensitive)
}

/**
 * 快速開檔用的檔案清單（只有相對路徑）。
 * @param {string} projectId
 */
async function listFiles(projectId) {
  return search.listFiles(await rootOf(projectId))
}

async function reveal(projectId, relPath) {
  const full = files.resolveExisting(await rootOf(projectId), relPath)
  shell.showItemInFolder(full)
  return true
}

/**
 * 用系統瀏覽器開一個網址（內建瀏覽器撞到 X-Frame-Options 時的退路）。
 *
 * **只放行 http(s)**：這個字串來自 renderer 的網址列，`file:` 會用檔案總管開本機檔案、
 * 自訂協定會去叫別的程式起來。跟 `markdown.js` 的連結白名單同一條規則。
 * @param {unknown} raw
 * @returns {Promise<boolean>}
 */
async function openExternal(raw) {
  const value = typeof raw === 'string' ? raw.trim() : ''
  let url
  try {
    url = new URL(value)
  } catch {
    throw fail('BAD_URL', '網址不合法')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw fail('BAD_URL', '只支援 http 與 https 的網址')
  }
  await shell.openExternal(url.href)
  return true
}

// ===== 本機埠號 =====

/**
 * 這一項**跟專案無關**（列的是整台機器在聽的埠），所以不吃 projectId。
 */
const listPorts = () => ports.list()

// ===== Git =====

const gitStatus = (projectId) => git.status(projectId)
const gitLog = (projectId) => git.log(projectId)
const gitStage = (projectId, relPath) => git.stage(projectId, relPath)
const gitUnstage = (projectId, relPath) => git.unstage(projectId, relPath)
const gitDiscard = (projectId, relPath) => git.discard(projectId, relPath)
const gitCommit = (projectId, message, stageAll) => git.commit(projectId, message, stageAll)
const gitPush = (projectId) => git.push(projectId)
const gitPull = (projectId) => git.pull(projectId)
const gitDiff = (projectId, relPath, staged) => git.diff(projectId, relPath, staged)
/** git worktree：一個 repo 同時攤開好幾個分支 */
const worktreeList = (projectId) => worktree.list(projectId)
const worktreeAdd = (projectId, name, base) => worktree.add(projectId, name, base)
/** 已經存在但不在側欄的工作樹：直接加進來（路徑走 git 自己列出來的白名單） */
const worktreeAdopt = (projectId, treePath) => worktree.adopt(projectId, treePath)
/** 移除前先問「有沒有東西擋著」，講得出是哪幾個檔案 */
const worktreeCheck = (projectId, treePath) => worktree.check(projectId, treePath)
const worktreeRemove = (projectId, treePath) => worktree.remove(projectId, treePath)
/** 審閱：分支清單／跟某條分支的整體比較／單一檔案對基準點的兩份內容 */
const gitBranches = (projectId) => git.branches(projectId)
const gitCompareBranch = (projectId, ref) => git.compareBranch(projectId, ref)
const gitFileVersionsAgainst = (projectId, relPath, ref) => (
  git.fileVersionsAgainst(projectId, relPath, ref)
)
/** diff 編輯器要的兩份完整內容（unified diff 只夠畫舊的那種逐行檢視） */
const gitFileVersions = (projectId, relPath, staged) => git.fileVersions(projectId, relPath, staged)

// ===== AI 對話記錄 =====

async function agentSessions(projectId) {
  return agents.sessions(await rootOf(projectId))
}

/**
 * 監看專案資料夾。一次只看一個（就是使用者正在看的那個），
 * 事件由 `ipc.js` 轉成 `workspace:changed` 送給主視窗。
 * @param {string} projectId
 * @param {(payload: object) => void} send
 */
async function watchProject(projectId, send) {
  return watch.start(projectId, await rootOf(projectId), send)
}

const unwatchProject = () => {
  watch.stop()
  return true
}

const saveTabsState = (id, tabsState) => store.saveTabsState(id, tabsState)
const getTabsState = (id) => store.getTabsState(id)

async function getFileMtime(projectId, relPath) {
  return files.getFileMtime(await rootOf(projectId), relPath)
}

const gitStageAll = (projectId) => git.stageAll(projectId)
const gitUnstageAll = (projectId) => git.unstageAll(projectId)

/**
 * 接續：**先確認這段對話真的屬於這個專案**再組指令。只驗 id 格式的話，
 * renderer 送別的專案的 session id 進來照樣接得起來。
 * @param {string} projectId
 * @param {string} agent
 * @param {string} sessionId
 */
async function agentResume(projectId, agent, sessionId) {
  return agents.resume(await rootOf(projectId), agent, sessionId)
}

async function agentSessionDetail(projectId, agent, sessionId) {
  return agents.sessionDetail(await rootOf(projectId), agent, sessionId)
}

module.exports = {
  listProjects,
  addProject,
  addDropped,
  renameProject,
  removeProject,
  reorderProjects,
  projectPath,
  saveTabsState,
  getTabsState,
  listDir,
  readFile,
  writeFile,
  getFileMtime,
  createEntry,
  renameEntry,
  moveEntry,
  removeEntry,
  searchFiles,
  listFiles,
  listPorts,
  reveal,
  openExternal,
  gitStatus,
  gitLog,
  gitStage,
  gitUnstage,
  gitStageAll,
  gitUnstageAll,
  gitDiscard,
  gitCommit,
  gitPush,
  gitPull,
  gitDiff,
  gitFileVersions,
  worktreeList,
  worktreeAdd,
  worktreeAdopt,
  worktreeCheck,
  worktreeRemove,
  gitBranches,
  gitCompareBranch,
  gitFileVersionsAgainst,
  watchProject,
  unwatchProject,
  agentSessions,
  agentResume,
  agentSessionDetail
}
