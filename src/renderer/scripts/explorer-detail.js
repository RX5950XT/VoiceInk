/**
 * 檔案總管右側詳情：預覽＋詳細資訊。操作鈕在上方命令列。
 */

let detailSeq = 0

/**
 * @param {{
 *   host: HTMLElement,
 *   items: object[],
 *   inRecycle: boolean,
 *   inspect: (path: string) => Promise<object>,
 *   formatSize: (n: number) => string,
 *   formatTime: (n: number) => string
 * }} opts
 */
export async function paintDetail(opts) {
  const seq = ++detailSeq
  const host = opts.host
  if (!host) return
  host.replaceChildren()
  const items = opts.items || []
  if (!items.length) {
    const hint = document.createElement('p')
    hint.className = 'setting-hint'
    hint.textContent = '選一個項目看詳情。'
    host.appendChild(hint)
    return
  }
  if (items.length > 1) {
    const title = document.createElement('h2')
    title.className = 'ex-detail-name'
    title.textContent = `已選 ${items.length} 項`
    host.appendChild(title)
    const total = items.reduce((sum, item) => sum + (item.dir ? 0 : Number(item.size) || 0), 0)
    const dl = document.createElement('dl')
    addFact(dl, '數量', `${items.length}`)
    addFact(dl, '大小', opts.formatSize(total))
    host.appendChild(dl)
    return
  }
  const item = items[0]
  const title = document.createElement('h2')
  title.className = 'ex-detail-name'
  title.textContent = item.name
  host.appendChild(title)

  let info = null
  if (!opts.inRecycle) {
    try {
      info = await opts.inspect(item.path)
    } catch {
      info = null
    }
  }
  if (seq !== detailSeq) return
  host.appendChild(previewEl(item, info))

  const dl = document.createElement('dl')
  addFact(dl, '類型', (info && info.type) || (item.dir ? '資料夾' : '檔案'))
  addFact(dl, '位置', item.path)
  addFact(dl, '大小', item.dir ? '資料夾' : opts.formatSize((info && info.size) || item.size))
  addFact(dl, '建立', opts.formatTime((info && info.ctimeMs) || 0))
  addFact(dl, '修改', opts.formatTime((info && info.mtimeMs) || item.mtimeMs))
  addFact(dl, '存取', opts.formatTime((info && info.atimeMs) || 0))
  if (info && info.width && info.height) addFact(dl, '尺寸', `${info.width} × ${info.height}`)
  if (info && info.shortcutTarget) addFact(dl, '目標', info.shortcutTarget)
  if (info && info.linkTarget) addFact(dl, '連結', info.linkTarget)
  if (info && info.tooLarge) addFact(dl, '預覽', '檔案太大')
  host.appendChild(dl)
}

function previewEl(item, info) {
  const box = document.createElement('div')
  box.className = 'ex-detail-preview-box'
  if (info && info.image) {
    const img = document.createElement('img')
    img.className = 'ex-detail-preview'
    img.alt = item.name
    img.src = info.image
    box.appendChild(img)
    return box
  }
  if (info && info.text) {
    const pre = document.createElement('pre')
    pre.className = 'ex-detail-text'
    pre.textContent = info.text
    box.appendChild(pre)
    return box
  }
  const icon = document.createElement('div')
  icon.className = 'ex-detail-preview-icon'
  icon.textContent = item.dir ? '📁' : ((item.ext || '').toLowerCase() === 'lnk' ? '🔗' : '📄')
  box.appendChild(icon)
  const cap = document.createElement('p')
  cap.className = 'ex-detail-preview-cap'
  cap.textContent = (info && info.shortcutTarget) || item.name
  box.appendChild(cap)
  return box
}

function addFact(dl, key, value) {
  const wrap = document.createElement('div')
  const dt = document.createElement('dt')
  dt.textContent = key
  const dd = document.createElement('dd')
  dd.textContent = value || '—'
  wrap.append(dt, dd)
  dl.appendChild(wrap)
}
