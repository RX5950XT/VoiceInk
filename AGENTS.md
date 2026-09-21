# VoiceInk — 專案規範與 AI 作業守則

> 本檔是專案規則正文；`CLAUDE.md` 僅作相容入口。
> 現行架構與最近變更見 [CONTEXT.md](./CONTEXT.md)，可遷移的判斷原則見 [tasks/lessons.md](./tasks/lessons.md)。
> 底下「地雷」每一條都是實際改壞過的；細節查 git log。

## 專案

Windows Electron AI 工作台：聊天＋終端機＋專案工作區＋本機 LLM＋Claude Code 工作台＋系統監控＋
額度與用量統計＋AGY 反代＋語音轉文字＋翻譯與 TTS。Vanilla JS + Vite（無框架），Electron 43.4.1 ＋ Node 22。

nav：聊天（預設，**工作區與終端機同一頁**）｜檔案｜CC代理｜額度｜AGY反代｜語音轉文字｜翻譯與 TTS｜系統監控｜HF模型｜設定。

| 模組 | 一句話 |
|---|---|
| 聊天 | 多組供應商（`chatProviders`），雲端翻譯共用同一份清單；會話存 `chats.json`（含側欄資料夾與每對話取樣參數），圖片存 `chat-images/`；不同對話可同時回應 |
| 終端機 | `@lydell/node-pty` ConPTY ＋ xterm.js，開在工作區的分頁列上；PTY 由 userData 裡的獨立宿主持有（更新／關 App 只斷線）；可用管理員身分（提權 host 代開）|
| 專案工作區 | `src/main/workspace/`：專案＝本機資料夾（`workspaces.json`）；中間分頁列（終端機／Monaco 編輯器／`<webview>` 瀏覽器），右側欄＝檔案總管／Git／AI 記錄／監聽埠 |
| 檔案 | 整機檔案總管（`src/main/explorer/`）；瀏覽本機資料夾；檔名搜尋走 UFFS（MFT），不自己 walk 整碟 |
| HF模型 | 在 HF 搜 GGUF → 下載 → llama-server **router 模式** 一顆程序管全部模型 → 出現在聊天選單 |
| CC代理 | `src/main/ccswitch/`：供應商 tile 改 `~/.claude/settings.json` 的 `env`／MCP／CLI 版本；非 Anthropic 格式經本機閘道轉協議 |
| 系統監控 | `probe.ps1` 常駐取樣器＋`nvidia-smi`；六子頁（總覽／使用時長／處理程序／壓力測試／風扇控制／效能調整），感測器走提權 sidecar |
| 額度／用量統計 | 額度＝七家官方端點（`usage.json`）；用量統計＝掃五家 CLI 本機記錄算 token／花費（`code-usage.json`），兩件事 |
| AGY 反代 | Antigravity 憑證 → OpenAI／Anthropic 端點；只綁 127.0.0.1＋強制金鑰 |
| ASR／翻譯／TTS | 本地 sherpa（CPU）／llama-server（GPU）或雲端；翻譯 local（LinguaForge）／cloud；TTS 走 Edge TTS |
| 語音輸入 | 全域右 Alt（原生 sidecar 吞鍵）→ 錄音 → ASR → 個人字典 → LLM 整理 → 剪貼簿＋Ctrl+V，底部浮藥丸 |
| 常駐／更新 | 關窗縮系統匣（`closeToTray`）；`updater.js` ＝ electron-updater ＋ GitHub Releases 的 `latest.yml`（安裝檔經鏡像下載） |
| 視覺 | Token Anxiety Aurora glass；深／淺共用 12px surface、blur；RWD 900／640px；本機字體 |

模型 registry `src/main/models.js`，下載至 `%APPDATA%/voiceink/models/`。

## 指令

```bash
npm run electron:dev     # 開發（vite + electron）
npm run dev:sandbox      # 沙箱實例：不干擾你正在用的那份，但接得到原本的模型與專案
npm run electron:pack    # 免安裝預覽 → dist/win-unpacked/VoiceInk.exe（UI／功能改完必跑；自動打到專案外→驗 asar→同步→刪外部輸出）
npm run electron:build   # 完整打包：NSIS 安裝檔＋ win-unpacked → dist/
npm run build:sensors    # 系統監控提權感測器 sidecar（需 .NET 8 SDK）→ resources/sensors/
npm run build:hook       # 語音輸入原生熱鍵 sidecar（需 .NET 8 SDK）→ resources/hook/
npm run build:shell      # 檔案總管殼層 sidecar（需 .NET 8 SDK）→ resources/shell/
```

`resources/sensors/`、`resources/hook/`、`resources/shell/` 不進版控（沒建置也打得起來，只是那兩個功能降級；shell 沒建＝右鍵少 7-Zip／WinRAR、沒有 Drive 綠勾）。
打包前先關掉 `dist/win-unpacked/VoiceInk.exe`。使用者同時在用電腦時，桌面 QA 只能用 CDP 背景操作。

### 發行流程（五步一整條，漏一步舊版永遠檢查不到更新，且**不會報錯**）

```bash
# 1) bump package.json 的 version（不可與既有 tag 重複），順手更新 README 版本行
git commit -am "feat: 發行 vX.Y.Z — <一句話>" && git tag vX.Y.Z && git push && git push --tags
npm run electron:build                                   # 2) 產出安裝檔、blockmap 與 latest.yml
gh release create vX.Y.Z --title "vX.Y.Z" --notes "..."  # 3) 不可加 --draft／--prerelease
gh release upload vX.Y.Z dist/VoiceInk-Setup-X.Y.Z.exe dist/VoiceInk-Setup-X.Y.Z.exe.blockmap dist/latest.yml
```

兩個檔案缺一：`.exe` → 下載 404；`latest.yml` → 舊版說「沒有附帶更新資訊」。
`.blockmap` 是**差分下載**用的，而差分下載在這個 App 上已經關掉（`updater.js` 的
`disableDifferentialDownload`，見地雷「更新」），上傳它只是留個後路，不上傳也不影響更新。
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
- 設定走 electron-store IPC，**key 僅 allowlist**。以下**不走** `store:*`，各有獨立 store／IPC：聊天／終端機／工作區／檔案總管／AGY／語音輸入紀錄／用量統計。`hfToken`、`agyEnabled`、`ocControl` 刻意不進 allowlist。
- 十組模組 IPC 的共用外殼在 `src/main/ipc-invoke.js`（主視窗守衛＋`{ ok, data|error }`＋`userMessage` 白名單），**handler 仍要各模組自己逐一列舉**。
- 兩窗 `sandbox: true`；CSP `connect-src 'self' https: http: vi-media:`、`font-src 'self' data:`、`worker-src 'self' blob:`（後兩條是 Monaco 要的，不可拿掉）；`img-src`／`media-src` 也要有 `vi-media:`（工作區媒體預覽）。
- **UI 改完先跑 `npm run electron:pack`** 更新免安裝預覽；完整安裝檔僅發佈時打。

---

## 地雷

### 安全底線（跨模組）

- **遞迴刪資料夾不准用 `fs.rmSync(..., { recursive: true })`，一律 `src/main/safe-rm.js` 的 `removeTreeSync`**（腳本裡是 `test-temp.js` 的 `removeTree`）：Node 24（＝Electron 43 內建）的同步遞迴刪除**會穿過 junction 把對面的真資料刪掉**（實測純 Node 24 與 Electron 主程序都會；Node 22 不會；非同步 `fs.promises.rm` 不會）。CDP 的暫存 userData 裡有 junction 指著使用者 6.9GB 的模型，系統 Node 一升級就是整包刪光。守門 `test-temp-hygiene.js`、回歸 `test-safe-rm.js`。
- **碰「使用者任意路徑」的模組用 `src/main/raw-fs.js`（Electron 下＝`original-fs`）**：Electron 的 `fs` 把 `.asar` 當資料夾打開而且**開了不關**——檔案總管列一次打包輸出、終端機把印出來的路徑偵測成連結、工作區搜尋掃到 `dist/`，那個 `app.asar` 就被 VoiceInk 鎖到關 App 為止（刪不掉、下次打包 `EBUSY: unlink app.asar`）。目前 `explorer/*`、`workspace/*`、`terminal/links.js` 已換；App 自己的程式碼與資源（在 asar 裡）**不要**用它讀。回歸 `test-asar-lock.js`（`npx electron`）。

- **雲端路徑的 HTTP 錯誤只記狀態摘要**：上游 response body／token／外部 `error.message` 一律不進 console／IPC／UI（API URL 是使用者自填的，閘道原樣回音等於在 UI 印出自己的金鑰）。回歸 `test-error-hygiene.js`。
- **代理／閘道不透傳上游狀態碼**：只有 429（含 `retry-after`）原樣回，其餘一律 502；每個端點走同一個 `statusFor`。
- **不收 renderer 給的網址**：模型掃描只收 providerId，上游位址一律由 main 從 store 取。
- **圖片只收 `data:` URI**（去下載客戶端給的 http URL＝SSRF 跳板）。
- 不硬編碼 secrets（Antigravity OAuth 走環境變數）；外部 CLI 憑證（`~/.codex`／`~/.grok`／`~/.commandcode`）**只讀不寫**。
- **`workspace/files.js` 的 `resolveIn` 是唯一的檔案系統入口**：renderer 只送 `{ projectId, relPath }`；比對要帶路徑分隔符（`base + path.sep`），字面檢查後還要兩邊 `realpathSync.native`（資料夾連結繞得過字面比對）。
- **git 一律 `spawn(..., { shell: false })` ＋參數陣列＋ `GIT_TERMINAL_PROMPT=0`／`GIT_ASKPASS=''`；stderr 不透傳**（裡面有遠端 URL、使用者名稱，有時是 token）。「沒東西可提交」要跟「提交失敗」分開講。
- **agent 恢復指令是 main 的固定表**，session id 卡 `^[A-Za-z0-9_-]{6,64}$`，且要先確認那段對話屬於這個專案。

### 打包／建置

- 保留 `asar.smartUnpack: false`；`asarUnpack` 要含 sherpa-onnx*、`@node-llama-cpp/win-x64`、`@reflink`、Antigravity `.ps1`、`sysmon/probe.ps1`、`screentime/observer.ps1`、`uiohook-napi`、`@lydell/node-pty*`（`node-pty` 的 JS 與 `node-pty-win32-x64` 兩份都要）。
- **`fs.cpSync` 讀不了 asar 裡的東西**（`copyFileSync` 可以）：終端機宿主複製 node-pty 時只會留下半套 `node_modules`，開發版全綠、打包版靜靜地開不起終端機。要複製整個資料夾就先 `asarUnpack`，路徑再換成 `app.asar.unpacked`。回歸只有 `probe-terminal-restart.js` 抓得到。
  **從 asar 裡複製單一檔案也不要用 `copyFileSync`**：Electron 會先把它解壓成 `%TEMP%\<uuid>.tmp<副檔名>` 當中繼，程序被強制結束（CDP 收尾的 `taskkill /F`）就永遠留在那裡（實測累積 609 個終端機宿主的 `.tmp.js`）。改成 `writeFileSync(to, readFileSync(from))`——`readFileSync` 直接讀 archive、不經暫存檔。
