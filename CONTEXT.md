# CONTEXT.md — 交接文件

> 只寫「現在長什麼樣」與「最近改了什麼」。規則與地雷見 [AGENTS.md](./AGENTS.md)；[CLAUDE.md](./CLAUDE.md) 僅作相容入口，
> 可遷移的判斷原則見 [tasks/lessons.md](./tasks/lessons.md)，歷史細節查 git log。

## 專案概況

VoiceInk：Windows Electron AI 工作台。Vanilla JS + Vite（無前端框架），Electron 43.4.1 ＋ Node.js 22。
目前版本 **v1.31.0**（最重的幾段改 Rust：終端機宿主 `voiceink-term.exe`、用量掃描、資料夾大小、語音輸入熱鍵；常駐 sidecar 不再掛 conhost；前版 v1.30.0 主程序同步 I/O 改非同步＋逾時修「沒有回應」、全專案 UX 稽核、檔案頁排序／範圍切換／欄寬、終端機快捷鍵；再前 v1.29.0 語音轉文字頁多了錄音機、即時字幕留逐字稿紀錄；再前 v1.28.1 Telegram 切回來不再卡；再前 v1.25.0：檔案總管雙欄右欄變成真的能用、操作中心收進狀態列且同名時可覆蓋、
資料夾監看不再漏事件；前版終端機 PATH 不再被 Ctrl+G 橋接蓋掉；再前檢查更新改走鏡像）。

nav 十頁：聊天（預設，**專案工作區與終端機都在同一頁**）｜Telegram（官方網頁版 `web.telegram.org/a` 放進 `<webview>`，可並排多開最多 4 格（沒存過開 2 格；每格卡 600px，Web A 一律手機版版面）、共用 `persist:telegram`，每格頂端細列 ✕ 關／最右格 ＋ 再開，每格停的聊天室存 store `telegramPanes`（不用 localStorage：結束走 `app.exit()` 會掉最後幾秒的寫入）；`telegram-page.js`，第一次點才建）｜檔案｜CC代理（`data-page` 仍是 `ccswitch`）｜
AGY反代｜語音轉文字｜翻譯與 TTS｜系統監控｜HF模型｜設定。額度不再是一頁：收成工作區主區最下面那條，用量統計在 CC代理。

## 架構

### 「沒有回應」、全專案 UX 稽核、檔案頁排序與範圍（2026-09-24，v1.30.0）

- **卡死**：事件記錄 30 天 22 次 AppHang（主程序 UI 執行緒被擋住，沒有堆疊）。找得到的同步阻塞全改成非同步＋逾時：
  `explorer/drives.js`（`isDirSoon`、`listPlaces`／`listDrives` 並行探測 1.5 秒逾時；使用者的「下載」在 NAS 上）、`explorer/index.js` bootstrap、
  `explorer/recycle.js`（SID 資料夾、whoami、丟回收筒 PowerShell）、`terminal/links.js`（`statSoon` 800ms；**UNC 預設不查**，
  Claude Code 輸出的 JSON 轉義 `\\Users` 會被當網路路徑）、`codeusage/scan.js`、`workspace/agents.js`、`stt-archive.readRecording`、`hfmodels/library.importFile`。
  VoiceInkSensors.exe 的「Pipe is broken」是主程式死掉後的連帶結果，不是起因。
- **檔案頁**：左欄也有 `#exScopeBtn`（`searchMode` 'global'｜'filter'，分頁各自記、存進 `explorer.json`）；`#exSort`／`#exSortDir` 工具列排序，
  搜尋中選項換成 相關度／路徑／時間／大小／類型（`sortHitList`，hit 帶 `rank`）；排序鍵多了 `type`（副檔名，沒有的排前面，main `fs.js` `sortEntries` 與 renderer 共用 `BROWSE_SORT_KEYS`）。
  「大小」「修改」欄寬是 `--ex-col-size`／`--ex-col-date`（`initResizer` 以欄標題當 panel、`invert`）；欄標題與清單都 `scrollbar-gutter: stable` 才對得齊。
  收起的欄位把手用 `:has(+ …[hidden])` 一起藏。
- **終端機**：打包版 `.xterm-viewport` 的原生捲軸跟 xterm 自畫的疊成兩條 → `scrollbar-width: none`；Ctrl+Shift+T／W、終端機內 Ctrl+Tab（`terminal-page.js` 放行、`workspace-page.js` 處理）。
- **語音**：即時字幕兩欄 grid（<860px 疊起）；檔案轉錄 `#recordingPickList` 列最近 4 段；錄音中 `.nav-tab.is-recording`。
- **風扇**：`sysmon-fans.js` 改斜投影（側透視角，`AX`／`ORIGIN`／`BOX`），16 個位置投影後互不重疊。**系統監控總覽**：`openSubs`（`voiceink.sysmon.openSubs`）記細項展開。
- **UX 稽核**：十區逐條查證後修（更新手動下載、設定頁草稿與確認、CC代理錯誤就地顯示、聊天 Enter 不砍回覆、工作區 worktree 取消、多處 IME Enter、HF／AGY 下載取消與錯誤、系統監控 BIOS 還原／風扇編輯器／使用時長），清單見 `tasks/todo.md`。
- 測試：4 支長期紅的單元測試都是測試過時，已跟上（`test-app-dialog-ime` 改測 `openDialog` 的 capture Enter；`test-usage-state-race` 比 `sanitizeSettings` 後的值）。

### 終端機滾輪在 Claude Code 全螢幕會翻提示詞歷史（2026-09-23）

- **根因**：`term-mouse.js` 擋掉 CLI 的滑鼠回報（為了能選字）之後，xterm 在備用畫面把滾輪換成 ↑↓ 鍵；
  使用者的 Claude Code 設 `"tui": "fullscreen"`，整個工作階段都在備用畫面。改成記住 CLI 要滑鼠＋SGR，
  備用畫面時滾輪自己包成 SGR 滾輪事件送出；一般畫面照舊捲 scrollback。順手修 Ctrl+滾輪放大字級時偷送方向鍵。
- **`windowsPty`**：xterm 補上 `{ backend: 'conpty', buildNumber }`（組建號由 `service.js` 的 `catalog` 給，
  不放 `pty.js` 免得宿主被判成舊版）。終端機拉高時 xterm 不再把 scrollback 拉回畫面、跟 ConPTY 對不上。
- 測試：`probe-terminal-mouse.js` 13 條（新增 5 條滾輪，修之前 3 紅）。

### 錄音機與即時字幕紀錄（2026-09-23）

- 語音轉文字頁多一個「錄音機」子分頁（檔案轉錄｜錄音機｜即時字幕｜語音輸入）：`recorder.js` 用 MediaRecorder（opus 64kbps）每秒一塊送 `sttArchive:appendRecording`，可播放／刪除／開資料夾；「轉錄」直接切到檔案轉錄並帶入檔案。檔案轉錄也多了「或選一段錄音」下拉，並收 `.webm`（main 的 ffmpeg 解得開）。
- 即時字幕每次 upsert 都 append 一行到 `live-transcripts/live-<開始時間>.jsonl`；子分頁下方「字幕紀錄」列每一場（`live-history.js`），可查看／複製／下載 txt／刪除。
- main 端全在 `src/main/stt-archive.js`（含 IPC）；錄音上限 200MB＝檔案轉錄上限。


### Telegram 切回來不再卡（2026-09-23）

- **根因**：切走時 `.page` 是 `display:none`，webview 被當成藏起來、圖塊全丟；切回來 GPU 主執行緒要把
  每一格重畫（3 格各約 14 塊），主視窗那一幀跟著等，實測卡 300–945ms（trace 看得到 `RendererRasterWorker`
  塞滿 CrGpuMain，主畫面與 Telegram 自己都沒有長任務）。`visibility:hidden` 一樣會丟圖塊，沒用。
- **修法**：`#page-telegram:not(.active)` 改成原尺寸 `position:absolute` 疊在 `.main-content` 底下、`opacity:0`、
  點不到；非作用頁一律 `inert`（擋 Tab 摸進透明的 webview）。切回來 19–29ms，藏著時 CPU 沒有變多
  （Chromium 不畫透明層），GPU 多留約 50MB 圖塊。
- **`e2e-visual-cdp.js` 拿掉 560px**：主視窗 `minWidth` 900 到不了；而且視窗 `--hidden` 時用 Emulation 縮寬，
  有 `-webkit-app-region` 的標題列元素不重算樣式，量到的溢出是假的（視窗顯示中量就正常）。
- **不是 Bug 的 CPU**：語音輸入開著時麥克風常駐（`dictation.js` 的刻意取捨），音訊服務一直吃約 7% 單核。

### 導覽列換真圖示、可拖曳排序；Telegram 一律手機版（2026-09-23）

- **導覽列圖示**：emoji 全換成 SVG（`ws-tool-icons.js` 的 `toolIcon`）。Telegram／Hugging Face 用 simple-icons 原廠輪廓，
  CC代理／AGY反代沿用既有的 `claude`／`agy`，其餘是 lucide 24×24 描邊。`index.html` 只放 `data-icon`，`initNavigation()` 塞 SVG。
- **導覽列拖曳排序**：沿用 `list-reorder.js`（`axis: 'x'`，Alt+←→ 也能搬），順序存 localStorage `navOrder`；
  放開那一下的 click 用 `navSuppressClickUntil` 擋掉，不會順便切頁。
- **Telegram 手機版**：Web A 寬度 ≤ 600px 才切手機版版面，`.telegram-pane` 加 `max-width: 600px`、整排置中；
  沒存過格子時預設開兩格。

### 額度詳情精簡、Claude 不再 429、Codex 重置直接用；工作區搜尋改放大鏡（2026-09-23）

- **額度詳情卡精簡**：名字＋方案一行，一個視窗一行（名稱｜量表｜%｜倒數），可信度／來源／「已從某某 API 讀取」都拿掉，只有在顯示舊資料時才留一行小字。
- **Claude 一直 HTTP 429 的根因**：額度 API 看 User-Agent 限流，Node 預設的 `node` 會一直被擋，`claude-code/…` 不會。改報 CLI 的 UA；`fetchJson` 對 429 不再重試、並冷卻那個端點（以前每分鐘同步×3 次重試，把限流越拉越長）。
- **Codex 重置次數**：詳情卡顯示還有幾次、每一次的到期日，旁邊「使用」（先確認）→ main 走官方 `codex app-server` 兌換（`usage/codex-reset.js`）→ 再同步一次。Claude、Grok 查不到同類 API。
- **Grok 方案**：token 的 `tier: 1` 顯示成 SuperGrok（以前是 Tier 1）。
- **工作區右欄**：拿掉「檔案／搜尋」兩顆切換，標題列資料夾圖示旁多一顆放大鏡，按一下換搜尋、再按回檔案樹。

