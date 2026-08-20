# CONTEXT.md — 開發紀錄交接文件

> 給下一個 AI Agent 的接手指南。保持精簡，每次任務完成後更新。
> 規範與地雷見 [CLAUDE.md](./CLAUDE.md) / [AGENTS.md](./AGENTS.md)；歷史教訓見 [tasks/lessons.md](./tasks/lessons.md)。

## 專案概況

VoiceInk：Windows Electron AI 工作台（**聊天**＋**AI 訂閱額度**＋檔案轉錄＋即時字幕＋翻譯與 TTS）。Vanilla JS + Vite，無框架。
已發行版本 **1.7.0**（Release `v1.7.0`：LinguaForge think 前綴修正、Q8／Q4 量化可選、譯文清理獨立模組）。

> **工作樹目前領先 v1.7.0**：已完成聊天／圖片／thinking、設定重整、即時字幕 PCM＋VAD、五家額度儀錶板；尚未 bump 版本／commit／發行。
> 要出貨時：bump `package.json` → commit → `git tag v1.8.0` → push → `electron:build` → `gh release create`。

## 架構

```
src/main/
  main.js             frameless 主窗 + IPC；localAsr 依 asrEngine 分流
  chat.js             雲端聊天 SSE 串流；單一 in-flight、雙逾時、上下文裁切、model allowlist、
                      系統提示 preset、reasoning 分流、圖片多模態、重新生成
  chat-store.js       會話持久化（獨立 electron-store 實例 → <userData>/chats.json）；訊息可帶 images/reasoning
  chat-images.js      圖片附件：存 <userData>/chat-images/，檔名 allowlist、孤兒回收
  usage/              五家額度 provider、bounded HTTPS／唯讀 SQLite／Credential Manager bridge、
                      獨立 usage store、6h soft cache、同步協調與受限 IPC
  models.js           registry：qwen3asr、qwen35translate、linguaforge08(Q8)、linguaforge08q4(Q4)
  gpu-capability.js   NVIDIA VRAM 門檻（≥6GB）／cuda-env.js CUDA 偵測安裝
  local-asr.js        sherpa-onnx 本地 ASR（僅 CPU；asrThreads 可調執行緒）
  cloud-asr.js        OpenAI 相容 /audio/transcriptions
  local-llm.js        翻譯 cloud/local；多 GGUF + CPU/GPU；LINGUAFORGE_DECODE 查表
  translate-clean.js  譯文清理（純文字、無 electron 依賴，可 node 直測）
  file-transcribe.js  本地 f32le 28s；雲端 mp3 segment 50s
  edge-tts.js         Edge TTS + ttsRate（%）
  engine.js           owner live|file|translate；雲端 ASR 時 needs.asr=false
src/renderer/scripts/
  app.js  translate-page.js  transcribe.js
  live-caption.js      16k PCM 擷取 → VAD 語句 → ASR／翻譯佇列
  vad.js               純資料能量 VAD（pre-roll／遲滯／語句長度界，可 node 直測）
  chat-page.js        聊天頁 UI（側欄搜尋／提示 preset 彈窗／auto-grow 輸入框／圖片附件／
                      thinking 開關／訊息複製與重新生成）＋設定頁「聊天」區塊
  markdown.js         最小安全 Markdown → DocumentFragment（零 innerHTML）
  usage-page.js       額度卡片／倒數／手動同步／顯示設定／拖曳與鍵盤排序／去敏診斷
```

| 項目 | 說明 |
|---|---|
| 聊天 | 雲端 OpenAI 相容 `/chat/completions` + `stream:true`；`chatApiUrl`/`chatApiKey`/`chatModels`/`chatModelId`（與翻譯完全獨立） |
| 聊天進階 | 系統提示多組 preset `chatPrompts`/`chatPromptId`；thinking `chatThinking` → `reasoning_effort`；圖片附件（訊息存檔名、實體在 `<userData>/chat-images/`） |
| 額度 | Claude Code／Codex／Antigravity／OpenCode／Grok；只在按「同步」時查詢；獨立 `<userData>/usage.json`、6h soft cache；Main-only 固定來源 |
| ASR | `asrEngine` = local（Qwen3-ASR-0.6B，**只有 CPU**，`asrThreads` 0=自動/2/4/8）/ cloud（`asrApiUrl`/`asrApiKey`/`asrModelId`） |
| 翻譯 | `translator` = cloud / local；`localTranslateModel` = `linguaforge08`(Q8，預設) / `linguaforge08q4`(Q4) / `qwen35translate`；`llmGpu` |
| 即時字幕 | 系統 loopback → AudioContext 16k mono PCM → 能量 VAD 依停頓切 0.5–6s 語句 → ASR；pending 上限 2 |
| TTS | Edge TTS；`ttsVoices` + `ttsRate`（-50…100 → Edge rate %） |
| 設定 UI | 導航最後一 tab；**左側分類 rail** 一次顯示一區：模型／翻譯／聊天／語音轉文字／外觀／語音朗讀 + 底部 sticky 儲存列 |
| 導覽 | 聊天（預設頁）｜額度｜檔案轉錄｜即時字幕｜翻譯與 TTS｜設定 |
| 視窗 | 主窗 frameless（header 含 min/max/close）；字幕彈窗獨佔顯示模式 |
| 視覺 | Token Anxiety Aurora glass；dark/light 共用 12px surface、blur、冷藍／暖金光暈；900／640px RWD |

模型存放：`%APPDATA%/voiceink/models/<key>/`。

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
