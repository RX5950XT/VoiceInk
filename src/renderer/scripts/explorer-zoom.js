/**
 * 檔案總管 Ctrl+滾輪的級距。
 *
 * 只有純函式、不碰 DOM——好直接用 node 測，也讓「往上滾變大、在最小的方格往下滾
 * 掉回清單」這條規則只有一份。
 *
 * 級距照檔案總管的順序排：清單 →（小）48 → 64 → 96 → 128 → 180 →（特大）256。
 * main 的 `explorer/store.js` 存的是同一組數字，改一邊要改兩邊。
 */

/** 方格圖示的邊長（px），由小到大 */
export const TILE_SIZES = [48, 64, 96, 128, 180, 256]
export const DEFAULT_TILE = 96

/**
 * 滾一格之後該變成什麼。
 *
 * @param {{ view: 'list'|'grid', tile: number }} state 現在的檢視與圖示大小
 * @param {number} deltaY 滾輪的 deltaY：負的是往上滾（放大）
 * @returns {{ view: 'list'|'grid', tile: number }} 新的狀態（沒得再變就原樣回去）
 */
export function nextZoomState(state, deltaY) {
  const view = state?.view === 'grid' ? 'grid' : 'list'
  const tile = TILE_SIZES.includes(Number(state?.tile)) ? Number(state.tile) : DEFAULT_TILE
  if (!Number.isFinite(deltaY) || deltaY === 0) return { view, tile }
  // -1 那一格代表「清單檢視」，接在所有方格尺寸的前面
  const steps = [-1, ...TILE_SIZES]
  const at = view === 'grid' ? steps.indexOf(tile) : 0
  const next = Math.max(0, Math.min(steps.length - 1, (at < 0 ? 1 : at) + (deltaY < 0 ? 1 : -1)))
  const size = steps[next]
  // 清單再往下滾就停在清單；最大的方格再往上滾就停在最大
  return size < 0 ? { view: 'list', tile } : { view: 'grid', tile: size }
}
