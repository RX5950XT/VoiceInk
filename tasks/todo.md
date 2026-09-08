# tasks/todo.md — 規劃與回顧

## 2026-09-09 — 記事本置頂、Shift+Enter、Git 面板重整、終端機桌布

- [x] Ctrl+G 的記事本每次都跳出來而且置頂（`terminal/foreground.js`）
- [x] 終端機 Shift+Enter 換行（`\x1b[13;2u` → `\x1b\r`）
- [x] Git 面板重整（參考 orca 的 `right-sidebar/source-control`）
- [x] 終端機配色與桌布（設定 → 基本）
- [x] 打包版實測與截圖檢查

**回顧** — 這一輪最重要的是第一項的**根因**：

`foreground.js` 原本在找「新出現的、有視窗的 pid」。但 Windows 11 的記事本第二次開檔案
會**沿用同一個程序、同一個視窗**（只多一個分頁，實測兩次都是 pid 5380／HWND 394578），
所以那個信號在「記事本已經開著」時永遠不會成立——這就是使用者說的「之前剛改完又變回原樣」。
快照改成記「視窗代碼＋標題」，標題變動只放行 `REUSE_WINDOW` 那幾支會重用視窗的編輯器
（瀏覽器切分頁也一直在改標題）；抬完再 `SetWindowPos(HWND_TOPMOST)`。

Shift+Enter 送的 `\x1b[13;2u`（CSI u）要 CLI 先啟用 kitty keyboard protocol，
xterm.js 不宣告支援，於是那串序列被當成一般字元印進輸入框。改成 `\x1b\r`。

Git 面板：列改成「檔名（亮）＋所在資料夾（淡）」兩段、右邊補 `+新增 −刪除`
（`status()` 多跑一次 `diff --numstat -z --no-renames HEAD`）、分組標頭帶檔案數與整組暫存／取消、
超過 8 個檔案時出現篩選框（只重畫不重問 main）、分支的 ↑↓ 拆成兩顆分色 chip。
**動作鈕維持常駐不做 hover-only**——orca 那邊是 hover 才出現，但本專案的規則相反。
第一版截圖抓到長檔名把目錄與按鈕擠到疊在一起（`.ws-git-basename` 寫成 `flex: none`），
改成兩段都能縮、**目錄先被壓掉**（`flex-shrink` 999）。

終端機桌布：圖片本體存 `<userData>/terminal-bg/`，store 只存檔名，renderer 只拿得到 `data:` URI；
**只有真的有桌布時**才把 xterm 底色改成 `#00000000` ＋ `allowTransparency`（沒圖時維持不透明，
否則捲動殘影會疊在一起），壓暗的 `opacity` 只作用在 `.term-host::before` 那一層。

驗證（打包版 `VOICEINK_EXE=D:/vi-build-term-git-ui/win-unpacked/VoiceInk.exe`）：

| 指令 | 實際結果 |
|---|---|
| `node scripts/probe-terminal-foreground.js` | **舊版 1 failed**（`WS_EX_TOPMOST=False`）→ 新版 2 passed, 0 failed |
| `node scripts/probe-terminal-background.js` | 12 passed, 0 failed（桌布畫得出來、字仍是不透明的 `rgb(230,230,230)`、拿掉圖底色回到 `#000000`） |
| `node scripts/test-terminal.js` | 77 passed, 0 failed（`test-error-hygiene.js` 85／`test-ipc-invoke.js` 11 也都 0 failed） |
| `node scripts/test-workspace.js` | 231 passed, 0 failed（新增 [U] 真 repo 量增刪行數） |
| `node scripts/test-workspace-ui.js` | 104 passed, 0 failed（新增 [F] Git 列版面契約；把 `flex: 0 1 auto` 改回 `flex: none` 會紅） |
| `node scripts/e2e-terminal-cdp.js` | 47 passed, 0 failed（Shift+Enter 實測送出 `\x1b\r`） |
| `node scripts/e2e-workspace-cdp.js` | 169 passed, 0 failed（新增「沒有任何一列的內容溢出」與「沒撞名不印資料夾」） |
| `node scripts/e2e-visual-cdp.js` | ALL PASS 71 visual checks |
| `node scripts/e2e-cdp-smoke.js` | 22 passed, 0 failed |
| asar 抽驗 | `workspace-page.js`／`term-themes.js`／`main.js` 內容正確，沒有錯位 |

**踩到兩個坑**：

1. 第一版的列版面用 `flex: none` 給檔名，長檔名把行數與動作鈕整排擠到疊在一起——
   單元測試與 e2e 全綠，**是截圖才看出來的**。改成兩段都能縮、目錄先被壓掉，
   並且目錄只在撞名時才印（第二版又變成一排 `e2e-termina…` 認不出是誰）。
   這條現在有斷言擋著（`test-workspace-ui.js` 的 [F]、`e2e-workspace-cdp.js` 的 [E]）。
