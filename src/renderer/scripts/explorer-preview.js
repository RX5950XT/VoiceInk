/**
 * 整機檔案總管的 Quick Look 預覽。
 * 圖片／PDF／影音走 vi-media 串流；Markdown 只讀受限文字，不轉 base64。
 */

import { renderMarkdown } from './markdown.js'

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg'])
const VIDEO_EXT = new Set(['mp4', 'webm'])
const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'])
const MARKDOWN_EXT = new Set(['md', 'markdown', 'mdown', 'mkd'])

/** @type {{ root: HTMLElement, stage: HTMLElement, caption: HTMLElement } | null} */
let ui = null
/** @type {Array<{ path: string, name: string, ext?: string, dir?: boolean }>} */
let items = []
let index = 0
let generation = 0
/** @type {(() => void) | null} */
let release = null
let pdfLib = null

function extOf(item) {
  return String(item?.ext || item?.name?.split('.').pop() || '').toLowerCase()
}

export function previewKind(item) {
  if (!item || item.dir) return ''
  const ext = extOf(item)
  if (IMAGE_EXT.has(ext)) return 'image'
  if (VIDEO_EXT.has(ext)) return 'video'
  if (AUDIO_EXT.has(ext)) return 'audio'
  if (ext === 'pdf') return 'pdf'
  if (MARKDOWN_EXT.has(ext)) return 'markdown'
  return ''
}

export function isPreviewable(item) {
  return Boolean(previewKind(item))
}

function button(label, title) {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = 'btn-icon ex-preview-btn'
  el.textContent = label
  el.title = title
  return el
}

function hint(text) {
  const el = document.createElement('p')
  el.className = 'ex-preview-hint'
  el.textContent = text
  return el
}

function clearRelease() {
  const fn = release
  release = null
  fn?.()
}

function cleanupMedia(stage) {
  for (const node of stage.querySelectorAll('video, audio')) {
    const media = /** @type {HTMLMediaElement} */ (node)
    media.pause()
    media.removeAttribute('src')
    media.load()
  }
}

function createUi() {
  const root = document.createElement('div')
  root.className = 'ex-preview-root'
  root.tabIndex = -1
  const bar = document.createElement('header')
  bar.className = 'ex-preview-bar'
  const caption = document.createElement('div')
  caption.className = 'ex-preview-caption'
  const close = button('✕', '關閉（Esc）')
  close.addEventListener('click', closePreview)
  bar.append(caption, close)
  const stage = document.createElement('main')
  stage.className = 'ex-preview-stage'
  const prev = button('‹', '上一個（←）')
  prev.classList.add('ex-preview-nav', 'is-prev')
  const next = button('›', '下一個（→）')
  next.classList.add('ex-preview-nav', 'is-next')
  prev.addEventListener('click', () => step(-1))
  next.addEventListener('click', () => step(1))
  root.append(bar, stage, prev, next)
  stage.addEventListener('pointerdown', (event) => {
    if (event.target === stage) closePreview()
  })
  document.body.appendChild(root)
  ui = { root, stage, caption }
  return ui
}

function mediaUrlFor(resolveUrl, item) {
  return Promise.resolve(resolveUrl(item.path)).then((result) => (
    result?.ok === false ? '' : String(result?.data?.url || result?.url || '')
  ))
}

async function loadMarkdown(item, readMarkdown, host, seq) {
  if (typeof readMarkdown !== 'function') {
    host.replaceChildren(hint('沒有 Markdown 讀取功能'))
    return
  }
  try {
    const result = await readMarkdown(item.path)
    if (seq !== generation || !ui) return
    const data = result?.ok === false ? null : (result?.data || result)
    if (!data || typeof data.text !== 'string') throw new Error('markdown')
    const article = document.createElement('article')
    article.className = 'ex-preview-markdown md-content'
    article.appendChild(renderMarkdown(data.text))
    if (data.truncated) article.appendChild(hint('內容已截到預覽上限'))
    host.replaceChildren(article)
  } catch {
    if (seq === generation && ui) host.replaceChildren(hint('Markdown 打不開'))
  }
}

