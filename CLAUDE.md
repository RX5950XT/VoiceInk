# CLAUDE.md

> VoiceInk 專案規範。接手前先讀 [CONTEXT.md](./CONTEXT.md)（現行架構與交接紀錄）；
> AI 作業守則見 [AGENTS.md](./AGENTS.md)，歷史教訓見 [tasks/lessons.md](./tasks/lessons.md)。
> **本檔的「地雷」是唯一權威清單**，其他文件只引用不複製。

## 專案

Windows Electron AI 工作台：聊天＋終端機＋本機 LLM（HF模型）＋Claude Code 工作台＋系統監控＋
額度與用量統計＋AGY 反代＋語音轉文字（檔案轉錄／即時字幕／全域語音輸入）＋翻譯與 TTS。
Vanilla JS + Vite，無前端框架；Electron 43.4.1（固定版本）＋ Node.js 22。

nav 順序：聊天（預設，**工作區與終端機併在同一頁**：側欄頂部兩顆鈕切專案／對話，
側欄只列專案，終端機開在主區的分頁列上）｜
CC代理（Claude Code 工作台）｜額度｜AGY反代｜語音轉文字｜翻譯與 TTS｜系統監控｜HF模型（本機 LLM）｜設定。

| 模組 | 重點 |
|---|---|
| 聊天 | 多組供應商（`chatProviders`＋`chatProviderId`＋`chatModelId`），各帶 url／key／模型清單，可掃 `/models`；**雲端翻譯共用同一份清單**（`translateProviderId`＋`translateModelId`）。系統提示 preset、thinking 開關、圖片附件、生圖模型（`imageModels`）、訊息複製與重新生成、側欄搜尋與拖曳排序。會話存 `<userData>/chats.json` |
| 終端機 | **與聊天同一頁**（清單在側欄「專案」面板的下半，主區 `#chatMain` ⇄ `#termMain`）。`@lydell/node-pty`（ConPTY）＋ xterm.js；多開、狀態「運行中／已完成／已結束」＋未讀點。選取自動複製、右鍵貼上、窄邊框；聊天側欄寬度可拖（`--chat-sidebar-w`）。shell 與啟動指令是 main 固定表（renderer 只送 key），cwd 走系統對話框。可勾「以系統管理員身分執行」（`admin`）——ConPTY 開不出提權 shell，改由 `--terminal-admin-host=` 再開一份自己（UAC 一次）代開，見 `admin.js`／`admin-host.js`。metadata 存 `<userData>/terminals.json`（**不存畫面內容**） |
| 專案工作區 | `src/main/workspace/`：**與聊天同一頁**，借 Orca 的三欄版面。左側欄兩顆鈕切專案／對話，「專案」面板**只列本機資料夾**（`workspaces.json`，**不做 git worktree**，可拖資料夾進來加入；**兩個清單容器 id 都不動**：`#projList`／`#chatList`）；中間 `#termMain` 裡多一條分頁列（終端機／編輯器／瀏覽器，「＋」貼著分頁尾端可一鍵開終端機／Claude Code／Codex／OpenCode／Antigravity／Grok／瀏覽器，可勾管理員，「終端機（自訂…）」才選 shell 與工作目錄）。**分頁狀態跟著專案走**（含終端機分頁，存 `workspaces.json` 的 `tabsState`），切專案只摘畫面、pty 留在 main；終端機的狀態燈、未讀點、改名（右鍵）與關閉（×，二次確認後真的收掉工作階段）都在分頁上；右側欄四面板＝檔案總管（含搜尋、右鍵新增／改名／刪除）／Git 狀態（暫存區／變更／未追蹤三組，逐檔暫存／取消／捨棄（3 秒二次確認）、全部暫存、提交（staged）、推送、拉取、最近提交 10 筆）／這個資料夾跑過的 AI 對話（點一下在新終端機 resume）／本機正在監聽的埠（點一下用內建瀏覽器開）。分頁拖曳是 **pointer 跟手＋FLIP 平滑讓位**（不是 HTML5 DnD）、中鍵關閉、右鍵「關閉其他／右邊」。鍵盤：**Ctrl+P 快速開檔**（模糊比對整條相對路徑）、Ctrl+W 關分頁、Ctrl+Tab 切分頁、檔案樹 ↑↓←→／Home／End 走位（照 VS Code），開著的檔案在樹上標出來、藏起來會自動展開。檔案樹可 Ctrl／Shift 多選、拖曳搬檔。Git 面板下面有 **worktree** 一區（列出／新增／移除，新的會自動加進側欄）。編輯器是 **Monaco**（語法高亮、內建尋找取代、真正的並排 diff；載不起來退回 `<textarea>`），`.md`／`.html` 有預覽，圖片與 PDF 直接顯示；瀏覽器是 **`<webview>`**（`partition="persist:wsbrowser"`＋`allowpopups`，**只有主視窗開 `webviewTag`**） |
| HF模型 | `src/main/hfmodels/`：在 Hugging Face 搜 GGUF → 下載 → 一鍵載入 → **直接出現在聊天的模型選單**。探索頁是左清單／右模型卡兩欄（README＋每個量化的大小與「這台跑不跑得動」）。推論走 `llama-server` 的 **router 模式**（`--models-dir`＋`--models-preset`，一顆程序管全部模型），參數由 `plan.js`（估算）＋官方 `llama-fit-params`（實測）決定，每一項都可覆寫、可原始參數直通、可 `llama-bench` 實測調校。模型放 `hfModelsDir`（可自選，預設 `<userData>/hf-models`），一顆一個子資料夾（`mmproj-*.gguf` 同夾＝多模態） |
| Claude Code 工作台 | `src/main/ccswitch/`：供應商（CC Switch 式 tile，一鍵改 `~/.claude/settings.json` 的 `env`；「Claude 官方訂閱」排第一、內建各家自動播種、「＋」新增自訂；**端點只有自訂能填，六家內建可選上游格式**）／MCP（`~/.claude.json`）／CLI 版本。走閘道那幾家經 `ccswitch/gateway/` 轉協議；Codex／Grok 可 App 內 OAuth 或沿用 CLI 憑證 |
| 系統監控 | `src/main/sysmon/`：常駐 `probe.ps1` 取樣器＋`nvidia-smi -l`；六個子分頁（總覽／使用時長／處理程序／壓力測試／風扇控制／效能調整）。磁碟**按實體碟分開**顯示，S.M.A.R.T. 走免提權 NVMe IOCTL（健康度／通電時數／寫入總量／溫度，CrystalDiskInfo 那半邊）；壓力測試 CPU／GPU 各一排四格（負載／功耗／溫度／轉速）＋磁碟測速（`bench.js`，測試檔跑完刪掉）。感測器走提權 sidecar（WinExe、無主控台視窗），**即開即用**：開 App 靜默拉起（有排程工作就不跳 UAC），沒有排程工作時一進系統監控頁就自動啟用，**第一次順手把排程工作裝起來（一次 UAC），之後永遠靜默**；sidecar 中途死掉會自己重拉（上限 5 次）；**風扇控制**（`fans.js`＋`sensors-task.js`）走同一顆 sidecar 的雙向管道，通用機殼示意圖＋可拖點的轉速曲線，開機自啟動時直接接管（排程工作免 UAC）；**效能調整**（`oc.js`）同顆 sidecar 另走 `G`／`C`／`X` 寫 NVIDIA 功耗牆／時脈偏移與 Ryzen PBO 牆，不能沿用風扇的 `S`／`D`／`R` |
| 額度 | 七家（Claude Code／Codex／Antigravity／OpenCode Go／Grok／Ollama Cloud／Command Code），**全部走官方端點**，只在手動同步時查詢，快取 `<userData>/usage.json`；Main-only 固定來源 |
| 用量統計 | `src/main/codeusage/`：從五家 CLI 的本機 session 記錄算 token／花費（跟「訂閱額度」是兩件事），增量掃描，桶子存 `<userData>/code-usage.json` |
| AGY 反代 | `src/main/agy/`：把 Antigravity 憑證轉成 OpenAI `/v1/chat/completions` 與 Anthropic `/v1/messages`；只綁 127.0.0.1＋強制金鑰；日誌 `<userData>/agy-logs.db` |
| ASR | local（`asr-select.js` 分流 sherpa CPU／llama-server GPU）或 cloud（`/audio/transcriptions`）。兩顆本地：`qwen3asr`（0.6B INT8，只有 CPU）／`qwen3asrgpu`（1.7B Q8_0，Vulkan GPU，需 `llamaruntime`） |
| 翻譯／TTS | 翻譯 cloud（走聊天供應商）／local（`linguaforge08q4` 預設／`qwen35translate`／`qwen354b`；`llmGpu` 全域開關）；TTS 走 Edge TTS（`ttsVoices`＋`ttsRate`） |
| 語音輸入 | 全域右 Alt（原生 sidecar 吞鍵）→ 錄音（上限 20 分鐘）→ ASR → 個人字典 → LLM 整理 → 剪貼簿＋Ctrl+V；滑鼠所在螢幕底部浮藥丸指示器；紀錄與字典存 `<userData>/dictations.json` |
| 設定 | 最後一個 nav tab；左側分類 rail（本地模型／雲端模型／語音朗讀／基本）＋底部 sticky 儲存列。**只管「裝了什麼、怎麼推論、雲端端點」，用哪一顆模型在功能頁選** |
| 常駐 | 關視窗預設縮到系統匣讓 AGY 續命（`closeToTray`）；開機自啟動走 `app.setLoginItemSettings`（真相在 OS，不進 store），帶 `--hidden` |
| 自動更新 | `src/main/updater.js`：electron-updater ＋ GitHub Releases 的 `latest.yml`。設定→基本可開關「自動下載」、手動「檢查更新」、下載完可「重新啟動並安裝」；沒按的話結束 App 時靜默裝好 |
| 視覺 | Token Anxiety Aurora glass；深／淺主題共用 12px surface、blur、冷藍／暖金光暈；RWD 900／640px；本機字體（不拉 Google Fonts） |

模型 registry `src/main/models.js`，下載至 `%APPDATA%/voiceink/models/`；
`archive: true` 的項目用 `Expand-Archive` 解開，已安裝與否看 `check` 清單不看檔名。

## 指令

```bash
npm run electron:dev     # 開發（vite + electron）
npm run dev:sandbox      # 沙箱實例：不干擾你正在用的那份，但接得到原本的模型與專案
npm run electron:pack    # 免安裝快速預覽 → dist/win-unpacked/VoiceInk.exe（UI／功能改完必跑）
npm run electron:build   # 完整打包：NSIS 安裝檔 + win-unpacked → dist/
npm run build:sensors    # 系統監控提權感測器 sidecar（需 .NET 8 SDK）→ resources/sensors/（36MB）
npm run build:hook       # 語音輸入原生熱鍵 sidecar（需 .NET 8 SDK）→ resources/hook/（10MB）
```

- `resources/sensors/` 與 `resources/hook/` **不進版控**；沒建置也打得起來，只是感測器顯示「沒有附帶元件」、
  右 Alt 退回「只監聽」模式。
- 打包前先關掉 `dist/win-unpacked/VoiceInk.exe`（否則卡 `d3dcompiler_47.dll: Access is denied`）。
- 使用者同時在用電腦時，桌面 QA 只能用 CDP／視窗 API 背景操作；不可移動滑鼠、發全域快捷鍵或搶前景焦點。
- **手動開一份來玩一律走 `npm run dev:sandbox`**：三份 VoiceInk（安裝版／`dist/win-unpacked`／`electron:dev`）
  預設共用 `%APPDATA%\voiceink`，而 `requestSingleInstanceLock()` 綁的就是 userData 路徑——
  直接開第二份只會自己關掉，還會跟使用者那份搶 `chats.json`／`config.json` 與 AGY 的埠。
  沙箱在 `%APPDATA%\voiceink-dev`：`models`／`hf-models` 用 junction 接回去（唯讀、30GB 不能複製），
  `config.json`／`workspaces.json` 複製一份，`agyEnabled`／`dictationEnabled`／`sysmonSensors`
  強制關掉（這三個的影響會跑出 userData 之外：搶埠、全機吞右 Alt、跳 UAC）。

### 發行流程

App 內自動更新靠這條流程產出的檔案，**少一步舊版就永遠檢查不到更新**。

```bash
# 1) bump 版本（不可與既有 tag 重複），順手更新 README 頂端的版本行
#    package.json 的 "version" ← X.Y.Z
git commit -am "feat: 發行 vX.Y.Z — <一句話>"
git tag vX.Y.Z && git push && git push --tags

# 2) 完整打包（產出安裝檔、blockmap 與 latest.yml）
npm run electron:build

# 3) 建立 release（不可加 --draft／--prerelease，那兩種 electron-updater 看不到）
gh release create vX.Y.Z --title "vX.Y.Z" --notes "<發行說明>"

# 4) 上傳三個檔案（缺一不可）
gh release upload vX.Y.Z dist/VoiceInk-Setup-X.Y.Z.exe dist/VoiceInk-Setup-X.Y.Z.exe.blockmap dist/latest.yml
```

三個檔案各自的作用（**任何一個少了都不會報錯，只會靜靜失效**）：

| 檔案 | 少了會怎樣 |
|---|---|
| `VoiceInk-Setup-X.Y.Z.exe` | 下載 404 |
| `latest.yml` | 舊版永遠說「沒有附帶更新資訊」——**它只在 `build.publish` 有設定時才產出** |
| `.blockmap` | 不報錯，但差異更新退回下載完整 360MB |

另外三條：

- **不可以 `--draft` 或 `--prerelease`**：electron-updater 走的是 `releases/latest`，
  那條路徑跳過草稿與預覽版（`GitHubProvider.getLatestTagName`），發了等於沒發。
- **`nsis.artifactName` 不可改回預設**：預設帶空白，上傳 GitHub 會被改名成 `VoiceInk.Setup.X.Y.Z.exe`，
  而 `latest.yml` 寫的是連字號版 → 下載 404。
- tag 用 `vX.Y.Z`，且要跟 `package.json` 的 version 一致（`latest.yml` 的 `version` 是從那裡來的）。

發完之後，舊版使用者開 App 20 秒後（或設定 → 基本按「檢查更新」）就會看到。

## 慣例

- 檔名 kebab-case、變數 camelCase、常數 UPPER_SNAKE_CASE；ES2022、async/await、JSDoc。
- Renderer 是 ESM，Main／Preload 是 CJS。函數 <50 行、檔案 <800 行、巢狀 ≤4 層。
- Commit 格式 `<type>: <description>`，訊息用繁體中文。
- 設定走 electron-store IPC，**key 僅 allowlist**。以下**不走** `store:*`，各有獨立 store／IPC：
  聊天（`chat:*`／`chats.json`）、終端機（`terminal:*`／`terminals.json`）、
  工作區（`workspace:*`／`workspaces.json`）、AGY（`agy:*`）、
  語音輸入紀錄與字典（`dictation:*`／`dictations.json`）、用量統計（`codeusage:*`）。
- 九組模組 IPC（agy／ccswitch／codeusage／dictation／hfmodels／sysmon／terminal／usage／workspace）的
  「只有主視窗能呼叫 ＋ 回 `{ ok, data }`／`{ ok, error }` ＋ 錯誤訊息走 `userMessage` 白名單」
  收在 `src/main/ipc-invoke.js` 的 `makeInvoke()`。**收掉的只是那段 try/catch，
  每組仍然要逐一列舉自己的 handler**（漏一行的坑照舊存在）。要換一套收斂規則就傳 `publicError`
  （usage 與 hfmodels 各有自己的一套）。回歸：`test-ipc-invoke.js`
- 本地 ASR 模型 key 走 `models.isAsrKey()`；`models.openFolder` 僅收 registry key 或根目錄。
- 兩窗 `sandbox: true`；CSP `connect-src 'self' https: http:`（自訂 API URL 的前提，不要改回白名單）、
  `font-src 'self' data:` 與 `worker-src 'self' blob:`（**兩條都是 Monaco 要的**，見地雷區）。
- **UI／功能改動完成後先跑 `npm run electron:pack`** 更新免安裝預覽；完整安裝檔僅發佈時再打。

---

## 地雷（改壞過的地方）

### 安全底線（跨模組）

- **所有雲端路徑**（額度／聊天／雲端 ASR／雲端翻譯／AGY／閘道）的 HTTP 錯誤**只記狀態摘要**：
  上游 response body、token、外部 `error.message` 一律不進 console／diagnostics／IPC／UI。
  API URL 是使用者自填的，回什麼字串由對方決定；閘道原樣回音時等於在 UI 印出自己的金鑰。
  判準是「這個字串是不是上游可控又會顯示給使用者」，不是「哪個功能」。回歸：`test-error-hygiene.js`
- **代理／閘道不透傳上游狀態碼**：只有 429（含 `retry-after`）原樣回，其餘一律 502。
  透傳 401／403 會讓客戶端去檢查一個完全正確的 API key。**每個端點都要走同一個 `statusFor`**
  （`count_tokens` 曾自己寫一套，Claude Code CLI 靠它估上下文，會誤判成金鑰壞掉）。
- **不收 renderer 給的網址**：模型掃描 IPC 只收 providerId，閘道上游位址一律由 main 從 store 取。
  讓 renderer 指定網址＝把 App 變成「幫你打任意網址」的代理。
- **圖片只收 `data:` URI**（聊天生圖／AGY／閘道皆同）：去下載客戶端給的 http URL＝SSRF 跳板。
- 不硬編碼 secrets；Antigravity 的 OAuth client secret 走 `ANTIGRAVITY_CLIENT_ID`／`SECRET` 環境變數
  （那是 IDE 的憑證，而且 `GOCSPX-` 會被 GitHub secret scanning 攔）。
- 外部 CLI 憑證（`~/.codex/auth.json`／`~/.grok/auth.json`）**只讀不寫**：寫回去會跟 CLI 互相作廢 refresh token。

### 打包／建置

- 保留 `asar.smartUnpack: false`（否則會自動解開所有 `.exe`／`.node`）。`asarUnpack` 要含：
  sherpa-onnx*、`@node-llama-cpp/win-x64`、`@reflink`、Antigravity `.ps1`、`sysmon/probe.ps1`、
  `uiohook-napi`、`@lydell/node-pty-win32-x64`（帶 `conpty.dll`／`OpenConsole.exe`）。
  ffmpeg／CUDA／Vulkan 留 asar，第一次用拷到 `%APPDATA%/voiceink/`
  （**不可寫進安裝目錄 asar.unpacked**，Program Files 一般使用者寫不進去，GPU 會默默退回 CPU）。
- 外部程序（PowerShell、conhost）執行不了 asar 內檔案，路徑要換成 `app.asar.unpacked`。
  sherpa-onnx-node 在 Windows 需先把 DLL 目錄加入 PATH 才能 require（`local-asr.js` 已處理，勿動順序）。
- **`node_modules/node-llama-cpp/llama/**` 整包排掉會讓打包版的本地 LLM 靜默失效**（runtime 讀
  `binariesGithubRelease.json` 定位 prebuilt binary）：排除之後要再 include 回那一支 json。
  雲端翻譯照樣好好的，所以完全看不出來——動這條規則前後跑 `probe-packed-local-llm.js`。
- 打包跑的是 `src/` 原始碼（`files` 排除 `dist/**`、`dist-*/**`），改 renderer 直接改 `src/`；`vite build` 只作驗證。
  **新增任何產物資料夾都要記得排除**（`dist-hud/` 曾讓 asar 從 525MB 爆到 1.46GB，且無警告；
  `native/`（.NET sidecar 的原始碼與 `bin`／`obj`）漏排時 asar 631MB，**症狀不是變慢而是打包失敗**
  ——`app.asar` 寫完立刻被即時掃描抓住，electron-builder 在自己那一步 `EBUSY: unlink app.asar`，
  排掉之後 437MB 一次就過）。
- **`app.asar` 被別的程式抓著 → 產出的 asar 會安靜錯位**（每個檔案拿到前一個的內容，整頁 SyntaxError，**不報錯**）。
  兇手可能是完全無關的 Electron 工具（實測 `Orca.exe` 會監看工作區，**連 `%TEMP%` 也監看**——
  2026-09-03 兩次都被它抓住，改打包到 `C:\vi-pack` 才過）；`Get-Process | Where Path` 抓不到，
  要用 `handle64 app.asar`，或用 Restart Manager 的 P/Invoke（`RmStartSession`＋`RmGetList`，免提權）
  直接問「誰鎖著這個檔案」——`Get-CimInstance Win32_Process` 只看得到命令列，看不到 handle。
  解法：打包到**工作區外**（`--config.directories.output="$TEMP/vi-pack"`）→ `cp -rf` 或
  `robocopy /MIR /XF app.asar` 覆寫回 `dist/win-unpacked`（那個 handle 擋 delete 不擋 write），
  asar 用 `[IO.File]::Open(dst,'Open','Write','Read')` 就地覆寫＋`SetLength`。
  **`VoiceInk.exe` 一定要一起換**（asar 完整性雜湊嵌在它的資源裡）。收尾 `sha256sum` 對兩邊＋跑一次 CDP。
