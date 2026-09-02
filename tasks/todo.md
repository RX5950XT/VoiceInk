# VoiceInk UI & Design Token Polish Todo

## 進行中（2026-09-03）— 清理專案目錄與專案外受影響垃圾

- [x] 1. 終止背景鎖定程序（`VoiceInk`、`VoiceInkHook`）釋放檔案鎖
- [x] 2. 清理專案內暫存與建置產物（`dist/win-unpacked-*`、`dist/win-unpacked.tmp`、`native/sysmon-sensors/{bin,obj}`，釋放 ~6.07GB）
- [x] 3. 清理專案外垃圾（`$env:TEMP` 測試與打包暫存目錄 64 個、日誌腳本 51 個、`$env:LOCALAPPDATA\voiceink-updater` 安裝檔 280MB、`$env:APPDATA\voiceink` 測試殘留 json 7 個、截斷鎖定暫存 asar 437MB，釋放 ~1.18GB）
- [x] 4. 重新執行標準免安裝打包 `npm run electron:pack`，產出單一標準 `dist/win-unpacked/VoiceInk.exe`
- [x] 5. 驗證清理成果、檢查磁碟空間釋放量與打包完整性

### 回顧

- **專案內清理（釋放 ~6.07 GB）**：
  - 清理 `dist/` 底下 7 個歷史臨時打包目錄（`win-unpacked-ccswitch`、`win-unpacked-ccswitch-final`、`win-unpacked-ccswitch-final2`、`win-unpacked-ccswitch-final3`、`win-unpacked-usage-fix`、`win-unpacked-usage-layout`、`win-unpacked.tmp`）及 debug yaml。
  - 清理 `native/sysmon-sensors/bin/` 與 `obj/`（84.57MB + 9.40MB）。
  - 保留 `resources/sensors/` 與 `resources/hook/` sidecar 執行檔。
- **專案外清理（釋放 ~1.18 GB）**：
  - 清理 `$env:LOCALAPPDATA\voiceink-updater\installer.exe`（280 MB 舊安裝檔）。
  - 清理 `$env:APPDATA\voiceink` 中 e2e/probe 產生的 7 個 `*-tmp.json` 檔案。
  - 清理 `$env:TEMP` 中 64 個測試與打包目錄（`voiceink-cdp-*`、`voiceink-smoke-*`、`electron-download-*` 等）及 51 個日誌與腳本檔。
  - 針對 Orca 鎖定之暫存 asar（`vi-pack`），以檔案串流截斷為 0 bytes，完全釋放 437MB 佔用。
- **乾淨標準打包**：
  - 終止殘留的背景測試預覽程序釋放鎖定。
  - 依 CLAUDE.md 規範以 temp 打包 ＋ robocopy ＋ asar 就地覆寫串流，重新建構標準 `dist/win-unpacked/VoiceInk.exe`，SHA256 雜湊完全吻合。
  - 驗證 `test-usage.js`（34/34 passed）與 `test-error-hygiene.js`（82/82 passed）全數通過，`VoiceInk.exe --version` 啟動正常。
  - 兩端合計共釋放超過 **7.25 GB** 磁碟空間。

## 進行中（2026-09-03）— 額度儀錶板依可見卡片數排版

- [x] 1. 在 `e2e-usage-cdp.js` 補 2～7 張卡的列／欄與窄視窗排版回歸，先確認目前固定兩欄會失敗
- [x] 2. 將可見卡片數寫入 `#usageGrid`，不改額度資料與排序流程
- [x] 3. 依卡片數固定橫向欄數，視窗縮放只讓卡片變寬／變窄
- [x] 4. 跑額度單元、CDP 與 `npm run electron:pack` 驗證

### 回顧

- 回歸測試先在舊版固定兩欄行為得到 3 張卡為 2 欄／2 列的失敗，再以 `data-card-count` 驅動 CSS grid。
- 驗證：`npm run build`、`node scripts/test-usage.js` 30/30、`npm run electron:pack -- --config.directories.output=dist/win-unpacked-usage-layout`、`e2e-usage-cdp.js` 23/23、`e2e-visual-cdp.js` 71/71、`test-usage-reorder.js` 15/15。
- 原 `dist/win-unpacked` 的 `app.asar` 被既有檔案鎖住，改用替代輸出目錄完成打包；原預覽產物未覆寫。

## 進行中（2026-09-03）— CC 代理手動閘道、格式選擇與上游測試

- [x] 1. 依官方文件確認六家上游 URL、上游格式與驗證格式
- [x] 2. 追完自動啟動閘道的切換流程，改成只由使用者手動開關
- [x] 3. 讓內建供應商可儲存／顯示上游格式與驗證格式，保留舊設定相容
- [x] 4. 依供應商選定格式建立閘道路由，加入安全的「測試響應」IPC／按鈕
- [x] 5. 把轉換閘道 UI 收斂成一顆可存取的開關
- [x] 6. 跑 CC 回歸、UI／CDP 與 `npm run electron:pack`

### 回顧

- 先讓新增的回歸測試在舊流程跑出 230 passed／11 failed，再修正格式遷移、動態路由、手動閘道與測試響應。
- 官方無金鑰探測六個端點均回 401，沒有 404；這證明 URL／格式路徑存在，但沒有冒用使用者憑證發送模型請求。Grok Build 依官方一般 CLI 範例把驗證預設修為 Chat，仍保留使用者指定的 Responses 上游預設。
- 驗證：`node scripts/test-ccswitch.js` 256/256、`node scripts/test-ccswitch-gateway.js` 53/53、`node scripts/e2e-ccswitch-gateway.js` 35/35、`node scripts/test-error-hygiene.js` 82/82、六端點探測 6/6 回 401、打包版 `e2e-ccswitch-cdp.js` 123/123、`npm run electron:pack -- --config.directories.output=dist/win-unpacked-ccswitch-final3` 通過。
- 原 `dist/win-unpacked` 的 `app.asar` 仍被既有預覽鎖住，因此保留原產物，改用替代輸出目錄完成最終打包。

## 進行中（2026-09-02）— 額度儀錶板視窗與重置時間

- [x] 1. 以官方實流量／既有 fixture 確認 Ollama Cloud 與 Command Code 的月額度資料形狀
- [x] 2. 修正 parser 與卡片顯示：補回月額度、保留真實重置時間；沒有時間就明講尚未啟動／上游未提供
- [x] 3. 更新最小回歸測試並跑額度、錯誤衛生、打包版 UI 驗證

### 回顧

- `Ollama Cloud` 改讀官方實際回傳的 `limits.monthly.usage`；`Command Code` 以 `monthlyCredits`、方案總額與 `currentPeriodEnd` 組回每月視窗。
- `resetAt` 支援 epoch 秒／毫秒；5 小時視窗用量為 0 且沒有時間時顯示「尚未啟動」，Ollama 沒有時間時顯示「上游未提供重置時間」。
- 驗證：`node scripts/test-usage.js` 34/34、`node scripts/test-error-hygiene.js` 82/82、`npx electron scripts/e2e-usage.js` 8/8、修正後 probe 通過；替代輸出目錄打包與 CDP UI 檢查通過。
- `npm run electron:pack` 原輸出目錄因 `resources/app.asar` 被鎖而回 `EBUSY`；改用 `dist/win-unpacked-usage-fix/win-unpacked` 完成打包，未覆寫既有產物。
- Command Code 真實月額度未在本機驗證：目前沒有 `COMMAND_CODE_API_KEY`／`~/.commandcode/auth.json`，fixture 已覆蓋訂閱回應形狀。

## 完成（2026-09-02）— HF模型第二輪：使用者回報四項

- [x] **nav 位置**：HF模型移到系統監控之後（五個寫死頁面清單的腳本一起改）
- [x] **探索頁改成兩欄**（左清單／右模型卡）：README、下載數／更新日期、參數量與架構、
      下載選項（每個量化的大小＋可行性＋下載鈕）一次看得到。新增 `hfmodels:detail` IPC；
      一個 repo 只抓一次檔頭（26 個變體不必打 26 次 Range）；README 先剝 HTML 與 front matter
- [x] **搜尋列版面**：`custom-select` 接管後實際佔位的是 `.custom-select`，
      「搜尋」被擠成一條、文字直排 → 收斂 `.select, .custom-select, .btn`
- [x] **執行環境一鍵安裝最佳配置**：照驅動版本挑 CUDA／Vulkan，走既有的 `models:download`；
      每一列另有「安裝」鈕（舊版只有「未安裝」四個字，按不下去）
- [x] **一鍵自動調參**（`hfmodels:autoTune`）：fit 量記憶體 → bench 實測 → 套用並重啟 router；
      模型卡與參數彈窗各一顆

**驗證**：`e2e-hf-cdp` 44 checks（+5）／`probe-hf-detail`（新，打真 HF）／
`e2e-cdp-smoke` 22／`e2e-visual-cdp` 71／`test-hfmodels` 146／`test-error-hygiene` 82

### 回顧

- 「列出一個使用者會想改變的狀態，就要在同一列給改變它的方法」——執行環境那兩列只顯示「未安裝」
  卻沒有按鈕，程式碼每一行都對，但畫面上是個死路。
- 對照組（LM Studio）要拿來數「同一個資訊要幾次點擊」，不是拿來抄版面。
  一次全算出來反而比較省：各量化共用同一份架構，檔頭只要抓一次。
- 換掉一個元件的 DOM 結構（`custom-select` 多包一層）之後，要回頭搜有誰用舊結構的選擇器在排版。

## 完成（2026-09-02）— 新增「HF模型」分頁（LM Studio 等價功能，走 llama.cpp router）

- [x] 0. `probe-hf-router.js`：實測 router 模式，決定整個架構（**全數 PASS**）
- [x] 1. `hfmodels/gguf.js`（GGUF header 解析）＋ `catalog.js`（量化／分片／mmproj）＋ `plan.js`（參數決策）
      → `node scripts/test-hfmodels.js` **61 passed, 0 failed**（含本機真檔 linguaforge08q4）
- [x] 2. `hardware.js`（`--list-devices`）＋ `hub.js`（HF API）
      → `node scripts/probe-hf-hub.js` **全數 PASS**（搜尋／tree 檔案大小／Range 206／
      前 1MB 就讀得到 arch＋層數＋訓練上下文，兩個 repo 各驗一次）
- [x] 3. `download.js`＋`library.js`＋`presets.js`（下載、meta、presets.ini）
      → `node scripts/test-hfmodels.js` **117 passed**（續傳／上游忽略 Range／大小對不上留 .part／
      取消／只走 https／INI 注入清理）
- [x] 4. `runtime.js`＋`index.js`＋`ipc.js`（router 生命週期）＋ main.js／preload 接線
      → `npx electron scripts/e2e-hfmodels.js` **24 passed**（真的起 router、載真模型、
      `/v1/chat/completions` 200 且 completion_tokens=8、不帶金鑰 401、關掉後零孤兒程序）
- [x] 5. `chat.js` 串接（synthetic provider `__local`）＋ `chat:providerOptions` IPC
      → `npx electron scripts/e2e-chat.js` **138 passed**（新增 [O]：router 沒跑時清單沒有那筆、
      跑著時多一筆、`sanitizeProviders` 擋掉存檔、關掉後退回雲端）
- [x] 6. renderer 三個子分頁（探索／模型庫／執行環境）＋ 參數彈窗（自動值／覆寫／原始參數直通）
      → `node scripts/e2e-hf-cdp.js` **39 checks**（模型庫指到暫存資料夾，不碰使用者的模型）
- [x] 7. CUDA 執行環境（`llamaruntimecuda`）＋ `bench.js` 實測調校 ＋ 資料夾可自選 ＋ HF Token
- [x] 8. 五支 CDP 腳本的頁面清單同步、`e2e-hf-cdp.js` 新增、CLAUDE／CONTEXT／README／AGENTS 更新
- [x] 9. **修掉 KV 低估 2 倍會 OOM 的估算錯誤**：`embd ÷ head_count` → GGUF 明寫的
      `attention.key_length`（實測 Qwen3.5-4B 160 vs 256、linguaforge 0.8B 128 vs 256）
      → `test-hfmodels.js` **146 passed**（新增 [D2] KV 與 [D3] 進階調參共 29 條）
- [x] 10. `fit.js`：跑官方 `llama-fit-params` 拿實測的記憶體配置，蓋掉估算
      （實測整顆放得下時它印 `-ngl -1`，要轉成 `all`；margin 夾 4095 避開 Windows 溢位 bug）

### 回顧

- **先寫 probe 再動手是對的**：router 模式如果不照文件走，退路是「每顆模型各起一個 sidecar ＋
  自己做 LRU」，那是完全不同的架構。第一步就問清楚，省掉做到一半才推翻的風險。
  換來的紅利也超乎預期——**多模態、手動拖檔、子程序回收三件事都變成零程式碼**。
- **「自己算」與「官方算」要先分清楚**：`-fit on` 是預設值，而且它只調整「使用者沒設的參數」。
  主動寫死 `gpu-layers` 等於把官方那套（會實際載一次模型量記憶體、MoE 還會產出手寫不出來的 `-ot`）
  默默關掉。估算只該用在 fit 到不了的地方：下載前的預覽、fit 失敗的退路、fit 不管的策略。
- **估算錯的方向決定代價**：KV 低估 → 以為放得下 → 載入時 OOM → 使用者只看到「載入失敗」。
  而 `embd ÷ head_count` 這個公式在多數模型上是對的，**剛好在 Qwen3 系列上錯**。
  這種「大部分時候對」的錯最難發現，只有拿真檔案去對 GGUF 欄位才抓得到。
- **同一個值被兩個用途共用時最容易漏**：`readConfig` 的 modelId 收斂看起來只是 UX，
  但 `chat.send` 的安全守衛就靠它。改成「退回第一顆」會讓 model allowlist 靜靜失效——
  是既有測試（[D] model allowlist）擋下來的，不是我自己看出來的。
- **測試隔離做對了會讓假綠燈變紅，那是好事**：`e2e-usage-cdp` 的「antigravity = 4 windows」
  一直是靠讀到使用者本機 `usage.json` 的快取才成立，換成暫存 user-data-dir 之後才現形。

