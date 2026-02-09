# 即時字幕功能開發與優化交接文件

> 日期：2026-02-09
> 作者：Antigravity (Gemini)
> 版本：v2.0.0
> 狀態：已完成

## 1. 專案概述

本文件整合了「即時字幕功能核心開發」與「懸浮視窗 UI 優化」的所有技術細節。我們完成了一個基於 Electron 的系統音訊擷取、轉錄與即時顯示功能。

---

## 2. 核心功能開發 (Core Features)

我們解決了音訊格式相容性、API 請求限制與 AI 幻覺問題。

### 2.1 關鍵問題與解決方案

| 問題範疇 | 問題描述 | 解決方案 |
|----------|----------|----------|
| **音訊格式** | OpenRouter API 不支援 WebM 格式。 | **前端轉碼**：實作 `webmToWav`，在送出請求前將瀏覽器的 WebM 錄音轉為標準 WAV (16-bit PCM)。 |
| **API 限制** | 請求頻率過高導致 429 錯誤。 | **請求節流**：將錄製區塊時長 (`CHUNK_DURATION`) 設為 3000ms，並加入 `isProcessing` 鎖定機制，防止請求堆疊。 |
| **AI 幻覺** | 靜音時 AI 輸出無意義文字（如「字幕由...提供」）。 | **雙重 VAD 機制**：<br>1. **RMS 閾值 (0.015)**：過濾低音量片段。<br>2. **語音佔比 (5%)**：分析 waveform，確保有足夠的語音特徵才送出請求。 |
| **錄製中斷** | 處理錯誤導致錄製循環停止。 | **非阻塞循環**：將 `processAudioChunkData` 與錄製循環解耦，並完善錯誤捕獲 (`.catch`)。 |

### 2.2 技術實作細節
- **MediaRecorder**：放棄 `timeslice` 模式，改為每次建立新實例，確保獲得完整的檔案標頭 (Header)。
- **Prompt Engineering**：在 System Prompt 中加入嚴格規則，禁止輸出幻覺詞彙。

---

## 3. 懸浮視窗 UI 優化 (Floating Window UI)

我們解決了 Windows 平台上的視窗渲染異常（白色標題列）與互動問題（拖動、調整大小）。

### 3.1 視窗管理問題與解決

| 問題 | 原因 | 解決方案 |
|------|------|----------|
| **白色標題列殘留** | Electron 在 Windows 上同時使用 `transparent: true` 與 `frame: false` 時，若未正確移除選單，會殘留白色標題列。 | 1. 設定 `autoHideMenuBar: true`。<br>2. 明確呼叫 `win.setMenu(null)`。<br>3. **最終方案**：改用不透明視窗 (`transparent: false`) 徹底解決渲染異常。 |
| **無法拖動視窗** | 內容區域 (`.subtitle-history`) 設定了 `no-drag` 且佔滿全視窗。 | **分離拖動區**：在頂部新增專用的 `.drag-area` (`-webkit-app-region: drag`)，內容區域恢復正常互動。 |
| **無法調整大小/滾動** | 透明視窗在 Windows 上會強制禁用 `resizable` 且影響滑鼠事件。 | **放棄透明度**：改用不透明黑色 (`#1a1a1a`) 背景，恢復 `resizable: true` 與正常的滑鼠滾動功能。 |
| **關閉狀態不同步** | 懸浮視窗關閉後主介面未感知。 | **IPC 雙向同步**：<br>1. Main: 監聽視窗關閉 -> 發送 `subtitle:closed`。<br>2. Renderer: 監聽事件 -> 觸發 `stopCapture`。 |

### 3.2 視窗配置 (Final Configuration)

**`src/main/main.js`**:
```javascript
subtitleWindow = new BrowserWindow({
  frame: false,
  transparent: false, // 關鍵：使用不透明解決 Windows 相容性
  backgroundColor: '#1a1a1a',
  resizable: true,    // 關鍵：恢復調整大小
  autoHideMenuBar: true, // 避免選單列出現
  // ...
})
subtitleWindow.setMenu(null) // 雙重保險
```

**`src/renderer/pages/subtitle.html`**:
- 頂部 `.drag-area` 負責拖動。
- 內容 `.subtitle-history` 負責顯示與滾動。
- 右上角新增「複製」與「關閉」按鈕。

---

## 4. 開發建議與注意事項

1. **Windows 透明視窗限制**：
   - 除非必要（如異形視窗），盡量避免在 Windows 使用 `transparent: true`，因為它會導致 `resizable` 失效、滑鼠穿透問題以及潛在的渲染 Bug（如白色邊框）。
   - 若必須使用透明背景，請準備好處理複雜的滑鼠事件轉發 (event forwarding)。

2. **瀏覽器錄音坑**：
   - 不同瀏覽器的 `MediaRecorder` 實作差異大。
   - 始終假設 `timeslice` 產生的 Blob 是不完整的（缺 Header），若需傳送給後端或 API，請自行重新封裝或轉碼。

3. **VAD (語音活動檢測)**：
   - 依賴 AI 自行判斷靜音是不可靠的昂貴行為。
   - 務必在客戶端進行訊號層級的過濾（RMS/Zero-crossing rate）。

---

## 5. 相關檔案列表

- **核心邏輯**: `src/renderer/scripts/live-caption.js`
- **視窗管理**: `src/main/main.js`
- **懸浮視窗**: `src/renderer/pages/subtitle.html`
- **樣式設定**: `src/renderer/styles/main.css`
