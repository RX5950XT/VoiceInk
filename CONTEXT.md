# CONTEXT.md — 開發紀錄交接文件

> 給下一個 AI Agent 的接手指南。**只寫「現在長什麼樣」與「最近改了什麼」**，
> 規則與地雷見 [CLAUDE.md](./CLAUDE.md)（唯一權威清單），作業守則見 [AGENTS.md](./AGENTS.md)，
> 可遷移的判斷原則見 [tasks/lessons.md](./tasks/lessons.md)。歷史細節查 git log。

## 專案概況

VoiceInk：Windows Electron AI 工作台。Vanilla JS + Vite，無前端框架；Electron 43.4.1 ＋ Node.js 22。
已發行 **v1.12.0**（應用程式內自動更新；前幾版為管理員終端機、全域語音輸入、系統監控、HF模型、CC 代理工作台）。

nav 九頁：聊天（預設，**終端機在同一頁**）｜CC代理（原「Claude Code」，data-page 仍是 `ccswitch`）｜額度｜AGY反代｜語音轉文字｜翻譯與 TTS｜系統監控｜HF模型（本機 LLM）｜設定。

## 架構

```
src/main/
  main.js             frameless 主窗、IPC 註冊、store allowlist 與一次性遷移、單一實例鎖與系統匣
  updater.js          應用程式內自動更新（electron-updater ＋ GitHub Releases 的 latest.yml）：
                      開機後 20 秒與每 6 小時靜靜檢查一次、狀態推播給設定頁、
                      結束前在 app.exit(0) 之前靜默安裝（autoInstallOnAppQuit 對本 App 無效）
  chat.js             雲端聊天 SSE；單一 in-flight、雙逾時、上下文裁切、model allowlist、
                      提示 preset、reasoning 分流、圖片多模態、生圖、重新生成
  chat-store.js       會話持久化（獨立 store → <userData>/chats.json）
  chat-images.js      圖片附件：<userData>/chat-images/，檔名 allowlist、孤兒回收
  chat-models.js      /models 掃描（fetchModels／extractIds，聊天與 ccswitch 共用）
  ipc-invoke.js       八組模組 IPC 的共用外殼 makeInvoke()：主視窗守衛 ＋ { ok, data|error }
                      ＋ userMessage 白名單（handler 仍由各模組自己逐一列舉）
  terminal/           ConPTY 工作階段：pty.js、status.js（OSC 133 ＋ 靜默雙軌，純函式）、
                      store.js（shell／preset／cwd 固定表）、ipc.js、
                      admin.js（管理員終端機：起提權 host、偽裝成 IPty）、admin-host.js（提權那一端）
  ccswitch/           Claude Code 工作台：claude-settings.js（外科式改 env）、presets.js、
                      providers.js（路由推導）、models-scan.js、mcp.js、versions.js、credential.js、
                      gateway/（server.js 路由與轉換、oauth.js device code／PKCE）
  codeusage/          本機用量統計：scan.js（增量游標）、parsers.js（五家逐行）、pricing.js
                      （單價＋RULES_VERSION）、index.js（每小時桶／stats）
  sysmon/             系統監控：probe.ps1 常駐取樣器、metrics.js（純函式差值）、sampler.js、
                      gpu.js（nvidia-smi）、bench.js（磁碟測速）、stress.js（CPU／記憶體）、
                      sensors.js（提權 sidecar 雙向橋接）、sensors-task.js（免 UAC 啟動的排程工作）、
                      fans.js（風扇曲線引擎：內插／遲滯／斜率／下限／panic）、
                      pawnio.js（代裝＋驗簽）、ipc.js
  usage/              七家額度 provider（全走官方端點）、bounded HTTPS／Credential Manager bridge、
                      api-key.js（env → OpenCode auth.json → CC 代理 store）、6h soft cache、受限 IPC
  agy/                本機反向代理：server.js（127.0.0.1＋強制金鑰）、OpenAI/Anthropic ⇄ Gemini
                      雙向轉換、catalog.js／model-map.js、credential.js（nudgeCli 續期）、logs.js
  dictation/          語音輸入：index.js（管線）、hotkey.js（原生 sidecar／uiohook 雙路徑）、
                      hook.js（sidecar 生命週期）、text.js（切段／字典／清理）、hud.js（指示器視窗）
  hfmodels/           HF模型（本機 LLM）：hub.js（HF API 唯讀）、catalog.js（量化／分片／mmproj 歸組）、
                      gguf.js（檔頭解析＋KV 估算＋激活參數）、hardware.js（`--list-devices`）、
                      plan.js（參數決策，純函式）、fit.js（跑官方 llama-fit-params 拿實測值）、
                      download.js（續傳）、library.js（磁碟是唯一真相）、presets.js（INI）、
                      runtime.js（router 生死）、bench.js（llama-bench 實測調校）、index.js、ipc.js
  model-scope.js      三個子分頁（file／live／dictation）各自的模型選擇：唯一解析點
  asr-select.js       本地 ASR 門面（依 scope 分流）；engine／file-transcribe／IPC 都只認它
  local-asr.js        sherpa-onnx（CPU）／ llama-asr.js  llama-server sidecar（Vulkan GPU）
  cloud-asr.js        OpenAI 相容 /audio/transcriptions（asrClouds：一組設定多顆模型）
  local-llm.js        翻譯 cloud/local；多 GGUF；LINGUAFORGE_DECODE 查表
  translate-clean.js  譯文清理（純文字、無 electron 依賴、可 node 直測）
  file-transcribe.js  ffmpeg 串流 16k mono → 28s 切段
  models.js           模型 registry（archive 型別走 Expand-Archive）／gpu-capability.js／cuda-env.js
  edge-tts.js  engine.js（owner live|file|translate）  opencc.js（s2twp 共用）

src/renderer/scripts/
  app.js  設定頁與分頁切換     chat-page.js  markdown.js（零 innerHTML）
  terminal-page.js  ccswitch-page.js  sysmon-page.js  usage-page.js  code-usage-page.js  agy-page.js
  stt-page.js（三個子分頁）  transcribe.js  live-caption.js  vad.js  translate-page.js
  dictation.js（錄音與熱鍵事件）  model-picker.js  custom-select.js（共用 ARIA listbox）
  list-reorder.js（聊天與終端機側欄拖曳）  hf-page.js（探索／模型庫／執行環境三個子分頁）
  sysmon-fans.js（機殼示意圖 SVG ＋ 可拖點的轉速曲線編輯器）

native/  dictation-hook/（WH_KEYBOARD_LL，→ resources/hook/）  sysmon-sensors/（→ resources/sensors/）
```

### 資料落點

| 檔案 | 內容 | 存取 |
|---|---|---|
| `config.json` | 一般設定 | `store:*`（**key 僅 allowlist**） |
| `chats.json` | 聊天會話（不含圖片） | `chat:*` |
| `chat-images/` | 圖片附件與生圖 | main 產生檔名 |
| `terminals.json` | 終端機 metadata（不存畫面內容） | `terminal:*` |
| `dictations.json` | 語音輸入紀錄與個人字典 | `dictation:*` |
| `usage.json` | 七家額度快取 | `usage:*` |
| `code-usage.json` | 每小時 × 供應商 × 模型的用量桶＋掃描游標 | `codeusage:*` |
| `agy-logs.db` | AGY 流量日誌（node:sqlite） | `agy:*` |
| `claude-backup/` | `~/.claude/settings.json` 寫入前的備份 | ccswitch |
| `models/<key>/` | 下載的模型與 llama.cpp 執行環境 | `models:*` |
| `hf-models/<id>/` | HF模型的本機模型庫（一顆一夾，含 `voiceink-meta.json`）。路徑可由 `hfModelsDir` 改到別的碟 | `hfmodels:*` |
| `hf-presets.ini` | router 的 `--models-preset`（每顆模型實際的執行參數） | main 產生 |

（皆在 `%APPDATA%/voiceink/`。AGY 設定與終端機、聊天、語音輸入紀錄**刻意不進** `STORE_ALLOWLIST`；
`hfToken` 同理——它是機密，只走 `hfmodels:setToken`，renderer 讀不到。）

### 三個子分頁的模型選擇