2. **連續三次打包到同一個輸出目錄，第三次產出的執行檔是壞的**（`Invalid file descriptor
   to ICU data received`、程序直接 exit `0xC0000003`，而 electron-builder 照樣 exit 0，
   asar 本身驗過是好的）。照 CLAUDE.md 的做法整個刪掉重打就正常了。

**沒做**：桌布的「選圖」那一步是系統對話框，CDP 測不到（圖片是先擺進 userData 的，
從 store 存的檔名往後那整條路都是真的）。未 commit 之外的發行動作也沒做。

## 2026-09-08 — 全專案 bug 掃描與修復

- [x] 盤點所有模組與既有測試，建立安全的測試基準
- [x] 追查失敗與資料流，先重現再修復確認的 bug
- [x] 執行受影響回歸、建置與隔離打包版驗收
- [x] 記錄修復證據與未能驗證的範圍

修復回顧：

- 聊天：相容沒有結尾換行的 SSE，最後一段中文仍送到畫面並存入會話。
- CC 代理：自訂 Anthropic 模型掃描依 authField 使用 Bearer 或 x-api-key。
- 雲端 ASR：連線及讀取本文失敗不透傳外部錯誤；逾時涵蓋完整回應讀取。
- 語音字典：修正永遠不會成立的長度守衛，避免把整句改寫當成新詞。
- HF 模型：驗證分片編號與總數，缺片拒絕下載；查詢完成後再次檢查下載狀態，阻止同時寫入同一模型。
- 工作區：同批重複資料夾不重算；Git 中文檔案用 UTF-8 位元組套上限；檔案樹先驗證拖放再清除狀態，恢復搬檔。
- PDF：舊的非同步預覽不蓋掉新內容；切去文字編輯器時仍完成隱藏預覽；連續縮放取消並等待上一輪繪圖，處理繪圖失敗。
- 系統監控：等待取樣器 READY，第一筆取樣與較慢的靜態查詢依序執行；處理舊程序輸出與 stdin 錯誤；GPU 停止會取消重啟，切換間隔確實生效。
- 使用時長：跨小時依秒數分配；月底換月不跳過二月；快速切換採最後一次結果；離頁清除輪詢與晚到回應。WebSocket 啟停依序完成，停止後不再重試啟動。
- 時長寫入：資料庫暫時鎖住時保留待寫紀錄，下次補寫，不再清掉尚未存下的秒數。此佇列只保留於本次執行，未涵蓋持續鎖檔後強制結束的跨重啟恢復。
- 測試工具：修正 CRLF 擷取問題；工作區與使用時長使用隱藏視窗；截圖改用 Electron capturePage(stayHidden/stayAwake)，只比對提示框附近並等待淡入完成。

驗證（記錄在 `dist/bug-audit/`）：

| 指令／檢查 | 實際結果 |
|---|---|
| `node scripts/test-*.js`（逐支執行全部 45 支） | 全部 exit 0；涵蓋 AGY、CC 代理、用量、字典、HF、ASR／翻譯、工作區、終端機、sysmon、IPC、更新及文字處理 |
| `node scripts/test-audit-boundaries.js --baseline` / 不帶 `--baseline` | HEAD 的 4 個案例失敗；修復後 4 個案例通過 |
| `node --check`（全部 171 支 src JS） | 171 通過；最後新增的時長修正另重驗兩支 |
| `electron.exe scripts/e2e-chat.js`（Start-Process 等待結束） | 140 passed, 0 failed；本機 mock SSE／隔離會話 |
| `electron.exe scripts/e2e-sysmon.js`（Start-Process 等待結束） | 修前 60/1（SYSMON_TIMEOUT）；修後 61/0，真 PowerShell 與程序清理 |
| `npm run electron:pack -- --config.directories.output=dist/bug-audit/pack` | exit 0；asar 的全部 171 支 JS 與來源逐位元一致，package 1.16.1 |
| `node scripts/e2e-workspace-cdp.js` | 最終打包版 167 passed, 0 failed，含 PDF 連續縮放、真實搬檔、Monaco、Git 與背景截圖 |
| `node scripts/e2e-terminal-cdp.js` | 46 passed, 0 failed |
| `node scripts/e2e-visual-cdp.js` | ALL PASS 71 visual checks（深／淺色、三種尺寸、九頁） |
| `node scripts/e2e-sysmon-cdp.js` | 112 passed, 0 failed |
| `node scripts/e2e-screentime-cdp.js` | 最終打包版 19 passed, 0 failed |
| `VOICEINK_EXE=dist/win-unpacked/VoiceInk.exe node scripts/e2e-visual-cdp.js` | 更新正式預覽後，71 項再次通過 |
| `git diff --check` | exit 0 |