### probe-hf-router.js 的實測結論（架構就押在這些上面）

| 問題 | 實測答案 |
|---|---|
| 不給 `-m` 只給 `--models-dir` 起得來嗎 | 起得來，`/health` → 200 |
| 模型 id 怎麼來 | **單檔＝檔名去掉 `.gguf`；子資料夾＝資料夾名**（不是裡面的檔名） |
| `--api-key` | 有效：不帶 401、帶了 200 |
| `--models-preset` | 吃得到；`[*]` 套全部、`[<id>]` 蓋掉它（實測 `c = 3072` → `--ctx-size 3072`） |
| mmproj | 子資料夾裡的 `mmproj-*.gguf` **自動加 `--mmproj`**，`architecture.input_modalities` 跟著變 |
| `GET /models` | `data[]`：`id`／`status.value`（unloaded｜loaded…）／`status.args`（真正的命令列）／`status.preset`／`architecture.input_modalities`／`source`（`preset`｜`models_dir`｜`cache`）；**載入後多一個 `meta`：`n_vocab`／`n_ctx`／`n_ctx_train`／`n_embd`／`n_params`／`size`／`ftype`** |
| load／unload | `POST /models/load`｜`/models/unload`，body `{model}`，回 `{success:true}` |
| autoload | 有效：沒先 load 直接打 `/v1/chat/completions` 也會自己載入 |
| `?reload=1` | 有效：手動丟檔進資料夾後掃得到（**「手動拖進資料夾」零程式碼**） |
| `/models/sse` | 200 `text/event-stream`，靜止時不推（只在狀態變動時推） |
| 收程序 | kill router → 子 `llama-server` 一起走（實測 2 → 0），**不必自己追子 pid** |

## 完成（2026-09-02）— CC 代理供應商、用量統計拆 token、常駐後台複檢

- [x] 1. 新增 Command Code 預設供應商（實測 `/provider/v1/messages` 回 Anthropic 形狀的 401 → 直連，
      不走閘道；模型清單 62 顆）
- [x] 2. 重驗其他供應商的位址與格式：直連 3 家 401＝在、閘道 3 家上游 401＝在、7 家 modelsUrl 全 200
- [x] 3. 內建各家的 Base URL 欄收起來（`allowsCustomUrl()` 只放行 `custom`，UI＋main 兩邊都擋）；
      金鑰與模型設定照留
- [x] 4. 趨勢長條分段堆疊（輸入／輸出／快取讀／快取寫）＋四色圖例＋hover 顯示數字
- [x] 5. 分佈每一列也分段，底下多一行 token 明細
- [x] 6. 確認成本有算快取：`costOf` 五項全乘，實測 $46,919 裡 cache read 佔 $32,819（70%）
- [x] 7. 常駐後台複檢：tray 12／節流矩陣（派送仍 0–1ms）／dictation-cdp 32 全綠

### 回顧

- 「使用者指定的格式」不一定是最好的接法：Command Code 名字就是為 Claude Code 做的，
  `/messages` 真的在（不存在的路徑回 404，而且錯誤 body 會依協議換形狀）——**測一下比照做重要**。
- `allowsCustomUrl()` 一個函式被當兩件事用（能不能自己填 ／ 實際打哪），收緊前者就會順手
  把內建直連的預設端點也弄丟。**同名不同義的第二個用途是最容易漏的那種**。
- 快取那 97.5% 的 token 就是「數字大得嚇人」的真正原因；只給一個總數等於什麼都沒說。


## 完成（2026-09-02）— 系統監控總覽：把挖得到的硬體全列出來

- [x] 1. 先實測 probe 的 static 框現在吐什麼、哪幾格是空的（不憑感覺列缺口）
- [x] 2. 量候選 WMI 查詢的成本，只收便宜的（`Win32_Bus` 164ms 查了沒用 → 不收）
- [x] 3. probe.ps1 一律**往後加欄位**：SYS／CPU／BOARD／BIOS／OS／PDISK／MON／NIC／SEC
- [x] 4. 新增五種列：`TZ` 時區、`PAGE` 分頁檔、`SLOT` 擴充插槽、`USBC` USB 控制器、`HID` 鍵鼠
- [x] 5. `metrics.clean()` 統一清掉 SMBIOS 佔位值（以前 renderer 各處寫 `!== 'Default string'`）
- [x] 6. UI 排版：新增四個子項群組；GPU 有 nvidia-smi 時也列「顯示介面卡」；顯示器區塊補上 specs
- [x] 7. 顯示器**不硬湊 EDID 與桌面配置**（沒有可靠對應鍵）：面板那幾行列全部面板
- [x] 8. 回歸：`test-sysmon.js` +12 條、`e2e-sysmon-cdp.js` +11 條（要求「標籤＋真的有值」）

### 回顧

- 規格條數 **60 → 118**；整頁只剩 4 條無值，而且都是這台機器本來就沒有的
  （BaseBoard 版本／主機板序號／機殼序號是 OEM 塞的 `Default string`、沒有公網 IPv6）。
- 排版量測：8 個區塊零 `offsetHeight === 0`、零溢出，24 個子項群組都有列。
- static 框成本 4.4 秒（加了十幾個查詢只多幾百毫秒，TPM 那支佔 470ms）。
- 兩個「手動跑正常、App 裡壞掉」的坑：`$env:firmware_type` 被 spawn 時不存在；
  斷言查錯區塊（韌體模式在主機板不在系統）——兩個都只有實際看畫面才抓得到。

## 完成（2026-09-01）— 六項使用者回報

- [x] 1. nav 順序改成 聊天｜Claude Code｜額度｜AGY反代｜語音轉文字｜翻譯TTS｜系統監控｜設定
      （四支 CDP 腳本裡寫死的頁面清單同步改）
- [x] 2. 系統監控總覽補齊硬體：L1 快取、記憶體插槽數與主機板上限、VRAM 讀登錄檔 64 位元真值
      （`AdapterRAM` 是 uint32，16GB 的卡回 4GB）、磁碟區對到實體碟、閘道／DNS／DHCP、
      每台螢幕的桌面配置（Electron `screen`）
- [x] 3. 用量統計對帳：新增 `probe-code-usage-audit.js`（不經 codeusage 自己重算）→ 逐模型
      請求數／token／金額全對得上；補 GLM-5.3 與 GLM-5.3-Flash 公開單價
- [x] 4. 個人字典：單趟掃描（不再接力取代）、拉丁詞卡詞界並忽略大小寫、不學反向對與接力對
- [x] 5. Claude Code 供應商 tile 可拖曳排序（順序＝store 陣列順序，「＋」固定最後）
- [x] 6. 用量統計不收「不是模型名的 id」（`isJunkModel`；`m` 那種代理寫進去的垃圾），
      `unknown` 照留；`RULES_VERSION` +1 讓舊桶子重讀
- [x] 7. 清理垃圾：專案內 `dist-hud`／`dist-pack2`／`dist-preview`（1.9GB）與
      `native/*/bin|obj`（186MB → 36KB，sidecar 執行檔在 `resources/` 不受影響）；
      專案外 `%TEMP%` 的 `vi-pack`～`vi-pack3`（2.9GB）與 49 個測試殘留的暫存 user-data-dir
- [x] 8. 整理模型更聰明：prompt 加範例與「不要翻譯」、本地切 500 字一段、`maxTokens` 按段長給、
      輸出長度離譜就退回原文

### 回顧

- 「成本算得對不對」不可能用同一份解析器驗——`test-code-usage` 與 `e2e-code-usage` 全綠也只證明
  「它照自己的規則算」。分開寫一支自己重讀原始檔的稽核，才看得出 GLM 兩顆從頭到尾沒有單價。
- 字典的接力取代是那種「每一條規則單看都對、合起來就錯」的 bug：使用者只會覺得模型偶爾發瘋。
- 本地整理的 640 token 上限與 3000 字輸入上限兩條互相矛盾了很久，沒有任何錯誤訊息——
  症狀只是「講的話少了一截」。**沉默的截斷比拋錯難查十倍。**
- 打包失敗（`EBUSY: unlink app.asar`）的真因是 `native/` 沒排除讓 asar 到 631MB。
  以為是「別的程式抓著檔案」而去繞路（打到 %TEMP%）只是拖時間；先看檔案為什麼變這麼大才對。

## 完成（2026-09-01）— 六項使用者回報修正

- [x] 1. Grok 模型掃描：改打 `cli-chat-proxy.grok.com`（`api.x.ai` 是 API 金鑰那條，
      OAuth token 一律 403 spending-limit，跟訂閱額度無關）；閘道上游同步換並補
      `x-grok-client-version`。Claude Code tile 拿掉那顆按不下去的灰色「使用中」
- [x] 2. 系統監控總覽預設全部展開，移除展開／收起按鈕；localStorage 改記「收起清單」
- [x] 3. 處理程序只留「強制結束工作」
- [x] 4. 壓力測試儀錶補 CPU 功耗、記憶體佔用、磁碟佔用（GPU 三項本來就有）；
      完整感測器維持預設自動啟用，頁首的開關與按鈕收掉
- [x] 5. 用量統計成本：查證 20 顆模型的公開單價填進表；順手修「增量掃描把 Codex 模型
      丟成 unknown（7.8 萬筆）」與「`-lite` 被當檔位剝掉，Flash-Lite 算成三倍價」；
      加「全部重讀」按鈕讓舊桶子重算
- [x] 6. 語音輸入：右 Alt 補送 F24 化解「單獨一顆 Alt」（瀏覽器焦點不再跳到工具列）；
      指示器改成啟用時就先建好；量過背景節流後決定**不動** `setBackgroundThrottling`

### 回顧

- 第 5、6 兩項都是「先量再改」救回來的。用量統計如果只是把價目表填一填，7.8 萬筆
  `unknown` 會安靜地少算一大塊；語音輸入如果照直覺去關背景節流，換來的是 AGY 與
  系統監控的輪詢再也停不下來（`document.hidden` 會跟著變 false）。
- 指示器預熱這種「看起來零風險」的改動也會外溢：多一扇視窗就是多一個 CDP page target，
  五支腳本挑錯視窗。用 `url + title` 比對產品名本來就太寬，改成只認 `/index.html/`。


## 完成（2026-09-01）— 供應商 tile 按鈕分家＋壓力測試真的滿載

- [x] 1. tile 改版：名稱／狀態行／底下常駐「啟用」「編輯」兩顆按鈕（不再只有 hover 才出現）
- [x] 2. 確認預設供應商：`probe-ccswitch-endpoints` 2/2、`probe-ccswitch-models` 4/5
      （Grok 403 是帳號額度）；probe 加「預設模型還在不在上游」檢查，抓到 Ollama Cloud
      的 `qwen3-coder:480b-cloud` 已下架並換掉
- [x] 3. 閘道自動決定：內建五家依 preset 的 route 自動啟動閘道，狀態列把結果講出來；
      自訂維持「上游協議」自己選（label 講明它就是閘道開關）
- [x] 4. 修 `detectActiveId`：切過閘道那幾家後把 env 清空，不該再顯示「Codex 使用中」
- [x] 5. 壓力測試實機量測（新 `scripts/probe-sysmon-stress.js`）：CPU 100%、
      GPU 3%→94~100%、記憶體 7.75GB→35GB 且停止會還
- [x] 6. 回歸＋打包＋文件

### 回顧

- GPU 那項連踩三層假象：`gl.finish()` 量到 0ms、frame 間隔被 rAF 節流騙、畫預設
  framebuffer 讓數字在 3%／77%／100% 之間跳。最後是離屏 FBO ＋ `readPixels` 計時
  ＋ 測試期間關背景節流才穩定。
- 記憶體是 Electron 的 V8 sandbox 對整個 process 有 ~8GB 上限（worker thread 也繞不過），
  只能開子程序；順便解決「停止後記憶體沒還」。
- 教訓：只驗「按鈕狀態變成執行中」的測試，抓不到「執行中但沒壓到」。


## 完成（2026-09-01）— Claude Code 可以切回官方訂閱

> 使用者回報：「切換供應商會破壞原本的設定，要可以完美切回原本的官方訂閱」。

- [x] 1. 追資料流確認「破壞」的範圍：`applyEnv` 只動 `MANAGED_ENV_KEYS`，
      hooks／enabledPlugins／permissions／top-level `model` 本來就沒被碰；缺的是回頭那一步
- [x] 2. `presets.js` 新增 `official`（排第一、`auth: 'none'`、無端點、`env: {}`）
- [x] 3. `providers.js`：`resolveEnv` 對 `auth: 'none'` 直接回 `{}`；`allowsCustomUrl` 排除它；
      `detectActiveId` 認「沒切過＋env 沒 Base URL＝官方訂閱作用中」
- [x] 4. UI：彈窗把 Base URL 與模型四格收起來；切回去的狀態訊息講清楚「清掉了什麼、沒動什麼」
- [x] 5. 測試：`test-ccswitch.js` 222 全綠（含播種七筆、官方不可刪、寫出空 env）；
      `e2e-ccswitch-cdp.js` 的預設表與 tile 斷言同步
- [x] 6. 文件：CLAUDE.md（含新地雷）／AGENTS.md／CONTEXT.md

### 回顧

- 沒做「切走前把 env 拍快照再原樣還原」：只有「使用者本來就自己設了 `ANTHROPIC_*`」用得到，
  而那種情況本來就不是官方訂閱；真要救有 `<userData>/claude-backup/` 的備份。
- 官方訂閱那筆刻意不寫 `https://api.anthropic.com`——寫了反而會蓋掉自架／企業代理設定。


## 完成（2026-08-31）— ccswitch 供應商頁重構：5 家固定＋自訂、一鍵切換、API 模型掃描

> 使用者需求：預設供應商只留 Grok／Codex／Ollama Cloud／OpenCode Go／OpenRouter 五家，
> 供應商頁改成 CC Switch 風格一排 tile 一鍵切換＋「＋」新增自訂，移除多餘文字；
> 新增「從 API 自動載入模型」——彈窗四個模型欄位變下拉，內容掃各家 `/models`。

