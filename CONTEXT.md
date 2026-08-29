# CONTEXT.md — 開發紀錄交接文件

> 給下一個 AI Agent 的接手指南。保持精簡，每次任務完成後更新。
> 規範與地雷見 [CLAUDE.md](./CLAUDE.md) / [AGENTS.md](./AGENTS.md)；歷史教訓見 [tasks/lessons.md](./tasks/lessons.md)。

## 專案概況

VoiceInk：Windows Electron AI 工作台（**聊天**＋**終端機**＋**AI 訂閱額度**＋**AGY 反向代理**＋**語音轉文字**＋翻譯與 TTS）。Vanilla JS + Vite，無框架。
已發行版本 **1.9.0**（Release `v1.9.0`：終端機多工作階段、GPU 語音辨識、AGY 反代與聊天模型管理更新、自訂下拉與 Aurora glass 視覺精修）。

> v1.9.0 是這一輪的總結發行：在 v1.8.0 的聊天、字幕、額度與 AGY 基礎上，加入終端機多工作階段、GPU ASR，並完成模型選單與設定頁排版修整。
> 要出貨時：確認版本與既有 tag 不重複 → bump `package.json` → commit → `git tag vX.Y.Z` → push → `electron:build` → `gh release create`。

## 最近變更（2026-08-30）— v1.9.0 發行整理

- **聊天與模型 UI**：共用自訂 ARIA listbox，修正 `optgroup` 模型清單點擊例外；清單寬度依內容調整且保持單行，模型 ID／生圖標記／移除按鈕同高對齊。
- **語音與終端機**：本地 ASR 依模型分流 CPU／Vulkan GPU；終端機支援多工作階段、狀態與背景執行。
- **AGY 與穩定性**：補上狀態競態、憑證續期、流量轉換與受限 IPC 的回歸保護。
- **驗證**：`npm run build`、`npm run electron:pack`、`node scripts/e2e-visual-cdp.js`（54/54）通過；本次 release 會再產生 NSIS 安裝檔並上傳。

## 架構

```
src/main/
  main.js             frameless 主窗 + IPC；localAsr 依 asrEngine 分流
  chat.js             雲端聊天 SSE 串流；單一 in-flight、雙逾時、上下文裁切、model allowlist、
                      系統提示 preset、reasoning 分流、圖片多模態、重新生成
  chat-store.js       會話持久化（獨立 electron-store 實例 → <userData>/chats.json）；訊息可帶 images/reasoning
  chat-images.js      圖片附件：存 <userData>/chat-images/，檔名 allowlist、孤兒回收
  terminal/           側欄多開的 ConPTY 工作階段：pty.js 生命週期與 scrollback、status.js 忙碌判定
                      （OSC 133 標記 ＋ 靜默雙軌，純函式）、store.js metadata、ipc.js 白名單
  usage/              五家額度 provider、bounded HTTPS／唯讀 SQLite／Credential Manager bridge、
                      獨立 usage store、6h soft cache、同步協調與受限 IPC
  agy/                本機反向代理：node:http 閘道（127.0.0.1 + 強制金鑰）、OpenAI/Anthropic ⇄ Gemini
                      雙向轉換、cloudcode-pa 上游（401 強制 refresh 重試）、node:sqlite 流量日誌與統計
  models.js           registry：qwen3asr(CPU)／qwen3asrgpu(GPU)／llamaruntime(執行環境)／
                      linguaforge08q4／qwen35translate／qwen354b；archive 型別走 Expand-Archive
  gpu-capability.js   NVIDIA VRAM 門檻（≥6GB）／cuda-env.js CUDA 偵測安裝
  asr-select.js       本地 ASR 門面：依 asrModelKey 分流；engine／file-transcribe／IPC 都只認它
  local-asr.js        sherpa-onnx 本地 ASR（僅 CPU；執行緒自動）
  llama-asr.js        llama-server sidecar（Vulkan GPU）；spawn／health 輪詢／multipart 轉錄／收程序
  cloud-asr.js        OpenAI 相容 /audio/transcriptions
  local-llm.js        翻譯 cloud/local；多 GGUF + CPU/GPU；LINGUAFORGE_DECODE 查表
  translate-clean.js  譯文清理（純文字、無 electron 依賴，可 node 直測）
  file-transcribe.js  本地 f32le 28s；雲端 mp3 segment 50s
  edge-tts.js         Edge TTS + ttsRate（%）
  engine.js           owner live|file|translate；雲端 ASR 時 needs.asr=false
src/renderer/scripts/
  app.js  translate-page.js  transcribe.js
  stt-page.js          語音轉文字頁：子分頁切換 ＋ 上方模型選單
  model-picker.js      模型選單共用邏輯（選項組裝／寫回 store／未安裝提示）
  custom-select.js     共用 ARIA listbox 視覺層（保留原生 select 作為資料與事件來源）
  live-caption.js      16k PCM 擷取 → VAD 語句 → ASR／翻譯佇列
  vad.js               純資料能量 VAD（pre-roll／遲滯／語句長度界，可 node 直測）
  chat-page.js        聊天頁 UI（側欄搜尋／提示 preset 彈窗／auto-grow 輸入框／圖片附件／
                      thinking 開關／訊息複製與重新生成）＋設定頁「聊天」區塊
  markdown.js         最小安全 Markdown → DocumentFragment（零 innerHTML）
  usage-page.js       額度卡片／倒數／手動同步／顯示設定／拖曳與鍵盤排序／去敏診斷
  terminal-page.js    終端機頁（側欄多開／狀態徽章／未讀點／xterm 每階段一個實例）
  agy-page.js         反代服務控制／金鑰遮罩複製／統計（純 CSS 長條）／流量日誌表與篩選
```

| 項目 | 說明 |
|---|---|
| 聊天 | **多組供應商**：`chatProviders`（各帶 url／key／模型清單／`imageModels`）＋`chatProviderId`＋`chatModelId`；雲端 OpenAI 相容 `/chat/completions` + `stream:true`；**雲端翻譯共用同一份清單**（`translateProviderId`＋`translateModelId`） |
| 聊天進階 | 系統提示多組 preset `chatPrompts`/`chatPromptId`；thinking `chatThinking` → `reasoning_effort`；圖片附件（訊息存檔名、實體在 `<userData>/chat-images/`）；**生圖模型**（清單勾「生圖」→ 請求帶 `modalities`，回傳的 data URI 存 `chat-images/`）；側欄就地改名／逐列刪除／拖曳排序（`chat:reorder`） |
| 終端機 | `@lydell/node-pty`（ConPTY）＋ xterm.js；側欄多開、狀態「運行中／已完成／已結束」＋未讀點；shell（pwsh/powershell/cmd）與啟動指令（shell/claude/codex）是 main 固定表，cwd 走系統對話框；metadata 存 `<userData>/terminals.json`，走 `terminal:*` IPC |
| 額度 | Claude Code／Codex／Antigravity／OpenCode／Grok；只在按「同步」時查詢；獨立 `<userData>/usage.json`、6h soft cache；Main-only 固定來源 |
| AGY 反代 | OpenAI `/v1/chat/completions` + Anthropic `/v1/messages` → cloudcode-pa `v1internal:streamGenerateContent`；只綁 `127.0.0.1`＋強制金鑰；設定走 `agy:*`（不進 `STORE_ALLOWLIST`）；日誌 `<userData>/agy-logs.db` |
| ASR | `asrEngine` = local / cloud；local 再由 `asrModelKey` 選 `qwen3asr`（0.6B INT8，sherpa，**只有 CPU**，執行緒自動）或 `qwen3asrgpu`（1.7B Q8_0，llama-server sidecar，Vulkan GPU）。**沒有 CPU/GPU 開關**：選模型＝選推論方式 |
| 翻譯 | `translator` = cloud（走聊天供應商，`translateProviderId`＋`translateModelId`）／ local（`localTranslateModel` = `linguaforge08q4`(預設) / `qwen35translate`(0.8B) / `qwen354b`(4B，建議 GPU)）；`llmGpu` 是全域推論開關 |
| 即時字幕 | 系統 loopback → AudioContext 16k mono PCM → 能量 VAD 依停頓切 0.5–6s 語句 → ASR；pending 上限 2 |
| TTS | Edge TTS；`ttsVoices` + `ttsRate`（-50…100 → Edge rate %）；設定頁每個語音有試聽鈕（`tts:preview`） |
| 設定 UI | 導航最後一 tab；**左側分類 rail** 一次顯示一區：本地模型（依語音辨識／翻譯／執行環境分組）／雲端模型（供應商共用＋語音轉文字）／語音朗讀／基本 + 底部 sticky 儲存列。只管安裝與推論設定，**選模型在功能頁標題旁的 `.model-chip`** |
| 導覽 | 聊天（預設頁）｜終端機｜額度｜AGY反代｜語音轉文字（子分頁：檔案轉錄／即時字幕）｜翻譯與 TTS｜設定 |
| 視窗 | 主窗 frameless（header 含 min/max/close）；字幕彈窗獨佔顯示模式 |
| 視覺 | Token Anxiety Aurora glass；dark/light 共用 12px surface、blur、冷藍／暖金光暈；900／640px RWD |

模型存放：`%APPDATA%/voiceink/models/<key>/`。

## 最近變更（2026-08-29）— 自訂下拉、思考狀態與生圖列排版

- **自訂下拉**：新增 `renderer/scripts/custom-select.js`。原始 `<select>` 保留作為資料來源與 `change` 事件目標，畫面改用共用 ARIA listbox；模型、語言、供應商、TTS、終端機與篩選下拉都使用同一套圓角、陰影、選取／hover 色。清單用 fixed portal 定位，彈窗內選單會留在 dialog top layer，避免被裁切。
- **互動**：支援滑鼠、Enter／Space、上下／Home／End、Esc、外部點擊收合；選取會回寫原生 `<select>` 並照常派發 `change`。少數程式只改 `.value` 的流程由 `syncCustomSelects()` 補同步。
- **模型與窄版**：`optgroup` 以 `querySelectorAll('option')` 讀取，避免聊天模型清單點擊時因不存在的 `options` 例外而打不開；清單寬度取觸發鈕與內容寬度較大者（仍受視窗邊界限制），選項不再逐字直排。
- **模型列**：設定頁模型列固定為模型 ID／生圖標記／移除三欄，三個控制項同頂線、同為 40px。
- **生圖標記**：`.setting-group label` 會把 label 預設成 block；`.chat-model-flag` 必須用同等特異度恢復 inline flex，並清掉欄位下間距，勾選框與文字才會同一中心線。
- **驗證**：`npm run build`、`npm run electron:pack`、`node scripts/e2e-visual-cdp.js` **54 項**（含聊天模型點擊、窄版清單、模型列對齊、模型 chip、彈窗 top-layer、鍵盤與 `change` 回歸）通過。`dist/win-unpacked/VoiceInk.exe` 為最新免安裝預覽。

## 前一輪變更（2026-08-29）— 下拉控制項、思考狀態與生圖列排版

- **下拉控制項**：共用 `<select>` 收合態改成一致的 40px／10px 圓角／自繪箭頭；模型 chip 改成同一套控制面板形狀，hover、focus 與兩主題選取色統一。原生 `<option>` 仍保留不透明底色與 4.5:1 以上對比，供資料層與後備呈現使用。
- **思考按鈕**：`aria-pressed=true` 改用實心 accent、外圈與粗字，並補高特異度 hover 規則，滑過去不會把開啟狀態洗掉。
- **生圖模型列**：改成固定三欄 grid（模型 ID／生圖開關／移除），三個控制項同高；勾選後整個「生圖」標記同步亮起，設定頁供應商列的下拉與按鈕也對齊。
- **驗證**：本輪原先的 CSS-only 版本通過 `npm run build`、`npm run electron:pack`、視覺 49 項；之後因原生展開彈窗仍無法控制，改為上方的自訂 listbox。

## 最近變更（2026-08-29）— 背景終端機輸出、AGY 狀態競態與安全 CDP 收尾

