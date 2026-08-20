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
- **即時字幕不要用 MediaRecorder**：`timeslice` Blob 缺 WebM header；每輪新建 recorder 雖可解碼，但 stop→restart 仍有 20–100ms 無人錄音，且固定切句、opus 編解碼都是冤枉路。現行改為 `AudioContext({sampleRate:16000})` 直取 PCM + 能量 VAD 依停頓切句。
- 打包後原生模組路徑要把 `app.asar` 換成 `app.asar.unpacked`（sherpa DLL PATH hack）。
- **外部程序也讀不到 asar 內檔案**：Antigravity Credential Manager bridge 在 source e2e 正常、打包版卻找不到憑證，因 PowerShell `-File` 指向 `app.asar/...ps1`。腳本要列入 `asarUnpack`，呼叫前同樣把路徑換成 `app.asar.unpacked`；這類功能一定要驗 final package，source e2e 不足。
- **來源未連線時不可合成保守額度**：Antigravity 的「缺 slot → 沒快取就視為 100% used」只適用已連線但 API 漏欄位；若 credential 根本沒讀到，套同一 merge 會同時顯示「未連線」與四條 100% 假額度。先判 account status，再做 slot merge。

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
- **載入模型 ≠ 可快速推論**：`warm()` 只 `loadModel`＋`createContext` 不算就緒——node-llama-cpp **首次 `prompt` 的 compute-graph 冷啟動在 CPU 上 ~12.5s**（後續同 session ~110ms）。若這 12.5s 拖到使用者「開始字幕」後第一句才付，舊版固定 2s ASR 管線會持續產批、`translateQueue`（上限 5）塞爆丟批次，**僅翻譯顯示模式**對沒譯文的行回退顯示原文 → 整段只剩英文原文，看似「翻譯壞了」。解法：預熱時多跑一次拋棄式推論（`setChatHistory(極簡 system)` + `prompt('warmup',{maxTokens:1})`）把冷啟動挪到背景，`warmedUp` 旗標只跑一次、`unload` 重置、走 `withTranslateLock`。實測第一句 12,493ms→249ms。
- **括號式 meta-prompt 小模型會複誦**：把前文塞進「【前文】【本段】」單一 user 訊息，0.8B 模型會原樣吐回原文甚至整段 prompt（prompt 漏進字幕）。正解：指令放 system prompt、前文當上一輪 user/assistant 對話（本地 `setChatHistory`、雲端 messages 陣列），本地雲端同構。

## 流程

