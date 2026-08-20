'use strict'

function registerUsageIpc({ ipcMain, service, isMainSender }) {
  const invoke = async (event, action) => {
    if (!isMainSender(event)) {
      return {
        ok: false,
        error: { code: 'FORBIDDEN', message: '僅主視窗可查詢額度' }
      }
    }
    try {
      return { ok: true, data: await action() }
    } catch (error) {
      return { ok: false, error: service.publicError(error) }
    }
  }

  ipcMain.handle('usage:load', (event) => invoke(event, () => service.load()))
  ipcMain.handle('usage:sync', (event) => invoke(event, () => service.sync()))
  ipcMain.handle('usage:saveSettings', (event, settings) => (
    invoke(event, () => service.saveSettings(settings))
  ))
  ipcMain.handle('usage:diagnostics', (event) => (
    invoke(event, () => service.getDiagnostics())
  ))
}

module.exports = { registerUsageIpc }
