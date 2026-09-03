'use strict'

/**
 * 應用程式內自動更新（electron-updater + GitHub Releases）。
 *
 * 為什麼不是 Electron 內建的 autoUpdater：內建那顆在 Windows 上只吃 Squirrel.Windows，
 * 我們打的是 NSIS。electron-updater 讀的是 electron-builder 產出的 `latest.yml`
 * （sha512 在裡面，下載完會自己驗），所以**發行時 latest.yml 一定要跟 .exe 一起上傳**。
 *
 * 另一個坑：`autoInstallOnAppQuit` 在這個 App 上**沒有作用**——它掛的是 `app.once('quit')`，
 * 而我們的 `before-quit` 收完子程序是走 `app.exit(0)`（不發 quit 事件）。
 * 所以「結束時順便裝好」改由 main.js 在 exit 前呼叫 `installOnQuit()`。
 */

const { app } = require('electron')

/** @typedef {'idle'|'checking'|'available'|'downloading'|'downloaded'|'none'|'error'|'unsupported'} UpdateState */

/** @type {import('electron-updater').AppUpdater | null} */
let updater = null
/** @type {(status: object) => void} */
let notify = () => {}
/** 自動下載開關（設定頁的「自動更新」） */
let autoEnabled = true

const state = {
  /** @type {UpdateState} */ state: app.isPackaged ? 'idle' : 'unsupported',
  version: '',
  percent: 0,
  message: app.isPackaged ? '' : '開發模式不檢查更新（只有安裝版才會自動更新）。'
}

function emit(patch) {
  Object.assign(state, patch)
  notify(status())
}

/** @returns {{state: UpdateState, version: string, percent: number, message: string, currentVersion: string, autoUpdate: boolean}} */
function status() {
  return { ...state, currentVersion: app.getVersion(), autoUpdate: autoEnabled }
}

function get() {
  if (updater) return updater
  const { autoUpdater } = require('electron-updater')
  autoUpdater.autoDownload = autoEnabled
  // 交給 main.js 的 before-quit 處理（見檔頭）
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.on('checking-for-update', () => emit({ state: 'checking', message: '正在檢查更新…', percent: 0 }))
  autoUpdater.on('update-available', (info) => emit({
    state: autoEnabled ? 'downloading' : 'available',
    version: info?.version || '',
    percent: 0,
    message: autoEnabled ? `發現新版本 v${info?.version}，開始下載…` : `發現新版本 v${info?.version}。`
  }))
  autoUpdater.on('update-not-available', () => emit({ state: 'none', percent: 0, message: '已經是最新版本。' }))
  autoUpdater.on('download-progress', (p) => emit({
    state: 'downloading',
    percent: Math.round(p?.percent || 0),
    message: `下載中 ${Math.round(p?.percent || 0)}%`
  }))
  autoUpdater.on('update-downloaded', (info) => emit({
    state: 'downloaded',
    version: info?.version || state.version,
    percent: 100,
    message: `v${info?.version || state.version} 已下載完成，重新啟動即可完成安裝。`
  }))
  autoUpdater.on('error', (err) => {
    // 錯誤原文只進 console：這條路上的訊息由 GitHub 決定，不往 UI 送
    console.error('[updater]', err?.message || err)
    emit({ state: 'error', percent: 0, message: '檢查更新失敗（無法連線到 GitHub，或這個版本沒有附帶更新資訊）。' })
  })
  updater = autoUpdater
  return updater
}

/**
 * @param {{autoUpdate: boolean, onStatus: (s: object) => void}} opts
 */
function configure({ autoUpdate, onStatus }) {
  autoEnabled = autoUpdate !== false
  if (typeof onStatus === 'function') notify = onStatus
  if (updater) updater.autoDownload = autoEnabled
}

/** 手動按「檢查更新」；autoDownload 開著的話會直接接著下載 */
async function check() {
  if (!app.isPackaged) return status()
  try {
    await get().checkForUpdates()
  } catch (err) {
    console.error('[updater] check failed:', err?.message || err)
    emit({ state: 'error', percent: 0, message: '檢查更新失敗（無法連線到 GitHub，或這個版本沒有附帶更新資訊）。' })
  }
  return status()
}

/** 開機後靜靜看一次（失敗不吵使用者） */
function checkQuietly() {
  if (!app.isPackaged || !autoEnabled) return
  check().catch(() => {})
}

/** 「重新啟動並安裝」：靜默安裝 ＋ 裝完自己開起來 */
function quitAndInstall() {
  if (!app.isPackaged || state.state !== 'downloaded') return false
  get().quitAndInstall(true, true)
  return true
}

/**
 * 結束前順手把已下載的更新裝起來（同步，只能在 before-quit 的最後一步呼叫）。
 * 已經走過 quitAndInstall 的話 electron-updater 自己會擋掉重複安裝。
 */
function installOnQuit() {
  if (!app.isPackaged || !autoEnabled || state.state !== 'downloaded' || !updater) return false
  try {
    return updater.install(true, false)
  } catch (err) {
    console.error('[updater] install on quit failed:', err?.message || err)
    return false
  }
}

module.exports = { configure, check, checkQuietly, quitAndInstall, installOnQuit, status }
