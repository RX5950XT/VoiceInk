'use strict'

/**
 * explorer:* IPC。每個對外方法都要在這裡逐一列舉。
 */

const { makeInvoke } = require('../ipc-invoke')

function registerExplorerIpc({ ipcMain, service, isMainSender }) {
  const invoke = makeInvoke({
    isMainSender,
    forbidden: '僅主視窗可操作檔案總管',
    code: 'EXPLORER_ERROR',
    message: '檔案總管操作失敗'
  })

  ipcMain.handle('explorer:bootstrap', (event) => invoke(event, () => service.bootstrap()))
  ipcMain.handle('explorer:saveState', (event, patch) => invoke(event, () => service.saveState(patch)))
  ipcMain.handle('explorer:listPlaces', (event) => invoke(event, () => service.listPlaces()))
  ipcMain.handle('explorer:savePlaces', (event, list) => invoke(event, () => service.savePlaces(list)))
  ipcMain.handle('explorer:addPlace', (event, spec) => invoke(event, () => service.addPlace(spec)))
  ipcMain.handle('explorer:removePlace', (event, id) => invoke(event, () => service.removePlace(id)))
  ipcMain.handle('explorer:connectShare', (event, spec) => invoke(event, () => service.connectShare(spec)))
  ipcMain.handle('explorer:pickFolder', (event) => invoke(event, () => service.pickFolder()))
  ipcMain.handle('explorer:resolvePath', (event, target) => invoke(event, () => service.resolvePath(target)))
  ipcMain.handle('explorer:createShortcut', (event, target, toDir) => (
    invoke(event, () => service.createShortcut(target, toDir))
  ))
  ipcMain.handle('explorer:listDrives', (event) => invoke(event, () => service.listDrives()))
  ipcMain.handle('explorer:listDir', (event, dirPath, opts) => (
    invoke(event, () => service.listDir(dirPath, opts))
  ))
  ipcMain.handle('explorer:preview', (event, filePath) => invoke(event, () => service.preview(filePath)))
  ipcMain.handle('explorer:inspect', (event, filePath) => invoke(event, () => service.inspect(filePath)))
  ipcMain.handle('explorer:createEntry', (event, dirPath, name, dir) => (
    invoke(event, () => service.createEntry(dirPath, name, dir))
  ))
  ipcMain.handle('explorer:renameEntry', (event, target, name) => (
    invoke(event, () => service.renameEntry(target, name))
  ))
  ipcMain.handle('explorer:removeEntry', (event, target, opts) => (
    invoke(event, () => service.removeEntry(target, opts))
  ))
  ipcMain.handle('explorer:restoreEntry', (event, key) => invoke(event, () => service.restoreEntry(key)))
  ipcMain.handle('explorer:purgeEntry', (event, key) => invoke(event, () => service.purgeEntry(key)))
  ipcMain.handle('explorer:emptyRecycle', (event) => invoke(event, () => service.emptyRecycle()))
  ipcMain.handle('explorer:copyEntry', (event, fromPath, toDir) => (
    invoke(event, () => service.copyEntry(fromPath, toDir))
  ))
  ipcMain.handle('explorer:moveEntry', (event, fromPath, toDir) => (
    invoke(event, () => service.moveEntry(fromPath, toDir))
  ))
  ipcMain.handle('explorer:openPath', (event, target) => invoke(event, () => service.openPath(target)))
  ipcMain.handle('explorer:reveal', (event, target) => invoke(event, () => service.reveal(target)))
  ipcMain.handle('explorer:setClipboard', (event, items, mode) => (
    invoke(event, () => service.setClipboard(items, mode))
  ))
  ipcMain.handle('explorer:paste', (event, toDir) => invoke(event, () => service.paste(toDir)))
  ipcMain.handle('explorer:dropEntries', (event, items, toDir, mode) => (
    invoke(event, () => service.dropEntries(items, toDir, mode))
  ))
  ipcMain.handle('explorer:watch', (event, dirPath) => invoke(event, () => service.watchDir(dirPath)))
  ipcMain.handle('explorer:unwatch', (event) => invoke(event, () => service.unwatch()))
  ipcMain.handle('explorer:uffsStatus', (event) => invoke(event, () => service.uffsStatus()))
  ipcMain.handle('explorer:uffsSearch', (event, pattern) => invoke(event, () => service.uffsSearch(pattern)))
  ipcMain.handle('explorer:uffsCancel', (event) => invoke(event, () => service.uffsCancel()))
  ipcMain.handle('explorer:uffsInstall', (event) => invoke(event, () => service.uffsInstall()))
  ipcMain.handle('explorer:uffsCancelInstall', (event) => invoke(event, () => service.uffsCancelInstall()))
  ipcMain.handle('explorer:uffsInstallBroker', (event) => invoke(event, () => service.uffsInstallBroker()))
  ipcMain.handle('explorer:uffsEnsure', (event, opts) => invoke(event, () => service.uffsEnsure(opts)))
}

module.exports = { registerExplorerIpc }