`src/main/model-scope.js` 是唯一解析點；三組 key 共用同一份 sanitize。

| scope | ASR key | LLM key | 用途 |
|---|---|---|---|
| `file` | `fileAsr` | `fileLlm` | 檔案轉錄 |
| `live` | `liveAsr` | `liveLlm` | 即時字幕 |
| `dictation` | `dictationAsr` | `dictationLlm` | 語音輸入（唯一可選「不使用」） |

值格式：ASR＝`local:<key>`／`cloud:<設定 id>:<模型 id>`；LLM＝`local:<key>`／`cloud:<供應商 id>:<模型 id>`／`''`。
翻譯與 TTS 頁**不在這組**，維持全域 `translator`／`localTranslateModel`／`translateProviderId`／`translateModelId`。

## 最近變更（2026-09-04，分支 `feat/voice-input`）— 應用程式內自動更新

**已發行 v1.12.0**（tag `v1.12.0`、master 與 feat/voice-input 同步、GitHub Release 帶
`VoiceInk-Setup-1.12.0.exe` ＋ `.blockmap` ＋ `latest.yml`）。

- **`src/main/updater.js`**：electron-updater ＋ GitHub Releases。開機後 20 秒與每 6 小時
  靜靜檢查一次，狀態推播給設定頁；設定 → 基本有「自動下載新版本」開關、「檢查更新」、
  下載完才出現的「重新啟動並安裝」。
- **`autoInstallOnAppQuit` 對這個 App 無效**：它掛的是 `app.once('quit')`，而 `before-quit`
  收完子程序走的是 `app.exit(0)`（不發 quit 事件）。所以「結束時裝好」是 main.js 在
  `app.exit(0)` **前一行**呼叫 `updater.installOnQuit()`，順序不可對調。
- **`build.publish` ＋ `nsis.artifactName` 兩個設定缺一不可**：前者不設就不會產出 `latest.yml`
  （舊版永遠檢查不到更新），後者改回預設會讓檔名帶空白、上傳 GitHub 後跟 `latest.yml` 對不上而 404。
  發行時三個檔案都要上傳，流程見 CLAUDE.md「發行流程」。
