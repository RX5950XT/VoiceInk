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

## 2026-08-25 — 啟動慢往往不是「Electron 本身」，是把用不到的工作排在第一扇窗前面

- 預設頁是聊天，卻在 DOMContentLoaded 等 nvidia-smi、掃模型檔、load 額度、拉 Google Fonts。
- 主行程還在開窗前掃 CUDA PATH、開 AGY SQLite 做 cleanup。
- 修法：先 initStore + 建窗；其餘 setImmediate／進該頁再做。字體用本機，不要讓 CDN 擋住 first paint。

## 2026-08-25 — 拖曳中改 DOM 順序就是卡頓與閃爍的來源

- overlay + 鬼影還是卡：每個 pointermove 都 `appendChild` + FLIP，layout 每換一次槽位就重算；碰撞又去量「含 transform 的畫面座標」，卡片滑到一半就被判定成另一張，於是來回抽換。
- Token Anxiety / dnd-kit 拖曳中**不改 DOM**，只把 item 用 transform 送到開始時記住的格子；碰撞打那份靜態槽位。放開才 `appendChild` 一次。
- CSS transition 推開可以中途改目標；WAAPI FLIP 每次 cancel 重來，快拖時必閃。

## 2026-08-25 — 額度拖曳要 overlay + 鬼影，不能讓同一張卡身兼兩職

- Token Anxiety（dnd-kit）是兩層：`DragOverlay` 跟手（近乎不透明）、格子裡的 item 變 `opacity: 0.18` 當落點預覽。
- VoiceInk 先前把**同一張卡** `translate` 跟游標，又用 `appendChild` 改它的排版槽位。槽位一動，跟手的 transform 就過期，閃爍解不完；中間空隙也點不到，所以「不靈敏」。
- 半透明該出現在**落點**，不是跟手那張。跟手 overlay 獨立 `position:fixed`；格子裡的鬼影才是預覽。碰撞用 pointerWithin，沒命中再 closestCenter。

## 2026-08-25 — Gemini 模型清單「按名稱」其實是世代＋思考強度

- 第一輪做成字典序／由舊到新，看起來是排過了，但使用者掃清單時要的是「新的在上面、同代 high→low」。
- `localeCompare` 會把 `3.10` 排到 `3.2` 前面、`flash-high` 排到 `flash-low` 前面只是碰巧（h < l），`tiered`／`extra-low`／`lite` 就亂了。
- 修法：先拆世代號做新到舊，再從 id 裡認思考強度 token（`extra-low` 必須先於 `low`）。

## 2026-08-25 — 拖曳「偶發閃爍」是進行中的 FLIP 被下一輪蓋掉

- 症狀：額度卡拖動大多順，但跨過另一張時會突然跳一格再接上。
- 真因有三層，都是 transform 被兩套系統同時改：
  1. 上一輪 110ms FLIP 還沒跑完就開下一輪。`capturePositions` 讀到的是「含舊 invert 的畫面位置」，`getBoundingClientRect` 當 last 時舊動畫還在，新 `element.animate()` 一替換就把剩餘位移丢掉 → 卡片先閃到終點再從頭播。
  2. CSS `.usage-card:hover { transform: translateY(-2px) }` 帶 160ms transition，跟 WAAPI 搶同一個 `transform`。
  3. `appendChild` 改排版槽位後，被拖卡片的 `translate3d` 仍相對舊槽位；`followPointer` 還先把 transform 清成 `none` 再量，layout flush 時會閃回格子裡。
- 修法：量 last 前 `getAnimations().cancel()`（`first` 仍用取消前的畫面位置）；`.is-sorting` 關掉 hover lift 與 transform transition；重排後立刻用矩陣扣掉現有 translate 校正被拖卡片，不要清成 `none`。
- 可測：假元素的 `getBoundingClientRect` 在 `cancel()` 前後回不同座標，斷言 invert 用的是取消後的 last。

## 2026-08-21 — 「拖曳時變半透明」不是 CSS 調不調的問題，是拖曳實作選錯

- 症狀回報：額度卡按住拖動會變半透明。第一直覺是去改 `.dragging { opacity }`，但那只解一半。
- 真正原因：用的是 HTML5 Drag and Drop——瀏覽器一定會生一張半透明拖影跟著游標，來源元素還留在原位，
  所以當初才用 `opacity: .18` 把來源淡掉；兩者相加就是「整張卡都半透明」。`setDragImage` 也控不到透明度。
