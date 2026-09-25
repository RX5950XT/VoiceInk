/**
 * 磁碟空間 treemap 的純函式。沒有 DOM，node 可以直接 import。
 * NODE：{ n, s, f, k:'d'|'f'|'o', c?, t? }。子項依 s 由大到小。
 */

const RECLAIMABLE = new Set([
  'node_modules', '.cache', 'cache', 'caches', 'temp', 'tmp',
  '__pycache__', '.gradle', '.npm', 'target',
  '.nuget', '.pytest_cache', '.mypy_cache', '.tox', '.turbo',
  '.parcel-cache', 'bower_components'
])

const EXT = {
  js: 'code', jsx: 'code', ts: 'code', tsx: 'code', mjs: 'code', cjs: 'code',
  py: 'code', rs: 'code', go: 'code', java: 'code', kt: 'code', c: 'code', h: 'code',
  cpp: 'code', hpp: 'code', cc: 'code', cs: 'code', rb: 'code', php: 'code',
  swift: 'code', vue: 'code', svelte: 'code', html: 'code', css: 'code', scss: 'code',
  json: 'code', yml: 'code', yaml: 'code', toml: 'code', xml: 'code', sql: 'code',
  sh: 'code', ps1: 'code', lua: 'code',
  mp4: 'video', mkv: 'video', avi: 'video', mov: 'video', webm: 'video', wmv: 'video', m4v: 'video',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image',
  svg: 'image', ico: 'image', tif: 'image', tiff: 'image', heic: 'image', avif: 'image',
  mp3: 'audio', wav: 'audio', flac: 'audio', aac: 'audio', ogg: 'audio', m4a: 'audio', opus: 'audio',
  pdf: 'doc', doc: 'doc', docx: 'doc', xls: 'doc', xlsx: 'doc', ppt: 'doc', pptx: 'doc',
  odt: 'doc', ods: 'doc', txt: 'doc', md: 'doc', csv: 'doc', rtf: 'doc', epub: 'doc',
  zip: 'archive', '7z': 'archive', rar: 'archive', tar: 'archive', gz: 'archive',
  bz2: 'archive', xz: 'archive', tgz: 'archive', cab: 'archive', iso: 'archive',
  exe: 'bin', dll: 'bin', msi: 'bin', so: 'bin', dylib: 'bin', bin: 'bin',
  sys: 'bin', lib: 'bin', pdb: 'bin', wasm: 'bin', pyc: 'bin', class: 'bin',
  tmp: 'cache', temp: 'cache', cache: 'cache'
}

export const CATEGORIES = [
  { key: 'code', label: '程式碼' },
  { key: 'doc', label: '文件' },
  { key: 'image', label: '圖片' },
  { key: 'video', label: '影片' },
  { key: 'audio', label: '音樂' },
  { key: 'archive', label: '壓縮檔' },
  { key: 'bin', label: '執行檔' },
  { key: 'cache', label: '快取' },
  { key: 'dir', label: '資料夾' },
  { key: 'other', label: '其他' }
]

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** @param {number} bytes */
export function formatBytes(bytes) {
  const n = Math.max(0, num(bytes))
  if (n < 1024) return `${Math.round(n)} B`
  const units = ['KB', 'MB', 'GB', 'TB', 'PB']
  let value = n / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  const digits = value >= 100 ? 0 : 1
  return `${value.toFixed(digits)} ${units[i]}`
}

/** @param {string} name */
export function baseName(name) {
  const s = String(name || '')
  const cut = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'))
  const leaf = cut >= 0 ? s.slice(cut + 1) : s
  return leaf || s
}

function extOf(name) {
  const base = baseName(name).toLowerCase()
  if (base.endsWith('.tar.gz') || base.endsWith('.tar.bz2') || base.endsWith('.tar.xz')) return 'tar'
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return ''
  return base.slice(dot + 1)
}

/** 資料夾名（不分大小寫）是不是可清掉的快取。 */
export function isReclaimable(name) {
  return RECLAIMABLE.has(baseName(name).toLowerCase())
}

/**
 * @param {{ n?: string, k?: string }} node
 * @returns {'code'|'cache'|'video'|'image'|'audio'|'doc'|'archive'|'bin'|'dir'|'other'}
 */
export function categorize(node) {
  if (!node || node.k === 'o') return 'other'
  if (node.k === 'd') return isReclaimable(node.n) ? 'cache' : 'dir'
  return EXT[extOf(node.n)] || 'other'
}

function childPath(parent, name) {
  const text = String(parent || '')
  if (text.endsWith('\\') || text.endsWith('/')) return text + name
  const sep = text.includes('\\') || !text.includes('/') ? '\\' : '/'
  return text + sep + name
}

