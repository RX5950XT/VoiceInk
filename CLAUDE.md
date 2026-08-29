# CLAUDE.md

> VoiceInk 專案規範。接手前先讀 [CONTEXT.md](./CONTEXT.md)（現行架構與驗證紀錄）；開發規範細節見 [AGENTS.md](./AGENTS.md)，兩份文件需同步對齊。

## 專案

Windows Electron AI 工作台：聊天＋終端機＋額度＋AGY 反代＋語音轉文字（檔案轉錄／即時字幕）＋翻譯與 TTS。Vanilla JS + Vite，無前端框架。

- Core：Electron 43.4.1（固定版本）＋ Node.js 22

- 聊天：雲端 OpenAI 相容 `/chat/completions` + `stream:true`。**多組供應商**（`chatProviders` 陣列＋`chatProviderId`＋`chatModelId`），每組帶自己的 url／key／模型清單，可向 `/models` 掃描；**雲端翻譯共用同一份清單**（`translateProviderId`＋`translateModelId`）
- 聊天進階：系統提示多組 preset（`chatPrompts`/`chatPromptId`，在輸入框那一排切換與管理）、thinking 開關（`chatThinking` → `reasoning_effort`）、圖片附件（存 `<userData>/chat-images/`）、訊息複製／重新生成、側欄搜尋。**生圖模型**：模型清單每一列可勾「生圖」（`imageModels`，`models` 的子集），選到它時請求帶 `modalities:['image','text']`，回來的 data URI 存進 `chat-images/`、訊息只記檔名
- 終端機：`@lydell/node-pty`（ConPTY，N-API prebuilt 不需 rebuild）＋ xterm.js；側欄多開，每個工作階段一顆獨立 shell，狀態顯示「運行中／已完成／已結束」，跑完但你不在看的那個亮未讀點。shell（pwsh／powershell／cmd）與啟動指令（純 shell／claude／codex）都是 main 的固定表，renderer 只送 key；工作目錄走系統對話框並在 main 驗證。metadata 存 `<userData>/terminals.json`（**不存畫面內容**）；側欄拖曳／Alt+↑↓ 排序與聊天共用 `renderer/scripts/list-reorder.js`
- 額度：Claude Code／Codex／Antigravity／OpenCode／Grok 五家；卡片與頂部橫條同走 `visibleAccounts()`（顯示設定關掉的兩邊都不出現）；訂閱方案顯示在 footer（`planName`，OpenCode 除外）；**只在手動同步時查詢**，啟動／進頁只讀 `<userData>/usage.json` 快取；Main-only 固定來源，renderer 不接觸憑證／URL／路徑／SQL
- AGY 反代：本機 HTTP 閘道（`src/main/agy/`），把 Antigravity 憑證轉成 OpenAI `/v1/chat/completions` 與 Anthropic `/v1/messages`；只綁 `127.0.0.1`、強制 Bearer／x-api-key、SQLite 流量日誌與統計；「測試連線」（`agy:test`）自動挑一個有額度的對話模型，從 loopback 送一則訊息驗證整條路
- ASR：local（`asr-select.js` 依 `asrModelKey` 分流 sherpa CPU／llama-server GPU）或 cloud（`cloud-asr.js` → `/audio/transcriptions`）
- 翻譯：cloud（走聊天供應商）／ local（node-llama-cpp）；本地可選 `linguaforge08q4`（LinguaForge Q4，預設）／`qwen35translate`（Qwen3.5 0.8B Q4）／`qwen354b`（Qwen3.5 4B Q4，建議 GPU）；`llmGpu`（NVIDIA≥6GB → cuda/vulkan）
- TTS：Edge TTS；`ttsVoices` + `ttsRate`（-50…100）；設定頁每個語音下拉旁有試聽鈕（`tts:preview`，唸 main 固定表的範例句）
- 翻譯頁輸入不限字數：renderer `splitForTranslate` 分 ≤600 字段落依序翻譯（main IPC 仍限單次 1500 字）
- 設定：最後一個 nav tab；左側分類 rail（**本地模型／雲端模型／語音朗讀／基本**）一次顯示一區 + 底部 sticky 儲存列。設定頁只管「裝了什麼、怎麼推論、雲端端點」；**要用哪一顆模型在功能頁標題旁的選單直接選**（`.model-chip`，不另佔一條橫排）。雲端模型只有兩塊：**供應商（聊天與翻譯共用）** 與 **語音轉文字**
- 本地 ASR 兩顆：`qwen3asr`（Qwen3-ASR 0.6B INT8，sherpa-onnx，**只有 CPU**，執行緒自動）／`qwen3asrgpu`（Qwen3-ASR 1.7B Q8_0，llama-server sidecar，Vulkan GPU，需搭 `llamaruntime`）。**沒有 CPU/GPU 開關**：選了模型就決定了推論方式
- nav 順序：聊天（預設頁）｜終端機｜額度｜AGY反代｜語音轉文字｜翻譯與 TTS｜設定。「語音轉文字」是**頁內子分頁**（檔案轉錄／即時字幕），兩者共用標題旁的模型選單
- 常駐背景：關視窗預設不結束，縮到系統匣讓 AGY 反代續命（`closeToTray`，設定→基本可關）；開機自啟動走 `app.setLoginItemSettings`（真相在 OS，不進 store），登入時帶 `--hidden` 直接縮在匣裡。單一實例鎖是常駐的前提
- 主窗 frameless（標題列合併 header）；標題僅 VoiceInk。`whenReady` 立刻 `show: true` 建窗，不 await store；ASR／LLM／額度／AGY／CUDA 第一次用到才 require；非聊天分頁 dynamic import；ffmpeg 留 asar、第一次轉錄拷到 userData；CUDA／Vulkan addon 用到才從 asar 解開。字體用本機（Segoe UI／微軟正黑體），不拉 Google Fonts
- 視覺：Token Anxiety Aurora glass；深／淺兩主題共用 12px surface、blur 與冷藍／暖金光暈；RWD 斷點 900／640px
- 模型 registry：`src/main/models.js`；下載至 `%APPDATA%/voiceink/models/`。`archive: true` 的項目（llama.cpp 執行環境）下載後用 PowerShell `Expand-Archive` 解開，已安裝與否看 `check` 清單不看下載檔名

## 指令

```bash
npm run electron:dev     # 開發（vite + electron）
npm run electron:pack    # 免安裝快速預覽 → dist/win-unpacked/VoiceInk.exe（任務結束必跑）
npm run electron:build   # 完整打包：NSIS 安裝檔 + win-unpacked → dist/
npm start                # 注意：未打包時 isDev=true，會連 localhost:5173，需先開 vite
```

打包前先關掉開著的 `dist/win-unpacked/VoiceInk.exe`（`Stop-Process -Name VoiceInk -Force`），
否則 electron-builder 會卡 `d3dcompiler_47.dll: Access is denied`。
使用者同時操作電腦時，桌面 QA 只能用 CDP／視窗 API 背景定位與操作；不可移動滑鼠、發全域快捷鍵或搶前景焦點。
發行：bump `package.json` 版本（不可與既有 tag 重複）→ commit → `git tag vX.Y.Z` → push → `electron:build` → `gh release create`。

