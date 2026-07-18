# CONTEXT.md — 開發紀錄交接文件

> 給下一個 AI Agent 的接手指南。保持精簡，每次任務完成後更新。

## 專案概況

VoiceInk：Windows Electron 語音轉文字應用（檔案轉錄＋即時字幕＋翻譯與 TTS）。
Vanilla JS + Vite，無前端框架。版本 **1.5.0**（GitHub Release `v1.5.0`：翻譯與 TTS 頁）。

## 架構（本地 ASR + 翻譯頁 TTS，2026-07-18）

```
src/main/
  main.js             視窗管理 + IPC（store / subtitle / models / localAsr / translate / tts）
  models.js           本地模型 registry + 下載管理（qwen3asr、qwen35translate）
  local-asr.js        sherpa-onnx 本地轉錄（固定 Qwen3-ASR-0.6B；zh-TW 經 opencc 轉繁）
  local-llm.js        翻譯分流：雲端 chat completions / 本地 node-llama-cpp
  file-transcribe.js  長檔串流：ffmpeg→16k mono f32le→28s 切段 ASR（≥2h／≥100MB）
  edge-tts.js         Edge TTS facade（node-edge-tts MIT；Uint8Array；切塊）
  tts-voices.js       語音 allowlist + ttsVoices sanitize
  engine.js           owner: live | file | translate（布林；translate 預設不載 ASR）
src/preload/preload.js   contextBridge（含 tts.synthesize / listVoices / cancel）
src/renderer/
  scripts/app.js            設定 + 分頁 + ttsVoices 表單
  scripts/translate-page.js 第三頁：按鈕式翻譯、stale 態、Edge TTS 串播
  scripts/live-caption.js   即時字幕
  scripts/transcribe.js     檔案轉錄
  pages/subtitle.html       懸浮字幕視窗
```

## 轉錄引擎

| 項目 | 說明 |
|---|---|
| ASR | 固定本地 Qwen3-ASR-0.6B（`ASR_MODEL_KEY = 'qwen3asr'`），無引擎選擇 UI、無 FireRed |
| 路徑 | renderer 解碼→16k mono Float32→IPC→sherpa-onnx |
| 翻譯 | `translator` = none / cloud（文字丟雲端 API）/ local（Qwen3.5-0.8B GGUF）；三頁共用 |
| TTS | Edge TTS（`node-edge-tts` MIT）；需連網；store `ttsVoices` 每語一聲 |

模型存放：`%APPDATA%/voiceink/models/<key>/`，registry 在 `src/main/models.js`。

## 最近變更（2026-07-18j）— TTS 播放／左色條／temperature

- CSP 加 `media-src 'self' blob:`（修 Edge TTS blob 播放被擋）
- 移除 `.toast.error`／`.live-error` 左側紅條；toast.error 改淡紅底＋紅字
- 翻譯 local+cloud `temperature: 0`；TTS bytes 正規化

## 最近變更（2026-07-18i）— 第三頁「翻譯與 TTS」

- 導航第三 tab：雙欄輸入／譯文；複製 + Edge TTS 朗讀；Ctrl+Enter 翻譯
- 翻譯沿用設定 `translator`；none 時空狀態引導設定（非整頁死灰）；字數上限 1500
- 輸入變更 → 譯文 stale；⇄ 交換語言＋兩欄文字
- engine owner `translate` + prewarmGen 鏡像 live；切頁先 acquire 再 release
- TTS：`node-edge-tts`（禁 AGPL）；IPC 回 `Uint8Array`；renderer 串播；voice allowlist
- 設定新增「語音（Edge TTS）」五語下拉；store key `ttsVoices` 深度校驗
- 驗證：`npx electron scripts/e2e-tts-translate.js` 16/16；`npm run electron:pack`

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
- **Edge TTS** 永遠需連網；與本地翻譯無關。voice 只允許 `tts-voices.js` allowlist；renderer 只傳 `lang`。
- **engine owner `translate`**：prewarm 必用 gen 作廢；`settings-changed` 非 local 要 release；勿漏 `unloadAll` 清第三旗標。

## 最近變更（2026-07-18h）— 轉錄 JSON 控制字元崩潰

