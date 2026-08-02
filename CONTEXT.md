# CONTEXT.md — 開發紀錄交接文件

> 給下一個 AI Agent 的接手指南。保持精簡，每次任務完成後更新。

## 專案概況

VoiceInk：Windows Electron 語音轉文字應用（檔案轉錄＋即時字幕＋翻譯與 TTS）。
Vanilla JS + Vite，無前端框架。版本 **1.7.0**（GitHub Release `v1.7.0`：LinguaForge think 前綴修正、Q8／Q4 量化可選、譯文清理獨立模組）。

## 架構（設定第四分頁 + 雲端 ASR，2026-07-24）

```
src/main/
  main.js             frameless 主窗 + IPC；localAsr 依 asrEngine 分流
  models.js           registry：qwen3asr、qwen35translate、linguaforge08(Q8)、linguaforge08q4
  gpu-capability.js   NVIDIA VRAM 門檻（≥6GB）
  local-asr.js        sherpa-onnx 本地 ASR（CPU）
  cloud-asr.js        OpenRouter 相容 /audio/transcriptions
  local-llm.js        翻譯 cloud/local；多 GGUF + CPU/GPU（cuda|vulkan）
  file-transcribe.js  本地 f32le 28s；雲端 mp3 segment 50s
  edge-tts.js         Edge TTS + ttsRate（%）
  engine.js           owner live|file|translate；雲端 ASR 時 needs.asr=false
src/renderer/
  scripts/app.js            設定分頁（外觀／模型／GPU）；frameless 窗控
  scripts/translate-page.js / live-caption.js / transcribe.js
```

## 轉錄／翻譯／TTS

| 項目 | 說明 |
|---|---|
| ASR | `asrEngine` = local（Qwen3-ASR）/ cloud（`asrApiUrl`/`asrApiKey`/`asrModelId`） |
| 翻譯 | `translator` = cloud / local；本地模型 `localTranslateModel` = `linguaforge08`(Q8，預設) / `linguaforge08q4`(Q4) / `qwen35translate`；`llmGpu` |
| TTS | Edge TTS；`ttsVoices` + `ttsRate`（-50…100 → Edge rate %） |
| 設定 UI | 導航第四 tab；區塊：模型／翻譯／語音轉文字／外觀／語音 |
| 視窗 | 主窗 frameless（header 含 min/max/close）；標題 `VoiceInk` |

模型存放：`%APPDATA%/voiceink/models/<key>/`。

## 最近變更（2026-08-03）— 補回 Qwen3.5 空 think 前綴（根因）＋ Q8／Q4 可選

- **根因**：Qwen3.5 `chat_template.jinja` 在 `enable_thinking` 未開時，`<|im_start|>assistant\n` 後**固定補** `<think>\n\n</think>\n\n`（token `248068,271,248069,271`），模型是帶著它訓練與評測的。node-llama-cpp 3.19 自動解析出的 Qwen wrapper **不補**這 4 個 token → 掉出分布。先前記在「量化對照」的三精度共通缺陷（標籤前綴、專名消失、年份幻覺）其實全部出自這裡，不是權重或語料
- **修法（一行）**：`local-llm.getSession` 的 `LlamaChatSession` 帶 `newQwen35ChatWrapper(QwenChatWrapper)` ＝ `new QwenChatWrapper({ thoughts: 'discourage' })`
  - 實測（`node scripts/probe-prompt-path.js`）：`thoughts:'discourage'` 產出的 prompt 與 transformers `apply_chat_template(..., add_generation_prompt=True)` **逐字元相同**、尾端 token 正是 `248068,271,248069,271` → 不需 INTEGRATION.md 建議的自訂 subclass（subclass 亦驗過，輸出相同）
  - 現況（自動解析）尾端只有 `…<|im_start|>assistant\n`，確認缺 4 token
  - `budgets.thoughtTokens:0` 是「不生成 thinking」，補不了前綴，兩件事都要做