- **AGY**：`agy-page.js` 的 `refreshStatus()` 以遞增 generation 忽略過期回應，手動刷新、輪詢與服務切換不會再由慢回應寫回舊 Base URL。
- **終端機**：初始 snapshot 與後續 PTY 事件走同一條序列佇列；視窗背景時改用 xterm 的同步 write buffer，避免首段提示字元等不到非同步 callback 而被後續輸出超車。
- **CDP**：終端機與視覺測試各用暫存 userData，只以自己的 PID 清理；視覺測試的 CDP HTTP 與 WebSocket 都有失敗出口，SQLite 暫存檔清理有限重試。背景終端機回歸會最小化自己的測試 App，確認 `document.hidden` 下首段輸出不觸發非同步 `write`。
- **驗證**：`npm run build`、`npm run electron:pack`；CDP：terminal 30、AGY 33、visual 48、smoke 22、chat 44、usage 10、STT 19、tray 12；核心：terminal 50、AGY mapper 50、error hygiene 32，均通過。

## 最近變更（2026-08-28）— 聊天生圖、雲端供應商共用、選單瘦身

### 需求（使用者原話整理）

1. 聊天要支援生成圖片的模型。
2. 雲端模型那邊，翻譯跟聊天整合在一起（都是 LLM，選單不用拆成兩個）。
3. 本地模型的選單分類一下（現在連執行環境都混在裡面）。
4. ASR 不用特別設定 CPU/GPU（0.6B 就是 CPU、1.7B 就是 GPU），所以執行緒那個選項也拿掉，一律「自動」。
5. 「翻譯與 TTS」與「語音轉文字」的模型選單改成標題旁的小按鈕，不要單獨佔一整排。
6. 問題：圖片模型要不要在設定的雲端模型裡單獨開一個欄位？→ **不用**，見下。

### 做法

- **生圖**（`chat.js`）：供應商多一個 `imageModels`（`models` 的子集，設定頁每一列一個「生圖」勾）。
  選到被勾的模型時請求帶 `modalities:['image','text']`，SSE 的 `delta.images[].image_url.url`
  收下來後走既有的 `chatImages.saveMany`，訊息只記檔名——**不另開「圖片模型」欄位**，
  因為它跟文字模型是同一個端點、同一組金鑰，差別只有請求要不要帶那個欄位。
  聊天頁的模型選單會在生圖模型前面加 🖼。
- **雲端翻譯併入聊天供應商**：`local-llm.translateCloud` 改讀 `chat.readTranslateConfig()`；
  舊的 `apiUrl`／`apiKey`／`modelId` 由 `main.js` 的 `migrateTranslateProvider()` 一次性併進
  `chatProviders`（網址與金鑰都相同就沿用既有那組）後刪掉，三個 key 一併退出 `STORE_ALLOWLIST`。
  翻譯要用哪一顆在翻譯頁選（選項是「供應商 / 模型」逐一列出）。
- **本地模型清單分組**：`refreshModels` 依 registry 的 `kind` 分成 語音辨識／翻譯／執行環境 三段，
  每列的 `.model-tag` 拿掉（分組標題已經講了同一件事）。
- **ASR 執行緒設定移除**：`asrThreads` 退出 allowlist，開機時 `store.delete` 一次；
  設定頁那一格改成一句說明（0.6B＝sherpa CPU、1.7B＝llama-server GPU）。
- **模型選單移到標題旁**：`.model-bar` 整條橫排 → `.page-header-row` 裡的 `.model-chip`；
  提示文字只在「選到還沒裝好的東西」時才出現。

### 驗證

- `npx electron scripts/e2e-chat.js` 129 passed（新增 [M] 生圖：modalities／存檔／不回送 assistant 圖／
  非生圖模型不帶欄位／`imageModels` 子集／只收 data URI；[N] 翻譯與聊天共用供應商）
- `node scripts/e2e-cdp-smoke.js` 22／`e2e-stt-cdp.js` 19／`e2e-chat-cdp.js` 44（新增生圖勾選框回歸）／
  `e2e-visual-cdp.js` 46／`e2e-usage-cdp.js` 10／`e2e-agy-cdp.js` 33／`e2e-terminal-cdp.js` 29／`e2e-tray-cdp.js` 12
- `node scripts/test-error-hygiene.js` 32（雲端翻譯的假 store 改成供應商形狀）／`test-usage` 30／
  `test-agy-mappers` 50／`test-markdown` 23／`test-terminal` 50／`test-vad` 11／`npx electron scripts/e2e-agy.js` 98
- 真實雲端翻譯：打包版 CDP 呼叫 `translate('今天天氣很好。','en')` → `The weather is very nice today.`
  （確認走的是搬移後的供應商設定，且舊 `apiUrl` key 已被 allowlist 擋掉）

### 已知取捨

- 生圖只驗到 mock SSE server；**沒有花使用者的額度去打真的生圖模型**。要實測就在設定的模型清單
  勾一顆生圖模型（例如 OpenRouter 的 image preview 系列）再到聊天頁選它。
- 供應商清單被編輯時，翻譯的選擇會跟著收斂到合法值（與聊天那組同樣的行為）。
  這一輪的測試跑過之後，翻譯目前指到清單裡的某一組；要換直接在翻譯頁標題旁選。

### 補丁：下拉展開後整份清單看不見（使用者回報）

`.model-chip-select` 的背景是 `transparent`，其他 `.select` 是半透明玻璃。展開後的清單由
作業系統畫（在頁面之外，吃不到 `backdrop-filter`），Chromium 只好拿 `<select>` 的背景色去畫 →
退回系統白底，而 `option` 的文字仍繼承接近白的 `--text-primary`＝白底白字。

修法是全域一條 `option { background-color: var(--surface-solid); color: var(--text-primary) }`，
`--surface-solid` 是兩個主題各一個**不透明**色（dark `#1c2123`／light `#f8f9f6`）。
所有 `<select>` 都有同一個毛病，所以修在共用層而不是那顆 chip 上。
回歸：`e2e-visual-cdp.js` 新增 `option-contrast`（兩主題各驗底色不透明＋對比 ≥ 4.5；
原生彈窗截圖看不到，只能驗 computed style），`e2e-visual-cdp.js` 因此變成 48 checks。

## 最近變更（2026-08-28）— 模型選單重整、設定頁改成推論設定、GPU 語音辨識

### 需求（使用者原話整理）

1. 設定頁只做「推論設定」＋「管理模型有沒有安裝」；**要用哪一顆模型，在檔案轉錄／即時字幕頁自己選**，選單同時有本地與雲端。
2. 檔案轉錄與即時字幕合併成一頁。
3. 模型清單重排：語音一小（CPU）一大（GPU）；翻譯一小一大再加特製的 LinguaForge。標籤寫明量化位數。
4. LinguaForge Q8 移除（連本機檔案一起清掉），只留 Q4。
5. 設定頁分區改成 本地模型／雲端模型／語音朗讀／基本；語音朗讀往上；語音要能試聽。

### GPU 語音辨識：為什麼是 llama-server sidecar

三條路都查過／測過才決定：

| 方案 | 結論 |
|---|---|
| sherpa-onnx 開 CUDA | npm 的 `sherpa-onnx-win-x64` 是 CPU-only 編譯；要換官方 win-x64-cuda 的 DLL，還得 CUDA 12＋cuDNN 9 版本完全對上（另外 ~700MB），對不上會**靜默**退回 CPU |
| node-llama-cpp | `3.20`（npm latest）**沒有 multimodal／audio API**，dist 裡連 image 都 grep 不到 |
| **llama-server sidecar** | 採用。llama.cpp 官方支援 Qwen3-ASR GGUF，`llama-server` 自帶 `/v1/audio/transcriptions`；**Windows Vulkan 版只有 34MB**、自帶 CPU backend，不需要 CUDA／cuDNN |

實測數字（RTX 5060 Ti，4.42 秒音訊）：

| 情況 | 結果 |
|---|---|
| 不帶 `--device`，只給 `--gpu-layers 99` | prompt eval **7.43 tok/s**（整包跑 CPU，不印任何錯誤） |
| 帶 `--device Vulkan0` | prompt eval **720 tok/s**，快 **97 倍** |
| sidecar 冷啟動 | 2.9～3.3s |
| 轉錄（首次／第二次） | 312ms／**93ms**（約 47× 實時） |

**這是最容易踩的坑**：兩種情況都成功回應、都不報錯，只有比對 tok/s 才發現在跑 CPU。

另外兩件上游行為：Qwen3-ASR 經 llama-server 回來會夾 `language Chinese<asr_text>` 前綴
（llama.cpp issue #26749，未修）→ `stripAsrTags` 剝掉；中文一律吐簡體 → 跟 CPU 那條一樣套 `s2twp`
（判斷函式 `shouldS2twpSource` 從 `local-asr.js` 移到 `opencc.js` 共用）。

### 做法

- **新檔**：`src/main/llama-asr.js`（sidecar 生命週期＋multipart 轉錄，介面刻意跟 `local-asr.js` 一模一樣）、
  `src/main/asr-select.js`（唯一的選擇點，~110 行）、
  `src/renderer/scripts/stt-page.js`（子分頁＋模型選單）、`src/renderer/scripts/model-picker.js`（選單共用邏輯）
- **registry**：新增 `qwen3asrgpu`／`llamaruntime`（`archive: true`，下載後 PowerShell `Expand-Archive`，
  已安裝與否看 `check` 不看下載檔名）／`qwen354b`；移除 `linguaforge08`（Q8）
- **模型選擇不新增狀態**：選單只是 `asrEngine`+`asrModelKey` 與 `translator`+`localTranslateModel` 的扁平視圖，
  選了立刻寫回（跟主題一樣即時套用）。語音轉文字頁與翻譯頁共用同一份
- **信任邊界**：`localAsr:*` 的 `modelKey` 不再由 renderer 傳，一律 main 從 store 讀；
  `tts:preview` 新增的 `voice` 參數對 `tts-voices.js` 的固定表做白名單驗證
- 舊使用者的 `localTranslateModel = 'linguaforge08'` 由 `main.js` 的 `RETIRED_MODEL_KEYS` 讀成 Q4

### 踩到的三件事

1. **`engine.js` 沒有 `setStore`**：`main.js` 的 `lazyLoad` 靠它把 store 塞進模組，而 `engine.acquire`
   會比任何 `localAsr:*` IPC 更早發生（進頁就 prewarm）。少了這一層轉發，`asr-select` 讀不到
   `asrModelKey`，使用者選了 GPU 模型也會 warm 成 CPU 那顆。
2. **`#page-live.active { display: flex }` 搬過來會壞**：子分頁的顯示是 `.subtab-panel.active` 在管，
   再對容器裸寫 display 就會蓋掉 `display: none` → 兩個子分頁疊在一起（跟當初 `.page` 同一個坑）。
   改成內容自己 `margin: 0 auto` 置中。
3. **批次 sed 換 model key 會誤傷斷言**：`isLlmKey('linguaforge08') === false` 被改成
   `isLlmKey('linguaforge08q4') === false`（永遠 false），測試會假綠。改完要逐條看 diff。

### 驗證

新測試：`npx electron scripts/e2e-llama-asr.js` **21 passed**（含真的拉 sidecar、TTS 往返比對、程序收得掉）、
`node scripts/e2e-stt-cdp.js` **16 passed**（打包版；跑完還原使用者的四個 store key）。

回歸全綠：smoke 22／visual 46／usage-cdp 10／agy-cdp 33／chat-cdp 42／terminal-cdp 29／tray-cdp 12／
e2e-chat 117／e2e-agy 98／mappers 50／usage 30／error-hygiene 32／markdown 23／terminal 50／VAD 11／
reorder 15／asr-threads 10／linguaforge-decode・list ALL PASS。

真實推論：
- Qwen3.5-4B 六方向翻譯全部正確，專名（Kimi／Sol Energy）與年份（2024）都保住，無標籤前綴；GPU 上 190～440ms/句
- 打包版切到 GPU 語音模型跑真實檔案轉錄：CPU 0.6B 回空字串、**GPU 1.7B 回「咳咳咳。」**（同一個
  `scripts/test-sample.wav`，CPU 那顆回空是既有的已知限制）

