# tasks/todo.md — 規劃與回顧

> 只留「還沒做完的」與「最近幾輪做了什麼、驗到什麼」。更早的逐項紀錄查 git log。
> 規則見 [CLAUDE.md](../CLAUDE.md)（＝AGENTS.md），架構見 [CONTEXT.md](../CONTEXT.md)，教訓見 [lessons.md](./lessons.md)。

## 待辦

從 2026-09-05 的「最近更改修復與整體驗收」留下來的；前四項在第九～十二輪已大致涵蓋，
但沒有逐項對照驗收過，保留在這裡當清單。

- [ ] 對照 Orca 檢查專案工作區的開檔、切換、草稿與 Git（第九～十二輪已重寫大部分）
- [ ] 感測器自動啟動、隱藏視窗與重連，驗證風扇安全交還
- [ ] 獨立對帳真實用量來源（`probe-code-usage-audit.js` 已對過 Claude 與 Grok，其餘三家未逐輪核銷）
- [ ] 全庫回歸與安全審查，修復 UI 錯誤並簡化操作與文案
- [ ] 每輪收尾：`build:sensors` ＋ `electron:pack` ＋ 打包版背景 CDP 驗證
- [ ] 每輪收尾：同步文件，記錄實際驗證結果與限制

---

## 2026-09-07 — 沙箱測試與文件精簡

- [x] `scripts/dev-sandbox.js` ＋ `npm run dev:sandbox`：另一份 userData、模型 junction 接回、
      設定與專案清單複製、三個會外溢的開關強制關掉、寫入前先 `rm` 目的地
- [x] `scripts/probe-dev-sandbox.js` 實測：安裝版跑著時沙箱起得來、讀得到供應商／模型／專案，
      真 userData 指紋前後不變
- [x] `ws-git-status.js`：`git status` in-flight 去重 ＋ 500ms 短快取，切分頁不再重打
- [x] 聊天側欄拿掉多餘的「只看這個專案」按鈕
- [x] CLAUDE.md 與 AGENTS.md 合併成同一份（1372 → 289 行），CONTEXT.md、lessons.md、todo.md 一併精簡
- [x] 測試 fixture 的機器名／MAC／內網 IP／序號改成佔位值，文件裡的本機絕對路徑改成示意路徑

**回顧**：`probe-dev-sandbox.js` 8/8（含「全程沒有動到你正在用的那份 userData」）；
`test-workspace-ui` 79、`test-workspace` 219、`test-sysmon` 176、`test-error-hygiene` 82、
`test-ipc-invoke` 11、`-nav`／`-state` PASS。
寫沙箱腳本時自己踩到一次：`copyFileSync` 會跟著符號連結寫到對面去，
沙箱裡若有一條指回真 userData 的連結，這支「保護資料」的腳本就會親手覆寫使用者的設定 →
每次寫入前先 `rm` 目的地，並用「故意種一條連結」的紅燈驗過。

## 2026-09-07 — 工作區變更入口、檔案樹狀態、尋找列 tooltip

- [x] 檔案樹重畫時沿用 `gitStatus`，檔案標「改／新／衝突」、資料夾標 `改 N`，點標記開既有 Diff
- [x] 編輯器工具列「看未提交變更」（沿用 `openDiffTab`，依暫存／工作區選比較面）
- [x] `is-workspace` 緊湊佈局；切回聊天時收起右側欄與拖曳把手
- [x] 尋找列 tooltip 的 `.context-view` 被 `fixedOverflowWidgets` 放到 host 外 →
      用 `body:has(.find-widget.visible)` 限定範圍讓外層穿透滑鼠

**回顧**：先讓新增契約失敗（`test-workspace-ui` 68 passed／5 failed）再修，完成後 73／0。
驗證 `test-workspace` 219、`-state`／`-nav`／`-editor` PASS、`e2e-workspace-cdp` 162/162、`electron:pack` 成功。

## 2026-09-06 — 第十二輪：專案真的管住工作內容 ＋ 日常開發流程

- [x] 對話與終端機的專案歸屬（`chats.json`／`terminals.json` 各多一個**可選** `projectId`，缺值＝未分類）
- [x] AI 記錄可閱讀可接續：工具細節收合、標出來源與截斷、讀過／改過分開；接續由 main 驗專案歸屬
- [x] 修正記錄來源：`CODEX_HOME`／`CLAUDE_CONFIG_DIR`／別的工作台的 runtime home 三處都掃、照 `agent + id` 去重
- [x] 選取內容帶入聊天（`chat:insert`）；`workspace/watch.js` 自動更新畫面
- [x] worktree 補齊（`adopt`／建立後直接切過去／移除前 `check` 講得出哪幾個檔案擋著）
- [x] Git 審閱流程（merge-base 比較、上一個／下一個變更、衝突自成一組、逐行意見「交給 AI」）
- [x] 拆檔：`ws-ai-session.js`、`ws-review.js`

**回顧** — 三件「不做會出事」的：
1. **`main.js` 的 service 白名單是第三份清單**：`ipc.js`／`index.js`／preload 都對、單元測試全綠，
   `main.js` 漏一行就只回「工作區操作失敗」（這一輪的 `gitBranches` 中過）→ 補 [Q2] 把三份清單對起來。
