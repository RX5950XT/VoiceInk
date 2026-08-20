# VoiceInk — 設定頁重整 + 聊天對齊 Chatbox/Cherry Studio

## 背景

使用者回饋四項：
1. 語音轉文字要能選 CPU／GPU（比照翻譯的 `llmGpu`）
2. 設定選單字級都差不多、層級混亂、不好用
3. 聊天設定只留 API URL／Key／模型清單；系統提示搬到聊天頁，且要能存多組自選
4. 聊天輸入框滑動反直覺；要加 thinking 開關與圖片輸入
外加：對齊 Chatbox / Cherry Studio 的常用功能

## 前置調查結論（已實測）

- [x] 本地 ASR GPU **不可行**：npm 的 `sherpa-onnx-win-x64` 是 CPU-only 編譯
  `session.cc:GetSessionOptionsImpl:324 Please compile with -DSHERPA_ONNX_ENABLE_GPU=ON.`
  `Available providers: CPUExecutionProvider, . Fallback to cpu!`
  （provider 傳 cuda / directml 都只會靜默 fallback；npm 無 `sherpa-onnx-win-x64-gpu` 套件）
  → 改成提供**真的有效**的 `asrThreads`（推論執行緒），並在 UI 明講 GPU 不可用與替代路徑（雲端 ASR）

## 任務

### A. 設定頁資訊架構與字級
- [x] 左側分類 rail（模型／翻譯／聊天／語音轉文字／外觀／語音），一次只顯示一區
- [x] 字級階層修正：區塊標題 18px/700 primary、子標題 14px/600、欄位 label 13px/600、hint 12px tertiary
- [x] 卡片化欄位群、sticky 儲存列、focus ring、reduced-motion

### B. 語音轉文字推論設定
- [x] 新 store key `asrThreads`（0=自動 / 2 / 4 / 8），main 驗證整數範圍
- [x] `local-asr.js` 讀 store 決定 numThreads；threads 變動時強制重建 recognizer
- [x] UI：本地 ASR 區塊加「推論執行緒」＋ GPU 不可用說明

### C. 系統提示多組化（搬到聊天頁）
- [x] 新 store key `chatPrompts`（`{id,name,content}[]`）、`chatPromptId`
- [x] `initStore` 一次性搬移舊 `chatSystemPrompt` → preset 後刪除舊 key
- [x] 設定頁移除系統提示欄位
- [x] 聊天頁工具列加提示下拉 + `<dialog>` 管理彈窗（新增／改名／編輯／刪除）

### D. 輸入框重做
- [x] auto-grow textarea（1 行起跳、上限 40vh、`resize:none`）
- [x] composer 工具列：附加圖片、thinking 開關、送出／停止
- [x] 貼上與拖放圖片、canvas 縮圖（長邊 1568、JPEG 0.85）、縮圖列可移除

### E. thinking
- [x] store `chatThinking`；開啟時 body 帶 `reasoning_effort`
- [x] SSE 解析 `delta.reasoning_content` / `delta.reasoning`，以 `kind:'reasoning'` 分流
- [x] 落盤到助理訊息的 `reasoning` 欄位；UI 以可摺疊區塊呈現

### F. 圖片訊息（main 端所有權）
- [x] `chat-images.js`：存 `<userData>/chat-images/`，驗證 data URL 前綴與大小
- [x] 訊息新增 `images: string[]`（只存檔名）；送 API 時才讀檔轉 data URL
- [x] `chat:image` IPC 供 renderer 顯示；CSP 加 `img-src 'self' data: blob:`
- [x] 刪除對話時回收孤兒圖片

### G. 對齊參考專案的其他功能
- [x] 每則訊息 hover 顯示「複製」；最後一則助理可「重新生成」
- [x] 側欄搜尋

## 驗證
- [x] `node scripts/test-markdown.js`
- [x] `npx electron scripts/e2e-chat.js`（新增圖片／thinking／prompt preset 案例）
- [x] `node scripts/e2e-cdp-smoke.js`
- [x] `npm run electron:pack`

## Review

四項需求全部落地，外加對齊參考專案的訊息操作與側欄搜尋。

**唯一沒有照字面做的是第 1 項。** 本地 ASR 的 GPU 選項在現有相依下不存在：npm 的 `sherpa-onnx-win-x64`
是 CPU-only 編譯（實測 provider 傳 cuda／directml 都印 `Please compile with -DSHERPA_ONNX_ENABLE_GPU=ON ...
Fallback to cpu!`，三者耗時相同）。照做只會交出一個切了沒差的假開關，所以改成提供真的有效的
`asrThreads`（實測 2 執行緒 1656ms、8 執行緒 1056ms，同一段音訊逐字相符），並在設定頁原地說明為什麼沒有
GPU、要更快請走雲端 ASR。

