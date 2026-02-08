# 深度研究報告：VoiceInk

> 🗓️ 研究日期：2026-02-08
> 🎯 專案目標：Windows 桌面端語音轉文字應用程式

---

## 1. 專案概覽

VoiceInk 是一個 Windows 桌面應用程式，提供兩大核心功能：
1. **音訊檔案轉錄**：拖入音訊檔案生成逐字稿
2. **即時字幕**：擷取系統音訊並即時顯示字幕

### 用戶背景
- **技術等級**：Vibe-coder（非技術背景）
- **目標平台**：Windows Desktop
- **使用場景**：個人使用，API Key 由用戶自行管理

---

## 2. 技術方案推薦

### 2.1 桌面框架：**Electron** ⭐ 推薦

| 框架 | 優點 | 缺點 | 適合度 |
|------|------|------|--------|
| **Electron** | 成熟穩定、生態系豐富、支援 WASAPI loopback | 較大的安裝包（~150MB） | ⭐⭐⭐⭐⭐ |
| Tauri | 輕量（~10MB）、Rust 後端 | Rust 學習曲線陡峭、音訊擷取需自行實作 | ⭐⭐ |
| WPF/WinUI | 原生 Windows、輕量 | 需 C# 經驗、開發速度較慢 | ⭐⭐ |

**推薦理由**：
- Vibe-coder 友善：JavaScript/TypeScript 學習資源豐富
- 系統音訊擷取有現成解決方案
- Chromium 內建的 `getDisplayMedia` API 支援 `audio: 'loopback'`
- 大量 npm 生態系套件可使用

---

### 2.2 系統音訊擷取方案

#### 方案 A：Electron `desktopCapturer` + `setDisplayMediaRequestHandler` ⭐ 推薦

```javascript
// Main Process
session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
  desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
    callback({ video: sources[0], audio: 'loopback' })
  })
})
```

**特點**：
- Electron 原生支援
- Windows 10+ 完整支援
- 無需額外原生模組

#### 方案 B：`application-loopback` npm 套件

使用 WASAPI 直接擷取特定應用程式或系統音訊的 Node.js 原生模組。

**適用場景**：需要更精細控制音訊來源時

---

### 2.3 AI 語音轉文字：**OpenRouter + Gemini 2.5 Flash**

#### API 規格

| 項目 | 說明 |
|------|------|
| 端點 | `https://openrouter.ai/api/v1/chat/completions` |
| 模型 | `google/gemini-2.5-flash-preview` |
| 音訊格式 | WAV, MP3, AIFF, AAC, OGG, FLAC |
| 最大長度 | 最多 11 小時音訊 |
| 輸入方式 | Base64 編碼 |

#### API 請求範例

```javascript
const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'google/gemini-2.5-flash-preview',
    messages: [{
      role: 'user',
      content: [
        {
          type: 'audio',
          audio: {
            data: audioBase64,
            format: 'wav'
          }
        },
        {
          type: 'text',
          text: '請將這段音訊轉錄為繁體中文逐字稿，自動過濾贅詞，並預測模糊聽不清楚的部分。'
        }
      ]
    }]
  })
})
```

#### Gemini Flash 優勢
- ✅ 自動語言偵測
- ✅ 智慧過濾贅詞（「嗯」「啊」「就是」等）
- ✅ 上下文預測模糊音訊
- ✅ 多語言翻譯能力
- ✅ 高速處理（Flash 優化版本）

---

### 2.4 音訊處理

| 套件 | 用途 |
|------|------|
| `fluent-ffmpeg` | 音訊格式轉換、分割 |
| `web-audio-api` | 音訊分析、波形處理 |
| `pcm-convert` | PCM 格式轉換 |

**支援格式**：MP3, WAV, M4A, FLAC, OGG, AAC, WMA, AIFF

---

## 3. 核心功能技術實現

### 3.1 檔案轉錄流程and

```mermaid
graph LR
    A[拖入音訊檔案] --> B[讀取為 Buffer]
    B --> C[轉換為 Base64]
    C --> D[呼叫 OpenRouter API]
    D --> E[解析回應]
    E --> F[顯示逐字稿]
```

### 3.2 即時字幕流程

```mermaid
graph LR
    A[啟動系統音訊擷取] --> B[取得音訊串流]
    B --> C[分段切割 3-5 秒]
    C --> D[Base64 編碼]
    D --> E[OpenRouter API]
    E --> F[更新懸浮字幕視窗]
    F --> C
```

### 3.3 懸浮視窗技術要點

```javascript
// Electron BrowserWindow 設定
const subtitleWindow = new BrowserWindow({
  width: 800,
  height: 120,
  frame: false,           // 無邊框
  transparent: true,       // 透明背景
  alwaysOnTop: true,       // 置頂
  skipTaskbar: true,       // 不顯示在工作列
  resizable: true,
  movable: true,
  webPreferences: {
    nodeIntegration: true,
    contextIsolation: false
  }
})
```

---

## 4. 成本預估

### OpenRouter API 定價（Gemini 2.5 Flash）

| 類型 | 價格 |
|------|------|
| 輸入 | $0.15 / 1M tokens |
| 輸出 | $0.60 / 1M tokens |

**估算**（以 1 小時音訊為例）：
- 預估輸入：~50,000 tokens（音訊 + 指令）
- 預估輸出：~15,000 tokens（逐字稿）
- 單次費用：約 $0.02 USD

> 💡 成本極低，適合個人使用

---

## 5. 技術風險與對策

| 風險 | 影響 | 對策 |
|------|------|------|
| 即時字幕延遲 | 體驗下降 | 使用串流處理、預緩衝 |
| API 失敗 | 功能中斷 | 錯誤重試機制、用戶提示 |
| 音訊格式不支援 | 轉錄失敗 | 使用 FFmpeg 自動轉換 |
| 長時間音訊 | 超時/費用高 | 自動分段處理 |

---

## 6. 推薦技術堆疊摘要

| 層級 | 技術 |
|------|------|
| **框架** | Electron 35+ |
| **前端** | HTML + CSS + Vanilla JavaScript |
| **音訊擷取** | Electron desktopCapturer + WASAPI loopback |
| **AI API** | OpenRouter (Gemini 2.5 Flash) |
| **音訊處理** | fluent-ffmpeg |
| **打包** | electron-builder |

---

## 7. 下一步

1. ✅ 確認技術方案
2. ➡️ 進入 **階段 2：產品需求 (PRD)** - 詳細規劃功能與 UI