- [x] 0. `scripts/probe-ccswitch-models.js`：實測五家（OpenRouter 396／Ollama Cloud 19／
      OpenCode Go 33／Codex 要 `client_version` 才回 8 顆／Grok 端點在但本帳號額度用完）
- [x] 1. `presets.js`：砍到 6 筆（5＋custom）＋`modelsUrl`/`modelsAuth` 欄位
- [x] 2. `providers.js`：播種 5 家、孤兒 currentId 清理、`remove()` 擋內建最後一筆、`configure()` 注入點
- [x] 3. `chat-models.js`：`fetchModels` 支援完整 `url`＋`headers`；新增 `models-scan.js`
- [x] 4. IPC 鏈：`ccswitch:scanModels`（index/ipc/main.js/preload）
- [x] 5. `index.html`／`ccswitch-page.js`／`main.css`：tile 網格＋「＋」、彈窗去 preset 下拉、模型下拉與掃描
- [x] 6. 測試：`test-ccswitch.js` 補 [G0] 播種／[H0] 掃描段；`e2e-ccswitch-cdp.js` 重寫供應商段
- [x] 7. 回歸＋打包（Orca 鎖 asar，走 %TEMP%＋robocopy＋就地覆寫的既有程序）
- [x] 8. 文件：CLAUDE.md／AGENTS.md／CONTEXT.md

### 回顧

- `test-ccswitch` 214／`e2e-ccswitch-cdp` 103／`e2e-visual-cdp` 70／`e2e-cdp-smoke` 22／
  `test-ccswitch-gateway` 53／`test-error-hygiene` 41，全綠。
- 實機：`probe-ccswitch-scan-ui.js`——Codex 彈窗自動掃到 8 顆真模型進下拉。
- 兩個實測陷阱（都已寫進 CLAUDE.md 地雷）：Codex `/models` 的 `client_version`（舊版回
  200 空清單）、Grok OAuth 打 `/models` 額度用完回 403（錯誤文案分流）。
- 修正一版：刪除鈕原本只給 custom，同一家的**第二筆**（舊資料會有）會刪不掉——
  改成「custom 或同家有重複」都顯示。
- 預覽已更新：`dist/win-unpacked/VoiceInk.exe`（asar 就地覆寫，兩邊雜湊一致）。

## 完成（2026-08-31）— 語音輸入桌面指示器＋雲端 ASR 修復

> 使用者回報兩件事：① 按下右 Alt 之後畫面沒有任何回饋，希望像 Typeless 一樣在桌面底部
> 顯示指示器（波形跟著講話動、會跟著滑鼠跑到另一面螢幕）；② 雲端語音 API 一直出錯，
> 但 API Key 是正確的。

### 一、桌面指示器

- [x] `src/main/dictation/hud.js` —— 視窗生命週期、定位、顯示規則
- [x] `src/renderer/pages/dictation-hud.html` ＋ `scripts/dictation-hud.js` —— 藥丸 UI 與波形
- [x] preload 補 `hudState` / `hudAction` / `onHud`
- [x] main 補 `dictation:hudState`（只收主視窗）與 `dictation:hudAction`（只收指示器視窗）
- [x] `renderer/scripts/dictation.js` 的 `emit()` 一律轉一份給指示器
- [x] `before-quit` 與 `mainWindow` 的 `closed` 都收掉視窗
- [x] 三種狀態：錄音（波形）／處理中（收起按鈕、只留脈動）／失敗（訊息，5 秒自動收）

關鍵決定：

- **`focusable: false` ＋ `showInactive()`**：管線最後是模擬 Ctrl+V 貼進前景視窗，
  指示器搶到焦點就等於把使用者的文字吃掉
- **視窗固定尺寸（540×104）、藥丸在裡面撐寬**：`resizable: false` 會讓 `setBounds` 的寬高
  被靜默忽略，臨時開 resizable 又踩既有的 transparent × resizable 教訓；固定大小之後
  兩個坑一起消失。`body { pointer-events: none }`，只有藥丸吃滑鼠
- **跟著滑鼠不開輪詢**：每次狀態更新問一次游標所在螢幕，`display.id` 變了才動視窗
- **失敗訊息顯示在指示器上**：使用者人在別的程式裡，主視窗的 Toast 他看不到

### 二、雲端 ASR

- [x] 寫 `scripts/probe-cloud-asr.js` 打真上游做請求形狀 × 模型的矩陣
- [x] 401 與 403 分開，403 指名是哪一顆模型、明講「金鑰沒問題」
- [x] 雲端 ASR 補 `shouldS2twpSource` ＋ `s2twp`（第三支 ASR，一樣會吐簡體）
- [x] 設定頁模型 ID 欄位加 `datalist`（三顆實測可用）與 403 的說明
- [x] 使用者存的 `x-ai/grok-stt-1.0`（403）換成 `openai/gpt-4o-mini-transcribe`

實測結論：**請求形狀本來就是對的**（JSON `input_audio` 與 multipart 都 200），
`x-ai/grok-stt-1.0` 是那顆模型在該帳號沒開通，而舊訊息把它講成「請檢查 API Key」。

### 回顧

- `npx electron scripts/e2e-dictation.js` 60（新增 [K] 指示器 13 條）
- `node scripts/e2e-dictation-cdp.js` 28（新增打包版指示器 5 條）
- `node scripts/test-error-hygiene.js` 41（新增 403／s2twp 6 條）
- 回歸全綠：`e2e-cdp-smoke` 22／`e2e-visual-cdp` 70／`e2e-stt-cdp` 21／`test-dictation` 54／
  `test-model-scope` 28／`test-markdown` 23
- 外觀：`scripts/probe-dictation-hud.js` 三種狀態截圖確認過
- **沒做**：`probe-dictation-live.js`（真的送右 Alt、會搶前景焦點）——使用者當時在用電腦。
  `emit()` → `hudState` 這一段是兩端各自驗過、不是端到端量的

## 完成（2026-08-31）— 三個子分頁各自獨立的模型選單

> 「語音轉文字」底下三件事各做各的，共用一組模型會互相打架（字幕想用 GPU 那顆、
> 語音輸入想用 CPU 那顆）。改成每一頁各存一份選擇，選單搬進頁面內容裡、不放標題旁。

### 設計

新增 store key，值的格式沿用語音輸入原本的 `dictationLlm`（三頁共用同一組解析）：

| scope | ASR key | LLM key |
|---|---|---|
| 檔案轉錄 | `fileAsr` | `fileLlm` |
| 即時字幕 | `liveAsr` | `liveLlm` |
| 語音輸入 | `dictationAsr` | `dictationLlm`（已存在） |

- ASR：`local:<模型 key>` ／ `cloud`
- LLM：`local:<模型 key>` ／ `cloud:<供應商 id>:<模型 id>` ／ `''`（只有語音輸入可以「不整理」；
  另外兩頁用「目標語言＝自動偵測」關掉翻譯，不需要第二個關閉開關）
- 開機一次性從舊的全域 key 播種（`asrEngine`+`asrModelKey`／`translator`+`localTranslateModel`+
  `translateProviderId`+`translateModelId`）。**翻譯與 TTS 頁維持用舊的全域 key**，不在這次範圍。

### 完成

- [x] `src/main/model-scope.js`：三個 scope 的 key 表、sanitize、讀取、開機播種、供應商刪除後收斂
- [x] `asr-select.js`／`engine.js`：`warm(scope)`／`transcribe(scope, req)`，不再讀全域 `asrModelKey`
- [x] `local-llm.js`：`translate` 依 `opts.scope` 決定 translator／模型；`warm(modelKey)` 可覆寫；
      順手修好 `translateLocalOnce` 沒把 key 傳進 `getSession()`
- [x] `main.js`：allowlist ＋ 5 個新 key 的 get/set 校驗、`transcribeSamples(scope, req)`、
      `translate` IPC 的 scope 白名單、`chatProviders` 變動時三組 LLM 選擇一起收斂
- [x] `models.js`：`RETIRED_MODEL_KEYS` 從 main.js 移過來（model-scope 也要用）
- [x] `dictation/index.js`：ASR 走 `dictationAsr`、整理走 `model-scope.readLlm`（含 `stale` 提醒）
- [x] renderer：`model-picker.js` 改成 scope 版（`readScope`／`writeScope`／`parseAsrValue`／
      `parseLlmValue`／`resolveScopedCloud`）；`stt-page.js` 一次驅動三組選單
- [x] 移除標題旁的 `#sttModelBar`／`#sttModelHint`，改成各面板的 `.scope-models`（翻譯頁 chip 保留）
- [x] 測試：`test-model-scope.js` 28 新增；`e2e-stt-cdp` 21／`e2e-cdp-smoke` 22／`e2e-llama-asr` 22／
      `e2e-live-cdp`／`e2e-ui-transcribe`／`probe-dictation-live` 同步更新
- [x] 文件：CLAUDE.md／AGENTS.md／CONTEXT.md／README.md

### 回顧

- **這個需求其實是在指出一個設計錯誤**：原本「三頁共用一組模型」的理由是「不要新增第三份
  狀態」，但那是在把「同一份設定」跟「同一個用途」混為一談。三件事的取捨完全不同
  （字幕要快、語音輸入要輕、檔案轉錄可以慢），共用等於每換用途就要重設一次。
- **共用的是解析、不是值**：三組 key 用同一個 `model-scope.js` sanitize／讀取，所以「各存一份」
  沒有變成三份重複程式碼。真正該避免的是同一件事寫三遍，不是同一種資料存三筆。
- **`translateLocalOnce` 的 `getSession()` 少傳 key 是既有 bug**：以前三頁共用同一顆所以剛好對，
  分開之後才會顯現。改共用狀態時要把「因為剛好一樣所以沒事」的地方全部找出來。
- **`isLoaded()` 不能問「目前選的那一支」**：scope 不同時「目前」是誰會變。改成「兩支任一載著
  就算載著」——`warm` 本來就會先卸掉另一支，同時只可能有一支在。
- **升級不能硬切**：`seedFromLegacy` 拿舊的全域設定播種，只填空的 scope 且可重入，
  所以使用者升級之後行為跟升級前一模一樣（實測他原本的 `translator: cloud` 正確搬成
  `liveLlm: cloud:...`）。`dictationLlm` 的空值是「不整理」，刻意不播種。

## 完成（2026-08-30）— 語音輸入（復刻並超越 Typeless）

> 分支 `feat/voice-input`。按住／點一下右 Alt 開始講話 → ASR 轉文字 → LLM 清理贅詞與排版
> → 插入到游標所在的任何應用程式。每一筆留紀錄，並自動累積個人字典讓辨識更準。

### 已驗證的關鍵事實

- `uiohook-napi@1.5.5` 是 `prebuildify --napi` 產物，Electron 43 **直接 require 就能用**（不必 rebuild）。
- **右 Alt 分得開**：`UiohookKey.AltRight = 3640`、左 Alt = 56。實測
  `npx electron scripts/probe-uiohook.js` → `right alt distinguishable: YES`。
- `uIOhook.keyTap/keyToggle` 可送出按鍵 → 插入文字走「剪貼簿 + Ctrl+V + 還原剪貼簿」。
- 本地 LLM 是**單槽**：`local-llm.getSession()` 的指紋含 model key，換 key 會卸載重載。
  語音輸入的本地清理沿用同一顆 session（加 `modelKey` 參數），不另開第二顆。

### 完成

- [x] `src/main/dictation/text.js` 純函式：字典套用／diff 學詞／prompt 組裝／輸出清理
- [x] `src/main/dictation/hotkey.js`：uiohook 生命週期 ＋ 右 Alt 狀態機（短按切換／長按 push-to-talk）
- [x] `src/main/dictation/insert.js`：剪貼簿寫入 → Ctrl+V → 還原原本剪貼簿
- [x] `src/main/dictation/store.js`：`<userData>/dictations.json`（歷史上限 500 ＋ 個人字典）
- [x] `src/main/dictation/index.js` ＋ `ipc.js`：服務門面與逐一列舉的 IPC 白名單
- [x] `local-llm.js` 加 `promptOnce()`：走同一把 translate lock，模型 key 可覆寫
- [x] `src/renderer/scripts/dictation.js`：常駐麥克風擷取（16k PCM），收熱鍵事件跑完整條管線
- [x] `src/renderer/scripts/dictation-page.js` ＋ index.html 第三個子分頁「語音輸入」
- [x] 設定：`dictationEnabled`／`dictationLlm`／`dictationLang` 進 allowlist（含收斂驗證）
- [x] 順手修好雲端翻譯全掛：`reasoning: { enabled: false }` → `{ exclude: true }`
- [x] 驗證：`test-dictation` 54／`e2e-dictation` 43／`e2e-dictation-cdp` 23／全套回歸綠

### 回顧

- **右 Alt 只能用低階鍵盤 hook**：Electron 的 `globalShortcut` 認不出單獨一顆修飾鍵，
  更分不出左右。`uiohook-napi` 的 N-API prebuild 在 Electron 43 直接可用（實測 `probe-uiohook.js`），
  代價是要 `asarUnpack`，而且它看得到所有按鍵——所以程式裡只認右 Alt 與 Esc，其餘不看不記。
- **插入是模擬 Ctrl+V，測試一定要換掉**：不換的話測試會把文字貼進使用者當下的編輯器。
  `configure({ insert })` 這個注入點是為了安全，不是為了「好測」。
- **整理失敗要退回原文**：語音輸入是「講完就要有字」的功能，LLM 掛掉不能讓整段話消失。
- **學詞寧可少學**：只認短詞、無標點、且同一組出現兩次才啟用。學錯一個詞的代價是
  之後每一句都被改壞。
- **順手抓到的既有 bug 比新功能還嚴重**：`reasoning: { enabled: false }` 讓雲端翻譯
  對現在的兩顆模型全部 400，而唯一會抓到的是 smoke 的長文翻譯那一條。
  逐欄位實測後改成 `exclude: true`。

