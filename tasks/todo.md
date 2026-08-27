# GPU 套件改解到 userData

## 規劃

- 不可寫 Program Files 的 asar.unpacked
- 第一次開 GPU 拷到 `%APPDATA%/voiceink/native-modules/`，用 registerHooks 導 import

## 實作

- [x] `src/main/llama-addon.js`
- [x] pack + `test-llama-addon.js` + smoke 22/22

---

# 再開一次啟動

## 規劃

- 開窗不擋 store；重模組 lazy require；非聊天頁延後載入
- 縮小 asar.unpacked（ffmpeg／vulkan／llama 原始碼不要開機就被掃）

## 實作

- [x] main.js 立刻 show、lazy IPC
- [x] renderer dynamic import
- [x] ffmpeg 拷到 userData；GPU vulkan 延後 unpack
- [x] pack + probe-startup + smoke

## 驗證

- `node scripts/probe-startup.js` → 第二次 434ms
- `node scripts/e2e-cdp-smoke.js` → 22/22
- `node scripts/e2e-agy-cdp.js` → 27/27
- unpacked 447MB → 66.5MB

## 回顧

真正拖 20 秒的是 Defender 掃 unpacked CUDA／ffmpeg／vulkan DLL，不是某一行 JS。`asar.smartUnpack: false` 才能讓 ffmpeg／`.node` 留在 asar。

---

# 額度拖曳對齊 Token Anxiety（overlay + 鬼影預覽）

## 規劃

- 跟手 overlay 不透明、格子裡 18% 透明鬼影當落點預覽
- 碰撞 pointerWithin → closestCenter，門檻 1px
- 不再把同一張卡又 translate 又改槽位

## 實作

- [x] `pickCollision` + overlay/鬼影
- [x] 單元測試與 CDP
- [x] pack

## 驗證

- `node scripts/test-usage-reorder.js`
- `node scripts/e2e-usage-cdp.js`

---

# 額度拖曳閃爍 ＋ AGY 模型名稱排序

## 規劃

1. 額度卡拖曳偶發閃爍：FLIP 未取消進行中動畫就量 last、CSS hover `translateY(-2px)` 與 transform transition 跟 WAAPI 打架、DOM 重排後被拖卡片的 transform 相對舊槽位。
2. AGY「可用模型」：Claude 池（含 GPT OSS）與 Gemini 分組；世代由新到舊，Gemini 同代依思考強度高→低。

## 實作

- [x] 額度 FLIP：量 last 前取消進行中動畫；重排後立刻校正被拖卡片；排序中關掉 hover lift 與 transform transition
- [x] AGY 型錄：Claude 池（含 gpt-oss）與 Gemini 池分組；世代新到舊，Gemini 同代思考強度 high→lite
- [x] 測試：`test-usage-reorder.js`、`test-agy-mappers.js`；打包 `electron:pack`

## 驗證

- `node scripts/test-usage-reorder.js` → 10 passed
- `node scripts/test-agy-mappers.js` → 47 passed（含型錄排序 3）
- `npx electron scripts/e2e-agy.js` → 79 passed
- `npm run electron:pack` → 成功
- `node scripts/e2e-usage-cdp.js` → 9 passed（含拖曳 FLIP）
- `node scripts/e2e-agy-cdp.js` → 27 passed（列出 23 個模型且依名稱排序）

## Review

- 閃爍不是 FLIP 時長不夠，是進行中的 invert 被下一輪蓋掉、再加上 hover transform 與「先清 none 再量」。
- 模型排序不能只 `localeCompare`：GPT OSS 會掉到 Gemini 後面，Gemini `3.10` 會排到 `3.2` 前面。
- 改動範圍：`usage-reorder.js` / `usage-page.js` / `main.css` / `agy/catalog.js` 與對應測試、文件。

---

# 使用者可見前端 UI 缺陷修復（2026-08-26）

## 規劃

- [x] 逐頁稽核桌面、900px、640px 版面與深淺主題
- [x] 確認可重現的可見缺陷與根因
- [x] 只修改 renderer 的必要 HTML／CSS／前端互動
- [x] 跑視覺檢查、相關 CDP 測試與 `electron:pack`
- [x] 實際檢查打包版畫面並記錄 Review

## Review

- 修正聊天刪除確認跨會話殘留、設定捷徑跳錯分類，以及無效聊天網址造成設定只存一半。
- 修正翻譯輸入／語言變更後仍顯示舊譯文、即時字幕啟動中可重複操作、轉錄進度缺少可讀狀態。
- 修正 AGY 平行請求互相清掉錯誤、長檔名溢出、disabled 狀態不明顯與觸控操作按鈕過小。
- 打包版完成深淺主題與 1440／900／560px 視覺檢查；主要 CDP 與單元測試通過。

