# 2026-09-21 — 欄寬可拖、分頁列縮小並可拖曳排序

回報：四塊欄位（側欄／主欄／右欄／詳情）之間的縫隙要能拖大小；分頁列要窄一點矮一點，
而且像瀏覽器那樣可以左右拖。

- `initResizer()` 從 `app.js` 抽成 `pane-resize.js`（多了 min／max／onResize），聊天側欄沿用，
  檔案總管三條把手共用同一份。寬度進 CSS 變數＋localStorage。
- 詳情欄本來是 CSS `resize: horizontal`：把手只在右下角一個小三角、換頁就忘記，換掉。
- 分頁列 padding 8→3、分頁 180px→`flex: 0 1 148px`（最小 96px）、字 13→12px、
  關閉鈕 28→20px、新增鈕 32→26px。整條從 54px 降到 34px。
- 分頁左右拖排序：`createListReorder` 加 `axis`，鍵盤改 Alt+←→。

地雷：
1. `.ex-resizer` 沒有 `position: relative` 的話 `z-index` 不生效，`margin-inline: -3px`
   會讓左右欄疊在把手上面，整條點不到（詳情欄那條完全拖不動，查了三輪才看到
   `elementFromPoint` 回傳的是隔壁欄）。
2. 操作中心那塊浮動面板蓋在右下角，詳情欄把手中段被它擋住。使用者抓上半段沒問題，
   測試也要抓 `rect.top + 40`。
3. **CDP 的滑鼠「按下／放開」在視窗沒有前景時會被 Chromium 丟掉**，只剩 mousemove。
   探針一開始沒加 `--hidden`，三個拖曳全部靜靜地沒反應，差點以為是程式壞了。
4. 右欄要吃固定寬（`flex: 0 0 var(--ex-second-w)`），兩邊都 `flex: 1` 的話把手一拖會互推。

驗收：`e2e-explorer-cdp.js` 112 條（新增 [J]）、`test-explorer.js` 297 條、
`e2e-explorer-dual-cdp.js` 42 條全綠。

已知偶發（改動前就有，跟這次無關）：`e2e-explorer-cdp.js` 的 [C6] 框選與 [C8]／[F] 的
資料夾監看會偶爾紅。[C6] 紅的時候現場是 `selected: 3` 但 `marquees: 0`——框選其實跑了，
是晚一步的監看事件重畫清單把框洗掉。腳本現在會在紅的時候把現場印出來。

# 2026-09-21 — 雙欄右欄換不了磁碟

回報：「開啟雙欄預設在 C，沒辦法便捷地切其他槽。」

右欄本來只能靠三條路換磁碟：先點右欄讓它變作用欄再去側欄按、把麵包屑點開打路徑、
或一路按 ↑。而 ↑ 到磁碟根目錄再按一次會到「本機」，右欄在「本機」不畫磁碟格，
所以看到的是一片空白——等於沒有出口。

- 右欄標頭加一排磁碟鈕（`#exSecondDrives`）：按一下換槽，順便把作用欄切成右欄，
  目前那顆用 `aria-pressed` 標起來。資料跟側欄共用同一份 `disks`。
- 右欄在「本機」時的空畫面改成指路去那排鈕，不再只寫「這個資料夾是空的」。

順手修掉：`#exSecondCmdBar` 只在 `setActivePane()` 時畫，所以剛開雙欄、還沒點過右欄
之前那條指令列是空的。改成跟著 `paintSecondPane()` 一起畫。

地雷：磁碟鈕不壓 `max-width` 的話，四顆鈕會把 `flex-basis: 0` 的麵包屑擠成 0 寬，
右欄窄到 240px 時路徑整個看不見（實測 `crumbW: 0`）。麵包屑另外給 `min-width: 78px`。

驗收：`e2e-explorer-dual-cdp.js` 42 條、`test-explorer.js` 297 條、
`e2e-explorer-cdp.js` 102 條全綠。`e2e-explorer-files-plan-cdp.js` 的「換到自種的三頁 PDF」
在**跑原始碼**時會逾時，把改動前的 master 原始碼放回去跑同樣會紅，不是這次造成的；
那支本來就是寫給打包版跑的（打包版 55 條全過）。

# 2026-09-21 — 全專案 bug 掃描與修復

- [x] 盤點主要模組、既有測試與安全執行範圍
- [x] 分模組追查，新增失敗回歸並最小修復已確認問題
- [x] 跑跨模組回歸、打包與背景 CDP 驗收
- [x] 記錄實際結果及未涵蓋邊界

## Review

修好的問題（每項都先有一支會失敗的回歸，再改）：

- HF 儀表板離開再回來會重開舊輪詢（`hf-dash.js`）
- 朗讀停止後仍留播放監聽與等待工作（`translate-page.js`）
- PDF 快速翻頁被慢一步的舊頁蓋回（`explorer-preview.js`）
- 關閉 PDF 預覽整段中斷：pdfjs 6 的 `PDFDocumentProxy` 沒有 `destroy()`，要走
  `loadingTask.destroy()`；原本丟 TypeError，`closePreview` 半路斷掉、預覽關不掉
- 中文選字按 Enter 誤送出：彈窗、路徑輸入、快速開檔、搜尋／取代、分頁改名、
  工作區改名、側欄改名（`app-dialog.js`／`ws-*.js`／`workspace-page.js`／`chat-sidebar.js`）
- 圖片預覽載入後顯示錯誤的縮放百分比（`image-viewer.js`）
- 複製後清單沒刷新、中文大檔存檔上限按位元組算、Windows 路徑大小寫
  （`workspace/files.js`／`search.js`／`watch.js`／`explorer/fs.js`）
- AGY 串流逾時被當成正常結束（`agy/upstream.js`）
- HF hub 讀 body 前綴在沒有 body 時會炸（`hfmodels/hub.js`）

驗收（2026-09-21）：

- `scripts/test-*.js` 80 支全過（`test-asar-lock` 要用 electron 跑，另計）
- electron：`test-asar-lock` 8、`e2e-agy` 98、`e2e-chat` 195 全過
- 打包版 CDP：`e2e-explorer-files-plan-cdp` 54、`e2e-app-dialog-cdp` 8、
  `e2e-explorer-cdp`、`e2e-ccswitch-gateway` 40 全過

未涵蓋：需要實體麥克風、GPU 感測器與真雲端憑證的路徑（ASR／sysmon／dictation）沒跑。

地雷：

- `node_modules/.bin` 會整個空掉，`vite`／`electron` 就找不到；`npm install` 重建連結即可。
- `e2e-agy`／`e2e-chat` 印完結果不會真的退出，打包前要先清掉殘留的 electron，
  否則 `npm install` 會 EBUSY 卡在 `electron/dist`。
- `e2e-explorer-files-plan-cdp` 的預覽換檔會繞圈，不能假設「下一份」是哪個副檔名。

# 2026-09-21 — 方格檢視縮放、大圖預覽、終端機貼截圖、Ctrl+G 的 PATH

