# VoiceInk - AI Agent Instructions

> 此文件為 AI 助手提供開發 VoiceInk MVP 的指導原則。

---

## 1. 專案概覽

**VoiceInk**（v1.9.0）是一個 Windows 桌面端 AI 工作台，具備：

- AI 聊天（雲端串流、多會話）
- 終端機（側欄多開、運行狀態、AI 代理啟動指令）
- AI 訂閱額度（五家 provider、手動同步）
- AGY 反向代理（本機 API 閘道、流量日誌、統計）
- 語音轉文字（同一分頁的兩個子分頁：音訊檔案轉錄、系統音訊即時字幕）
- 翻譯與 TTS（Edge TTS 朗讀）
- 深色/淺色主題切換

### 技術堆疊

- **Electron 43.4.1** - 桌面應用框架（安全更新後固定版本）
- **Vite** - 構建工具
- **Vanilla JavaScript** - 無框架前端
- **ASR** - 本地兩顆（`asr-select.js` 依 `asrModelKey` 分流）：`qwen3asr`＝sherpa-onnx Qwen3-ASR 0.6B INT8（僅 CPU）／`qwen3asrgpu`＝llama-server sidecar 跑 Qwen3-ASR 1.7B Q8_0（Vulkan GPU，需搭 `llamaruntime`）；或雲端（OpenRouter 相容 `/audio/transcriptions`）
- **翻譯** - 雲端 chat / 本地 GGUF（`linguaforge08q4` 預設／`qwen35translate`＝Qwen3.5 0.8B Q4／`qwen354b`＝Qwen3.5 4B Q4 建議 GPU；`llmGpu` 可開 GPU）；即時「自動偵測」= 不譯
- **TTS** - Edge TTS（`node-edge-tts` MIT；語速 `ttsRate`；需連網）
- **翻譯頁** - 輸入不限字數：`splitForTranslate` 通用 ≤600／LinguaForge ≤280 字段落依序翻譯、可中途停止（IPC 單次上限 1500 字）；LinguaForge 解碼見 `local-llm` DECODE 查表
- **聊天** - 雲端 OpenAI 相容 `/chat/completions` + `stream:true`；多組供應商（`chatProviders`/`chatProviderId`/`chatModelId`），**雲端翻譯共用同一份清單**（`translateProviderId`/`translateModelId`）；會話存 `<userData>/chats.json`（`chat:*` IPC，不走 `store:*`）；Markdown 為自寫渲染器 `renderer/scripts/markdown.js`（零 innerHTML）
- **聊天進階** - 系統提示多組 preset（`chatPrompts`/`chatPromptId`，輸入框那一排切換、`<dialog>` 管理）；thinking 開關（`chatThinking` → `reasoning_effort`，關閉時完全不帶欄位）；圖片附件（貼上／拖放／選檔 → canvas 縮至 1568px JPEG → main 存 `<userData>/chat-images/`，訊息只記檔名）；生圖模型（模型清單勾「生圖」→ `imageModels`，請求帶 `modalities:['image','text']`，回來的 data URI 同樣存 `chat-images/`）；訊息複製與重新生成；側欄搜尋、就地改名、逐列刪除與 pointer 拖曳排序（`chat:reorder`，順序＝`chats.json` 陣列順序）
- **終端機** - `src/main/terminal/`：`@lydell/node-pty`（ConPTY，N-API prebuilt 不需 rebuild）＋ xterm.js（renderer 直接 import `node_modules` 的 `.mjs`，不 vendoring）。側欄多開，狀態「運行中／已完成／已結束」靠 OSC 133 標記（帶 `Get-History` id 去重）＋ 靜默偵測雙軌；shell 與啟動指令是 main 的固定表（renderer 只送 key），cwd 走系統對話框；metadata 存 `<userData>/terminals.json`，走 `terminal:*` IPC（不進 `STORE_ALLOWLIST`）；側欄排序與聊天共用 `list-reorder.js`
- **AGY 反代** - `src/main/agy/`：node:http 閘道（只綁 `127.0.0.1`＋強制 Bearer／x-api-key），OpenAI `/v1/chat/completions` 與 Anthropic `/v1/messages` 雙協議轉成 cloudcode-pa `v1internal:streamGenerateContent`；憑證鏈與額度頁共用（`usage/antigravity.js`），設定走 `agy:*` IPC（不進 `STORE_ALLOWLIST`），日誌與統計在 `<userData>/agy-logs.db`（`node:sqlite`）
- **額度** - Claude Code／Codex／Antigravity／OpenCode／Grok；手動同步；獨立 `<userData>/usage.json` 快取。憑證與固定 HTTPS／DB 路徑／SQL 只在 main；OpenCode 用 `node:sqlite` 唯讀；Antigravity `.ps1` 必須 `asarUnpack`
- **設定** - 導航最後一頁：左側分類 rail（本地模型／雲端模型／語音朗讀／基本）一次顯示一區，底部 sticky 儲存列。設定頁只管「裝了什麼、怎麼推論、雲端端點」，**選用哪一顆模型在功能頁標題旁的下拉**（`.model-chip`）。雲端模型只有兩塊：供應商（聊天與翻譯共用）與語音轉文字；主窗 frameless；預設分頁為聊天；導覽為聊天｜終端機｜額度｜AGY反代｜語音轉文字（子分頁：檔案轉錄／即時字幕）｜翻譯與 TTS｜設定
- **啟動** - `whenReady` 立刻建窗（`show: true`），不 await store；ASR／LLM／額度／AGY／CUDA 第一次用到才 require；非聊天分頁 dynamic import。`asar.smartUnpack` 必須 false；`asarUnpack` 只放 sherpa、llama CPU、`@reflink`、Antigravity `.ps1`、node-pty（帶 `conpty.dll` 與 `OpenConsole.exe`，asar 內的 .exe 執行不了）；ffmpeg／CUDA／Vulkan 留 asar，第一次用拷到 `%APPDATA%/voiceink/`（不要寫 Program Files）
- **視覺** - Token Anxiety Aurora glass；深／淺兩主題、12px 半透明 surface、冷藍／暖金光暈；RWD 斷點 900／640px，含置頂字幕窗
- **本地 ASR 推論** - **沒有 CPU/GPU 開關**：`qwen3asr` 只有 sherpa（npm 的 Windows 套件是 CPU-only 編譯，指定 cuda／directml 會被靜默退回 CPU，執行緒一律自動）、`qwen3asrgpu` 只有 llama-server（**啟動一定要帶 `--device`，只給 `--gpu-layers` 會整包跑 CPU**）。選了模型就決定了推論方式；`llmGpu` 只管本地翻譯，且是全域的

