/**
 * e2e：LinguaForge v5e 下載 + 六方向翻譯能力
 * 用法：npx electron scripts/e2e-linguaforge-v5e.js
 *
 * 會：確認 registry 指向 gguf-v5e → 未下載則下載 → warm → 多方向翻譯抽樣
 */
const path = require('path')
const { app } = require('electron')

app.setPath('userData', path.join(app.getPath('appData'), 'voiceink'))

const CASES = [
  // en → zh-TW
  {
    id: 'en→zh-TW',
    text: 'The night market is crowded on weekends.',
    target: 'zh-TW',
    expect: /夜市|週末|周末|人/
  },
  {
    id: 'en→zh-TW medical',
    text: 'The patient should take this medication twice a day.',
    target: 'zh-TW',
    expect: /病|藥|一天|兩次|每日/
  },
  // zh-TW → en
  {
    id: 'zh-TW→en',
    text: '週末的夜市人聲鼎沸。',
    target: 'en',
    expect: /night|market|weekend|crowd/i
  },
  // en → ja
  {
    id: 'en→ja',
    text: 'Please open the window and let some fresh air in.',
    target: 'ja',
    expect: /窓|窓|空気|開け|ください|新鮮/
  },
  // ja → en
  {
    id: 'ja→en',
    text: '週末の夜市はとても賑やかです。',
    target: 'en',
    expect: /night|market|weekend|lively|bustl|crowd/i
  },
  // ja → zh-TW
  {
    id: 'ja→zh-TW',
    text: '週末の夜市はとても賑やかです。',
    target: 'zh-TW',
    expect: /週末|夜市|熱鬧|人/
  },
  // zh-TW → ja
  {
    id: 'zh-TW→ja',
    text: '請把窗戶打開，讓新鮮空氣進來。',
    target: 'ja',
    expect: /窓|空気|開け|ください|新鮮/
  },
  // 一般句子（非極短寒暄）
  {
    id: 'en→zh-TW walk',
    text: 'The weather is nice today, so we went for a walk.',
    target: 'zh-TW',
    expect: /天氣|天氣|散步|今天|好/
  }
]

async function main() {
  const models = require('../src/main/models')
  const localLlm = require('../src/main/local-llm')

  let failed = 0
  const pass = (name, detail = '') =>
    console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`)
  const fail = (name, err) => {
    failed++
    console.error(`FAIL  ${name}:`, err?.message || err)
  }

  // --- registry points at v5e ---
  try {
    const rel = models.ggufRelativePath('linguaforge08')
    if (!rel || !rel.includes('gguf-v5e') || !rel.includes('v5e')) {
      throw new Error(`unexpected gguf path: ${rel}`)
    }
    if (!models.isLlmKey('linguaforge08')) throw new Error('not in whitelist')
    if (!models.status().models.linguaforge08) throw new Error('missing in status')
    pass('registry v5e path', rel)
  } catch (e) {
    fail('registry v5e path', e)
  }

  // --- download if needed ---
  try {
    if (models.isDownloaded('linguaforge08')) {
      pass('already downloaded', models.modelDir('linguaforge08'))
    } else {
      console.log('Downloading linguaforge08 (v5e Q4_K_M)…')
      let lastPct = -1
      const t0 = Date.now()
      await models.download('linguaforge08', ({ receivedBytes, totalBytes }) => {
        const pct = totalBytes ? Math.floor((receivedBytes / totalBytes) * 100) : 0
        if (pct >= lastPct + 10 || pct === 100) {
          lastPct = pct
          console.log(`  download ${pct}%  (${receivedBytes}/${totalBytes})`)
        }
      })
      if (!models.isDownloaded('linguaforge08')) {
        throw new Error('download finished but isDownloaded=false')
      }
      const ms = Date.now() - t0
      pass('download v5e', `${(ms / 1000).toFixed(1)}s`)
    }
  } catch (e) {
    fail('download v5e', e)
    console.error('Abort: cannot test translate without model')
    process.exit(1)
  }

  // --- warm + translate ---
  const store = {
    data: {
      translator: 'local',
      localTranslateModel: 'linguaforge08',
      llmGpu: false
    },
    get(k, d) {
      return k in this.data ? this.data[k] : d
    }
  }
  localLlm.setStore(store)

  try {
    const t0 = Date.now()
    const warm = await localLlm.warm()
    if (!warm?.ok) throw new Error(JSON.stringify(warm))
    const info = localLlm.getLoadInfo()
    if (info.key !== 'linguaforge08') throw new Error(`loaded key=${info.key}`)
    pass('warm linguaforge08', `${Date.now() - t0}ms backend=${info.backend}`)
  } catch (e) {
    fail('warm', e)
    process.exit(1)
  }

  const results = []
  for (const c of CASES) {
    try {
      const t0 = Date.now()
      const out = await localLlm.translate(store, c.text, c.target, { mode: 'file' })
      const ms = Date.now() - t0
      const text = (out || '').trim()
      if (!text) throw new Error('empty output')
      if (text === c.text.trim()) throw new Error(`echoed source: ${text}`)
      if (c.expect && !c.expect.test(text)) {
        throw new Error(`output mismatch expect ${c.expect}: ${text}`)
      }
      // 極短「？」已知問題不應出現在這些句子
      if (text === '？' || text === '?') throw new Error('got bare question mark')
      results.push({ id: c.id, ok: true, ms, out: text })
      pass(`translate ${c.id}`, `${ms}ms → ${text}`)
    } catch (e) {
      results.push({ id: c.id, ok: false, err: e?.message || String(e) })
      fail(`translate ${c.id}`, e)
    }
  }

  console.log('\n=== summary ===')
  console.log(JSON.stringify(results, null, 2))
  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
  // Windows 上 dispose llama 可能原生崩潰，先印結果再 unload
  const code = failed === 0 ? 0 : 1
  try {
    await localLlm.unload()
  } catch {
    /* ignore */
  }
  process.exit(code)
}

app.whenReady().then(main).catch((e) => {
  console.error(e)
  process.exit(1)
})