### 順手修好的：視窗被遮住時檔案轉錄會卡在 1%

合併頁跑回歸時 `e2e-ui-transcribe.js` 永遠停在「準備中… 1%」。不是分頁改動造成的，
是 `transcribe.js` 放很久的 `waitForPaint()`——它 `await` 兩層 `requestAnimationFrame`，
而**視窗被遮住時 rAF 完全不觸發**（CDP 實測 `document.hidden: true` 時 3 秒零回呼）。
`finally` 又把按鈕解鎖，症狀就是「按了沒反應」。修法是 rAF 配 200ms 逾時，兩者誰先到都算。

### 沒做

- llama-server 的 CUDA 版本（239MB＋373MB cudart）：Vulkan 已經能吃 GPU，先不做第二套
- 聊天接生成圖片的模型：使用者當初問的是「支不支援」，沒有要求實作

---

## 最近變更（2026-08-28）— 「新終端機」彈窗對齊 ＋ CDP 測試不再絕對定位

使用者回報「新終端機」彈窗歪掉：標題與按鈕列在 24px，欄位卻貼到 0。

- **根因**：`.app-dialog` 自己 `padding: 0`，那 24px 是 `.dialog-head`／`.dialog-actions` 各寫各的。
  五個彈窗內容區裡 `.term-new-body` 是**唯一**沒補 `padding: 4px 24px 0` 的（CDP 實測 pad 0px/0px，其餘四個都 24px）
- 順手收窄：`.app-dialog` 的 760px 是給模型清單那種寬內容用的，三個欄位的表單改 `#termNewDialog { width: min(460px, 92vw) }`，
  select 也拉滿寬（原本 `min-width:180px` 孤零零漂在一片空白裡）
- **同類問題掃過了**：全 8 頁 × 1440/900/560 逐一量「子元素有沒有超出父層 content box」→ 0 筆；
  五個彈窗在 1440／560 兩個寬度都對齊、無溢出。只有 `.term-new-body` 這一處
- 檢查折進 `e2e-visual-cdp.js`（新增 `dialog-align`，49 → 52 checks），一次性探測腳本不留

### 順帶修好的：`e2e-terminal-cdp.js` 會誤傷使用者資料

跑回歸時 3 條 FAIL，追下去不是產品壞掉，是測試自己用「第一列」與絕對總數定位：

- `document.querySelector('.term-list-item')` 抓的是側欄第一列——使用者本來就有工作階段時，
  那是**別人的**，而下一步就是點刪除。`panes === 1`／`count === 1` 這種絕對數同理必然對不上
- 收尾只刪 `createdId`，中途建立的第二個階段沒刪：測試一中斷就在使用者側欄留一筆垃圾
  （這次就撈到一筆 `t_mtcm9jv3_pu3dwn`，測試環境的真實殘留）
- 改法：全部改用 `[data-id="<自己建的 id>"]` 指名，斷言改看「那個 id 的 pane 在不在」，
  `secondId` 一併納入 finally。改完在**留著殘留資料**的情況下重跑 → 29 passed, 0 failed

驗證：`e2e-visual-cdp.js` 52 ／ `e2e-terminal-cdp.js` 29 ／ `e2e-chat-cdp.js` 42 ／ `e2e-cdp-smoke.js` 22。

## 最近變更（2026-08-28）— 側欄拖曳排序 ＋ AGY 自動續期真的修好

### 一：終端機側欄加拖曳

聊天側欄本來就有拖曳＋Alt+↑↓，實作與終端機需要的一模一樣（連 class 都共用），
所以抽成 `src/renderer/scripts/list-reorder.js`，兩頁都用它，沒有各寫一份。
碰撞判定沿用 `usage-reorder.js` 的 `pickCollision`。

### 二：AGY 自動續期在打包版一直沒生效（root cause 找到了）

上一輪做的「代跑 `agy.exe models` 續期」看起來有做，實際上每次都在等逾時：
使用者的請求卡滿 60 秒才回 `TOKEN_EXPIRED`，而同一支指令從主控台跑只要 2～3 秒。

原因**不是**憑證、不是 stdout、也不是 CLI 需要主控台，而是 **`execFile`**：
它把三個 stdio 都接成 pipe，而且**不會把 stdin 那條關掉**——`agy.exe` 拿到一條開著、
永遠收不到 EOF 的管線，就在那裡等輸入。

`scripts/probe-agy-nudge.js` 的實測矩陣（這支留著，之後動 `runAgyCli` 前先跑）：

| 寫法 | 結果 |
|---|---|
| A `execFile`（現況） | **逾時 25s** |
| B `spawn` + stdin `ignore` | exit 0，2.8s |
| C 找不到憑證 + stdin `ignore` | exit 0，2.2s |
| D 找不到憑證 + stdin 繼承 | exit 0，2.1s |
| E `spawn` + stdin `pipe`（不寫也不關） | **逾時 25s** ← 證實是 stdin |
| F `spawn` + 三個都 `ignore`（採用） | exit 0，2.1s |

修法：`runAgyCli` 改用 `spawn(exe, ['models'], { windowsHide: true, stdio: 'ignore' })`，
逾時從 60s 降到 30s（正常 2～3 秒，這只是防真的卡住）。
走真正 `credential.acquire` 的計時：**1798ms**（原本會等滿逾時）。

回歸測試：`e2e-agy.js` 新增「代跑 CLI 的 stdin 是 ignore」「代跑 CLI 不開視窗」，
擋住有人為了「簡潔」改回 `execFile`。

### 驗證

- `npx electron scripts/e2e-agy.js` → 98 passed
- `node scripts/e2e-terminal-cdp.js` → 29 passed（新增拖曳與 Alt+↑ 兩條）
- `node scripts/e2e-chat-cdp.js` → 42 passed（聊天側欄拖曳原本就有測，抽共用後仍過）
- 其餘回歸：smoke 22／visual 49／usage-cdp 10／agy-cdp 33／tray 12／terminal 50／
  e2e-terminal 27／mappers 50／usage 30／error-hygiene 32／markdown 23／usage-reorder 15

## 最近變更（2026-08-28）— 終端機分頁（AI 代理用）

### 需求

nav 加一個終端機分頁；側欄像聊天那樣多開與管理，**每一列要看得出「運行中」還是「已完成」**
（同時跑三個代理時，一眼知道哪個跑完該回去看）。新終端機可選啟動指令、跑完要提醒、
每個工作階段記住工作目錄。

### 技術選擇（都先實測過才寫）

| 事項 | 結果 |
|---|---|
| `@lydell/node-pty` | Electron 43 直接 require 就能用（N-API prebuilt，不需 electron-rebuild） |
| ConPTY 視窗標題當忙碌訊號 | **不行**，跑 `ping` 期間標題一直是 `powershell.exe` |
| 只靠 OSC 133 提示字元標記 | **不行**，PSReadLine 在外部輸出時重繪，三秒內重送 9 次 `D;0` |
| `D` 標記帶 `Get-History` id 去重 | **可以**，ping 期間全是 id=1 的重繪，結束才 id=2；`cmd /c exit 7` 正確回 code=1 |
| xterm.js vendoring | **不用**，`lib/xterm.mjs`／`addon-fit.mjs` 直接相對路徑 import `node_modules` |

### 做法

- `src/main/terminal/`：`status.js`（純函式狀態機）／`pty.js`（生命週期＋256KB scrollback＋
  16ms 輸出合併）／`store.js`（`<userData>/terminals.json`，只存 metadata）／`ipc.js`（逐一列舉白名單）
- 忙碌判定雙軌：**送出非空指令 → 運行中**；**新的 history id 的 `D` 標記 → 已完成＋離開碼**；
  沒有 shell integration（cmd）或代理 REPL 的情況靠**靜默**（有指令在跑 4s／已回提示字元 0.8s）
- shell integration 用 `-NoExit -Command` 注入一層 prompt wrapper，字串**完全不含雙引號**
- 信任邊界：shell／preset 只收 key（執行檔與指令在 main 固定表）、cwd 走 `terminal:pickDirectory`
  系統對話框再 `statSync().isDirectory()`、write ≤8KB、cols/rows 夾值、最多 20 個工作階段
- renderer 每個階段留一份 xterm 實例（切分頁只換顯示）；`open()` 回快照＋`seq`，
  監聽器收到 `seq <=` 的片段直接丟掉，避免快照與串流重疊

### 踩到的兩個坑

1. **`term.open()` 掛在 `display:none` 的格子上**會開出 0×0 終端機 → 提示字元整段消失，
   但之後的輸出又正常，看起來像 pty 沒起來。改成 `createPane` 先切 `is-active` 再 open。
2. **第一個看到的 `D` 標記不是「跑完了」**，是「現在這個提示字元」。原本 `maxHistoryId` 從 -1
   起跳，指令送出後遇到的第一次重繪就被當成完成。

### 驗證

- `node scripts/test-terminal.js` → 50 passed
- `npx electron scripts/e2e-terminal.js` → 27 passed（真 ConPTY，連跑兩次都穩）
- `node scripts/e2e-terminal-cdp.js` → 27 passed（打包版）
- 回歸：smoke 22／visual 49／usage 10／chat 42／agy-cdp 33／tray 12／agy 96／mappers 50／
  usage 30／error-hygiene 32／markdown 23／usage-reorder 15

> smoke 的「long text translated in chunks」曾失敗一次，原因是使用者的雲端翻譯指向自己的 AGY
> 反代而 Antigravity token 過期（AGY 日誌 `TOKEN_EXPIRED`，耗時 60s = `nudgeCli` 逾時）。
> 手動跑一次 `agy models` 續期後就 22/22。**順帶發現：自動續期在打包版沒生效**——
> 同一支 `agy.exe models` 從主控台跑只要 3 秒，App 用 `execFile(windowsHide:true)` 代跑卻等滿 60 秒。
> 疑似 CLI 在沒有主控台／stdin 時卡在互動式重新登入。下次處理這條時從這裡查起。

## 最近變更（2026-08-28）— 常駐系統匣 ＋ 開機自啟動

### 需求

關掉視窗後 AGY 反代要繼續服務（接上去的客戶端不能斷），並且能設定開機自動啟動。

### 做法（`src/main/main.js`）

- `closeToTray`（store，**預設開**）：主視窗 `close` 事件 `preventDefault()` + `hide()`，
  第一次縮起來才建 `Tray`（顯示 VoiceInk／結束 VoiceInk）。關掉開關就恢復「關窗即結束」。
- 開機自啟動：`app.setLoginItemSettings({ openAtLogin, args: ['--hidden'] })`。
  **真相在 OS，不進 store**——使用者可能在工作管理員的「開機」分頁直接停用，
  存一份自己的布林值只會跟系統對不上。`isDev` 不註冊（會把 node_modules 的 electron.exe 排進去）。
  帶 `--hidden` 開機時視窗直接 `show: false`。
- 單一實例鎖：常駐之後這是必要條件，不是保險。
- `agy-page.js` 輪詢加 `document.hidden` 檔板：那條會開 PowerShell 讀 Credential Manager。
- 設定 → 外觀新增兩個 checkbox（`.setting-check`），跟主題一樣即時套用、不用按儲存。

### 踩到的兩件事

1. **輸掉單一實例鎖的那份要 `app.quit()`，不是 `app.exit()`**。exit 立刻砍掉自己，
   「我來過了」的通知來不及送到第一份 → 藏在系統匣時再點捷徑有時叫不出視窗。
2. **`document.hidden` 同時代表「被完全遮住」**。CDP 測試從背景 node 程序 spawn 第二份，
   Windows 不給前景權，`show()` 之後馬上被終端機遮回去（`visibilitychange` 記到
   `visible → hidden`）。斷言改看「有沒有 visible 過」後三連跑 12/12 穩定。

### 驗證