- **症狀**：開始轉錄 toast `SyntaxError: Bad control character in string literal in JSON at position N`。
- **根因**：`sherpa-onnx-node` 的 `decodeAsync` 對 native JSON 做 `JSON.parse`；辨識文本含未跳脫 `\t`/`\n`/C0 控制字元時直接炸掉（長檔／雜訊段較易踩到）。
- **修法**：`local-asr.js` 載入後 patch `OfflineRecognizer.decodeAsync/getResult` → `parseSherpaJson`（先 parse，失敗則修字串內控制字元再 parse，再失敗 regex 抽 text）；輸出再 strip C0。雲端翻譯 `res.text()`+安全 parse 防同類。
- 驗證：`node scripts/test-sherpa-json.js` ALL PASS；`electron:pack`。

## 最近變更（2026-07-18g）— 長檔／大檔轉錄（≥2h／≥100MB）

- **症狀**：長檔或大檔按「開始轉錄」易黑屏／OOM——renderer `decodeAudioData` 把整段 PCM 展開（2h 立體聲 44.1k ≈ 數 GB）。
- **修法**：main 端串流管線 `src/main/file-transcribe.js`：
  1. 依賴 `ffmpeg-static`（`asarUnpack` 含 `ffmpeg-static`）
  2. `ffmpeg -i file -ac 1 -ar 16000 -f f32le pipe:1` 串流；每 **28s** 切一段送 sherpa，**不常駐整檔 Float32**
  3. 上限：**200MB**（保證 ≥100MB）、**4 小時**（保證 ≥2 小時）；進度經 `localAsr:fileProgress`
  4. renderer：`webUtils.getPathForFile` → `localAsr.transcribeFile`；不再整檔 WebAudio decode
  5. 注意：勿在 promise chain 內 `await` 會再 enqueue 自己的函式（尾段會死鎖）
- 驗證：`npx electron scripts/e2e-file-long.js` → 60s wav **3 段**、duration=60、ALL PASS；`npm run electron:pack` 更新預覽。

## 最近變更（2026-07-18f）— 檔案轉錄「黑屏」

- **症狀**：拖入檔案按「開始轉錄」後內容區幾乎全黑、像當掉。
- **根因**：按開始後先 hide 選項再 `await` 載入模型（ASR+LLM 並行可 >12s），進度 UI 未強制 paint；深色主題下只剩小檔案卡 → 視覺像黑屏。大檔再疊 decode+雙模型記憶體尖峰更糟。
- **修法**（`transcribe.js` + 進度面板 CSS）：立刻進度卡 + rAF×2；ASR/LLM 分階段（後續 18g 改串流後解碼亦在 main）。
- 驗證：進度可見、無 crash；`electron:pack` 已更新。

## 最近變更（2026-07-18e）— 非語言 ASR 碎片 → 翻譯 persona 問候

- **症狀**：僅翻譯模式下字幕出現「你好，我是即時字幕翻譯引擎…請提供原文…您應該如何稱呼？」等聊天開場，看似翻譯壞了。
- **根因**：系統音訊中音樂／靜音／音效被 ASR 轉成純符號碎片（`♪♪♪`、`……`、`>>`、零寬 `Cf` 等）。舊 guard `replace(/[\s\p{P}]/gu,'')` 只去掉空白與**標點**（`P`），漏掉 **Symbol `So`** 與 **Format `Cf`**，碎片仍 ≥2「字元」流進 0.8B；system prompt 又給了 persona 名，模型當聊天回問候。模組 e2e：正常英文全數正確、context 污染不擴散（各碎片獨立觸發）。
- **修法**：
  1. `live-caption.js`：`hasLinguisticContent` = `text.replace(/[^\p{L}]/gu,'').length >= 2`（只認字母／漢字／假名／諺文）。在 `processAudioChunkData` 進 `handleAsrResult` **前**丟棄 → 純符號連字幕行都不建；`shouldTranslate` 同構再擋一次。
  2. `local-llm.js`：`translate` 入口同構短路徑（縱深）；live system prompt 改祈使句、弱化「你是…引擎」自稱。
