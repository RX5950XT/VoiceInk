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

  // ===== Claude Code 工作台 =====
  // 供應商端點、MCP 檔案路徑、CLI 的 npm 套件名都在 main 的固定表；格式值受白名單限制，
  // 這裡只送得出 preset key、供應商 id、MCP 定義、工具 key 與格式選擇。
  ccswitch: {
    /** 預設供應商清單 ＋ MCP 範本（不含任何憑證） */
    catalog: () => ipcRenderer.invoke('ccswitch:catalog'),
    listProviders: () => ipcRenderer.invoke('ccswitch:listProviders'),
    /** @param {{ presetId: string, name?: string, apiKey?: string, model?: string, apiFormat?: string }} req */
    createProvider: (req) => ipcRenderer.invoke('ccswitch:createProvider', req || {}),
    /** @param {string} id @param {{ name?: string, apiKey?: string, model?: string, apiFormat?: string }} patch */
    updateProvider: (id, patch) => ipcRenderer.invoke('ccswitch:updateProvider', id, patch || {}),
    deleteProvider: (id) => ipcRenderer.invoke('ccswitch:deleteProvider', id),
    /** @param {string[]} ids 拖曳後的完整順序 */
    reorderProviders: (ids) => ipcRenderer.invoke('ccswitch:reorderProviders', ids),
    /** 切換：把這一筆寫進 ~/.claude/settings.json 的 env（閘道需先手動開啟） */
    activateProvider: (id) => ipcRenderer.invoke('ccswitch:activateProvider', id),
    /** @param {string} id 用儲存的上游格式測試上游，只回傳狀態摘要 */
    testProvider: (id) => ipcRenderer.invoke('ccswitch:testProvider', id),
    /** @param {string} id 從 API 掃這一筆的模型清單；回 { ok, models } / { ok: false, code, error } */
    scanModels: (id) => ipcRenderer.invoke('ccswitch:scanModels', id),

    /** 本機轉換閘道的狀態（回傳不含任何上游 token） */
    gatewayStatus: () => ipcRenderer.invoke('ccswitch:gatewayStatus'),
    startGateway: () => ipcRenderer.invoke('ccswitch:startGateway'),
    stopGateway: () => ipcRenderer.invoke('ccswitch:stopGateway'),

    listMcp: () => ipcRenderer.invoke('ccswitch:listMcp'),
    /** @param {string} id @param {object} spec @param {boolean} enabled */
    saveMcp: (id, spec, enabled) => ipcRenderer.invoke('ccswitch:saveMcp', id, spec, enabled),
    toggleMcp: (id, enabled) => ipcRenderer.invoke('ccswitch:toggleMcp', id, enabled),
    deleteMcp: (id) => ipcRenderer.invoke('ccswitch:deleteMcp', id),

    /** 在本 App 登入的 ChatGPT／xAI 帳號清單（**不含任何 token**） */
    listAccounts: () => ipcRenderer.invoke('ccswitch:listAccounts'),
    /** @param {string} providerKey 開始登入；回「現在該去哪、要輸入什麼碼」，完成與否要輪詢 loginStatus */
    beginLogin: (providerKey) => ipcRenderer.invoke('ccswitch:beginLogin', providerKey),
    /** @param {string} providerKey */
    loginStatus: (providerKey) => ipcRenderer.invoke('ccswitch:loginStatus', providerKey),
    /** @param {string} providerKey */
    cancelLogin: (providerKey) => ipcRenderer.invoke('ccswitch:cancelLogin', providerKey),
    /** @param {string} accountId 刪帳號並把綁著它的供應商解綁 */
    removeAccount: (accountId) => ipcRenderer.invoke('ccswitch:removeAccount', accountId),

    /** 逐一跑 `<工具> --version` 並查 npm registry；離線時仍回本機版本 */
    checkVersions: () => ipcRenderer.invoke('ccswitch:checkVersions'),
    /** @param {string} key 更新指令字串（由 main 組，交給終端機分頁執行） */
    updateCommand: (key) => ipcRenderer.invoke('ccswitch:updateCommand', key)
  },

  // ===== 本機 token 用量統計 =====
  // 記錄檔路徑、SQL 與時間範圍都固定在 main；這裡只送得出 range key 與單價表。
  codeusage: {
    /** @param {{ range?: string, provider?: string }} query range 是 main 的白名單 */
    stats: (query) => ipcRenderer.invoke('codeusage:stats', query || {}),
    /** 掃描本機 session 記錄（第一次很久，之後只讀新增的部分） */
    sync: () => ipcRenderer.invoke('codeusage:sync'),
    /** @param {Record<string, { input: number, output: number }>} prices 每 1M token 的美金價 */
    savePrices: (prices) => ipcRenderer.invoke('codeusage:savePrices', prices),
    /** 清掉游標與統計，下次從頭掃 */
    reset: () => ipcRenderer.invoke('codeusage:reset')
  },

  // ===== 系統監控 =====
  // PowerShell 腳本、nvidia-smi 參數、taskkill 參數都固定在 main；
  // 這裡只送得出取樣間隔的 key、要結束的 pid，以及由系統對話框選出來的目錄。
  sysmon: {
    status: () => ipcRenderer.invoke('sysmon:status'),
    /** @param {'fast'|'normal'|'slow'} intervalKey main 端有白名單，未知值退回 normal */
    start: (intervalKey) => ipcRenderer.invoke('sysmon:start', intervalKey),
    stop: () => ipcRenderer.invoke('sysmon:stop'),
    /** 一次性硬體清單（CPU／主機板／BIOS／記憶體模組／GPU／實體碟／磁碟區） */
    inventory: () => ipcRenderer.invoke('sysmon:inventory'),
    /** 選到某一列才查路徑／擁有者；每輪都查會多 284ms */
    detail: (pid) => ipcRenderer.invoke('sysmon:detail', pid),
    /** @param {number} pid @param {boolean} force true = taskkill /F /T */
    kill: (pid, force) => ipcRenderer.invoke('sysmon:kill', pid, force === true),
    enableSensors: () => ipcRenderer.invoke('sysmon:enableSensors'),
    /** 代裝 PawnIO 核心驅動：下載網址與安裝參數都在 main，這裡送不出任何字串 */
    installPawnIo: () => ipcRenderer.invoke('sysmon:installPawnIo'),
    /** 開 PawnIO 官方安裝頁；網址是 main 的固定常數，這裡送不出任何字串 */
    openPawnIoPage: () => ipcRenderer.invoke('sysmon:openPawnIoPage'),
    // 壓力測試跑在 main（renderer 的 Worker 會跟畫面搶排程，也配不到大塊記憶體）
    cpuStress: (run, threads) => ipcRenderer.invoke('sysmon:cpuStress', run === true, threads),
    memStress: (run, gb) => ipcRenderer.invoke('sysmon:memStress', run === true, gb),
    stressStatus: () => ipcRenderer.invoke('sysmon:stressStatus'),
    gpuStress: (active) => ipcRenderer.invoke('sysmon:gpuStress', active === true),
    /** @param {{ drive: string, sizeMb: number }} req renderer 只送磁碟代號，路徑由 main 組 */
    diskBench: (req) => ipcRenderer.invoke('sysmon:diskBench', req || {}),
    cancelDiskBench: () => ipcRenderer.invoke('sysmon:cancelDiskBench'),
    // 風扇控制：只送 identifier 與數字，main 會對照即時通道清單驗過
    fanList: () => ipcRenderer.invoke('sysmon:fanList'),
    fanEnable: (on) => ipcRenderer.invoke('sysmon:fanEnable', on === true),
    fanSetChannel: (id, patch) => ipcRenderer.invoke('sysmon:fanSetChannel', id, patch || {}),
    fanIdentify: (id) => ipcRenderer.invoke('sysmon:fanIdentify', id),
    fanResetAll: () => ipcRenderer.invoke('sysmon:fanResetAll'),
    fanTaskStatus: () => ipcRenderer.invoke('sysmon:fanTaskStatus'),
    fanTaskInstall: () => ipcRenderer.invoke('sysmon:fanTaskInstall'),
    fanTaskRemove: () => ipcRenderer.invoke('sysmon:fanTaskRemove'),

    /** @param {(payload: { type: string, data: any }) => void} callback */
    onEvent: (callback) => {
      const handler = (_event, payload) => callback(payload)
      ipcRenderer.on('sysmon:event', handler)
      return () => ipcRenderer.removeListener('sysmon:event', handler)
    }
  },

  // ===== HF模型（本機 llama.cpp router）=====
  // 這裡送得出去的只有 repoId／變體 id／模型 id：下載網址由 main 從 repoId 組，
  // router 的 api key 不出 main。要匯入本機檔案也是 main 開對話框，這裡沒有路徑參數。
  hfmodels: {
    /** @param {string} query @param {'downloads'|'likes'|'lastModified'} [sort] */
    search: (query, sort) => ipcRenderer.invoke('hfmodels:search', query, sort),
    /** 一個 repo 有哪些量化變體、哪些已經裝了 */
    inspect: (repoId) => ipcRenderer.invoke('hfmodels:inspect', repoId),
    /** 還沒下載就先算「跑不跑得動」（main 用 HTTP Range 抓檔頭前 1MB） */
    preview: (repoId, variantId) => ipcRenderer.invoke('hfmodels:preview', repoId, variantId),
    /** 詳情面板：模型卡、README、每個量化的大小與可行性 */
    detail: (repoId) => ipcRenderer.invoke('hfmodels:detail', repoId),
    install: (repoId, variantId) => ipcRenderer.invoke('hfmodels:install', repoId, variantId),
    cancelInstall: (variantId) => ipcRenderer.invoke('hfmodels:cancelInstall', variantId),
    list: () => ipcRenderer.invoke('hfmodels:list'),
    remove: (id) => ipcRenderer.invoke('hfmodels:remove', id),
    /** 走系統對話框選 .gguf（沒有路徑參數） */
    import: () => ipcRenderer.invoke('hfmodels:import'),
    /** 在檔案總管開模型資料夾（使用者要自己把 gguf 拖進去） */
    openFolder: () => ipcRenderer.invoke('hfmodels:openFolder'),
    /** 手動拖檔進去之後重新掃描 */
    rescan: () => ipcRenderer.invoke('hfmodels:rescan'),
    /** @param {string} id @param {{ requested?: object, rawArgs?: string }} patch */
    updateSettings: (id, patch) => ipcRenderer.invoke('hfmodels:updateSettings', id, patch),
    /** 重跑官方的 llama-fit-params（實際載一次模型量記憶體） */
    refreshFit: (id) => ipcRenderer.invoke('hfmodels:refreshFit', id),
    /** 實測調校：跑 llama-bench 比幾組候選參數 */
    tune: (id) => ipcRenderer.invoke('hfmodels:tune', id),
    /** 一鍵自動調參：fit 量記憶體 → bench 實測挑最快 */
    autoTune: (id) => ipcRenderer.invoke('hfmodels:autoTune', id),
    cancelTune: () => ipcRenderer.invoke('hfmodels:cancelTune'),
    /** 執行環境＋裝置＋CPU＋資料夾＋有沒有 token 一次給 */
    hardware: () => ipcRenderer.invoke('hfmodels:hardware'),
    /** 走系統對話框換模型資料夾（沒有路徑參數） */
    chooseDir: () => ipcRenderer.invoke('hfmodels:chooseDir'),
    /** HF Token 只寫不讀：回的是 { hasToken } */
    setToken: (token) => ipcRenderer.invoke('hfmodels:setToken', token),
    tokenStatus: () => ipcRenderer.invoke('hfmodels:tokenStatus'),
    runtimeReady: () => ipcRenderer.invoke('hfmodels:runtimeReady'),
    /** 只回 { running, port }——金鑰留在 main */
    runtimeStatus: () => ipcRenderer.invoke('hfmodels:runtimeStatus'),
    startRuntime: () => ipcRenderer.invoke('hfmodels:startRuntime'),
    stopRuntime: () => ipcRenderer.invoke('hfmodels:stopRuntime'),
    device: () => ipcRenderer.invoke('hfmodels:device'),
    /** 重算每顆模型的參數並重啟 router（preset 只在啟動時讀） */
    applyPresets: () => ipcRenderer.invoke('hfmodels:applyPresets'),
    loadModel: (id) => ipcRenderer.invoke('hfmodels:loadModel', id),
    unloadModel: (id) => ipcRenderer.invoke('hfmodels:unloadModel', id),
    refreshModels: () => ipcRenderer.invoke('hfmodels:refreshModels'),
    /** @param {(payload: { type: string, [k: string]: any }) => void} callback 下載進度等事件 */
    onEvent: (callback) => {
      const handler = (_event, payload) => callback(payload)
      ipcRenderer.on('hfmodels:event', handler)
      return () => ipcRenderer.removeListener('hfmodels:event', handler)
    }
  },

  // ===== 語音輸入（全域右 Alt）=====
  // 熱鍵、ASR 模型、整理用的供應商與剪貼簿都在 main；這裡只送得出錄好的 PCM 與字典字串。
  dictation: {
    status: () => ipcRenderer.invoke('dictation:status'),
    /** 依 store 的 dictationEnabled 重新掛上／拔掉全域熱鍵 */
    refresh: () => ipcRenderer.invoke('dictation:refresh'),
    /**
     * 錄完一段就送進來：ASR → 字典 → LLM 整理 → 貼到游標處 → 存紀錄
     * @param {{ samples: Float32Array, sampleRate: number, durationMs: number }} req
     */
    submit: (req) => ipcRenderer.invoke('dictation:submit', req),
    /** @param {{ limit?: number }} [query] */
    records: (query) => ipcRenderer.invoke('dictation:records', query || {}),
    deleteRecord: (id) => ipcRenderer.invoke('dictation:deleteRecord', id),
    clearRecords: () => ipcRenderer.invoke('dictation:clearRecords'),
    dictionary: () => ipcRenderer.invoke('dictation:dictionary'),
    /** @param {{ from: string, to: string }} entry */
    saveTerm: (entry) => ipcRenderer.invoke('dictation:saveTerm', entry),
    deleteTerm: (from) => ipcRenderer.invoke('dictation:deleteTerm', from),
    /** @param {(payload: { type: string, data: any }) => void} callback */
    onEvent: (callback) => {
      const handler = (_event, payload) => callback(payload)
      ipcRenderer.on('dictation:event', handler)
      return () => ipcRenderer.removeListener('dictation:event', handler)
    },

    // --- 桌面指示器（另一扇視窗）---
    // 主視窗把「正在錄／音量多大／出什麼錯」推給 main，main 再決定指示器要不要出現、
    // 出現在哪一面螢幕。指示器那一側只收畫面資料，送得出去的只有 ✕／✓。
    /** @param {{ state: string, level?: number, message?: string }} payload */
    hudState: (payload) => ipcRenderer.invoke('dictation:hudState', payload),
    /** @param {'cancel'|'stop'} action */
    hudAction: (action) => ipcRenderer.invoke('dictation:hudAction', action),
    /** @param {(payload: { state: string, level: number, message: string }) => void} callback */
    onHud: (callback) => {
      const handler = (_event, payload) => callback(payload)
      ipcRenderer.on('dictation:hud', handler)
      return () => ipcRenderer.removeListener('dictation:hud', handler)
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
     * 模型選單的選項（含 main 合成的「本機模型」那一組）。
     * 不要改回自己讀 `chatProviders`——那樣看不到本機模型。
     */
    providerOptions: () => ipcRenderer.invoke('chat:providerOptions'),
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
