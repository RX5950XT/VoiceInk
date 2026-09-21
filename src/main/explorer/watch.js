'use strict'

/**
 * 只監看目前那一層資料夾（Main Process）。
 *
 * 失敗就回 `{ watching: false }`，UI 退回手動重新整理。事件合併，避免
 * 解壓縮時把畫面刷死。
 */

const fs = require('../raw-fs')
const paths = require('./paths')

const DEBOUNCE_MS = 250
const MAX_WAIT_MS = 1000

/** @type {Map<string, { dir: string, watcher: fs.FSWatcher, timer: NodeJS.Timeout | null, pending: boolean, firstAt: number }>} */
let active = new Map()

function stop() {
  for (const item of active.values()) {
    if (item.timer) clearTimeout(item.timer)
    try {
      item.watcher.close()
    } catch {
      // 已經掛掉
    }
  }
  active = new Map()
}

/**
 * @param {unknown} dirPath
 * @param {(payload: { path: string }) => void} send
 * @returns {{ watching: boolean, path: string }}
 */
function start(dirPath, send) {
  const full = paths.resolveAbs(dirPath)
  return startMany([{ path: full, send }])[0] || { watching: false, path: full }
}

/**
 * 同時監看左右欄可見資料夾。舊的 start() 仍保留單欄語意。
 * @param {Array<{ path: string, send: (payload: { path: string }) => void }>} list
 */
function startMany(list) {
  stop()
  const out = []
  const seen = new Set()
  for (const item of Array.isArray(list) ? list : []) {
    const full = paths.resolveAbs(item.path)
    const key = full.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (typeof item.send !== 'function') {
      out.push({ watching: false, path: full })
      continue
    }
    let watcher
    try {
      watcher = fs.watch(full, { persistent: false })
    } catch {
      out.push({ watching: false, path: full })
      continue
    }
    const state = { dir: full, watcher, timer: null, pending: false, firstAt: 0 }
    const flush = () => {
      state.timer = null
      if (!state.pending) return
      state.pending = false
      item.send({ path: full })
    }
    watcher.on('error', () => {
      if (state.timer) clearTimeout(state.timer)
      active.delete(key)
    })
    watcher.on('change', () => {
      state.pending = true
      if (!state.timer) state.firstAt = Date.now()
      else clearTimeout(state.timer)
      const wait = Math.min(DEBOUNCE_MS, Math.max(0, state.firstAt + MAX_WAIT_MS - Date.now()))
      state.timer = setTimeout(flush, wait)
    })
    active.set(key, state)
    out.push({ watching: true, path: full })
  }
  return out
}

module.exports = { DEBOUNCE_MS, start, startMany, stop }
