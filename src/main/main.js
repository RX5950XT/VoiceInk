const { app, BrowserWindow, ipcMain, session, desktopCapturer, screen } = require('electron')
const path = require('path')
const models = require('./models')
const localAsr = require('./local-asr')
const localLlm = require('./local-llm')
const engine = require('./engine')

// 主視窗
let mainWindow = null
// 字幕視窗
let subtitleWindow = null
// 設定儲存實例（延遲初始化）
let store = null
/** 正在執行 before-quit 卸載 */
let isQuitting = false

// 開發模式判斷
const isDev = !app.isPackaged

/**
 * 初始化 electron-store（ESM 模組需要動態 import）
 */
async function initStore() {
  const Store = (await import('electron-store')).default
  store = new Store()
}

/**
 * 建立主視窗
 */
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    frame: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload/preload.js')
    },
    backgroundColor: '#1a1a1a',
    show: false
  })

  // 載入頁面
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  // 準備好後顯示
  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    if (subtitleWindow) {
      subtitleWindow.close()
    }
  })
}

/**
 * 儲存的視窗位置是否仍落在某個螢幕的可視範圍內（外接螢幕拔除後座標會失效）
 */
function isBoundsOnScreen(bounds) {
  if (bounds.x === undefined || bounds.y === undefined) return true
  return screen.getAllDisplays().some((d) => {
    const wa = d.workArea
    return (
      bounds.x < wa.x + wa.width &&
      bounds.x + bounds.width > wa.x &&
      bounds.y < wa.y + wa.height &&
      bounds.y + bounds.height > wa.y
    )
  })
}

/**
 * 建立懸浮字幕視窗
 */
function createSubtitleWindow() {
  // 取得儲存的位置
  const bounds = store ? store.get('subtitleWindowBounds', {
    width: 800,
    height: 200,
    x: undefined,
    y: undefined
  }) : { width: 800, height: 200, x: undefined, y: undefined }

  // 座標已不在任何螢幕內（拔掉外接螢幕）→ 回到置中，避免視窗開在看不見的地方
  if (!isBoundsOnScreen(bounds)) {
    bounds.x = undefined
    bounds.y = undefined
  }

  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    frame: false,
    transparent: false,
    backgroundColor: '#1a1a1a',
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload/preload.js')
    }
  })
  subtitleWindow = win

  // 強制移除選單，避免出現白色選單列
  subtitleWindow.setMenu(null)

  if (isDev) {
    subtitleWindow.loadURL('http://localhost:5173/pages/subtitle.html')
  } else {
    subtitleWindow.loadFile(path.join(__dirname, '../renderer/pages/subtitle.html'))
  }

  // 儲存視窗位置
  subtitleWindow.on('moved', () => {
    if (store && subtitleWindow) {
      const bounds = subtitleWindow.getBounds()
      store.set('subtitleWindowBounds', bounds)
    }
  })

  subtitleWindow.on('resized', () => {
    if (store && subtitleWindow) {
      const bounds = subtitleWindow.getBounds()
      store.set('subtitleWindowBounds', bounds)
    }
  })

  win.on('closed', () => {
    // subtitle:close 會先同步把 subtitleWindow 設 null；此處仍 === win 代表是 OS 層關閉
    // （Alt+F4／主視窗連帶關閉），需通知 renderer 停止擷取，否則管線在無視窗下空轉
    if (subtitleWindow !== win) return
    subtitleWindow = null
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('subtitle:closed')
    }
  })
}

// ===== IPC 處理器 =====

// 設定相關
ipcMain.handle('store:get', async (event, key, defaultValue) => {
  if (!store) await initStore()
  return store.get(key, defaultValue)
})

ipcMain.handle('store:set', async (event, key, value) => {
  if (!store) await initStore()
  store.set(key, value)
  return true
})

// 字幕視窗控制
ipcMain.handle('subtitle:show', () => {
  if (!subtitleWindow) {
    createSubtitleWindow()
  } else {
    subtitleWindow.show()
  }
  return true
})

ipcMain.handle('subtitle:hide', () => {
  if (subtitleWindow) {
    subtitleWindow.hide()
  }
  return true
})

ipcMain.handle('subtitle:close', () => {
  if (subtitleWindow) {
    subtitleWindow.close()
    subtitleWindow = null
  }
  // 通知主視窗字幕已關閉，讓 UI 同步更新
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('subtitle:closed')
  }
  return true
})

ipcMain.handle('subtitle:update', (event, text) => {
  if (subtitleWindow && !subtitleWindow.isDestroyed()) {
    subtitleWindow.webContents.send('subtitle:text', text)
  }
  return true
})

ipcMain.handle('subtitle:setOpacity', (event, value) => {
  if (subtitleWindow && !subtitleWindow.isDestroyed()) {
    subtitleWindow.setOpacity(value)
  }
  return true
})

// ===== 本地模型相關 =====

ipcMain.handle('models:status', () => models.status())

ipcMain.handle('models:download', async (event, key) => {
  return models.download(key, (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('models:progress', progress)
    }
  })
})

ipcMain.handle('models:cancel', (event, key) => models.cancelDownload(key))

ipcMain.handle('models:delete', (event, key) => models.remove(key))

ipcMain.handle('models:openFolder', (event, key) => models.openFolder(key))

ipcMain.handle('localAsr:transcribe', (event, req) => localAsr.transcribe(req))

ipcMain.handle('translate', async (event, text, targetLang, opts) => {
  if (!store) await initStore()
  return localLlm.translate(store, text, targetLang, opts || {})
})

// 引擎生命週期：acquire / release / status
ipcMain.handle('engine:acquire', async (event, owner, needs) => {
  return engine.acquire(owner, needs || {})
})

ipcMain.handle('engine:release', async (event, owner) => {
  return engine.release(owner)
})

ipcMain.handle('engine:status', () => engine.status())

// 設定系統音訊擷取的媒體請求處理器
app.whenReady().then(async () => {
  await initStore()

  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      callback({ video: sources[0], audio: 'loopback' })
    })
  }, { useSystemPicker: false })

  createMainWindow()
})

// 關閉前同步卸載模型，再真正退出
app.on('before-quit', (e) => {
  if (isQuitting) return
  e.preventDefault()
  isQuitting = true
  engine.unloadAll()
    .catch((err) => console.error('[engine] unloadAll on quit failed:', err))
    .finally(() => {
      app.exit(0)
    })
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('activate', () => {
  if (mainWindow === null) {
    createMainWindow()
  }
})

