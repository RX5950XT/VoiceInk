'use strict'

/**
 * 專案資料夾的變動監看（Main Process）。
 *
 * 「別人（AI CLI、另一個編輯器、git）改了檔案，畫面自己更新」就是靠這一支。
 * 之前只有在使用者按重新整理時才重讀，跑完一輪 agent 之後整個右側欄都還是舊的。
 *
 * 四條規則：
 *
 * 1. **一次只監看一個專案**（就是使用者正在看的那一個）。每個專案各留一個
 *    recursive watcher 等於在背景把好幾棵樹整個掛住，記憶體與 handle 都不划算。
 * 2. **事件要合併**：存一個檔案在 Windows 上會連發好幾個 `change`，
 *    npm install 更是一秒幾千個。收進一個 Set、`DEBOUNCE_MS` 之後送一次。
 * 3. **`.git` 底下的變動只當成「Git 狀態變了」**，不進檔案清單——
 *    那裡面的 index／lock 檔每次 git 指令都在動，塞進 UI 只是雜訊。
 *    其餘 `SKIP_DIRS`（node_modules…）整段丟掉。
 * 4. **監看失敗不是錯誤**：網路磁碟與某些檔案系統不支援 recursive watch，
 *    回 `{ watching: false }` 讓 UI 安靜退回「手動重新整理」，不要跳錯誤。
 */

const fs = require('fs')
const path = require('path')
const files = require('./files')

/** 合併事件的等待時間 */
const DEBOUNCE_MS = 250
/**
 * 最久等多久一定要送一次。純 trailing debounce 在「事件一直來」時永遠不會觸發
 * （npm install、跑一輪 agent 就是這樣），畫面反而整段時間都不更新——
 * 那正好是最需要更新的時候。
 */
const MAX_WAIT_MS = 1000
/** 一次最多回報幾條路徑（超過就只說「動很多」，讓 UI 整棵重讀） */
const MAX_PATHS = 200

/** @type {{ projectId: string, root: string, watcher: fs.FSWatcher } | null} */
let active = null
/** @type {NodeJS.Timeout | null} */
let timer = null
/** @type {Set<string>} */
let pending = new Set()
let pendingGit = false
let overflow = false
/** 這一批的第一個事件是什麼時候到的（`MAX_WAIT_MS` 的起算點） */
let firstAt = 0

/**
 * 停掉目前的監看。切專案、關 App 都要叫。
 */
function stop() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  pending = new Set()
  pendingGit = false
  overflow = false
  if (!active) return
  try {
    active.watcher.close()
  } catch {
    // 已經掛掉就算了
  }
  active = null
}

/**
 * 這條相對路徑要不要理。
 * @param {string} rel
 * @returns {{ ignore: boolean, git: boolean }}
 */
function classify(rel) {
  const parts = rel.split(/[\\/]/)
  for (const part of parts) {
    if (part === '.git') return { ignore: true, git: true }
    if (files.SKIP_DIRS.has(part)) return { ignore: true, git: false }
  }
  return { ignore: false, git: false }
}

/**
 * 開始監看一個專案。重複呼叫同一個專案不會重開（避免每次切分頁都重掛一次）。
 *
 * @param {string} projectId
 * @param {string} root 專案根目錄（絕對路徑，由 index.js 從 store 取）
 * @param {(payload: { projectId: string, paths: string[], git: boolean, overflow: boolean }) => void} send
 * @returns {{ watching: boolean }}
 */
function start(projectId, root, send) {
  if (active && active.projectId === projectId && active.root === root) return { watching: true }
  stop()
  let watcher
  try {
    watcher = fs.watch(root, { recursive: true, persistent: false })
  } catch {
    // 網路磁碟／不支援 recursive：安靜退回手動重新整理
    return { watching: false }
  }
  const flush = () => {
    timer = null
    const paths = [...pending]
    const git = pendingGit
    const over = overflow
    pending = new Set()
    pendingGit = false
    overflow = false
    if (!paths.length && !git) return
    send({ projectId, paths, git, overflow: over })
  }
  watcher.on('error', () => stop())
  watcher.on('change', (_event, filename) => {
    if (!filename) return
    const rel = String(filename).split(path.sep).join('/')
    const kind = classify(rel)
    if (kind.git) pendingGit = true
    if (!kind.ignore) {
      // 任何檔案動過都代表 git 狀態可能變了（未追蹤、已修改）
      pendingGit = true
      if (pending.size >= MAX_PATHS) overflow = true
      else pending.add(rel)
    }
    if (!timer) firstAt = Date.now()
    else clearTimeout(timer)
    // 事件一直來時把等待時間往上夾在「這批開始後 MAX_WAIT_MS」，不然永遠等不到安靜。
    const wait = Math.min(DEBOUNCE_MS, Math.max(0, firstAt + MAX_WAIT_MS - Date.now()))
    timer = setTimeout(flush, wait)
  })
  active = { projectId, root, watcher }
  return { watching: true }
}

module.exports = {
  DEBOUNCE_MS,
  MAX_WAIT_MS,
  MAX_PATHS,
  classify,
  start,
  stop
}
