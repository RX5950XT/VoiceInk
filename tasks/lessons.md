# tasks/lessons.md — 開發教訓

> 修正後把模式記在這裡，session 開始時複習。

## Electron / Windows

- **ASR 也要 serial lock + loadEnabled**：LLM 有 `withTranslateLock` 且 unload 會等 queue；ASR 若沒有，stop 後 in-flight `transcribe` 會 `getRecognizer` 幽靈重載（`users` 全 false 但 `asrLoaded: true`）。修法：`withAsrLock` 包 transcribe/unload、`loadEnabled=false` 於 unload 開頭、transcribe 無載入則 throw。live+file 並行也靠同一把鎖避免雙 `createAsync`。
- **prewarm 旗標不可早於 acquire 成功**：`prewarmed=true` 若在 await 前就設，cooldown 會 release 掉「尚未佔用」的 owner，而 in-flight acquire 之後成功卻無人 release → 模型洩漏。用 `prewarmGen` 作廢過期結果；擷取已接手（`engineAcquired`/`isStarting`）時**不可**對同一 live owner 再 release。
- **openFolder／store 要白名單**：download/remove 有 `MODELS[key]`，openFolder 漏了就可用 `..\\` 跳出 models 建目錄；store 任意 key 在 XSS 後可改 `apiUrl` 外洩 API Key。
- **displayMedia handler 必須 callback**：`getSources` reject 或空陣列若不呼叫 `callback`，`getDisplayMedia` 永久挂起。
- **檔案轉錄要重入鎖**：`users.file` 是布林，連點開始 → 雙管線 → 先完成的 `release` 卸掉後完成者的模型。
- **長 await 前要先 paint 進度 UI**：hide 大區塊後若立刻 `await engine.acquire`（載 1GB 模型可卡 main 十數秒），renderer 可能來不及畫幀 → 深色主題下像「黑屏」。點擊後立刻 show 進度卡 + `rAF`×2；ASR/LLM 分階段載。
- **長檔不可整檔 decodeAudioData**：2h 立體聲 44.1k PCM 可達數 GB → OOM/黑屏。正解：main 用 `ffmpeg-static` 串流 16k mono f32le，28s 切段 ASR；路徑用 `webUtils.getPathForFile`（Electron 32+ 無 `File.path`）。打包 `asarUnpack` 要含 `ffmpeg-static`。
- **串列 promise chain 內不可 await 會再 enqueue 自己的函式**：`chain.then(async () => { await processChunk() })` 而 `processChunk` 又做 `chain = chain.then(...)` 會死鎖（尾段永遠不 resolve）。尾段要先 enqueue 再 `chain.then(finalize)`，或在 chain 內直接跑 ASR 本體。
- **目標語 zh-TW ≠ 來源是中文**：ASR 不可對所有 `lang===zh-TW` 一律 s2twp，否則日文漢字被 opencc 弄髒。有假名/諺文就跳過，且 CJK 比例夠才轉。
- **透明視窗是坑**：Windows 上 `transparent: true` + `frame: false` → 白色標題列殘留、`resizable` 失效、滑鼠事件異常。字幕視窗用 `transparent: false` + 深色背景 + `setMenu(null)`，透明需求改用整窗 `setOpacity`。
- **MediaRecorder timeslice 不可用**：`timeslice` 模式產生的 Blob 缺 WebM header，無法解碼。正確做法：每輪錄製新建 MediaRecorder 實例、錄滿即 stop 取完整檔。
- 打包後原生模組路徑要把 `app.asar` 換成 `app.asar.unpacked`（sherpa DLL PATH hack）。

## 音訊 / ASR

- **靜音判斷不能交給 AI**：昂貴且易幻覺，必須客戶端訊號層過濾（RMS＋語音佔比），並先做增益補償再檢測（loopback 音量隨系統音量浮動）。
- 雲端 chat completions 不吃 WebM → 前端轉 WAV 16-bit PCM。
- ASR 模型輸出要 strip `<sil>`/`<unk>` 等特殊 token。
- **sherpa-onnx-node `decodeAsync` 會 `JSON.parse` native 回傳字串**：辨識文本若含未跳脫控制字元（`\t`/`\n`/0x00–0x1F），會丟 `SyntaxError: Bad control character in string literal in JSON`，UI 顯示「轉錄失敗」。修法：載入後 patch `OfflineRecognizer.decodeAsync/getResult`，用 `repairJsonControlChars` 再 parse；失敗再 regex 抽 `text`。
- 自迴歸 ASR 遇到音樂/雜訊會重複循環（「我，我，我…」）→ regex 偵測短單位重複 8 次即丟棄。
- LLM 轉錄的幻覺要多層防護：客戶端 VAD → 上下文 → prompt 防呆 → 後處理過濾（長度上限＋贅句 regex）。本地 ASR 無此問題。