- **更新不留殘留**：新安裝檔會先跑舊版的解除安裝程式（`/S /KEEP_APP_DATA --updated`），
  `RMDir /r $INSTDIR` 把安裝目錄清空再解壓新版；`%APPDATA%\voiceink\` 完全不碰
  （我們沒設 `deleteAppDataOnUninstall`），開機自啟動的 HKCU Run 機碼與風扇排程工作也都不受影響。
- 順手移除雲端語音轉文字「轉錄模型 ID」欄位上那份寫死四顆的 datalist（會蓋住輸入框）。
- 回歸：`node scripts/test-updater.js`、`node scripts/e2e-update-cdp.js`（打包版，會真的連一次 GitHub）。

## 前一次變更（2026-09-03，分支 `feat/voice-input`）— 終端機可以用系統管理員身分開

**已發行 v1.11.0**（tag `v1.11.0`、master 與 feat/voice-input 同步、GitHub Release 帶
`VoiceInk-Setup-1.11.0.exe`）。

- **新終端機對話框多了「以系統管理員身分執行」**（`admin` 布林，跟 shell／preset 一樣存在
  `terminals.json`）；側欄那一列會多一顆「管理員」pill。
- **為什麼要多一顆程序**：ConPTY／CreateProcess 一律繼承呼叫者的 token，而唯一拿得到管理員
  token 的 `ShellExecute runas`（UAC）交接不了 pty handle。所以把**自己**用
  `Start-Process -Verb RunAs` 再開一份、帶 `--terminal-admin-host=<具名管道>`，
  提權那份開 pty、把位元組透過管道轉回來。`main.js` 最前面就攔下這個旗標（**在 single
  instance lock 之前**，否則第二份會被自己 quit 掉），不建視窗、不註冊 IPC、userData 指到 temp。
- **一顆 host 服務所有管理員階段**：UAC 只在第一個管理員終端機時跳一次；socket 一斷，
  host 就把管理員 shell 全部 kill 再自己結束（`before-quit` 會走到 `killAll` → `admin.shutdown()`）。
- `pty.js` 只多一個分支：admin 時 `term` 換成 `admin.spawnAdmin()` 回的 IPty-like 物件，
  scrollback／忙碌判定／flush 一行沒動。shell 解析抽成 `pty.shellCommand()`，提權那端共用同一份。
- 回歸：`node scripts/test-terminal.js` 60/60、`node scripts/probe-terminal-admin.js` 6/6（不需 UAC）、
  `probe-terminal-admin-elevate.js` 4/4（**跳一次 UAC**，實測 shell 的 `IsInRole('Administrators')` 是 True）。

## 最近變更（2026-09-03）— 發行 v1.10.0 ＋ 八組模組 IPC 收成共用外殼

- **版本**：`package.json` 1.9.0 → **1.10.0**，README 改寫版本區塊並補上缺的「系統監控」章節與
  「用量統計」子分頁說明；GitHub 倉庫 About 一併更新。
- **`src/main/ipc-invoke.js`（新）**：agy／ccswitch／codeusage／dictation／hfmodels／sysmon／
  terminal／usage 八份 `ipc.js` 各自抄了一段一字不差的
  「`isMainSender` 守衛 → try → `{ ok, data }` → catch → `{ ok, error }`」，收進 `makeInvoke()`。
  **只收掉那段 try/catch，handler 仍由各模組逐一列舉**（service 加方法卻漏一行的坑照舊存在，
  那是刻意的白名單）。usage 與 hfmodels 的錯誤收斂規則不同，走 `publicError` 覆寫。
  回歸：`node scripts/test-ipc-invoke.js` 11/11。

## 最近變更（2026-09-03，分支 `feat/voice-input`）— CC 代理：1M 上下文開關＋修好 Codex 502

- **Codex 一直 502 的真正原因**：ChatGPT 後端的 `/responses` 不是公版——不明寫 `store: false`
  回 400 `Store must be set to false`，帶 `max_output_tokens` 或 `temperature` 回 400
  `Unsupported parameter`。閘道把所有非 429 的上游狀態碼收斂成 502，所以畫面上只看得到 502。
  修法是 `gateway/convert.forCodexBackend()`（只對 `route.auth === 'codex'` 套），
  「測試」鈕的 `models-scan.probeBody()` 也套同一份。實測矩陣 `scripts/probe-ccswitch-codex.js`。
- **新增「宣告支援 1M 上下文」勾選**（供應商彈窗的模型四格下面，tile 第二行會顯示 `· 1M`）：
  照 cc-switch 的作法在四個等級的模型名尾巴加 `[1m]`，Claude Code 看到就把上下文窗當成 1M；
  同時把 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 與 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 一起設成 1000000
  （只加後綴的話 Codex preset 釘住的 372000 會把自動壓縮門檻夾回去）。
  存在 `cc-providers.json` 的 `context1m`，官方訂閱那筆照樣什麼都不寫。
- **`[1m]` 的實測結論**（本機 sink 收 Claude Code 真流量，不是看文件猜的）：
  後綴是唯一開關（單設 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 不會送 1M beta）；
  現行版本的 Claude Code **自己會把後綴剝掉**再送上游，並自己在 `anthropic-beta` 補
  `context-1m-2025-08-07`，所以直連那幾家（OpenRouter／自訂）開 1M 不會打壞。
  `gateway/server.js` 的 `convert.stripContextMarker()` 是**防舊版**（cc-switch issue #3980
  記錄舊版會原樣送出），上游不認（實測 Codex 400 model is not supported）。
- 跟 cc-switch 對過的地方：Codex 預設（`gpt-5.6-sol`／`gpt-5.6-luna`＋雙鍵釘 372000）、
  OpenCode Go（`deepseek-v4-flash`＋`ANTHROPIC_API_KEY`）、OpenRouter 四格模型**與他們一字不差**；
  Codex 請求整形也對過他們的 `transform_responses.rs`（`store:false`／刪 `max_output_tokens`／
  刪 `temperature`／刪 `top_p`，我們本來就不送 `top_p`）。他們多送的
  `include: ["reasoning.encrypted_content"]` 我們用不到——我們的轉換一律丟掉 thinking block，
  實測工具往返兩輪（function_call → function_call_output）不帶它照樣 200。
- 驗證：`node scripts/test-ccswitch.js` 255/255、`node scripts/e2e-ccswitch-gateway.js` 40/40、
  `node scripts/test-ccswitch-gateway.js` 53/53、`node scripts/test-error-hygiene.js` 82/82、
  `node scripts/probe-ccswitch-codex.js` 7/7（打真 Codex）、
  `node scripts/e2e-ccswitch-cdp.js` 125/125、`node scripts/e2e-visual-cdp.js` 71/71（打包版）。

## 最近變更（2026-09-03，分支 `feat/voice-input`）— CC 代理改為手動閘道與上游格式（清理多餘驗證格式）

- 移除切換供應商時自動啟動閘道；頁面只留一顆 `role=switch` 開關，啟停完全由使用者操作。
- 清理多餘的「驗證格式（validationFormat）」，僅保留「上游格式（apiFormat）」：測試上游端點時一律直接使用選定的上游格式送最小請求驗證連線。
- 六家內建供應商各自保存 `apiFormat`（上游格式），舊資料讀入會回到新的官方預設：
  Grok／Codex／Ollama Cloud／OpenCode Go＝OpenAI Responses；Command Code＝OpenAI Chat；OpenRouter＝Anthropic Messages。
- 內建 URL 仍由 main 固定，`wireBaseUrl` 只供閘道／測試組成路徑；自訂 URL 仍只接受 `http(s)`。新增 `ccswitch:testProvider` 與 tile「測試」鈕，測試只回固定摘要（成功／是否收到 HTTP／狀態碼／延遲），不讀上游 body。
- 官方依據： [xAI REST API](https://api.x.ai/docs/)／[Grok Build README](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/README.md)、[OpenAI Codex](https://openai.com/index/unrolling-the-codex-agent-loop/)、[Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)、[Ollama Cloud](https://docs.ollama.com/cloud)、[OpenCode Go](https://dev.opencode.ai/docs/go/)、[Command Code provider](https://commandcode.ai/docs/provider)、[OpenRouter Anthropic Messages](https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-messages?explorer=true)。
- 驗證：`node scripts/test-ccswitch.js` 250/250、`node scripts/test-ccswitch-gateway.js` 53/53、`node scripts/e2e-ccswitch-gateway.js` 35/35、`node scripts/test-error-hygiene.js` 82/82、`node scripts/probe-ccswitch-endpoints.js` 六端點均回 401。

## 最近變更（2026-09-02，分支 `feat/voice-input`）— 系統監控新增「風扇控制」子分頁

視覺化調整系統與 CPU 風扇轉速（SIV／FanControl 那件事），走的是專案已經有的
LibreHardwareMonitorLib sidecar，**沒有新增任何依賴**。

### 1. 先實測能不能做，再決定要不要做

`ISensor.Control.SetSoftware(0~100)` / `SetDefault()` 就是全部 API。本機（X570 AORUS PRO +
5700X + RTX 5060 Ti）實測 9 條可寫 PWM 通道、**8 條有接風扇的全部真的會動**：
CPU Fan 1527→740、System Fan #1 3230→**9507**、PCH Fan 0→5232、GPU Fan 走 NVAPI（下限 30%）。

能力邊界（要對使用者講實話）：ITE IT87xx／Nuvoton NCT67xx／Fintek F718xx（＝絕大多數桌機主機板）
＋ NVIDIA／AMD 顯卡 ＋ 部分 AIO 控制器。**筆電幾乎都不行**（廠商自訂 EC）。

### 2. 兩個實測踩到的坑，決定了整個設計

- **手動 PWM 留在晶片裡**：設 100% 後硬殺程序，8 秒後另一支程序重讀仍是 100%。
- **`SetDefault()` 救不回來**：它只還原「自己 Open 當下的快照」，用**全新**程序還原無效
  → 只有**重新開機**才會回到 BIOS 曲線。

所以安全機制不是選配：每條通道下限 `minPwm`（≥20，預設 30）、sidecar 5 秒看門狗、
`before-quit` await 得到的交還、`dirty` 旗標偵測「上次沒正常收尾」並在 UI 講明要重開機。

### 3. sidecar 改成雙向（`native/sysmon-sensors/Program.cs`）

指令一行一個、空白分隔（`S <id> <0~100>` / `D <id>` / `R` / `P`），payload 加 `"c"`（可控通道）。
**`PipeOptions.Asynchronous` 不可省**——不帶它，同一 handle 上的同步讀會把同步寫整個擋住，
症狀是只收到第一框、之後永遠「感測器沒有連線」，而且完全不報錯（詳見 CLAUDE.md 地雷）。

### 4. 開機接管走排程工作（`sensors-task.js`）

`-Verb RunAs` 每次都彈 UAC，開機自啟動時等於不可用。改成註冊一個**沒有觸發程序**、
`RunLevel Highest`、`ExecutionTimeLimit 0` 的工作（建立時一次 UAC），之後 `schtasks /run`
提權且不再提示；管道名走交接檔 `<userData>/sensors-handoff.txt`（sidecar 讀完立刻刪）。
**只有打包版能安裝**（開發版執行檔在可寫目錄＝提權後門）。沒有工作就安靜退回 `-Verb RunAs`。
App 啟動時 `initStore()` 之後直接 `ensureFanControl()`，**不必開系統監控頁**。

### 5. UI（`sysmon-fans.js`，放在「壓力測試」右邊）

版面是**左示意圖／右通道清單**，點清單任一列就地向下展開設定（手風琴）。

- **等角機殼示意圖（斜上方視角）**：SVG 由世界座標 `(x 深度, y 寬度, z 高度)` 投影出來，
  風扇是「單位圓 + 平面基底矩陣」，所以躺在哪一面就跟著那一面傾斜。晶片只給接頭名稱、
  給不出實體位置，所以是通用槽位（13 個）＋使用者指派；`System Fan #N` 會先猜一個預設位置
  （空的示意圖等於請使用者憑空想像）。關鍵仍是**「識別」按鈕**——拉到 100% 四秒，用聽的認。
  槽位上只印**短代碼**（前1／後／CPU…），全名走 `<title>`／`aria-label`。
  扇葉用 CSS animation，`animation-duration` 跟著即時 RPM 成正比，但整體放慢 `SPIN_SCALE` 倍
  （真實轉速在 60fps 下只會糊成一團）。
- **曲線編輯器**：X 是來源值（CPU/GPU 溫度或使用率、NVMe、主機板；都是 0~100 所以同一個元件通吃），
  **Y 是 PWM 不是 RPM**（能寫的只有 PWM，標 RPM 是騙人），圖上疊即時光點與垂直參考線、
  下限以下畫成禁區、曲線下方填色。拖點／點空白新增／Delete 刪除，鍵盤可操作；拖曳中顯示座標讀數。
- 三個校正旋鈕：遲滯 2°C、斜率上限 5%/秒、3 次移動平均。緊急放手（`panicTemp` 90°C）
  **用未平滑的原始值**判斷，慢三秒就失去意義。
- 「接管風扇」是自繪開關、「建立排程工作」與「全部還原 BIOS」收在同一條操作列右側（等高對齊）。
  `#fanEditor` 只有一份，由 JS 搬進展開的那一列；**沒有展開時要掛回清單底下**（脫離 DOM 就再也找不回來）。

### 6. 其他

`fanControl` **不進 `STORE_ALLOWLIST`**，一律走 `sysmon:fan*` IPC，identifier 由 main 對照
即時通道清單驗過。`main.js` 的 `registerSysmonIpc({ service })` 白名單補了八個方法
（漏掉時 renderer 只會拿到通用錯誤，單元測試全綠、只有打包版點下去才發現——踩過一次）。

**驗證**：`node scripts/test-sysmon-fans.js` 52 passed／`node scripts/e2e-sysmon-fans-cdp.js` 22 passed／
`node scripts/probe-sysmon-fans.js`（實機 7 條風扇 100%/40% 全部 CONTROLLABLE，引擎接管後正常交還）／
`node scripts/probe-sensors-task.js` 8 passed（免 UAC 啟動實測通過）／
既有回歸 `test-sysmon.js` 172／`e2e-sysmon-cdp.js` 112／`e2e-visual-cdp.js` 71 全綠。

