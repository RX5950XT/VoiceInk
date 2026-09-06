# VoiceInk — 專案規範與 AI 作業守則

> **本檔與 [AGENTS.md](./AGENTS.md) 內容完全相同**（兩個入口、一份規則，改一份要同步另一份）。
> 現行架構與最近變更見 [CONTEXT.md](./CONTEXT.md)，可遷移的判斷原則見 [tasks/lessons.md](./tasks/lessons.md)。
> 底下「地雷」每一條都是實際改壞過的；細節查 git log。

## 專案

Windows Electron AI 工作台：聊天＋終端機＋專案工作區＋本機 LLM＋Claude Code 工作台＋系統監控＋
額度與用量統計＋AGY 反代＋語音轉文字＋翻譯與 TTS。Vanilla JS + Vite（無框架），Electron 43.4.1 ＋ Node 22。

nav：聊天（預設，**工作區與終端機同一頁**）｜CC代理｜額度｜AGY反代｜語音轉文字｜翻譯與 TTS｜系統監控｜HF模型｜設定。

| 模組 | 一句話 |
|---|---|
| 聊天 | 多組供應商（`chatProviders`），雲端翻譯共用同一份清單；會話存 `chats.json`，圖片存 `chat-images/` |
| 終端機 | `@lydell/node-pty` ConPTY ＋ xterm.js，開在工作區的分頁列上；可用管理員身分（提權 host 代開）|
| 專案工作區 | `src/main/workspace/`：專案＝本機資料夾（`workspaces.json`）；中間分頁列（終端機／Monaco 編輯器／`<webview>` 瀏覽器），右側欄＝檔案總管／Git／AI 記錄／監聽埠 |
| HF模型 | 在 HF 搜 GGUF → 下載 → llama-server **router 模式** 一顆程序管全部模型 → 出現在聊天選單 |
| CC代理 | `src/main/ccswitch/`：供應商 tile 改 `~/.claude/settings.json` 的 `env`／MCP／CLI 版本；非 Anthropic 格式經本機閘道轉協議 |
| 系統監控 | `probe.ps1` 常駐取樣器＋`nvidia-smi`；六子頁（總覽／使用時長／處理程序／壓力測試／風扇控制／效能調整），感測器走提權 sidecar |
| 額度／用量統計 | 額度＝七家官方端點（`usage.json`）；用量統計＝掃五家 CLI 本機記錄算 token／花費（`code-usage.json`），兩件事 |
| AGY 反代 | Antigravity 憑證 → OpenAI／Anthropic 端點；只綁 127.0.0.1＋強制金鑰 |
| ASR／翻譯／TTS | 本地 sherpa（CPU）／llama-server（GPU）或雲端；翻譯 local（LinguaForge）／cloud；TTS 走 Edge TTS |
| 語音輸入 | 全域右 Alt（原生 sidecar 吞鍵）→ 錄音 → ASR → 個人字典 → LLM 整理 → 剪貼簿＋Ctrl+V，底部浮藥丸 |
| 常駐／更新 | 關窗縮系統匣（`closeToTray`）；`updater.js` ＝ electron-updater ＋ GitHub Releases 的 `latest.yml` |
| 視覺 | Token Anxiety Aurora glass；深／淺共用 12px surface、blur；RWD 900／640px；本機字體 |

模型 registry `src/main/models.js`，下載至 `%APPDATA%/voiceink/models/`。

## 指令

```bash
npm run electron:dev     # 開發（vite + electron）
npm run dev:sandbox      # 沙箱實例：不干擾你正在用的那份，但接得到原本的模型與專案
npm run electron:pack    # 免安裝預覽 → dist/win-unpacked/VoiceInk.exe（UI／功能改完必跑）
npm run electron:build   # 完整打包：NSIS 安裝檔＋ win-unpacked → dist/
npm run build:sensors    # 系統監控提權感測器 sidecar（需 .NET 8 SDK）→ resources/sensors/
npm run build:hook       # 語音輸入原生熱鍵 sidecar（需 .NET 8 SDK）→ resources/hook/
```

`resources/sensors/`、`resources/hook/` 不進版控（沒建置也打得起來，只是那兩個功能降級）。
打包前先關掉 `dist/win-unpacked/VoiceInk.exe`。使用者同時在用電腦時，桌面 QA 只能用 CDP 背景操作。

### 發行流程（五步一整條，漏一步舊版永遠檢查不到更新，且**不會報錯**）

```bash
# 1) bump package.json 的 version（不可與既有 tag 重複），順手更新 README 版本行
git commit -am "feat: 發行 vX.Y.Z — <一句話>" && git tag vX.Y.Z && git push && git push --tags
npm run electron:build                                   # 2) 產出安裝檔、blockmap 與 latest.yml
gh release create vX.Y.Z --title "vX.Y.Z" --notes "..."  # 3) 不可加 --draft／--prerelease
gh release upload vX.Y.Z dist/VoiceInk-Setup-X.Y.Z.exe dist/VoiceInk-Setup-X.Y.Z.exe.blockmap dist/latest.yml
```

三個檔案缺一：`.exe` → 下載 404；`latest.yml` → 舊版說「沒有附帶更新資訊」；`.blockmap` → 退回下載完整 360MB。
tag 要與 `package.json` 的 version 一致。

## 作業守則

1. **動手前**先讀 CONTEXT.md 找到模組，再讀本檔該模組的地雷；追完整條資料流與所有 caller，找根本原因，不臨時修補。
2. 改動範圍降到最低。非簡單任務（3 步以上或涉及架構決策）先把可勾選的規劃寫進 `tasks/todo.md`。
3. **宣告完成前必附驗證指令與實際輸出**；沒跑過就不算完成。同一修法失敗兩次就換方法。
4. **新寫的回歸測試要先在修復前跑一次，紅了才算數**（UI 斷言特別容易寫成恆真）。
5. mock 全綠證明不了對面長什麼樣：整合功能另留 `probe-*.js` 打真流量；「讓機器做某件事」的功能要用第三方工具量結果。
6. **刪功能時把「定義／exports／IPC 白名單／preload／renderer 呼叫點」一起掃**（見地雷「三份清單」）。
7. 規則或架構有實質變動時才動 CLAUDE.md／AGENTS.md／CONTEXT.md，三份保持對齊；使用者修正後把**模式**記進 `tasks/lessons.md`。
8. Commit 格式 `<type>: <description>`（feat／fix／refactor／docs／test／chore／perf／ci），訊息繁體中文；**只在使用者要求時** commit 或 push。