- **打包完一定要先驗 asar 沒錯位，再覆寫回 `dist/`**（2026-09-06 又中一次，這次是 `C:i-pack` 也被抓）：
  `npx @electron/asar extract-file <app.asar> package.json` 印得出正常 JSON 才算過（**這個指令不是印到 stdout，是把檔案寫進當下的工作目錄**——在專案根目錄跑會把
  自己的 `package.json` 蓋掉，而且完全沒有輸出、看起來像成功。一定要 `cd` 到暫存目錄再跑；
  真的蓋掉了就 `git checkout-index -f -- package.json` 從索引救回來，再把行尾換回 LF）；
  錯位時印出來是二進位亂碼，而 electron-builder **exit 0、完全不報錯**。
  症狀是啟動即結束（CDP 埠連不上、`--version` 無輸出 exit 1），看起來會很像剛剛那筆程式碼改壞了。
  修法：**換一個全新的輸出目錄重打**（同一個目錄再打可能又被同一個 handle 抓住），驗過再 copy。
- **`electron:pack` 中途 EPERM 失敗會留下壞掉的 `dist/win-unpacked`**：症狀是啟動無 log、CDP 埠連不上，
  `--version` 卻回 0，實際是 `icudtl.dat` 沒更新完。**整個刪掉重打**，不要原地重試。
- **自動更新靠 `latest.yml`，而它只在 `build.publish` 有設定時才產出**：拿掉那段設定不會有任何錯誤，
  只是 `dist/` 少一個檔案 → 所有已安裝的版本從此檢查不到更新。
  **`nsis.artifactName` 也不能改回預設**：預設帶空白（`VoiceInk Setup 1.11.0.exe`），
  上傳 GitHub 會被改名成 `VoiceInk.Setup.1.11.0.exe`，而 latest.yml 寫的是連字號版 → 下載時 404。
  回歸：`test-updater.js` 的 [E]
- **`electron:pack`（dir target）產出的預覽版永遠檢查不到更新，那不是 bug**：
  electron-builder 只在 **nsis／appx** 這種真正的安裝目標才會寫 `resources/app-update.yml`
  （`PublishManager` 的 `isSuitableWindowsTarget`），而 electron-updater 的 provider 設定就讀那一份，
  沒有它一律 ENOENT → UI 顯示「檢查更新失敗」。要在預覽版上驗更新，先自己補一份
  （`e2e-update-cdp.js` 會自動補、跑完刪掉）。**不可以把 error 當成測試通過**，
  那會讓 `build.publish` 被拿掉時測試還是綠的。
- **`autoInstallOnAppQuit` 在這個 App 沒有作用**：它掛的是 `app.once('quit')`，而 `before-quit` 收完
  子程序是走 `app.exit(0)`（不發 quit 事件）。所以「結束時裝好」是 main.js 在 `app.exit(0)` **前一行**
  呼叫 `updater.installOnQuit()`，順序不可對調。
- CDP 腳本都吃 `VOICEINK_EXE` 環境變數，要驗別的路徑的建置版時指過去。

### 啟動與常駐

- `whenReady` 立刻 `show: true` 建窗，不 await store；ASR／LLM／額度／AGY／CUDA 第一次用到才 require；
  非聊天分頁 dynamic import。`show: false` 等 ready-to-show 等於把解析 HTML/JS 的時間也算進「沒開」。
- **常駐背景（`closeToTray`，預設開）三件套缺一不可**：① `requestSingleInstanceLock()`
  （第二份會用同一個埠 autoStart 反代並跟第一份搶 `chats.json`／`usage.json`／`agy-logs.db`）；
  ② 沒搶到鎖的那份用 **`app.quit()` 不是 `app.exit()`**（exit 來不及把 second-instance 送出去，症狀是叫不出視窗）；
  ③ `whenReady` 也要 `if (!hasInstanceLock) return`。`close` 攔截**必須放行 `isQuitting`**，否則關不掉。
- **`document.hidden` 同時代表「被完全遮住」**，不只「視窗藏起來」：測「叫回視窗」要看有沒有 visible 過，
  不是最後停在 visible。反過來 AGY 頁與系統監控頁靠它在縮到系統匣時自動停掉輪詢——
  所以**不可以**在建視窗時關 `setBackgroundThrottling`（實測會讓 `document.hidden` 恆為 false）。
- **常駐時只有計時器被節流**（20×setTimeout(4ms)：89ms → 19828ms），main→renderer 派送仍是 0～1ms。
  熱鍵這種要即時的路徑上不准放計時器。
- `before-quit` 要收的子程序：終端機 `killAll()`、系統監控三顆（probe.ps1／nvidia-smi／感測器 sidecar）、
  `llama-asr.unload()`（獨立 186MB+ 程序，engine 沒載過但 ASR 被直接叫過的分支也要涵蓋）、
  `dictationHud.close()`、`agy.shutdown()`（**不是 `stop()`**，那會把 `agyEnabled` 寫成 false）。

### 聊天

- **model 與訊息歷史所有權在 main**：renderer 只送 `{reqId, conversationId, text, images?, regenerate?}`；
  model 讀 `chatModelId`、system prompt 讀 `chatPrompts`+`chatPromptId`、歷史由 `chat-store` 讀寫、
  上下文 ≤24000 字由 main 裁切。別把 messages 陣列或 model 搬回 renderer 傳。
- **模型必須對「目前這組供應商」驗證**：先取 `chatProviderId` 對應的供應商，再檢查 `chatModelId ∈ provider.models`。
  只檢查「在不在任何清單裡」的話，切到 B 之後還能拿 A 的模型名去打 B 的端點。
- **`chat.send` 的 inflight 佔位必須跟守衛同一個同步區塊**（中間不得有 await）：否則兩個併發請求一起通過守衛，
  兩條串流互相覆蓋、「停止」abort 不掉、逾時計時器改到別人的 `reason`。
  回歸：`e2e-chat.js` 的「無 inflight 時同 tick 併發」
- **重新生成在上游成功前不得 `dropTrailingAssistant`**：先砍舊助理再 fetch，500／尚未吐字就停止會讓上一則回覆消失。
  記憶體裡剝掉尾端 assistant 去打 API，確定有新內容（或 partial）才落盤替換。
  `chats.json` 的 read-modify-write 一律走 `withStore`；新圖要 `chatImages.hold` 到入 json。
- **圖片不進 chats.json**（electron-store 整檔讀寫）：訊息只存檔名，實體放 `<userData>/chat-images/`，
  檔名由 main 產生並走 `chat-images.isValidName`，renderer 給的字串不當路徑用。
- 只送最近 6 則訊息的圖片（`IMAGE_CONTEXT_MESSAGES`），**而且只送 user 的圖**——把生成的圖塞回 assistant 訊息的
  content 陣列，嚴格端點會直接 400。
- **生圖 SSE buffer 要放大到 24MB**（`MAX_SSE_BUFFER_IMAGE`）：整張圖在同一行 `data:` 裡，
  沿用 512KB 會在收到第一張圖時把串流砍掉（症狀「文字有、圖沒有」，看起來像模型沒生圖）。
- `imageModels` 要收斂成 `models` 的子集，否則刪掉的模型同名新增會莫名變成生圖模型。
- thinking 關閉時**完全不帶** `reasoning_effort`（舊端點看到不認得的參數會 400）。
- 中斷串流時已收到的內容仍要存檔：累加器 `partial` 宣告在 `try` 之外。
- 串流不可用 `AbortSignal.timeout`（會砍長連線）→ 首 token 60s ＋ 閒置 120s 雙計時器。
- **側欄順序＝`chats.json` 的陣列順序**：`list()` 不依 `updatedAt` 重排（否則拖好的順序會被下次回訊息洗掉）；
  超過上限時只能 `filter` 掉最舊的，不可把排序後的陣列落盤。
- 聊天頁上方沒有工具列（改名／刪除在側欄每一列 hover 的兩顆鈕）。刪除**不用 `window.confirm`**，
  改成按鈕就地變紅勾的二次確認（3 秒逾時，`renderList` 重畫前要先 `disarmDelete` 收計時器）。
- 純雲端 → **不 acquire 引擎**，`engine.js` 的 owner 維持 `live|file|translate`。
- **`chatProviders` 的 sanitize 遇到壞網址要保留該筆、只清空 `apiUrl`**：它也跑在 store:set 存檔路徑上，
  整筆丟掉等於使用者打錯一個字就把 API Key 與整份模型清單刪了。
- **雲端翻譯與聊天共用 `chatProviders`**（舊的 `apiUrl`／`apiKey`／`modelId` 由 `migrateTranslateProvider()`
  一次性併入）：`chatProviders` 變動時**兩組選擇都要收斂**（`reconcileProviderSelection` 各跑一次），
  只收聊天那組的話翻譯會拿到已刪供應商的 id。
- **設定表單的空列 placeholder 不可複誦預設值**：新增出來的列會跟上一列一字不差、看起來像壞掉的重複項。
- `markdown.js` 全程 `createElement`＋`textContent`、**零 innerHTML**；連結只放行 http(s)/mailto。
  不要改用 marked/DOMPurify（renderer 無 bundler、CSP `script-src 'self'`、打包跑原碼）。
  `INLINE_SRC` **每次呼叫都要 `new RegExp`**（`renderInline` 會遞迴，共用 g-regex 會無限迴圈 OOM）；
  強調標記內側不得為空白（否則 `2 * 3 * 4` 被吃成斜體），`_` 兩側要 `(?<![\w_])` 才不拆 `snake_case`。
- 極小圖（8×8）Gemini 會回 `400 Unable to process input image`：測試 fixture 要用真實尺寸
  （走與正式路徑相同的 canvas → ≤1568px JPEG）。

### 翻譯與本地 LLM

- node-llama-cpp 是 ESM-only，main 只能動態 `import()`；Qwen 系列要 `budgets: { thoughtTokens: 0 }` 關思考，
  否則譯文為空。
- **Qwen3.5 的 generation prompt 必須以空 think 區塊收尾**（`<think>\n\n</think>\n\n`，token 248068,271,248069,271）。
  自動解析的 wrapper **不補**這 4 個 token，模型立刻掉出分布（憑空前綴／拉丁專名消失／年份幻覺）。
  修法是 `new QwenChatWrapper({ thoughts: 'discourage' })`；`budgets.thoughtTokens:0` 只擋「生成 thinking」，
  兩件事都要做。驗證：`node scripts/probe-prompt-path.js`
- **關思考一律用 `reasoning: { exclude: true }`，不要用 `{ enabled: false }`**：後者在強制思考的模型上直接回 400
  `Reasoning is mandatory...`（實測 `x-ai/grok-4.6`、`z-ai/glm-5.3-flash`，一度讓雲端翻譯整條掛掉）。
  雲端翻譯與語音輸入整理走同一條規則。
- **LinguaForge 一律單輪**（system + 單一 user，不給前文 chat history）：多一輪會讓 greedy 複誦上一輪譯文。
  只出貨 Q4_K_M（`linguaforge08q4`，505MB），判斷用 `local-llm.isLinguaforge(key)` 不要比對單一 key；
  舊 key 由 `RETIRED_MODEL_KEYS` 讀成 Q4。
- **翻譯 prompt 不可用「【前文】【本段】」括號式模板**（0.8B 會整段複誦）：指令走 system prompt、前文走 chat history。
- LinguaForge 長文**逐行翻譯**，行首清單標記（`· ` `- ` `1. `）剝掉再送、翻完貼回（`splitLinesForLinguaforge`）；
  跨段合併會退化成重複迴圈、連符號一起送會被翻成「選擇器：」。
- **zhtw 必須 `repeatPenalty: false`**（node-llama 省略時預設 1.1 會攪繁簡）；en/ja rep=1.1；雙 EOS／關 thinking；
  勿改 system prompt。代價是偶發重複迴圈 → `findRepetitionLoop` 偵測後開 rep-penalty 重跑，
  **重試前必須 `setChatHistory(history)` 還原**（否則第二輪帶著上一輪＝複誦）。
- 譯文清理集中在 `src/main/translate-clean.js`（純文字、無 electron 依賴、可 node 直測），勿在別處複製。
  **引號單側只在找不到配對時剝**（否則 `「引言」，某某說` 會變孤兒 」）；列點需帶原文判斷。
- **不要用 regex 剝「說明：」「問：」「1. 」這類前綴當修復**：那是止血，代表 prompt 錯了；
  同時發生的專名消失／年份幻覺 regex 抓不到。
- `s2twp` 只在文字真的含簡體時才套（純字形 `tw` 探測）：`twp` 會把已正確的「參數」竄改成「引數」。
- 分段：通用 ≤600 字（`contextSize: 2048`）、**LinguaForge ≤280**；main `MAX_TRANSLATE_CHARS`（1500）是 IPC 信任邊界。
- **離開翻譯頁必須作廢 `_translateRequestId`**：只 release owner 的話，分段迴圈下一輪 `translate` IPC 會把
  已卸載的 LLM 幽靈重載。`refreshUiState` 在 `isTranslating` 時不得把「停止」設 `disabled`。
- **`translateLocalOnce` 一定要把 key 傳進 `getSession(key)`**（以前算好卻用 `getSession()` 讀全域設定，
  三頁各選各的之後會直接用錯模型）。
- 語音輸入的本地整理跟翻譯**共用同一顆 session**（`getSession(keyOverride)`，走 `promptOnce()`＋`withTranslateLock`），
  不要另開第二個 llama 實例。

### ASR（本地／雲端）與模型 scope

- **`asr-select.js` 是本地 ASR 唯一的選擇點**：`engine.js`／`file-transcribe.js`／`main.js` 都只認它，
  renderer 給的 `modelKey` 一律不採用。`engine.js` 必須有 `setStore` 並轉給 `asr-select`——
  `engine.acquire`（進頁就 prewarm）可能比任何 `localAsr:*` IPC 更早發生，沒轉的話 GPU 模型會 warm 成 CPU 那顆。
- **scope 由呼叫點決定**：`asr-select.transcribe(scope, req)`／`warm(scope)`（`engine.acquire` 的 owner 就是 scope）；
  `localAsr:transcribe` 固定 `live`、`transcribeFile` 固定 `file`、語音輸入固定 `dictation`。
  `translate` IPC 是唯一收 renderer `scope` 的地方，且是白名單（只認 `file`／`live`，其餘當成翻譯頁的全域設定）。
- **三個子分頁各存一份模型選擇**（`src/main/model-scope.js` 是唯一解析點）：`fileAsr`/`fileLlm`、
  `liveAsr`/`liveLlm`、`dictationAsr`/`dictationLlm`。值的格式三組共用：
  ASR＝`local:<key>`／`cloud:<設定 id>:<模型 id>`；LLM＝`local:<key>`／`cloud:<供應商 id>:<模型 id>`／`''`。
  三頁的取捨不同（即時要快、語音輸入要輕、檔案可以慢慢跑），共用一組等於每換用途都要重設。
  「不使用」只有語音輸入有（另外兩頁靠「目標語言＝自動偵測」關翻譯）。翻譯與 TTS 頁不在這組（維持全域 key）。
- **`readLlm` 的 `stale` 不能省**：供應商被刪時值會被收斂成「不使用」，不回報等於整理功能無聲消失。
- **`seedFromLegacy` 要保持可重入**（每次 `initStore` 都跑）：只填「還沒有值」的 scope；
  `dictationLlm` 的空值＝使用者選的「不整理」，不可被播種蓋掉。
- **雲端 ASR 一組設定可以有多顆模型**（`asrClouds[].models`，跟聊天供應商同一套）：舊值 `cloud` 由 `sanitizeAsr`
  升級成第一組第一顆（不升級的話功能頁選單找不到對應項目，畫面顯示本地那顆但實際還是雲端在跑）。
  **`migrateAsrClouds` 對「已經有清單」的情況也要寫回一次**，否則 renderer 看到沒有 `models` 的舊列，
  雲端選項整組不見。`readConfig(store, scope)` 才知道用哪一顆，所以兩個轉錄入口都要把 scope 傳下去。
- **本地 GPU ASR 只能走 llama-server sidecar**：npm 的 `sherpa-onnx-win-x64` 是 CPU-only 編譯，
  傳 `cuda`／`directml` 只會印 `Please compile with -DSHERPA_ONNX_ENABLE_GPU=ON ... Fallback to cpu!` 靜默退回 CPU；
  `node-llama-cpp@3.20` 也沒有 multimodal／audio API。**不要在 sherpa 旁邊加假的 GPU 開關**。
- **llama-server 一定要帶 `--device <裝置>`**，只給 `--gpu-layers 99` 不夠：實測不指定就整包跑 CPU
  （prompt eval 7.4 tok/s vs 720 tok/s，**97 倍**），而且兩次都不印任何錯誤，只有比對 tok/s 才看得出來。
  `llama-asr.detectDevice()` 跑一次 `--list-devices` 挑第一個非 CPU 的。
- **Qwen3-ASR 經 llama-server 會夾 `language English<asr_text>` 前綴**（llama.cpp issue #26749），要 `stripAsrTags` 剝掉。
- **中文一律吐簡體**：`shouldS2twpSource`＋`s2twp` **三支 ASR（兩支本地＋雲端）都要套**，
  判斷函式在 `opencc.js` 共用，勿各寫一份。目標語 zh-TW ≠ 來源是中文（有假名／諺文要跳過）。
- **雲端 ASR 的 401 與 403 是兩件事**：401＝金鑰壞掉，403＝金鑰沒問題但這顆模型沒開通（實測 OpenRouter 的
  `google/chirp-3`／`x-ai/grok-stt-1.0` 是 BYOK-only）。合併訊息等於把人送去查一個從頭到尾正確的設定。
  訊息要指名是哪一顆模型（modelId 是使用者自填的設定值，可以進訊息）。
  模型 ID 必須是**轉錄模型**，填聊天模型會 400。
- ASR 輸出要 strip `<sil>` 等 `<...>` token；sherpa `decodeAsync` 的 JSON.parse 要 patch 防控制字元
  （見 `local-asr.parseSherpaJson`）。
- ASR 必須 `withAsrLock` + `loadEnabled`（unload 等 in-flight、禁止 stop 後幽靈重載）；
  transcribe 要驗 samples 長度／sampleRate。
- 檔案轉錄走 main `file-transcribe.js`（ffmpeg 串流 16k mono → 28s 切段），勿改回 renderer 整檔 `decodeAudioData`（長檔 OOM）。
  pause 要看「已排隊未 ASR 段數」而不是 pending bytes（stdout data 把 pending 一次抽進無界 chain 等於沒反壓）；
  Duration N/A 時用 `samplesDone`／片段數套 `MAX_DURATION_SEC`。
- **`await` 一個 `requestAnimationFrame` 一定要配逾時**：視窗被遮住或縮到系統匣時 rAF 根本不觸發
  （CDP 實測 3 秒零回呼），`transcribe.js` 的 `waitForPaint()` 曾因此卡在「準備中… 1%」而看起來像沒反應。
  rAF 只能當「有就更好」，不能當流程的門檻。

### 語音輸入

- **右 Alt 只能用低階鍵盤 hook 認**（`globalShortcut` 認不出單獨的修飾鍵，也分不出左右）。
  主要路徑是原生 sidecar `resources/hook/VoiceInkHook.exe`（.NET 8、**不提權**、WH_KEYBOARD_LL，
  對 down/up `return 1` 真的吞掉，事件走 stdout `READY`／`D`／`U`／`E`）；
  退路是 `uiohook-napi`（`AltRight = 3640`／`Alt = 56`，**只能監聽**）。兩條共用同一個狀態機。
- **原生 hook 三個坑**：① 委派要用**欄位**抓著（被 GC 後 Windows 回呼不存在的位址，整台機器鍵盤卡住）；
  ② 低階 hook 的 callback 只在有訊息迴圈的執行緒被呼叫，`GetMessage` 迴圈不能省；
  ③ 父程序關掉靠 **stdin 的 EOF** 自己結束（`stdio: ['pipe', ...]`，不寫也不關），否則留下攔著全機鍵盤的孤兒程序。
  Esc **不吞**（吞了所有程式的 Esc 都會壞）。
- **退路模式要補送 F24**：低階 hook 攔不下按鍵，Windows 看到「單獨一顆 Alt 按放」就去啟動選單列
  （瀏覽器焦點跳到工具列）。keydown 時補送一顆沒人綁的 F24 中和；**一次按放只補一次**
  （auto-repeat 會一直重送 keydown，每次都補等於灌一串按鍵給前景程式）。
- **按住 keydown 會一直重送**：狀態機要用 `pressed` 旗標擋掉，否則「按住講話」被當成連按好幾次。
- **麥克風在「啟用語音輸入」時就一直開著**（按下才 `getUserMedia` 要等 200～500ms，吃掉開頭第一個字）；
  track 變 `ended`（拔耳機、被別的程式搶走）或 AudioContext 被中斷時要自己重建。關掉開關就 `stop()` 掉所有 track。
- **單次上限 20 分鐘，長錄音一定要切段再送 ASR**：本地 sherpa 硬上限 **30 秒**、llama-server 120 秒，
  整段丟過去只會拿到「音訊過長」。`text.splitSamples` 切成 20 秒一段，切點在段尾前 3 秒內找音量最小處；
  **用 `slice` 不用 `subarray`**（native 綁定不保證尊重 byteOffset）；接回去時中文不補空白、拉丁字母交界才補。
  同時要放寬雲端整理的 `max_tokens`（寫死 1200 會把後半段切掉）與逾時（20s → 120s）。
- **整理失敗一定要退回原文照樣插入**：LLM 連不上、400、回非 JSON 都只能降級成「套過字典的 ASR 原文」，
  不能讓使用者講的話整段消失。
