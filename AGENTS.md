# VoiceInk - AI Agent Instructions

> 此文件為 AI 助手提供開發 VoiceInk MVP 的指導原則。

---

## 1. 專案概覽

**VoiceInk** 是一個 Windows 桌面端語音轉文字應用程式，具備：

- 音訊檔案轉錄功能
- 系統音訊即時字幕功能
- 翻譯與 TTS（Edge TTS 朗讀）
- 深色/淺色主題切換

### 技術堆疊

- **Electron 35+** - 桌面應用框架
- **Vite** - 構建工具
- **Vanilla JavaScript** - 無框架前端
- **本地 ASR** - sherpa-onnx（固定 Qwen3-ASR-0.6B，CPU 即時）+ opencc-js 轉繁
- **翻譯** - none / 雲端（OpenAI 相容 chat completions）/ 本地（node-llama-cpp + Qwen3.5-0.8B GGUF）；檔案／即時／翻譯頁共用
- **TTS** - Edge TTS（`node-edge-tts` MIT；`edge-tts.js` facade；需連網）

> 現行架構與驗證紀錄見 [CONTEXT.md](./CONTEXT.md)（接手前先讀）。

### 建置與預覽

```bash
npm run electron:pack    # 免安裝快速預覽 → dist/win-unpacked/VoiceInk.exe
npm run electron:build   # NSIS 安裝檔 + win-unpacked → dist/
```

> [!IMPORTANT]
> **每次 UI／功能改動完成後，必須先跑 `npm run electron:pack` 更新免安裝預覽**，讓使用者可直接執行 `dist/win-unpacked/VoiceInk.exe` 驗證。完整 `.exe` 安裝檔（`electron:build`）只在發佈時再打。

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
- 記錄詳細錯誤至 console

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

字幕顯示模式（雙語／僅翻譯）由**字幕彈窗**獨佔：控制列「雙/譯」鈕讀寫 store `captionDisplayMode`、以單一 `currentMode` 統一渲染；即時頁不再放此切換、payload 不帶 `displayMode`。

### 3.4 模型載入加速

- `engine.acquire` 內 ASR／LLM warm 以 `Promise.all` 並行。
- 進入 live → `prewarmEngine()`；進入 translate → `prewarmTranslatePage()`；離開各自 cooldown。owner 布林 `live|file|translate`；prewarm 以 gen 作廢 in-flight。切頁先 acquire 新頁再 release 舊頁。

---

## 4. 重要注意事項

> [!IMPORTANT]
>
> - API Key 必須安全儲存，使用 electron-store（IPC 存取）
> - 靜音檢測在客戶端做（RMS＋語音佔比），不要交給 AI 判斷
> - 音訊分段：即時 2 秒（佇列「保留最新 pending」不丟塊）；檔案 28 秒（main ffmpeg 串流，≥2h／≥100MB）
> - ASR 固定 Qwen3-ASR-0.6B（`ASR_MODEL_KEY = 'qwen3asr'`），無引擎切換 UI

> [!CAUTION]
>
> - 不要在 Renderer Process 儲存 API Key 明文
> - 不要把 MediaRecorder 改回 `timeslice` 模式（Blob 缺 WebM header）
> - 翻譯前文不要塞進「【前文】【本段】」括號式 prompt（小模型會複誦）→ system prompt + chat history
> - 顯示模式勿讓即時頁 payload 夾帶 `displayMode` 或加跨窗 IPC（由字幕彈窗獨佔 store `captionDisplayMode`，兩端搶改會打架）
> - 引擎 owner 布林 `live|file|translate`，勿改成計數；prewarm gen 作廢 in-flight；TTS 只傳 lang、回 Uint8Array（禁 base64／禁 AGPL 套件）
> - ASR 有 serial lock + `loadEnabled`（防 stop 後幽靈重載），勿拿掉
> - store key allowlist、`models.openFolder` 僅 registry key；兩窗 `sandbox: true`
> - 打包跑的是 `src/` 原始碼（`files` 排除 `dist/**`），改 renderer 直接改 `src/`；`vite build` 只作驗證
> - 歷史教訓清單見 [tasks/lessons.md](./tasks/lessons.md)，開發規範地雷見 [CLAUDE.md](./CLAUDE.md)
