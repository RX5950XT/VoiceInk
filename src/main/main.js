const { app, BrowserWindow, ipcMain, session, desktopCapturer } = require('electron')
const path = require('path')

// 主視窗
let mainWindow = null
// 字幕視窗
let subtitleWindow = null
// 設定儲存實例（延遲初始化）
let store = null

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
 * 建立懸浮字幕視窗
 */
function createSubtitleWindow() {
  // 取得儲存的位置
  const bounds = store ? store.get('subtitleWindowBounds', {
    width: 800,
    height: 120,
    x: undefined,
    y: undefined
  }) : { width: 800, height: 120, x: undefined, y: undefined }

  subtitleWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    movable: true,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload/preload.js')
    }
  })

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

  subtitleWindow.on('closed', () => {
    subtitleWindow = null
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
  return true
})

ipcMain.handle('subtitle:update', (event, text) => {
  if (subtitleWindow) {
    subtitleWindow.webContents.send('subtitle:text', text)
  }
  return true
})

// 設定系統音訊擷取的媒體請求處理器
app.whenReady().then(async () => {
  // 初始化 store
  await initStore()

  // 設定 DisplayMedia 請求處理器（用於系統音訊擷取）
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      // 返回第一個螢幕並啟用系統音訊 loopback
      callback({ video: sources[0], audio: 'loopback' })
    })
  }, { useSystemPicker: false })

  createMainWindow()
})

// 所有視窗關閉時退出
app.on('window-all-closed', () => {
  app.quit()
})

// macOS 點擊 dock 圖示時重建視窗
app.on('activate', () => {
  if (mainWindow === null) {
    createMainWindow()
  }
})

