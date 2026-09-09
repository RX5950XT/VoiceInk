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
