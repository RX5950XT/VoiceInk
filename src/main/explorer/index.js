'use strict'

/**
 * 整機檔案總管門面（Main Process）。
 *
 * renderer 送絕對路徑；所有進出都過 `paths.js`。UFFS 只當搜尋引擎，
 * 關 App 不停它的 daemon。
 */

const { app, shell, dialog, BrowserWindow, nativeImage } = require('electron')
const fs = require('../raw-fs')
const path = require('path')
const { spawnSync } = require('child_process')
const paths = require('./paths')
const store = require('./store')
const files = require('./fs')
const drives = require('./drives')
const watch = require('./watch')
const uffs = require('./uffs')
const recycle = require('./recycle')
const places = require('./places')
const shellExt = require('./shell')
const size = require('./size')

/** @type {(channel: string, payload: any) => void} */
let emit = () => {}

/** @type {{ mode: 'copy'|'cut', paths: string[] }} */
let clip = { mode: 'copy', paths: [] }

/**
 * @param {{ userDataPath?: string, send?: (channel: string, payload: any) => void }} opts
 */
function configure(opts) {
  if (opts && opts.userDataPath) uffs.configure(opts.userDataPath)
  if (opts && typeof opts.send === 'function') emit = opts.send
}

function defaultPlaces() {
  const items = drives.listPlaces()
  items.unshift({ id: 'thispc', label: '本機', path: drives.THIS_PC })
  items.push({ id: 'recycle', label: '資源回收筒', path: recycle.RECYCLE_CWD })
  return items
}

async function listPlaces() {
  const state = await store.readState()
  return places.mergePlaces(state.places, defaultPlaces())
}

async function bootstrap() {
  const state = await store.readState()
  const listed = await listPlaces()
  const disks = drives.listDrives()
  // 沒存過就落在「本機」首頁（＝Windows 檔案總管的預設畫面）。
  let cwd = state.lastPath || drives.THIS_PC
  if (!recycle.isRecyclePath(cwd) && !drives.isThisPc(cwd)) {
    try {
      paths.resolveExisting(cwd)
    } catch {
      cwd = listed[0] ? listed[0].path : (disks[0] ? disks[0].path : 'C:\\')
    }
  }
  return { ...state, lastPath: cwd, places: listed, drives: disks }
}

function saveState(patch) {
  const next = patch && typeof patch === 'object' ? { ...patch } : {}
  delete next.uffsAuto
  return store.writeState(next)
}
const listDrives = () => drives.listDrives()
const driveInfo = () => drives.driveInfo()
const listDir = (dirPath, opts) => {
  // 「本機」是虛擬位置，沒有檔案清單（renderer 自己畫首頁）。
  if (drives.isThisPc(dirPath)) return { path: drives.THIS_PC, entries: [], truncated: false }
  return recycle.isRecyclePath(dirPath) ? files.listRecycle(opts) : files.listDir(dirPath, opts)
}
const preview = (filePath) => files.preview(filePath)
const inspect = (filePath) => files.inspect(filePath)

async function savePlaces(raw) {
  const incoming = places.sanitizePlaces(raw)
  const state = await store.readState()
  const seen = new Set(incoming.map((p) => p.id))
  const hidden = state.places.filter((p) => p.hidden && !seen.has(p.id))
  await store.writeState({ places: places.sanitizePlaces(incoming.concat(hidden)) })
  return listPlaces()
}

async function snapshotPlaces() {
  const state = await store.readState()
  if (state.places.length) return state.places.slice()
  const listed = await listPlaces()
  return listed.map((p) => ({ id: p.id, label: p.label, path: p.path, hidden: false }))
}

async function addPlace(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const full = recycle.isRecyclePath(input.path) ? recycle.RECYCLE_CWD : paths.resolveAbs(input.path)
  if (full !== recycle.RECYCLE_CWD && !paths.isUnc(full)) {
    const existing = paths.resolveExisting(full)
    let st
    try {
      st = fs.statSync(existing)
    } catch {
      throw paths.fail('NOT_FOUND', '找不到這個檔案')
    }
    if (!st.isDirectory()) throw paths.fail('BAD_PATH', '只能釘資料夾')
  }
  const listed = await listPlaces()
  const key = full.toLowerCase()
  if (listed.some((p) => String(p.path).toLowerCase() === key)) return listed
  const id = `place-${Date.now().toString(36)}`
  const fallback = full === recycle.RECYCLE_CWD
    ? '資源回收筒'
    : (path.basename(full) || places.shareLabel(full))
  const label = typeof input.label === 'string' && input.label.trim()
    ? input.label.trim().slice(0, 40)
    : fallback
  const stored = await snapshotPlaces()
  stored.push({ id, label, path: full, hidden: false })
  await store.writeState({ places: places.sanitizePlaces(stored) })
  return listPlaces()
}

