'use strict'

/**
 * hfmodels:* IPC。比照 `sysmon/ipc.js`：只有主視窗能呼叫，回傳一律 { ok, data } / { ok, error }。
 *
 * 每個方法都要在這裡**逐一列舉**——index.js 加了方法但這裡漏一行，renderer 只會拿到
 * 通用錯誤訊息，完全查不出原因。
 *
 * 這一組的 IPC 邊界特別要守兩件事：
 *   - **不收網址**：只收 repoId 與 variantId，網址由 `hub.fileUrl` 在 main 組出來
 *   - **不外送金鑰**：`runtimeStatus` 只回 { running, port }；router 的 api key 留在 main
 */

/**
 * @param {any} value
 * @returns {string}
 */
function str(value) {
  return typeof value === 'string' ? value.slice(0, 200) : ''
}

function registerHfModelsIpc({ ipcMain, service, isMainSender }) {
  const invoke = async (event, action) => {
    if (!isMainSender(event)) {
      return { ok: false, error: { code: 'FORBIDDEN', message: '僅主視窗可操作本機模型' } }
    }
    try {
      return { ok: true, data: await action() }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: error?.code || 'HFMODELS_ERROR',
          // 這幾支的錯誤訊息都是我們自己寫死的字串（上游 body 早在 hub／runtime 就被擋掉了）
          message: error?.message || '本機模型操作失敗'
        }
      }
    }
  }

  // ---- 探索 ----
  ipcMain.handle('hfmodels:search', (event, query, sort) => (
    invoke(event, () => service.search({ query: str(query), sort: str(sort) }))
  ))
  ipcMain.handle('hfmodels:inspect', (event, repoId) => (
    invoke(event, () => service.inspect(str(repoId)))
  ))
  ipcMain.handle('hfmodels:preview', (event, repoId, variantId) => (
    invoke(event, () => service.preview(str(repoId), str(variantId)))
  ))
  // 詳情面板：模型卡＋README＋每個量化的可行性，一次回來
  ipcMain.handle('hfmodels:detail', (event, repoId) => (
    invoke(event, () => service.detail(str(repoId)))
  ))

  // ---- 下載 ----
  ipcMain.handle('hfmodels:install', (event, repoId, variantId) => (
    invoke(event, () => service.install(str(repoId), str(variantId)))
  ))
  ipcMain.handle('hfmodels:cancelInstall', (event, variantId) => (
    invoke(event, () => service.cancelInstall(str(variantId)))
  ))

  // ---- 模型庫 ----
  ipcMain.handle('hfmodels:list', (event) => invoke(event, () => service.listLocal()))
  ipcMain.handle('hfmodels:remove', (event, id) => invoke(event, () => service.removeLocal(str(id))))
  // 路徑走系統對話框（在 main 開），renderer 不送檔案路徑
  ipcMain.handle('hfmodels:import', (event) => invoke(event, () => service.pickAndImport()))
  ipcMain.handle('hfmodels:openFolder', (event) => invoke(event, () => service.openModelsDir()))
  ipcMain.handle('hfmodels:rescan', (event) => invoke(event, () => service.rescan()))

  // ---- 每顆模型的參數 ----
  // `patch` 是物件（覆寫欄位＋原始參數字串），內容由 index.sanitizeRequested 收斂：
  // 這裡只保證它是物件，不在 IPC 層做第二套欄位表（兩套一定會漂移）
  ipcMain.handle('hfmodels:updateSettings', (event, id, patch) => (
    invoke(event, () => service.updateModelSettings(str(id), patch && typeof patch === 'object' ? patch : {}))
  ))
  ipcMain.handle('hfmodels:refreshFit', (event, id) => invoke(event, () => service.refreshFit(str(id))))
  ipcMain.handle('hfmodels:tune', (event, id) => invoke(event, () => service.tune(str(id))))
  ipcMain.handle('hfmodels:autoTune', (event, id) => invoke(event, () => service.autoTune(str(id))))
  ipcMain.handle('hfmodels:cancelTune', (event) => invoke(event, () => service.cancelTune()))

  // ---- 執行環境 ----
  ipcMain.handle('hfmodels:runtimeReady', (event) => invoke(event, () => service.runtimeReady()))
  ipcMain.handle('hfmodels:runtimeStatus', (event) => invoke(event, () => service.runtimeStatus()))
  ipcMain.handle('hfmodels:startRuntime', (event) => invoke(event, () => service.startRuntime()))
  ipcMain.handle('hfmodels:stopRuntime', (event) => invoke(event, () => service.stopRuntime()))
  ipcMain.handle('hfmodels:device', (event) => invoke(event, () => service.currentDevice()))
  ipcMain.handle('hfmodels:hardware', (event) => invoke(event, () => service.hardwareInfo()))
  ipcMain.handle('hfmodels:chooseDir', (event) => invoke(event, () => service.chooseModelsDir()))
  // token 只寫不讀：回去的永遠只有 { hasToken }
  ipcMain.handle('hfmodels:setToken', (event, token) => invoke(event, () => service.setToken(str(token))))
  ipcMain.handle('hfmodels:tokenStatus', (event) => invoke(event, () => service.tokenStatus()))
  ipcMain.handle('hfmodels:applyPresets', (event) => invoke(event, () => service.applyPresets()))
  ipcMain.handle('hfmodels:loadModel', (event, id) => invoke(event, () => service.loadModel(str(id))))
  ipcMain.handle('hfmodels:unloadModel', (event, id) => (
    invoke(event, () => service.unloadModel(str(id)))
  ))
  ipcMain.handle('hfmodels:refreshModels', (event) => invoke(event, () => service.refreshModels()))
}

module.exports = { registerHfModelsIpc }