- **自動學詞要保守**：只認「兩側都是短詞、都不含標點」的取代區塊，同一組出現**兩次**才啟用（`PROMOTE_COUNT`）。
  學錯一個詞之後每一句都被改壞，而使用者不會知道是字典幹的。整句改寫／純刪贅詞／只補標點都不該進字典。
  另外**不學反向對與接力對**（字典已有 `A→B` 就不學 `B→A`；`from` 是別條的 `to` 也不學）——
  兩種都會讓字典自己打架，症狀是「這一句這樣改、下一句那樣改」，看起來像模型隨機。
  反向對除了不學還要**回報成扣分**（`demote`）：字典先套過了、整理模型看到成品又改回去，
  等於那一條被推翻一次 → 扣回門檻以下就停用、扣到零整條移除，學錯的詞才有機會自己退場。
  **手動加的（`manual: true`）不扣**，使用者自己打的比模型的意見權威。
- **字典要套兩次：送進整理模型之前一次、模型回來之後再一次**。小模型很常把換好的專名改回去，
  只套前面等於字典白設了。學詞必須夾在中間（用模型「真正的輸出」比對），
  否則反向證據會被自己蓋掉的結果吃光。prompt 裡也要明講「已經是右邊的不要改回左邊」。
- **prompt 只帶這一段用得到的字典**（`buildSystemPrompt({ text })` 過濾左右任一邊有出現的）：
  60 條全帶會吃掉本地那顆 2048 token context 的一大塊，指令被稀釋反而更不聽話。
- **整理分兩種模式，判準只有長度**（`text.cleanupMode`，門檻 `REWRITE_MIN_CHARS` 180 字）：
  短句保守整理（不換用詞、不重寫整句），長篇改用重寫模式——合併分次講的同一件事、
  改成寫出來會用的說法、依主題分段。**重寫模式仍然不准加料**（只能少不能多）。
  模式要在**本地切段之前**用整段長度決定，不然每一段都會被當成短句。
- **`applyDictionary` 是單趟掃描，不是每條各跑一次 `split/join`**：後者會接力（`A→B` 之後
  `B→C` 把 A 一路改成 C，使用者只交代兩件事卻拿到第三種結果）。拉丁詞另外卡詞界並忽略大小寫
  （`AI→人工智慧` 不可以把 `MAIL` 改成 `M人工智慧L`；ASR 吐的英文大小寫本來就不穩）。
- **本地整理一定要先切段**：那顆的 context 只有 2048 token，system prompt 加字典就吃掉一半，
  整段送過去**會被無聲截掉後半段**（症狀「講的話少了一截」，沒有任何錯誤）。
  `splitForCleanup` 切 500 字一段逐段跑；`promptOnce` 的 `maxTokens` 預設 640 是給翻譯短句的，
  不按段長給也會截。
- **整理結果長度離譜就當沒整理過**（`looksReasonable`）：模型回答問題、加前言或整段複誦時長度會明顯
  偏離原文，而使用者只會看到一段他沒講過的話被貼進去。判長度不判語意（判語意要再一顆模型）。
- **「輸出語言」是選字習慣、不是翻譯指令**：prompt 寫成「輸出語言：繁體中文」會讓使用者講英文時
  整段被翻成中文——那是把口述變成翻譯。要明講「不要翻譯，講什麼語言就輸出什麼語言」。
- **指示器（HUD）必須 `focusable: false` ＋ `showInactive()`**：最後一步是模擬 Ctrl+V 貼進「當下的前景視窗」，
  指示器搶到一次焦點文字就貼進它自己。
- **指示器視窗尺寸固定，藥丸在裡面自己撐寬**：`resizable: false` 會讓 `setBounds` 的寬高被**靜默忽略**，
  臨時開 resizable 又踩「Windows 上 transparent × resizable 會出事」。透明大方框要 `body { pointer-events: none }`、
  只有藥丸 `auto`，否則會擋住底下的程式。波形用 CSS transition，不跑 rAF 迴圈。
- **啟用時就先建好（`hud.warm()`）**：第一次按才建窗＋立刻 show 是一扇還沒 paint 的透明視窗。
  副作用是多一個 CDP page target → **測試挑主視窗一律用 `/index\.html/`**（用 `url + title` 比對 `VoiceInk`
  會抓到指示器，它的路徑也含這個字）。
- **跟著滑鼠換螢幕不必開輪詢**：每次狀態更新（錄音中每秒 8 次）問一次
  `getDisplayNearestPoint(getCursorScreenPoint())`，`display.id` 變了才 `setBounds`；
  座標一定要從 `workArea` 的 x／y 算（副螢幕原點不是 0，甚至是負的）。
- **`dictation:hudAction` 要驗 sender 是指示器那扇視窗**（`hud.isSender`），`dictation:hudState` 只收主視窗。
- **任何自動化測試都必須把 `insert` 換掉**（`dictation.configure({ insert })`），否則會把文字貼進使用者正在用的程式。
  真要端到端就用 `scripts/probe-dictation-live.js`（會先確認 `document.hasFocus()`，不成立就中止）。

### 即時字幕與字幕視窗

- 音訊走 `AudioContext({sampleRate:16000})` + `ScriptProcessorNode` 直取 PCM，再由 `vad.js` 依停頓切句。
  **勿改回 MediaRecorder**（`timeslice` Blob 缺 header、多一輪 opus 編解碼、stop/restart 邊界丟音）。
- VAD：128ms frame、250ms pre-roll、360ms hangover、0.5–6s 語句界；ASR 忙時最多保留 2 句、丟最舊未處理句。
- **靜音與非語言片段要在訊號層擋掉**：`♪♪♪`／`……`／零寬字元流進 0.8B 翻譯模型會被當成聊天開場，
  回一串 persona 問候佔滿字幕。進管線前用 `hasLinguisticContent` 丟棄（只認字母／漢字／假名／諺文），
  main 的 `translate` 再擋一次。
- **失敗時別把原文冒充譯文寫進 history**（下一輪它變成 few-shot 教模型複誦）；
  identity 前文（譯文==原文）同理要擋在三層：源頭不 push、模型自我複誦比照空譯文、`buildContextPair` 回 null。
- **字幕視窗 `transparent: false` 是刻意的**：Windows 上透明視窗會白條殘留＋resizable 失效。
  字幕以 `createElement` 增量更新，只有使用者原本在底部才自動捲底。
- **顯示模式（雙語／僅翻譯）由字幕彈窗獨佔**（讀寫 store `captionDisplayMode`、單一 `currentMode` 渲染）：
  別讓即時頁 payload 夾帶 `displayMode` 或加跨窗 IPC，兩端搶改同一狀態會打架。
- **`subtitleWindowBounds` 寫入與讀取兩邊都要過 `sanitizeSubtitleBounds`**（allowlist 裡唯一直接餵進
  `new BrowserWindow()` 的值）：NaN／字串會建出看不見的視窗，`isBoundsOnScreen` 的算術也全變 NaN。
  x／y 刻意不夾（多螢幕負座標合法），交給 `isBoundsOnScreen` 判斷。
- **字幕視窗被 OS 關掉（Alt+F4）也要通知 renderer**：`'closed'` 事件要補發 `subtitle:closed`，
  否則管線在沒有視窗的情況下持續擷取。
- 引擎 owner：`live|file|translate` 布林（不可改成計數）；切頁先 acquire 再 release；
  prewarm 以 gen 作廢 in-flight，且 `prewarmed=true` 不可早於 acquire 成功。
  TTS IPC 只收 lang、回 Uint8Array（禁 base64／禁 AGPL 套件）。
- **長 await 之後與 `finally` 裡都要重檢 session 狀態**（`isCapturing` / epoch），
  否則停止後才 resolve 的 stale 結果會建新 batch、幽靈重載已卸載的模型。
- `displayMedia` handler 失敗也要 `callback({})`（否則 `getDisplayMedia` 永久掛起）。

### 專案工作區

- **`index.js` 的 `module.exports` 列了一個沒定義的名字＝整個模組在載入期就 ReferenceError**：
  症狀是**每一支 workspace IPC 都回「工作區操作失敗」**（那是 `makeInvoke` 的通用訊息），
  側欄一個專案都列不出來。`node --check` 過、所有單元測試全綠——因為 `index.js` 要 electron
  才 require 得起來，測試載的是各個子模組。實測踩過：第七輪把 resume 從 UI 拿掉時，
  順手刪了 `agentResumeCommand` 的定義卻留著那一行 export（renderer 其實還在用）。
  回歸：`test-workspace.js` 的 [Q]（比對 exports 清單與檔案裡的定義）
- **`main.js` 的 `registerWorkspaceIpc({ service })` 是逐一列舉的白名單**（跟 AGY／系統監控同一條）：
  `ipc.js` 加了 handler、`index.js` 也匯出了，但 `main.js` 那份清單漏一行，
  `service.X` 就是 `undefined` → TypeError → renderer 只看得到通用的「工作區操作失敗」。
  **IPC 層、preload、單元測試全綠**，只有真的按下去才發現（這一輪的 `gitBranches` 就漏過一次）。
  回歸：`test-workspace.js` 的 [Q2]（ipc.js 用到的每個 `service.X` 都要在 main.js 那份清單裡，
  而且每一支 `workspace:*` 在 preload 都要接得到）
- **AI 記錄的家目錄不是只有 `~/.claude`／`~/.codex`**：CLI 認 `CLAUDE_CONFIG_DIR`／`CODEX_HOME`，
  而且被別的工作台（Orca）代跑時整份記錄會落在它自己的 runtime home
  （實測這台機器的 `CODEX_HOME=%APPDATA%\orca\codex-runtime-home\home`，
  `~/.codex/sessions` 底下一筆都沒有）。只看預設家目錄的症狀是「剛跑完的對話面板上完全不出現」。
  同一個 session 可能同時躺在好幾個家目錄（備份／回填）或 `sessions` 與 `archived_sessions`
  兩邊，最後要照 `agent + id` 去重、留最新的那一份。
  `codeusage/index.js` 的 `jsonlSources()` 是另一組事實（游標與桶子），**維持只掃預設家目錄**——
  它的游標鍵是檔名，多掃一份同名檔會共用游標而算錯。回歸：`test-workspace.js` 的 [W]
- **「讀過」跟「改過」要分開回**（`sessionDetail` 的 `readFiles`／`editedFiles`）：
  以前一個 `modifiedFiles` 把 `Read`／`Grep` 也算進去，使用者以為 agent 動過三十個檔案，
  其實只是看過。工具名不認得時算「讀過」——**不可以憑空說人家改過**。
  回歸：`test-workspace-ui.js` 的 [C]
- **接續一段對話要先確認它屬於這個專案**（`agents.resume` → `findSessionFile`）：
  只驗 id 格式的話，renderer 送別的專案的 session id 進來照樣接得起來，
  而那個字串會被直接打進終端機。回歸：`e2e-workspace-cdp.js` 的 [AA]
- **`for-each-ref` 不吃 `%x1f`**（那是 `git log` 的 pretty-format）：寫了不會報錯，
  只會原樣留在字串裡，分支名整條變成 `name%x1frefs/heads/name`。要多個欄位就分幾次跑，
  或只取 `%(refname)` 自己剝前綴。
- **跟分支比要比「合併基準點」，不是那條分支的頂端**（`git merge-base <ref> HEAD`）：
  直接跟頂端比的話，對方後來的提交會被算成「我刪掉的」。右邊是**工作區**（含未提交），
  因為要審的就是手上這一份。`--numstat` 一定要配 `--no-renames`——帶改名偵測時
  那一筆會變成三格（`add\0from\0to`），欄位一錯位後面每一筆檔名都跟著錯。
  回歸：`test-workspace.js` 的 [X]＋`e2e-workspace-cdp.js` 的 [Y]
- **切到「不是 git 儲存庫」的專案時，Git 面板的每一塊都要清乾淨**：`renderGit` 在
  `!status.repo` 那條會提早 return，忘了清的區塊會留著**上一個專案**的資料
  （實測審閱的分支下拉留著舊分支，按「比較」得到「這兩條分支沒有共同的起點」，
  看起來像 git 壞了）。工作樹、分支下拉、審閱清單三塊都要一起收。
- **衝突檔案（porcelain 的 `u` 記錄）要自己一組**：`index`／`worktree` 兩欄都是 `U`，
  用「不是 . 也不是 ?」去分組的話同一個檔案會同時出現在「暫存區」與「變更」兩組，
  而且看不出它其實是合併沒解完。那一組只給「解決了」（`git add`），不給捨棄。
- **工作樹移除前要自己先問一次**（`worktree.check`）：git 擋下來時只回一個非 0，
  UI 只能說「移不掉」——講不出是**哪幾個檔案**還沒提交。先跑一次 `status --porcelain`
  數出來、講出前幾個檔名，使用者才知道要去哪裡收。順便：`worktree list` 列得到、
  但側欄沒有的那幾棵要給一顆「加入」（`worktree.adopt`，路徑一樣走列舉當白名單），
  不然只看得到卻切不過去。
- **資料夾監看一次只看一個專案**（`workspace/watch.js`）：每個專案各留一個 recursive
  watcher 等於在背景掛住好幾棵樹。`.git` 底下的變動**只當成「Git 狀態變了」**、不進檔案清單
  （那裡的 index／lock 每跑一次 git 都在動），其餘 `SKIP_DIRS` 整段丟掉。
  事件要合併（npm install 一秒幾千個），監看不起來（網路磁碟）回 `{ watching: false }`
  安靜退回手動重新整理，**不要跳錯誤**。重畫檔案樹時要自己記住捲動位置，
  否則別人一存檔畫面就跳回最上面。回歸：`test-workspace.js` 的 [Z]＋`e2e-workspace-cdp.js` 的 [AB]
- **對話與終端機的 `projectId` 是可選欄位**（`chats.json`／`terminals.json`）：舊檔沒有這個欄位，
  缺值一律當「未分類」，**不可以拿它當必填**（那會讓既有的對話全部消失）。
  格式卡 `^[A-Za-z0-9_-]{1,64}$`——那個字串會被拿去過濾與比對，renderer 送什麼都不能信。
  回歸：`test-workspace.js` 的 [Y]＋`e2e-workspace-cdp.js` 的 [AC]
- **字面比對擋不住資料夾連結**：在專案裡建一個指向 `C:\` 的 junction，`path.resolve` 看到的
  仍然是專案內的路徑，實際讀到的卻是整台電腦（實測讀得到專案外的檔案）。
  `resolveIn` 通過字面檢查之後還要 `assertInsideReal`：兩邊都 `fs.realpathSync.native` 再比。
  **專案根目錄自己住在連結底下是合法的**（使用者把 junction 拖進側欄），所以基準也要解開；
  還不存在的路徑（新增檔案）往上找到第一個存在的祖先，把剩下那段接回去比。
  `git.js` 讀工作區檔案（`fileVersions`、未追蹤檔案的假 diff）也要走 `files.resolveIn`，
  不可以自己 `path.resolve`。回歸：`test-workspace.js` 的 [U]＋`e2e-workspace-cdp.js` 的 [G]
- **存檔一定要帶「開檔當下的版本」**（`writeFile(..., expectedMtimeMs)`）：不帶等於每次存檔都
  無條件蓋掉磁碟上那一版——外部改過、被別的編輯器寫過、甚至**原檔已經被刪掉**都照樣寫下去
  （刪掉的那種會把舊檔重新建出來）。對不上時 main 回 `STALE`，UI 開提示條給
  比較／重新載入／覆寫／保留編輯四條路，**草稿一個字都不能動**。
  「保留編輯」要去讀磁碟的真 mtime，不可以隨手填 `Date.now()`（那等於下次存檔又硬蓋一次）。
  回歸：`test-workspace.js` 的 [V]＋`test-workspace-state.js`＋`e2e-workspace-cdp.js` 的 [R]
- **同一個檔案的寫入要排隊**（`files.js` 的 `queueWrite`）：暫存檔取成不同名字還不夠，
  **Windows 上兩個 rename 同時指向同一個目的地會直接失敗**（實測併發存檔拿到 EPERM，
  UI 顯示「存檔失敗」，而使用者只是連按了兩次儲存）。暫存檔名要帶 pid＋流水號。
- **開分頁的每一次 await 之後都要對 `projectSwitch` 核對一次**（`ws-tabs.js` 的 `staleOpen`）：
  開一個分頁至少要等一次 IPC，那段時間使用者可能已經切到別的專案，回來照樣 `tabs.push`
  的話 B 專案的分頁列上會冒出 A 的檔案。`restoreProjectTabs` 早就有這道守衛，
  `openEditorTab`／`openDiffTab`／`openAiSessionTab` 三條漏了。**回來還要再 `findTab` 一次**
  （連點兩下會開出兩份）。右側欄的 `renderGit`／`renderGitLog`／`renderWorktrees`／
  `openAllChanged` 同理（AI 記錄那條本來就有）。回歸：`test-workspace-state.js`
- **改名／搬檔之後要 `retargetTabs`**：分頁 id 內嵌相對路徑（`e:<專案>:<相對路徑>`），
  不接的話那個分頁還指著舊路徑，**存檔會把舊檔重新建出來**，而畫面上完全看不出來。
  資料夾改名要連底下每一個開著的檔案一起換；id 照長度換尾巴，不要用 `replace` 找 `:${relPath}`。
  刪除那條靠 main 的 `STALE` 擋住，外部變更檢查看到 `exists === false` 要把提示條打開
  （不然畫面看起來完全正常）。
- **結束時的草稿要由 main 等**：`beforeunload` 裡的非同步儲存跑不完，視窗一關就沒了。
  `before-quit` 先送 `workspace:flushDrafts` 等 renderer 回報（逾時 3 秒照樣往下走，
  不能讓 App 因為存草稿關不掉），**這一步要排在 `terminalMod.killAll()` 之前**——
  存不起來時是要「取消這次結束」的，終端機已經被砍掉就回不去了。
  第二次按結束一律放行（`draftFlush === 'done'`）。回歸：`e2e-tray-cdp.js`
- **草稿上限要跟 `files.MAX_WRITE_CHARS` 同一個數字**（4MB）：`store.js` 以前寫 500KiB，
  症狀是「編輯器讓你打、存檔也存得下，但關掉分頁草稿就沒了」而且沒有任何訊息。
  超過上限時 renderer 要當場講一次。
- **`gitFileVersions` 的「讀不到」不可以畫成空檔**：截斷（>2MB）與非 `ENOENT` 的錯誤都會讓
  並排 diff 把後面整段標成「刪光」。截斷回 `truncated: true`、其他錯誤往上丟，
  renderer 收到就把 `versions` 設 null 退回逐行檢視。`ENOENT` 才是「這個版本沒有這個檔案」。
  **暫存／取消暫存之後兩份完整內容也要重讀**（只換 `diffData` 的話統計是新的、畫面是舊的）。
- **`workspace/files.js` 的 `resolveIn` 是唯一的檔案系統入口**：renderer 一律只送
  `{ projectId, relPath }`，絕對路徑由 main 從 store 取。收 renderer 給的路徑等於把
  「讀寫任意檔案」變成一個 API。比對**必須帶路徑分隔符號**（`full.startsWith(base + path.sep)`）——
  少了它，`D:\Proj-evil` 這種「字首相同的鄰居目錄」會被當成專案內。
  回歸：`test-workspace.js` 的 [A]（七種寫法）＋`e2e-workspace-cdp.js` 的 [G]（真的打 IPC）
- **git 一律 `spawn(..., { shell: false })` 且參數走陣列**：commit message 是使用者輸入，
  串成字串丟給 shell 就是注入。而且要**關掉互動提示**（`GIT_TERMINAL_PROMPT=0`＋`GIT_ASKPASS=''`），
  否則要密碼時 git 會安安靜靜等一個永遠不會來的輸入，UI 看起來就是「按了沒反應」。
- **git 的 stderr 不透傳**：裡面有遠端 URL、使用者名稱，有時候還有 token。回 renderer 的一律是
  寫死的句子（跟雲端路徑的錯誤衛生同一條）。「沒東西可提交」要跟「提交失敗」分開講——
  git 對兩者都回非 0。
- **`git status` 用 `--porcelain=v2 -b -z`**：預設格式會把含空白／非 ASCII 的檔名加引號再跳脫，
  自己反解那套規則遲早會錯。欄位是**位置**決定的，改名（`2`）那型**後面還跟著一格原檔名**——
  少吃那一格，之後每一筆檔名都錯位。回歸：`test-workspace.js` 的 [C]
- **agent 恢復指令是 main 的固定表**（`agents.js` 的 `AGENTS`），session id 卡 `^[A-Za-z0-9_-]{6,64}$`：
  那個字串會被直接送進終端機，放行空白或分號等於指令注入。
- **Claude 的 session 資料夾名＝把 cwd 的非英數字元全換成 `-`**
  （`D:\Workspace\Personal_Project\VoiceInk` → `D--Workspace-Personal-Project-VoiceInk`）；
  Codex 沒有這個對應，只能開第一行讀 `session_meta.cwd`（**帶 `forked_from_id` 的是母 thread 的重播，不能收**）。
- **內建瀏覽器是 `<webview>`（2026-09-04 從 iframe 換過來，比照 Orca）**：實測矩陣
  `scripts/probe-workspace-webview.js` 證明 Electron 43 的 `sandbox: true × webviewTag: true` 能用
  （attach 成 OOPIF、導航、標題都正常）。三件套缺一不可：① `webviewTag: true` **只開在主視窗**
  （字幕／HUD 用不到，少一扇視窗多吃一個能力）；② guest 不掛 preload；
  ③ **popup 一律在 app 層收斂**——`app.on('web-contents-created')` 給每個 webContents 補
  `setWindowOpenHandler`（http(s) → `shell.openExternal`、其餘 deny），因為 webview guest 的
  window.open 走不到主視窗那條 `attachWindowSecurity`。`partition="persist:wsbrowser"` 是持久的
  （登入狀態要留著）；`allowpopups` 交給 main 管就不怕 target=_blank 沒反應。
- **網址正規化不能只看「有沒有冒號」**：`localhost:5173` 的 `localhost:` 會被 `new URL` 當成協定，
  於是最常用的那個網址反而進不去。做法是先照原樣解析，**協定不是 http(s) 才**補 `http://` 重解一次
  （`javascript:alert(1)` 補成 `http://javascript:alert(1)` 會因為 port 不合法而失敗，照樣擋得住）。