- **外部程序（PowerShell、conhost）執行不了 asar 內檔案**，路徑要換成 `app.asar.unpacked`。
- **`node-llama-cpp/llama` 整包排掉會讓打包版的本地 LLM 靜默失效**（runtime 讀 `binariesGithubRelease.json`）：排除後要 include 回那支 json。動 `build.files` 前後跑 `probe-packed-local-llm.js`。
- 打包跑的是 `src/` 原始碼；**新增任何產物資料夾都要記得排除**（`dist-hud/` 曾讓 asar 525MB → 1.46GB，`native/` 漏排時 asar 631MB **打包直接失敗**在 `EBUSY: unlink app.asar`）。
- **`app.asar` 被別的程式抓著 → 產出的 asar 會安靜錯位**（每個檔案拿到前一個的內容，整頁 SyntaxError，electron-builder **exit 0**）。兇手實測是 `Orca.exe`（連 `%TEMP%` 也監看）。解法：打包到工作區外 → `cd` 到暫存目錄跑 `npx @electron/asar extract-file <app.asar> package.json` 驗過（**這指令會把檔案寫進當下工作目錄**，在專案根目錄跑會蓋掉自己的 `package.json`）→ `robocopy /MIR /XF app.asar` 覆寫回去，asar 用 `[IO.File]::Open(dst,'Open','Write','Read')` 就地覆寫＋`SetLength`，**`VoiceInk.exe` 一定要一起換**（完整性雜湊嵌在它裡面）。
- **「工作區外」是指 `D:\Workspace` 之外**（實測：打到 `D:/Workspace/vi-pack-…` 一樣錯位，打到 `D:/vi-build-…` 才乾淨）；**打包期間不可以動到任何會被打包的檔案**——連改一行 `CLAUDE.md` 都會讓後面每個檔案位移（實測四次：中途編輯過的三次全錯位，全程沒碰的兩次乾淨）；**驗證要抽一支 renderer 的 `.js`**，只驗 `package.json` 過得了關卻仍然是錯的（`extract-file` 的路徑要用反斜線）。症狀：App 開得起來但整頁功能沒反應，console 一堆 `SyntaxError: Unexpected token '}'`，而且指的是你根本沒改過的檔案。
  **這整套已經是 `npm run electron:pack` 本身**（`scripts/pack-preview.js`：打到磁碟根的 `vi-build-<時間>` → asar 裡每一支 `src/` 跟原始碼逐位元組比對 → robocopy＋asar 就地覆寫進 `dist/win-unpacked` → 不論成敗刪掉外部輸出）。**不要再手動 `--config.directories.output=D:/vi-build-…`**，那會把幾百 MB 留在專案外；CDP 一律測 `dist/win-unpacked`。
- **NSIS 的警告會被當成錯誤**：`build/installer.nsh` 會被安裝程式與解除安裝程式**各編譯一次**，
  而 `customInstall` 只插進安裝程式那一份——在那裡宣告 `Var` 卻只在 `customInstall` 用到，
  解除安裝程式那次就是「宣告了沒人用」（warning 6001），`electron:build` 直接失敗。
  路徑之類的東西當字面值傳進 macro 就好（macro 參數是純文字替換）。症狀很難認：
  `dist` 只剩 `voiceink-*.nsis.7z`，連 `win-unpacked` 都被收走，而錯誤訊息埋在輸出很上面
  ——**別把 `tail` 之後的 exit code 當成建置成功**（管線的離開碼是 `tail` 的）。
- `electron:pack` 中途失敗會留下壞掉的 `dist/win-unpacked`（症狀：啟動無 log、CDP 埠連不上）：**整個刪掉重打**。
- **`latest.yml` 只在 `build.publish` 有設定時才產出**；**`nsis.artifactName` 不能改回預設**（預設帶空白，上傳 GitHub 會被改名成點分隔版 → 下載 404）。回歸 `test-updater.js` 的 [E]。
- **差分下載一定要關著（`disableDifferentialDownload = true`），開著會讓更新慢 70 倍**：
  electron-updater 在 GitHub 上只能走「一段一個 HTTP request、完全序列」那條
  （GitHub 不支援 multipart range，`providerFactory` 寫死 `isUseMultipleRangeRequest: false`），
  而且每 100 段還強制 sleep 1 秒。實測 v1.22.0 → v1.23.0：406MB 切成 2 萬塊、比對後仍有
  **1963 段**要下載（220MB），每段 115KB 的 range 請求 **506ms** ＝ **約 17 分鐘**；
  整包 406MB 單連線 14MB/s 只要 **28 秒**。省 185MB 流量換 36 倍時間。
  症狀是「按了更新之後進度條爬得比下載整包還慢」，而且**不會報錯**。
  回歸 `test-updater.js` 的 [B]；要重新評估時用 `probe-updater-diff.js` 拿真 blockmap 重算。
- **安裝檔不准直接打 GitHub CDN（APAC 會限到 ~50KB/s，406MB 要一小時）**：
  `latest.yml` 仍從 GitHub 讀（sha512 是信任根，不可走代理），`.exe` 由
  `update-mirrors.js` 先走 `ghfast.top`／`gh-proxy.com`，官方放最後——官方慢但會成功，
  排前面就永遠輪不到代理。下完仍由 electron-updater 對雜湊，代理換檔會失敗並試下一跳。
  回歸 `test-updater.js` 的 [F]；代理還活著、而且比官方快，跑 `probe-updater-mirrors.js`。
- **`electron:pack`（dir target）的預覽版永遠檢查不到更新，那不是 bug**（只有 nsis／appx 才寫 `app-update.yml`）；**不可以把 error 當成測試通過**。`autoInstallOnAppQuit` 在本 App 無效——`installOnQuit()` 要在 `app.exit(0)` 前一行。
- CDP 腳本都吃 `VOICEINK_EXE` 環境變數。

### 啟動與常駐

- `whenReady` 立刻 `show: true` 建窗、不 await store；ASR／LLM／額度／AGY 第一次用到才 require。
- **Windows 的視窗身分要自己宣告**：`app.setAppUserModelId('com.voiceink.app')`（＝`build.appId`，NSIS 捷徑上寫的就是它）要排在搶鎖**之前**。不設的話 Windows 自己從執行檔路徑推一個，跟捷徑對不起來——更新後（安裝程式重開 App，不是從捷徑點的）工作列會多長一顆；而 frameless 主視窗沒有 `icon:` 就沒有自己的 HICON，那顆就是**一片白**（實測 `WM_GETICON` small／big 都是 0）。兩件事都要做。
- **改 AUMID 會連帶換掉開機自啟動在登錄檔的值名稱**（`setLoginItemSettings` 寫的值名就是 AUMID，而 `getLoginItemSettings` **沒有 `name` 參數**）：舊版寫的 `electron.app.VoiceInk` 會變孤兒——開機照樣自己啟動，但設定頁顯示「未開啟」而且關不掉。要用 `migrateLoginItemName()` 搬過來。回歸 `test-taskbar-identity.js`。
- **更新會把捷徑放到過期**：electron-builder 更新時走 keepShortcuts 刻意不重建捷徑，但更新會把安裝資料夾與 `VoiceInk.exe` 整個換掉——`.lnk` 的 IDList 記著舊的時間戳，Windows 解析不到目標，工作列與開始功能表就退回「一張白紙加捷徑箭頭」。**視窗自己的 HICON 是對的**（`WM_GETICON` 拿得到圖），所以照著程式碼查永遠查不到。解法是 `build/installer.nsh` 的 `customInstall`：每次安裝把「本來就存在」的開始功能表／桌面／已釘選那三份重寫一次並補回 AUMID（`build/` 整個被 `.gitignore` 擋掉，那支要 `!build/installer.nsh` 放行）。回歸 `probe-taskbar-icon.js`（比對捷徑與 exe 解析到的是不是同一格系統影像清單）。
- **常駐三件套缺一不可**：`requestSingleInstanceLock()`；沒搶到鎖的用 **`app.quit()` 不是 `app.exit()`**；`whenReady` 也要 `if (!hasInstanceLock) return`。`close` 攔截必須放行 `isQuitting`。管理員終端機的 `--terminal-admin-host=` 要攔在搶鎖**之前**。
- **`document.hidden` 同時代表「被完全遮住」**，所以**不可以**關 `setBackgroundThrottling`（實測會讓它恆為 false）。常駐時只有計時器被節流（89ms → 19828ms），main→renderer 派送仍是 0～1ms。
- `before-quit` 要收：終端機 `killAll()`、sysmon 三顆、`llama-asr.unload()`、`dictationHud.close()`、`agy.shutdown()`（**不是 `stop()`**）、`oc.shutdown()`／風扇排在 `sensors.stop()` 之前；`workspace:flushDrafts` 要排在 `killAll()` **之前**（存不起來時要能取消結束）。

### 聊天

- **model 與訊息歷史所有權在 main**；模型必須對「目前這組供應商」驗證（只檢查「在不在任何清單裡」會拿 A 的模型打 B）。
- **`chat.send` 的 inflight 佔位必須跟守衛同一個同步區塊**（中間不得有 await）。佔位是「每個對話一格」的 Map：不同對話可以同時跑（**不設總數上限**），同一個對話仍只能一條；`finally` 只刪**自己那一格**。`chat:abort` 一定要帶 reqId（`abort()` 不帶 id ＝停掉所有對話，IPC 那層擋掉空值）。
- **renderer 的串流狀態也要照 conversationId 分開**：delta 帶 `conversationId`，背景對話照收不畫，切回來再 `attachLiveView` 補齊；`regenerate` 那條在 chats.json 裡舊回覆還在，切回來畫面時要藏掉。改寫／刪除訊息在那個對話回應中時 main 一律拒絕。
- **取樣參數只收最通用的 temperature／top_p／max_tokens／stop（外加不送上游的上下文則數），而且沒勾的完全不送**（top_k、penalty、seed 各家支援不一，有的直接 400）；每對話一份存 `chats.json` 的 `params`，`chatParams`（allowlist）只是新對話預設；`sanitize` 在 `chat-params.js`。body 要先展開參數再寫 `model`／`stream`／`messages`，不能反過來。
- **AI 自動取標題只在「第一輪回覆後、標題還是暫定那份」時跑**（`chat-title.js`，同一組供應商／模型、非串流、不 await）；寫回走 `replaceAutoTitle(id, 暫定, 新)`，產生途中使用者改了名就不蓋；第一則訊息也只在標題還是預設「新對話」時才定暫定標題（送出前改的名字不能被蓋）。e2e 的假 store 要設 `chatAutoTitle: false`，否則背景那一發會打亂假上游的請求計數。
- **重新生成在上游成功前不得 `dropTrailingAssistant`**；`chats.json` 的 read-modify-write 一律走 `withStore`。
- 圖片不進 `chats.json`（只存檔名）；只送最近 6 則且**只送 user 的圖**；生圖 SSE buffer 要 24MB。
- thinking 關閉時**完全不帶** `reasoning_effort`；串流不可用 `AbortSignal.timeout`（首 token 60s ＋閒置 120s 雙計時器）；中斷時已收到的內容仍要存檔（累加器宣告在 try 之外）。
- **側欄順序＝陣列順序**，`list()` 不依 `updatedAt` 重排；超過上限只能 `filter` 掉最舊的。
- **`chatProviders` 的 sanitize 遇到壞網址要保留該筆、只清空 `apiUrl`**（它跑在存檔路徑上，整筆丟掉＝打錯一個字就刪掉金鑰）。`chatProviders` 變動時聊天與翻譯**兩組選擇都要收斂**。本機模型是 main 合成的 `__local`，`sanitizeProviders` 必須過濾掉它。
- `markdown.js` 全程 `createElement`＋`textContent`、**零 innerHTML**；`INLINE_SRC` 每次呼叫都要 `new RegExp`（共用 g-regex 會 OOM）。