## 完成（2026-08-30）— 新分頁「系統監控」（sysmon）

> 需求：整機硬體規格 + 即時資源監視 + 完整處理程序清單（可升／降冪排序、結束／強制結束工作）
> + GPU/VRAM 壓力測試 + 硬碟測速，整合成本專案的 Aurora glass 樣子；效能要比原生工作管理員好。
> 參考：btop（版面）／CPU-Z・AIDA64（規格）／GPU-Z（顯卡）／HWMonitor・HWiNFO（感測器）／
> CrystalDiskInfo（硬碟健康）／CrystalDiskMark（測速）／FurMark（壓力測試）／工作管理員（進程）。

- [x] `src/main/sysmon/metrics.js` 純函式層（差值、解析、排序、pid 驗證）＋ `scripts/test-sysmon.js`
- [x] `src/main/sysmon/probe.ps1` 常駐 PowerShell 取樣器（stdin 固定指令、框住的管線分隔輸出）
- [x] `src/main/sysmon/sampler.js` sidecar 生命週期（背壓、逾時重啟、真的收程序）
- [x] `src/main/sysmon/gpu.js` nvidia-smi 常駐輪詢；無 NVIDIA 時退回 Windows GPU 效能計數器
- [x] `src/main/sysmon/bench.js` 序列讀寫測速（寫入含 fsync；讀取標明含快取）
- [x] `src/main/sysmon/sensors.js` + `native/sysmon-sensors/` 提權感測器 sidecar（具名管道 + UAC）
- [x] `src/main/sysmon/ipc.js` 逐一列舉白名單 ＋ `main.js` 掛載、`before-quit` 收三顆子程序
- [x] `src/renderer/scripts/sysmon-page.js`：四個子分頁（總覽／處理程序／硬體資訊／壓力測試）
- [x] 進程表虛擬捲動（400+ 列只掛 <60 個 DOM 節點）、八欄升／降冪排序、搜尋
- [x] 結束工作／強制結束工作（彈窗二次確認，pid 走 main 驗證）
- [x] GPU 著色器 + VRAM 配置壓力測試（WebGL2，5 分鐘安全上限）
- [x] 同步更新四支寫死頁面清單的 CDP 腳本
- [x] 驗證：`test-sysmon` 68／`e2e-sysmon` 51／`e2e-sysmon-cdp` 60／`e2e-sysmon-sensors` 25／`e2e-visual-cdp` 68

### 回顧

- **效能是靠選對計數器，不是靠寫得巧**：`Win32_PerfRawData_*` 比 `Win32_PerfFormattedData_*`
  快一個數量級（進程 158ms vs 500ms、GPU 引擎 67ms vs `Get-Counter` 的 5335ms），
  代價只是差值要自己算——而我們本來就需要「上一輪」才算得出速率，等於不用多付。
- **每進程 GPU 使用率原本規劃成「不做」**，實測 `Win32_PerfRawData_GPUPerformanceCounters_GPUEngine`
  只要 67ms 之後改成做了。規劃裡的取捨要以實測數字為準，不是憑印象。
- **感測器只做到「拿得到的那一半」**：GPU 溫度／功耗（nvidia-smi）與硬碟 SMART 溫度可用；
  CPU／主機板溫度需要 PawnIO 核心驅動另外安裝，本機未裝 → UI 明講原因與下一步，不顯示假的 0 度。

## 進行中（2026-08-30）— 整合 cc-switch：Claude Code 模型轉接

> 分支 `feat/cc-switch`。來源：<https://github.com/farion1231/cc-switch>（Tauri + Rust），
> 只復刻 Claude Code 相關功能，改寫成本專案的 Electron + Vanilla JS 形狀。
> 不做：Skills 管理、提示詞管理、工作階段管理、其他 CLI 的供應商切換。

### 已確認的關鍵事實（研究結果）

| 項目 | 結論 |
|---|---|
| 切換供應商實際改哪裡 | `~/.claude/settings.json` 的 `env` 區塊（`ANTHROPIC_BASE_URL`／`ANTHROPIC_AUTH_TOKEN`／`ANTHROPIC_API_KEY`／`ANTHROPIC_MODEL`／`ANTHROPIC_DEFAULT_*_MODEL`／`CLAUDE_CODE_MAX_CONTEXT_TOKENS`／`CLAUDE_CODE_AUTO_COMPACT_WINDOW`） |
| **不可整檔覆寫** | 使用者的 `settings.json` 還有 `hooks`／`enabledPlugins`／`statusLine`／`permissions`／`model` 等 17 個鍵。cc-switch 是整檔換掉（SSOT），照抄會毀掉使用者設定。本專案只做 `env` 的外科式合併＋首次寫入前備份 |
| MCP 存哪 | `~/.claude.json` 根物件的 `mcpServers`（不是 `settings.json`）。Windows 上 `npx`／`npm`／`node` 等指令要包成 `cmd /c` |
| 六家供應商需不需要代理 | **直連**：Claude 官方（清空 env）、OpenRouter（`https://openrouter.ai/api`，原生 Anthropic）、OpenCode Go（`https://opencode.ai/zen/go`，只認 `ANTHROPIC_API_KEY`）。**要本機代理轉換**：Codex（ChatGPT Responses）、Grok Build（xAI Responses）、Ollama Cloud（OpenAI Chat） |
| Codex／Grok 的 token | 沿用已安裝 CLI 的憑證（`~/.codex/auth.json`、`~/.grok/auth.json`），過期時代跑 CLI 續期——與 AGY 對 Antigravity 的做法相同。不自建 OAuth 登入 |
| 使用統計資料來源 | Claude `~/.claude/projects/**/*.jsonl`（assistant 訊息帶 `message.usage` 與 model）／Codex `~/.codex/{sessions,archived_sessions}/**`／Grok `~/.grok/sessions/<enc-cwd>/<id>/updates.jsonl`（逐輪 `turn_completed`，**是每輪總量不是累計快照**）／OpenCode `~/.local/share/opencode/opencode.db`（唯讀 SQLite，本專案已有讀法）／**Antigravity 本機沒有 session 記錄**，只能用 VoiceInk 自己的 `agy-logs.db` |
| CLI 版本更新 | 偵測本機版本 ＋ 查 npm registry latest；更新指令丟進既有終端機分頁執行，不自己開子程序裝東西 |

### 使用者決定

- 認證：沿用已裝 CLI 的 token（不做 device-code 登入）
- Ollama Cloud：要做，走本機代理轉換
- 統計：token／請求數／趨勢／模型分佈 **＋金額**；內建單價表最簡（Claude Opus 5、Sonnet 5、GPT-5.6 Sol／Terra／Luna、Grok 4.6、Gemini 3.7 Flash），可自行增列；同一模型在不同供應商的 id 差異要正規化後合併計算
- 位置：新增「Claude Code」nav 分頁（子分頁：供應商／MCP／CLI 版本）；使用統計併進現有「額度」頁當第二個子分頁

### 階段一：供應商切換（核心）
- [x] `src/main/ccswitch/claude-settings.js`：讀／合併／寫 `~/.claude/settings.json`；只動 `env` 內我們管理的鍵，切換時清掉前一家留下的鍵，首次寫入前備份到 `<userData>/claude-settings-backup/`
- [x] `src/main/ccswitch/presets.js`：六家固定預設（含 `apiFormat`／`apiKeyField`／模型預設值）
- [x] `src/main/ccswitch/providers.js`：供應商 CRUD ＋ 目前選用；獨立 electron-store（`<userData>/cc-providers.json`），**不進 `STORE_ALLOWLIST`**
- [x] `src/main/ccswitch/ipc.js`：逐一列舉白名單的 `ccswitch:*` IPC
- [x] `src/renderer/scripts/ccswitch-page.js` ＋ index.html／main.css：新分頁、供應商卡列表、切換、編輯彈窗（**只有名稱、Base URL、金鑰、模型；不放備註與官網連結**）
- [x] 驗證：`node scripts/test-ccswitch.js`（純函式：env 合併／舊鍵清理／預設值／壞輸入）

### 階段二：MCP 管理
- [x] `src/main/ccswitch/mcp.js`：讀寫 `~/.claude.json` 的 `mcpServers`；stdio／http／sse 驗證；Windows `cmd /c` 包裝；停用的伺服器搬到自己的 store 而不是刪掉
- [x] UI：MCP 子分頁（清單、開關、新增／編輯／刪除、幾個常用範本）
- [x] 驗證：`test-ccswitch.js` 補 MCP 段（含 `cmd /c` 與非法 spec）

### 階段三：CLI 版本更新
- [x] `src/main/ccswitch/cli-version.js`：`claude --version` 等本機版本偵測 ＋ npm registry latest（bounded fetch、只記狀態碼）
- [x] UI：一列一個工具（名稱／目前版本／最新版本／更新鈕）；更新＝開一個終端機工作階段跑 `npm i -g <pkg>@latest`
- [x] 驗證：`test-ccswitch.js` 補版本比較；打包版 CDP 驗清單渲染

### 階段四：使用統計（五家）
- [x] `src/main/codeusage/{claude,codex,grok,opencode,antigravity}.js`：各自的解析器，增量游標存 `<userData>/code-usage.json`
- [x] `src/main/codeusage/pricing.js`：模型 id 正規化（跨供應商別名合併）＋ 最簡單價表 ＋ 使用者自訂單價
- [x] `src/main/codeusage/index.js`：彙總（時間範圍走 main 白名單、序列補零，比照 `agy/logs.js`）
- [x] UI：額度頁第二個子分頁（總覽卡／趨勢圖／模型分佈／各家分佈），沿用 AGY 統計的純 CSS 長條與 tooltip
- [x] 驗證：`node scripts/test-code-usage.js`（fixture 逐家解析／Grok 逐輪不累計／模型別名合併／單價換算／補零）

### 階段五：Codex／Grok／Ollama 本機代理
- [x] `src/main/ccswitch/gateway/`：只綁 `127.0.0.1`＋強制金鑰＋Host 檢查的小閘道（沿用 AGY server 的防護寫法）
- [x] Anthropic Messages ⇄ OpenAI Responses（Codex／xAI）與 ⇄ OpenAI Chat（Ollama Cloud）雙向轉換＋SSE
- [x] 憑證：讀 `~/.codex/auth.json`／`~/.grok/auth.json`，過期代跑 CLI 續期（比照 `agy/credential.js`）
- [x] 驗證：`node scripts/test-ccswitch-mappers.js`（轉換純函式）＋ `npx electron scripts/e2e-ccswitch-gateway.js`（mock 上游：串流拼接、鑑權、Host、錯誤不外洩上游 body）

### 收尾
- [x] 四支 CDP 腳本寫死的頁面清單同步更新（`e2e-cdp-smoke`／`e2e-usage-cdp`／`e2e-agy-cdp` 的 `EXPECTED_ORDER`、`e2e-visual-cdp` 的 `PAGES`／`SIGNATURES`）
- [x] `npm run build` ＋ `npm run electron:pack`；跑完整回歸
- [x] 更新 `CLAUDE.md`／`AGENTS.md`／`CONTEXT.md`／`tasks/lessons.md`

### 已知風險
- 寫使用者的 `~/.claude/settings.json` 與 `~/.claude.json` 是本輪唯一會動到 App 之外真實資料的地方，所有寫入都要備份＋原子寫入＋只動自己管的鍵。
- 分支開出來時工作區已有未提交的 `sysmon` 系統監控（新 nav 分頁）與翻譯思考的修改，會一起帶進這條分支。

### Review

五個階段都做完並驗證通過。

**驗證輸出**
- 純函式：`test-ccswitch` 109／`test-ccswitch-gateway` 53／`test-code-usage` 81，全 0 failed
- 端到端：`e2e-ccswitch-gateway` 31（自開 mock 上游）／`npx electron e2e-code-usage` 16
  （真的讀本機 session 記錄：2627MB／19.7s／646 個桶）
- 打包版 CDP：`e2e-ccswitch-cdp` 52／`e2e-usage-cdp` 17／`e2e-visual-cdp` 69／`e2e-terminal-cdp` 30／
  `e2e-chat-cdp` 44／`e2e-agy-cdp` 33／`e2e-stt-cdp` 19
- 回歸：`e2e-agy` 98／`e2e-chat` 129／`test-usage` 30／`test-agy-mappers` 50／`test-error-hygiene` 33／
  `test-terminal` 50／`test-markdown` 23／`test-vad` 11／`test-usage-reorder` 15
- `npm run build` ＋ `npm run electron:pack` 通過，`dist/win-unpacked/VoiceInk.exe` 是最新預覽

**做了但規劃時沒想到的**
- `usage/shared.fetchJson` 加了 `label` 參數：CLI 版本檢查借它去打 npm registry，
  錯誤訊息全寫死「額度服務」會讓使用者看到牛頭不對馬嘴的字。
- `terminal-page.js` 新增 `runInNewTerminal()`：CLI 更新要開一個終端機工作階段跑指令。
- `activateProvider` 會自動把閘道拉起來——不然使用者切到 Codex 會撞到「請先啟動閘道」然後不知道去哪按。

**沒做到的**
- 閘道沒有對真的 ChatGPT／xAI／Ollama 上游實測過（會花使用者的訂閱額度，留給使用者決定）。
- `e2e-cdp-smoke` 22 項中有 1 項失敗（長文分段翻譯），是既有問題：使用者設定的
  `z-ai/glm-5.3-flash` 收到「關閉思考」參數回 400，與本輪無關。

## 本輪功能修正（2026-08-30）— 翻譯固定關閉思考
- [x] 確認本地與雲端翻譯的思考設定路徑。
- [x] 雲端翻譯固定送 `reasoning: { enabled: false }`，補回歸檢查。
- [x] 跑測試、建置與免安裝打包驗證。

### Review
- `node scripts/test-error-hygiene.js`：33 passed, 0 failed。
- `npm run build`：Vite production build 成功。
- `npm run electron:pack`：`dist/win-unpacked/VoiceInk.exe` 產生成功。
- 實測目前設定的 `z-ai/glm-5.3-flash` 會產生思考 token 且拒絕關閉；`z-ai/glm-4.5-air` 使用 `reasoning.enabled=false` 回應成功且思考 token 為 0。

