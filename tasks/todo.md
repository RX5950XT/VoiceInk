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

## Review

- 既有 release：`v1.0.0`、`v1.1.0` → 本版用 **v1.2.0**（不重複）
- 指令：`npm run electron:pack`（預覽）、`npm run electron:build`（安裝檔）
- 對抗性審查納入：find-by-id upsert、batch 狀態機、epoch 清佇列、mutex、batch 勿同時砍 tokens