- [x] 方格檢視檔名直書：`.ex-row-name` 在 grid 下改直排，檔名限兩行 ＋ `title` 放完整檔名
- [x] Ctrl+滾輪縮放：`explorer-zoom.js` 純函式級距（清單↔48/64/96/128/180/256），
      `--ex-tile` 驅動版面、`data-tile` 驅動縮圖尺寸，存進 `explorer.json` 的 `tile`
- [x] 縮圖跟著放大：`explorer-icons.js` 的請求尺寸與快取鍵都帶 tile
- [x] 大圖預覽 `image-viewer.js`：空白鍵／側欄預覽圖／右鍵「預覽」開，滾輪縮放、拖曳、
      ←→ 換圖、Esc 關；圖片走 `vi-media://` 的 `~local`（不再卡 2MB）
- [x] 終端機貼上截圖：`terminal/clipboard-image.js` 落成 PNG 後貼路徑，Ctrl+V／Alt+V 都收
- [x] Ctrl+G 的 `editor "voiceink-edit.cmd" not found in PATH`：`shellEnvironment` 的
      `env.PATH = …` 在 Windows 等於另開一個空 PATH，改成就地改本來那個 `Path` 鍵
- [x] 測試：`test-explorer-zoom.js`（新）、`probe-terminal-editor.js` [F][H] 改成會抓到這個 bug、
      `e2e-explorer-cdp.js` [C11]、`e2e-terminal-cdp.js` 貼截圖兩條
- [x] 文件：AGENTS 地雷四條、CONTEXT 架構兩段

Review：
- 根因一（Ctrl+G）：Windows 環境變數不分大小寫，但 `{ ...process.env }` 展開後的鍵是 `Path`，
  `env.PATH = …` 新增的是第二個同名變數，子程序生效的仍是原本那份 → CLI 找不到 shim。
  舊測試讀的是自己寫進去的那個假鍵，所以一直是綠的。
- 根因二（方格直書）：只改了 `.ex-row` 的 flex 方向，沒改裡面那層 `.ex-row-name`。
- 使用者要重新啟動終端機宿主，Ctrl+G 的修正才會生效（宿主活得比 App 久）。

# 2026-09-20 — 檢查更新下載走鏡像（GitHub APAC 過慢）

- [x] `update-mirrors.js`：GitHub Releases 的 `.exe` 先走 gh-proxy／ghfast，最後才官方
- [x] `updater.js` 包住 `httpExecutor.download`；失敗刪掉半截再試下一個
- [x] `latest.yml` 仍只從 GitHub 讀（sha512 信任根不走代理）
- [x] 測試先紅再綠；probe 量鏡像 vs GitHub 的實際速度
- [x] 文件：AGENTS 更新地雷、發行流程不用多一步

# 2026-09-20 — 電腦安裝版 VoiceInk 更新至最新發行版（v1.23.1）

- [x] 調查安裝版檢查更新失敗根因：v1.22.0 差分下載與快取狀態、網路或 Range 請求中斷觸發 error；v1.23.1 已修正關閉差分下載
- [x] 確認安裝檔：`dist/VoiceInk-Setup-1.23.1.exe` SHA-512 與 GitHub Release 完全吻合
- [x] 安全關閉目前背景常駐的 1.22.0 主程序與關聯程序
- [x] 執行 NSIS 靜默安裝更新至 v1.23.1
- [x] 驗證安裝後的執行檔版本（1.23.1.0）、捷徑、app-update.yml
- [x] 啟動新版並驗證檢查更新功能正常（已是最新版本，不報錯）
- [x] 清理暫存檔案與回顧

Review：
- 根因：舊版 v1.22.0 預設開啟差分下載（Differential Download），在進行增量下載時需發送數千次 HTTP Range 請求，若遭遇 GitHub CDN 中斷、超時或快取 blockmap 不一致即觸發 error 事件，且 updater 錯誤提示一律為「檢查更新失敗（無法連線到 GitHub，或這個版本沒有附帶更新資訊）」。
- 處置：下載官方發行 v1.23.1 安裝包（SHA-512 校驗一致），關閉舊版常駐程序後完成 NSIS 靜默安裝。安裝後 `VoiceInk.exe` 版本為 1.23.1.0，新版已內建關閉差分下載改為整包單連線下載，檢查更新確認顯示「已經是最新版本」，後續升級通道恢復正常。

# 2026-09-20 — 檔案總管殼層選單 ＋ Google Drive 綠勾

- [x] sidecar：`IContextMenu` 讀 7-Zip／WinRAR／傳送到；overlay 改 `SHGFI_ADDOVERLAYS`
- [x] 「傳送到」空選單：`CMF_SYNCCASCADEMENU` ＋ IContextMenu3 沒填再退 IContextMenu2
- [x] 玻璃選單合併殼層項（去重 App 自己的開啟／剪下複製）
- [x] 可見列圖示走疊好的殼層圖（Drive 綠勾）；沒 sidecar 降級
- [x] 驗證：`test-explorer-shell.js` 26/0、`test-explorer.js` 186/0；probe 看到 WinRAR／7-Zip／傳送到；Drive `學校的資料` overlay 槽 14、PNG 2038 bytes
# 2026-09-20 — 用量單價、Claude Opus 計價、多硬碟排版

工作樹：`D:\\Workspace\\Personal_Project\\VoiceInk-usage-sysmon`（分支 `feat/usage-sysmon`）

- [x] Gemini 3.8 Flash、Kimi K3 公開單價（測試先紅再綠）
- [x] Claude Opus：核對本機 jsonl（去重後快取讀佔大宗，不是重複加總）；補花費拆帳讓畫面看得出為什麼貴
- [x] 系統監控：虛擬磁區（Google Drive）不進容量總計；多顆實體碟各一卡；磁碟計數器繞回不做差值
- [x] `test-code-usage.js` 158/0、`test-sysmon.js` 188/0、`e2e-sysmon.js` 63/0、`e2e-code-usage.js` 16/0
  未做：`electron:pack` 與打包版 CDP（在工作樹裡改，預覽請用 `npm run dev:sandbox`）

# 2026-09-20 — 合併前審查（上一輪未提交的 34 檔）

- [x] 逐模組審查未提交變更（終端機／HF／系統監控／檔案總管／文件）
- [x] 修：**關思考沒真的關**——`--reasoning` 預設 auto，不寫 `off` 等於沒關（先紅再綠）
- [x] 修：**儀表板 tok/s 永遠是「—」**——router 沒帶 `--metrics`、`/metrics` 要帶 `?model=`、
      欄位名實測是 `tokens_predicted_seconds_total`（三個都缺一不可；`e2e-hfmodels.js` 真的量到 7.4 tok/s）
- [x] 修：**nvidia-smi 卡在啟動不會重開**——看門狗改成 spawn 就武裝，子程序結束時收掉（先紅再綠）
- [x] 修：切回「執行環境」子分頁會再開一條儀表板輪詢鏈（`startDash` 重入）
- [x] 查證後排除：preset 的 `no-mmproj = 1` 安全（router 自己轉成 `--no-mmproj-auto`，不會多送一個 `1`）
- [x] 文件：CLAUDE／AGENTS 補三條實測地雷（reasoning 預設、/metrics 三件事、GPU 看門狗）

