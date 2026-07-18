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
- **括號式 meta-prompt 小模型會複誦**：把前文塞進「【前文】【本段】」單一 user 訊息，0.8B 模型會原樣吐回原文甚至整段 prompt（prompt 漏進字幕）。正解：指令放 system prompt、前文當上一輪 user/assistant 對話（本地 `setChatHistory`、雲端 messages 陣列），本地雲端同構。

## 流程

- 忙碌時「丟棄」音訊塊會造成字幕大段缺失 → 用「保留最新 pending」的序列佇列（不丟塊、不堆積延遲）。
- 錯誤必須浮上 UI（狀態區＋連續失敗自動停止），只進 console 等於使用者看到永遠的「擷取中…」。
- **await 後要重檢 session 狀態**：`transcribe`／`translate` 這種長 await 之後、以及 promise 的 `finally` 裡，一律先 `if (!isCapturing || epoch !== sessionEpoch) return`。否則停止後才 resolve 的 stale 結果會建新 batch、觸發翻譯、幽靈重載已卸載的模型，或清掉新 session 的鎖。epoch 機制存在就是為了擋這個。
- **失敗時別把原文冒充譯文寫進 history**：翻譯空白/失敗時 push 原文當「譯文」，下一輪它變成 chat history 的 assistant 前文，等於 few-shot 教模型複誦原文（=括號式 prompt bug 的資料版）。譯文留空即可（`buildContextPair` 會因空譯文回 null 而略過）。
- **identity 前文（譯文==原文）會教小模型複誦**：同上的隱形版。日文全漢字片段（無假名、cjkRatio 高）被 `needsTranslation` 誤判為「已是中文」，於是 `pushPair(原文,原文)` 塞進 history；這對 (X→X) 就是 few-shot 示範「原樣輸出」，下一段日文被 0.8B 整段複誦→雙語字幕變兩行日文。英文不會（永遠需翻，不走 identity 分支）。三層防護：源頭別 push identity 前文；模型自我複誦（`translated===source`）比照空譯文；`buildContextPair` 對 `prevSrc===prevTr` 回 null。e2e 可穩定重現（identity ctx 時 `ECHO=true`）。修復語言無關（KO/ES/FR/EN 皆驗過）。但殘留 0.8B 對「整句共用漢字」的日文句先天複誦（~1/6），prompt 強化與 echo 重試皆救不了（實測重試無效還加延遲）→ 靠 self-echo 守門顯示原文即可；要真正提升日文品質得換更大翻譯模型。強化 live system prompt（明講來源可能是共用漢字的日/韓文、嚴禁原樣輸出）可讓繁體較一致、不加延遲，屬低成本淨賺。
- **別用 0.8B 翻譯模型當語言偵測器**：實測簡單分類 prompt 準確率僅 ~43%（中文→判英文、日文含假名→判英文、韓文→判中文），比漢字比例啟發式更糟又多一次推論延遲。且中文→中文不保證 echo（會改寫，如 `人工智慧→人工智能`），不能靠「全翻+echo 去重」取代啟發式。要可靠只能靠手動來源語言選單或換更大模型。動手前先用 e2e 量準確率，別假設小模型會偵測。
- **譯文轉繁與 echo 去重的順序**：0.8B 譯文偶爾夾簡體字→翻譯 choke point（`translate` 收尾）統一過 `s2twp`（抽到 `src/main/opencc.js` 與 ASR 共用）。但**要先判 echo 再轉繁**：模型自我複誦（`result===text`，含日文頑固句）時回原文且**不轉繁**，否則 s2twp 會 mangle 原文使 renderer 的 `translated===source` 去重失效、把亂碼日文當譯文顯示。
- **前文原文/譯文要成對過濾**：兩個 history 分開存、只單邊過濾會錯位（user 只有 X、assistant 卻含 X+Y）。存成 `{source, translation}` 成對陣列，過濾與取樣一起做。
- **啟動要有重入旗標**：按鈕 `disabled` 若在多個 await 之後才設，雙擊會起兩條錄音管線且第一條永不停。用 JS 旗標（`isStarting`）在函式入口擋，別只靠 DOM disabled。
- **下游佇列也要防堆積**：上游 pending 有 latest-wins，下游 `translateQueue` 也要設上限丟最舊，否則本地翻譯跟不上時延遲線性擴大。
- **視窗還原座標要驗螢幕存在**：存的 bounds 可能在已拔除的外接螢幕（負座標）→ 開在看不見處。用 `screen.getAllDisplays()` 檢查重疊，否則置中。
- **字幕視窗 OS 層關閉（Alt+F4）要通知 renderer**：只有 `subtitle:close` IPC 會發 `subtitle:closed`；視窗 `'closed'` 事件也要補發（用 `subtitleWindow !== win` 區分 OS 關閉與 IPC 關閉），否則管線在無視窗下持續擷取。
- **跨行程 send 前檢查 `isDestroyed()`**、雲端 `fetch` 要帶 `AbortSignal.timeout`（翻譯走 serial chain，卡死會連帶鎖死停止與卸載）。
- **顯示模式讓「顯示端」獨佔**：雙語／僅翻譯純屬字幕彈窗的渲染選擇，就該由彈窗擁有（讀寫 store `captionDisplayMode`、單一 `currentMode` 渲染）；別讓來源端每筆 payload 夾帶 `displayMode` 又跨窗 IPC 覆寫——兩邊搶著改同一狀態必打架。source/translation 一律都送，模式只影響顯示。
- **背景預熱綁分頁生命週期**：模型載入是最大體感延遲。進入即時分頁就 `engine.acquire` 預熱、離開且未擷取就 `release` 卸載（`switchPage` 為 hook）。`users.live` 用布林非計數，預熱與擷取共用 owner、單次 release 歸零；用 `prewarmed`／`engineAcquired` 兩支互斥旗標記錄由誰持有，擷取開始時把所有權轉交（`prewarmed=false`）、失敗或停止時一起清。
- **獨立模型並行 warm**：ASR（sherpa）與 LLM（llama）互不相干，`Promise.all` 並行載入即可近乎減半等待；各自 `warm()` 已 catch 回傳 `{ok,warnings}`，並行不會 reject。實測同時載入無原生競態。
- **打包跑的是 `src/` 原始碼**：`build.files` 排除 `dist/**`，main `loadFile('../renderer/...')` 直接載入 asar 內原始 ESM/HTML；`vite build` 只作驗證。改 renderer 改 `src/` 就生效，別被 `dist/renderer` 只有 index.html 誤導。
- **e2e 用 `npx electron <script>` 時 app 名是 `Electron`**：`userData` 會指向 `Roaming/Electron`（找不到 `voiceink` 的模型）→ 開頭補 `app.setPath('userData', join(app.getPath('appData'),'voiceink'))`。UI 端可用內建 `WebSocket`（Node 22）走 CDP 驅動打包版驗證。