## 慣例

- 檔名 kebab-case、變數 camelCase、常數 UPPER_SNAKE_CASE；ES2022、async/await、JSDoc。
- Renderer 是 ESM，Main／Preload 是 CJS。函數 <50 行、檔案 <800 行、巢狀 ≤4 層。
- 所有外部輸入都要驗證；例外不可靜默吞掉，邊界回結構化錯誤。
- 設定走 electron-store IPC，**key 僅 allowlist**。以下**不走** `store:*`，各有獨立 store／IPC：聊天／終端機／工作區／AGY／語音輸入紀錄／用量統計。`hfToken`、`agyEnabled`、`ocControl` 刻意不進 allowlist。
- 九組模組 IPC 的共用外殼在 `src/main/ipc-invoke.js`（主視窗守衛＋`{ ok, data|error }`＋`userMessage` 白名單），**handler 仍要各模組自己逐一列舉**。
- 兩窗 `sandbox: true`；CSP `connect-src 'self' https: http:`、`font-src 'self' data:`、`worker-src 'self' blob:`（後兩條是 Monaco 要的，不可拿掉）。
- **UI 改完先跑 `npm run electron:pack`** 更新免安裝預覽；完整安裝檔僅發佈時打。

---

## 地雷

### 安全底線（跨模組）

- **雲端路徑的 HTTP 錯誤只記狀態摘要**：上游 response body／token／外部 `error.message` 一律不進 console／IPC／UI（API URL 是使用者自填的，閘道原樣回音等於在 UI 印出自己的金鑰）。回歸 `test-error-hygiene.js`。
- **代理／閘道不透傳上游狀態碼**：只有 429（含 `retry-after`）原樣回，其餘一律 502；每個端點走同一個 `statusFor`。
- **不收 renderer 給的網址**：模型掃描只收 providerId，上游位址一律由 main 從 store 取。
- **圖片只收 `data:` URI**（去下載客戶端給的 http URL＝SSRF 跳板）。
- 不硬編碼 secrets（Antigravity OAuth 走環境變數）；外部 CLI 憑證（`~/.codex`／`~/.grok`／`~/.commandcode`）**只讀不寫**。
- **`workspace/files.js` 的 `resolveIn` 是唯一的檔案系統入口**：renderer 只送 `{ projectId, relPath }`；比對要帶路徑分隔符（`base + path.sep`），字面檢查後還要兩邊 `realpathSync.native`（資料夾連結繞得過字面比對）。
- **git 一律 `spawn(..., { shell: false })` ＋參數陣列＋ `GIT_TERMINAL_PROMPT=0`／`GIT_ASKPASS=''`；stderr 不透傳**（裡面有遠端 URL、使用者名稱，有時是 token）。「沒東西可提交」要跟「提交失敗」分開講。
- **agent 恢復指令是 main 的固定表**，session id 卡 `^[A-Za-z0-9_-]{6,64}$`，且要先確認那段對話屬於這個專案。

### 打包／建置

- 保留 `asar.smartUnpack: false`；`asarUnpack` 要含 sherpa-onnx*、`@node-llama-cpp/win-x64`、`@reflink`、Antigravity `.ps1`、`sysmon/probe.ps1`、`screentime/observer.ps1`、`uiohook-napi`、`@lydell/node-pty-win32-x64`。
- **外部程序（PowerShell、conhost）執行不了 asar 內檔案**，路徑要換成 `app.asar.unpacked`。
- **`node-llama-cpp/llama` 整包排掉會讓打包版的本地 LLM 靜默失效**（runtime 讀 `binariesGithubRelease.json`）：排除後要 include 回那支 json。動 `build.files` 前後跑 `probe-packed-local-llm.js`。
- 打包跑的是 `src/` 原始碼；**新增任何產物資料夾都要記得排除**（`dist-hud/` 曾讓 asar 525MB → 1.46GB，`native/` 漏排時 asar 631MB **打包直接失敗**在 `EBUSY: unlink app.asar`）。
- **`app.asar` 被別的程式抓著 → 產出的 asar 會安靜錯位**（每個檔案拿到前一個的內容，整頁 SyntaxError，electron-builder **exit 0**）。兇手實測是 `Orca.exe`（連 `%TEMP%` 也監看）。解法：打包到工作區外 → `cd` 到暫存目錄跑 `npx @electron/asar extract-file <app.asar> package.json` 驗過（**這指令會把檔案寫進當下工作目錄**，在專案根目錄跑會蓋掉自己的 `package.json`）→ `robocopy /MIR /XF app.asar` 覆寫回去，asar 用 `[IO.File]::Open(dst,'Open','Write','Read')` 就地覆寫＋`SetLength`，**`VoiceInk.exe` 一定要一起換**（完整性雜湊嵌在它裡面）。
- `electron:pack` 中途失敗會留下壞掉的 `dist/win-unpacked`（症狀：啟動無 log、CDP 埠連不上）：**整個刪掉重打**。
- **`latest.yml` 只在 `build.publish` 有設定時才產出**；**`nsis.artifactName` 不能改回預設**（預設帶空白，上傳 GitHub 會被改名成點分隔版 → 下載 404）。回歸 `test-updater.js` 的 [E]。
- **`electron:pack`（dir target）的預覽版永遠檢查不到更新，那不是 bug**（只有 nsis／appx 才寫 `app-update.yml`）；**不可以把 error 當成測試通過**。`autoInstallOnAppQuit` 在本 App 無效——`installOnQuit()` 要在 `app.exit(0)` 前一行。
- CDP 腳本都吃 `VOICEINK_EXE` 環境變數。