### 專案工作區

- **三份清單要對起來**：`ipc.js` 用到的每個 `service.X` 都要在 `main.js` 的逐一列舉白名單裡、每支 `workspace:*` 都要在 preload 接得到；`index.js` 的 `module.exports` 列一個沒定義的名字＝**載入期 ReferenceError**，症狀是每支 IPC 都回通用錯誤，而 `node --check` 與單元測試全綠。回歸 `test-workspace.js` 的 [Q][Q2]。（AGY／sysmon／usage 同一條）
- **檔案樹的外部拖入（`workspace:importDropped`）一律複製不搬移**：來源是使用者任意路徑
  （用 `raw-fs` 讀），目的地仍只收 `{ projectId, relPath }` 走 `resolveIn`；跨磁碟搬移會毀掉
  來源，撞名產 `name (2).ext`。上限要**先量再複製、超過整批拒絕**（50 個頂層項目／8000 檔／
  單檔 200MB／總量 1GB），邊複製邊檢查會留下一半。`dragover` 也要放行外部檔案
  ——只看內部 `dragging` 的話 Chromium 連 `drop` 都不會發。
- **AI 記錄的家目錄不只 `~/.claude`／`~/.codex`**：要掃 `CLAUDE_CONFIG_DIR`／`CODEX_HOME` 與其他工作台的 runtime home（實測本機 Codex 記錄全在 Orca 那邊），照 `agent + id` 去重。`codeusage` 的 `jsonlSources()` 相反——**維持只掃預設家目錄**（游標鍵是檔名）。
-「讀過」跟「改過」要分開回；工具名不認得時算「讀過」，**不可以憑空說人家改過**。
- **存檔一定要帶開檔當下的 mtime**（`STALE` → 提示條給比較／重新載入／覆寫／保留編輯，草稿一個字都不能動）；同一檔案的寫入要排隊（Windows 上兩個 rename 指向同一目的地會 EPERM）；草稿上限（4MB，main 與 renderer 同一個數字）比存檔上限（50MB）小，超過的草稿**整個欄位不送**並提示先存檔（送空字串會把分頁還原成空白的未存狀態）。
- **開分頁的每一次 await 之後都要核對 `projectSwitch`，回來還要再 `findTab` 一次**；改名／搬檔後要 `retargetTabs`（分頁 id 內嵌相對路徑，不接的話存檔會把舊檔重新建出來）。
- `git status` 用 `--porcelain=v2 -b -z`；欄位是**位置**決定的，改名（`2`）那型後面還跟著一格原檔名。衝突（`u`）要自成一組。`git log` 的欄位分隔用 `%x1f`，**不能跟 `-z` 混用**；`for-each-ref` **不吃 `%x1f`**。展開看檔案用的就是 `--numstat` 那幾列（上限 `MAX_LOG_FILES`），要帶 `--no-renames` 與 `-c core.quotepath=false`（改名路徑與中文檔名才點得開）。
- 跟分支比要比 `merge-base` 不是分支頂端；`--numstat` 一定要配 `--no-renames`。切到非 git 專案時 `renderGit` 的提早 return **要把工作樹、分支下拉、審閱清單三塊都清乾淨**。
- **Git 面板列上的 `+新增 −刪除` 來自 `status()` 多跑的一次 `diff --numstat -z --no-renames HEAD`**：
  未追蹤的檔案沒有數字（git 不 diff 它），**全新的 repo 還沒有 HEAD，那一跑會失敗——當成沒數字，不是錯誤**。
- **篩選框只重畫不重問 main**（`paintGitFiles` 吃 `lastGitStatus`）：每打一個字跑一次 `git status`
  在大 repo 上是好幾百毫秒的子程序，輸入會整個卡住。換專案要把 `gitFilter`／`lastGitStatus` 一起清掉。
- **`.ws-git-name` 的 `textContent` 是「檔名＋所在資料夾」兩段接起來**（面板只有 280px，整條路徑會把
  檔名擠掉）：CDP 測試要比對相對路徑請讀**整列的 `title`**，讀 `.ws-git-name` 會拿到 `app.jssrc`。
  列上的動作鈕**常駐不做 hover-only**（見「UI／CSS」：hover 才出現的操作等於沒有）。
- worktree：路徑由 main 組（repo 的兄弟資料夾）、移除拿 `worktree list` 當白名單、不准移主工作樹、不加 `--force`、移除前先 `check`。
- **資料夾監看一次只看一個專案**；`.git` 底下的變動只當成「Git 狀態變了」；事件要合併；監看不起來安靜退回手動。
- 終端機的 `projectId` 是**可選**欄位（缺值＝未分類，卡 `^[A-Za-z0-9_-]{1,64}$`）；對話的專案歸屬已拿掉，改用聊天側欄自己的資料夾（`folderId`）。`workspaces.json` 的路徑不存在只標 `missing`。
- 搜尋只收字串不收 regex，四個上限（命中 200／掃 8000 檔／單檔 1MB／15 秒）少一個都會凍住 UI；快速開檔與搜尋共用同一份 `walk`，模糊比對沒命中要回 `null` 不是 `-1`。
- **圖片／PDF／影音先看副檔名**，不可走「二進位檔」那條（PNG 含 NUL 會被判成不能編輯），而且**不讀內容、不轉 base64**：`readFile` 只回 `media` 種類，`index.js` 補上 `vi-media://<每次啟動的隨機 token>/<projectId>/<relPath>`，由 `workspace/media.js` 用 `protocol.handle` 串流（自己解 Range 回 206，影片才拖得動進度條；路徑走 `rootOf`＋`resolveIn`、只送媒體副檔名、錯的一律 404）。token 只經主視窗 IPC 發出，`<webview>` 裡的網頁猜不到。CSP 的 `img-src`／`media-src`／`connect-src` 三條都要有 `vi-media:`（pdf.js 用 fetch 讀，缺一條就是「看起來壞掉但不報錯」）；`registerSchemesAsPrivileged` 要在 app ready 之前。Electron 43 **沒有內建 PDF 檢視器**，只能用 pdf.js 畫 canvas（給網址＋`disableStream`／`disableAutoFetch`，只讀看得到的頁），且 `workerSrc` 不能給空字串。
- **純文字讀／寫上限都是 50MB**（Monaco 虛擬捲動）。大檔（>1MB）打字時 `ws-monaco.js` **停手 300ms 才 `getValue()`**（每個字複製整份＝12MB 的檔連打 40 字就是近 500MB 垃圾，停下來被 GC 卡半秒），期間 `onChange(null)` 只標未存；**`stash()` 開頭一定要先 `flushChange()`**（activeId 換掉之後才交出去會記到下一個分頁上），換 model 時丟掉晚到的那次。大檔也不倒進影子 `<textarea>`（`SHADOW_MAX_CHARS`）。回歸 `test-workspace.js` ＋ `probe-workspace-bigfile.js` 的 [F][F2][G]。
- **行首是 `(` 的那一行會跟上一行接起來**（沒有分號）：`releasePreviewMedia` 曾寫成 `el.removeAttribute('src')` 下一行 `/** @type */ (el).load()`，結果是 `el.removeAttribute('src')(el).load()`——關任何影音分頁都丟例外、之後工作區點什麼都沒反應。型別轉換先存進一個變數。
- **Monaco 只能走 AMD 的 `min/vs`**（ESM 那份有 98 個 `import './x.css'`）；`build.files` 只放行 `monaco-editor/min/**`；codicon 是 `data:` 字型、Worker 是 blob（CSP 那兩條少一條就是「看起來壞掉但不報錯」，**沒有 Worker 時 diff 算不出來**）。那份 `<textarea>` 還在（存檔／草稿／尋找取代退路讀它），但 Monaco 在時**只用防抖同步**——
  每敲一個字整份倒過去，2MB 的檔就是每個字搬 2MB；跳行要等 model 掛上（`pendingGoto`）。
- **大檔案的成本都在「每次都重做」，不是「做得慢」**：`showTab` 不可以用 `getValue()` 比對（那是把整份再複製一次，
  改用 `modelText` 這份 WeakMap）；`showDiff` 每個分頁留自己那兩顆 model（舊版每次切回來重建一對，Monaco 得重新
  斷行＋重算差異）；Monaco 接手後 `updateGutter`／`updateIdeStatus` 是白工（行號欄 hidden、狀態列被 `paintMonacoStatus`
  蓋掉），兩支各要掃完整份內容；預覽（Markdown／HTML／PDF）要比**內容字串本身**決定重不重畫，比長度會漏掉同長度的修改。
- **切專案要 `disposeModelsExcept`**：`tabs` 換掉了，但 model 是照分頁 id 存的，沒人收＝每切一次就多留一整份
  檔案內容。收之前 `persistTabsNow()` 的 `stash()` 已經把草稿拿走了，順序不可以顛倒。
- **存檔後要重讀一次現在的內容**（`monaco ? currentValue() : text.value`）：等 main 寫檔的期間使用者可能又打了字，
  直接把送出去的那份塞回 `tab.content` 會把那幾個字吃掉。回歸 `test-workspace-state.js` 的「存檔守衛」。