CDP 均以 `VOICEINK_EXE=dist/bug-audit/pack/win-unpacked/VoiceInk.exe` 指定隔離建置；沒有桌面滑鼠或全域按鍵操作。最後確認原預覽已關閉，將通過驗收的檔案更新至 `dist/win-unpacked`，exe 與 asar 的 SHA-256 和驗證版本相同；正在執行的安裝版保留。

驗證範圍限制：未對各家外部供應商付費 API、真實語音輸入插入、大型 GPU 模型推論、提權風扇／超頻及 NSIS 安裝更新做本輪實測。未 commit、push 或發行；本輪測試通過不代表能保證所有可能輸入都沒有 bug。

> 只留「還沒做完的」與「最近幾輪做了什麼、驗到什麼」。更早的逐項紀錄查 git log。
> 規則見 [CLAUDE.md](../CLAUDE.md)（＝AGENTS.md），架構見 [CONTEXT.md](../CONTEXT.md)，教訓見 [lessons.md](./lessons.md)。

## 2026-09-08 — 大檔開關的效能與記憶體、終端機三件事

- [x] 量出基準線（`probe-workspace-bigfile.js`，打包版 1.4MB／4 萬行）
- [x] 關掉分頁後真的放手：`disposeModel` 先 `setModel(null)`、預覽的 iframe／影片收掉、
      影子 textarea 與 `previewKey.source` 清空、最後一個分頁關掉時連編輯器空殼一起 dispose
- [x] 選了專案就趁閒置先載 Monaco（第一個大檔不用等 16MB 的 AMD 包）
- [x] 貼上超過 8192 字不再被安靜截半（`term-write-chunks.js` ＋每階段一條寫入鏈）
- [x] 輸入法候選字視窗的根因：`.xterm-helpers` 的 `left: auto`（收回上一版的 `opacity: 1` 作法）
- [x] Ctrl+G 開出來的記事本抬到最前面（`terminal/foreground.js`）
- [x] 補回 v1.16.0 漏掉的第四份清單：`resolveLinks`／`revealLink` 沒進 `main.js` 的 service 白名單
- [x] Ctrl+G 抬視窗只驗到「PowerShell 起得來、C# 編得過、不會疊出第二支」；
      真的把記事本抬到前面會搶前景焦點，沒有在使用者用電腦時實測
      → 2026-09-09 補上 `probe-terminal-foreground.js`，並在那裡抓到根因（記事本重用視窗）

回顧（全部打包版實測，`VOICEINK_EXE=D:/vi-build-680e-4/win-unpacked/VoiceInk.exe`）：
`probe-workspace-bigfile.js` 12/12——開檔前 9.8MB → 開著大檔＋diff 66.9MB → 全關掉 21.2MB（掉了 45.7MB），
第二輪開關只多 0.8MB（沒有每開一次漏一份）；Monaco 已在時開 1.4MB 的檔 157ms，並排變更 826ms。
修之前（v1.16.1）：關掉後 iframe 還在跑，堆積回不去（21.5MB 沒放掉）。
`probe-terminal-ime.js` 10/10、`probe-workspace-perf.js` 18/18、`e2e-terminal-cdp.js` 47/47
（含新加的「貼上 9000 字」——讓 PowerShell 自己印出長度，只看畫面字數證明不了；
同一份測試在修復前的打包版上只有這一條紅，畫面停在 PowerShell 的續行提示）。
單元：`test-terminal.js` 63/0、`test-terminal-links.js` 71/0、`test-workspace.js` 225/0、
`test-workspace-ui.js` 93/0、`test-error-hygiene.js` 82/0、`test-ipc-invoke.js` 11/0、
`test-terminal-drop.js`／`test-terminal-ui.js`／`test-terminal-host.js`／`test-workspace-state.js` PASS。

## 2026-09-07 — v1.15.0 整合發行

- [x] 提交終端機修改，合併尚未整合的分支
- [x] 更新版本、排除工作樹打包、完成受影響測試
- [ ] 建置及驗證安裝檔，推送 master／tag 並發行三個更新檔

合併時保留主分支的預覽快取與選單圖示，同時保留分支的縮放功能；所有本機／遠端分支已納入 master。
已通過 terminal 60/0、terminal-ui 7/0、terminal-drop、updater、error-hygiene 82/0；
workspace／workspace-ui／state／nav／editor／perf 全部通過；感測器與熱鍵 sidecar 重建成功。

## 2026-09-07 — 終端機拖入檔案路徑