### 啟動與常駐

- `whenReady` 立刻 `show: true` 建窗、不 await store；ASR／LLM／額度／AGY 第一次用到才 require。
- **常駐三件套缺一不可**：`requestSingleInstanceLock()`；沒搶到鎖的用 **`app.quit()` 不是 `app.exit()`**；`whenReady` 也要 `if (!hasInstanceLock) return`。`close` 攔截必須放行 `isQuitting`。管理員終端機的 `--terminal-admin-host=` 要攔在搶鎖**之前**。
- **`document.hidden` 同時代表「被完全遮住」**，所以**不可以**關 `setBackgroundThrottling`（實測會讓它恆為 false）。常駐時只有計時器被節流（89ms → 19828ms），main→renderer 派送仍是 0～1ms。
- `before-quit` 要收：終端機 `killAll()`、sysmon 三顆、`llama-asr.unload()`、`dictationHud.close()`、`agy.shutdown()`（**不是 `stop()`**）、`oc.shutdown()`／風扇排在 `sensors.stop()` 之前；`workspace:flushDrafts` 要排在 `killAll()` **之前**（存不起來時要能取消結束）。

### 聊天

- **model 與訊息歷史所有權在 main**；模型必須對「目前這組供應商」驗證（只檢查「在不在任何清單裡」會拿 A 的模型打 B）。
- **`chat.send` 的 inflight 佔位必須跟守衛同一個同步區塊**（中間不得有 await）。
- **重新生成在上游成功前不得 `dropTrailingAssistant`**；`chats.json` 的 read-modify-write 一律走 `withStore`。
- 圖片不進 `chats.json`（只存檔名）；只送最近 6 則且**只送 user 的圖**；生圖 SSE buffer 要 24MB。
- thinking 關閉時**完全不帶** `reasoning_effort`；串流不可用 `AbortSignal.timeout`（首 token 60s ＋閒置 120s 雙計時器）；中斷時已收到的內容仍要存檔（累加器宣告在 try 之外）。
- **側欄順序＝陣列順序**，`list()` 不依 `updatedAt` 重排；超過上限只能 `filter` 掉最舊的。
- **`chatProviders` 的 sanitize 遇到壞網址要保留該筆、只清空 `apiUrl`**（它跑在存檔路徑上，整筆丟掉＝打錯一個字就刪掉金鑰）。`chatProviders` 變動時聊天與翻譯**兩組選擇都要收斂**。本機模型是 main 合成的 `__local`，`sanitizeProviders` 必須過濾掉它。
- `markdown.js` 全程 `createElement`＋`textContent`、**零 innerHTML**；`INLINE_SRC` 每次呼叫都要 `new RegExp`（共用 g-regex 會 OOM）。

### 專案工作區

- **三份清單要對起來**：`ipc.js` 用到的每個 `service.X` 都要在 `main.js` 的逐一列舉白名單裡、每支 `workspace:*` 都要在 preload 接得到；`index.js` 的 `module.exports` 列一個沒定義的名字＝**載入期 ReferenceError**，症狀是每支 IPC 都回通用錯誤，而 `node --check` 與單元測試全綠。回歸 `test-workspace.js` 的 [Q][Q2]。（AGY／sysmon／usage 同一條）
- **AI 記錄的家目錄不只 `~/.claude`／`~/.codex`**：要掃 `CLAUDE_CONFIG_DIR`／`CODEX_HOME` 與其他工作台的 runtime home（實測本機 Codex 記錄全在 Orca 那邊），照 `agent + id` 去重。`codeusage` 的 `jsonlSources()` 相反——**維持只掃預設家目錄**（游標鍵是檔名）。
-「讀過」跟「改過」要分開回；工具名不認得時算「讀過」，**不可以憑空說人家改過**。
- **存檔一定要帶開檔當下的 mtime**（`STALE` → 提示條給比較／重新載入／覆寫／保留編輯，草稿一個字都不能動）；同一檔案的寫入要排隊（Windows 上兩個 rename 指向同一目的地會 EPERM）；草稿上限要跟 `MAX_WRITE_CHARS` 同一個數字（4MB）。
- **開分頁的每一次 await 之後都要核對 `projectSwitch`，回來還要再 `findTab` 一次**；改名／搬檔後要 `retargetTabs`（分頁 id 內嵌相對路徑，不接的話存檔會把舊檔重新建出來）。
- `git status` 用 `--porcelain=v2 -b -z`；欄位是**位置**決定的，改名（`2`）那型後面還跟著一格原檔名。衝突（`u`）要自成一組。`git log` 的欄位分隔用 `%x1f`，**不能跟 `-z` 混用**；`for-each-ref` **不吃 `%x1f`**。
- 跟分支比要比 `merge-base` 不是分支頂端；`--numstat` 一定要配 `--no-renames`。切到非 git 專案時 `renderGit` 的提早 return **要把工作樹、分支下拉、審閱清單三塊都清乾淨**。
- worktree：路徑由 main 組（repo 的兄弟資料夾）、移除拿 `worktree list` 當白名單、不准移主工作樹、不加 `--force`、移除前先 `check`。
- **資料夾監看一次只看一個專案**；`.git` 底下的變動只當成「Git 狀態變了」；事件要合併；監看不起來安靜退回手動。
- 對話與終端機的 `projectId` 是**可選**欄位（缺值＝未分類，卡 `^[A-Za-z0-9_-]{1,64}$`）；`workspaces.json` 的路徑不存在只標 `missing`。
- 搜尋只收字串不收 regex，四個上限（命中 200／掃 8000 檔／單檔 1MB／15 秒）少一個都會凍住 UI；快速開檔與搜尋共用同一份 `walk`，模糊比對沒命中要回 `null` 不是 `-1`。
- **圖片先看副檔名回 `data:` URI**，不可走「二進位檔」那條（PNG 含 NUL 會被判成不能編輯）。Electron 43 **沒有內建 PDF 檢視器**，只能用 pdf.js 畫 canvas，且 `workerSrc` 不能給空字串。
- **Monaco 只能走 AMD 的 `min/vs`**（ESM 那份有 98 個 `import './x.css'`）；`build.files` 只放行 `monaco-editor/min/**`；codicon 是 `data:` 字型、Worker 是 blob（CSP 那兩條少一條就是「看起來壞掉但不報錯」，**沒有 Worker 時 diff 算不出來**）。那份 `<textarea>` 還在而且雙向同步（存檔／草稿／外部變更全讀它）；跳行要等 model 掛上（`pendingGoto`）。
- 內建瀏覽器是 `<webview>`：`webviewTag` **只開在主視窗**、guest 不掛 preload、popup 在 app 層用 `web-contents-created` ＋ `setWindowOpenHandler` 收斂。網址正規化要先照原樣解析、**協定不是 http(s) 才**補 `http://`（`localhost:5173` 會被當成協定）。本機 HTML 預覽用 `srcdoc` ＋ `sandbox="allow-scripts"`，**不給 `allow-same-origin`**。
- 分頁拖曳是 pointer 跟手＋FLIP（不是 HTML5 DnD），transform 只吃 X、讓位距離用量出來的 gap、要加 `scrollLeft` 變化量；檔案樹的拖曳**刻意**用 HTML5 DnD（兩邊取捨不同，不要統一）。切分頁的 click 掛在 `.ws-tab-open` 不是 `.ws-tab`。
- 檔案樹展開／收合只動自己那一列後面的子樹（整棵重畫會把捲動位置跳回最上面）。
- 新增／改名的名字要在 `checkName` 就擋（斜線、冒號、Windows 保留檔名）；刪除要擋專案根目錄；搬檔要擋「搬進自己底下」與同名覆蓋。
- `netstat -ano` 的 `LISTENING` 沒有被在地化可以直接比對；**刻意不用 `Get-NetTCPConnection`**（要載模組）。