- 內建瀏覽器是 `<webview>`：`webviewTag` **只開在主視窗**、guest 不掛 preload、popup 在 app 層用 `web-contents-created` ＋ `setWindowOpenHandler` 收斂。網址正規化要先照原樣解析、**協定不是 http(s) 才**補 `http://`（`localhost:5173` 會被當成協定）。本機 HTML 預覽用 `srcdoc` ＋ `sandbox="allow-scripts"`，**不給 `allow-same-origin`**。
  **每個分頁一顆 webview**（共用一顆切回來整頁重載，「上一頁」會走進別的分頁的歷史）；UA 的 `display: flex` 壓得過 `[hidden]`，要自己寫 `webview[hidden] { display: none }`。工具列只有一組，背景分頁的 `did-start-loading` 不准改正在看的那一頁。關掉分頁／移除專案才 `pruneBrowserGuests`；**換專案要停放**（`projectId`＋分頁 id），切回來不重載、不用再按前往。
- **檢視變更不新開分頁**：同一個檔案（id `e:`）就地把 `kind` 換成 `diff` 並設 `diffView`。存檔時 `kind` 仍要寫 `editor`，否則下次開專案草稿接不回來。
- **檔案樹執行**：`.exe`／`.lnk` 走 `workspace:openEntry`（`resolveExisting`，只收專案內）；`.cmd`／`.ps1` 開終端機跑。`.js`／`.py` 點下去仍開編輯器。三份清單要有 `openEntry`。
- **Git 動作鈕**：側欄拖到 180px 時要 `flex-wrap`，按鈕不准 `min-width: 0`（縮了字會溢出疊在一起）。
- 分頁拖曳是 pointer 跟手＋FLIP（不是 HTML5 DnD），transform 只吃 X、讓位距離用量出來的 gap、要加 `scrollLeft` 變化量；檔案樹的拖曳**刻意**用 HTML5 DnD（兩邊取捨不同，不要統一）。切分頁的 click 掛在 `.ws-tab-open` 不是 `.ws-tab`。
- 檔案樹展開／收合只動自己那一列後面的子樹（整棵重畫會把捲動位置跳回最上面）。
- 新增／改名的名字要在 `checkName` 就擋（斜線、冒號、Windows 保留檔名）；刪除要擋專案根目錄；搬檔要擋「搬進自己底下」與同名覆蓋。
- `netstat -ano` 的 `LISTENING` 沒有被在地化可以直接比對；**刻意不用 `Get-NetTCPConnection`**（要載模組）。

### 檔案總管

- **跟工作區檔案樹是兩件事**：聊天頁右側仍是 `{ projectId, relPath }` + `workspace/files.js` 的 `resolveIn`。整機那頁走 `explorer/paths.js` 的 `resolveAbs`，放行 `^[A-Za-z]:\` 與嚴格 UNC（`\\伺服器\分享`，主機名／IPv4），不收 `\\.\`／`\\?\`／named pipe／ADS。資源回收筒是虛擬位置 `recyclebin`（不是 UNC）。側欄位置存 `explorer.json` 的 `places`（可隱藏內建、加自訂／NAS）；`net use` 對應磁碟代號時不帶密碼、不透傳 stderr。
- **整機搜尋不准自己 walk C:\\**：檔名搜尋只代跑本機 `uffs`（NTFS MFT）。pattern 拒 `>` regex 與以 `-` 開頭的參數。進檔案頁自動下載並跳一次 UAC 裝 Access Broker、拉起 daemon；開機不跳 UAC。使用者按否就寫 `uffsAuto: false`，只留「啟用快速搜尋」。
- **`uffs.exe` 不打進 asar**；只跑 `<userData>/uffs/`，不認 PATH／`%LOCALAPPDATA%\uffs`。zip checksum 缺或對不上就失敗。關 App **不停** UFFS daemon。刪／改名／搬移擋磁碟根目錄、`%SystemRoot%` 本身、使用者家目錄本身（`assertMutable`）；家目錄根層可以新增／貼上／還原子項（`assertCreatable` 只擋磁碟根與 Windows 目錄）。`resolveExisting` 回使用者路徑，刪 junction 不跟目標。清空回收筒不吃 list 的 2000 上限。預設刪除丟進系統資源回收筒（寫 `$I`／`$R`，Electron 裡走 `shell.trashItem`）；`{ permanent: true }` 才 `rm`。複製／搬移撞名產出 `name (2).ext`，不覆寫。CDP 暫存 userData 與沙箱的 `uffsAuto` 關掉，且忽略 `uffsEnsure({ force })`，避免自動化卡在 UAC。
- 三份清單：`explorer/index.js` exports、`main.js` 的 `registerExplorerIpc` service、`preload.js` 的 `electronAPI.explorer`。回歸 `test-explorer.js` 的 [Q][Q2]。
- **右鍵「加入工作區專案」不另開 IPC**：沿用工作區的 `workspace:addDropped`（preload 的 `addFolders` 只把字串路徑送過去），main 端仍走 `store.create` 的全套驗證——路徑要存在、必須是資料夾、撞路徑回原本那筆。虛擬位置（本機首頁、資源回收筒）在 renderer 就擋掉。回歸 `test-explorer.js` 的 [S2] ＋ `e2e-explorer-cdp.js` 的 [C2]。
- **列目錄要「先排序再截斷」，不是先截斷再排序**：`listDir` 舊版是
  `dirents.slice(0, MAX_ENTRIES)` 之後才 `sortEntries`，所以在 node_modules／Downloads
  那種大資料夾裡按大小或時間排，拿到的是「readdir 前 2000 筆裡最大的」，而不是真正最大的
  ——畫面看不出異狀，只在狀態列寫一句「（已截斷）」。排序需要每筆的 size／mtime，所以
  **會對整個資料夾 stat**（`MAX_STAT = 10000`、64 並發；實測 10000 筆約 0.8s，20000 會超過
  1.5s，所以超過上限就退回舊行為並標 `truncated`）。也不要為「按名稱排」省掉 stat：
  symlink 的 `dirent.isDirectory()` 跟 stat 後的 `dir` 不一致，排出來的順序會跟另外兩種模式對不上。
- **「點開頭」在 Windows 不是隱藏的意思**：`isHiddenName` 只認寫死的系統名單
  （`$RECYCLE.BIN`／`System Volume Information`／`desktop.ini`／`NTUSER.DAT*`…）加上版本控制
  那個資料夾（它建立時自己設了 hidden 屬性）。**不可以順手加回 `name.startsWith('.')`**：
  `.gitignore`／`.env`／`.vscode`／`.eslintrc` 在 Windows 上沒有 hidden 屬性、檔案總管照顯示，
  而這個 App 的使用者天天要看它們，藏掉等於把專案資料夾挖空。回歸 `test-explorer.js` 的 [S6]。
  本機優先問 sidecar `attrs` 的真實 hidden／system（前 2000 筆、200ms 等候上限），
  缺資料／逾時／UNC 才退回上述啟發式；不可把 fallback 當成真正屬性。
- **框選期間不可以 `paintList()`**：框本身是 `#exList` 的子元素，重畫會把它一起清掉；
  而且每動一像素重建整份 DOM 太貴。框選中只就地 `classList.toggle('is-selected')`，
  放開才重畫一次。`.ex-list` 要有 `position: relative`，不然框的座標會飄到整頁去。
- **方向鍵的游標（`cursor`）跟 Shift 連選的錨點（`anchor`）是兩個變數**：混用的話
  Shift+↓ 會每走一步就把錨點帶著跑，連選永遠只有兩列。方格檢視一列幾格要照實際版面量
  （`offsetTop` 相同的算同一列），寫死欄數在視窗一縮就錯。
- **方格檢視要另外把 `.ex-row-name` 轉成直排**：它在清單檢視是「圖示 ＋ 檔名」的橫向 flex，
  只把外層 `.ex-row` 改成 column 沒有用——圖示會留在左邊、檔名被擠成一欄寬，畫面上是
  **一個字一行的直書**（實測災情）。檔名限兩行（`-webkit-line-clamp`）並把完整檔名放 `title`。
- **Ctrl+滾輪縮放要 `addEventListener('wheel', fn, { passive: false })`**：預設的 wheel 監聽是
  被動的，`preventDefault()` 會被忽略，結果變成 Chromium 把整頁（連側欄、工具列）一起縮放。
  圖示大小同時寫 `--ex-tile`（版面）與 `data-tile`（縮圖尺寸），**縮圖快取鍵要帶尺寸**，
  不然放大後還是拿到 96px 那張拉糊的圖。級距在 `explorer-zoom.js` 的純函式，
  main 的 `store.sanitizeTile` 認同一份數字，回歸 `test-explorer-zoom.js` 會比對兩邊。
- **大圖預覽不要走 `inspect` 的 `data:` URI**（卡 2MB，整個檔案 base64 過一次 IPC）：
  走 `vi-media://` 的 `~local` 路線（`explorer:mediaUrl`）邊讀邊送。路徑兩端都要驗
  （`explorer/paths.resolveExisting` ＋ 協定端再驗一次），協定的 host 仍是隨機 token。
- **Ctrl+Z 復原「複製」要丟資源回收筒，不是永久刪**：復原本身也要能反悔。復原只記
  「怎麼倒回去」不記快照（檔案太大，快照不起），搬移是逐筆搬回**原本各自的父目錄**
  （一次拖多筆可能來自不同資料夾）。刪除不進這個堆疊——本來就能去資源回收筒撈。
- **拖到別的程式只有 `webContents.startDrag` 做得到，而且跟 HTML5 的 DnD 不能並存**：
  `dataTransfer` 裡放什麼，出了視窗都不算數（瀏覽器的上傳框要的是 OS 的 CF_HDROP）。
  dragstart 要 `preventDefault()` 把場子讓給 main 的 `explorer:startDrag`，兩邊一起來
  Windows 只認先啟動的那個。代價是**自家視窗內的拖放也變成 OS 拖放**——drop 端再也讀不到
  自訂 MIME，一律 `dataTransfer.files` ＋ `getPathForFile`（Electron 32+ 沒有 `File.path`）。
  另外三件事各自會讓它安靜失效：`dragover` 把 `dropEffect` 設成來源沒允許的值，Chromium 當成
  none，**`drop` 整個不發生**（一律走 `setDropEffect`，不允許就退回 copy）；`startDrag` 的
  `icon` 是空的會**直接丟例外**（拿不到圖示要有保底圖）；`startDrag` 底下是 OS 的 DoDragDrop，
  **會一路阻塞到使用者放手——CDP 測試絕對不可以呼叫它**（要驗交出去的內容就注入假的 sender）。
  回歸 `e2e-explorer-drag.js` ＋ `test-explorer.js` 的 [S3] ＋ `e2e-explorer-cdp.js` 的 [C3][C4]。
