# CLAUDE.md

> VoiceInk 專案規範。接手前先讀 [CONTEXT.md](./CONTEXT.md)（現行架構與驗證紀錄）；開發規範細節見 [AGENTS.md](./AGENTS.md)，兩份文件需同步對齊。

## 專案

Windows Electron 語音轉文字：檔案轉錄＋即時字幕＋翻譯與 TTS。Vanilla JS + Vite，無前端框架。

- ASR：local（sherpa Qwen3-ASR-0.6B）或 cloud（`cloud-asr.js` → `/audio/transcriptions`）
- 翻譯：cloud / local（node-llama-cpp）；本地可選 `linguaforge08`（Q8，預設）／`linguaforge08q4`（Q4）／`qwen35translate`；`llmGpu`（NVIDIA≥6GB → cuda/vulkan）
- TTS：Edge TTS；`ttsVoices` + `ttsRate`（-50…100）
- 翻譯頁輸入不限字數：renderer `splitForTranslate` 分 ≤600 字段落依序翻譯（main IPC 仍限單次 1500 字）
- 設定：第四 nav tab；區塊模型／翻譯／語音轉文字／外觀／語音
- 主窗 frameless（標題列合併 header）；標題僅 VoiceInk
- 模型 registry：`src/main/models.js`；下載至 `%APPDATA%/voiceink/models/`

## 指令

```bash
npm run electron:dev     # 開發（vite + electron）
npm run electron:pack    # 免安裝快速預覽 → dist/win-unpacked/VoiceInk.exe（任務結束必跑）
npm run electron:build   # 完整打包：NSIS 安裝檔 + win-unpacked → dist/
npm start                # 注意：未打包時 isDev=true，會連 localhost:5173，需先開 vite
```

## 慣例

- 檔名 kebab-case、變數 camelCase、常數 UPPER_SNAKE_CASE；ES2022、async/await、JSDoc
- Renderer 是 ESM（import/export）、Main/Preload 是 CJS
- 設定一律走 electron-store IPC（含 asrEngine/asrApi* / ttsRate；translator 僅 cloud|local）
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
- 即時字幕的佇列（pumpQueue）「保留最新 pending」是刻意設計：不丟塊、不堆積延遲
- 每輪錄製新建 MediaRecorder 是刻意設計：`timeslice` 產生的 Blob 缺 WebM header，不要改回去
- 字幕視窗 `transparent: false` 是刻意設計：Windows 上透明視窗會白條殘留＋resizable 失效（詳見 tasks/lessons.md）
- CSP `connect-src 'self' https: http:` 是自訂 API URL 的前提，不要改回白名單
- 打包需保留 package.json 的 `asarUnpack`（sherpa-onnx*、node-llama-cpp、ffmpeg-static）與 `files` 排除（cuda/arm64 變體）
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

## 驗證方式

- LinguaForge 解碼改動：`node scripts/probe-prompt-path.js`（prompt 逐字元／token id）＋ `node scripts/verify-chat-wrapper-fix.js`（30 句修前後對照與門檻；樣本在 `scripts/bench-cases.js`）
- Main 模組直測：`npx electron <e2e腳本>`（參考 CONTEXT.md）；此模式 app 名為 `Electron`，找模型需先 `app.setPath('userData', join(app.getPath('appData'),'voiceink'))`
- UI 無頭驅動：打包版 `VoiceInk.exe --remote-debugging-port=<port>` + Node 22 內建 `WebSocket` 走 CDP（驗分頁結構、彈窗切換、預熱/冷卻、關窗訊號）
- 宣告完成前跑過實際轉錄（模型已在本機，見 models 資料夾）