2. **`CODEX_HOME` 真的被別的工作台改掉了**：`~/.codex/sessions` 底下一筆都沒有，
   AI 記錄列不出 Codex 對話「不是解析壞了，是根本沒去那裡找」。
3. **非 git 專案要把每一塊都清乾淨**：`renderGit` 的提早 return 留著上一個專案的分支下拉，
   按「比較」得到「這兩條分支沒有共同的起點」，看起來像 git 壞了。

紅燈驗證：`codexHomes` 改回只看 `~/.codex` → [W] 三條失敗；刪掉 `main.js` 的 `gitBranches` → [Q2] 失敗並指名；
`EDIT_TOOLS` 改成 `/.*/` → 「Read 只算讀過」失敗。三條都還原成綠。
驗證：`test-workspace` 214、`test-workspace-ui` 64、`e2e-workspace-cdp` 131、`e2e-cdp-smoke` 22、
`e2e-chat-cdp` 44、`e2e-terminal-cdp` 34、`e2e-visual-cdp` 71、`e2e-tray-cdp` 12、`e2e-ux-tweaks-cdp` 18。

## 2026-09-06 — 第十一輪：工作區的資料安全與專案切換

- [x] `resolveIn` 加 realpath 檢查（資料夾連結指到專案外一律拒絕，專案根自己是連結照樣可用）
- [x] 存檔比對磁碟版本（`expectedMtimeMs` → `STALE`，提示條四條路，草稿一個字都不能動）
- [x] 同一檔案的寫入排隊（暫存檔名帶 pid＋流水號，避開 Windows 併發 rename 的 EPERM）
- [x] 開分頁的每一次 await 之後核對 `projectSwitch`，回來再 `findTab` 一次
- [x] 改名／搬檔後 `retargetTabs`；結束時的草稿由 main 等（`workspace:flushDrafts` 排在 `killAll()` 之前）

## 2026-09-06 — 第九、十輪：Monaco、worktree、拖曳搬檔、多選、分頁跟著專案走

- [x] 編輯器換 Monaco（AMD `min/vs`、語法高亮、真正的並排 diff、尋找取代；載不起來退回 `<textarea>`）
- [x] Git 面板加 worktree 一區；檔案樹 Ctrl／Shift 多選與拖曳搬檔
- [x] 分頁列橫向溢出＋pointer 跟手＋FLIP 讓位；中鍵關閉、右鍵「關閉其他／右邊」
- [x] 側欄只列專案（終端機清單移除），終端機變成分頁列上的一顆分頁（關掉＝刪掉工作階段，要二次確認）
- [x] 分頁狀態跟著專案走（存 `workspaces.json` 的 `tabsState`），切專案只摘畫面、pty 留在 main

**回顧**：Monaco 三件事要一起做才不會「看起來壞掉但不報錯」——CSP 的 `font-src data:`（codicon）、
`worker-src blob:`（沒有 Worker 時 diff 算不出來）、`build.files` 只放行 `min/**`（asar 437 → 460MB）。
`<textarea>` 仍是存檔／草稿／外部變更偵測的來源，兩邊要雙向同步。

---

## 更早的輪次（各一句，逐項紀錄查 git log）

| 時間 | 內容 |
|---|---|
| 2026-09-05 第七輪 | 工作區適配 Orca 核心：分頁持久化、外部變更偵測、IDE 尋找取代、AI 會話卡片、拖曳遮罩修復 |
| 2026-09-04 第六輪 | 用量統計徹查：Codex 子代理重播雪崩（60 份 fork 重播出 7.8 萬筆假請求）與 Grok 花費灌水 10 倍 |
| 2026-09-04 第五輪 | 專案側欄整合、簡易 IDE、Git Diff 與多格式預覽（借 Orca） |
| 2026-09-04 | 使用時長（Tai 相容）、效能調整（第五、六子分頁）＋即時儀表、App 內自動更新、使用者回饋六點整頓 |
| 2026-09-03 | 發行 v1.10.0；八組模組 IPC 收成共用外殼；管理員終端機；CC 代理 1M 上下文＋修好 Codex 502；額度卡片依可見數排版 |
| 2026-09-02 | 新增 HF模型分頁（llama-server router）；系統監控風扇控制；額度新增 Command Code；用量統計拆 token；硬體規格 60 → 118 條 |
| 2026-09-01 | 語音輸入字典真的生效＋長篇重寫；壓力測試真的壓得滿（GPU 3% → 94–100%、記憶體 7.75 → 35GB）；供應商可切回官方訂閱；合頁後的回歸收尾 |
| 2026-08-31 | 系統監控改版（總覽⊕硬體資訊、四項壓力測試）；ccswitch 供應商頁重構；語音輸入 HUD ＋雲端 ASR 修復；三個子分頁各自的模型選單 |
| 2026-08-30 | 新分頁「系統監控」；語音輸入（復刻並超越 Typeless）；整合 cc-switch；v1.9.0 發行 |
| 2026-08-29 | UI／Design Token 全面打磨（Aurora 雙色主題、字體層級、12px 圓角、WCAG AA）；`custom-select.js` 共用下拉 |
