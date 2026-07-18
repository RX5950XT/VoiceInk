const { contextBridge, ipcRenderer } = require('electron')

/**
 * 安全地將 API 暴露給 Renderer Process
 */
contextBridge.exposeInMainWorld('electronAPI', {
  // ===== 設定儲存 =====
  store: {
    get: (key, defaultValue) => ipcRenderer.invoke('store:get', key, defaultValue),
    set: (key, value) => ipcRenderer.invoke('store:set', key, value)
  },

  // ===== 字幕視窗控制 =====
  subtitle: {
    show: () => ipcRenderer.invoke('subtitle:show'),
    hide: () => ipcRenderer.invoke('subtitle:hide'),
    close: () => ipcRenderer.invoke('subtitle:close'),
    /** @param {string | { id?: string, source?: string, translation?: string, action?: string, text?: string }} payload */
    update: (payload) => ipcRenderer.invoke('subtitle:update', payload),
    setOpacity: (value) => ipcRenderer.invoke('subtitle:setOpacity', value),
    onTextUpdate: (callback) => {
      ipcRenderer.on('subtitle:text', (event, text) => callback(text))
    },
    onClosed: (callback) => {
      ipcRenderer.on('subtitle:closed', () => callback())
    }
  },

  // ===== 引擎生命週期（warm / unload via refcount）=====
  engine: {
    acquire: (owner, needs) => ipcRenderer.invoke('engine:acquire', owner, needs || {}),
    release: (owner) => ipcRenderer.invoke('engine:release', owner),
    status: () => ipcRenderer.invoke('engine:status')
  },

  // ===== 本地模型管理 =====
  models: {
    status: () => ipcRenderer.invoke('models:status'),
    download: (key) => ipcRenderer.invoke('models:download', key),
    cancel: (key) => ipcRenderer.invoke('models:cancel', key),
    delete: (key) => ipcRenderer.invoke('models:delete', key),
    openFolder: (key) => ipcRenderer.invoke('models:openFolder', key),
    onProgress: (callback) => {
      ipcRenderer.on('models:progress', (event, progress) => callback(progress))
    }
  },

  // ===== 本地 ASR 與翻譯 =====
  localAsr: {
    transcribe: (req) => ipcRenderer.invoke('localAsr:transcribe', req)
  },
  translate: (text, targetLang, opts) =>
    ipcRenderer.invoke('translate', text, targetLang, opts || {})
})
