'use strict'

/**
 * 檔案總管的 Windows 殼層 sidecar 門面。
 *
 * 右鍵選單裡的 7-Zip／WinRAR／「傳送到」／「內容」，以及 Google Drive 綠勾，
 * 都要真的去問殼層。這裡把 `shell-host.js` 的行協定收成幾個函式，並把 BGRA
 * 圖示轉成 PNG data URL（renderer 直接當 img.src）。
 *
 * sidecar 沒建置時全部回空——檔案總管其餘功能不受影響。
 */

const os = require('os')
const { nativeImage, BrowserWindow } = require('electron')
const host = require('./shell-host')
const paths = require('./paths')

/** @type {null | { ok: boolean, send: Function, stop: Function, alive: Function }} */
let session = null
/** @type {Promise<object|null> | null} */
let starting = null
let missing = false

/**
 * @returns {Promise<object|null>}
 */
async function ensure() {
  if (missing) return null
  if (session && typeof session.alive === 'function' && session.alive()) return session
  if (starting) return starting
  starting = host.startShell().then((started) => {
    starting = null
    if (!started || !started.ok) {
      missing = started && started.error === 'SHELL_EXE_MISSING'
      session = null
      return null
    }
    session = started
    return session
  }).catch((error) => {
    console.error('[explorer] 殼層 sidecar 啟動失敗:', error?.message || error)
    starting = null
    session = null
    return null
  })
  return starting
}

function shutdown() {
  starting = null
  if (!session) return
  try {
    session.stop()
  } catch (error) {
    console.error('[explorer] 收掉殼層 sidecar 失敗:', error?.message || error)
  }
  session = null
}

/**
 * @param {{ w?: number, h?: number, bgra?: string }} icon
 * @returns {string}
 */
function toPng(icon) {
  if (!icon || !icon.bgra || !icon.w || !icon.h) return ''
  const width = icon.w | 0
  const height = icon.h | 0
  if (width < 1 || height < 1 || width > 256 || height > 256) return ''
  let buffer
  try {
    buffer = Buffer.from(icon.bgra, 'base64')
  } catch {
    return ''
  }
  if (buffer.length !== width * height * 4) return ''
  try {
    const image = nativeImage.createFromBitmap(buffer, { width, height })
    if (!image || image.isEmpty()) return ''
    return image.toDataURL()
  } catch {
    return ''
  }
}

function mapNode(node) {
  if (!node || typeof node !== 'object') return null
  if (node.sep) return { sep: true }
  const out = {
    cmd: Number(node.cmd) || 0,
    label: typeof node.label === 'string' ? node.label : '',
    verb: typeof node.verb === 'string' ? node.verb : '',
    disabled: Boolean(node.disabled),
    checked: Boolean(node.checked)
  }
  const icon = toPng(node.icon)
  if (icon) out.icon = icon
  if (Array.isArray(node.children)) {
    out.children = node.children.map(mapNode).filter(Boolean)
  }
  return out
}

function hwndOf() {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) return '0'
  try {
    const buf = win.getNativeWindowHandle()
    if (!buf || !buf.length) return '0'
    if (os.arch() === 'ia32' || buf.length < 8) return String(buf.readUInt32LE(0))
    return buf.readBigUInt64LE(0).toString()
  } catch {
    return '0'
  }
}

function absPath(target) {
  return paths.resolveExisting(target)
}

/**
 * @param {{ paths?: unknown, dir?: unknown, extended?: unknown }} spec
 * @returns {Promise<{ token: number, items: object[] }>}
 */
async function menu(spec) {
  const s = await ensure()
  if (!s) return { token: 0, items: [] }
  try {
    const input = spec && typeof spec === 'object' ? spec : {}
    const list = []
    for (const item of Array.isArray(input.paths) ? input.paths.slice(0, 64) : []) {
      try {
        list.push(absPath(item))
      } catch {
        // 檔案可能剛被刪掉，略過這一筆
      }
    }
    let dir = ''
    if (!list.length && input.dir) {
      try {
        dir = absPath(input.dir)
      } catch {
        return { token: 0, items: [] }
      }
    }
    const result = await s.send({
      op: 'menu',
      paths: list,
      dir,
      extended: input.extended === true
    })
    if (!result.ok || !result.data) return { token: 0, items: [] }
    const token = Number(result.data.token) || 0
    const items = Array.isArray(result.data.items) ? result.data.items.map(mapNode).filter(Boolean) : []
    return { token, items }
  } catch {
    return { token: 0, items: [] }
  }
}

/**
 * @param {unknown} token
 * @param {unknown} cmd
 * @param {unknown} dir
 */
async function invoke(token, cmd, dir) {
  const s = await ensure()
  const id = Number(token)
  const command = Number(cmd)
  if (!s || !Number.isInteger(id) || id < 1 || !Number.isInteger(command) || command < 0) {
    return { invoked: false }
  }
  const folder = typeof dir === 'string' && dir ? absPath(dir) : ''
  const result = await s.send({ op: 'invoke', token: id, cmd: command, hwnd: hwndOf(), dir: folder })
  return { invoked: Boolean(result.ok && result.data && result.data.invoked) }
}

/**
 * @param {unknown} token
 */
async function release(token) {
  const s = await ensure()
  const id = Number(token)
  if (!s || !Number.isInteger(id) || id < 1) return { released: true }
  await s.send({ op: 'release', token: id })
  return { released: true }
}

/**
 * 這個路徑在檔案總管裡實際長的樣子（含 Google Drive 綠勾）。問不到回空字串。
 * @param {string} full
 * @returns {Promise<string>}
 */
async function iconOf(full) {
  const s = await ensure()
  if (!s || !full) return ''
  try {
    const result = await s.send({ op: 'icon', path: full })
    if (!result.ok || !result.data) return ''
    return toPng(result.data.icon)
  } catch {
    return ''
  }
}

/**
 * 這個路徑的縮圖（照片／影片／PDF 預覽）。問不到回空字串，呼叫端再退回類型圖示。
 * @param {string} full
 * @param {unknown} [size]
 * @returns {Promise<string>}
 */
async function thumbOf(full, size) {
  const s = await ensure()
  if (!s || !full) return ''
  const px = Number(size)
  const edge = Number.isInteger(px) && px >= 16 ? Math.min(px, 256) : 96
  try {
    const result = await s.send({ op: 'thumb', path: full, size: edge })
    if (!result.ok || !result.data) return ''
    return toPng(result.data.thumb)
  } catch {
    return ''
  }
}

module.exports = {
  ensure,
  shutdown,
  menu,
  invoke,
  release,
  iconOf,
  thumbOf,
  toPng,
  mapNode,
  hwndOf
}
