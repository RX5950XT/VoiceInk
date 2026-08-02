/**
 * LinguaForge 兩個量化（Q8 預設／Q4 省空間）都是獨立 registry key，
 * 驗證：白名單／status／切換 key 後真的載到對應 GGUF 並走同一套 SFT 格式與 DECODE。
 * 用法：npx electron scripts/e2e-linguaforge-quant.js
 */
const { app } = require('electron')
const path = require('path')

app.setPath('userData', path.join(app.getPath('appData'), 'voiceink'))

const models = require('../src/main/models')
const localLlm = require('../src/main/local-llm')

let failed = 0
const pass = (n, d) => console.log(`PASS  ${n}${d ? ` — ${d}` : ''}`)
const fail = (n, e) => {
  failed++
  console.log(`FAIL  ${n} — ${e?.message || e}`)
}

/** 極簡 store stub（只需 get） */
function makeStore(values) {
  return { get: (k, d) => (k in values ? values[k] : d) }
}

const KEYS = ['linguaforge08', 'linguaforge08q4']

async function main() {
  try {
    const ok = KEYS.every((k) => models.LLM_MODEL_KEYS.includes(k))
    if (!ok) throw new Error(`白名單缺 key: ${models.LLM_MODEL_KEYS.join(',')}`)
    pass('both quant keys in whitelist', models.LLM_MODEL_KEYS.join(','))
  } catch (e) {
    fail('both quant keys in whitelist', e)
  }

  try {
    const st = models.status().models
    const info = KEYS.map((k) => `${k}:${st[k]?.downloaded ? 'downloaded' : 'missing'}`)
    if (!KEYS.every((k) => st[k])) throw new Error('status 缺 key')
    pass('models.status has both', info.join(' '))
  } catch (e) {
    fail('models.status has both', e)
  }

  try {
    const g8 = models.ggufRelativePath('linguaforge08')
    const g4 = models.ggufRelativePath('linguaforge08q4')
    if (!/Q8_0/.test(g8) || !/Q4_K_M/.test(g4)) throw new Error(`${g8} / ${g4}`)
    pass('gguf paths distinct', `${g8} | ${g4}`)
  } catch (e) {
    fail('gguf paths distinct', e)
  }

  // 兩個 key 各自翻譯一次（切換 key 應觸發指紋重載）
  const src = 'Im predicting it to beat Kimi k3 and maybe be around Sol level.'
  for (const key of KEYS) {
    try {
      if (!models.isDownloaded(key)) {
        console.log(`SKIP  translate ${key}（未下載）`)
        continue
      }
      const store = makeStore({ translator: 'local', localTranslateModel: key, llmGpu: false })
      localLlm.setStore(store)
      const resolved = localLlm.resolveLocalTranslateModel(store)
      if (resolved !== key) throw new Error(`resolve 落到 ${resolved}`)
      const out = await localLlm.translate(store, src, 'zh-TW', { mode: 'file' })
      const info = localLlm.getLoadInfo()
      if (info.key !== key) throw new Error(`載入的是 ${info.key}`)
      if (!out || out.trim() === src.trim()) throw new Error(`譯文異常: ${out}`)
      pass(`translate ${key}`, `${out}（Kimi=${out.includes('Kimi')} Sol=${out.includes('Sol')}）`)
    } catch (e) {
      fail(`translate ${key}`, e)
    }
  }

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
  // 跳過 unload 原生崩潰；直接 exit
  process.exit(failed === 0 ? 0 : 1)
}

app.whenReady().then(main).catch((e) => {
  console.error(e)
  process.exit(1)
})
