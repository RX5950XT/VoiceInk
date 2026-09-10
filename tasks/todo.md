# 終端機體驗升級（1-7、10 ＋ 串流閃爍）

審查結論：底層（IME、獨立宿主、忙碌判定）紮實，缺的是使用者每天碰得到的表層功能。

## 待辦

- [x] 1. WebGL renderer（`@xterm/addon-webgl`）——同時是「游標跟著閃」的根因修復
- [x] 2. 搜尋（`@xterm/addon-search`）：Ctrl+F，Enter／Shift+Enter 前後找，顯示第幾筆／共幾筆
- [x] 3. 字級縮放：Ctrl+滾輪、Ctrl+= / Ctrl+- / Ctrl+0，存 store（`termFontSize`）
- [x] 4. Unicode 11 寬度（`@xterm/addon-unicode11`）
- [x] 5. `pty.js` 的 scrollback 不要每個 chunk 都重切 256KB
- [x] 6. 分頁標題跟著跑什麼變（OSC 0/2）、cwd 跟著 `cd` 走（OSC 7）；連結解析改用即時 cwd
- [x] 7. 分割顯示：同一個 `#termHost` 裡並排最多 3 個工作階段
- [x] 10. 安靜的 build 不再被誤判成「已完成」
- [x] 驗證：main 端單元測試、閃爍量測
- [ ] 驗證：打包版 CDP（`probe-terminal-upgrade.js`）

## 閃爍：查到的與被推翻的

用 `scripts/probe-terminal-flicker.js` 在真的 Chromium 裡量（2.4 秒、29 幀 Ink 式重畫）：

| renderer | 重畫 | 游標移動 | 游標 DOM 重建 | textarea 位置變動 |
|---|---|---|---|---|
| dom | 29 | 88 | **30** | 1 |
| webgl | 29 | 88 | **0** | 1 |

1. **游標（成立）**：DOM renderer 把游標畫成 `<span class="xterm-cursor-blink">`，閃爍是 CSS
   `animation: 1s step-end infinite`。那一列每一幀被重建 → 動畫每一幀從 0%（實心）重來 →
   游標永遠跑不完一個週期。WebGL 畫在 canvas 上、閃爍走自己的計時器，重建 0 次。
2. **選字框（推翻）**：原本猜是 `onCursorMove → _syncTextArea()` 沒合到幀、把隱形
   `<textarea>` 搬來搬去，讓輸入法候選視窗跟著跳。**實測 88 次游標移動只換來 1 次位置變動**
   ——每一輪重畫完游標都回到輸入行同一格，中間那些移動在同一個同步批次裡就抵銷了。
   所以候選字視窗看起來在閃**不是位置在抖**，是它底下那顆游標在閃；治的是 renderer。
   `probe-terminal-flicker.js` 留了一條反向斷言釘住「textarea 幾乎不動」。

第一次量的時候兩邊都是 0，那是**假的**：視窗沒有焦點時 xterm 根本不畫游標
（`.xterm-cursor` 整顆不存在）。所以那支 probe 刻意要焦點。

## 順手修掉的既有問題

- `test-terminal-ui.js`／`test-terminal-drop.js` 在 HEAD 就已經壞了（終端機桌布那次加了
  top-level `normalizeAppearance({})`，這兩支的 VM harness 沒補樁 → 載入期 ReferenceError）。
  補了兩行樁。

# 2026-09-10 — 效能、記憶體與死碼清理

- [x] 追查 main／renderer 資源生命週期與死碼，建立可重現基準。
- [x] 最小修復並驗證受影響功能。
- [x] 打包、背景驗收，回報量測與 Rust 取捨。

## 改了什麼

