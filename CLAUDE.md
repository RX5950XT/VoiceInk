# CLAUDE.md

> VoiceInk 專案規範。接手前先讀 [CONTEXT.md](./CONTEXT.md)（現行架構與驗證紀錄）；開發規範細節見 [AGENTS.md](./AGENTS.md)，兩份文件需同步對齊。

## 專案

Windows Electron AI 工作台：聊天＋額度＋AGY 反代＋檔案轉錄＋即時字幕＋翻譯與 TTS。Vanilla JS + Vite，無前端框架。

- Core：Electron 43.4.1（固定版本）＋ Node.js 22

- 聊天：雲端 OpenAI 相容 `/chat/completions` + `stream:true`；設定與翻譯獨立。**多組供應商**（`chatProviders` 陣列＋`chatProviderId`＋`chatModelId`），每組帶自己的 url／key／模型清單，可向 `/models` 掃描
- 聊天進階：系統提示多組 preset（`chatPrompts`/`chatPromptId`，在輸入框那一排切換與管理）、thinking 開關（`chatThinking` → `reasoning_effort`）、圖片附件（存 `<userData>/chat-images/`）、訊息複製／重新生成、側欄搜尋
- 額度：Claude Code／Codex／Antigravity／OpenCode／Grok 五家；卡片與頂部橫條同走 `visibleAccounts()`（顯示設定關掉的兩邊都不出現）；訂閱方案顯示在 footer（`planName`，OpenCode 除外）；**只在手動同步時查詢**，啟動／進頁只讀 `<userData>/usage.json` 快取；Main-only 固定來源，renderer 不接觸憑證／URL／路徑／SQL
- AGY 反代：本機 HTTP 閘道（`src/main/agy/`），把 Antigravity 憑證轉成 OpenAI `/v1/chat/completions` 與 Anthropic `/v1/messages`；只綁 `127.0.0.1`、強制 Bearer／x-api-key、SQLite 流量日誌與統計；「測試連線」（`agy:test`）自動挑一個有額度的對話模型，從 loopback 送一則訊息驗證整條路
- ASR：local（sherpa Qwen3-ASR-0.6B）或 cloud（`cloud-asr.js` → `/audio/transcriptions`）
- 翻譯：cloud / local（node-llama-cpp）；本地可選 `linguaforge08`（Q8，預設）／`linguaforge08q4`（Q4）／`qwen35translate`；`llmGpu`（NVIDIA≥6GB → cuda/vulkan）
- TTS：Edge TTS；`ttsVoices` + `ttsRate`（-50…100）
- 翻譯頁輸入不限字數：renderer `splitForTranslate` 分 ≤600 字段落依序翻譯（main IPC 仍限單次 1500 字）
- 設定：最後一個 nav tab；左側分類 rail（模型／翻譯／聊天／語音轉文字／外觀／語音朗讀）一次顯示一區 + 底部 sticky 儲存列
- 本地 ASR 只有 CPU：`asrThreads`（0＝自動／2／4／8）；sherpa 官方 Windows 套件未編譯 GPU
- nav 順序：聊天（預設頁）｜額度｜AGY反代｜檔案轉錄｜即時字幕｜翻譯與 TTS｜設定
- 主窗 frameless（標題列合併 header）；標題僅 VoiceInk。`whenReady` 立刻 `show: true` 建窗，不 await store；ASR／LLM／額度／AGY／CUDA 第一次用到才 require；非聊天分頁 dynamic import；ffmpeg 留 asar、第一次轉錄拷到 userData；CUDA／Vulkan addon 用到才從 asar 解開。字體用本機（Segoe UI／微軟正黑體），不拉 Google Fonts
- 視覺：Token Anxiety Aurora glass；深／淺兩主題共用 12px surface、blur 與冷藍／暖金光暈；RWD 斷點 900／640px
- 模型 registry：`src/main/models.js`；下載至 `%APPDATA%/voiceink/models/`

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
- 設定一律走 electron-store IPC（含 asrEngine/asrApi* / ttsRate；translator 僅 cloud|local）
- 聊天會話**不走** `store:*`，走 `chat:*` IPC ＋ 獨立 electron-store 實例（`<userData>/chats.json`）
- AGY 設定（`agyEnabled`／`agyPort`／`agyApiKey`／`agyLogBodies`／`agyLogRetentionDays`）**刻意不進 `STORE_ALLOWLIST`**，只走 `agy:*` IPC；日誌在 `<userData>/agy-logs.db`
- 本地 ASR 模型 key 固定 `qwen3asr`；雲端 ASR 不需下載
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
- LinguaForge 有 **兩個量化 key**（`models.js`）：`linguaforge08`＝Q8_0（預設，774MB，專名保留 93.3%）／`linguaforge08q4`＝Q4_K_M（505MB、CPU 快約 2.2×，專名保留 80%，Kimi→金剛、Sol→索爾）。兩者共用整套 SFT 格式與 DECODE → 判斷一律用 `local-llm.isLinguaforge(key)`，勿寫 `key === 'linguaforge08'`
- LinguaForge GGUF：**zhtw 必須 `repeatPenalty: false`**（node-llama 省略時預設 1.1 會攪繁簡）；en/ja rep=1.1；dry≈nrng4；雙 EOS／關 thinking；勿改 system prompt
- **不要用 regex 剝掉「說明：」「問：」「1. 」這類前綴當修復**：那是止血，代表 prompt 錯了；同時發生的專名消失／年份幻覺 regex 抓不到（現行 `translate-clean` 白名單是最後一層保險，不是主修）
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
- **本地 ASR 不可能有 GPU 選項**：npm 的 `sherpa-onnx-win-x64` 是 CPU-only 編譯，provider 傳 `cuda`／`directml` 只會印 `Please compile with -DSHERPA_ONNX_ENABLE_GPU=ON ... Fallback to cpu!` 然後靜默退回 CPU（實測過）。不要加假的 GPU 切換鈕；要更快就用雲端 ASR
- **聊天側欄順序＝`chats.json` 的陣列順序**：`list()` 不再依 `updatedAt` 重排，否則使用者拖好的順序會在下一次回訊息時被洗掉。`writeAll` 超過上限時仍砍 `updatedAt` 最舊的，但只能 `filter` 掉、**不可以把排序後的陣列直接落盤**
- **聊天頁上方沒有工具列**：改名／刪除在側欄每一列（hover 才顯示的兩顆 icon 鈕），系統提示與模型選單在輸入框那一排。刪除**不用 `window.confirm`**：原生彈窗會擋住整個 App、樣式也跟 Aurora 完全不搭，改成按鈕就地變紅勾的二次確認（3 秒逾時復原，`renderList` 重畫前要先 `disarmDelete` 收計時器）
- **聊天圖片不進 chats.json**：electron-store 是整檔讀寫，塞 base64 會讓每次 append 都重寫數 MB。訊息只存檔名，實體放 `<userData>/chat-images/`；檔名由 main 產生並走 allowlist 驗證（`chat-images.isValidName`），renderer 給的字串一律不當路徑用
- 只送最近 6 則訊息的圖片進 API（`IMAGE_CONTEXT_MESSAGES`）：長對話每輪重傳全部圖片會爆 token
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
- **新增 nav 分頁時，三個 CDP 腳本裡寫死的頁面清單都要同步更新**：`e2e-cdp-smoke.js`、`e2e-usage-cdp.js` 的 `EXPECTED_ORDER`、`e2e-visual-cdp.js` 的 `PAGES` 與 `SIGNATURES`（後者的 signature 必須是 12px radius＋blur 的頂層 glass 面板，純佈局容器會被判失敗）