> 現行架構與驗證紀錄見 [CONTEXT.md](./CONTEXT.md)（接手前先讀）。

### 建置與預覽

```bash
npm run electron:pack    # 免安裝快速預覽 → dist/win-unpacked/VoiceInk.exe
npm run electron:build   # NSIS 安裝檔 + win-unpacked → dist/
```

> [!IMPORTANT]
> **每次 UI／功能改動完成後，必須先跑 `npm run electron:pack` 更新免安裝預覽**，讓使用者可直接執行 `dist/win-unpacked/VoiceInk.exe` 驗證。完整 `.exe` 安裝檔（`electron:build`）只在發佈時再打。
> 打包前先關掉開著的 `dist/win-unpacked/VoiceInk.exe`（`Stop-Process -Name VoiceInk -Force`），否則會卡 `d3dcompiler_47.dll: Access is denied`。
> 發行流程：bump 版本（不可與既有 tag 重複）→ commit → `git tag vX.Y.Z` → push → `electron:build` → `gh release create`。
> 使用者同時操作電腦時，桌面 QA 只能用 CDP／視窗 API 背景定位與操作；不可移動滑鼠、發全域快捷鍵或搶前景焦點。
> CDP 測試只可用自己 spawn 的 `child.pid` 搭配 `taskkill /PID /T` 收尾，禁止 `/IM VoiceInk.exe`，不可關閉使用者安裝版。

---

## 2. 程式碼規範