### 終端機

- **忙碌判定不能只靠 OSC 133**（PSReadLine 會重送整份提示字元）：標記要帶 `Get-History` 的 id 且**比大小**，第一個看到的標記只是「現在這個提示字元」；也不能只靠靜默（AI CLI 是常駐 REPL）。兩者都要。
- **狀態變動只能就地改那一列，不可 `renderList()` 重建**（待確認的刪除鈕與改名輸入框掛在 DOM 上 → 跑著的終端機刪不掉）。
- 注入 PowerShell 的 `-Command` 字串不可含雙引號（用單引號＋`+` 相接，`$ok = $?` 必須第一句）。
- shell 與啟動指令只收 key（固定表），cwd 走系統對話框再 `statSync().isDirectory()`。
- **管理員終端機**：ConPTY 開不出提權 shell，改用 `Start-Process -Verb RunAs` 再開一份自己代開。host 的 socket 一 close 就 kill 掉所有管理員 shell；一顆 host 服務全部階段（UAC 只跳一次）；host 模式要 `app.setPath('userData', ...temp...)`（提權程序寫進主 userData 會讓檔案擁有者變管理員）。
- `term.open()` 前要先讓那一格可見（`display:none` 會開出 0×0）；「人在不在看」要看 `#termMain` 不是 `termHost`。
- `.chat-list-item` 三邊共用，選擇器一定要限定 `#chatList`／`#projList`。側欄寬度走 `--chat-sidebar-w`（`main.css` 有三處要各留 `var()`）。

### HF模型與本地 LLM

- 推論一律走 llama-server 的 **router 模式**（`--models-dir`），不要自己寫多模型管理器；模型 id ＝檔名去 `.gguf`／資料夾名；`--models-preset` 的 INI 只在啟動時讀（改完要重啟）。
- **記憶體配置以官方 `llama-fit-params` 為準**，它只調整使用者沒設的參數（主動寫死 `gpu-layers` 等於把那套關掉）。
- **KV cache 要用 GGUF 的 `attention.key_length`／`value_length`**，拿 `embedding_length ÷ head_count` 推會低估 1.6～2 倍 → OOM。
- V 的 KV 量化需要 `flash-attn = on`（K 不用）；f16 那檔**刻意不送** flash-attn。MoE 塞不下時搬專家（`n-cpu-moe`）不砍層。
- `presets.js` 的 `safeValue` 只清換行，**不可以清中括號**（`override-tensor` 的值是 llama.cpp 自己產的 regex）。
- `readConfig` 的 modelId 不在清單內時回空字串、**不退回第一顆**（那是 `chat.send` 的 allowlist 依據）。
- node-llama-cpp 是 ESM-only（main 只能動態 `import()`）；Qwen 系列要 `budgets: { thoughtTokens: 0 }`；**Qwen3.5 的 generation prompt 必須以空 think 區塊收尾**（用 `new QwenChatWrapper({ thoughts: 'discourage' })`，兩件事都要做）。
- **關思考一律用 `reasoning: { exclude: true }`**，`{ enabled: false }` 在強制思考的模型上直接 400。
- LinguaForge 一律單輪、逐行翻譯、≤280 字；zhtw 必須 `repeatPenalty: false`，重試前必須 `setChatHistory` 還原。譯文清理集中在 `translate-clean.js`；**不要用 regex 剝前綴當修復**。`s2twp` 只在真的含簡體時才套。
- 離開翻譯頁必須作廢 `_translateRequestId`；`translateLocalOnce` 一定要把 key 傳進 `getSession(key)`。

### ASR／語音輸入／即時字幕