## 再上一批（2026-09-02，分支 `feat/voice-input`）— 新增「HF模型」分頁（本機 LLM，LM Studio 等價）

在 Hugging Face 搜 GGUF → 下載 → 一鍵載入 → **直接出現在聊天的模型選單**。
推論引擎是 llama.cpp，參數自動決定但每一項都可覆寫。

### 1. 架構押在 llama-server 的 **router 模式**（先實測才動手）

`probe-hf-router.js` 是第一步就寫的，因為它決定其他一切。實測結論（全 PASS）：

| 問題 | 實測答案 |
|---|---|
| 不給 `-m` 只給 `--models-dir` 起得來嗎 | 起得來，`/health` → 200 |
| 模型 id 怎麼來 | **單檔＝檔名去 `.gguf`；子資料夾＝資料夾名**（不是裡面的檔名） |
| `--api-key` | 有效：不帶 401、帶了 200 |
| `--models-preset` | 吃得到；`[*]` 套全部、`[<id>]` 蓋掉它（實測 `c = 3072` → `--ctx-size 3072`） |
| mmproj | 同夾的 `mmproj-*.gguf` **自動加 `--mmproj`**，`input_modalities` 跟著變 → **多模態零程式碼** |
| `GET /models` | `data[]` 帶 `status.value`／`status.args`（真正的命令列）／`status.preset`／`architecture`／`source`；**載入後多一個 `meta`**（`n_params`／`n_ctx_train`／`ftype`…） |
| load／unload／autoload | `POST /models/load｜unload` 回 `{success:true}`；沒先 load 直接聊也會自己載入 |
| `?reload=1` | 有效 → **「手動把 gguf 拖進資料夾」零程式碼** |
| 收程序 | kill router → 子 `llama-server` 一起走（實測 2 → 0），**不必自己追子 pid** |

⇒ **不寫多模型程序管理器**，一顆 router 就是 LM Studio 的伺服器。

### 2. 參數決策三層（估算 → 官方實測 → 使用者）

- **`plan.js`（估算）**：用在下載前的預覽（檔案還不在本機）與 fit 失敗的退路，
  以及 fit 不管的策略（KV 量化檔位、投機解碼、執行緒、多模態裝置、`n-cpu-moe`、`tensor-split`）。
- **`fit.js`（實測）**：下載完跑一次官方 `llama-fit-params`（它會真的載一次模型量記憶體），
  拿到的 `-c/-ngl/-ts/-ot` 蓋掉估算。MoE 的 `-ot` regex 手寫不出來也估不出來。
- **使用者覆寫**：每一項都可以填（空著＝自動，placeholder 顯示自動值），
  另外有「原始參數」多行框直通 INI（**這就是比 LM Studio 自由的地方**），
  以及「實測調校」按鈕跑 `llama-bench` 比 KV 檔位與投機解碼的候選矩陣。

**修掉一個會 OOM 的估算錯誤**：原本的 `kvCacheMiB` 拿 `embedding_length ÷ head_count` 當 head_dim，
但 GGUF 明寫 `attention.key_length`——實測 Qwen3.5-4B 的 `embd/hc` 是 160、`key_length` 是 256，
KV 被低估 1.6 倍（linguaforge 0.8B 是 **2 倍**）→ `gpu-layers` 給太多 → 載入時 OOM。
`gguf.js` 改成優先讀明寫的那兩格，缺了才推導（**不可回 0**）。回歸：`test-hfmodels.js` 的 [D2]。

### 3. 聊天串接：synthetic provider `__local`

router 跑著時 `chat.allProviders()` 多回一筆「本機模型」（`apiUrl` = `http://127.0.0.1:<port>/v1`）。
llama-server 本身就是 OpenAI 相容端點，所以**整條聊天管線一行都不用改**。三個要點：
① `sanitizeProviders`（跑在存檔路徑上）**必須過濾掉它**，否則會把死掉的埠號寫進 `config.json`；
② `reconcileProviderSelection` 遇到它直接 return（否則編輯雲端供應商會順手改掉本機選擇）；
③ 選了未載入的模型時 `chat.send` 先 `ensureLocalModel`，**那個 await 一定在 inflight 佔位之後**。
renderer 的模型選單改成向 main 要（`chat:providerOptions`），自己讀 `chatProviders` 看不到合成的那筆。

### 4. 其他

- **CUDA 執行環境**（`llamaruntimecuda`，可選）：llama ＋ cudart 兩個 zip 解到同一夾，
  少了 cudart 會在啟動時因為找不到 DLL 直接結束。UI 只在 NVIDIA 驅動 ≥ 580 時建議裝。
- **模型資料夾可自選**（`hfModelsDir`）：30B MoE 動輒 20GB，C 碟未必塞得下。換資料夾**不搬移舊檔**。
- **`hfToken` 不進 `STORE_ALLOWLIST`**：只走 `hfmodels:setToken`，回給 renderer 的只有 `{ hasToken }`。
- **踩到一條舊地雷**：`closeParams()` 裡 `editing = null` 後面接一行以 `(` 開頭的 JSDoc cast，
  被 ASI 併成 `null(...)` → 存完參數彈窗關不掉。cast 一律先接成變數。

**驗證**：`test-hfmodels` 146 passed／`test-error-hygiene` 82 passed（+17：HF 的錯誤衛生與路徑正規化）／
`e2e-chat` 138 passed（+8：synthetic provider 的 [O]）／`e2e-hfmodels` 24 passed（真的起 router、載入、發請求、收程序）／
`probe-hf-router` 全 PASS／`probe-hf-hub` 全 PASS（打真 HF）。
打包版 CDP：`e2e-hf-cdp` 39 checks（新）／`e2e-cdp-smoke` 22／`e2e-chat-cdp` 44／`e2e-stt-cdp` 21／
`e2e-visual-cdp` 71／`e2e-ccswitch-cdp` 117／`e2e-usage-cdp` 22／`e2e-agy-cdp` 33／`e2e-tray-cdp` 12 全綠。

**順手修掉兩支既有測試的假綠燈／假紅燈**：
- `e2e-usage-cdp` 的「antigravity = 4 windows」是靠**讀到使用者本機 `usage.json` 的快取**才成立的
  （舊版沒有暫存 user-data-dir）。改成暫存資料夾之後 antigravity 走真上游回 401 → 0 窗 → 必紅。
  斷言改成驗「窗數與有重置時間的窗數一致」，數字本身留給 `test-usage.js` 的純函式守。
- 同一支的 hover 斷言 `sleep(250)` 是固定時間，機器忙的時候會量到 transition 還在 0 的中間狀態。
  改成輪詢重派 `mouseMoved` 直到量得到（＋`Page.bringToFront`：視窗還沒 show 出來時 Chromium 不更新 `:hover`）。
  連跑 6 次全綠。

### 5. 使用者回報後的第二輪（同日）

- **nav 位置**：HF模型從第 2 個移到**系統監控之後、設定之前**。
  五個寫死頁面清單的腳本要一起改（`e2e-cdp-smoke`／`e2e-usage-cdp`／`e2e-agy-cdp` 的 `EXPECTED_ORDER`、
  `e2e-visual-cdp` 的 `PAGES`）。
- **探索頁改成兩欄**（左清單／右模型卡，比照 LM Studio）：右邊是 repo 標題、下載數／讚數／更新日期、
  參數量與架構、**下載選項**（每個量化的大小＋「這台跑不跑得動」＋下載鈕），最後是 README。
  新增 `hfmodels:detail` 一支 IPC 把這些一次回來——舊版是「展開才列量化、還要一顆一顆按『這台跑得動嗎』」，
  等於把 LM Studio 一眼看得到的東西藏在兩層點擊後面。
  - **一個 repo 只抓一次檔頭**：各量化共用同一份架構，第一個變體的前 1MB 算完，其餘套自己的檔案大小。
    unsloth 那批有 26 個變體，每個各打一次 Range 就是 26 個請求。
  - README 走既有的 `markdown.js`（零 innerHTML），所以 **HTML 標籤與 YAML front matter 要在 main 先剝掉**，
    剝的時候跳過圍籬程式碼區塊。
  - GGUF 常常沒寫 `general.parameter_count`，總參數退回 HF `/api/models` 的 `gguf.total`，
    並且要傳進 `gguf.activeParams(info, total)`。