- [x] 沿用 preload 路徑取得及 xterm 貼上，支援圖片、多檔與空白路徑
- [x] 驗證拖放只貼一次、不送出指令
- [x] 更新免安裝打包並以背景 CDP 驗收

回顧：`node scripts/test-terminal-drop.js` PASS（PowerShell／cmd 引號、多檔、控制字元及長度上限）；
`test-terminal.js` 60/0、`test-terminal-ui.js` 7/0。
`npm run electron:pack -- --config.directories.output=C:/Users/rx595/AppData/Local/Temp/voiceink-drop-pack-verified-20260907` exit 0；
三支 main／preload／terminal 原始碼與 asar 逐位元一致，已更新 `dist/win-unpacked` 並核對 asar 雜湊。
`PROBE_DROP=1 PROBE_CLI=1 node scripts/probe-terminal-paste.js` 最終打包版 PASS：
以 CDP 拖入本機圖片與文字檔，完整路徑只收到一次，中文／空白／單引號完整，沒有 Enter，後續打字正常。
圖片以本機路徑交給 CLI；本輪未驗證各家 AI CLI 是否將它顯示為圖片附件。

## 2026-09-07 — 終端機右鍵重複貼上

- [x] 接續紀錄：已在 Claude Code 重現右鍵同時貼上及回報滑鼠事件，修正與打包完成
- [x] 核對打包內程式與現有修正一致；一般終端機右鍵只貼一次，後續鍵盤輸入正常
- [x] 驗證模擬 AI CLI 的 bracketed paste、選取文字與游標輸入框右鍵，記錄驗收結果

回顧：本輪 `node scripts/test-terminal.js` 60 passed／0 failed；`node scripts/test-terminal-ui.js` 7 passed／0 failed。
`node scripts/probe-terminal-paste.js` 三種打包版情境皆 PASS：一般 shell、
`PROBE_CLI=1 PROBE_BRACKETED=1 PROBE_ON_TEXTAREA=1`、
`PROBE_CLI=1 PROBE_BRACKETED=1 PROBE_SELECTED=1 PROBE_LONG=1`。
每次讀剪貼簿一次、貼上一次、沒有右鍵滑鼠回報，後續 `z` 輸入正常；模擬 CLI 實際 stdin 也只有一份貼上。
既有 `dist/win-unpacked/resources/app.asar` 內 `terminal-page.js` 與原始碼逐位元一致，沿用前輪打包產物。
前輪紀錄含真 Claude Code 的修復前失敗與修復後 PASS；本輪未重跑真 Claude／Codex，也未發行。

## 2026-09-07 — 大檔不卡頓、輸入法對位、選單圖示

- [x] 分頁列「＋」選單八個項目各一顆 16px 單色圖示（`ws-tool-icons.js`，零 innerHTML）
- [x] 終端機中文輸入法：`syncImeCaret` 在 `focus`／`compositionstart`／每次 `fitPane` 把 xterm
      那個隱形 `<textarea>` 挪到游標那一格；`.composition-view` 改成終端機反白
- [x] 終端機體驗：排隊輸出接成一段再寫、欄列數沒變就不送 resize、ResizeObserver 合併到下一幀
- [x] 大檔案／預覽變更：`showDiff` 每分頁快取兩顆 model、`showTab` 改用 `modelText` WeakMap 比對、
      Monaco 在時跳過行號欄與狀態列、預覽比內容字串本身決定重不重畫
- [x] 打字不再每個字搬一整份檔案（影子 textarea 改成停手 200ms 才同步）
- [x] 切專案 `disposeModelsExcept`：model 不再只增不減
- [x] 紅燈驗證、單元測試、打包版 CDP 實測

**回顧** — 這一輪的成本全在「每次都重做」，不是「做得慢」：

1. **`showDiff` 每次切回來重建兩顆 model**：Monaco 得把兩份檔案重新斷行、重算差異。
   紅燈：舊版三次呼叫建了 6 顆（新版 2 顆）。
2. **`showTab` 用 `getValue()` 比對**＝每次切分頁把整份檔案再複製一次。改用 `modelText` 這份 WeakMap。
3. **每敲一鍵做好幾趟 O(檔案大小)**：整份倒進影子 textarea、兩次全文比對、`updateGutter` 組全部行號、
   `updateIdeStatus` 兩次 `split('\n')` ＋一顆 `Blob`——而且後兩支在 Monaco 接手後根本沒人看。
4. **切專案沒收 model**：`tabs` 換掉了但 model 照分頁 id 存著，每切一次就多留一整份檔案內容。
   實測 3 顆 → 0 顆，來回三趟都是 0。