- **量化改 Q8_0**（`models.js` `totalBytes: 811843008`）：補回前綴後，唯一還在的量化稅就是罕見專名音譯（Q4 `Kimi→金剛`、`Sol→索爾`；Q8/f16 保留）
- **30 句客觀對照**（`node scripts/verify-chat-wrapper-fix.js`，樣本／指標共用 `scripts/bench-cases.js`）：

| GGUF | 標籤前綴 | 拉丁專名保留率 | 憑空年份 | 缺陷總數 |
|---|---|---|---|---|
| Q4_K_M 修前 | 8 | 46.7% | 2 | 20 |
| Q4_K_M 修後 | 0 | 80.0% | 0 | 5 |
| Q8_0 修前 | 9 | 73.3% | 2 | 20 |
| **Q8_0 修後（出貨）** | **0** | **93.3%** | **0** | **6** |

  門檻（標籤=0／專名≥90%／年份=0／總數<8）**Q8_0 修後 ALL GATES PASS**；Q4 只差專名保留率
- 逐句例：`The NVIDIA H200 has 141GB…` 修前「141GB HBM3e 記憶體。」→ 修後「NVIDIA H200 擁有 141GB HBM3e 記憶體。」；`A pig would break…` 修前「故事說，豬會…」→ 修後無前綴；`Up to 1M context` 修前「選擇 1M 上下文」→ 修後「最大 1M 上下文」
- **未修（語料缺口，勿為此調 prompt）**：多行且各行互不相關（規格表）只譯第一行（m1）；`open weight`／`agentic` 等 2023 後 AI 術語
- **Q4／Q8 改為可選**：Q4 另開 registry key `linguaforge08q4`（獨立資料夾、獨立下載），設定→翻譯模型三顆按鈕（LinguaForge Q8／LinguaForge Q4／Qwen3.5 通用）。預設 Q8（774MB）；Q4（505MB）CPU 約快 2.2×，代價是罕見專名音譯
  - 同一顆模型兩個量化共用 SFT 格式與 DECODE → `local-llm.isLinguaforge(key)` 取代原本的 `key === LINGUAFORGE_KEY`；renderer 切段用 `startsWith('linguaforge08')`
  - 實測同一句 `…beat Kimi k3 … around Sol level`：Q8「超越Kimi k3…和Sol一樣強」／Q4「比金剛大3倍…和索爾一樣強」
  - 舊用戶模型資料夾裡的舊 Q4 檔（在 `linguaforge08/` 底下）不會自動刪，可手動清
- 驗證：`npx electron scripts/e2e-linguaforge-quant.js` ALL PASS（雙 key 白名單／status／GGUF 路徑／各自實際翻譯）、`e2e-linguaforge-decode` A–E ALL PASS（log 已含 `chat_wrapper`／`think_prefix_token_ids`）、`-list`／`-leak`／`-context` ALL PASS、`e2e-local-translate-settings` ALL PASS（雙模型 × CPU/CUDA，qwen35translate 無回歸）、`node scripts/e2e-cdp-smoke.js` **13/13**、`electron:pack` 已更新預覽
- 順修：cdp-smoke 的「長文分段」斷言寫死 4 段（LinguaForge 改 280 字切段後應為 8 段，自 2026-08-02 起就一直是假綠燈）→ 改成讀 UI 的「N 字（M 段）」

## 量化對照（2026-08-02e）— ⚠️ 結論已被 2026-08-03 推翻，僅存歷史

> 當時判定「三精度共通＝模型／語料問題」是錯的：三次都缺 think 前綴（同一個變因沒被控制），
> f16 也壞只證明不是量化、不證明不是 prompt。補回前綴後缺陷 20→5/6。
> 「維持 Q4_K_M」的決策同步作廢（改 Q8_0，理由見上一節）。