`node scripts/e2e-tray-cdp.js` 12 passed（含**藏起來時 `http://127.0.0.1:8788/health` 回 ok**，
即反代真的沒斷）。回歸：smoke 22、visual 43、usage-cdp 10、chat-cdp 42、agy-cdp 33 全過。

## 最近變更（2026-08-28）— AGY token 自動續期（不再「用幾分鐘就斷線」）

### 症狀

客戶端接上 AGY 反代後幾十分鐘就開始 401／`TOKEN_EXPIRED`，使用者得自己再跑一次 `agy` 指令才會通。

### 根因

Antigravity 的 access token 只有 1 小時（實測憑證 `expiry` 就是 +1h）。續期需要 OAuth client id／secret，
但那是 Antigravity IDE 的 public desktop client，**刻意不寫進原始碼**（見 CLAUDE.md），
所以 `refreshAccessToken` 在使用者機器上永遠回空字串。
到期後 VoiceInk 只能等「有人跑一次 Antigravity CLI」把新 token 寫回 Windows Credential Manager——
而那個「有人」以前就是使用者本人。

### 修法（`src/main/agy/credential.js`）

我們沒有憑證，但 CLI 有：`agy.exe models` 是最便宜的「要連上游」子指令（實測 1.8s／exit 0），
跑完就會續期並寫回同一個 Credential Manager 項目。所以由我們代跑：

- `nudgeCli(deps)`：跑 `agy.exe models`，失敗吞掉。冷卻 60 秒 ＋ `nudgeInFlight` 合併
  （token 尾聲每個請求都會走到 `loadToken`，沒冷卻會連開一堆 186MB 的程序）
- **stale 但還沒真的過期** → `void nudgeCli()` 背景跑，這次照常回舊 token，不擋使用者
- **真的過期或 `mustRefresh`（上游 401）** → `await nudgeCli()` 後重讀憑證；
  重讀結果必須是**不同的** access token 才算續期成功，否則照樣拋 `TOKEN_EXPIRED`
- `agyCliPath(env)` 從 `detectSources` 抽出來共用；CLI 沒裝就直接跳過（IDE 使用者維持原行為）

回歸：`npx electron scripts/e2e-agy.js`（96 passed）新增四條——自動續期、續期失敗仍拋錯、
背景續期不擋請求、連續請求不連開程序。測試自建假 `LOCALAPPDATA/agy/bin/agy.exe`，
不依賴開發機有沒有裝 CLI，也不會真的把 `agy.exe` 叫起來。

### 沒驗到的

沒有等真實 token 過期做端到端實測（要 ~1 小時，且偽造 Credential Manager 內容有弄丟登入的風險）。
「跑 CLI 就會續期並寫回」這一點的依據是使用者原本的手動流程本來就有效。

## 最近變更（2026-08-25）— 再開一次啟動

上一輪只延後 CUDA／AGY，主行程仍同步 require 全部模組、視窗等 store、asar.unpacked 有 447MB DLL（Defender 掃很久）。

- `whenReady` 立刻建窗 `show: true`，theme 只 peek `config.json`，不 await electron-store。
- ASR／LLM／引擎／額度／AGY／CUDA／TTS 第一次 IPC 才 require；AGY 僅在 `agyEnabled` 時才於第一幀後 autoStart。
- 非聊天分頁改 dynamic import；即時字幕進頁才寫 hint。
- `asar.smartUnpack: false`，否則 builder 會自動把 ffmpeg.exe／`.node` 整包解開。ffmpeg 拷到 `%APPDATA%/voiceink/native/ffmpeg.exe`；CUDA／Vulkan 拷到 `%APPDATA%/voiceink/native-modules/`（**禁止寫安裝目錄**）。
- 量時間：`node scripts/probe-startup.js`。剛打包第一次 ~21s（Defender 掃新 asar）；第二次 **434ms**（whenReady 46ms）。unpacked 從 447MB → 66.5MB。

## 最近變更（2026-08-27）— 聊天頁版面重整＋側欄排序

- **上方工具列整排移除**：標題輸入框、系統提示、模型選單、刪除鈕原本擠在訊息串上方。
  系統提示（含 ⚙ 管理鈕）與模型選單搬到輸入框那一排，刪除搬到側欄，標題輸入框由側欄
  就地改名取代 → `.chat-main` 頂端只剩 banner。
- **側欄每一列**：開啟鈕 ＋ 改名（✎）＋ 刪除（🗑），兩顆 icon 鈕平常 `opacity: 0`，
  hover／active／focus-within 才浮出。刪除是**就地二次確認**：第一次按變成紅色的勾（`.is-armed`），
  3 秒內再按一次才真的刪，逾時自動復原；`renderList` 重畫前先 `disarmDelete()` 收掉計時器。
  刻意不用 `window.confirm`——原生彈窗會擋住整個 App，樣式也跟 Aurora 完全不搭。
- **就地改名**：`.chat-list-title` 換成 `.chat-list-rename` 輸入框，Enter／失焦送出、Esc 取消；
  輸入框自己吃掉 `pointerdown`，否則打字中的拖曳會被當成排序。
- **拖曳排序**：pointer 直拖（4px 門檻），碰撞沿用 `usage-reorder.js` 的 `pickCollision`
  （pointerWithin → closestCenter，直的橫的都能用），拖曳中直接 `before/after` 換位置，
  放開才 `chat:reorder` 落盤一次。另有 Alt+↑／↓ 鍵盤排序。
  搜尋狀態下用 `mergeVisibleOrder` 把沒顯示的那些塞回原相對位置，不會因為過濾就掉順序。
- **main**：`chat-store.list()` 不再依 `updatedAt` 排序（陣列順序＝顯示順序）、`create()` 改 `unshift`、
  新增 `reorder(ids)`（只接受既有 id，未列到的附在後面）；`writeAll` 超過上限時改成 `filter`
  掉 `updatedAt` 最舊的，避免把手動順序洗掉。
- **AGY 日誌不再被測試清空**：`e2e-agy-cdp.js` 跑在正式 profile 上，原本會呼叫 `clearLogs()`
  把真實流量與統計整個刪掉。改成只驗按鈕存在；清空行為由 `e2e-agy.js`（自己開暫存 DB）覆蓋。
- 驗證：`npx electron scripts/e2e-chat.js` 117（新增 [E2] 側欄手動排序 7 條）、
  `node scripts/e2e-chat-cdp.js` 42（新增版面與側欄 10 條）、smoke 22、visual 43。

## 最近變更（2026-08-27）— AGY 統計面板與客戶端提示

- **客戶端提示**：服務控制區新增可摺疊的「客戶端怎麼填？」，把兩組 Base URL 分開列——
  Claude Code／CC Switch 用 `anthropicBaseUrl`（根位址，附「不要加 `/v1`」的說明與原因），
  OpenAI 相容工具用 `baseUrl`（帶 `/v1`）。頁面原本只顯示帶 `/v1` 的那一組，旁邊卻寫著
  「Claude Code 用 ANTHROPIC_BASE_URL」，等於直接把人導向 404。
- **統計時間範圍**：6 小時／24 小時／7 天／30 天／全部。範圍是 main 的白名單
  （`logs.STAT_RANGES`），renderer 只送 key；summary／series／models 三者套同一個 cutoff。
- **序列補零**（`fillSeries`）：SQL 只回「有資料的桶」，先前 3 筆請求會被攤成整條 24 小時軸，
  看起來像整天都在跑。≤48h 用小時桶、其餘用天桶，最多 96 格。
- **圖表 hover 顯示數量**：自訂 tooltip（次數／時間／tokens），取代原本的原生 `title`；
  位置夾在圖表寬度內，`pointerleave` 收起。
- **模型分佈改成上下堆疊**：左右並排時模型名全被擠成省略號；堆疊後用
  `repeat(auto-fit, minmax(220px, 1fr))`，寬螢幕自然排成多欄。
- **省空間**：統計卡 padding 14→10、數值 24→20px；長條圖 132→108px；圖表間距 18→12px。
- 修掉 `.agy-model-row` 與「可用模型」面板撞名（統計那份改名 `.agy-dist-row`）——
  後面那份把分佈列改成 flex row，進度條整條看不見。
- 驗證：`e2e-agy.js` 90（含補零／天桶／未知 range 退回預設）、`e2e-agy-cdp.js` 33
  （含兩組 Base URL、堆疊排版、範圍切換、hover 數值）、`e2e-visual-cdp.js` 43、smoke 22。

## 最近變更（2026-08-27）— AGY 接 Claude Code（CC Switch）

真實 Claude Code CLI 打 AGY 一律 `502 UPSTREAM_400`，只有一般聊天正常。原因不在鑑權也不在協議轉換，
而是 `sanitizeSchema` 的白名單只擋「欄位名不對」，擋不住「欄位名對、型別不對」——
Claude Code 一次送 195 個 MCP 工具，其中三支寫法不合 Gemini 的 Schema proto，整包請求就 400，所有工具一起陣亡：

| 客戶端寫法 | 上游錯誤 | 修法 |
|---|---|---|
| `type: ['string','null']` | `Unknown name "type" ... Proto field is not repeating` | 取第一個非 null 型別＋`nullable: true` |
| `{type:'boolean', enum:[true]}`（anyOf 判別欄位） | `Invalid value at ...value.enum[0]` | enum 只留「字串陣列＋`type:'string'`」，其餘剝掉 |
| `anyOf: [X, {type:'null'}]` | 同上（null 變體變空殼 object） | null 那支換成 `nullable`；只剩一支就攤平 |

- 單一修改點在 `agy/gemini.js` 的 `sanitizeSchema`（兩個協議共用）；回歸測試 `test-agy-mappers.js` 加三條（50 passed）。
- 除錯手法可重用：用 20 行 mock server 錄下 Claude Code 真正送的 body（`/v1/messages?beta=true`，約 300KB／195 tools），
  再把每個工具的 sanitize 結果拿去比對 Gemini Schema proto 的欄位規則（靜態掃描 390 個工具 → 0 問題），不必每次都打上游。
- CC Switch 設定（`~/.cc-switch/cc-switch.db` 的 `providers` 表，`app_type='claude'`）：
  `ANTHROPIC_BASE_URL` **不能帶 `/v1`**（Claude Code 自己會接 `/v1/messages`，帶了就 404）；
  非 Claude 模型名要加 `[1m]` 後綴才不會被當成 200k 窗口（後綴由 CLI 自己剝掉，不會送到上游）。
- 驗證：`claude -p` 實跑純文字與工具呼叫（Read）各一次，經 AGY → cloudcode-pa 全鏈路通過。

## 最近變更（2026-08-25）— 額度拖曳閃爍 ＋ AGY 模型名稱排序

- 額度卡拖曳：跟手 overlay + 格子鬼影；拖曳中只 `translate3d` 到靜態槽位（不 `appendChild`、不拿動畫中的 rect 做碰撞），放開才改 DOM。這才是 Token Anxiety／dnd-kit 的模型，先前 FLIP+重排 DOM 會卡頓閃爍。
- AGY「可用模型」：Claude 池（含 GPT OSS）在前、Gemini 在後；世代由新到舊，Gemini 同代依思考強度 high → medium → tiered → low → extra-low → lite（`pro-agent` 無世代號排最後）。
- 驗證：`test-usage-reorder.js` 10；`test-agy-mappers.js` 46。

## 最近變更（2026-08-24）— 完整應用程式測試與安全依賴更新

