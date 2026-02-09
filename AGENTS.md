# VoiceInk - AI Agent Instructions

> 此文件為 AI 助手提供開發 VoiceInk MVP 的指導原則。

---

## 1. 專案概覽

**VoiceInk** 是一個 Windows 桌面端語音轉文字應用程式，具備：

- 音訊檔案轉錄功能
- 系統音訊即時字幕功能
- 深色/淺色主題切換

### 技術堆疊

- **Electron 35+** - 桌面應用框架
- **Vite** - 構建工具
- **Vanilla JavaScript** - 無框架前端
- **OpenRouter API** - AI 語音轉錄 (Gemini 3 Flash)

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

## 3. 開發階段

### Phase 1：基礎設定 ⚙️

**目標**：建立專案骨架與基本 UI

**步驟**：

1. 使用 Vite 初始化 Electron 專案
2. 建立主視窗 (`src/main/main.js`)
3. 建立 preload 橋接 (`src/preload/preload.js`)
4. 建立基本 HTML/CSS 結構
5. 實作設定頁面與 API Key 儲存
6. 實作深色/淺色主題切換

**驗證**：

- 應用程式可正常啟動
- 可輸入並儲存 API Key
- 可切換主題

---

### Phase 2：檔案轉錄 📁

**目標**：完成音訊檔案轉逐字稿功能

**步驟**：

1. 實作檔案拖放區域
2. 讀取檔案並轉換為 Base64
3. 實作 OpenRouter API 呼叫模組
4. 實作轉錄進度顯示
5. 實作結果顯示區
6. 實作複製/儲存功能

**驗證**：

- 拖入 MP3/WAV 檔案可正確識別
- 轉錄結果正確顯示
- 複製/儲存功能正常

---

### Phase 3：即時字幕 🎙️

**目標**：完成系統音訊即時字幕功能

**步驟**：

1. 實作 desktopCapturer 音訊擷取
2. 實作音訊串流分段處理
3. 建立懸浮字幕視窗
4. 實作即時轉錄與字幕更新
5. 實作視窗拖動功能

**驗證**：

- 可擷取系統播放的音訊
- 懸浮視窗正確顯示字幕
- 視窗可自由拖動

---

### Phase 4：潤飾與打包 🎨

**目標**：完善 UI 並打包發布

**步驟**：

1. 調整 UI 細節與動畫
2. 完善錯誤處理
3. 配置 electron-builder
4. 生成 Windows 安裝包

**驗證**：

- 安裝包可正常安裝
- 所有功能正常運作

---

## 4. 關鍵實作提示

### 4.1 系統音訊擷取

```javascript
// Main Process
session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
  desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
    callback({ video: sources[0], audio: 'loopback' })
  })
})
```

### 4.2 OpenRouter API 呼叫

```javascript
const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'google/gemini-2.5-flash-preview',
    messages: [{ role: 'user', content: [...] }]
  })
})
```

### 4.3 懸浮視窗設定

```javascript
const subtitleWindow = new BrowserWindow({
  frame: false,
  transparent: true,
  alwaysOnTop: true,
  skipTaskbar: true,
  resizable: true,
  movable: true,
})
```

---

## 5. 重要注意事項

> [!IMPORTANT]
>
> - API Key 必須安全儲存，使用 electron-store
> - 即時字幕需處理 API 速率限制
> - 音訊分段建議 3-5 秒以平衡延遲與品質

> [!CAUTION]
>
> - 不要在 Renderer Process 儲存 API Key 明文
> - 懸浮視窗需設定 `alwaysOnTop: true` 才能置頂

---

## 6. 參考文件

- [深度研究報告](./docs/research-VoiceInk.md)
- [產品需求文件](./docs/PRD-VoiceInk-MVP.md)
- [技術設計文件](./docs/TechDesign-VoiceInk-MVP.md)
