/**
 * 預覽與編輯器的 Ctrl+滾輪縮放倍率。
 *
 * 只有一個純函式、不碰 DOM——好直接用 node 測，也讓「往上放大、往下縮小、
 * 夾在合理範圍」這條規則只有一份。
 */

/** 再小就看不見了 */
export const ZOOM_MIN = 0.25
/** 再大 PDF 重繪出來的 canvas 會吃掉幾百 MB */
export const ZOOM_MAX = 5
/** 一格滾輪的倍率 */
const STEP = 1.1

/**
 * 算下一個倍率。往上滾（`deltaY < 0`）放大，往下滾縮小。
 *
 * @param {number} current 目前倍率
 * @param {number} deltaY 滾輪的 deltaY
 * @returns {number} 夾在 ZOOM_MIN～ZOOM_MAX 之間、取到小數兩位的倍率
 */
export function nextZoom(current, deltaY) {
  const base = Number.isFinite(current) && current > 0 ? current : 1
  if (!Number.isFinite(deltaY) || deltaY === 0) return base
  const scaled = deltaY < 0 ? base * STEP : base / STEP
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(scaled * 100) / 100))
}