---

# AGY 憑證卡死修復＋連線測試＋額度顯示設定與訂閱方案（2026-08-26）

## 規劃

- [x] 重現「CLI 已登入卻永遠紅字」的根因（credential.js 的 mustRefresh）
- [x] 加「測試連線」按鈕：自動挑模型、從 loopback 送一則訊息驗證整條路
- [x] 額度頂部橫條改跟隨顯示設定
- [x] 四家（OpenCode 除外）顯示訂閱方案
- [x] 補回歸測試並跑過 e2e-agy / test-usage / 三支 CDP
- [x] `electron:pack` 更新免安裝預覽

## Review

- 根因：`credential.acquire` 失敗時呼叫 `invalidateToken()`，把「上游回過 401」專用的 `mustRefresh`
  旗標拿來當一般的清快取用。任何暫時性失敗（PowerShell 讀憑證逾時、loadCodeAssist 抖動）之後，
  每一輪都強制 refresh；沒有 client id／secret 時 refresh 必回 null，於是一律拋 `TOKEN_EXPIRED`。
  重登 CLI 沒用（旗標在記憶體），只有重開 App 才會好。改成失敗只清 token 快取。
- 新增 `agy:test`：main 取即時型錄挑一個還有額度的對話模型，用本機閘道的 `/v1/chat/completions`
  真的送一則訊息（走完整條 HTTP → 鑑權 → 映射 → 憑證 → 上游），成功就把模型回覆秀在頁面上。
  失敗只回代碼與我們自己寫的訊息。`main.js` 的 service 白名單同步補 `selfTest`（漏補會變通用錯誤）。
- `renderSummary()` 改用 `visibleAccounts()`，頂部橫條與卡片同一份來源、順序一致。
- 訂閱方案：Claude 改讀 `.credentials.json` 的 `subscriptionType`、Codex 改讀 id_token 的
  `https://api.openai.com/auth` claim、Grok 退回 access token 的 `tier`；顯示在卡片 footer，
  OpenCode 不顯示（沒有訂閱方案概念）。實測結果：Claude Pro／ChatGPT Plus／Google AI Pro／Tier 1。
- 順手修兩支 CDP 腳本的環境假設：`e2e-usage-cdp.js` 進頁前沒等 render 完成（抓到脫離文件的節點）、
  `e2e-agy-cdp.js` 假設服務一定是停的且測完不還原使用者的埠與開關。

## AGY 接 Claude Code（CC Switch）— 2026-08-27

- [x] 用 mock server 錄下 Claude Code 真正送的 `/v1/messages` body（195 個 MCP 工具、~300KB）
- [x] 逐一比對上游 400，定位到 `sanitizeSchema` 的三種型別問題
- [x] 修 `agy/gemini.js`：type 陣列、非字串 enum、anyOf 的 null 變體
- [x] 補三條回歸測試（`test-agy-mappers.js` 50 passed）＋ `e2e-agy.js` 85 passed
- [x] `electron:pack` 更新免安裝預覽並重啟服務
- [x] 修好 CC Switch 的 `antigravity` 供應商設定（base URL 去掉 `/v1`、模型分派、`[1m]` 後綴）
- [x] `claude -p` 實跑純文字與工具呼叫，全鏈路驗證通過

### Review

- 根因不是鑑權也不是協議轉換：白名單只擋「欄位名不對」，擋不住「欄位名對、型別不對」。
  Gemini 的 Schema proto 比 JSON Schema 窄，`type: ['string','null']`（proto 的 type 不是 repeating）、
  `{type:'boolean', enum:[true]}`（enum 只吃字串）、`anyOf` 裡的 `{type:'null'}`（沒有 null 型別）
  三種寫法都會讓整包請求 400——**一個工具寫壞，195 個工具一起陣亡**，所以一般聊天（無工具）完全正常。
- 修在 `sanitizeSchema` 一處，兩個協議共用；約束丟掉還有 description 撐著，比整包被拒好。
- 驗證方法可重用：錄下真實 body → 對 390 個工具的 sanitize 結果做 proto 欄位靜態掃描（0 問題），
  不必每次都打上游燒額度。
- CC Switch 的坑：`ANTHROPIC_BASE_URL` 帶 `/v1` 會變成 `/v1/v1/messages` → 404；
  非 Claude 模型名要加 `[1m]`（CLI 會自己剝掉再送上游）否則被當 200k 窗口。
- 代價：逐一探測 195 個工具把 Antigravity 的 claude 池額度打到 429（約 4 小時後重置）；
  下次應該用二分法夾出問題工具，不要逐一打。

## AGY 統計面板優化 ＋ CC Switch 提示 — 2026-08-27

