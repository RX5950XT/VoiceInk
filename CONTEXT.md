# CONTEXT.md — 開發紀錄交接文件

> 給下一個 AI Agent 的接手指南。保持精簡，每次任務完成後更新。

## 專案概況

VoiceInk：Windows Electron 語音轉文字應用（檔案轉錄＋系統音訊即時字幕）。
Vanilla JS + Vite，無前端框架。版本 **1.3.0**（GitHub Release `v1.3.0`）。

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
  pages/subtitle.html     懸浮字幕視窗（顯示模式 雙/譯、字級 A±、視窗透明度 ◐、複製）
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
- **打包用的是 `src/` 原始碼**：`build.files` 排除 `dist/**`，main 以 `loadFile('../renderer/...')` 從 asar 內 `src/renderer` 直接載入原始 ESM/HTML；`vite build` 僅作語法驗證，改 renderer 直接改 `src/` 即生效（不需理會 `dist/renderer` 只有 index.html）。
- 即時字幕處理佇列：「保留最新 pending」不丟塊也不堆積（live-caption.js pumpQueue）。
- 靜音門檻：peak normalize 後 RMS>0.01 且 speechRatio>0.05。
- dev 驗證技巧:`npx electron . --remote-debugging-port=9223` + CDP；e2e 腳本用 `npx electron <script>` 直測 main process。
- **改動完成後必跑** `npm run electron:pack` → 更新 `dist/win-unpacked/VoiceInk.exe` 免安裝預覽；完整安裝檔才用 `npm run electron:build`。

## 最近變更（2026-07-18b）

- **修日文翻譯被複誦（雙語變兩行日文）**：根因是 identity 前文（譯文==原文）當 few-shot 教 0.8B 模型「原樣輸出」，下一段日文被整段複誦。三層防護：(1) `live-caption.js` 移除 `!needsTranslation` 分支的 `pushPair(原文,原文)`（identity 前文源頭；全漢字日文片段會被誤判為已是中文）；(2) `pumpTranslate` 對 `translated === joinedSource`（模型自我複誦）比照空譯文處理，不覆寫譯文也不寫進 history；(3) `local-llm.js buildContextPair` 對 `prevSrc === prevTr` 回 null（live/cloud/file 共用邊界網）。e2e：修前 JA-after-identity-ctx `ECHO=true`，修後全部 `ECHO=false`（`これはテストです。→這是測試。`）。
- **跨語言驗證＋強化 live 系統 prompt**：三層修復語言無關，KO／ES／FR／EN identity 前文皆 `ECHO=false`。殘留為 0.8B 對「整句都是與中文共用漢字」的日文句先天複誦傾向（實測 ~1/6，如 `昨日は友達と映画を見に行きました。`），任何 prompt 或 echo 重試都救不了（實測重試無效且加延遲，故不採用）→ 交給第 2 層 self-echo 守門（顯示原文、不出現重複行）。`buildSystemPrompt` live 分支改為明確告知「來源可能是與目標語共用文字的日/韓文、一律翻譯、嚴禁原樣輸出」，實測繁體較一致、修好部分漢字密集句（不加延遲）。
- **翻譯輸出轉繁（s2twp）＋ main 側 echo 守門**：0.8B 譯文偶爾夾簡體字（如「气/这/能」）。抽出 `src/main/opencc.js`（lazy 單例 `s2twp`，ASR 與翻譯共用；local-asr 改 require 它、移除本地副本）。`local-llm.translate` 收尾：先判 `result===text`（模型自我複誦，含日文頑固句）→ 回原文**不轉繁**（轉繁會 mangle 使 renderer echo 去重失效），否則目標為 `zh-TW` 時過 `s2twp`。cloud/local、live/file 共用此 choke point。實測 KO/JA/EN 譯文全繁體、頑固 echo 仍回原文（`ECHO(==原文)=true`）。
- **語言偵測評估：不採用**。實測「用現有 0.8B 翻譯模型當語言偵測器」準確率僅 ~3/7（中文→英文、日文含假名→英文、韓文→中文），比漢字比例啟發式更糟且多一次推論延遲；且中文→中文不保證 echo（`人工智慧→人工智能` 改寫），無法靠「全翻+echo 去重」取代啟發式。故保留現有 `needsTranslation` 啟發式；純漢字日文片段偶爾不譯屬已知限制（少見、self-echo 守門避免重複行）。真正解法：手動來源語言選單（可靠零延遲）或換更大翻譯模型。
- **UI 清理**：移除即時字幕頁「💡 使用說明」`info-card` 卡片（含 CSS）；移除主視窗綠色成功 toast（`showToast(..,'success')` 全數：設定已儲存／已刪除／下載完成／已複製/已儲存檔案）與 `.toast.success` CSS，僅保留紅色錯誤 toast（字幕彈窗自身複製 toast 不動）。

## 最近變更（2026-07-18）