- **縮圖跟圖示是兩支 API**：`SHGetFileInfo`（`iconOf`）回的是**類型圖示**，一資料夾照片會長得
  一模一樣；縮圖要 `IShellItemImageFactory::GetImage`（`thumbOf`）。
  fallback 用 `RESIZETOFIT | BIGGERSIZEOK`；只有探快取才用 `THUMBNAILONLY | INCACHEONLY`。
  尚未拿到真縮圖就帶 `pending`，renderer 最多重試三次且不快取暫時圖。
  尺寸要夾上下限：一張 96px 的 BGRA 就 36KB、256px 是 256KB，列一百個檔 IPC 會肥掉。
  `HBITMAP` 用完一定要 `DeleteObject`（這支會被連叫上百次）。測試**一定要斷言「縮圖跟類型圖示
  不是同一張 base64」**，否則「其實還是回圖示」也會全綠。回歸 `probe-explorer-shell.js` 的 [D]。
  另外 `resources/shell/` 不進版控：**改完 sidecar 要記得 `npm run build:shell` 再打包**，
  否則 App 拿到的還是舊的 exe，症狀是「程式碼都對、就是沒有縮圖」而且一聲不吭。
- **右鍵的 7-Zip／WinRAR／「傳送到」不能從登錄檔靜態列舉**（只有 CLSID）：要 `IContextMenu` sidecar（`native/explorer-shell`，`npm run build:shell`）。pidl 陣列一定要 `LPArray`（預設 SAFEARRAY ＝ GetUIObjectOf AV）；路徑只吃反斜線。子選單要 `CMF_SYNCCASCADEMENU` ＋ `WM_INITMENUPOPUP`，而且 **IContextMenu3 不做事時要退回 IContextMenu2**（「傳送到」只實作 v2，7-Zip 實作 v3）。Google Drive 綠勾走 `SHGFI_ICON | SHGFI_ADDOVERLAYS` 拿已經疊好的圖，**不要** `IImageList::GetOverlayImage`（每個槽位都回同一張）。沒建 sidecar 就少那些項、資料夾維持 emoji。回歸 `test-explorer-shell.js` ＋ `probe-explorer-shell.js`。

- **虛擬清單要「捲到已載入的那幾頁也重畫」**：`loadVisiblePages()` 原本在需要的頁都已在手上時直接 return，2,600 筆的資料夾往下捲，DOM 永遠停在最前面 29 列，後面整片空白——`scrollHeight` 是對的，所以看起來像「捲得動但沒東西」。回歸 `test-explorer-browse-wiring.js` ＋ `e2e-explorer-files-plan-cdp.js` 的 [3]。
- **`paintList()` 要在 `replaceChildren()` 之前記 `scrollTop`**：清掉子節點會把捲動位置歸零，之後再讀永遠是 0，虛擬清單每次重畫都彈回頂端。相對地 `loadDir` 結尾要**無條件**把 `scrollTop` 設回分頁記的值（新資料夾就是 0），否則會沿用上一個資料夾的位置。
- **`switchTab` 呼叫 `loadDir` 要帶 `keepSelection: true`**：它先用 `applyTabState` 還原選取，`loadDir` 沒帶旗標就立刻清掉，切回分頁選取永遠是空的。而且分頁載入時手上只有已載到的那幾頁，**沒載完（`truncated`）就不准拿「不在清單裡」當理由裁掉選取**。
- **雙欄沒開過就不要存右欄狀態**：`saveSecondPaneState()` 會被 `switchTab`／`loadDir` 一路呼叫，雙欄還沒開時把預設的「本機」寫進 `paneStates`，下次按「雙欄」就還原成一個空的本機，而不是目前這個資料夾。開頭補 `if (!dualPane) return`。
### 終端機

- **忙碌判定不能只靠 OSC 133**（PSReadLine 會重送整份提示字元）：標記要帶 `Get-History` 的 id 且**比大小**，第一個看到的標記只是「現在這個提示字元」；也不能只靠靜默（AI CLI 是常駐 REPL）。兩者都要。
- **狀態變動只能就地改那一列，不可 `renderList()` 重建**（待確認的刪除鈕與改名輸入框掛在 DOM 上 → 跑著的終端機刪不掉）。
- 注入 PowerShell 的 `-Command` 字串不可含雙引號（用單引號＋`+` 相接，`$ok = $?` 必須第一句）。
- shell 與啟動指令只收 key（固定表），cwd 走系統對話框再 `statSync().isDirectory()`。
- **管理員終端機**：ConPTY 開不出提權 shell，改用 `Start-Process -Verb RunAs` 再開一份自己代開。host 的 socket 一 close 就 kill 掉所有管理員 shell；一顆 host 服務全部階段（UAC 只跳一次）；host 模式要 `app.setPath('userData', ...temp...)`（提權程序寫進主 userData 會讓檔案擁有者變管理員）。
- `term.open()` 前要先讓那一格可見（`display:none` 會開出 0×0）；「人在不在看」要看 `#termMain` 不是 `termHost`。
- **輸入法的候選字視窗跟著那個隱形 `<textarea>` 走**：xterm 平常把它丟在 `left: -9999em`，只有 `onCursorMove` 才挪回來，
  所以剛開分頁／剛切回來時系統看到的輸入框在畫面外，候選字視窗會被夾到螢幕角落。對位整段在 `term-ime.js`
  （`bindImeCaret`／`syncImeCaret`），`fitPane` 也要各對一次。
  `.composition-view` 預設是寫死的黑底白字，要改成終端機的反白。
- **組字期間候選字視窗會被 CLI 的重畫拉走**——「打注音時候選字視窗一直閃」的根因，而且**只有
  Claude Code／Codex 那類整塊重畫的 CLI 才會**。組字中不是我們在對位，是 xterm 自己的
  `updateCompositionElements()`，它讀**當下的 `buffer.x/y`**；Ink 每一幀把游標拉到上面幾行再走回輸入行，
  按鍵落在哪個瞬間就被擺到哪（實測 12 個組字鍵落在 3 個位置）。**DOM 與 WebGL 量到一模一樣，不要往
  renderer 找**。`term-ime.js` 的釘法：錨點等游標**安靜 40ms** 才取（取 `compositionstart`
  當下或下一個 rAF 都還會抓到重畫中途的位置，實測是 `0,0` 與 `0px,60px`）；組字開始時把錨點寫進
  `--ime-left／--ime-top` 並加 `.ime-composing`，由 `main.css` 用 `!important` 壓過 xterm 寫的 inline 座標，
  組字中 `syncImeCaret` 與游標移動都不准改錨點。**不要改回「每一幀用 JS 擺回去」**：兩幀之間仍會被拉走
  （舊打包版 40 次取樣移位 20 次、最大 159px），而且只補在 `compositionupdate` 後面贏不了 xterm。
  **寬高不准動**（那是 xterm 撐組字文字用的）；關分頁要呼叫 `bindImeCaret` 回傳的 dispose。
  回歸 `probe-terminal-ime.js` 的 [E]（連續重畫＋組字，量實際位置）與 `probe-terminal-flicker.js`。
- **對好位置還不夠，那個 `<textarea>` 還必須真的被畫出來**：xterm 給它 `opacity: 0`，
  而 `opacity: 0` 的東西 Chromium 不畫，Windows 就問不到「游標的方框在哪」，注音的組字與
  候選字視窗會退回預設位置（視窗右下角）。要改用**透明的文字／游標／底色**藏
  （`color`／`caret-color`／`background-color` 都要 transparent，缺 `background-color`
  會露出白方塊）。回歸 `probe-terminal-ime.js`。
- **`.term-host` 的 `overflow` 必須是 `clip` 不是 `hidden`**：`hidden` 是「可以捲、只是沒有
  捲軸」的捲動容器。組字時 xterm 會把那個隱形 `<textarea>` 撐到整段組字文字的寬度（實測
  988px），一超過終端機右緣，Chromium 就自己捲它把游標帶進視野（實測 `scrollLeft` 177.7px）
  ——使用者看到的是整個終端機畫面往左滑掉，候選字視窗也跟著被推到視窗右下角。`clip` 完全
  不能捲，而且不會把溢出往上傳給祖先。回歸 `probe-terminal-ime.js` 的 [D]。
- **排隊的輸出要接成一段再寫**：AI CLI 串流一秒上百個小封包，逐段 `await term.write()` ＝每段排一次 timer；
  合併時 `seq <= 目前` 的片段仍然要丟掉（快照重疊）。`fitCurrent` 欄列數沒變就不要往 main 送 resize，
  ResizeObserver 也要合併到下一幀。
- **PTY 不在 App 裡**：`terminal/host.js` 是獨立宿主，執行環境（Electron exe ＋ node-pty ＋ 七支 host 檔）整套複製到 `<userData>/terminal-host/runtime-<內容雜湊>/`——安裝目錄的檔案被更新覆寫時，跑著的 shell 才不會被拖下水。`before-quit` 只 `disconnect()`，**不可以改回 `killAll()`**。
- **宿主活得比 App 久＝終端機那一側的修正裝了也沒生效**：更新只換安裝目錄，跑著的宿主
  還是舊的執行環境，`pty.js`／`status.js`／`store.js` 的改動要等它重開才算數。實測使用者
  的宿主從 Ctrl+G 橋接還沒存在的那一版一路活著，連發三版都「裝了跟沒裝一樣」，而且
  **App 這端完全看不出異狀**（連得上、功能都在，只是行為是舊的）。所以 auth 回覆要帶
  `runtime`（自己那份執行環境的資料夾名），App 拿 `runtimeName()` 算出來的比一次；
  **舊宿主沒有這個欄位，缺欄位就是舊版**。重開一律用 auth 回報的 pid 直接收（舊宿主不
  認得新的 op），沒有跑著的 shell 就自動重開，有的話問過使用者再收。
  回歸 `test-terminal.js` 的 [宿主版本] ＋ `probe-terminal-host-version.js`（問真的活著的那個）。
- **一份執行環境 248MB**：`stageRuntime` 每次改版就多一份，舊的要清掉（能用 `r+` 開啟該份 exe ＝沒人在跑）；建到一半失敗要把 staging 整個刪掉。
- **系統工具一律指名 `%SystemRoot%\System32`**：PATH 上常擺著 Git Bash 的 MSYS `whoami.exe`／`icacls.exe`，裸名會抓錯那支（libuv 的搜尋順序只看 PATH，不含 System32），症狀是「PowerShell 跑得過、Git Bash 跑不過」。
- 已結束的終端機**保留畫面**（`finished` map），狀態是 `exited` 不是 `stopped`；`stopped` ＝這次還沒開過。明確刪除（`forget`）才真的收掉，宿主也才會閒置自關。
- **切回一格終端機一定要重新對欄列數**：`openSession` 走 `fitAndSync` 不是 `fitPane`
  ——那一格被藏起來的期間側欄或視窗可能被拉過，量到的新尺寸沒送給 ConPTY 的話，
  整畫面重畫的 CLI（Claude Code／Codex）會照舊寬度再貼一次：**狀態列出現兩份、
  右邊被切掉半行**。回歸 `test-terminal-ui.js`。
