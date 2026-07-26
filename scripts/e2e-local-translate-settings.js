/**
 * e2e：本地翻譯相關設定皆生效，且能真正用本地模型翻譯
 *
 * 覆蓋：
 * - translator=local 走 local 路徑
 * - localTranslateModel：linguaforge08 / qwen35translate（已下載者）
 * - 切換模型後 loadInfo.key 正確
 * - llmGpu=false → backend cpu
 * - llmGpu=true（能力允許）→ intentGpu true，backend cuda|vulkan|cpu-fallback
 * - 實際 translate 英文→繁中，非空、非原樣 echo
 *
 * 用法：npx electron scripts/e2e-local-translate-settings.js
 */
const path = require('path')
const { app } = require('electron')

app.setPath('userData', path.join(app.getPath('appData'), 'voiceink'))

// 實際句子（0.8B 對 "Hello world." 這類極短 greeting 不穩，不納入硬門檻）
const SAMPLES = [
  {
    text: 'The patient should take this medication twice a day.',
    expectNot: 'The patient should take this medication twice a day.'
  },
  { text: 'I will go to school tomorrow.', expectNot: 'I will go to school tomorrow.' },
  { text: 'Good morning, how are you?', expectNot: 'Good morning, how are you?' }
]

function looksLikeChinese(s) {
  return /[\u4e00-\u9fff]/.test(s || '')
}