5. **輸入法候選字視窗**：xterm 把那個隱形 `<textarea>` 丟在 `left: -9999em`，只有游標移動才挪回來，
   所以剛切回終端機時系統看到的輸入框在畫面外，候選字視窗被夾到螢幕角落。

另外 `e2e-workspace-cdp` 的 [N] 亮紅：不是這一輪改壞的（HEAD 版 162/0），是那支測試在樹還沒畫到最新時
就動手（`renderTree` 中間要等一趟 `git status`，`rows >= 2` 在**舊的**那棵樹上就成立了）。效能一改快就露出來。
合併時發現 master 的 d569448 已經修掉同一件事的根因——`toggleDir` 原本照模組狀態 `expanded` 判斷，
改成看那一列現在畫成什麼樣（`aria-expanded`）——那條比只改測試好，合併時採 master 那一版。

自己踩到一次：把存檔後的 `tab.content = text.value` 改成 `= content`（想省一次全文複製），
結果把「等 main 寫檔期間又打的字」吃掉——`test-workspace-state.js` 的「存檔守衛」當場紅燈。
改成存完再讀一次現在的內容（`monaco ? currentValue() : text.value`）。

驗證：`test-workspace` 225/0、`-ui` 92/0、`-state`／`-nav`／`-editor` PASS、
**`test-workspace-perf` 10/0**（新增）、`test-terminal` 60/0、**`test-terminal-ui` 7/0**（新增）、
`test-markdown` 23/0、`test-error-hygiene` 82/0；`npm run electron:pack` exit 0；
打包版 **`probe-workspace-perf.js` 18/18**（新增：1.4MB／4 萬行的檔，編輯器⇄diff 來回 5 趟
`createModel` 一顆都沒多建；輸入法輸入框量得到在游標那一格；切專案 model 3 → 0）、
`e2e-terminal-cdp` 46/0、`e2e-workspace-cdp` 162/0、`e2e-cdp-smoke` 22/22、`e2e-visual-cdp`。

**沒做**：`@xterm/addon-webgl`（對 xterm 6.0 只有 beta，拿整個終端機賭一顆 beta renderer 不值得）；
`updateGutter` 在退回 `<textarea>` 的那條路上仍是 O(行數)，只是不再每個字重組。

## 2026-09-07 — 長文翻譯修復

- [x] 重現雲端分段、20 秒逾時與輸出截斷
- [x] 雲端整篇送出（IPC 上限 20 萬字），本地保留 280／600 字分段；雲端長文等待 10 分鐘、live 保留 20 秒
- [x] 移除雲端的本地模型鎖；共用既有 reader 限制回應 4MB；body 逾時、空譯文與輸出截斷回固定錯誤
- [x] 回歸測試、打包與背景實測

**回顧**：`node scripts/test-translate-long.js` PASS（先驗到分段、卸載阻塞、過大回應紅燈再修）；
`test-error-hygiene.js` 82/0、`test-model-scope.js` 31/0、`test-strip-prompt-leak.js` ALL PASS。
`npm run electron:pack` exit 0；`node scripts/probe-translate-long.js` 最終打包版真流量：
12,554 字、35 段核對標記完整、3,957 字中文譯文、9 秒完成。使用隔離 userData，未修改正在使用的安裝版。
模型仍有各自的上下文／輸出容量上限；本次未重跑本地 GPU 推論，保留既有本地切段與解碼策略。

## 2026-09-07 — 終端機換行與字級

- [x] Shift+Enter 傳送獨立按鍵訊號，Enter 保持送出；字級 13 → 17
- [x] 先驗回歸紅燈，再修正、打包及背景 CDP 驗證

回顧：`node scripts/test-terminal.js` 60 passed／0 failed；`node scripts/e2e-terminal-cdp.js` 42 passed／0 failed。
修復前確認 Shift+Enter 送出 CR、字級 13；修復後只送一次 CSI u、Enter 保持 CR、字級 17，三種視窗寬度無溢出。
`npm run electron:pack` exit 0，asar 內終端機程式與原始碼逐位元一致；各家 AI CLI 的輸入畫面未逐一驗證。
首次打包因舊版回歸程序仍占用 DLL 失敗，收尾後將失敗產物移至 `dist/pack-failed-shift-enter` 再重建成功。

## 2026-09-07 — 終端機切換閃爍與最新訊息

- [x] 保留跨專案的 xterm 畫面，避免先清空再重建，防止慢回應切回舊分頁
- [x] 切換終端機／回到工作區時捲到底部
- [x] 先驗回歸紅燈，完成狀態測試、打包及背景 CDP 驗證