Review：17 支 node 測試全綠（terminal 102／links 116／hfmodels 169／sysmon 183／explorer 186／
workspace 251／workspace-ui 127／error-hygiene 85 等）；`probe-terminal-links.js` 6/0、
`probe-terminal-editor.js` 10/0、`e2e-hfmodels.js` 26/0（真的起 router、真的發請求、真的量到速度）。
**未做**：`npm run electron:pack` 與打包版 CDP（審查在 worktree 裡跑，打包預覽要在主工作目錄更新）。

# 2026-09-19 — 系統監控常駐穩定 ＋ HF 模型對標 LM Studio

- [x] 感測器：斷線／卡住無限重拉（指數退避），不再 5 次就停；測試先紅
- [x] nvidia-smi 卡住也重開
- [x] HF 依 GGUF 架構自適應：上下文梯度、視覺、思考、in-checkpoint MTP
- [x] HF 儀表板：GPU VRAM、tok/s、排隊、本機端點、llama log（不送金鑰）
- [x] 模型卡顯示 ctx／KV／視覺／MTP；參數彈窗可設上下文／視覺／思考
- [x] CONTEXT／AGENTS／CLAUDE 對齊；相關測試全綠

# 2026-09-19 — 改善終端機體驗

- [x] 連結掃描：硬換行／折行接起來；`file://`、`www.`、`localhost:埠`；路徑留下行號
- [x] 點網址開內建瀏覽器分頁；點路徑用 App 開（專案內編輯器／樹，其餘走檔案頁）
- [x] AGY Ctrl+G：EDITOR 改短檔名＋PATH，通過 `split(' ')` + `shell: true` 的 spawn
- [x] 降低破圖：WebGL context 掉了重掛、fit 後清 glyph atlas
- [x] 測試先紅再綠：`test-terminal-links.js`、`probe-terminal-editor.js`；再跑 `test-terminal.js`

# 2026-09-15 — 根治專案外殘留


- [x] App：碰使用者任意路徑的模組改用 `raw-fs`（Electron 下＝`original-fs`）；`test-asar-lock.js` 修前 6/8 紅、修後 8/8
- [x] 追出第四個源頭：從 asar `copyFileSync` 會留 `%TEMP%\<uuid>.tmp.*`（累積 609 個）→ 終端機宿主／ffmpeg／GPU 套件改讀再寫；實測 copyFileSync 多 1 個、讀再寫 0 個
- [x] **發現 Node 24（Electron 43）`rmSync` 遞迴會穿過 junction 刪真資料**（純 Node 24 與 Electron 都重現、Node 22 不會）→ `src/main/safe-rm.js`；App 5 處、腳本 94 處換掉；`test-safe-rm.js` 在 Node 22／24 皆 6/0（Node 24 對照組 followed=true）；確認使用者模型 63 檔 6.9GB 完好、`hf-models` 自 9/2 建立後未變動
- [x] 測試暫存：`scripts/lib/test-temp.js`；74 支腳本改用；`test-temp-hygiene.js`（暫存＋遞迴 rmSync 兩條）對修改前版本紅、修改後綠
- [x] 打包：`electron:pack` → `scripts/pack-preview.js`；故意改一個換行會被 asar 比對擋下
- [x] 順手修三支過期測試（`.chat-list-proj`、寫死資料夾名、`dist/` 不存在）
- [x] 文件：CLAUDE／AGENTS（安全底線兩條、打包、測試、驗證表）、CONTEXT、lessons
- [x] 第五個源頭：electron-builder（@electron/get）每次打包在 `%TEMP%` 留空的 `electron-download-*`（183 個）→ `pack-preview.js` 把子程序 TEMP 指進 test-temp 管的資料夾；重打一次 0 → 0
- [x] 清掉既有殘留：空 `electron-download-*` 183 個、asar 中繼檔 612 個
- [x] 最終驗證：29 支單元＋4 支 Electron e2e 全綠；新流程打包（209 支 src 逐檔比對）；打包版 CDP 工作區 179/0、終端機 48/0、聊天 62/0、檔案總管 exit 0；`<uuid>.tmp.*` 612 → 612（修前每跑一次終端機 +7）；`%TEMP%`、磁碟根、`voiceink-tests` 皆零新增

Review：還留著 `D:\vi-build-ime-20260914`（使用者的 VoiceInk 安裝版鎖著，新版裝上後重開 App 才放得掉）；安裝版要等下一次發行才會帶到 `raw-fs` 修正。

# 2026-09-14 — 聊天：併發、側欄資料夾與狀態、對話參數

- [x] main：inflight 改成每對話一格（第二輪拿掉總數上限）、`abortConversation`、`activeConversationIds`；本機模型載入去重
- [x] main：`chat-params.js`（驗證＋轉 API 欄位，沒勾不送）；回覆記 model／ms／tokens
- [x] store：拿掉 `projectId`；資料夾 CRUD、`reorder` 帶 folderId、編輯／刪除／分叉訊息、`toMarkdown`
- [x] IPC／preload：刪 `chat:setProject`，加 folders／params／edit／delete／fork／export；`chatParams` 進 allowlist
- [x] renderer：`chat-sidebar.js`（資料夾、狀態點、⋯ 選單）、`chat-params-panel.js`、串流照對話分開、訊息操作
- [x] 測試：`e2e-chat.js` 新增 P／Q／R／S（P 在舊碼上先紅）→ 185 passed；`test-workspace.js` 235 passed
- [x] 打包版 `e2e-chat-cdp.js`：新增 19 項 UI 斷言全過（57/58）；唯一失敗是既有的「刪除供應商」測試還在 mock `window.confirm`（`e093589` 起已改 `askConfirm`），與本次無關
- [x] 截圖檢查側欄資料夾／狀態點／⋯ 選單／參數彈窗（深色）；修掉彈窗開啟時整塊捲動區的焦點框

### 第二輪（使用者追加）

- [x] 拿掉同時回應上限 8（`e2e-chat.js` 改測 12 個同時放行）
- [x] 資料夾本身拖曳排序（`reorderFolders`＋側欄第二組 list-reorder，拖完不誤觸收合）
- [x] AI 自動取標題（`chat-title.js`；`[T]` 7 項）
- [x] 參數只留 Temperature／Top P／Max tokens／Stop＋上下文則數；舊資料的非通用欄位 sanitize 丟掉
- [x] 新斷言在拿掉改動時紅（6 項 FAIL）→ 還原後 `e2e-chat.js` 194 passed
- [x] CDP 抓到：送出前改的名字會被第一則訊息蓋掉（既有行為，AI 標題讓它更明顯）→ 只在預設「新對話」時定暫定標題；先紅後綠，`e2e-chat.js` 195 passed
- [x] 打包版 `e2e-chat-cdp.js` 61/62（資料夾拖曳、AI 標題、取標題只打一次都過；失敗仍是既有的刪除供應商測試）

### 合併前審查（2026-09-15）