- [x] `logs.stats({ range })`：範圍白名單（6h／24h／7d／30d／all），summary／series／models 套同一 cutoff；序列補零（≤48h 用小時桶、其餘用天桶）→ 驗證：`e2e-agy.js` 新斷言
- [x] `index.js getStats(range)`／`ipc.js`／`preload` 傳遞範圍；範圍在 main 驗證，renderer 只送 key
- [x] 統計面板：範圍切換（segmented）、模型分佈移到長條圖下方（單欄）、卡片與圖表壓縮高度
- [x] 長條圖 hover／focus 顯示數量（自訂 tooltip，取代 `title`）
- [x] 服務控制區加「接 Claude Code（CC Switch）」提示：Anthropic 端點不帶 `/v1`，OpenAI 端點帶 `/v1`
- [x] 驗證：`e2e-agy.js` 90、`e2e-agy-cdp.js` 33、`e2e-visual-cdp.js` 43、smoke 22、`electron:pack`

### Review

- 頁面原本只給一組帶 `/v1` 的 Base URL，旁邊卻寫「Claude Code 用 ANTHROPIC_BASE_URL」——
  提示本身就是那次 404 的源頭。改成兩組分開列，各自附上「要／不要帶 `/v1`」與原因。
- 統計面板先前的口徑是混的：卡片與模型分佈算「全部時間」、長條圖算「近 24 小時」。
  現在三者共用同一個 cutoff，範圍由 main 白名單決定（renderer 只送 key）。
- 序列補零是這次最有價值的修正：SQL 只回有資料的桶，3 筆請求會被攤成整條 24 小時軸，
  看起來像整天都在跑；補零之後長條圖的疏密才是真的。
- 順手修掉 `.agy-model-row` 撞名（統計改用 `.agy-dist-row`）：「可用模型」面板的同名規則
  把分佈列改成 flex row，進度條整條看不見——左右並排時就已經壞了，只是不明顯。
- `e2e-agy-cdp.js` 的「協議篩選」原本假設 DB 裡沒有 Anthropic 流量（斷言篩完剩 0 列）。
  正式 profile 跑過 Claude Code 之後就會失敗；改成驗「留下的每一列都是 Anthropic」。

## 聊天頁版面重整 ＋ 側欄排序 — 2026-08-27

- [x] `e2e-agy-cdp.js` 不再呼叫 `clearLogs()`（跑在正式 profile 上，會刪掉真實流量與統計）
- [x] `chat-store`：陣列順序＝顯示順序（`list()` 不排序、`create()` unshift、`writeAll` 用 filter 淘汰）
- [x] `chat-store.reorder(ids)` ＋ `chat:reorder` IPC ＋ preload
- [x] 側欄每一列加改名（就地輸入框）與刪除（按鈕就地二次確認，不用原生彈窗）兩顆 icon 鈕
- [x] 側欄 pointer 拖曳排序（沿用 `usage-reorder.pickCollision`）＋ Alt+↑／↓ 鍵盤排序
- [x] 系統提示（含 ⚙）與模型選單移到輸入框那一排；上方工具列整排移除
- [x] 驗證：`e2e-chat.js` 117、`e2e-chat-cdp.js` 42、smoke 22、visual 43、`electron:pack` ＋ 四張截圖

### Review

- 側欄順序如果還讓 `list()` 依 `updatedAt` 排，拖好的順序會在下一次回訊息時被洗掉；
  所以順序改成「`chats.json` 的陣列順序」，`writeAll` 只在超過上限時 `filter` 掉最舊的，
  不能把排序後的陣列直接落盤。
- 拖曳沒有自己再寫一套碰撞：`usage-reorder.js` 的 `pickCollision`（pointerWithin → closestCenter）
  直的橫的都能用，640px 以下側欄變成橫向捲動也照樣正確；`mergeVisibleOrder` 則負責搜尋
  狀態下把沒顯示的對話塞回原相對位置。
- 改名輸入框要自己吃掉 `pointerdown`，否則在裡面拖曳選字會被當成排序。
- 兩顆按鈕原本用 `✎`／`🗑` 文字字元，Segoe UI 下 🗑 會縮成一條看不出是什麼的細線
  （截圖才看出來）→ 改成跟 composer 同一套 stroke SVG。
- `e2e-agy-cdp.js` 的清空日誌斷言是這次一併修掉的：它跑在使用者的正式 profile 上，
  等於每跑一次驗收就把真實流量紀錄刪光。清空行為本來就有 `e2e-agy.js`（暫存 DB）覆蓋。
- 刪除原本沿用供應商那套 `window.confirm`，實機一看就知道不行：原生彈窗會擋住整個 App、
  標題還是「voiceink」，跟 Aurora 完全不搭。改成按鈕自己變紅勾的二次確認，不必多開 `<dialog>`。
