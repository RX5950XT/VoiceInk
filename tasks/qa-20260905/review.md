# 2026-09-05 修復與驗收

本輪保留原有 staged／unstaged 修改，不 commit 或 push。以本機 Orca 原始碼作專案功能參考。

## 已重現與修復

- 專案 IPC：新增功能漏接 main 的 service，草稿、全部暫存與 AI 記錄無法呼叫（整合驗收中）。
- 編輯器：行號 12px、文字 13px，逐行錯位；統一字級，窄版尋找列可以縮排。
- Git Diff：淺色主題仍使用淺綠／淺紅文字；改用主題文字色，保留增刪底色。
- 視窗安全：主視窗原本放行任意 `file://`；只允許 App 自身頁面。webview 建立時移除外帶 preload 並強制沙箱。
- 自動更新：缺 `app-update.yml` 時按鈕停在 idle、没有提示；回傳明確 unsupported 狀態。上游錯誤不再寫入 console 原文。

## 驗證紀錄

以下皆為本輪實際輸出，完整輸出存於同目錄 `.log`。Electron 測試由 Node 等待程序結束，`windowsHide: true`；資料使用各腳本自建的暫存目錄。

| 指令 | 實際結果 |
|---|---|
| `node scripts/test-dictation.js` | `114 passed, 0 failed` |
| `node scripts/test-ccswitch.js` | `255 passed, 0 failed` |
| `node scripts/test-ccswitch-gateway.js` | `53 passed, 0 failed` |
| `node scripts/test-agy-mappers.js` | `50 passed, 0 failed` |
| `node scripts/test-usage.js` | `34/34 passed` |
| `node scripts/test-usage-reorder.js` | `ALL PASS 15 passed, 0 failed` |
| `node scripts/test-terminal.js` | `60 passed, 0 failed` |
| `node scripts/test-model-scope.js` | `31 passed, 0 failed` |
| `node scripts/test-markdown.js` | `ALL PASS 23 passed, 0 failed` |
| `node scripts/test-hfmodels.js` | `146 passed, 0 failed` |
| `node scripts/test-error-hygiene.js` | `82 passed, 0 failed` |
| `node scripts/test-ipc-invoke.js` | `ALL PASS — 11 passed, 0 failed` |
| `node scripts/test-vad.js` | `ALL PASS 11 passed, 0 failed` |
| `node scripts/test-screentime.js` | `ALL PASS` |
| `node scripts/test-updater.js` | `全部通過`（含缺更新設定與錯誤不洩漏） |
| `node scripts/test-window-security.js` | `PASS 視窗導覽、webview preload 與沙箱守衛` |
| `electron.exe scripts/e2e-chat.js` | `ALL PASS 138 passed, 0 failed`，exit=0 |
| `electron.exe scripts/e2e-terminal.js` | `27 passed, 0 failed`，exit=0 |
| `electron.exe scripts/e2e-agy.js` | `98 passed, 0 failed`，exit=0 |
| `node scripts/e2e-ccswitch-gateway.js` | `40 passed, 0 failed` |
| `npm audit --audit-level=high` | `found 0 vulnerabilities` |
| `npm run build` | `✓ built in 3.66s` |

語法初檢：對 `rg --files src scripts -g *.js` 的 268 個檔案執行 `node --check`，`failures: []`。

## 尚在驗收

專案互動、感測器與風扇生命週期、真實用量獨立對帳、打包版 UI、預覽更新。

## 測試事件

第一輪直接由 PowerShell 啟動 GUI 版 Electron 時，shell 提早結束導致 `EPIPE` 彈窗。已驗證並只終止該輪 e2e-chat/e2e-agy 的 PID，改為 Node 等待 exit 後三組測試皆通過；使用者的安裝版未關閉。

參考：[Orca](https://github.com/stablyai/orca)、[Electron 視窗與 webview 安全](https://www.electronjs.org/docs/latest/tutorial/security)。
