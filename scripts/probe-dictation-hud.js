'use strict'

/**
 * 語音輸入指示器的外觀檢查：`node_modules/electron/dist/electron.exe scripts/probe-dictation-hud.js`
 *
 * 真的開那扇視窗、餵幾種狀態，然後 `capturePage()` 存成 PNG 給人看。
 * 不搶焦點、不動滑鼠——指示器本來就是 `focusable: false` ＋ `showInactive()`。
 */

const { app } = require('electron')
const path = require('path')
const fs = require('fs')

const OUT = path.join(__dirname, '..', '.tmp-hud')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  await app.whenReady()
  fs.mkdirSync(OUT, { recursive: true })

  const hud = require(path.join(__dirname, '..', 'src', 'main', 'dictation', 'hud.js'))
  hud.configure({ isDev: false, preload: path.join(__dirname, '..', 'src', 'preload', 'preload.js') })

  /** @param {string} name */
  async function shoot(name) {
    await sleep(450)
    const img = await hud._window().capturePage()
    const file = path.join(OUT, `${name}.png`)
    fs.writeFileSync(file, img.toPNG())
    console.log('wrote', file, `${img.getSize().width}x${img.getSize().height}`)
  }

  // 錄音中：波形要有高低起伏，不是一排等高
  hud.update({ state: 'recording', level: 0.05 })
  await sleep(600)
  for (const lv of [0.2, 0.55, 0.8, 0.35, 0.9, 0.15, 0.6, 0.75, 0.3, 0.85, 0.25, 0.7, 0.4, 0.95, 0.5, 0.65, 0.45]) {
    hud.update({ state: 'recording', level: lv })
    await sleep(60)
  }
  await shoot('recording')

  hud.update({ state: 'processing' })
  await shoot('processing')

  hud.update({
    state: 'error',
    message: '雲端語音辨識模型「x-ai/grok-stt-1.0」無法使用（HTTP 403）。金鑰本身沒問題，請換一個轉錄模型'
  })
  await shoot('error')

  // 波形真的有動嗎：量一次 DOM
  const heights = await hud._window().webContents.executeJavaScript(
    "(() => { window.__hudRender({state:'recording', level:0.8});"
    + " return [...document.querySelectorAll('#hudWave span')].map(s => s.style.height) })()"
  )
  console.log('bar heights:', heights.join(' '))

  hud.close()
  app.exit(0)
}

main().catch((e) => { console.error(e); app.exit(1) })