- **本機 HTML 的預覽用 `srcdoc` ＋ `sandbox="allow-scripts"`，不給 `allow-same-origin`**：
  給了等於讓那份 HTML 拿到我們這個 origin 的一切。
- **側欄兩顆模式鈕（專案／對話），兩個清單各自是獨立容器**（`#projList`／`#chatList`），
  切換只 toggle `hidden`。**側欄沒有終端機清單**（2026-09-06 移掉）：終端機是分頁列上的一顆分頁，
  新增走分頁列的「＋」。因此**關掉終端機分頁＝刪掉那個工作階段**（沒有別的地方接得住它，
  留著就再也叫不出來），要二次確認；狀態燈（`.ws-tab-state`）、未讀點（`.ws-tab-unread`）
  與就地改名（`.ws-tab-rename`，右鍵選單）都在分頁上，由 `terminal-page.js` 推給 `paintTerminalTab`。
  `.chat-list-item` 三邊共用，合併成一個容器的話所有選擇器都會互相打到。
  用 `hidden` 收合的 `.sidebar-panel` **必須自己補 `[hidden] { display: none }`**（作者規則的 `display: flex` 壓得過瀏覽器內建樣式）。
- **`#termMain`／`.term-main` 這兩個名字不可以改**：終端機的「人在不在看」判定與
  `e2e-ux-tweaks-cdp.js` 都認它。工作區是加在它裡面，不是取代它。
- **哪一塊內容在畫面上只有一個擁有者**（`ws-tabs.js` 的 `showSurface`）：
  終端機那邊的 `showHost()` 也要走它，各自 toggle 自己的 hidden 會讓編輯器跟終端機疊在一起。
- **圖片不可以走「二進位檔」那條**：PNG／JPG 一定含 NUL byte，`readFile` 的二進位偵測會把它判成
  「不能編輯」，結果點開圖片畫面上什麼都沒有。做法是**先看副檔名**（`files.imageMime`），是圖片就回
  一個 `data:` URI（大小照樣受 `MAX_READ_BYTES` 管，CSP 的 `img-src` 本來就放行 `data:`）——
  **不另外開一個 IPC**。SVG 也走這條：`<img>` 不執行 SVG 裡的 script。
  回歸：`test-workspace.js` 的 [B]＋`e2e-workspace-cdp.js` 的 [D2]
- **Electron 43 沒有內建 PDF 檢視器**：`plugins: true` 也長不出來
  （實測矩陣 `scripts/probe-workspace-pdf.js`：plugins 開關 × blob:／file: 四種組合全都沒有
  `embed[type="application/pdf"]`），所以 PDF 只能自己用 pdf.js 畫在 canvas 上。
  **`pdfjs-dist` 整包 35MB ＋ 一個 37MB 的 `@napi-rs/canvas`（那是給 Node 端算圖的，用不到）**，
  `build.files` 只放行 `pdf.min.mjs` 與 `pdf.worker.min.mjs` 兩支，其餘連同 `@napi-rs` 一起排掉
  （不排的話 asar 從 421MB 變 457MB）。
- **pdf.js v6 的 `workerSrc` 不能給空字串**（會直接拋 `No "GlobalWorkerOptions.workerSrc" specified.`）：
  指到 asar 裡那支 worker 就好——file:// 開不出真的 Worker，pdf.js 自己會退回 fake worker
  把它 import 進主執行緒。**症狀是預覽一片空白**，看起來像 PDF 壞掉。
- **`netstat -ano` 的 `LISTENING` 沒有被在地化**（zh-TW 只翻欄位標題），所以可以直接比對這個字；
  刻意**不用 `Get-NetTCPConnection`**——那要自動載入 NetTCPIP 模組，`PSModulePath` 被污染時整組載不起來
  （`Get-NetAdapter` 已經踩過一次）。程序名要另外跑一次 `tasklist`（netstat 只給 PID）。
  同一個埠 IPv4／IPv6 各一列，要去重。回歸：`test-workspace.js` 的 [H]
- **搜尋只收字串、不收 regex**：收 regex 等於讓 renderer 送一個會災難性回溯的 pattern 把 main 卡死。
  四個上限（命中 200／掃 8000 檔／單檔 1MB／整趟 15 秒）少一個都會在大 repo 上把 UI 凍住。
- **新增／改名的「名字」是使用者打的，要在 `checkName` 就擋**：含 `/`／`\\`／`:` 等於在指定路徑，
  `resolveIn` 雖然是最後一道門，但在這裡擋才講得出人話；Windows 的保留檔名（`CON`、`PRN`…）
  建出來會是個刪不掉的東西。刪除另外要擋掉「專案根目錄本身」。
  回歸：`test-workspace.js` 的 [F]＋`e2e-workspace-cdp.js` 的 [I]（真的打 IPC）
- **拖資料夾加入專案的路徑要在 main 端收斂**：drop 的 File 由 preload 的 `webUtils.getPathForFile`
  轉成路徑，但每一筆仍走 `store.create` 的全套驗證（解析成絕對路徑、必須是存在的目錄、
  已存在就略過、上限照樣拋）——renderer 不能繞過對話框自己送任意路徑。
  回歸：`e2e-workspace-cdp.js` 的 [M]
- **分頁拖曳是 pointer 跟手＋FLIP，不是 HTML5 DnD**（使用者要求「拖住跟著滑鼠走、平滑推開別的」）：
  被拖那顆**留在 flex 流裡**靠 transform 跟手（它的槽位就是空格），跨過鄰居**中點**才
  `insertBefore`；其他分頁用 FLIP（記舊座標 → 反向 transform → 150ms 滑回）。
  落點是 **closestCenter**（拖曳中那顆的中心離哪個**靜態槽位**中心最近，跟額度卡片同一套）。
  測試要用 `Input.dispatchMouseEvent`（合成 PointerEvent 走不了真輸入管線），且**終點要放
  鄰居的正中心**——放到鄰居右緣時，只要那顆鄰居比再下一顆寬，拖曳中心就會離下一個槽位更近，
  **一次跳兩格**，斷言會假紅。
  `user-select: none` 不可省（拖曳變選字）。回歸：`e2e-workspace-cdp.js` 的 [L]
- **Git 面板的逐檔動作**：`stage`／`unstage`／`discard` 的檔名來自 renderer，
  `relPathOf` 擋絕對路徑與 `..` 段、git 參數一律陣列＋`--` 分隔；**捨棄救不回來**，
  renderer 的鈕要 3 秒二次確認（第一下變「確定？」）。`git log` 的欄位分隔用 `%x1f`，
  **不能跟 `-z` 混用**（NUL 同時是記錄與欄位的界線，整包變成一鍋湯）。
  回歸：`test-workspace.js` 的 [J]＋`e2e-workspace-cdp.js` 的 [E]
- **檔案樹展開／收合只能動自己那一列後面的子樹**：以前是 `renderTree()` 整棵重畫，
  等於把每一個展開過的層都再 `listDir` 一次，而且**捲動位置會跳回最上面**
  （展到第三層之後就找不到自己在哪）。收起來時把子節點丟掉、再展開重讀一次就好，
  順便反映磁碟上的變動，比自己維護一份快取便宜。
  回歸：`e2e-workspace-cdp.js` 的 [N]（在別列做記號，展開後記號要還在）
- **Ctrl+P／Ctrl+W／Ctrl+Tab 在焦點落在 `#termHost` 裡時一律放行**：那三顆在 shell 裡本來就有意思
  （Ctrl+W 刪一個詞、Ctrl+P 上一筆指令），搶走等於把終端機弄壞。
  三顆也只在 `#termMain` 真的看得見時才收（`offsetParent`），否則會把整個 App 的 Ctrl+P 吃掉。
- **快速開檔的檔案清單跟全文搜尋共用同一份 `walk`**（`search.listFiles`）：
  跳過的資料夾（`files.SKIP_DIRS`）與四個上限一定要一致，不然會出現
  「搜尋找得到但 Ctrl+P 找不到」這種說不清的怪事。模糊評分照 Orca 的
  `shared/quick-open-path-search.ts`（分數越小越前面），但**沒命中要回 `null` 不是 `-1`**——
  `-1` 是算得出來的合法分數，拿它當哨兵會把一筆真的命中丟掉。
  回歸：`test-workspace-nav.js` 的 [A]＋`test-workspace.js` 的 [R]
- **切分頁的 click 掛在 `.ws-tab-open` 上，不是 `.ws-tab`**（`.ws-tab` 那層只有 pointerdown 拖曳、
  中鍵與右鍵）：測試對著 `.ws-tab` 呼叫 `.click()` **什麼都不會發生也不報錯**，
  看起來會像「切分頁壞了」。
- **Monaco 只能走 AMD 的 `min/vs`，ESM 那份沒有 bundler 一 import 就死**：`esm/vs` 裡面有 98 個
  `import './x.css'`，瀏覽器不會把 CSS 當模組。AMD 那份自帶 `loader.js`（它自己注入 `<script>`，
  同源所以過得了 `script-src 'self'`），CSS 是獨立一支 `editor.main.css`，`<link>` 進來就好。
  三件事要一起做，少一件都是「看起來壞掉但不報錯」：① codicon 字型是 **`data:` 內嵌**的，
  `font-src` 沒放行只會看到一排小方框；② Monaco 的 Worker 是 **blob** 開的，
  `worker-src 'self' blob:` 沒放行時它會退回主執行緒，**diff 就算不出來**（並排編輯器畫得出來、
  但一條變更都不標）；③ `build.files` 只放行 `monaco-editor/min/**`（`esm`／`dev`／`min-maps`
  加起來 57MB 全用不到），asar 437MB → 460MB。回歸：`probe-workspace-monaco.js`
- **視窗藏著的時候 Monaco 不會做語法高亮**（背景 tokenize 走 `requestIdleCallback`，
  視窗不可見時根本不觸發）：測試裡 `show: false` 量到的是「整片同一個顏色」，
  看起來就像「這個語言沒支援」。探針要 `showInactive()`（不搶前景焦點）。
  斷言也**不可以只數 `.mtk` 節點**——沒高亮時每一段照樣是 `mtk1`，要比對**實際顏色**有幾種。
- **Monaco 的尋找列收起來時高度還在**（只是 `visibility: hidden`）：判斷開沒開要看 `.find-widget.visible`
  這個 class，量 `offsetHeight` 會永遠判成「開著」，於是切換鈕再按一次就沒反應。
  另外 `closeFindWidget` 是**命令不是動作**，`getAction` 找不到，要用 `editor.trigger`。
- **那份 `<textarea>` 還在，而且是雙向同步的**：Monaco 是真的內容來源，但存檔、草稿落盤、
  外部變更偵測、Hot Exit 全部仍讀 `#wsEditorText.value`。所以 Monaco 改 → 寫回 textarea；
  有人直接改 textarea → `pushValue` 推進 Monaco（走 `executeEdits` 不走 `setValue`，
  後者會把復原歷程清光）。少任何一邊，存下去的就是舊內容。
- **跳到某一行要等 Monaco 把 model 掛上去**：`useMonaco` 是非同步的，`openEditorTab` 之後
  馬上 `goToLine` 會跳在**上一個檔案**的 model 上。先記著（`pendingGoto`），掛好再補跳。
- **搬檔要擋兩件事，少一件就弄丟東西**（`files.moveEntry`）：① 資料夾不能搬進自己底下
  （`rename` 對這種情況的行為不一致，最壞整棵子樹變孤兒）；② 目的地同名就拒絕，**不覆蓋**
  （覆蓋救不回來，而使用者只是手滑放錯一格）。放在檔案上＝放進**那個檔案的資料夾**（比照檔案總管）。
  回歸：`test-workspace.js` 的 [S]
- **檔案樹的拖曳用 HTML5 DnD，分頁列刻意不用**：檔案總管本來就是這個手感，
  半透明拖影正好代表「要搬走的東西」，而且 drop 目標判定是瀏覽器算的。
  分頁列要的是「跟手＋平滑讓位」，那裡的拖影只會礙事——兩邊的取捨不同，不要統一。
- **worktree 的路徑一律由 main 組**：renderer 只送一個名字（走 `files.checkName`），
  位置固定是 repo 的**兄弟資料夾**（放在 repo 裡面會被自己的檔案清單、搜尋掃到，還可能被誤 commit）。
  要移除哪一個**用 `git worktree list` 的結果當白名單**比對，而且不准移主工作樹、不加 `--force`
  （有未提交變更時讓 git 擋下來——那些改動只存在那個資料夾裡）。
  `--porcelain` 是「一段一個、空行分隔」且**每段行數不一樣**（detached 的沒有 branch 那行），
  逐行看關鍵字、不要數行號。回歸：`test-workspace.js` 的 [T]
- **分頁列會橫向溢出，拖曳三件事一起才順**：① transform **只吃 X**（帶 Y 會讓分頁飛出那一條）；
  ② 鄰居讓位的距離要用**量出來的 gap**（寫死的值跟 CSS 差幾 px，放開的瞬間整排會跳一下）；
  ③ 位移要加上 `strip.scrollLeft` 的變化量，並在指標靠近邊緣時自動捲——沒有這段就**搬不到
  看不見的那幾顆旁邊**。捲軸用 `scrollbar-width: none` 藏起來（橫向捲軸會把分頁列撐高一截），
  改用滾輪橫捲＋切分頁時 `scrollIntoView`。
- **`workspaces.json` 的路徑不存在不可以整筆丟掉**（隨身碟拔掉、網路磁碟沒接上），
  只標 `missing: true` 讓 UI 講明白——丟掉的話插回硬碟專案就沒了。
- **空狀態的斷言不可以用「字數大於 N」**：文案上限是 12 字（下一條），
  收乾淨之後「請先啟用感測器」只有 7 字 → `textContent.length > 10` 變成假紅燈。
  要驗的是「有沒有講原因」（比對關鍵字），不是長度。
- **精簡說明文字時，測試裡的斷言字串要跟著掃**：精簡前 `grep` 測試腳本裡有沒有引用舊文案
  （這輪 `e2e-chat-cdp.js` 的掃描彈窗說明就中了一次）。空狀態 ≤ 12 字、hint 只留「這是什麼」，
  但「防誤解」的最短說法（dwm VRAM、磁碟測速含快取、風扇下限保險）**不準刪光**——拿掉會再被回報。

### 終端機

- **忙碌判定不能只靠 OSC 133 標記**：PSReadLine 會把整份提示字元（含標記）重送
  （實測 `ping -n 4` 三秒內收到 9 次 `D;0`）。標記要帶 `Get-History` 的 id，而且**比大小、不是比「跟上次不同」**
  （捲動重播會送更舊的 id）；**第一個看到的標記只是「現在這個提示字元」**，不能下結論。
  也不能只靠靜默（AI 代理 CLI 是常駐 REPL，shell 那層看不到指令結束）。兩者都要。
- **注入 PowerShell 的 `-Command` 字串不可含雙引號**（會變成單一 argv，內嵌雙引號跳脫規則很容易出錯）：
  用單引號＋`+` 相接（`pty.js` 的 `PS_INTEGRATION`），`$ok = $?` 必須是第一句。
- **狀態變動只能就地改那一列，不可 `renderList()` 重建整份清單**：待確認的刪除鈕與就地改名的輸入框
  都掛在 DOM 上，而提示字元標記三秒會重送九次 → **跑著的終端機刪不掉、也改不了名**
  （第二次點到的是已脫離 DOM 的節點，畫面上完全看不出來）。走 `refreshItemView()`。
- **「人在不在看終端機」要看 `#termMain` 有沒有被藏起來**：合頁後切到對話藏的是 `termMain`，
  `termHost` 自己不會變，只看 `termHost` 的話背景階段跑完永遠不亮未讀點。
- **`.chat-list-item` 同時是專案列的 class**：選擇器一定要限定 `#chatList` 或 `#projList`。
- **`term.open()` 前要先讓那一格可見**：掛在 `display:none` 上會開出 0×0 終端機，第一段輸出（提示字元）消失，
  看起來像 pty 沒起來。
- **shell 與啟動指令只收 key**（執行檔路徑與指令字串在 `terminal/store.js` 的固定表）；
  cwd 走 `terminal:pickDirectory` 對話框再由 main `statSync().isDirectory()` 驗過。
- **管理員終端機開不成 ConPTY，只能另開一顆提權程序代開**：CreateProcess 一律繼承呼叫者的
  token，唯一拿得到管理員 token 的 `ShellExecute runas`（UAC）又交接不了 pty handle。
  做法是把**自己**用 `Start-Process -Verb RunAs` 再開一份、帶 `--terminal-admin-host=<管道>`
  （`main.js` 最前面就攔下來，**要擋在 single instance lock 之前**，否則第二份會被自己 quit 掉），
  提權那份開 pty 再用具名管道把位元組轉回來。三件事缺一不可：
  ① host 的 socket 一 `close` 就把管理員 shell 全部 kill 掉再自己結束（沒人看的提權 shell 最糟）；
  ② 一顆 host 服務所有管理員階段，UAC 只跳第一次；
  ③ host 模式要 `app.setPath('userData', …temp…)`，提權程序寫進主 userData 會讓檔案擁有者變管理員。
  對面送來的東西一律重新收斂（shell 只認 key、cwd 要真的存在），host 不照著執行任意路徑。
  `-ArgumentList` 的元素含空白時 PowerShell 不會自己加引號，而那段字串又不准有雙引號 →
  用 `[char]34` 兜（`admin.psArgList`）。回歸：`probe-terminal-admin.js`（不需 UAC）＋
  `probe-terminal-admin-elevate.js`（**會跳一次 UAC**）
- 初始 snapshot 與後續 PTY 事件走同一條序列佇列；視窗背景時用 xterm 的同步 write buffer。
- **選取自動複製掛 `mouseup`、不掛 `onSelectionChange`**：後者在拖曳途中每過一格就發一次，
  等於每拖一列就寫一次剪貼簿。右鍵貼上讀的是 `navigator.clipboard.readText()`，
  **視窗沒有焦點時它會丟 `NotAllowedError: Document is not focused`**——使用者右鍵的當下一定有焦點，
  所以只影響自動化測試（CDP 要先 `Page.bringToFront`）；handler 本身照樣要吞掉這個錯。
- **側欄寬度走 `--chat-sidebar-w`，不要寫 inline width**：`.chat-sidebar` 的寬度在
  `main.css` 出現三次（基礎、Token Anxiety、900px），每一處都要留 `var(--chat-sidebar-w, <原值>)`，
  漏掉後面那條就會把拖好的寬度蓋回去。640px 以下側欄改成橫排、把手要 `display: none`。
  終端機不需要另外通知——`term-host` 上本來就有 ResizeObserver。


### HF模型（本機 LLM）

- **推論一律走 llama-server 的 router 模式**（不給 `-m`，只給 `--models-dir`）：它自己會發現模型、
  依請求路由、載入／卸載，**不要自己寫多模型程序管理器**。實測（`probe-hf-router.js`）：
  模型 id ＝**單檔的檔名去掉 `.gguf`／子資料夾的資料夾名**（不是裡面的檔名）；
  同一夾裡的 `mmproj-*.gguf` 會自動接成 `--mmproj`（**多模態零程式碼**）；
  `--api-key` 有效（不帶 401）；`GET /models?reload=1` 會重掃（**手動拖檔進資料夾零程式碼**）；
  沒先 load 直接打 `/v1/chat/completions` 會自動載入；**kill router 子程序會一起走**（不必追子 pid）。
- **`--models-preset` 的 INI 只在 router 啟動時讀**：改完參數一定要重啟（`applyPresets` 負責）。
  `[*]` 套全部、`[<模型 id>]` 蓋掉它；key 用長選項名（`ctx-size`／`gpu-layers`）。
- **記憶體配置以官方 `llama-fit-params` 為準，不是我們算的**：`-fit on` 是預設值，
  它會實際載一次模型量投影記憶體並產出 `-ngl`／`-ts`／`-ot`（MoE 那串 regex 手寫不出來），
  但**只調整使用者沒設的參數**——主動寫死 `gpu-layers` 等於把那套關掉。
  `fit.js` 下載完跑一次存進該模型的 meta，失敗就退回 `plan.js` 的估算（**不可讓 fit 失敗＝模型不能用**）。
  實測整顆放得下時它印 `-ngl -1`，要轉成 `all` 再送；`--fit-target` 在 Windows 上超過 4095 MiB 會溢位（上游 #20308）。
- **KV cache 一定要用 GGUF 寫的 `attention.key_length`／`value_length`**，不能拿
  `embedding_length ÷ head_count` 推：實測 Qwen3.5-4B 的 `embd/hc` 是 160、但 `key_length` 明寫 256，
  推導值會低估 **1.6～2 倍**（linguaforge 0.8B 是 2 倍）→ `gpu-layers` 給太多 → 載入時 OOM，
  而使用者只看到「載入失敗」。缺欄位時才退回推導，**不可以回 0**（回 0 等於說 KV 不佔空間）。
  回歸：`test-hfmodels.js` 的 [D2]