- **搜尋列版面 bug**：`custom-select` 接管之後實際佔位的是 `.custom-select`，
  原本只收斂 `.select` → 「搜尋」被擠成一條、文字直排疊在排序下拉上。
  收斂改成 `.select, .custom-select, .btn`，回歸斷言比按鈕的寬與高。
- **執行環境「一鍵安裝最佳配置」**：照 `hardwareInfo().installable[].recommended` 挑
  （有夠新的 NVIDIA 驅動＝CUDA，否則 Vulkan），下載走既有的 `models:download`（續傳、解壓縮都現成的），
  進度借 `models:progress`。每一列另外也各有一顆「安裝」。**舊版只有「已安裝／未安裝」四個字，按不下去。**
- **模型庫每張卡多一顆「自動調參」**（`hfmodels:autoTune`）：先跑官方 `llama-fit-params` 量實際記憶體配置，
  再跑 `llama-bench` 實測比 KV 檔位與投機解碼，挑最快的寫回並重啟 router。
  參數彈窗裡也有同一顆。順序不能顛倒：fit 決定「放得下的配置」，bench 只在那個配置上比。

**驗證**：`e2e-hf-cdp` 44 checks（+5：一鍵安裝、兩欄版面、搜尋鈕沒被擠成直排）／
`probe-hf-detail`（新，打真 HF：模型卡／README 剝乾淨／26 個量化都算得出可行性／越大的量化不會被評得越好跑）／
`e2e-cdp-smoke` 22／`e2e-visual-cdp` 71／`test-hfmodels` 146／`test-error-hygiene` 82 全綠。

### 6. 額度儀表板修正（2026-09-02）

- Ollama Cloud 實際回 `limits.monthly.usage`，沒有重置時間；parser 只畫官方回來的每月視窗，卡片顯示「上游未提供重置時間」。
- Command Code 從 `billing/credits` 讀 5 小時／每週，再從 `billing/subscriptions` 讀 `planId`／`currentPeriodEnd`，
  用 `monthlyCredits`（剩餘）換算每月已用；`resetAt` 同時支援 epoch 秒與毫秒。5 小時視窗尚未使用時顯示「尚未啟動」，不捏造時間。
- 回歸：`test-usage.js` 先以 32/34 重現，再修到 34/34；`e2e-usage.js` 與 `e2e-usage-cdp.js` 的 Ollama／Command Code 斷言已同步。

### 7. 額度儀表板卡片排版（2026-09-03）

- `#usageGrid` 以可見卡片數決定橫向欄數：2 張／4 張為 2 欄、3 張／5 張／6 張為 3 欄、7 張為 4 欄；1 張或 0 張退回 1 欄。
- 視窗縮放不切換欄數，只讓 CSS grid 的卡片寬度跟著變化；`usage-page.js` 只寫入 `data-card-count`，不碰資料與排序流程。
- 回歸：`e2e-usage-cdp.js` 23/23（含 2～7 張與 560px 縮放）、`e2e-visual-cdp.js` 71/71、`test-usage-reorder.js` 15/15。

## 上一批（2026-09-02，分支 `feat/voice-input`）— CC 代理新增 Command Code、用量統計拆 token、常駐後台複檢

### 1. Claude Code 供應商：新增 Command Code，內建各家收起 Base URL 欄

- **Command Code（`commandcode`）＝直連 Anthropic**，不走閘道。使用者原本要求的是
  「OpenAI Chat Completions + `…/provider/v1`」，但實測 `POST /provider/v1/messages` 回的是
  **Anthropic 形狀**的 401（`{"type":"error","error":{...}}`），而不存在的路徑回 404 ——
  代表那條路由真的在，而且錯誤 body 會依協議換形狀。直連少一層轉換，所以表上寫
  `route: 'direct'`／`baseUrl: 'https://api.commandcode.ai/provider'`。
  真要走 OpenAI Chat 的話開一筆自訂即可。模型清單 62 顆（OpenAI 形狀的 `/v1/models`）。
- **`allowsCustomUrl()` 收成「只放行 `custom`」**：內建各家的端點是實測查證過的事實，
  多一個輸入格只多一種「填錯了但看不出來」的失敗方式。原本它同時被 `baseUrlFor()` 當成
  「這一筆實際打哪」的開關，收緊之後內建直連那幾家會連預設端點都拿不到 →
  **兩件事拆開**：`allowsCustomUrl` 只管「能不能自己填」，`baseUrlFor` 自己判斷
  官方訂閱（空）／內建走閘道（空，位址在閘道固定表）／內建直連（preset 表）／自訂（使用者填的）。
  UI 那邊 `ccBaseUrlGroup` 對非 custom 一律收起，金鑰與模型兩組照留。
- **全家端點與格式重驗過**（`probe-ccswitch-endpoints.js` 3 家直連全 401＝在；
  `probe-ccswitch-models.js` 7 家 modelsUrl 全 200、表上的預設模型都還在上游清單裡；
  閘道那三家的上游 `responses`／`chat/completions` 手動打過也都是 401 不是 404）。

### 2. 用量統計：趨勢與分佈都拆成輸入／輸出／快取讀／快取寫

- main 加 `emptyTotals()`＋`addTotals()`，`fillSeries` 與 byModel／byProvider 共用；
  1h 快取寫入在**顯示層**併進 `cacheWrite`（價錢在 `costOf` 仍各算各的）。
- 趨勢長條改成**由下往上堆疊四段**（`flex-grow` 給比例）＋四色圖例；
  滑鼠移上去浮出數字（純 CSS `:hover`，原生 `title` 要等一秒又排不了多行）。
  分佈每一列的長條同樣分段，底下多一行明細文字。
- **成本確實有算快取**（`pricing.costOf` 五項全乘）：本機實測 all 範圍 $46,919.91 裡
  **cache read 就佔 $32,819**（70%），token 面 97.5% 是快取讀。數字大是因為快取量大，不是算錯。

### 3. 常駐後台複檢（全綠）

`e2e-tray-cdp` 12 passed（第二份自己退出／關窗後 main 還活著／AGY 續命／捷徑叫回視窗／關掉開關就真的結束）；
`probe-dictation-latency` 節流矩陣：藏起來時 **訊息派送仍 0–1ms**、只有 `setTimeout` 被拉到 19s；
`e2e-dictation-cdp` 32 passed（藏起來熱鍵還掛著、IPC <500ms）。結論：**熱鍵這種要即時的路徑上不准放計時器**這條仍然成立且已遵守。

**驗證**：`test-ccswitch` 227 passed（+3）／`test-code-usage` 118 passed（+4）／
`e2e-ccswitch-cdp` 117 checks（+2：內建不顯示 Base URL 欄、仍留金鑰與模型）／
`e2e-usage-cdp` 23 passed（+3：明細欄位、四色圖例、真的派滑鼠事件量 tooltip opacity）／
`e2e-tray-cdp` 12／`e2e-dictation-cdp` 32／`e2e-visual-cdp` 64／`e2e-cdp-smoke` 22／
`test-error-hygiene` 41。

**注意（平行進行中，不是這一批動的）**：工作區同時在加第六家額度來源 `ollama`
（`src/main/usage/ollama.js`＋`api-key.js`，`e2e-usage-cdp` 已改成期待 6 張卡）。
本批跑 CDP 時 `dist/win-unpacked` 還是加 ollama 之前的版本，**那邊落地後要重打一次 pack 再跑**。

## 再上一批（2026-09-02，分支 `feat/voice-input`）— 系統監控：硬體盤點收尾（攝影機／藍牙／I/O 埠／音訊端點／Windows 更新）

逐類別盤點「還沒抓的 WMI 類別」的值與成本後補上的。總覽 specs 123 條、21 個子項群組。

1. **probe.ps1 新增五種列**：`AEND`（AudioEndpoint，喇叭／麥克風實體；**虛擬混音器在 probe 就擋**）、
   `CAM`（攝影機＋掃描器，`PNPClass='Camera' OR 'Image'`）、`BT`（藍牙電台）、
   `PORT`（機殼前後 I/O 埠，SMBIOS Type 8/9——USB 3.0／USB-C／HDMI／DP／音源，實測 11ms）、
   `QFE`＋`QFEC`（Windows 更新，全表 921ms 所以**只送最近 5 筆＋總數**）。