- **明確要求的功能不能只留在未來清單**：使用者指出額度儀錶板被遺漏後，才把原本的「階段二」真正落地。交付前要逐項對照使用者原始需求與核准 spec，不以 roadmap/backlog 文字冒充完成。
- **「不回 renderer」不等於不洩漏**：聊天 API error body 原本仍整段寫入 main console，測試假 key 直接出現在 log。所有外部 body、token、外部 error message 都不可進 console／diagnostics；只記 provider、HTTP status、內部錯誤 code 等安全摘要，測試要同時攔 IPC 與 console。
- **系統 loopback e2e 會混到其他 App 音訊**：打包 CDP 只用一個測試 TTS 關鍵字證明 loopback→VAD→ASR 通路；ASR 精準度由隔離的 `e2e-live-pipeline` 驗多關鍵字。把三個詞都綁在系統混音測試上會因背景影片／音樂假紅燈。
- ASR 佇列不能無限堆積：現行 VAD 先切完整語句，ASR 忙時最多保留 2 句；第 3 句進來丟最舊未處理句，以即時性優先。正常本地 ASR 快於語音實時速度，不會觸發淘汰。
- **非語言性片段餵給小翻譯模型會變「對話模式」**：擷取系統音訊時的音樂／靜音／音效被 ASR 轉成純符號（`♪♪♪`）、`……`、`>>`、零寬/格式字元等碎片。這些過得了「≥2 非標點字元」的弱 guard（`\p{P}` 不含 Symbol `So` 與 Format `Cf`），流進 0.8B 翻譯模型後，模型不翻譯而是**當成聊天開場**回「你好，我是即時字幕翻譯引擎…請提供原文…您應該如何稱呼？」persona 問候（system prompt 給了它 persona 名稱，它就照唸）。**僅翻譯顯示模式**下整個畫面被這些 babble 佔滿，看似「翻譯壞了」。真因是輸入端，不是翻譯邏輯（模組層 e2e：正常英文全數正確、context 污染不擴散——每個碎片各自獨立觸發，非級聯）。解法：進管線前用 `hasLinguisticContent`（`text.replace(/[^\p{L}]/gu,'').length>=2`，只認字母/漢字/假名/諺文）丟棄非語言片段——`transcribeUtterance` 在進 `handleAsrResult` 前就 return（連字幕行都不建）+ `shouldTranslate` 同構；main `translate` 再擋一次（縱深）。live system prompt 改祈使句、避免「你是…引擎」自稱（降極短輸入 chatty）。殘留：單一填充詞（如 "um"）仍可能觸發一次 chatty，罕見；要根除需更大模型或輸出端 persona 偵測。
- **「翻譯不見了」先別假設翻譯邏輯回歸**：症狀（僅翻譯模式只剩原文）可能是顯示層 + 佇列丟批次造成。除錯順序：先在模組層 e2e 直測翻譯（本案證明英文→繁中正常、零複誦）排除 LLM，再查顯示模式（`captionDisplayMode`）與佇列行為。本案真因是冷啟動丟批次（見上），非翻譯壞掉。讀使用者實際 `%APPDATA%/voiceink/config.json`（遮蔽 apiKey）比猜設定快。
- 錯誤必須浮上 UI（狀態區＋連續失敗自動停止），只進 console 等於使用者看到永遠的「擷取中…」。
- **await 後要重檢 session 狀態**：`transcribe`／`translate` 這種長 await 之後、以及 promise 的 `finally` 裡，一律先 `if (!isCapturing || epoch !== sessionEpoch) return`。否則停止後才 resolve 的 stale 結果會建新 batch、觸發翻譯、幽靈重載已卸載的模型，或清掉新 session 的鎖。epoch 機制存在就是為了擋這個。
- **失敗時別把原文冒充譯文寫進 history**：翻譯空白/失敗時 push 原文當「譯文」，下一輪它變成 chat history 的 assistant 前文，等於 few-shot 教模型複誦原文（=括號式 prompt bug 的資料版）。譯文留空即可（`buildContextPair` 會因空譯文回 null 而略過）。
- **identity 前文（譯文==原文）會教小模型複誦**：同上的隱形版。日文全漢字片段（無假名、cjkRatio 高）被 `needsTranslation` 誤判為「已是中文」，於是 `pushPair(原文,原文)` 塞進 history；這對 (X→X) 就是 few-shot 示範「原樣輸出」，下一段日文被 0.8B 整段複誦→雙語字幕變兩行日文。英文不會（永遠需翻，不走 identity 分支）。三層防護：源頭別 push identity 前文；模型自我複誦（`translated===source`）比照空譯文；`buildContextPair` 對 `prevSrc===prevTr` 回 null。e2e 可穩定重現（identity ctx 時 `ECHO=true`）。修復語言無關（KO/ES/FR/EN 皆驗過）。但殘留 0.8B 對「整句共用漢字」的日文句先天複誦（~1/6），prompt 強化與 echo 重試皆救不了（實測重試無效還加延遲）→ 靠 self-echo 守門顯示原文即可；要真正提升日文品質得換更大翻譯模型。強化 live system prompt（明講來源可能是共用漢字的日/韓文、嚴禁原樣輸出）可讓繁體較一致、不加延遲，屬低成本淨賺。
- **別用 0.8B 翻譯模型當語言偵測器**：實測簡單分類 prompt 準確率僅 ~43%（中文→判英文、日文含假名→判英文、韓文→判中文），比漢字比例啟發式更糟又多一次推論延遲。且中文→中文不保證 echo（會改寫，如 `人工智慧→人工智能`），不能靠「全翻+echo 去重」取代啟發式。要可靠只能靠手動來源語言選單或換更大模型。動手前先用 e2e 量準確率，別假設小模型會偵測。
- **譯文轉繁與 echo 去重的順序**：0.8B 譯文偶爾夾簡體字→翻譯 choke point（`translate` 收尾）統一過 `s2twp`（抽到 `src/main/opencc.js` 與 ASR 共用）。但**要先判 echo 再轉繁**：模型自我複誦（`result===text`，含日文頑固句）時回原文且**不轉繁**，否則 s2twp 會 mangle 原文使 renderer 的 `translated===source` 去重失效、把亂碼日文當譯文顯示。
- **前文原文/譯文要成對過濾**：兩個 history 分開存、只單邊過濾會錯位（user 只有 X、assistant 卻含 X+Y）。存成 `{source, translation}` 成對陣列，過濾與取樣一起做。
- **啟動要有重入旗標**：按鈕 `disabled` 若在多個 await 之後才設，雙擊會起兩條錄音管線且第一條永不停。用 JS 旗標（`isStarting`）在函式入口擋，別只靠 DOM disabled。
- **下游佇列也要防堆積**：上游 ASR 語句 pending 上限 2，下游 `translateQueue` 上限 5，超量皆丟最舊未處理項；否則任一後端跟不上時延遲會線性擴大。
- **視窗還原座標要驗螢幕存在**：存的 bounds 可能在已拔除的外接螢幕（負座標）→ 開在看不見處。用 `screen.getAllDisplays()` 檢查重疊，否則置中。
- **字幕視窗 OS 層關閉（Alt+F4）要通知 renderer**：只有 `subtitle:close` IPC 會發 `subtitle:closed`；視窗 `'closed'` 事件也要補發（用 `subtitleWindow !== win` 區分 OS 關閉與 IPC 關閉），否則管線在無視窗下持續擷取。
- **跨行程 send 前檢查 `isDestroyed()`**、雲端 `fetch` 要帶 `AbortSignal.timeout`（翻譯走 serial chain，卡死會連帶鎖死停止與卸載）。
- **顯示模式讓「顯示端」獨佔**：雙語／僅翻譯純屬字幕彈窗的渲染選擇，就該由彈窗擁有（讀寫 store `captionDisplayMode`、單一 `currentMode` 渲染）；別讓來源端每筆 payload 夾帶 `displayMode` 又跨窗 IPC 覆寫——兩邊搶著改同一狀態必打架。source/translation 一律都送，模式只影響顯示。
- **背景預熱綁分頁生命週期**：模型載入是最大體感延遲。進入即時分頁就 `engine.acquire` 預熱、離開且未擷取就 `release` 卸載（`switchPage` 為 hook）。`users.live` 用布林非計數，預熱與擷取共用 owner、單次 release 歸零；用 `prewarmed`／`engineAcquired` 兩支互斥旗標記錄由誰持有，擷取開始時把所有權轉交（`prewarmed=false`）、失敗或停止時一起清。
- **獨立模型並行 warm**：ASR（sherpa）與 LLM（llama）互不相干，`Promise.all` 並行載入即可近乎減半等待；各自 `warm()` 已 catch 回傳 `{ok,warnings}`，並行不會 reject。實測同時載入無原生競態。
- **打包跑的是 `src/` 原始碼**：`build.files` 排除 `dist/**`，main `loadFile('../renderer/...')` 直接載入 asar 內原始 ESM/HTML；`vite build` 只作驗證。改 renderer 改 `src/` 就生效，別被 `dist/renderer` 只有 index.html 誤導。
- **e2e 用 `npx electron <script>` 時 app 名是 `Electron`**：`userData` 會指向 `Roaming/Electron`（找不到 `voiceink` 的模型）→ 開頭補 `app.setPath('userData', join(app.getPath('appData'),'voiceink'))`。UI 端可用內建 `WebSocket`（Node 22）走 CDP 驅動打包版驗證。
- **單輪 SFT 翻譯模型別餵前文 chat history**：LinguaForge 0.8B 訓練格式是 system + 單一 user（`翻譯成…：\n<text>`）。多塞一輪 user/assistant 前文後，greedy 會直接複誦上一輪的 assistant 譯文（off-by-one echo）→ 長文分段時整篇都是第 1 段譯文。前文對 chat 型模型（qwen35translate／雲端）有益，對單輪 MT 模型是毒；別把「前文走 chat history」當通則套到所有模型。重現：`scripts/e2e-linguaforge-context.js` 連續 4 段帶前文，看 dupes。
- **自家「清理」也會製造污染**：譯文後處理無條件剝單側引號，把合法的 `「引言」，某某說。` 開頭 「 剝掉，留下孤兒 」——看起來像模型出錯，其實是我方 regex。剝括號/引號一律先判配對。另：測試腳本為了避開 electron 依賴而**複製**一份清理邏輯，等於改一次要改兩處且測到的不是真程式碼 → 把純文字邏輯抽成無依賴模組（`translate-clean.js`）讓測試 require 真貨。除錯先看模型原始輸出（`VOICEINK_DEBUG_RAW=1`）再決定是修 prompt 還是修清理。
- **在地化詞彙表會竄改正確譯文**：OpenCC `twp`（台灣詞彙）對已是繁體的文字照樣替換，「總參數」→「總引數」、「記憶體參數設定」→「記憶體引數設定」。看起來像模型翻錯，其實是後處理。作法：先用純字形 `tw` 探測，字串沒變＝沒有簡體字 → 原樣回傳，只有真的含簡體才套 `twp`。
- **切段策略要用實測收斂，別靠推理**：LinguaForge 條列貼文退化，依序試了「空行為硬邊界」（bullet 區塊單獨送 → 被總結掉）、「純逐行」（`·` 被翻成「選擇器：」），最後才是「逐行＋清單標記剝除後再送、翻完貼回」。每一版都跑同一個 e2e 對照，才看得出哪個假設錯。
- **e2e 別把小模型的用詞正確性當紅燈**：0.8B 會音譯專名（Kimi→金智美）、偶發整句幻覺，這些永遠修不好，寫進斷言只會讓測試長期是紅的而失去訊號。斷言只驗工程層能保證的：結構（行數／清單標記）、污染（persona 標籤／指令／special token）、退化（重複迴圈）、後處理竄改（引數）。
- **重試推論前要還原 chat history**：`session.prompt` 會把這一輪寫進 history，直接重跑等於帶著剛才那段爛譯文當前文 → 複誦。重試分支第一件事就是 `setChatHistory(history)`。
- **對照實驗的樣本不能從其中一組的失敗集挑**：先用 7 句（全部挑自 Q4 翻壞的句子）比 Q4/Q8/f16，看起來「Q8 完勝、量化是元兇」；換成 30 句預先設計的均衡樣本後，客觀缺陷 22/20/22——差距落在雜訊內，先前結論是選擇偏誤。凡是「A 比 B 好」的宣稱，樣本必須在看到任一方輸出之前就固定。
- **量化不背模型的鍋**：0.8B 的專名丟失（NVIDIA/TSMC/H200）、幻覺年份、`說明：`／`選擇`／`圖為` 標籤前綴、多行輸入只翻第一行，f16 全精度照樣發生。個別句子 Q4 崩而 Q8 對（或反過來）是解碼路徑被擾動的隨機結果，不是系統性優勢。要判斷「模型 vs 量化」，看的是**同一批樣本的整體缺陷率**，不是幾個亮眼個案。