### 額度收成終端機下面那條、Claude 自己續期、終端機複製與連結（2026-09-23）

- **額度頁拿掉了**：`#page-usage` 與 nav 那顆刪掉，訂閱額度改成 `#termMain` 最下面一條 26px 的
  `#quotaBar`（`quota-bar.js`，原本的 `usage-page.js` 改名改寫）。一家一顆：小圓點（provider 色）＋名字＋
  每個視窗一支小量表（`5h ▬ 37% 1時30分`），點一下用 popover 開原本那張完整卡片；拖曳或 Alt+←→ 排序
  （沿用 `list-reorder.js`，拖完那一下 click 不開詳情）；條很窄時直向滾輪拿來左右捲，右緣會淡出。
- **顯示設定多一組「每一家顯示」**：5 小時／每週／每月視窗、重置倒數、方案名稱、精簡（只留用得最多那條）、
  隱藏未連線、上次同步時間。存在 `usage.json` 的 `settings.bar`，main 的 `store.sanitizeBar` 逐欄驗。
  **彈窗是照 renderer 手上那份狀態填的**：測試直接打 IPC 改設定，下一次按「儲存」就被蓋回去。
- **自動同步**：條看得到（在工作區、視窗沒被藏）時，快取超過 60 秒就同步；進工作區、視窗切回來都會補一次。
  以前只有按鈕。一輪七家約 3 秒，main 那邊本來就會合併同時的請求。
- **「額度跑掉、要去終端機開一次 claude」的根因**：Claude 的 access token 只活幾個小時，只有 CLI 在跑才會續。
  新增 `usage/claude-auth.js`：快過期（或還沒到期卻 401）就照 Claude Code 自己的協定續——兩把鎖、鎖內重讀、
  CAS 寫回、原子替換（細節見 AGENTS.md「用量統計與額度」）。協定是從已安裝的 CLI（2.1.280）讀出來的，
  `probe-claude-refresh.js --force` 實測過：新 token 8 小時、額度 API 通、`claude auth status` 仍是登入。
- **用量統計搬到 CC代理**：`#cc-stats` 子分頁，`code-usage-page.js` 原封不動（id 都沒改），點進去才 dynamic import。
  單價新增 Claude Opus 5.5（$4／$20、讀 $0.20）、GPT-6 Sol（$2／$10）、GPT-6 Luna（$0.10／$0.50）。
- **終端機的 OSC 8 連結**：以前點 Claude Code 印的網址會跳系統原生的 confirm（xterm 預設的 linkHandler），
  按了也開不起來（`window.open` 被 main 擋）。現在 `linkHandler: oscLinkHandler(id)` 直接開內建瀏覽器分頁。
- **終端機複製**（`term-copy.js`）：有選取的 Ctrl+C＝複製（沒選取才中斷）、Ctrl+Shift+C／Ctrl+Insert、
  右鍵有選取＝複製；剪貼簿改走 main（`terminal:clipboardWrite`）。實測一般 PowerShell 裡拖曳選取本來就選得起來，
  壞的是這幾條「選完怎麼複製」的路（舊版右鍵會把剛選的字貼回提示字元、Ctrl+C 直接變中斷）。
- 測試：`test-claude-auth.js`（7 條，修之前 [F][F2] 紅）、`e2e-terminal-copy-cdp.js`（12 條，對安裝版 v1.25.0
  跑 8 紅）、`e2e-usage-cdp.js` 改寫成額度條＋CC 用量統計（23 條）；nav 清單改九頁的有 smoke／terminal／
  visual／agy／chat 五支。

### 檔案總管：操作中心收進狀態列、同名可覆蓋（2026-09-22）

- **操作中心不再浮在右下角**：改掛在最下面那條狀態列（`#exStatus`，「搜尋就緒」左邊），
  平常只是一顆鈕，字就是現況：閒著寫「檔案操作」、跑的時候寫「複製中 42%」、
  收尾寫「複製完成」；面板改成往上開（`bottom: calc(100% + 8px)`）。
  **開始操作不再自動彈面板**（以前一開始就把面板打開，擋在清單右下角），
  只有收在 `failed`／`partial` 才自己跳出來。卡片也精簡了：跑完就不再留那行位元組數。
- **同名時多了「覆蓋」**：`operations.js` 的 collision 從 `rename`／`skip` 變三種，
  `fs.js` 收斂成一支 `resolveCollision()`（copy/move 共用）。覆蓋是**先把目的地那份
  丟進資源回收筒**再放新的（丟不進去才真的刪，NAS／非 NTFS 沒有回收筒），
  救得回來；複製到同一個資料夾時覆蓋等於刪掉來源，一律退回保留兩份。
- **切資料夾會被監看事件彈回去**：切換還在飛的時候 `cwd` 還停在舊資料夾，
  `onChanged` 拿舊 `cwd` 重讀 → 後完成的那個蓋掉切換，畫面就彈回原本的資料夾
  （`e2e-explorer-cdp.js` 的 [C9] 偶發變紅是這個，不是拖放壞了）。改成比對
  `navTarget`（最後一次「要去」的資料夾）。
- 測試：`test-explorer-operations.js`（覆蓋後留下新的那份、舊的進回收筒）、
  `test-explorer-operations-ui.js`（長在狀態列、三種同名處理）、
  `test-explorer-browse-wiring.js`（`navTarget` 守衛）、
  `e2e-explorer-files-plan-cdp.js` 的 [1]。

### 檔案總管：監看事件會掉、框選被重畫洗掉（2026-09-22）

- **重掛 watcher 會吃掉改動**：UI 每重讀一次目錄就再呼叫一次 `watchDirs()`，
  `explorer/watch.js` 以前是「先全部 `stop()` 再重開」——重開之間的改動沒人看，
  連還在 debounce（250ms）沒送出的事件也被 `clearTimeout` 吃掉，那個檔案就再也不會
  出現在畫面上，只能手動 F5。改成同一個資料夾沿用既有 watcher（只換 `send`），
  這次清單裡沒有的才關掉。`e2e-explorer-cdp.js` 的 [C8]／[F] 偶發變紅就是這個。
- **框選期間不重畫清單**：`paintList()` 的 `replaceChildren()` 會把框（`.ex-marquee`）
  連同反白一起洗掉，監看事件晚一步送到就會踩到（症狀：三列都反白但框不見了）。
  `paintList()` 遇到框選中改成記一筆就回，放開滑鼠再補畫。
- 測試：`test-explorer-watch.js`（重新 arm 不掉事件、舊資料夾要關掉）、
  `e2e-explorer-cdp.js` 的 [C6]／[C8]／[F]（連跑三次全綠）。

### 檔案總管：欄寬可拖與分頁列（2026-09-21）

- **三條把手**：`#exSidebarResizer`／`#exSecondResizer`／`#exDetailResizer`，共用
  `pane-resize.js` 的 `initResizer()`（本來長在 `app.js` 裡面只給聊天側欄用，這次抽出來）。
  寬度寫進 `--ex-sidebar-w`／`--ex-second-w`／`--ex-detail-w` 並記進 localStorage。
  詳情欄原本用 CSS `resize: horizontal`（把手只在右下角、也存不住），換掉了。
- **坑**：`.ex-resizer` 一定要 `position: relative`。`margin-inline: -3px` 讓左右欄疊上來，
  沒有 position 的話 `z-index` 不生效，把手整條點不到。
- **坑**：右欄改吃固定寬（`flex: 0 0 var(--ex-second-w)`），剩下的才給左欄。兩邊都 `flex: 1`
  的話把手一拖兩欄會互相推。窄視窗（≤640px）時改回 `flex: 1 1 0`，不然左欄會被擠沒。
- **坑**：操作中心那塊浮動面板蓋在右下角，詳情欄把手中段會被它擋住（`elementFromPoint`
  回傳 `.ex-ops-actions`）。使用者往上半段抓就好；測試也要抓 `rect.top + 40`。
- **分頁列**：整條變矮變窄（padding 8→3、分頁 180px→`flex: 0 1 148px` 最小 96px、
  字 13→12px、關閉鈕 28→20px），分頁多了會一起縮，縮到底才橫向捲。
- **分頁可左右拖排序**：沿用側欄那支 `createListReorder`，多一個 `axis: "x"`（鍵盤從
  Alt+↑↓ 換成 Alt+←→）。拖完由 `reorderTabs()` 照 DOM 順序原地 `splice` 重排——
  `tabs`／`secondTabs` 到處都有人拿著參考，換成新陣列的話那些地方會看到舊的。
  `onKeydown` 要掛在 `.ex-tab` 上不是按鈕上（它讀 `currentTarget` 當要搬的那一頁）。
- 測試：`e2e-explorer-cdp.js` 的 [J]（整支 112 條）。那支用真的滑鼠事件，
  **視窗一定要 `--hidden`**：視窗沒在前景時 Chromium 會把 CDP 的「按下／放開」丟掉，只剩 mousemove。

### 檔案總管：雙欄的「作用欄」（2026-09-21）

- 雙欄不是兩套流程，是**一套流程＋一個作用欄**。`explorer-page.js` 的 `activePane`
  記著使用者最後按的是哪一欄（`#exList` 與 `#exSecondPane` 各有一個 capture 階段的
  mousedown）。`selectedEntries()`／`paintStatus()`／`paintCmdBar()`／`pasteHere()`／
  `newFolder()`／`newFile()`／`openContextMenu()`／側欄位置與磁碟的導覽都讀
  `activeCwd()` 與作用欄的選取，右欄不另外複製一份。
- 右欄的右鍵選單、方向鍵／Enter／Backspace／Delete／F2、拖出去（原生拖放）與拖進來
  （`bindDropTarget` 指到 `secondPane.cwd`）都綁在 `#exSecondList`。
- **坑**：四顆跨欄鈕（複製／搬到左右欄）長在右欄裡，mousedown 會先把作用欄切成右欄，
  所以 `copyBetweenPanes()` 的來源必須指名左欄／右欄，不能用 `selectedEntries()`。
- **坑**：大資料夾分頁載入後 `secondPane.entries` 是稀疏陣列，未載入的頁是洞。
  `filter`／`map` 會跳洞，`find` 不會——掃它之前一定要先 `.filter(Boolean)`。