- **`asr-select.js` 是本地 ASR 唯一的選擇點**，renderer 給的 `modelKey` 一律不採用；`engine.js` 必須有 `setStore` 並轉給它。
- scope 由呼叫點決定；三個子分頁各存一份模型選擇（`model-scope.js` 是唯一解析點），`seedFromLegacy` 要可重入且不蓋掉空值。
- **本地 GPU ASR 只能走 llama-server**（npm 的 sherpa 是 CPU-only 編譯，傳 `cuda` 只會靜默退回）；llama-server 一定要帶 `--device`（不給實測慢 97 倍且不報錯）。Qwen3-ASR 經 llama-server 會夾前綴要 `stripAsrTags`。
- 中文一律吐簡體 → **三支 ASR 都要套** `s2twp`（判斷函式共用）。雲端 ASR 的 **401 與 403 是兩件事**（金鑰壞 vs 模型沒開通）。
- ASR 必須 `withAsrLock` ＋ `loadEnabled`；檔案轉錄走 main（ffmpeg 串流切段），pause 要看「已排隊未 ASR 段數」。
- **`await` 一個 rAF 一定要配逾時**（視窗被遮住時 rAF 3 秒零回呼）。
- **右 Alt 只能用低階鍵盤 hook 認**；原生 sidecar 三個坑：委派要用欄位抓著、`GetMessage` 迴圈不能省、靠 stdin EOF 結束。Esc 不吞。退路模式要補送 F24（一次按放只補一次）。keydown 會重送，狀態機要 `pressed` 旗標。
- 麥克風在啟用時就一直開著（track `ended` 要自己重建）；單次上限 20 分鐘，**長錄音一定要切段**（用 `slice` 不用 `subarray`）。
- **整理失敗一定要退回原文照樣插入**；**字典要套兩次**（送進模型前、模型回來後），學詞夾在中間；自動學詞要保守（兩次才啟用、不學反向對與接力對、反向對要 `demote`、手動加的不扣）；prompt 只帶這段用得到的字典。
- `applyDictionary` 是**單趟掃描**不是每條各跑一次（否則 A→B→C 接力）；拉丁詞要卡詞界並忽略大小寫。
- 整理分兩種模式（門檻 180 字），模式要在**切段之前**用整段長度決定；本地整理一定要先切段（context 只有 2048）；長度離譜就當沒整理過；**「輸出語言」是選字習慣不是翻譯指令**。
- HUD 必須 `focusable: false` ＋ `showInactive()`；視窗尺寸固定（`resizable: false` 會讓 `setBounds` 被靜默忽略），透明大框要 `pointer-events: none`；啟用時就 `hud.warm()`（副作用是多一個 CDP target）。
- 即時字幕：`AudioContext(16000)` ＋ `ScriptProcessorNode` 直取 PCM（勿改回 MediaRecorder）；靜音與非語言片段要在訊號層擋掉；失敗時別把原文冒充譯文寫進 history；字幕視窗 `transparent: false` 是刻意的；顯示模式由字幕彈窗獨佔；`subtitleWindowBounds` 讀寫兩邊都要 sanitize；OS 關掉要補發 `subtitle:closed`。
- 引擎 owner 是 `live|file|translate` 布林（不可改計數）；長 await 之後與 `finally` 裡都要重檢 session 狀態。

### CC 代理與轉換閘道

- **改 `~/.claude/settings.json` 只能動 `env` 裡我們管的那幾個鍵**（使用者那份還有 hooks／plugins／permissions）；切換時**要先清掉前一家的鍵**；壞掉的 settings.json 一律拋錯不可當空物件；寫入前備份＋原子替換。
- `official` 預設＝寫出空 env 讓 Claude Code 回到自己的 OAuth，**刻意不寫 `api.anthropic.com`**。
- **供應商的「上游格式」就是路由開關**，`providers.routeFor()` 是唯一推導點，renderer 不可自己看 `preset.route`。
- **內建各家不吃使用者填的 Base URL**（`allowsCustomUrl()` 只放行 `custom`），`sanitizeAll`／`create`／`update` 三處都要擋；`baseUrl` 只放行 http(s)；`authField` 只收兩個值之一。自訂的閘道路由 key 是 **provider id 不是 preset id**。
- **Codex 的 Responses 端點不是公版**：`store` 要明寫 `false`、`max_output_tokens` 與 `temperature` 一律 400；只對 Codex 那條路由套，「測試」鈕的 probeBody 也要套。
- **1M 上下文＝模型名尾巴加 `[1m]`**（四個等級都要），`CLAUDE_CODE_MAX_CONTEXT_TOKENS` 與 `AUTO_COMPACT_WINDOW` 要一起放大；閘道仍要 `stripContextMarker`（舊版 CLI 會原樣送出）。這是「宣告」不是「升級」。
- Grok 訂閱制走 `cli-chat-proxy.grok.com`（要帶 `x-grok-client-version`）；Codex `/models` 一定要帶 `client_version`，列位叫 `slug`。
- Codex 走 PKCE ＋ loopback `localhost:1455`（埠是註冊死的），xAI 走 device code；callback 要驗 `state` 且綁 127.0.0.1，結束一定要收 server。
- 自己登入的帳號與「沿用 CLI 憑證」**兩條的快取鍵要分開**；refresh token 可能輪替。
- **CLI 更新一律用該工具自己的 updater**（只有 codex／opencode 真的是 npm 裝的）；查 npm `/latest` 不可帶精簡格式 Accept（406）。
- MCP 存在 `~/.claude.json`（動輒好幾 MB，只能讀進來改 `mcpServers` 再原子寫回）；停用的搬到自己的 store；Windows 上 `npx`／`npm` 要包成 `cmd /c`（已經是的不可重複包）。

### AGY 反代

