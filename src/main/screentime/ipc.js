'use strict'

/**
 * screentime:* IPC。只有主視窗能呼叫。
 * renderer 只送 kind／range／date，路徑與 SQL 不出 main。
 */

const { makeInvoke } = require('../ipc-invoke')

const KINDS = new Set(['app', 'web'])
const RANGES = new Set(['day', 'week', 'month', 'year'])

function registerScreentimeIpc({ ipcMain, service, isMainSender }) {
  const invoke = makeInvoke({
    isMainSender,
    forbidden: '僅主視窗可操作使用時長',
    code: 'SCREENTIME_ERROR',
    message: '使用時長操作失敗'
  })

  ipcMain.handle('screentime:status', (event) => invoke(event, () => service.status()))
  ipcMain.handle('screentime:stats', (event, q) => invoke(event, () => {
    const kind = KINDS.has(q?.kind) ? q.kind : 'app'
    const range = RANGES.has(q?.range) ? q.range : 'day'
    const date = typeof q?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(q.date) ? q.date : ''
    return service.stats({ kind, range, date })
  }))
  ipcMain.handle('screentime:drill', (event, q) => invoke(event, () => {
    const kind = KINDS.has(q?.kind) ? q.kind : 'app'
    const stamp = typeof q?.stamp === 'string' ? q.stamp : ''
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:00:00$/.test(stamp)) return []
    return service.drill({ kind, stamp })
  }))
  ipcMain.handle('screentime:export', (event, q) => invoke(event, () => {
    const kind = KINDS.has(q?.kind) ? q.kind : 'app'
    const range = RANGES.has(q?.range) ? q.range : 'day'
    const date = typeof q?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(q.date) ? q.date : ''
    return service.exportCsv({ kind, range, date })
  }))
  ipcMain.handle('screentime:openFolder', (event) => invoke(event, () => service.openFolder()))
}

module.exports = { registerScreentimeIpc }