- 修法是換實作：pointer 事件直拖，被拖的就是卡片本體（`translate3d` 跟游標、完全不透明），
  其他卡片維持 FLIP 推開。參考專案（dnd-kit）本來就是這個模型，「對齊使用體驗」＝對齊互動模型，不是對齊色票。
- 兩個實作細節：預覽排序會 `appendChild` 搬動卡片，`setPointerCapture` 可能被隱式釋放 → 監聽掛 `window`；
  插入點用幾何比對而非 `elementFromPoint`，就不用為了命中測試把卡片設 `pointer-events: none`。
- 附帶好處：合成 PointerEvent 能完整驅動這條路徑，打包版 CDP 可以直接斷言「拖曳中 opacity=1、cursor=grabbing」。

## 2026-08-21 — 「清掉快取」不等於「換一個 token」

401 之後只做 `cache.token = ''` 看起來像是把 token 作廢了，實際上下一輪會重讀本機憑證檔，
看到裡面的 `expiry` 還沒到就直接再用同一個 token——上游剛剛才拒絕過它。重試次數用掉了，
但送出去的東西一模一樣。

**教訓**：作廢一份憑證時要問「下一次取用會走到哪條路徑」。憑證有兩個真實來源（本機記錄的到期時間、
上游的實際判定），上游說失效就必須壓過本機記錄，所以要有一個明確的 `mustRefresh` 旗標，
而不是靠清空快取間接達成。同一個模式也適用於任何「本地認為還有效、遠端已撤銷」的資源。

## 2026-08-21 — 代理不該把上游的狀態碼原樣丟回去

反代最初直接透傳上游狀態碼。上游 token 過期回 401，客戶端收到 401 的第一反應是「我的 API key 打錯了」——
去檢查一個完全正確的設定。狀態碼是講給「這一段連線」聽的，不是講給上一段聽的。

**教訓**：閘道要重新詮釋錯誤，而不是轉發。只有對客戶端有行動意義的才透傳（429 → 等一下再試，
且要連 `retry-after` 一起帶），其餘一律收斂成 502「上游壞了」。同理，上游的 error body 一個字都不該外流，
它可能帶著 token 或別人的帳號資訊。

## 2026-08-21 — 移植時，來源的「奇怪選擇」通常是它踩過的坑

移植 AGY 的反代時，它的端點清單是 `[sandbox, daily, prod]`，註解寫「優先級 1: Sandbox (已知有效且穩定)、
prod 僅作為兜底」。我判斷那是額度查詢用的備援順序，反代是熱路徑不該多試網域，於是寫死只打 prod，
還特地留了一句註解合理化。真實跑起來 prod 一律 429、sandbox 才 200——它的順序不是偏好，是實測結論。

同一批還有三個一樣的錯：照抄了模型映射表（裡面有 404 的模型）、保留了 `x-goog-user-project`
（每個端點都 403）、無條件送 `thinkingBudget: 0`（thinking-only 模型 400）。

**教訓**：移植別人的整合層時，最有價值的不是程式碼結構，是那些「看起來多餘的迴避動作」——
fallback 順序、被註解掉的 header、寫了 issue 編號的重試分支。那是別人用生產流量換來的地圖。
要刪掉任何一個之前，先問「什麼情況下這行是必要的」，答不出來就不要動它。

## 2026-08-21 — mock 測得再綠，也證明不了對面長什麼樣

反代的 42 項 e2e 全綠、單元測試全綠，但第一次接真實上游就四個錯誤同時炸開。
原因很簡單：mock 是照我對協議的理解寫的，我理解錯的地方，mock 會忠實地跟著錯。
兩邊都是同一個誤解，測試自然對得起來。

**教訓**：對外部系統的整合，測試分兩種——「我有沒有照我以為的規格實作」（mock 能測）
和「我以為的規格對不對」（只有真流量能測）。前者綠了不能宣稱後者。
這次補的 `scripts/probe-agy-upstream.js` 就是後者：它不驗程式碼，它驗我對上游的假設，
而且會自我校驗（把實測結果跟程式碼裡的名單比對，不一致就印出來）。
交付整合功能時，如果一次真實往返都沒跑過，就要在文件裡明講這件事。

## 2026-08-21 — 錯誤訊息要寫給「還沒做到那件事」的人看

憑證讀不到時，頁面顯示的是「找不到 Antigravity 登入憑證，請先在 Antigravity 登入」。
這句話只對「已經裝好、只是登出了」的人有用。對還沒裝的人，它沒回答任何一個真正的問題：
要裝什麼？去哪裝？裝完要做什麼？