要真的上 GPU 得抽換 `sherpa-onnx-c-api.dll` ＋ onnxruntime GPU provider（~500MB ＋ CUDA/cuDNN），
而且模型是 int8、CUDA EP 多半仍會回落 CPU——投報率極低，等使用者確認要不要做。

其餘三項：
- 設定選單的根因是**字級與顏色階層反轉**（標題 13px 灰 vs 欄位 label 14px 白），不是字不夠大；
  同時加左側分類 rail 降低單頁密度。字級階層已寫成 CDP 回歸斷言。
- 系統提示改 preset 多組，設定頁只剩 API URL／Key／模型清單；舊值由 `initStore` 一次性搬移。
- 輸入框 auto-grow ＋ 工具列（附圖／thinking／送出），圖片走 main 落檔不進 chats.json。

驗證數字見 CONTEXT.md「最近變更（2026-08-20 下午）」。

---

# 2026-08-20 — 即時字幕優化（PCM 直取 + VAD 斷句）

## 根因

音訊路徑繞了一圈冤枉路：`MediaStream → MediaRecorder(opus 編碼) → Blob → decodeAudioData(解碼)
→ AudioBuffer → OfflineAudioContext 重採樣 → Float32`，終點卻只要 16kHz mono Float32。

三個後果：
1. **每 2 秒丟一段音**：`stop()` → `onstop` → 建新 recorder → `start()` 之間沒人在錄，
   固定丟在句子被切開的地方（20~100ms）。
2. **固定 2 秒硬切**：句子攔腰斬斷，ASR 對半句話辨識率大掉；短句也要硬等滿 2 秒。
3. **每塊建 2 個 AudioContext**：decode 一個、重採樣一個，Windows 每次都要初始化音訊裝置。

## 任務

- [x] 1. live-caption.js：`new AudioContext({ sampleRate: 16000 })` + `createMediaStreamSource`
      + `ScriptProcessorNode` 直接取 PCM（瀏覽器自動重採樣），連續取樣＝零丟音、零編解碼
- [x] 2. VAD 狀態機（遲滯門檻 + pre-roll 防吃首字 + 最短/最長語句界）取代固定切塊
- [x] 3. 刪除 `MediaRecorder` / `decodeAudio` / `analyzeAudio` / `resampleTo16kMono` 整條路徑
- [x] 4. level meter 併入同一個 AudioContext（省一個 context + 一條 rAF 迴圈）
- [x] 5. 修 `liveEngine` 引擎名寫死（雲端 ASR 時顯示錯誤）
- [x] 6. subtitle.html：修無條件 `scrollTop = scrollHeight`（往上捲看歷史被強制拉回底部）
- [x] 7. subtitle.html：`innerHTML` 整串重繪 → `createElement` 增量渲染
- [x] 8. 寫 `scripts/test-vad.js`（純 node 驗 VAD 狀態機切點）
- [x] 9. `npx electron scripts/e2e-live-pipeline.js`（TTS 合成含停頓語句 → 走真實 VAD → ASR 比對）
- [x] 10. `npm run electron:pack` 更新免安裝預覽
- [x] 11. 同步 CLAUDE.md / AGENTS.md / CONTEXT.md / README.md

## Review

- 音訊主路徑由 MediaRecorder/WebM 編解碼＋固定 2 秒硬切，改為 AudioContext 16kHz mono PCM 直取＋VAD 自然停頓切句；舊路徑約 100 行已刪除。
- VAD 實際參數：128ms frame、250ms pre-roll、360ms hangover、0.5–6s 語句界；ASR pending 上限 2。
- 字幕窗改為單行增量安全 DOM，零 innerHTML；手動上捲不再被更新強制拉回底部。
- 順修：auto（不翻譯）不再要求翻譯 key／模型；雲端 ASR 狀態列顯示正確。
- 驗證：VAD 11/11、TTS→VAD→ASR 2/2 句與 3/3 關鍵字、打包版真 loopback 5/5、Markdown 23/23、聊天 69/69、CDP smoke 19/19、Vite build 與 electron:pack 通過。

---

# 2026-08-20 — 額度儀錶板整合

## 任務

- [x] 1. 共用資料合約、外部輸入驗證與 bounded I/O
- [x] 2. Claude Code／Codex／Grok provider
- [x] 3. OpenCode `node:sqlite` 唯讀 provider
- [x] 4. Antigravity Credential Manager／OAuth／四視窗 provider
- [x] 5. 獨立 usage store、6h 快取、同步協調、IPC／preload
- [x] 6. 獨立額度頁、完整設定／排序／診斷互動與 RWD／a11y
- [x] 7. 打包版真實同步與 CDP 驗證
- [x] 8. 安全審查、全回歸、文件同步與最終 pack

