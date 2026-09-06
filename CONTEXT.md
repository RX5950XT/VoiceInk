# CONTEXT.md — 交接文件

> 只寫「現在長什麼樣」與「最近改了什麼」。規則與地雷見 [CLAUDE.md](./CLAUDE.md)＝[AGENTS.md](./AGENTS.md)（同一份），
> 可遷移的判斷原則見 [tasks/lessons.md](./tasks/lessons.md)，歷史細節查 git log。

## 專案概況

VoiceInk：Windows Electron AI 工作台。Vanilla JS + Vite（無前端框架），Electron 43.4.1 ＋ Node.js 22。
已發行 **v1.13.0**（工作區換上 Monaco／worktree／檔案狀態；前幾版為 App 內自動更新、管理員終端機、
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
                      ipc.js、admin.js／admin-host.js（管理員終端機的提權 host）
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
  ws-monaco.js  ws-ai-session.js  ws-review.js  ws-git-status.js（git status 共用快取）
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