而且我自己也搞錯過一次——先入為主認定憑證是 IDE 在維護，跟使用者說「IDE 會保持 token 新鮮」，
實際查下去才發現這台機器根本沒裝 IDE，是 CLI 在做這件事，`Programs\Antigravity` 只是解除安裝
留下的空目錄。差點就把「請安裝 IDE」寫進引導文案。

**教訓**：寫錯誤訊息前先問「看到這句話的人，此刻手上有什麼、缺什麼」，然後給出從那個狀態出發的
下一步——具體到指令與網址。狀態不只一種就分支（未安裝／未登入／token 過期各給各的），
別用一句話涵蓋所有情況。附帶一提，偵測「有沒有裝」要看執行檔，不要看資料夾：
解除安裝常留空目錄，看目錄會把「已移除」判成「已安裝」，然後給出完全錯誤的指引。

## 2026-08-21 — 同一種故障，上游可能給你兩種說法

`gemini-3.6-flash-*` 在探測時全部回 400 `Request contains an invalid argument`，
看起來就是「這個模型不能用」，我差點把整個家族從清單刪掉。實際原因跟
`gemini-pro-agent` 一模一樣——拒絕 `thinkingBudget: 0`——只是上游對前者回
`Budget 0 is invalid. This model only works in thinking mode.`（講得很清楚），
對後者回一句沒有資訊量的 `invalid argument`。

**教訓**：把「症狀分類」建立在錯誤訊息的字面上很脆弱。判斷一個東西是不是壞了，
要用**變因對照**而不是讀訊息：同一個模型換幾種請求參數各打一次，
就看得出來是模型不可用還是某個參數不被接受。這次多花三分鐘做對照，
保住了四個可用模型。

順帶一提，命名也要照著真相走。原本那份名單叫 `THINKING_ONLY_MODELS`，
但 3.6-flash 明明能關思考（`includeThoughts: false` 完全正常），
它只是不接受把預算設成 0。名字不精確會讓下一個人用錯誤的心智模型去推論，
所以改名為 `REJECTS_ZERO_BUDGET`。

## 2026-08-21 — 翻譯層不該覆蓋使用者的明確指名

重建模型映射表時，我把 `gemini-3-flash` 導向了更新的 `gemini-3.7-flash-medium`，
理由是「換成最新的」。但 `gemini-3-flash` 在上游真實存在——使用者打這個名字，
就是要這個模型，不是要我幫他挑一個「更好的」。

映射表的職責邊界其實很窄：**只翻譯上游查無此名的東西**
（`claude-sonnet-4-5-20250929` 這種客戶端寫死的死名字）。
只要上游認得，就原樣送過去。

**教訓**：相容層做「善意的替換」是越界。使用者指名一個確實存在的東西時，
系統的工作是照做，不是猜測他其實想要別的。這個錯是既有測試
「上游真實 ID 原樣保留」擋下來的——寫測試時把「這條規則為什麼存在」
也寫進斷言名稱，未來的自己才擋得住自己。

## 2026-08-21 — 「該續期了」不等於「已經不能用了」

`tokenIsStale` 對 access token 留了 15 分鐘的提前量，意思是「快到期了，去換一個」。
但 `loadToken` 在換不到的時候直接拋 `TOKEN_EXPIRED`，把提前量當成失效線——
結果每個 token 的最後 15 分鐘都被自己作廢。使用者回報當下，憑證還有 7 分鐘壽命。

更值得記的是：**同一個判斷在專案裡已經有兩套標準**。額度頁的 `syncAntigravity`
早就寫對了（refresh 失敗就沿用舊 token，只把 accuracy 標成 estimated），
反代這條路徑卻是硬失敗。寫第二個消費者的時候沒去看第一個怎麼處理同一件事。

**教訓**：refresh deadline 與 expiry deadline 是兩條線，不能共用一個布林值。
還有，新寫一條路徑要用既有的共用工具時，先看現有呼叫端怎麼用——
不一致的地方通常不是「兩種需求」，而是其中一邊有 bug。

## 2026-08-21 — 沒滿足前提的觀察，不能拿來推翻假設

引導文字寫「執行任一個 agy 指令，它會自動把 token 續期」。我跑了 `agy models`，
成功，但憑證裡的 expiry 一動也沒動，於是推論「CLI 不會回寫憑證」，
準備把引導改掉。

問題是當下 token 還有 7 分鐘壽命——CLI 判斷還能用，本來就不會去換。
我測的情境根本沒滿足「token 過期」這個前提。等真的過期後再跑一次，
expiry 前進了整整一小時，原本的引導是對的。