## 慣例

- 檔名 kebab-case、變數 camelCase、常數 UPPER_SNAKE_CASE；ES2022、async/await、JSDoc
- Renderer 是 ESM（import/export）、Main/Preload 是 CJS
- 設定一律走 electron-store IPC（含 asrEngine／asrModelKey／asrApi*／ttsRate；translator 僅 cloud|local，asrModelKey 走 `models.isAsrKey()`）。`apiUrl`／`apiKey`／`modelId`（舊的獨立雲端翻譯設定）與 `asrThreads` 已移除，開機時一次性搬移／刪除
- 聊天會話**不走** `store:*`，走 `chat:*` IPC ＋ 獨立 electron-store 實例（`<userData>/chats.json`）
- AGY 設定（`agyEnabled`／`agyPort`／`agyApiKey`／`agyLogBodies`／`agyLogRetentionDays`）**刻意不進 `STORE_ALLOWLIST`**，只走 `agy:*` IPC；日誌在 `<userData>/agy-logs.db`
- 終端機同理：不走 `store:*`，只走 `terminal:*` IPC ＋ 獨立 electron-store 實例（`<userData>/terminals.json`）
- 本地 ASR 模型 key 走 `models.isAsrKey()`；雲端 ASR 不需下載
- Commit 格式 `<type>: <description>`，訊息用繁體中文
- **UI／功能改動完成後，先跑 `npm run electron:pack` 更新免安裝預覽**（`dist/win-unpacked/VoiceInk.exe`），方便使用者直接點開驗證；完整安裝檔（`electron:build`）僅在需要發佈時再打

## 地雷（改壞過的地方）

