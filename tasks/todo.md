# VoiceInk — 任務追蹤

## v1.2.0（2026-07-17）

- [x] 本地 ASR only：移除雲端轉錄、FireRed；固定 Qwen3-ASR-0.6B
- [x] 設定 UI：模型狀態卡、雲端 API 僅 cloud 時展開
- [x] 規範：任務結束先 `electron:pack` 更新免安裝預覽
- [x] 文件維護（README / AGENTS / CLAUDE / CONTEXT）
- [x] 建置安裝檔並發佈 GitHub Release v1.2.0

## Review

- 既有 release：`v1.0.0`、`v1.1.0` → 本版用 **v1.2.0**（不重複）
- 指令：`npm run electron:pack`（預覽）、`npm run electron:build`（安裝檔）
