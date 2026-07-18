/**
 * 驗證本輪審計修補（main process 直測）
 * 用法：npx electron scripts/e2e-audit-fixes.js
 */
const { app } = require('electron')
const path = require('path')
const { join } = path

app.whenReady().then(async () => {
  // e2e 時 app 名是 Electron → 指回 voiceink 才能找到模型
  app.setPath('userData', join(app.getPath('appData'), 'voiceink'))

  const localAsr = require('../src/main/local-asr')
  const engine = require('../src/main/engine')
  const models = require('../src/main/models')

  const results = []
  const ok = (name, pass, detail = '') => {
    results.push({ name, pass: !!pass, detail })
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  }

  try {
    // 1) openFolder 路徑白名單
    try {
      await models.openFolder('..\\..\\evil')
      ok('openFolder rejects path traversal', false, 'should have thrown')
    } catch (e) {
      ok('openFolder rejects path traversal', /未知的模型|非法路徑/.test(String(e.message || e)), e.message)
    }

    try {
      await models.openFolder('qwen3asr')
      ok('openFolder allows registry key', true)
    } catch (e) {
      ok('openFolder allows registry key', false, e.message)
    }

    // 2) 無 warm 時 transcribe 不得幽靈重載
    await localAsr.unload()
    const silent = new Float32Array(16000) // 1s silence
    try {
      await localAsr.transcribe({ samples: silent, sampleRate: 16000, lang: 'zh-TW' })
      ok('transcribe without warm throws', false, 'should reject')
    } catch (e) {
      ok(
        'transcribe without warm throws',
        /未載入|已卸載/.test(String(e.message || e)),
        e.message
      )
    }
    ok('asr not loaded after ghost attempt', !localAsr.isLoaded())

    // 3) acquire → transcribe → release 無幽靈
    const warm = await engine.acquire('live', { asr: true, llm: false })
    ok('engine.acquire asr', warm.ok, (warm.warnings || []).join('; '))
    if (warm.ok) {
      const text = await localAsr.transcribe({
        samples: silent,
        sampleRate: 16000,
        lang: 'zh-TW'
      })
      ok('transcribe while held', typeof text === 'string', `textLen=${(text || '').length}`)

      // 並行兩次 transcribe 不應炸（serial lock）
      const [a, b] = await Promise.all([
        localAsr.transcribe({ samples: silent, sampleRate: 16000, lang: 'zh-TW' }),
        localAsr.transcribe({ samples: silent, sampleRate: 16000, lang: 'zh-TW' })
      ])
      ok('parallel transcribe serialised', typeof a === 'string' && typeof b === 'string')

      await engine.release('live')
      ok('after release asr unloaded', !localAsr.isLoaded())

      // release 後再 transcribe 不得重載
      try {
        await localAsr.transcribe({ samples: silent, sampleRate: 16000, lang: 'zh-TW' })
        ok('no ghost reload after release', false)
      } catch (e) {
        ok('no ghost reload after release', /未載入|已卸載/.test(String(e.message || e)), e.message)
      }
      ok('still unloaded', !localAsr.isLoaded())
    }

    // 4) s2twp 不碰日文假名句
    const jaLike = 'これはテストです'
    // 直接測 shouldS2twp 行為：無法 export，改 warm + mock 困難；以模組內部邏輯用英文/中文對照
    // 此處僅確認 transcribe 驗證 sampleRate
    await engine.acquire('file', { asr: true, llm: false })
    try {
      await localAsr.transcribe({ samples: silent, sampleRate: 8000, lang: 'zh-TW' })
      ok('reject bad sampleRate', false)
    } catch (e) {
      ok('reject bad sampleRate', /sampleRate/.test(String(e.message || e)), e.message)
    }
    try {
      await localAsr.transcribe({ samples: new Float32Array(31 * 16000), sampleRate: 16000, lang: 'zh-TW' })
      ok('reject oversize samples', false)
    } catch (e) {
      ok('reject oversize samples', /過長|上限/.test(String(e.message || e)), e.message)
    }
    await engine.release('file')

    // 5) re-acquire failure semantics：先成功再 partial（僅 asr 已載）
    const r1 = await engine.acquire('live', { asr: true, llm: false })
    ok('re-acquire hold asr', r1.ok)
    // 再 acquire 同一 owner 應保持 users.live
    const r2 = await engine.acquire('live', { asr: true, llm: false })
    ok('re-acquire same owner ok', r2.ok && engine.status().users.live === true)
    await engine.release('live')
    // boolean owner：一次 release 即清
    ok('release clears live', engine.status().users.live === false)

  } catch (e) {
    console.error('FATAL', e)
    ok('suite', false, e.message || String(e))
  }

  const failed = results.filter((r) => !r.pass)
  console.log('\n=== summary ===')
  console.log(`total=${results.length} pass=${results.length - failed.length} fail=${failed.length}`)
  if (failed.length) {
    failed.forEach((f) => console.log(' -', f.name, f.detail))
    app.exit(1)
  } else {
    app.exit(0)
  }
})
