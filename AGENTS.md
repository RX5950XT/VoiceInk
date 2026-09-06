# AGENTS.md — AI 代理作業守則

> 給接手 VoiceInk 的 AI 助手。**架構與地雷不在這裡**：
> 現行架構與交接紀錄看 [CONTEXT.md](./CONTEXT.md)，專案規範與地雷清單看 [CLAUDE.md](./CLAUDE.md)
> （那是唯一權威清單，這裡不複製），歷史教訓看 [tasks/lessons.md](./tasks/lessons.md)。

## 1. 這是什麼

**VoiceInk**（v1.12.0）：Windows 桌面 AI 工作台，Electron 43.4.1 ＋ Vite ＋ Vanilla JS（無框架）。
九個分頁：聊天（**專案工作區與終端機併在同一頁**：側欄兩顆鈕切專案／對話，終端機清單在專案面板下半，中間有分頁列，右邊是檔案總管／Git／AI 記錄；Ctrl+P 快速開檔、Ctrl+W／Ctrl+Tab 管分頁、檔案樹可用方向鍵走、可多選與拖曳搬檔；編輯器是 Monaco，Git 面板含 worktree）｜CC代理｜額度（＋用量統計）｜AGY 反代｜語音轉文字｜翻譯與 TTS｜系統監控（含使用時長／風扇控制／效能調整）｜HF模型｜設定。

模組職責、資料流與 store key 一覽在 [CONTEXT.md](./CONTEXT.md) 的「架構」一節；
每個模組的實作限制在 [CLAUDE.md](./CLAUDE.md) 的「地雷」。

## 2. 動手前

1. 先讀 CONTEXT.md 找到要改的模組，再讀 CLAUDE.md 該模組那一段的地雷。
2. 追完整條資料流、看過所有 caller，找根本原因；不憑猜測修改、不搞臨時修補。
3. 改動範圍降到最低，僅限必要之處。
4. 非簡單任務（3 步以上或涉及架構決策）先把可勾選的規劃寫進 `tasks/todo.md`。

## 3. 程式碼規範

- 檔名 kebab-case、變數／函數 camelCase、類別 PascalCase、常數 UPPER_SNAKE_CASE。
- ES2022、`async/await`、所有函數加 JSDoc；函數 <50 行、檔案 <800 行、巢狀 ≤4 層。
- Renderer 是 ESM，Main／Preload 是 CJS。優先不可變資料。
- 所有外部輸入（使用者輸入、API 回應、檔案內容）都要驗證；例外不可靜默吞掉，邊界回結構化錯誤。
- console 只記可公開的狀態摘要：**不得記錄 API response body、token、外部錯誤原文或本機憑證內容**
  （詳見 CLAUDE.md「安全底線」，回歸測試 `test-error-hygiene.js`）。
- 設定走 electron-store IPC 且 key 僅 allowlist；聊天／終端機／工作區／AGY／語音輸入／用量統計各有獨立 store 與 IPC。
- **UI 一律禁用強調條／裝飾條**（方框左邊一條粗粗的彩色條，例如 `border-left: 3px solid <accent>` 或
  標題前的色票偽元素）。強調走完整 1px 邊框、底色 tint 或字級／顏色本身，新樣式不准長出這種條。
- **說明文字精簡**：空狀態 ≤ 12 字、hint 只留「這是什麼」不教操作；改文案後要 grep 測試腳本
  同步斷言字串。防誤解的最短說法（數字為什麼長這樣）不準刪光。
  反過來，**測試不可以用「字數大於 N」當斷言**——文案一收乾淨就變假紅燈，要驗的是有沒有講原因。
- **刪功能時把「定義／exports／IPC 白名單／preload／renderer 呼叫點」一起掃**：
  `module.exports` 留一個沒定義的名字＝該模組載入期就 ReferenceError，整組 IPC 回通用錯誤，
  而 `node --check` 與單元測試全綠（要 electron 才 require 得起來）。

## 4. 建置與預覽