- **V 的 KV 量化需要 flash attention**（K 不用）：選到 `cache-type-v != f16` 就一定要一起送
  `flash-attn = on`。反過來 f16 那一檔**刻意不送** `flash-attn`——預設的 `auto` 已經會在支援的後端自己開，
  硬寫 `on` 在不支援 FA 的後端上會直接載不起來。
- **MoE 塞不下時搬專家、不砍層**（`n-cpu-moe`）：每個 token 只用到一小部分專家但**所有**專家都佔顯存；
  砍層數等於把注意力一起搬到 CPU（那才是真的慢）。
- **`presets.js` 的 `safeValue` 只清換行，不可以清 `[` `]`**：`override-tensor` 的值是 llama.cpp 自己產的
  regex（`blk\.(1[0-9])\.ffn_.*=CPU`），把中括號換成空白**不會報錯**，只會把 MoE 的層搬錯地方。
  INI 的區段判定是「整行以 `[` 開頭」，而我們永遠寫 `key = value`，值不可能在行首。
- **聊天的「本機模型」是 main 合成的 synthetic provider（`__local`）**：`chat.allProviders()` 只在
  **讀取／驗證**時把它併進來，`sanitizeProviders`（跑在 `store:set` 存檔路徑上）**必須把它過濾掉**——
  寫進 `config.json` 等於留一筆指向死掉埠號的設定。`reconcileProviderSelection` 遇到它要直接 return
  （否則編輯任何一組雲端供應商都會順手把使用者的本機模型選擇改掉）。
- **`readConfig` 的 modelId 不在清單內時回空字串、不退回第一顆**：`chat.send` 的守衛靠 `!cfg.modelId`
  擋下「拿清單外的模型名打過來」。退回第一顆等於 allowlist 失效（會真的打出去一個請求）。
  「選過的模型被刪掉要退回第一顆」是 main 的 reconcile 在**寫 store** 時做的，兩件事。
- **`hfToken` 不進 `STORE_ALLOWLIST`**：它是機密，只走 `hfmodels:setToken`／`tokenStatus`，
  回給 renderer 的永遠只有 `{ hasToken }`。renderer 連 `store:get` 都該被擋（回歸：`e2e-hf-cdp.js`）。
- **換模型資料夾不搬移舊檔**：搬 30GB 會把 UI 卡住好幾分鐘，搬到一半失敗更難收拾。舊的留原地並在 UI 講明。
- CUDA 執行環境（`llamaruntimecuda`）**兩個 zip 解到同一夾**（llama ＋ cudart）：少了 cudart，
  `llama-server.exe` 會在啟動時因為找不到 DLL 直接結束。需要 NVIDIA 驅動 ≥ 580，UI 只在夠新時才建議裝。
  「一鍵安裝最佳配置」就是照 `hardwareInfo().installable[].recommended` 挑那一顆，
  下載走既有的 `models:download`（續傳／解壓縮都現成的），**不要另寫第二套下載器**。
- **一個 repo 只抓一次檔頭**（`detail()`）：同一顆模型的各量化共用同一份架構
  （層數／head 數／`key_length` 都在檔頭，量化只改權重），所以拿第一個變體的前 1MB 算完，
  其餘變體套自己的檔案大小就好。每個量化各打一次 Range 會讓開一個 repo 送出二十幾個請求
  （unsloth 那批動輒 26 個變體）。回歸：`probe-hf-detail.js` 的「越大的量化不會被評得越好跑」。
- **HF 的 README 要先剝 HTML 再交給 `markdown.js`**：那邊是零 innerHTML 的，
  標籤會原樣變成文字印在模型卡最上面（實測 unsloth 的 README 開頭就是一整塊 `<div style=...>`）。
  剝的時候**要跳過圍籬程式碼區塊**（那裡的 `<` 是內容不是標籤）。
  YAML front matter 同理要剝掉，不然模型卡第一段是一串授權設定。
- **GGUF 常常沒寫 `general.parameter_count`**（unsloth 那批就沒有）：總參數要退回 HF `/api/models` 的
  `gguf.total`，而且要把它傳進 `gguf.activeParams(info, total)`——不傳的話 MoE 的激活參數永遠算不出來。

### Claude Code 工作台與轉換閘道

- **改 `~/.claude/settings.json` 只能動 `env` 裡我們管的那幾個鍵**：使用者那份還有 `hooks`／`enabledPlugins`／
  `statusLine`／`permissions`／`model`，整檔換掉（上游 cc-switch 的 SSOT 模型）等於換一次供應商就把它們弄丟。
  **切換時要先清掉前一家的鍵**（A 家用 `ANTHROPIC_API_KEY`、B 家用 `ANTHROPIC_AUTH_TOKEN`，
  只 merge 會兩把金鑰一起送）。壞掉的 settings.json 一律拋錯，不可當成空物件（當空的＝下一步把整份洗掉）。
  寫入前備份到 `<userData>/claude-backup/`、原子替換。回歸：`test-ccswitch.js` 的 [B][C]
- **「切走」一定要有「切回」**：`official` 預設（排第一、`auth: 'none'`、`baseUrl: ''`、env 空）＝寫出空 env，
  靠 `applyEnv` 把我們管的鍵整組清掉，Claude Code 回到自己的 OAuth。
  **刻意不寫 `api.anthropic.com`**（會蓋掉使用者的自架／企業代理設定），也不給 Base URL 與模型欄位。
  `detectActiveId` 要認「還沒切過 ＋ env 沒有 Base URL＝官方訂閱作用中」，否則新使用者看到整排 tile 都暗的。
  內建不可刪到少於一筆。
- **tile 拖曳走 `renderer/scripts/grid-reorder.js`**（跟額度卡片同一套：跟手 overlay ＋ 鬼影，
  拖曳中只改 transform、放開才動一次 DOM）。`.cc-tile` 一定要 `user-select: none`——
  不擋的話按住拖過去會把 tile 上的文字整片反白。回歸要用 `Input.dispatchMouseEvent`，
  合成的 PointerEvent 不會產生文字選取（那條斷言會恆綠）。
- **tile 的順序＝store 的陣列順序**（使用者可以拖，跟額度卡片一樣）：`renderProviders` 不再依
  preset 表重排，否則拖好的順序會被下一次重畫洗掉。「＋」固定收在最後且不參與排序
  （選擇器一律 `.cc-tile:not(.is-add)`）。
- **供應商的「上游格式」就是路由開關**：`anthropic` → 直連，`openai_chat`／`openai_responses` → 經本機閘道；六家內建與自訂都能選。
  測試鈕一律以選定的「上游格式」送最小請求驗證連線。
  `providers.routeFor()` 是唯一推導點，`list()` 把算好的 `route` 回給 renderer；
  renderer **不可以自己看 `preset.route`**（custom 在表上寫的是 `direct`，會漏掉整組自訂供應商——
  閘道狀態列、「需要閘道」徽章三處都會錯）。切換供應商**不會自動啟動閘道**，閘道只由頁面上的單一開關手動啟停。
- **自訂的閘道路由 key 是 provider id、不是 preset id**（多筆自訂共用 preset id 會互相蓋，症狀是打到別人的上游）；
  `server.js` 的路徑 regex 因此要收底線。`keyForPreset()` 先按 provider id 找，找不到才退回「這家的第一筆」。
- **內建各家一律不吃使用者填的 Base URL**（`allowsCustomUrl()` **只放行 `custom`**）：表上的端點是
  實測查證過的事實，走閘道那幾家的上游更是在 `gateway/server.js` 的 `ROUTES`（還帶專屬標頭：
  Codex 要 `chatgpt-account-id`／`originator`）；格式可在供應商彈窗選，填了不會生效。要接自架端點就開一筆自訂。
  **UI 藏起輸入格不夠**，`sanitizeAll`／`create`／`update` 三處都要擋（store 會被手改）；
  `baseUrlFor()` 另外負責「這一筆實際打哪」——它跟「能不能自己填」是兩件事，合成一個函式會讓
  內建直連那幾家連預設端點都拿不到。回歸：`test-ccswitch.js` 的「內建不吃自填 Base URL」
- **`baseUrl` 只放行 http(s)**（那個字串會寫進使用者的 settings.json，`file:`／`javascript:` 進去等於幫別人埋東西）；
  `authField` 只收 `ANTHROPIC_AUTH_TOKEN`／`ANTHROPIC_API_KEY`（填錯的症狀是靜默 401）。
  **舊檔只有一個 `model`，語意是四個等級全套**，`sanitizeAll` 要靠「三個等級鍵在不在」補回去
  （用「值空不空」判斷的話，使用者刻意清空某一格會在下次讀檔被塞回去）。
- **`presets.js` 的端點與格式要對照官方文件／實測**：401／403 代表端點在但驗證失敗，404 才是 URL 或格式路徑不符；
  不同家不能共用同一條路徑。加新的一家先跑 `probe-ccswitch-endpoints.js`，變更格式要同步更新測試鈕的驗證路徑。
- **Codex 的 Responses 端點不是公版**（實測 `probe-ccswitch-codex.js`）：`store` 一定要明寫 `false`
  （不寫 400 `Store must be set to false`）、`max_output_tokens` 與 `temperature` 一律 400
  `Unsupported parameter`。三個都在 `convert.forCodexBackend`，**只對 Codex 那條路由套**
  （Grok／Ollama／OpenCode 走同一個 `toResponsesRequest` 但沒有這些限制）。
  症狀是閘道一律回「上游回應失敗（HTTP 400）」→ Claude Code 顯示 502，看不出是哪個參數。
  同一組限制在「測試」鈕的 `models-scan.probeBody` 也要套（那邊也送 `max_output_tokens: 1`）。
- **「宣告 1M 上下文」＝模型名尾巴加 `[1m]`**（跟 cc-switch 同一套約定）。實測（本機 sink 收 Claude Code
  真流量）：`[1m]` **是唯一開關**——只設 `CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000` 不會讓它送 1M beta，
  Claude Code 自己的提示也寫「append [1m] to the model name for 1M」。加了之後**它會自己把後綴剝掉再送**
  （上游收到乾淨的模型名），並自己在 `anthropic-beta` 補 `context-1m-2025-08-07`——所以直連那幾家
  不會因為開了 1M 就打壞。
  四個等級都要加，而且 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 與 **`CLAUDE_CODE_AUTO_COMPACT_WINDOW`
  兩個鍵要一起放大**——只加後綴的話，preset 原本釘住的自動壓縮窗（Codex 是 372000）會把門檻夾回去
  （`Math.min(模型視窗, 這個值)`），視窗開了也用不到。
  閘道仍要 `convert.stripContextMarker`：**舊版 Claude Code 會原樣送出**（cc-switch issue #3980），
  而上游不認（實測 Codex 回 400 `The 'gpt-5.6-sol[1m]' model is not supported`）。
  **這是「宣告」不是「升級」**：上游只有 372K 卻宣告 1M，講到超過就會被上游擋下來，UI 要講明。
- **Grok 的訂閱制走 `cli-chat-proxy.grok.com` 不是 `api.x.ai`**：CLI 的 OAuth token 打 api.x.ai 一律
  403 `personal-team-blocked:spending-limit`（那條是給 **API 金鑰**用的、看儲值餘額，跟訂閱額度無關）。
  閘道上游同網域的 `/v1/responses`，**要帶 `x-grok-client-version`**（不帶回 426 outdated）。
- **模型掃描兩個實測陷阱**：① Codex `/models` **一定要帶 `client_version`**（不帶 400 missing field；
  帶舊版回 **200 但空清單**，看起來像成功其實沒東西），列位叫 `slug` 不叫 `id`；
  ② Grok 額度用完回 403 `spending-limit`（端點與憑證都對，**不可**講「API Key 可能不正確」）。
  動 `modelsUrl` 前跑 `probe-ccswitch-models.js`。
- **Codex 與 Grok 的登入各走各家官方支援的流程**（查 OIDC discovery 決定）：xAI 有 device code → Grok 走 device code；
  OpenAI 只列 `authorization_code`＋`refresh_token` → Codex 走 PKCE ＋ loopback
  `http://localhost:1455/auth/callback`（跟官方 `codex login` 同一組 client id／redirect／scope，從執行檔實測取得）。
  cc-switch 對 Codex 用 device code，他們自己文件寫明那是逆向的、可能違反條款——**不要照抄**。
  redirect 的埠是註冊死的，換一個會被直接拒絕。
- **loopback callback 一定要驗 `state` 且綁 `127.0.0.1`**（那條路上會收到 authorization code）；
  流程結束（成功／失敗／取消／關彈窗）都要把 server 收掉，否則使用者之後跑 `codex login` 會被我們佔著 1455 埠。
- **自己登入的帳號與「沿用 CLI 憑證」是兩條並存的路**：帶 `oauthAccountId` 走 `oauth.tokenFor`（存自己的 store，可寫回），
  沒帶就讀 CLI 的 auth.json（**只讀不寫**）。**兩條的快取鍵要分開**，否則換帳號還拿到上一個人的 token。
  刪帳號要連帶 `providers.unbindAccount`（留一個指向不存在帳號的 id，症狀是「切過去才說找不到登入帳號」）。
  **refresh token 可能輪替**，回應帶新的就要換掉存起來的那顆，沿用舊的下次會 `invalid_grant`。
- **使用者的 Ollama 金鑰不進 settings.json**，由閘道自己去 store 取——`settings.getProviderKey` 回的是 Promise，
  沒 `await` 會把 Promise 物件當成 token 送出去。
- **CLI 更新一律用該工具自己的 updater**：本機實測只有 `codex`／`opencode` 是 npm global，
  `claude` 在 `~/.local/bin`、`grok` 在 `~/.grok/bin`、`agy` 在 `AppData\Local\agy\bin`——
  對它們跑 `npm i -g` 會裝出第二份互相蓋。npm registry 只留著查版本號。
  **Antigravity 沒發 npm**（但有 `agy update`），UI 要講「按更新讓 CLI 自己檢查」而不是「離線？」。
- **查 npm `/latest` 不可以帶 `Accept: application/vnd.npm.install-v1+json`**：那個精簡格式只有 packument 端點支援，
  `/latest` 會回 **406 空 body**，錯誤被 `.catch(() => '')` 吃掉，症狀是每一家都顯示「查不到最新版（離線？）」。
- **MCP 存在 `~/.claude.json` 不是 `settings.json`**：那份檔案裝著全部專案的歷史、動輒好幾 MB，
  只能「讀進來 → 只改 `mcpServers` → 原子寫回」。Claude Code 沒有「停用」欄位，停用的搬到我們自己的 store
  （直接刪掉使用者就再也找不回設定）。Windows 上 `npx`／`npm`／`node` 是 `.cmd`，要包成 `cmd /c`
  （已經是 cmd 的不可重複包）。
- 閘道與 AGY 共通：`thinking` block 不回送上游；工具 schema 走白名單；圖片只收 `data:` URI。

### 用量統計（codeusage）

- **五家的記錄是 GB 等級**（實測 90 天內 Claude 543MB／Codex 4.2GB／Grok 444MB）：每個檔案記位移游標只讀新增那段，
  且**只在使用者按「掃描本機記錄」時跑**。折成「每小時 × 供應商 × 模型」的桶子，原始事件不留。
- **增量掃描要把「這個檔案用哪顆模型」跟著游標留下來**：Codex 只在 `session_meta`／`turn_context` 寫一次模型，
  下一輪只讀新附加的那段就讀不到 → 之後每筆都記成 `unknown`。
  `scanSource` 的 `cursors[key]` 要存 `model` 並在下一輪回填。
- **游標 key 必須跟著檔案走（`source.keyOf`），不能認絕對路徑**：Codex／Grok 的 session 檔會從
  `sessions/` 搬進 `archived_sessions/`，搬完之後新路徑沒有游標 → 整份檔案從 0 重讀、
  整個 session 的用量算兩次（模擬重現：搬移後 +N 筆假事件）。Claude／Codex 用檔名（UUID 唯一）、
  Grok 用上一層資料夾名（檔名一律叫 `updates.jsonl`）；`pruneCursors` 靠游標的 `path` 欄驗存在，
  舊格式（無 `path`）一併丟掉。回歸：`test-code-usage.js` 的「搬到 archived 後不重複計算」
- **Codex 子代理（fork）的 rollout 開頭是「母 thread 整份歷史的重播」，一筆都不能收**：
  `session_meta` 帶 `forked_from_id`／`parent_thread_id` 時，後面幾千行是從母檔複製過來的舊記錄，
  **而且每一行都蓋上 fork 當下的時間戳** → 憑空多一份用量，還全部塞進同一個小時的桶子
  （實測 60 份子代理檔重播出 7.8 萬筆假請求，單一小時 16539 次）。重播段落沒有 `turn_context`
  所以連模型都讀不到，症狀是「有 1 個模型還沒設單價：unknown」——**那不是缺單價，是重複計算**。
  重播的結束點＝第一個 `turn_context`；`state.replay` 要跟 `model` 一樣存進游標
  （檔案還在寫時會掃到重播的一半，不接回來剩下那半份就被當成新用量）。
  `session_meta` 的預過濾**不可以用 `"model"`**（fork 那份只有 `model_provider`，會在那裡就被擋掉）。
  回歸：`test-code-usage.js` 的 [C] fork 段落 ＋ `probe-code-usage-audit.js` 的 [E]（拿母檔逐筆核銷）。
- **三個「加錯就差十倍」**：Codex 的 `token_count` 要加 `last_token_usage`（單輪）不是 `total_token_usage`（累計）；
  Claude 串流同一則 assistant 會寫好幾行，要靠 `message.id` 去重；
  `input` 有沒有含 cache 三家不同（**Claude 沒含、Codex 與 Grok 有含**，後兩者要扣掉 cached 才不會重複計價）。
  Grok 的 `turn_completed` 自帶 `costUsdTicks`（**所有世代都是 1 USD = 1e10 ticks，4.6 也一樣**——
  依據是 CLI 自己附的 `~/.grok/docs/user-guide/14-headless-mode.md`：那份文件明寫「1 USD = 10^10 ticks」，
  範例還同時給 `costUSD: 0.01268905` 與 `total_cost_usd_ticks: 126890500`（比值剛好 1e10），而且那個範例用的就是 grok-4.6。
  **不要用「ticks ÷ 表列單價」去反推單位**：CLI 的實收價比 api.x.ai 表列便宜約 3～4 倍（訂閱制／build 檔位），
  照那個比值猜會得到「4.6 是 1e9」的錯誤結論，把花費一次灌水 10 倍），
  OpenCode 的 `message.data.cost` 也是真花費。
- **快取的價錢一定要分開算**（長對話九成以上 token 走快取）：Anthropic 規則是 read = input × 0.1、
  **5 分鐘寫入 ×1.25、1 小時寫入 ×2**，而 Claude Code 寫的幾乎都是 1h
  （`usage.cache_creation.ephemeral_1h_input_tokens`，實測 78%）——混在一起用 5m 價算會低估三成多。
  桶子有獨立的 `cacheWrite1h` 欄位。**「OpenAI 的自動快取不收寫入費」只到 gpt-5.5 為止**——
  官方表從 gpt-5.6 那一代起多了「cache writes」一格（＝input × 1.25，astra 是 12.5），
  照舊寫 0 會少算；OpenAI 沒有 5m／1h 兩檔，`cacheWrite1h` 要寫成跟 `cacheWrite` 同價
  （留 0 等於宣告 1h 免費，空著又會被 `costOf` 推成 1.6 倍）。xAI／Gemini 仍是 **0 不是「沒填」**。
  單價彈窗四格：輸入／輸出／快取讀／快取寫（1h 沒填就用 5m × 1.6 推）。
- **趨勢與分佈都要把 token 拆成輸入／輸出／快取讀／快取寫**（`emptyTotals`＋`addTotals`，
  `fillSeries` 與 byModel／byProvider 共用）：只回一個總數的話，使用者看到「幾百億 token」
  無從判斷那是真的在打模型還是在讀快取——實測本機 97.5% 的 token 是 cache read。
  1h 快取寫入在顯示層併進 `cacheWrite`（價錢在 `costOf` 仍各算各的），不併就會憑空少一段。
- **沒有單價的模型 `costUsd` 要回 null 不可以回 0**（0 會被當免費加進總額，總花費少一截而且完全看不出來）；
  UI 另外列出「哪幾個模型還沒設單價、少算了幾次請求」。
- **模型 id 要正規化後才合併**：`claude-haiku-4-5-20251001` → `claude-haiku-4.5`、剝供應商前綴、收斂思考檔位；
  **剝 `-thinking` 但不剝 `-lite`**（`gemini-3.1-flash-lite` 剝掉會對到不存在的模型，而 Flash-Lite
  只有 Flash 三分之一的價）。`model: "<synthetic>"` 是 Claude Code 本機補的假訊息，不算進統計。
  `gemini-pro-agent` 就是 Gemini 3.1 Pro 的 agent 檔位 → 套 3.1 Pro 的價，不要留 `null`。
- **「不是模型名的 id」直接不收**（`pricing.isJunkModel`，一兩個字元；實測有代理往 Claude Code 的
  記錄寫 `model: "m"`）：留著會永遠掛在「未設單價」那一列，而使用者根本填不了單價。
  **判準是「不是模型名」不是「我不認得」**——`unknown` 要留（真的有用量，丟掉等於少算）。
  `addEvent` 與 `loadBuckets` 兩邊都要擋（後者才讓舊檔立刻乾淨，不必等使用者按重掃）。