| 位置 | 問題 | 修法 |
|---|---|---|
| `ws-tabs.js` `paintPreview`／`paintPdf` | 關掉 PDF 只移除 canvas，pdf.js 的文件（含 worker 資源）沒人 `destroy()` | 用 `activePdfCleanup` 記住這一份的清理器，切走／關掉／換內容時取消繪圖再 `destroy()` |
| `ws-git-status.js` `gitStatusShared` | 快取只看「發出時間」，`git status` 超過 500ms 就再開一趟一模一樣的子程序 | 加 `pending` 旗標：同一趟還沒回來就共用，快取從**完成**時開始算 |
| `codeusage/index.js` `runSync`／`reset` | 連續 5 次 `store.set`＝把 1.5MB 的 `code-usage.json` 讀寫 5 遍（`conf` 每次 set 都整份 serialize＋寫檔） | 併成一次 `s.set({ ... })` |
| `usage-reorder.js`／`ws-tabs.js`／`ws-tool-icons.js`／`ccswitch-page.js` | `capturePositions`／`animateFlip`／`moveTab`／`toolIconNames`／`initCcSwitchPage` 全 App 零呼叫點 | 刪掉，連同只測它們的測試 |

## 順手修掉的既有假紅（不是這次改出來的）

- `probe-workspace-bigfile.js`：還在按「切預覽」鈕，但文件類開檔早就預設是預覽模式。
- `test-workspace-ui.js`：PDF 標記那條斷言比對**舊的字面寫法**，改成「每次套倍率前都先標記」的不變式（反向驗證過：把標記移到套倍率之後會紅）。
- `e2e-workspace-cdp.js` `[AE]`：v1.19.7 把 Ctrl+G 的「儲存」與「送出」拆開後，按鈕就叫「儲存」，斷言沒跟上。

## 驗證

- 單元：`test-workspace`(231)／`-nav`／`-state`／`-perf`(11)／`-ui`(113)／`-pdf-lifecycle`／`test-usage-reorder`(10)／`test-code-usage`(148)／`test-usage`(34)／`test-ccswitch`(258)／`test-markdown`(23)／`test-terminal-ui`(12) 全綠。
- 新回歸 `test-code-usage-persistence.js`：現行版 1 次寫入 PASS，`--baseline`（HEAD）5 次寫入 FAIL——**紅過才算數**。
- 打包版（worktree 自己的 `dist/win-unpacked`，asar 抽 `ws-tabs.js` 出來 `node --check` 過，沒錯位）：
  `probe-workspace-bigfile.js` 12/12、`probe-workspace-perf.js` 18/18、`e2e-workspace-cdp.js` 176/176、
  `e2e-ccswitch-cdp.js` 125、`e2e-usage-cdp.js` 23、`e2e-cdp-smoke.js` 22/22、`e2e-code-usage.js` 16。

實測堆積（`probe-workspace-bigfile.js`，1.4MB／4 萬行）：開檔前 10.2MB → 開大檔 18.4 → ＋diff 72.3 →
全關掉 21.5，第二輪關掉 22.4（多 0.9MB，沒有每開一次漏一份）。**不宣稱整個 App 的記憶體下降多少**，
這次修的是「開著 PDF／頻繁查 Git／背景同步用量」這三條路徑上的浪費。

## 要不要換 Rust

不值得。理由是**熱點不在 JS**：

1. 真正吃 CPU 的（ASR、LLM 推論、GGUF 解析）本來就在原生程式裡（sherpa-onnx、llama.cpp、node-llama-cpp），
   JS 只負責喊它、接串流。
2. 這次量到的三個浪費——PDF 文件沒釋放、同一個 `git status` 開兩趟、同一份 JSON 寫五遍——
   **換成 Rust 一個都不會自己消失**，那是生命週期與呼叫次數的問題，不是語言速度的問題。
3. Electron 的 UI 那一層本來就只能是 JS；重寫等於連 UI 框架一起換掉，成本是整個專案，效益沒有證據。

真要用 Rust 的時機：日後量到**某段純計算長期吃滿 CPU**（例如用量統計掃 GB 級 JSONL 變成瓶頸），
那時把那一段做成 napi-rs 模組局部替換就好，不必動其他地方。