async function removePlace(rawId) {
  const id = String(rawId || '').trim()
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw paths.fail('BAD_PATH', '路徑不合法')
  const builtins = defaultPlaces()
  const builtinIds = new Set(builtins.map((b) => b.id))
  const stored = await snapshotPlaces()
  let next
  if (builtinIds.has(id)) {
    let found = false
    next = stored.map((p) => {
      if (p.id !== id) return p
      found = true
      return { ...p, hidden: true }
    })
    if (!found) {
      const b = builtins.find((x) => x.id === id)
      next.push({ id, label: b.label, path: b.path, hidden: true })
    }
  } else {
    next = stored.filter((p) => p.id !== id)
  }
  await store.writeState({ places: places.sanitizePlaces(next) })
  return listPlaces()
}

async function connectShare(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const unc = paths.resolveAbs(input.unc || input.path)
  if (!paths.isUnc(unc)) throw paths.fail('BAD_PATH', '這不是網路路徑')
  const letter = places.sanitizeLetter(input.letter)
  if (letter) {
    const net = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'net.exe')
    const result = spawnSync(net, ['use', `${letter}:`, unc, '/persistent:yes'], {
      windowsHide: true,
      timeout: 20000,
      encoding: 'utf8'
    })
    if (result.status !== 0) throw paths.fail('NET_USE', '連不上這個網路磁碟')
  }
  const target = letter ? `${letter}:\\` : unc
  const label = typeof input.label === 'string' && input.label.trim()
    ? input.label.trim().slice(0, 40)
    : places.shareLabel(unc)
  return addPlace({ path: target, label })
}

async function pickFolder() {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
  const result = await dialog.showOpenDialog(win || undefined, {
    title: '選擇資料夾',
    properties: ['openDirectory']
  })
  if (result.canceled || !result.filePaths[0]) return { path: '' }
  return { path: paths.resolveAbs(result.filePaths[0]) }
}

function resolvePath(raw, seen = new Set()) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) throw paths.fail('BAD_PATH', '路徑不合法')
  if (text === '本機' || drives.isThisPc(text)) {
    return { path: drives.THIS_PC, dir: true, parent: drives.THIS_PC }
  }
  if (text === '資源回收筒' || text.toLowerCase() === 'recyclebin') {
    return { path: recycle.RECYCLE_CWD, dir: true, parent: recycle.RECYCLE_CWD }
  }
  const full = paths.resolveAbs(text)
  if (path.extname(full).toLowerCase() === '.lnk') {
    const key = full.toLowerCase()
    if (seen.has(key) || seen.size >= 16) throw paths.fail('BAD_PATH', '捷徑循環，無法開啟')
    seen.add(key)
    let target
    try {
      target = shell.readShortcutLink(full).target
    } catch {
      throw paths.fail('NOT_FOUND', '讀不到這個捷徑')
    }
    if (!target) throw paths.fail('NOT_FOUND', '找不到捷徑目的地')
    return resolvePath(target, seen)
  }
  let st
  try {
    st = fs.lstatSync(full)
  } catch {
    throw paths.fail('NOT_FOUND', '找不到這個檔案')
  }
  let dir = st.isDirectory()
  if (st.isSymbolicLink()) {
    try { dir = fs.statSync(full).isDirectory() } catch { dir = false }
  }
  const parent = dir ? full : (paths.parentOf(full) || full)
  return { path: full, dir, parent }
}

async function createShortcut(target, toDir) {
  const full = paths.resolveExisting(target)
  const destDir = toDir ? paths.resolveExisting(toDir) : path.dirname(full)
  let st
  try {
    st = fs.statSync(destDir)
  } catch {
    throw paths.fail('BAD_PATH', '目的地不存在')
  }
  if (!st.isDirectory()) throw paths.fail('BAD_PATH', '只能放進資料夾裡')
  paths.assertCreatable(destDir)
  const base = `${path.basename(full, path.extname(full))} - 捷徑.lnk`
  const dest = files.uniqueDest(destDir, base)
  if (!process.versions.electron) throw paths.fail('CREATE_FAILED', '建不了捷徑')
  const ok = shell.writeShortcutLink(dest, { target: full })
  if (!ok) throw paths.fail('CREATE_FAILED', '建不了捷徑')
  return { path: dest }
}
const createEntry = (dirPath, name, dir) => files.createEntry(dirPath, name, dir)
const renameEntry = (target, name) => files.renameEntry(target, name)
const removeEntry = (target, opts) => files.removeEntry(target, opts)
const restoreEntry = (key) => files.restoreEntry(key)
const purgeEntry = (key) => files.purgeEntry(key)
const emptyRecycle = () => files.emptyRecycle()
const copyEntry = (fromPath, toDir) => files.copyEntry(fromPath, toDir)
const moveEntry = (fromPath, toDir) => files.moveEntry(fromPath, toDir)
const uffsStatus = () => uffs.status()
const uffsSearch = (pattern) => uffs.search(pattern)
const uffsCancel = () => {
  uffs.cancelSearch()
  return true
}
const uffsInstall = () => uffs.download((info) => emit('explorer:uffsProgress', info))
const uffsCancelInstall = () => uffs.cancelDownload()
const uffsInstallBroker = () => uffs.installBroker()

