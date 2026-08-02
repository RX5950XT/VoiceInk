/**
 * 對照：Q4_K_M vs f16（同一組實測失敗句、同一 decode 設定）
 * 目的：分離「模型本身能力」與「Q4 量化損傷」——0.8B 對量化特別敏感
 * 用法：npx electron scripts/bench-quant-compare.js <f16.gguf 路徑>
 */
const path = require('path')
const fs = require('fs')
const { app } = require('electron')

app.setPath('userData', path.join(app.getPath('appData'), 'voiceink'))

/** 實測翻壞的句子（含期望特徵，僅供人工判讀） */
const CASES = [
  {
    id: 'JPMorgan 幻覺',
    text: 'JPMorgan/Reuters forecast an August release.',
    note: 'Q4 翻成「美國證券交易委員會（SEC）…」完全無關'
  },
  { id: 'Open weight release', text: 'Open weight release', note: 'Q4：開啟重量釋放' },
  { id: '1T+ total parameters', text: '1T+ total parameters', note: 'Q4：選擇 1T+ 總參數' },
  {
    id: 'Kimi k3 長句',
    text: 'Im predicting it to beat Kimi k3 and maybe be around Sol level or a little less than that as Chinese models are 3-6 months behind the frontier releases.',
    note: 'Q4：Kimi→金智美'
  },
  {
    id: 'agentic coding',
    text: 'Following trends it will have a focus on agentic coding',
    note: 'Q4：說明：此趨勢會將焦點放在程式碼上'
  },
  {
    id: 'bullet 整塊（退化來源）',
    text: '1T+ total parameters\nOpen weight release\nUp to 1M context\nFollowing trends it will have a focus on agentic coding\nThis is also a direct jump from GLM 5.2 to 5.5',
    note: 'Q4：整段退化成「…大模型…」迴圈'
  },
  {
    id: '壓機長句（正常樣本）',
    text: 'This is an 80,000-tonne hydraulic forging press from China’s Northern Heavy Industries, one of the largest metal-forming machines ever built.',
    note: '對照組：Q4 本來就翻得不錯'
  }
]

const SYSTEM = 'You are a professional translator.'
const INSTR = '翻譯成繁體中文：'

async function runModel(llamaMod, modelPath, label) {
  const { getLlama, LlamaChatSession } = llamaMod
  const llama = await getLlama({ gpu: false, progressLogs: false })
  const model = await llama.loadModel({ modelPath })
  const context = await model.createContext({ contextSize: 2048 })
  const session = new LlamaChatSession({ contextSequence: context.getSequence() })

  const outs = []
  for (const c of CASES) {
    session.setChatHistory([{ type: 'system', text: SYSTEM }])
    const maxTokens = Math.min(768, Math.max(64, Math.ceil(c.text.length * 2)))
    const t0 = Date.now()
    const out = await session.prompt(`${INSTR}\n${c.text}`, {
      maxTokens,
      temperature: 0,
      budgets: { thoughtTokens: 0 },
      trimWhitespaceSuffix: true,
      repeatPenalty: false, // 出貨 zhtw 規定
      dryRepeatPenalty: { strength: 0.8, base: 1.75, allowedLength: 3 },
      customStopTriggers: ['<|im_end|>', '<|endoftext|>']
    })
    outs.push({ id: c.id, ms: Date.now() - t0, out: String(out).trim() })
    console.log(`\n[${label}] ${c.id}\n  ${String(out).trim().replace(/\n/g, '\n  ')}`)
  }

  // 刻意不 dispose：Windows 上 dispose llama 資源可能原生崩潰（見 local-llm 註解）
  return outs
}

async function main() {
  const extra = process.argv.filter((a) => a.endsWith('.gguf') && fs.existsSync(a))
  const models = require('../src/main/models')
  const q4Path = path.join(
    models.modelDir('linguaforge08'),
    models.ggufRelativePath('linguaforge08')
  )
  if (!fs.existsSync(q4Path)) {
    console.error('找不到 Q4 模型：' + q4Path)
    process.exit(1)
  }

  const targets = [{ label: 'Q4', modelPath: q4Path }].concat(
    extra.map((p) => ({ label: path.basename(p).replace(/^lf-|\.gguf$/g, ''), modelPath: p }))
  )

  const llamaMod = await import('node-llama-cpp')
  const results = []
  for (const t of targets) {
    console.log(`\n=== ${t.label} ===`)
    results.push({ label: t.label, outs: await runModel(llamaMod, t.modelPath, t.label) })
  }

  console.log('\n\n=== 並列對照 ===')
  for (let i = 0; i < CASES.length; i++) {
    console.log(`\n--- ${CASES[i].id} ---`)
    console.log(`原文 : ${CASES[i].text.replace(/\n/g, ' / ')}`)
    for (const r of results) {
      console.log(`${r.label.padEnd(4)}: ${r.outs[i].out.replace(/\n/g, ' / ')}`)
    }
  }
  process.exit(0)
}

app.whenReady().then(main).catch((e) => {
  console.error(e)
  process.exit(1)
})
