# CLAUDE.md

> VoiceInk 專案規範。接手前先讀 [CONTEXT.md](./CONTEXT.md)（現行架構與驗證紀錄）；開發規範細節見 [AGENTS.md](./AGENTS.md)，兩份文件需同步對齊。

## 專案

Windows Electron AI 工作台：聊天＋檔案轉錄＋即時字幕＋翻譯與 TTS。Vanilla JS + Vite，無前端框架。

- 聊天：雲端 OpenAI 相容 `/chat/completions` + `stream:true`；設定與翻譯獨立（`chatApiUrl`/`chatApiKey`/`chatModels`/`chatModelId`）
- 聊天進階：系統提示多組 preset（`chatPrompts`/`chatPromptId`，在聊天頁工具列切換與管理）、thinking 開關（`chatThinking` → `reasoning_effort`）、圖片附件（存 `<userData>/chat-images/`）、訊息複製／重新生成、側欄搜尋
- 額度：Claude Code／Codex／Antigravity／OpenCode／Grok 五家；**只在手動同步時查詢**，啟動／進頁只讀 `<userData>/usage.json` 快取；Main-only 固定來源，renderer 不接觸憑證／URL／路徑／SQL
- ASR：local（sherpa Qwen3-ASR-0.6B）或 cloud（`cloud-asr.js` → `/audio/transcriptions`）
- 翻譯：cloud / local（node-llama-cpp）；本地可選 `linguaforge08`（Q8，預設）／`linguaforge08q4`（Q4）／`qwen35translate`；`llmGpu`（NVIDIA≥6GB → cuda/vulkan）
- TTS：Edge TTS；`ttsVoices` + `ttsRate`（-50…100）
- 翻譯頁輸入不限字數：renderer `splitForTranslate` 分 ≤600 字段落依序翻譯（main IPC 仍限單次 1500 字）
- 設定：最後一個 nav tab；左側分類 rail（模型／翻譯／聊天／語音轉文字／外觀／語音朗讀）一次顯示一區 + 底部 sticky 儲存列
- 本地 ASR 只有 CPU：`asrThreads`（0＝自動／2／4／8）；sherpa 官方 Windows 套件未編譯 GPU
- nav 順序：聊天（預設頁）｜額度｜檔案轉錄｜即時字幕｜翻譯與 TTS｜設定
- 主窗 frameless（標題列合併 header）；標題僅 VoiceInk
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
發行：bump `package.json` 版本（不可與既有 tag 重複）→ commit → `git tag vX.Y.Z` → push → `electron:build` → `gh release create`。

## 慣例

