// 共用同一份即時快照，切專案後也能看到背景終端機的狀態。
let sessions = []

export function terminalStatusLabel(item) {
  if (item.state === 'running') return '運行中'
  if (item.state === 'idle') {
    if (item.exitCode === null || item.exitCode === undefined) return '暫無輸出'
    return item.exitCode === 0 ? '已完成' : `指令失敗 · ${item.exitCode}`
  }
  return '已停止'
}

export function setTerminalStatuses(items) {
  sessions = items.map((item) => ({ ...item, stateLabel: terminalStatusLabel(item) }))
  document.dispatchEvent(new CustomEvent('ws:terminal-status'))
}

export function terminalStatuses() {
  return sessions
}
