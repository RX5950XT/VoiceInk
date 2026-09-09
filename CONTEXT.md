# CONTEXT.md — 交接文件

> 只寫「現在長什麼樣」與「最近改了什麼」。規則與地雷見 [CLAUDE.md](./CLAUDE.md)＝[AGENTS.md](./AGENTS.md)（同一份），
> 可遷移的判斷原則見 [tasks/lessons.md](./tasks/lessons.md)，歷史細節查 git log。

## 專案概況

VoiceInk：Windows Electron AI 工作台。Vanilla JS + Vite（無前端框架），Electron 43.4.1 ＋ Node.js 22。
目前版本 **v1.19.0**（終端機 WebGL／搜尋／字級／分割／標題與 cwd、Git 面板重整、終端機桌布、工作列圖示修復；前幾版為 App 內自動更新、管理員終端機、
全域語音輸入、系統監控、HF模型、CC 代理工作台）。

nav 九頁：聊天（預設，**專案工作區與終端機都在同一頁**）｜CC代理（`data-page` 仍是 `ccswitch`）｜額度｜
AGY反代｜語音轉文字｜翻譯與 TTS｜系統監控｜HF模型｜設定。

## 架構

```
src/main/
  main.js             frameless 主窗、IPC 註冊、store allowlist 與一次性遷移、單一實例鎖與系統匣
  updater.js          App 內自動更新（electron-updater ＋ GitHub Releases 的 latest.yml）；
                      結束前在 app.exit(0) 前一行靜默安裝（autoInstallOnAppQuit 對本 App 無效）
  chat.js             雲端聊天 SSE；單一 in-flight、雙逾時、上下文裁切、model allowlist、圖片與生圖、重新生成
  chat-store.js / chat-images.js / chat-models.js   會話持久化、圖片附件、/models 掃描（與 ccswitch 共用）
  ipc-invoke.js       九組模組 IPC 的共用外殼 makeInvoke()：主視窗守衛 ＋ { ok, data|error } ＋ userMessage 白名單
  terminal/           ConPTY：pty.js、status.js（OSC 133 ＋ 靜默雙軌，純函式）、store.js（固定表）、
                      ipc.js、links.js（畫面上的網址／路徑，主行程驗存在再開）、
                      admin.js／admin-host.js（管理員終端機的提權 host）、
                      host.js／host-runtime.js／host-client.js／service.js（**PTY 住在 App 外的獨立宿主**）、
                      editor-bridge.js（Ctrl+G 的 $EDITOR 橋接：CLI 開的編輯器就是 App 自己的分頁）
  workspace/          專案工作區：store.js（workspaces.json）、files.js（**唯一的檔案系統入口**，resolveIn）、
                      git.js（porcelain=v2 -z 解析＋commit／push／審閱）、agents.js（本機 AI session）、
                      worktree.js、watch.js（一次看一個專案的 recursive watcher）、index.js、ipc.js
  hfmodels/           hub.js（HF API 唯讀）、catalog.js、gguf.js（檔頭＋KV 估算）、hardware.js、plan.js、
                      fit.js（官方 llama-fit-params）、download.js、library.js、presets.js（INI）、
                      runtime.js（router 生死）、bench.js、index.js、ipc.js
  ccswitch/           claude-settings.js（外科式改 env）、presets.js、providers.js（路由推導）、
                      models-scan.js、mcp.js、versions.js、credential.js、gateway/（server.js、oauth.js）
  codeusage/          scan.js（增量游標）、parsers.js（五家逐行）、pricing.js（單價＋RULES_VERSION）、index.js
  sysmon/             probe.ps1 常駐取樣器、metrics.js（純函式差值）、sampler.js、gpu.js、bench.js、
                      stress.js、sensors.js（提權 sidecar 雙向橋接）、sensors-task.js、fans.js、
                      oc.js（效能調整）、pawnio.js（代裝＋驗簽）、ipc.js
  screentime/         使用時長：Tai 相容 SQLite、前景觀測、8908 WebSocket、統計查詢
  usage/              七家額度 provider（全走官方端點）、api-key.js、6h soft cache、受限 IPC
  agy/                server.js（127.0.0.1＋強制金鑰）、OpenAI/Anthropic ⇄ Gemini 雙向轉換、
                      catalog.js／model-map.js、credential.js（nudgeCli 續期）、logs.js
  dictation/          index.js（管線）、hotkey.js（原生 sidecar／uiohook 雙路徑）、hook.js、
                      text.js（切段／字典／清理）、hud.js（指示器視窗）
  model-scope.js      三個子分頁各自的模型選擇：唯一解析點
  asr-select.js       本地 ASR 門面（依 scope 分流）；engine／file-transcribe／IPC 都只認它
  local-asr.js（sherpa CPU）／llama-asr.js（llama-server GPU）／cloud-asr.js（/audio/transcriptions）
  local-llm.js  translate-clean.js  file-transcribe.js  models.js  edge-tts.js  engine.js  opencc.js

src/renderer/scripts/
  app.js  chat-page.js  markdown.js（零 innerHTML）  terminal-page.js  ccswitch-page.js  sysmon-page.js
  usage-page.js  code-usage-page.js  agy-page.js  stt-page.js  transcribe.js  live-caption.js  vad.js
  translate-page.js  dictation.js  model-picker.js  custom-select.js（共用 ARIA listbox）
  workspace-page.js（專案側欄＋右側欄四面板＋檔案樹）  ws-tabs.js（分頁列＋編輯器＋內建瀏覽器）
  ws-monaco.js  ws-ai-session.js  ws-review.js  ws-git-status.js（git status 共用快取）  ws-tool-icons.js（「＋」選單圖示）
  list-reorder.js  grid-reorder.js  hf-page.js  sysmon-fans.js  sysmon-oc.js  sysmon-screentime.js

native/  dictation-hook/（WH_KEYBOARD_LL → resources/hook/）  sysmon-sensors/（→ resources/sensors/）
scripts/ 測試與探針（指令表見 CLAUDE.md「驗證方式」），dev-sandbox.js ＝ npm run dev:sandbox
```