- [x] 全份 diff 逐檔審查（main／store／側欄／聊天頁／參數面板／選單）
- [x] 修：`chat:abort` 空 reqId 會停掉所有對話 → IPC 層擋掉
- [x] 修：`e2e-workspace-cdp.js` [AC] 還在呼叫已刪的 `chat.setProject`；參數鈕提示還寫 Top K
- [x] `e2e-chat.js` 195 passed；`test-workspace.js` 235；`test-error-hygiene.js` 85；`test-markdown.js` 23；`test-ipc-invoke.js` 11
- [x] 修：`e2e-chat-cdp.js`「刪除供應商」還在假裝 `window.confirm`（程式早改 `askConfirm`）→ 真的點彈窗；修前 61/62、修後 62/62
- [x] 打包版（asar 抽三檔與原始碼雜湊一致）`e2e-chat-cdp.js` 62/0、`e2e-workspace-cdp.js` 179/0
- [x] 合併進 master 推送、清理分支

## Review

- CDP 在背景跑時 Chromium 會延後 `<dialog>` 的 `close` 事件，靠它回結果的彈窗（`askInput`）在自動化裡等不到；參數彈窗改成按鈕直接結算。

# 2026-09-13 — 補齊未通過項目

- [x] 發行完成：版本更新至 `v1.21.0`，已提交、推送、合併、打包並建立 GitHub Release

- [x] 更新日期解析先紅再修；`test-sysmon-hotfix-date.js` 通過、`test-sysmon.js` 183/0、真 Electron 取樣 63/0
- [x] 更新監控測試中過期的合併列／多 GPU／畫布父層斷言；打包 `e2e-sysmon-cdp.js` 113/0
- [x] UFFS 0.6.40 真下載、官方 checksum 核對、解壓與 App UAC 安裝流程通過；UffsAccessBroker Running
- [x] 修正真搜尋發現的完整檔名 pattern、is_directory 與 FILETIME 格式；原始 CLI 與本輪檔案 mtime 核對通過
- [x] 最終 packaged 搜尋畫面／NAS IPC 驗證通過，已更新 `dist/win-unpacked` 預覽
- [x] 既有 NAS 分享實際讀取驗證：`probe-explorer-nas.js` 10 項／35 ms，UNC 與 X: 均可讀（唯讀）

本輪 UFFS 正式 ZIP SHA-256：`0e0103a25a98e86f698d0b910f6a4bcc706bde443d56c2f999c2abfb26c7a22a`，與官方 CHECKSUMS.txt 一致。經 App `installBroker()` 安裝到 `%APPDATA%/voiceink/uffs/uffs-windows-x64/`，服務已執行；真 `*.txt` 查詢 200 筆且 truncated=true，待下列格式修正後再驗特定檔名與畫面。
真查已驗：完整 `test-sysmon-hotfix-date.js`、大寫、`*test-sysmon-hotfix-date.js*`、`test-sysmon-hotfix-date.??` 均精準命中一筆；錯誤 `.pdf` 不命中，mtime 與 fs.stat 差 <2ms。含點的一般文字及基本 glob 以跳脫後 regex 避開 UFFS 0.6.40 漏檔；進階 glob（字元集合／大括號／OR／路徑 glob）仍沿用上游語法，未宣稱涵蓋。

Review：本輪新增日期／UFFS 格式／probe userData 回歸先紅再綠，12 支相關 Node 檢查全 exit 0。`e2e-sysmon.js` 真 Electron 63/0；`e2e-sysmon-cdp.js` 113/0。最終 `npm run electron:pack -- --config.directories.output=D:/vi-explorer-review-20260913` exit 0，194 支 JS 與 asar 一致、解包 probe.ps1 與來源逐位元一致。`D:/vi-explorer-review-20260913/probe-explorer-live.js` 在隔離 profile 複製已驗 UFFS binary：畫面一般完整檔名搜尋、mtime 核對、NAS IPC 及原有 explorer 斷言全過。預覽 exe／asar／probe.ps1 與驗收包 SHA-256 一致。尚未測 NAS 遠端寫入與進階 glob；本輪已提交、推送、合併、打包並發行。

# 2026-09-12 — feat/explorer 上游檢查

- [x] 抓取分支並確認本機乾淨；審查檔案操作、下載與畫面流程
- [x] 重現貼上途中剪貼簿改變造成複製變搬移；固定單次貼上的來源與模式，失敗只留剩餘項目
- [x] 重現複製碰到新建同名檔會覆寫；複製及跨磁碟搬移停用強制覆寫
- [x] UFFS 下載寫入失敗改回結構化錯誤；Windows 特殊資料夾改讀系統設定位置
- [x] 舊搜尋回覆失效、過期導航不寫歷史、格狀切回清單恢復排序列
- [x] 相關回歸、打包與隔離背景驗收；系統監控既有失敗另記如下

Review：上述問題均先重現再修復；未提交或推送。`test-explorer.js` 182/0、新增五支回歸均通過；`test-workspace.js` 239/0、`test-workspace-ui.js` 128/0、sysmon resident/lifecycle 通過。
`npm run electron:pack -- --config.directories.output=D:/vi-explorer-review-20260912` exit 0；194 支 source JS 與 asar 完全一致，預覽 `dist/win-unpacked` 的 exe/asar SHA-256 與驗收包一致。
打包背景驗證：explorer CDP 24 項通過；追加真實滑鼠雙擊、格狀切清單通過；workspace CDP 180/0。UFFS 真實下載／UAC、NAS 連線未驗。
系統監控 CDP：15 passed, 1 failed，卡在硬體清單。直接以 PowerShell 執行 `probe.ps1` 輸入 `static 1` 重現 `InstalledOn` DateTime Parse 例外，整個 static 框只剩 `#ERR`；`probe.ps1`／`metrics.js`／`sampler.js` 與 master 無差異，來源與 packaged probe SHA-256 一致。屬既有問題，未擴大修改；此項未通過。

# Git 面板：變更總行數 + 完善最近提交

- [x] 測試先紅：parseLog 作者／numstat；變更總計 DOM；log 主旨不准 ellipsis
- [x] 變更區段標題顯示總 +/−（跟上一次提交比，未追蹤／二進位不算）
- [x] 各分組標題也帶該組總 +/−
- [x] 最近提交：作者、主旨換行、每筆 +/−、點 hash 複製
- [x] `test-workspace.js` 239 passed；`test-workspace-ui.js` 128 passed

# 檔案總管：詳情橫排、側欄自訂、路徑輸入、搜尋排序、右鍵

- [x] 測試先紅：UNC 放行、rankHits、places 合併、inspect、路徑輸入／右鍵來源掃描
- [x] 路徑守衛放行嚴格 UNC；裝置路徑／pipe 仍擋
- [x] 詳情操作鈕在上＋inspect 預覽
- [x] 側欄新增／移除／拖曳排序＋NAS
- [x] 路徑列可輸入；搜尋相關度排序；右鍵補強
- [x] `node scripts/test-explorer.js` 綠（180 passed, 0 failed）
- [x] 沙箱預覽（不動安裝版）

# 系統監控取樣器常駐（加快進頁顯示）

- [x] 回歸測試先紅：再次 `start()` 立刻重送 lastFeed；離頁不呼叫 `stop()`
- [x] main：開機就 `sysmon.start()`；`start()` 重送 lastFeed（順便刷新 gpu／sensors）
- [x] renderer：cooldown／縮到系統匣不停 probe；進頁立刻畫上一筆
- [x] 更新 CDP 斷言、CONTEXT／AGENTS
- [x] 驗證：lifecycle 修復前紅、修復後綠；`test-sysmon-resident.js` 綠；`test-sysmon.js` 183 passed