/**
 * 進檔案頁自動把搜尋引擎拉起來。暫存 userData／uffsAuto=false 不跳 UAC。
 * @param {unknown} raw
 */
async function uffsEnsure(raw) {
  const force = Boolean(raw && typeof raw === 'object' && raw.force === true)
  if (uffs.inTempUserData()) {
    return uffs.ensureReady({ auto: false })
  }
  const state = await store.readState()
  const auto = force || state.uffsAuto !== false
  try {
    return await uffs.ensureReady({
      auto,
      onProgress: (info) => emit('explorer:uffsProgress', info)
    })
  } catch (error) {
    if (error && error.code === 'UFFS_BROKER') {
      await store.writeState({ uffsAuto: false })
    }
    throw error
  }
}

/**
 * @param {unknown} target
 */
async function openPath(target) {
  const full = paths.resolveExisting(target)
  const resolved = resolvePath(full)
  if (resolved.dir) return resolved
  const err = await shell.openPath(full)
  if (err) throw paths.fail('OPEN_FAILED', '打不開')
  return true
}

async function fileIcon(target, opts) {
  const full = paths.resolveExisting(target)
  const resolved = resolvePath(full)
  const wantThumb = Boolean(opts && typeof opts === 'object' && opts.thumb === true)
  if (wantThumb && !resolved.dir) {
    try {
      const url = await shellExt.thumbOf(resolved.path, opts.size)
      if (url) return { url }
    } catch (error) {
      console.error('[explorer] 殼層縮圖失敗:', error?.message || error)
    }
  }
  try {
    const url = await shellExt.iconOf(resolved.path)
    if (url) return { url }
  } catch (error) {
    console.error('[explorer] 殼層圖示失敗:', error?.message || error)
  }
  if (resolved.dir) return { folder: true }
  try {
    const icon = await app.getFileIcon(resolved.path, { size: 'normal' })
    if (icon.isEmpty()) throw new Error('empty icon')
    return { url: icon.toDataURL() }
  } catch {
    throw paths.fail('ICON_FAILED', '讀不到檔案圖示')
  }
}

/** 拿不到檔案圖示時的保底圖（1x1 透明 PNG）：`startDrag` 的 icon 是空的就直接丟例外。 */
const FALLBACK_DRAG_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4' +
  '2mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

async function dragIcon(target) {
  try {
    const info = await fileIcon(target)
    if (info && info.url) {
      const image = nativeImage.createFromDataURL(info.url)
      if (!image.isEmpty()) return image
    }
  } catch {
    // 殼層圖示是裝飾，拿不到就往下走
  }
  try {
    const image = await app.getFileIcon(target, { size: 'normal' })
    if (!image.isEmpty()) return image
  } catch {
    // 同上
  }
  return nativeImage.createFromDataURL(FALLBACK_DRAG_ICON)
}

/**
 * 把選取的項目交給 Windows 的原生拖放，讓它們拖得進別的程式
 * （瀏覽器的上傳框、桌面、Office）。renderer 只能在 dragstart 當下呼叫：
 * `startDrag` 底下是 OS 的 DoDragDrop，會一路阻塞到使用者放手。
 *
 * @param {string[]} list renderer 剛列出來的絕對路徑
 * @param {{ startDrag: Function, isDestroyed?: () => boolean }} sender 發起拖曳的 webContents
 * @returns {Promise<boolean>} 有沒有真的交給 OS
 */
async function startDrag(list, sender) {
  const files = []
  for (const item of (Array.isArray(list) ? list : []).slice(0, 100)) {
    try {
      files.push(paths.resolveExisting(item))
    } catch {
      // 清單畫出來之後被刪掉的，跳過就好
    }
  }
  if (!files.length || !sender || sender.isDestroyed?.()) return false
  const icon = await dragIcon(files[0])
  sender.startDrag(files.length === 1 ? { file: files[0], icon } : { files, icon })
  return true
}

