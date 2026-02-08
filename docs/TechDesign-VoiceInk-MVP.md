# 技術設計文件：VoiceInk MVP

> 📅 日期：2026-02-08
> 🎯 版本：MVP v1.0

---

## 1. 技術堆疊

| 層級 | 技術 | 版本 |
|------|------|------|
| Runtime | Electron | 35.x |
| Frontend | HTML + CSS + JavaScript | ES2022 |
| Build Tool | Vite | 6.x |
| Audio Processing | fluent-ffmpeg | 2.x |
| Storage | electron-store | 10.x |
| Packaging | electron-builder | 26.x |
| AI API | OpenRouter (Gemini 2.5 Flash) | - |

---

## 2. 專案結構

```
VoiceInk/
├── package.json
├── vite.config.js
├── electron-builder.yml
├── src/
│   ├── main/                    # Electron Main Process
│   │   ├── main.js              # 主程序入口
│   │   ├── ipc-handlers.js      # IPC 事件處理
│   │   ├── audio-capture.js     # 系統音訊擷取
│   │   └── subtitle-window.js   # 懸浮字幕視窗管理
│   ├── renderer/                # Electron Renderer Process
│   │   ├── index.html           # 主視窗 HTML
│   │   ├── styles/
│   │   │   ├── main.css         # 主樣式
│   │   │   └── themes.css       # 深色/淺色主題
│   │   ├── scripts/
│   │   │   ├── app.js           # 主應用邏輯
│   │   │   ├── settings.js      # 設定管理
│   │   │   ├── transcribe.js    # 檔案轉錄功能
│   │   │   ├── live-caption.js  # 即時字幕功能
│   │   │   └── api.js           # OpenRouter API 呼叫
│   │   └── pages/
│   │       ├── settings.html    # 設定頁面
│   │       └── subtitle.html    # 懸浮字幕視窗 HTML
│   └── preload/
│       └── preload.js           # 安全橋接
├── resources/
│   └── icon.ico                 # 應用程式圖示
└── docs/
    ├── research-VoiceInk.md
    └── PRD-VoiceInk-MVP.md
```

---

## 3. 核心模組設計

### 3.1 Main Process (`src/main/`)

#### `main.js` - 主程序入口
```javascript
// 職責：
// - 建立主視窗
// - 註冊 IPC 處理器
// - 管理應用程式生命週期
```

#### `audio-capture.js` - 系統音訊擷取
```javascript
// 職責：
// - 使用 desktopCapturer 擷取系統音訊
// - 將音訊串流分段處理
// - 轉換為 Base64 格式發送至 Renderer
```

#### `subtitle-window.js` - 懸浮字幕視窗
```javascript
// 職責：
// - 建立無邊框、置頂、可拖動的 BrowserWindow
// - 管理視窗位置與大小
// - 接收字幕更新並顯示
```

### 3.2 Renderer Process (`src/renderer/`)

#### `api.js` - OpenRouter API 封裝
```javascript
// API 呼叫封裝
class OpenRouterAPI {
  constructor(apiKey) { ... }
  
  // 轉錄音訊檔案
  async transcribeFile(audioBase64, format, outputLanguage) { ... }
  
  // 即時轉錄音訊片段
  async transcribeLive(audioChunk, targetLanguage) { ... }
  
  // 驗證 API Key
  async validateKey() { ... }
}
```

#### `transcribe.js` - 檔案轉錄邏輯
```javascript
// 職責：
// - 處理檔案拖放
// - 讀取音訊檔案並轉 Base64
// - 呼叫 API 並顯示結果
// - 處理進度回報
```

#### `live-caption.js` - 即時字幕邏輯
```javascript
// 職責：
// - 啟動/停止系統音訊擷取
// - 緩衝並分段音訊（每 3-5 秒）
// - 持續呼叫 API 取得字幕
// - 更新懸浮視窗內容
```

---

## 4. IPC 通訊設計

### 4.1 Main → Renderer 事件

| 頻道 | 資料 | 說明 |
|------|------|------|
| `audio-chunk` | `{ data: ArrayBuffer }` | 系統音訊分段 |
| `subtitle-update` | `{ text: string }` | 更新懸浮字幕 |

### 4.2 Renderer → Main 事件