# 檔案總管審查修復

- [x] `assertMutable` 只擋刪／改名／搬走受保護「那一項」；家目錄可新增／貼上／還原
- [x] `resolveExisting` 回使用者路徑；junction 刪／搬／purge 不跟目標
- [x] 清空回收筒不吃 list 2000 上限；還原先檢查再 mkdir
- [x] UFFS 只跑安裝目錄、checksum 缺就失敗、zip 有上限；temp userData 忽略 force
- [x] renderer：navSeq、監看保留選取、回收筒用 recycleKey、預覽不 toast、複製進自己、搜尋後重畫、拖進回收筒要確認
- [x] sysmon `start()` 空 GPU／感測器不覆蓋 lastFeed
- [x] 測試先紅再綠：家目錄可寫、junction、UFFS 校驗、碰撞檔名 `hello (2).txt`；刪檔用 permanent 不清使用者回收筒

# 檔案頁（檔案總管 + UFFS 整機搜尋）

- [x] main：`explorer/paths.js` 路徑守衛
- [x] main：store／fs／drives／watch
- [x] main：uffs（尋找／搜尋／下載／broker）
- [x] main：index + ipc；接 main.js／preload
- [x] renderer：nav + `#page-explorer` + CSS + `explorer-page.js`
- [x] 測試：`test-explorer.js` 59 passed；`e2e-explorer-cdp.js` 綠；probe 無 UFFS 則 SKIP
- [x] CONTEXT／AGENTS／CLAUDE 對齊
- [x] 驗證：單元測試綠；`electron-builder --win dir --config.npmRebuild=false` 產出 unpacked
- [x] 未提權搜尋不再回空清單；授權鈕看 `broker.installed` 不是 exe 在不在
- [x] 進檔案頁自動下載＋一次 UAC，搜尋即開即用；UAC 按否寫 `uffsAuto: false`
- [x] CDP 暫存 userData／沙箱不自動跳 UAC
- [x] 預設刪除進資源回收筒，可還原／清空；永久刪除另走
- [x] 複製／搬移撞名給唯一名；新增檔案；listDir 排序
- [x] 右鍵選單、Shift／Ctrl+A、拖放、側欄資源回收筒
# 2026-09-14 — AI CLI 中文組字閃爍

- [x] 用 Chromium 組字與連續定位取樣重現背景重畫造成的閃動：舊打包版 40 次取樣／20 次移位，最大 159.85px
- [x] 修正組字定位，保留正常輸入、中文送出與分頁生命週期：CSS 固定位置、組字期間凍結錨點，移除逐幀補救並在關分頁時清理事件
- [x] 驗證：`node scripts/test-terminal-ui.js` 12/0、`node scripts/test-terminal.js` 102/0；`npm run electron:pack -- --config.directories.output=D:/vi-build-ime-20260914` exit 0
- [x] 打包版：`VOICEINK_EXE=D:/vi-build-ime-20260914/win-unpacked/VoiceInk.exe` 下 `node scripts/probe-terminal-ime.js` 13/0（25 次取樣、0 次移位、0px）；`node scripts/e2e-terminal-cdp.js` 48/0
- [x] Review：打包內三支修改檔與來源逐位元組一致；已同步 `dist/win-unpacked`，exe／asar 的 SHA-256 一致；未動正在運行的安裝版
- 邊界：以真 Chromium IME＋模擬 CLI 分段重畫驗證，未操作前景 Windows 原生注音選字窗，也未發行新版本。

# 2026-09-14 — 全代碼庫檢查與修復

- [x] 盤點既有改動、模組與測試，建立本輪基準（58 支本機測試全過；194 支 JS 語法檢查通過）
- [x] 分組追查檔案／工作區、AI、代理／統計／監控、終端機與共用邊界
- [x] 對確認的 bug 先跑失敗回歸，再做最小修復
- [x] 執行本機檢查、打包與隔離背景驗收，記錄結果及未涵蓋範圍

本輪修復：
- 工作區草稿保存原檔 mtime，切專案或重開後仍能擋住外部修改／刪檔；舊草稿缺版本時先比較或明確覆寫。
- 工作區與整機檔案總管可只改檔名大小寫，仍禁止覆蓋另一個項目；磁碟根目錄作為專案時可正常讀取子項。
- HF 下載寫入失敗回傳錯誤、不崩潰；失敗清掉取消監聽；續傳跳過已完成分片，分片／投影檔全部完成才算已安裝。
- 雲端轉錄在最後一段等候期間取消，回覆抵達後不再誤報成功。
- 額度同步保留同步期間的新排序／顯示設定；失敗重試不再延長舊額度的 6 小時期限。
- CC 閘道接受 CRLF 串流；CC／AGY 保留沒有結尾換行的最後一段文字。
- Ctrl+G 來源讀取失敗不死等，寫回失敗回傳非零並保留 .out 編輯內容；TTS 不回送外部錯誤，段落編號收斂為整數。

Review／實際驗證：
- `node dist/audit-20260914/run-final.cjs`：64 支本機 test 全 exit 0（初始基準 58 支全過）。新增回歸及工作區／額度擴充覆蓋上述失敗路徑。
- `node scripts/e2e-ccswitch-gateway.js`：40 passed, 0 failed。
- `node dist/audit-20260914/run-integration.cjs`：真 Electron 聊天 140/0、AGY 98/0、系統取樣器 63/0；聊天／代理上游使用本機測試服務。
- `npm run electron:pack -- --config.directories.output=D:/vi-build-audit-20260914`：exit 0；194 支 source JS 與 asar 逐位元組一致。
- `node dist/audit-20260914/run-packaged.cjs`：9 支全部 exit 0；workspace 180/0、explorer 24 項、terminal 48/0、HF 44 項、CC 125 項、sysmon 113/0、screentime 19/0、visual 77 項、IME 13/0（25 次取樣、0 次移位）。全部使用隔離 userData／隱藏視窗，不操作使用者的安裝版。
- `dist/win-unpacked` 已同步驗收包，exe／asar SHA-256 一致，且預覽包內 194 支 JS 仍與 source 一致。詳細 log、結果 JSON 與 hash 在 `dist/audit-20260914/`。
- 保留進場時六個未提交檔案的既有終端機／輸入法改動；本輪沒有 commit、push 或發行。
- 未涵蓋：真實付費 API、HF 遠端大檔下載／GPU 推論、NAS 寫入、提權風扇／超頻、Windows 原生語音輸入插入、NSIS 安裝更新。上述界線不代表已證實的 bug；本輪確認的 bug 均已修復並驗證。

# 2026-09-15 — 提交上述兩輪、清理專案外殘留

