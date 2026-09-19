// 只讀可見列的 Windows 圖示；切目錄即丟掉等待中的舊列。
const cache = new Map()
let observer
let queue = []
let running = 0

export function paintFileIcons(host, readIcon) {
  observer?.disconnect()
  queue = []
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      observer.unobserve(entry.target)
      queue.push(entry.target)
    }
    pump(readIcon)
  }, { root: host })
  for (const el of host.querySelectorAll('.ex-row-icon[data-path]')) {
    const cached = cache.get(el.dataset.iconKey)
    if (cached) showIcon(el, cached)
    else observer.observe(el)
  }
}

function pump(readIcon) {
  while (running < 4 && queue.length) {
    const el = queue.shift()
    if (!el.isConnected) continue
    running++
    void readIcon(el.dataset.path).then((result) => {
      if (!result?.ok || (!result.data?.folder && !/^data:image\/png;base64,/.test(result.data?.url))) return
      cache.set(el.dataset.iconKey, result.data)
      if (cache.size > 256) cache.delete(cache.keys().next().value)
      if (el.isConnected) showIcon(el, result.data)
    }).catch(() => {
      // 檔案可能剛被刪除，保留原本的類型圖示。
    }).finally(() => { running--; pump(readIcon) })
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