- **改 `normalizeModel`／`ALIASES` 一定要把 `pricing.RULES_VERSION` +1**（sync 看到版本對不上會自己整份重讀，
  使用者不必去按「全部重讀」）；單價表本身改動不必（金額每次 stats 現算）。
- **掃描上限訂太小會靜靜少算**：單行 16MB（實測有 4.2MB 的單行）、單檔 1GB（實測有一份被整個跳過）。
  讀取本來就是逐行串流不佔記憶體，上限只是防「混進奇怪的東西」。放寬後同機掃描量 2.6GB → 5.4GB。
- **Antigravity 本機沒有 session 記錄**，只統計得到經過本 App 的 AGY 反代那段，UI 要講清楚。

### 額度（usage）

- **`mergeExpectedWindows` 只能由 `usage/index.js` 呼叫，`syncAntigravity` 不准先補一輪**：
  補視窗需要「上一次的快取」才做得對，而只有 `mergeAccountState` 拿得到 previous。先用 `previous=null` 補完，
  上層會看到四個 id 都存在 → 撿不回快取的真實值，也偵測不到有視窗是補的而降級成 `estimated`，
  結果是**憑空的「100% 已用盡」被標成「官方 API · 已讀取真實額度」**。
  **空窗（API 失敗）也不可 merge**：`windows.length === 0` 時走 6h soft cache，沒快取就維持空。
  回歸：`test-usage.js` 的「同步只回上游真的給的視窗」＋「API 失敗且無快取時不合成 100% 假額度」
- **訂閱方案的來源全在本機登入檔，不在額度 API**：Claude 讀 `.credentials.json` 的 `subscriptionType`
  （拿 `extra_usage.is_enabled` 猜會把 Pro 寫成「Pro / Max」）、Codex 讀 `auth.json` → `tokens.id_token` 的
  `https://api.openai.com/auth` claim（新版沒有頂層 `plan_type`）、Grok 退回 access token 的數字 `tier` claim。
  共用 `shared.readJwtClaims`（不驗簽：來源是本機檔案，只取標籤字串）。
- **Anthropic `/api/oauth/usage` 的 `seven_day_opus` 是 Max 專屬的第三條上限**（Claude Code 自己的 `/usage`
  就畫三格）：非 Max 方案上游回 **`null` 不是 0**，所以只能靠 `Number.isFinite(utilization)` 跳過，
  不可以當成「用了 0%」多畫一格。同層還有 `seven_day_sonnet`／`tangelo`／`iguana_necktie` 等實驗欄位，
  實測全機回 null，**不要照抄整包欄位**。
- **Command Code 的額度在 `GET https://api.commandcode.ai/alpha/billing/credits`，不是 `alpha/usage/summary`**：
  後者也回 200，但內容是計費週期的花費報表（`totalCost`／`totalTokens`／`periodBasis`），**一個上限欄位都沒有**——
  拿它當額度會每次都 parse 不到，卡片顯示成「0% 全新未用」，比空白更糟（那是會被相信的假數字）。
  額度在 `windowLimits.fiveHour`／`weekly` 的 `{ used, cap, resetAt }`：跟前兩家不同，**給的是真的用量與上限**
  （單位 credits），直接餵 used/limit；`resetAt` 可能是 **epoch 秒或毫秒**，要轉 ISO。
  每月視窗則用 `credits.monthlyCredits`（剩餘）＋`billing/subscriptions` 的 `planId`／`currentPeriodEnd` 組成；
  `cap` 缺了或是 0 就跳過那一格。尚未使用的 5 小時滾動視窗可以沒有 `resetAt`，不可自行推算。
  `limited: false` 是正常狀態不是錯誤（加購 credits 不受視窗限制）。金鑰走 `resolveCommandCodeKey`：
  `COMMAND_CODE_API_KEY` → `~/.commandcode/auth.json` 的頂層 `apiKey`（**只讀不寫**）→ CC 代理供應商 store。
  格式跟 OpenCode 那份「以服務 id 分組」的表不同，所以兩支分開。
  **第三段（CC 代理 store）不可省**：在 Studio 開一把 API key 是官方支援的用法，不是每個人都跑過
  `cmd login`；只認那個檔案的話，有金鑰的人在 App 裡沒有任何地方填得進去，而錯誤訊息還會叫他去跑
  一個他根本不需要的指令。這是 `/alpha` 路由、上游會動，
  動之前跑 `scripts/probe-usage-endpoints.js`。
- **OpenCode Go 與 Ollama Cloud 走各自的官方端點，不要退回本機估算**：
  `GET https://opencode.ai/zen/go/v1/usage`（回 `usage.rolling|weekly|monthly` 的 `{status, percent, resetsAt}`）／
  `GET https://ollama.com/api/usage`（目前回 `limits.monthly.usage`）。兩支都是第一方但**沒寫進文件**，
  動端點或解析前後都要跑 `scripts/probe-usage-endpoints.js`。三個實測要點：
  ① OpenCode 的 **401 是金鑰壞掉、403 `EntitlementError` 是沒有 Go 訂閱**，合併訊息等於把人送去查一把正確的金鑰；
  403 用 `disconnected`（不是 `connected`），否則 6h soft cache 會把訂閱到期前的舊視窗撈回來，看起來像還有額度。
  ② **Ollama 的 `usage` 是 0～1 的比例**（0.98＝98%）不是百分比，而且上游**一個重置時間都不給**——
  卡片顯示「上游未提供重置時間」就好，自己算一個假的填進去就是在冒充官方值。
  ③ 金鑰解析只有 `usage/api-key.js` 一處：環境變數 → OpenCode `auth.json`（**只讀不寫**）→ CC 代理供應商 store。
  舊的「唯讀 `opencode.db` 加總 `step-finish` 成本」已整支移除（那個數字含所有經 OpenCode 的供應商，
  跟 Go 訂閱的計費視窗不是同一件事）；本機成本統計留在「用量統計」那半。
- 額度 IPC 只允許主視窗；renderer 不可指定 provider URL／credential path。
  Antigravity 的 `read-windows-credential.ps1` 必須 unpack（外部程序執行不了 asar 內檔案）。
- 卡片與頂部橫條同走 `visibleAccounts()`；額度卡依可見數排版：2 張／4 張是 2 欄、3 張／5 張／6 張是 3 欄、7 張是 4 欄（1 張或 0 張退回 1 欄），視窗縮放不改欄數，只改卡片大小；維持 `align-items: start`＋`min-height: 250px`；
  標題是 provider accent 實心 pill（**不放 LOGO 方塊或方案副標**），卡內小字 12px／`--text-secondary`。
- 排序對齊 Token Anxiety：**不用 HTML5 DnD、不引 dnd-kit**（HTML5 DnD 一定會生半透明拖影）。
  pointer 直拖；跟手的是 `position:fixed` overlay（opacity 0.98），格子裡是**鬼影預覽**（opacity 0.18）。
  **拖曳中不准 `appendChild`**，只把卡 `translate3d` 到開始時記住的槽位；碰撞打靜態槽位
  （pointerWithin → closestCenter），不要打動畫中的 `getBoundingClientRect`。放開才改 DOM 並存一次。
  監聽掛 `window`（`setPointerCapture` 可能被隱式釋放）。量 last 前 `getAnimations().cancel()`；
  `.is-sorting` 要關掉 hover lift 與 transform transition。Space／方向鍵／Enter／Esc 鍵盤排序，
  reduced motion 不播位移。

### AGY 反代

- **憑證由 Antigravity CLI（`agy.exe`）或 IDE 維護，VoiceInk 只讀不寫**；只裝 CLI 完全可用。
  `credential.detectSources()` **只認執行檔不認資料夾**（解除安裝會留下空的 `Programs\Antigravity`）。
  **不做內建瀏覽器 OAuth 登入**（三種加帳號方式全都需要 client_id + secret），偵測不到就顯示引導。
- **token 續期靠代跑 `agy.exe models`**（`credential.nudgeCli`）：access token 只有 1 小時，
  而我們沒有 client id／secret → `refreshAccessToken` 永遠回空。兩條路徑：
  **stale 但還沒過期 → 背景跑、這次照回舊 token**（不擋使用者）；
  **真過期或 401 → 等 CLI 跑完再重讀憑證**，且**必須確認 access token 真的換了**（否則等於把死 token 再送一次）。
  冷卻 60 秒＋`nudgeInFlight` 合併（token 尾聲每個請求都會走到這裡），逾時 30 秒。
- **代跑 CLI 一定要用 `spawn` 且 `stdio: 'ignore'`**：`execFile` 會把三個 stdio 都接成 pipe 且不關 stdin，
  `agy.exe` 拿到一條永不 EOF 的管線就卡在那裡等到逾時（主控台跑只要 2～3 秒）。
  實測矩陣 `scripts/probe-agy-nudge.js`（**動 `runAgyCli` 前先跑**）。
- **「refresh 拿不到」不等於「token 過期」**：`tokenIsStale` 的 15 分鐘是「該去續期了」的提前量，不是失效線；
  把它當過期等於每個 token 的最後 15 分鐘都被自己作廢。唯一例外是 `mustRefresh`（上游回過 401）。
- **上游 401 之後必須 `credential.invalidateToken()` 連帶設 `mustRefresh`**（只清記憶體快取的話，
  下一輪看本機 expiry 還沒到就把同一個死 token 再送一次，等於沒重試）。
- **反過來，`mustRefresh` 只有 401 能設**：`acquire` 失敗後的清快取**不可以**呼叫 `invalidateToken()`——
  任何暫時性失敗（PowerShell 逾時、網路抖動）都會把憑證永久卡在 `TOKEN_EXPIRED`（重開 App 才好）。
  失敗只清 `cache.token`／`cache.expiresAt`。
- **端點順序是 sandbox → daily → prod**（同一組憑證同一個請求，prod 回 429 RESOURCE_EXHAUSTED、sandbox 回 200）；
  可重試狀態（0/403/429/5xx）才往下換端點，400/401 換網域也沒用。
- **不要送 `x-goog-user-project`**（`loadCodeAssist` 回的 project 沒啟用 Cloud Code Private API，
  帶上去每個端點都 403 SERVICE_DISABLED）；project 放 body 就正常。
- **`countTokens` 的信封不一樣**：只吃 `{ request }`，多送 `project`／`model`／`userAgent` 會 400 Unknown name
  （`model` 要塞進 `request` 裡）。
- **`thinkingBudget: 0` 不能無條件送**：名單 `REJECTS_ZERO_BUDGET` 是**實測**出來的，而且上游錯誤訊息不只一種
  （`Budget 0 is invalid...` 或看起來像整包壞掉的 `Request contains an invalid argument`，後者很容易誤判成
  模型不可用）。別靠模型名猜（`claude-opus-4-6-thinking` 名字有 thinking 但接受 budget 0）。
  反過來也別為了省事一律不送（關思考能省 thinking token）。維護跑 `scripts/probe-agy-upstream.js`。
- **`agy/catalog.js` 才是模型清單的權威來源**，`model-map.js` 只翻譯「上游沒有的名字」。
  上游 `fetchAvailableModels` 回的 `models` 是**以 model id 為 key 的物件**（用 `Array.isArray` 判會靜默拿到空清單）。
  排序：Claude 池（含 GPT OSS）在前、Gemini 在後；世代由新到舊（`3.10` > `3.2` > `3`），
  Gemini 同代思考強度 high → medium → tiered → low → extra-low → lite，`pro-agent` 沒有世代號排最後。
- **映射表不可覆蓋真實存在的上游 id**（`gemini-3-flash` 上游真的有，使用者指名它就該用它；
  表裡只放上游查無此名的，如 `claude-sonnet-4-5-20250929`）；
  **每個映射目標都必須是實測可用的模型**，`DEFAULT_MODEL` 尤其致命（未知模型的退路指到 404 等於全掛）。
  回歸：`test-agy-mappers.js` 的「映射目標都在實測可用清單內」。
- **`/v1/models` 用即時型錄，但空清單要退回靜態表**（客戶端拿它填模型下拉，回空的比給舊清單更糟）。
- **cloudcode-pa 的 SSE 每格包一層 `response` 信封**，轉換前一定要 `unwrapEnvelope`；非串流則直接是本體。
- **usage 新舊格式看欄位存不存在，不是看值**：舊格式 `candidatesTokenCount` 已含 thinking／tool；
  新格式 `total_output_tokens` 不含，要把 `total_thought_tokens`＋`total_tool_use_tokens` 加回去。
  寫成看數值就會在 0 的時候算錯（`agy/gemini.js` 單一實作，兩協議共用，勿各寫一份）。
- **送上游的 function schema 走白名單**（`sanitizeSchema`）：客戶端／MCP 的完整 JSON Schema 帶
  `$schema`／`additionalProperties`／`oneOf` 原樣轉送會 400 INVALID_ARGUMENT。白名單擋不住三種
  「欄位名對、型別不對」的寫法，**全都會讓整包請求 400、所有工具一起陣亡**（接 Claude Code 帶 195 個 MCP 工具時踩到）：
  ① `type: ['string','null']` → proto 的 type 不是 repeating，收斂成單一型別＋`nullable`；
  ② 非字串 enum（`{type:'boolean', enum:[true]}`）一律剝掉（Gemini 的 enum 只吃字串陣列）；
  ③ `anyOf:[X, {type:'null'}]` → null 那支換成 `nullable`（只剩一支就攤平）。
- Anthropic 歷史訊息裡的 `thinking` block **不回送上游**（沒有原始 signature 會被拒）；
  `tool_result` 要靠先前 `tool_use` 的 id→name 對照補上 `functionResponse.name`。
- 非 2xx 要 `discardResponse`（`body.cancel`）：401 重試與 429 換端點不消耗 body 的話 undici 連線會卡到 GC。
- server 檢查 `Host` 必須是 127.0.0.1／localhost（擋 DNS rebinding）；`/health` 刻意不需鑑權。
- `agy/logs.js` 的 `node:sqlite` 是同步 API，**每個操作都要能失敗**（防毒會鎖 db 檔，寫不進日誌絕不能連帶讓請求失敗）。
- **`agy:*` IPC 的錯誤訊息走 `userMessage` 白名單**：只有我們自己建構、內容固定的 `CredentialError` 帶這個欄位，
  其餘（`UpstreamError`）一律變成通用訊息。不要改成「有 message 就送」。
- **`main.js` 的 `registerAgyIpc({ service })` 是逐一列舉的白名單**：agy/index.js 新增方法沒補一行，
  renderer 只會看到通用的「反向代理操作失敗」，完全查不出原因。`registerUsageIpc` 同理。
- **憑證指引不能只綁在「服務執行中」**：`status()` 停止中刻意不做 `credential.acquire`（那會開 PowerShell，
  5 秒一輪的輪詢付不起），但「可用模型」不需要服務跑著也能查——`loadModels` 失敗要自己叫出
  `#agyCredentialHelp`，並用 `credentialHint` 撐過下一輪 `renderStatus`。`status()` 停止中仍回 `sources`。
- **頁上有兩組 Base URL**：OpenAI 相容客戶端要 `http://127.0.0.1:<port>/v1`，
  Claude Code／CC Switch 要根位址（帶 `/v1` 會變成 `/v1/v1/messages` → 404）。
  回歸：`e2e-agy-cdp.js` 的「Anthropic 那組不帶 /v1」。
- **統計的時間範圍是 main 的白名單**（`logs.STAT_RANGES`：6h／24h／7d／30d／all）：renderer 只送 key，未知值退回 24h。
  序列**必須補零**（`fillSeries`，SQL 只回有資料的桶）；summary／series／models 要套同一個 cutoff。
- **`.agy-model-row` 已被「可用模型」面板佔用**，統計的模型分佈列叫 `.agy-dist-row`（撞名會把進度條壓成一列看不見）。
- `refreshStatus()` 要用遞增 generation 忽略過期回應（慢回應會寫回舊 Base URL）。

### 系統監控

- **一定要用 `Win32_PerfRawData_*` 不能用 `Win32_PerfFormattedData_*`／`Get-Counter`**：
  實測（474 進程）formatted 500ms、raw 158ms；GPU 引擎 `Get-Counter` **5335ms**、raw **67ms**。
  raw 回的**不是百分比也不是速率**，是累計的 100 奈秒／bytes，一定要配同一筆的 `Timestamp_Sys100NS` 算差值——
  當成算好的值直接顯示會得到非常像真的、但完全錯的數字。整輪預算 ~310ms，動之前先重測。
- **`Win32_VideoController.AdapterRAM` 是 uint32**：8GB 以上一律爆掉（16GB 的卡回 4293918720＝4GB）。
  真值在驅動的登錄檔 `Class\{4d36e968-…}\<n>\HardwareInformation.qwMemorySize`，用 `MatchingDeviceId`
  當前綴對回 `PNPDeviceID`。**這種欄位錯得很像真的**，只有跟卡的規格對一下才看得出來。
- **`Get-Partition` 要載 Storage 模組（實測 1376ms）**：只是要「哪個磁碟代號住在哪顆碟」的話，
  `Win32_LogicalDiskToPartition` 只要 23ms，`Antecedent.DeviceID` 就寫著 `Disk #0, Partition #1`。
- **NVMe 的 S.M.A.R.T. 不必提權**：開 `\\.\PhysicalDriveN` 時 **`dwDesiredAccess` 一定要給 0**
  （給 `GENERIC_READ|GENERIC_WRITE` 未提權直接 ERROR_ACCESS_DENIED，實測 open:5），
  只做查詢的 `IOCTL_STORAGE_QUERY_PROPERTY`（0x2D1400，NVMe 協議專屬資料）不需要任何存取權。
  健康記錄頁（溫度／通電時數／已用壽命／寫入總量）＋ Identify Controller 都走這條，每顆實測 ~3ms。
  **ATA／SATA 的 SMART_RCV_DRIVE_DATA 這條路多半仍要系統管理員**（沒實機驗過，失敗一律安靜跳過）。
  `Data Units Read/Written` 的單位是 **1000 × 512 bytes**，當成 bytes 會少算 51 萬倍；
  溫度是位移 1～2 的 uint16 克氏，`0 K` 是「這顆感測器不存在」不是 −273 °C（`kelvinToC` 回 null）。
  `Add-Type` 編譯 P/Invoke 要 265ms，**延後到第一次真的要用時才跑**。
  舊的 `MSStorageDriver_*` SMART 命名空間與 `MSFT_StorageReliabilityCounter` 未提權回 0 筆，是死路。
- **NVMe 溫度進 tick 框（`DT` 列）**：感測器 sidecar 要 UAC，大多數人不會按——NVMe 的硬碟溫度
  唯一拿得到的來源就是這條。實測開關 handle 每輪 3.8ms、留著 3.6ms，**差別可忽略**（不值得留 handle）。
- **groups 的 rows 值不能給空字串**：空的 `<dd>` 沒有 inline content，grid item 高度是 0，
  那一列在版面上整行塌掉（`喇叭與麥克風` 曾整組 0 高）。沒有值就給 `DASH`。
  **只斷言標題有出現抓不到**，要量 `offsetHeight`。
- **虛擬音訊裝置要在 probe 就擋掉**（`Broadcast|Virtual|Oculus|Voicemod|SteelSeries Sonar`）：
  `Win32_PnPEntity -Filter "PNPClass='AudioEndpoint'"` 是「聽得到的裝置」，軟體混音器混在裡面
  會把真正的喇叭擠到很後面。`Win32_SoundDevice`（驅動層）與它兩份都列、意義不同。
- **每台螢幕的解析度／更新率走 Electron 的 `screen`**：`Win32_VideoController` 只講得出主顯示器那一組，
  EDID（`WmiMonitorID`）又只有型號與出廠年。兩份清單沒有可靠的對應鍵，**各列各的、不要硬湊**。
- **`probe.ps1` 要有 UTF-8 BOM ＋ `AutoFlush`**：PowerShell 5.1 沒 BOM 就把 UTF-8 當 ANSI 讀（中文註解＝語法錯誤，
  而且錯誤訊息指不到真正原因）；`[Console]::Out` 被接成管線時 .NET 預設緩衝，不 `SetOut` 一個
  `AutoFlush = $true` 的 StreamWriter，父程序永遠等不到第一個框。`test-sysmon.js` 有守這兩條。
- **static 框裡不准查 `Win32_Tpm`**（未提權 PermissionDenied 且**失敗前卡 5.2 秒**，整個 static 框本來才 5 秒）；
  要 TPM 走 `Win32_PnPEntity -Filter "Service='TPM'"`（實測 470ms，回的裝置名就寫著「信賴平台模組 2.0」）。
  Secure Boot 走登錄檔 `HKLM:\SYSTEM\CurrentControlSet\Control\SecureBoot\State`。
  **網路卡走 `Win32_NetworkAdapter` 不用 `Get-NetAdapter`**（後者要自動載入模組，`PSModulePath` 被污染時整組載不起來）。
- **probe 裡不可以相信 `$env:*`**：`$env:firmware_type`（UEFI／Legacy）在互動式主控台有值，
  被 Electron `spawn` 的 PowerShell **沒有**（環境變數是從父程序繼承來的）——症狀是那一格永遠空著，
  而手動跑 `probe.ps1` 一切正常，完全看不出差別。韌體模式改推 `SecureBoot\State` 機碼（只有 UEFI 開機才存在）。
  同理 `Win32_OperatingSystem.InstallDate` 與登錄檔 `CurrentVersion\InstallDate` 實測都可能是空的，
  安裝日期退回 `(Get-Item $env:SystemRoot).CreationTime`。
