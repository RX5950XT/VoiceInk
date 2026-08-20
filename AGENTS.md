# VoiceInk - AI Agent Instructions

> 此文件為 AI 助手提供開發 VoiceInk MVP 的指導原則。

---

## 1. 專案概覽

**VoiceInk**（v1.7.0）是一個 Windows 桌面端 AI 工作台，具備：

- AI 聊天（雲端串流、多會話）
- AI 訂閱額度（五家 provider、手動同步）
- 音訊檔案轉錄功能
- 系統音訊即時字幕功能
- 翻譯與 TTS（Edge TTS 朗讀）
- 深色/淺色主題切換

### 技術堆疊

- **Electron 35+** - 桌面應用框架
- **Vite** - 構建工具
- **Vanilla JavaScript** - 無框架前端
- **ASR** - 本地 sherpa-onnx（Qwen3-ASR-0.6B）或雲端（OpenRouter 相容 `/audio/transcriptions`）
- **翻譯** - 雲端 chat / 本地 GGUF（`linguaforge08`(Q8) 預設／`linguaforge08q4`(Q4)／`qwen35translate`；`llmGpu` 可開 GPU）；即時「自動偵測」= 不譯
- **TTS** - Edge TTS（`node-edge-tts` MIT；語速 `ttsRate`；需連網）
- **翻譯頁** - 輸入不限字數：`splitForTranslate` 通用 ≤600／LinguaForge ≤280 字段落依序翻譯、可中途停止（IPC 單次上限 1500 字）；LinguaForge 解碼見 `local-llm` DECODE 查表
- **聊天** - 雲端 OpenAI 相容 `/chat/completions` + `stream:true`；設定（`chatApiUrl`/`chatApiKey`/`chatModels`/`chatModelId`）與翻譯獨立；會話存 `<userData>/chats.json`（`chat:*` IPC，不走 `store:*`）；Markdown 為自寫渲染器 `renderer/scripts/markdown.js`（零 innerHTML）
- **聊天進階** - 系統提示多組 preset（`chatPrompts`/`chatPromptId`，聊天頁工具列切換、`<dialog>` 管理）；thinking 開關（`chatThinking` → `reasoning_effort`，關閉時完全不帶欄位）；圖片附件（貼上／拖放／選檔 → canvas 縮至 1568px JPEG → main 存 `<userData>/chat-images/`，訊息只記檔名）；訊息複製與重新生成；側欄搜尋
- **額度** - Claude Code／Codex／Antigravity／OpenCode／Grok；手動同步；獨立 `<userData>/usage.json` 快取。憑證與固定 HTTPS／DB 路徑／SQL 只在 main；OpenCode 用 `node:sqlite` 唯讀；Antigravity `.ps1` 必須 `asarUnpack`
- **設定** - 導航最後一頁：左側分類 rail（模型／翻譯／聊天／語音轉文字／外觀／語音朗讀）一次顯示一區，底部 sticky 儲存列；主窗 frameless；預設分頁為聊天；導覽為聊天｜額度｜檔案轉錄｜即時字幕｜翻譯與 TTS｜設定
- **視覺** - Token Anxiety Aurora glass；深／淺兩主題、12px 半透明 surface、冷藍／暖金光暈；RWD 斷點 900／640px，含置頂字幕窗
- **本地 ASR 推論** - `asrThreads`（0＝自動／2／4／8）。沒有 GPU 選項：npm 的 sherpa-onnx Windows 套件是 CPU-only 編譯，指定 cuda／directml 會被靜默退回 CPU

> 現行架構與驗證紀錄見 [CONTEXT.md](./CONTEXT.md)（接手前先讀）。

### 建置與預覽

```bash
npm run electron:pack    # 免安裝快速預覽 → dist/win-unpacked/VoiceInk.exe
npm run electron:build   # NSIS 安裝檔 + win-unpacked → dist/
```

> [!IMPORTANT]
> **每次 UI／功能改動完成後，必須先跑 `npm run electron:pack` 更新免安裝預覽**，讓使用者可直接執行 `dist/win-unpacked/VoiceInk.exe` 驗證。完整 `.exe` 安裝檔（`electron:build`）只在發佈時再打。
> 打包前先關掉開著的 `dist/win-unpacked/VoiceInk.exe`（`Stop-Process -Name VoiceInk -Force`），否則會卡 `d3dcompiler_47.dll: Access is denied`。
> 發行流程：bump 版本（不可與既有 tag 重複）→ commit → `git tag vX.Y.Z` → push → `electron:build` → `gh release create`。

---

## 2. 程式碼規範

### 2.1 命名規則

- **檔案名**：kebab-case (e.g., `audio-capture.js`)
- **變數/函數**：camelCase (e.g., `transcribeFile`)
- **類別**：PascalCase (e.g., `OpenRouterAPI`)
- **常數**：UPPER_SNAKE_CASE (e.g., `API_ENDPOINT`)

### 2.2 程式碼風格

- 使用 ES2022 語法
- 優先使用 `async/await` 處理非同步
- 所有函數添加 JSDoc 註解
- 使用有意義的變數名稱

### 2.3 錯誤處理

- 所有 API 呼叫必須有 try/catch
- 使用用戶友善的錯誤訊息
- console 只記可公開的狀態摘要；不得記錄 API response body、token、外部錯誤原文或本機憑證內容

---

## 3. 關鍵實作提示

### 3.1 系統音訊擷取（Main Process）

```javascript
session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
  desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
    callback({ video: sources[0], audio: 'loopback' })
  })
})
```

Renderer 不再用 MediaRecorder 編碼／解碼：`AudioContext({ sampleRate: 16000 })` 直接取 mono PCM，
`renderer/scripts/vad.js` 以 250ms pre-roll + 360ms 停頓切句（0.5–6s），避免固定 2 秒切斷字詞與 recorder restart 音訊缺口。