2. **往後加欄位**：`RAM` 補序號（全 0 的視為沒資料）、`BIOS` 補系統 BIOS 字串（`BIOSVersion` 陣列第一格，
   跟 SMBIOSBIOSVersion 不同格）。
3. **UI**：主機板加「機殼 I/O 埠」；系統加「喇叭與麥克風」「攝影機與掃描器」「藍牙」「Windows 更新」。
   記憶體模組列補序號。
4. **排版地雷**：groups 的 rows 值**不能給空字串**——空 `<dd>` 沒有 inline content、grid item 高度 0，
   整列塌掉（喇叭那組曾整組 0 高）。沒值就給 `DASH`；斷言要量 `offsetHeight`。
5. **盤點過但不收的**：`Win32_CDROMDrive`（0 顆）、印表機（軟體印表機佔七成、名單雜）、
   `Win32_USBHub`（17 個全是 root hub 沒資訊）、IRQ/Port/DeviceMemory resource（472 筆對使用者沒意義）、
   `Get-PnpDeviceProperty`（PCIe 連結速度，10.4 秒回空）、`Win32_PnPSignedDeviceDriver`（等同重掃一遍 PnP）。

**驗證**：`node scripts/test-sysmon.js` 172 passed（+10）／`npx electron scripts/e2e-sysmon.js` 61 passed／
`node scripts/e2e-sysmon-cdp.js` 112 passed（+4）／`node scripts/e2e-visual-cdp.js` 64 checks／
`node scripts/e2e-cdp-smoke.js` 22 passed。排版量測：123 specs、21 子項、零 0 高、零溢出。
static 框約 6 秒。

## 再上一批（2026-09-02，分支 `feat/voice-input`）— 系統監控：S.M.A.R.T.（CrystalDiskInfo 那半邊）

**免提權的 NVMe SMART 是真的通的**：`\\.\PhysicalDriveN` 用 **`dwDesiredAccess=0`** 開
（給 GENERIC_READ 未提權直接 open:5；純查詢的 `IOCTL_STORAGE_QUERY_PROPERTY` 0x2D1400 不需要存取權），
`MSStorageDriver_*` 與 `MSFT_StorageReliabilityCounter` 未提權回 0 筆是死路（實測過）。
本機兩顆 NVMe 全數成功、每顆 ~3ms；ATA／SATA 的 SMART_RCV_DRIVE_DATA 沒實機驗過、多半要提權，失敗一律安靜跳過。

1. **probe.ps1**：新增 `SMART`／`SMATTR`（ATA 逐屬性）列；`PDISK` 補磁區大小・GPT／MBR・開機碟・
   標籤序號（`FruId`／`AdapterSerialNumber`，韌體那組是一長串補零）；tick 新增 `DT` 列（NVMe 即時溫度／壽命）。
   `Add-Type`（P/Invoke，實測 265ms）延後到第一次要用時。static 框 4.4 → 5.9 秒（有 NVMe 的機器）。
2. **metrics.js**：`kelvinToC`（0 K 是「感測器不存在」不是 −273 °C）、`smartHealth`（判準保守：
   只有 critical warning／備援低於廠商門檻／屬性掉到門檻才是「不良」，壽命用掉 90% 只是「警告」）、
   `ATA_ATTRS` 名稱表（查無此號顯示 `屬性 0xNN`，**不猜**）。`Data Units Read/Written` 單位是
   **1000 × 512 bytes**，當成 bytes 會少算 51 萬倍。
3. **儲存區塊**：specs 8 → 12（健康狀態／最高溫度／最長通電時數／累計寫入量）；每顆碟一組
   `S.M.A.R.T.｜型號` 子項（17／15 列）；無 sidecar 時硬碟溫度退回 NVMe SMART 那條路。
   健康度判定在 main（`index.js` 的 `inventory()`）——renderer 是 ESM 載不動 CJS，複製過去就是兩套會漂移的規則。
4. **死路記下來**：`Get-PnpDeviceProperty`（DEVPKEY_PciDevice_*）實測 10.4 秒還回空值，
   PCIe 連結速度那格**不要做**。

**驗證**：`node scripts/test-sysmon.js` 162 passed（+25：SMART 解析／健康度判準／克氏換算／舊格式）／
`npx electron scripts/e2e-sysmon.js` 61 passed（+10：**真 IOCTL**，mock 證明不了讀得到）／
`node scripts/e2e-sysmon-cdp.js` 108 passed（+9 SMART UI 斷言；IPC 回 `{ ok, data }`，忘了拆 data 的話
「這台沒有 NVMe」會把整段斷言安靜跳過＝假綠燈）／`node scripts/e2e-visual-cdp.js` 64 checks／
`node scripts/e2e-cdp-smoke.js` 22 passed。排版量測：122 specs、零 0 高、零溢出。

## 再上一批（2026-09-02，分支 `feat/voice-input`）— 系統監控總覽：把挖得到的硬體全列出來

規格條數 **60 → 118**（實測整頁只剩 4 條無值，而且那 4 條是這台機器本來就沒有的：
主機板／機殼序號與 BaseBoard 版本是 OEM 塞的 `Default string`、沒有公網 IPv6）。

1. **probe.ps1 一律往後加欄位**（既有欄位不動，舊格式照樣解析得動）：
   `SYS` 補工作群組・登入使用者・Hypervisor・開機方式；`CPU` 補外頻・家族／步進・已啟用核心・架構・修訂；
   `BOARD`／`BIOS` 補序號・SMBIOS 版本・BIOS 內部版本；`OS` 補 `DisplayVersion`（25H2）・`UBR`・
   架構・介面語言・系統磁碟・Windows 目錄・版本代號・分頁與虛擬記憶體大小；
   `PDISK` 補分割區數；`MON` 補**原生解析度**（EDID 列出的最大模式）・接頭型式・製造週次・型號碼；
   `NIC` 補子網路遮罩・DHCP 伺服器・IPv6・介面型別；`SEC` 補韌體模式・TPM・安裝日期。
2. **新增五種列**：`TZ`（時區）、`PAGE`（分頁檔）、`SLOT`（擴充插槽，SMBIOS 直接寫著哪條在用、幾通道）、
   `USBC`（USB 控制器）、`HID`（鍵鼠，同一支裝置在 HID 堆疊上會被列好幾次，probe 依描述去重後報數量）。
3. **佔位值統一在 `metrics.clean()` 清掉**（`Default string`／`To be filled by O.E.M.`／`Unknown`…）：
   以前是 renderer 各處寫 `!== 'Default string'`，漏一處就在規格表上印出來。
4. **UI 排版**：CPU 加「快取階層」子項、記憶體加「分頁檔」、主機板加「擴充插槽／USB 控制器」、
   系統加「輸入裝置」；**GPU 有 nvidia-smi 時也列「顯示介面卡」**（以前只在沒有 nvidia-smi 的分支才列，
   內顯／虛擬顯示卡完全看不到）；顯示器區塊以前 `specs: []` 全空，現在補上桌面配置與面板規格
   ——**EDID 與桌面配置沒有可靠對應鍵，面板那幾行一律列「全部面板」，不假裝其中一台是主要的**。
5. **成本**：static 框 4.4 秒（原本約 4 秒）。新查詢實測 `Win32_SystemSlot` 10ms／`Win32_DiskDrive` 13ms／
   EDID 三支合計 <40ms／TPM 走 `Win32_PnPEntity` 470ms；`Win32_Bus`（164ms）查了沒用，沒收。

**驗證**：`node scripts/test-sysmon.js` 137 passed（新增 12 條靜態解析斷言）／
`node scripts/e2e-sysmon-cdp.js` 99 passed（新增 11 條「標籤＋真的有值」斷言）／
`npx electron scripts/e2e-sysmon.js` 51 passed／`node scripts/e2e-visual-cdp.js` 64 checks／
`node scripts/e2e-cdp-smoke.js` 22 passed。

## 上一批（2026-09-01，分支 `feat/voice-input`）— 語音輸入：字典真的生效＋長篇重寫