- 憑證只讀不寫；`detectSources()` 只認執行檔不認資料夾。**token 續期靠代跑 `agy.exe models`**：stale 但沒過期→背景跑照回舊 token；真過期或 401→等 CLI 跑完並**確認 token 真的換了**。冷卻 60s ＋ in-flight 合併。
- 代跑 CLI 一定要 `spawn` ＋ `stdio: 'ignore'`（`execFile` 留一條永不 EOF 的 stdin，對方卡到逾時）。
- **`mustRefresh` 只有 401 能設**；`acquire` 失敗只清記憶體快取，不可 `invalidateToken()`（會把憑證永久卡住）。
- 端點順序 sandbox → daily → prod（0/403/429/5xx 才往下換）；**不要送 `x-goog-user-project`**；`countTokens` 只吃 `{ request }`；`thinkingBudget: 0` 不能無條件送（名單是實測出來的）。
- `catalog.js` 才是模型清單權威；上游回的 `models` 是**物件不是陣列**；映射表不可覆蓋真實存在的上游 id，每個映射目標都必須實測可用（`DEFAULT_MODEL` 尤其致命）。`/v1/models` 空清單要退回靜態表。
- SSE 每格包一層 `response` 信封要 `unwrapEnvelope`；usage 新舊格式**看欄位存不存在不是看值**。
- **送上游的 function schema 走白名單**，還要處理三種「欄位名對型別不對」：陣列 type → 單一型別＋`nullable`、非字串 enum 剝掉、`anyOf` 裡的 null 支換成 `nullable`（否則整包 400、所有工具一起陣亡）。
- 非 2xx 要 `discardResponse`；server 要檢查 `Host` 是 127.0.0.1／localhost；`logs.js` 的 `node:sqlite` 每個操作都要能失敗。
- 頁上有兩組 Base URL：OpenAI 相容要 `/v1`，Claude Code 要根位址。統計時間範圍是 main 的白名單，序列必須補零。

### 用量統計與額度

- 五家記錄是 GB 等級：每檔記位移游標、只在使用者按掃描時跑、折成每小時桶、原始事件不留。
- **游標 key 必須跟著檔案走**（Codex／Grok 的 session 會搬進 `archived_sessions`，認絕對路徑會整份重算）；增量掃描要把「這個檔案用哪顆模型」存進游標並回填。
- **Codex fork 的 rollout 開頭是母 thread 的重播，一筆都不能收**（實測 60 份子代理重播出 7.8 萬筆假請求）：重播結束點＝第一個 `turn_context`，`state.replay` 要存進游標；`session_meta` 的預過濾不可以用 `"model"`。
- 三個「加錯就差十倍」：Codex 要加 `last_token_usage` 不是 `total_token_usage`；Claude 串流要靠 `message.id` 去重；`input` 有沒有含 cache 三家不同。Grok 的 ticks **所有世代都是 1 USD = 1e10**（別用表列單價反推）。
- **快取的價錢要分開算**（Anthropic read = input×0.1、5m 寫入 ×1.25、1h ×2，Claude Code 幾乎都是 1h）；OpenAI 從 gpt-5.6 起有 cache write（`cacheWrite1h` 要寫成跟 `cacheWrite` 同價，留 0 或空著都會算錯）。
- 沒有單價的模型 `costUsd` 回 **null 不是 0**；模型 id 要正規化後才合併（剝 `-thinking` 但**不剝 `-lite`**）；「不是模型名的 id」不收但 `unknown` 要留；改 `normalizeModel` 要把 `RULES_VERSION` +1。
- **額度：`mergeExpectedWindows` 只能由 `usage/index.js` 呼叫**，空窗（API 失敗）也不可 merge（否則會生出「憑空的 100% 已用盡」還標成官方真實額度）。
- 訂閱方案來源全在本機登入檔不在額度 API；`seven_day_opus` 非 Max 回 **null 不是 0**；Command Code 的額度在 `billing/credits` 不是 `usage/summary`；OpenCode 的 403 ＝沒訂閱（要用 `disconnected`）；**Ollama 的 `usage` 是 0～1 的比例**且上游不給重置時間（不可自己算一個假的）。

### 系統監控／風扇／效能調整

- **一定要用 `Win32_PerfRawData_*`**（GPU 引擎 `Get-Counter` 5335ms vs raw 67ms）；raw 是累計值，一定要配 `Timestamp_Sys100NS` 算差值。`Win32_VideoController.AdapterRAM` 是 uint32（8GB 以上一律爆掉，真值在登錄檔）。
- **GPU engine 的配對 key 必須含 LUID＋引擎索引**（少一個會配錯實例，出現 7995% 假使用率）；uint64 累計計數器會繞回（`COUNTER_WRAP` 以上不做差值）。**不顯示 `Idle`（pid 0）**。
- **NVMe 的 S.M.A.R.T. 不必提權**，但開實體磁碟時 `dwDesiredAccess` **一定要給 0**；`Data Units Read/Written` 的單位是 1000 × 512 bytes；`0 K` 是「感測器不存在」。
- `probe.ps1` 要有 UTF-8 BOM ＋ `AutoFlush`；**probe 裡不可以相信 `$env:*`**（被 spawn 的子程序沒有）；static 框裡不准查 `Win32_Tpm`（未提權卡 5.2 秒）；網路卡走 `Win32_NetworkAdapter` 不用 `Get-NetAdapter`。
- **資料列一律往後加欄位、解析端逐格取值**（不要插在中間）；SMBIOS 佔位字串統一在 `metrics.clean()` 清掉；groups 的 rows 值不能給空字串（整列會塌成 0 高）。
- 感測器 sidecar：只有它提權（不是整個 App）、版本鎖 `0.9.7-pre728`、斷線要自己重拉（上限 5 次，經 `ensureSensors`）；**自動啟用只能放在進系統監控頁時**（開機那條只走排程工作）；PawnIO 由 App 代裝但要驗 Authenticode（不釘 SHA-256），靜默安裝參數是 `-install -silent`；殭屍 sidecar 要用 `Invoke-CimMethod ... Terminate` 才殺得掉。
- **風扇的手動 PWM 是留在晶片裡的**，新程序 `SetDefault()` 救不回來（只有重開機）：所以下限 `minPwm` ≥20、sidecar 5 秒看門狗、`before-quit` 要 await 得到、`dirty` 存 store。
- **雙向管道一定要 `PipeOptions.Asynchronous`**（同步讀會把同步寫整個擋住，症狀是只收到第一框且完全不報錯）。
- 開機接管只能走排程工作（無觸發程序、`RunLevel Highest`、`ExecutionTimeLimit 0`），管道名走交接檔；**只在打包版提供安裝**（開發版執行檔可寫＝免 UAC 後門）。
- 緊急放手要用未平滑的原始值；讀不到來源值要交還 BIOS 不是沿用舊值；曲線 Y 軸是 PWM 不是 RPM；等角示意圖的槽位要驗「投影後兩兩不重疊」；槽位只印短代碼。
- 效能調整：安全方向跟風扇**相反**（卡住要還原出廠）；硬上限 main 與 sidecar 兩邊都夾；≥95°C 立刻還原；**開機不自動套用**；不做 I2C／RTCore；V/F 寫入 `frequencyDeltaKHz` 要 ×2；CDP 測試**不准按套用**。
- 走勢圖兩條線各自縮放要各標各的 Y 軸；**讀不到值不可以用 0 佔位**；儀表顯示實際讀數不是牆。
- 壓力測試放 main 不放 renderer（V8 對整個 process 的 ArrayBuffer 約 8GB 上限），停止時 `kill` 子程序；GPU 壓測三件事一起才壓得滿（1080p 後端解析度、畫進離屏 framebuffer、只用 `readPixels` 計時）；測試期間才 `setBackgroundThrottling(false)`；離開頁面要自己收 CPU／記憶體壓測。
- 使用時長：同一份 Tai 庫與寫入規則、第一次拷進 `<userData>/screentime/`（不跟還在跑的 Tai 搶）；外掛協定寫死 `ws://127.0.0.1:8908`；**有 `LIMIT` 的清單不可以拿來算總數**。