function shellMenu(spec) {
  return shellExt.menu(spec)
}

function shellInvoke(token, cmd, dir) {
  return shellExt.invoke(token, cmd, dir)
}

function shellRelease(token) {
  return shellExt.release(token)
}

function folderSize(dirPath, token) {
  return size.folderSize(dirPath, token, {
    onProgress: (info) => emit('explorer:folderSizeProgress', info)
  })
}

function folderSizeCancel(token) {
  return size.folderSizeCancel(token)
}

function shutdown() {
  size.folderSizeCancel()
  watch.stop()
  shellExt.shutdown()
  return true
}

/**
 * @param {unknown} target
 */
function reveal(target) {
  const full = paths.resolveExisting(target)
  shell.showItemInFolder(full)
  return true
}

/**
 * @param {unknown} items
 * @param {unknown} mode
 */
function setClipboard(items, mode) {
  if (!Array.isArray(items)) throw paths.fail('BAD_PATH', '路徑不合法')
  const next = []
  for (const item of items.slice(0, 50)) {
    next.push(paths.resolveExisting(item))
  }
  clip = { mode: mode === 'cut' ? 'cut' : 'copy', paths: next }
  return { count: clip.paths.length, mode: clip.mode }
}

/**
 * @param {unknown} toDir
 */
async function paste(toDir) {
  let clipboard = clip
  if (!clipboard.paths.length) throw paths.fail('EMPTY', '剪貼簿是空的')
  const trashed = recycle.isRecyclePath(toDir)
  if (trashed && clipboard.mode !== 'cut') throw paths.fail('BAD_PATH', '不能複製進資源回收筒')
  const dest = trashed ? toDir : paths.resolveExisting(toDir)
  const pending = clipboard.paths.slice()
  const out = []
  for (const src of pending) {
    const result = trashed ? await files.removeEntry(src)
      : clipboard.mode === 'cut' ? await files.moveEntry(src, dest) : await files.copyEntry(src, dest)
    out.push(result.path)
    if (clipboard.mode === 'cut' && clip === clipboard) {
      clip = { ...clipboard, paths: clipboard.paths.filter((item) => item !== src) }
      clipboard = clip
    }
  }
  return trashed ? { paths: out, trashed: true } : { paths: out }
}

/**
 * 拖放到資料夾列或側欄位置。mode=copy 複製，其餘搬移；丟進回收筒＝刪除。
 * @param {unknown} items
 * @param {unknown} toDir
 * @param {unknown} mode
 */
async function dropEntries(items, toDir, mode) {
  if (!Array.isArray(items)) throw paths.fail('BAD_PATH', '路徑不合法')
  const slice = items.slice(0, 50)
  if (recycle.isRecyclePath(toDir)) {
    if (mode === 'copy') throw paths.fail('BAD_PATH', '不能複製進資源回收筒')
    const out = []
    for (const src of slice) out.push((await files.removeEntry(src)).path)
    return { paths: out, trashed: true }
  }
  const dest = paths.resolveExisting(toDir)
  const copy = mode === 'copy'
  const out = []
  for (const src of slice) {
    const result = copy ? await files.copyEntry(src, dest) : await files.moveEntry(src, dest)
    out.push(result.path)
  }
  return { paths: out }
}

/**
 * @param {unknown} dirPath
 */
function watchDir(dirPath) {
  if (recycle.isRecyclePath(dirPath)) return { watching: false, path: recycle.RECYCLE_CWD }
  return watch.start(dirPath, (payload) => emit('explorer:changed', payload))
}

function unwatch() {
  watch.stop()
  return true
}

module.exports = {
  configure,
  bootstrap,
  saveState,
  listPlaces,
  savePlaces,
  addPlace,
  removePlace,
  connectShare,
  pickFolder,
  resolvePath,
  createShortcut,
  listDrives,
  driveInfo,
  listDir,
  preview,
  inspect,
  createEntry,
  renameEntry,
  removeEntry,
  restoreEntry,
  purgeEntry,
  emptyRecycle,
  copyEntry,
  moveEntry,
  openPath,
  fileIcon,
  startDrag,
  shellMenu,
  shellInvoke,
  shellRelease,
  shutdown,
  reveal,
  setClipboard,
  paste,
  dropEntries,
  watchDir,
  unwatch,
  uffsStatus,
  uffsSearch,
  uffsCancel,
  uffsInstall,
  uffsCancelInstall,
  uffsInstallBroker,
  uffsEnsure,
  folderSize,
  folderSizeCancel
}