## v1.9.0 發行（2026-08-30）
- [x] 確認 `v1.9.0` 未與本地／遠端 tags 重複。
- [x] 提交版本與文件更新並建立 `v1.9.0` tag。
- [x] 產生並驗證 NSIS 安裝檔。
- [x] 推送分支／tag 並建立 GitHub Release。

### Review
- 提交：`c1e6040`（`feat: 發行 v1.9.0 UI 與模型工作台更新`）。
- 安裝檔：`dist/VoiceInk Setup 1.9.0.exe`，SHA-256 `1D754B85C19BBD2C8C8CEB97E39D8D197ED930099BA86889F1B7E010363AA08E`。
- Release：<https://github.com/RX5950XT/VoiceInk/releases/tag/v1.9.0>。

## 本輪完成修復（2026-08-29）
- [x] 修正 AGY Base URL 的舊狀態覆寫，驗證 `e2e-agy-cdp.js`。
- [x] 修正終端機首次提示字元遺失，驗證 `e2e-terminal-cdp.js`。
- [x] 修正 CDP 測試的全域 `taskkill`，不得關閉使用者安裝版。
- [x] 重新打包並跑完整 UI／功能驗收。
- [x] 驗收通過後清除 `.agents/` 與 `PROJECT.md`，更新交接紀錄。

## 本輪 UI 修整（2026-08-29）
- [x] 統一所有下拉控制項的收合形狀、箭頭、hover/focus 與雙主題 option 顏色。
- [x] 讓思考開關的開啟狀態與 hover 狀態可清楚區分。
- [x] 對齊設定頁生圖模型列的欄位、勾選標記與移除按鈕。
- [x] 更新免安裝預覽並通過 49 項視覺、22 項冒煙回歸。

## 本輪自訂下拉修整（2026-08-29）
- [x] 以可控的自訂 listbox 取代原生展開彈窗，保留既有 `<select>` 資料流與 change 事件。
- [x] 統一模型、語言、供應商與其他下拉的圓角、選取／hover 顏色、鍵盤操作與 RWD。
- [x] 修正聊天 `<optgroup>` 模型下拉點擊例外，並讓窄版長選項保持單行與可讀寬度。
- [x] 補上聊天模型點擊、模型列三欄同高回歸，重跑建置、免安裝預覽與視覺測試（54/54）。
- [x] 修正 `.setting-group label` 蓋掉生圖標籤 flex 對齊，補勾選框／文字中心線回歸。

## 待辦清單
- [x] 階段 0：全域 Survey 與架構探索（Explorers 1~3 完成調研）
- [x] 階段 1：M1 全域視覺系統與基礎排版精修（Design Tokens & Typography - R1）
- [x] 階段 2：M2 AI 聊天分頁與 Markdown 視覺體驗優化（Chat & Markdown - R2）
- [x] 階段 3：M3 終端機、額度卡片與輔助工具面板打磨（Terminal, Usage, AGY & Panels - R3）
- [x] 階段 4：M4 設定頁面與全域導覽列互動優化（Settings & Navigation - R4）
- [x] 階段 5：M5 E2E 視覺測試與打包驗證（`npm run build`, `npm run electron:pack`, `e2e-visual-cdp.js`, `e2e-cdp-smoke.js`）

## 回顧（Review）
- 階段 0 完成：3 位 Explorer 針對 R1 (Design Tokens)、R2 (Chat & Markdown)、R3/R4/E2E 測試完成全面調研並建立了 `PROJECT.md`。
- 階段 1~5 完成：
  - 全域 Token Anxiety Aurora 雙色主題（深/淺）、字體層級、12px 圓角與 WCAG AA 對比度標準確立。
  - AI 聊天訊息氣泡、Thinking 折疊區塊、Markdown 代碼高亮/表格/引言與底部輸入框交互打磨完成。
  - 終端機側欄狀態指示燈、額度管理卡片與進度條、AGY 反代日誌/統計面板精修完成。
  - 導覽列 Active 膠囊光暈、設定頁分類 Rail 與表單 Focus Ring 規格統一。
  - 全自動化測試套件（Vite 建置、免安裝預覽打包、視覺 CDP 48 項、冒煙測試 22 項、終端機 29 項、額度 10 項、AGY 33 項、語音 19 項）全數 100% 通過。
  - 2026-08-29：補 AGY 狀態 generation guard、終端機背景首段輸出序列化，以及 CDP 暫存 profile／PID 收尾；終端機回歸更新為 30 項。
  - 2026-08-29：統一下拉與模型 chip 的控制項視覺，強化思考開關狀態，將生圖模型列改為三欄對齊；視覺回歸更新為 49 項。
  - 2026-08-29：原生下拉的展開清單仍由 OS 畫、無法控制圓角，改用 `custom-select.js` 共用 ARIA listbox；打包版視覺／互動回歸更新為 52 項。
  - 2026-08-29：聊天模型 `<optgroup>` 誤讀 `child.options` 導致點擊下拉拋例外；改用群組內 `option`，並補窄版寬度與模型列幾何回歸，視覺／互動更新為 54 項。
  - 2026-08-30：系統監控頁的 PawnIO 核心驅動改為**App 代裝**（`sysmon/pawnio.js` ＋ `sysmon:installPawnIo`）：
    下載官方 release → `Get-AuthenticodeSignature` 驗簽（`Valid` ＋ `CN=namazso.eu`）→ 提權 `-install -silent`
    → 確認 DLL 出現 → 一律刪安裝檔。驗簽不過就中止、絕不執行；不釘 SHA-256 以免自動裝到過期版本。
    純函式回歸更新為 83 項；打包版系統監控 CDP 維持 60 項全綠。
  - 2026-08-31：cc-switch 整合的三處回報修正——
    ① CLI 版本頁的「查不到最新版（離線？）」是自己送錯 header（`Accept: application/vnd.npm.install-v1+json`
       在 npm `/latest` 端點回 406 空 body），拿掉後四家都查得到；
    ② 更新指令一律改用各家自帶的 updater（`claude update`／`codex update`／`grok update`／
       `opencode upgrade`／`agy update`），因為實測只有 codex 與 opencode 真的是 npm 裝的，
       Antigravity CLI 沒發 npm 但有 `agy update`，現在也有更新鈕；
    ③ 彈窗內的自訂下拉被 `.app-dialog` 的 `backdrop-filter` 偷走定位基準，整個位移一個 dialog 左上角，
       `positionMenu` 改為歸零量原點再回推，`dialog-dropdown` 補上對齊斷言（**影響所有彈窗**）。
    另補齊供應商表單（對照 cc-switch 的 `ClaudeFormFields`）：自訂 Base URL（僅直連、只放行 http(s)）、
    金鑰寫入欄位二選一、模型改成主／Haiku／Sonnet／Opus 四格。
    回歸：`test-ccswitch` 121、`e2e-ccswitch-cdp` 57、`e2e-visual-cdp` 69 全綠。

## 2026-08-31 — 系統監控改版：總覽⊕硬體資訊、四項壓力測試

- [x] 總覽與硬體資訊合併成一頁，改成漸進式揭露的區塊（收起＝視覺摘要，展開＝明細，長清單再包一層）
- [x] 同性質的長清單做成可收合子項：每執行緒、每條記憶體、每顆碟、每張網卡、依種類拆開的感測器
- [x] 展開狀態記在 localStorage（每輪重畫不會洗掉），加「全部展開／全部收起」
- [x] 完整感測器改成預設進頁自動啟用（`sysmonSensors`），UAC 按否就自動關掉不再騷擾
- [x] 補硬體資訊：系統／機殼／CPU 擴充／記憶體型別與插槽／GPU 解析度與 PCI ID／硬碟韌體／顯示器 EDID／網路卡／音效／電池／Secure Boot
- [x] 壓力測試補 CPU（main worker_threads）與記憶體（main Buffer），加即時負載與溫度儀錶
- [x] 刪掉壓力測試的黃色警告條，說明併進各卡敘述
- [x] 測試與文件同步

### Review

- 資料層只動了 `probe.ps1` 的 static 框與 `metrics.parseStatic`，tick 那條熱路徑（每 1～2 秒）一格沒碰。
- `Win32_Tpm` 實測未提權 PermissionDenied 且失敗前卡 5.2 秒，換到的只有一行「TPM 2.0」——不查，
  Secure Boot 改走登錄檔。static 框維持約 5 秒。
- CPU／記憶體壓力測試放 main 不放 renderer：Worker 跟畫面搶排程、V8 堆配不到幾十 GB，
  而且 CSP 在 file:// 底下能不能建 Worker 沒保證。
- 驗證：`test-sysmon.js` 108／`e2e-sysmon.js` 51／`e2e-sysmon-cdp.js` 73／`e2e-visual-cdp.js` 69／
  `e2e-cdp-smoke.js` 22，全綠；`npm run electron:pack` 通過。
- 還沒做：TPM 版本、SMART 完整屬性表——都要提權，成本遠高於價值。
  （記憶體 SPD/XMP 時序這一項是我判斷錯了：LibreHardwareMonitor 的 `Timing` 型別本來就有，
  本機 65 項，只是型別沒對到表所以混在清單裡看不出來，已歸到「記憶體時序」下拉。）

### 追加修正（2026-08-31，使用者回報）

- [x] **「全部展開／收起」與點標題完全沒作用** —— root cause 是 `.sysmon-block-body { display: flex }`
  壓過瀏覽器內建的 `[hidden] { display: none }`，`body.hidden = true` 形同虛設。補一行
  `.sysmon-block-body[hidden] { display: none }`。**測試為什麼放行**：舊斷言只看 `.hidden === true`
  （屬性確實是 true），改成量 `offsetHeight === 0`。
- [x] 壓力測試改 **2×2**（≤900px 收一欄），`.sysmon-stress-desc` 用 `flex: 1` 把四張卡的操作列對齊。
- [x] GPU 那張卡下面「多一小塊」＝ WebGL2 畫布（負載就是它畫出來的，不能刪）。改成**只在跑的時候顯示**；
  `startStress` 要先 `hidden = false` 再取 context，藏著取的話 `drawingBufferWidth` 是 0。
- [x] 再補硬體資訊：nvidia-smi 加 `clocks.mem`／`pcie.link.gen.current`／`pcie.link.width.current`／
  `vbios_version`（實測讀到 PCIe Gen4 × 8、記憶體時脈 7001 MHz、VBIOS 98.06.39.00.c5）；
  已撈到但沒顯示的補上：磁碟序號、電池設計電壓與充放電狀態、機殼序號、系統家族。
- 驗證：`test-sysmon.js` 110／`e2e-sysmon.js` 51／`e2e-sysmon-cdp.js` 76／`e2e-visual-cdp.js` 69／
  `e2e-cdp-smoke.js` 0 FAIL；`npm run build`、`npm run electron:pack` 通過。
  實機 CDP 量到：收起 0px → 全部展開 128px → 點標題再收 0px；四張卡兩個左緣、同列等高；閒置時畫布收起。
  - 2026-08-31（續）：補上 App 內的 OAuth 登入（`ccswitch/gateway/oauth.js`）。
    兩家各走官方支援的流程——Grok = device code（xAI discovery 有列）、
    Codex = PKCE ＋ loopback 1455（OpenAI discovery 沒有 device code，且 cc-switch 那套是逆向的）。
    多帳號並存、每筆供應商各自綁一個，沒綁就退回讀已安裝 CLI 的憑證（舊行為完全保留）。
    回歸：`test-ccswitch` 159（含真的開 1455 埠跑完整 PKCE）、`e2e-ccswitch-cdp` 68。

### 供應商清單擴充 ＋ 全自訂供應商（2026-08-31，使用者交代）

需求：把現有供應商全列出來、端點直接寫好、金鑰由使用者填、模型路由可自訂；
上游不支援 Anthropic 協議時要有路由開關；要能新增「全自訂」供應商。

- [x] 1. `presets.js`：補上實測有 `/v1/messages` 的家數（401＝端點在，404＝網址錯的剔除），
      加一筆 `custom`（全自訂）。**端點一律先探測過再寫進表**。
- [x] 2. `providers.js`：自訂供應商可選上游協議（anthropic／openai_chat／openai_responses），
      協議決定路由（anthropic→直連、其餘→經本機閘道）。閘道路由 key 從「preset id」
      改成「custom 用 provider id」，否則多筆自訂會互相蓋。
- [x] 3. `gateway/server.js`：`ROUTES` 之外加一條動態解析（`resolveRoute`），
      上游位址一律由 main 從 store 取，renderer 永遠不送 URL。
- [x] 4. `index.js`：注入 `resolveRoute`；切到自訂且需轉換的那筆也要自動拉起閘道。
- [x] 5. UI：預設下拉分組（原生 Anthropic／需轉換／自訂），自訂時顯示協議選擇＋
      算出來的路由說明；Base URL 對自訂是必填。
- [x] 6. 測試：`test-ccswitch` 加自訂供應商與路由推導；`e2e-ccswitch-cdp` 加建立自訂供應商。

回顧：預設表 6 → 19 筆，端點**每一筆都探測過**（401/403＝在、404＝錯；小米 MiMo 因此補上
`/anthropic`）。路由開關做成自訂那筆的「上游協議」選擇，推導集中在 `providers.routeFor()`、
由 `list()` 把算好的 `route` 回給 renderer。自訂的閘道路由段改用 provider id，
上游位址一律由 main 從 store 查（`resolveRoute`），路徑與標頭都指定不了網址。
驗證：`probe-ccswitch-endpoints` 12/12、`test-ccswitch` 182、`e2e-ccswitch-gateway` 35、
`e2e-ccswitch-cdp` 103、`e2e-visual-cdp` 70、`e2e-chat-cdp` 44、`e2e-terminal-cdp` 30、
`e2e-usage-cdp` 17、`e2e-stt-cdp` 21、`test-ccswitch-gateway` 53。

