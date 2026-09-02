'use strict'

/**
 * sysmon:* IPC。比照 `terminal/ipc.js`：只有主視窗能呼叫，回傳一律 { ok, data } / { ok, error }。
 *
 * 每個對外方法都要在這裡**逐一列舉**——service 加了方法但這裡漏一行，renderer 只會拿到
 * 通用錯誤訊息，完全查不出原因（`agy.test` 上線時踩過，CLAUDE.md 有記）。
 *
 * 錯誤訊息走 `userMessage` 白名單：只有我們自己建構、內容固定的錯誤才准原樣送出去。
 */

function registerSysmonIpc({ ipcMain, service, isMainSender }) {
  const invoke = async (event, action) => {
    if (!isMainSender(event)) {
      return { ok: false, error: { code: 'FORBIDDEN', message: '僅主視窗可操作系統監控' } }
    }
    try {
      return { ok: true, data: await action() }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: error?.code || 'SYSMON_ERROR',
          message: error?.userMessage || '系統監控操作失敗'
        }
      }
    }
  }

  ipcMain.handle('sysmon:status', (event) => invoke(event, () => service.status()))
  ipcMain.handle('sysmon:start', (event, intervalKey) => (
    invoke(event, () => service.start(intervalKey))
  ))
  ipcMain.handle('sysmon:stop', (event) => invoke(event, () => service.stop()))
  ipcMain.handle('sysmon:inventory', (event) => invoke(event, () => service.inventory()))
  ipcMain.handle('sysmon:detail', (event, pid) => invoke(event, () => service.detail(pid)))
  ipcMain.handle('sysmon:kill', (event, pid, force) => (
    invoke(event, () => service.killProcess(pid, force === true))
  ))
  ipcMain.handle('sysmon:enableSensors', (event) => invoke(event, () => service.enableSensors()))
  // 下載網址與安裝參數都是 main 的固定常數；renderer 只能說「裝」
  ipcMain.handle('sysmon:installPawnIo', (event) => invoke(event, () => service.installPawnIo()))
  // 網址是 main 的固定常數，renderer 傳不進任何字串——不然這條就是「幫你開任意網址」
  ipcMain.handle('sysmon:openPawnIoPage', (event) => invoke(event, () => service.openPawnIoPage()))

  // 壓力測試：renderer 只送「開／關」與一個數字，執行緒上限與記憶體上限都夾在 stress.js
  ipcMain.handle('sysmon:cpuStress', (event, run, threads) => (
    invoke(event, () => service.cpuStress(run === true, threads))
  ))
  ipcMain.handle('sysmon:memStress', (event, run, gb) => (
    invoke(event, () => service.memStress(run === true, gb))
  ))
  ipcMain.handle('sysmon:stressStatus', (event) => invoke(event, () => service.stressStatus()))
  // GPU 壓力測試跑在 renderer，但「別把這個 renderer 降級」只有 main 做得到
  ipcMain.handle('sysmon:gpuStress', (event, active) => (
    invoke(event, () => service.setGpuStress(active === true))
  ))

  // 測速只收磁碟代號：測試檔放哪裡由 main 決定（該碟根目錄的固定前綴＋亂數檔名，
  // 跑完自己刪）。renderer 不送路徑——送路徑等於把任意檔案讀寫當成 API 提供。
  ipcMain.handle('sysmon:diskBench', (event, req) => invoke(event, async () => {
    const drive = String(req?.drive || '')
    // 只接受單一磁碟代號（`C:`）；路徑、`..`、反斜線全擋在這裡
    if (!/^[A-Za-z]:$/.test(drive)) {
      const err = new Error('bad drive')
      err.code = 'SYSMON_BAD_DIR'
      err.userMessage = '請選擇要測試的磁碟（C:、D:…）'
      throw err
    }
    const { statSync } = require('fs')
    const path = require('path')
    const dir = path.join(drive + path.sep)
    try {
      if (!statSync(dir).isDirectory()) throw new Error('not dir')
    } catch {
      const err = new Error('bad drive')
      err.code = 'SYSMON_BAD_DIR'
      err.userMessage = `找不到磁碟 ${drive}`
      throw err
    }
    return service.diskBench({ dir, sizeMb: req?.sizeMb })
  }))

  // 風扇控制。renderer 只送 identifier（main 會對照目前真的存在的通道驗過）與數字：
  // 送暫存器位址或裝置路徑等於把「寫任意硬體暫存器」當成 API 提供。
  ipcMain.handle('sysmon:fanList', (event) => invoke(event, () => service.fanList()))
  ipcMain.handle('sysmon:fanEnable', (event, on) => (
    invoke(event, () => service.fanEnable(on === true))
  ))
  ipcMain.handle('sysmon:fanSetChannel', (event, id, patch) => (
    invoke(event, () => service.fanSetChannel(id, patch))
  ))
  ipcMain.handle('sysmon:fanIdentify', (event, id) => (
    invoke(event, () => service.fanIdentify(id))
  ))
  ipcMain.handle('sysmon:fanResetAll', (event) => invoke(event, () => service.fanResetAll()))
  // 免 UAC 啟動的排程工作：路徑與工作名都是 main 的固定值，renderer 只能說「裝／查／移除」
  ipcMain.handle('sysmon:fanTaskStatus', (event) => invoke(event, () => service.fanTaskStatus()))
  ipcMain.handle('sysmon:fanTaskInstall', (event) => invoke(event, () => service.fanTaskInstall()))
  ipcMain.handle('sysmon:fanTaskRemove', (event) => invoke(event, () => service.fanTaskRemove()))

  ipcMain.handle('sysmon:cancelDiskBench', (event) => (
    invoke(event, () => { service.cancelDiskBench(); return true })
  ))
}

module.exports = { registerSysmonIpc }