- 工具：`scripts/bench-quant-quality.js`（30 句均衡樣本 + 客觀指標）、`scripts/bench-quant-compare.js`（少量句並列）
- 30 句缺陷統計（越低越好）／CPU 耗時：**Q4 22 缺陷 76.7s｜Q8_0 20 缺陷 173.0s｜f16 22 缺陷 126.5s**
- 三個版本**共通**（＝模型端問題，換量化救不了）：
  - 標籤前綴 `說明：`／`選擇`／`圖為`／`圖 100 號：`／`問：`（訓練語料混了新聞圖說與 UI 選單格式）
  - 專名丟失：NVIDIA、TSMC、H200 直接消失；年份幻覺（原文沒年份卻生出 2005／2008／2023）
  - 多行輸入只翻第一行（app 端逐行切是必要的，不是繞路）
  - AI 術語未學到：open weight、agentic
- Q4 個案災難（n1 JPMorgan→SEC 幻覺、n2 Kimi→金剛）在 Q8 是對的，但 f16 在 n2 同樣翻錯 → 屬解碼路徑擾動，非系統性優勢
- 決策：**維持 Q4_K_M**。Q8 只換到 2 個缺陷改善，代價是 +282MB 下載與 2.2× 推論時間
- 另一項與量化無關的落差：出貨 `evaluate.py` 用 beam=4 + length_penalty=1.2，GGUF 只能 greedy——這部分無法用換量化補

## 最近變更（2026-08-02d）— 條列貼文退化＋術語竄改

- 症狀：貼含 bullet 的貼文，譯文只剩「…大躍進…」重複迴圈、條列內容整段消失；另有「說明：」「問：」標籤與「參數→引數」
- 逐項根因與修法（每一步都實測過，前兩種切法失敗才收斂到現行做法）：
  1. **切段**：跨段落合併 → 模型退化迴圈；改逐行又讓 `·` 被翻成「選擇器：」；孤立 bullet 區塊整塊送會被「總結」掉。最終：**逐行翻譯，行首清單標記（`· ` `- ` `1. `）剝除後才送模型，翻完貼回**（`splitLinesForLinguaforge` + `LIST_MARKER`），空行保留段落結構
  2. **退化救援**：zhtw 依出貨規定 `repeatPenalty:false`，一旦進迴圈出不來 → `findRepetitionLoop` 偵測後以 `repeatPenalty 1.15 + DRY allowedLength 2` **重跑該段**（重試前必須 `setChatHistory(history)` 還原，否則第二輪帶著上一輪＝複誦）
  3. **標籤**：模型自加 `說明：`／`問：` → 白名單 + **原文沒有冒號才剝**
  4. **s2twp 竄改**：`to:'twp'` 會把已正確的「總參數」改成「總引數」、「記憶體參數設定」→「記憶體引數設定」。改為先用 `to:'tw'`（純字形）探測，**沒有簡體字就原樣回傳**，只有真的含簡體才套詞彙表（ASR 共用此函式，一併受益）
- 驗證：`npx electron scripts/e2e-linguaforge-list.js` ALL PASS（結構 11 行、6 條 bullet 標記保留、無迴圈／標籤／引數）；`test-strip-prompt-leak` 23/23；`e2e-linguaforge-leak`／`-decode`／`-context`／`e2e-local-translate-settings`（CPU+CUDA）全 PASS；`electron:pack` 已更新預覽
- 已知殘留（0.8B 能力，非工程層可修）：專名音譯（Kimi→金智美）、偶發整句幻覺（JPMorgan 那句被翻成 SEC 內容）、片語誤譯（Open weight release→開啟重量釋放）。e2e 斷言刻意只驗結構／污染／退化，不把模型用詞正確性當紅燈

## 最近變更（2026-08-02c）— 譯文純淨度（persona／引號／列點）

