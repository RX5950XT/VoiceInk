/**
 * 不認得 asar 的 `fs`：碰「使用者任意路徑」的模組一律用這個。
 *
 * Electron 的 `fs` 會把 `.asar` 當成資料夾打開，而且**開了就不關**（archive 快取到程序結束）。
 * 檔案總管列一次打包輸出、終端機把印出來的路徑偵測成連結、工作區搜尋掃到 `dist/`，
 * 那個 `app.asar` 就被 VoiceInk 鎖住：刪不掉、下一次打包 `EBUSY: unlink app.asar`。
 * `original-fs` 是 Electron 保留的原版 Node `fs`，`.asar` 只是一個普通檔案。
 *
 * 純 Node 跑的單元測試沒有 `original-fs`，退回一般的 `fs`（Node 本來就不認得 asar）。
 * App 自己的程式碼與資源（在 app.asar 裡）**不要**用這支讀。回歸 `test-asar-lock.js`。
 */

let fs
try {
  fs = require('original-fs')
} catch {
  fs = require('fs')
}

module.exports = fs
