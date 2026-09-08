/**
 * 終端機配色表與桌布的套用。
 *
 * **key 要跟 `main.js` 的 `TERM_THEME_VALUES` 對齊**（那邊只驗 key，色碼只有這裡有）。
 *
 * 桌布的作法：把 xterm 的底色改成透明（`#00000000` ＋ `allowTransparency`），
 * 圖片鋪在 `.term-host` 自己的一層上，用 `opacity` 壓暗。這樣**只有底被換掉，
 * 文字那一層一個字都沒動**——前景色、選取反白、輸入法組字方塊照常。
 *
 * 沒有桌布時底色維持不透明：xterm 自己一格一格畫，半透明的底會讓捲動殘影疊在一起
 * （CLAUDE.md 的地雷，這裡刻意只在有圖時才開透明）。
 */

/** 主題色。`app` 是跟著 App 深／淺色走（＝這個功能加進來之前的樣子）。 */
export const TERM_THEMES = {
  black: {
    label: '全黑',
    colors: { background: '#000000', foreground: '#e6e6e6', cursor: '#e6e6e6', selectionBackground: 'rgba(255, 255, 255, 0.25)' }
  },
  app: {
    label: '跟著 App 主題',
    colors: null
  },
  dracula: {
    label: 'Dracula',
    colors: { background: '#282a36', foreground: '#f8f8f2', cursor: '#ff79c6', selectionBackground: 'rgba(68, 71, 90, 0.85)' }
  },
  solarized: {
    label: 'Solarized Dark',
    colors: { background: '#002b36', foreground: '#93a1a1', cursor: '#b58900', selectionBackground: 'rgba(7, 54, 66, 0.9)' }
  }
}

/** 沒設定過就是全黑（使用者要的預設） */
export const DEFAULT_TERM_THEME = 'black'

/**
 * `app` 主題要從 CSS 變數讀（深／淺色各一組），其餘直接查表。
 * @param {string} key
 * @returns {{ background: string, foreground: string, cursor: string, selectionBackground: string }}
 */
export function themeColorsOf(key) {
  const preset = TERM_THEMES[key] || TERM_THEMES[DEFAULT_TERM_THEME]
  if (preset.colors) return { ...preset.colors }
  const css = getComputedStyle(document.documentElement)
  const pick = (name, fallback) => (css.getPropertyValue(name).trim() || fallback)
  return {
    background: pick('--term-bg', '#0d1012'),
    foreground: pick('--term-fg', '#f4f1e8'),
    cursor: pick('--accent-primary', '#78a3b5'),
    selectionBackground: pick('--term-selection', 'rgba(120, 163, 181, 0.35)')
  }
}

/**
 * 目前的外觀設定。壞值一律退回預設（store 那邊已經驗過一次，這裡是第二道）。
 * @param {{ theme?: unknown, image?: unknown, opacity?: unknown }} raw
 * @returns {{ theme: string, image: string, opacity: number }}
 */
export function normalizeAppearance(raw) {
  const theme = typeof raw?.theme === 'string' && TERM_THEMES[raw.theme] ? raw.theme : DEFAULT_TERM_THEME
  const image = typeof raw?.image === 'string' ? raw.image : ''
  const opacity = Number.isFinite(Number(raw?.opacity))
    ? Math.max(0, Math.min(100, Math.round(Number(raw.opacity))))
    : 20
  return { theme, image, opacity }
}

/**
 * 把外觀套到畫面上：CSS 變數給桌布那一層，回傳的物件給 xterm。
 *
 * @param {HTMLElement | null} host `.term-host`
 * @param {{ theme: string, image: string, opacity: number }} appearance
 * @param {string} dataUri 桌布的 data: URI（空字串＝沒有桌布）
 * @returns {{ theme: object, allowTransparency: boolean }} 要塞進 xterm 的兩個選項
 */
export function applyAppearance(host, appearance, dataUri) {
  const colors = themeColorsOf(appearance.theme)
  const hasImage = Boolean(dataUri)
  if (host) {
    host.classList.toggle('has-term-bg', hasImage)
    host.style.setProperty('--term-theme-bg', colors.background)
    host.style.setProperty('--term-bg-image', hasImage ? `url("${dataUri}")` : 'none')
    host.style.setProperty('--term-bg-opacity', String(appearance.opacity / 100))
  }
  return {
    // 有桌布才讓 xterm 的底透出去；沒有的話維持不透明（避免捲動殘影）
    theme: { ...colors, background: hasImage ? '#00000000' : colors.background },
    allowTransparency: hasImage
  }
}