- [x] 預覽已更新：`dist/win-unpacked/VoiceInk.exe`（2026-08-31 16:56）。
  `Orca.exe`（pid 7788）抓著 app.asar 的 handle 不放，電腦上卻沒有任何 VoiceInk 程序，
  用 Sysinternals `handle64` 才查得出來。**刪不掉但寫得進去**（share-write 有、share-delete 沒有）：
  打包到 `%TEMP%` → `robocopy /MIR /XF app.asar`（`VoiceInk.exe` 一起換，完整性雜湊在它裡面）
  → asar 就地覆寫＋`SetLength`。sha256 對過兩邊一致，`e2e-ccswitch-cdp` 103 全過。
  順手抓到 `dist-hud/`（965MB）會被打進 asar（525MB → 1.46GB），已補 `!dist-*/**` 排除。
- 待清：`dist-preview/` 因為同一個 handle 刪不掉，Orca 關掉後 `rm -rf dist-preview` 即可。

## 系統監控：處理程序頁 CPU/GPU/VRAM 異常偏高（2026-08-31）

- [x] 1. `metrics.js`：GPU engine 配對 key 補上引擎索引（`engineId`）——eng_N 是每個進程
      各自的編號，同 pid 同卡同 engtype 可以有多個實例（實測 System 兩個 Copy、
      explorer 在 iGPU 上 16 個 3D），舊 key 讓它們互配 → System／msedge 常駐假 100%。
- [x] 2. `metrics.js`：新增 `COUNTER_WRAP`（2^63）守衛——這族 uint64 累計計數器會出現
      補數繞回的垃圾值（實測 dwm 的 3D engine 回報 ~2^64），差值爆成天文數字再被夾成
      恆 100%；進程 CPU 同族同守。
- [x] 3. 回歸測試：`test-sysmon.js` 加「引擎索引解析」「同卡同 engtype 多實例不互配」
      「補數繞回不做差值」三條，並更新 LUID 那條地雷（CLAUDE.md／CONTEXT.md）。

回顧：實機取證（真實 probe.ps1 + metrics.js 連跑 8 輪）確認 GPU 欄的元兇是配對 key
漏了引擎索引＋uint64 繞回；CPU 欄的差值公式對照 WMI formatted 參考值**是正確的**
（Idle 81.46% vs 80.31% 等），dwm VRAM 11.5GB 是 Windows 計數器本來就報的量法
（地雷有記，不動）。修後實測：System 100%→0.1~0.9%、msedge 100%→≤0.9%、
整卡使用率 100%→2~4%（dGPU 真實在閒置）、Discord 假 18~22% 消失。
驗證：`test-sysmon.js` 114、`e2e-sysmon.js` 51、`e2e-sysmon-cdp.js` 77（打包版，
跑完還原設定）。預覽已更新：`dist/win-unpacked/VoiceInk.exe`（打包走 %TEMP%＋
就地覆寫 asar 的既有程序，asar 與 exe 雜湊兩邊一致）。

### 第二輪：處理程序頁「還是特別高」的三個混淆源（2026-08-31）

- [x] 1. `metrics.js parseTick`：處理程序表不再顯示 `Idle`（pid 0）——它的 CPU% 是
      100 減整機負載，依 CPU 遞減排序永遠洗在頂端，讀起來像「有程序吃掉 60% CPU」。
      工作管理員「處理程序」分頁預設也不顯示它。
- [x] 2. `index.html`／`main.css`：處理程序表下方加一行說明（`#sysmonProcNote`）——
      VRAM 欄是 Windows 記帳的「配置量」，dwm 會刻意預留大塊（工作管理員同一套
      數字），實際駐留量看總覽頁 nvidia-smi。
- [x] 3. 對照組真相：nvidia-smi 實測整卡只住 3.8GB／16GB，計數器加總卻是 16GB、
      dwm 一人掛 11.2GB → 證明 DedicatedUsage 是配置量不是駐留量；但工作管理員
      顯示的就是這套數字（社群實測 dwm 在工作管理員也是 GB 級），值不動、加說明。

回顧：第一輪修的 GPU 假 100% 是真的 bug；第二輪剩下的「偏高」其實是（a）Idle 洗版
（b）dwm 配置量無說明。修後實測同機器：CPU 頂列是取樣器自己的 powershell／WmiPrvSE
（2~5%，真實開銷）與 msedge（≤3%），GPU 頂列 NVIDIA Broadcast 1.4%（真實）。
驗證：`test-sysmon.js` 115（新增 Idle 條）、`e2e-sysmon-cdp.js` 77、`e2e-visual-cdp.js`
70。預覽已再更新（asar 4b4c90a…、exe ab8ef78…，兩邊雜湊一致）。

## 八項使用者回報（2026-09-01）

- [x] 1. Claude Code 頁：拿掉 tile／列的左緣 accent bar（`.cc-tile.is-active` 的
      `inset 3px` 與 border accent），作用中改成只靠「使用中」徽章表示。
      順手刪掉沒人用的 `.cc-row.is-active` 死規則。
- [x] 2. 壓力測試上方儀錶：「磁碟佔用」改成**磁碟讀寫**（`_Total` 的 read+write 速率，
      尺規跟著看過的峰值走）——容量在壓力測試中不會動，看不出有沒有真的在跑。
      記憶體那格改名「記憶體已用」：Windows 沒有記憶體頻寬計數器，而記憶體壓力測試
      量的本來就是「吃掉多少容量」，跑起來會直接往上衝。
- [x] 3. 儀錶固定三欄（900px 收 2 欄、640px 收 1 欄）：CPU 三格一排、GPU 三格一排、
      記憶體與磁碟一排。
- [x] 4. 單價表補快取價：Anthropic 每顆補 `cacheRead`／`cacheWrite`／`cacheWrite1h`，
      OpenAI／xAI／Gemini 的自動快取寫入補 0（不是「沒填」）。UI 的單價彈窗
      從兩格變四格（輸入／輸出／快取讀／快取寫），摘要多一張「快取寫入」卡。
- [x] 5. `gemini-pro-agent` 套 Gemini 3.1 Pro 的價（它就是那顆的 agent 檔位）。
- [x] 6. 統計漏算三處：① Claude 的 `cache_creation` 1h／5m 沒分開（1h 是 input×2、
      5m 是 ×1.25，本機記錄幾乎都是 1h → 低估三成多）② 單行上限 2MB 把實測 4.2MB
      的行整條丟掉 ③ 單檔上限 50MB 把一整份 session 跳過。RULES_VERSION → 3
      （下次同步會自己整份重讀）。
- [x] 7. 語音輸入：新增 **原生熱鍵 sidecar**（`native/dictation-hook`，WH_KEYBOARD_LL）
      真的把右 Alt 吞掉，前景程式完全收不到；起不來才退回 uiohook＋F24 中和。
      錄音上限 2 分鐘 → **20 分鐘**（main 端切成 20 秒一段再逐段送 ASR，切點挑最安靜處），
      熱鍵掛不上時 5 秒後自動重試，麥克風 track 死掉會自己重建。
- [x] 8. 雲端 ASR 一組設定可以放**多顆模型**（`asrClouds[].models`），三個子分頁各自
      挑「哪一組設定的哪一顆模型」（值變成 `cloud:<設定 id>:<模型 id>`）。

### 回顧（2026-09-01 第二輪）

八項全部完成並實測。幾個值得記的：
1. **統計漏算的兇手是兩個防呆上限**（單行 2MB／單檔 50MB），放寬後掃描量 2.6GB → 5.4GB、
   請求數 31882 → 38279；成本方面 1h 快取（實測佔 78%）以前照 5m 價算，低估三成多。
2. **原生熱鍵 sidecar 成本比預期低**：專案已有 .NET sidecar 的建置與打包流程，照抄就好。
   `npm run build:hook` → `resources/hook/VoiceInkHook.exe`（10MB、不提權），
   打包版實測 `status().mode === 'native'`。
3. **舊值升級要一起做兩邊**：`asrClouds` 的 `modelId` → `models` 除了 sanitize，
   `migrateAsrClouds` 也要對「已經有清單」的情況寫回一次，否則 renderer 讀到的還是舊形狀。

驗證指令與數字見 CONTEXT.md 同日章節。預覽已更新：`dist/win-unpacked/VoiceInk.exe`
（打包走 `%TEMP%` ＋ 就地覆寫 asar，asar 雜湊兩邊一致）。

## 合頁後的回歸收尾（2026-09-01 第三輪）

上一輪把聊天與終端機合成同一頁、並把所有 CDP 腳本改成用暫存 `--user-data-dir`，
留下 8 個紅燈。逐條追根因後修完：

- [x] 1. **終端機刪不掉**（`terminal-page.js`）：`onStatus` 每收到一次狀態就 `renderList()` 重建整份清單，
      待確認的刪除鈕（第一次點會變紅勾）連同計時器一起被換掉，第二次點的是已經脫離 DOM 的節點。
      PowerShell 的提示字元標記三秒重送九次 → **跑著的終端機永遠刪不掉、也改不了名**。
      改成 `refreshItemView()` 只改那一列的徽章與未讀點（`paintBadge`／`paintUnread` 與 `buildListItem` 共用）。
- [x] 2. **人在對話主區時未讀點不亮**（`terminal-page.js`）：合頁後「離開終端機」藏的是 `#termMain`，
      `#termHost` 自己不會變，`watching` 少了這一條就恆為 true。
- [x] 3. `e2e-terminal-cdp.js`：`.chat-list-item` 也會命中終端機列（兩者共用 class），
      選擇器限定 `#chatList`；全新 profile 沒有對話，測試自己開一個再刪掉。
- [x] 4. `e2e-chat-cdp.js`：全新 profile 的 `chatProviders` 是空的 → 供應商下拉沒有選項。測試自己種一組。
- [x] 5. `e2e-live-cdp.js`／`e2e-ui-transcribe.js`／`e2e-file-transcribe-black.js`：
      模型放在 `<userData>/models`，換 user-data-dir 等於一顆都沒裝。用 junction 把真的模型資料夾接進來。
- [x] 6. `e2e-file-transcribe-black.js`：從來沒切到語音轉文字頁（預設頁已經是聊天），
      檔案選了不被收下，症狀是「進度面板永遠沒出現」。補上導頁。
- [x] 7. `e2e-tray-cdp.js`：第二／第三份實例沒帶同一個 `--user-data-dir`，各自拿到自己的
      single-instance lock，「第二份會自己退出」「捷徑叫回視窗」兩條根本沒測到。
      AGY 那條改成跟 OS 借一個空埠（使用者的正式實例佔著預設埠；寫死 47821 實測也被別的程式佔了）。
- [x] 8. `test-ccswitch-gateway.js`：Grok 端點斷言還停在 `api.x.ai`，程式碼早就改成
      `cli-chat-proxy.grok.com`（訂閱制那條）。

驗證（全部實跑）：
`test-terminal` 50／`test-sysmon` 116／`test-usage` 30／`test-ccswitch` 224／`test-ccswitch-gateway` 53／
`test-code-usage` 99／`test-markdown` 23／`test-vad` 11／`test-dictation` 77／`test-agy-mappers` 50／
`test-error-hygiene` 41／`test-usage-reorder` 15／`test-model-scope` 31；
`e2e-chat` 129／`e2e-terminal` 27／`e2e-sysmon` 51／`e2e-agy` 98／`e2e-usage` 6／`e2e-live-pipeline`／
`e2e-dictation` 60／`e2e-ccswitch-gateway` 35／`e2e-code-usage` 16；
CDP（打包版）：`e2e-cdp-smoke` 22／`e2e-terminal-cdp` 30／`e2e-chat-cdp` 44／`e2e-sysmon-cdp` 83／
`e2e-usage-cdp` 20／`e2e-visual-cdp` 64／`e2e-stt-cdp` 21／`e2e-live-cdp` 6／`e2e-agy-cdp` 33／
`e2e-tray-cdp` 12／`e2e-ccswitch-cdp` 107／`e2e-dictation-cdp` 32／`e2e-ui-transcribe`／
`e2e-file-transcribe-black`，全數 0 failed。

預覽已更新：`dist/win-unpacked/VoiceInk.exe`（打包走 `%TEMP%/vi-pack3` ＋ robocopy `/XF app.asar`
＋ asar 就地覆寫；asar `969fa1d3…`、exe `609c1827…` 兩邊雜湊一致）。
順帶：`e2e-usage-cdp` 第一次紅燈是 Antigravity token 過期（跑 `agy models` 續期後全綠），不是程式問題。

- [x] 9. 新增 `scripts/probe-packed-local-llm.js`：打包版真的載一次本地模型翻一句話。
      v1.8.0 起 `node-llama-cpp/llama/**` 被整包排出 asar，只靠 `binariesGithubRelease.json`
      再 include 回來撐著——這條斷了雲端翻譯照樣好好的，沒有專門的 probe 就看不出來。
      實測 `dist` 版：`PASS 本地 LLM 跑得起來 → 你好，世界。`

## 完成（2026-09-01）— 語音輸入：字典真的生效＋長篇重寫

- [x] 1. 字典套兩次（送進整理模型前一次、模型回來後再一次）：小模型很常把換好的專名改回去，
      只套前面等於字典白設。學詞夾在中間跑，才看得到模型真正的意見。
- [x] 2. prompt 只帶這一段用得到的字典（`buildSystemPrompt({ text })`），並明講「已經是右邊的
      不要改回左邊」。60 條全帶會吃掉本地那顆 2048 token context 的一大塊。
- [x] 3. 字典自我修正：反向對從「忽略」改成回報 `demote` → 扣次數 → 停用 → 扣到零移除；
      手動加的（新欄位 `manual`）不扣。學錯的詞終於有機會自己退場。
- [x] 4. `MAX_DIFF_TOKENS` 400 → 1200：講超過三分鐘就再也學不到詞的問題。
- [x] 5. 整理分兩種模式（`text.cleanupMode`，門檻 180 字）：短句保守、長篇重寫
      （合併分次講的同一件事、改成寫出來會用的說法、依主題分段），重寫仍不准加料。
      模式在本地切段之前用整段長度決定。