**教訓**：要否證一個「在 X 情況下會 Y」的說法，就得先真的把系統推進 X。
在 X 還沒發生的時候觀察不到 Y，什麼都證明不了。
這次成本只是多等三分鐘，代價卻是差點把正確的使用者指引改成錯的。

## 2026-08-21 — 同一件事被兩層各做一次，上層會把下層的資訊吃掉

`mergeExpectedWindows` 的職責是「上游沒回的視窗，先撿快取、真的沒有才當用盡」。
它需要 previous 才做得對，而 previous 只有 `usage/index.js` 那層有。
`syncAntigravity` 卻在回傳前先用 `previous=null` 呼叫了一次——補完之後四個 id 都存在，
index 那層再也分不出「這是上游給的」還是「這是補的」，於是快取撿不回來、
accuracy 也不會降級，憑空的 100% 用盡被標成「官方 API」。

**教訓**：一個補值函式若依賴呼叫端才有的上下文，就只能有一個呼叫端。
在拿不到那個上下文的地方先跑一次「無害的預處理」，實際上是把下游的判斷依據抹掉。

## 2026-08-21 — 測試測的是被繞過的那一層，就會一直是綠的

`test-usage.js` 早就有兩條測試在驗「缺 slot 要保留舊值」「補齊後要降級成 estimated」，
但它們都直接餵 `mergeAccountState`。production 的路徑是
`syncAntigravity → mergeAccountState`，前者先把事情做壞了，後者收到的輸入已經是乾淨的四條，
所以測試永遠綠，bug 永遠在。

## 2026-08-21 — 修掉「先補一輪」之後，失敗路徑仍會走同一個補值函式

`syncAntigravity` 不再預先 merge 了，但 API 失敗仍回 `status=connected`、`windows=[]`。
`mergeAccountState` 只擋 `disconnected`，空陣列照樣進 `mergeExpectedWindows` → 四條 100%。
上一輪的回歸測的是「成功但只回部分 slot」，測不到「失敗回空窗」。

**教訓**：同一補值函式的每一個入口都要有「現在有沒有東西可以補」的前置條件。
把呼叫點從 A 搬到 B 並不表示 B 的失敗路徑自動安全。新測試要從失敗回傳值進去，不要只測快樂路徑的部分成功。

## 2026-08-21 — 切頁若只卸資源、不作廢工作，下一輪會把資源載回來

翻譯 cooldown 做了 `engine.release`，但分段迴圈仍 `await translate()`。
owner 歸零後 `getSession` 沒有人佔用也會 load → 幽靈重載。
AGY 的 `refreshAgyPage` 不 await，cooldown 先 `stopPolling`，in-flight 的 `refreshAll` 結束又 `startPolling`。

**教訓**：離開頁面的清理清單是「作廢世代 ＋ 停工作 ＋ 卸資源」，缺第一個就會把後兩個抵銷。
額度頁已經用 `#page-usage.active` 當守衛，新頁不要漏掉。

同一回合我自己也踩了一次：新寫的併發測試放在「已經有 inflight」的時間點，
舊程式一樣會擋下來。跑了修復前的版本才發現它是綠的。

**教訓**：測試要從 production 真正的進入點打進去。
還有——**新寫的回歸測試一定要先在修復前跑一次**，紅了才算數，
不然只是把當下的行為寫成斷言。

## 2026-08-21 — 被問「這是要修的嗎」，代表清單沒把判斷寫進去

我把掃描結果分成「修掉的」與「沒動、但值得知道的」，後者列了七項 file:line 與症狀，
但沒有寫每一項到底是不是 bug、為什麼沒動。使用者第一個問題就是「這是要修的嗎」。

問題不在於留了觀察清單，而在於清單只有現象沒有判斷。讀的人拿到七個 file:line
還是得自己重跑一次我的思考。後來逐項判定，結果是三個真的會出事、四個不是——
這個比例本來就該寫在清單裡。

**教訓**：回報未處理項目時，每一項都要帶上「是／不是 bug」與依據，
而不是只列位置與現象。「值得知道」不是免於判斷的藉口；
如果我自己也還沒判斷，那就是還沒查完，不該先報出來。

## 2026-08-21 — 安全規範寫在文件裡，不等於舊模組跟上了

CLAUDE.md 早就寫著「額度與聊天的 HTTP 錯誤只記安全狀態摘要，禁止把 response body／
token／外部 error message 寫進 console、diagnostics 或 IPC」。`chat.js`、`usage/*`、
`agy/*` 都遵守，`cloud-asr.js` 與 `local-llm.js` 沒有——因為那條規則是後來寫的，
寫的時候只巡了當下在改的模組。