- sherpa-onnx-node 在 Windows 需先把 DLL 目錄加入 PATH 才能 require（`local-asr.js` 已處理，含 asar.unpacked 替換），不要動這段順序
- node-llama-cpp 是 ESM-only，main process 只能動態 `import()`；Qwen 系列要 `budgets: { thoughtTokens: 0 }` 關思考，否則譯文為空
- ASR 輸出要 strip `<sil>` 等 `<...>` 特殊 token；sherpa `decodeAsync` 的 JSON.parse 要 patch 防控制字元（見 local-asr `parseSherpaJson`）
- 翻譯 prompt 不可把前文塞進「【前文】【本段】」括號式模板——0.8B 模型會整段複誦；指令走 system prompt、前文走 chat history（本地 `setChatHistory`／雲端 messages）
- **LinguaForge 一律單輪**（system + 單一 user，不給前文 chat history）：多一輪對話會讓 greedy 直接複誦上一輪譯文，長文每段都吐同一句（`translateLocalOnce` 已擋，勿還原）
- 譯文清理集中在 `src/main/translate-clean.js`（純文字、無 electron 依賴）：persona 標籤／SFT 指令／引號／列點。**引號單側只在找不到配對時剝**（否則 `「引言」，某某說` 會變孤兒 」）；列點需帶原文判斷，勿在 local-llm 內另寫一份
- LinguaForge 長文**逐行翻譯**，行首清單標記（`· ` `- ` `1. `）剝掉再送、翻完貼回：跨段合併會退化成重複迴圈、連符號一起送會被翻成「選擇器：」（`splitLinesForLinguaforge`）
- zhtw 禁 rep-penalty 的代價是偶發重複迴圈 → `findRepetitionLoop` 偵測後開 rep-penalty 重跑該段；**重試前必須 `setChatHistory(history)` 還原**，否則第二輪帶著上一輪＝複誦
- `s2twp` 只在文字真的含簡體時才套詞彙表（純字形 `tw` 探測）：OpenCC `twp` 會把已正確的「參數」竄改成「引數」
- 即時字幕音訊走 `AudioContext({sampleRate:16000})` + `ScriptProcessorNode` 直取 PCM，再由 `vad.js` 依停頓切句；勿改回 MediaRecorder（會多一輪 opus 編解碼、固定切句且 stop/restart 邊界丟音）
- VAD：128ms frame、250ms pre-roll、360ms hangover、0.5–6s 語句界；ASR 忙時最多保留 2 句、丟最舊未處理句防延遲無限累積。驗證：`node scripts/test-vad.js` + `npx electron scripts/e2e-live-pipeline.js` + `node scripts/e2e-live-cdp.js`
- 字幕視窗 `transparent: false` 是刻意設計：Windows 上透明視窗會白條殘留＋resizable 失效；字幕以 `createElement` 增量更新，只有使用者原本在底部才自動捲底
- CSP `connect-src 'self' https: http:` 是自訂 API URL 的前提，不要改回白名單
- 打包需保留 `asar.smartUnpack: false`（否則 electron-builder 會自動解開所有 `.exe`／`.node`），以及 `asarUnpack`（sherpa-onnx*、`@node-llama-cpp/win-x64`、`@reflink`、Antigravity `.ps1`）。ffmpeg／CUDA／Vulkan 留 asar，第一次用拷到 `%APPDATA%/voiceink/`（**不可寫進安裝目錄 asar.unpacked**）
- **`mergeExpectedWindows` 只能由 `usage/index.js` 呼叫，`syncAntigravity` 不准先補一輪**：補視窗需要「上一次的快取」才做得對，而只有 `mergeAccountState` 拿得到 previous。在 `syncAntigravity` 裡先用 `previous=null` 補完，index 那層會看到四個 id 都存在 → 撿不回快取的真實值，也偵測不到有視窗是補的而把 accuracy 降成 `estimated`，結果是**憑空的「100% 已用盡」被標成「官方 API · 已讀取真實額度」**。同步只回上游真的給的視窗。**空窗（API 失敗）也不可 merge**：`windows.length === 0` 時走 6h soft cache，沒快取就維持空，否則 connected 失敗一樣會合成四條 100%。回歸：`test-usage.js`「同步只回上游真的給的視窗」＋「API 失敗且無快取時不合成 100% 假額度」
- **`chat.send` 的 inflight 佔位必須跟守衛同一個同步區塊**：`if (inflight) return` 是同步檢查，指派若排在 `await`（讀對話／存圖片／寫使用者訊息）之後，兩個併發請求會一起通過守衛——兩條串流、兩則使用者訊息連著落盤，先開的那條被後者覆蓋，「停止」再也 abort 不掉，逾時計時器還會去改別人的 `reason`。回歸測試：`e2e-chat.js` 的「無 inflight 時同 tick 併發」
- **重新生成在上游成功前不得 `dropTrailingAssistant`**：先砍舊助理再 fetch，500／尚未吐字就停止會讓上一則回覆消失。記憶體裡剝掉尾端 assistant 去打 API，確定有新內容（或 partial）才落盤替換。`chats.json` 的 read-modify-write 一律走 `withStore`；`saveMany` 到 `appendMessage` 之間的新圖要 `chatImages.hold`，以免並行刪對話的 prune 把還沒入 json 的檔刪掉
- **AGY 每一個端點的錯誤都要走 `statusFor`**：`count_tokens` 原本自己寫 `error.status >= 400 ? error.status : 502`，等於把上游 401／403 原樣透傳，而 Claude Code CLI 正是靠它估上下文，會誤判成自己的 API key 壞了。回歸測試：`e2e-agy.js` 的「count_tokens 上游 401 → 502」
- Antigravity 的 PowerShell 是外部程序，不能執行 `app.asar` 內檔案：`read-windows-credential.ps1` 必須 unpack，路徑經 `resolveCredentialScriptPath` 換成 `app.asar.unpacked`；未連線時不可用 `mergeExpectedWindows` 合成四條 100% 假額度
- OpenCode 固定用 Electron 內建 `node:sqlite` 的 `readOnly:true`／`allowExtension:false` 與參數化固定 SQL；不要改回 native dependency，也不可讓 renderer 傳 DB path／SQL
- **所有雲端路徑**（額度／聊天／雲端 ASR／雲端翻譯／AGY）的 HTTP 錯誤只記安全狀態摘要，**禁止把 response body／token／外部 error message 寫進 console、diagnostics 或 IPC**。`cloud-asr` 曾把 200 字 body、`local-llm` 曾把 `data.error.message` 與 120 字 preview 直接顯示給使用者——閘道把請求原樣回音時（含 `Authorization`）等於在 UI 上印出自己的金鑰，而 API URL 是使用者自填的，回什麼字串由對方決定。訊息只留狀態碼＋我們自己寫的下一步。回歸測試：`test-error-hygiene.js`
- **`subtitleWindowBounds` 寫入與讀取兩邊都要過 `sanitizeSubtitleBounds`**：它是 allowlist 裡唯一直接餵進 `new BrowserWindow()` 的值，來源同時有 renderer 的 `store:set` 和使用者可手改的設定檔。NaN／字串會讓 Electron 建出看不見的視窗，而且 `isBoundsOnScreen` 的算術也會全部變 NaN。x／y 刻意不夾（多螢幕負座標是合法的），交給 `isBoundsOnScreen` 判斷
- 翻譯分段：通用 ≤600 字（`contextSize: 2048`）；**LinguaForge 用 ≤280**（出貨 INTEGRATION 建議）；main `MAX_TRANSLATE_CHARS`（1500）是 IPC 信任邊界，不要拿掉
- **Qwen3.5 的 generation prompt 必須以空 think 區塊收尾**：`<|im_start|>assistant\n<think>\n\n</think>\n\n`（token 248068,271,248069,271）。node-llama-cpp 自動解析的 Qwen wrapper **不補**這 4 個 token，模型立刻掉出分布（憑空「說明：／問：／選擇：」前綴、拉丁專名整個消失、年份幻覺）。修法是 session 帶 `new QwenChatWrapper({ thoughts: 'discourage' })`（`local-llm.newQwen35ChatWrapper`），實測與 transformers `apply_chat_template` 逐字元相同；`budgets.thoughtTokens:0` 只擋「生成 thinking」，兩件事都要做。驗證：`node scripts/probe-prompt-path.js`
- LinguaForge 只出貨 **Q4_K_M**（`linguaforge08q4`，505MB）；Q8 版（`linguaforge08`）已下架。判斷一律用 `local-llm.isLinguaforge(key)`，勿寫 `key === '...'`——之後再加量化才不用到處改。舊使用者存的 `linguaforge08` 由 `main.js` 的 `RETIRED_MODEL_KEYS` 讀成 Q4
- LinguaForge GGUF：**zhtw 必須 `repeatPenalty: false`**（node-llama 省略時預設 1.1 會攪繁簡）；en/ja rep=1.1；dry≈nrng4；雙 EOS／關 thinking；勿改 system prompt
- **不要用 regex 剝掉「說明：」「問：」「1. 」這類前綴當修復**：那是止血，代表 prompt 錯了；同時發生的專名消失／年份幻覺 regex 抓不到（現行 `translate-clean` 白名單是最後一層保險，不是主修）
- **`await` 一個 `requestAnimationFrame` 一定要配逾時**：視窗被別的視窗遮住或縮到系統匣時 rAF 根本不觸發，`transcribe.js` 的 `waitForPaint()` 因此會永遠不 resolve，整條轉錄卡在「準備中… 1%」，`finally` 又把按鈕解鎖，看起來像沒反應（CDP 實測 `document.hidden` 為 true 時 3 秒內零回呼）。畫面平順是加分，卡住使用者的工作不是——rAF 只能當「有就更好」，不能當流程的門檻
- 檔案轉錄走 main `file-transcribe.js`（ffmpeg 串流 16k mono → 28s 切段），勿改回 renderer 整檔 `decodeAudioData`（長檔 OOM）
- 打包跑的是 `src/` 原始碼（`files` 排除 `dist/**`，main `loadFile('../renderer/...')` 載入 asar 內原始檔）；`vite build` 只作驗證，改 renderer 直接改 `src/`
- 字幕顯示模式（雙語/僅翻譯）由字幕彈窗獨佔（讀寫 store `captionDisplayMode`、單一 `currentMode` 渲染）；別再讓即時頁 payload 夾帶 `displayMode` 或加跨窗 IPC——兩端搶改同一狀態會打架
- 引擎 owner：`live|file|translate` 布林；翻譯頁 prewarm 同樣 gen 作廢；切頁先 acquire 再 release；TTS IPC 只收 lang、回 Uint8Array（禁 base64／禁 AGPL 套件）
- **離開翻譯頁必須作廢 `_translateRequestId`**：cooldown 若只 release owner，分段迴圈下一輪 `translate` IPC 會把已卸載的 LLM 幽靈重載。`refreshUiState` 在 `isTranslating` 時不得把「停止」設 `disabled`（prewarm 的 finally 會重跑它）
- 檔案轉錄的 ffmpeg pause 看「已排隊未 ASR 段數」而不是 pending bytes：stdout data 把 pending 一次抽進無界 chain 後再 pause，等於沒反壓。Duration N/A 時用 `samplesDone`／片段數套 `MAX_DURATION_SEC`
- AGY 上游非 2xx 要 `discardResponse`（`body.cancel`）：401 重試與 429 換端點若不消耗 body，undici 連線會卡到 GC
- ASR 必須 `withAsrLock` + `loadEnabled`：unload 等 in-flight、禁止 stop 後幽靈重載；transcribe 有 samples 長度／sampleRate 驗證
- store key 僅 allowlist；`models.openFolder` 僅 registry key 或根目錄
- 兩窗 `sandbox: true`；displayMedia handler 失敗也要 `callback({})`
- **聊天的 model 與訊息歷史所有權在 main**：renderer 只送 `{reqId, conversationId, text, images?, regenerate?}`，model 讀 `chatModelId`（必須 ∈ `chatModels`）、system prompt 讀 `chatPrompts`+`chatPromptId`、歷史由 `chat-store` 讀寫、上下文 ≤24000 字由 main 裁切。別為了方便把 messages 陣列或 model 搬回 renderer 傳——那等於把信任邊界拆掉
- **聊天模型必須對「目前這組供應商」驗證**：`chat.readConfig()` 先取 `chatProviderId` 對應的供應商，再檢查 `chatModelId ∈ provider.models`。只檢查「在不在任何清單裡」的話，切到 B 之後還能拿 A 的模型名去打 B 的端點
- **模型掃描的 IPC 收 providerId、不收 URL**（`chat:scanModels`）：網址與金鑰一律由 main 從 store 取。讓 renderer 指定網址等於把 App 變成「幫你打任意網址」的代理。副作用是掃描前會先把草稿寫進 store，UI 提示已寫明
- **`chatProviders` 的 sanitize 遇到壞網址要保留該筆、只清空 `apiUrl`**：這個函式同時跑在 store:set 的存檔路徑上，整筆丟掉等於使用者打錯一個字就把 API Key 與整份模型清單刪了
- **`agy/catalog.js` 才是模型清單的權威來源**，`model-map.js` 只負責翻譯「上游沒有的名字」。上游 `fetchAvailableModels` 回的 `models` 是**以 model id 為 key 的物件**，用 `Array.isArray` 判斷會靜默拿到空清單。可用模型排序：Claude 池（含 GPT OSS）在前、Gemini 在後；世代由新到舊（`3.10` > `3.2` > `3`），Gemini 同代再依思考強度 high → medium → tiered → low → extra-low → lite，`pro-agent` 沒有世代號排最後
- **映射表不可覆蓋真實存在的上游 id**：`gemini-3-flash` 上游真的有，使用者指名它就該用它。表裡只放上游查無此名的（`claude-sonnet-4-5-20250929`、`gpt-4o` 這種）
- **`REJECTS_ZERO_BUDGET` 是實測名單，而且上游的錯誤訊息不只一種**：`gemini-pro-agent`／`3.1-pro-low` 回 `Budget 0 is invalid...`，但 `gemini-3.6-flash-*`／`gpt-oss-120b-medium` 回 `Request contains an invalid argument`——後者看起來像整個請求壞掉，很容易誤判成模型不可用（實測踩過）。名單維護跑 `scripts/probe-agy-upstream.js`
- **反代的 `/v1/models` 用即時型錄，但空清單要退回靜態表**：客戶端拿它填模型下拉，回空的等於下拉整個沒東西，比給舊清單更糟
- **設定表單裡的空列 placeholder 不可複誦預設值**：模型清單的空列原本用 `DEFAULT_CHAT_MODEL` 當 placeholder，新增出來的列跟上一列文字一字不差、只差灰色，看起來像壞掉的重複項
- **本地 GPU ASR 只能走 llama-server sidecar**：npm 的 `sherpa-onnx-win-x64` 是 CPU-only 編譯，provider 傳 `cuda`／`directml` 只會印 `Please compile with -DSHERPA_ONNX_ENABLE_GPU=ON ... Fallback to cpu!` 然後靜默退回 CPU（實測過）；`node-llama-cpp@3.20` 也沒有 multimodal／audio API。所以 `qwen3asrgpu` 走 `llama-asr.js` 開一個 `llama-server.exe` 子程序（Vulkan 版 34MB，自帶 CPU backend，不需 CUDA／cuDNN），它本身就是 OpenAI 相容端點。**不要在 sherpa 那顆旁邊加假的 GPU 切換鈕**
- **llama-server 一定要帶 `--device <裝置>`，只給 `--gpu-layers 99` 不夠**：b10666 實測機器上明明有 Vulkan 裝置，不指定 `--device` 就整包跑 CPU——prompt eval 7.4 tok/s，指定後 720 tok/s（**快 97 倍**），而且兩次都不印任何錯誤，只有比對 tok/s 才看得出來。`llama-asr.detectDevice()` 跑一次 `--list-devices` 挑第一個非 CPU 的
- **Qwen3-ASR 經 llama-server 回來會夾 `language English<asr_text>` 前綴**（llama.cpp issue #26749，上游還沒修），要用 `stripAsrTags` 剝掉。另外它中文一律吐簡體，`shouldS2twpSource`＋`s2twp` 兩支本地 ASR 都要套（判斷函式放在 `opencc.js` 共用，勿各寫一份）
- **`asr-select.js` 是本地 ASR 唯一的選擇點**：`engine.js`／`file-transcribe.js`／`main.js` 三處都只認它，`transcribe()` 只往下傳 samples／sampleRate／lang，renderer 給的 `modelKey` 一律不採用。`engine.js` 必須有 `setStore` 並轉給 `asr-select`——`engine.acquire` 可能比任何 `localAsr:*` IPC 更早發生（進頁就 prewarm），沒轉的話它讀不到 `asrModelKey`，使用者選了 GPU 模型也會 warm 成 CPU 那顆
- **`llama-asr.unload()` 要真的把子程序收掉**：那是一顆獨立的 186MB+ 程序，`before-quit` 少收就留在工作管理員裡。engine 沒被載過但 ASR 被直接叫過的情況也要涵蓋（`main.js` 的 `before-quit` 兩條分支）
- **聊天側欄順序＝`chats.json` 的陣列順序**：`list()` 不再依 `updatedAt` 重排，否則使用者拖好的順序會在下一次回訊息時被洗掉。`writeAll` 超過上限時仍砍 `updatedAt` 最舊的，但只能 `filter` 掉、**不可以把排序後的陣列直接落盤**
- **聊天頁上方沒有工具列**：改名／刪除在側欄每一列（hover 才顯示的兩顆 icon 鈕），系統提示與模型選單在輸入框那一排。刪除**不用 `window.confirm`**：原生彈窗會擋住整個 App、樣式也跟 Aurora 完全不搭，改成按鈕就地變紅勾的二次確認（3 秒逾時復原，`renderList` 重畫前要先 `disarmDelete` 收計時器）
- **聊天圖片不進 chats.json**：electron-store 是整檔讀寫，塞 base64 會讓每次 append 都重寫數 MB。訊息只存檔名，實體放 `<userData>/chat-images/`；檔名由 main 產生並走 allowlist 驗證（`chat-images.isValidName`），renderer 給的字串一律不當路徑用
- 只送最近 6 則訊息的圖片進 API（`IMAGE_CONTEXT_MESSAGES`）：長對話每輪重傳全部圖片會爆 token。**而且只送 user 的圖**——生圖模型自己吐的圖若塞回 assistant 訊息的 content 陣列，嚴格一點的端點會直接 400（assistant 只收字串）
- **生圖時 SSE buffer 要放大**（`MAX_SSE_BUFFER_IMAGE`，24MB）：一張 1024px PNG 的 base64 是好幾 MB，而且整張圖就在**同一行** `data:` 裡，沿用 512KB 會在收到第一張圖時把串流砍掉——症狀是「文字有、圖沒有」，看起來像模型沒生圖
- **生圖只收 `data:` URI**：讓 main 去下載上游回的 http URL 等於開一個 SSRF 跳板（跟 AGY 的圖片輸入同一條理由）
- **`imageModels` 要收斂成 `models` 的子集**：模型從清單刪掉後標記還留著，之後同名新增會莫名其妙變成生圖模型
- **雲端翻譯與聊天共用 `chatProviders`**：舊的 `apiUrl`／`apiKey`／`modelId` 在 `migrateTranslateProvider()` 一次性併進供應商清單（網址與金鑰都相同就沿用既有那組，不重複建），搬完刪掉舊 key。`chatProviders` 變動時**兩組選擇都要收斂**（`reconcileProviderSelection` 各跑一次），只收聊天那組的話翻譯會拿到已刪供應商的 id
- thinking 關閉時**完全不帶** `reasoning_effort`：舊端點看到不認得的參數會直接 400
- 極小圖（8×8 這種）Gemini 會回 `400 Unable to process input image`；composer 的 `shrinkImage` 產出 ≤1568px JPEG 是正常路徑，測試 fixture 也要用真實尺寸
- 聊天純雲端 → **不 acquire 引擎**，`engine.js` 的 owner 維持 `live|file|translate`，不要為聊天新增 owner
- `markdown.js` 全程 `createElement`＋`textContent`、**零 innerHTML**；連結只放行 http(s)/mailto。不要為了「支援更多語法」改用 marked/DOMPurify：renderer 無 bundler、CSP `script-src 'self'`、打包跑 `src/` 原碼，vendoring 才是負擔
- `markdown.js` 的 `INLINE_SRC` **每次呼叫都要 `new RegExp`**：`renderInline` 會遞迴，共用同一個 g-regex 會被子呼叫重置 `lastIndex` → 外層從頭再跑 → 無限迴圈 OOM
- 強調標記（`**` `*` `_` `~~`）內側**不得為空白**，否則 `2 * 3 * 4`、`a ** b` 會被吃成斜體；`_` 兩側另需 `(?<![\w_])` 才不會拆 `snake_case`
- 中斷串流時已收到的內容仍要存檔：累加器 `partial` 必須宣告在 `try` 之外（`chat.js`）
- 串流不可用 `AbortSignal.timeout`（會砍長連線）→ 首 token 60s ＋ 閒置 120s 雙計時器
- **AGY 頁的 Base URL 有兩組，不能只給一組**：OpenAI 相容客戶端要 `http://127.0.0.1:<port>/v1`（自己接 `/chat/completions`），Claude Code／CC Switch 要根位址（自己接 `/v1/messages`，帶 `/v1` 會變成 `/v1/v1/messages` → 404）。`status()` 同時回 `baseUrl` 與 `anthropicBaseUrl`，頁面上的「客戶端怎麼填？」把兩組分開列。回歸：`e2e-agy-cdp.js` 的「Anthropic 那組不帶 /v1」
- **統計的時間範圍是 main 的白名單**（`logs.STAT_RANGES`：6h／24h／7d／30d／all）：renderer 只送 key，小時數與分桶格式一律由 main 決定；未知值退回 24h。序列**必須補零**（`fillSeries`）——SQL 只回有資料的桶，直接畫等於把 3 小時的量攤成整條時間軸。summary／series／models 套同一個 cutoff，否則卡片講「全部時間」、圖表講「近 24 小時」
- **`.agy-model-row` 已被「可用模型」面板佔用**：統計的模型分佈列叫 `.agy-dist-row`。撞名時後面那份會整個蓋掉，症狀是分佈的進度條被壓成一列看不見（實際發生過）
- 額度卡固定 2 欄（≤900px 收 1 欄）、`align-items: start`＋`min-height: 250px`；標題是 provider accent 實心 pill，**不放 LOGO 方塊或方案副標**，卡內小字一律 12px／`--text-secondary`
- **訂閱方案的來源全在本機登入檔，不在額度 API**：Claude 讀 `.credentials.json` 的 `subscriptionType`（拿 `extra_usage.is_enabled` 猜會把 Pro 寫成「Pro / Max」）、Codex 讀 `auth.json` → `tokens.id_token` 的 `https://api.openai.com/auth` claim（新版沒有頂層 `plan_type`）、Grok 的 billing 回應沒有 `subscriptionTier`，只能退回 access token 的數字 `tier` claim。共用 `shared.readJwtClaims`（不驗簽：來源是本機檔案，只取標籤字串）。回歸測試：`test-usage.js` 的「訂閱方案取自本機憑證」
- 額度排序對齊 Token Anxiety：不用 HTML5 DnD、不引 dnd-kit。pointer 直拖；**跟手的是 `position:fixed` overlay**（opacity 0.98），格子裡 **鬼影預覽**（opacity 0.18）。拖曳中**不准 `appendChild`**，只把卡 `translate3d` 到開始時記住的槽位；碰撞打靜態槽位（pointerWithin → closestCenter），不要打動畫中的 getBoundingClientRect。放開才改 DOM 並存一次。監聽掛 `window`。Space／方向鍵／Enter／Esc 鍵盤排序，reduced motion 不播位移
- Aurora 視覺 token 集中在 `themes.css`，共用 surface／RWD 在 `main.css`；不要用 React、DnD 或動畫 dependency 取代原生 DOM／Web Animations
- **cloudcode-pa 的 SSE 每一格都包一層 `response` 信封**（`data: {"response":{"candidates":[…],"usageMetadata":{…}}}`），轉換前一定要 `unwrapEnvelope`；非串流則直接是本體
- **usage 的新舊格式要看欄位存不存在，不是看值**：舊格式 `candidatesTokenCount` 已含 thinking／tool；新格式 `total_output_tokens` 不含，要把 `total_thought_tokens`＋`total_tool_use_tokens` 加回去。判斷依據是「有沒有 `total_output_tokens` 這個 key」，寫成看數值就會在 0 的時候算錯（`agy/gemini.js` 單一實作，兩個協議共用，勿各寫一份）
- **「refresh 拿不到」不等於「token 過期」**：`tokenIsStale` 的 15 分鐘是「該去續期了」的提前量，不是「已經不能用了」。沒有 `ANTIGRAVITY_CLIENT_ID`／`SECRET` 時 refresh 一定回 null，若把它當成過期直接拋 `TOKEN_EXPIRED`，等於每個 access token 的**最後 15 分鐘都被自己作廢**（實測：憑證還有 7 分鐘壽命，AGY 頁卻回報過期）。`loadToken` 要在 refresh 失敗後檢查真實 expiry 再決定；唯一例外是 `mustRefresh`（上游回過 401 就代表這個 token 真的死了，本機 expiry 寫什麼都不算數）
- **常駐背景要連帶做三件事，少一件就會出事**：① `requestSingleInstanceLock()`——視窗藏起來後再點一次捷徑，第二份會用同一個埠 autoStart 反代（EADDRINUSE）並跟第一份搶 `chats.json`／`usage.json`／`agy-logs.db`；② 沒搶到鎖的那份要用 **`app.quit()` 不是 `app.exit()`**，exit 立刻砍掉自己會來不及把「我來過了」送到第一份，症狀是叫不出視窗（實測時好時壞）；③ `whenReady` 也要 `if (!hasInstanceLock) return`，否則輸的那份在退出前還是會建窗＋autoStart。另外 `close` 的攔截**必須放行 `isQuitting`**，不然 `app.quit()` 會被自己擋住、永遠關不掉
- **`document.hidden` 同時代表「被完全遮住」，不只是「視窗藏起來」**：CDP 測試從背景程序 spawn 第二份時，Windows 常不給前景權，`show()` 之後馬上又被別的視窗遮回去（`visibilitychange` 記到 `visible → hidden`）。斷言要看「有沒有 visible 過」，不是「最後停在 visible」，否則測試三次會壞一次。反過來這個特性很好用：縮到系統匣時 `document.hidden` 為 true，AGY 頁的 5 秒輪詢靠它自己停（那條會開 PowerShell 讀 Credential Manager，常駐後不擋就是開著整天）
- **代跑 CLI 一定要用 `spawn` 且 `stdio: 'ignore'`，不能用 `execFile`**：`execFile` 會把三個 stdio 都接成 pipe，而且**不會把 stdin 那條關掉**——`agy.exe` 拿到一條開著、永遠收不到 EOF 的管線就卡在那裡等輸入。症狀是使用者的請求卡滿整個逾時才回 `TOKEN_EXPIRED`，而同一支指令從主控台跑只要 2～3 秒（實測過：自動續期上線後看似有做，其實每次都在等逾時）。實測矩陣 `node_modules/electron/dist/electron.exe scripts/probe-agy-nudge.js`：execFile 逾時／spawn+stdin 繼承 2.1s／spawn+stdin ignore 2.8s／**spawn+stdin pipe（不寫也不關）逾時**。回歸測試：`e2e-agy.js` 的「代跑 CLI 的 stdin 是 ignore」
- **token 續期靠代跑 Antigravity CLI，不是靠我們自己 refresh**（`credential.nudgeCli`）：access token 只有 1 小時，而我們沒有 client id／secret（那是 IDE 的憑證，不該進原始碼）→ `refreshAccessToken` 永遠回空字串。以前使用者得手動再跑一次 `agy` 指令才會續上，症狀是「接好幾分鐘就斷線」。修法是由我們代跑 `agy.exe models`（最便宜的連上游子指令，約 2 秒）：CLI 帶著自己的 OAuth 憑證，續期後會寫回同一個 Credential Manager 項目，我們重讀就好。兩條路徑：**還沒過期但已 stale → 背景跑、這次照回舊 token**（不擋使用者）；**真的過期或 401 → 等 CLI 跑完再重讀憑證**。重讀後**必須確認 access token 真的換了**，否則等於把同一顆死 token 再送一次。冷卻 60 秒＋`nudgeInFlight` 合併：token 尾聲每個請求都會走到這裡，沒冷卻會連開一堆 `agy.exe`。逾時 30 秒（正常 2～3 秒，這只是防它真的卡住）。回歸測試：`e2e-agy.js` 的「token 過期時自動跑一次 CLI 續期」「連續請求不會連開一堆 agy.exe」
- **`agy:*` IPC 的錯誤訊息走 `userMessage` 白名單**：只有我們自己建構、內容固定的錯誤（`CredentialError`）會帶這個欄位，才准原樣送到 renderer；`UpstreamError` 沒有，一律變成「反向代理操作失敗」。不要改成「有 message 就送」——上游 body 可能夾在 message 裡
- **憑證指引不能只綁在「服務執行中」**：`index.js status()` 停止中刻意不做 `credential.acquire`（那會開 PowerShell 讀 Credential Manager，5 秒一輪的輪詢付不起），但「可用模型」不需要服務跑著也能查。憑證壞掉時若只丟一句失敗訊息，整頁不會有任何下一步——`loadModels` 失敗要自己把 `#agyCredentialHelp` 叫出來，並用 `credentialHint` 讓它撐過下一輪 `renderStatus`。`status()` 停止中仍回 `sources`（只做 fs 檢查，很便宜），指引才知道該講 CLI 還是 IDE
- **上游 401 之後必須強制 refresh**：`credential.invalidateToken()` 要連帶設 `mustRefresh`。只清記憶體快取的話，下一輪會看本機憑證檔的 `expiry` 還沒到就把同一個死 token 再送一次，等於沒重試
- **反過來，`mustRefresh` 只有 401 能設**：`acquire` 失敗後的清快取**不可以**呼叫 `invalidateToken()`。任何一次暫時性失敗（PowerShell 讀憑證逾時、`loadCodeAssist` 網路抖動）都會把旗標設起來，之後每一輪強制 refresh，而沒有 client id／secret 時 refresh 一定回 null → 一律拋 `TOKEN_EXPIRED`。症狀是「CLI 明明登入著、憑證也沒過期，AGY 頁永遠紅字卡住，重登 CLI 也沒用，只有重開 App 才好」。失敗只清 `cache.token`／`cache.expiresAt`。回歸測試：`e2e-agy.js` 的「暫時性失敗不設 mustRefresh」
- **`main.js` 的 `registerAgyIpc({ service })` 是逐一列舉的白名單**：`src/main/agy/index.js` 新增一個對外方法，這裡沒補一行，IPC 就是 `service.selfTest is not a function` → renderer 只看到通用的「反向代理操作失敗」，完全查不出原因（`agy.test` 上線時踩過）。`registerUsageIpc` 同理
- **上游狀態碼不要透傳給客戶端**：只有 429（含 `retry-after`）原樣回，其餘一律收斂成 502。直接把上游的 401／403 丟回去，客戶端會誤判成自己的 API key 有問題
- AGY 的圖片輸入**只收 `data:` URI**：讓反代去下載客戶端指定的 http URL 等於開一個 SSRF 跳板
- 送上游的 function schema 走**白名單**（`sanitizeSchema`）：客戶端／MCP 給的完整 JSON Schema 帶 `$schema`／`additionalProperties`／`oneOf`，原樣轉送會直接 400 INVALID_ARGUMENT。白名單擋不住「欄位名對、型別不對」的三種寫法，**全都會讓整包請求 400、所有工具一起陣亡**（接 Claude Code 帶 195 個 MCP 工具時實測踩到）：① `type: ['string','null']` → proto 的 type 不是 repeating，要收斂成單一型別＋`nullable`；② `{type:'boolean', enum:[true]}`（anyOf 判別欄位）→ Gemini 的 enum 只吃 `type:'string'` 的字串陣列，其餘一律剝掉；③ `anyOf:[X, {type:'null'}]` → 沒有 null 型別，null 那支要換成 `nullable`（只剩一支就攤平）。回歸測試：`test-agy-mappers.js` 三條「type 陣列／非字串 enum／anyOf null 變體」
- Anthropic 歷史訊息裡的 `thinking` block **不回送上游**（沒有原始 signature 會被拒）；`tool_result` 要靠先前 `tool_use` 的 id→name 對照補上 `functionResponse.name`
- AGY server 檢查 `Host` 必須是 127.0.0.1／localhost（擋 DNS rebinding）；`/health` 刻意不需鑑權，客戶端與頁面都靠它探測
- `before-quit` 要呼叫 `agy.shutdown()` 而不是 `stop()`：`stop()` 會把 `agyEnabled` 寫成 false，下次啟動就不自動接續了
- `agy/logs.js` 的 `node:sqlite` 是同步 API，**每個操作都要能失敗**：Windows 防毒會鎖 db 檔，寫不進日誌絕不能連帶讓使用者的請求失敗
- **AGY 上游端點順序是 sandbox → daily → prod，不是只打 prod**：同一組憑證同一個請求，prod 回 429 RESOURCE_EXHAUSTED、sandbox 回 200。可重試狀態（0/403/429/5xx）才往下換端點，400/401 換網域也沒用
- **不要送 `x-goog-user-project`**：`loadCodeAssist` 回的 project 沒啟用 Cloud Code Private API，帶上去每個端點都回 403 SERVICE_DISABLED；project 放 body 就正常
- **`countTokens` 的信封跟另外兩個端點不一樣**：只吃 `{ request }`，多送 `project`／`model`／`userAgent` 會回 400 Unknown name（`model` 要塞進 `request` 裡）
- **`thinkingBudget: 0` 不能無條件送**：`gemini-pro-agent`／`gemini-3.1-pro-low` 只能在思考模式運作，收到 budget 0 回 400 Budget 0 is invalid。名單在 `model-map.js` 的 `THINKING_ONLY_MODELS`，**是實測出來的**——`claude-opus-4-6-thinking` 名字有 thinking 但接受 budget 0，別靠模型名猜。反過來也別為了省事一律不送：關思考能省 thinking token
- **映射表的每個目標都必須是實測可用的模型**：AGY 表裡的 `gemini-3-pro-preview`／`gemini-3.1-pro-preview`／`claude-sonnet-4-6-thinking` 在本機帳號回 404，`gemini-3-pro-low` 回 500。`DEFAULT_MODEL` 尤其致命（未知模型的退路，指到 404 等於全掛）。`test-agy-mappers.js` 有一條「映射目標都在實測可用清單內」擋這件事
- **憑證由 Antigravity CLI（`agy.exe`）或 IDE 維護，VoiceInk 只讀不寫**：只裝 CLI 沒裝 IDE 完全可用。`TOKEN_EXPIRED` 多半只是 CLI 一陣子沒跑。`credential.detectSources()` **只認執行檔不認資料夾**——解除安裝會留下空的 `Programs\Antigravity`，看目錄存在與否會誤判成已安裝
- **不做內建瀏覽器 OAuth 登入**：Antigravity-Manager 的三種加帳號方式（OAuth／貼 refresh token／匯入資料庫）全都需要 client_id + client_secret（貼 refresh token 也要，換 access token 得帶 client 憑證）。改為偵測不到憑證時顯示 `#agyCredentialHelp` 引導使用者裝官方 CLI
- **不要把 Antigravity 的 OAuth client secret 寫進原始碼**：那是 Antigravity IDE 的 public desktop client、不是我們的憑證，而且 `GOCSPX-` 會被 GitHub secret scanning 攔。要 refresh 就走 `ANTIGRAVITY_CLIENT_ID`／`SECRET` 環境變數；平常不必設，IDE 會自己維護 Credential Manager 裡的 token
- **終端機的忙碌判定不能只靠 OSC 133 標記**：PSReadLine 會在外部輸出時把整份提示字元（含標記）重送一次——實測 `ping -n 4` 的三秒內收到 9 次 `D;0`，只認「標記出現＝跑完了」會在指令還在跑的時候就顯示已完成。標記要帶 `Get-History` 的 id，而且**比大小、不是比「跟上次不同」**（捲動重播會送出更舊的 id）。另外**第一個看到的標記只是「現在這個提示字元」**，不能拿來下結論。反過來也不能只靠靜默：AI 代理 CLI 是常駐 REPL，跑起來之後 shell 那層到你離開前都看不到任何指令結束。兩者都要。回歸測試：`test-terminal.js` 的狀態機那一段
- **注入給 PowerShell 的 `-Command` 字串不可含雙引號**：它會變成單一 argv，Windows 的內嵌雙引號跳脫規則很容易出錯。要組字串就用單引號＋`+` 相接（`pty.js` 的 `PS_INTEGRATION`），`$ok = $?` 必須是第一句
- **`term.open()` 前要先讓那一格可見**：掛在 `display:none` 的容器上會開出 0×0 的終端機，第一段輸出（提示字元）就這樣消失，但之後的輸出又正常——看起來像 pty 沒起來，其實是量不到尺寸（`createPane` 先切 `is-active` 再 open）
- **`@lydell/node-pty-win32-x64` 必須 `asarUnpack`**：它帶著自己的 `conpty.dll` 與 `OpenConsole.exe`，asar 內的 .exe 是執行不了的。只有打包版測得出來（`e2e-terminal-cdp.js`）
- **終端機的 shell 與啟動指令只收 key**：執行檔路徑與指令字串都在 `terminal/store.js` 的固定表。讓 renderer 傳路徑等於把 App 變成「幫你執行任意程式」的跳板；工作目錄一律走 `terminal:pickDirectory` 的系統對話框，再由 main `statSync().isDirectory()` 驗過
- **`before-quit` 要 `terminal.killAll()`**：每個工作階段都是一顆真的 conhost，不砍就留在工作管理員裡
- **彈窗新增內容區時要自己補 `padding: 4px 24px 0`**：`.app-dialog` 本身 `padding:0`，24px 是 `.dialog-head`／`.dialog-actions` 各自寫的。`.term-new-body` 少了這行，欄位就比標題與按鈕列往左突一整截（實際出貨過）。另外 `.app-dialog` 的 760px 是給模型清單那種寬內容用的，三四個欄位的表單要自己收窄（`#termNewDialog` 460px）。回歸：`e2e-visual-cdp.js` 的 `dialog-align`
- **CDP 測試不可以用「第一列」或「總數」指涉自己建的東西**：使用者本來就有工作階段／對話時，`document.querySelector('.term-list-item')` 抓到的是別人的，`panes === 1` 這種絕對數也一定對不上——最糟的情況是**測試把使用者的資料刪掉**。一律用 `[data-id="<自己建的 id>"]` 指名，收尾也要把中途建立的每一個都刪掉（只清一個的話，測試中斷就會在使用者的側欄留垃圾）
- **CDP 收尾只能殺自己**：每支打包測試都要使用暫存 `--user-data-dir`，並只以 spawn 回傳的 `child.pid` 執行 `taskkill /PID /T`；禁止 `/IM VoiceInk.exe`，否則會把使用者安裝版一起關掉。暫存 SQLite 在 Windows 釋放較慢時，刪資料夾要有有限重試。
- **設定頁不放「用哪一顆模型」**：設定頁只管三件事——裝了什麼（模型清單）、怎麼推論（本地翻譯 CPU/GPU、CUDA 環境）、雲端端點。選用哪一顆在「語音轉文字」與「翻譯與 TTS」頁面**標題旁**的下拉選，選了立刻寫回 store（跟主題一樣即時套用）。選單是既有 key 的扁平視圖（`asrEngine`+`asrModelKey` ／ `translator`+`localTranslateModel`），**不要為它新增第三份狀態**；兩頁共用同一份設定，不是各記一份。**ASR 沒有 CPU/GPU 開關**：0.6B 只有 sherpa（CPU）、1.7B 只有 llama-server（GPU），選了模型就決定了推論方式，所以執行緒選項也一併移除（一律自動）。本地翻譯的 `llmGpu` 才是全域開關，哪一頁用到本地 LLM 都吃它
- **未安裝的本地模型仍要留在選單裡**，只是標「（未安裝）」＋提示去下載：整項消失的話使用者不知道有這個選擇。真的要跑之前（`transcribe.js`／`live-caption.js`）才擋，並且要一併檢查 `requires`（GPU 那顆缺 llama.cpp 執行環境時，錯誤要講執行環境而不是模型）
- **下拉清單由 `renderer/scripts/custom-select.js` 接手**：原始 `<select>` 保留作為資料來源與 `change` 事件目標，畫面用共用 ARIA listbox（模型／語言／供應商／TTS／終端機／篩選都一樣）。清單用 fixed portal；dialog 內要掛回 top layer，避免被 `overflow` 裁切。`optgroup` 只能用 `querySelectorAll('option')` 讀取；清單寬度至少容納最長選項且受視窗邊界限制。原生 `<option>` 仍要明寫不透明的 `--surface-solid`＋`--text-primary`，作為資料層與後備呈現的對比保證。回歸：`e2e-visual-cdp.js` 的 `custom-dropdown`／`model-dropdown`／`dialog-dropdown`／`option-contrast`
- **`.subtab-panel` 的顯示只由 `.active` 控制**：不要對 `#stt-live` 之類的子分頁容器裸寫 `display: flex`，那會蓋掉 `display: none` 讓兩個子分頁疊在一起（`#page-live` 以前就踩過同一個坑，註解還留著）。要置中改內容自己的 `margin: 0 auto`
- **新增 nav 分頁時，四個 CDP 腳本裡寫死的頁面清單都要同步更新**：`e2e-cdp-smoke.js`、`e2e-usage-cdp.js`、`e2e-agy-cdp.js` 的 `EXPECTED_ORDER`、`e2e-visual-cdp.js` 的 `PAGES` 與 `SIGNATURES`（後者的 signature 必須是 12px radius＋blur 的頂層 glass 面板，純佈局容器會被判失敗）

