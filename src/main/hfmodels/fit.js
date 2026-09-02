'use strict'

/**
 * 跑 llama.cpp 官方的 `llama-fit-params.exe`，拿**實際量出來**的記憶體配置。
 *
 * 為什麼不自己算：`llama_params_fit` 會真的把模型載一次、量投影記憶體，然後印出
 * `-c / -ngl / -ts / -ot`。我們自己那套（`plan.js`）是估算——estimation 的誤差方向
 * 是「以為放得下 → 載入時 OOM」，而使用者只會看到「載入失敗」。
 * 對 MoE 尤其明顯：官方會產出一串挑選哪些層的哪些張量留在 CPU 的 `-ot` regex，
 * 那個東西手寫不出來也估不出來。
 *
 * 代價是它要花時間（要載一次模型），所以**只在下載完成後跑一次**並把結果快取進該模型的
 * `voiceink-meta.json`；下載前的預覽仍然走 `plan.js` 的估算。
 *
 * 已知上游 bug（ggml-org/llama.cpp#20308）：Windows 上 `--fit-target` 超過 4095 MiB 會溢位，
 * 所以 margin 一律夾在 4095。
 */

const { spawn } = require('child_process')

/** 載一次模型量記憶體，大模型會久一點 */
const FIT_TIMEOUT_MS = 300_000
/** 留給桌面合成器與其他程式的顯存（MiB）。上限 4095：再高會踩到 Windows 的溢位 bug */
const DEFAULT_MARGIN_MIB = 1024
const MAX_MARGIN_MIB = 4095

/**
 * `llama-fit-params` 把參數印在 stdout（log 走 stderr）。
 * 形狀例：`-c 8192 -ngl 36 -ts 0.58,0.42 -ot "blk\.(1[0-9])\.ffn_.*=CPU"`
 *
 * 用「一個一個 token 走」而不是一條大 regex：`-ot` 的值含空白與引號時
 * 一條 regex 很容易在某個 repo 上剛好對錯，而錯了不會報錯，只會產生一組怪參數。
 * `gpuLayers` 刻意留成**字串**：實測整顆放得下時它印的是 `-ngl -1`（＝全部），
 * 而 `llama-server` 的說明寫的是「an exact number, 'auto', or 'all'」。
 * 轉成 `all` 比原樣送 `-1` 保險，也比自己填一個層數誠實。
 * @param {string} stdout
 * @returns {{ ctxSize: number, gpuLayers: string, tensorSplit: string, overrideTensor: string, raw: string }}
 */
function parseFitOutput(stdout) {
  const text = String(stdout || '').trim()
  const out = { ctxSize: 0, gpuLayers: '', tensorSplit: '', overrideTensor: '', raw: text }
  // 以空白切，但把成對的引號當一個 token
  const tokens = text.match(/"[^"]*"|'[^']*'|\S+/g) || []
  const unquote = (s) => String(s || '').replace(/^["']|["']$/g, '')
  for (let i = 0; i < tokens.length; i += 1) {
    const key = tokens[i]
    const value = unquote(tokens[i + 1])
    if (value === undefined) break
    if (key === '-c' || key === '--ctx-size') out.ctxSize = Number(value) || 0
    else if (key === '-ngl' || key === '--gpu-layers' || key === '--n-gpu-layers') {
      out.gpuLayers = Number(value) < 0 ? 'all' : String(Math.max(0, Math.floor(Number(value) || 0)))
    } else if (key === '-ts' || key === '--tensor-split') out.tensorSplit = value
    else if (key === '-ot' || key === '--override-tensor') out.overrideTensor = value
  }
  return out
}

/**
 * 有沒有真的量出東西。**`-ngl 0` 是合法結果**（顯存真的不夠），
 * 所以判準是「有沒有給 ctx」而不是「ngl 是不是 0」。
 * @param {ReturnType<typeof parseFitOutput>} result
 * @returns {boolean}
 */
function isUsable(result) {
  return !!result && result.ctxSize > 0
}

/**
 * @param {{
 *   exe: string, gguf: string, mmproj?: string, ctxSize?: number, marginMiB?: number,
 *   device?: string, timeoutMs?: number, spawnFn?: typeof spawn
 * }} options
 * @returns {Promise<ReturnType<typeof parseFitOutput> | null>} null = 跑不起來／沒量出東西
 */
function runFit(options) {
  const spawnFn = options.spawnFn || spawn
  const margin = Math.min(MAX_MARGIN_MIB, Math.max(0, Number(options.marginMiB) || DEFAULT_MARGIN_MIB))
  const args = ['-m', options.gguf, '--fit-target', String(margin)]
  if (options.mmproj) args.push('--mmproj', options.mmproj)
  // 使用者指定了上下文就固定它，讓 fit 去調別的（官方語意：已設的參數不動）
  if (Number(options.ctxSize) > 0) args.push('-c', String(Math.floor(Number(options.ctxSize))))
  if (options.device) args.push('--device', options.device)

  return new Promise((resolve) => {
    let stdout = ''
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }
    let child
    try {
      // stderr 直接丟掉：那是 llama.cpp 的 log，內容量大且我們只要 stdout 的參數
      child = spawnFn(options.exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      resolve(null)
      return
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已經結束了 */ }
      finish(null)
    }, Number(options.timeoutMs) || FIT_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.on('error', () => finish(null))
    child.on('close', () => {
      // 結束碼刻意不看：實測它在「margin 滿足不了」時會抱怨，但照樣印出可用的建議值。
      // 判準是「有沒有印出東西」。
      const parsed = parseFitOutput(stdout)
      finish(isUsable(parsed) ? parsed : null)
    })
  })
}

module.exports = { runFit, parseFitOutput, isUsable, DEFAULT_MARGIN_MIB, MAX_MARGIN_MIB }