- **SMBIOS 沒填時 OEM 塞的是佔位字串**（`Default string`、`To be filled by O.E.M.`、`Unknown`…），
  原樣顯示等於規格表上印著「Default string」，比留白更糟。統一在 `metrics.clean()` 清成空字串，
  **不要在 renderer 各處寫 `!== 'Default string'`**（漏一處就露出來）。回歸：`e2e-sysmon-cdp.js` 的「沒有把 SMBIOS 佔位字串當成規格顯示」。
- **`Win32_ComputerSystem`／`Win32_OperatingSystem` 各要 ~100ms，其餘硬體類別幾乎都在 10～70ms**
  （`Win32_SystemSlot` 10ms、`Win32_DiskDrive` 13ms、EDID 那三支合計 <40ms）；
  **例外是 `Win32_Bus`（164ms）與 `Get-Partition`（1376ms，要載 Storage 模組）**，兩個都不值得。
  `MSFT_Disk`（130ms）給開機碟／GPT／MBR，`Get-PnpDeviceProperty`（DEVPKEY_PciDevice_*）**10.4 秒還回空值，絕對不要**。
  加新查詢前後量一次整框（目前約 6 秒；AudioEndpoint 287ms／Camera 260ms／QFE 850ms 只留 5 筆、
  PortConnector 11ms）。`Win32_QuickFixEngineering` 全表 921ms，所以只送最近 5 筆＋總數。
- **`Emit-Static` 裡新增變數前先看有沒有跟 `$sb` 撞名**：隨手 `$sb = ''` 會讓下一個 `& $add` 拋
  「未包含名為 'Append' 的方法」，**整個 static 框變成一列 `#ERR`**，畫面只顯示「偵測中…」，看起來像 WMI 壞了。
- **資料列一律「往後加欄位」、解析端逐格取值**：舊版 probe 給的列會是 `undefined` → `''`／`0`，不會整列壞掉。
  **不要插在中間**（所有既有欄位會錯位）。回歸：`test-sysmon.js` 的「舊格式少欄位不會炸」。
- **GPU engine 的配對 key 必須含 LUID＋引擎索引**，缺一個就會配錯實例：雙卡機同 pid 同 engtype 的兩個實例
  phys 都是 0，只拿 phys 當 key 會跨卡配對（新卡從 0 起算、舊卡累積數小時，差值爆出 7995% 假使用率）；
  同一張卡上 eng_N 編號是每個進程各自的（System 實測 eng_9 累計 41 億 vs eng_2 兩萬），
  少了引擎索引會讓小實例配到大實例（System／msedge 常駐假 100%、整卡恆 100%）。
  **另外這族 uint64 累計計數器會出現補數繞回的垃圾值**（`COUNTER_WRAP` = 2^63 以上一律不做差值），
  進程 CPU 同族同守；每進程 GPU% 另有 `Math.min(100, …)` 夾值。
- **dwm 的 VRAM 顯示十幾 GB 不是計算錯**：`GPUProcessMemory` 的 `DedicatedUsage` 對 dwm.exe 就是這麼大
  （工作管理員同一套計數器照樣這樣報；實測 16GB 卡計數器加總 16GB，nvidia-smi 只住 3.8GB——兩種量法）。
  不要為了「看起來合理」去改演算法；處理程序頁的說明（`#sysmonProcNote`）拿掉會馬上再收到「數值異常偏高」回報。
- **錯誤訊息 8 秒後自己收起來**（`showError` 裡的計時器）：取樣逾時那一則的下一句就是「已重新啟動取樣器」，
  留在畫面上只是嚇人。要改成別的行為就改那一個函式，不要在各個呼叫點各寫一份。
- **不顯示 `Idle`（pid 0）**：它的「CPU%」其實是 100 減整機負載，依 CPU 遞減排序時永遠洗在頂端
  （被回報過兩次「CPU 偏高」）。`parseTick` 的 P 列與 `_Total` 一起擋。
- **結束工作的 pid 守衛只收 `number`**（`Number([1234])` 是 1234、`Number({toString:()=>'99'})` 是 99），
  並擋掉 0（Idle）與 4（System）。只有「強制結束工作」一顆鈕（溫和的那顆對沒有訊息迴圈的程序沒作用）。
- **感測器的「自動啟用」只能放在進系統監控頁時，不可放在開機那條**：開機就走 `-Verb RunAs`
  等於一啟動就彈 UAC（而且所有 CDP 測試都是先啟動、再把 `sysmonSensors` 關掉，會整批卡在對話框前）。
  開機那條只走排程工作（靜默，失敗就安靜維持 off），進頁時 renderer 才 `enableSensors()`——
  它會**先裝排程工作**（一次 UAC）再啟用，所以正常情況下一輩子只授權一次。
- **sidecar 死掉要自己重拉**（`sensors.js` 的 `onLost` → `index.js` 的 `ensureSensors`）：
  防毒收掉或它自己崩掉時，狀態會停在 off，畫面上的溫度就再也不會回來。重拉走排程工作（不彈 UAC），
  且**要有上限**（連續 5 次，撐過 60 秒就歸零），否則「一連上就死」會變成每 3 秒生一顆提權程序。
  重拉一定要經過 `ensureSensors` 而不是直接 `sensors.enable`——風扇接管要跟著接回去。
  回歸：`test-sysmon.js` 的「感測器斷線重拉」
- **感測器 sidecar 不把整個 App 提權**（整包提權會讓終端機分頁用管理員開 shell）：只有 `VoiceInkSensors.exe`
  走一次 UAC，透過 128-bit 亂數具名管道回傳，只收第一個連線。版本鎖 `0.9.7-pre728`
  （0.9.6 在 Ryzen 5000 上 Tctl/Tdie 恆為 0）。
- **LibreHardwareMonitor 0.9.4 起改用 PawnIO，沒裝時不報錯只回 0**（顯示 0 度比留白更糟）：
  sidecar 自己探 `PawnIOLib.dll` 回 `{"warn":"pawnio"}`，UI 端另外把 `v === 0` 當「沒讀到」過濾掉。
- **PawnIO 2.2.0 把 DLL 裝在 `%ProgramFiles%\PawnIO\` 而且不加進 PATH**：驅動跑著、DLL 也在，
  但 `LoadLibrary("PawnIOLib.dll")` 找不到，症狀跟**完全沒裝一模一樣**。`PreparePawnIo()` 要同時找 System32
  與 ProgramFiles，找到就加進**本程序**的 PATH。裝好後 `Computer.Open()` 要載核心模組，
  第一筆讀數實測約 **10 秒**才到（要等資料，不要寫死 sleep）。
- **PawnIO 由 App 代裝但落地後一定要先驗 Authenticode**（`Status=Valid` **且**簽署者含 `CN=namazso.eu`），
  不符就刪檔中止；**刻意不釘 SHA-256**（釘了上游一發新版就變成自動裝過期版，而簽章對每一版都成立）。
  裝完既有 sidecar 要收掉重開。**靜默安裝參數是 `-install -silent`**（單破折號，`-install` 不能省）；
  `/S`／`/silent`／`/quiet` 全部無效且**不報錯**，只會開一扇要人按的提權視窗（開三扇還關不掉）。
- **CPU／記憶體壓力測試放 main、不放 renderer**：renderer 的 Worker 跟畫面共用同一個 process 的排程；
  V8 sandbox 對**整個 process** 的 ArrayBuffer 有約 8GB 上限（實測 main 配到 7.75GB 就失敗，
  改開 5 條 worker thread 加起來還是 7.75GB，同機純 node 跑得到 50GB）。
  改成 `ELECTRON_RUN_AS_NODE` 子程序各吃 6GB、停止時 `kill`（沒有 `--expose-gc` 時丟掉參考不等於還記憶體，
  實測停止後 4 秒可用記憶體一點都沒回來；改成 kill 之後配 35GB 全數還回）。
  `Buffer.allocUnsafe` **一定要 `fill` 過**才算真的跟 OS 要到頁，而且要定期 touch。
  上限夾在 `stress.js`（可用記憶體的七成），`run` 必須 `=== true`（收任何真值的話 renderer 傳個 `1` 就把 CPU 燒滿）。
- **GPU 壓力測試三個「看起來在跑其實沒壓到」**（三個都實測踩過，一起才壓得滿）：
  ① 畫布後端解析度要拉到 1080p（320×180 才 5.8 萬像素，塞不滿現代顯示卡）；
  ② 負載要畫進**離屏 framebuffer**（畫預設 framebuffer 每批都要跟合成器與 swap chain 打交道，
  同一版程式碼連跑三次量到 77%／100%／3%）；
  ③ 計時**只能用 `readPixels` 擋回來的時間**（`gl.finish()` 在 Chromium 底下永遠回 0ms，會一路加壓到
  差點觸發 TDR；用兩次 frame 的間隔則被 rAF 節流騙走 → 量到 1001ms 於是完全不加壓）。
- **視窗被遮住時 Chromium 會把 renderer 降級**（實測 nvidia-smi 從 100% 掉到 3%，畫面還寫著「執行中」）：
  **只在測試期間** `webContents.setBackgroundThrottling(false)`（`sysmon:gpuStress`）。
  壓力測試的迴圈在 `document.hidden` 時要改用 `setTimeout`（rAF 完全不觸發）。
- **離開系統監控頁要自己收 CPU／記憶體壓力測試**（它們跑在 main，`sysmon:stop` 只停取樣器，
  不收會在背景燒到 5 分鐘上限）。
- **儀錶要量「有沒有在動」，不是「用掉多少空間」**：磁碟那格是 `_Total` 的讀＋寫速率
  （容量在壓力測試中根本不會動，看不出有沒有在跑），尺規跟著看過的峰值走（不同 SSD 差好幾倍）。
  記憶體那格維持容量（Windows 沒有記憶體頻寬計數器，而記憶體壓測量的本來就是吃掉多少），名字叫「記憶體已用」。
  儀錶固定三欄（同一組指標才不會被拆到兩排）。
- **總覽區塊每輪重畫，所以展開狀態不能只存在 DOM 上**（`<details open>` 會被下一輪重建洗掉）：
  存在 `openBlocks`（localStorage，存的是**收起**清單，空集合＝全展開），DOM 只是它的投影；
  內文用「結構指紋」（`bodySignature`）比對，一樣就只改 `textContent` 不重建。
- **規格表要等靜態清單到齊才有東西**（`describeBlocks` 在 inventory 沒回來前 `specs` 是空陣列）：
  測試要先 `waitFor` 硬體清單，不要在第一輪取樣後就斷言列數。

### 風扇控制

- **手動 PWM 是留在晶片裡的，程序死掉不會自動放手**：實測設 100% 後硬殺程序，8 秒後另一支程序
  重讀仍是 100%。更糟的是 **`SetDefault()` 只還原「自己 Open 當下的快照」**——用**全新**程序對
  同一條通道 `SetDefault()` **無效**（它 Open 時看到的就已經是手動狀態），所以事後救不回來，
  **只有重新開機**（BIOS 在 POST 重設 SmartGuardian）才會回到原本的曲線。
  因此這四件事缺一不可：① 每條通道有下限 `minPwm`（≥20，預設也是 20，最壞情況只能是「吵」不是「燒」）；
  ② sidecar 自己的 **5 秒看門狗**（主程式被硬殺時唯一會交還的機制）；
  ③ `before-quit` **要 await 得到** sysmon 的 shutdown，且**風扇要排在 `sensors.stop()` 之前**；
  ④ `dirty` 旗標存 store，下次啟動看到還是 true 就在 UI 講明「重開機可回復」。
- **雙向管道一定要 `PipeOptions.Asynchronous`**：不帶它開出來的是非 overlapped handle，
  同一個 handle 上的**同步讀會把同步寫整個擋住**——讀取執行緒一卡進 `ReadLine()`，
  主迴圈的 `WriteLine` 就再也送不出去。症狀是主程式只收到「reader 開始讀之前」那一框，
  之後永遠停在「感測器沒有連線」，**而且完全不報錯**（管道通、程序活著，資料就是不來）。
  最會騙人的是：主程式每秒送心跳時反而正常（每顆心跳讓 `ReadLine` 返回一次，剛好打開寫入的縫隙），
  看起來像「有時候會動」。回歸：`probe-sysmon-fans.js` 要看到**連續 5 框**，只驗第一框抓不到。
- **開機接管只能走排程工作**：`Start-Process -Verb RunAs` **每次啟動都彈 UAC**，開機自啟動時
  等於不可用。做法是註冊一個**沒有觸發程序**（僅隨選）、`RunLevel Highest`、
  `ExecutionTimeLimit 0`（預設 3 天到期會被砍，風扇就沒人管了）的工作，建立時彈**一次** UAC，
  之後 `schtasks /run` 提權執行且不再提示。工作的參數在註冊時就寫死，所以管道名改用**交接檔**
  傳（`<userData>/sensors-handoff.txt`，sidecar 讀完立刻刪）。
  **只在打包版提供安裝**（`app.isPackaged`）：開發版執行檔在使用者可寫的目錄，
  註冊成提權工作等於留一條「免 UAC 執行任意程式」的後門。沒有工作時要**安靜退回** `-Verb RunAs`。
- **`main.js` 的 `registerSysmonIpc({ service })` 是逐一列舉的白名單**（跟 AGY 同一條教訓）：
  service 加了方法但那裡漏一行，renderer 只會拿到通用的「系統監控操作失敗」，
  IPC 層與 preload 都對、單元測試也全綠，只有打包版點下去才發現。fan 那八個方法就漏過一次。
- **緊急放手要用未平滑的原始值**：3 次移動平均會把反應延後最多 3 秒，而 `panicTemp` 是安全網，
  慢三秒才全速就失去意義。曲線本身照樣吃平滑值（不然轉速會跟著單框跳動抖）。
- **讀不到來源值要交還 BIOS，不是沿用上一個值**：感測器掛了還照著舊溫度吹是危險的，
  BIOS 至少看得到真的溫度。
- **「識別」按鈕不是裝飾**：晶片只給得出接頭名稱（`System Fan #1`），**給不出實體位置**，
  所以示意圖只能是通用槽位＋使用者指派。把該通道拉到 100% 幾秒讓人用**聽的**認，
  是唯一可靠的對應方式（實測 System Fan #1 從 3230 → 9507 RPM，非常明顯）。
- **曲線的 Y 軸是 PWM 不是 RPM**：能寫進晶片的只有 PWM，標成 RPM 是騙人（同樣 60% 在不同風扇上
  轉速差好幾倍）。實測 RPM 另外以文字顯示。X 軸溫度與使用率**都是 0~100**，所以同一個圖形元件通吃。
- **等角示意圖的槽位座標一定要驗「投影後兩兩不重疊」**：等角投影把 z 與 (x+y) 壓在同一個螢幕軸上，
  世界座標看起來離很遠的兩顆（頂部風扇 z=140 與 CPU 風扇 z=88）在畫面上可能只差十幾個單位。
  判準是 `dist(screen) ≥ r1 + r2 + 4`；改座標後拿那段算式重跑一次，**不要用眼睛看**
  （實測第一版有兩組疊在一起，看起來只是「有點擠」）。
- **十三個槽位不可以印全名**：`System Fan #1`～`#5` 截斷後長得一模一樣，等於沒有資訊，而且必定互相疊到。
  槽位上只印**短代碼**（前1／後／CPU…），全名走 `<title>` 與 `aria-label`。
  標籤擺放方向要逐槽指定（前面板那一排上下相鄰，標籤一律往內側放才不會壓到下一顆）。
- **扇葉動畫是慢動作，而且必須講明**：700 RPM 換算成畫面是每秒 11.7 圈，60fps 下只會糊成一團。
  週期跟真實 RPM 成正比（`60/rpm × SPIN_SCALE`，停轉就不動），但整體放慢——寫成「即時轉速」是騙人的。
- **能力邊界要講實話**：LHM 有實作寫入的是 ITE IT87xx／Nuvoton NCT67xx／Fintek F718xx
  ＋ NVIDIA NVAPI／AMD ADL ＋ 部分 AIO 控制器。**筆電幾乎都不行**（廠商自訂 EC，沒有公開介面）。
  沒有通道時要說明原因，不要留白。
- **殭屍 sidecar 會讓下一次啟動安靜失敗**：提權跑的 sidecar 用一般 shell 的 `taskkill` 殺不掉
  （`Get-Process` 連 `Path` 都拿不到），要用 `Invoke-CimMethod ... -MethodName Terminate`。
  留著的話它佔著 PawnIO，新的 sidecar `Computer.Open()` 會撞在一起——測試會莫名其妙紅一整輪。

### 效能調整

- **不能沿用風扇的 `S`／`D`／`R`**：LHM `IControl` 只接到 PWM。CPU 走 PawnIO `ioctl_send_smu_command`（Vermeer／Matisse RSMU），GPU 走未公開 NVAPI QueryInterface。IPC 只收數字；opcode、PCI 位址、裝置路徑不准出現在 renderer。`ocControl` **不進 `STORE_ALLOWLIST`**。`registerSysmonIpc` 要逐一列舉 `ocStatus`／`ocSetDraft`／`ocApply`／`ocReset`。
- **安全方向跟風扇相反**：卡住要還原出廠，不是拉高。硬上限（核心 ±200 MHz、記憶體 −500～＋1000、功耗 50～120%、PBO 牆為工廠值 50%～150%）main 與 sidecar 兩邊都夾。套用期間 CPU／GPU ≥ 95°C 或讀不到溫度 → 立刻 `X`。看門狗與 `before-quit` 都要還原（`oc.shutdown()` 排在 `sensors.stop()` 之前）。
- **開機不自動套用**：GPU 軟體時脈重開就回預設，開機再套等於主動超頻。`dirty` 只表示「這次行程有套用、還沒還原」——下次啟動看到它是提示，不是再套一次。套用是按鈕，不每秒灌 SMU。
- **不做 I2C／RTCore**（CVE-2019-16098）。GPU 電壓走 NVAPI VID。Curve Optimizer、全核／每核鎖頻、Tctl、GPU 溫度牆、手動超頻 CPU VID、SoC 電壓（先快照才能還原）、V/F 逐點都要有。偵測不到可寫路徑時卡片改說明，不要留白。CDP 測試**不准按套用**。
- **V/F 寫入 frequencyDeltaKHz 要 ×2**（nvapioc 同源）。核心滑桿是整條基底，`V n d0…` 是各點額外 MHz。SoC 沒讀到進門值就不要寫，否則還原不知道要回到哪。
- **走勢圖兩條線各自縮放，所以 Y 軸要各標各的**（左緣第一條、右緣第二條，只標上下限＋單位）：
  沒有單位的曲線等於在猜數量級。**讀不到值時不可以用 0 佔位**——自動縮放會被那顆 0 壓扁一整分鐘，
  看起來像時脈突然掉到 0。整分鐘同一個值時線走中間、只標一次。
- **儀表要顯示實際讀數，不是牆**：CPU 功耗是 Package 瓦數，PPT 牆另標；負載 0% 是閒置不是「沒讀到」（JSON 的 `u` 允許 0）。每核時脈走 sidecar `ck`，GPU 負載／功耗可退回 nvidia-smi。套用後走勢圖要看得出時脈／功耗在動。

### 使用時長

- **同一份 Tai 庫、同一套寫入規則**：表名 `AppModels`／`DailyLogModels`／`HoursLogModels`／`WebSiteModels`／`WebBrowseLogModels`／`WebUrlModels`；時長是秒，日桶上限 86400、小時桶是整點且上限 3600。第一次啟動把本機 Tai `Data\data.db` 拷進 `<userData>/screentime/`，之後只寫這一份——不要跟還在跑的 Tai 搶同一顆檔。
- **外掛協定不能改**：Chrome／Edge「Tai Sentry」連寫死的 `ws://127.0.0.1:8908/TaiWebSentry`。只綁 127.0.0.1、收 JSON（`Url`／`Title`／`Duration`／`ActiveTime`）、丟掉純文字 `ping`。Tai 佔著 8908 時要重試，不能換埠。`observer.ps1` 要進 `asarUnpack`（PowerShell 執行不了 asar 內檔案）。
- **`registerScreentimeIpc` 要逐一列舉** `status`／`stats`／`drill`／`export`／`openFolder`。renderer 只送 kind／range／date；存檔路徑由系統對話框決定。**沒有開關**：使用時長開 App 就一直記，所以沒有 `setEnabled` IPC、也沒有 store 鍵。
- **有 `LIMIT` 的清單不可以拿來算總數**：`總時長`／`應用數` 走各自的聚合查詢
  （`SUM` ＋ `COUNT DISTINCT`）。拿 `LIMIT 80` 的清單加總在「日」永遠是對的（一天不到 80 個應用），
  切到「年」就少一大截，而畫面上看不出來（實測 80 vs 283 個應用）。
- **柱狀圖有 Y 軸**：三格刻度＋格線，單位由上限決定（同一條軸只用一種單位）；
  X 軸標籤掛在繪圖區**外面**，掛在柱子裡的話矮柱會被時間字壓住。回歸：`e2e-screentime-cdp.js`
- CDP **不准關使用者的 Tai.exe**；讀舊資料用暫存 userData 自己拷一份。回歸：`test-screentime.js`、`e2e-screentime-cdp.js`。

### UI／CSS