function normPath(p) {
  return String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

/** @param {Array<{ n?: string, k?: string }>|undefined} chain 從掃描根到這個節點 */
export function fullPath(chain) {
  if (!chain?.length) return ''
  let p = String(chain[0].n || '')
  for (let i = 1; i < chain.length; i++) {
    if (chain[i].k === 'o') return ''
    p = childPath(p, chain[i].n)
  }
  return p
}

/** 名稱篩選：自己或任一後代的檔名含 query 就算符合。 */
export function nameMatches(node, query, memo) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return true
  if (memo?.has(node)) return memo.get(node)
  let ok = baseName(node?.n).toLowerCase().includes(q)
  if (!ok) {
    for (const child of node?.c || []) {
      if (nameMatches(child, q, memo)) { ok = true; break }
    }
  }
  memo?.set(node, ok)
  return ok
}

function worst(row, side) {
  if (!row.length || side <= 0) return Infinity
  let sum = 0
  let min = Infinity
  let max = 0
  for (const item of row) {
    sum += item.area
    if (item.area < min) min = item.area
    if (item.area > max) max = item.area
  }
  if (sum <= 0 || min <= 0) return Infinity
  const side2 = side * side
  const sum2 = sum * sum
  return Math.max((side2 * max) / sum2, sum2 / (side2 * min))
}

/** 寬矩形時沿著短邊（高度）直向切；高矩形時橫向切。 */
function placeRow(row, rect, last) {
  const sum = row.reduce((s, item) => s + item.area, 0) || 1
  const wide = rect.w >= rect.h
  if (wide) {
    const thick = Math.max(0, last ? rect.w : sum / rect.h)
    let y = rect.y
    const bottom = rect.y + rect.h
    for (let i = 0; i < row.length; i++) {
      const h = i === row.length - 1 ? Math.max(0, bottom - y) : (row[i].area / sum) * rect.h
      row[i].x = rect.x
      row[i].y = y
      row[i].w = thick
      row[i].h = h
      y += h
    }
    if (last) { rect.w = 0; rect.h = 0 } else { rect.x += thick; rect.w = Math.max(0, rect.w - thick) }
    return
  }
  const thick = Math.max(0, last ? rect.h : sum / rect.w)
  let x = rect.x
  const right = rect.x + rect.w
  for (let i = 0; i < row.length; i++) {
    const w = i === row.length - 1 ? Math.max(0, right - x) : (row[i].area / sum) * rect.w
    row[i].x = x
    row[i].y = rect.y
    row[i].w = w
    row[i].h = thick
    x += w
  }
  if (last) { rect.w = 0; rect.h = 0 } else { rect.y += thick; rect.h = Math.max(0, rect.h - thick) }
}

/**
 * Squarified treemap。items 要有 value；回傳與輸入等長，每項帶 x,y,w,h。
 * @param {Array<{ value: number }>} items
 * @param {{ x: number, y: number, w: number, h: number }} rect
 */
export function squarify(items, rect) {
  const x0 = num(rect?.x)
  const y0 = num(rect?.y)
  const rw = Math.max(0, num(rect?.w))
  const rh = Math.max(0, num(rect?.h))
  const indexed = (items || []).map((item, index) => ({
    item, index, value: Math.max(0, num(item?.value))
  }))
  const live = indexed.filter((d) => d.value > 0).sort((a, b) => b.value - a.value || a.index - b.index)
  const placed = new Array(indexed.length)
  const total = live.reduce((s, d) => s + d.value, 0)
  const area = rw * rh
  if (live.length && total > 0 && area > 0) {
    const scale = area / total
    const nodes = live.map((d) => ({ ...d, area: d.value * scale }))
    const box = { x: x0, y: y0, w: rw, h: rh }
    let i = 0
    while (i < nodes.length && box.w > 0.5 && box.h > 0.5) {
      const side = Math.min(box.w, box.h)
      const row = [nodes[i]]
      let j = i + 1
      while (j < nodes.length && worst(row.concat(nodes[j]), side) <= worst(row, side)) {
        row.push(nodes[j])
        j += 1
      }
      placeRow(row, box, j >= nodes.length)
      i = j
    }
    for (const node of nodes) {
      if (node.w > 0 && node.h > 0) placed[node.index] = { ...node.item, x: node.x, y: node.y, w: node.w, h: node.h }
    }
  }
  return indexed.map((d, i) => placed[i] || { ...d.item, x: x0, y: y0, w: 0, h: 0 })
}

