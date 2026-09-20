// 只讀可見列的 Windows 圖示；切目錄即丟掉等待中的舊列。
// 方格檢視對可能有預覽的副檔名改要縮圖；清單維持類型圖示。
const cache = new Map()
let observer
let queue = []
let running = 0

const THUMB_SIZE = 96
const THUMB_EXT = new Set([
  'png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'bmp', 'ico', 'tif', 'tiff',
  'heic', 'heif', 'avif', 'svg',
  'mp4', 'mkv', 'avi', 'mov', 'wmv', 'webm', 'm4v',
  'pdf',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'
])

function canThumb(filePath) {
  const name = String(filePath || '')
  const slash = Math.max(name.lastIndexOf('\\'), name.lastIndexOf('/'))
  const base = slash >= 0 ? name.slice(slash + 1) : name
  const dot = base.lastIndexOf('.')
  if (dot < 1) return false
  return THUMB_EXT.has(base.slice(dot + 1).toLowerCase())
}

function cacheKey(el, thumb) {
  return `${thumb ? 't' : 'i'}:${el.dataset.iconKey || el.dataset.path}`
}

function wantThumb(host, el) {
  return host.classList.contains('is-grid') && canThumb(el.dataset.path)
}

function loadIcon(el, host, readIcon) {
  const fn = window.electronAPI && window.electronAPI.explorer && window.electronAPI.explorer.fileIcon
  if (wantThumb(host, el) && typeof fn === 'function') {
    return fn(el.dataset.path, { thumb: true, size: THUMB_SIZE })
  }
  return readIcon(el.dataset.path)
}

export function paintFileIcons(host, readIcon) {
  observer?.disconnect()
  queue = []
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      observer.unobserve(entry.target)
      queue.push(entry.target)
    }
    pump(host, readIcon)
  }, { root: host })
  for (const el of host.querySelectorAll('.ex-row-icon[data-path]')) {
    const cached = cache.get(cacheKey(el, wantThumb(host, el)))
    if (cached) showIcon(el, cached)
    else observer.observe(el)
  }
}

function pump(host, readIcon) {
  while (running < 4 && queue.length) {
    const el = queue.shift()
    if (!el.isConnected) continue
    running++
    const thumb = wantThumb(host, el)
    void loadIcon(el, host, readIcon).then((result) => {
      if (!result?.ok || (!result.data?.folder && !/^data:image\/png;base64,/.test(result.data?.url))) return
      cache.set(cacheKey(el, thumb), result.data)
      if (cache.size > 256) cache.delete(cache.keys().next().value)
      if (el.isConnected) showIcon(el, result.data)
    }).catch(() => {
      // 檔案可能剛被刪除，保留原本的類型圖示。
    }).finally(() => { running--; pump(host, readIcon) })
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