### 3.2 雲端 API（僅翻譯）

翻譯選「雲端 LLM」時，由 `src/main/local-llm.js` 的 `translateCloud()` 呼叫 `${apiUrl}/chat/completions`（純文字）。設定鍵：`apiUrl` / `apiKey` / `modelId`。

### 3.3 懸浮字幕視窗

```javascript
subtitleWindow = new BrowserWindow({
  frame: false,
  transparent: false, // 刻意設計：Windows 透明視窗有渲染 bug、resizable 會失效
  backgroundColor: '#1a1a1a',
  alwaysOnTop: true,
  skipTaskbar: true,
  resizable: true,
})
subtitleWindow.setMenu(null)
```

字幕顯示模式（雙語／僅翻譯）由**字幕彈窗**獨佔：控制列「雙/譯」鈕讀寫 store `captionDisplayMode`、以單一 `currentMode` 統一渲染；即時頁不再放此切換、payload 不帶 `displayMode`。字幕行用 `createElement` 增量更新（零 innerHTML），使用者往上看歷史時不強制捲底。

### 3.4 模型載入加速

- `engine.acquire` 內 ASR／LLM warm 以 `Promise.all` 並行。
- 進入 live → `prewarmEngine()`；進入 translate → `prewarmTranslatePage()`；離開各自 cooldown。owner 布林 `live|file|translate`；prewarm 以 gen 作廢 in-flight。切頁先 acquire 新頁再 release 舊頁。

---

## 4. 重要注意事項

> [!IMPORTANT]
>
> - API Key 必須安全儲存，使用 electron-store（IPC 存取）
> - 即時 VAD 在 renderer 做（RMS 遲滯門檻＋pre-roll＋hangover），不要交給 AI 判斷
> - 音訊分段：即時依停頓切 0.5–6 秒語句（ASR pending 上限 2）；檔案仍為 main ffmpeg 28 秒硬切（≥2h／≥100MB）
> - ASR：`asrEngine` local（`qwen3asr`）或 cloud（獨立 asrApi* 憑證）；設定為第四分頁

> [!CAUTION]
>
> - 不要在 Renderer Process 儲存 API Key 明文
> - 不要把即時字幕改回 MediaRecorder：除了 `timeslice` Blob 缺 WebM header，每輪 stop/restart 也會丟邊界音訊；維持 16k PCM 直取
> - 翻譯前文不要塞進「【前文】【本段】」括號式 prompt（小模型會複誦）→ system prompt + chat history
> - LinguaForge 不吃前文 chat history（單輪 SFT MT，多一輪就複誦上一輪譯文）→ 僅 system + 單一 user
> - `LlamaChatSession` 必須帶 `new QwenChatWrapper({ thoughts: 'discourage' })`：Qwen3.5 template 在 assistant 起頭固定補 `<think>\n\n</think>\n\n`（248068,271,248069,271），node-llama-cpp 自動解析的 wrapper 不補；缺這 4 token 會標籤前綴／專名消失／年份幻覺（`budgets.thoughtTokens:0` 補不了）
> - LinguaForge 兩個量化各自是獨立 registry key（`linguaforge08`=Q8 預設／`linguaforge08q4`=Q4，快但罕見專名會音譯）；共用同一套格式，判斷用 `isLinguaforge(key)` 不要比對單一 key
> - 譯文清理只放 `src/main/translate-clean.js`（無 electron 依賴、可 node 直測），別在別處複製一份；單側引號僅在無配對時剝
> - LinguaForge 長文逐行翻譯、清單標記不送模型；退化迴圈偵測到就開 rep-penalty 重跑（重試前還原 history）
> - `s2twp` 僅在含簡體時套詞彙表（`twp` 會把「參數」竄改成「引數」）
> - 顯示模式勿讓即時頁 payload 夾帶 `displayMode` 或加跨窗 IPC（由字幕彈窗獨佔 store `captionDisplayMode`，兩端搶改會打架）
> - 引擎 owner 布林 `live|file|translate`，勿改成計數；prewarm gen 作廢 in-flight；TTS 只傳 lang、回 Uint8Array（禁 base64／禁 AGPL 套件）
> - ASR 有 serial lock + `loadEnabled`（防 stop 後幽靈重載），勿拿掉
> - store key allowlist、`models.openFolder` 僅 registry key；兩窗 `sandbox: true`
> - 額度 IPC 只允許主視窗；renderer 不可指定 provider URL、credential path、DB path 或 SQL。Antigravity 未連線時不得補出假額度；外部 PowerShell 腳本須從 `app.asar.unpacked` 執行
> - 額度排序不設上下按鈕，也不用 HTML5 DnD（拖影必半透明）：pointer 直拖、卡片跟游標且不透明，其他卡片 110ms transform-only FLIP 推開，放開才存一次；Space／方向鍵／Enter／Esc 提供無動畫鍵盤排序，reduced motion 禁用 FLIP
> - 額度卡固定 2 欄（≤900px 收 1 欄）、標題為 accent 實心 pill（無 LOGO 方塊、無方案副標），卡內小字 12px／`--text-secondary`
> - Aurora token 集中在 `themes.css`，共用 surface／900、640px RWD 在 `main.css`；維持原生 DOM／Web Animations，不引入 React、DnD 或動畫 dependency
> - 打包跑的是 `src/` 原始碼（`files` 排除 `dist/**`），改 renderer 直接改 `src/`；`vite build` 只作驗證
> - 歷史教訓清單見 [tasks/lessons.md](./tasks/lessons.md)，開發規範地雷見 [CLAUDE.md](./CLAUDE.md)
