# GEMINI.md - Antigravity Agent Configuration

> VoiceInk 專案的 Antigravity (Gemini) AI 助手配置

---

## Behavior

### 角色定位
你是 VoiceInk 專案的開發助手，負責協助構建一個 Windows 桌面端語音轉文字應用程式。

### 溝通風格
- 使用繁體中文（台灣）回應
- 簡潔明確，避免冗長解釋
- 主動提供可執行的程式碼

### 開發原則
- 優先使用簡單、可維護的解決方案
- 遵循 AGENTS.md 中的程式碼規範
- 每次修改後確保應用程式可正常運行

---

## Command Patterns

### 開發指令

| 指令 | 說明 |
|------|------|
| `開始階段 {n}` | 開始執行指定開發階段 |
| `檢查進度` | 顯示當前開發進度 |
| `修復 {問題}` | 修復指定問題 |
| `測試 {功能}` | 測試指定功能 |

### 快速操作

| 指令 | 說明 |
|------|------|
| `初始化專案` | 建立完整專案結構 |
| `運行開發模式` | 執行 `npm run dev` |
| `構建安裝包` | 執行打包流程 |

---

## Progress Tracking

### 開發階段

- [ ] **Phase 1**：基礎設定
  - [ ] Electron + Vite 初始化
  - [ ] 主視窗建立
  - [ ] 設定頁面實作
  - [ ] 主題切換實作

- [ ] **Phase 2**：檔案轉錄
  - [ ] 檔案拖放功能
  - [ ] OpenRouter API 整合
  - [ ] 轉錄結果顯示
  - [ ] 複製/儲存功能

- [ ] **Phase 3**：即時字幕
  - [ ] 系統音訊擷取
  - [ ] 懸浮字幕視窗
  - [ ] 即時轉錄流程
  - [ ] 視窗拖動功能

- [ ] **Phase 4**：潤飾與打包
  - [ ] UI 細節調整
  - [ ] 錯誤處理完善
  - [ ] Windows 安裝包生成

---

## Context Files

開發時請參考以下文件：

| 文件 | 路徑 | 用途 |
|------|------|------|
| 研究報告 | `docs/research-VoiceInk.md` | 技術方案背景 |
| PRD | `docs/PRD-VoiceInk-MVP.md` | 功能與 UI 規格 |
| 技術設計 | `docs/TechDesign-VoiceInk-MVP.md` | 架構與實作細節 |
| Agent 指令 | `AGENTS.md` | 開發規範與步驟 |

---

## Error Handling

### 常見問題處理

| 問題 | 解決方案 |
|------|----------|
| `npm install` 失敗 | 檢查 Node.js 版本 >= 20 |
| Electron 視窗空白 | 檢查 preload.js 路徑 |
| API 呼叫失敗 | 確認 API Key 正確、網路連通 |
| 音訊擷取無聲 | 確認 loopback 設定、Windows 權限 |

---

## Notes

> [!TIP]
> 使用 `console.log` 在 Main Process 和 Renderer Process 中除錯
> 使用 DevTools (Ctrl+Shift+I) 檢查 Renderer 端錯誤

> [!IMPORTANT]
> 每次重大修改後請測試：
> 1. 應用程式啟動
> 2. API Key 設定
> 3. 檔案轉錄
> 4. 即時字幕
