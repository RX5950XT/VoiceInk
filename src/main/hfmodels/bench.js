'use strict'

/**
 * 實測調校：真的跑 `llama-bench.exe` 比幾組候選參數，挑最快的。
 *
 * **為什麼不能用算的**：KV 量化檔位與投機解碼對速度的影響跟模型架構、量化格式、
 * 顯示卡都有關，沒有公式。參考的那三個本機部署專案（Qwen3.8-27B 雙卡、Laguna S 2.1、
 * Qwen-35B-A3B）全都是跑一輪候選矩陣量出來的，不是推導出來的。
 *
 * 候選矩陣刻意很小（≤4 組）：每一組都要載一次模型，一顆 4B 在 Vulkan 上大約一分鐘，
 * 大模型更久。要更細的請自己用「原始參數」。
 *
 * `llama-bench` 的輸出用 `-o json`：表格形式會隨版本換欄位，JSON 至少欄位名穩定。
 */

const { spawn } = require('child_process')

/** 單一組候選的上限；載大模型很久，但也不能無限等 */
const RUN_TIMEOUT_MS = 600_000
/** 只量生成速度：prompt 處理速度受 batch 影響大，而使用者感受到的是吐字速度 */
const GEN_TOKENS = 64
const PROMPT_TOKENS = 256

/** @type {import('child_process').ChildProcess | null} */
let current = null
let cancelled = false

/**
 * 候選組合。第一組一定是「目前的決定」，這樣結果才看得出來「調校有沒有比較快」。
 * @param {{ cacheTypeK: string, cacheTypeV: string, specType: string }} base
 * @returns {Array<{ label: string, requested: Record<string, any> }>}
 */
function buildCandidates(base) {
  const list = [
    { label: '目前設定', requested: {} },
    { label: 'KV f16（品質優先）', requested: { cacheTypeK: 'f16', cacheTypeV: 'f16' } },
    { label: 'KV q8_0（省顯存）', requested: { cacheTypeK: 'q8_0', cacheTypeV: 'q8_0' } },
    { label: '關掉投機解碼', requested: { specType: '' } }
  ]
  // 目前已經是那一組的話就不必再量一次
  return list.filter((item, index) => {
    if (index === 0) return true
    const r = item.requested
    if (r.cacheTypeK && r.cacheTypeK === base.cacheTypeK && r.cacheTypeV === base.cacheTypeV) return false
    if ('specType' in r && r.specType === base.specType) return false
    return true
  })
}

/**
 * `llama-bench -o json` 的輸出 → 生成速度（tok/s）
 *
 * 只取 `n_gen > 0` 的那幾列（`tg` 那組）；`pp` 是 prompt 處理，不是使用者感受到的吐字速度。
 * @param {string} stdout
 * @returns {number} 0 = 量不到
 */
function parseBenchJson(stdout) {
  const text = String(stdout || '').trim()
  if (!text) return 0
  let rows
  try {
    rows = JSON.parse(text)
  } catch {
    // 有些版本會在 JSON 前後夾雜 log；抓最外層的陣列再試一次
    const at = text.indexOf('[')
    const to = text.lastIndexOf(']')
    if (at < 0 || to <= at) return 0
    try { rows = JSON.parse(text.slice(at, to + 1)) } catch { return 0 }
  }
  if (!Array.isArray(rows)) return 0
  const gen = rows.filter((row) => Number(row?.n_gen) > 0 && Number(row?.avg_ts) > 0)
  if (!gen.length) return 0
  return Math.max(...gen.map((row) => Number(row.avg_ts)))
}

/**
 * 跑一組候選
 * @param {{ benchExe: string, gguf: string, args: string[] }} options
 * @returns {Promise<number>} tok/s；0 = 失敗
 */
function runOnce(options) {
  return new Promise((resolve) => {
    let stdout = ''
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      current = null
      resolve(value)
    }
    let child
    try {
      child = spawn(options.benchExe, options.args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      })
    } catch {
      resolve(0)
      return
    }
    current = child
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已經結束了 */ }
      finish(0)
    }, RUN_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.on('error', () => finish(0))
    child.on('close', () => finish(parseBenchJson(stdout)))
  })
}

/**
 * @param {{ plan: object, requested: Record<string, any>, gguf: string }} input
 * @returns {string[]}
 */
function argsFor(input) {
  const p = input.plan
  const r = input.requested
  const ctk = r.cacheTypeK || p.cacheTypeK
  const ctv = r.cacheTypeV || p.cacheTypeV
  const args = [
    '-m', input.gguf,
    '-p', String(PROMPT_TOKENS),
    '-n', String(GEN_TOKENS),
    '-r', '2',
    '-o', 'json',
    '-ctk', ctk,
    '-ctv', ctv
  ]
  if (p.device) args.push('-dev', p.device)
  if (p.ctxSize) args.push('-c', String(p.ctxSize))
  // V 量化需要 flash attention（K 不用）
  if (ctv !== 'f16') args.push('-fa', 'on')
  if (p.gpuLayers !== undefined && p.gpuLayers !== null) args.push('-ngl', String(p.gpuLayers))
  if (p.nCpuMoe > 0) args.push('-ncmoe', String(p.nCpuMoe))
  return args
}

/**
 * 跑整輪候選並挑最快的
 * @param {{ benchExe: string, gguf: string, plan: object,
 *           onProgress?: (p: { index: number, total: number, label: string, tps?: number }) => void }} options
 * @returns {Promise<{ best: { label: string, requested: object, tps: number } | null,
 *                     results: Array<{ label: string, tps: number }>, cancelled: boolean }>}
 */
async function tune(options) {
  cancelled = false
  const candidates = buildCandidates({
    cacheTypeK: options.plan.cacheTypeK,
    cacheTypeV: options.plan.cacheTypeV,
    specType: options.plan.specType
  })
  const results = []
  for (let i = 0; i < candidates.length; i += 1) {
    if (cancelled) break
    const candidate = candidates[i]
    options.onProgress?.({ index: i, total: candidates.length, label: candidate.label })
    const tps = await runOnce({
      benchExe: options.benchExe,
      gguf: options.gguf,
      args: argsFor({ plan: options.plan, requested: candidate.requested, gguf: options.gguf })
    })
    results.push({ label: candidate.label, requested: candidate.requested, tps })
    options.onProgress?.({ index: i, total: candidates.length, label: candidate.label, tps })
  }
  const usable = results.filter((r) => r.tps > 0)
  // 只有「明顯比較快」（>3%）才換：量測本身有雜訊，為了 1% 去改設定不划算
  const baseline = results[0]?.tps || 0
  const best = usable.sort((a, b) => b.tps - a.tps)[0] || null
  const worth = best && baseline > 0 ? best.tps > baseline * 1.03 : !!best
  return {
    best: worth ? best : null,
    results: results.map((r) => ({ label: r.label, tps: r.tps })),
    cancelled
  }
}

function cancel() {
  cancelled = true
  if (current) {
    try { current.kill() } catch { /* 已經結束了 */ }
  }
  return true
}

module.exports = { tune, cancel, buildCandidates, parseBenchJson, argsFor, GEN_TOKENS, PROMPT_TOKENS }