async function loadPdf(url, host, seq) {
  let doc = null
  try {
    if (seq !== generation || !ui || !url) throw new Error('url')
    if (!pdfLib) {
      pdfLib = await import('../../../node_modules/pdfjs-dist/build/pdf.min.mjs')
      pdfLib.GlobalWorkerOptions.workerSrc = new URL(
        '../../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs',
        import.meta.url
      ).href
    }
    doc = await pdfLib.getDocument({
      url, isEvalSupported: false, disableStream: true, disableAutoFetch: true
    }).promise
    if (seq !== generation || !ui) {
      await doc.destroy()
      doc = null
      return
    }
    let pageNo = 1
    let renderTask = null
    let closed = false
    const bar = document.createElement('div')
    bar.className = 'ex-preview-pdf-bar'
    const prev = document.createElement('button')
    prev.type = 'button'
    prev.className = 'btn btn-secondary btn-sm'
    prev.textContent = '上一頁'
    const label = document.createElement('span')
    const next = document.createElement('button')
    next.type = 'button'
    next.className = 'btn btn-secondary btn-sm'
    next.textContent = '下一頁'
    bar.append(prev, label, next)
    const canvas = document.createElement('canvas')
    canvas.className = 'ex-preview-pdf-canvas'
    host.replaceChildren(bar, canvas)
    const draw = async () => {
      if (closed || seq !== generation || !ui) return
      const page = await doc.getPage(pageNo)
      renderTask?.cancel()
      const viewport = page.getViewport({ scale: 1.35 })
      canvas.width = viewport.width
      canvas.height = viewport.height
      label.textContent = `第 ${pageNo} / ${doc.numPages} 頁`
      prev.disabled = pageNo <= 1
      next.disabled = pageNo >= doc.numPages
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      renderTask = page.render({ canvasContext: ctx, viewport })
      await renderTask.promise.catch((error) => {
        if (error?.name !== 'RenderingCancelledException') throw error
      })
    }
    const dispose = () => {
      if (closed) return
      closed = true
      renderTask?.cancel()
      void doc.destroy()
      if (release === dispose) release = null
    }
    release = dispose
    prev.addEventListener('click', () => { if (pageNo > 1) { pageNo -= 1; void draw() } })
    next.addEventListener('click', () => { if (pageNo < doc.numPages) { pageNo += 1; void draw() } })
    await draw()
  } catch {
    if (doc) await doc.destroy().catch(() => {})
    if (seq === generation && ui) host.replaceChildren(hint('這份 PDF 打不開'))
  }
}

async function show(resolveUrl, readMarkdown) {
  if (!ui) return
  const item = items[index]
  if (!item) return
  const seq = ++generation
  clearRelease()
  cleanupMedia(ui.stage)
  ui.stage.replaceChildren(hint('載入中…'))
  ui.caption.textContent = items.length > 1 ? `${item.name}（${index + 1}／${items.length}）` : item.name
  const kind = previewKind(item)
  if (kind === 'markdown') {
    await loadMarkdown(item, readMarkdown, ui.stage, seq)
    return
  }
  try {
    const url = await mediaUrlFor(resolveUrl, item)
    if (seq !== generation || !ui || !url) throw new Error('url')
    if (kind === 'pdf') {
      await loadPdf(url, ui.stage, seq)
      return
    }
    if (kind === 'image') {
      const image = document.createElement('img')
      image.className = 'ex-preview-image'
      image.alt = item.name
      image.src = url
      ui.stage.replaceChildren(image)
      return
    }
    const media = document.createElement(kind)
    media.className = `ex-preview-${kind}`
    media.controls = true
    media.preload = 'metadata'
    media.src = url
    ui.stage.replaceChildren(media)
  } catch {
    if (seq === generation && ui) ui.stage.replaceChildren(hint('預覽打不開'))
  }
}

function step(delta) {
  if (items.length < 2) return
  index = (index + delta + items.length) % items.length
  void show(currentResolveUrl, currentReadMarkdown)
}

/** @type {((path: string) => Promise<any>) | null} */
let currentResolveUrl = null
/** @type {((path: string) => Promise<any>) | null} */
let currentReadMarkdown = null

function onKey(event) {
  if (!ui) return
  if (event.key === 'Escape') {
    event.preventDefault()
    closePreview()
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault()
    step(event.key === 'ArrowLeft' ? -1 : 1)
  }
}

export function previewOpen() {
  return Boolean(ui)
}

export function closePreview() {
  if (!ui) return
  generation += 1
  clearRelease()
  cleanupMedia(ui.stage)
  ui.root.remove()
  ui = null
  items = []
  currentResolveUrl = null
  currentReadMarkdown = null
  document.removeEventListener('keydown', onKey, true)
}

export function openPreview({ item, list, mediaUrl, readMarkdown }) {
  const candidates = (Array.isArray(list) ? list : [item]).filter(isPreviewable)
  if (!item || !isPreviewable(item) || typeof mediaUrl !== 'function') return false
  closePreview()
  items = candidates.length ? candidates : [item]
  index = Math.max(0, items.findIndex((entry) => entry.path === item.path))
  currentResolveUrl = mediaUrl
  currentReadMarkdown = readMarkdown
  createUi()
  document.addEventListener('keydown', onKey, true)
  ui.root.focus({ preventScroll: true })
  void show(mediaUrl, readMarkdown)
  return true
}