- 右欄有自己的分頁（`secondTabs`／`secondActiveId`），每一頁記自己的路徑、歷史、選取、
  捲動、排序、檢視與搜尋。整組分頁再按「左欄分頁」存進 `paneStates`，所以左欄換分頁時
  右欄跟著換成那一頁配的右欄分頁組。
- 右欄的麵包屑、圖示檢視（Ctrl+滾輪同一組級距）、整機搜尋都直接重用左欄那幾個純函式，
  不另外寫一套。
- **兩欄各有一條指令列**：`#exCmdBar`（左）與 `#exSecondCmdBar`（右）由同一支
  `paintCmdBarInto(bar, which)` 畫，選取、`貼上` 的可按與否都按那一欄算。動作本身仍然看
  作用欄，所以 `addCmd()` 的 click 會先 `setActivePane(which)` 再跑——`#exCmdBar` 長在兩欄
  外面，不先切的話它會拿右欄的 `cwd` 去貼上。
- **兩欄各有一組搜尋篩選條件**：`searchFilters(which)` 只差 id 前綴
  （`exSearch*` ／ `exSecondSearch*`）。右欄那組 `<details>` 只在整機搜尋時顯示，
  切回「篩這個資料夾」就收起來（在 `paintSecondPane()` 裡從狀態畫，換分頁也對）。
- **右欄自己有一排磁碟鈕**（`#exSecondDrives`，`paintSecondDrives()`）：側欄那排雖然也會
  送去作用欄，但得先點右欄才生效，開了雙欄的人根本看不出來。這排長在右欄裡，按一下就換槽，
  順便把作用欄切成右欄；目前那顆用 `aria-pressed` 標起來。資料來源跟側欄同一份 `disks`，
  所以收在 `paintSidebar()` 末尾一起重畫。
  版面上一定要壓 `max-width`——不壓的話四顆鈕會把 `flex-basis: 0` 的麵包屑擠成 0 寬，
  路徑整個消失；麵包屑那邊也給了 `min-width: 78px` 當底線。
- 右欄的「本機」不畫磁碟格（那是左欄首頁的事），空畫面改成指路去上面那排磁碟鈕。
- **坑**：`#exSecondCmdBar` 要在 `paintSecondPane()` 裡畫。只靠 `setActivePane()` 畫的話，
  剛開雙欄、還沒點過右欄之前那條指令列是空的。
- 右欄標頭固定兩列（導覽＋麵包屑／搜尋＋檢視），窄到 220px 時只有工具那一列會再換行。
  排序的原生 `select` 會被 `custom-select.js` 換成自訂下拉，寬度要對著
  `.custom-select[data-select-id="exSecondSort"] .custom-select-trigger` 調，
  不然它吃 `min-width: 180px`，標頭會胖到 200px 高。
- 測試：`e2e-explorer-dual-cdp.js`（42 條，含單欄回歸與跨欄鈕的來源）。
  三支 explorer e2e 都可以用 `VOICEINK_EXE=node_modules/electron/dist/electron.exe`
  跑原始碼（要先起 vite），並在連上 CDP 後把視埠固定成 1280×860——不固定的話視窗寬度
  會飄，詳情欄在 900px 以下整個收掉，實體滑鼠座標的測試也會跟著失準。

### 檔案總管：回收筒還原與 Enter 確認（2026-09-21）

