/**
 * 分頁列「＋」選單的圖示。
 *
 * 全部是 16×16 的單色 SVG，顏色吃 `currentColor`——選單本來就只有一種前景色，
 * 品牌彩色圖檔在深／淺主題各要一份，還會撞上「全 App 禁用強調條」那條規矩。
 *
 * 畫的是**幾何近似**不是原廠向量檔：16px 下原廠標誌一律糊成一團，
 * 這裡取每一家最好認的那個輪廓（Claude 的放射星芒、xAI 的斷開 X…）。
 *
 * 零 innerHTML（跟 `markdown.js` 同一條規矩）：全部走 `createElementNS`。
 */

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * `fill` 的那幾支是實心色塊，其餘走 1.5px 描邊。
 * @type {Record<string, { d: string[], fill?: boolean }>}
 */
const ICONS = {
  // 終端機：提示字元的 `>` 與游標底線
  shell: { d: ['M3.6 5 6.9 8l-3.3 3', 'M8.8 11.2h3.6'] },

  // Claude：九道放射星芒（Anthropic 的日芒）
  claude: {
    fill: true,
    d: ['M8.90 7.50L8.14 1.60L7.86 1.60L7.10 7.50ZM9.01 8.20L12.22 3.19L12.01 3.01L7.63 7.04ZM8.65 8.80L14.33 7.03L14.28 6.75L8.34 7.03ZM7.98 9.03L13.47 11.32L13.61 11.08L8.88 7.47ZM7.33 8.78L10.06 14.06L10.32 13.97L9.02 8.16ZM6.98 8.16L5.68 13.97L5.94 14.06L8.67 8.78ZM7.12 7.47L2.39 11.08L2.53 11.32L8.02 9.03ZM7.66 7.03L1.72 6.75L1.67 7.03L7.35 8.80ZM8.37 7.04L3.99 3.01L3.78 3.19L6.99 8.20Z']
  },

  // Codex：OpenAI 那顆六角結——外六邊形＋內部三叉
  codex: {
    d: [
      'M8 1.7 13.5 4.85v6.3L8 14.3 2.5 11.15v-6.3Z',
      'M8 8V4.85', 'M8 8l2.7 1.57', 'M8 8 5.3 9.57'
    ]
  },

  // OpenCode：程式碼尖括號
  opencode: { d: ['M5.9 4.2 2.4 8l3.5 3.8', 'M10.1 4.2 13.6 8l-3.5 3.8'] },

  // Antigravity：往上脫離的箭頭（反重力）
  agy: { d: ['M8 1.9a6.1 6.1 0 1 1 0 12.2A6.1 6.1 0 0 1 8 1.9Z', 'M8 11V5.2', 'M5.6 7.6 8 5.2l2.4 2.4'] },

  // Grok：xAI 那個斷開的 X
  grok: { d: ['M3.2 13.2 12.8 2.8', 'M3.2 2.8 6.7 6.9', 'M9.3 9.1l3.5 4.1'] },

  // 終端機（自訂…）：提示字元＋一個小加號（自己挑 shell 與工作目錄的那條路）
  custom: { d: ['M3.2 4.4 6 7.2l-2.8 2.8', 'M8.6 12.2h4.6', 'M10.9 9.9v4.6'] },

  // 瀏覽器：地球
  browser: {
    d: [
      'M8 1.9a6.1 6.1 0 1 1 0 12.2A6.1 6.1 0 0 1 8 1.9Z',
      'M1.9 8h12.2',
      'M8 1.9c1.7 1.7 2.6 3.8 2.6 6.1S9.7 12.4 8 14.1C6.3 12.4 5.4 10.3 5.4 8S6.3 3.6 8 1.9Z'
    ]
  }
}

/**
 * 做一顆圖示。名字不認得時回 `null`（呼叫端就只畫文字，不要塞一個空方框）。
 * @param {string} name
 * @returns {SVGSVGElement | null}
 */
export function toolIcon(name) {
  const spec = ICONS[name]
  if (!spec) return null
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('aria-hidden', 'true')
  svg.classList.add('ws-tool-icon')
  if (spec.fill) svg.classList.add('is-filled')
  for (const d of spec.d) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.appendChild(path)
  }
  return svg
}

/** 測試用：有哪些名字 */
export function toolIconNames() {
  return Object.keys(ICONS)
}
