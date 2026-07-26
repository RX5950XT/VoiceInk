/**
 * 本機翻譯模型 TPS（tokens/s）：CPU vs CUDA
 * npx electron scripts/bench-tps.js
 */
const path = require('path')
const { app } = require('electron')
const { execSync } = require('child_process')

app.setPath('userData', path.join(app.getPath('appData'), 'voiceink'))

// 同步 Machine/User PATH（CUDA bin）
try {
  const machine = execSync(
    "powershell -NoProfile -Command \"[Environment]::GetEnvironmentVariable('Path','Machine')\"",
    { encoding: 'utf8' }
  ).trim()
  const user = execSync(
    "powershell -NoProfile -Command \"[Environment]::GetEnvironmentVariable('Path','User')\"",
    { encoding: 'utf8' }
  ).trim()
  process.env.PATH = [machine, user, process.env.PATH].filter(Boolean).join(';')
} catch { /* ignore */ }

const PROMPTS = [
  {
    name: '短句 EN',
    system: '將使用者訊息翻譯成繁體中文（台灣）。只輸出譯文。',
    user: 'Hello world. How are you today?',
    maxTokens: 64
  },
  {
    name: '中段 EN',
    system: '將使用者訊息翻譯成繁體中文（台灣）。只輸出譯文。',
    user:
      'Artificial intelligence systems are increasingly used in everyday products. ' +
      'Speech recognition and translation help people communicate across languages. ' +
      'Efficiency depends on hardware and quantization.',
    maxTokens: 256
  },
  {
    name: '中段 JA',
    system: '將使用者訊息翻譯成繁體中文（台灣）。只輸出譯文。',
    user:
      '人工知能の発展により、音声認識や機械翻訳の精度が大きく向上しています。' +
      'リアルタイム字幕は会議や動画視聴で役立ちます。',
    maxTokens: 256
  }
]

function ms(t0) {
  return performance.now() - t0
}

/**
 * @param {object} opts
 * @param {boolean|string} opts.gpu
 * @param {string} opts.modelPath
 * @param {string} opts.label
 */
async function benchDevice({ gpu, modelPath, label }) {
  const { getLlama, LlamaChatSession } = await import('node-llama-cpp')
  console.log(`\n======== ${label} (gpu=${JSON.stringify(gpu)}) ========`)
  const tLoad0 = performance.now()
  const llama = await getLlama({ gpu, progressLogs: false })
  const model = await llama.loadModel({ modelPath })
  const context = await model.createContext({ contextSize: 2048 })
  const session = new LlamaChatSession({ contextSequence: context.getSequence() })
  const loadMs = ms(tLoad0)
  console.log(`load: ${loadMs.toFixed(0)} ms | llama.gpu=${llama.gpu}`)

  // 暖機 1 token
  session.setChatHistory([{ type: 'system', text: '你是翻譯引擎。' }])
  await session.prompt('warmup', {
    maxTokens: 1,
    temperature: 0,
    budgets: { thoughtTokens: 0 }
  })

  const rows = []
  for (const p of PROMPTS) {
    // 每題重置 history，避免前文干擾
    session.setChatHistory([{ type: 'system', text: p.system }])
    const t0 = performance.now()
    const out = await session.prompt(p.user, {
      maxTokens: p.maxTokens,
      temperature: 0,
      budgets: { thoughtTokens: 0 }
    })
    const elapsedMs = ms(t0)
    const elapsedSec = elapsedMs / 1000

    // 以模型 tokenizer 計 output tokens（較準）
    let outTokens = 0
    let inTokens = 0
    try {
      const outToks = model.tokenize(String(out || ''), true)
      outTokens = Array.isArray(outToks) ? outToks.length : Number(outToks?.length) || 0
    } catch {
      // 粗估：中文約 1.5 字/token、英文約 4 char/token
      outTokens = Math.max(1, Math.ceil([...String(out || '')].length / 1.8))
    }
    try {
      const inToks = model.tokenize(p.user, true)
      inTokens = Array.isArray(inToks) ? inToks.length : Number(inToks?.length) || 0
    } catch {
      inTokens = Math.max(1, Math.ceil(p.user.length / 4))
    }

    const tps = outTokens / Math.max(0.001, elapsedSec)
    rows.push({
      name: p.name,
      elapsedMs,
      inTokens,
      outTokens,
      tps,
      out: String(out || '').replace(/\s+/g, ' ').slice(0, 60)
    })
    console.log(
      `  ${p.name}: ${elapsedMs.toFixed(0)} ms | in≈${inTokens} out=${outTokens} tok | ` +
        `TPS=${tps.toFixed(1)} | "${rows[rows.length - 1].out}"`
    )
  }

  // 純生成吞吐：固定長 prompt、較高 maxTokens
  session.setChatHistory([
    {
      type: 'system',
      text: '將使用者訊息翻譯成繁體中文（台灣）。只輸出譯文，不要解釋。'
    }
  ])
  const genUser =
    'Please write a detailed paragraph about why real-time speech translation matters for education, ' +
    'business meetings, and online video, and what hardware factors affect latency.'
  const tGen = performance.now()
  const genOut = await session.prompt(genUser, {
    maxTokens: 200,
    temperature: 0,
    budgets: { thoughtTokens: 0 }
  })
  const genMs = ms(tGen)
  let genToks = 0
  try {
    const t = model.tokenize(String(genOut || ''), true)
    genToks = Array.isArray(t) ? t.length : 0
  } catch {
    genToks = Math.max(1, Math.ceil([...String(genOut || '')].length / 1.8))
  }
  const genTps = genToks / Math.max(0.001, genMs / 1000)
  console.log(
    `  吞吐測試(maxTokens=200): ${genMs.toFixed(0)} ms | out=${genToks} tok | TPS=${genTps.toFixed(1)}`
  )
  rows.push({
    name: '吞吐 max200',
    elapsedMs: genMs,
    inTokens: 0,
    outTokens: genToks,
    tps: genTps,
    out: ''
  })

  // dispose（不 dispose llama 避免 Windows AV）
  try {
    if (typeof session.dispose === 'function') await session.dispose()
  } catch { /* */ }
  try {
    if (typeof context.dispose === 'function') await context.dispose()
  } catch { /* */ }
  try {
    if (typeof model.dispose === 'function') await model.dispose()
  } catch { /* */ }

  const translateRows = rows.filter((r) => r.name !== '吞吐 max200')
  const avgTps =
    translateRows.reduce((s, r) => s + r.tps, 0) / Math.max(1, translateRows.length)

  return {
    label,
    backend: String(llama.gpu),
    loadMs,
    avgTps,
    genTps,
    genToks,
    rows
  }
}