- Electron `35.7.5` 升到固定版 `43.4.1`；`electron-builder`／Vite 等相容範圍內依賴更新，`npm audit`（含 dev）為 0。
- 修正 `probe-prompt-path.js` 預設把 Q4 檔名接到 Q8 資料夾的錯誤；修正 `e2e-cdp-smoke.js` 啟動期間分頁被初始化流程洗回聊天頁的 race（22/22）。
- 核心回歸：AGY main 79、聊天 main 110、額度 29、mapper 44、error hygiene 32、Markdown 23、VAD 11、ASR threads 10、engine audit 15，全部通過。
- 本機推論：Q8／Q4／Qwen3.5 的 CPU＋CUDA、六方向翻譯、長文／條列／污染、30 句 wrapper 品質門檻全部通過；即時 loopback → VAD → ASR → 字幕 6/6。
- 打包版：visual 43、chat CDP 32、usage CDP 9、AGY CDP 26、smoke 22，全部通過；七頁在副螢幕 `DISPLAY10` 實際截圖，無水平 overflow／白黑屏。
- 真實整合：五家額度 6/6；AGY 21 模型 sandbox／daily 皆 200，prod 429 為已知端點差異；budget-0 名單全對齊。
- 正式 profile 測前快照、測後還原；`config/chats/usage` hash 一致，AGY DB 邏輯資料一致。桌面 QA 若使用者同時操作電腦，只能用 CDP／視窗 API 定位，不得移動滑鼠、發全域快捷鍵或搶焦點。

已知測試限制：固定 `scripts/test-sample.wav` 在目前 ASR 回空字串，內容正確性由 Edge TTS 往返樣本驗證；大量反覆切換 LLM backend 時測試程序會出現 `MaxListenersExceededWarning`，未造成推論／卸載失敗，來源是刻意不 dispose 的 node-llama-cpp binding。

## 最近變更（2026-08-21）— 第二輪掃描（額度中斷後接續）

Claude session `349067c5` 在派出 6 個子代理後因 session limit 中斷。本輪重跑掃描並修真 bug。

| 嚴重度 | 項目 | 處置 |
|---|---|---|
| 高 | Antigravity API 失敗（空窗、status=connected）仍 `mergeExpectedWindows` → 四條 100% | 只在 `windows.length > 0` 時 merge；空窗走 6h soft cache |
| 高 | 長文翻譯中途切頁：分段迴圈續打 IPC、LLM 幽靈重載、「停止」被 disable | cooldown 作廢 `_translateRequestId`；翻譯中維持可點停止 |
| 中 | 重新生成先砍舊助理再 fetch，失敗就丟回覆 | 記憶體剝尾端再打 API，有新內容才落盤 |
| 中 | `chats.json` 無序列鎖；新圖尚未入 json 就被 prune | `withStore`；`chatImages.hold` |
| 中 | 檔案轉錄 pause 形同虛設；Duration N/A 無硬上限 | 排隊段數≤2；`samplesDone`／片段數套 4h |
| 中 | AGY 非 2xx 不消耗 body | `discardResponse` |
| 中 | `fetchAvailableModels` 失敗整筆丢掉 summary | models 改 `required: false` |
| 中 | AGY 切走後 5s 輪詢仍打 DB | `pageGen` ＋頁面仍 active 才 `startPolling` |
| 中 | 聊天 API URL 不合法時成功 toast 蓋掉錯誤 | `saveChatSettings` 回 boolean |
| UI | 深色主按鈕白字 2.73:1；淺色 tertiary／accent／語意色不足；窄屏 nav 無 aria-label | token 加深、深色鈕改深色字、nav／錯誤列／toast 補 aria |

未修（明確不是這次範圍，或證據不足當產品取捨）：OpenCode 倒數用 UTC（測試鎖定；UI 未標時區）、Edge TTS 取消不關 WebSocket（library 限制）、雲端轉錄取消不 abort 當下 fetch、標題階層跳級、訊息動作鈕 <24px。

驗證：`node scripts/test-usage.js` 29；`npx electron scripts/e2e-chat.js` 110；`npx electron scripts/e2e-agy.js` 79；`node scripts/test-agy-mappers.js` 44；`node scripts/test-error-hygiene.js` 32。

## 最近變更（2026-08-21）— 掃描後續：錯誤訊息衛生與輸入校驗

第一輪掃描列為「沒動、但值得知道的」七項，逐一評估後全部處理。

| # | 位置 | 是不是 bug | 處置 |
|---|---|---|---|
| 1 | `cloud-asr.js` `classifyHttpError` | **是**（會外洩） | 4xx 分支原本把 200 字上游 body 併進使用者可見訊息。實測：mock 上游回夾帶 `Bearer sk-…` 的 body，UI 訊息原樣印出三個假 token。改成只留狀態碼＋可行動說明，並補 404 分支 |
| 2 | `local-llm.js` 雲端翻譯 | **是**（會外洩） | `data.error.message` 直接透傳、無法解析時另加 120 字 preview。同上處理，`console.error` 只記狀態碼 |
| 3 | `main.js` `subtitleWindowBounds` | **是**（校驗缺口） | allowlist 裡唯一沒 sanitize 卻直接進 `new BrowserWindow()` 的 key。新增 `sanitizeSubtitleBounds`，`store:set` 與 `createSubtitleWindow` 兩邊都走 |
| 4 | `app.js` `renderModelItem` | 不是（但破例） | 值全來自寫死的 registry，不可利用；但這是 renderer 唯一一處 `innerHTML` 插值。改成 createElement + textContent |
| 5 | `preload.js` 三個 `on*` | 不是 | 三個註冊點都在 DOMContentLoaded 只跑一次，沒有實際洩漏。仍補上 unsubscribe 讓八個 `on*` 一致 |
| 6 | `agy/anthropic.js` `errorStream` | 防禦性 | 沒有實測失敗（TS SDK 遇 `event: error` 會先丟例外）。仍在錯誤格前補 `closeBlock`，追蹤區塊狀態的客戶端才不會停在半開 |
| 7 | `usage/opencode.js` `queryLatestReset` | 不是（死碼） | 「小於 1e12 就當秒」的對沖永遠觸發不到（篩選條件用的就是毫秒）。實測本機 db 4084 列、max=1781098765082 確認是毫秒，移除對沖 |

新測試 `scripts/test-error-hygiene.js`（32 checks，node 直跑）：修復前 8 紅、修復後全綠。
`e2e-cdp-smoke.js` 加一條 `model list rendered without innerHTML`（21 → 22 checks）。

## 最近變更（2026-08-21）— 全庫 bug 掃描修正三則

### 1. Antigravity 額度：憑空的「100% 已用盡」被標成官方資料（嚴重）

`syncAntigravity` 在回傳前先跑了一次 `mergeExpectedWindows(result.windows, null)`。
補視窗這件事需要「上一次的快取」才做得對，而只有 `usage/index.js` 的 `mergeAccountState`
拿得到 previous。先補一輪的後果是兩層都壞：

- 上游沒回的視窗被寫成 `100/100`（UI 顯示「已用盡」），快取裡的真實值撿不回來
- index 那層看到四個 id 都已存在 → `restoredAntigravity` 恆為 false
  → accuracy 不會降級成 `estimated`，卡片仍寫「官方 API · 已讀取真實額度」

實測：上游只回 Gemini 時，Claude 兩條顯示 100% 用盡且標官方；
上游完全沒回額度時四條全是假的 100%。
**修法**：`syncAntigravity` 只回上游真的給的視窗，補齊交給 `mergeAccountState`。

### 2. 聊天：`inflight` 守衛是 TOCTOU，併發請求會一起放行

`if (inflight) return` 是同步檢查，但 `inflight = {...}` 排在四個 `await` 之後
（讀對話／存圖片／寫使用者訊息）。同一個 tick 送兩則時兩個都通過守衛：
兩條上游串流、兩則使用者訊息連著寫進同一個對話，先開的那條被後者覆蓋掉——
「停止」按鈕 abort 不到它，首 token／閒置計時器還會去改到別人的 `reason`。
**修法**：守衛通過後立刻建 controller 並佔位，其餘全部包進 `try`，`finally` 統一清。

### 3. AGY：`count_tokens` 把上游狀態碼原樣透傳

其他端點都走 `statusFor`（只有 429 透傳、其餘收斂成 502），只有 `handleCountTokens`
自己寫 `error.status >= 400 ? error.status : 502`。實測上游 401／403／500 分別原樣回
401／403／500。Claude Code CLI 正是靠 count_tokens 估上下文，收到 401 會誤判成
自己的 API key 壞了。**修法**：改走 `statusFor`，並補上 `retry-after`。

### 驗證

- `node scripts/test-usage.js` 25（新增「Antigravity 同步只回上游真的給的視窗」）
- `npx electron scripts/e2e-chat.js` 108（新增「無 inflight 時同 tick 併發」5 條）
- `npx electron scripts/e2e-agy.js` 79（新增 count_tokens 錯誤路徑 5 條）
- 三條新測試都確認過「修復前紅、修復後綠」

## 最近變更（2026-08-21）— 憑證過期判定與失敗訊息

### 症狀

「可用模型」按重新查詢跳出「反向代理操作失敗」。

### 根因（兩層，都是自己造的）

1. **還沒過期的 token 被自己作廢**。`tokenIsStale` 的 15 分鐘是「該去續期了」的提前量；
   沒有 `ANTIGRAVITY_CLIENT_ID`／`SECRET` 時 refresh 必然回 null，
   舊的 `loadToken` 把「refresh 拿不到」直接當成過期拋 `TOKEN_EXPIRED`——
   實測當下憑證還有 7 分鐘壽命，等於每個 token 的最後 15 分鐘都用不了。
   額度頁的 `syncAntigravity` 本來就會退回舊 token 繼續用，只有反代這條路徑硬失敗。
2. **訊息什麼都沒說**。`agy:*` IPC 把所有錯誤收斂成「反向代理操作失敗」，
   而狀態面板那份「憑證怎麼修」的指引只在**服務執行中**才渲染——
   服務沒開時憑證壞掉，整頁一個字都不會提。

### 修法

- `credential.loadToken`：refresh 失敗後檢查真實 expiry，還沒到就照用；
  `mustRefresh`（上游 401）是唯一例外，那種 token 本機 expiry 寫什麼都不算數
- `CredentialError` 帶 `userMessage`，`agy/ipc.js` 只轉送有這個欄位的訊息（白名單，不是黑名單）
- `index.js status()` 停止中仍回 `sources`（只是 fs 檢查）
- `agy-page.loadModels` 失敗碼屬憑證類時，自己叫出 `#agyCredentialHelp` 並捲到可視範圍；
  用 `credentialHint` 讓它撐過下一輪 `renderStatus`，憑證真的連上才清掉

### 驗證

- `npx electron scripts/e2e-agy.js` 75（新增「憑證過期判定」4 條、「IPC 錯誤訊息白名單」5 條、「服務停止中的狀態」2 條）
- `node scripts/e2e-agy-cdp.js` 23（打包版在**真的壞掉的狀態下**跑：確認訊息說是憑證問題並同時顯示指引）
- 修前／修後對照：`credential.status()` 由 `TOKEN_EXPIRED` 變 `connected: true`，型錄回 28 個模型（23 個對話可用）

## 最近變更（2026-08-21）— 聊天多供應商 ＋ 模型清單即時化

### 聊天：多組供應商

設定從四個扁平 key 改成陣列，一次性搬移（舊 key 寫入成功才刪）：

```js
chatProviders: [{ id, name, apiUrl, apiKey, models: [...] }]
chatProviderId  // 目前選的
chatModelId     // 必須 ∈ 目前那組供應商的 models
```

信任邊界不變：renderer 仍只送 `{reqId, conversationId, text, images?}`。
**模型驗證的基準是「目前這組供應商」**——只檢查「在不在任何清單裡」的話，
切到 B 之後還能拿 A 的模型名打 B 的端點（e2e caseK 專門擋這件事）。

`sanitizeProviders` 遇到不合法的 apiUrl **保留該筆、只清空 url**：
這個函式也跑在存檔路徑上，整筆丟掉等於打錯一個字就刪掉 API Key 與整份模型清單。

### 聊天：模型掃描

`chat:scanModels(providerId)` → main 用 store 裡的網址金鑰打 `GET {apiUrl}/models`。
逾時 15s、回應上限 2MB、模型數上限 500、錯誤只回 `{code, error}`。
**收 providerId 而不是 URL**，否則等於開一個任意網址代理。
副作用是掃描前會把草稿寫進 store（main 得讀得到），UI 提示已寫明。

結果走彈窗搜尋勾選，不直接覆蓋既有清單（OpenRouter 一次回 300+）。

