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
