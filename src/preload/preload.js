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
      const handler = (event, text) => callback(text)
      ipcRenderer.on('subtitle:text', handler)
      return () => ipcRenderer.removeListener('subtitle:text', handler)
    },
    onClosed: (callback) => {
      const handler = () => callback()
      ipcRenderer.on('subtitle:closed', handler)
      return () => ipcRenderer.removeListener('subtitle:closed', handler)
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
      const handler = (event, progress) => callback(progress)
      ipcRenderer.on('models:progress', handler)
      return () => ipcRenderer.removeListener('models:progress', handler)
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
    /**
     * 設定頁試聽：唸 main 固定的範例句，用還沒儲存的語音／語速
     * @param {string} lang
     * @param {string} voice  必須在 main 的語音白名單內，否則退回該語言預設
     * @param {number} rate   -50…100
     */
    preview: (lang, voice, rate) => ipcRenderer.invoke('tts:preview', { lang, voice, rate }),
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
    getStartup: () => ipcRenderer.invoke('system:getStartup'),
    setStartup: (enabled) => ipcRenderer.invoke('system:setStartup', enabled === true),
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

  // ===== AGY 反向代理 =====
  // 憑證、上游 URL 與 project id 都留在 main；這裡只傳得到 port／開關這種無害設定。
  agy: {
    status: () => ipcRenderer.invoke('agy:status'),
    start: () => ipcRenderer.invoke('agy:start'),
    stop: () => ipcRenderer.invoke('agy:stop'),
    /** @param {{ port: number, logBodies: boolean, retentionDays: number }} settings */
    saveSettings: (settings) => ipcRenderer.invoke('agy:saveSettings', settings),
    regenerateKey: () => ipcRenderer.invoke('agy:regenerateKey'),
    /** @param {{ limit?: number, protocol?: string, onlyErrors?: boolean }} query */
    logs: (query) => ipcRenderer.invoke('agy:logs', query),
    /** @param {{ range?: '6h'|'24h'|'7d'|'30d'|'all' }} [query] 範圍在 main 驗證 */
    stats: (query) => ipcRenderer.invoke('agy:stats', query),
    models: (force) => ipcRenderer.invoke('agy:models', force === true),
    clearLogs: () => ipcRenderer.invoke('agy:clearLogs'),
    /** 端到端自我測試：自動挑模型，從本機閘道真的送一則訊息 */
    test: () => ipcRenderer.invoke('agy:test')
  },

  // ===== 終端機 =====
  // shell 與啟動指令都只傳 key（執行檔路徑在 main 的固定表）；工作目錄一律走系統對話框。
  terminal: {
    /** @returns {Promise<{ ok: boolean, data?: { shells: object[], presets: object[], maxSessions: number } }>} */
    catalog: () => ipcRenderer.invoke('terminal:catalog'),
    list: () => ipcRenderer.invoke('terminal:list'),
    /** @param {{ shell?: string, preset?: string, cwd?: string, title?: string }} req */
    create: (req) => ipcRenderer.invoke('terminal:create', req || {}),
    rename: (id, title) => ipcRenderer.invoke('terminal:rename', id, title),
    delete: (id) => ipcRenderer.invoke('terminal:delete', id),
    /** @param {string[]} ids 側欄拖曳後的完整順序 */
    reorder: (ids) => ipcRenderer.invoke('terminal:reorder', ids),
    /** 掛上分頁；回傳目前畫面快照與 seq（早於 seq 的 data 事件要丟掉） */
    open: (id, cols, rows) => ipcRenderer.invoke('terminal:open', id, cols, rows),
    write: (id, data) => ipcRenderer.invoke('terminal:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.invoke('terminal:resize', id, cols, rows),
    kill: (id) => ipcRenderer.invoke('terminal:kill', id),
    pickDirectory: () => ipcRenderer.invoke('terminal:pickDirectory'),
    /** @param {(payload: { id: string, seq: number, data: string }) => void} callback */
    onData: (callback) => {
      const handler = (_event, payload) => callback(payload)
      ipcRenderer.on('terminal:data', handler)
      return () => ipcRenderer.removeListener('terminal:data', handler)
    },
    /** @param {(payload: { id: string, state: string, exitCode: number | null }) => void} callback */
    onStatus: (callback) => {
      const handler = (_event, payload) => callback(payload)
      ipcRenderer.on('terminal:status', handler)
      return () => ipcRenderer.removeListener('terminal:status', handler)
    }
  },

  // ===== 聊天（雲端串流）=====
  chat: {
    /** @returns {Promise<Array<{ id: string, title: string, updatedAt: number, messageCount: number }>>} */
    list: () => ipcRenderer.invoke('chat:list'),
    get: (id) => ipcRenderer.invoke('chat:get', id),
    create: () => ipcRenderer.invoke('chat:create'),
    delete: (id) => ipcRenderer.invoke('chat:delete', id),
    rename: (id, title) => ipcRenderer.invoke('chat:rename', id, title),
    /** @param {string[]} ids 側欄拖曳後的完整順序；main 只接受既有 id */
    reorder: (ids) => ipcRenderer.invoke('chat:reorder', ids),
    scanModels: (providerId) => ipcRenderer.invoke('chat:scanModels', providerId),
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
