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

/** @type {Map<string, { dir: string, watcher: fs.FSWatcher, timer: NodeJS.Timeout | null, pending: boolean, firstAt: number, send: (payload: { path: string }) => void }>} */
let active = new Map()

function closeAll(map) {
  for (const item of map.values()) {
    if (item.timer) clearTimeout(item.timer)
    try {
      item.watcher.close()
    } catch {
      // 已經掛掉
    }
  }
}

function stop() {
  closeAll(active)
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
  // 同一個資料夾沿用既有 watcher。每次重讀目錄都會再呼叫一次這裡，先全部關掉再重開
  // 會漏事件：重開之間的改動沒人看，連還沒送出的 debounce 事件也被 clearTimeout 吃掉，
  // 那次改動就再也不會送到畫面（新檔案永遠不出現，只能手動 F5）。
  const next = new Map()
  const out = []
  for (const item of Array.isArray(list) ? list : []) {
    const full = paths.resolveAbs(item.path)
    const key = full.toLowerCase()
    if (next.has(key)) continue
    if (typeof item.send !== 'function') {
      out.push({ watching: false, path: full })
      continue
    }
    const live = active.get(key)
    if (live) {
      active.delete(key)
      live.send = item.send
      next.set(key, live)
      out.push({ watching: true, path: full })
      continue
    }
    let watcher
    try {
      watcher = fs.watch(full, { persistent: false })
    } catch {
      out.push({ watching: false, path: full })
      continue
    }
    const state = { dir: full, watcher, timer: null, pending: false, firstAt: 0, send: item.send }
    const flush = () => {
      state.timer = null
      if (!state.pending) return
      state.pending = false
      state.send({ path: full })
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
    next.set(key, state)
    out.push({ watching: true, path: full })
  }
  closeAll(active) // 只關掉這次不看的那些
  active = next
  return out
}

module.exports = { DEBOUNCE_MS, start, startMany, stop }