## 2026-08-03 — 「三個精度都一樣壞」不等於權重問題

- 錯誤推論：Q4／Q8／f16 缺陷數相近 → 判定是模型／語料，決定維持 Q4 並停止追查。
- 實情：三次跑的都是**同一個壞 prompt**（缺 Qwen3.5 的空 think 前綴 4 token），變因根本沒被控制。
- 教訓：比較實驗前先確認「送進模型的字串」與權威來源逐字元一致；prompt 是所有解碼參數的上游。
- 通則：模型輸出出現憑空前綴／專名消失，先印 prompt，不要先寫 regex 剝前綴（剝掉的只是最顯眼的症狀）。
- 也別盡信文件：INTEGRATION.md 說 node-llama-cpp 的 `thoughts` 六個選項都補不了，實測 3.19 的 `thoughts:'discourage'` 剛好就是；先跑 probe 再決定要不要自訂 subclass。

## 2026-08-20 — 使用者要的功能可能物理上不存在

- 需求：「語音轉文字跟翻譯一樣，可以選 CPU 或 GPU」。做法是先**實測**而不是先寫 UI：傳 `provider: 'cuda'` / `'directml'` 給 sherpa，得到
  `Please compile with -DSHERPA_ONNX_ENABLE_GPU=ON. Available providers: CPUExecutionProvider, . Fallback to cpu!`
  ——npm 的 `sherpa-onnx-win-x64` 是 CPU-only 編譯，三種 provider 耗時相同（673 / 769 / 654ms）。
