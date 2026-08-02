# CONTEXT.md — 開發紀錄交接文件

> 給下一個 AI Agent 的接手指南。保持精簡，每次任務完成後更新。
> 規範與地雷見 [CLAUDE.md](./CLAUDE.md) / [AGENTS.md](./AGENTS.md)；歷史教訓見 [tasks/lessons.md](./tasks/lessons.md)。

## 專案概況

VoiceInk：Windows Electron 語音轉文字（檔案轉錄＋即時字幕＋翻譯與 TTS）。Vanilla JS + Vite，無框架。
版本 **1.7.0**（Release `v1.7.0`：LinguaForge think 前綴修正、Q8／Q4 量化可選、譯文清理獨立模組）。

## 架構

```
src/main/
  main.js             frameless 主窗 + IPC；localAsr 依 asrEngine 分流
  models.js           registry：qwen3asr、qwen35translate、linguaforge08(Q8)、linguaforge08q4(Q4)
  gpu-capability.js   NVIDIA VRAM 門檻（≥6GB）／cuda-env.js CUDA 偵測安裝
  local-asr.js        sherpa-onnx 本地 ASR（CPU）
  cloud-asr.js        OpenAI 相容 /audio/transcriptions
  local-llm.js        翻譯 cloud/local；多 GGUF + CPU/GPU；LINGUAFORGE_DECODE 查表
  translate-clean.js  譯文清理（純文字、無 electron 依賴，可 node 直測）
  file-transcribe.js  本地 f32le 28s；雲端 mp3 segment 50s
  edge-tts.js         Edge TTS + ttsRate（%）
  engine.js           owner live|file|translate；雲端 ASR 時 needs.asr=false
src/renderer/scripts/
  app.js  translate-page.js  live-caption.js  transcribe.js
```

| 項目 | 說明 |
|---|---|
| ASR | `asrEngine` = local（Qwen3-ASR-0.6B）/ cloud（`asrApiUrl`/`asrApiKey`/`asrModelId`） |
| 翻譯 | `translator` = cloud / local；`localTranslateModel` = `linguaforge08`(Q8，預設) / `linguaforge08q4`(Q4) / `qwen35translate`；`llmGpu` |
| TTS | Edge TTS；`ttsVoices` + `ttsRate`（-50…100 → Edge rate %） |
| 設定 UI | 導航第四 tab；區塊：模型／翻譯／語音轉文字／外觀／語音 |
| 視窗 | 主窗 frameless（header 含 min/max/close）；字幕彈窗獨佔顯示模式 |

模型存放：`%APPDATA%/voiceink/models/<key>/`。

## 最近變更（2026-08-03）— Qwen3.5 空 think 前綴（根因）＋ Q8／Q4 可選 ＋ v1.7.0 發行

- **根因**：Qwen3.5 chat template 在 `<|im_start|>assistant\n` 後**固定補** `<think>\n\n</think>\n\n`（token `248068,271,248069,271`），模型帶著它訓練與評測。node-llama-cpp 3.19 自動解析的 Qwen wrapper **不補** → 掉出分布。先前歸咎「模型／語料」的三精度共通缺陷（標籤前綴、專名消失、年份幻覺）全部出自這裡
- **修法（一行）**：`getSession` 的 `LlamaChatSession` 帶 `newQwen35ChatWrapper(QwenChatWrapper)` ＝ `new QwenChatWrapper({ thoughts: 'discourage' })`
  - `node scripts/probe-prompt-path.js` 實測與 transformers `apply_chat_template` **逐字元相同** → 不需 INTEGRATION.md 建議的自訂 subclass
  - `budgets.thoughtTokens:0` 是「不生成 thinking」，補不了前綴，兩件事都要做
- **30 句客觀對照**（`node scripts/verify-chat-wrapper-fix.js`，樣本／指標在 `scripts/bench-cases.js`）：

