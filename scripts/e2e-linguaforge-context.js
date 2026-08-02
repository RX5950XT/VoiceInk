/**
 * e2e：LinguaForge 長文分段（模擬翻譯頁逐段帶前文）
 * 用法：npx electron scripts/e2e-linguaforge-context.js
 *
 * 驗：各段譯文互不相同（前文注入不得讓模型複誦上一段譯文）
 */
const path = require('path')
const { app } = require('electron')

app.setPath('userData', path.join(app.getPath('appData'), 'voiceink'))

const CHUNKS = [
  "My name's Max, I'm 25, and for the last three years I've been running a small family pig farm — 40 to 60 head depending on the season.",
  'And there were losses. Regularly.',
  'A pig would break through the fence at night and wander off into the woods — not always found.',
  "Piglets got lost in the crowd, and I couldn't always tell who'd already been fed and who hadn't."
]

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

  const outs = []
  let previousSource = ''
  let previousTranslation = ''
  for (const src of CHUNKS) {
    const out = (
      await localLlm.translate(store, src, 'zh-TW', {
        mode: 'file',
        previousSource,
        previousTranslation
      })
    ).trim()
    outs.push(out)
    previousSource = src
    previousTranslation = out
    console.log(`\n[src] ${src}\n[out] ${out}`)
  }

  const dupes = outs.length - new Set(outs).size
  console.log('\n=== summary ===')
  console.log(JSON.stringify({ chunks: outs.length, dupes }, null, 2))
  const code = dupes === 0 ? 0 : 1
  console.log(dupes === 0 ? 'ALL PASS' : `FAIL 重複譯文 ${dupes} 段`)
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
