'use strict'

/**
 * 整機檔案總管門面（Main Process）。
 *
 * renderer 送絕對路徑；所有進出都過 `paths.js`。UFFS 只當搜尋引擎，
 * 關 App 不停它的 daemon。
 */

const { shell, dialog, BrowserWindow } = require('electron')
const os = require('os')
const fs = require('fs')
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
  let cwd = state.lastPath
  if (!cwd) {
    try {
      cwd = os.homedir()
    } catch {
      cwd = disks[0] ? disks[0].path : 'C:\\'
    }
  }
  if (!recycle.isRecyclePath(cwd)) {
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
const listDir = (dirPath, opts) => (
  recycle.isRecyclePath(dirPath) ? files.listRecycle(opts) : files.listDir(dirPath, opts)
)
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

function resolvePath(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) throw paths.fail('BAD_PATH', '路徑不合法')
  if (text === '資源回收筒' || text.toLowerCase() === 'recyclebin') {
    return { path: recycle.RECYCLE_CWD, dir: true, parent: recycle.RECYCLE_CWD }
  }
  const full = paths.resolveAbs(text)
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
  const err = await shell.openPath(full)
  if (err) throw paths.fail('OPEN_FAILED', '打不開')
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
  if (!clip.paths.length) throw paths.fail('EMPTY', '剪貼簿是空的')
  if (recycle.isRecyclePath(toDir)) {
    if (clip.mode !== 'cut') throw paths.fail('BAD_PATH', '不能複製進資源回收筒')
    const out = []
    for (const src of clip.paths) out.push((await files.removeEntry(src)).path)
    clip = { mode: 'copy', paths: [] }
    return { paths: out, trashed: true }
  }
  const dest = paths.resolveExisting(toDir)
  const out = []
  for (const src of clip.paths) {
    const result = clip.mode === 'cut'
      ? await files.moveEntry(src, dest)
      : await files.copyEntry(src, dest)
    out.push(result.path)
  }
  if (clip.mode === 'cut') clip = { mode: 'copy', paths: [] }
  return { paths: out }
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
  uffsEnsure
}