- **顯示模式搬進字幕視窗**：雙語／僅翻譯切換鈕（雙/譯）移到字幕彈窗右上角控制列，由彈窗獨佔——載入時讀 store `captionDisplayMode`、以單一 `currentMode` 統一渲染、切換時寫回 store。即時頁移除該 segmented 控制（保留翻譯後端提示），`upsertSubtitle` payload 不再帶 `displayMode`；跨窗 IPC `subtitle:setDisplayMode`／`onDisplayMode` 一併移除。
- **關窗＝真正停止且雙向同步**（機制原已存在，本次實測確認）：關彈窗（✕／Alt+F4）→ main 送 `subtitle:closed` → 即時頁 `stopCapture` 回「開始字幕」；頁面「停止字幕」→ `subtitle.close()` 關窗。
- **加快模型載入**：(1) `engine.acquire` 內 ASR/LLM warm 改 `Promise.all` 並行；(2) 進入即時字幕分頁即背景預熱（`app.js switchPage('live') → prewarmEngine()`），離開且未擷取則 `cooldownEngine()` 卸載。`users.live` 為布林，預熱與擷取共用同一 owner、單次 release 即歸零；`prewarmed`／`engineAcquired` 互斥旗標避免互踩。
- 驗證：CDP 驅動打包版全過（即時頁已無 segment、彈窗雙/譯切換持久化、切到 live 背景載入 ASR、切離卸載、關窗送 `subtitle:closed`）；engine 並行 warm e2e 同時載入 ASR+LLM ~14s 無競態。
- 備忘：`npx electron <script>` 下 app 名為 `Electron`，`userData` 指向 `Roaming/Electron`（找不到模型）→ e2e 需先 `app.setPath('userData', join(getPath('appData'),'voiceink'))`。

## 最近變更（2026-07-17）

- 徹底移除雲端轉錄路徑（`transcribeAudio` / `transcribeLiveWithContext` / 引擎切換 UI）
- ASR 模型只留 Qwen3-ASR-0.6B（移除 FireRedASR2-CTC）
- 設定：刪除「轉錄引擎」區段與本地模型下拉；翻譯標題改為「翻譯」（去掉括號說明）
- 設定鍵：`translator` / `captionDisplayMode` / `apiUrl` / `apiKey` / `modelId` / `theme`
- 設定 UI：模型狀態卡；雲端 API 僅 cloud 時展開；翻譯開啟時可選「雙語字幕／僅翻譯」
- 規範：任務結束先 `electron:pack` 更新免安裝預覽
- **修即時翻譯 prompt 複誦**：0.8B 模型看到「【前文】【本段】」括號式 prompt 會原樣複誦（原文甚至整段 prompt 漏進字幕）。改為指令走 system prompt、前文當上一輪 user/assistant 對話（本地 `session.setChatHistory`、雲端 messages 陣列同構）；`buildTranslatePrompt` 已移除，改 `buildSystemPrompt` + `buildContextPair`。live-caption 前文改取對齊的 2+2 段。本地／雲端路徑皆以 `npx electron` e2e 驗證通過。
- **即時字幕全鏈路體檢＋修 15 項**（多代理審查＋對抗性驗證；細節見 tasks/lessons.md）：
  - 根因叢集「stop/start 邊界的 stale in-flight 工作」：`processAudioChunkData` 於 transcribe await 後補 `isCapturing/epoch` 檢查；`pumpTranslate` 的 `finally` 加 epoch guard（不清新 session 鎖）。
  - history 改成 `{source,translation}` 成對陣列：失敗/空譯文 push 空字串不污染、`buildTranslateContext` 成對過濾不錯位。
  - live-caption：`startCapture` 重入旗標 `isStarting`；track `ended` + `MediaRecorder.onerror` + inactive stream 防護；`translateQueue` 上限 5 丟最舊；失敗路徑補 `stopLevelMeter`；settings-changed 刷新快照；`needsTranslation` 修日/韓（有假名/諺文即需翻）。
  - main.js：`isBoundsOnScreen` 驗證還原座標；字幕視窗 `'closed'` 補發 `subtitle:closed`（Alt+F4）；`subtitle:update/setDisplayMode/setOpacity` 加 `isDestroyed()`。
  - local-llm：`MAX_TOKENS_LIVE` 128→256（避免截斷半句）；雲端 fetch 加 `AbortSignal.timeout(20s)`。
  - 非問題（未動）：sherpa `OfflineRecognizer` 無 dispose→無 use-after-free；applyGain 在門檻前是刻意設計。
- 即時字幕翻譯 v2／v3：
  - ASR 與翻譯管線分離；openBatch 合併；find-by-id upsert
  - 即時頁可切雙語／僅翻譯；顯示翻譯後端狀態
  - 修 seal 後必 pumpTranslate；空譯文 setError
  - **engine 生命週期**：`engine:acquire/release` refcount；start 預熱 ASR+LLM；stop 卸載；`before-quit` 同步 unloadAll
  - local-asr/local-llm：warm/unload + generation 防幽靈載入；LLM 持有 model/context 可 dispose

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
