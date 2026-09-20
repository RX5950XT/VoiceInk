'use strict'

/**
 * 用 Electron 的 nativeImage 把殼層 BGRA 轉成 PNG，確認 Drive 資料夾圖示不是空的。
 * 用法：npx electron scripts/probe-explorer-shell-icon.js
 */

const { app } = require('electron')
const path = require('path')
const { tempDir } = require('./lib/test-temp')

app.setPath('userData', tempDir('shell-icon-ud'))

const TARGET = process.argv[2] || 'G:\\我的雲端硬碟\\學校的資料'

app.whenReady().then(async () => {
  const shell = require(path.join(__dirname, '../src/main/explorer/shell.js'))
  const url = await shell.iconOf(TARGET)
  if (!url) {
    console.log('EMPTY', TARGET)
    shell.shutdown()
    app.exit(1)
    return
  }
  console.log('png', url.startsWith('data:image/png;base64,'), 'len', url.length, TARGET)
  shell.shutdown()
  app.exit(0)
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