回顧：`node scripts/e2e-terminal-cdp.js` 舊版 43 passed／3 failed，新版 46 passed／0 failed；
確認跨專案保留同一個 DOM 與 xterm 實例、回到終端機的捲動位置等於輸出底部，背景狀態與三種視窗寬度正常。
`node scripts/test-terminal.js` 60／0、`test-workspace-ui.js` 79／0、`test-workspace-state.js`、`test-workspace-nav.js`、`test-workspace-editor.js` PASS。
`npm run electron:pack` exit 0；asar 內兩支修改的 renderer 與原始碼逐位元一致。

## 2026-09-07 — 終端機跨 App 重啟持續運行

- [x] 獨立背景 runtime 放在 `<userData>/terminal-host/runtime-<內容雜湊>/`，安裝檔案被替換仍繼續運行
- [x] 共用既有 PTY／管理員宿主，加入具名管道認證連線、重新接回與輸出保留
- [x] App 關閉只斷開連線，明確關閉終端機才結束程序；重開自動還原分頁
- [x] 紅燈回歸、一般／管理員宿主、重啟及更新路徑實測；打包、背景 UI 驗證與文件交接

**回顧** — 三個只有打包版／別的 shell 才抓得到的問題：

1. **`fs.cpSync` 讀不了 asar**（`copyFileSync` 可以）：宿主複製 node-pty 時留下半套 `node_modules`，
   從源碼跑的 `test-terminal-host.js` 全綠，打包版卻靜靜地開不起終端機（證據是 staging 目錄裡
   `node_modules/@lydell` 是空的）→ `asarUnpack` 的 `@lydell/node-pty-*` 改成 `node-pty*`
   （少一個字元就漏掉 JS 那份），路徑一律過 `unpacked()`。
2. **裸名 `whoami.exe`／`icacls.exe` 會抓到 Git Bash 的 MSYS 版**（libuv 的搜尋順序只看 PATH，
   不含 System32）：同一支測試在 PowerShell 綠、Git Bash 紅 → 一律指名 `%SystemRoot%\System32`。
   紅燈驗法是把 `PATH` 清空跑 `connection(dir, true)`。
3. **CDP 點側欄按鈕會被吞掉**：模組還沒掛上監聽時點下去，清單就永遠不重畫 → 改成「點到列出來為止」。

另外補了兩件會長大的事：舊版執行環境（一份 248MB）在下次 `stageRuntime` 清掉；
staging 建到一半失敗整個刪掉。

驗證：`test-terminal-host.js` 8/8、`test-terminal.js` 60/0、`e2e-terminal.js` 27/0（`npx electron`）、
`e2e-terminal-cdp.js` 46/0、`probe-terminal-admin.js` 6/0、
**`probe-terminal-restart.js` 打包版 5/5**（真的關掉 App → 覆寫 `VoiceInk.exe`／`app.asar`／PTY 原生檔
→ 重開；shell PID 不變、關閉期間磁碟心跳持續、分頁與輸出自動還原、只有明確刪除才結束程序）。
`test-error-hygiene` 82/0、`test-ipc-invoke` 11/0、`test-workspace` 219/0、`-ui` 79/0、`-state`／`-nav` PASS。
`npm run electron:pack` exit 0。
**沒做**：宿主的自動更新（改了 host 檔就換一份執行環境，舊宿主要等使用者關掉那些終端機才會退場）；
舊版 App 已經開著的終端機無法搬進宿主。

## 待辦




從 2026-09-05 的「最近更改修復與整體驗收」留下來的；前四項在第九～十二輪已大致涵蓋，
但沒有逐項對照驗收過，保留在這裡當清單。

- [ ] 對照 Orca 檢查專案工作區的開檔、切換、草稿與 Git（第九～十二輪已重寫大部分）
- [ ] 感測器自動啟動、隱藏視窗與重連，驗證風扇安全交還
- [ ] 獨立對帳真實用量來源（`probe-code-usage-audit.js` 已對過 Claude 與 Grok，其餘三家未逐輪核銷）
- [ ] 全庫回歸與安全審查，修復 UI 錯誤並簡化操作與文案
- [ ] 每輪收尾：`build:sensors` ＋ `electron:pack` ＋ 打包版背景 CDP 驗證
- [ ] 每輪收尾：同步文件，記錄實際驗證結果與限制

---

## 2026-09-07 — 沙箱測試與文件精簡

- [x] `scripts/dev-sandbox.js` ＋ `npm run dev:sandbox`：另一份 userData、模型 junction 接回、
      設定與專案清單複製、三個會外溢的開關強制關掉、寫入前先 `rm` 目的地
- [x] `scripts/probe-dev-sandbox.js` 實測：安裝版跑著時沙箱起得來、讀得到供應商／模型／專案，
      真 userData 指紋前後不變