- 檔名 kebab-case、變數 camelCase、常數 UPPER_SNAKE_CASE；ES2022、async/await、JSDoc
- Renderer 是 ESM（import/export）、Main/Preload 是 CJS
- 設定一律走 electron-store IPC（含 asrEngine/asrApi* / ttsRate；translator 僅 cloud|local）
- 聊天會話**不走** `store:*`，走 `chat:*` IPC ＋ 獨立 electron-store 實例（`<userData>/chats.json`）
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
- 打包需保留 package.json 的 `asarUnpack`（sherpa-onnx*、node-llama-cpp、ffmpeg-static、Antigravity credential `.ps1`）與 `files` 排除（cuda/arm64 變體）
- Antigravity 的 PowerShell 是外部程序，不能執行 `app.asar` 內檔案：`read-windows-credential.ps1` 必須 unpack，路徑經 `resolveCredentialScriptPath` 換成 `app.asar.unpacked`；未連線時不可用 `mergeExpectedWindows` 合成四條 100% 假額度
- OpenCode 固定用 Electron 內建 `node:sqlite` 的 `readOnly:true`／`allowExtension:false` 與參數化固定 SQL；不要改回 native dependency，也不可讓 renderer 傳 DB path／SQL
- 額度與聊天的 HTTP 錯誤只記安全狀態摘要，**禁止把 response body／token／外部 error message 寫進 console、diagnostics 或 IPC**
- 翻譯分段：通用 ≤600 字（`contextSize: 2048`）；**LinguaForge 用 ≤280**（出貨 INTEGRATION 建議）；main `MAX_TRANSLATE_CHARS`（1500）是 IPC 信任邊界，不要拿掉
- **Qwen3.5 的 generation prompt 必須以空 think 區塊收尾**：`<|im_start|>assistant\n<think>\n\n</think>\n\n`（token 248068,271,248069,271）。node-llama-cpp 自動解析的 Qwen wrapper **不補**這 4 個 token，模型立刻掉出分布（憑空「說明：／問：／選擇：」前綴、拉丁專名整個消失、年份幻覺）。修法是 session 帶 `new QwenChatWrapper({ thoughts: 'discourage' })`（`local-llm.newQwen35ChatWrapper`），實測與 transformers `apply_chat_template` 逐字元相同；`budgets.thoughtTokens:0` 只擋「生成 thinking」，兩件事都要做。驗證：`node scripts/probe-prompt-path.js`
- LinguaForge 有 **兩個量化 key**（`models.js`）：`linguaforge08`＝Q8_0（預設，774MB，專名保留 93.3%）／`linguaforge08q4`＝Q4_K_M（505MB、CPU 快約 2.2×，專名保留 80%，Kimi→金剛、Sol→索爾）。兩者共用整套 SFT 格式與 DECODE → 判斷一律用 `local-llm.isLinguaforge(key)`，勿寫 `key === 'linguaforge08'`
- LinguaForge GGUF：**zhtw 必須 `repeatPenalty: false`**（node-llama 省略時預設 1.1 會攪繁簡）；en/ja rep=1.1；dry≈nrng4；雙 EOS／關 thinking；勿改 system prompt
- **不要用 regex 剝掉「說明：」「問：」「1. 」這類前綴當修復**：那是止血，代表 prompt 錯了；同時發生的專名消失／年份幻覺 regex 抓不到（現行 `translate-clean` 白名單是最後一層保險，不是主修）
- 檔案轉錄走 main `file-transcribe.js`（ffmpeg 串流 16k mono → 28s 切段），勿改回 renderer 整檔 `decodeAudioData`（長檔 OOM）
- 打包跑的是 `src/` 原始碼（`files` 排除 `dist/**`，main `loadFile('../renderer/...')` 載入 asar 內原始檔）；`vite build` 只作驗證，改 renderer 直接改 `src/`
- 字幕顯示模式（雙語/僅翻譯）由字幕彈窗獨佔（讀寫 store `captionDisplayMode`、單一 `currentMode` 渲染）；別再讓即時頁 payload 夾帶 `displayMode` 或加跨窗 IPC——兩端搶改同一狀態會打架
- 引擎 owner：`live|file|translate` 布林；翻譯頁 prewarm 同樣 gen 作廢；切頁先 acquire 再 release；TTS IPC 只收 lang、回 Uint8Array（禁 base64／禁 AGPL 套件）
- ASR 必須 `withAsrLock` + `loadEnabled`：unload 等 in-flight、禁止 stop 後幽靈重載；transcribe 有 samples 長度／sampleRate 驗證
- store key 僅 allowlist；`models.openFolder` 僅 registry key 或根目錄
- 兩窗 `sandbox: true`；displayMedia handler 失敗也要 `callback({})`
- **聊天的 model 與訊息歷史所有權在 main**：renderer 只送 `{reqId, conversationId, text, images?, regenerate?}`，model 讀 `chatModelId`（必須 ∈ `chatModels`）、system prompt 讀 `chatPrompts`+`chatPromptId`、歷史由 `chat-store` 讀寫、上下文 ≤24000 字由 main 裁切。別為了方便把 messages 陣列或 model 搬回 renderer 傳——那等於把信任邊界拆掉
- **本地 ASR 不可能有 GPU 選項**：npm 的 `sherpa-onnx-win-x64` 是 CPU-only 編譯，provider 傳 `cuda`／`directml` 只會印 `Please compile with -DSHERPA_ONNX_ENABLE_GPU=ON ... Fallback to cpu!` 然後靜默退回 CPU（實測過）。不要加假的 GPU 切換鈕；要更快就用雲端 ASR
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
- 額度卡固定 2 欄（≤900px 收 1 欄）、`align-items: start`＋`min-height: 250px`；標題是 provider accent 實心 pill，**不放 LOGO 方塊或方案副標**，卡內小字一律 12px／`--text-secondary`
- 額度排序不設上下按鈕，且**不用 HTML5 DnD**（瀏覽器拖影一定半透明）：pointer 事件直拖，卡片本體 `translate3d` 跟游標、維持不透明（`.dragging` 只加 z-index／陰影並關 transition），其他卡片以 Web Animations FLIP（110ms、transform-only）推開，放開才存一次並以 150ms FLIP 滑回槽位。監聽掛在 `window`（不用 `setPointerCapture`：preview 會 `appendChild` 移動卡片，capture 可能被隱式釋放）。卡片本身以 Space 抓取、方向鍵移動、Enter／Space 放下、Esc 取消；鍵盤移動與 reduced motion 不播放 FLIP
- Aurora 視覺 token 集中在 `themes.css`，共用 surface／RWD 在 `main.css`；不要用 React、DnD 或動畫 dependency 取代原生 DOM／Web Animations

## 驗證方式

- 額度：`node scripts/test-usage.js`（合約／bounded I/O／五 provider fixture／唯讀 SQLite／快取／IPC／打包路徑）＋ `npx electron scripts/e2e-usage.js`（本機五家真實來源、憑證不外洩）＋ `node scripts/e2e-usage-cdp.js`（打包版手動同步／設定／排序／診斷／主題／RWD）
- 聊天：`node scripts/test-markdown.js`（渲染器 + XSS，node 直跑；用 vm 載入 ESM 並以會丟例外的 innerHTML setter 當斷言）＋ `npx electron scripts/e2e-chat.js`（mock SSE server：串流拼接／中斷存檔／上下文裁切／model allowlist／上限淘汰／錯誤不外洩 body／提示 preset／圖片附件與回收／thinking 分流／重新生成）
- LinguaForge 解碼改動：`node scripts/probe-prompt-path.js`（prompt 逐字元／token id）＋ `node scripts/verify-chat-wrapper-fix.js`（30 句修前後對照與門檻；樣本在 `scripts/bench-cases.js`）
- 本地 ASR 執行緒：`npx electron scripts/e2e-asr-threads.js`（Edge TTS 合成一句 → ffmpeg 轉 16k → 送回 ASR 比對，順便量不同 threads 的耗時）
- Main 模組直測：`npx electron <e2e腳本>`（參考 CONTEXT.md）；此模式 app 名為 `Electron`，找模型需先 `app.setPath('userData', join(app.getPath('appData'),'voiceink'))`
- UI 無頭驅動：打包版 `VoiceInk.exe --remote-debugging-port=<port>` + Node 22 內建 `WebSocket` 走 CDP（驗分頁結構、彈窗切換、預熱/冷卻、關窗訊號）
- 視覺／RWD：`node scripts/e2e-visual-cdp.js`（六頁 × dark/light × 1440/900/560、glass signature、水平 overflow、reduced motion）＋ `node scripts/test-usage-reorder.js`（排序與 FLIP）
- 宣告完成前跑過實際轉錄（模型已在本機，見 models 資料夾）