```bash
npm run electron:pack    # 免安裝快速預覽 → dist/win-unpacked/VoiceInk.exe
npm run electron:build   # NSIS 安裝檔 + win-unpacked → dist/
npm run build:sensors    # 系統監控感測器＋風扇控制 sidecar（需 .NET 8 SDK）
npm run build:hook       # 語音輸入原生熱鍵 sidecar（需 .NET 8 SDK）
```

> [!IMPORTANT]
> **每次 UI／功能改動完成後必須跑 `npm run electron:pack`**，讓使用者可直接執行
> `dist/win-unpacked/VoiceInk.exe` 驗證；完整安裝檔只在發佈時再打。
> 打包前先關掉開著的預覽（`Stop-Process -Name VoiceInk -Force`）。
> `resources/sensors/`（36MB）與 `resources/hook/`（10MB）**不進版控**，乾淨 clone 要出貨這兩個功能就先自己建；
> 沒建也打得起來，只是感測器顯示「沒有附帶元件」、右 Alt 退回「只監聽」模式。

## 5. 發行

App 內有自動更新（設定 → 基本），**它完全靠這條流程產出的檔案**；漏一步不會報錯，
只會讓所有舊版使用者從此檢查不到更新。地雷細節見 [CLAUDE.md](./CLAUDE.md)「發行流程」。

1. bump `package.json` 的 `version`（不可與既有 tag 重複），順手更新 README 頂端版本行。
2. commit → `git tag vX.Y.Z` → `git push && git push --tags`。
3. `npm run electron:build` → `dist/` 產出安裝檔、`.blockmap`、`latest.yml`。
4. `gh release create vX.Y.Z`（**不可 `--draft`／`--prerelease`**，electron-updater 走
   `releases/latest`，那兩種它看不到）。
5. `gh release upload vX.Y.Z` 把**三個檔案都傳上去**：
   `VoiceInk-Setup-X.Y.Z.exe`、同名 `.blockmap`、`latest.yml`。

| 檔案 | 少了會怎樣 |
|---|---|
| 安裝檔 | 下載 404 |
| `latest.yml` | 舊版永遠顯示「沒有附帶更新資訊」（它只在 `build.publish` 有設定時才產出） |
| `.blockmap` | 不報錯，但差異更新退回下載完整 360MB |

發完之後舊版開 App 20 秒後就會自己看到；也可以在設定 → 基本手動按「檢查更新」。

## 6. 驗證紀律

- **宣告完成前必附驗證指令與實際輸出**；沒跑過就不算完成。完整指令表在 CLAUDE.md「驗證方式」。
- 同一修法失敗兩次就停下換方法，不重試第三次。
- 新寫的回歸測試**要先在修復前跑一次**，紅了才算數。
- mock 全綠證明不了對面長什麼樣：整合功能要另留 `probe-*.js` 打真流量；
  「讓機器做某件事」的功能要用第三方工具量結果，不能只看 App 自己回報的狀態。
- **使用者同時在用電腦時**，桌面 QA 只能用 CDP／視窗 API 背景操作；
  不可移動滑鼠、發全域快捷鍵或搶前景焦點。語音輸入測試一定要把 `insert` 換成 stub。
  唯一的例外是讀剪貼簿（`navigator.clipboard.readText()` 沒有焦點就丟 `NotAllowedError`），
  這種測試要在檔頭寫明「會把視窗叫到最前面」（`e2e-ux-tweaks-cdp.js`）。
- **CDP 測試只可用自己 spawn 的 `child.pid` 搭 `taskkill /PID /T` 收尾**，禁止 `/IM VoiceInk.exe`；
  一律用暫存 `--user-data-dir`，並用 `[data-id="…"]` 指涉自己建的資料（不可用「第一列」或總數）。

## 7. 收尾

- 規則或架構有實質變動時才維護 CLAUDE.md／AGENTS.md／CONTEXT.md，保持精簡且三份對齊。
- 收到使用者修正後，把模式寫進 `tasks/lessons.md`（寫「為什麼」，不要只寫「改了什麼」）。
- 在 `tasks/todo.md` 補回顧章節。
- Commit 格式 `<type>: <description>`（`feat`／`fix`／`refactor`／`docs`／`test`／`chore`／`perf`／`ci`），
  訊息用繁體中文；**只在使用者要求時** commit 或 push。
