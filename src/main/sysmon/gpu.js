'use strict'

/**
 * VoiceInk — GPU 即時讀數（GPU-Z 那一塊）。
 *
 * `nvidia-smi` 自己就有輪詢模式（`-l <秒>`），所以開**一顆常駐子程序**讓它自己每 N 秒印一行，
 * 而不是每輪 spawn 一次（spawn 一次約 100～200ms，跟真正要的資料一樣貴）。
 *
 * 沒有 NVIDIA 卡就整個安靜地不啟用：使用率／VRAM 仍有 Windows 的 GPU 效能計數器
 * （見 probe.ps1 的 GPUEngine／GPUProcessMemory），只是拿不到溫度與功耗。
 * 那不是 bug，Windows 沒有廠商中立的 GPU 溫度介面。
 */

const { spawn } = require('child_process')
const metrics = require('./metrics')

// 尾端欄位是後來補的：解析端逐格取值，舊機器少給幾格也不會整列壞掉
const QUERY = [
  'index', 'name', 'memory.total', 'memory.used',
  'utilization.gpu', 'temperature.gpu', 'power.draw', 'clocks.sm', 'fan.speed',
  'clocks.mem', 'pcie.link.gen.current', 'pcie.link.width.current', 'vbios_version'
].join(',')

/** 讀數超過這麼久沒更新就當成失效（顯示卡拔掉／驅動重載） */
const STALE_MS = 15_000

function createGpuFeed(deps = {}) {
  const spawnFn = deps.spawnFn || spawn

  /** @type {import('child_process').ChildProcess | null} */
  let child = null
  let buf = ''
  let running = false
  let available = false
  /** @type {Map<number, any>} */
  let cards = new Map()
  let lastAt = 0
  let intervalSec = 2

  function stopChild() {
    const dying = child
    child = null
    if (!dying) return
    try { dying.kill() } catch { /* 已經沒了 */ }
  }

  function launch() {
    stopChild()
    buf = ''
    let proc
    try {
      proc = spawnFn('nvidia-smi', [
        `--query-gpu=${QUERY}`,
        '--format=csv,noheader,nounits',
        `-l`, String(intervalSec)
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      available = false
      return
    }
    child = proc

    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk) => {
      buf += chunk
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        const card = metrics.parseNvidiaSmiRow(line)
        if (!card) continue
        available = true
        lastAt = Date.now()
        cards.set(card.index, card)
      }
      if (buf.length > 64 * 1024) buf = ''
    })
    // 沒裝驅動時 spawn 直接 ENOENT，這是正常路徑，不是錯誤
    proc.on('error', () => { available = false; child = null })
    proc.on('close', () => {
      if (child !== proc) return
      child = null
      // nvidia-smi 在驅動重載時會自己退出；服務還開著就再試一次
      if (running) setTimeout(() => { if (running) launch() }, 5000)
    })
  }

  return {
    /** @param {number} [seconds] */
    start(seconds) {
      intervalSec = Math.max(1, Math.min(10, Math.trunc(Number(seconds) || 2)))
      if (running) return
      running = true
      launch()
    },
    stop() {
      running = false
      stopChild()
      cards = new Map()
      available = false
    },
    isRunning: () => running,
    /** @returns {{ available: boolean, cards: any[] }} */
    read() {
      const fresh = available && (Date.now() - lastAt) < STALE_MS
      return {
        available: fresh,
        cards: fresh ? [...cards.values()].sort((a, b) => a.index - b.index) : []
      }
    }
  }
}

module.exports = { createGpuFeed, QUERY }
