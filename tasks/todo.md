# VoiceInk UI & Design Token Polish Todo

## v1.9.0 發行（2026-08-30）
- [x] 確認 `v1.9.0` 未與本地／遠端 tags 重複。
- [x] 提交版本與文件更新並建立 `v1.9.0` tag。
- [x] 產生並驗證 NSIS 安裝檔。
- [x] 推送分支／tag 並建立 GitHub Release。

### Review
- 提交：`c1e6040`（`feat: 發行 v1.9.0 UI 與模型工作台更新`）。
- 安裝檔：`dist/VoiceInk Setup 1.9.0.exe`，SHA-256 `1D754B85C19BBD2C8C8CEB97E39D8D197ED930099BA86889F1B7E010363AA08E`。
- Release：<https://github.com/RX5950XT/VoiceInk/releases/tag/v1.9.0>。

## 本輪完成修復（2026-08-29）
- [x] 修正 AGY Base URL 的舊狀態覆寫，驗證 `e2e-agy-cdp.js`。
- [x] 修正終端機首次提示字元遺失，驗證 `e2e-terminal-cdp.js`。
- [x] 修正 CDP 測試的全域 `taskkill`，不得關閉使用者安裝版。
- [x] 重新打包並跑完整 UI／功能驗收。
- [x] 驗收通過後清除 `.agents/` 與 `PROJECT.md`，更新交接紀錄。

## 本輪 UI 修整（2026-08-29）
- [x] 統一所有下拉控制項的收合形狀、箭頭、hover/focus 與雙主題 option 顏色。
- [x] 讓思考開關的開啟狀態與 hover 狀態可清楚區分。
- [x] 對齊設定頁生圖模型列的欄位、勾選標記與移除按鈕。
- [x] 更新免安裝預覽並通過 49 項視覺、22 項冒煙回歸。

## 本輪自訂下拉修整（2026-08-29）
- [x] 以可控的自訂 listbox 取代原生展開彈窗，保留既有 `<select>` 資料流與 change 事件。
- [x] 統一模型、語言、供應商與其他下拉的圓角、選取／hover 顏色、鍵盤操作與 RWD。
- [x] 修正聊天 `<optgroup>` 模型下拉點擊例外，並讓窄版長選項保持單行與可讀寬度。
- [x] 補上聊天模型點擊、模型列三欄同高回歸，重跑建置、免安裝預覽與視覺測試（54/54）。
- [x] 修正 `.setting-group label` 蓋掉生圖標籤 flex 對齊，補勾選框／文字中心線回歸。

## 待辦清單
- [x] 階段 0：全域 Survey 與架構探索（Explorers 1~3 完成調研）
- [x] 階段 1：M1 全域視覺系統與基礎排版精修（Design Tokens & Typography - R1）
- [x] 階段 2：M2 AI 聊天分頁與 Markdown 視覺體驗優化（Chat & Markdown - R2）
- [x] 階段 3：M3 終端機、額度卡片與輔助工具面板打磨（Terminal, Usage, AGY & Panels - R3）
- [x] 階段 4：M4 設定頁面與全域導覽列互動優化（Settings & Navigation - R4）
- [x] 階段 5：M5 E2E 視覺測試與打包驗證（`npm run build`, `npm run electron:pack`, `e2e-visual-cdp.js`, `e2e-cdp-smoke.js`）

## 回顧（Review）
- 階段 0 完成：3 位 Explorer 針對 R1 (Design Tokens)、R2 (Chat & Markdown)、R3/R4/E2E 測試完成全面調研並建立了 `PROJECT.md`。
- 階段 1~5 完成：
  - 全域 Token Anxiety Aurora 雙色主題（深/淺）、字體層級、12px 圓角與 WCAG AA 對比度標準確立。
  - AI 聊天訊息氣泡、Thinking 折疊區塊、Markdown 代碼高亮/表格/引言與底部輸入框交互打磨完成。
  - 終端機側欄狀態指示燈、額度管理卡片與進度條、AGY 反代日誌/統計面板精修完成。
  - 導覽列 Active 膠囊光暈、設定頁分類 Rail 與表單 Focus Ring 規格統一。
  - 全自動化測試套件（Vite 建置、免安裝預覽打包、視覺 CDP 48 項、冒煙測試 22 項、終端機 29 項、額度 10 項、AGY 33 項、語音 19 項）全數 100% 通過。
  - 2026-08-29：補 AGY 狀態 generation guard、終端機背景首段輸出序列化，以及 CDP 暫存 profile／PID 收尾；終端機回歸更新為 30 項。
  - 2026-08-29：統一下拉與模型 chip 的控制項視覺，強化思考開關狀態，將生圖模型列改為三欄對齊；視覺回歸更新為 49 項。
  - 2026-08-29：原生下拉的展開清單仍由 OS 畫、無法控制圓角，改用 `custom-select.js` 共用 ARIA listbox；打包版視覺／互動回歸更新為 52 項。
  - 2026-08-29：聊天模型 `<optgroup>` 誤讀 `child.options` 導致點擊下拉拋例外；改用群組內 `option`，並補窄版寬度與模型列幾何回歸，視覺／互動更新為 54 項。