async function main() {
  await app.whenReady()
  const models = require('../src/main/models')
  const gpu = require('../src/main/gpu-capability')
  const cudaEnv = require('../src/main/cuda-env')
  const localLlm = require('../src/main/local-llm')
  const Store = (await import('electron-store')).default

  try {
    const added = cudaEnv.prependCudaBinToPath()
    if (added.length) console.log('cuda PATH +=', added.join('; '))
  } catch (e) {
    console.warn('cuda PATH prepend failed', e.message || e)
  }

  const store = new Store({
    cwd: path.join(app.getPath('appData'), 'voiceink'),
    name: 'e2e-local-translate-settings-tmp'
  })
  localLlm.setStore(store)

  let failed = 0
  const pass = (name, detail = '') => console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`)
  const fail = (name, err) => {
    failed++
    console.error(`FAIL  ${name}:`, err?.message || err)
  }

  const available = models.LLM_MODEL_KEYS.filter((k) => models.isDownloaded(k))
  console.log('models:', available.join(', ') || '(none)')
  if (available.length === 0) {
    console.error('FAIL  no local LLM downloaded')
    process.exit(1)
  }

  const cap = await gpu.detectGpuCapability()
  console.log('gpuCapability:', JSON.stringify({
    ok: cap.ok,
    name: cap.name,
    vramMiB: cap.vramMiB,
    hasCudaRuntime: cap.hasCudaRuntime,
    backends: cap.backends
  }))

  // --- translator=local 必走本地（不依賴 apiKey）---
  try {
    store.set('translator', 'local')
    store.set('apiKey', '') // 若誤走 cloud 會炸
    store.set('localTranslateModel', available[0])
    store.set('llmGpu', false)
    await localLlm.unload()
    const warm = await localLlm.warm()
    if (!warm.ok) throw new Error(warm.warnings?.join('; ') || 'warm failed')
    const out = await localLlm.translate(
      store,
      'The weather is nice today.',
      'zh-TW',
      { mode: 'file' }
    )
    if (!out || out.length < 1) throw new Error('empty')
    if (out.trim() === 'The weather is nice today.') throw new Error(`echo: ${out}`)
    if (!looksLikeChinese(out)) throw new Error(`no CJK: ${out}`)
    pass('translator=local uses local model', `→ ${out}`)
  } catch (e) {
    fail('translator=local', e)
  }

  // --- 各模型 × CPU ---
  for (const key of available) {
    try {
      store.set('translator', 'local')
      store.set('localTranslateModel', key)
      store.set('llmGpu', false)
      await localLlm.unload()
      const warm = await localLlm.warm()
      if (!warm.ok) throw new Error(warm.warnings?.join('; ') || 'warm failed')

      const info = localLlm.getLoadInfo()
      if (info.key !== key) throw new Error(`load key ${info.key} !== ${key}`)
      if (info.intentGpu) throw new Error('intentGpu should be false')
      if (info.backend !== 'cpu') throw new Error(`backend ${info.backend} !== cpu`)

      const outs = []
      for (const sample of SAMPLES) {
        const out = await localLlm.translate(store, sample.text, 'zh-TW', { mode: 'file' })
        if (!out || out.trim().length < 1) throw new Error(`empty for ${sample.text}`)
        if (out.trim() === sample.expectNot) throw new Error(`echo: ${sample.text} → ${out}`)
        outs.push(out)
      }
      const okZh = outs.some(looksLikeChinese)
      if (!okZh) throw new Error(`no CJK in outputs: ${JSON.stringify(outs)}`)
      pass(
        `model=${key} CPU translate`,
        `backend=${info.backend} outs=${JSON.stringify(outs)}`
      )
    } catch (e) {
      fail(`model=${key} CPU`, e)
    }
  }

  // --- 切換模型：同一 session 內 fingerprint 應重載 ---
  if (available.length >= 2) {
    try {
      const [a, b] = available
      store.set('localTranslateModel', a)
      store.set('llmGpu', false)
      await localLlm.unload()
      let w = await localLlm.warm()
      if (!w.ok) throw new Error(w.warnings?.join('; '))
      if (localLlm.getLoadInfo().key !== a) throw new Error(`want ${a}`)

      store.set('localTranslateModel', b)
      // 不 unload，靠 getSession 指紋切換
      w = await localLlm.warm()
      if (!w.ok) throw new Error(w.warnings?.join('; '))
      if (localLlm.getLoadInfo().key !== b) {
        throw new Error(`after switch load key=${localLlm.getLoadInfo().key} want ${b}`)
      }
      const out = await localLlm.translate(store, 'See you tomorrow.', 'zh-TW', { mode: 'file' })
      if (!out || out.trim() === 'See you tomorrow.') throw new Error(`bad: ${out}`)
      pass(`switch model ${a}→${b}`, `out=${JSON.stringify(out)}`)
    } catch (e) {
      fail('switch model fingerprint', e)
    }
  } else {
    console.log('SKIP  switch model (only one downloaded)')
  }

  // --- GPU 路徑 ---
  if (cap.ok) {
    for (const key of available) {
      try {
        store.set('translator', 'local')
        store.set('localTranslateModel', key)
        store.set('llmGpu', true)
        await localLlm.unload()
        const warm = await localLlm.warm()
        if (!warm.ok) throw new Error(warm.warnings?.join('; ') || 'gpu warm failed')

        const info = localLlm.getLoadInfo()
        if (info.key !== key) throw new Error(`load key ${info.key} !== ${key}`)
        if (!info.intentGpu) throw new Error('intentGpu should be true when llmGpu+cap')
        // 有 Runtime 時優先期望 cuda；否則 vulkan；皆失敗才 cpu
        if (cap.hasCudaRuntime && info.backend !== 'cuda') {
          console.warn(`WARN  expected cuda, got ${info.backend} (still ok if gpu=${info.gpu})`)
        }
        if (!info.gpu && info.backend === 'cpu') {
          console.warn('WARN  GPU intent fell back to CPU')
        }
        const sample = SAMPLES[2]
        const out = await localLlm.translate(store, sample.text, 'zh-TW', { mode: 'file' })
        if (!out || out.trim().length < 1) throw new Error('empty')
        if (out.trim() === sample.expectNot) throw new Error(`echo: ${out}`)
        pass(
          `model=${key} GPU intent translate`,
          `backend=${info.backend} gpu=${info.gpu} out=${JSON.stringify(out)}`
        )
      } catch (e) {
        fail(`model=${key} GPU`, e)
      }
    }

    // llmGpu true 但硬體門檻：模擬 resolveWantGpu 已由 cap.ok 保證
    // 再測 llmGpu false 覆寫：即使剛用過 GPU，關回 CPU 應重載 intentGpu false
    try {
      const key = available[0]
      store.set('localTranslateModel', key)
      store.set('llmGpu', true)
      await localLlm.unload()
      await localLlm.warm()
      if (!localLlm.getLoadInfo().intentGpu) throw new Error('precondition intentGpu')

      store.set('llmGpu', false)
      const w = await localLlm.warm()
      if (!w.ok) throw new Error(w.warnings?.join('; '))
      const info = localLlm.getLoadInfo()
      if (info.intentGpu) throw new Error('intentGpu still true after llmGpu=false')
      if (info.backend !== 'cpu') throw new Error(`backend ${info.backend}`)
      const out = await localLlm.translate(store, 'Open the window.', 'zh-TW', { mode: 'file' })
      if (!out || out.trim() === 'Open the window.') throw new Error(`bad: ${out}`)
      pass('llmGpu true→false reloads CPU', `out=${JSON.stringify(out)}`)
    } catch (e) {
      fail('llmGpu toggle', e)
    }
  } else {
    console.log('SKIP  GPU matrix (capability not ok):', cap.reason || '')
    // llmGpu=true 但 cap 不足時 resolveWantGpu 應為 false
    try {
      store.set('llmGpu', true)
      store.set('localTranslateModel', available[0])
      await localLlm.unload()
      const warm = await localLlm.warm()
      if (!warm.ok) throw new Error(warm.warnings?.join('; '))
      const info = localLlm.getLoadInfo()
      if (info.intentGpu) throw new Error('intentGpu should be false when cap not ok')
      if (info.backend !== 'cpu') throw new Error(`backend ${info.backend}`)
      pass('llmGpu ignored when GPU not capable')
    } catch (e) {
      fail('llmGpu when no GPU', e)
    }
  }

  // --- live mode tokens 路徑也要能譯 ---
  try {
    store.set('translator', 'local')
    store.set('localTranslateModel', available[0])
    store.set('llmGpu', false)
    if (!localLlm.isLoaded() || localLlm.getLoadInfo().key !== available[0]) {
      await localLlm.unload()
      const w = await localLlm.warm()
      if (!w.ok) throw new Error(w.warnings?.join('; '))
    }
    const out = await localLlm.translate(
      store,
      'The weather is nice today.',
      'zh-TW',
      { mode: 'live' }
    )
    if (!out || out.trim() === 'The weather is nice today.') throw new Error(`bad live: ${out}`)
    if (!looksLikeChinese(out)) throw new Error(`no CJK live: ${out}`)
    pass('mode=live translate', `out=${JSON.stringify(out)}`)
  } catch (e) {
    fail('mode=live', e)
  }

  // 不在 GPU 後強制 dispose（Windows AV）；CPU 可卸
  try {
    store.set('llmGpu', false)
    await localLlm.unload()
  } catch { /* ignore */ }

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