- [x] `ws-git-status.js`：`git status` in-flight 去重 ＋ 500ms 短快取，切分頁不再重打
- [x] 聊天側欄拿掉多餘的「只看這個專案」按鈕
- [x] CLAUDE.md 與 AGENTS.md 合併成同一份（1372 → 289 行），CONTEXT.md、lessons.md、todo.md 一併精簡
- [x] 測試 fixture 的機器名／MAC／內網 IP／序號改成佔位值，文件裡的本機絕對路徑改成示意路徑

**回顧**：`probe-dev-sandbox.js` 8/8（含「全程沒有動到你正在用的那份 userData」）；
`test-workspace-ui` 79、`test-workspace` 219、`test-sysmon` 176、`test-error-hygiene` 82、
`test-ipc-invoke` 11、`-nav`／`-state` PASS。
寫沙箱腳本時自己踩到一次：`copyFileSync` 會跟著符號連結寫到對面去，
沙箱裡若有一條指回真 userData 的連結，這支「保護資料」的腳本就會親手覆寫使用者的設定 →
每次寫入前先 `rm` 目的地，並用「故意種一條連結」的紅燈驗過。

## 2026-09-07 — 工作區變更入口、檔案樹狀態、尋找列 tooltip

- [x] 檔案樹重畫時沿用 `gitStatus`，檔案標「改／新／衝突」、資料夾標 `改 N`，點標記開既有 Diff
- [x] 編輯器工具列「看未提交變更」（沿用 `openDiffTab`，依暫存／工作區選比較面）
- [x] `is-workspace` 緊湊佈局；切回聊天時收起右側欄與拖曳把手
- [x] 尋找列 tooltip 的 `.context-view` 被 `fixedOverflowWidgets` 放到 host 外 →
      用 `body:has(.find-widget.visible)` 限定範圍讓外層穿透滑鼠

**回顧**：先讓新增契約失敗（`test-workspace-ui` 68 passed／5 failed）再修，完成後 73／0。
驗證 `test-workspace` 219、`-state`／`-nav`／`-editor` PASS、`e2e-workspace-cdp` 162/162、`electron:pack` 成功。

## 2026-09-06 — 第十二輪：專案真的管住工作內容 ＋ 日常開發流程

- [x] 對話與終端機的專案歸屬（`chats.json`／`terminals.json` 各多一個**可選** `projectId`，缺值＝未分類）
- [x] AI 記錄可閱讀可接續：工具細節收合、標出來源與截斷、讀過／改過分開；接續由 main 驗專案歸屬
- [x] 修正記錄來源：`CODEX_HOME`／`CLAUDE_CONFIG_DIR`／別的工作台的 runtime home 三處都掃、照 `agent + id` 去重
- [x] 選取內容帶入聊天（`chat:insert`）；`workspace/watch.js` 自動更新畫面
- [x] worktree 補齊（`adopt`／建立後直接切過去／移除前 `check` 講得出哪幾個檔案擋著）
- [x] Git 審閱流程（merge-base 比較、上一個／下一個變更、衝突自成一組、逐行意見「交給 AI」）
- [x] 拆檔：`ws-ai-session.js`、`ws-review.js`

**回顧** — 三件「不做會出事」的：
1. **`main.js` 的 service 白名單是第三份清單**：`ipc.js`／`index.js`／preload 都對、單元測試全綠，
   `main.js` 漏一行就只回「工作區操作失敗」（這一輪的 `gitBranches` 中過）→ 補 [Q2] 把三份清單對起來。
2. **`CODEX_HOME` 真的被別的工作台改掉了**：`~/.codex/sessions` 底下一筆都沒有，
   AI 記錄列不出 Codex 對話「不是解析壞了，是根本沒去那裡找」。
3. **非 git 專案要把每一塊都清乾淨**：`renderGit` 的提早 return 留著上一個專案的分支下拉，
   按「比較」得到「這兩條分支沒有共同的起點」，看起來像 git 壞了。

紅燈驗證：`codexHomes` 改回只看 `~/.codex` → [W] 三條失敗；刪掉 `main.js` 的 `gitBranches` → [Q2] 失敗並指名；
`EDIT_TOOLS` 改成 `/.*/` → 「Read 只算讀過」失敗。三條都還原成綠。
驗證：`test-workspace` 214、`test-workspace-ui` 64、`e2e-workspace-cdp` 131、`e2e-cdp-smoke` 22、
`e2e-chat-cdp` 44、`e2e-terminal-cdp` 34、`e2e-visual-cdp` 71、`e2e-tray-cdp` 12、`e2e-ux-tweaks-cdp` 18。

## 2026-09-06 — 第十一輪：工作區的資料安全與專案切換