- **殘留**：單填充詞（如 `um`）仍可能觸發 chatty，罕見；要根除需更大模型或輸出端 persona 偵測。
- 與 18d 的 `prewarmGen` 互不衝突，同一檔並存。

## 最近變更（2026-07-18d）— 全專案審計修補

四代理平行審查（main IPC／ASR-LLM／renderer／安全）後修補高信心問題：

| 等級 | 修補 |
|---|---|
| High | ASR `withAsrLock` + `loadEnabled`：unload 等 in-flight、禁止無 warm 幽靈重載；並行 transcribe 串列化 |
| High | `getDisplayMedia` handler：`getSources` catch + 空 sources 拒絕 |
| High | `models.openFolder` key 白名單 + 路徑必須在 models root |
| High | 檔案轉錄 `isTranscribing` 重入鎖；cloud 缺 apiKey 開跑前擋下 |
| High | prewarm `prewarmGen`／`prewarmInFlight`：切頁作廢 in-flight、避免無人 release 洩漏 |
| Med | ASR 來源 s2twp 條件化（日韓假名／諺文不轉繁）；engine 重入 acquire 失敗不卸已持有 owner |
| Med | `models.remove` 先 cancel 下載；刪除 UI 擋已載入模型；store key allowlist |
| Med | `sandbox: true`、will-navigate／setWindowOpenHandler、subtitle CSP、opacity clamp |
| Med | 開設定重灌表單（丟髒狀態）；file 翻譯組間帶 previous 上下文；before-quit 卸載中持續 preventDefault |
| Low | toast 單 timer、進度除零、設定文案改「字幕視窗雙／譯」 |

驗證：`npx electron scripts/e2e-audit-fixes.js` 15/15；`node scripts/e2e-cdp-smoke.js` 8/8（含 sandbox + store allowlist）；`npm run electron:pack` 成功。

## 最近變更（2026-07-18c）

- **修「英文翻譯只剩原文」＋ 開始字幕卡頓（同源）**。根因不是翻譯邏輯（e2e 證明英文→繁中暖機後 ~110ms、零複誦）：`local-llm.warm()` 原本只**載入**模型、不跑推論，node-llama-cpp 首次 prompt 的 compute-graph 冷啟動 **~12.5s** 就落在使用者「開始字幕」後第一句翻譯上；那 12.5s 內 ASR 每 2s 產批、`translateQueue`（上限 5）塞爆丟批次，**僅翻譯顯示模式**（使用者設定 `captionDisplayMode:"translation"`）對沒譯文的行回退顯示原文 → 整段只剩英文。
- **修法：`warm()` 內加拋棄式暖機推論**（`warmupInference`：`setChatHistory` 極簡 system + `prompt('warmup',{maxTokens:1})`），把 12.5s 冷啟動挪到背景預熱（進 live 分頁 `prewarmEngine` 時付掉）。`warmedUp` 旗標保證只跑一次、`unload` 時重置；走 `withTranslateLock` 不與 translate/unload 互踩。e2e：`warm()` 11.7s→第一句真實翻譯 **249ms**（原 12,493ms）；`engine.acquire('live')` 13s→第一句 462ms。開始字幕後翻譯佇列不再塞爆，僅翻譯模式正常出譯文、開頭不卡。
- **診斷結論**：目標語預設 `zh-TW`（未持久化，讀下拉）；`translator=local`、opencc 正常皆已排除。翻譯壞掉純為冷啟動丟批次的表象。
- **存設定回饋**：`saveSettings` 加回 `showToast('設定已儲存')`——base `.toast` 已是中性深色（綠色 `.toast.success` 前版已移除），故為中性提示非綠條，且只在明確「儲存」時觸發。
- **預熱狀態提示**：`prewarmEngine` 期間 `statusText` 顯示「準備模型…」，就緒/失敗且未擷取時還原「未啟動」（不覆蓋 startCapture 的文字）。

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
- 本地檔案轉錄已串流切 28s（支援 ≥2h／≥100MB）→ 硬切邊界仍可用 VAD 改善
- Qwen3-ASR-1.7B（更準，int8 ~2GB）可加入 registry
- PRD 未實作的 backlog 見 `tasks/todo.md`
