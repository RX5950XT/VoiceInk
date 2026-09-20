// 只讀可見列的 Windows 圖示；切目錄即丟掉等待中的舊列。
// 方格檢視一律問殼層縮圖（照片／影片／文件／資料夾預覽）；清單維持類型圖示。
// 殼層第一次常回 pending（影片／PDF 還在現生）：先畫暫時的圖，稍後再問，不把暫時的寫進快取。
const cache = new Map()
const visible = new WeakSet()
const inflight = new WeakSet()
const retryCount = new Map()
let observer
let queue = []
let running = 0
let generation = 0
const retryTimers = new Set()
let activeContext = null

const THUMB_SIZE = 96
/** 殼層給得出的最大邊長（`shell.js` 的 `thumbOf` 也夾在這） */
const THUMB_MAX = 256
const RETRY_MS = 400
const MAX_RETRY = 3

/**
 * 這一格要多大的縮圖：跟著方格的圖示大小走（Ctrl+滾輪會改它）。
 * 不跟的話放大之後只是把 96px 那張拉開，照片全糊掉。
 *
 * 讀 `data-tile` 不讀 CSS 變數：`getComputedStyle` 在測試用的假 DOM 裡根本不存在，
 * 而且每一列都問一次 computed style 很貴。`explorer-page.js` 的 `applyTile` 兩邊都寫。
 * @param {HTMLElement} host
 */
function thumbSize(host) {
  const raw = Number.parseInt(host?.dataset?.tile ?? '', 10)
  if (!Number.isFinite(raw) || raw < 16) return THUMB_SIZE
  return Math.min(THUMB_MAX, raw)
}

/**
 * 快取鍵要帶尺寸：同一個檔案在不同大小是兩張圖，共用一個鍵的話縮放完還是舊的那張。
 */
function cacheKey(el, thumb, size) {
  return `${thumb ? `t${size || THUMB_SIZE}` : 'i'}:${el.dataset.iconKey || el.dataset.path}`
}

function wantThumb(host, el) {
  return host.classList.contains('is-grid') && Boolean(el.dataset.path)
}

function loadIcon(el, host, readIcon, size) {
  const fn = window.electronAPI && window.electronAPI.explorer && window.electronAPI.explorer.fileIcon
  if (wantThumb(host, el) && typeof fn === 'function') {
    return fn(el.dataset.path, { thumb: true, size: size || thumbSize(host) })
  }
  return readIcon(el.dataset.path)
}

function clearRetries() {
  for (const id of retryTimers) clearTimeout(id)
  retryTimers.clear()
}

export function clearFileIconWork() {
  generation += 1
  clearRetries()
  retryCount.clear()
  observer?.disconnect()
  observer = undefined
  queue = []
  activeContext = null
}

function enqueue(el, host) {
  if (cache.has(cacheKey(el, wantThumb(host, el), thumbSize(host)))) return
  if (inflight.has(el)) return
  if (queue.includes(el)) return
  queue.push(el)
}

function scheduleRetry(el, host, readIcon, attempt) {
  const gen = generation
  const delay = RETRY_MS * (2 ** (attempt - 1))
  const id = setTimeout(() => {
    retryTimers.delete(id)
    if (gen !== generation) return
    if (!el.isConnected || !visible.has(el)) return
    enqueue(el, host)
    pump(host, readIcon)
  }, delay)
  retryTimers.add(id)
}

function applyThumb(el, host, readIcon, result, thumb, size) {
  if (!result?.ok || (!result.data?.folder && !/^data:image\/png;base64,/.test(result.data?.url))) return
  if (result.data.pending === true) {
    if (el.isConnected) showIcon(el, result.data)
    const attempt = (retryCount.get(el) || 0) + 1
    retryCount.set(el, attempt)
    if (attempt <= MAX_RETRY) scheduleRetry(el, host, readIcon, attempt)
    else observer?.unobserve(el)
    return
  }
  retryCount.delete(el)
  observer?.unobserve(el)
  cache.set(cacheKey(el, thumb, size), result.data)
  if (cache.size > 256) cache.delete(cache.keys().next().value)
  if (el.isConnected) showIcon(el, result.data)
}

export function paintFileIcons(host, readIcon) {
  generation += 1
  clearRetries()
  retryCount.clear()
  observer?.disconnect()
  queue = []
  activeContext = { host, readIcon }
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        visible.add(entry.target)
        enqueue(entry.target, host)
      } else {
        visible.delete(entry.target)
      }
    }
    pump(host, readIcon)
  }, { root: host })
  for (const el of host.querySelectorAll('.ex-row-icon[data-path]')) {
    const cached = cache.get(cacheKey(el, wantThumb(host, el), thumbSize(host)))
    if (cached) showIcon(el, cached)
    else observer.observe(el)
  }
}

function pump(host, readIcon) {
  while (running < 4 && queue.length) {
    const el = queue.shift()
    if (!el.isConnected || inflight.has(el)) continue
    if (cache.has(cacheKey(el, wantThumb(host, el), thumbSize(host)))) continue
    running++
    inflight.add(el)
    const thumb = wantThumb(host, el)
    // 要哪個尺寸在**發問當下**就定住：回來時使用者可能已經又滾了一格，
    // 拿新的尺寸當快取鍵會把小圖存成大圖那一格。
    const size = thumbSize(host)
    const gen = generation
    void loadIcon(el, host, readIcon, size).then((result) => {
      if (gen !== generation) return
      applyThumb(el, host, readIcon, result, thumb, size)
    }).catch(() => {
      // 檔案可能剛被刪除，保留原本的類型圖示。
    }).finally(() => {
      inflight.delete(el)
      running--
      if (activeContext) pump(activeContext.host, activeContext.readIcon)
    })
  }
}

function showIcon(el, data) {
  if (data.folder) {
    el.textContent = '📁'
    return
  }
  const image = document.createElement('img')
  image.src = data.url
  image.alt = ''
  image.draggable = false
  el.replaceChildren(image)
}