## Review

- 完整移植 Claude Code／Codex／Antigravity／OpenCode／Grok：手動同步、6h soft cache、五卡倒數、顯示／排序、OpenCode reset 與去敏診斷；導覽為「聊天｜額度｜檔案轉錄｜即時字幕｜翻譯與 TTS｜設定」。
- 信任邊界收在 main：固定 HTTPS／credential path／唯讀 SQLite SQL；IPC 只允許主視窗，renderer 不接觸 token、URL、路徑或 SQL；動態 UI 零 `innerHTML`。
- 打包視覺檢查抓到並修正 Antigravity `.ps1` 未 unpack 與 disconnected 假額度；安全回歸另修聊天 API body 寫入 console。
- 驗證：usage unit 24/24、真實五家 6/6、打包 usage 8/8、chat 70/70、Markdown 23/23、VAD 11/11、TTS→VAD→真 ASR、打包 loopback 5/5、全域 smoke 20/20、Vite build／electron:pack／`git diff --check` 通過。
- 最終免安裝預覽：`dist/win-unpacked/VoiceInk.exe`；未 bump 版本、未 commit／tag／push／release。

---

# 2026-08-20 — Token Anxiety 全站視覺重構

## 任務

- [x] 1. 建立視覺、深淺主題與 RWD 的打包版紅燈 gate
- [x] 2. 重建 Aurora/light tokens、App shell、品牌與共用 controls
- [x] 3. 將聊天／額度／轉錄／即時／翻譯／設定映射成一致 glass surface
- [x] 4. 額度卡片 FLIP 拖曳＋無按鈕鍵盤排序
- [x] 5. 字幕小窗與 900／560px responsive 收斂
- [x] 6. 打包版逐頁截圖、自我批判與精修
- [x] 7. 安全審查、全回歸、文件同步與 final pack

## Review

- 六頁與置頂字幕窗已統一為 Token Anxiety Aurora glass；保留原資訊架構、frameless window controls 與深／淺主題。
- 額度卡移除上下按鈕；mouse dragover 即時重排並以 110ms transform-only FLIP 推開其他卡，drop 才儲存。鍵盤以 Space／方向鍵／Enter／Esc 排序且不播放位移動畫，並有 aria-live。
- 900／640px RWD 在 560px 實測無水平溢出；reduced motion 禁用 FLIP。未新增 dependency，視覺任務未改動 Main／Preload 信任邊界。
- 驗證：排序 9/9、usage 24/24＋真實五家 6/6＋打包 9/9、chat 70/70、Markdown 23/23、VAD 11/11、真 ASR pipeline、字幕 loopback 6/6、全域 smoke 21/21、視覺 37/37、Vite build／electron:pack／`git diff --check`。最終預覽為 `dist/win-unpacked/VoiceInk.exe`。

---

# 2026-08-21 — 額度頁 2 欄版面與拖曳體驗對齊

## 任務

- [x] 1. 卡片網格改固定 2 欄（≤900px 收成 1 欄）
- [x] 2. 拖曳改 pointer 直拖：卡片本體跟游標、全不透明、放開滑回槽位
- [x] 3. 卡片標題只留大標籤 pill，移除 LOGO 方塊與方案副標
- [x] 4. 小字統一 12px 並改用 secondary 色，額度列加底板
- [x] 5. 更新打包版 CDP 斷言（2 欄／不透明／不再有 LOGO 與副標）並全回歸

## Review

- 半透明的根因是 **HTML5 DnD 的拖影必定半透明**，`.dragging { opacity: .18 }` 只是把來源槽位也一起淡掉；換成 pointer 直拖後，被拖的卡片就是本體，全程不透明並跟著游標，放開以 150ms FLIP 滑回。
- 監聽掛 `window` 而非 `setPointerCapture`：預覽排序會 `appendChild` 搬動卡片，pointer capture 可能被隱式釋放；插入點用幾何比對而非 `elementFromPoint`，不必為了命中測試把卡片設成 `pointer-events: none`。
- 版面固定 2 欄、`align-items: start` ＋ `min-height: 250px`：等高拉伸會讓只有一個視窗的卡片留下大片空白。
- 標題改 accent 實心 pill、拿掉 LOGO 方塊與方案副標；卡內小字由 9.5～11px `--text-tertiary` 統一為 12px `--text-secondary`。
- 驗證：打包 usage 9/9（新增 2 欄／opacity=1／cursor=grabbing／無 LOGO 副標斷言）、視覺 37/37、smoke 21/21、字幕 6/6、usage 24/24、真實五家 6/6、chat 70/70、Markdown 23/23、VAD 11/11、排序 9/9、Vite build 與 electron:pack 通過。