### 2.1 命名規則

- **檔案名**：kebab-case (e.g., `audio-capture.js`)
- **變數/函數**：camelCase (e.g., `transcribeFile`)
- **類別**：PascalCase (e.g., `OpenRouterAPI`)
- **常數**：UPPER_SNAKE_CASE (e.g., `API_ENDPOINT`)

### 2.2 程式碼風格

- 使用 ES2022 語法
- 優先使用 `async/await` 處理非同步
- 所有函數添加 JSDoc 註解
- 使用有意義的變數名稱

### 2.3 錯誤處理

- 所有 API 呼叫必須有 try/catch
- 使用用戶友善的錯誤訊息
- console 只記可公開的狀態摘要；不得記錄 API response body、token、外部錯誤原文或本機憑證內容

---

## 3. 關鍵實作提示

### 3.1 系統音訊擷取（Main Process）

```javascript
session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
  desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
    callback({ video: sources[0], audio: 'loopback' })
  })
})
```

Renderer 不再用 MediaRecorder 編碼／解碼：`AudioContext({ sampleRate: 16000 })` 直接取 mono PCM，
`renderer/scripts/vad.js` 以 250ms pre-roll + 360ms 停頓切句（0.5–6s），避免固定 2 秒切斷字詞與 recorder restart 音訊缺口。

### 3.2 雲端 API（僅翻譯）

翻譯選雲端時，由 `src/main/local-llm.js` 的 `translateCloud()` 呼叫 `${apiUrl}/chat/completions`（純文字）。端點與金鑰**跟聊天共用同一份供應商清單**（`chat.readTranslateConfig()`）；設定鍵：`translateProviderId` / `translateModelId`。舊的 `apiUrl` / `apiKey` / `modelId` 由 `migrateTranslateProvider()` 一次性併入 `chatProviders` 後刪除。

### 3.3 懸浮字幕視窗

```javascript
subtitleWindow = new BrowserWindow({
  frame: false,
  transparent: false, // 刻意設計：Windows 透明視窗有渲染 bug、resizable 會失效
  backgroundColor: '#1a1a1a',
  alwaysOnTop: true,
  skipTaskbar: true,
  resizable: true,
})
subtitleWindow.setMenu(null)
```

字幕顯示模式（雙語／僅翻譯）由**字幕彈窗**獨佔：控制列「雙/譯」鈕讀寫 store `captionDisplayMode`、以單一 `currentMode` 統一渲染；即時頁不再放此切換、payload 不帶 `displayMode`。字幕行用 `createElement` 增量更新（零 innerHTML），使用者往上看歷史時不強制捲底。

### 3.4 模型載入加速

- `engine.acquire` 內 ASR／LLM warm 以 `Promise.all` 並行。
- 進入 live → `prewarmEngine()`；進入 translate → `prewarmTranslatePage()`；離開各自 cooldown。owner 布林 `live|file|translate`；prewarm 以 gen 作廢 in-flight。切頁先 acquire 新頁再 release 舊頁。

---

## 4. 重要注意事項

> [!IMPORTANT]
>
> - API Key 必須安全儲存，使用 electron-store（IPC 存取）
> - 即時 VAD 在 renderer 做（RMS 遲滯門檻＋pre-roll＋hangover），不要交給 AI 判斷
> - 音訊分段：即時依停頓切 0.5–6 秒語句（ASR pending 上限 2）；檔案仍為 main ffmpeg 28 秒硬切（≥2h／≥100MB）
> - ASR：`asrEngine` local（`asrModelKey` 選 `qwen3asr`／`qwen3asrgpu`）或 cloud（獨立 asrApi* 憑證）

