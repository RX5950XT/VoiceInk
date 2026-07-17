# CLAUDE.md

> VoiceInk 專案規範。接手前先讀 [CONTEXT.md](./CONTEXT.md)（現行架構與驗證紀錄）；開發規範細節見 [AGENTS.md](./AGENTS.md)，兩份文件需同步對齊。

## 專案

Windows Electron 語音轉文字：檔案轉錄＋系統音訊即時字幕。Vanilla JS + Vite，無前端框架。

- ASR：固定本地 sherpa-onnx Qwen3-ASR-0.6B（無雲端轉錄、無其他 ASR 模型）
- 翻譯：none / cloud / local（node-llama-cpp + Qwen3.5-0.8B GGUF）
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
- 設定一律走 electron-store IPC（鍵：translator/apiUrl/apiKey/modelId/theme）
- ASR 模型 key 固定 `qwen3asr`（`ASR_MODEL_KEY`）
- Commit 格式 `<type>: <description>`，訊息用繁體中文
- **UI／功能改動完成後，先跑 `npm run electron:pack` 更新免安裝預覽**（`dist/win-unpacked/VoiceInk.exe`），方便使用者直接點開驗證；完整安裝檔（`electron:build`）僅在需要發佈時再打

## 地雷（改壞過的地方）

- sherpa-onnx-node 在 Windows 需先把 DLL 目錄加入 PATH 才能 require（`local-asr.js` 已處理，含 asar.unpacked 替換），不要動這段順序
- node-llama-cpp 是 ESM-only，main process 只能動態 `import()`；Qwen 系列要 `budgets: { thoughtTokens: 0 }` 關思考，否則譯文為空
- ASR 輸出要 strip `<sil>` 等 `<...>` 特殊 token
- 即時字幕的佇列（pumpQueue）「保留最新 pending」是刻意設計：不丟塊、不堆積延遲
- 每輪錄製新建 MediaRecorder 是刻意設計：`timeslice` 產生的 Blob 缺 WebM header，不要改回去
- 字幕視窗 `transparent: false` 是刻意設計：Windows 上透明視窗會白條殘留＋resizable 失效（詳見 tasks/lessons.md）
- CSP `connect-src 'self' https: http:` 是自訂 API URL 的前提，不要改回白名單
- 打包需保留 package.json 的 `asarUnpack`（sherpa-onnx*、node-llama-cpp）與 `files` 排除（cuda/arm64 變體）

## 驗證方式

- Main 模組直測：`npx electron <e2e腳本>`（參考 CONTEXT.md）
- UI 無頭驅動：`npx electron . --remote-debugging-port=9223` + CDP
- 宣告完成前跑過實際轉錄（模型已在本機，見 models 資料夾）