驗證（實跑）：`node scripts/test-dictation.js` **114 passed, 0 failed**（新增 C／D／E／E2 共 21 條）／
`npx electron scripts/e2e-dictation.js` **67 passed, 0 failed**（新增 [F2] 字典壓過整理模型、
[F3] 長篇走重寫模式）／`node scripts/test-error-hygiene.js` 41 passed。

回顧：三件事其實是同一個根因——「字典只在管線前半段存在」。套一次、只在 prompt 提一次、
反向證據丟掉，三者都讓字典在整理模型面前沒有份量。修法統一成「字典是使用者的權威用詞，
模型不是」：前後各套一次、prompt 帶相關詞、模型的反對意見拿來扣分而不是丟掉。
長篇重寫則刻意不加設定開關（長度就是判準），少一個「設錯了但看不出來」的失敗方式。
已知取捨：本地那顆 context 2048，重寫仍是逐段各自重組，跨段搬移做不到（`index.js` 有 `ponytail:` 註記）。

## 完成（2026-09-02）— 額度：OpenCode Go 改走官方 API，新增 Ollama Cloud

- [x] 1. 端點探測（先做，不憑猜）：`GET https://opencode.ai/zen/go/v1/usage` 與
      `GET https://ollama.com/api/usage` 都是第一方但未文件化的路由。實測本機：
      OpenCode 回 **403 `EntitlementError`**（金鑰有效、沒有 Go 訂閱）、Ollama 回 **200**
      `{ activity, limits: { session: { usage }, weekly: { usage } } }`。
      新增 `scripts/probe-usage-endpoints.js` 固定這條驗證（不印金鑰、不印上游 body）。
- [x] 2. `usage/opencode.js` 整支改寫：唯讀 SQLite 成本推估 → 官方三個百分比視窗
      （rolling/weekly/monthly，`percent` ＋ 上游算好的 `resetsAt`），`accuracy` 從 `local` 變 `official`。
      **401 與 403 分開講**：403 是沒訂閱、401 才是金鑰壞掉；403 用 `disconnected`，
      免得 6h soft cache 把訂閱到期前的舊視窗撈回來看起來像還有額度。
- [x] 3. 新增 `usage/ollama.js`（第六家）：session／weekly 兩個視窗。`usage` 是 **0～1 的比例**
      不是百分比，而且上游**不給重置時間**——不自己算一個假的填進去。
- [x] 4. 新增 `usage/api-key.js`：兩家共用的金鑰解析唯一入口，順序是
      環境變數 → OpenCode `auth.json`（只讀不寫）→ CC 代理供應商 store。
- [x] 5. 順手刪掉現在沒有意義的東西：`opencodeWeeklyReset`／`opencodeMonthlyReset` 兩組設定
      （main store、renderer、彈窗 HTML、CSS 一起）、`OPENCODE_WINDOWS` 的美元上限、
      `mergeAccountState` 裡 opencode-go 的 soft cache 特例。UI 少一整個 fieldset。

驗證（實跑）：`node scripts/test-usage.js` **31/31**（新增 OpenCode 官方視窗／401 vs 403／
金鑰順序／Ollama 比例換算共 4 條）／`node scripts/test-error-hygiene.js` **56 passed**
（新段落：兩家 × 401/403/500 都不回送上游 body、不外洩金鑰）／
`npx electron scripts/e2e-usage.js` **7/7**（真實來源，ollama 兩窗、opencode 因無訂閱走 SKIP 分支）／
`node scripts/probe-usage-endpoints.js`（真上游）／打包版 `e2e-usage-cdp.js` **22/22**、
`e2e-cdp-smoke.js` **22/22**、`e2e-visual-cdp.js` **64 checks**。

回顧：原本那個「唯讀 opencode.db 加總 step-finish 成本」看起來很認真，其實量的是別的東西——
它含所有經 OpenCode 的供應商，跟 Go 訂閱的計費視窗根本不是同一件事，卡片上只能標「非官方額度」。
官方端點一存在，整套推估（三個視窗定義、兩組重置時間設定、SQLite 讀取、reset 日期計算）就全是負債，
所以是刪掉而不是留著當 fallback；本機成本統計本來就有「用量統計」那半在做。
已知取捨：Ollama 上游不給重置時間，卡片那格顯示「未提供重置時間」；OpenCode Go 的三個視窗
上游只給百分比，文件講的 $12／$30／$60 不換算進 UI（換算出來的數字看起來精確，其實是我們乘的）。

## 追加（2026-09-02）：Claude Code 的第三個視窗

- [x] 6. Claude Code 本來就走官方端點（`api.anthropic.com/api/oauth/usage`），但只畫了
      `five_hour`／`seven_day` 兩格；實測回應還有 **`seven_day_opus`**（Max 專屬的另一條上限，
      Claude Code 自己的 `/usage` 就是畫三格）。補成第三個 weekly 視窗，label `Opus`。
      非 Max 方案上游回 **`null` 不是 0**，靠既有的 `Number.isFinite` 跳過，不會憑空多畫一格 0%。
      同層還有 `seven_day_sonnet`／`tangelo`／`iguana_necktie` 等實驗欄位，實測全機 null，不收。

驗證（實跑）：`node scripts/test-usage.js` **31/31**（該條測試改成三窗＋非 Max 的 null 情境）／
`npx electron scripts/e2e-usage.js` **7/7**（本機帳號 `seven_day_opus` 為 null，照樣兩窗）／
打包版 `e2e-usage-cdp.js` **22/22**、`e2e-cdp-smoke.js` **22/22**。

## 追加（2026-09-02）：Command Code 成為第七家額度來源

> 前一則的「Claude Code Opus 視窗」是把使用者說的 Command Code 聽成 Claude Code 才做的，屬多餘工作。

- [x] 1. 實測確認端點存在：`api.commandcode.ai` 的 `/alpha/whoami`、`/alpha/billing/credits`、
      `/alpha/billing/subscriptions`、`/alpha/usage/summary` 不帶金鑰都回 **401**（＝路由在），
      `/provider/v1/models` 回 200。官方文件沒寫這幾支，形狀靠四份獨立實作＋一份逐字實機回應交叉比對。
- [x] 2. 新增 `usage/commandcode.js`：讀 `windowLimits.fiveHour`／`weekly` 的 `{used, cap, resetAt}`，
      **給的是真的用量與上限（credits），不是百分比**；`resetAt` 支援 epoch 秒／毫秒並轉 ISO。
      再以 `billing/subscriptions` 的方案週期補每月視窗；`cap` 缺了或是 0 就跳過那一格（畫成 0% 等於宣稱「你都沒用」）。
- [x] 3. 金鑰走 `api-key.js` 新增的 `resolveCommandCodeKey`：`COMMAND_CODE_API_KEY` →
      `~/.commandcode/auth.json` 的頂層 `apiKey`（**只讀不寫**）。跟 OpenCode 那份分組表格式不同，故分開一支。
- [x] 4. constants／index（job 順序要對齊 PROVIDER_IDS）／renderer PROVIDERS／app.js fallback／
      page-desc 六→七、CLAUDE.md 地雷、README、CONTEXT 同步。

驗證（實跑）：`node scripts/test-usage.js` **34/34**（新增三條：實機形狀、
「usage/summary 的花費報表不可當額度」、金鑰順序與缺 cap 跳過）／
`node scripts/test-error-hygiene.js` **65 passed**（三家 × 401/403/500）／
`npx electron scripts/e2e-usage.js` **8/8**（本機沒跑過 `cmd login`，走 SKIP 分支）／
`node scripts/probe-usage-endpoints.js`（真上游）／打包版 `e2e-usage-cdp.js` **22/22**、
`e2e-cdp-smoke.js` **22/22**、`e2e-visual-cdp.js` **64 checks**；dist 版重跑 `e2e-usage-cdp.js` **22/22**。

已知取捨：方案總額靠固定的 `planId` 對照表；遇到未知方案或訂閱資料失敗時，月額度降級不畫，
不拿剩餘值猜總額。這是 `/alpha` 路由，上游改版時會降級成「已連線但沒有回傳視窗上限」而不是顯示假數字。

### 修正：只有 API key 的人也要能用（2026-09-02）

回報：「commandcode 我只有一支 api key」——沒跑過 `cmd login`，所以 `~/.commandcode/auth.json` 根本不存在。
原本只認「環境變數 → auth.json」兩段，等於**有金鑰的人在 App 裡沒有任何地方填得進去**，
而錯誤訊息還叫他去跑一個他不需要的指令。

- [x] `resolveCommandCodeKey` 補第三段：CC 代理供應商 store（`readCcSwitchKey('commandcode')`），
      跟 OpenCode／Ollama 同一套。CC 代理頁本來就有 Command Code 這家（`auth: 'key'`），
      `seedBuiltins` 會自動補上那塊 tile，填進去就會被額度那邊讀到。
- [x] 未連線與 401 的說明改成指「CC代理頁填 API Key」，`cmd login` 降為括號裡的另一條路。

驗證：新斷言先在修復前跑過是紅的（33/34），修好後 `node scripts/test-usage.js` **34/34**；
`test-error-hygiene.js` **65 passed**；`npx electron scripts/e2e-usage.js` **8/8**；
打包版 `e2e-usage-cdp.js` **22/22**、`e2e-ccswitch-cdp.js` **117 checks**、`e2e-cdp-smoke.js` **22/22**。

---

## 風扇控制（系統監控 → 新子分頁「風扇控制」）

### 研究結論（2026-09-02，本機實測 Gigabyte X570 AORUS PRO + Ryzen 5700X + RTX 5060 Ti）

**可行。** 走已在用的 LibreHardwareMonitorLib（MPL-2.0，`resources/sensors` sidecar）即可，
不必新增任何依賴。`ISensor.Control.SetSoftware(0~100)` / `SetDefault()` 就是全部 API。

實測（`scratchpad/fanprobe`，提權執行）本機抓到 9 條可寫 PWM 通道，8 條有接風扇的**全部真的會動**：

| 通道 | 晶片 | 閒置 RPM | @100% | @40% |
|---|---|---|---|---|
| CPU Fan | ITE IT8688E | 1527 | 1524 | 730 |
| System Fan #1 | IT8688E | 3230 | 9507 | 5037 |
| System Fan #2 | IT8688E | 718 | 975 | 559 |
| PCH Fan | IT8688E | 0 | 5153 | 2974 |
| CPU Optional Fan | IT8688E | 1500 | 1503 | 698 |
| System Fan #4／#5 | IT8792E | 744 | 970 | 565 |
| System Fan #6 | IT8792E | 0 | 0 | 0 | ←沒插風扇 |
| GPU Fan | NVIDIA NVAPI | 3124 | 3754 | 2665 | ←下限 30% |

**「通用」的真實範圍**：LHM 有實作寫入的是 ITE IT87xx／Nuvoton NCT67xx／Fintek F718xx
（等於絕大多數桌機主機板）＋ NVIDIA NVAPI／AMD ADL 顯示卡 ＋ 部分 AIO 控制器
（Corsair Commander／NZXT／Aquacomputer）。**筆電幾乎都不行**（廠商自訂 EC，沒有公開介面）。
所以 UI 要能誠實地說「這台偵測到 N 條可控通道」而不是假裝人人有。

### 實測踩到的地雷（決定整個設計）

1. **手動 PWM 會留在晶片裡，程序死掉不會自動放手。**
   實測把 System Fan #2 設 100% 後硬殺程序，8 秒後另一支程序重讀仍是 `value=100`／997 RPM。
2. **`SetDefault()` 只還原「自己 Open 當下的快照」，不是「BIOS 曲線」。**
   實測用**全新**程序對同一條通道 `SetDefault()` **無效**（仍 100%）——因為它 Open 時看到的
   就已經是手動狀態。⇒ 崩潰後只有**重開機**（BIOS 在 POST 重新設定 SmartGuardian）能回復。
3. 因此安全機制不是選配：**下限保護（預設 30%）＋ 高溫緊急放手 ＋ 離開／關閉時主動還原 ＋
   「上次沒正常結束」偵測**。有下限的話，就算真的卡住也只是「風扇比較吵」，不會燒 CPU。
4. IT8688E 在 BIOS 自動模式下 PWM 讀值是 `null`，被設成手動後才讀得到數字（可當「誰在控制」的提示）；
   IT8792E 兩種模式都讀得到，**不能只靠讀值判斷模式**。
5. 同時開 SIV／EasyTune／FanControl／HWiNFO／Argus 會互相搶同一顆 Super I/O，要偵測並警告。

> ⚠ 研究過程中把本機「System Fan #2」留在 100%（997 RPM，原本 711）。重開機即回復。

### 設計

#### 1. 開機接管：一次 UAC，之後永不再彈

現在 sidecar 走 `Start-Process -Verb RunAs`，**每次啟動都彈 UAC**——開機自啟動時這是死路。
改成**排程工作**（FanControl／Rainmeter 同一套做法）：

- 使用者第一次按「啟用風扇控制」→ 彈**一次** UAC，用 `Register-ScheduledTask` 建一個
  **沒有觸發程序**（僅隨選）、`-RunLevel Highest` 的工作 `VoiceInk Sensors`，動作＝
  `VoiceInkSensors.exe <handoff 檔路徑>`。
- 之後每次要 sidecar：主程式把本次隨機管道名寫進 `<userData>/sensors-handoff.txt`
  → `schtasks /run /tn "VoiceInk Sensors"` → **提權執行且不彈 UAC**。sidecar 讀完立刻刪檔。
- **管道方向維持不變**（Node 是 server、sidecar 是 client）：主程式一定先跑，所以不必倒過來，
  也不必自己處理 pipe ACL。管道名仍是每次 session 128 bit 亂數。
- 工作**不加開機觸發程序**：App 本來就有開機自啟動（`--hidden`＋`closeToTray`），
  由 App 啟動時自己去 `schtasks /run`。少一個常駐提權程序，也省掉「sidecar 自己讀設定檔跑曲線」
  那一整套 C# 重複實作。接管延遲＝App 啟動時間（約 2 秒），這段期間由 BIOS 曲線負責，是安全的預設。
