# 2026-09-20 — 檔案總管殼層選單 ＋ Google Drive 綠勾

- [x] sidecar：`IContextMenu` 讀 7-Zip／WinRAR／傳送到；overlay 改 `SHGFI_ADDOVERLAYS`
- [x] 「傳送到」空選單：`CMF_SYNCCASCADEMENU` ＋ IContextMenu3 沒填再退 IContextMenu2
- [x] 玻璃選單合併殼層項（去重 App 自己的開啟／剪下複製）
- [x] 可見列圖示走疊好的殼層圖（Drive 綠勾）；沒 sidecar 降級
- [x] 驗證：`test-explorer-shell.js` 26/0、`test-explorer.js` 186/0；probe 看到 WinRAR／7-Zip／傳送到；Drive `學校的資料` overlay 槽 14、PNG 2038 bytes

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