- 如果照做，會交出一個「切了也沒差」的開關，比不做更糟：使用者會以為 GPU 沒生效是別的問題。
- 正確處置：交出**真的有效**的替代（`asrThreads`），在同一個位置用文字講清楚為什麼沒有 GPU、要快請走雲端，並把實測輸出寫進 CONTEXT/CLAUDE 以免下一個人再試一次。
- 通則：功能請求先驗可行性再排版面。「先做 UI 之後再接後端」對這種硬體/相依性限制是反的。

## 2026-08-20 — 「字體大小都差不多」的根因是權重反轉，不是字級不夠大

- 症狀回報：設定選單「視覺上有些混亂、很難一眼看清楚」。
- 直覺修法（把標題調大）只對一半。實際量出來：分區標題 13px + `--text-secondary`，欄位 label 14px + primary，說明 12px + secondary
  ——**標題比它管轄的欄位更小更灰**，階層是倒的，所以整頁看起來是同一層。
- 修法是把大小與顏色兩條階層同時擺正（標題 20/700 primary → 輸入 14 → 子標題與 label 13/600 secondary → 說明 12 tertiary），
  再加資訊架構（左側分類 rail 一次顯示一區）減少單頁密度。
- 可測：CDP 直接量 `getComputedStyle(...).fontSize`，斷言 `title > label > hint`——視覺階層是能寫成回歸測試的。