- 症狀：譯文出現 `譯者：` 標籤、憑空 `2. ` 列點編號、不成對的 `」`
- 根因：(1) 0.8B 偶爾把 system persona 寫成說話者標籤（舊 `stripPromptLeak` 只認 `譯文：`／`Translation:`）；(2) 我方單側引號剝除無條件執行，把 `「引言」，某某說。` 的開頭 「 剝掉留下孤兒 」；(3) 模型把整段譯成編號清單
- 修法：清理邏輯抽到 **`src/main/translate-clean.js`**（純文字、無 electron 依賴，測試可直接 require；原本 `scripts/test-strip-prompt-leak.js` 複製一份邏輯，改一次要改兩處）
  - 新增 persona 標籤 `譯者|翻譯者|翻譯員|譯員|Translator[：:]`
  - 引號：整段包覆才剝一層；**單側只在「找不到配對」時剝**
  - 列點：`stripTranslationNoise(raw, source)` 帶原文，原文沒編號才剝譯文行首 `1. `／`2、`
  - 除錯鉤子：`VOICEINK_DEBUG_RAW=1` 印模型原始輸出（判斷污染來自模型或我方清理）
- 驗證：`node scripts/test-strip-prompt-leak.js` 19/19；`npx electron scripts/e2e-linguaforge-leak.js`（1349 字實測文）ALL PASS；`e2e-linguaforge-decode` / `e2e-linguaforge-context` 未回歸；`electron:pack` 已更新預覽
- 已知殘留：0.8B 會幻覺出原文沒有的引述來源（如「…」，某某說），屬翻譯品質非提示洩漏，清理層不可能安全辨識

## 最近變更（2026-08-02b）— 修 LinguaForge 長文每段吐同一句

- 症狀：翻譯頁貼長文（8 段），譯文欄整篇重複第 1 段譯文
- 根因：`translateLocalOnce` 把前文（`previousSource`/`previousTranslation`）當上一輪 user/assistant 塞進 chat history。LinguaForge 是**單輪 SFT MT 模型**，多一輪對話後 greedy 直接複誦上一輪的 assistant 譯文（off-by-one echo）；原版 evaluate.py 就是 system + 單一 user，故沒此問題
- 修法：`key === LINGUAFORGE_KEY` 時 `pair = null`（不注入前文）；`translateLocal` 的 280 字切段迴圈同步停止串接 prevSrc/prevTr。qwen35translate／雲端不受影響
- 驗證：`npx electron scripts/e2e-linguaforge-context.js`（4 段連續帶前文）修前 `dupes:2`、修後 `dupes:0 ALL PASS`；`npm run electron:pack` 已更新預覽

## 最近變更（2026-08-02）— LinguaForge v5e 出貨解碼對齊（GGUF）

- 權威：`evaluate.py` DECODE / INTEGRATION.md；本 app 走 **GGUF + node-llama-cpp**（無 beam／無 nrng）
- `local-llm.js` 集中 `LINGUAFORGE_DECODE`：
  - 雙 EOS 文件化 `[248046,248044]` + `customStopTriggers` `<|im_end|>`/`<|endoftext|>`
  - **zhtw：`repeatPenalty: false`**（套件省略時預設 1.1，會攪繁簡——此為關鍵修）
  - en/ja：`repeatPenalty.penalty=1.1`；全向 `dryRepeatPenalty.allowedLength=3` 近似 `no_repeat_ngram_size=4`
  - `temperature=0`、`budgets.thoughtTokens=0`；`maxTokens≈源長×2`（64–768）
  - 長文 file 模式 main 端 ≤280 字段落；renderer 選 LinguaForge 時同 280
  - 後處理 strip 引號；zhtw 必 `s2twp`；每次 log `[linguaforge decode]`
- 驗收：`npx electron scripts/e2e-linguaforge-decode.js` A–E ALL PASS（stopReason=`eogToken`）

## 最近變更（2026-08-01）— LinguaForge v5e 模型路徑

- HF repo 不變：`RX5950XT/LinguaForge-Qwen3.5-0.8B-zhTW-en-ja`
- GGUF 路徑更新：`gguf-v5e/linguaforge-v5e-0.8b-Q4_K_M.gguf`（`totalBytes: 529296832`）；舊 v3 `gguf/linguaforge-v3-…` 作廢
- 本機已刪舊目錄後重下 v5e；prompt 仍為 system=`You are a professional translator.` + user=`翻譯成…：\n`（與 v5e 卡片一致）；zh-TW 仍過 OpenCC s2twp
- 驗證：`npx electron scripts/e2e-linguaforge-v5e.js` 下載＋八向翻譯 PASS；`e2e-llm-device` CPU+CUDA PASS；`e2e-local-translate-settings` ALL PASS；`npm run electron:pack` 已更新預覽
- 抽樣譯文（v5e Q4 CPU）：en→繁「週末夜市人潮擁擠。」／醫囑「藥劑應每天服用兩次。」；ja→繁「我週末的夜市非常熱鬧。」；繁→en／en→ja 語意正確

