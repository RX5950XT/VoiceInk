# tasks/lessons.md — 開發教訓

> 修正後把模式記在這裡，session 開始時複習。

## Electron / Windows

- **透明視窗是坑**：Windows 上 `transparent: true` + `frame: false` → 白色標題列殘留、`resizable` 失效、滑鼠事件異常。字幕視窗用 `transparent: false` + 深色背景 + `setMenu(null)`，透明需求改用整窗 `setOpacity`。
- **MediaRecorder timeslice 不可用**：`timeslice` 模式產生的 Blob 缺 WebM header，無法解碼。正確做法：每輪錄製新建 MediaRecorder 實例、錄滿即 stop 取完整檔。
- 打包後原生模組路徑要把 `app.asar` 換成 `app.asar.unpacked`（sherpa DLL PATH hack）。

## 音訊 / ASR

- **靜音判斷不能交給 AI**：昂貴且易幻覺，必須客戶端訊號層過濾（RMS＋語音佔比），並先做增益補償再檢測（loopback 音量隨系統音量浮動）。
- 雲端 chat completions 不吃 WebM → 前端轉 WAV 16-bit PCM。
- ASR 模型輸出要 strip `<sil>`/`<unk>` 等特殊 token。
- 自迴歸 ASR 遇到音樂/雜訊會重複循環（「我，我，我…」）→ regex 偵測短單位重複 8 次即丟棄。
- LLM 轉錄的幻覺要多層防護：客戶端 VAD → 上下文 → prompt 防呆 → 後處理過濾（長度上限＋贅句 regex）。本地 ASR 無此問題。

## 本地 LLM

- Qwen 系列思考模式會吃光 maxTokens 導致輸出為空 → node-llama-cpp 用 `budgets: { thoughtTokens: 0 }`，並保留 strip `<think>` 後備。
- node-llama-cpp 是 ESM-only → CJS main process 用動態 `import()`。

## 流程

- 忙碌時「丟棄」音訊塊會造成字幕大段缺失 → 用「保留最新 pending」的序列佇列（不丟塊、不堆積延遲）。
- 錯誤必須浮上 UI（狀態區＋連續失敗自動停止），只進 console 等於使用者看到永遠的「擷取中…」。
