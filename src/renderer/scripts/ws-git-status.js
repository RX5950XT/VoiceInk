import { electronAPI } from './app.js'

/**
 * `workspace.gitStatus` 的共用結果。
 *
 * 檔案樹（`workspace-page.js`）與編輯器的「未提交變更」鈕（`ws-tabs.js`）要的是
 * **同一份答案**，卻各打各的：切一次分頁、監看跳一次，就是兩三趟完整 `git status`
 * ——那是這個模組裡最貴的一支 git 指令（大 repo 幾百毫秒）。
 *
 * 只做兩件事：同時發生的請求共用一個 in-flight promise，並在 `CACHE_MS` 內重用結果。
 * 不做精細的失效條件——會改動 git 狀態的操作全部走 `invalidateGitStatus()`，
 * 其餘情況慢半秒拿到新狀態不影響任何判斷（監看本來就會讓兩邊重讀）。
 */

/** 同一份結果最多重用多久 */
const CACHE_MS = 500

/** @type {{ projectId: string, at: number, promise: Promise<any> } | null} */
let cached = null

/**
 * 讀這個專案的 git 狀態，短時間內的重複呼叫共用同一趟。
 * @param {string} projectId
 * @returns {Promise<any>}
 */
export function gitStatusShared(projectId) {
  const now = Date.now()
  if (cached && cached.projectId === projectId && now - cached.at < CACHE_MS) return cached.promise
  const promise = electronAPI.workspace.gitStatus(projectId)
  cached = { projectId, at: now, promise }
  // 失敗不留在快取裡，否則接下來半秒每個人都拿到同一個錯誤
  promise.catch(() => {
    if (cached?.promise === promise) cached = null
  })
  return promise
}

/**
 * 剛動過 git（暫存／取消／捨棄／提交…），下一次一定要重讀。
 */
export function invalidateGitStatus() {
  cached = null
}