- [x] `resolveIn` 加 realpath 檢查（資料夾連結指到專案外一律拒絕，專案根自己是連結照樣可用）
- [x] 存檔比對磁碟版本（`expectedMtimeMs` → `STALE`，提示條四條路，草稿一個字都不能動）
- [x] 同一檔案的寫入排隊（暫存檔名帶 pid＋流水號，避開 Windows 併發 rename 的 EPERM）
- [x] 開分頁的每一次 await 之後核對 `projectSwitch`，回來再 `findTab` 一次
- [x] 改名／搬檔後 `retargetTabs`；結束時的草稿由 main 等（`workspace:flushDrafts` 排在 `killAll()` 之前）

## 2026-09-06 — 第九、十輪：Monaco、worktree、拖曳搬檔、多選、分頁跟著專案走

- [x] 編輯器換 Monaco（AMD `min/vs`、語法高亮、真正的並排 diff、尋找取代；載不起來退回 `<textarea>`）
- [x] Git 面板加 worktree 一區；檔案樹 Ctrl／Shift 多選與拖曳搬檔
- [x] 分頁列橫向溢出＋pointer 跟手＋FLIP 讓位；中鍵關閉、右鍵「關閉其他／右邊」
- [x] 側欄只列專案（終端機清單移除），終端機變成分頁列上的一顆分頁（關掉＝刪掉工作階段，要二次確認）
- [x] 分頁狀態跟著專案走（存 `workspaces.json` 的 `tabsState`），切專案只摘畫面、pty 留在 main

**回顧**：Monaco 三件事要一起做才不會「看起來壞掉但不報錯」——CSP 的 `font-src data:`（codicon）、
`worker-src blob:`（沒有 Worker 時 diff 算不出來）、`build.files` 只放行 `min/**`（asar 437 → 460MB）。
`<textarea>` 仍是存檔／草稿／外部變更偵測的來源，兩邊要雙向同步。

---

## 更早的輪次（各一句，逐項紀錄查 git log）

| 時間 | 內容 |
|---|---|
| 2026-09-05 第七輪 | 工作區適配 Orca 核心：分頁持久化、外部變更偵測、IDE 尋找取代、AI 會話卡片、拖曳遮罩修復 |
| 2026-09-04 第六輪 | 用量統計徹查：Codex 子代理重播雪崩（60 份 fork 重播出 7.8 萬筆假請求）與 Grok 花費灌水 10 倍 |
| 2026-09-04 第五輪 | 專案側欄整合、簡易 IDE、Git Diff 與多格式預覽（借 Orca） |
| 2026-09-04 | 使用時長（Tai 相容）、效能調整（第五、六子分頁）＋即時儀表、App 內自動更新、使用者回饋六點整頓 |
| 2026-09-03 | 發行 v1.10.0；八組模組 IPC 收成共用外殼；管理員終端機；CC 代理 1M 上下文＋修好 Codex 502；額度卡片依可見數排版 |
| 2026-09-02 | 新增 HF模型分頁（llama-server router）；系統監控風扇控制；額度新增 Command Code；用量統計拆 token；硬體規格 60 → 118 條 |
| 2026-09-01 | 語音輸入字典真的生效＋長篇重寫；壓力測試真的壓得滿（GPU 3% → 94–100%、記憶體 7.75 → 35GB）；供應商可切回官方訂閱；合頁後的回歸收尾 |
| 2026-08-31 | 系統監控改版（總覽⊕硬體資訊、四項壓力測試）；ccswitch 供應商頁重構；語音輸入 HUD ＋雲端 ASR 修復；三個子分頁各自的模型選單 |
| 2026-08-30 | 新分頁「系統監控」；語音輸入（復刻並超越 Typeless）；整合 cc-switch；v1.9.0 發行 |
| 2026-08-29 | UI／Design Token 全面打磨（Aurora 雙色主題、字體層級、12px 圓角、WCAG AA）；`custom-select.js` 共用下拉 |

## 2026-09-07 — 專案與分頁運行狀態
- [x] 查終端機狀態流，沿用 main 判定並區分靜默與完成
- [x] 專案側欄列名稱與狀態，分頁補文字且就地更新
- [x] 回歸驗證與免安裝打包

回顧：`node scripts/test-terminal.js` 60 passed／0 failed；`node scripts/test-workspace-ui.js` 79 passed／0 failed。
`node scripts/e2e-terminal-cdp.js` 舊版 34 passed／2 failed，新版擴充跨專案與靜默檢查後 40 passed／0 failed；背景截圖確認側欄與分頁文字可見。
`npm run electron:pack -- --config.directories.output=C:/Users/rx595/AppData/Local/Temp/voiceink-status-pack-20260907` 成功；更新至 `dist/win-unpacked`，exe／asar 雜湊一致。只顯示本 App 終端機狀態；靜默顯示「暫無輸出」，不當成任務完成。