## 驗證方式

- AGY 反代（真實上游）：`npx electron scripts/probe-agy-upstream.js` —— 模型 × 端點可用性矩陣＋`THINKING_ONLY_MODELS` 自我校驗。**動映射表或端點順序前先跑**
- AGY 反代：`node scripts/test-agy-mappers.js`（雙向轉換／SSE 信封／usage 新舊格式／schema 清理／模型映射）＋ `npx electron scripts/e2e-agy.js`（mock cloudcode-pa：串流拼接、401 換 token 重試、鑑權、Host 檢查、429 retry-after、日誌落盤與統計、錯誤不外洩上游 body）＋ `node scripts/e2e-agy-cdp.js`（打包版啟停／金鑰遮罩／日誌表／篩選／RWD／「測試連線」真的打一次上游；跑完會還原使用者原本的埠與開關）
- 額度：`node scripts/test-usage.js`（合約／bounded I/O／五 provider fixture／唯讀 SQLite／快取／IPC／打包路徑／訂閱方案取自本機憑證）＋ `npx electron scripts/e2e-usage.js`（本機五家真實來源、憑證不外洩）＋ `node scripts/e2e-usage-cdp.js`（打包版手動同步／設定／排序／診斷／主題／RWD／頂部橫條跟隨顯示設定）
- 聊天：`node scripts/e2e-chat-cdp.js`（打包版：多供應商增刪改、草稿保留、模型掃描彈窗、不寫入真實設定）＋ `node scripts/test-markdown.js`（渲染器 + XSS，node 直跑；用 vm 載入 ESM 並以會丟例外的 innerHTML setter 當斷言）＋ `npx electron scripts/e2e-chat.js`（mock SSE server：串流拼接／中斷存檔／上下文裁切／model allowlist／上限淘汰／錯誤不外洩 body／提示 preset／圖片附件與回收／thinking 分流／重新生成）
- LinguaForge 解碼改動：`node scripts/probe-prompt-path.js`（prompt 逐字元／token id）＋ `node scripts/verify-chat-wrapper-fix.js`（30 句修前後對照與門檻；樣本在 `scripts/bench-cases.js`）
- 本地 ASR 執行緒：`npx electron scripts/e2e-asr-threads.js`（Edge TTS 合成一句 → ffmpeg 轉 16k → 送回 ASR 比對，順便量不同 threads 的耗時）
- Main 模組直測：`npx electron <e2e腳本>`（參考 CONTEXT.md）；此模式 app 名為 `Electron`，找模型需先 `app.setPath('userData', join(app.getPath('appData'),'voiceink'))`
- UI 無頭驅動：打包版 `VoiceInk.exe --remote-debugging-port=<port>` + Node 22 內建 `WebSocket` 走 CDP（驗分頁結構、彈窗切換、預熱/冷卻、關窗訊號）
- 錯誤訊息衛生與輸入校驗：`node scripts/test-error-hygiene.js`（mock 上游回夾帶假 token 的 body → cloud-asr／雲端翻譯的訊息不得含之；`subtitleWindowBounds` 垃圾輸入；Anthropic errorStream 收 block；opencode 時間戳單位）
- 視覺／RWD：`node scripts/e2e-visual-cdp.js`（六頁 × dark/light × 1440/900/560、glass signature、水平 overflow、reduced motion）＋ `node scripts/test-usage-reorder.js`（排序與 FLIP）
- 宣告完成前跑過實際轉錄（模型已在本機，見 models 資料夾）