- [x] 審查兩輪未提交改動（無新問題）；`CLAUDE.md`／`AGENTS.md` 組字地雷改成 CSS 固定位置的新做法；`CONTEXT.md` 補變更紀錄
- [x] 刪除專案外殘留：`D:\vi-build-*` 打包輸出、`%TEMP%` 約 260 個測試暫存；剩被其他程式鎖住的 3 個
- [x] `e2e-chat-cdp.js` 收尾改成 taskkill 自己的程序樹＋刪暫存 userData（之前每跑一次留一個 `voiceink-cdp-*`）
- [x] 與聊天那輪合在一起重驗：18 支單元測試全 exit 0、`e2e-ccswitch-gateway.js` 40/0、`e2e-chat.js` 195/0；打包版 `e2e-chat-cdp.js` 62/0、`probe-terminal-ime.js` 13/0、`e2e-terminal-cdp.js` 48/0，`%TEMP%` 無新增；打包輸出驗完已刪
# 2026-09-19 — 接續檔案總管分頁與本機首頁

- [x] 從原始對話與工作樹確認需求、既有改動及中斷點
- [x] 完成分頁新增／切換／關閉、獨立歷史與首頁樣式
- [x] 驗證晚到回覆、首頁操作邊界及原有檔案操作
- [x] 打包並以隔離 userData 背景驗收，記錄結果

Review／實際驗證：
- `node scripts/test-explorer-page-state.js`：修正前首頁晚到造成歷史 `["B","B"]`（預期 `["B"]`）；修正後通過，另涵蓋切頁晚到、關閉分頁、首頁禁止貼上與上一頁失敗保留位置。
- `node scripts/test-explorer.js`：186 passed, 0 failed；`test-explorer-copy-race.js`：2/0；`test-explorer-clipboard.js`：3/0；`test-explorer-places.js`：PASS。
- `npm run electron:pack -- --config.npmRebuild=false`：exit 0，212 支 src 檔案與 asar 一致，更新此工作樹的 `dist/win-unpacked`。沿用根工作樹 node_modules（junction），未新增依賴。
- `node scripts/e2e-explorer-cdp.js`：exit 0，35 項 PASS。實測分頁增刪、獨立歷史、切 App 頁面保留、首頁中鍵另開、Ctrl+T/W、真實磁碟容量、首次預設首頁；深／淺／800px 截圖無水平溢出；分頁操作無未處理 renderer 例外。
- 14 支修改／新增 JS 通過 `node --check`，`git diff --check` 通過；截圖在 `dist/explorer-tabs-qa/`。
- 邊界：分頁不跨 App 重啟還原；本輪未提交、合併或發行。此隔離工作樹未建置 sensors／hook sidecar，未驗證硬體功能與 NAS 寫入；使用者安裝版與根工作樹未改動。
# 2026-09-19 — 捷徑、檔案圖示、滑鼠側鍵

- [x] 資料夾捷徑在目前檔案分頁開啟，失效／循環捷徑顯示錯誤
- [x] 清單與格狀檢視顯示 Windows 圖示，限制同時讀取數量
- [x] 滑鼠側鍵依目前分頁的歷史前進／返回
- [x] 回歸先紅後綠，打包與隔離背景驗收

Review（2026-09-20）：
- `node scripts/test-explorer-shortcuts.js`：修正前失敗（捷徑沒有回傳資料夾目的地）；修正後 PASS，含多層／循環／失效捷徑、路徑列、資料夾圖示與保留檔案捷徑啟動方式。
- `node scripts/test-explorer.js`：186 passed, 0 failed；`node scripts/test-explorer-page-state.js`：PASS。
- `npm run electron:pack -- --config.npmRebuild=false`：exit 0，213 支來源檔與 asar 一致；此工作樹 `dist/win-unpacked` 已更新。
- `node scripts/e2e-explorer-cdp.js`：舊包先在真實 .lnk 解析失敗；新包 44 項 PASS。真實 Windows .lnk 在目前分頁開啟，檔案圖示在 list/grid 均載入，CDP `Input.dispatchMouseEvent` back/forward/back 保留 App 網址，分頁與深淺／窄版回歸全過。
- 截圖改用既有 workspace 探針的 `capturePage({ stayHidden, stayAwake })` 方式，解決隱藏視窗 CDP 截圖等待；圖片在 `dist/explorer-tabs-qa/icons-list.png`／`icons-grid.png`。
- 邊界：未操作實體滑鼠；程式／一般檔案捷徑仍沿用原捷徑開啟，以保留啟動參數。未提交、合併或發行，未改使用者安裝版與主工作樹。

## 2026-09-20 工作區：執行腳本、瀏覽器、Git 面板、diff 切換

- [x] 1 檔案樹可以執行檔案：`.exe`／`.lnk` 走 `shell.openPath`；`.cmd`／`.ps1` 開終端機跑；`.js`／`.py` 仍開編輯器
- [x] 2 內建瀏覽器補上：每個分頁一顆 webview（各自歷史與捲動）、上一頁／下一頁／停止、載入中、錯誤頁、devtools、快捷鍵
- [x] 3 Git 面板：動作鈕跟著側欄寬度換行（180px 也不疊字）；最近提交可展開看變更檔案
- [x] 4 檢視變更不新開分頁：同一個檔案在「編輯 ⇄ 變更」之間就地切換
- [x] 5 回歸：test-workspace.js（parseLog 帶檔案清單）、test-workspace-ui.js（版面／切換契約）

Review：工作在 `.claude/worktrees/ws-browser-git-exec`（分支 `worktree-ws-browser-git-exec`），尚未合併、尚未 `electron:pack`。
`node scripts/test-workspace.js` 260/0；`node scripts/test-workspace-ui.js` 176/0。
`.js`／`.py` 點下去仍開編輯器（右鍵才跑）；`.cmd`／`.ps1` 點下去會開終端機，要改內容走右鍵「開啟」。

# 2026-09-20 — 三工作樹驗收與整合

- [x] 審查 explorer-shell、ws-browser-git-exec、usage-sysmon，驗證各自修改
- [x] 整合變更並解決衝突，打包與隔離背景驗收
- [x] 提交、合併至 master、推送並核對遠端
- [x] 清理已完成分支與工作樹，保留仍在使用的資料

Review（2026-09-20）：

三個工作樹先前被誤刪，從 `dist/merge-qa-20260920/*.patch`（已追蹤檔）、Codex session 的
`Get-Content` 輸出（5 支 JS ＋ `Program.cs`／`ShellMenu.cs`）與 Claude session 的 Write/Edit
重放（其餘 4 支 `.cs`）拼回。`.cs` 那份落後最終版一步，照呼叫端補回 5 個 Win32 宣告
（`CMF_EXPLORE`／`CMF_ITEMMENU`／`CMF_SYNCCASCADEMENU`／`MF_BYPOSITION`／`GetMenuStringW`）。
未追蹤檔另備份在 `dist/merge-qa-20260920/explorer-shell-untracked.tgz`。

三份工作出自 Grok CLI 的三個 session，需求逐項核對過都已落地：殼層右鍵（WinRAR／7-Zip／
傳送到）與 Drive 綠勾、工作區執行檔案與瀏覽器導覽與 Git 面板換行與 diff 就地切換、
Gemini 3.8 Flash 與 Kimi K3 單價與快取花費拆開與多硬碟分卡。

合併只有 `tasks/todo.md` 衝突（兩邊各自的紀錄），程式碼零衝突。

