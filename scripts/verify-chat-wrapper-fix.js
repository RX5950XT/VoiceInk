/**
 * 修復驗收：node-llama-cpp 內建的 QwenChatWrapper 不會輸出 Qwen3.5 chat template
 * 在 `<|im_start|>assistant\n` 之後固定補的 `<think>\n\n</think>\n\n`（4 token），
 * 而模型是帶著這段前綴訓練／評測的。缺這段就掉出分布 → 標籤前綴、專名消失、年份幻覺。
 *
 * 本檔在「生產路徑」（LlamaChatSession + 現行 promptOptions）上前後對照，
 * 唯一變因是 chatWrapper。指標與 scripts/bench-quant-quality.js 對齊，另加 tag/year。
 *
 * 用法：node scripts/verify-chat-wrapper-fix.js [gguf 路徑]
 */
const path = require('path')
const fs = require('fs')
const { findRepetitionLoop } = require('../src/main/translate-clean')
const { newQwen35ChatWrapper, THINK_PREFIX } = require('../src/main/local-llm')
const { CASES, INSTR, SYSTEM, defects: rawDefects, summarize: rawSummarize } = require('./bench-cases')

const defects = (c, out) => rawDefects(c, out, findRepetitionLoop)
const summarize = (label, outs) => rawSummarize(label, outs, findRepetitionLoop)

const GGUF =
  process.argv[2] ||
  path.join(
    process.env.APPDATA || '',
    'voiceink/models/linguaforge08q4/gguf-v5e/linguaforge-v5e-0.8b-Q4_K_M.gguf'
  )

/** 出貨 DECODE：zh-TW 禁 rep-penalty；en/ja 1.1（與 bench-quant-quality.js 相同） */
function promptOptions(target, text) {
  return {
    maxTokens: Math.min(768, Math.max(64, Math.ceil(text.length * 2))),
    temperature: 0,
    budgets: { thoughtTokens: 0 },
    trimWhitespaceSuffix: true,
    dryRepeatPenalty: { strength: 0.8, base: 1.75, allowedLength: 3 },
    customStopTriggers: ['<|im_end|>', '<|endoftext|>'],
    repeatPenalty:
      target === 'zh-TW' ? false : { penalty: 1.1, lastTokens: 64, penalizeNewLine: false }
  }
}

async function run(llamaMod, model, chatWrapper) {
  const { LlamaChatSession } = llamaMod
  const context = await model.createContext({ contextSize: 2048 })
  const session = new LlamaChatSession({
    contextSequence: context.getSequence(),
    ...(chatWrapper ? { chatWrapper } : {})
  })
  const outs = []
  for (const c of CASES) {
    session.setChatHistory([{ type: 'system', text: SYSTEM }])
    let out = ''
    try {
      out = String(
        await session.prompt(`${INSTR[c.target]}\n${c.text}`, promptOptions(c.target, c.text))
      ).trim()
    } catch (e) {
      console.error(`  ${c.id} 推論失敗:`, e?.message || e)
    }
    outs.push(out)
  }
  return outs
}

/** 門檻（同一組 30 句、同一組指標；出貨 INTEGRATION.md） */
const GATES = [
  ['A_標籤前綴', (s) => s.A_標籤前綴 === 0, '= 0'],
  ['B_拉丁專名保留率', (s) => s.B_拉丁專名保留率 >= 90, '≥ 90%'],
  ['C_憑空年份', (s) => s.C_憑空年份 === 0, '= 0'],
  ['缺陷總數', (s) => s.缺陷總數 < 8, '< 8']
]

async function main() {
  const llamaMod = await import('node-llama-cpp')
  const { getLlama, QwenChatWrapper } = llamaMod

  const llama = await getLlama({ gpu: false, progressLogs: false })
  const model = await llama.loadModel({ modelPath: GGUF })

  // 生產路徑用的 wrapper（src/main/local-llm.js 匯出，避免此處另寫一份）
  const fixed = newQwen35ChatWrapper(QwenChatWrapper)
  const history = [
    { type: 'system', text: SYSTEM },
    { type: 'user', text: `${INSTR['zh-TW']}\n${CASES[3].text}` },
    { type: 'model', response: [] }
  ]
  console.log('=== 送進模型的完整 prompt（修後 / 生產 wrapper）===')
  console.log(JSON.stringify(fixed.generateContextState({ chatHistory: history }).contextText.toString()))
  console.log('think 前綴存在:', String(fixed.generateContextState({ chatHistory: history }).contextText.toString()).endsWith(THINK_PREFIX))

  const before = await run(llamaMod, model, new QwenChatWrapper())
  const after = await run(llamaMod, model, fixed)

  console.log(`模型：${path.basename(GGUF)}`)
  console.log('\n=== 逐句對照（修前 = 內建 Qwen wrapper / 修後 = 補回 think 前綴）===')
  CASES.forEach((c, i) => {
    if (before[i] === after[i]) return
    const dB = defects(c, before[i])
    const dA = defects(c, after[i])
    console.log(`\n--- ${c.id} [${c.target}] ${c.text.replace(/\n/g, ' / ')}`)
    console.log(`  修前: ${before[i].replace(/\n/g, ' / ')}${dB.length ? `   [${dB.join(',')}]` : ''}`)
    console.log(`  修後: ${after[i].replace(/\n/g, ' / ')}${dA.length ? `   [${dA.join(',')}]` : ''}`)
  })

  console.log('\n=== 缺陷統計 ===')
  const sBefore = summarize('修前', before)
  const sAfter = summarize('修後', after)
  console.table([sBefore, sAfter])

  console.log('\n=== 門檻（修後）===')
  let pass = true
  for (const [k, ok, desc] of GATES) {
    const good = ok(sAfter)
    if (!good) pass = false
    console.log(`  ${good ? 'PASS' : 'FAIL'} ${k} ${desc}｜實際 ${sAfter[k]}（修前 ${sBefore[k]}）`)
  }
  console.log(
    `  參考 D_行數遺失 ${sAfter.D_行數遺失}/2 多行句（多行且各行互不相關屬語料缺口，非解碼問題）`
  )
  console.log(pass ? '\nALL GATES PASS' : '\nGATES FAILED')

  const dump = path.join(process.env.TEMP || '.', 'linguaforge-wrapper-fix.json')
  fs.writeFileSync(dump, JSON.stringify({ gguf: GGUF, cases: CASES, before, after }, null, 2), 'utf8')
  console.log(`原始輸出 → ${dump}`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
