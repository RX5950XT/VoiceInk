# CONTEXT.md — 開發紀錄交接文件

> 給下一個 AI Agent 的接手指南。保持精簡，每次任務完成後更新。

## 專案概況

VoiceInk：Windows Electron 語音轉文字應用（檔案轉錄＋系統音訊即時字幕）。
Vanilla JS + Vite，無前端框架。版本 **1.2.0**（GitHub Release `v1.2.0`）。

## 架構（本地 ASR only，2026-07-17）

```
src/main/
  main.js        視窗管理 + IPC 掛載（store / subtitle / models / localAsr / translate）
  models.js      本地模型 registry + 下載管理（qwen3asr、qwen35translate）
  local-asr.js   sherpa-onnx 本地轉錄（固定 Qwen3-ASR-0.6B；zh-TW 經 opencc 轉繁）
  local-llm.js   翻譯分流：雲端 chat completions / 本地 node-llama-cpp
src/preload/preload.js   contextBridge 暴露上述 IPC
src/renderer/
  scripts/app.js          設定（translator/apiUrl/apiKey/modelId）+ 模型管理 UI
  scripts/api.js          雲端 API 預設值（DEFAULT_API_URL / DEFAULT_MODEL）
  scripts/live-caption.js 即時字幕（2s 切塊、佇列不丟塊、增益+靜音門檻、音量條）
  scripts/transcribe.js   檔案轉錄（28s 切段 + 翻譯）
  pages/subtitle.html     懸浮字幕視窗（字級 A±、視窗透明度 ◐、複製）
```

## 轉錄引擎

| 項目 | 說明 |
|---|---|
| ASR | 固定本地 Qwen3-ASR-0.6B（`ASR_MODEL_KEY = 'qwen3asr'`），無引擎選擇 UI、無 FireRed |
| 路徑 | renderer 解碼→16k mono Float32→IPC→sherpa-onnx |
| 翻譯 | `translator` = none / cloud（文字丟雲端 API）/ local（Qwen3.5-0.8B GGUF） |

模型存放：`%APPDATA%/voiceink/models/<key>/`，registry 在 `src/main/models.js`。

## 關鍵技術備忘

- **sherpa-onnx-node@1.13.4**：Windows 需在 require 前把 `node_modules/sherpa-onnx-win-x64` 加入 `process.env.PATH`（`local-asr.js` 已處理，含 asar.unpacked 替換）。Qwen3 config 鍵：`qwen3Asr:{convFrontend,encoder,decoder,tokenizer,hotwords}`。
- ASR 輸出要 strip `<sil>` 等特殊 token（已在 local-asr.js 處理）。
- **node-llama-cpp@3.19** 是 ESM，main process 用動態 `import()`；Qwen 系列要 `/no_think` + strip `<think>`。
- 打包：package.json `build.asarUnpack` 已含 sherpa-onnx*/node-llama-cpp。
- 即時字幕處理佇列：「保留最新 pending」不丟塊也不堆積（live-caption.js pumpQueue）。
- 靜音門檻：peak normalize 後 RMS>0.01 且 speechRatio>0.05。
- dev 驗證技巧:`npx electron . --remote-debugging-port=9223` + CDP；e2e 腳本用 `npx electron <script>` 直測 main process。
- **改動完成後必跑** `npm run electron:pack` → 更新 `dist/win-unpacked/VoiceInk.exe` 免安裝預覽；完整安裝檔才用 `npm run electron:build`。

## 最近變更（2026-07-17）

- 徹底移除雲端轉錄路徑（`transcribeAudio` / `transcribeLiveWithContext` / 引擎切換 UI）
- ASR 模型只留 Qwen3-ASR-0.6B（移除 FireRedASR2-CTC）
- 設定：刪除「轉錄引擎」區段與本地模型下拉；翻譯標題改為「翻譯」（去掉括號說明）
- 設定鍵：`translator` / `apiUrl` / `apiKey` / `modelId` / `theme`（不再寫 engine/localModel）
- 設定 UI：上方「模型狀態」卡顯示 ASR／翻譯模型與下載按鈕；雲端 API 僅在翻譯選「雲端 LLM」時展開
- 規範：任務結束先 `electron:pack` 更新免安裝預覽

## 已驗證（歷史）

- Qwen3-ASR 推理 e2e 通過（RTF ~0.62）
- 即時字幕全流程：loopback→本地 ASR→字幕視窗
- 檔案轉錄本地路徑＋本地翻譯全鏈
- 打包版 win-unpacked 實測本地轉錄成功

## 已知限制／未來方向

- 固定 2s 切塊會切斷字詞邊界 → 升級路徑：silero-vad（sherpa-onnx 內建）做語音段偵測
- 字幕透明度用整窗 setOpacity（文字也會變淡）→ 若要文字不透明需 transparent window（Windows 有坑）
- 本地檔案轉錄 28s 硬切 → 同樣可用 VAD 改善
- Qwen3-ASR-1.7B（更準，int8 ~2GB）可加入 registry
- PRD 未實作的 backlog 見 `tasks/todo.md`