規則的措辭也幫了倒忙：「額度與聊天」聽起來像只管那兩個功能，但真正的判準是
「這個字串是不是上游可控、又會顯示給使用者」。cloud-asr 與雲端翻譯的 API URL
同樣是使用者自填的，回什麼內容完全由對方決定。

**教訓**：寫安全規範時，用「什麼情境適用」描述範圍，不要用「哪個功能」——
功能名會讓後來的人以為別的模組不在管轄內。既有規則新增時，
順手 grep 全庫同類路徑一次，別只修觸發當下的那個檔案。

## 2026-08-24 — 使用者仍在操作電腦時，不得移動滑鼠或搶前景焦點

完整桌面 QA 要求應用程式開在副螢幕，不代表可以改變使用者的游標位置或發送全域快捷鍵。
這些操作會打斷使用者正在進行的工作，即使只持續幾秒也不可接受。

**教訓**：使用者同時在用電腦時，視窗定位一律走 CDP `Browser.setWindowBounds`、
應用程式自身的視窗 API 或其他不影響輸入裝置與前景焦點的方式；不得使用
`Cursor.Position`、滑鼠拖曳、全域鍵盤快捷鍵或會搶焦點的桌面自動化。

## 2026-08-25 — 啟動慢的主因是 unpacked native，不是某一行 setImmediate

第一輪把 CUDA PATH 與 AGY 移到 `setImmediate`，拿掉 Google Fonts，使用者仍覺得慢。
真正的開機成本是：`main.js` 頂層 require 整張模組圖（AGY＋額度＋local-llm）、
`await initStore()` 擋住 `BrowserWindow`、以及 `app.asar.unpacked` 裡 400MB+ DLL
（llama CUDA／Vulkan、ffmpeg）被 Defender 掃。

**教訓**：量的是「點 exe 到視窗出現」，不是「我們延後了哪段 JS」。
Windows 上 unpacked `.node`／`.dll` 就算這次沒 load，只要躺在 exe 旁邊就會被掃。
能留 asar 的就留 asar，spawn／dlopen 第一次再拷到 **userData**。
寫進 `app.asar.unpacked` 等於假設安裝目錄可寫——Program Files 一般使用者寫不進去，GPU 會默默退回 CPU。ffmpeg 一開始就拷 userData，GPU 套件必須同一套。
`show: false` 等到 ready-to-show 等於把 Chromium 解析整份 HTML/JS 的時間也算進「沒開」。

## 2026-08-26 — 可見狀態必須跟真正的資料上下文一起失效

聊天的二次確認只記在 DOM，切換會話後仍會殘留；翻譯結果只在輸入變更時清理，改語言後仍像是有效結果；
AGY 多個平行請求共用同一個錯誤區，其中一個成功就會把另一個失敗清掉。三者根因相同：畫面狀態沒有綁定它代表的資料上下文。

**教訓**：會影響結果的輸入、選項或實體一改，就要同步取消舊操作並讓衍生畫面失效；
平行請求的共用錯誤只能由整批流程統一清理，不能讓單一成功請求自行清除。

## 2026-08-26 — 「重試用」的旗標不能拿來當「清快取」用

AGY 反代回報「Antigravity token 已過期」，但 CLI 明明登入著、憑證檔還有 50 分鐘壽命，
重登 CLI 也救不回來——因為 `mustRefresh` 這個「上游回過 401」專用旗標，被 `acquire` 的
一般失敗清理路徑順手設了起來。一次 PowerShell 讀憑證逾時，就讓之後每一輪都強制 refresh，
而環境沒有 client id／secret 時 refresh 必定失敗，於是永久拋 `TOKEN_EXPIRED`。

**教訓**：語意窄的旗標（「這個 token 真的死了」）只能由產生該語意的那一條路徑設定。
清快取要清快取的欄位，不要圖方便呼叫一個「順便」多做一件事的函式。
另外：只存在記憶體的黏性錯誤狀態，使用者做什麼都好不了，一定要能自己恢復。

## 2026-08-26 — 逐一列舉的 IPC 白名單，新增方法要同步補

`agy:test` 在 e2e（直接呼叫 service 模組）全綠，打包版卻只回「反向代理操作失敗」：
`main.js` 的 `registerAgyIpc({ service: { … } })` 是手寫的方法白名單，漏了一行。

**教訓**：白名單是好設計，但它讓「模組加方法」與「對外開放」變成兩件事。
新增 main 端對外方法時，一併檢查 `main.js` 的 service 物件；
而且 e2e 測 service 模組不等於測 IPC，要有一條 CDP 斷言擋住「回通用錯誤訊息」這個症狀。