- **Ctrl+G 的編輯分頁是「儲存」與「關閉」兩件事**：`save()` 只寫 `.out`（分頁留著，可以再改
  再存，最後一次存的那份才算數），`cancel()`（＝關掉分頁）才寫 `.done` 放走 batch，而 batch
  只在 `.out` 存在時才蓋回原檔——所以「改完存檔再關」與「什麼都沒動就關」自然分開，不用另外
  記狀態。**存檔不可以順手收掉分頁**（舊版 `submit()` 是存＋放走＋關分頁，使用者要的是像一般
  編輯器那樣存完還能繼續改）。回歸 `probe-terminal-editor.js` 的 [C][C2][D]。
- **放走過的請求要進忽略名單**：`.done` 一落地就叫醒 `fs.watch`，而那支 batch 每秒才看一次
  ——掃描當下 `<id>.in` 還躺在磁碟上，而該 id 已經從 `pending` 移除，於是被當成**新請求**
  再發一次，使用者關掉的分頁**當場自己跳回來**（實測關掉後又多收到 1 次 editRequest）。
  回歸 `probe-terminal-editor.js` 的 [G]。
- **Ctrl+G 的 `$EDITOR` 橋接（`editor-bridge.js`）三個坑**：那支 batch **只能是 ASCII**
  （cmd.exe 用 cp950 讀 UTF-8 的中文註解會把行切壞，錯誤是莫名其妙的
  `'idge' is not recognized`）；**路徑不可以用 `echo %~f1` 送出來**（同樣的 cp950 問題，
  使用者名稱有中文就指到不存在的檔案），改成 batch 自己 `copy` 檔案進出；**「上一輪
  留下來的請求」不可以用檔案時間判斷**（`copy` 會把來源的 mtime 一起帶過去，看起來
  永遠很舊），改成啟動時掃一次當下就存在的那些。回歸 `probe-terminal-editor.js`。
- **接不接手只在 main 決定一次**（`service.js` 的 `bridgeTakesOver`），宿主拿到空字串就完全
  不動環境變數。判斷要看 `VISUAL` 再看 `EDITOR`（Claude Code 與 Codex 都是這個順序），
  而且 **`EDITOR=notepad` 不算「使用者挑過編輯器」**——那正是 CLI 沒設時的預設值
  （`start /wait notepad`），實測使用者環境變數裡躺著這一條，Ctrl+G 就永遠彈記事本，
  照著程式碼查會以為橋接壞了。接手時 `EDITOR`／`VISUAL` **兩個都要蓋**（只蓋 EDITOR 會被
  VISUAL 壓過去），值必須是短檔名 `voiceink-edit.cmd`（AGY 用 `split(' ')` 再 spawn，
  完整路徑一加引號就切壞），並把 `editor-bridge` 資料夾接到 PATH 最前面。
  設了 vim 那類真編輯器才放行，這時 `raiseChildWindow` 才需要出手抬窗。
  回歸 `probe-terminal-editor.js` 的 [F][H]。
- **終端機連結**：`provideLinks` 收到的是**整份緩衝區的 1-based 列號**（不是畫面上第幾列），回去的 range 也是同一套；折行的一列要先往回接成整條邏輯行再掃，CLI 自己印的換行（沒 `isWrapped`）若前一列以斜線結尾或剛好滿列也要接。range 的 x 是 **cell 欄位**不是字元位移——CJK／emoji 一格佔兩欄，用 `offset % cols` 會把底線畫到前後無關的字上；有 `getCell` 就逐格對。掃描不要把前後黏著的中文、括號、等號吃進候選。路徑候選一律先問 main 存不存在再畫底線（不驗＝畫面上每個含斜線的字都變假連結），相對路徑以**即時 cwd（OSC 7，沒有就退回開檔目錄）** 為基準。點網址開內建瀏覽器；點路徑用 App 開（專案內編輯器／檔案樹，否則檔案頁），不要 `shell.showItemInFolder`。
- **xterm 自己不碰剪貼簿，Ctrl+V 要我們自己接**：不接的話那顆鍵只會變成 `^V`（`\x16`）送進
  PTY，Claude Code 那類 CLI 不認，畫面上**什麼都不會發生**；語音輸入走的正是「寫剪貼簿 ＋
  模擬 Ctrl+V」，所以症狀是「文字在別的 App 都貼得進去，只有這個終端機貼不進來」。接在
  `attachCustomKeyEventHandler`，而**剪貼簿一定要跟 main 要**（`terminal:clipboardText`）
  ——renderer 的 `navigator.clipboard.readText()` 要視窗有焦點，沒焦點（背景視窗、剛從別的
  程式切回來、模擬按鍵）直接 reject，症狀跟沒接一模一樣而且一聲不吭（實測修好按鍵綁定後
  打包版仍然只送出 `\x16`）。右鍵貼上走同一支 `pasteFromClipboard`。回歸 `e2e-terminal-cdp.js`。
- **剪貼簿裡是截圖就自己落檔、貼路徑，不要只丟 `^V` 指望 CLI 自己去翻剪貼簿**：那條路在
  ConPTY 裡多半一聲不吭（使用者的話是「Ctrl+V／Alt+V 都貼不了圖」）。main 的
  `terminal/clipboard-image.js` 把 `clipboard.readImage()` 存成 `<userData>/clipboard-images/clip-*.png`，
  renderer 貼**加好引號的路徑**（跟拖放檔案同一套規則），Claude Code／Codex／Gemini CLI
  看到圖片路徑都會自己讀進去。`^V` 只留成最後的退路。**Alt+V 也要接**（Claude Code 的說明
  把它列成「貼上圖片」，不接就只送出 `ESC v`）。舊圖一天或 40 張以上掃掉，免得無限長。
  回歸 `e2e-terminal-cdp.js` ＋ `test-explorer-zoom.js` 的 [D]。
- **在 Windows 上改 PATH 要改「本來那個鍵」**：`{ ...process.env }` 展開出來的是系統寫的原字
  （實測是 `Path`），直接寫 `env.PATH = …` 等於**另外開一個空的 `PATH`**——`env.PATH` 讀出來是
  `undefined`，原本那份一個字都沒動，子程序拿到兩個同名變數而生效的是先進環境區塊的那個。
  Ctrl+G 的 `editor-bridge` 就是這樣整整幾版都沒接上 PATH，症狀是 AGY 回
  `editor "voiceink-edit.cmd" not found in PATH`，而測試因為讀的是同一個假鍵所以全綠。
  斷言要寫成「不分大小寫只有一個 path 鍵，而且原本的 PATH 還在後面」。
  回歸 `probe-terminal-editor.js` 的 [F][H]。
- **Shift+Enter 送的是 `\x1b\r` 不是 CSI u**：`\x1b[13;2u` 要終端機與 CLI 先協商 kitty keyboard
  protocol，xterm.js 不宣告支援、CLI 也就不會啟用，那串序列會被當成一般字元——使用者看到的是
  輸入框裡直接冒出 `[13;2u`。`ESC`＋`CR` 是 Claude Code `/terminal-setup` 綁的同一個東西。
- **Ctrl+G 的抬窗快照要記「視窗代碼＋標題」，不是只記有哪些 pid**：Windows 11 的記事本第二次開
  檔案會**沿用同一個程序與同一個視窗**（只多一個分頁，實測 pid 5380／HWND 394578 兩次完全相同），
  只比對 pid 的話記事本開過一次之後就再也抬不到——症狀是「昨天還會跳，今天又不跳了」。
  標題比對只放行 `REUSE_WINDOW` 那幾支會重用視窗的編輯器（瀏覽器切分頁也一直在改標題）。
  抬完還要 `SetWindowPos(HWND_TOPMOST)` 才留得住（只 SetForegroundWindow 的話點一下 VoiceInk 就被蓋掉）。
  回歸 `probe-terminal-foreground.js`；全螢幕獨佔的遊戲在前景時搶不到前景是 Windows 的規則，**斷言只看
  記事本那個視窗的 `WS_EX_TOPMOST`**，看前景是誰會拿到假紅。
- **終端機桌布**：圖片本體存 `<userData>/terminal-bg/`，store 只存**檔名**（`termBgImage`，
  `^bg-\d+\.[a-z]{3,4}$` 擋路徑穿越），renderer 只拿得到 `data:` URI，換圖一律走系統對話框。
  **只有真的有桌布時才把 xterm 底色改成 `#00000000` ＋ `allowTransparency`**（沒圖時維持不透明，
  否則捲動殘影會疊在一起）；壓暗的 `opacity` 只作用在 `.term-host::before` 那一層，文字那層一個字都沒動。
- **桌布不可以用 `data:` URI 塞進 CSS**：Chromium 的 CSS 值大約 **2M 字元**就滿了，
  `setProperty` 超過就**靜靜不做事**（不丟例外，computed style 直接 `none`）。
  3.2MB 的圖 base64 之後 4.3M 字元，桌布整張消失，而且**滑桿拉到哪都一樣**
  ——壓暗那一層是好的，只是沒有圖可壓。renderer 收到 `data:` 之後要轉成 `blob:`
  短網址（`toBlobUrl`，換圖記得 `revokeObjectURL`）。回歸的測試圖**一定要用真實尺寸**：
  原本 `probe-terminal-background.js` 用 8×8（base64 才 130 字元）全綠了好幾版卻完全沒
  碰到那條線，現在用 `inflateToSize` 撐到 2.5MB，而且要把 URL 丟給 `Image` 真的解一次
  （computed style 讀得到 `url(...)` 只代表宣告還在）。
- **背景圖強度不可以到 0**：`opacity: 0` ＝圖還在卻整張沒畫，
  使用者看到的就是「選了圖卻什麼都沒有」（實測：滑桿叫「濃度」又說「只壓背景圖」，
  使用者往 0 拉以為那是「不壓暗」）。滑桿 `min="10"`，`normalizeAppearance` 與 main 的
  `sanitizeBgOpacity` 把低於下限的（含舊設定裡的 0）當成「沒設定過」回預設 45；
  「不要圖」走「移除背景圖」。回歸 `test-terminal-ui.js`。
- **桌布還會被 `xterm.css` 寫死的 `.xterm-viewport { background-color: #000 }` 整片蓋掉**：
  xterm 6 把底色改畫在後面那層 `.xterm-scrollable-element` 上（配色表套的就是那一層），
  `.xterm-viewport` 就變成一塊**永遠不會跟著配色更新的黑布**，剛好夾在桌布（`.term-host::before`）
  與文字之間——選了背景圖只看得到全黑（實測純紅桌布、濃度 100%，畫面 100% 是 #121212）。
  `main.css` 要把它設成 `background-color: transparent`。**只讀 `term.options.theme` 是恆真的斷言**
  （那是自己剛塞進去的值），要量「那個點上疊了哪幾層、各自什麼底色」；截圖在 `--hidden` 的視窗上
  會卡住不回，不要拿它當回歸。回歸 `probe-terminal-background.js` 的 [G]。