### AGY：模型清單改成即時查詢

上游端點 `v1internal:fetchAvailableModels`，body 送 `{}`。
**回的 `models` 是以 model id 為 key 的物件，不是陣列**——用 `Array.isArray` 判斷會靜默拿到空清單。

`agy/catalog.js` 負責解析／過濾／快取（10 分鐘）：

- 對話可用性用 `maxTokens >= 100000 && maxOutputTokens > 0` 判斷，不用黑名單（黑名單會隨上游新增而過期）
- 實測 28 個模型裡濾掉 5 個 IDE 內部用的（`tab_*`、`chat_*`、`*-flash-image`）
- `deprecatedModelIds` 帶出接替者（`gemini-3.1-pro-high` → `gemini-pro-agent`）

反代的 `/v1/models` 改用即時清單，**但撈不到時退回靜態表**：
客戶端拿它填模型下拉，回空清單比回舊清單更糟。

AGY 頁新增「可用模型」面板：進頁不自動查（那是一次真實往返），
按鈕才查；顯示剩餘額度／context 上限／提供者，**模型 ID 本身就是複製鈕**。

### 映射表重建（實測驗證過）

`UPSTREAM_MODELS` 換成型錄的即時內容，映射目的地全部改指最新世代。
**每個目的地都跑過 `scripts/probe-agy-upstream.js` 實測 200 才寫進表**，過程中抓到三個問題：

| 問題 | 真相 |
|---|---|
| `gemini-3.6-flash-*` 回 400 `Request contains an invalid argument` | 不是壞掉，是**拒絕 `thinkingBudget: 0`**，只是錯誤訊息跟別人不同 |
| `gemini-2.5-pro` 回 503 `No capacity available` | 型錄裡有但實際不可用 → 移出清單 |
| `gpt-oss-120b-medium` 拒絕 budget 0 | 漏列 `REJECTS_ZERO_BUDGET` |

`THINKING_ONLY_MODELS` 更名為 `REJECTS_ZERO_BUDGET`（`allowsThinkingOff` → `allowsZeroThinkingBudget`）：
3.6-flash 照樣能關思考，它只是不接受把預算設成 0，原名會誤導。

另一個修正：**映射表不可覆蓋真實存在的上游 id**。
我一度把 `gemini-3-flash` 導向 3.7，但它上游真的有——使用者指名就該用它，
表裡只放上游查無此名的。

### UI 修復

模型清單空列的 placeholder 原本是 `DEFAULT_CHAT_MODEL`，
新增出來的列跟上一列文字一字不差、只差灰色，看起來像壞掉的重複項；
存檔時又被 `filter(Boolean)` 靜默丟掉。改成中性字樣＋自動 focus＋略過時給提示＋同組去重。

### 驗證

- `npx electron scripts/e2e-chat.js` 103／`npx electron scripts/e2e-agy.js` 64／`node scripts/test-agy-mappers.js` 44
- `node scripts/e2e-chat-cdp.js` 32（新增，打包版；全程只動草稿，測完還原真實設定）
- `node scripts/e2e-agy-cdp.js` 26（含模型面板對真實上游：23 個對話可用 / 28 個全部）
- smoke 21／visual 43／usage-cdp 9／usage 24／markdown 23／VAD 11／reorder 9
- 搬移實測：造一個帶非空 API Key 的舊狀態啟動打包版，Key 一字不差、兩個模型都在、選中的第二個模型沒被重設、舊 key 清乾淨

## 最近變更（2026-08-21）— AGY 反向代理頁