## 最近變更（2026-07-28）— 恢復 LinguaForge 選項

- 2026-07-27 的屏蔽全部反向改回：`models.js` 移除 `hidden` 與 `status()` 的 hidden 跳過、`LLM_MODEL_KEYS = ['linguaforge08','qwen35translate']`；`local-llm.js` `DEFAULT_LLM_KEY = 'linguaforge08'`；`app.js` 預設／白名單／normalize 回 lingua；`index.html` 翻譯模型 setting-group 取消 hidden 並加回 LinguaForge 按鈕
- e2e 斷言同步反轉：`e2e-cdp-smoke.js` 改測 `linguaforge selectable`（改用 setting-group 是否帶 hidden 判定，不用 `offsetParent`——translator=cloud 時整個本地區塊本來就隱藏）；`e2e-llm-device.js` 改測在白名單／在 status／resolve 落 lingua
- e2e 測試句改成一般句子：LinguaForge 對 `Hello world.` 等極短寒暄句會吐「？」（既有已知行為），不是回歸
- 驗證：`npx electron scripts/e2e-llm-device.js` ALL PASS（CPU + CUDA）、`npx electron scripts/e2e-local-translate-settings.js` ALL PASS（雙模型 × CPU/CUDA）、`node scripts/e2e-cdp-smoke.js` **13/13**、`npm run electron:pack` 已更新預覽

## 最近變更（2026-07-27b）— 翻譯頁解除字數限制（自動分段）

- 移除 UI 硬限制：`index.html` textarea 去掉 `maxlength=1500`，字數改顯示「N 字（M 段）」
- `translate-page.js` 新增 `splitForTranslate(text, max=600)`：依句尾／換行切單位 → 貪婪合併 ≤600 字；無標點超長段硬切；保留原尾端空白供接回
  - 600 字＝本地 `contextSize: 2048`（prompt＋輸出共用）的安全值，**不要調高到 >1000**
  - 逐段送 IPC，前一段當 `previousSource/previousTranslation` 維持上下文；譯文逐段即時填入
  - 進度顯示 `翻譯中… (i/n)`；翻譯中按鈕變「停止」（`_translateRequestId=0` 中斷迴圈，已完成段落保留並標為 stale）
- main `MAX_TRANSLATE_CHARS = 1500` **保留**（IPC 信任邊界防 DoS）；分段後每次呼叫遠低於此
- 順修：`translateCloud` 呼叫 `buildSystemPrompt(targetLang, mode)` 少一個參數（modelKey），導致雲端 system prompt 變成「翻譯成 file」→ 已改 `buildSystemPrompt(null, targetLang, options.mode)`
- 驗證：`node scripts/e2e-cdp-smoke.js` **13/13**（新增 `splitForTranslate` 單元檢查、無 maxlength、1908 字實際分 4 段翻譯完成）；`npx electron scripts/e2e-local-translate-settings.js` ALL PASS
- 備忘：CDP e2e 不要用單次 `awaitPromise` 等數十秒（連線閒置會斷、node 靜默 exit 0）→ 改由 Node 端 2s 輪詢

## 最近變更（2026-07-27）— 暫時屏蔽 LinguaForge（已於 2026-07-28 恢復，僅存歷史）

- 原因：LinguaForge 0.8B 品質待修，先從 UI 與白名單移除，模型修好再恢復
- 屏蔽點（恢復＝這 3 處反向改回）：
  1. `models.js`：registry `linguaforge08.hidden = true`（`status()` 跳過 hidden）＋ `LLM_MODEL_KEYS = ['qwen35translate']`
  2. `local-llm.js`：`DEFAULT_LLM_KEY = 'qwen35translate'`（LinguaForge 專用 prompt 分支保留，未刪）
  3. renderer：`app.js` 預設／白名單／normalize 全指向 qwen；`index.html` 翻譯模型 setting-group 加 `hidden` 並移除 LinguaForge 按鈕