驗證（合併後的 master，打包版走 `dist/win-unpacked`）：
- 單元／整合：test-explorer 186、test-explorer-shell 26、test-workspace 260、
  test-workspace-ui 182、test-sysmon 188、test-code-usage 158、test-ipc-invoke 11、
  test-error-hygiene 85、test-safe-rm 6、test-temp-hygiene 2
- 真流量：e2e-sysmon 63（兩顆 NVMe SMART）、e2e-code-usage 16、
  probe-explorer-shell 實測 WinRAR／7-Zip／傳送到都有子項、
  probe-explorer-shell-icon 拿到 Drive 綠勾（槽 14、171 綠像素）
- 打包版 CDP：e2e-cdp-smoke 22、e2e-explorer-cdp 48、e2e-workspace-cdp 179、
  e2e-sysmon-cdp 114、e2e-usage-cdp 23

`npm run electron:pack` 通過（asar 驗證 216 支 src 檔逐位元組相同）；`resources/shell/`
要先 `npm run build:shell` 才會進預覽包，沒建的話右鍵少殼層那幾項、資料夾維持 emoji。

邊界：未發行（沒有 bump 版本、沒有 tag、沒有 release）。`.claude/worktrees/` 下那兩個
工作樹與它們的分支、以及中轉用的 `feat/merged-three` 已清掉；`VoiceInk-usage-sysmon`
連同 `feat/usage-sysmon` 保留（那份開在專案外，內容已合併，要不要收由你決定）。

# 2026-09-20 — 瀏覽器分頁跨專案停放 ＋ 方格縮圖

- [x] 切走專案時停放瀏覽器 webview（依 projectId+tabId），切回來不重載、不用再按前往
- [x] 方格檢視對圖片／影片／其他檔案類別與資料夾都問殼層縮圖，不再用副檔名白名單
- [x] 關掉分頁或移除專案才收掉 webview
- [x] 清理已合併工作樹 `vi-wt-size`／`vi-wt-attr`／`vi-wt-pending`
- [x] 測試先紅再綠；打包版工作區 CDP 驗切專案瀏覽器還在

Review：
- 切專案時瀏覽器 webview 依 `projectId::tabId` 停放，切回來不重載
- 方格檢視每個可見列都問殼層縮圖（含資料夾）
- 已刪 `vi-wt-size`／`vi-wt-attr`／`vi-wt-pending` 與對應分支
- 驗證：`test-explorer-icons-state.js` 3/0（修前紅）、`test-workspace-ui.js` 185/0（修前 3 紅）、
  `test-workspace.js` 271/0、`test-explorer.js` 295/0、
  打包 asar 217 支一致、打包版工作區 CDP 184/0（含停放斷言）、
  打包版檔案總管 CDP 90/0

# 2026-09-20 — 接續檔案總管三包整合

- [x] 還原交接與確認 merge 中斷點，保留兩方測試
- [x] 三位子代理分別審查資料夾大小、真實屬性與縮圖重試
- [x] 修復確認問題，重建 shell、打包與隔離 CDP 驗收
- [x] 完成三包合併（50cb491）、更新交接
- [x] 清理三個已合併工作樹（`vi-wt-size`／`vi-wt-attr`／`vi-wt-pending` 與對應分支已刪）

Review：
- 巢狀 `readdir`／`lstat` 失敗改標 `incomplete`，不再當成完整大小
- 縮圖：切清單／方格時晚到回覆改走目前佇列；離開檔案頁清掉重試
- `CLAUDE.md` 改成只指向 `AGENTS.md`
- 驗證：`test-explorer-size-errors.js`、`test-explorer-icons-state.js` 2/0、
  `test-explorer-shortcuts.js`、`test-explorer-page-state.js`、
  `test-explorer.js` 295/0、`test-workspace.js` 271/0、
  打包 asar 217 支 src 一致、打包版檔案總管 CDP 90/0、
  打包版工作區 CDP 183/0
# 2026-09-21 — 參考 Files 完成檔案總管五批改進

- [x] 第1批：操作中心（進度、逐筆結果、取消、撞名策略、復原）
- [x] 第2批：分頁瀏覽狀態持久化（選取、捲動、搜尋、排序，含重開還原）
- [x] 第3批：大型資料夾分批載入／虛擬清單，搜尋加類型・大小・日期・位置篩選
- [x] 第4批：Markdown／PDF／影音預覽，空白鍵開、換檔不殘留、關閉釋放、詳情欄收合
- [x] 第5批：雙欄左右獨立狀態與跨欄複製／搬移；批次改名前後預覽與撞名檢查
- [x] 共用接線：`explorer-page.js`、`index.html`、`main.css`、preload／IPC 契約
- [x] 驗收修掉的 5 個真 bug（見下方 Review）
- [x] 回歸：27 支單元測試 0 失敗、`e2e-explorer-cdp.js` 全過、
      `e2e-workspace-cdp.js` 184/0、`test-asar-lock.js` 8/0（`npx electron`）
- [x] packaged CDP：`e2e-explorer-files-plan-cdp.js` 重寫成真的驗五批，53 項全過

Review：

子代理交付時單元測試全綠，但**打包版的檔案頁整頁載不起來**，而他們留下的
「五批打包版回歸」其實是 `e2e-explorer-cdp.js` 的複製品（章節清單 diff 完全相同，
只是多種 2,200 個檔案），沒有一條碰到新功能。那支腳本已重寫成真的走五批的
使用者動作，驗收過程另外挖出 4 個只在真畫面才現形的 bug：

1. **`explorer-operations.js:1` 的 `import '../styles/explorer-operations.css'`**
   ——打包版用 `file://` 直接載原始 ES module，CSS 不是 JS module，
   `explorer-page.js` 整條 import 鏈 `Failed to fetch`，檔案頁完全空白。
   改掛 `index.html` 的 `<link>`；守門加在 `test-explorer-operations-ui.js`
   （掃 `src/renderer/scripts/*.js` 不准 import 非 JS）。
2. **`loadVisiblePages()` 在「要顯示的頁都已載入」時 return 而不重畫**
   ——2,600 筆的資料夾往下捲，DOM 永遠停在最前面 29 列，後面整片空白。
   守門加在 `test-explorer-browse-wiring.js`。
3. **`paintList()` 在 `replaceChildren()` 之後才讀 `scrollTop`**（已被歸零）
   ——虛擬清單每次重畫彈回頂端。改成重畫前先記；`loadDir` 結尾改成無條件把
   `scrollTop` 設回分頁記的值，避免沿用上一個資料夾的位置。
4. **`switchTab` 沒帶 `keepSelection`**——切回分頁選取被清空，正是第 2 批要修的事；
   同時把「拿只載了第一頁的清單去裁選取」改成沒載完就不裁。
5. **`saveSecondPaneState()` 在雙欄沒開時也存**——把預設的「本機」寫進 `paneStates`，
   下次按「雙欄」還原成空的本機而不是目前資料夾。開頭補 `if (!dualPane) return`。

驗收邊界（未做，如實列出）：
- 真 NAS 的複製／搬移／取消沒測（只有本機與 C:→D: 跨磁碟 probe）。
- 打包版的取消驗的是「按得下去＋收在終局狀態＋檔案不壞」；真正的取消語意由
  `test-explorer-operations.js` 與 `probe-explorer-operations-cross-volume.js` 保證
  （同一顆磁碟的搬移是 rename，一瞬間結束，按不到取消）。