function innerBox(rect, depth) {
  const margin = depth === 1 ? 4 : 3
  const label = depth > 1 && rect.h >= 28 ? 16 : 0
  return {
    x: rect.x + margin,
    y: rect.y + margin + label,
    w: Math.max(0, rect.w - margin * 2),
    h: Math.max(0, rect.h - margin * 2 - label)
  }
}

function placeChildren(node, rect, depth, chain, valueOf, cells) {
  if (depth > 3) return
  const kids = (node?.c || []).filter((child) => valueOf(child) > 0)
  if (!kids.length) return
  const box = innerBox(rect, depth)
  if (box.w < 8 || box.h < 8) return
  const placed = squarify(kids.map((child) => ({ node: child, value: valueOf(child) })), box)
  for (const cell of placed) {
    if (!(cell.w >= 1) || !(cell.h >= 1) || !cell.node) continue
    const childChain = chain.concat(cell.node)
    cells.push({ node: cell.node, chain: childChain, x: cell.x, y: cell.y, w: cell.w, h: cell.h, depth })
    if (cell.node.k === 'd' && depth < 3 && cell.w >= 36 && cell.h >= 28) {
      placeChildren(cell.node, cell, depth + 1, childChain, valueOf, cells)
    }
  }
}

/**
 * 目前這一層畫 2–3 層。chain 從掃描根算到 container（含）。
 * @param {object} node
 * @param {{ x:number, y:number, w:number, h:number }} rect
 * @param {(node: object) => number} valueOf
 * @param {object[]} [chain]
 */
export function layoutTree(node, rect, valueOf, chain) {
  const cells = []
  if (!node) return cells
  const here = chain?.length ? chain : [node]
  placeChildren(node, rect, 1, here, valueOf, cells)
  return cells
}

function walkFiles(node, chain, acc) {
  if (node?.k === 'f') acc.push({ node, chain })
  for (const child of node?.c || []) walkFiles(child, chain.concat(child), acc)
}

/** 這一層底下最大的檔案（照位元組，不含「其他」）。 */
export function largestFiles(node, limit = 15) {
  const acc = []
  if (node) walkFiles(node, [node], acc)
  acc.sort((a, b) => (num(b.node.s) - num(a.node.s)) || (num(b.node.f) - num(a.node.f)))
  return acc.slice(0, limit)
}

function subtract(node, gone) {
  node.s = Math.max(0, num(node.s) - num(gone.s))
  node.f = Math.max(0, num(node.f) - num(gone.f))
}

function detach(node, path, want) {
  const kids = node.c
  if (!kids) return null
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i]
    if (child.k === 'o') continue
    const next = childPath(path, child.n)
    if (normPath(next) === want) {
      kids.splice(i, 1)
      subtract(node, child)
      return child
    }
    const found = detach(child, next, want)
    if (found) {
      subtract(node, found)
      return found
    }
  }
  return null
}

/** 從樹上拿掉這個絕對路徑，並沿路扣掉大小與檔案數。根本身不刪。 */
export function removePath(root, target) {
  if (!root || !target) return null
  const want = normPath(target)
  if (!want || normPath(root.n) === want) return null
  return detach(root, root.n, want)
}

function searchChain(node, path, want, chain) {
  if (normPath(path) === want) return chain
  for (const child of node.c || []) {
    if (child.k === 'o') continue
    const next = childPath(path, child.n)
    const hit = searchChain(child, next, want, chain.concat(child))
    if (hit) return hit
  }
  return null
}

/** @returns {object[]|null} 從根到目標的節點鏈（比對路徑） */
export function findChain(root, target) {
  if (!root || !target) return null
  return searchChain(root, root.n, normPath(target), [root])
}

function relLum(rgb) {
  const lin = (c) => {
    const x = c / 255
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2])
}

function rgbOf(hex) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(hex || ''))
  if (!match) return null
  const n = parseInt(match[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** 填色上的字，選對比達標的那一個（深色字或淺色字）。 */
export function labelInk(fill, ink, paper) {
  const rgb = rgbOf(fill)
  const dark = rgbOf(ink)
  const light = rgbOf(paper)
  if (!rgb || !dark || !light) return paper || ink || '#f4f1e8'
  const score = (other) => {
    const a = relLum(rgb)
    const b = relLum(other)
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  }
  return score(dark) >= score(light) ? ink : paper
}

/** 從根走到同一個節點物件。找不到回 null。 */
export function chainTo(root, target) {
  if (!root || !target) return null
  const here = [root]
  if (root === target) return here
  for (const child of root.c || []) {
    const hit = chainTo(child, target)
    if (hit) return here.concat(hit)
  }
  return null
}