- **`themes.css` 沒有 `--surface`／`--accent`／`--border` 這三個名字**（正確的是 `--surface-glass`／
  `--surface-solid`、`--accent-primary`、`--border-color`）：CSS 變數打錯**不會報錯也不會有警告**，
  只會靜靜地變成「沒有背景」或（在 SVG 的 `fill` 上）**純黑**。實測整片玻璃面板消失、曲線圖底變成黑方塊，
  而 DevTools 只顯示一個無效值。**新寫一段樣式前先 `grep -- '--名字:' src/renderer/styles/themes.css`**；
  回歸要量 `getComputedStyle` 的實際顏色，不是「這條規則在不在」。
  SVG 的 `fill` 另外要用**不透明**的 `--surface-solid`（`--surface-glass` 是 rgba，疊在深色底上會發灰）。
- **手風琴式的「唯一一份編輯器」被搬走之後不可以留在 DOM 外面**：`getElementById` 找不到脫離文件的節點，
  下一輪就再也搬不回來（症狀是展開第二次是空的）。沒有展開任何一列時要把它掛回容器底下並 `hidden`。
- **「再點一次收起」跟「第一次自動展開第一列」會互相打架**：選取狀態要分三態
  （`null` = 還沒選過、`''` = 使用者自己收起來的、id = 展開中）。只用 `if (!selectedId) selectedId = first`
  的話收起來的下一個 render 又自己展開，看起來像按鈕壞掉。
- **用 `el.hidden` 收合的元素，CSS 若寫了 `display` 就必須自己補 `[hidden] { display: none }`**：
  `[hidden]{display:none}` 只是瀏覽器內建樣式，任何作者規則（`.sysmon-block-body { display: flex }`）都壓得過它。
  症狀是屬性設了、`aria-expanded` 也對，畫面卻永遠展開。**只斷言 `.hidden === true` 抓不到**，要量 `offsetHeight`。
- **`<details>` 收起後，子元素的 `offsetHeight` 還是舊值**（Chromium 用 `::details-content` 的
  `content-visibility: hidden`，幾何留著）：要量就量 `details` 自己的高度跟 `summary` 比，
  量內容那一層會拿到「看起來沒收起來」的假紅燈。
- **`.btn` 也是其中一個**（`display: inline-flex`）：`el.hidden = true` 的按鈕照樣看得見。
  已經在 `.btn[hidden] { display: none }` 補掉了（屬性選擇器特異度較高，跟寫在前後無關），
  新寫的按鈕類別要記得比照。回歸：`e2e-workspace-cdp.js` 的「圖片分頁不給存檔」
- **同一條適用 `<dialog>`**：給 `.app-dialog` 寫 `display` 一定要帶 `[open]`，否則
  `dialog:not([open]) { display: none }` 被壓過，**沒開的彈窗會全部浮出來疊在頁面上**。
  只斷言 `dialog.open === false` 抓不到，要量 `offsetHeight`。回歸：`e2e-visual-cdp.js` 的 `dialog-hidden`。
- **彈窗內容超過 `max-height: 86vh` 時要捲的是「中間那塊」**：`.app-dialog` 是 `overflow: hidden`，
  body 沒有 `overflow-y: auto` 的話會把「取消／儲存」擠出可視範圍。新彈窗的 body 一定要掛到
  `.prompt-editor, .term-new-body, .cc-dialog-body, .chat-scan-body, .usage-dialog-body` 那條共用規則上。
- **彈窗新增內容區時要自己補 `padding: 4px 24px 0`**：`.app-dialog` 本身 `padding: 0`，
  那 24px 是 `.dialog-head`／`.dialog-actions` 各自寫的（少了就往左突一整截）。
  預設 760px 只適合寬內容，三四個欄位的表單自己收窄。回歸：`e2e-visual-cdp.js` 的 `dialog-align`。
- **`custom-select` 接管之後，flex 版面要收斂的是 `.custom-select` 不是 `.select`**：
  原生 `<select>` 被搬到畫面外，實際佔位的是外面那層 `<span class="custom-select">`。
  只寫 `.hf-searchbar .select { flex: 0 0 auto }` 等於沒收，隔壁的按鈕會被擠成一條、文字直排疊上來。
  **斷言要比按鈕的寬與高**（`w > h`），只檢查「按鈕在不在」抓不到。
- **下拉清單由 `renderer/scripts/custom-select.js` 接手**：原生 `<select>` 保留作為資料來源與 `change` 事件目標，
  畫面用共用 ARIA listbox（原生展開清單由 OS 畫，圓角／陰影／主題都控不到）。清單用 fixed portal；
  dialog 內要掛回 top layer。`optgroup` 只能用 `querySelectorAll('option')` 讀取
  （`HTMLOptGroupElement` 沒有 `options`，當成 select 用會拋 TypeError → 看起來像「按鈕點不開」）。
  清單寬度至少容納最長選項且受視窗邊界限制。原生 `<option>` 仍要明寫不透明的
  `--surface-solid`＋`--text-primary`（深色主題下原生彈窗會退回系統白底、近白字）。
- **`positionMenu` 不可以直接寫視窗座標**：`.app-dialog` 有 `backdrop-filter`，那會讓 dialog 變成
  `position: fixed` 子孫的**定位基準**（跟 `transform`／`filter` 一樣），清單整個位移一個 dialog 左上角
  （實測寫 515/447、落在 1005/727）。修法是先把 `left/top` 歸零、量出實際原點再回推。
  **斷言要量 trigger 與 menu 的相對位置**，只檢查「清單在不在 dialog 裡」抓不到。
- **`.chat-layout` 底下只能有一個 `.chat-main`**：曾經多出一層沒有 id 的 `<div class="chat-main">`
  把 `chatMain` 與 `termMain` 一起包住（HTML 沒報錯，parser 自己補上收尾），
  症狀是終端機憑空多一圈 18px 的內距、看起來就是「邊框好厚」。
  回歸：`e2e-ux-tweaks-cdp.js` 的「沒有多餘的 chat-main 外框」。
- **`.subtab-panel` 的顯示只由 `.active` 控制**：不要對 `#stt-live` 之類的子分頁容器裸寫 `display: flex`
  （會蓋掉 `display: none` 讓兩個子分頁疊在一起）。要置中改內容自己的 `margin: 0 auto`。
- **批次改 CSS 前先確認選擇器不是某條多選擇器規則的結尾**：`.sysmon-stress-card {` 同時也是
  「Token Anxiety surface mapping」共用規則的最後一個選擇器，用 `str.index('.sysmon-stress-card {')` 刪重複宣告
  會把 `background`／`box-shadow` 從**共用規則**裡刪掉，全 App 的玻璃面板一起變透明。
- **狀態樣式要比 hover 更高特異度**（`.composer-btn:hover:not(:disabled)` 會蓋掉 toggle 的 selected 狀態）；
  把 `label` 當可點擊元件時，元件自己的 `display` 要用同等特異度覆蓋（`label.chat-model-flag`）。
- **規格表與長條圖標籤不准 `text-overflow: ellipsis`**：截成「…」的那筆等於沒有那筆資料
  （裝置 ID、序號、感測器名稱全中）。長字串多半沒有空白可斷，要 `overflow-wrap: anywhere`；
  欄寬同時放寬（`minmax(330px, 1fr)`）、列距放鬆。
- **`<dl>` 做多欄流版時每組 dt/dd 要包一層 `<div>`**，否則 `auto-fill` 會把標籤跟值拆到不同欄。
- **hover 才出現的操作等於沒有**（觸控裝置沒有 hover）：兩個不同的動作就給兩顆有文字標籤的常駐按鈕。
- **全 App 禁用強調條／裝飾條**：不准用「方框左邊一條粗粗的彩色條」（`border-left: 3px solid <accent>`、
  標題前的 3×13px 色票偽元素都算）。強調一律走完整 1px 邊框、底色 tint 或字級／顏色本身；
  已清掉的：`.md-quote`、`.chat-think`、`.sysmon-note`、`.settings-subsection-title::before`。
  新樣式不准再長出來（grep `border-left: [2-9]px` 應為 0 筆裝飾用途）。
- Aurora 視覺 token 集中在 `themes.css`，共用 surface／RWD 在 `main.css`；
  不要用 React、DnD 或動畫 dependency 取代原生 DOM／Web Animations。
- **設定頁不放「用哪一顆模型」**：設定頁只管裝了什麼、怎麼推論、雲端端點；選用哪一顆在做事的頁面上直接選，
  選了立刻寫回 store（跟主題一樣即時套用）。**ASR 沒有 CPU/GPU 開關**（選模型＝選推論方式，執行緒一律自動）。
  `llmGpu` 是本地翻譯的全域開關。
- **未安裝的本地模型仍要留在選單裡**（標「（未安裝）」＋提示去下載，整項消失使用者不知道有這個選擇），
  真的要跑之前才擋，並一併檢查 `requires`（GPU 那顆缺 llama.cpp 執行環境時，錯誤要講執行環境而不是模型）。
- 設定頁字級與顏色的階層要一致（標題 20/700 primary → 輸入 14 → 子標題 13/600 secondary → 說明 12 tertiary）；
  視覺階層可以用 CDP 量 `fontSize` 寫成回歸。

### 測試（CDP／e2e）

- **CDP 收尾只能殺自己**：每支打包測試都要用暫存 `--user-data-dir`，並只以 spawn 回傳的 `child.pid`
  執行 `taskkill /PID /T`；**禁止 `/IM VoiceInk.exe`**（會把使用者安裝版一起關掉）。
  暫存 SQLite 在 Windows 釋放較慢，刪資料夾要有有限重試。
- **不可以用「第一列」或「總數」指涉自己建的東西**：使用者本來就有工作階段／對話時，
  `querySelector('.term-list-item')` 抓到的是別人的，`panes === 1` 這種絕對數也一定對不上，
  最糟會**把使用者的資料刪掉**。一律用 `[data-id="<自己建的 id>"]`，中途建立的每一個都要在收尾刪掉。
- **同一時間只能跑一支 CDP 測試**（單一實例鎖會把後開的擋掉，症狀是隨機失敗）；
  挑主視窗一律用 `/index\.html/`（HUD 也是一個 page target）。
- **暫存 `--user-data-dir` 隔離的是設定，連資產一起搬走就會整批假紅燈**：
  `<userData>/models`（模型全不見 →「尚未下載」）、`chatProviders`（下拉是空的 → 等待逾時）、
  `agyPort`（預設埠被使用者的正式實例佔著 → `PORT_IN_USE`）都在那底下。
  模型用 `fs.symlinkSync(..., 'junction')` 接回真的資料夾（只讀），其餘缺什麼在測試裡自己種。
  借埠要跟 OS 要（`listen(0)` 後關掉再用），寫死數字實測會撞到別的程式。
- **多實例測試的第二／第三份也要帶同一個 `--user-data-dir`**：single-instance lock 是綁 userData 路徑，
  不帶等於各自拿到自己的鎖，「第二份會自己退出」「捷徑叫回視窗」兩條**根本沒測到卻是綠的**。
- **UI 斷言要等「量得到尺寸」，不要睡固定時間**：機器同時在打包時 `setTimeout(420)` 會量到一整排 0×0，
  假紅燈比假綠燈更浪費時間（你會先去懷疑自己剛改的東西）。
- **新測試一定要先在修復前跑一次**（紅了才算數）；UI 斷言尤其容易寫成恆真，
  必要時先把修法拿掉量一次（`reproduced`／`broken`）確認重現得出來。
- **批次改識別字（sed）時，斷言與清單是最危險的兩種上下文**：`=== false` 可能被改成恆假、
  陣列字面值可能塌成重複項。改完一定要 `git diff` 逐條看過。
- **`Runtime.evaluate` 每次都在同一個全域範圍求值**：寫 `const s = ...` 第二次會撞
  `Identifier 's' has already been declared`，要包成 IIFE。
- **新增 nav 分頁時五個腳本裡寫死的頁面清單都要同步更新**：`e2e-cdp-smoke.js`、`e2e-usage-cdp.js`、
  `e2e-agy-cdp.js` 的 `EXPECTED_ORDER`、`e2e-visual-cdp.js` 的 `PAGES` 與 `SIGNATURES`、
  `e2e-hf-cdp.js` 的 nav 斷言
  （`SIGNATURES` 的 signature 必須是 12px radius＋blur 的頂層 glass 面板，純佈局容器會被判失敗）。
- **CDP 測試開頭要把 `sysmonSensors` 關掉**（否則一進系統監控頁就彈 UAC 卡住），`finally` 還原使用者原本的值。
- **`npx electron <script>` 時 app 名是 `Electron`**：開頭要補
  `app.setPath('userData', join(app.getPath('appData'),'voiceink'))` 才找得到模型。
- **JSDoc 型別轉換後面接一行以 `(` 開頭的敘述會被 ASI 併成函式呼叫**（症狀 `template.id is not a function`）：
  cast 一律先接成變數再用。
- **mock 綠燈證明不了對面長什麼樣**：對外部系統的整合要另留一支 `probe-*.js` 打真流量驗假設；
  「讓機器做某件事」的功能（壓力測試、GPU 加速）要用**第三方工具**量結果，不能用 App 自己回報的狀態。

---

## 驗證方式

宣告完成前必附驗證指令與實際輸出。純函式用 `node`，需要 Electron 環境的用 `npx electron`，
打包版 UI 用 CDP（先跑 `npm run electron:pack`）。

| 範圍 | 指令 |
|---|---|
| 語音輸入 | `node scripts/test-dictation.js`（字典／學詞／狀態機／F24／輸出清理）＋`npx electron scripts/e2e-dictation.js`（mock 端點，含 HUD [K]；**插入是 stub**）＋`node scripts/e2e-dictation-cdp.js`（打包版：熱鍵真的掛上、原生 sidecar 模式、假麥克風、藥丸以外不吃滑鼠、藏起來仍即時） |
| HF模型（本機 LLM） | `node scripts/test-hfmodels.js`（GGUF 檔頭／量化與分片歸組／參數決策／KV 估算／INI）＋`node scripts/probe-hf-router.js`（**實測 router 的真實行為**，動 runtime.js 前先跑）＋`node scripts/probe-hf-hub.js`（打真 HF：搜尋／檔案樹／Range 抓檔頭）＋`node_modules/electron/dist/electron.exe scripts/probe-hf-detail.js`（**打真 HF**：模型卡／README／每個量化的可行性，動 `detail()` 前後都要跑）＋`npx electron scripts/e2e-hfmodels.js`（起 router → 載入 → 真的發一次請求 → 卸載 → 收程序）＋`node scripts/e2e-hf-cdp.js`（打包版 UI，**模型庫指到暫存資料夾、不碰使用者的模型**） |
| 熱鍵可用性 | `node scripts/probe-dictation-hook.js`（原生 sidecar；`--live` 會等你按鍵）＋`npx electron scripts/probe-uiohook.js`（退路）＋`node_modules/electron/dist/electron.exe scripts/probe-dictation-latency.js`（節流矩陣）＋`scripts/probe-dictation-live.js`（**會搶前景焦點**，只在使用者沒在用電腦時跑）＋`probe-dictation-hud.js`（三種狀態截圖） |
| Claude Code 工作台 | `node scripts/test-ccswitch.js`（settings.json 外科式合併／預設表／播種／models-scan／路由推導／MCP／PKCE）＋`node scripts/e2e-ccswitch-cdp.js`（打包版，**不碰使用者的 settings.json**） |
| 供應商端點／模型 | `node scripts/probe-ccswitch-endpoints.js`（動 `presets.js` 端點前後都要跑）／`probe-ccswitch-models.js`（動 `modelsUrl` 前跑）／`probe-ccswitch-codex.js`（**打真 Codex**：哪些參數會 400，動 `forCodexBackend`／`probeBody` 前跑）／`probe-ccswitch-scan-ui.js`（實機掃描） |
| 轉換閘道 | `node scripts/test-ccswitch-gateway.js`＋`node scripts/e2e-ccswitch-gateway.js`（自開 mock 上游） |
| 用量統計 | `node scripts/test-code-usage.js`＋`npx electron scripts/e2e-code-usage.js`（**真的讀本機記錄**，實測 5.4GB）＋`npx electron scripts/probe-code-usage-audit.js`（**不經 codeusage 自己重算一次**再對帳；動 `parsers.js`／`pricing.js` 前後都要跑） |
| AGY | `node scripts/test-agy-mappers.js`＋`npx electron scripts/e2e-agy.js`（mock cloudcode-pa）＋`node scripts/e2e-agy-cdp.js`；動映射表／端點順序前先跑 `npx electron scripts/probe-agy-upstream.js`，動 `runAgyCli` 前跑 `probe-agy-nudge.js` |
| 專案工作區 | `node scripts/test-workspace-nav.js`（快速開檔模糊排序／檔案樹鍵盤導覽／roving tabindex）＋`node scripts/test-workspace.js`（路徑逃逸守衛／`git status --porcelain=v2 -z` 解析／agent id 白名單／專案 sanitize／檔名白名單／搜尋／`netstat` 解析）＋`node scripts/e2e-workspace-cdp.js`（打包版 UI，**用暫存 user-data-dir ＋ 自己種一個暫存專案，不碰使用者的專案**）；動 Monaco（版本、`build.files` 的 monaco 規則、CSP）前後都要跑
`node_modules/electron/dist/electron.exe scripts/probe-workspace-monaco.js`（實測高亮與並排 diff 真的畫得出來）；
動 PDF 預覽前先跑 `node_modules/electron/dist/electron.exe scripts/probe-workspace-pdf.js`（實測 Electron 到底有沒有內建檢視器） |
| 終端機 | `node scripts/test-terminal.js`＋`npx electron scripts/e2e-terminal.js`（真 ConPTY）＋`node scripts/e2e-terminal-cdp.js`；管理員終端機 `node scripts/probe-terminal-admin.js`（宿主協定，**不需 UAC**）＋`node_modules/electron/dist/electron.exe scripts/probe-terminal-admin-elevate.js`（**會跳一次 UAC**，驗 shell 真的是 High） |
| 系統監控 | `node scripts/test-sysmon.js`＋`npx electron scripts/e2e-sysmon.js`＋`node scripts/e2e-sysmon-cdp.js`＋`node scripts/probe-sysmon-stress.js`（**實機量有沒有真的壓到**）＋`node scripts/e2e-sysmon-sensors.js`（**會跳一次 UAC**） |
| 風扇控制 | `node scripts/test-sysmon-fans.js`（內插／遲滯／斜率／下限／panic／sanitize）＋`node scripts/e2e-sysmon-fans-cdp.js`（打包版 UI，**不接管真風扇**）＋`node scripts/probe-sysmon-fans.js`（**實機轉你的風扇**，100%/40% 各量一次 RPM，會跳 UAC）＋`node scripts/probe-sensors-task.js`（免 UAC 啟動那條路，**會跳兩次 UAC**：建立與移除工作） |
| 效能調整 | `node scripts/test-sysmon-oc.js`（夾值／panic／指令形狀）＋`node scripts/e2e-sysmon-oc-cdp.js`（打包版 UI，**不按套用**） |
| 使用時長 | `node scripts/test-screentime.js`（切桶／寫入／讀 Tai 舊庫／WebSocket）＋`node scripts/e2e-screentime-cdp.js`（打包版 UI，**不關使用者的 Tai**） |
| 額度 | `node scripts/test-usage.js`＋`npx electron scripts/e2e-usage.js`（真實來源）＋`node scripts/e2e-usage-cdp.js`；動 OpenCode Go／Ollama／Command Code 端點或解析前後跑 `node scripts/probe-usage-endpoints.js`（**打真上游**） |
| 聊天 | `npx electron scripts/e2e-chat.js`（mock SSE）＋`node scripts/e2e-chat-cdp.js`＋`node scripts/test-markdown.js` |
| ASR | `npx electron scripts/e2e-llama-asr.js`（GPU）／`e2e-asr-threads.js`（CPU）／`node scripts/e2e-stt-cdp.js`（三個子分頁的模型選單）；雲端形狀矩陣 `node_modules/electron/dist/electron.exe scripts/probe-cloud-asr.js`（**會用真金鑰打真上游**） |
| 即時字幕 | `node scripts/test-vad.js`＋`npx electron scripts/e2e-live-pipeline.js`＋`node scripts/e2e-live-cdp.js` |
| 翻譯解碼 | `node scripts/probe-prompt-path.js`（prompt 逐 token）＋`node scripts/verify-chat-wrapper-fix.js`；打包版本地 LLM 走不走得通用 `node scripts/probe-packed-local-llm.js`（動 `build.files` 的 node-llama-cpp 規則前後都要跑） |
| 翻譯頁語言鈕 | `node scripts/probe-translate-lang.js`（來源 5 顆／目標 4 顆、交換、560px 不溢出）；**預設跑原始碼**（先開著 `npx vite`），打包版指 `VOICEINK_EXE` |
| 錯誤衛生 | `node scripts/test-error-hygiene.js` |
| IPC 共用外殼 | `node scripts/test-ipc-invoke.js` |
| 常駐／自啟動 | `node scripts/e2e-tray-cdp.js` |
| 自動更新 | `node scripts/test-updater.js`（狀態機／開關／結束時安裝／接線）＋`node scripts/e2e-update-cdp.js`（打包版 UI，**會真的連一次 GitHub**） |
| 視覺／RWD | `node scripts/e2e-visual-cdp.js`（七頁 × dark/light × 三尺寸）＋`node scripts/test-usage-reorder.js` |
| 使用體驗（本輪四項） | `node scripts/e2e-ux-tweaks-cdp.js`（打包版：系統監控錯誤自動收起、風扇下限 20%、終端機選取複製／右鍵貼上／窄邊框、側欄拖寬。**會把測試視窗叫到最前面**讀剪貼簿） |
| 冒煙 | `node scripts/e2e-cdp-smoke.js` |