- **絕不整個 App 提權**（會讓終端機分頁開出管理員 shell，見地雷）。工作的動作只指向 sidecar 執行檔。
- 沒有排程工作時**退回現在的 `-Verb RunAs`**（每次一個 UAC），功能不消失。
- 打包版的執行檔在 Program Files（一般使用者寫不進去）；**開發版執行檔在使用者可寫的目錄，
  等於一條提權後門，所以「建立排程工作」只在打包版提供**。

#### 2. 視覺化：機殼／主機板示意圖 + 指派槽位

我們**拿不到**風扇的實體位置——晶片只給得出接頭名稱（`CPU Fan`／`System Fan #1`…）。
主機板實圖每張都不一樣，畫死一張＝只有這台能用。所以走**通用示意圖 ＋ 使用者指派**：

- 一張 SVG：機殼外框、主機板、CPU 散熱器、顯示卡、晶片組，加上**固定槽位**
  `cpu` `cpu-opt` `pump` `pch` `gpu` `front-1/2/3` `rear` `top-1/2` `bottom` `side`。
- 每個槽位是一顆風扇圖示，**轉速用 CSS animation 依即時 RPM 調 `animation-duration`**
  （沒轉就靜止），旁邊標指派到的通道名與 RPM。
- 指派方式：點槽位 → 選一條偵測到的通道；或從右側通道清單拖到槽位上。
  初始猜測靠名稱（`CPU Fan`→`cpu`、`PCH Fan`→`pch`、`GPU Fan`→`gpu`，`System Fan #N` 留「未指派」）。
- **「識別」按鈕是關鍵**：按下去把該通道拉到 100% 四秒再還原——使用者用**聽的**就知道是哪一顆。
  沒有這顆按鈕，示意圖只是在請使用者猜。（實測 System Fan #1 從 3230 → 9507 RPM，聽得非常清楚。）
- 未指派的通道照樣可以調，只是不出現在圖上（不強迫使用者先做拼圖）。

#### 3. 曲線編輯器（X = 來源值、Y = 轉速）

- X 軸來源**可選**：`CPU 溫度`／`CPU 使用率`／`GPU 溫度`／`GPU 使用率`／`NVMe 溫度`／`主機板溫度`。
  溫度與使用率**都是 0~100 的區間**，所以同一個圖形元件通吃，只換單位標籤。
- Y 軸是**轉速百分比（PWM）**，不是 RPM——我們能寫的只有 PWM，寫 RPM 等於騙人。
  圖上另外疊一顆**即時光點**（目前來源值 × 目前 PWM）並在旁邊顯示**實測 RPM**，兩者都看得到。
- 互動：拖點、線上點一下新增點、點上按 × 刪除；X 受左右鄰居夾住（保持遞增）、
  Y 夾在 `[minPwm, 100]`。**鍵盤可操作**（Tab 選點、方向鍵移動、Delete 刪除）。
- 曲線引擎的三個校正旋鈕（少了會來回震盪，硬體必要）：
  **遲滯 2°C**（來源值變動小於此不重算）、**斜率上限 5%/秒**、**取樣平滑 3 次移動平均**。

#### 4. 安全（因為 PWM 會留在晶片裡，這幾條是必須不是選配）

- **每條通道下限 `minPwm`**（預設 30，可調但不得 <20）：就算真的卡住也只是比較吵，不會過熱。
- **緊急放手**：來源溫度 ≥ `panicTemp`（預設 90°C）→ 該通道 100% 並退回 `bios`，UI 顯眼提示。
- **收尾**：`before-quit`、`sensors.stop()`、管道斷線三條路都要先送 `{"reset":1}` 等 ack 再結束。
- **sidecar 看門狗**：`HEARTBEAT_MS`（5 秒）內沒收到任何指令 → 自己全部 `SetDefault()` 後結束。
  主程式每秒送一次心跳，所以主程式被硬殺也會在 5 秒內放手。
- **`dirty` 旗標**：寫入前設 true、正常還原後設 false。啟動時看到 true ⇒ 上次沒正常收尾，
  UI 提示「重開機可回復 BIOS 曲線」（`SetDefault()` 救不回來，實測已驗證）。
- **衝突偵測**：SIV／EasyTune／FanControl／HWiNFO／Argus／Afterburner 執行中 → 顯眼警告，不擋。
- `fanControl` **不進 `STORE_ALLOWLIST`**：renderer 一律走 `sysmon:fan*` IPC，由 main 驗證後寫入
  （renderer 只送 identifier ＋ 數字，identifier 要對照 main 手上的即時通道清單驗過）。

#### 5. 版面

```
┌ 風扇控制 ─────────────────────────────────────────────┐
│ [接管風扇 ●] 已接管 5/9 條   [全部還原 BIOS]  ⚠ 警告列 │
├──────────────────────────┬────────────────────────────┤
│  機殼／主機板示意圖 (SVG) │  通道：CPU Fan   [識別 ♪]  │
│   ┌───────────────────┐  │  模式 ( )BIOS (•)曲線 ( )固定│
│   │ ▣top1  ▣top2      │  │  來源 [CPU 溫度 ▾] 下限[30%]│
│   │ ▣  ┌─────────┐ ▣  │  │  ┌───────────────────────┐ │
│   │front│  ▣cpu   │rear│  │  │      ╱‾‾ 可拖的折線    │ │
│   │ ▣  │ ▣gpu ▣pch│    │  │  │   ╱   ● 即時光點       │ │
│   │    └─────────┘    │  │  │_╱                      │ │
│   │      ▣bottom      │  │  └───────────────────────┘ │
│   └───────────────────┘  │  目前 52°C → 45%（1 180 RPM）│
├──────────────────────────┴────────────────────────────┤
│ 通道清單（未指派的也在這）：卡片一列，顯示 RPM／PWM／模式 │
└───────────────────────────────────────────────────────┘
```
≤900px 收成一欄（示意圖在上、編輯器在下）。

### 實作步驟

- [x] **[A] sidecar 改雙向**（`native/sysmon-sensors/Program.cs`）
- [x] **[B] 排程工作**（`src/main/sysmon/sensors-task.js`，僅打包版可安裝）
- [x] **[C] `sensors.js`**：`send()`、`stop()` 先 reset 再斷、優先走排程工作
- [x] **[D] 曲線引擎**（`src/main/sysmon/fans.js`）
- [x] **[E] IPC**（`sysmon/ipc.js` ＋ preload ＋ **`main.js` 的 service 白名單**）
- [x] **[F] 啟動接管**（`main.js`：`initStore()` 後 `ensureFanControl()`；`before-quit` await 交還）
- [x] **[G] UI**（`index.html` 子分頁 ＋ `sysmon-fans.js` ＋ `main.css`）
- [x] **[H] 驗證**（見下）

### 回顧

**做完了，端到端在本機實機驗過。**

實作與計畫的差異只有一處：指派方式從「拖曳」改成「點選＋下拉」——資訊量一樣，
但少一整套指標事件、而且天生可鍵盤操作。

#### 過程中發現、計畫裡沒有的三件事

1. **`PipeOptions.Asynchronous`**（最花時間的一個）
   雙向管道不帶這個旗標時，同一 handle 上的同步讀會把同步寫整個擋住：讀取執行緒卡進
   `ReadLine()` 之後，主迴圈的 `WriteLine` 再也送不出去。症狀是主程式只收到第一框、
   之後永遠「感測器沒有連線」，**完全不報錯**。
   最會騙人的是：我用來排查的 probe 每 2 秒送一次心跳，反而是**正常的**——每顆心跳讓
   `ReadLine` 返回一次，剛好打開寫入的縫隙。所以看起來像「probe 會動、正式路徑不會動」，
   一度以為是橋接寫錯。回歸因此改成**要看到連續 5 框**，只驗第一框抓不到。

2. **`main.js` 的 `registerSysmonIpc({ service })` 是逐一列舉的白名單**
   IPC 層寫好了、preload 寫好了、單元測試全綠，打包版點下去卻是「系統監控操作失敗」。
   這條在 CLAUDE.md 的 AGY 段落已經記過（`registerAgyIpc` 同樣的坑），但寫的是 AGY，
   所以看 sysmon 的時候沒聯想到。已在風扇段落補一條。

3. **殭屍 sidecar 會讓下一次啟動安靜失敗**
   提權跑的 sidecar 用一般 shell 的 `taskkill` 殺不掉（`Get-Process` 連 `Path` 都拿不到），
   要 `Invoke-CimMethod -MethodName Terminate`。留著的話它佔著 PawnIO，
   新 sidecar 的 `Computer.Open()` 會撞在一起——排查時紅了好幾輪都不是程式的錯。

#### 驗證（實際輸出）

| 指令 | 結果 |
|---|---|
| `node scripts/test-sysmon-fans.js` | 51 passed, 0 failed |
| `node scripts/e2e-sysmon-fans-cdp.js` | ALL PASS 18 passed |
| `node scripts/probe-sysmon-fans.js` | 實機 7 條風扇 100%/40% 全部 CONTROLLABLE；引擎接管後正常交還、dirty 清乾淨 |
| `node scripts/probe-sensors-task.js` | ALL PASS 8 passed（建立→免 UAC 觸發→提權確認→移除） |
| `node scripts/test-sysmon.js` | 172 passed, 0 failed |
| `node scripts/e2e-sysmon-cdp.js` | ALL PASS 112 passed |
| `node scripts/e2e-visual-cdp.js` | ALL PASS 71 visual checks |

實機 probe 的原始輸出：

```
偵測到 9 條可控通道：
  CPU Fan  [ITE IT8688E]  rpm=1506  ...
其中 7 條有接風扇（rpm > 200），逐條做 100%/40% 實測：
  CPU Fan: @100%=1510  @40%=740  => CONTROLLABLE
  System Fan #1: @100%=9507  @40%=5400  => CONTROLLABLE
  PCH Fan: @100%=5232  @40%=3082  => CONTROLLABLE
  ...（7/7 全部 CONTROLLABLE）
引擎接管 5 秒（曲線模式、CPU 溫度來源）…
  CPU Fan: applied=36%  rpm=625  panic=false
全部交還 BIOS …
  store dirty after release = false
```

#### 還沒做的

- **「靜音／平衡／效能」設定檔一鍵切換**：計畫階段就決定不做（YAGNI）。
  真的想要時，它是 `fanControl.channels` 的一組快照，加起來大概 30 行。
- **AIO 泵浦的專屬處理**：`System Fan #5 / Pump` 目前跟一般風扇同一套。
  泵浦通常不該低於某個轉速，但這台沒有水冷可測，沒有實機就不寫。

---

## 風扇控制 UI 改版（2026-09-02）

使用者回饋五點：機殼配置改成類 3D 斜上方視角／風扇轉速要正確捕捉／機殼左上・清單右上排好順序／
點清單風扇向下展開・曲線 UI 改善／勾選框與按鈕擺位整齊。

- [x] **等角（斜上方）機殼示意圖**：SVG 從世界座標 `(x 深度, y 寬度, z 高度)` 投影，
      風扇用「單位圓 ＋ 平面基底矩陣」躺在各自的面上；殼採半透明玻璃面，避免處理遮擋順序。
      座標用「投影後兩兩距離 ≥ r1+r2+4」驗過（第一版有兩組疊在一起）。
- [x] **轉速真的捕捉得到**：`System Fan #N` 現在會猜一個預設槽位（`fans.js` 的 `CHASSIS_ORDER`），
      以前這幾條 slot 是空的 → 示意圖上五顆風扇永遠不轉、看起來像讀不到轉速。
      扇葉週期改成跟真實 RPM 成正比的慢動作（`SPIN_SCALE`），並在註解與文件講明是慢動作。
- [x] **版面**：`.fan-layout` = 機殼配置（左）＋風扇通道清單（右），清單依槽位順序排序、
      同組再依接頭名稱自然序（`System Fan #10` 不會排在 `#2` 前面）。
- [x] **手風琴**：點一列就地向下展開設定，再點一次收起。`#fanEditor` 只有一份、由 JS 搬進那一列；
      沒展開時掛回清單底下並 `hidden`（脫離 DOM 就再也 `getElementById` 不到）。
- [x] **曲線 UI**：加大、曲線下方填色、下限畫成禁區、即時值加垂直參考線、拖曳時顯示座標讀數、
      刻度帶單位、點的命中範圍加大；圖寬設上限（不然一顆風扇就佔滿整頁）。
- [x] **操作列**：自繪開關 ＋ 狀態 ＋ 右側兩顆等高按鈕（「建立排程工作」從提示文字裡搬出來）；
      模式改成三選一的分段控制；欄位排成 `auto-fit` 網格，標籤與輸入對齊。
- [x] 回歸：`e2e-sysmon-fans-cdp.js` 補「CSS 變數沒打錯（量實際顏色）」「槽位有 `<title>`／只印短代碼」
      「編輯器收起時仍在 DOM 裡」，並把切分頁的固定 sleep 改成 `waitFor`（原本會偶發假紅燈）。

### 回顧

真正的 bug 只有兩個，其餘是版面：

1. **`var(--surface)`／`var(--accent)`／`var(--border)` 在 `themes.css` 裡不存在**
   （正確是 `--surface-glass`／`--surface-solid`、`--accent-primary`、`--border-color`）。
   CSS 變數打錯不報錯，只會安靜地變成「沒有背景」，SVG 的 `fill` 則變**純黑**。
   上一版風扇 CSS 已經有同樣的錯，只是不夠明顯。
2. **機殼風扇沒有預設槽位** → 示意圖上那幾格永遠是空的、不轉。這就是「轉速沒有正確捕捉」的實情。

驗證用的殼：`contextBridge` 的物件是 frozen 且 non-configurable，CDP 換不掉 `fanList`；
改成另起一個 `contextIsolation: false` 的視窗載 vite 的 renderer、preload 直接塞假 API，
就能在不碰真硬體、不跳 UAC 的前提下量版面、截圖、模擬拖曳（視窗用 `showInactive()` 不搶焦點）。