> [!CAUTION]
>
> - 不要在 Renderer Process 儲存 API Key 明文
> - 不要把即時字幕改回 MediaRecorder：除了 `timeslice` Blob 缺 WebM header，每輪 stop/restart 也會丟邊界音訊；維持 16k PCM 直取
> - 翻譯前文不要塞進「【前文】【本段】」括號式 prompt（小模型會複誦）→ system prompt + chat history
> - LinguaForge 不吃前文 chat history（單輪 SFT MT，多一輪就複誦上一輪譯文）→ 僅 system + 單一 user
> - `LlamaChatSession` 必須帶 `new QwenChatWrapper({ thoughts: 'discourage' })`：Qwen3.5 template 在 assistant 起頭固定補 `<think>\n\n</think>\n\n`（248068,271,248069,271），node-llama-cpp 自動解析的 wrapper 不補；缺這 4 token 會標籤前綴／專名消失／年份幻覺（`budgets.thoughtTokens:0` 補不了）
> - LinguaForge 只出貨 Q4_K_M（`linguaforge08q4`）；Q8 已下架，舊值由 `RETIRED_MODEL_KEYS` 讀成 Q4。判斷仍用 `isLinguaforge(key)` 不要比對單一 key
> - 譯文清理只放 `src/main/translate-clean.js`（無 electron 依賴、可 node 直測），別在別處複製一份；單側引號僅在無配對時剝
> - LinguaForge 長文逐行翻譯、清單標記不送模型；退化迴圈偵測到就開 rep-penalty 重跑（重試前還原 history）
> - `s2twp` 僅在含簡體時套詞彙表（`twp` 會把「參數」竄改成「引數」）
> - 顯示模式勿讓即時頁 payload 夾帶 `displayMode` 或加跨窗 IPC（由字幕彈窗獨佔 store `captionDisplayMode`，兩端搶改會打架）
> - 引擎 owner 布林 `live|file|translate`，勿改成計數；prewarm gen 作廢 in-flight；TTS 只傳 lang、回 Uint8Array（禁 base64／禁 AGPL 套件）
> - ASR 有 serial lock + `loadEnabled`（防 stop 後幽靈重載），勿拿掉
> - store key allowlist、`models.openFolder` 僅 registry key；兩窗 `sandbox: true`
> - 所有雲端路徑（額度／聊天／雲端 ASR／雲端翻譯／AGY）的錯誤訊息只留狀態碼，上游 body 與 `error.message` 一律不進 UI／console／IPC
> - `subtitleWindowBounds` 寫入與讀取都要過 `sanitizeSubtitleBounds`（allowlist 裡唯一直接餵進 `BrowserWindow` 的值）
> - AGY 反代：cloudcode-pa 的 SSE 每格包一層 `response` 信封，先 `unwrapEnvelope` 再轉換；usage 新舊格式看「有沒有 `total_output_tokens` 這個 key」決定要不要把 thought／tool token 加回 output（`agy/gemini.js` 單一實作，兩協議共用）
> - AGY 反代：上游 401 後必須 `mustRefresh`（只清快取會拿同一個死 token 重試）；上游狀態碼只有 429 原樣透傳，其餘收斂成 502；圖片只收 `data:` URI（防 SSRF）；function schema 走白名單，且要收斂三種「欄位名對、型別不對」的寫法（`type:['string','null']` → 單一型別＋`nullable`；非字串 enum 一律剝掉；`anyOf` 的 `{type:'null'}` 變體換成 `nullable`），漏一個就整包 400、所有工具陣亡；Anthropic 歷史 `thinking` block 不回送；`Host` 必須指向本機（防 DNS rebinding）；`before-quit` 用 `agy.shutdown()` 而非 `stop()`；頁面要同時給兩組 Base URL（OpenAI 帶 `/v1`、Claude Code／CC Switch 不帶）；統計範圍走 main 白名單（`logs.STAT_RANGES`）且序列要補零
> - AGY 反代（真實上游實測）：端點順序 sandbox → daily → prod（prod 回 429）；不送 `x-goog-user-project`（403 SERVICE_DISABLED）；`countTokens` 只吃 `{ request }`；`thinkingBudget: 0` 只給 `THINKING_ONLY_MODELS` 以外的模型；映射目標必須是實測 200 的模型。改這些之前先跑 `npx electron scripts/probe-agy-upstream.js`
> - 聊天設定是多組供應商（`chatProviders`／`chatProviderId`／`chatModelId`）；model 必須對目前那組供應商驗證，掃描 IPC 只收 providerId 不收 URL
> - `mergeExpectedWindows` 只在 `usage/index.js` 呼叫；`syncAntigravity` 只回上游真的給的視窗，先補一輪會讓假的 100% 被標成官方額度。**空窗也不可 merge**（API 失敗走 6h soft cache）
> - `chat.send` 的 inflight 佔位跟守衛必須同一個同步區塊，中間不得有 await
> - 重新生成在上游成功前不得先砍舊助理；`chats.json` 走 `withStore`；新圖 `hold` 到入 json
> - 離開翻譯頁必須作廢 `_translateRequestId`；`refreshUiState` 翻譯中不得 disable「停止」
> - 檔案轉錄 pause 看排隊段數，不是把 pending 一次抽進無界 chain
> - AGY 非 2xx 要 `discardResponse`，否則 undici 連線卡到 GC
> - AGY 所有端點的錯誤狀態碼一律走 `statusFor`，不得各寫一套
> - refresh 拿不到 ≠ token 過期：還沒過真實 expiry 的 access token 照用，只有上游回過 401（`mustRefresh`）才作廢
> - 常駐背景（`closeToTray`，預設開）三件套缺一不可：單一實例鎖、輸的那份用 `app.quit()`（不是 `app.exit()`，會來不及送 second-instance）、`whenReady` 也要擋。`close` 攔截必須放行 `isQuitting`
> - `document.hidden` 也代表「被完全遮住」：測「叫回視窗」要看有沒有 visible 過，不是最後停在 visible；反過來 AGY 頁靠它在縮到系統匣時自動停掉 5 秒輪詢
> - 代跑 CLI 必須是 `spawn` + `stdio: 'ignore'`。`execFile` 會留一條永不 EOF 的 stdin pipe，`agy.exe` 會卡在那裡等到逾時（實測：主控台 2～3 秒，execFile 逾時）
> - 續期靠代跑 `agy.exe models`（`credential.nudgeCli`）：我們沒有 client id／secret，refresh 永遠回空。stale 但還沒過期 → 背景跑、照回舊 token；真過期或 401 → 等 CLI 跑完重讀，且**必須確認 access token 換了新的**。冷卻 60 秒＋in-flight 合併，不然 token 尾聲會連開一堆程序
> - 反過來：`mustRefresh` 只有 401 能設。`acquire` 失敗後的清快取不可以呼叫 `invalidateToken()`，否則一次暫時性失敗就讓憑證永久卡在 `TOKEN_EXPIRED`（重開 App 才好）
> - `main.js` 的 `registerAgyIpc({ service })` 是逐一列舉的白名單：agy/index.js 新增方法要同步補一行，否則 renderer 只會看到通用的「反向代理操作失敗」
> - 訂閱方案（`planName`）來自本機登入檔而非額度 API：Claude `subscriptionType`／Codex id_token claim／Grok token 的 `tier`，共用 `shared.readJwtClaims`
> - `agy:*` IPC 只有帶 `userMessage` 的錯誤（`CredentialError`）能把訊息送到 renderer，其餘一律通用訊息
> - 模型清單以 `agy/catalog.js`（上游 `fetchAvailableModels`）為準，`model-map.js` 只翻譯上游沒有的名字；`models` 欄位是物件不是陣列。可用模型：Claude 池（含 GPT OSS）→ Gemini；世代新到舊，Gemini 同代思考強度 high→lite
> - 不得把 Antigravity 的 OAuth client id／secret 寫進原始碼，一律走環境變數；不做內建 OAuth 登入，憑證不可用時只做偵測與引導（`credential.detectSources()` 只認執行檔，空目錄不算已安裝）
> - 終端機狀態不能只靠 OSC 133 標記（PSReadLine 會把整份提示字元含標記重繪重送 → 執行中就被判完成），標記要帶 `Get-History` id 並**比大小**，第一個標記只當基準；也不能只靠靜默（代理 CLI 是常駐 REPL，shell 那層看不到結束）。兩者都要
> - 注入 PowerShell 的 `-Command` 字串不可含雙引號（單一 argv 的跳脫規則易錯），用單引號＋`+` 相接；`$ok = $?` 必須第一句
> - `term.open()` 前要先讓那一格可見，否則開出 0×0 終端機、第一段輸出直接消失
> - 終端機的 shell 與啟動指令只收 key（執行檔路徑在 main 的固定表），cwd 走系統對話框再由 main 驗證是目錄；`before-quit` 要 `killAll()`，不然 conhost 殘留
> - `.app-dialog` 本身 `padding: 0`，新增的內容區要自己補 `padding: 4px 24px 0` 才跟 `.dialog-head`／`.dialog-actions` 對齊；預設 760px 只適合寬內容，小表單自己收窄。回歸：`e2e-visual-cdp.js` 的 `dialog-align`
> - CDP 測試一律用 `[data-id="<自己建的 id>"]` 指名，不可用「第一列」或絕對總數（使用者本來就有資料時會誤判，甚至刪到使用者的東西）；中途建立的每一個都要在收尾刪掉
> - 設定頁不放「用哪一顆模型」；選單是既有 key 的扁平視圖（`asrEngine`+`asrModelKey` ／ `translator`+`localTranslateModel`＋雲端時的 `translateProviderId`+`translateModelId`），不要新增第三份狀態，也不要各頁記一份
> - 生圖：SSE buffer 要放大到 24MB（整張圖在同一行 `data:` 裡），只收 `data:` URI，`imageModels` 必須是 `models` 的子集，而且**生成的圖不回送上游**（assistant 訊息塞 image_url 陣列會被嚴格端點 400）
> - `asr-select.js` 是本地 ASR 唯一的選擇點；`engine.js` 的 `setStore` 一定要轉給它，否則 prewarm 會 warm 錯模型
> - llama-server 回來的文字要 `stripAsrTags` 剝 `language X<asr_text>` 前綴，中文再套 `s2twp`；`before-quit` 一定要把 sidecar 收掉
> - 新增 nav 分頁要同步更新四個 CDP 腳本的頁面清單（`e2e-cdp-smoke.js`／`e2e-usage-cdp.js`／`e2e-agy-cdp.js` 的 `EXPECTED_ORDER`／`e2e-visual-cdp.js` 的 `PAGES` 與 `SIGNATURES`）
> - 額度 IPC 只允許主視窗；renderer 不可指定 provider URL、credential path、DB path 或 SQL。Antigravity 未連線時不得補出假額度；外部 PowerShell 腳本須從 `app.asar.unpacked` 執行
> - 額度排序對齊 Token Anxiety：pointer 直拖、跟手 overlay（不透明）＋格子裡半透明鬼影；拖曳中只改 transform、不改 DOM，碰撞打開始時的靜態槽位；Space／方向鍵／Enter／Esc 鍵盤排序
> - 額度卡固定 2 欄（≤900px 收 1 欄）、標題為 accent 實心 pill（無 LOGO 方塊、無方案副標），卡內小字 12px／`--text-secondary`
> - Aurora token 集中在 `themes.css`，共用 surface／900、640px RWD 在 `main.css`；維持原生 DOM／Web Animations，不引入 React、DnD 或動畫 dependency
> - 下拉清單由 `renderer/scripts/custom-select.js` 接手：原始 `<select>` 保留作為資料來源與 `change` 事件目標，畫面用共用 ARIA listbox；fixed portal 避開 overflow，dialog 內掛回 top layer。`optgroup` 用 `querySelectorAll('option')` 讀取，清單寬度至少容納選項且受視窗邊界限制。原生 `<option>` 仍必須明寫不透明的 `--surface-solid`＋`--text-primary`，後備呈現才不會在深色主題變成白底近白字（`e2e-visual-cdp.js` 的 `custom-dropdown`／`option-contrast` 驗證）
> - 打包跑的是 `src/` 原始碼（`files` 排除 `dist/**`），改 renderer 直接改 `src/`；`vite build` 只作驗證
> - 歷史教訓清單見 [tasks/lessons.md](./tasks/lessons.md)，開發規範地雷見 [CLAUDE.md](./CLAUDE.md)