- 舊 store 值 `linguaforge08` 由 `isLlmKey` 校驗自動正規化為 qwen（不需 migration）
- 驗證：`node scripts/e2e-cdp-smoke.js` **10/10**（新增 `linguaforge hidden` 檢查：status keys、設定頁文字、seg 按鈕、可見性、store 值）；`npx electron scripts/e2e-local-translate-settings.js` **ALL PASS**（CPU/CUDA 實際翻譯）；`npm run electron:pack` 已更新預覽

## 最近變更（2026-07-26d）— 本地翻譯設定全路徑驗證

- e2e：`scripts/e2e-local-translate-settings.js` — 雙模型 × CPU/CUDA、指紋切換、llmGpu 開關、live mode **ALL PASS**
- LinguaForge 改用訓練格式：`system=You are a professional translator.` + user=`翻譯成繁體中文：\n…`
- `createLlama` 載入前 `prependCudaBinToPath`（確保設定 GPU 真走 CUDA）
- 存檔後翻譯頁／即時頁未擷取時強制 re-prewarm（模型／GPU 立刻生效）
- 注意：LinguaForge 0.8B 對極短寒暄句（Hello world / See you）可能吐 `？`；一般句子正常。Qwen 通用較穩

## 最近變更（2026-07-26c）— 修 LLM load cancelled

- **症狀**：預熱／開始翻譯時 toast `LLM load cancelled`
- **根因**：`getSession` 在「指紋相同」時仍 cancel 進行中的 load（第二個呼叫者誤作廢）
- **修法**：同指紋 in-flight **join**；僅 mismatch 才 bump `loadGen`；`unload` 清 `loadPromise`；`warm` 遇 cancel 重試一次並改中文提示
- 驗證：`npx electron scripts/e2e-llm-load-cancel.js` → concurrent warm / after loaded / after unload 全 PASS

## 最近變更（2026-07-26b）— CUDA 環境自動安裝

- 本機已裝 **CUDA Toolkit 13.3**（winget `Nvidia.CUDA`）；`getLlama({gpu:'cuda'})` 通過
- 新增 `src/main/cuda-env.js`：偵測 cudart/cublas/cublasLt；winget 或下載官方 installer（UAC）
- 設定→本地翻譯：顯示 CUDA 狀態、「安裝 CUDA 環境」「重新偵測」
- 啟動時 `prependCudaBinToPath`；e2e GPU 路徑 backend=**cuda**

## 最近變更（2026-07-26）— frameless + LinguaForge + 本地雙模型 + GPU

- 主窗 `frame:false` 標題列合併進 header（min/max/close）；標題僅 `VoiceInk`；主題移設定「外觀」
- 模型 registry 新增 `linguaforge08`（Q4 GGUF 繁中/英/日）；`localTranslateModel` 可選兩本地翻譯模型
- 未下載選中模型時 **fallback** 到已下載的 `qwen35translate`（不破壞舊用戶）
- `llmGpu`：NVIDIA 且 VRAM≥6GB 才可開；載入 cuda→vulkan→CPU fallback
- pack 納入 `win-x64-cuda`（仍排除 cuda-ext）

## 最近變更（2026-07-24）— 設定第四分頁 + 雲端 ASR + 語速

- 設定改嵌入式第四 tab（移除齒輪彈窗）；模型狀態與本地管理合併
- 翻譯設定僅雲端/本地 LLM；舊 `translator=none` 正規化為 local
- 語音轉文字：本地/雲端切換；雲端憑證與翻譯分開；`cloud-asr.js` + 檔案 mp3 切段
- TTS 語速 slider（store `ttsRate`）
- 驗證：模組單元檢查 + `electron:pack`；CDP smoke 改抓 `#page-settings`

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
