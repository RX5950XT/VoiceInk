'use strict'

/**
 * workspace:* IPC。比照 `terminal/ipc.js`：只有主視窗能呼叫，回傳一律 { ok, data } / { ok, error }。
 *
 * 每個對外方法都要在這裡**逐一列舉**——service 加了方法但這裡漏一行，renderer 只會拿到
 * 通用錯誤訊息，完全查不出原因（AGY 與系統監控各踩過一次，CLAUDE.md 有記）。
 *
 * 「加入專案」的資料夾路徑由系統對話框給，或由 OS 的拖放給（preload 的 webUtils.getPathForFile，
 * renderer 不能自己組路徑字串）。拖放那筆在 main 端仍走 `store.create` 的全套驗證。
 */
const { makeInvoke } = require('../ipc-invoke')

function registerWorkspaceIpc({ ipcMain, service, isMainSender, dialog, getWindow }) {
  const invoke = makeInvoke({
    isMainSender,
    forbidden: '僅主視窗可操作工作區',
    code: 'WORKSPACE_ERROR',
    message: '工作區操作失敗'
  })

  // ── 專案 ──
  ipcMain.handle('workspace:listProjects', (event) => (
    invoke(event, () => service.listProjects())
  ))
  ipcMain.handle('workspace:addProject', (event) => invoke(event, async () => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: '選擇專案資料夾',
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    return service.addProject({ path: result.filePaths[0] })
  }))
  ipcMain.handle('workspace:addDropped', (event, paths) => (
    invoke(event, () => service.addDropped(paths))
  ))
  ipcMain.handle('workspace:renameProject', (event, id, name) => (
    invoke(event, () => service.renameProject(id, name))
  ))
  ipcMain.handle('workspace:removeProject', (event, id) => (
    invoke(event, () => service.removeProject(id))
  ))
  ipcMain.handle('workspace:reorderProjects', (event, ids) => (
    invoke(event, () => service.reorderProjects(ids))
  ))
  ipcMain.handle('workspace:projectPath', (event, id) => (
    invoke(event, () => service.projectPath(id))
  ))

  // ── 檔案 ──
  ipcMain.handle('workspace:listDir', (event, id, relPath) => (
    invoke(event, () => service.listDir(id, relPath))
  ))
  ipcMain.handle('workspace:readFile', (event, id, relPath) => (
    invoke(event, () => service.readFile(id, relPath))
  ))
  ipcMain.handle('workspace:writeFile', (event, id, relPath, content) => (
    invoke(event, () => service.writeFile(id, relPath, content))
  ))
  ipcMain.handle('workspace:createEntry', (event, id, relDir, name, dir) => (
    invoke(event, () => service.createEntry(id, relDir, name, dir))
  ))
  ipcMain.handle('workspace:moveEntry', (event, id, fromRel, toRelDir) => (
    invoke(event, () => service.moveEntry(id, fromRel, toRelDir))
  ))
  ipcMain.handle('workspace:renameEntry', (event, id, relPath, name) => (
    invoke(event, () => service.renameEntry(id, relPath, name))
  ))
  ipcMain.handle('workspace:removeEntry', (event, id, relPath) => (
    invoke(event, () => service.removeEntry(id, relPath))
  ))
  ipcMain.handle('workspace:search', (event, id, query, caseSensitive) => (
    invoke(event, () => service.searchFiles(id, query, caseSensitive))
  ))
  ipcMain.handle('workspace:listFiles', (event, id) => (
    invoke(event, () => service.listFiles(id))
  ))
  ipcMain.handle('workspace:listPorts', (event) => (
    invoke(event, () => service.listPorts())
  ))
  ipcMain.handle('workspace:reveal', (event, id, relPath) => (
    invoke(event, () => service.reveal(id, relPath))
  ))

  ipcMain.handle('workspace:openExternal', (event, url) => (
    invoke(event, () => service.openExternal(url))
  ))

  ipcMain.handle('workspace:saveTabsState', (event, id, tabsState) => (
    invoke(event, () => service.saveTabsState(id, tabsState))
  ))
  ipcMain.handle('workspace:getTabsState', (event, id) => (
    invoke(event, () => service.getTabsState(id))
  ))
  ipcMain.handle('workspace:getFileMtime', (event, id, relPath) => (
    invoke(event, () => service.getFileMtime(id, relPath))
  ))

  // ── Git ──
  ipcMain.handle('workspace:gitStatus', (event, id) => (
    invoke(event, () => service.gitStatus(id))
  ))
  ipcMain.handle('workspace:gitLog', (event, id) => (
    invoke(event, () => service.gitLog(id))
  ))
  ipcMain.handle('workspace:gitStage', (event, id, relPath) => (
    invoke(event, () => service.gitStage(id, relPath))
  ))
  ipcMain.handle('workspace:gitUnstage', (event, id, relPath) => (
    invoke(event, () => service.gitUnstage(id, relPath))
  ))
  ipcMain.handle('workspace:gitStageAll', (event, id) => (
    invoke(event, () => service.gitStageAll(id))
  ))
  ipcMain.handle('workspace:gitUnstageAll', (event, id) => (
    invoke(event, () => service.gitUnstageAll(id))
  ))
  ipcMain.handle('workspace:gitDiscard', (event, id, relPath) => (
    invoke(event, () => service.gitDiscard(id, relPath))
  ))
  ipcMain.handle('workspace:gitCommit', (event, id, message, stageAll) => (
    invoke(event, () => service.gitCommit(id, message, stageAll))
  ))
  ipcMain.handle('workspace:gitPush', (event, id) => (
    invoke(event, () => service.gitPush(id))
  ))
  ipcMain.handle('workspace:gitPull', (event, id) => (
    invoke(event, () => service.gitPull(id))
  ))
  ipcMain.handle('workspace:worktreeList', (event, id) => invoke(event, () => service.worktreeList(id)))
  ipcMain.handle('workspace:worktreeAdd', (event, id, name, base) => (
    invoke(event, () => service.worktreeAdd(id, name, base))
  ))
  ipcMain.handle('workspace:worktreeRemove', (event, id, treePath) => (
    invoke(event, () => service.worktreeRemove(id, treePath))
  ))
  ipcMain.handle('workspace:gitFileVersions', (event, id, relPath, staged) => (
    invoke(event, () => service.gitFileVersions(id, relPath, staged))
  ))
  ipcMain.handle('workspace:gitDiff', (event, id, relPath, staged) => (
    invoke(event, () => service.gitDiff(id, relPath, staged))
  ))

  // ── AI 對話記錄 ──
  ipcMain.handle('workspace:agentSessions', (event, id) => (
    invoke(event, () => service.agentSessions(id))
  ))
  ipcMain.handle('workspace:agentResumeCommand', (event, agent, sessionId) => (
    invoke(event, () => service.agentResumeCommand(agent, sessionId))
  ))
  ipcMain.handle('workspace:agentSessionDetail', (event, id, agent, sessionId) => (
    invoke(event, () => service.agentSessionDetail(id, agent, sessionId))
  ))
}

module.exports = { registerWorkspaceIpc }