移植 [Antigravity-Manager](https://github.com/lbjlaq/Antigravity-Manager)（Tauri/Rust）的三項功能：API 反向代理、流量日誌、統計。第三個 nav 分頁「AGY反代」。

**範圍決策**（其餘刻意不做：多帳號輪換、Gemini 原生入口、圖片生成／音訊端點、thinking signature、cache_control、IP 白名單、限流）

- 協議入口：OpenAI `/v1/chat/completions`＋Anthropic `/v1/messages`
- 帳號：只用本機 Antigravity 憑證（單帳號，與額度頁共用 `usage/antigravity.js` 的憑證鏈）
- 安全：只綁 `127.0.0.1`＋強制 `Authorization: Bearer` 或 `x-api-key`
- 日誌：預設只記 metadata，除錯模式才記截斷 8KB 的 body
- 模型：內建映射表（移植自 `model_mapping.rs`）＋未知透傳

**模組**（`src/main/agy/`，每檔 ≤300 行）

| 檔案 | 職責 |
|---|---|
| `index.js` | 服務門面：start／stop／**shutdown**／status／saveSettings／logs／stats |
| `server.js` | node:http、路由、`timingSafeEqual` 鑑權、Host 檢查、32MB body 上限、SSE 寫出 |
| `credential.js` | token／project 記憶體快取、in-flight 合併、401 強制 refresh |
| `upstream.js` | cloudcode-pa 呼叫、SSE 行解析、401 重試一次、首 token 60s／閒置 120s 雙計時器 |
| `gemini.js` | 兩協議共用：`response` 信封拆解、usage 新舊格式、parts 分類、JSON Schema 白名單 |
| `openai.js` / `anthropic.js` | 各自的雙向轉換（含串流狀態機） |
| `model-map.js` | 精確表 → 前綴規則 → 透傳；`..` 一律擋 |
| `logs.js` | node:sqlite 寫入／聚合／保留天數清理，**所有操作都可失敗** |
| `ipc.js` | `agy:*`，僅主視窗 |

**實作過程修掉的三個真問題**

1. **401 重試無效**：`invalidateToken()` 只清記憶體快取，下一輪看本機憑證檔 `expiry` 還沒到，就把同一個被上游拒絕的 token 再送一次 → 加 `mustRefresh` 旗標強制走 refresh。
2. **上游狀態碼直接透傳**：上游回 401 會讓客戶端誤判自己的 API key 有問題 → 只有 429（含 `retry-after`）原樣回，其餘收斂成 502。
3. **模型名 `..` 可透傳**：`/` 要放行（`google/gemini-3-flash`），但 `..` 沒有正當用途，先擋掉（AGY 的 Gemini 原生入口就是把 model 放進 URL 路徑）。

**驗證**

- `node scripts/test-agy-mappers.js` 42/42｜`npx electron scripts/e2e-agy.js` 42/42（mock cloudcode-pa）｜`node scripts/e2e-agy-cdp.js` 19/19（打包版）
- 全回歸：視覺 43/43（含 agy × dark/light × 1440/900/560）、smoke 21/21、usage CDP 9/9、usage unit 24/24、chat 70/70、Markdown 23/23、VAD 11/11、reorder 9/9
- **真實上游已驗證**（`npx electron scripts/probe-agy-upstream.js`）：OpenAI 串流／Anthropic 串流／countTokens 三條路都拿到真實回應，`response` 信封與 usage 舊格式解析正確。

### 真實往返揪出的四個移植錯誤

照著 AGY 原始碼移植但**沒照它的實測結論**，四處都是 mock 測不出來的：

| 錯誤 | 症狀 | 修正 |
|---|---|---|
| 只打 prod 端點 | 429 RESOURCE_EXHAUSTED | 端點順序 sandbox → daily → prod，可重試狀態才往下換 |
| 送 `x-goog-user-project` | 每個端點都 403 SERVICE_DISABLED | 不送這個 header，project 只放 body |
| `thinkingBudget: 0` 一律送 | thinking-only 模型 400 Budget 0 is invalid | 只送給實測接受的模型（`THINKING_ONLY_MODELS`） |
| 映射目標抄 AGY 的表 | `gemini-3-pro-preview`／`claude-sonnet-4-6-thinking` 回 404 | 全部改指實測 200 的模型；`DEFAULT_MODEL` → `gemini-3-flash` |

模型可用性隨帳號方案而異（本機為 Google AI Pro）。**改映射表前先跑 `scripts/probe-agy-upstream.js`**，它會列出模型 × 端點矩陣，並比對 `THINKING_ONLY_MODELS` 與現實是否一致。

### 憑證來源：CLI 或 IDE，誰在跑誰續期

`gemini:antigravity` 這份 Credential Manager 憑證由 **Antigravity CLI（`agy.exe`）或 Antigravity IDE** 維護，
VoiceInk **只讀不寫**（`grep cmdkey|CredWrite|Write-*Credential` 全無）。所以：

- **只裝 CLI、沒裝 IDE 完全可用**——本機實測就是這個組合（`%LOCALAPPDATA%\\agy\\bin\\agy.exe` 存在、
  `%LOCALAPPDATA%\\Programs\\Antigravity` 是解除安裝留下的**空目錄**）。
- 顯示 `TOKEN_EXPIRED` 通常只代表 CLI／IDE 一陣子沒跑，不是壞了；跑一次 CLI 就會續期。
- `credential.detectSources()` 據此判斷該給什麼指引，**只認執行檔不認資料夾**（空目錄會誤判）。
  回傳只有 `{cli, ide}` 兩個布林值，不含路徑，可安全過 IPC。
- 頁面在憑證不可用時顯示 `#agyCredentialHelp` 引導區塊（未安裝／未登入／token 過期三種文案）。

**刻意不做瀏覽器 OAuth 登入**：Antigravity-Manager 的三種加帳號方式（OAuth 授權／貼 Refresh Token／
從資料庫匯入）**全都需要 Google OAuth 的 client_id + client_secret**——連「貼 refresh token」也要，
因為換 access token 時得帶 client 憑證。那組值是 Antigravity IDE 的 public desktop client，不是我們的，
且 `GOCSPX-` 會被 GitHub secret scanning 攔。決議：只做偵測與引導，把使用者導回官方 CLI。

要讓本機自行 refresh 仍可設 `ANTIGRAVITY_CLIENT_ID`／`ANTIGRAVITY_CLIENT_SECRET` 環境變數
（額度頁既有機制），但平常不需要。

## 最近變更（2026-08-21）— 額度頁 2 欄與拖曳手感

- `.usage-grid` 固定 2 欄（`repeat(2, minmax(0, 1fr))`、gap 18px、`align-items: start`），≤900px 收成 1 欄；卡片 `min-height: 250px` 避免單視窗卡片過扁
- 拖曳改 pointer 直拖：`pointerdown` 起算 4px 門檻才進入排序，卡片本體以 `translate3d` 跟游標並保持**不透明**（`.dragging` 只加 z-index、加重陰影、關 transition），放開以 150ms FLIP 滑回槽位
  - 監聽掛在 `window` 而非 `setPointerCapture`：preview 會 `appendChild` 搬動卡片，pointer capture 可能被隱式釋放
  - `cardUnderPointer` 用幾何比對決定插入位置（跳過被拖的卡），不需要 `elementFromPoint` 或 `pointer-events: none`
  - 合成 PointerEvent 也能驅動整條路徑，打包版 CDP 因此可直接斷言「拖曳中 opacity=1、cursor=grabbing、transform≠none」
- 卡片標題改 provider accent 實心 pill（19px/700、深色字），移除 LOGO 方塊與方案副標；狀態 pill 12px
- 卡內小字統一 12px 並改 `--text-secondary`（原 9.5～11px `--text-tertiary`）；額度列加 `--bg-tertiary` 底板、視窗標題 13.5px、進度條 9px
- 驗證：打包 usage 9/9（含 2 欄／不透明／無 LOGO 副標新斷言）、視覺 37/37、全域 smoke 21/21、字幕 loopback 6/6、usage unit 24/24、真實五家 6/6、chat 70/70、Markdown 23/23、VAD 11/11、排序 helper 9/9；Vite build 與 electron:pack 通過

## 最近變更（2026-08-20）— Token Anxiety 全站視覺重構

- `themes.css` 重建 Aurora dark/light tokens；深灰綠／淡藍灰底搭配冷藍、暖金光暈，header、nav、controls、dialog 與六頁 surface 統一為 12px glass
- 品牌改三色直條 mark；六頁資訊架構與 frameless window controls 不變；字幕窗同樣採深色 Aurora surface
- 額度卡移除上下按鈕。Pointer 直拖即時預覽順序，其他卡片以 Web Animations FLIP（110ms、`translate3d` only）平滑推開；放開才寫一次 store，取消拖曳還原不寫
- 卡片本身支援 Space 抓取、方向鍵移動、Enter／Space 放下、Esc 取消與 `aria-live`；鍵盤高頻操作及 `prefers-reduced-motion` 不播放位移動畫
- 900／640px 斷點收斂 nav、聊天上下布局、設定橫向分類 rail、dialog 與 actions；打包版以 1440／900／560 × dark/light 六頁截圖驗證無水平 overflow
- 零新 dependency；信任邊界、Main／Preload IPC 與資料流未因視覺重構改動
- 驗證：排序 helper 9/9、usage unit 24/24、真實五家 6/6、chat 70/70、Markdown 23/23、VAD 11/11、TTS→VAD→真 ASR 2/2／3/3、打包 usage 9/9、字幕 loopback 6/6、全域 smoke 21/21、視覺 37/37；Vite build、electron:pack、`git diff --check` 通過

## 最近變更（2026-08-20）— 五家額度儀錶板

完整移植 [Token-Anxiety-Dashboard](https://github.com/RX5950XT/Token-Anxiety-Dashboard) 到聊天右側的獨立「額度」頁：Claude Code、Codex、Antigravity、OpenCode、Grok。

- **手動同步**：App 啟動／進頁只讀 `<userData>/usage.json`；按「同步」才以 `Promise.allSettled` 查五家，並以單一 in-flight Promise 合併連點。單家失敗不阻擋其他卡；近期成功值可保留 6 小時
- **來源**：Claude `~/.claude/.credentials.json`、Codex `~/.codex/auth.json`、Grok `$GROK_HOME/auth.json`；Antigravity 固定讀 Windows Credential Manager `gemini:antigravity`；OpenCode 固定讀 `~/.local/share/opencode/opencode.db`
- **OpenCode**：Electron 內建 Node 22 `node:sqlite`，`readOnly:true`／`allowExtension:false`／參數化固定 SQL，零新 dependency；額度為 $12/$30/$60 成本估算並明確標「非官方」
- **Antigravity**：Google cloudcode-pa 三個固定 base，Claude／Gemini × 5h／weekly 四 slot；OAuth client 僅讀環境變數。外部 PowerShell 無法讀 asar，故 `.ps1` 必須 `asarUnpack` 且執行路徑換成 `app.asar.unpacked`
- **信任邊界**：renderer 只能呼叫 `usage:load|sync|saveSettings|diagnostics`，且 IPC 僅允許主視窗；不能傳任意 URL／credential path／DB path／SQL。HTTP 僅 HTTPS、15s timeout、最多 3 次、response ≤1MiB、credential JSON ≤2MiB；console／diagnostics／IPC 不記 token 或原始 response body
- **UI**：五張 provider accent 卡、重置倒數、狀態／可信度、dragover 即時 FLIP 與卡片本身的鍵盤排序、顯示／隱藏、OpenCode reset 設定、去敏診斷；深淺主題與 RWD，動態資料全用 `textContent`
- **踩坑修復**：打包截圖抓到 Antigravity `.ps1` 留在 asar 導致未連線，且 disconnected 帳戶被錯補四條 100% 假額度；新增 unit + packaged CDP regression 後修正。安全回歸另抓到聊天 API 原始 body 會進 console，現已只記 HTTP status／安全摘要

驗證：`test-usage` 24/24、真實五家 `e2e-usage` 6/6、打包頁 `e2e-usage-cdp` 8/8、`e2e-chat` 70/70、Markdown 23/23、VAD 11/11、TTS→VAD→真 ASR、打包 loopback 5/5、全域 CDP smoke 20/20、Vite build／electron:pack 通過。`node:sqlite` 的 ExperimentalWarning 是 Node 22 平台警告，不是失敗。

## 最近變更（2026-08-20 晚間）— 即時字幕 PCM 直取 + VAD 斷句

### 根因與修法

舊路徑為 `MediaStream → MediaRecorder(opus) → Blob → decodeAudioData → OfflineAudioContext 重採樣 → ASR`。
每 2 秒 stop／重建 recorder 之間有 20–100ms 沒在錄，剛好丟在固定切斷的句中邊界；短句也一定要等滿 2 秒。

現行 `live-caption.js` 改為：

```
系統 loopback → AudioContext({sampleRate:16000}) → mono PCM frame（128ms）
  → vad.js（250ms pre-roll、on/off 遲滯、360ms 停頓、0.5–6s 語句界）
  → 低音量增益 → ASR → 翻譯
```

- Chromium 直接重採樣，移除 opus 編／解碼、每塊兩個 AudioContext、固定 2 秒切句與 recorder restart 缺口
- `ScriptProcessorNode` 是 Electron 35 內建的最小 PCM 邊界；接 zero-gain destination 才持續 callback，不回放音訊
- ASR 忙時 pending 語句上限 2，第 3 句丟最舊未處理句，避免延遲無限累積
- `targetLanguage=auto` 不翻譯時，不再驗證／載入翻譯後端
- 雲端 ASR 狀態列不再錯寫「本地 Qwen3-ASR」
- 字幕窗改 `createElement`＋`textContent` 增量更新（零 innerHTML）；只有原本在底部才自動捲底；控制鈕補 focus ring／aria-label

### 驗證

```
node scripts/test-vad.js                  ALL PASS 11/11
npx electron scripts/e2e-live-pipeline.js ALL PASS（TTS 兩句 → VAD 2/2 → 真 ASR 關鍵字 3/3）
node scripts/e2e-live-cdp.js              ALL PASS 5/5（打包版真 loopback，音量峰值 100%）
node scripts/test-markdown.js             ALL PASS 23/23
npx electron scripts/e2e-chat.js          ALL PASS 69/69
node scripts/e2e-cdp-smoke.js             ALL PASS 19/19
npm run build                             PASS
npm run electron:pack                     PASS，dist/win-unpacked/VoiceInk.exe 已更新
```

## 最近變更（2026-08-20 下午）— 設定頁改版 + 聊天對齊 Chatbox / Cherry Studio

使用者回饋四項：ASR 也要能選推論裝置、設定選單層級混亂、聊天設定太肥、輸入框反直覺。

### 1. 本地 ASR「GPU 推論」不可行（已實測，別再試）

npm 的 `sherpa-onnx-win-x64` 是 **CPU-only 編譯**。傳 `provider: 'cuda'` / `'directml'` 都只會印：

```
session.cc:GetSessionOptionsImpl:324 Please compile with -DSHERPA_ONNX_ENABLE_GPU=ON.
Available providers: CPUExecutionProvider, . Fallback to cpu!
```

然後靜默退回 CPU（cpu 673ms / cuda 769ms / directml 654ms，同一段音訊）。npm 也沒有 `sherpa-onnx-win-x64-gpu`。
→ 改成提供**真的有效**的 `asrThreads`（0=自動／2／4／8），並在設定頁明講 GPU 不可用與替代路徑（雲端 ASR）。
真要 GPU 得換掉 `sherpa-onnx-c-api.dll` + onnxruntime GPU provider（~500MB＋CUDA/cuDNN），且模型是 int8、CUDA EP 多半會回落 CPU，投報率極低。

### 2. 設定頁資訊架構

- 左側分類 rail（6 區）一次只顯示一區，取代原本 640px 單欄長捲；底部 sticky 儲存列
- 字級階層修正（**這是原本「看起來都一樣大」的根因**）：改版前分區標題 13px 灰、欄位 label 14px 白 → 權重是反的。
  現在 **標題 20/700 primary > 輸入 14 > 子標題與 label 13/600 secondary > 說明 12 tertiary**
- 子標題加 accent 直條；欄位群卡片化；補 `:focus-visible` 外框與 `prefers-reduced-motion`

### 3. 系統提示改成多組 preset

- 設定頁移除系統提示欄位，只留 API URL／Key／模型清單
- 新 key `chatPrompts`（`{id,name,content}[]`，≤20 組、名稱 ≤40、內容 ≤4000）與 `chatPromptId`（''＝不使用）
- 聊天頁工具列下拉即時切換；⚙ 開 `<dialog>` 管理（新增／改名／編輯／刪除）
- `initStore()` 一次性把舊的 `chatSystemPrompt` 搬成第一組 preset 後 `store.delete`，`chatSystemPrompt` 已移出 allowlist

### 4. 輸入框重做

- **auto-grow**：1 行起跳、上限視窗 40%，`resize:none`（原本 `rows=3` + `resize:vertical` 的手動拉桿在 flex 版面裡跟訊息串搶高度，就是「滑動很反直覺」的來源）
- **圖片**：貼上／拖放／選檔，最多 4 張；renderer 用 canvas 縮到長邊 1568 的 JPEG(0.85)
- **thinking 開關**：`chatThinking` → 送出時帶 `reasoning_effort: 'medium'`；**關閉時完全不帶欄位**（舊端點看到不認得的參數會 400）
- SSE 解析 `delta.reasoning_content`（DeepSeek/Qwen）與 `delta.reasoning`（OpenRouter），以 `kind:'reasoning'` 分流、落盤在助理訊息的 `reasoning` 欄位、UI 以可摺疊區塊呈現

### 5. 圖片的所有權同樣在 main

- 訊息只存檔名，實體在 `<userData>/chat-images/`：electron-store 整檔讀寫，base64 進 chats.json 會讓每次 append 重寫數 MB
- 檔名由 main 產生（`img_<t36>_<rand>.<ext>`）並走 allowlist 驗證，renderer 給的字串一律不當路徑用；只收 png/jpeg/webp（**不收 svg**）、單張 ≤6MB
- 送 API 時才讀檔轉 data URL，且**只處理最近 6 則訊息**的圖片（長對話重傳全部會爆 token）
- 刪對話／訊息淘汰後回收孤兒檔
- CSP 加 `img-src 'self' data: blob:`

### 6. 其他對齊參考專案

每則訊息 hover 顯示「複製」、最後一則助理可「重新生成」（`chat:send` 帶 `regenerate:true` → main 砍掉結尾助理訊息後重送，不新增 user 訊息）；側欄對話搜尋。

### 驗證

```
node scripts/test-markdown.js       ALL PASS 23/23
npx electron scripts/e2e-chat.js    ALL PASS 69/69   （新增 G 提示 preset／H 圖片／I thinking／J 重新生成）
node scripts/e2e-cdp-smoke.js       19/19            （新增分類 rail 字級階層、composer 四項）
npx electron scripts/e2e-asr-threads.js  ALL PASS 10/10（TTS→ASR 往返；threads 2→1656ms、8→1056ms，逐字相符）
打包版 + 真實 gateway               9/9              （提示生效、圖片辨識「紅色」、縮圖渲染、跑完還原設定）
npm run electron:pack               dist/win-unpacked/VoiceInk.exe 已更新
```

> 踩過：測試用 8×8 PNG 會被 Gemini 回 `400 Unable to process input image`，改用 512×512 canvas JPEG 才是真實路徑。

## 最近變更（2026-08-20）— 重新定位階段一：聊天分頁

App 從「語音工具」擴為「AI 工作台」。此階段先完成聊天；額度查詢後續已完成，見本文件最上方最新變更。

- **信任邊界收在 main**：renderer 只送 `{reqId, conversationId, text}`。model 由 main 讀 `chatModelId`（必須 ∈ `chatModels`，否則直接拒絕、不發 HTTP）、訊息歷史由 `chat-store` 讀寫、上下文 ≤24000 字由 main 從最舊丟起（最後一則永遠保留）。renderer 拿不到「指定任意 model / 塞任意 history」的路徑
- **串流**：`fetch` + `stream:true`，`res.body.getReader()` 逐塊解析 SSE（跨 chunk 行緩衝）。`AbortSignal.timeout` 會砍長連線 → 改**首 token 60s ＋ 閒置 120s** 雙計時器。同時只允許一個 in-flight；中斷時**已收到的部分仍存檔**（累加器 `partial` 宣告在 `try` 外，這點踩過）
- **會話儲存**：`new Store({ name: 'chats' })` → `<userData>/chats.json`，`chat:*` IPC，不進 `STORE_ALLOWLIST`（那是設定 key）。上限 100 會話 × 500 則，超過砍最舊；標題取第一則 user 訊息前 30 字
- **Markdown 自寫**（`renderer/scripts/markdown.js`，~280 行）：全程 `createElement`＋`textContent`、零 `innerHTML` → XSS 先天不可能；連結只放行 http(s)/mailto。理由是 renderer 無 bundler、CSP `script-src 'self'`、打包跑 `src/` 原碼 → vendoring marked/DOMPurify 是額外維護面
  - 踩過兩個坑：①`INLINE_RE` 模組層 g-regex 被遞迴呼叫重置 `lastIndex` → 無限迴圈 OOM，改成每次 `new RegExp(INLINE_SRC,'g')`；②強調標記內側允許空白會把 `2 * 3 * 4` 吃成斜體 → 加 `(?!\s)` / `(?<!\s)`
  - 碼塊複製鈕由 `chat-page.js` 事件委派，`markdown.js` 不綁任何 listener（保持純函式、可在 node 用 DOM shim 直測）
- **不佔引擎**：聊天純雲端 → 不 `engine.acquire`，`engine.js` 零改動，owner 仍是 `live|file|translate`
- 驗證：`node scripts/test-markdown.js` **23/23**；`npx electron scripts/e2e-chat.js` **37/37**；`node scripts/e2e-cdp-smoke.js` **17/17**（既有 13 + 聊天 4）；真實端點（使用者本機 gateway）串流 7 塊 1937ms、多輪上下文正確；打包版 UI 實測 10/10（設定→送出→串流→碼塊複製鈕→持久化→清理還原）
- 當時未做、後續已補：圖片附件、thinking、系統提示 preset、訊息重新生成、側欄搜尋；目前仍刻意不做本地 GGUF 聊天、語音輸入／朗讀回覆、RAG、分支對話與匯出

## 先前變更（2026-08-03）— Qwen3.5 空 think 前綴（根因）＋ Q8／Q4 可選 ＋ v1.7.0 發行

- **根因**：Qwen3.5 chat template 在 `<|im_start|>assistant\n` 後**固定補** `<think>\n\n</think>\n\n`（token `248068,271,248069,271`），模型帶著它訓練與評測。node-llama-cpp 3.19 自動解析的 Qwen wrapper **不補** → 掉出分布。先前歸咎「模型／語料」的三精度共通缺陷（標籤前綴、專名消失、年份幻覺）全部出自這裡
- **修法（一行）**：`getSession` 的 `LlamaChatSession` 帶 `newQwen35ChatWrapper(QwenChatWrapper)` ＝ `new QwenChatWrapper({ thoughts: 'discourage' })`
  - `node scripts/probe-prompt-path.js` 實測與 transformers `apply_chat_template` **逐字元相同** → 不需 INTEGRATION.md 建議的自訂 subclass
  - `budgets.thoughtTokens:0` 是「不生成 thinking」，補不了前綴，兩件事都要做
- **30 句客觀對照**（`node scripts/verify-chat-wrapper-fix.js`，樣本／指標在 `scripts/bench-cases.js`）：

| GGUF | 標籤前綴 | 拉丁專名保留率 | 憑空年份 | 缺陷總數 |
|---|---|---|---|---|
| Q4_K_M 修前 | 8 | 46.7% | 2 | 20 |
| Q4_K_M 修後 | 0 | 80.0% | 0 | 5 |
| Q8_0 修前 | 9 | 73.3% | 2 | 20 |
| **Q8_0 修後（出貨）** | **0** | **93.3%** | **0** | **6** |

  門檻（標籤=0／專名≥90%／年份=0／總數<8）**Q8_0 修後 ALL GATES PASS**；Q4 只差專名保留率
- **Q4／Q8 可選**：Q4 另開 registry key `linguaforge08q4`（獨立資料夾／下載），設定→翻譯三顆按鈕。預設 Q8（774MB）；Q4（505MB）CPU 約快 2.2×，代價是罕見專名音譯（實測同句 Q8「超越Kimi k3…和Sol一樣強」／Q4「比金剛大3倍…和索爾一樣強」）
  - 兩量化共用 SFT 格式與 DECODE → `local-llm.isLinguaforge(key)`；renderer 切段 `startsWith('linguaforge08')`
  - 舊用戶 `linguaforge08/` 底下的舊 Q4 檔不會自動刪，可手動清
- **未修（語料缺口，勿為此調 prompt）**：多行且各行互不相關（規格表）只譯第一行；`open weight`／`agentic` 等 2023 後 AI 術語
- 順修：cdp-smoke「長文分段」斷言寫死 4 段（280 字切段後應為 8 段，一直是假綠燈）→ 改讀 UI 的「N 字（M 段）」
- 驗證：`e2e-linguaforge-quant` ALL PASS、`-decode` A–E ALL PASS（log 含 `chat_wrapper`／`think_prefix_token_ids`）、`-list`／`-leak`／`-context` ALL PASS、`e2e-local-translate-settings` ALL PASS（雙模型 × CPU/CUDA）、`e2e-cdp-smoke` **13/13**、`electron:build` 出 `VoiceInk Setup 1.7.0.exe`（290MB）已上傳 Release

> ⚠️ 2026-08-02e 的「量化對照」結論（三精度共通缺陷＝模型問題、維持 Q4）**已被推翻**：三次都缺 think 前綴，同一變因沒被控制。

## 更早變更（2026-08-02 系列）— LinguaForge 出貨對齊

- **解碼對齊 GGUF**：`local-llm.js` 集中 `LINGUAFORGE_DECODE` — 雙 EOS `[248046,248044]` + `customStopTriggers`；**zhtw `repeatPenalty:false`**（省略時預設 1.1 會攪繁簡）、en/ja 1.1；`dryRepeatPenalty.allowedLength=3` 近似 `no_repeat_ngram_size=4`；`temperature=0`、`thoughtTokens=0`、`maxTokens≈源長×2`（64–768）；每次 log `[linguaforge decode]`
- **長文每段吐同一句**：`translateLocalOnce` 把前文塞進 chat history，LinguaForge 是單輪 SFT MT 模型，greedy 直接複誦上一輪 assistant → `isLinguaforge` 時 `pair = null`
- **條列貼文退化**：逐行翻譯、行首清單標記（`· ` `- ` `1. `）剝除後才送、翻完貼回（`splitLinesForLinguaforge`）；退化迴圈由 `findRepetitionLoop` 偵測後開 rep-penalty 重跑該段（重試前必 `setChatHistory(history)` 還原）
- **譯文純淨度**：清理抽到 `src/main/translate-clean.js` — persona 標籤白名單（原文沒冒號才剝）／整段包覆才剝引號、單側僅在無配對時剝／`stripTranslationNoise(raw, source)` 帶原文判斷列點；除錯 `VOICEINK_DEBUG_RAW=1`
- **s2twp 竄改**：`twp` 會把「總參數」改成「總引數」→ 先以 `to:'tw'` 純字形探測，沒簡體就原樣回傳（ASR 共用同函式）
- 模型路徑：`gguf-v5e/linguaforge-v5e-0.8b-{Q8_0,Q4_K_M}.gguf`（HF repo `RX5950XT/LinguaForge-Qwen3.5-0.8B-zhTW-en-ja`）
- 已知殘留（0.8B 能力，非工程層可修）：偶發整句幻覺、片語誤譯；e2e 斷言刻意只驗結構／污染／退化，不把用詞正確性當紅燈

## 關鍵技術備忘

- **sherpa-onnx-node@1.13.4**：Windows 需在 require 前把 `node_modules/sherpa-onnx-win-x64` 加入 `PATH`（`local-asr.js` 已處理，含 asar.unpacked 替換）。Qwen3 config 鍵：`qwen3Asr:{convFrontend,encoder,decoder,tokenizer,hotwords}`；輸出 strip `<sil>` 等 token；`decodeAsync` 的 JSON.parse 需 patch 防控制字元
- **node-llama-cpp@3.19** 是 ESM，main 用動態 `import()`；Qwen 系列關 thinking
- **冷啟動**：`warm()` 內含拋棄式暖機推論（首次 compute-graph ~12.5s 挪到背景預熱），否則第一句翻譯會塞爆佇列
- **打包用 `src/` 原始碼**：`build.files` 排除 `dist/**`，main `loadFile('../renderer/...')` 從 asar 內載入原始 ESM/HTML；`vite build` 僅語法驗證
- **`electron:build` / `electron:pack` 前要先關掉開著的 `dist/win-unpacked/VoiceInk.exe`**，否則 `d3dcompiler_47.dll: Access is denied`
- 即時字幕：16k PCM 直取；VAD on/off RMS=0.004/0.002、pre-roll 250ms、hangover 360ms、語句 0.5–6s；ASR pending 上限 2；`hasLinguisticContent` 只認 `\p{L}`（純符號碎片會讓 0.8B 當聊天回問候）
- **Edge TTS** 永遠需連網；voice 僅 `tts-voices.js` allowlist，renderer 只傳 `lang`
- e2e：`npx electron <script>` 直測 main（app 名為 `Electron`，需先 `app.setPath('userData', join(getPath('appData'),'voiceink'))`）；CDP 驅動打包版 `--remote-debugging-port=9223`，長工作用 Node 端 2s 輪詢，勿用單次 `awaitPromise`

## 歷史變更摘要

| 日期 | 內容 |
|---|---|
| 2026-08-26 | AGY 憑證 `mustRefresh` 永久卡死修復；AGY「測試連線」（`agy:test`，loopback 真打一次上游）；額度頂部橫條跟隨顯示設定；四家訂閱方案（Claude `subscriptionType`／Codex id_token claim／Grok token `tier`／Antigravity tier）|
| 2026-08-20 | 五家額度儀錶板：手動同步、Main-only providers、唯讀 SQLite／Credential Manager、快取／排序／診斷 |
| 2026-08-20 | 即時字幕改 16k PCM 直取＋VAD 停頓切句；字幕窗增量安全 DOM／保留手動捲動 |
| 2026-08-01 | LinguaForge v5e 模型路徑（舊 v3 作廢） |
| 2026-07-27/28 | 翻譯頁解除字數限制（`splitForTranslate` 自動分段、可中途停止）；LinguaForge 屏蔽後恢復 |
| 2026-07-26 | frameless 主窗；本地雙翻譯模型＋`llmGpu`（cuda→vulkan→CPU）；CUDA 環境自動安裝；修 `LLM load cancelled`（同指紋 in-flight join） |
| 2026-07-24 | 設定改第四分頁；雲端 ASR；TTS 語速 |
| 2026-07-18 | 第三頁「翻譯與 TTS」＋Edge TTS；顯示模式搬進字幕視窗；模型載入並行化＋分頁預熱；長檔串流轉錄（ffmpeg 28s，≥2h／100MB）；黑屏修復；sherpa JSON 控制字元；日文複誦三層防護＋s2twp；全專案審計 15 項修補 |
| 2026-07-17 | 移除雲端轉錄路徑；ASR 只留 Qwen3-ASR-0.6B；翻譯 prompt 改 system + chat history（括號式模板會被複誦）；即時字幕全鏈路體檢 |

## 已知限制／未來方向

- 聊天：目前無本地 GGUF 對話、無語音輸入／朗讀與 RAG；Markdown 不支援巢狀清單（原樣輸出不壞版）

- 字幕透明度用整窗 `setOpacity`（文字也變淡）；transparent window 在 Windows 有坑
- 本地檔案轉錄硬切 28s 邊界仍可用 VAD 改善
- GGUF 只能 greedy，出貨 `evaluate.py` 的 beam=4 + length_penalty=1.2 無法對齊
- Qwen3-ASR-1.7B（更準，int8 ~2GB）可加入 registry；PRD backlog 見 `tasks/todo.md`
