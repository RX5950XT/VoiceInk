/**
 * 本機翻譯推論效率：CPU / GPU（分開跑避免 unload 崩潰）
 *   npx electron scripts/bench-llm-device.js cpu
 *   npx electron scripts/bench-llm-device.js gpu
 *   npx electron scripts/bench-llm-device.js both
 */
const path = require('path')
const { app } = require('electron')

app.setPath('userData', path.join(app.getPath('appData'), 'voiceink'))

const SAMPLES = [
  'Hello world.',
  'Good morning, how are you today?',
  'The weather is nice and we should go for a walk.',
  '人工知能の発展は目覚ましいものがあります。',
  'Please translate this sentence into Traditional Chinese carefully.'
]

const long =
  'Artificial intelligence systems are increasingly used in everyday products. ' +
  'Speech recognition and translation help people communicate across languages. ' +
  'Efficiency depends on hardware, quantization, and whether the model runs on CPU or GPU.'

function ms(t0) {
  return Math.round(performance.now() - t0)
}

function stats(arr) {
  const a = [...arr].sort((x, y) => x - y)
  const sum = a.reduce((s, v) => s + v, 0)
  return {
    n: a.length,
    min: a[0],
    max: a[a.length - 1],
    avg: Math.round(sum / a.length),
    p50: a[Math.floor(a.length * 0.5)],
    p90: a[Math.min(a.length - 1, Math.floor(a.length * 0.9))]
  }
}

async function runDevice(label, store, localLlm) {
  console.log(`\n======== ${label} ========`)
  const tWarm0 = performance.now()
  const warm = await localLlm.warm()
  const warmMs = ms(tWarm0)
  if (!warm.ok) throw new Error(warm.warnings?.join('; ') || 'warm failed')
  const info = localLlm.getLoadInfo()
  console.log(`warm: ${warmMs} ms | backend=${info.backend} key=${info.key} gpu=${info.gpu}`)

  const tWarm2 = performance.now()
  await localLlm.warm()
  console.log(`warm(2nd): ${ms(tWarm2)} ms`)

  const times = []
  for (let i = 0; i < SAMPLES.length; i++) {
    const text = SAMPLES[i]
    const t0 = performance.now()
    const out = await localLlm.translate(store, text, 'zh-TW', { mode: 'live' })
    const d = ms(t0)
    times.push(d)
    console.log(
      `  [${i + 1}] ${d} ms  "${text.slice(0, 36)}${text.length > 36 ? '…' : ''}" → "${(out || '').slice(0, 40)}"`
    )
  }
  const s = stats(times)
  console.log(
    `translate live: avg=${s.avg} p50=${s.p50} p90=${s.p90} min=${s.min} max=${s.max} ms (n=${s.n})`
  )

  const tLong = performance.now()
  const longOut = await localLlm.translate(store, long, 'zh-TW', { mode: 'file' })
  const longMs = ms(tLong)
  console.log(
    `translate file(~${long.length} chars): ${longMs} ms → "${(longOut || '').slice(0, 50)}…"`
  )

  return { label, warmMs, backend: info.backend, live: s, longMs }
}

async function main() {
  const mode = (process.argv[2] || 'both').toLowerCase()
  const models = require('../src/main/models')
  const localLlm = require('../src/main/local-llm')
  const gpu = require('../src/main/gpu-capability')

  if (!models.LLM_MODEL_KEYS.some((k) => models.isDownloaded(k))) {
    console.error('無本地翻譯模型')
    process.exit(1)
  }

  const Store = (await import('electron-store')).default
  const store = new Store({ name: 'bench-llm-device-tmp' })
  const key = localLlm.resolveLocalTranslateModel({
    get: (k, d) => (k === 'localTranslateModel' ? 'linguaforge08q4' : d)
  })
  store.set('localTranslateModel', key)
  store.set('translator', 'local')
  localLlm.setStore(store)

  const cap = await gpu.detectGpuCapability()
  console.log('GPU capability:', JSON.stringify(cap))
  console.log('model key:', key)

  /** @type {object | null} */
  let cpu = null
  /** @type {object | null} */
  let gpuRes = null

  if (mode === 'cpu' || mode === 'both') {
    store.set('llmGpu', false)
    cpu = await runDevice('CPU', store, localLlm)
  }

  if (mode === 'gpu' || mode === 'both') {
    if (!cap.ok) {
      console.log('SKIP GPU')
    } else {
      // both 模式：盡量不 unload（避免 native crash）；改 intent 後 getSession 會重載
      store.set('llmGpu', true)
      // 強制重載：僅 bump 意圖；若已是 CPU 資源，getSession 會 fingerprint mismatch
      try {
        await localLlm.unload()
      } catch (e) {
        console.warn('unload warn', e.message)
      }
      gpuRes = await runDevice('GPU', store, localLlm)
    }
  }

  console.log('\n======== SUMMARY ========')
  if (cpu) {
    console.log(
      `CPU  warm ${cpu.warmMs} ms | live avg ${cpu.live.avg} ms | long ${cpu.longMs} ms | ${cpu.backend}`
    )
  }
  if (gpuRes) {
    console.log(
      `GPU  warm ${gpuRes.warmMs} ms | live avg ${gpuRes.live.avg} ms | long ${gpuRes.longMs} ms | ${gpuRes.backend}`
    )
    if (cpu) {
      console.log(
        `相對 CPU：live ×${(cpu.live.avg / Math.max(1, gpuRes.live.avg)).toFixed(2)} | long ×${(cpu.longMs / Math.max(1, gpuRes.longMs)).toFixed(2)}`
      )
    }
  }

  process.exit(0)
}

app.whenReady().then(main).catch((e) => {
  console.error(e)
  process.exit(1)
})
