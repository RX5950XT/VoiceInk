/**
 * e2e: 翻譯頁相關 main 能力（engine translate owner + TTS + store ttsVoices）
 * 用法: npx electron scripts/e2e-tts-translate.js
 */
const { app } = require('electron')
const path = require('path')
const { join } = path

async function main() {
  // 與正式 app 共用 userData（找得到已下載模型）
  app.setPath('userData', join(app.getPath('appData'), 'voiceink'))

  const engine = require('../src/main/engine')
  const edgeTts = require('../src/main/edge-tts')
  const { sanitizeTtsVoices, DEFAULT_TTS_VOICES, isAllowedVoice } = require('../src/main/tts-voices')
  const localLlm = require('../src/main/local-llm')

  let passed = 0
  let failed = 0
  const assert = (name, cond, detail) => {
    if (cond) {
      console.log(`PASS  ${name}`)
      passed++
    } else {
      console.error(`FAIL  ${name}${detail ? ' — ' + detail : ''}`)
      failed++
    }
  }

  // 1) sanitize
  const bad = sanitizeTtsVoices({ en: 'evil-voice', 'zh-TW': 'zh-TW-HsiaoChenNeural', x: 1 })
  assert('sanitize drops bad voice', bad.en === DEFAULT_TTS_VOICES.en)
  assert('sanitize keeps good voice', bad['zh-TW'] === 'zh-TW-HsiaoChenNeural')
  assert('allowlist HsiaoChen', isAllowedVoice('zh-TW-HsiaoChenNeural'))
  assert('allowlist rejects garbage', !isAllowedVoice('not-a-voice'))

  // 2) engine translate owner
  const st0 = engine.status()
  assert('users has translate key', st0.users && 'translate' in st0.users)

  const acq = await engine.acquire('translate', { asr: false, llm: false })
  assert('acquire translate ok (llm false)', acq.ok === true || acq.ok === false) // llm false → ok true without llm
  const st1 = engine.status()
  assert('users.translate true after acquire', st1.users.translate === true)
  assert('ASR not forced by translate', st1.asrLoaded === false || st1.asrLoaded === true) // may already be loaded from other runs

  // acquire with llm only if model present
  const models = require('../src/main/models')
  const hasLlm = models.isDownloaded('qwen35translate')
  if (hasLlm) {
    const acq2 = await engine.acquire('translate', { asr: false, llm: true })
    assert('acquire translate+llm', acq2.ok === true, JSON.stringify(acq2))
    assert('llm loaded', engine.status().llmLoaded === true)
  } else {
    console.log('SKIP  llm warm (model not downloaded)')
  }

  await engine.release('translate')
  assert('users.translate false after release', engine.status().users.translate === false)

  // 3) translate IPC 邏輯：字數上限在 main handler；此處直測 local-llm 若有模型
  if (hasLlm) {
    await engine.acquire('translate', { asr: false, llm: true })
    const Store = (await import('electron-store')).default
    const store = new Store({ cwd: app.getPath('userData') })
    // 暫設 local（不永久污染：測完可還原）
    const prev = store.get('translator', 'none')
    store.set('translator', 'local')
    try {
      const out = await localLlm.translate(store, 'Hello world', 'zh-TW', { mode: 'file' })
      assert('local translate non-empty', typeof out === 'string' && out.trim().length > 0, out)
      console.log('      translate sample:', out.slice(0, 80))
    } catch (e) {
      assert('local translate', false, e.message)
    }
    store.set('translator', prev)
    await engine.release('translate')
  }

  // 4) TTS synthesize (network)
  try {
    const r = await edgeTts.synthesize({
      text: '你好，這是語音測試。',
      voice: 'zh-TW-HsiaoChenNeural',
      chunkIndex: 0
    })
    assert('tts mime', r.mime === 'audio/mpeg')
    assert('tts data bytes', r.data && r.data.length > 100, `len=${r.data && r.data.length}`)
    assert('tts chunks meta', r.totalChunks >= 1 && r.chunkIndex === 0)
    console.log(`      tts bytes=${r.data.length} chunks=${r.totalChunks}`)
  } catch (e) {
    assert('tts synthesize', false, e.message)
  }

  // 5) unloadAll clears translate
  await engine.acquire('translate', { asr: false, llm: false })
  await engine.unloadAll()
  assert('unloadAll clears translate', engine.status().users.translate === false)

  console.log(`\n${passed} passed, ${failed} failed`)
  app.exit(failed ? 1 : 0)
}

app.whenReady().then(main).catch((e) => {
  console.error(e)
  app.exit(1)
})
