const { contextBridge, ipcRenderer, webUtils } = require('electron')

/**
 * 安全地將 API 暴露給 Renderer Process
 */
contextBridge.exposeInMainWorld('electronAPI', {
  /**
   * 取得本機檔案絕對路徑（Electron 32+ 取代 File.path）
   * @param {File} file
   * @returns {string}
   */
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || ''
    } catch {
      return ''
    }
  },
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
    transcribe: (req) => ipcRenderer.invoke('localAsr:transcribe', req),
    /** 長檔串流轉錄（main 端 ffmpeg 切段） */
    transcribeFile: (req) => ipcRenderer.invoke('localAsr:transcribeFile', req),
    cancelFileTranscribe: () => ipcRenderer.invoke('localAsr:cancelFileTranscribe'),
    onFileProgress: (callback) => {
      const handler = (_event, progress) => callback(progress)
      ipcRenderer.on('localAsr:fileProgress', handler)
      return () => ipcRenderer.removeListener('localAsr:fileProgress', handler)
    }
  },
  translate: (text, targetLang, opts) =>
    ipcRenderer.invoke('translate', text, targetLang, opts || {}),

  // ===== Edge TTS =====
  tts: {
    listVoices: () => ipcRenderer.invoke('tts:listVoices'),
    /**
     * @param {string} text
     * @param {string} lang  zh-TW | zh-CN | en | ja | ko
     * @param {{ chunkIndex?: number }} [opts]
     * @returns {Promise<{ mime: string, data: Uint8Array, chunkIndex: number, totalChunks: number, gen: number }>}
     */
    synthesize: (text, lang, opts) =>
      ipcRenderer.invoke('tts:synthesize', {
        text,
        lang,
        chunkIndex: opts?.chunkIndex
      }),
    cancel: () => ipcRenderer.invoke('tts:cancel')
  },

  // ===== 主視窗控制（frameless）=====
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    onMaximized: (callback) => {
      const handler = (_event, value) => callback(value)
      ipcRenderer.on('window:maximized', handler)
      return () => ipcRenderer.removeListener('window:maximized', handler)
    }
  },

  // ===== 系統／LLM 能力 =====
  system: {
    gpuCapability: () => ipcRenderer.invoke('system:gpuCapability'),
    refreshGpuCapability: () => ipcRenderer.invoke('system:refreshGpuCapability'),
    installCudaEnv: () => ipcRenderer.invoke('system:installCudaEnv'),
    openCudaDownloadPage: () => ipcRenderer.invoke('system:openCudaDownloadPage'),
    onCudaInstallProgress: (callback) => {
      const handler = (_event, progress) => callback(progress)
      ipcRenderer.on('system:cudaInstallProgress', handler)
      return () => ipcRenderer.removeListener('system:cudaInstallProgress', handler)
    }
  },
  llm: {
    loadInfo: () => ipcRenderer.invoke('llm:loadInfo')
  },

  // ===== 額度儀錶板 =====
  // 所有憑證、URL、SQL 與 provider 選擇都固定在 main；此處不接受任意來源參數。
  usage: {
    load: () => ipcRenderer.invoke('usage:load'),
    sync: () => ipcRenderer.invoke('usage:sync'),
    saveSettings: (settings) => ipcRenderer.invoke('usage:saveSettings', settings),
    getDiagnostics: () => ipcRenderer.invoke('usage:diagnostics')
  },

  // ===== 聊天（雲端串流）=====
  chat: {
    /** @returns {Promise<Array<{ id: string, title: string, updatedAt: number, messageCount: number }>>} */
    list: () => ipcRenderer.invoke('chat:list'),
    get: (id) => ipcRenderer.invoke('chat:get', id),
    create: () => ipcRenderer.invoke('chat:create'),
    delete: (id) => ipcRenderer.invoke('chat:delete', id),
    rename: (id, title) => ipcRenderer.invoke('chat:rename', id, title),
    /**
     * model 與歷史都由 main 決定，這裡只給對話 id、文字與圖片 data URL
     * @param {{ reqId: string, conversationId: string, text?: string, images?: string[], regenerate?: boolean }} req
     * @returns {Promise<{ ok: boolean, content?: string, aborted?: boolean, error?: string }>}
     */
    send: (req) => ipcRenderer.invoke('chat:send', req),
    abort: (reqId) => ipcRenderer.invoke('chat:abort', reqId),
    /**
     * 讀回附件圖片（main 驗證檔名，renderer 拿不到路徑）
     * @param {string} name
     * @returns {Promise<string>} data URL，失敗回空字串
     */
    image: (name) => ipcRenderer.invoke('chat:image', name),
    /** @param {(payload: { reqId: string, text: string, kind: 'content'|'reasoning' }) => void} callback */
    onDelta: (callback) => {
      const handler = (_event, payload) => callback(payload)
      ipcRenderer.on('chat:delta', handler)
      return () => ipcRenderer.removeListener('chat:delta', handler)
    }
  }
})
