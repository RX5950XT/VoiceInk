'use strict'

const { makeInvoke } = require('../ipc-invoke')

function registerUsageIpc({ ipcMain, service, isMainSender }) {
  const invoke = makeInvoke({
    isMainSender,
    forbidden: '僅主視窗可查詢額度',
    publicError: (error) => service.publicError(error)
  })

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
