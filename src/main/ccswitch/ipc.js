'use strict'

/**
 * ccswitch:* IPC。比照 `terminal/ipc.js`／`agy/ipc.js`：只有主視窗能呼叫，
 * 回傳一律 `{ ok, data }` / `{ ok, error }`。
 *
 * 每個對外方法都要在這裡**逐一列舉**——service 加了方法但這裡漏一行，renderer 只會拿到
 * 通用錯誤訊息，完全查不出原因（`agy.test` 上線時踩過）。
 *
 * 錯誤訊息走 `userMessage` 白名單：只有我們自己建構、內容固定的錯誤才准原樣送出去。
 * 檔案系統的錯誤字串會夾帶完整路徑，一律收斂成通用訊息。
 */
const { makeInvoke } = require('../ipc-invoke')

function registerCcSwitchIpc({ ipcMain, service, isMainSender }) {
  const invoke = makeInvoke({
    isMainSender,
    forbidden: '僅主視窗可操作',
    code: 'CCSWITCH_ERROR',
    message: 'Claude Code 設定操作失敗'
  })

  ipcMain.handle('ccswitch:catalog', (event) => invoke(event, () => service.catalog()))

  ipcMain.handle('ccswitch:listProviders', (event) => (
    invoke(event, () => service.listProviders())
  ))
  ipcMain.handle('ccswitch:createProvider', (event, req) => (
    invoke(event, () => service.createProvider(req))
  ))
  ipcMain.handle('ccswitch:updateProvider', (event, id, patch) => (
    invoke(event, () => service.updateProvider(id, patch))
  ))
  ipcMain.handle('ccswitch:deleteProvider', (event, id) => (
    invoke(event, () => service.deleteProvider(id))
  ))
  ipcMain.handle('ccswitch:reorderProviders', (event, ids) => (
    invoke(event, () => service.reorderProviders(ids))
  ))
  ipcMain.handle('ccswitch:activateProvider', (event, id) => (
    invoke(event, () => service.activateProvider(id))
  ))
  ipcMain.handle('ccswitch:testProvider', (event, id) => (
    invoke(event, () => service.testProvider(id))
  ))
  // 回 `{ ok, models }`／`{ ok: false, code, error }`（掃描失敗不是 throw，是值）
  ipcMain.handle('ccswitch:scanModels', (event, id) => (
    invoke(event, () => service.scanProviderModels(id))
  ))

  ipcMain.handle('ccswitch:gatewayStatus', (event) => (
    invoke(event, () => service.gatewayStatus())
  ))
  ipcMain.handle('ccswitch:startGateway', (event) => (
    invoke(event, () => service.startGateway())
  ))
  ipcMain.handle('ccswitch:stopGateway', (event) => (
    invoke(event, () => service.stopGateway())
  ))

  ipcMain.handle('ccswitch:listMcp', (event) => invoke(event, () => service.listMcp()))
  ipcMain.handle('ccswitch:saveMcp', (event, id, spec, enabled) => (
    invoke(event, () => service.saveMcp(id, spec, enabled))
  ))
  ipcMain.handle('ccswitch:toggleMcp', (event, id, enabled) => (
    invoke(event, () => service.toggleMcp(id, enabled))
  ))
  ipcMain.handle('ccswitch:deleteMcp', (event, id) => (
    invoke(event, () => service.deleteMcp(id))
  ))

  ipcMain.handle('ccswitch:listAccounts', (event) => (
    invoke(event, () => service.listAccounts())
  ))
  ipcMain.handle('ccswitch:beginLogin', (event, providerKey) => (
    invoke(event, () => service.beginLogin(providerKey))
  ))
  ipcMain.handle('ccswitch:loginStatus', (event, providerKey) => (
    invoke(event, () => service.loginStatus(providerKey))
  ))
  ipcMain.handle('ccswitch:cancelLogin', (event, providerKey) => (
    invoke(event, () => service.cancelLogin(providerKey))
  ))
  ipcMain.handle('ccswitch:removeAccount', (event, accountId) => (
    invoke(event, () => service.removeAccount(accountId))
  ))

  ipcMain.handle('ccswitch:checkVersions', (event) => (
    invoke(event, () => service.checkVersions())
  ))
  ipcMain.handle('ccswitch:updateCommand', (event, key) => (
    invoke(event, () => service.versionUpdateCommand(key))
  ))
}

module.exports = { registerCcSwitchIpc }
