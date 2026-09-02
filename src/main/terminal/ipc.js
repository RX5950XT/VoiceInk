'use strict'

/**
 * terminal:* IPC。比照 `agy/ipc.js`：只有主視窗能呼叫，回傳一律 { ok, data } / { ok, error }。
 *
 * 每個對外方法都要在這裡**逐一列舉**——service 加了方法但這裡漏一行，renderer 只會拿到
 * 通用錯誤訊息，完全查不出原因（`agy.test` 上線時踩過，CLAUDE.md 有記）。
 *
 * 錯誤訊息走 `userMessage` 白名單：只有我們自己建構、內容固定的錯誤才准原樣送出去，
 * 其餘一律變成通用訊息，避免把路徑或系統錯誤字串洩漏到畫面上。
 */
const { makeInvoke } = require('../ipc-invoke')

function registerTerminalIpc({ ipcMain, service, isMainSender, dialog, getWindow }) {
  const invoke = makeInvoke({
    isMainSender,
    forbidden: '僅主視窗可操作終端機',
    code: 'TERMINAL_ERROR',
    message: '終端機操作失敗'
  })

  ipcMain.handle('terminal:catalog', (event) => invoke(event, () => service.catalog()))
  ipcMain.handle('terminal:list', (event) => invoke(event, () => service.listSessions()))
  ipcMain.handle('terminal:create', (event, req) => (
    invoke(event, () => service.createSession(req))
  ))
  ipcMain.handle('terminal:rename', (event, id, title) => (
    invoke(event, () => service.renameSession(id, title))
  ))
  ipcMain.handle('terminal:delete', (event, id) => (
    invoke(event, () => service.deleteSession(id))
  ))
  ipcMain.handle('terminal:reorder', (event, ids) => (
    invoke(event, () => service.reorderSessions(ids))
  ))
  ipcMain.handle('terminal:open', (event, id, cols, rows) => (
    invoke(event, () => service.openSession(id, cols, rows))
  ))
  ipcMain.handle('terminal:write', (event, id, data) => (
    invoke(event, () => service.writeSession(id, data))
  ))
  ipcMain.handle('terminal:resize', (event, id, cols, rows) => (
    invoke(event, () => service.resizeSession(id, cols, rows))
  ))
  ipcMain.handle('terminal:kill', (event, id) => (
    invoke(event, () => service.killSession(id))
  ))

  // 工作目錄一律由系統對話框選，renderer 不自己組路徑字串
  ipcMain.handle('terminal:pickDirectory', (event) => invoke(event, async () => {
    const win = getWindow()
    if (!win) return ''
    const result = await dialog.showOpenDialog(win, {
      title: '選擇工作目錄',
      properties: ['openDirectory']
    })
    return result.canceled ? '' : (result.filePaths[0] || '')
  }))
}

module.exports = { registerTerminalIpc }