- **游標畫在 canvas 上（WebGL renderer）**：DOM renderer 把游標畫成
  `<span class="xterm-cursor-blink">`，閃爍是 CSS `animation: 1s step-end infinite`——串流時
  那一列每一幀都被重建，動畫就每一幀從 0%（實心）重來，游標永遠跑不完一個週期，看起來是
  在亂閃（實測 2.4 秒 29 幀＝重建 30 次；WebGL 是 0 次）。`onContextLoss` **一定要接並
  `dispose()` 再重掛（最多 3 次）**（驅動更新／GPU 重置會掉 context，不收就是整片空白）；拿不到 GPU 時要能安靜
  退回 DOM renderer。欄列數真的變了才 `clearTextureAtlas`。**候選字視窗的抖動不在輸入法對位**：同一段時間 88 次游標移動只換來
  1 次 textarea 位置變動——別再去改 `syncImeCaret`。回歸 `probe-terminal-flicker.js`
  （**會叫到最前面**，而且是刻意的：沒焦點的終端機根本不畫游標，量到的會是假的 0）。
- **Unicode 11 要 `loadAddon` 之後再 `term.unicode.activeVersion = '11'`**，只 load 不切不生效。
- **分割顯示不搬 DOM**（搬 xterm 的節點＝逼它整份重新量尺寸），順序用 CSS `order`；
  `createPane` 裡**不可以**改成呼叫 `paintPanes()`——新的那一格還沒登記進 `panes`，會被它
  過濾掉，於是 `term.open()` 開在 `display: none` 上，變成 0×0。並排時**每一格都要各自
  `fit`**（只 fit 作用中那個的話，旁邊那格的 ConPTY 還以為自己有整個寬度，換行全亂）。
- **「安靜＝做完了」只適用人在裡面來回打字的前景程式**：拿得到 shell integration 標記、
  而且送出指令後沒再打過字時，安靜多久都維持「運行中」（安靜的 build 不再誤報收工）；
  在裡面又送出一行才算 `interactive`，那時才恢復靜默判定。**沒有標記的（`cmd.exe`）不可以
  套這條**——沒人來解會永遠卡在「運行中」。
- **標題與 cwd 走 `osTitle`／`liveCwd`，不可以叫 `title`／`cwd`**：`service.listSessions` 是
  `{ ...store 那筆, ...宿主那筆 }` 展開，同名欄位會把使用者取的名字與開檔當下的目錄無聲蓋掉。
  使用者改過名字（store 的 `renamed`）就不准被 OSC 0/2 蓋。OSC 7 只收磁碟機開頭的絕對路徑。
- **scrollback 不要每個 chunk 都 `slice(-上限)`**：那是每個小封包都複製一份 256KB 字串
  （實測 2 萬個 chunk 1912ms vs 3.4ms）。留到超過兩倍才砍，而且**從最近的換行砍**——
  從字串中間切會切在跳脫序列裡，回放的第一行就冒出半截 `[38;5;12m`。
- `.chat-list-item` 三邊共用，選擇器一定要限定 `#chatList`／`#projList`。側欄寬度走 `--chat-sidebar-w`（`main.css` 有三處要各留 `var()`）。

### HF模型與本地 LLM

- 推論一律走 llama-server 的 **router 模式**（`--models-dir`），不要自己寫多模型管理器；模型 id ＝檔名去 `.gguf`／資料夾名；`--models-preset` 的 INI 只在啟動時讀（改完要重啟）。
- **關思考要明寫 `reasoning = off`**：llama-server 的 `--reasoning` 預設是 **auto**，不送就等於沒關（模型卡寫「關」，實際照樣思考）。`thinkingCapable` 的模型一律寫 `on`／`off` 其中之一。
- **儀表板的速度／排隊來自 `/metrics`，那支端點預設是關的**：router 要帶 `--metrics`（它會把這面旗子傳給自己開的子程序），而且 router 模式的 `/metrics` **照模型分**——不帶 `?model=<id>` 直接 400。時間欄位實測叫 `tokens_predicted_seconds_total`（不是 `predicted_seconds_total`；自己編一個名字會全綠卻永遠算出 0 tok/s）。回歸 `test-hfmodels.js` 的 [D5] ＋ `e2e-hfmodels.js`（真的量到 tok/s）。
- 布林旗標寫進 preset INI 用 `key = 1` 就好（實測 router 會轉成 `--no-mmproj-auto`，不會多送一個 `1`）。
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
- **焦點在自己視窗時不准走剪貼簿**：`insert.js` 的 `insertIntoOwnWindow` 用
  `executeJavaScript` 叫 renderer 的 `__viInsertText`（終端機 `term.paste`／一般輸入框
  `execCommand('insertText')`，保住 undo 與 input 事件），一個位元組都不寫剪貼簿。走剪貼簿
  會在 Windows 剪貼簿歷史（Win+V）裡插進兩筆（我們的文字一筆、還原舊值又一筆），使用者
  原本複製的東西被擠到後面——他會說「剪貼簿順序被打亂」。拿不到 focused window（人在別的
  程式裡）或 renderer 回 false 才退回剪貼簿 ＋ 模擬 Ctrl+V。回歸 `e2e-dictation.js` 的 [K0]，
  那段**一律要注入假的 uiohook**，漏掉就會真的把測試字串貼進使用者正在用的程式。
- **右 Alt 只能用低階鍵盤 hook 認**；原生 sidecar 三個坑：委派要用欄位抓著、`GetMessage` 迴圈不能省、靠 stdin EOF 結束。Esc 不吞。退路模式要補送 F24（一次按放只補一次）。keydown 會重送，狀態機要 `pressed` 旗標。
- 麥克風在啟用時就一直開著（track `ended` 要自己重建）；單次上限 20 分鐘，**長錄音一定要切段**（用 `slice` 不用 `subarray`）。
- **整理後的換行要留著**：整理器要排版（條列每項一行、換主題空一行分段），輸出直接貼進輸入框，
  全部擠成一行就只是逐字稿。本地逐段整理接回去時用**空行**接（`parts.join('\n\n')`），
  **不可以用 `joinSegments`**——那支是給 ASR 逐段辨識用的（直接黏起來），會把排好的版整平。
  錯字規則要明講「用上下文判斷」並附錯字範例，寫成「只有非常確定才改」時小模型會把錯字原樣抄出來。
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
- **nvidia-smi 的看門狗要從 spawn 那一刻就武裝**：只在「收到第一行讀數」之後才設的話，卡在啟動（一行都沒吐）就永遠等不到重開；子程序 `close`／`error` 時要把它收掉，不然重啟計時與看門狗會疊在一起。回歸 `test-sysmon-gpu-lifecycle.js`。
- **NVMe 的 S.M.A.R.T. 不必提權**，但開實體磁碟時 `dwDesiredAccess` **一定要給 0**；`Data Units Read/Written` 的單位是 1000 × 512 bytes；`0 K` 是「感測器不存在」。
- `probe.ps1` 要有 UTF-8 BOM ＋ `AutoFlush`；**probe 裡不可以相信 `$env:*`**（被 spawn 的子程序沒有）；static 框裡不准查 `Win32_Tpm`（未提權卡 5.2 秒）；網路卡走 `Win32_NetworkAdapter` 不用 `Get-NetAdapter`。
- **資料列一律往後加欄位、解析端逐格取值**（不要插在中間）；SMBIOS 佔位字串統一在 `metrics.clean()` 清掉；groups 的 rows 值不能給空字串（整列會塌成 0 高）。
- 感測器 sidecar：只有它提權（不是整個 App）、版本鎖 `0.9.7-pre728`、斷線／卡住**一直重拉**（指數退避，經 `ensureSensors`；讀數穩定 60s 才把間隔歸零）；**自動啟用只能放在進系統監控頁時**（開機那條只走排程工作）；PawnIO 由 App 代裝但要驗 Authenticode（不釘 SHA-256），靜默安裝參數是 `-install -silent`；殭屍 sidecar 要用 `Invoke-CimMethod ... Terminate` 才殺得掉。
- **probe.ps1 與 nvidia-smi 開機就常駐**：離開系統監控頁與縮到系統匣都不要 `stop()`（每次重開會付冷啟動＋第一輪 CPU% 全 0）；壓力測試才要離頁收掉。進頁 `start()` 要把 lastFeed 立刻再送一次。
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
- **不可以用 `window.confirm`／`prompt`／`alert`**（樣式不搭，而且會把整個 renderer 卡住）：一律用 `app-dialog.js` 的 `askConfirm`／`askInput`／`showAlert`，訊息走 `textContent`（檔名、分支名、上游錯誤都是外部輸入）。就地二次確認（按鈕變紅勾）仍然是刪除的首選，這三支給「需要打字」或「非刪除」的情況。
- 規格表與長條圖標籤不准 `text-overflow: ellipsis`（截掉那筆等於沒有那筆資料），要 `overflow-wrap: anywhere`；`<dl>` 多欄流版每組 dt/dd 要包一層 `<div>`。**hover 才出現的操作等於沒有**。
- 說明文字：空狀態 ≤12 字、hint 只留「這是什麼」；**測試不可以用「字數大於 N」當斷言**；改文案要 grep 測試腳本；但「防誤解」的最短說法（dwm VRAM、磁碟測速含快取、風扇下限）不準刪光。
- 設定頁只管「裝了什麼、怎麼推論、雲端端點」，選哪一顆模型在功能頁選；未安裝的本地模型仍要留在選單裡標「（未安裝）」。
- `.subtab-panel` 的顯示只由 `.active` 控制；狀態樣式要比 hover 更高特異度；可以拖的東西一律 `user-select: none`。

- **renderer 的 JS 不准 `import './x.css'`**：打包版是用 `file://` 直接載 `src/` 的原始 ES module，CSS 不是 JS module，整條 import 鏈會 `Failed to fetch dynamically imported module`，掛掉的是最上層那支（症狀寫著 `explorer-page.js`，真兇是它 import 的那支）。開發版有 Vite 轉換所以全綠。樣式一律掛 `index.html` 的 `<link>`；守門 `test-explorer-operations-ui.js`。
### 測試（CDP／e2e）