### UI／CSS

- **`themes.css` 沒有 `--surface`／`--accent`／`--border` 這三個名字**（是 `--surface-glass`／`--surface-solid`／ `--accent-primary`／`--border-color`）：CSS 變數打錯不報錯，只會變成「沒有背景」或（SVG `fill`）純黑。新寫樣式前先 grep `themes.css`；回歸要量 `getComputedStyle` 的實際顏色。
- **用 `el.hidden` 收合的元素，CSS 若寫了 `display` 就必須自己補 `[hidden] { display: none }`**（`.btn`、`.sidebar-panel`、`.app-dialog` 都中過；`<dialog>` 寫 `display` 一定要帶 `[open]`，否則沒開的彈窗全浮出來）。只斷言 `.hidden === true` 抓不到，**要量 `offsetHeight`**；`<details>` 收起後子元素的 `offsetHeight` 還是舊值。
- **`backdrop-filter` 會偷走 `position: fixed` 的定位基準**（`positionMenu` 要先歸零量原點再回推）。
- 下拉走 `custom-select.js`（原生 `<select>` 留作資料與事件來源）；`optgroup` 只能用 `querySelectorAll('option')` 讀；flex 版面要收斂的是 `.custom-select` 不是 `.select`。
- 批次改 CSS 前先確認選擇器不是某條多選擇器規則的結尾（曾把共用規則的 `background` 一起刪掉，全 App 玻璃面板變透明）。
- 彈窗：body 要掛上共用的 `overflow-y: auto` 規則、內容區要自己補 `padding: 4px 24px 0`。
- **全 App 禁用強調條／裝飾條**（方框左邊一條粗彩色條、標題前色票偽元素都算），強調走 1px 邊框或底色 tint。
- 規格表與長條圖標籤不准 `text-overflow: ellipsis`（截掉那筆等於沒有那筆資料），要 `overflow-wrap: anywhere`；`<dl>` 多欄流版每組 dt/dd 要包一層 `<div>`。**hover 才出現的操作等於沒有**。
- 說明文字：空狀態 ≤12 字、hint 只留「這是什麼」；**測試不可以用「字數大於 N」當斷言**；改文案要 grep 測試腳本；但「防誤解」的最短說法（dwm VRAM、磁碟測速含快取、風扇下限）不準刪光。
- 設定頁只管「裝了什麼、怎麼推論、雲端端點」，選哪一顆模型在功能頁選；未安裝的本地模型仍要留在選單裡標「（未安裝）」。
- `.subtab-panel` 的顯示只由 `.active` 控制；狀態樣式要比 hover 更高特異度；可以拖的東西一律 `user-select: none`。

### 測試（CDP／e2e）

- **在這個 App 裡開發這個 App，一律 `npm run dev:sandbox`**（`scripts/dev-sandbox.js`）：三份 VoiceInk 預設共用 `%APPDATA%\voiceink`，而 `requestSingleInstanceLock()` 綁的是 **userData 路徑**（`main.js` 特地在搶鎖前就套用 `--user-data-dir`）——不換路徑只會把使用者的視窗叫到前面然後自己關掉，還跟他搶資料檔與 AGY 的埠。沙箱在 `%APPDATA%\voiceink-dev`：`models`／`hf-models` 用 junction 接回真的那份（唯讀，30GB 不能複製）；`config.json`／`workspaces.json` **複製**一份（有真資料可用又弄不髒）；會累積的紀錄（usage／code-usage／ agy-logs／dictations／terminals）**不接**；`agyEnabled`／`dictationEnabled`／`sysmonSensors` 強制關掉（只有這三個的影響跑得出 userData 之外）。**寫進沙箱前一律先 `rm` 目的地**——`writeFileSync`／`copyFileSync` 會跟著符號連結寫到對面去，沙箱裡只要有一條指回真 userData 的連結，這支「保護資料」的腳本就會親手覆寫使用者的設定。
- **CDP 收尾只能殺自己**：暫存 `--user-data-dir` ＋只對自己 spawn 的 `child.pid` 跑 `taskkill /PID /T`；**禁止 `/IM VoiceInk.exe`**（會關掉使用者的安裝版）。
- **不可以用「第一列」或「總數」指涉自己建的東西**（最糟會刪掉使用者的資料）：一律 `[data-id="..."]`，中途建的都要刪掉。
- 同一時間只能跑一支 CDP 測試；挑主視窗一律用 `/index\.html/`（HUD 也是一個 page target）。
- **暫存 user-data-dir 會連帶搬走資產**：模型用 junction 接回去（只讀）、`chatProviders` 自己種、埠跟 OS 借（`listen(0)`）。多實例測試的第二／第三份也要帶**同一個** `--user-data-dir`，否則那兩條斷言根本沒測到卻是綠的。
- UI 斷言要等「量得到尺寸」不要睡固定時間；`Runtime.evaluate` 每次都在同一個全域範圍求值（`const` 要包 IIFE）；新增 nav 分頁時五個腳本裡寫死的頁面清單都要同步更新；開頭要把 `sysmonSensors` 關掉（否則彈 UAC 卡住），`finally` 還原。
- `npx electron <script>` 時 app 名是 `Electron`，開頭要補 `app.setPath('userData', ...voiceink)`。
- 批次改識別字（sed）時斷言與清單最危險（`=== false` 會變恆假、陣列會塌成重複項），改完 `git diff` 逐條看。
- **語音輸入的自動化測試必須把 `insert` 換掉**（否則會把文字貼進使用者正在用的程式）。