1. **字典套兩次**（`dictation/index.js` 的 `cleanup`）：送進整理模型之前一次、模型回來之後再一次。
   小模型很常把換好的專名改回去，只套前面等於字典白設。prompt 也多一句「已經是右邊的不要改回左邊」。
2. **prompt 只帶用得到的字典**（`buildSystemPrompt({ text })`）：左右任一邊有出現在這段文字裡才帶。
   60 條全帶會吃掉本地那顆 2048 token context 的一大塊，指令被稀釋反而更不聽話。
3. **字典會自我修正**：`learnPairs` 遇到反向對不再只是忽略，而是回報 `demote: true`
   （字典先套過了、模型看到成品又改回去＝那條被推翻一次）→ `mergeLearned` 扣次數，
   扣回門檻以下停用、扣到零整條移除。**手動加的（新欄位 `manual: true`）不扣**。
4. **長文也學得到詞**：`MAX_DIFF_TOKENS` 400 → **1200**（講超過三分鐘就再也學不到的問題）。
   dp 表 1201² 個 uint16 ≈ 2.9MB，一次口述跑得完。
5. **整理分兩種模式，判準只有長度**（`text.cleanupMode`，`REWRITE_MIN_CHARS` = 180 字）：
   短句維持保守整理（不換用詞、不重寫整句）；長篇改走**重寫模式**——合併分次講的同一件事、
   改成寫出來會用的說法、依主題分段，並附一組長篇範例。**重寫模式仍然不准加料**。
   模式在本地切段**之前**用整段長度決定（不然每段都被當短句）。
   ceiling：本地那顆 context 2048，重寫仍是逐段各自重組，跨段搬移做不到（要整篇重組請選雲端模型）。

**驗證**：`node scripts/test-dictation.js` 114 passed／`npx electron scripts/e2e-dictation.js` 67 passed／
`node scripts/test-error-hygiene.js` 41 passed。

## 再上一批（2026-09-01，分支 `feat/voice-input`）— 六項使用者回報

1. **nav 順序**：聊天｜CC代理｜額度｜AGY反代｜語音轉文字｜翻譯與 TTS｜**系統監控**｜設定
   （系統監控從第三位移到設定前）。四支 CDP 腳本裡寫死的頁面清單同步改。
2. **系統監控總覽補齊硬體**：CPU L1 快取（`Win32_CacheMemory`）／記憶體插槽總數與主機板上限
   （`Win32_PhysicalMemoryArray`）／**顯示卡 VRAM 改讀登錄檔的 64 位元真值**（`AdapterRAM` 是 uint32，
   16GB 的卡回 4GB）／磁碟區標出住在哪顆實體碟（`Win32_LogicalDiskToPartition`，23ms，
   `Get-Partition` 要 1376ms）／網路卡的預設閘道・DNS・DHCP／每台螢幕的桌面配置（Electron `screen`）。
3. **用量統計對過帳**：新增 `probe-code-usage-audit.js`（**完全不經 codeusage** 自己重讀
   `~/.claude/projects` 再對帳）——請求數／token／金額逐模型全對得上，總額 30 天 $2329.75。
   補上 GLM 的公開單價（`glm-5.3` 1.4/4.4/0.26、`glm-5.3-flash` 0.15/0.5/0.03），
   剩下沒單價的只有 `m`（某個代理寫進去的垃圾 id，2 次請求）。
4. **個人字典邏輯**：`applyDictionary` 改**單趟掃描**（以前每條各跑一次 `split/join`，
   `A→B` 之後 `B→C` 會接力把 A 改成 C）；拉丁詞卡詞界並忽略大小寫；
   `learnPairs` 多收現有字典，**不學反向對與接力對**。
5. **Claude Code 供應商 tile 可拖曳排序**（`list-reorder.js`，跟聊天側欄同一套）：
   順序＝store 的陣列順序，`reorderProviders` IPC 本來就有、只是 renderer 沒接。
6. **不是模型名的 id 不進統計**（`pricing.isJunkModel`，一兩個字元；實測有代理往 Claude Code 的
   記錄寫 `model: "m"`）：`addEvent` 與 `loadBuckets` 兩邊都擋，`RULES_VERSION` → 5 讓舊桶子重讀。
   `unknown` 要留（真的有用量，丟掉等於少算）。
7. **整理模型更聰明**：prompt 加範例與「不要翻譯」（以前寫「輸出語言：繁中」，講英文會被翻掉）；
   本地整理**切 500 字一段逐段跑**（context 只有 2048，整段送會被無聲截掉後半段）；
   `maxTokens` 按段長給（以前吃 `promptOnce` 預設的 640）；輸出長度離譜就當沒整理過。
8. **Codex 子代理重播不再重複計算**（`unknown` 那 7.8 萬筆的真正原因）：帶 `forked_from_id` 的
   rollout 開頭是母 thread 整份歷史的重播，舊版照收 → 憑空多一份用量、還因為重播段落沒有
   `turn_context` 而全記成 `unknown`。`parseCodexLine` 加 `state.replay`（第一個 `turn_context`
   解除），`scanSource` 把它跟 `model` 一起存進游標，`RULES_VERSION` → 6 讓舊桶子重讀。
   `probe-code-usage-audit.js` 補 [E]：拿母檔逐筆核銷 78016 筆重播，0 筆對不到（＝丟掉不會少算）。

**驗證**：`test-sysmon` 122／`test-dictation` 95／`test-code-usage` 114／`test-ccswitch` 224／
`test-usage` 30／`test-error-hygiene` 41／`e2e-dictation` 60／`probe-code-usage-audit` 全對得上／
`probe-packed-local-llm` PASS；打包版 CDP：`e2e-cdp-smoke` 22／`e2e-ccswitch-cdp` 110／
`e2e-sysmon-cdp` 87／`e2e-usage-cdp` 20／`e2e-agy-cdp` 33／`e2e-visual-cdp` 64／`e2e-dictation-cdp` 32 全綠。
**打包**：`native/**`（.NET sidecar 原始碼與 bin/obj，186MB）漏排讓 asar 到 631MB，
`app.asar` 寫完立刻被即時掃描抓住 → electron-builder 自己 `EBUSY: unlink app.asar`；
排掉後 437MB 一次過（`%TEMP%` 打包＋就地覆寫，兩邊 sha256 一致）。

## 前一輪（2026-09-01）— 七項使用者回報

1. **聊天與終端機合成同一頁**：側欄上下兩半（＋新對話／＋新終端機），主區在 `#chatMain`／`#termMain`
   之間切（`app.js` 的 `setChatPaneMode`）。**沒有 `page-terminal` 了**——判斷「人在不在看終端機」
   要看 `#termMain` 有沒有被藏起來。終端機列與對話列共用 `.chat-list-item` class，
   選擇器一定要限定 `#chatList`／`#termList`。
2. **終端機狀態更新改成就地改那一列**（`refreshItemView`）：以前每收到一次狀態就 `renderList()`
   重建整份清單，而提示字元標記三秒重送九次 → 待確認的刪除鈕與改名輸入框被洗掉，
   **跑著的終端機刪不掉、也改不了名**。
3. **系統監控的磁碟按實體碟分開**：總覽與壓力測試都逐顆列（型號＋掛的磁碟代號），
   `_Total` 只用在整機那一格。
4. **壓力測試儀錶 CPU／GPU 各四格一排**：負載／功耗／溫度／轉速。風扇轉速走感測器 sidecar
   （`CPU Fan`／`GPU Fan`，`findFan` 只認名字不只認型別，免得撈到機殼風扇）。
5. **磁碟測速**（`sysmon/bench.js`）：選磁碟代號＋測試大小，測試檔由程式建在該碟根目錄、跑完刪掉。
6. **用量統計**：「全部重讀」與「掃描本機記錄」併成一顆；成本算得出來了
   （實測 30 天 38923 次請求、$4389.93）。
7. **打包版本地 LLM**：`node-llama-cpp/llama/**` 被整包排出 asar，補 include 回
   `binariesGithubRelease.json`（回歸 `probe-packed-local-llm.js`）。

## 更早（2026-09-01）— 八項使用者回報