### 資料落點（皆在 `%APPDATA%/voiceink/`）

| 檔案 | 內容 | 存取 |
|---|---|---|
| `config.json` | 一般設定 | `store:*`（**key 僅 allowlist**） |
| `chats.json` ／ `chat-images/` | 聊天會話（不含圖片）／圖片附件 | `chat:*`；檔名由 main 產生 |
| `terminals.json` | 終端機 metadata（不存畫面內容） | `terminal:*` |
| `workspaces.json` | 專案清單（`{ id, name, path }`＋`tabsState`） | `workspace:*` |
| `dictations.json` | 語音輸入紀錄與個人字典 | `dictation:*` |
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

### 2026-09-09 — 終端機切回來畫面錯亂、Ctrl+G 改用 App 內的編輯器

- **畫面重複／被切一半的根因是欄列數沒同步**：`openSession` 切回舊分頁時只 `fitPane`
  不送 resize，那一格被藏起來的期間版面被拉過就對不上——Claude Code／Codex 這種整畫面
  重畫的 CLI 會照舊寬度再貼一次，看起來就是狀態列兩份、右邊被切掉半行。改走
  `fitAndSync`（量完欄列數變了才送）。回歸 `test-terminal-ui.js`。
- **Ctrl+G 不再彈記事本**：`terminal/editor-bridge.js` 產生一支純 batch 當 `EDITOR`，
  CLI 呼叫它時 batch 把檔案複製成 `<id>.in` 並卡住等 `<id>.done`；App 收到就開一個
  提示詞編輯分頁，按「送出」寫出 `<id>.out` ＋ `.done`，batch 自己蓋回原檔後退出。
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
  折行的一列要往回接成整條邏輯行再掃。實測 `probe-terminal-links.js`（真 xterm、真滑鼠事件）。
- 新測試：`test-terminal-links.js`（32 項）、`probe-terminal-links.js`（4 項）。

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
- 管理員終端機沿用同一條路：宿主用 `configureRuntime()` 讓提權 host 也從那份執行環境啟動。
- 舊版執行環境會在下次 `stageRuntime` 清掉（能用 `r+` 開啟該份 exe ＝沒人在跑），一份 248MB。

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

1. **先讀 CLAUDE.md 對應模組的地雷再動手**——那份清單裡的每一條都是實際改壞過的。
2. **宣告完成前一定要跑驗證並貼輸出**；UI／功能改動還要 `npm run electron:pack` 更新免安裝預覽。
3. **這個 repo 的測試跑在使用者的真實資料上**：要手動開一份來玩走 `npm run dev:sandbox`；
   CDP 只殺自己 spawn 的 PID、只用 `[data-id]` 指涉自己建的東西、語音輸入測試一定要把 `insert` 換成 stub。
