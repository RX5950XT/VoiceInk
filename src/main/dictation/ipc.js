'use strict'

/**
 * dictation:* IPC。比照 `sysmon/ipc.js`：只有主視窗能呼叫，回傳一律 { ok, data } / { ok, error }。
 *
 * 每個對外方法都要在這裡**逐一列舉**——service 加了方法但這裡漏一行，renderer 只會拿到
 * 通用錯誤訊息，完全查不出原因。
 *
 * 這條路徑上不接受 renderer 指定的模型、供應商網址或金鑰：整理要用哪一顆一律由 main
 * 從 store 讀（`dictationLlm`），跟聊天與翻譯同一個規矩。
 */

function registerDictationIpc({ ipcMain, service, isMainSender }) {
  const invoke = async (event, action) => {
    if (!isMainSender(event)) {
      return { ok: false, error: { code: 'FORBIDDEN', message: '僅主視窗可操作語音輸入' } }
    }
    try {
      return { ok: true, data: await action() }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: error?.code || 'DICTATION_ERROR',
          message: error?.userMessage || '語音輸入操作失敗'
        }
      }
    }
  }

  ipcMain.handle('dictation:status', (event) => invoke(event, () => service.status()))
  ipcMain.handle('dictation:refresh', (event) => invoke(event, () => service.refresh()))

  // 錄好的 PCM 從 renderer 送進來；模型與語言都由 main 決定
  ipcMain.handle('dictation:submit', (event, req) => invoke(event, () => service.submit({
    samples: req?.samples,
    sampleRate: req?.sampleRate,
    durationMs: req?.durationMs
  })))

  ipcMain.handle('dictation:records', (event, query) => (
    invoke(event, () => service.listRecords({ limit: query?.limit }))
  ))
  ipcMain.handle('dictation:deleteRecord', (event, id) => (
    invoke(event, () => service.removeRecord(String(id || '')))
  ))
  ipcMain.handle('dictation:clearRecords', (event) => invoke(event, () => service.clearRecords()))

  ipcMain.handle('dictation:dictionary', (event) => invoke(event, () => service.listDictionary()))
  ipcMain.handle('dictation:saveTerm', (event, entry) => invoke(event, () => service.upsertDictionary({
    from: String(entry?.from || ''),
    to: String(entry?.to || '')
  })))
  ipcMain.handle('dictation:deleteTerm', (event, from) => (
    invoke(event, () => service.removeDictionary(String(from || '')))
  ))
}

module.exports = { registerDictationIpc }
