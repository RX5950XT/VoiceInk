# AGENTS.md — AI 代理作業守則

> 給接手 VoiceInk 的 AI 助手。**架構與地雷不在這裡**：
> 現行架構與交接紀錄看 [CONTEXT.md](./CONTEXT.md)，專案規範與地雷清單看 [CLAUDE.md](./CLAUDE.md)
> （那是唯一權威清單，這裡不複製），歷史教訓看 [tasks/lessons.md](./tasks/lessons.md)。

## 1. 這是什麼

**VoiceInk**：Windows 桌面 AI 工作台，Electron 43.4.1 ＋ Vite ＋ Vanilla JS（無框架）。
分頁與各模組的重點見 [CLAUDE.md](./CLAUDE.md)「專案」那張表（版本號以 `package.json` 為準）；
模組職責、資料流與 store key 在 [CONTEXT.md](./CONTEXT.md) 的「架構」；實作限制在 CLAUDE.md 的「地雷」。

## 2. 動手前

1. 先讀 CONTEXT.md 找到要改的模組，再讀 CLAUDE.md 該模組那一段的地雷。
2. 追完整條資料流、看過所有 caller，找根本原因；不憑猜測修改、不搞臨時修補。
3. 改動範圍降到最低，僅限必要之處。
4. 非簡單任務（3 步以上或涉及架構決策）先把可勾選的規劃寫進 `tasks/todo.md`。

## 3. 程式碼規範

命名、ESM／CJS、函數與檔案長度、store allowlist 等硬性慣例見 [CLAUDE.md](./CLAUDE.md)「慣例」。
這裡只留那份沒有、而且改壞過的幾條：

- 所有外部輸入（使用者輸入、API 回應、檔案內容）都要驗證；例外不可靜默吞掉，邊界回結構化錯誤。
- console 只記可公開的狀態摘要：**不得記錄 API response body、token、外部錯誤原文或本機憑證內容**
  （詳見 CLAUDE.md「安全底線」，回歸測試 `test-error-hygiene.js`）。
- **UI 一律禁用強調條／裝飾條**（方框左邊一條粗粗的彩色條，例如 `border-left: 3px solid <accent>` 或
  標題前的色票偽元素）。強調走完整 1px 邊框、底色 tint 或字級／顏色本身，新樣式不准長出這種條。
- **說明文字精簡**：空狀態 ≤ 12 字、hint 只留「這是什麼」不教操作；改文案後要 grep 測試腳本
  同步斷言字串。防誤解的最短說法（數字為什麼長這樣）不準刪光。
  反過來，**測試不可以用「字數大於 N」當斷言**——文案一收乾淨就變假紅燈，要驗的是有沒有講原因。
- **刪功能時把「定義／exports／IPC 白名單／preload／renderer 呼叫點」一起掃**：
  `module.exports` 留一個沒定義的名字＝該模組載入期就 ReferenceError，整組 IPC 回通用錯誤，
  而 `node --check` 與單元測試全綠（要 electron 才 require 得起來）。

## 4. 建置、預覽與發行

指令表與每一步的地雷在 [CLAUDE.md](./CLAUDE.md)「指令」與「發行流程」，這裡只留兩條紀律：

> [!IMPORTANT]
> **每次 UI／功能改動完成後必須跑 `npm run electron:pack`**，讓使用者可直接執行
> `dist/win-unpacked/VoiceInk.exe` 驗證；完整安裝檔只在發佈時再打。打包前先關掉開著的預覽。
>
> **發行是五步一整條**（bump → commit＋tag＋push → `electron:build` → `gh release create` →
> 上傳**三個**檔案）：App 內的自動更新完全靠它產出的檔案，漏一步**不會報錯**，
> 只會讓所有舊版使用者從此檢查不到更新。

## 5. 驗證紀律

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
- **要手動開一份來試，走 `npm run dev:sandbox`**：三份 VoiceInk 預設共用 `%APPDATA%\voiceink`，
  而單一實例鎖綁的就是 userData 路徑——不換路徑開第二份只會自己關掉，還跟使用者搶資料檔與 AGY 的埠。
  沙箱另給一個 userData，把 `models`／`hf-models` 接回去、`config.json`／`workspaces.json` 複製一份，
  三個會影響 userData 之外的開關強制關掉（細節見 CLAUDE.md「測試（CDP／e2e）」第一條）。

## 6. 收尾

- 規則或架構有實質變動時才維護 CLAUDE.md／AGENTS.md／CONTEXT.md，保持精簡且三份對齊。
- 收到使用者修正後，把模式寫進 `tasks/lessons.md`（寫「為什麼」，不要只寫「改了什麼」）。
- 在 `tasks/todo.md` 補回顧章節。
- Commit 格式 `<type>: <description>`（`feat`／`fix`／`refactor`／`docs`／`test`／`chore`／`perf`／`ci`），
  訊息用繁體中文；**只在使用者要求時** commit 或 push。
