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
