/**
 * e2e：本地翻譯模型解析 + GPU 能力 +（可選）載入/翻譯
 * 用法：npx electron scripts/e2e-llm-device.js
 */
const path = require('path')
const { app } = require('electron')

// 與正式 app 相同 userData，才能找到已下載模型
app.setPath('userData', path.join(app.getPath('appData'), 'voiceink'))

async function main() {
  const models = require('../src/main/models')
  const gpu = require('../src/main/gpu-capability')
  const localLlm = require('../src/main/local-llm')

  let failed = 0
  const pass = (name) => console.log(`PASS  ${name}`)
  const fail = (name, err) => {
    failed++
    console.error(`FAIL  ${name}:`, err?.message || err)
  }

  // --- registry ---
  try {
    if (!models.isLlmKey('linguaforge08') || !models.isLlmKey('qwen35translate')) {
      throw new Error('isLlmKey')
    }
    if (models.isLlmKey('qwen3asr')) throw new Error('asr 不該是 llm key')
    if (!models.status().models.linguaforge08) throw new Error('linguaforge08 應出現在 status')
    if (!models.ggufRelativePath('linguaforge08')?.endsWith('.gguf')) {
      throw new Error('lingua gguf path')
    }
    if (!models.ggufRelativePath('qwen35translate')?.includes('Qwen3.5')) {
      throw new Error('qwen gguf path')
    }
    pass('models registry + gguf path')
  } catch (e) {
    fail('models registry', e)
  }

  // --- nvidia-smi parse ---
  try {
    const parsed = gpu.parseNvidiaSmi('NVIDIA GeForce RTX 3070 Ti, 8192\nOther GPU, 2048')
    if (!parsed || parsed.vramMiB !== 8192) throw new Error(JSON.stringify(parsed))
    const empty = gpu.parseNvidiaSmi('')
    if (empty) throw new Error('empty should be null')
    pass('parseNvidiaSmi max VRAM')
  } catch (e) {
    fail('parseNvidiaSmi', e)
  }

  // --- GPU capability ---
  let cap
  try {
    cap = await gpu.detectGpuCapability()
    console.log('  gpuCapability:', JSON.stringify(cap))
    if (typeof cap.ok !== 'boolean') throw new Error('shape')
    pass(`detectGpuCapability (ok=${cap.ok})`)
  } catch (e) {
    fail('detectGpuCapability', e)
  }

  // --- resolveLocalTranslateModel fallback ---
  try {
    const mockStore = {
      data: { localTranslateModel: 'linguaforge08' },
      get(k, d) {
        return k in this.data ? this.data[k] : d
      }
    }
    localLlm.setStore(mockStore)
    const key = localLlm.resolveLocalTranslateModel(mockStore)
    // 若 lingua 未下載而 qwen 已下載 → fallback
    const qwenDl = models.isDownloaded('qwen35translate')
    const lingDl = models.isDownloaded('linguaforge08')
    console.log(`  downloaded: qwen=${qwenDl} lingua=${lingDl} resolved=${key}`)
    if (lingDl && key !== 'linguaforge08') throw new Error(`expected lingua, got ${key}`)
    if (!lingDl && qwenDl && key !== 'qwen35translate') throw new Error(`expected qwen, got ${key}`)
    pass('resolveLocalTranslateModel')
  } catch (e) {
    fail('resolveLocalTranslateModel', e)
  }

  // --- 實際載入 + 一句翻譯（有任一模型才測）---
  const anyLlm = models.LLM_MODEL_KEYS.some((k) => models.isDownloaded(k))
  if (!anyLlm) {
    console.log('SKIP  load+translate (no local LLM downloaded)')
  } else {
    try {
      const Store = (await import('electron-store')).default
      const store = new Store({ name: 'e2e-llm-device-tmp' })
      store.set('localTranslateModel', localLlm.resolveLocalTranslateModel({
        get: (k, d) => (k === 'localTranslateModel' ? 'linguaforge08' : d)
      }))
      store.set('llmGpu', false)
      store.set('translator', 'local')
      localLlm.setStore(store)

      const warm = await localLlm.warm()
      if (!warm.ok) throw new Error(warm.warnings?.join('; ') || 'warm failed')
      const info = localLlm.getLoadInfo()
      console.log('  loadInfo CPU:', JSON.stringify(info))
      if (info.backend !== 'cpu') throw new Error(`expected cpu, got ${info.backend}`)

      // 一般句子（LinguaForge 對極短寒暄句可能吐「？」，見 CONTEXT）
      const out = await localLlm.translate(store, 'The weather is nice today, so we went for a walk.', 'zh-TW', { mode: 'file' })
      console.log('  translate:', out)
      if (!out || out.length < 2) throw new Error('empty translation')
      pass('CPU warm + translate')

      // GPU 路徑（能力允許時）
      if (cap?.ok) {
        await localLlm.unload()
        store.set('llmGpu', true)
        const warmG = await localLlm.warm()
        if (!warmG.ok) throw new Error(warmG.warnings?.join('; ') || 'gpu warm failed')
        const infoG = localLlm.getLoadInfo()
        console.log('  loadInfo GPU:', JSON.stringify(infoG))
        // CUDA 失敗會 fallback vulkan/cpu，仍算可接受
        const outG = await localLlm.translate(store, 'She opened the window and listened to the rain.', 'zh-TW', { mode: 'file' })
        console.log('  translate GPU path:', outG)
        if (!outG || outG.length < 2) throw new Error('empty gpu translation')
        if (!infoG.gpu && infoG.backend === 'cpu') {
          console.log('WARN  GPU intent fell back to CPU (driver/binary)')
        }
        pass(`GPU path warm+translate (backend=${infoG.backend})`)
        // 不在 e2e 強制 unload GPU：Windows 上部分 GPU binding 於 exit 前 dispose 可能 AV
      } else {
        console.log('SKIP  GPU path (capability not ok)')
        await localLlm.unload()
        pass('unload')
      }
    } catch (e) {
      fail('load+translate', e)
    }
  }

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
  const code = failed === 0 ? 0 : 1
  // 硬退：避免 GPU native teardown AV 影響 exit code
  process.exit(code)
}

app.whenReady().then(main).catch((e) => {
  console.error(e)
  app.exit(1)
})