## 驗證方式

- AGY 續期：`node_modules/electron/dist/electron.exe scripts/probe-agy-nudge.js` —— execFile／spawn × stdin 各種組合的實測矩陣，外加走真正 `credential.acquire` 的計時。**動 `runAgyCli` 前先跑**
- AGY 反代（真實上游）：`npx electron scripts/probe-agy-upstream.js` —— 模型 × 端點可用性矩陣＋`THINKING_ONLY_MODELS` 自我校驗。**動映射表或端點順序前先跑**
- AGY 反代：`node scripts/test-agy-mappers.js`（雙向轉換／SSE 信封／usage 新舊格式／schema 清理／模型映射）＋ `npx electron scripts/e2e-agy.js`（mock cloudcode-pa：串流拼接、401 換 token 重試、鑑權、Host 檢查、429 retry-after、日誌落盤與統計、錯誤不外洩上游 body）＋ `node scripts/e2e-agy-cdp.js`（打包版啟停／金鑰遮罩／日誌表／篩選／RWD／「測試連線」真的打一次上游；跑完會還原使用者原本的埠與開關）
- 終端機：`node scripts/test-terminal.js`（狀態機：提示字元重繪／捲動重播的舊 id／空白 Enter／無 shell integration 時的靜默退路；shell・preset・cwd 白名單；terminals.json 正規化）＋ `npx electron scripts/e2e-terminal.js`（真 ConPTY：跑 `ping` 三秒一路是運行中、離開碼 0／1、快照與 seq、kill）＋ `node scripts/e2e-terminal-cdp.js`（打包版：xterm 掛載、狀態徽章、未讀點、改名／二次確認刪除、RWD；跑完會刪掉自己建立的工作階段）
- 額度：`node scripts/test-usage.js`（合約／bounded I/O／五 provider fixture／唯讀 SQLite／快取／IPC／打包路徑／訂閱方案取自本機憑證）＋ `npx electron scripts/e2e-usage.js`（本機五家真實來源、憑證不外洩）＋ `node scripts/e2e-usage-cdp.js`（打包版手動同步／設定／排序／診斷／主題／RWD／頂部橫條跟隨顯示設定）
- 聊天：`node scripts/e2e-chat-cdp.js`（打包版：多供應商增刪改、生圖標記、草稿保留、模型掃描彈窗、不寫入真實設定）＋ `node scripts/test-markdown.js`（渲染器 + XSS，node 直跑；用 vm 載入 ESM 並以會丟例外的 innerHTML setter 當斷言）＋ `npx electron scripts/e2e-chat.js`（mock SSE server：串流拼接／中斷存檔／上下文裁切／model allowlist／上限淘汰／錯誤不外洩 body／提示 preset／圖片附件與回收／thinking 分流／重新生成／生圖 modalities 與存檔／翻譯共用供應商）
- LinguaForge 解碼改動：`node scripts/probe-prompt-path.js`（prompt 逐字元／token id）＋ `node scripts/verify-chat-wrapper-fix.js`（30 句修前後對照與門檻；樣本在 `scripts/bench-cases.js`）
- 本地 ASR（CPU）執行緒：`npx electron scripts/e2e-asr-threads.js`（Edge TTS 合成一句 → ffmpeg 轉 16k → 送回 ASR 比對，順便量不同 threads 的耗時）
- 本地 ASR（GPU）：`npx electron scripts/e2e-llama-asr.js`（`stripAsrTags`／模組選擇／archive registry 判定，外加真的把 llama-server 拉起來、送一段 TTS 音訊回來比對、確認程序收得掉；沒裝執行環境或模型就只跑純函式那幾條）
- 語音轉文字合併頁／設定四分區／語音試聽：`node scripts/e2e-stt-cdp.js`（打包版：子分頁切換、模型選單寫回 store、兩頁共用同一份設定、未安裝標記、試聽真的合成；跑完會還原使用者原本的四個 key）
- Main 模組直測：`npx electron <e2e腳本>`（參考 CONTEXT.md）；此模式 app 名為 `Electron`，找模型需先 `app.setPath('userData', join(app.getPath('appData'),'voiceink'))`
- UI 無頭驅動：打包版 `VoiceInk.exe --remote-debugging-port=<port>` + Node 22 內建 `WebSocket` 走 CDP（驗分頁結構、彈窗切換、預熱/冷卻、關窗訊號）
- 錯誤訊息衛生與輸入校驗：`node scripts/test-error-hygiene.js`（mock 上游回夾帶假 token 的 body → cloud-asr／雲端翻譯的訊息不得含之；`subtitleWindowBounds` 垃圾輸入；Anthropic errorStream 收 block；opencode 時間戳單位）
- 常駐背景／開機自啟動：`node scripts/e2e-tray-cdp.js`（打包版：關窗留背景、藏起來時 `/health` 仍通、單一實例、second-instance 叫回視窗、關掉開關就真的結束、開機自啟動寫入 OS 再讀回；跑完還原 `closeToTray`、自啟動與測試自己開起來的反代）
- 視覺／RWD：`node scripts/e2e-visual-cdp.js`（七頁 × dark/light × 1440/900/560、glass signature、水平 overflow、彈窗左右邊界對齊、reduced motion）＋ `node scripts/test-usage-reorder.js`（排序與 FLIP）
- 宣告完成前跑過實際轉錄（模型已在本機，見 models 資料夾）
