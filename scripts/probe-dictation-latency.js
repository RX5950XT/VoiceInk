'use strict'

/**
 * 量「視窗藏起來（縮到系統匣／最小化）之後，renderer 還有多快」。
 *
 * 語音輸入的錄音端在 renderer：右 Alt → main → 送訊息 → renderer 開始錄。
 * 常駐背景是這個功能的前提，所以先把數字量出來再決定要不要動節流，不要用猜的。
 *
 * 實測結論（2026-09，Electron 43.4.1）：
 *   - **計時器**被重壓：20×setTimeout(4ms) 從 89ms 變 19828ms（約 220 倍）
 *   - **main→renderer 的訊息派送不受影響**：往返 0～1ms
 *   - 關掉 `setBackgroundThrottling` 之後計時器恢復，但 `document.hidden` 會跟著
 *     變成 **false**（minimize 與 hide 都一樣）——AGY 頁與系統監控頁的輪詢正是靠
 *     `document.hidden` 停下來的，所以那個開關只能是「跑 GPU 壓力測試那幾秒」的暫時狀態。
 *
 * 也就是說：熱鍵路徑上只要不放計時器，常駐背景就是即時的。
 *
 *     node_modules/electron/dist/electron.exe scripts/probe-dictation-latency.js
 */

const { app, BrowserWindow } = require('electron')

const PAGE = 'data:text/html,' + encodeURIComponent(`<!doctype html><meta charset="utf-8"><body>
<script>
  window.timers = async () => {
    const t0 = Date.now()
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 4))
    return Date.now() - t0
  }
</script></body>`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * @param {import('electron').BrowserWindow} win
 * @param {string} label
 */
async function measure(win, label) {
  const t0 = Date.now()
  await win.webContents.executeJavaScript('Date.now()')
  const dispatchMs = Date.now() - t0
  const timerMs = await win.webContents.executeJavaScript('window.timers()')
  const hidden = await win.webContents.executeJavaScript('document.hidden')
  console.log(`${label.padEnd(24)} document.hidden=${String(hidden).padEnd(5)} `
    + `訊息派送 ${dispatchMs}ms · 20×setTimeout(4ms) ${timerMs}ms`)
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 500, height: 320, show: false })
  await win.loadURL(PAGE)
  // showInactive：不搶使用者當下的前景焦點
  win.showInactive()
  await sleep(800)
  await measure(win, '看得見')

  for (const throttling of [true, false]) {
    for (const mode of ['minimize', 'hide']) {
      win.webContents.setBackgroundThrottling(throttling)
      win[mode]()
      await sleep(3500) // 節流有寬限期，等它真的生效
      await measure(win, `${mode}（節流${throttling ? '開' : '關'}）`)
      win.showInactive()
      await sleep(800)
    }
  }

  win.destroy()
  app.exit(0)
})

process.on('uncaughtException', (err) => {
  console.error('探測失敗：', err?.message || err)
  app.exit(1)
})
