'use strict'

/**
 * codeusage:* IPC。比照 `usage/ipc.js`：只有主視窗能呼叫，回傳 `{ ok, data }` / `{ ok, error }`，
 * 每個對外方法逐一列舉。
 *
 * 這裡讀的是使用者家目錄裡的 session 記錄，**回給 renderer 的只有彙總數字**——
 * 路徑、對話內容、專案名稱一律不出 main。
 */
const { makeInvoke } = require('../ipc-invoke')

function registerCodeUsageIpc({ ipcMain, service, isMainSender }) {
  const invoke = makeInvoke({
    isMainSender,
    forbidden: '僅主視窗可查詢用量',
    code: 'CODE_USAGE_ERROR',
    message: '用量統計失敗'
  })

  ipcMain.handle('codeusage:stats', (event, query) => (
    invoke(event, () => service.stats(query || {}))
  ))
  ipcMain.handle('codeusage:sync', (event) => invoke(event, () => service.sync()))
  ipcMain.handle('codeusage:savePrices', (event, prices) => (
    invoke(event, () => service.savePrices(prices))
  ))
  ipcMain.handle('codeusage:reset', (event) => invoke(event, () => service.reset()))
}

module.exports = { registerCodeUsageIpc }