- 影音預覽只驗元素掛得起來與關閉後收乾淨，沒驗播放。

---

## 檔案總管：雙欄「根本沒法用」（2026-09-21）

實測證實右欄只是一份唯讀清單：右鍵選單、鍵盤、拖放全部沒綁；上面那排指令列、
狀態列、詳情欄、貼上、新增資料夾、側邊欄的位置／磁碟導覽，一律只對左欄生效。
右欄能做的只有四顆跨欄搬移鈕。

修法是引入**作用欄**（`activePane`）：點過哪一欄，既有那一整套就對那一欄生效，
不另外複製一份右欄專用的流程。

- 右欄補上右鍵選單、方向鍵／Enter／Backspace／Delete／F2、可拖出去、可拖進來。
- `selectedEntries()`／`paintStatus()`／`paintCmdBar()`／`pasteHere()`／`newFolder()`／
  `newFile()`／`openContextMenu()` 改吃作用欄的 cwd 與選取。
- `refreshAfterMutate()` 雙欄時兩邊都重讀。
- 作用欄加外框，看得出指令列現在在操作誰。

順手修掉兩個既有 bug：
1. `onSecondDoubleClick` 用 `.find()` 掃稀疏陣列——大資料夾未載入的頁是洞，
   `find` 不跳洞，雙擊會 TypeError。改成先 `.filter(Boolean)`。
2. `paintSecondPane()` 每次重畫都把「不在已載入列裡」的選取砍掉——大資料夾捲一下
   選取就沒了（左欄沒這個動作）。整段拿掉，裁切交給 `loadSecond`。

地雷：四顆跨欄鈕長在右欄裡，按下去 mousedown 會先把作用欄切成右欄，所以
`copyBetweenPanes` 的來源不能用 `selectedEntries()`，要指名左欄／右欄。

驗收：`node scripts/e2e-explorer-dual-cdp.js` 15 條全綠（跑原始碼時先起 vite，
再用 `VOICEINK_EXE=node_modules/electron/dist/electron.exe`）。

### 後續：把上面「未做」的那五件補完（同日）

- **右欄分頁**：`secondTabs`／`secondActiveId`，每頁自己的路徑、歷史、選取、捲動、排序、
  檢視、搜尋；整組再按左欄分頁存進 `paneStates`。中鍵點資料夾＝開右欄新分頁。
- **麵包屑**：`#exSecondCrumbs`（帶 `data-path` 給測試看）＋點一下變路徑輸入框，
  取代原本用對話框問路徑的作法。
- **圖示檢視**：右欄自己的 `view`／`tile`，☰▦ 兩顆鈕＋Ctrl+滾輪，跟左欄共用
  `explorer-zoom.js` 的級距；列也改成跟殼層要真圖示，不再只有 emoji。
- **整機搜尋**：右欄搜尋框加「範圍」鈕，切到整機就走 UFFS（跟左欄共用篩選條件），
  結果畫在右欄、顯示完整路徑。
- **拖到資料夾列**：右欄的資料夾列各自是放置目標，停 0.7 秒會自己進去。

過程中順手修掉：換資料夾沒把右欄捲動位置歸零，虛擬清單會停在上一個資料夾的位置、
畫出一整片空白。

地雷：
1. 排序的原生 `select` 會被 `custom-select.js` 換成自訂下拉，`.ex-second-sort` 的寬度管不到，
   要改 `.custom-select[data-select-id="exSecondSort"] .custom-select-trigger`——
   不改的話它吃 `min-width: 180px`，右欄標頭會胖到 200px 高。
2. 多一條右欄分頁列之後，測試裡的 `.ex-tab` 會同時選到兩邊，左欄的斷言要寫成
   `#exTabStrip .ex-tab`。
3. 三支 explorer e2e 現在都能跑原始碼（`VOICEINK_EXE` 指到 `electron.exe` ＋先起 vite），
   並在連上 CDP 後把視埠固定成 1280×860；不固定的話詳情欄會被 900px 的 media query
   整個收掉，用實體滑鼠座標的測試也會失準。

驗收：`e2e-explorer-dual-cdp.js` 25 條、`e2e-explorer-files-plan-cdp.js` 53 條、
`e2e-explorer-cdp.js` 102 條全綠。`e2e-explorer-cdp.js` 的 [C8] 資料夾監看偶發時序失敗，
同一份程式碼重跑就過，不是這次改動造成的。

### 再後續：右欄的指令列與篩選面板，外加回收筒還原與 Enter 確認（同日）

- **右欄自己的指令列**：`#exSecondCmdBar` 長在右欄裡，跟 `#exCmdBar` 共用
  `paintCmdBarInto(bar, which)`，選取與「貼上」可不可按都按那一欄算。動作本身仍看作用欄，
  所以 `addCmd()` 的 click 先 `setActivePane(which)` 再跑——不先切的話，站在右欄時按
  左欄的「貼上」會貼到右欄去。
- **右欄自己的篩選面板**：`searchFilters(which)` 只差 id 前綴（`exSearch*`／
  `exSecondSearch*`）。右欄那組 `<details>` 只在整機搜尋時顯示，切回「篩這個資料夾」
  就收起來，免得把窄窄的右欄標頭擠爆（標頭還是 93px）。
- **資源回收筒還原不了（真 bug）**：`recycle.restore()` 檢查父資料夾能不能寫，而磁碟
  根目錄被 `isSystemLocked` 當成鎖住的位置，所以從 `D:\` 刪掉的東西一律 `PROTECTED`。
  實測使用者的回收筒裡 4 筆全是 `D:\` 來的＝整個回收筒等於壞掉。改成只看目的地自己。
  第二層：`mkdir('D:\', { recursive: true })` 吐 `EPERM`，所以父資料夾在就不要補。
- **Enter ＝確定**：`app-dialog.js` 在 `<dialog>` 掛 capture 階段 keydown，Enter 一律
  `close(OK)`。危險彈窗焦點仍停在「取消」，但 Enter 會確定（不 `preventDefault()` 的話
  Enter 會先觸發焦點那顆鈕＝取消）。選字中的 Enter 照樣放行（`isComposing` 或
  `keyCode === 229`）。
- **Claude Code 的終端機**：`~/.claude/settings.json` 的 `"tui"` 從 `fullscreen` 改成
  `default`，開起來就是一般新視窗而不是 Agent View。

驗收：`test-explorer.js` 296 條、`e2e-app-dialog-cdp.js` 10 條、
`e2e-explorer-dual-cdp.js` 35 條、`e2e-explorer-files-plan-cdp.js` 53 條、
`e2e-explorer-cdp.js` 102 條全綠。

地雷：`e2e-explorer-cdp.js` 的 [C8]「資料夾監看有在跑」偶發會紅。這次把改動前的版本
（1bdb439）放回去跑，同樣會紅，所以不是這批改的；改完的版本連兩次 102 全綠。腳本現在
會在紅的時候把當下的清單與磁碟內容印出來，下次不用再從零查。