---

## 驗證方式

宣告完成前必附驗證指令與實際輸出。純函式用 `node`，需要 Electron 的用 `npx electron`，打包版 UI 用 CDP（先 `electron:pack`）。
全部在 `scripts/`。

| 範圍 | 指令 |
|---|---|
| 開發沙箱 | `probe-dev-sandbox.js`（**實測**沙箱讀得到你的模型與供應商，而你正在用的那份一個位元組都沒動；動 `dev-sandbox.js` 前後都要跑）|
| 專案工作區 | `test-workspace.js`／`-nav`／`-ui`／`-state` ＋ `e2e-workspace-cdp.js`（暫存 user-data-dir ＋自種專案）；動 Monaco 前後跑 `probe-workspace-monaco.js`，動 PDF 前跑 `probe-workspace-pdf.js` |
| 終端機 | `test-terminal.js` ＋ `e2e-terminal.js`（真 ConPTY）＋ `e2e-terminal-cdp.js`；管理員 `probe-terminal-admin.js`（免 UAC）／`probe-terminal-admin-elevate.js`（**跳一次 UAC**）|
| 聊天／Markdown | `e2e-chat.js`（mock SSE）＋ `e2e-chat-cdp.js` ＋ `test-markdown.js` |
| HF模型 | `test-hfmodels.js` ＋ `probe-hf-router.js`（動 runtime 前跑）／`probe-hf-hub.js`／`probe-hf-detail.js`（打真 HF）＋ `e2e-hfmodels.js` ＋ `e2e-hf-cdp.js` |
| CC代理／閘道 | `test-ccswitch.js` ＋ `e2e-ccswitch-cdp.js`；端點 `probe-ccswitch-endpoints.js`／模型 `probe-ccswitch-models.js`／Codex 參數 `probe-ccswitch-codex.js`；閘道 `test-ccswitch-gateway.js` ＋ `e2e-ccswitch-gateway.js` |
| AGY | `test-agy-mappers.js` ＋ `e2e-agy.js`（mock）＋ `e2e-agy-cdp.js`；動映射表／端點順序前跑 `probe-agy-upstream.js`，動 `runAgyCli` 前跑 `probe-agy-nudge.js` |
| 用量統計 | `test-code-usage.js` ＋ `e2e-code-usage.js`（真的讀本機記錄）＋ `probe-code-usage-audit.js`（不經 codeusage 重算對帳）|
| 額度 | `test-usage.js` ＋ `e2e-usage.js` ＋ `e2e-usage-cdp.js`；動端點或解析前後跑 `probe-usage-endpoints.js`（打真上游）|
| 系統監控 | `test-sysmon.js` ＋ `e2e-sysmon.js` ＋ `e2e-sysmon-cdp.js` ＋ `probe-sysmon-stress.js`（實機量有沒有壓到）＋ `e2e-sysmon-sensors.js`（**跳 UAC**）|
| 風扇／效能調整 | `test-sysmon-fans.js` ＋ `e2e-sysmon-fans-cdp.js`（不接管真風扇）＋ `probe-sysmon-fans.js`／`probe-sensors-task.js`（**跳 UAC**）；`test-sysmon-oc.js` ＋ `e2e-sysmon-oc-cdp.js`（不按套用）|
| 使用時長 | `test-screentime.js` ＋ `e2e-screentime-cdp.js`（**不關使用者的 Tai**）|
| 語音輸入 | `test-dictation.js` ＋ `e2e-dictation.js`（insert 是 stub）＋ `e2e-dictation-cdp.js`；熱鍵 `probe-dictation-hook.js`／`probe-uiohook.js`／`probe-dictation-latency.js`／`probe-dictation-live.js`（**會搶焦點**）|
| ASR／即時字幕 | `e2e-llama-asr.js`／`e2e-asr-threads.js`／`e2e-stt-cdp.js`／`probe-cloud-asr.js`（真金鑰打真上游）；`test-vad.js` ＋ `e2e-live-pipeline.js` ＋ `e2e-live-cdp.js` |
| 翻譯 | `probe-prompt-path.js`（prompt 逐 token）＋ `verify-chat-wrapper-fix.js` ＋ `probe-packed-local-llm.js`（動 `build.files` 前後）＋ `probe-translate-lang.js` |
| 跨模組 | `test-error-hygiene.js`（錯誤衛生）／`test-ipc-invoke.js`（IPC 外殼）／`e2e-tray-cdp.js`（常駐）／`test-updater.js` ＋ `e2e-update-cdp.js`（會連 GitHub）／`e2e-visual-cdp.js`（七頁 × 主題 × 三尺寸）／`e2e-ux-tweaks-cdp.js`（**會叫到最前面**）／`e2e-cdp-smoke.js` |
