/**
 * uiohook-napi 在 Electron 下的可用性探測。
 *
 * 兩件事要先確認才敢往下做全域語音輸入：
 *   1. N-API prebuild 在 Electron 43（Node 22 ABI）能不能直接 require
 *   2. 右 Alt 是否真的跟左 Alt 分得開（Windows VK_RMENU → uiohook 的 3640）
 *
 * 跑法：npx electron scripts/probe-uiohook.js
 * 會自己送一次右 Alt 與一次左 Alt（keyToggle），不需要人按鍵。
 */

const { app } = require('electron')

const RIGHT_ALT = 3640
const LEFT_ALT = 56

app.whenReady().then(async () => {
  let uIOhook
  try {
    ;({ uIOhook } = require('uiohook-napi'))
    console.log('[probe] require ok')
  } catch (err) {
    console.error('[probe] require FAILED:', err.message)
    app.exit(1)
    return
  }

  /** @type {Array<{ kind: string, keycode: number }>} */
  const seen = []
  uIOhook.on('keydown', (e) => seen.push({ kind: 'down', keycode: e.keycode }))
  uIOhook.on('keyup', (e) => seen.push({ kind: 'up', keycode: e.keycode }))

  uIOhook.start()
  console.log('[probe] hook started')

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  await sleep(400)

  uIOhook.keyToggle(RIGHT_ALT, 'down')
  await sleep(150)
  uIOhook.keyToggle(RIGHT_ALT, 'up')
  await sleep(300)

  uIOhook.keyToggle(LEFT_ALT, 'down')
  await sleep(150)
  uIOhook.keyToggle(LEFT_ALT, 'up')
  await sleep(500)

  uIOhook.stop()
  console.log('[probe] events:', JSON.stringify(seen))

  const rightDown = seen.some((e) => e.kind === 'down' && e.keycode === RIGHT_ALT)
  const leftDown = seen.some((e) => e.kind === 'down' && e.keycode === LEFT_ALT)
  console.log(`[probe] right alt distinguishable: ${rightDown && leftDown ? 'YES' : 'NO'}`)
  app.exit(rightDown && leftDown ? 0 : 1)
})