async function main() {
  const models = require('../src/main/models')
  const cudaEnv = require('../src/main/cuda-env')
  try {
    cudaEnv.prependCudaBinToPath()
  } catch { /* */ }

  const key = models.isDownloaded('qwen35translate')
    ? 'qwen35translate'
    : models.LLM_MODEL_KEYS.find((k) => models.isDownloaded(k))
  if (!key) {
    console.error('無本地翻譯模型')
    process.exit(1)
  }
  const rel = models.ggufRelativePath(key)
  const modelPath = path.join(models.modelDir(key), rel)
  console.log('model:', key, modelPath)
  console.log('cudaRuntime:', cudaEnv.detectCudaRuntime().hasCudaRuntime)

  const cpu = await benchDevice({ gpu: false, modelPath, label: 'CPU' })

  let gpu = null
  if (cudaEnv.detectCudaRuntime().hasCudaRuntime) {
    // 稍等 GC / VRAM
    await new Promise((r) => setTimeout(r, 500))
    gpu = await benchDevice({ gpu: 'cuda', modelPath, label: 'CUDA' })
  } else {
    console.log('\nSKIP CUDA (no runtime)')
  }

  console.log('\n======== TPS SUMMARY ========')
  console.log(
    `CPU   load ${cpu.loadMs.toFixed(0)} ms | 翻譯任務 avg TPS ${cpu.avgTps.toFixed(1)} | 吞吐 TPS ${cpu.genTps.toFixed(1)} (${cpu.genToks} tok)`
  )
  if (gpu) {
    console.log(
      `CUDA  load ${gpu.loadMs.toFixed(0)} ms | 翻譯任務 avg TPS ${gpu.avgTps.toFixed(1)} | 吞吐 TPS ${gpu.genTps.toFixed(1)} (${gpu.genToks} tok)`
    )
    console.log(
      `加速比：翻譯 ×${(gpu.avgTps / Math.max(0.01, cpu.avgTps)).toFixed(2)} | 吞吐 ×${(gpu.genTps / Math.max(0.01, cpu.genTps)).toFixed(2)}`
    )
  }
  console.log(
    '\n註：TPS = 輸出 tokens / 生成秒數（含 prompt 處理）；翻譯任務通常輸出短，端到端延遲比純吞吐更重要。'
  )
  process.exit(0)
}

app.whenReady().then(main).catch((e) => {
  console.error(e)
  process.exit(1)
})