## 2026-08-20 — 極小測試圖會被 vision API 拒絕

- 用 8×8 PNG 當附件 fixture 測多模態，真實端點回 `400 Unable to process input image`，看起來像格式做錯。
- 對照實驗才看得出來：只有 text 的陣列格式回 200 → 格式是對的，問題在圖太小。
- 教訓：測 vision 的 fixture 要用真實尺寸（512×512 起跳），並且走與正式路徑相同的產生方式（這裡是 canvas → JPEG）。

## 2026-08-21 — 「拖曳時變半透明」不是 CSS 調不調的問題，是拖曳實作選錯

- 症狀回報：額度卡按住拖動會變半透明。第一直覺是去改 `.dragging { opacity }`，但那只解一半。
- 真正原因：用的是 HTML5 Drag and Drop——瀏覽器一定會生一張半透明拖影跟著游標，來源元素還留在原位，
  所以當初才用 `opacity: .18` 把來源淡掉；兩者相加就是「整張卡都半透明」。`setDragImage` 也控不到透明度。
- 修法是換實作：pointer 事件直拖，被拖的就是卡片本體（`translate3d` 跟游標、完全不透明），
  其他卡片維持 FLIP 推開。參考專案（dnd-kit）本來就是這個模型，「對齊使用體驗」＝對齊互動模型，不是對齊色票。
- 兩個實作細節：預覽排序會 `appendChild` 搬動卡片，`setPointerCapture` 可能被隱式釋放 → 監聽掛 `window`；
  插入點用幾何比對而非 `elementFromPoint`，就不用為了命中測試把卡片設 `pointer-events: none`。
- 附帶好處：合成 PointerEvent 能完整驅動這條路徑，打包版 CDP 可以直接斷言「拖曳中 opacity=1、cursor=grabbing」。
