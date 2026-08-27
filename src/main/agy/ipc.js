'use strict'

/**
 * agy:* IPC。比照 usage/ipc.js：只有主視窗能呼叫，回傳一律 { ok, data } / { ok, error }。
 * 錯誤只帶代碼與自訂訊息，絕不把上游 body 或憑證內容往 renderer 送。
 *
 * `userMessage` 是明確的白名單：只有我們自己建構、內容固定的錯誤（CredentialError）
 * 會帶這個欄位。上游錯誤（UpstreamError）的 message 是狀態碼、也可能夾雜外部字串，
 * 沒有這個欄位就一律變成通用訊息。
 */
function registerAgyIpc({ ipcMain, service, isMainSender }) {
  const invoke = async (event, action) => {
    if (!isMainSender(event)) {
      return { ok: false, error: { code: 'FORBIDDEN', message: '僅主視窗可操作反向代理' } }
    }
    try {
      return { ok: true, data: await action() }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: error?.code || 'AGY_ERROR',
          message: error?.userMessage || '反向代理操作失敗'
        }
      }
    }
  }

  ipcMain.handle('agy:status', (event) => invoke(event, () => service.status()))
  ipcMain.handle('agy:start', (event) => invoke(event, async () => {
    const result = await service.start()
    return { ...result, ...(await service.status()) }
  }))
  ipcMain.handle('agy:stop', (event) => invoke(event, async () => {
    await service.stop()
    return service.status()
  }))
  ipcMain.handle('agy:saveSettings', (event, settings) => (
    invoke(event, () => service.saveSettings(settings))
  ))
  ipcMain.handle('agy:regenerateKey', (event) => invoke(event, () => service.regenerateApiKey()))
  ipcMain.handle('agy:logs', (event, query) => invoke(event, () => service.getLogs(query)))
  ipcMain.handle('agy:stats', (event, query) => invoke(event, () => service.getStats(query)))
  ipcMain.handle('agy:models', (event, force) => (
    invoke(event, () => service.listModels({ force: force === true }))
  ))
  ipcMain.handle('agy:clearLogs', (event) => invoke(event, () => service.clearLogs()))
  ipcMain.handle('agy:test', (event) => invoke(event, () => service.selfTest()))
}

module.exports = { registerAgyIpc }