| GGUF | 標籤前綴 | 拉丁專名保留率 | 憑空年份 | 缺陷總數 |
|---|---|---|---|---|
| Q4_K_M 修前 | 8 | 46.7% | 2 | 20 |
| Q4_K_M 修後 | 0 | 80.0% | 0 | 5 |
| Q8_0 修前 | 9 | 73.3% | 2 | 20 |
| **Q8_0 修後（出貨）** | **0** | **93.3%** | **0** | **6** |

  門檻（標籤=0／專名≥90%／年份=0／總數<8）**Q8_0 修後 ALL GATES PASS**；Q4 只差專名保留率
- **Q4／Q8 可選**：Q4 另開 registry key `linguaforge08q4`（獨立資料夾／下載），設定→翻譯三顆按鈕。預設 Q8（774MB）；Q4（505MB）CPU 約快 2.2×，代價是罕見專名音譯（實測同句 Q8「超越Kimi k3…和Sol一樣強」／Q4「比金剛大3倍…和索爾一樣強」）
  - 兩量化共用 SFT 格式與 DECODE → `local-llm.isLinguaforge(key)`；renderer 切段 `startsWith('linguaforge08')`
  - 舊用戶 `linguaforge08/` 底下的舊 Q4 檔不會自動刪，可手動清
- **未修（語料缺口，勿為此調 prompt）**：多行且各行互不相關（規格表）只譯第一行；`open weight`／`agentic` 等 2023 後 AI 術語
- 順修：cdp-smoke「長文分段」斷言寫死 4 段（280 字切段後應為 8 段，一直是假綠燈）→ 改讀 UI 的「N 字（M 段）」
- 驗證：`e2e-linguaforge-quant` ALL PASS、`-decode` A–E ALL PASS（log 含 `chat_wrapper`／`think_prefix_token_ids`）、`-list`／`-leak`／`-context` ALL PASS、`e2e-local-translate-settings` ALL PASS（雙模型 × CPU/CUDA）、`e2e-cdp-smoke` **13/13**、`electron:build` 出 `VoiceInk Setup 1.7.0.exe`（290MB）已上傳 Release

> ⚠️ 2026-08-02e 的「量化對照」結論（三精度共通缺陷＝模型問題、維持 Q4）**已被推翻**：三次都缺 think 前綴，同一變因沒被控制。

## 先前變更（2026-08-02 系列）— LinguaForge 出貨對齊

- **解碼對齊 GGUF**：`local-llm.js` 集中 `LINGUAFORGE_DECODE` — 雙 EOS `[248046,248044]` + `customStopTriggers`；**zhtw `repeatPenalty:false`**（省略時預設 1.1 會攪繁簡）、en/ja 1.1；`dryRepeatPenalty.allowedLength=3` 近似 `no_repeat_ngram_size=4`；`temperature=0`、`thoughtTokens=0`、`maxTokens≈源長×2`（64–768）；每次 log `[linguaforge decode]`
- **長文每段吐同一句**：`translateLocalOnce` 把前文塞進 chat history，LinguaForge 是單輪 SFT MT 模型，greedy 直接複誦上一輪 assistant → `isLinguaforge` 時 `pair = null`
- **條列貼文退化**：逐行翻譯、行首清單標記（`· ` `- ` `1. `）剝除後才送、翻完貼回（`splitLinesForLinguaforge`）；退化迴圈由 `findRepetitionLoop` 偵測後開 rep-penalty 重跑該段（重試前必 `setChatHistory(history)` 還原）
- **譯文純淨度**：清理抽到 `src/main/translate-clean.js` — persona 標籤白名單（原文沒冒號才剝）／整段包覆才剝引號、單側僅在無配對時剝／`stripTranslationNoise(raw, source)` 帶原文判斷列點；除錯 `VOICEINK_DEBUG_RAW=1`
- **s2twp 竄改**：`twp` 會把「總參數」改成「總引數」→ 先以 `to:'tw'` 純字形探測，沒簡體就原樣回傳（ASR 共用同函式）
- 模型路徑：`gguf-v5e/linguaforge-v5e-0.8b-{Q8_0,Q4_K_M}.gguf`（HF repo `RX5950XT/LinguaForge-Qwen3.5-0.8B-zhTW-en-ja`）
- 已知殘留（0.8B 能力，非工程層可修）：偶發整句幻覺、片語誤譯；e2e 斷言刻意只驗結構／污染／退化，不把用詞正確性當紅燈

