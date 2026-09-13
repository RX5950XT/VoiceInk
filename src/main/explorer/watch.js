'use strict'

/**
 * 只監看目前那一層資料夾（Main Process）。
 *
 * 失敗就回 `{ watching: false }`，UI 退回手動重新整理。事件合併，避免
 * 解壓縮時把畫面刷死。
 */

const fs = require('fs')
const paths = require('./paths')

const DEBOUNCE_MS = 250
const MAX_WAIT_MS = 1000

/** @type {{ dir: string, watcher: fs.FSWatcher } | null} */
let active = null
/** @type {NodeJS.Timeout | null} */
let timer = null
let pending = false
let firstAt = 0

function stop() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  pending = false
  if (!active) return
  try {
    active.watcher.close()
  } catch {
    // 已經掛掉
  }
  active = null
}

/**
 * @param {unknown} dirPath
 * @param {(payload: { path: string }) => void} send
 * @returns {{ watching: boolean, path: string }}
 */
function start(dirPath, send) {
  const full = paths.resolveAbs(dirPath)
  if (active && active.dir.toLowerCase() === full.toLowerCase()) {
    return { watching: true, path: full }
  }
  stop()
  let watcher
  try {
    watcher = fs.watch(full, { persistent: false })
  } catch {
    return { watching: false, path: full }
  }
  const flush = () => {
    timer = null
    if (!pending) return
    pending = false
    send({ path: full })
  }
  watcher.on('error', () => stop())
  watcher.on('change', () => {
    pending = true
    if (!timer) firstAt = Date.now()
    else clearTimeout(timer)
    const wait = Math.min(DEBOUNCE_MS, Math.max(0, firstAt + MAX_WAIT_MS - Date.now()))
    timer = setTimeout(flush, wait)
  })
  active = { dir: full, watcher }
  return { watching: true, path: full }
}

module.exports = { DEBOUNCE_MS, start, stop }