1. **Claude Code 頁**：`.cc-tile.is-active` 拿掉左緣 accent bar 與 accent 邊框，作用中只靠右上角徽章。
2. **壓力測試儀錶**：「磁碟佔用」（容量）→ **「磁碟讀寫」**（`_Total` 讀＋寫速率，尺規跟峰值）；
   「記憶體佔用」→「記憶體已用」（Windows 沒有記憶體頻寬計數器）。
3. **儀錶固定三欄**（900px 收 2、640px 收 1）：CPU 一排、GPU 一排、記憶體＋磁碟一排。
4~6. **用量統計**：`BUILTIN_PRICES` 每顆補 `cacheRead`／`cacheWrite`／`cacheWrite1h`（單價彈窗兩格→四格）；
   Claude 的 1 小時快取獨立計價（實測 78% 是 1h，以前混用 5m 價低估三成多），`RULES_VERSION` → 3；
   `gemini-pro-agent` 套 Gemini 3.1 Pro 的價；單行上限 2MB → 16MB、單檔 50MB → 1GB
   （同機掃描量 2.6GB → **5.4GB**、請求數 31882 → **38279**）；摘要多一張「快取寫入」卡。
7. **語音輸入**：新增 `native/dictation-hook`（.NET 8、不提權、10MB 單檔）裝 WH_KEYBOARD_LL，
   對右 Alt down/up `return 1` **真的吞掉**；起不來才退回 uiohook（＋F24 中和）。
   錄音上限 2 分鐘 → **20 分鐘**（`text.splitSamples` 切 20 秒一段、挑最安靜處下刀）。
   熱鍵掛不上 5 秒後自動重試；麥克風 track `ended` 或 AudioContext 中斷時自己重建。
8. **雲端 ASR 一組設定多顆模型**：`asrClouds[].modelId` → `asrClouds[].models`；
   三個子分頁的 ASR 值變成 `cloud:<設定 id>:<模型 id>`，舊值自動升級。

**驗證**：`test-code-usage` 96／`test-dictation` 77／`test-model-scope` 31／`test-sysmon` 116／`test-usage` 30／
`test-ccswitch` 224／`test-error-hygiene` 41／`e2e-dictation` 60／`e2e-code-usage` 16／`probe-dictation-hook` 4；
打包版 CDP：`e2e-dictation-cdp` 32（含「熱鍵走原生 sidecar」）／`e2e-stt-cdp` 21／`e2e-sysmon-cdp` 78／
`e2e-usage-cdp` 20／`e2e-ccswitch-cdp` 107／`e2e-chat-cdp` 44／`e2e-visual-cdp` 70／`e2e-cdp-smoke` 22／
`e2e-tray-cdp` 12 全綠。預覽已更新（打包走 `%TEMP%` ＋ 就地覆寫 asar，兩邊 sha256 一致）。

## 這一輪之前做過什麼（各一句）

| 時間 | 內容 |
|---|---|
| 2026-09-02 | 新增「HF模型」分頁：HF 搜尋→下載→router 一鍵載入→直接在聊天用；參數走 llama-fit-params 實測＋可覆寫＋原始參數直通＋llama-bench 調校；修掉 KV 低估 2 倍會 OOM 的估算錯誤 |
| 2026-09-02 | CC 代理新增 Command Code（直連）、內建各家收起 Base URL 欄；用量統計趨勢／分佈拆成輸入・輸出・快取；常駐後台複檢全綠 |
| 2026-09-02 | 系統監控總覽的硬體規格 60 → 118 條（插槽／USB／鍵鼠／分頁檔／時區／TPM／韌體模式／面板原生解析度…），SMBIOS 佔位值統一清掉 |
| 2026-09-01 | 合頁後的回歸收尾：終端機狀態更新改成就地改列（跑著的終端機終於刪得掉／改得了名）、未讀點改看 `#termMain`；CDP 腳本的暫存 user-data-dir 補回模型 junction／自種資料／借空埠 |
| 2026-09-01 | Grok 掃描改走 `cli-chat-proxy.grok.com`；系統監控總覽預設全展開、只留強制結束；用量統計補單價與增量游標修正；語音輸入 F24 中和與 HUD 預建 |
| 2026-09-01 | 供應商 tile 改成常駐「啟用／編輯」兩顆鈕；壓力測試真的壓得滿（GPU 3% → 94–100%、記憶體 7.75GB → 35GB）；補上 `official`（切回官方訂閱）預設 |
| 2026-08-31 | 整合 cc-switch → Claude Code 工作台（供應商／MCP／CLI 版本＋本機轉換閘道＋App 內 OAuth）；用量統計子分頁 |
| 2026-08-31 | 語音轉文字三個子分頁各自獨立的模型選單（新增 `model-scope.js`） |
| 2026-08-31 | 語音輸入桌面指示器（HUD）；雲端 ASR 的 401/403 分家與 `s2twp` |
| 2026-08-30~31 | 新分頁「系統監控」（取樣器／處理程序／壓力測試／提權感測器）；語音輸入上線 |
| 2026-08-28~29 | 終端機分頁、常駐系統匣與開機自啟動、AGY token 自動續期、共用自訂下拉（`custom-select.js`） |
| 2026-08-30 | v1.9.0 發行（NSIS 安裝檔已上傳 GitHub Release） |
| 2026-09-04 | 應用程式內自動更新（設定 → 基本）：`src/main/updater.js`、`update:*` IPC、`build.publish` ＋ `nsis.artifactName`；發行時要一併上傳 `latest.yml` 與 `.blockmap` |

## 已知取捨與未做

- **轉換閘道只有 Codex 的請求形狀對真上游驗過**（`probe-ccswitch-codex.js`）：SSE 回程與其餘四家
  仍是打自開的 mock 驗的。要整條實測就切過去跑一次 `claude -p`，那會花掉使用者的訂閱額度。
- **CDP 測試各自用暫存 `--user-data-dir`**：設定是乾淨的，但模型靠 junction 接回真的資料夾；
  需要資料才跑得動的測試（聊天供應商、AGY 埠）自己在測試裡種。
- **`probe-dictation-live.js` 需要前景焦點**，只能在使用者沒在用電腦時跑。
- **Antigravity 的用量只統計得到經過本 App 的反代那一段**（本機沒有 session 記錄），UI 已明講。
- **`resources/sensors/`（36MB）與 `resources/hook/`（10MB）不進版控**：乾淨 clone 要出貨這兩個功能就先跑
  `npm run build:sensors`／`build:hook`（需 .NET 8 SDK）。
- **打包環境有既知干擾**：使用者機器上的 `Orca.exe` 會抓著 `dist/win-unpacked/resources/app.asar`，
  打包必須走 `%TEMP%` ＋ 就地覆寫（步驟見 CLAUDE.md「打包／建置」）。
- **HF模型：下載與搜尋沒有進 CDP 測試**（要網路、下載動輒好幾 GB）：
  `e2e-hf-cdp.js` 只驗 UI，網路那一段由 `probe-hf-hub.js` 打真流量、router 由 `e2e-hfmodels.js` 驗。
  **真的下載一顆大模型跑起來**（含 fit、實測調校、多模態、MoE 的 `-ot`）還沒做過，
  手上只有 0.8B／4B 的 dense 模型驗過整條路。
- **`llama-bench` 的實測調校沒有在大模型上驗過**：候選矩陣只有 4 組、每組要載一次模型，
  一顆 30B 跑完可能要十幾分鐘，UI 有進度但沒有「背景跑」的設計。
- **CUDA 執行環境沒有實際安裝驗過**（本機只裝了 Vulkan 版）：registry 的兩個 zip 與
  `check` 清單是照 release 資產列的，第一個裝的人要確認 `ggml-cuda.dll` 真的在解壓後的根層。

## 給下一個人的三個提醒

1. **先讀 CLAUDE.md 對應模組的地雷再動手**——那份清單裡的每一條都是實際改壞過的。
2. **宣告完成前一定要跑驗證並貼輸出**，UI／功能改動還要 `npm run electron:pack` 更新免安裝預覽。
3. **這個 repo 的測試跑在使用者的真實資料上**：CDP 只殺自己 spawn 的 PID、只用 `[data-id]` 指涉自己建的東西、
   語音輸入測試一定要把 `insert` 換成 stub。
