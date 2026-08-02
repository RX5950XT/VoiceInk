/**
 * e2e：LinguaForge 長文譯文純淨度（不得混入 persona／指令／列點／幻覺標籤）
 * 用法：npx electron scripts/e2e-linguaforge-leak.js
 */
const path = require('path')
const { app } = require('electron')

app.setPath('userData', path.join(app.getPath('appData'), 'voiceink'))

const TEXT = `This is an 80,000-tonne hydraulic forging press from China's Northern Heavy Industries, one of the largest metal-forming machines ever built.

But it is not simply a machine that bends metal like traditional presses do.

At this scale, forging is about changing the internal structure of the material itself, compressing the metal, refining its molecular grain flow and eliminating hidden defects that could cause failure decades later.

Machines like this are used to create some of the most critical components on Earth, aircraft landing gear, titanium aerospace structures, nuclear reactor components, massive gas turbine rotors and ship propulsion shafts.

The metals being forged are among the most advanced engineering materials available, ultra-high-strength steels, titanium alloys and nickel-based superalloys designed to survive extreme temperatures, pressure and millions of fatigue cycles.

An 80,000-tonne press is an industrial ecosystem by itself. The press, hydraulic systems, furnaces, manipulators and supporting infrastructure can require hundreds of millions of dollars in investment, with hydraulic systems requiring tens of megawatts of power to control forces equivalent to thousands of tonnes.

The biggest industrial machines often do not make the final products. They make the materials that make those products possible.`

/** 渲染端分段（generic 600）——與 translate-page.splitForTranslate 同構 */
function splitForTranslate(text, max = 600) {
  const units = String(text || '').split(/(?<=[。．.！!？?…；;\n])/)
  const chunks = []
  let buf = ''
  for (const u of units) {
    if (buf && buf.length + u.length > max) {
      chunks.push(buf)
      buf = ''
    }
    if (u.length > max) {
      for (let i = 0; i < u.length; i += max) chunks.push(u.slice(i, i + max))
      continue
    }
    buf += u
  }
  if (buf) chunks.push(buf)
  return chunks.filter((c) => c.trim())
}

/** 譯文不該出現的污染樣式 */
const BAD = [
  { id: 'persona 譯者/翻譯員標籤', re: /(^|\n)\s*(譯者|翻譯者|翻譯員|譯文|Translator)\s*[：:]/u },
  { id: 'system persona 複誦', re: /professional translator/i },
  { id: 'SFT 指令前綴', re: /(^|\n)\s*翻譯成(繁體中文|英文|日文)[：:]/u },
  { id: '括號式 meta', re: /【(系統|指令|前文|本段)】/u },
  { id: '憑空列點編號', re: /(^|\n)\s*\d+[.、]\s/u },
  { id: '殘留 special token', re: /<\|[a-z_]+\|>/i }
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

  const chunks = splitForTranslate(TEXT)
  console.log(`renderer chunks: ${chunks.length}`)
  const outs = []
  for (const src of chunks) {
    const out = (await localLlm.translate(store, src.trim(), 'zh-TW', { mode: 'file' })).trim()
    outs.push(out)
    console.log(`\n--- chunk (${src.trim().length} 字) ---\n${out}`)
  }

  const joined = outs.join('\n')
  const hits = BAD.filter((b) => b.re.test(joined))
  console.log('\n=== summary ===')
  for (const h of hits) console.error(`FAIL 污染：${h.id}`)
  const ok = hits.length === 0
  console.log(ok ? 'ALL PASS' : `${hits.length} 種污染`)
  try {
    await localLlm.unload()
  } catch {
    /* ignore */
  }
  process.exit(ok ? 0 : 1)
}

app.whenReady().then(main).catch((e) => {
  console.error(e)
  process.exit(1)
})