- **在這個 App 裡開發這個 App，一律 `npm run dev:sandbox`**（`scripts/dev-sandbox.js`）：三份 VoiceInk 預設共用 `%APPDATA%\voiceink`，而 `requestSingleInstanceLock()` 綁的是 **userData 路徑**（`main.js` 特地在搶鎖前就套用 `--user-data-dir`）——不換路徑只會把使用者的視窗叫到前面然後自己關掉，還跟他搶資料檔與 AGY 的埠。沙箱在 `%APPDATA%\voiceink-dev`：`models`／`hf-models` 用 junction 接回真的那份（唯讀，30GB 不能複製）；`config.json`／`workspaces.json` **複製**一份（有真資料可用又弄不髒）；會累積的紀錄（usage／code-usage／ agy-logs／dictations／terminals）**不接**；`agyEnabled`／`dictationEnabled`／`sysmonSensors`／檔案頁 `uffsAuto` 強制關掉（這幾個的影響跑得出 userData 之外）。**寫進沙箱前一律先 `rm` 目的地**——`writeFileSync`／`copyFileSync` 會跟著符號連結寫到對面去，沙箱裡只要有一條指回真 userData 的連結，這支「保護資料」的腳本就會親手覆寫使用者的設定。
- **腳本不准自己往 `%TEMP%` 撒東西**：暫存一律 `scripts/lib/test-temp.js` 的 `tempDir(prefix)`／`tempFile(name)`——全部收在 `%TEMP%\voiceink-tests\run-<pid>-*`，程序結束（含 Ctrl+C、`npx electron` 的 `app.exit()`）自動刪，當掉沒刪成的超過 6 小時由下一支腳本清掉（以前 76 支各自 `mkdtemp`，累積 260 多個資料夾）。守門 `test-temp-hygiene.js`；真的要留的那一行加 `// temp-ok: 原因`。
- **CDP 收尾只能殺自己**：暫存 `--user-data-dir` ＋只對自己 spawn 的 `child.pid` 跑 `taskkill /PID /T`；**禁止 `/IM VoiceInk.exe`**（會關掉使用者的安裝版）。
- **不可以用「第一列」或「總數」指涉自己建的東西**（最糟會刪掉使用者的資料）：一律 `[data-id="..."]`，中途建的都要刪掉。
- 同一時間只能跑一支 CDP 測試；挑主視窗一律用 `/index\.html/`（HUD 也是一個 page target）。
- **暫存 user-data-dir 會連帶搬走資產**：模型用 junction 接回去（只讀）、`chatProviders` 自己種、埠跟 OS 借（`listen(0)`）。多實例測試的第二／第三份也要帶**同一個** `--user-data-dir`，否則那兩條斷言根本沒測到卻是綠的。
- UI 斷言要等「量得到尺寸」不要睡固定時間；`Runtime.evaluate` 每次都在同一個全域範圍求值（`const` 要包 IIFE）；新增 nav 分頁時五個腳本裡寫死的頁面清單都要同步更新；開頭要把 `sysmonSensors` 關掉（否則彈 UAC 卡住），檔案頁自動授權看 `explorer.json` 的 `uffsAuto`（暫存 userData 也會自己跳過），`finally` 還原。
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
| 檔案總管 | `test-explorer.js`（路徑守衛＋自種暫存目錄）＋ `e2e-explorer-cdp.js`（暫存 user-data-dir，**不點第一列**）＋ `probe-explorer-uffs.js`（機器上真有 `uffs` 才打真搜尋）＋ `e2e-explorer-drag.js`（拖出去交給 OS 的內容，假 sender）＋ `test-explorer-shell.js`（殼層選單去重／sidecar 協定）＋ `probe-explorer-shell.js`（真 IContextMenu：7-Zip／WinRAR／傳送到、Drive 綠勾） |
| 專案工作區 | `test-workspace.js`／`-nav`／`-ui`／`-state`／`-perf` ＋ `e2e-workspace-cdp.js`（暫存 user-data-dir ＋自種專案）；動 Monaco 前後跑 `probe-workspace-monaco.js`，動 PDF 前跑 `probe-workspace-pdf.js`；動編輯器／diff／預覽／專案切換前後跑 `probe-workspace-perf.js`（**打包版**開 1.4MB／4 萬行的檔，數 `createModel` 有沒有重做、量輸入法游標位置、驗專案隔離）；動大檔開關與記憶體前後跑 `probe-workspace-bigfile.js`（**打包版**量 1.4MB／4 萬行的開檔毫秒數、並排變更毫秒數，以及關掉之後堆積回不回得去、預覽的 iframe 有沒有被收掉） |
| 終端機 | `test-terminal.js` ＋ `test-terminal-ui.js`（輸出合併、輸入法對位）＋ `probe-terminal-flicker.js`（**會叫到最前面**：DOM vs WebGL 量游標重建與 textarea 抖動）＋ `probe-terminal-upgrade.js`（**打包版**驗 WebGL／Unicode 11／字級／搜尋／分割／OSC 標題與 cwd）＋ `probe-terminal-ime.js`（**打包版**真的走一次 Chromium 輸入法組字）＋ `e2e-terminal.js`（真 ConPTY）＋ `e2e-terminal-cdp.js` ＋ `test-terminal-host.js`（獨立宿主）＋ `test-terminal-links.js` ＋ `probe-terminal-links.js`（真 xterm 座標，`npx electron`） ＋ `probe-terminal-editor.js`（Ctrl+G 的 $EDITOR 橋接：真的把那支 batch 跑起來，量它會不會卡住、送出與取消放不放得走） ＋ `probe-terminal-host-version.js`（唯讀：問這台機器上真的跑著的宿主是哪一份執行環境、還活著幾個 shell——「更新了卻沒生效」先跑這支）；動宿主或 `build.files`／`asarUnpack` 前後跑 `probe-terminal-restart.js`（**打包版**真的關 App、覆寫安裝檔再開回來）；管理員 `probe-terminal-admin.js`（免 UAC）／`probe-terminal-admin-elevate.js`（**跳一次 UAC**）；動 `foreground.js` 前後跑 `probe-terminal-foreground.js`（**會開／關記事本**，重現「記事本已經開著」再開第二次）；動配色或桌布前後跑 `probe-terminal-background.js`（**打包版**量桌布那一層畫不畫得出來、字有沒有被 opacity 一起壓掉、拿掉圖之後底色回不回得到不透明）|
| 聊天／Markdown | `e2e-chat.js`（mock SSE）＋ `e2e-chat-cdp.js` ＋ `test-markdown.js` |
| HF模型 | `test-hfmodels.js` ＋ `probe-hf-router.js`（動 runtime 前跑）／`probe-hf-hub.js`／`probe-hf-detail.js`（打真 HF）＋ `e2e-hfmodels.js` ＋ `e2e-hf-cdp.js` |
| CC代理／閘道 | `test-ccswitch.js` ＋ `e2e-ccswitch-cdp.js`；端點 `probe-ccswitch-endpoints.js`／模型 `probe-ccswitch-models.js`／Codex 參數 `probe-ccswitch-codex.js`；閘道 `test-ccswitch-gateway.js` ＋ `e2e-ccswitch-gateway.js` |
| AGY | `test-agy-mappers.js` ＋ `e2e-agy.js`（mock）＋ `e2e-agy-cdp.js`；動映射表／端點順序前跑 `probe-agy-upstream.js`，動 `runAgyCli` 前跑 `probe-agy-nudge.js` |
| 用量統計 | `test-code-usage.js` ＋ `e2e-code-usage.js`（真的讀本機記錄）＋ `probe-code-usage-audit.js`（不經 codeusage 重算對帳）|
| 額度 | `test-usage.js` ＋ `e2e-usage.js` ＋ `e2e-usage-cdp.js`；動端點或解析前後跑 `probe-usage-endpoints.js`（打真上游）|
| 系統監控 | `test-sysmon.js` ＋ `e2e-sysmon.js` ＋ `e2e-sysmon-cdp.js` ＋ `probe-sysmon-stress.js`（實機量有沒有壓到）＋ `e2e-sysmon-sensors.js`（**跳 UAC**）|
| 風扇／效能調整 | `test-sysmon-fans.js` ＋ `e2e-sysmon-fans-cdp.js`（不接管真風扇）＋ `probe-sysmon-fans.js`／`probe-sensors-task.js`（**跳 UAC**）；`test-sysmon-oc.js` ＋ `e2e-sysmon-oc-cdp.js`（不按套用）|
| 使用時長 | `test-screentime.js` ＋ `e2e-screentime-cdp.js`（**不關使用者的 Tai**）|
| 語音輸入 | `test-dictation.js` ＋ `e2e-dictation.js`（insert 是 stub）＋ `e2e-dictation-cdp.js`；動整理 prompt 前後跑 `probe-dictation-cleanup.js`（**打使用者設定裡那顆雲端整理模型**：錯字有沒有修、條列有沒有換行、長篇有沒有分段；userData 指到暫存，不碰真字典）；熱鍵 `probe-dictation-hook.js`／`probe-uiohook.js`／`probe-dictation-latency.js`／`probe-dictation-live.js`（**會搶焦點**）|
| ASR／即時字幕 | `e2e-llama-asr.js`／`e2e-asr-threads.js`／`e2e-stt-cdp.js`／`probe-cloud-asr.js`（真金鑰打真上游）；`test-vad.js` ＋ `e2e-live-pipeline.js` ＋ `e2e-live-cdp.js` |
| 翻譯 | `probe-prompt-path.js`（prompt 逐 token）＋ `verify-chat-wrapper-fix.js` ＋ `probe-packed-local-llm.js`（動 `build.files` 前後）＋ `probe-translate-lang.js` |
| 彈窗 | `e2e-app-dialog-cdp.js`（自己開 vite ＋ electron，**會叫到最前面**：驗確認／輸入／告知三種都是 `app-dialog` 且套到玻璃樣式、Esc 與取消回得對、節點會收掉）|
| 跨模組 | `test-taskbar-identity.js`（工作列身分與圖示）＋ `probe-taskbar-icon.js`（量安裝好的捷徑解析得到 App 圖示；動 `build/installer.nsh` 前後跑）／`test-error-hygiene.js`（錯誤衛生）／`test-ipc-invoke.js`（IPC 外殼）／`e2e-tray-cdp.js`（常駐）／`test-updater.js` ＋ `e2e-update-cdp.js`（會連 GitHub）＋ `probe-updater-diff.js`（唯讀：拿最近兩版真 blockmap 重算差分划不划算）＋ `probe-updater-mirrors.js`（唯讀：量官方 vs 鏡像的實際 KB/s）／`e2e-visual-cdp.js`（七頁 × 主題 × 三尺寸）／`e2e-ux-tweaks-cdp.js`（**會叫到最前面**）／`e2e-cdp-smoke.js`／`test-temp-hygiene.js`（腳本不撒暫存、沒有遞迴 rmSync）＋ `test-safe-rm.js`（junction 不被穿過，另可用 Electron 內建 Node 24 跑）＋ `test-asar-lock.js`（`npx electron`：列資料夾不鎖 `app.asar`）|
