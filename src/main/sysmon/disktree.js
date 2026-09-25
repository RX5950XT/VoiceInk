'use strict'

/**
 * 磁碟空間掃描。renderer 只送一個絕對路徑；執行檔、上限與輸出解析都在這裡。
 * 沒有 voiceink-probe 就不掃——整碟用 JS 走一次太慢，也不做那條退路。
 *
 * 進度走 sysmon 既有的 emit：`{ type: 'diskTreeProgress', data: { bytes, files, dirs } }`。
 */

const path = require('path')
const { spawn } = require('child_process')
const fs = require('fs')

const MAX_MS = 180_000
const MAX_DEPTH = 12
const KEEP = 200
const STAT_TIMEOUT_MS = 8_000

/**
 * @param {string} code
 * @param {string} userMessage
 */
function fail(code, userMessage) {
  const err = new Error(code)
  err.code = code
  err.userMessage = userMessage
  return err
}

/** @param {string} rootPath */
function isDevicePath(rootPath) {
  return rootPath.startsWith('\\\\.\\') || rootPath.startsWith('\\\\?\\')
}

/**
 * 使用者挑的資料夾可能在睡著的網路磁碟上。非同步還要加逾時，不然這條 IPC 會掛著不回來。
 * @param {(p: string) => Promise<import('fs').Stats>} stat
 * @param {string} rootPath
 */
function statSoon(stat, rootPath) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(fail('DISKTREE_BAD_PATH', '讀不到這個資料夾'))
    }, STAT_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()
    Promise.resolve(stat(rootPath)).then((info) => {
      clearTimeout(timer)
      resolve(info)
    }, () => {
      clearTimeout(timer)
      reject(fail('DISKTREE_BAD_PATH', '讀不到這個資料夾'))
    })
  })
}

/**
 * @param {{
 *   exe?: string,
 *   emit?: (payload: { type: string, data: any }) => void,
 *   spawnFn?: typeof spawn,
 *   statFn?: (p: string) => Promise<import('fs').Stats>
 * }} [options]
 */
function createDiskTree(options = {}) {
  const exe = options.exe || ''
  const spawnChild = options.spawnFn || spawn
  const stat = options.statFn || fs.promises.stat
  const notify = typeof options.emit === 'function' ? options.emit : () => {}
  /** @type {any} */
  let current = null
  let generation = 0

  /** @param {any} job @param {(value: any) => void} fn @param {any} value */
  function settle(job, fn, value) {
    if (job.settled) return
    job.settled = true
    if (current === job) current = null
    fn(value)
  }

  /** @param {any} job @param {string} code @param {string} userMessage */
  function killJob(job, code, userMessage) {
    settle(job, job.reject, fail(code, userMessage))
    try { job.child.kill() } catch { /* 已經結束 */ }
  }

  function cancel() {
    generation += 1
    if (current) killJob(current, 'DISKTREE_CANCELLED', '掃描已取消')
  }

  /** @param {any} job @param {string} line */
  function onLine(job, line) {
    if (job.settled) return
    const text = line.replace(/\r$/, '')
    if (text.startsWith('P ')) {
      const parts = text.split(' ')
      if (parts.length !== 4) return
      const bytes = Number(parts[1])
      const files = Number(parts[2])
      const dirs = Number(parts[3])
      if (![bytes, files, dirs].every((n) => Number.isFinite(n))) return
      notify({ type: 'diskTreeProgress', data: { bytes, files, dirs } })
      return
    }
    if (text.startsWith('J ')) {
      let parsed
      try {
        parsed = JSON.parse(text.slice(2))
      } catch {
        settle(job, job.reject, fail('DISKTREE_BAD_JSON', '掃描結果無法解析'))
        return
      }
      settle(job, job.resolve, parsed)
      return
    }
    if (text.startsWith('E')) {
      settle(job, job.reject, fail('DISKTREE_READ', '讀不到這個資料夾'))
    }
  }

  /** @param {any} job */
  function attach(job) {
    let pending = ''
    job.child.stdout.setEncoding('utf8')
    job.child.stdout.on('data', (chunk) => {
      pending += chunk
      let index
      while ((index = pending.indexOf('\n')) >= 0) {
        onLine(job, pending.slice(0, index))
        pending = pending.slice(index + 1)
      }
    })
    job.child.on('error', () => {
      settle(job, job.reject, fail('DISKTREE_SPAWN', '磁碟掃描沒有啟動'))
    })
    job.child.on('close', () => {
      if (pending.trim()) onLine(job, pending)
      pending = ''
      settle(job, job.reject, fail('DISKTREE_INTERRUPTED', '掃描中斷'))
    })
  }

  /**
   * @param {string} rootPath
   * @returns {Promise<any>}
   */
  async function scan(rootPath) {
    if (!exe) {
      throw fail('DISKTREE_NO_PROBE', '需要先建置 voiceink-probe（npm run build:probe）')
    }
    if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath) || isDevicePath(rootPath)) {
      throw fail('DISKTREE_BAD_PATH', '請選擇一個資料夾')
    }
    const mine = ++generation
    if (current) killJob(current, 'DISKTREE_CANCELLED', '掃描已取消')
    const info = await statSoon(stat, rootPath).catch((err) => {
      if (mine !== generation) throw fail('DISKTREE_CANCELLED', '掃描已取消')
      throw err
    })
    if (mine !== generation) throw fail('DISKTREE_CANCELLED', '掃描已取消')
    if (!info.isDirectory()) throw fail('DISKTREE_BAD_PATH', '請選擇一個資料夾')
    return start(rootPath, mine)
  }

  /**
   * @param {string} rootPath
   * @param {number} mine
   */
  function start(rootPath, mine) {
    let child
    try {
      child = spawnChild(exe, ['disk-tree', rootPath, String(MAX_MS), String(MAX_DEPTH), String(KEEP)], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      })
    } catch {
      throw fail('DISKTREE_SPAWN', '磁碟掃描沒有啟動')
    }
    if (!child?.stdout || typeof child.kill !== 'function') {
      try { child?.kill?.() } catch { /* 已經結束 */ }
      throw fail('DISKTREE_SPAWN', '磁碟掃描沒有啟動')
    }
    return new Promise((resolve, reject) => {
      if (mine !== generation) {
        try { child.kill() } catch { /* 已經結束 */ }
        reject(fail('DISKTREE_CANCELLED', '掃描已取消'))
        return
      }
      const job = { child, resolve, reject, settled: false }
      current = job
      attach(job)
    })
  }

  return { scan, cancel, stop: cancel }
}

module.exports = { createDiskTree }
