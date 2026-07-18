# VoiceInk — 任務追蹤

## v1.2.0（2026-07-17）

- [x] 本地 ASR only：移除雲端轉錄、FireRed；固定 Qwen3-ASR-0.6B
- [x] 設定 UI：模型狀態卡、雲端 API 僅 cloud 時展開
- [x] 規範：任務結束先 `electron:pack` 更新免安裝預覽
- [x] 文件維護（README / AGENTS / CLAUDE / CONTEXT）
- [x] 建置安裝檔並發佈 GitHub Release v1.2.0
- [x] 即時字幕翻譯上下文融合（模型外：前文 + prompt + live tokens + 先顯原文）
- [x] 雙語／僅翻譯顯示模式 + ASR∥翻譯分離 + openBatch 合併 + upsert 字幕
- [x] 即時頁顯示模式 UI；engine warm/unload；quit 清記憶體；修 pump／空譯文
- [x] 修即時翻譯 prompt 複誦：括號式 prompt → system prompt + chat history（本地/雲端 e2e 驗證）
- [x] 即時字幕全鏈路體檢：多代理審查＋對抗性驗證，修 15 項（stale in-flight guard、history 污染/錯位、重入、track ended、佇列上限、螢幕外還原、Alt+F4 通知、isDestroyed、雲端逾時、token 上限、設定快照、日韓判定）

## v1.3.0（2026-07-18）

- [x] 顯示模式（雙語／僅翻譯）搬進字幕彈窗，由彈窗獨佔 store `captionDisplayMode`；即時頁移除 segment＋清跨窗 IPC
- [x] 關窗雙向同步實測確認（彈窗 ✕／Alt+F4 ↔ 即時頁開始/停止）
- [x] 加快模型載入：engine warm 並行（Promise.all）＋進 live 分頁背景預熱、離開卸載
- [x] CDP 驅動打包版全鏈驗證（結構／彈窗切換／預熱／冷卻／關窗訊號）＋ engine 並行 warm e2e
- [x] 修日文翻譯被複誦（雙語兩行日文）：移除 identity 前文源頭（`pushPair(原文,原文)`）＋ echo 自我複誦守門 ＋ `buildContextPair` 過濾 identity；`repro-ja.js` e2e 驗證修前後
- [x] UI 清理：移除「💡 使用說明」info-card ＋ 綠色成功 toast（僅留紅色錯誤 toast）
- [x] 譯文轉繁 s2twp（抽 `opencc.js` 共用）＋ main 側 echo 守門（先判複誦再轉繁）；KO/JA/EN 譯文全繁體
- [x] 語言偵測評估：實測 0.8B 當偵測器準確率 ~3/7、中文不保證 echo → 不採用，保留啟發式（見 CONTEXT）

## v1.3.0 修補（2026-07-18c）

- [x] 修「英文翻譯只剩原文」＋開始字幕卡頓（同源）：`local-llm.warm()` 加拋棄式暖機推論，把 ~12.5s compute-graph 冷啟動挪到背景預熱；e2e 第一句 12,493ms→249ms、`engine.acquire('live')` 後 462ms
- [x] 診斷排除 LLM 邏輯（e2e 英文→繁中零複誦）、opencc、目標語；真因為冷啟動丟批次 × 僅翻譯顯示模式回退原文
- [x] 存設定回饋：`saveSettings` 加回中性 `showToast('設定已儲存')`（非綠條）
- [x] 預熱期間 `statusText` 顯示「準備模型…」
- [x] `electron:pack` 重建預覽 + CDP 開機煙霧測試通過

## 2026-07-18g — 長檔／大檔轉錄

- [x] main `file-transcribe.js`：ffmpeg 串流 16k mono + 28s 切段 ASR
- [x] 上限 200MB／4h（保證 ≥100MB／≥2h）；進度 IPC；cancel
- [x] renderer 改 `getPathForFile` + `transcribeFile`；修 chain 尾段死鎖
- [x] e2e `scripts/e2e-file-long.js` 60s→3 段 ALL PASS；`electron:pack`

## v1.3.0 全專案審計修補（2026-07-18d）

- [x] 四代理平行審查（main／ASR-LLM／renderer／安全）
- [x] ASR serial lock + loadEnabled 防幽靈重載；displayMedia catch；openFolder 白名單
- [x] 檔案轉錄重入鎖 + cloud apiKey 預檢；prewarm generation 防洩漏
- [x] sandbox、store allowlist、導覽守衛、subtitle CSP、s2twp 條件化等
- [x] 驗證：`scripts/e2e-audit-fixes.js` 15/15、`e2e-cdp-smoke.js` 8/8、`electron:pack`

## v1.3.0 非語言碎片 persona 問候（2026-07-18e）

- [x] 根因：ASR 純符號碎片（So/Cf）過舊 `\p{P}` guard → 0.8B 當聊天回 persona
- [x] `hasLinguisticContent`（`\p{L}`≥2）擋在進管線前；純符號不建字幕行
- [x] main `translate` 同構短路徑 + live system prompt 改祈使句
- [x] 文件 CONTEXT／lessons；pack 更新預覽

## Review

- 既有 release：`v1.0.0`、`v1.1.0` → 本版用 **v1.2.0**（不重複）；目前 **v1.3.0**
- 指令：`npm run electron:pack`（預覽）、`npm run electron:build`（安裝檔）
- 對抗性審查納入：find-by-id upsert、batch 狀態機、epoch 清佇列、mutex、batch 勿同時砍 tokens
- 2026-07-18d 審計：ASR 生命週期對齊 LLM 紀律；IPC 信任邊界（store/openFolder）；prewarm 旗標時序

## 已知未做（低優先／產品取捨）

- 模型下載 SHA-256 完整性校驗
- API Key `safeStorage` 加密
- 下載 timeout / re-verify
- 手動來源語言選單（取代 needsTranslation 啟發式）

## v1.4.0（2026-07-18）

- [x] 長檔串流轉錄：ffmpeg ≥2h／≥100MB（上限 4h／200MB）
- [x] 檔案轉錄黑屏：進度 UI 先 paint、ASR/LLM 分階段
- [x] sherpa JSON 控制字元崩潰修復
- [x] 非語言 ASR 碎片 persona 問候防護
- [x] 翻譯冷啟動暖機、日文複誦／繁體、全專案審計修補
- [x] 發佈 GitHub Release v1.4.0（不重複版本號）