## 本地 LLM

- Qwen 系列思考模式會吃光 maxTokens 導致輸出為空 → node-llama-cpp 用 `budgets: { thoughtTokens: 0 }`，並保留 strip `<think>` 後備。
- node-llama-cpp 是 ESM-only → CJS main process 用動態 `import()`。
- **載入模型 ≠ 可快速推論**：`warm()` 只 `loadModel`＋`createContext` 不算就緒——node-llama-cpp **首次 `prompt` 的 compute-graph 冷啟動在 CPU 上 ~12.5s**（後續同 session ~110ms）。若這 12.5s 拖到使用者「開始字幕」後第一句才付，期間 ASR 每 2s 產批、`translateQueue`（上限 5）塞爆丟批次，**僅翻譯顯示模式**對沒譯文的行回退顯示原文 → 整段只剩英文原文，看似「翻譯壞了」。解法：預熱時多跑一次拋棄式推論（`setChatHistory(極簡 system)` + `prompt('warmup',{maxTokens:1})`）把冷啟動挪到背景，`warmedUp` 旗標只跑一次、`unload` 重置、走 `withTranslateLock`。實測第一句 12,493ms→249ms。
- **括號式 meta-prompt 小模型會複誦**：把前文塞進「【前文】【本段】」單一 user 訊息，0.8B 模型會原樣吐回原文甚至整段 prompt（prompt 漏進字幕）。正解：指令放 system prompt、前文當上一輪 user/assistant 對話（本地 `setChatHistory`、雲端 messages 陣列），本地雲端同構。

## 流程

- 忙碌時「丟棄」音訊塊會造成字幕大段缺失 → 用「保留最新 pending」的序列佇列（不丟塊、不堆積延遲）。
- **非語言性片段餵給小翻譯模型會變「對話模式」**：擷取系統音訊時的音樂／靜音／音效被 ASR 轉成純符號（`♪♪♪`）、`……`、`>>`、零寬/格式字元等碎片。這些過得了「≥2 非標點字元」的弱 guard（`\p{P}` 不含 Symbol `So` 與 Format `Cf`），流進 0.8B 翻譯模型後，模型不翻譯而是**當成聊天開場**回「你好，我是即時字幕翻譯引擎…請提供原文…您應該如何稱呼？」persona 問候（system prompt 給了它 persona 名稱，它就照唸）。**僅翻譯顯示模式**下整個畫面被這些 babble 佔滿，看似「翻譯壞了」。真因是輸入端，不是翻譯邏輯（模組層 e2e：正常英文全數正確、context 污染不擴散——每個碎片各自獨立觸發，非級聯）。解法：進管線前用 `hasLinguisticContent`（`text.replace(/[^\p{L}]/gu,'').length>=2`，只認字母/漢字/假名/諺文）丟棄非語言片段——`processAudioChunkData` 在進 `handleAsrResult` 前就 return（連字幕行都不建）+ `shouldTranslate` 同構；main `translate` 再擋一次（縱深）。live system prompt 改祈使句、避免「你是…引擎」自稱（降極短輸入 chatty）。殘留：單一填充詞（如 "um"）仍可能觸發一次 chatty，罕見；要根除需更大模型或輸出端 persona 偵測。
- **「翻譯不見了」先別假設翻譯邏輯回歸**：症狀（僅翻譯模式只剩原文）可能是顯示層 + 佇列丟批次造成。除錯順序：先在模組層 e2e 直測翻譯（本案證明英文→繁中正常、零複誦）排除 LLM，再查顯示模式（`captionDisplayMode`）與佇列行為。本案真因是冷啟動丟批次（見上），非翻譯壞掉。讀使用者實際 `%APPDATA%/voiceink/config.json`（遮蔽 apiKey）比猜設定快。
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