| 頻道 | 資料 | 說明 |
|------|------|------|
| `start-capture` | `{ targetLanguage: string }` | 開始擷取系統音訊 |
| `stop-capture` | `null` | 停止擷取 |
| `show-subtitle-window` | `null` | 顯示懸浮字幕視窗 |
| `hide-subtitle-window` | `null` | 隱藏懸浮字幕視窗 |
| `update-subtitle` | `{ text: string }` | 更新懸浮字幕 |

---

## 5. 資料儲存設計

使用 `electron-store` 儲存用戶設定：

```javascript
// 設定結構
{
  "apiKey": "sk-or-...",           // OpenRouter API Key
  "theme": "dark",                  // dark | light
  "outputLanguage": "zh-TW",        // 預設輸出語言
  "subtitleFontSize": 24,           // 字幕字體大小
  "subtitleWindowBounds": {         // 字幕視窗位置
    "x": 100,
    "y": 800,
    "width": 800,
    "height": 120
  }
}
```

---

## 6. API 整合規格

### 6.1 OpenRouter 請求格式

```javascript
// 檔案轉錄請求
{
  "model": "google/gemini-2.5-flash-preview",
  "messages": [{
    "role": "user",
    "content": [
      {
        "type": "audio",
        "audio": {
          "data": "<base64_audio>",
          "format": "wav"
        }
      },
      {
        "type": "text",
        "text": "請將這段音訊轉錄為繁體中文。自動偵測語言，過濾贅詞（如「嗯」「啊」「就是」），預測模糊聽不清楚的部分。僅輸出逐字稿內容，不要額外說明。"
      }
    ]
  }]
}

// 即時字幕請求
{
  "model": "google/gemini-2.5-flash-preview",
  "messages": [{
    "role": "user", 
    "content": [
      {
        "type": "audio",
        "audio": {
          "data": "<base64_audio_chunk>",
          "format": "wav"
        }
      },
      {
        "type": "text",
        "text": "即時轉錄此音訊片段為繁體中文字幕。自動偵測語言，若非中文則翻譯。僅輸出字幕文字，保持簡潔。"
      }
    ]
  }]
}
```

---

## 7. 開發階段規劃

### Phase 1：基礎設定 (Day 1)
- [ ] 初始化 Electron + Vite 專案
- [ ] 建立主視窗與基本 UI
- [ ] 實作設定頁面（API Key 儲存）
- [ ] 實作深色/淺色主題切換

### Phase 2：檔案轉錄 (Day 2)
- [ ] 實作檔案拖放功能
- [ ] 實作 OpenRouter API 呼叫
- [ ] 實作轉錄進度顯示
- [ ] 實作結果顯示與複製/儲存

### Phase 3：即時字幕 (Day 3)
- [ ] 實作系統音訊擷取
- [ ] 實作懸浮字幕視窗
- [ ] 實作即時轉錄串流
- [ ] 實作視窗拖動與置頂

### Phase 4：潤飾與打包 (Day 4)
- [ ] UI 細節調整
- [ ] 錯誤處理與用戶提示
- [ ] 使用 electron-builder 打包
- [ ] 測試安裝包

---

## 8. 驗證計畫

### 8.1 功能測試

| 測試項目 | 測試方法 | 預期結果 |
|----------|----------|----------|
| API Key 驗證 | 輸入正確/錯誤 Key | 正確提示成功/失敗 |
| 檔案拖放 | 拖入 MP3/WAV | 正確識別並顯示資訊 |
| 音訊轉錄 | 轉錄 30 秒音訊 | 生成正確逐字稿 |
| 即時字幕 | 播放 YouTube 影片 | 顯示即時字幕 |
| 懸浮視窗 | 拖動視窗 | 可自由移動位置 |
| 主題切換 | 切換深色/淺色 | UI 正確切換 |

### 8.2 手動驗證步驟

1. **啟動應用程式**
   - 執行 `npm run dev`
   - 確認視窗正確顯示

2. **設定 API Key**
   - 進入設定頁面
   - 輸入 OpenRouter API Key
   - 確認儲存成功

3. **檔案轉錄測試**
   - 拖入一個 MP3 音訊檔案
   - 選擇輸出語言為繁體中文
   - 點擊開始轉錄
   - 確認逐字稿正確顯示

4. **即時字幕測試**
   - 播放一個 YouTube 影片
   - 啟動即時字幕功能
   - 確認懸浮視窗顯示字幕
   - 拖動視窗確認可移動