## 關鍵技術備忘

- **sherpa-onnx-node@1.13.4**：Windows 需在 require 前把 `node_modules/sherpa-onnx-win-x64` 加入 `PATH`（`local-asr.js` 已處理，含 asar.unpacked 替換）。Qwen3 config 鍵：`qwen3Asr:{convFrontend,encoder,decoder,tokenizer,hotwords}`；輸出 strip `<sil>` 等 token；`decodeAsync` 的 JSON.parse 需 patch 防控制字元
- **node-llama-cpp@3.19** 是 ESM，main 用動態 `import()`；Qwen 系列關 thinking
- **冷啟動**：`warm()` 內含拋棄式暖機推論（首次 compute-graph ~12.5s 挪到背景預熱），否則第一句翻譯會塞爆佇列
- **打包用 `src/` 原始碼**：`build.files` 排除 `dist/**`，main `loadFile('../renderer/...')` 從 asar 內載入原始 ESM/HTML；`vite build` 僅語法驗證
- **`electron:build` / `electron:pack` 前要先關掉開著的 `dist/win-unpacked/VoiceInk.exe`**，否則 `d3dcompiler_47.dll: Access is denied`
- 即時字幕：佇列「保留最新 pending」；靜音門檻 peak normalize 後 RMS>0.01 且 speechRatio>0.05；`hasLinguisticContent` 只認 `\p{L}`（純符號碎片會讓 0.8B 當聊天回問候）
- **Edge TTS** 永遠需連網；voice 僅 `tts-voices.js` allowlist，renderer 只傳 `lang`
- e2e：`npx electron <script>` 直測 main（app 名為 `Electron`，需先 `app.setPath('userData', join(getPath('appData'),'voiceink'))`）；CDP 驅動打包版 `--remote-debugging-port=9223`，長工作用 Node 端 2s 輪詢，勿用單次 `awaitPromise`

## 歷史變更摘要

| 日期 | 內容 |
|---|---|
| 2026-08-01 | LinguaForge v5e 模型路徑（舊 v3 作廢） |
| 2026-07-27/28 | 翻譯頁解除字數限制（`splitForTranslate` 自動分段、可中途停止）；LinguaForge 屏蔽後恢復 |
| 2026-07-26 | frameless 主窗；本地雙翻譯模型＋`llmGpu`（cuda→vulkan→CPU）；CUDA 環境自動安裝；修 `LLM load cancelled`（同指紋 in-flight join） |
| 2026-07-24 | 設定改第四分頁；雲端 ASR；TTS 語速 |
| 2026-07-18 | 第三頁「翻譯與 TTS」＋Edge TTS；顯示模式搬進字幕視窗；模型載入並行化＋分頁預熱；長檔串流轉錄（ffmpeg 28s，≥2h／100MB）；黑屏修復；sherpa JSON 控制字元；日文複誦三層防護＋s2twp；全專案審計 15 項修補 |
| 2026-07-17 | 移除雲端轉錄路徑；ASR 只留 Qwen3-ASR-0.6B；翻譯 prompt 改 system + chat history（括號式模板會被複誦）；即時字幕全鏈路體檢 |

## 已知限制／未來方向

- 固定 2s 切塊會切斷字詞邊界 → 升級路徑：silero-vad（sherpa-onnx 內建）
- 字幕透明度用整窗 `setOpacity`（文字也變淡）；transparent window 在 Windows 有坑
- 本地檔案轉錄硬切 28s 邊界仍可用 VAD 改善
- GGUF 只能 greedy，出貨 `evaluate.py` 的 beam=4 + length_penalty=1.2 無法對齊
- Qwen3-ASR-1.7B（更準，int8 ~2GB）可加入 registry；PRD backlog 見 `tasks/todo.md`
