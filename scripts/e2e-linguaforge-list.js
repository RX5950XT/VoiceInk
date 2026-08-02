/**
 * e2e：條列式貼文翻譯（多行／bullet）不得退化重複、不得漏段
 * 用法：npx electron scripts/e2e-linguaforge-list.js
 */
const path = require('path')
const { app } = require('electron')

app.setPath('userData', path.join(app.getPath('appData'), 'voiceink'))

const TEXT = `🧧 GLM 5.5 will launch in August

JPMorgan/Reuters forecast an August release.

Details include:

· 1T+ total parameters
· Open weight release
· Up to 1M context
· Following trends it will have a focus on agentic coding
· This is also a direct jump from GLM 5.2 to 5.5
· Founder Tang Jie teased an "epic" upgrade is coming.

Im predicting it to beat Kimi k3 and maybe be around Sol level or a little less than that as Chinese models are 3-6 months behind the frontier releases.

What are your predictions for GLM 5.5?`

const { findRepetitionLoop } = require('../src/main/translate-clean')

async function main() {
  const localLlm = require('../src/main/local-llm')
  const models = require('../src/main/models')
  if (!models.isDownloaded('linguaforge08')) {
    console.error('FAIL linguaforge08 未下載')
    process.exit(1)
  }

  const store = {
    data: { translator: 'local', localTranslateModel: 'linguaforge08', llmGpu: false },
    get(k, d) {
      return k in this.data ? this.data[k] : d
    }
  }
  localLlm.setStore(store)

  const warm = await localLlm.warm()
  if (!warm?.ok) {
    console.error('FAIL warm', warm)
    process.exit(1)
  }

  const t0 = Date.now()
  const out = (await localLlm.translate(store, TEXT, 'zh-TW', { mode: 'file' })).trim()
  console.log(`\n=== 譯文（${Date.now() - t0}ms）===\n${out}`)

  // 只驗工程層能保證的事：結構、污染、退化；0.8B 的用詞正確性不在此把關
  let failed = 0
  const check = (id, ok) => {
    if (ok) return
    failed++
    console.error(`FAIL ${id}`)
  }

  const loop = findRepetitionLoop(out)
  check(`退化重複片段：「${loop}」`, !loop)

  const lines = out.split('\n').filter((l) => l.trim())
  check(`譯文只有 ${lines.length} 行（原文 11 行），內容遺失`, lines.length >= 10)
  check('條列標記未保留', out.split('\n').filter((l) => l.trim().startsWith('·')).length === 6)
  check('原文專名／數字未保留', /GLM/.test(out) && /1T/.test(out) && /1M/.test(out))

  const BAD = [
    { id: 'persona／輸出標籤混入', re: /(^|\n)\s*(譯者|譯文|說明|問|答|備註|Translator)\s*[：:]/u },
    { id: 'SFT 指令混入', re: /翻譯成(繁體中文|英文|日文)[：:]/u },
    { id: 'special token 殘留', re: /<\|[a-z_]+\|>/i },
    { id: 's2twp 竄改術語（參數→引數）', re: /引數/ }
  ]
  for (const b of BAD) check(`${b.id}`, !b.re.test(out))

  console.log('\n=== summary ===')
  console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`)
  try {
    await localLlm.unload()
  } catch {
    /* ignore */
  }
  process.exit(failed === 0 ? 0 : 1)
}

app.whenReady().then(main).catch((e) => {
  console.error(e)
  process.exit(1)
})