- **從磁碟根目錄刪掉的東西本來一律還原不了**。`recycle.restore()` 檢查的是「父資料夾
  能不能寫」（`assertCreatable(parent)`），而 `isSystemLocked` 把 `D:\` 這種磁碟根目錄
  當成鎖住的位置，所以 `D:\` 底下刪掉的東西每一筆都吐 `PROTECTED`。還原是把東西放回
  它原本待的地方、不是往新地方丟，所以改成只看目的地自己（`assertCreatable(destAbs)`）。
  第二層是同一個原因：`mkdir('D:\', { recursive: true })` 在 Windows 上吐 `EPERM`，
  所以父資料夾已經在就不要補。`assertCreatable` 對新增／貼上的語意沒動——磁碟根目錄
  還是不能當新增目的地。
- **Enter＝確定**：`app-dialog.js` 在 `<dialog>` 上掛 capture 階段的 keydown，
  Enter 一律 `close(OK)`。危險彈窗的焦點仍然留在「取消」（滑鼠亂點不會刪到東西），
  但 Enter 會確定——不 `preventDefault()` 的話 Enter 會先觸發焦點那顆鈕，變成取消。
  `askInput` 原本自己那支 Enter 監聽因此拿掉了；注音／倉頡選字中的 Enter 要放行
  （`isComposing` 有些輸入法不送，所以連 `keyCode === 229` 一起擋）。
- 測試：`test-explorer.js` 的「磁碟根目錄的檔案還原得回去」、
  `e2e-app-dialog-cdp.js` 的 [G1]／[G2]／[G3]。
### 終端機：選取文字選不起來、PATH 被送兩份（2026-09-21）

- **「選取文字自動複製壞掉」其實是選不起來**：Claude Code v2.1 起會送 `?1000h`＋`?1006h`
  開滑鼠回報，xterm 一進滑鼠模式就把左鍵交給 CLI，自己不做選取——拖曳連反白都沒有。
  新增 `src/renderer/scripts/term-mouse.js`：用 `parser.registerCsiHandler` 把
  9／1000／1002／1003 吞掉（同一串裡的非滑鼠模式原樣寫回去），模式根本開不起來，
  選取／右鍵貼上／滾輪捲 scrollback 全照原路走。取捨：CLI 收不到滑鼠，Claude Code 的
  點選單要改用鍵盤——這是使用者選的。回歸 `probe-terminal-mouse.js`（含對照組）。
- **`prependPath` 只改第一個 path 鍵還不夠**：從 Git Bash／MSYS 啟動 App 時 `process.env`
  同時有 `PATH` 與 `Path`，而 node-pty 是照物件的鍵逐一拼環境區塊（`child_process` 會先
  去重、它不會），兩份一起送進去子程序拿到哪份看運氣。改成先把同名鍵收成一個。
  回歸 `probe-terminal-editor.js` 的 [F2]。
- 順帶查清楚的：v1.24.1 那版把整條 PATH 蓋成 `<editor-bridge>;`，從那種終端機起的
  Claude Code 會一直噴 `node: command not found`——**已跑著的工作階段不會自己好**，
  v1.24.2 之後新開的終端機才是乾淨的。

### 檔案總管：方格檢視的縮放與大圖預覽（2026-09-21）

- **方格檢視的檔名本來是直書的**：`.ex-row-name` 在清單檢視是「圖示 ＋ 檔名」橫向一列，
  方格檢視沒把它改成直排，於是圖示留在左邊、檔名被擠成一欄寬＝一個字一行。
  CSS 補 `.ex-list.is-grid .ex-row-name { flex-direction: column }`，檔名 `.ex-row-label`
  最多兩行（選取時攤到五行），完整檔名放 `title`。
- **Ctrl+滾輪縮放**：級距在 `explorer-zoom.js`（純函式，好測）——清單 → 48 → 64 → 96 →
  128 → 180 → 256，最小的方格再往下滾掉回清單。大小寫進 `#exList` 的 `--ex-tile`（版面）
  與 `data-tile`（`explorer-icons.js` 拿它決定跟殼層要多大的縮圖，快取鍵也帶尺寸），
  存進 `explorer.json` 的 `tile`（`store.js` 的 `sanitizeTile` 把怪值靠回最近一級）。
  `wheel` 要 `{ passive: false }`，不然 `preventDefault()` 無效＝整頁被 Chromium 縮放。
- **大圖預覽 `image-viewer.js`**：選圖片按**空白鍵**、點側欄小預覽、或右鍵「預覽」開；
  滾輪縮放、拖曳平移、雙擊切「符合視窗 ⇄ 100%」、←／→ 換同資料夾的圖、Esc 關。
  圖片走 `vi-media://` 的 `~local` 路線（`explorer:mediaUrl`）**邊讀邊送**，
  不是 `inspect` 那個卡 2MB 的 `data:` URI。路徑兩道關卡：`explorer/paths.resolveExisting`
  ＋ 協定端再驗一次。Enter／雙擊仍是「用系統預設程式開」，沒有改掉。
- 測試：`test-explorer-zoom.js`（級距、消毒、兩邊級距一致、網址編碼）
  ＋ `e2e-explorer-cdp.js` 的 [C11]（量 computed style，確認檔名不是直書、滾輪真的放大）。

### 貼上與語音輸入的插入路徑（2026-09-20，2026-09-21 補截圖）

- **終端機接下 Ctrl+V／Ctrl+Shift+V／Alt+V**（`attachCustomKeyEventHandler` → `pasteFromClipboard`）：
  xterm 自己不碰剪貼簿，沒接的話那顆鍵只會變成 `^V` 送進 PTY，Claude Code 那類 CLI 不認。
  剪貼簿跟 main 要（`terminal:clipboardText`）——renderer 的 `navigator.clipboard.readText()`
  沒焦點會 reject。右鍵貼上同一支。
- **剪貼簿裡是截圖就落成 PNG 再貼路徑**（`terminal/clipboard-image.js` →
  `terminal:clipboardImage`）：存進 `<userData>/clipboard-images`，貼進去的是加好引號的
  路徑（跟拖放檔案同一套規則），任何 CLI 都讀得到那張圖。**丟 `^V` 讓 CLI 自己去翻剪貼簿
  在 ConPTY 裡多半一聲不吭**，那是最後的退路不是主路。舊圖超過一天或超過 40 張就掃掉。
- Alt+V 也收：Claude Code 的說明把它列成「貼上圖片」，不接的話 xterm 只會送 `ESC v`。
- **語音輸入在自己的視窗裡不走剪貼簿**：`dictation/insert.js` 的 `insertIntoOwnWindow` 用
  `executeJavaScript` 叫 renderer 的 `__viInsertText`（`dictation.js`）；終端機走
  `pasteIntoFocusedTerminal`，一般輸入框走 `execCommand('insertText')`。人在別的程式裡
  （拿不到 focused window）或 renderer 插不進去，才退回原本的剪貼簿 ＋ 模擬 Ctrl+V。
- 測試：`e2e-terminal-cdp.js`（打包版量 PTY 真的收到什麼）、`e2e-dictation.js` 的 [K0]。

### 檔案總管：跟 Windows 看齊的那幾件事（2026-09-20）

- **排序不再被 2000 筆截斷毀掉**：`listDir` 改成先排序再截斷（`MAX_STAT = 10000`、64 並發；
  超過上限才退回「先砍再排」並標 `truncated`）。以前在大資料夾按大小排，拿到的是
  「readdir 前 2000 筆裡最大的」。
- **系統項目預設藏起來**：本機優先用殼層 `attrs` 讀 Windows hidden／system 屬性（每層前 2000 筆、200ms 等待上限）；缺資料、逾時或 UNC 才退回系統名稱名單，不把點開頭一律藏起來。`showHidden` 由空白處右鍵切換並存進 `explorer.json`，隱藏列畫淡。
- **鍵盤走得動**：方向鍵／Home／End 移動選取，Shift 連選；方格檢視四個方向都走（欄數照版面量）。
- **空白處拖出框選**，框選期間不重畫清單（見 AGENTS.md 地雷）。
- **狀態列講得出「已選取 N 個」**，全是檔案時報總大小（選到資料夾不報，要遞迴才算得出來）。
- **拖著檔案停在資料夾上 0.7 秒會自己進去**（`bindDropTarget` 的 `onHover`），才丟得到深層路徑。
- **Ctrl+Z 復原**搬移／複製／改名／貼上；復原「複製」是丟資源回收筒不是永久刪。
- **方格檢視顯示真的縮圖**：殼層 sidecar 的 `thumb` op 走 `IShellItemImageFactory::GetImage`
  （以前只有 `SHGetFileInfo` 的類型圖示，一資料夾照片長得一模一樣）；方格裡每個可見列都問
  （照片／影片／文件／資料夾），可見列與併發 4 沿用，快取 key 用 `t:`／`i:` 分開，沒建 sidecar 照舊降級。
- 測試：`test-explorer.js` 的 [H2][H3][S4][S5][S6] ＋ `e2e-explorer-cdp.js` 的 [C5]～[C10]
  ＋ `probe-explorer-shell.js` 的 [D]（真的取一張縮圖，並驗它跟類型圖示不是同一張）。

### 檔案總管：大小、屬性與縮圖重試（2026-09-20）

- `explorer/size.js` 以 `raw-fs` 加總資料夾，不追 junction／symlink；單一工作可取消，5 萬檔／32 層／8 秒停止，未讀完顯示「至少」。詳情換選取或離開檔案頁取消，晚到結果不覆蓋新選取。
- 縮圖以 `THUMBNAILONLY | INCACHEONLY` 探快取，未完成先給圖示並帶 `pending`；renderer 以 400／800／1600ms 最多重試三次，暫時圖不進快取。
- 驗證包含真 `attrib +h`、真 PNG 與無法生成縮圖的檔案；正常 PDF／影片不保證能重現 `E_PENDING`。

### 工作區：檔案樹收得下外面拖進來的檔案（2026-09-20）

- `workspace:importDropped(projectId, relDir, absPaths)`：目的地仍只收
  `{ projectId, relPath }` 並走 `files.resolveIn`，來源是使用者任意路徑所以用 `raw-fs` 讀；
  **一律複製不搬移**（跨磁碟搬移會毀掉來源），撞名 `name (2).ext`，資料夾遞迴，
  符號連結當連結複製不跟著走。上限先量再複製、超過整批拒絕（50 個頂層項目／8000 檔／
  單檔 200MB／總量 1GB）。
- 檔案樹的 `dragover` 也要放行外部檔案（只看內部 `dragging` 的話 `drop` 根本不會發生）。
- 測試：`test-workspace.js` 的 [S2]。

### 檔案總管：檔案拖得出去、空白處取消選取（2026-09-20）

- 清單上拖檔案**交給 Windows 自己的拖放**（`explorer:startDrag` → `webContents.startDrag`），
  所以拖得進瀏覽器的上傳框、桌面、別的程式。dragstart 要 `preventDefault()` 把場子讓出來，
  HTML5 的 DnD 跟原生拖放不能並存。
- 代價是自家視窗內的拖放也變成 OS 拖放：drop 端沒有自訂 MIME 可讀，`readDragPaths` 改從
  `dataTransfer.files` ＋ `getPathForFile` 取絕對路徑（順手支援「從別的程式拖檔案進來」）。
- 清單空白處按一下就取消選取（以前只有右鍵會清，Ctrl 多選之後點旁邊清不掉）。
- 測試：`e2e-explorer-drag.js`（假 sender，不真的啟動拖放）、`test-explorer.js` 的 [S3]、
  `e2e-explorer-cdp.js` 的 [C3][C4]。

### 檔案總管：右鍵把資料夾加進工作區專案（2026-09-20）

- 資料夾右鍵「加入工作區專案」、資料夾內空白處右鍵「把這個資料夾加入專案」→ 加進專案清單、
  切到聊天頁、側欄切到專案並選中它（`explorer-page.js` 的 `openInWorkspace` →
  `workspace-page.js` 的 `openFolderAsProject`）。沿用既有的 `workspace:addDropped`，不另開 IPC。

### 工作區：執行檔、瀏覽器、Git 面板（2026-09-20）

- 檔案樹點 `.exe`／`.lnk` 用系統開啟（`workspace:openEntry` → `shell.openPath`，路徑只收專案內）；點 `.cmd`／`.bat`／`.ps1`／`.sh` 開終端機跑。`.js`／`.py` 仍開編輯器，右鍵才有「在終端機執行」。
- 內建瀏覽器**每個分頁一顆 webview**（各自歷史與捲動），工具列有上一頁／下一頁／停止、載入中、錯誤頁、devtools；快捷鍵 Alt+←／→、F5／Ctrl+R、F12、Ctrl+L。
  切到別的專案時 webview **停放不拆**，切回來接著原本的畫面，不用再按前往。
- 方格檢視對每個可見列問殼層縮圖（照片／影片／文件／資料夾預覽），不再用副檔名白名單；清單仍是類型圖示。
- Git 動作鈕跟著側欄寬度換行（180px 也不疊字）；最近提交可展開看 `--numstat` 那幾列。
- 「檢視變更」同一個檔案就地切換編輯 ⇄ 變更，不新開分頁。測試：`test-workspace.js`、`test-workspace-ui.js`。

### 檔案總管分頁與首頁（2026-09-19）

- `explorer-page.js` 管理各分頁的路徑與上一頁／下一頁；切換 App 頁面仍保留。分頁只保留於本次開啟，重啟沿用既有 `lastPath`。
- `explorer-tabs.js` 畫分頁列；支援新增／關閉、Ctrl+T／Ctrl+W／Ctrl+Tab、方向鍵切頁、資料夾中鍵另開與右鍵「在新分頁開啟」。
- `explorer-home.js` 畫 `thispc` 虛擬首頁，顯示常用資料夾、磁碟容量與網路磁碟；沒有 `lastPath` 時預設首頁。不能把首頁當資料夾新增／貼上。
- `explorer:driveInfo` 非同步讀取 CIM 磁碟資訊（8 秒上限，同時查詢共用一份）；晚到回覆不得改到另一分頁。測試：`test-explorer-page-state.js`、`test-explorer.js`、`e2e-explorer-cdp.js`。
- `.lnk` 經 `resolvePath` 解析（最多 16 層，拒循環）；`openPath` 遇到資料夾回傳導航目的地，renderer 留在目前分頁。一般檔案捷徑仍執行原捷徑，保留參數。
- `explorer-icons.js` 只載入可見列圖示（同時最多 4 筆、快取 256 筆）；`explorer:fileIcon` 優先問殼層 sidecar 拿**已經疊好 overlay 的圖**（Google Drive 綠勾／雲朵跟檔案總管同一張），問不到才退回 `app.getFileIcon`／資料夾 emoji。捷徑附箭頭。滑鼠側鍵 3／4 走目前分頁歷史，攔截瀏覽器預設跳頁。
- 右鍵選單：App 自己的開啟／剪下複製貼上／釘側欄，再加上殼層 `IContextMenu`（7-Zip／WinRAR／Git／傳送到／內容）。擴充項目畫進玻璃選單，子選單 hover 展開。sidecar 是 `native/explorer-shell` → `resources/shell/VoiceInkShell.exe`（`npm run build:shell`），沒建就少那些項。測試：`test-explorer-shell.js`、`probe-explorer-shell.js`。

```
src/main/
  main.js             frameless 主窗、IPC 註冊、store allowlist 與一次性遷移、單一實例鎖與系統匣
  updater.js          App 內自動更新（electron-updater ＋ GitHub Releases 的 latest.yml）；
                      結束前在 app.exit(0) 前一行靜默安裝（autoInstallOnAppQuit 對本 App 無效）；
                      差分下載強制關閉（GitHub 只能逐段序列下載，實測比整包慢 36 倍）；
                      安裝檔經 update-mirrors.js 先走代理（GitHub CDN 在 APAC 會限速）
  chat.js             雲端聊天 SSE；每個對話一條 in-flight（不同對話可併發）、雙逾時、上下文裁切、model allowlist、圖片與生圖、重新生成
  chat-params.js      每對話取樣參數（只收通用的 Temperature／Top P／Max tokens／Stop）的驗證與轉 API 欄位
  chat-title.js       第一輪回覆後 AI 自動取標題（改過名就不動）
  chat-store.js / chat-images.js / chat-models.js   會話＋側欄資料夾持久化（編輯／刪除／分叉訊息、匯出 Markdown）、圖片附件、/models 掃描
  ipc-invoke.js       十組模組 IPC 的共用外殼 makeInvoke()：主視窗守衛 ＋ { ok, data|error } ＋ userMessage 白名單
  terminal/           ConPTY：pty.js、status.js（OSC 133 ＋ 靜默雙軌，純函式）、store.js（固定表）、
                      ipc.js、links.js（畫面上的網址／路徑，主行程驗存在後回給 renderer 用 App 開）、
                      admin.js／admin-host.js（管理員終端機的提權 host）、
                      host.js／host-runtime.js／host-client.js／service.js（**PTY 住在 App 外的獨立宿主**）、
                      editor-bridge.js（Ctrl+G 的 $EDITOR 橋接：CLI 開的編輯器就是 App 自己的分頁）
  workspace/          專案工作區：store.js（workspaces.json）、files.js（**專案內**唯一的檔案系統入口，resolveIn）、
                      git.js（porcelain=v2 -z 解析＋commit／push／審閱）、agents.js（本機 AI session）、
                      worktree.js、watch.js（一次看一個專案的 recursive watcher）、index.js、ipc.js
  explorer/           整機檔案總管：paths.js（resolveAbs）、fs.js、recycle.js（系統資源回收筒）、
                      drives.js、watch.js、uffs.js（代跑 UFFS CLI）、store.js（explorer.json）、
                      shell-host.js／shell.js（IContextMenu sidecar）、index.js、ipc.js
  hfmodels/           hub.js（HF API 唯讀）、catalog.js、gguf.js（檔頭＋KV 估算）、hardware.js、plan.js、
                      fit.js（官方 llama-fit-params）、download.js、library.js、presets.js（INI）、
                      runtime.js（router 生死）、bench.js、index.js、ipc.js
  ccswitch/           claude-settings.js（外科式改 env）、presets.js、providers.js（路由推導）、
                      models-scan.js、mcp.js、versions.js、credential.js、gateway/（server.js、oauth.js）
  codeusage/          scan.js（增量游標）、parsers.js（五家逐行）、pricing.js（單價＋RULES_VERSION）、index.js
  native-probe.js     voiceink-probe.exe 的位置／找不到就退回 PowerShell 或 JS（sysmon、screentime、codeusage、explorer/size 共用）
  sysmon/             probe.ps1（退路；平常跑 voiceink-probe.exe sysmon）、metrics.js（純函式差值）、sampler.js、gpu.js、bench.js、
                      stress.js、sensors.js（提權 sidecar 雙向橋接）、sensors-task.js、fans.js、
                      oc.js（效能調整）、pawnio.js（代裝＋驗簽）、ipc.js
  screentime/         使用時長：Tai 相容 SQLite、前景觀測、8908 WebSocket、統計查詢
  usage/              七家額度 provider（全走官方端點）、codex-reset.js（app-server 兌換重置）、api-key.js、6h soft cache、受限 IPC、
                      claude-auth.js（Claude 的 token 照 CLI 協定續期、寫回）
  agy/                server.js（127.0.0.1＋強制金鑰）、OpenAI/Anthropic ⇄ Gemini 雙向轉換、
                      catalog.js／model-map.js、credential.js（nudgeCli 續期）、logs.js
  dictation/          index.js（管線）、hotkey.js（原生 sidecar／uiohook 雙路徑）、hook.js、
                      text.js（切段／字典／清理）、hud.js（指示器視窗）
  model-scope.js      三個子分頁各自的模型選擇：唯一解析點
  asr-select.js       本地 ASR 門面（依 scope 分流）；engine／file-transcribe／IPC 都只認它
  local-asr.js（sherpa CPU）／llama-asr.js（llama-server GPU）／cloud-asr.js（/audio/transcriptions）
  local-llm.js  translate-clean.js  file-transcribe.js  models.js  edge-tts.js  engine.js  opencc.js

src/renderer/scripts/
  app.js  chat-page.js（串流照對話分開）  chat-sidebar.js（資料夾／狀態）  chat-params-panel.js  chat-menu.js  markdown.js（零 innerHTML）  terminal-page.js  ccswitch-page.js  sysmon-page.js
  quota-bar.js（工作區底下的額度條）  code-usage-page.js（CC代理的用量統計）  agy-page.js  stt-page.js  transcribe.js  live-caption.js  vad.js
  translate-page.js  dictation.js  model-picker.js  custom-select.js（共用 ARIA listbox）
  workspace-page.js（專案側欄＋右側欄四面板＋檔案樹）  explorer-page.js（整機檔案總管）
  ws-tabs.js（分頁列＋編輯器＋內建瀏覽器）
  ws-monaco.js  ws-ai-session.js  ws-review.js  ws-git-status.js（git status 共用快取）  ws-tool-icons.js（「＋」選單圖示）
  list-reorder.js  grid-reorder.js  hf-page.js  sysmon-fans.js  sysmon-oc.js  sysmon-screentime.js

native/  dictation-hook/（WH_KEYBOARD_LL → resources/hook/）  sysmon-sensors/（→ resources/sensors/）
         explorer-shell/（IContextMenu + overlay → resources/shell/）
         voiceink-probe/（Rust：系統監控取樣＋前景視窗觀測，取代兩支 PowerShell；另有 usage-scan／dir-size／hook 子指令；第二支 voiceink-term.exe＝終端機宿主 → resources/probe/）
scripts/ 測試與探針（指令表見 CLAUDE.md「驗證方式」），dev-sandbox.js ＝ npm run dev:sandbox
```

### 資料落點（皆在 `%APPDATA%/voiceink/`）

| 檔案 | 內容 | 存取 |
|---|---|---|
| `config.json` | 一般設定 | `store:*`（**key 僅 allowlist**） |
| `chats.json` ／ `chat-images/` | 聊天會話＋資料夾＋每對話參數（不含圖片）／圖片附件 | `chat:*`；檔名由 main 產生 |
| `terminals.json` | 終端機 metadata（不存畫面內容） | `terminal:*` |
| `workspaces.json` | 專案清單（`{ id, name, path }`＋`tabsState`） | `workspace:*` |
| `explorer.json` | 檔案總管上次路徑／檢視模式 | `explorer:*` |
| `dictations.json` | 語音輸入紀錄與個人字典 | `dictation:*` |
| `recordings/rec-*.webm` ／ `live-transcripts/live-*.jsonl` | 錄音機的錄音／即時字幕每一場的逐字稿 | `sttArchive:*` |
| `usage.json` ／ `code-usage.json` | 七家額度快取／每小時用量桶＋掃描游標 | `usage:*`／`codeusage:*` |
| `agy-logs.db` | AGY 流量日誌（node:sqlite） | `agy:*` |
| `claude-backup/` | `~/.claude/settings.json` 寫入前的備份 | ccswitch |
| `models/<key>/` ／ `hf-models/<id>/` | 下載的模型與執行環境／HF 本機模型庫（可改 `hfModelsDir`） | `models:*`／`hfmodels:*` |
| `hf-presets.ini` | router 的 `--models-preset` | main 產生 |
| `screentime/data.db` | Tai 相容的應用／網站時長 | `screentime:*` |

AGY 設定、終端機、聊天、語音輸入紀錄**刻意不進** `STORE_ALLOWLIST`；`hfToken` 是機密，renderer 讀不到。

### 三個子分頁的模型選擇

`src/main/model-scope.js` 是唯一解析點：`file`（`fileAsr`／`fileLlm`）、`live`、`dictation`（唯一可選「不使用」）。
值格式：ASR＝`local:<key>`／`cloud:<設定 id>:<模型 id>`；LLM＝`local:<key>`／`cloud:<供應商 id>:<模型 id>`／`''`。
翻譯與 TTS 頁不在這組（維持全域 key）。

## 最近變更

### 2026-09-25（v1.31.0）— 第二輪：終端機宿主改 Rust、常駐小程式瘦身、終端機少一層毛玻璃

實機量（開 29.6 小時）：GPU 程序 621MB／平均 9% 單核、主畫面 renderer 6.5%、Telegram 四格約 700MB、終端機宿主工作集 277MB、5 顆 conhost。

- **終端機宿主 → Rust `voiceink-term.exe`**：不再把 224MB 的 Electron 複製進 userData 當 Node 跑。私有 40.7→1.8MB、工作集 52→7MB、CPU 0.44→0.13s（同樣輸出 3000 行）。協定不變，找不到 exe 退回 Electron 版。
- **常駐 sidecar**：熱鍵 .NET → `voiceink-probe hook`（33.7→7.1MB）；probe 改 GUI 子系統＋`nvidia-smi` detached，四顆 conhost 不見（合計約 50MB）。
- **終端機那格拿掉毛玻璃**：底色不透明本來就看不到，截圖逐像素最大差 2/255；GPU 程序少約 24MB。
- **量過不做**：全面拿掉毛玻璃（快速輸出時 CPU −31%、GPU −59MB，但文字會從灰階反鋸齒變 ClearType 彩邊）；Telegram 四格共用程序（−111MB，但要全域 `--process-per-site`，語音輸入的浮動提示會跟主視窗擠同一個程序、一格當掉四格一起白）。**這兩項使用者決定維持現狀**，別再提；整個 App 改 Tauri（WebView2 一樣是 Chromium）。

### 2026-09-25 — 最重的兩段 JS 改成 Rust（沿用 voiceink-probe.exe）

- 掃過整個專案挑 CPU 熱點：一次性 PowerShell、git、搜尋都不是瓶頸；真正卡的是**用量統計全量掃描**（2.8GB JSONL 在主程序 JSON.parse 28.5 秒）與**資料夾大小**（每檔一次 lstat，大資料夾 8 秒逾時只給「至少」）。
- `usage-scan`：`usage.rs` 逐條照 `parsers.js`、多執行緒 → 1.3 秒；7.2 萬筆事件與全部游標跟 JS 逐筆一致。JS 端只剩收檔案、接游標與退路。
- `dir-size`：`read_dir` 直接帶大小 → node_modules 0.2 秒、`C:\Program Files` 3.5 秒算完 21.5 萬檔（原本逾時停在 4.5 萬）；取消＝砍程序。
- 其餘候選（專案全文搜尋 1.5s／1200 檔、AI 記錄、埠清單）量過都夠快，不動。

### 2026-09-19 — 系統監控常駐穩定、HF 儀表板與架構自適應

- **感測器不再 5 次就停**：sidecar 斷線或卡住沒回報就指數退避一直重拉（`ensureSensors`）；讀數穩定 60 秒才把間隔歸零。nvidia-smi 卡住同樣重開。
- **HF 依 GGUF 架構自適應**：顯存夠就把上下文沿著 4K～256K 梯子往上長；有 mmproj 預設開視覺（可關）；Qwen3／DeepSeek 可開思考；in-checkpoint MTP 預設 `draft-mtp`。
- **執行環境分頁加簡易儀表板**（對標 DualGPUs 面板／LM Studio）：GPU VRAM、tok/s、排隊、本機 OpenAI／Anthropic 端點（**不送金鑰**）、llama-server log。模型卡列出 ctx／KV／視覺／MTP。

### 2026-09-19 — 終端機連結、Ctrl+G、破圖

- **折行**：xterm `isWrapped` 之外，CLI 自己印的換行若前一列以 `/` `\` 結尾、或剛好填滿一列，也接成同一條邏輯行再掃。`file://`、`www.`、`localhost:埠` 也認得；`file.js:12` 的行號留給開檔。
- **點下去用 App 開**：網址走內建瀏覽器分頁；路徑在專案裡就開編輯器／檔案樹，否則進檔案頁。不再 `shell.showItemInFolder`。
- **AGY Ctrl+G**：`EDITOR`／`VISUAL` 改短檔名 `voiceink-edit.cmd`，`editor-bridge` 資料夾接到 PATH 最前面。AGY／Gemini CLI 用 `split(' ')` 再 `spawn({ shell: true })`，完整路徑一加引號就切壞。
  **2026-09-21 修**：那條 PATH 其實從來沒進到子程序——`{ ...process.env }` 展開出來的鍵是
  `Path`（Windows 原字），寫 `env.PATH = …` 等於另外開一個空的 `PATH`，生效的還是原封不動的
  `Path`，症狀是 AGY 回 `editor "voiceink-edit.cmd" not found in PATH`。改成
  `prependPath()` 就地改本來那個鍵。**宿主活得比 App 久，要按重新啟動宿主才吃得到。**
- **破圖**：WebGL context 掉了重掛（最多 3 次）；欄列數真的變了才清 glyph atlas 並 refresh。

### 2026-09-15 — 工作區大檔預覽與編輯

- 純文字讀／寫上限 2MB／4MB → 都是 50MB：幾十萬行 JSON 用 Monaco 開、改、存。大檔打字停手 300ms 才同步內容（`ws-monaco.js` 的 `flushChange`），12MB 檔每字 ~1ms。
- 圖片／PDF／影音不再整份 base64 過 IPC：新增 `workspace/media.js` 的 `vi-media://` 自訂協定串流（Range、隨機 token、`resolveIn`），沒有大小上限；pdf.js 改吃網址分段讀。
- 修掉既有 bug：關影音預覽分頁會丟例外（行首 `(` 被接到上一行），之後工作區卡死。
- 實測 `probe-workspace-bigfile.js`：26MB 圖片、74MB 影片拖曳、30MB 音訊、400 頁 PDF、協定擋錯 token／越界／非媒體檔。

### 2026-09-15 — 根治專案外殘留

- **App 不再鎖住 `app.asar`**：`src/main/raw-fs.js`（Electron 下＝`original-fs`）給檔案總管、工作區、終端機連結偵測用；以前列一次打包輸出，那個 asar 就被鎖到關 App。
- **同步遞迴刪除改走 `src/main/safe-rm.js`**：Node 24（Electron 43 內建）的 `rmSync` 遞迴會穿過 junction 刪到對面；模型庫刪模型、GPU 套件、終端機宿主暫存都換掉。
- **從 asar 複製檔案改讀進來再寫**（終端機宿主、ffmpeg、GPU 套件）：`copyFileSync` 會在 `%TEMP%` 留 `<uuid>.tmp.*` 中繼檔。
- **腳本暫存統一**：`scripts/lib/test-temp.js`（`%TEMP%\voiceink-tests`，結束自動刪、過期清），74 支腳本改用；`test-temp-hygiene.js` 守門（也擋遞迴 rmSync）。
- **`npm run electron:pack` 改成 `scripts/pack-preview.js`**：打到專案外 → asar 內 `src/` 逐檔比對 → 同步 `dist/win-unpacked` → 刪外部輸出。
- 順手修三支過期測試：`test-workspace-ui.js` 還查已刪的 `.chat-list-proj`、`e2e-terminal.js` 寫死專案資料夾名、`test-terminal-host.js` 假設 `dist/` 已存在。

### 2026-09-14 — 終端機組字閃爍與全代碼庫修復

- **終端機組字不再被 AI CLI 重畫拉走**：`term-ime.js` 改成組字期間用 CSS 變數＋`!important` 固定輸入框與組字文字位置（不再每幀用 JS 擺回去）；`bindImeCaret` 回傳 dispose，關分頁時收事件。
- 工作區草稿記住原檔 `mtimeMs`，重開後仍擋外部修改；缺版本的舊草稿要先比較或明確覆寫。只改檔名大小寫可以改名（兩邊檔案總管都是）；磁碟根當專案時路徑守衛正常。
- HF 下載寫檔失敗回錯誤不崩潰、續傳跳過已完成分片；`library.has` 要全部分片／mmproj 到齊才算已安裝（開始下載前先寫預期檔案清單）。
- 雲端轉錄最後一段取消不誤報成功；額度 `usage/store.js` 改成 `updateState(fn)`（讀改寫不讓出執行權，同步與設定不互蓋）。
- CC 閘道／AGY 的 SSE 逐行解析（接受 CRLF、保留沒有結尾換行的最後一段）；Ctrl+G batch 複製失敗回非零（`SHIM_VERSION` 2）；TTS 錯誤不回送外部訊息。

### 2026-09-14 — 聊天：併發、側欄資料夾與狀態、對話參數

- **不同對話可以同時回應**：main 的 inflight 改成照 conversationId 的 Map（不設總數上限，同一對話仍一條）；renderer 串流也照對話分開，切走不中斷。
- 側欄每列顯示「回應中／已完成（還沒看）／失敗」；收起來的資料夾在標題上掛狀態點。`chat:list` 帶 `streaming`，重載 renderer 也看得到。
- **對話的專案歸屬拿掉**（`projectId`、`chat:setProject`、`ws:project` 事件都刪了），改成側欄資料夾：建立／改名／收合／刪除（對話移回未分類）、資料夾本身拖曳排序、對話拖進拖出、「⋯」選單搬移與匯出 Markdown。
- **對話參數**（勾選才送，只留各家都支援的）：Temperature、Top P、最大輸出 tokens、停止字串，外加不送上游的上下文訊息數；可存為新對話預設（`chatParams`）。
- **AI 自動取標題**：第一輪回覆後用同一顆模型補一發非串流請求換掉暫定標題，側欄收到 `chat:title` 重讀；改過名就不動。
- 訊息操作：編輯使用者訊息並重送、刪除單則、從某則分叉成新對話；最後一則是沒回覆的使用者訊息時可「重新送出」。回覆下方標模型、耗時、token 與 tok/s（上游有給 `usage` 才有 token）。
- 合併前審查：`chat:abort` 不帶 reqId 一律不動（以前會停掉全部對話）；`e2e-workspace-cdp.js` 的 [AC] 改驗「對話不再帶專案歸屬」；`e2e-chat-cdp.js` 刪除供應商改走 `askConfirm` 彈窗（背景視窗要手動補送 `close`）。

### 2026-09-12 — 系統監控取樣器常駐

- **probe.ps1 與 nvidia-smi 開機就跑**，離開系統監控頁與縮到系統匣都不停；進頁 `start()` 立刻把上一筆再送一次，不必等下一輪 tick（以前每次進頁都付冷啟動＋第一輪 CPU% 全 0）。
- 壓力測試仍離頁就收。提權感測器 sidecar 的 UAC 自動啟用仍只在進頁時，開機那條還是只走排程工作。

### 2026-09-12 — 檔案頁詳情／側欄／路徑／搜尋

- 右側詳情：操作鈕改上方橫排，下面是預覽（圖片／文字開頭／捷徑目標）與類型／時間／尺寸。
- 側欄位置可新增、移除、拖曳排序；可釘資料夾或加 UNC／NAS（可選磁碟代號 `net use`）。
- 路徑列可點一下或 Ctrl+L 輸入直達（檔案會進上一層並選取）。
- 快速搜尋命中依檔名相關度排序；右鍵補複製路徑／名稱、建立捷徑、釘到側欄、重新整理。

### 2026-09-12 — 檔案頁可做日常檔案操作

- 預設刪除進系統資源回收筒（側欄可進、還原、清空；Shift+Delete 永久刪除）。複製／搬移撞名改成 `name (2).ext`，不覆寫。
- 右鍵選單、Shift 範圍選、Ctrl+A、拖到資料夾列或側欄；清單可依名稱／日期／大小排序。新增檔案與新增資料夾都有。
- 路徑仍只放行本機磁碟機絕對路徑；回收筒是虛擬位置 `recyclebin`。

### 2026-09-12 — 整機檔案總管 + UFFS 搜尋

- 頂欄新增「檔案」頁（`data-page="explorer"`，排在聊天後面）：左側快捷／磁碟、麵包屑、清單／圖示、右側詳情。
- 瀏覽走 `src/main/explorer/`，路徑只放行本機磁碟機絕對路徑；聊天頁的專案檔案樹不動。
- 搜尋框代跑本機 UFFS（Everything 等級的 MFT 索引）。進檔案頁自動從 GitHub Releases 下載到 `%APPDATA%/voiceink/uffs/`，跳一次 UAC 裝 Access Broker 並拉起 daemon，之後搜尋即開即用。關 App 不停 daemon。沙箱／CDP 暫存 userData 不自動跳 UAC（含 `force`）。
- 審查後：`assertCreatable` 讓家目錄根層可新增／貼上；`resolveExisting` 不跟 junction；UFFS 只跑安裝目錄且 checksum 缺就失敗；清空回收筒不吃 2000 上限。

### 2026-09-11 — 系統監控多 GPU、處理程序合併、使用時長分類

- **總覽兩張卡分開擺**：nvidia-smi 與庫存各卡一格，≥900px 並排；感測器／風扇對到自己那張，不再把全部 GPU 讀數複製到每一卡。有幾張卡就長幾張（總覽／壓力測試／效能調整跟 nvidia-smi 張數走；風扇來源預先建到 8 張，示意圖槽位到 gpu-4）。
- **處理程序同名合併**：chrome 那類收成一列，CPU／記憶體／磁碟／VRAM 加總，GPU% 加總後夾 100；結束工作會對該組全部 pid。
- **使用時長自動分類**：空庫種開發／瀏覽器／通訊／生產力／娛樂／遊戲／系統（網站另有購物／資訊）；寫入時依行程名／網域填 CategoryID；剩下未分類的背景查維基百科摘要再對類，不覆蓋已分過的。
- **風扇／效能調整／壓力測試**：槽位 `gpu`～`gpu-4`、來源 `gpu-temp`／`gpu2-temp`／`gpu3-temp`…；sidecar NVAPI 對每張卡寫入（`G … index`、`W`）；壓力測試每張卡自己的儀表，兩個 WebGL 環境盡力壓。沙箱預設關完整感測器（避免 UAC），總覽就只剩 nvidia-smi 那一層。

### 2026-09-09 — 終端機切回來畫面錯亂、Ctrl+G 改用 App 內的編輯器

- **畫面重複／被切一半的根因是欄列數沒同步**：`openSession` 切回舊分頁時只 `fitPane`
  不送 resize，那一格被藏起來的期間版面被拉過就對不上——Claude Code／Codex 這種整畫面
  重畫的 CLI 會照舊寬度再貼一次，看起來就是狀態列兩份、右邊被切掉半行。改走
  `fitAndSync`（量完欄列數變了才送）。回歸 `test-terminal-ui.js`。
- **Ctrl+G 不再彈記事本**：`terminal/editor-bridge.js` 產生一支純 batch 當 `EDITOR`，
  CLI 呼叫它時 batch 把檔案複製成 `<id>.in` 並卡住等 `<id>.done`；App 收到就開一個
  提示詞編輯分頁，按「儲存」只寫出 `<id>.out`（分頁還開著），**關掉分頁才寫 `.done`**，
  batch 這時把 `.out` 蓋回原檔後退出（沒存過就沒有 `.out`，等於原樣放行）。
  **路徑一個字都不出 batch**（`echo %~f1` 會用 cp950 寫出亂碼路徑），renderer 也只
  拿得到 id 與內容。**宿主是獨立程序、更新不會換掉它**，所以這個功能一直沒生效——
  App 現在會比對宿主回報的 `runtime` 與這一版想要的那份，舊的就（沒 shell 在跑時）
  自動重開、有 shell 在跑時問過再重開。接不接手由 main 的 `bridgeTakesOver` 決定：使用者挑過真的編輯器
  （vim 那類）才放行，`EDITOR=notepad` 等同沒設（那就是 CLI 的預設值）照樣接手。回歸
  `probe-terminal-editor.js`（真的把 batch 跑起來走完整條路）。

### 2026-09-09 — 終端機：WebGL、搜尋、字級、分割、標題與 cwd、忙碌判定

補上四個「每天碰得到、各只要幾行」的缺口，並修掉串流時游標亂閃。

- **游標亂閃的根因是 DOM renderer**（不是輸入法）。它把游標畫成
  `<span class="xterm-cursor-blink">`，閃爍是 CSS `animation: 1s step-end infinite`；
  AI CLI 串流時那一列每一幀都被重建，動畫就每一幀從 0%（游標實心）重來，永遠跑不完一個
  週期。實測 2.4 秒 29 幀 → DOM 重建游標 **30 次**，換上 `@xterm/addon-webgl` 是 **0 次**。
  **候選字視窗的抖動不是位置在跑**：同一段時間 88 次游標移動只換來 **1 次** textarea 位置
  變動（每輪重畫完游標都回到輸入行同一格）——別再往 `syncImeCaret` 修。回歸
  `probe-terminal-flicker.js`。
- **搜尋**（`@xterm/addon-search`）：Ctrl+F／Ctrl+Shift+F 開，Enter／Shift+Enter 前後找，
  顯示「第幾筆／共幾筆」，Esc 收。PSReadLine 的 Windows 編輯模式沒有綁 Ctrl+F（實測
  `Get-PSReadLineKeyHandler -Bound` 查得到），所以拿來當搜尋不會擋到行內編輯。
- **字級**：Ctrl+滾輪、Ctrl+= / Ctrl+- / Ctrl+0，所有分頁一起改，存 `termFontSize`
  （已進 `STORE_ALLOWLIST`，夾在 8～40）。
- **Unicode 11**（`@xterm/addon-unicode11`）：`loadAddon` 之後**還要**
  `term.unicode.activeVersion = '11'` 才生效。預設的 Unicode 6 字寬表會把 emoji 與部分
  框線字元算成一格，AI CLI 畫的方框就歪掉。
- **分割顯示**：同一個 `#termHost` 最多並排 3 格。**不搬 DOM**（搬 xterm 的節點＝逼它整份
  重新量尺寸），順序用 CSS `order`；`#termHost.is-split` 切成 flex。右鍵分頁 →「並排顯示」。
- **分頁標題跟著跑什麼變、cwd 跟著 `cd` 走**：宿主從 PTY 輸出撈 OSC 0/2 與 OSC 7，經
  `terminal:status` 的 `osTitle`／`liveCwd` 上來；`links.js` 改用即時 cwd 當相對路徑基準
  （原本的 `ponytail:` 待辦結掉了）。使用者改過名字（store 的 `renamed`）就不准被蓋掉。
- **安靜不再一律等於做完**（原本的 `ponytail:` 待辦）：拿得到 shell integration 標記、
  而且送出指令之後人沒再打過字時，安靜多久都維持「運行中」——quiet build 不再誤報收工。
  人在裡面又送出過一行才算「互動中」，那時才恢復「安靜＝做完」。`cmd.exe` 沒有標記，
  維持原本的靜默判定（不然會永遠卡在運行中）。
- **scrollback 不再每個 chunk 都重切 256KB**：實測 2 萬個 chunk 從 1912ms 降到 3.4ms；
  砍的位置改成從最近的換行砍（從中間切會切在跳脫序列裡，回放第一行冒出半截 `[38;5;12m`）。

### 2026-09-09 — 記事本真的置頂、Shift+Enter、Git 面板重整、終端機桌布

- **Ctrl+G 開的記事本終於每次都跳出來而且置頂**。根因：Windows 11 的記事本第二次開檔案
  **沿用同一個 pid 與同一個 HWND**（只多一個分頁，實測兩次都是 pid 5380／HWND 394578），
  而舊的抬窗器是在找「新出現的有視窗 pid」——記事本開過一次之後就永遠命中不了。
  快照改成記「視窗代碼＋標題」，標題變動只放行 `REUSE_WINDOW` 那幾支會重用視窗的編輯器；
  抬完加 `SetWindowPos(HWND_TOPMOST)`。新增 `probe-terminal-foreground.js`（舊版紅、新版綠）。
- **Shift+Enter 換行**：`\x1b[13;2u`（CSI u）改成 `\x1b\r`。CSI u 要 CLI 先啟用 kitty
  keyboard protocol，xterm.js 不宣告支援，所以那串序列直接被當成字元印進輸入框。
- **Git 面板重整**（參考 orca 的 `right-sidebar/source-control`）：列改成「檔名（亮）＋所在
  資料夾（淡）」兩段，右邊補上 `+新增 −刪除`（`status()` 多跑一次 `diff --numstat HEAD`）；
  分組標頭帶檔案數與「全部暫存／全部取消」；檔案多於 8 個時出現篩選框（只重畫不重問 main）；
  分支列的 ↑↓ 拆成兩顆各自上色的 chip。動作鈕維持常駐，不做 hover-only。
- **終端機主題與桌布**（設定 → 基本）：四組配色（全黑＝預設／跟著 App 主題／Dracula／
  Solarized Dark）＋自選背景圖＋濃度滑桿。圖片複製進 `<userData>/terminal-bg/`，store 只存
  檔名，renderer 只拿得到 `data:` URI；有桌布時才讓 xterm 的底透明，文字那一層完全沒動。

### 2026-09-08 — 大檔關掉要放手、貼上不再被截半、輸入法方框

- **關掉大檔之後記憶體回得去**：`disposeModel` 先讓編輯器 `setModel(null)` 再 dispose
  （不放手的話那份 PieceTree 沒人回收）；分頁關掉時把預覽區的 `<iframe>`／`<video>`
  收掉（以前關了還在背景跑腳本與緩衝）、`<textarea>` 影子與 `previewKey.source` 清空。
  實測 `probe-workspace-bigfile.js`。
- **選了專案就趁閒置先載 Monaco**：第一個大檔以前要等 16MB 的 AMD 包（實測 2964ms），
  暖機之後只剩開檔本身（實測 158ms）。載不起來照樣退回 `<textarea>`。
- **貼上超過 8192 字不再被安靜截半**：`terminal-page.js` 改走 `term-write-chunks.js`
  切段＋每個工作階段一條寫入鏈（IPC 是非同步的，連發會亂序）。
- **輸入法候選字視窗跑掉的真正原因是 `.xterm-helpers` 的 `left: auto`**（xterm.css 只寫了
  `top: 0`）：Electron 的 Blink 會把它算成非 0，隱形輸入框整個被推離游標。改成明寫
  `left: 0`，並把上一版「`opacity: 1` ＋一堆 transparent」的作法收回去——那個作法會讓
  Chromium 把那個輸入框的原生游標畫出來，就是畫面右下角那個會閃的白方塊。
- **Ctrl+G 開出來的記事本會跳到最前面**：PTY 收到 `\x07` 時 main 起一支一次性 PowerShell
  盯著新視窗，出現就 `AttachThreadInput` ＋ `SetForegroundWindow`（`terminal/foreground.js`）。
  ConPTY 沒有視窗、跑 shell 的又是 App 外的獨立宿主，兩個都不是前景，Windows 才不讓它跳。
- **修好 v1.16.0 就漏掉的第四份清單**：`resolveLinks`／`revealLink` 沒進 `main.js` 的
  `registerTerminalIpc({ service })` 列舉，終端機連結整個安靜地沒作用。
  `test-terminal-links.js` 現在從 `ipc.js` 反推該有哪些方法，四份清單一起對。

### 2026-09-08 — 終端機裡的連結

- **網址點了開內建瀏覽器分頁，路徑點了開檔案總管**：走 xterm 自己的 `registerLinkProvider`
  （沒裝 addon-web-links——路徑那半本來就得自己寫）。掃描與折行接合在 `term-link-scan.js`（純字串），
  掛載與 IPC 在 `term-links.js`，路徑解析在 `terminal/links.js`。
- **候選字要先問主行程「這個真的存在嗎」**，不存在就不畫底線：不然畫面上每個含斜線的字都變成假連結。
  相對路徑以**這個階段開起來時的 cwd** 為基準（PTY 之後 `cd` 去哪主行程看不到）。
- `provideLinks` 拿到的是**整份緩衝區的 1-based 列號**（不是畫面上的第幾列），回去的 range 同一套；
  折行的一列要往回接成整條邏輯行再掃。range 的 x 是 cell 欄位：CJK 一格佔兩欄，
  用字元位移 `% cols` 會把底線畫到前後無關的字上。掃描會剝掉黏在前後的中文、括號、等號。
  實測 `probe-terminal-links.js`（真 xterm、真滑鼠事件）。
- 新測試：`test-terminal-links.js`、`probe-terminal-links.js`。

### 2026-09-07 — 大檔不卡頓、輸入法對位、選單圖示

- **大檔案的成本都在「每次都重做」**：`showDiff` 改成每個分頁留自己那兩顆 model（舊版每次切回來重建一對，
  Monaco 得重新斷行＋重算差異）；`showTab` 不再用 `getValue()` 比對（改用 `modelText` 這份 WeakMap，
  省掉每次切分頁把整份檔案再複製一次）；Monaco 接手後 `updateGutter`／`updateIdeStatus` 直接跳過
  （行號欄 hidden、狀態列由 `paintMonacoStatus` 蓋掉，那兩支各要掃完整份內容）；預覽（Markdown／HTML／PDF）
  比內容字串本身決定重不重畫，PDF 不再每次切回來重解一次 base64。
- **打字不再每個字搬一整份檔案**：Monaco 在的時候那份影子 `<textarea>` 改成停手 200ms 才同步
  （`scheduleShadowSync`／`cancelShadowSync`），存檔與切分頁各自有更新的來源（`currentValue()`、`tab.content`）。
- **切專案會 `disposeModelsExcept`**：以前 model 照分頁 id 存著沒人收，每切一次專案就多留一整份檔案內容。
  實測 `probe-workspace-perf.js`：切走時 3 顆 → 0 顆，來回三趟都是 0。
- **終端機輸入法**：`syncImeCaret` 在 `focus`、`compositionstart` 與每次 `fitPane` 把 xterm 那個隱形
  `<textarea>` 挪到游標那一格（xterm 平常丟在 `left: -9999em`，只有游標移動時才挪，所以候選字視窗會被
  系統夾到螢幕角落）；`.composition-view` 改成終端機的反白，不再是寫死的黑底白字。
- **終端機輸出合併寫入**：排隊的片段接成一段再寫（AI CLI 串流一秒上百個小封包，逐段 await 等於每段排一次 timer）；
  `fitCurrent` 欄列數沒變就不送 resize，ResizeObserver 合併到下一幀。
- 分頁列「＋」選單八個項目各有一顆 16px 單色圖示（`ws-tool-icons.js`，零 innerHTML）。
- 新測試：`test-workspace-perf.js`、`test-terminal-ui.js`、`probe-workspace-perf.js`（打包版 18/18）。

### 2026-09-07 — 終端機跨 App 重啟持續運行

- **PTY 搬出 App**：`terminal/service.js` 是 main 的門面，真正持有 ConPTY 的是 `terminal/host.js`，
  跑在 `<userData>/terminal-host/runtime-<內容雜湊>/`——那份執行環境是 Electron exe ＋ node-pty ＋
  七支 host 檔的整套複製，**不在安裝目錄裡**，所以更新覆寫安裝檔時跑著的 shell 不受影響。
- 連線走具名管道（`\\.\pipe\voiceink-terminal-v1-<root 雜湊>`）＋ 64 hex 通行證（`connection.json`，
  目錄 ACL 只給本人／SYSTEM／Administrators），封包是有上限的 JSON 行，壞封包直接斷線。
- `before-quit` 只 `disconnect()`；已結束的終端機保留畫面（狀態 `exited`），
  明確刪除才 `forget`（結束程序、移除畫面），宿主沒有連線也沒有工作階段時 5 秒自關。
- 管理員終端機沿用同一條路：宿主用 `configureRuntime()` 讓提權 host 也從那份執行環境啟動（Rust 版：提權的是同一支 `VoiceInkTerminalHost.exe --terminal-admin-host=`）。
- 舊版執行環境會在下次 `stageRuntime` 清掉（能用 `r+` 開啟該份 exe ＝沒人在跑），Electron 版一份 248MB，Rust 版一支 568KB。

### 2026-09-07 — 終端機切換

- 跨專案保留既有 xterm 實例與輸出；切到目標終端機前不先顯示空白頁，等待期間暫停舊畫面的鍵盤操作。
- 切換終端機、從其他頁回到工作區時直接捲到底部；相同主題不重套，慢回應不能搶回已切走的分頁。
- Shift+Enter 傳送 CSI u 換行按鍵，Enter 維持送出；終端機字級為 17。

### 2026-09-07 — 沙箱測試、文件精簡、`git status` 共用快取

- **`npm run dev:sandbox`**（`scripts/dev-sandbox.js`）：在 `%APPDATA%\voiceink-dev` 另開一份 userData，
  `models`／`hf-models` 用 junction 接回真的那份、`config.json`／`workspaces.json` 複製一份、
  會累積的紀錄不接、三個會影響 userData 之外的開關強制關掉。寫入前一律先 `rm` 目的地
  （`copyFileSync` 會跟著符號連結寫到對面去）。實測 `probe-dev-sandbox.js` 8/8：
  安裝版跑著時沙箱照樣起得來、讀得到 2 組供應商與 6 顆模型與 1 個專案，真 userData 指紋前後不變。
- **`ws-git-status.js`**：`git status` 改成 in-flight 去重 ＋ 500ms 短快取，
  切分頁不再每次重打完整 `git status`；動過 git 的地方（`renderGit`、diff 分頁的暫存鈕）呼叫 `invalidateGitStatus()`。
- 聊天側欄拿掉「只看這個專案」按鈕（清單本來就短，多一顆開關只是雜訊），歸屬標籤照樣顯示。
- CLAUDE.md 與 AGENTS.md 合併成同一份內容（1372 → 289 行），CONTEXT.md 與 `tasks/` 一併精簡；
  測試 fixture 裡的機器名／MAC／內網 IP／序號改成佔位值，文件裡的本機絕對路徑改成示意路徑。

### 2026-09-07 — 工作區變更入口與滿版佈局

- 編輯器打開有 Git 變更的檔案時工具列顯示「看未提交變更」（沿用 `openDiffTab`，依暫存／工作區選比較面）；
  檔案樹的變更父資料夾顯示 `改 N`，提示列出最多四個檔名。
- `setChatPaneMode` 在工作區加 `is-workspace` 緊湊版面；切回聊天時隱藏右側欄與拖曳把手。

### 2026-09-06 — 專案真的管住工作內容（第十二輪）

- **對話與終端機歸專案**：`chats.json`／`terminals.json` 各多一個可選 `projectId`（缺值＝未分類）；
  專案切換由 `workspace-page` 發 `ws:project` 事件推給聊天頁（不互相 import）。
- **AI 記錄三件事**：家目錄改成「環境變數 → 預設 → 別的工作台的 runtime home」三處都掃、照 `agent + id` 去重、
  讀過與改過分開。卡片由 `ws-ai-session.js` 畫，接續由 main 先驗「這段對話屬於這個專案」。
- 選取內容帶入聊天（`chat:insert`）；`workspace/watch.js` 自動重讀畫面；worktree 補 `adopt`／`check`；
  Git 審閱流程（跟指定分支比、上一個／下一個變更、逐行意見「交給 AI」）拆在 `ws-review.js`。

### 2026-09-06 — 工作區的資料安全（第十一輪）／Monaco 與 worktree（第九、十輪）

- `resolveIn` 加 realpath 檢查；存檔帶 `expectedMtimeMs` → `STALE` 提示條；同檔寫入排隊；草稿由 main 等。
- 分頁狀態跟著專案走（存 `workspaces.json` 的 `tabsState`）；側欄只列專案，終端機變成分頁列上的一顆分頁。
- 編輯器換成 Monaco（AMD `min/vs`、語法高亮、真正的並排 diff，載不起來退回 `<textarea>`）；
  worktree 一區；檔案樹多選與拖曳搬檔；分頁拖曳改成 pointer 跟手＋FLIP。

### 更早（各一句）

| 時間 | 內容 |
|---|---|
| 2026-09-20 | 關掉差分下載：設定頁的更新從 ~17 分鐘降到 ~30 秒（1963 段序列 range 請求 → 一條整包）|
| 2026-09-20 | 安裝檔改走 GitHub 鏡像：APAC 官方 CDN ~50KB/s，ghfast／gh-proxy 可到 ~30MB/s；latest.yml 仍只從 GitHub 讀 |
| 2026-09-05 | 工作區適配 Orca 核心：分頁持久化、外部變更偵測、尋找取代、AI 會話卡片 |
| 2026-09-04 | 用量統計徹查：修掉 Codex 子代理重播雪崩（60 份 fork 重播出 7.8 萬筆假請求）與 Grok 花費灌水 10 倍 |
| 2026-09-04 | 使用時長（Tai 相容）、效能調整（第五、六子分頁）、App 內自動更新、使用體驗四項 |
| 2026-09-03 | 發行 v1.10.0；八組模組 IPC 收成共用外殼；管理員終端機；CC 代理 1M 上下文＋修好 Codex 502 |
| 2026-09-02 | 新增 HF模型分頁（llama-server router）；系統監控風扇控制；額度新增 Command Code；硬體規格 60 → 118 條 |
| 2026-09-01 | 語音輸入字典真的生效＋長篇重寫；壓力測試真的壓得滿（GPU 3% → 94–100%）；供應商可切回官方訂閱 |
| 2026-08-30~31 | 系統監控上線；語音輸入上線；整合 cc-switch → CC 代理工作台；三個子分頁各自的模型選單；v1.9.0 發行 |
| 2026-08-28~29 | 終端機分頁、常駐系統匣與開機自啟動、AGY token 自動續期、共用自訂下拉 |

## 已知取捨與未做

- **轉換閘道只有 Codex 的請求形狀對真上游驗過**（`probe-ccswitch-codex.js`），SSE 回程與其餘四家仍是 mock 驗的。
- **CDP 測試各自用暫存 `--user-data-dir`**：設定乾淨，但模型靠 junction 接回真的資料夾，需要資料的測試自己種。
- `probe-dictation-live.js` 需要前景焦點，只能在使用者沒在用電腦時跑。
- **Antigravity 的用量只統計得到經過本 App 反代的那一段**（本機沒有 session 記錄），UI 已明講。
- `resources/sensors/`（36MB）與 `resources/hook/`（10MB）不進版控：乾淨 clone 要出貨就先跑 `build:sensors`／`build:hook`。
- **打包環境有既知干擾**：本機的 `Orca.exe` 會抓著 `dist/win-unpacked/resources/app.asar`，
  打包必須走 `%TEMP%` ＋ 就地覆寫（步驟見 CLAUDE.md「打包／建置」）。
- **HF模型的下載與搜尋沒有進 CDP 測試**；**真的下載一顆大模型跑起來**（fit、實測調校、多模態、MoE 的 `-ot`）
  還沒做過，手上只有 0.8B／4B 的 dense 模型驗過整條路。`llama-bench` 調校也沒在大模型上驗過。
- **CUDA 執行環境沒有實際安裝驗過**（本機只裝 Vulkan 版）：第一個裝的人要確認 `ggml-cuda.dll` 真的在解壓後的根層。

## 給下一個人的三個提醒

1. **先讀 AGENTS.md 對應模組的地雷再動手**——那份清單裡的每一條都是實際改壞過的。
2. **宣告完成前一定要跑驗證並貼輸出**；UI／功能改動還要 `npm run electron:pack` 更新免安裝預覽。
3. **這個 repo 的測試跑在使用者的真實資料上**：要手動開一份來玩走 `npm run dev:sandbox`；
   CDP 只殺自己 spawn 的 PID、只用 `[data-id]` 指涉自己建的東西、語音輸入測試一定要把 `insert` 換成 stub。
