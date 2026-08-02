/**
 * Q4_K_M vs Q8_0（vs f16）品質量測：30 句對照 + 可自動判定指標
 * 用法：npx electron scripts/bench-quant-quality.js <其他.gguf 路徑…>
 *
 * 樣本與指標共用 scripts/bench-cases.js（verify-chat-wrapper-fix.js 也吃同一份）：
 *   keep   原文專名／數字是否保留在譯文
 *   lines  多行輸入的行數是否保留
 *   loop   是否退化成重複迴圈
 *   echo   是否原樣複誦原文
 *   empty  是否空輸出
 *   len    譯文/原文長度比異常（門檻依語系，見 bench-cases.lengthRatioBounds）
 *   tag    A 類：憑空加上的標籤前綴（說明：／問：／1. ／選擇…）
 *   year   C 類：原文沒有卻生出的四位數年份
 */
const path = require('path')
const fs = require('fs')
const { app } = require('electron')
const { findRepetitionLoop } = require('../src/main/translate-clean')
const { CASES, INSTR, SYSTEM, defects: rawDefects, summarize } = require('./bench-cases')

const defects = (c, out) => rawDefects(c, out, findRepetitionLoop)

app.setPath('userData', path.join(app.getPath('appData'), 'voiceink'))


/**
 * 出貨 DECODE：zhtw 禁 rep-penalty；en/ja 1.1
 * @param {string} target
 * @param {string} text
 */
function promptOptions(target, text) {
  const opts = {
    maxTokens: Math.min(768, Math.max(64, Math.ceil(text.length * 2))),
    temperature: 0,
    budgets: { thoughtTokens: 0 },
    trimWhitespaceSuffix: true,
    dryRepeatPenalty: { strength: 0.8, base: 1.75, allowedLength: 3 },
    customStopTriggers: ['<|im_end|>', '<|endoftext|>'],
    repeatPenalty:
      target === 'zh-TW' ? false : { penalty: 1.1, lastTokens: 64, penalizeNewLine: false }
  }
  return opts
}

async function runModel(llamaMod, modelPath, label) {
  const { getLlama, LlamaChatSession } = llamaMod
  const llama = await getLlama({ gpu: false, progressLogs: false })
  const model = await llama.loadModel({ modelPath })
  const context = await model.createContext({ contextSize: 2048 })
  const session = new LlamaChatSession({ contextSequence: context.getSequence() })

  const outs = []
  let ms = 0
  for (const c of CASES) {
    session.setChatHistory([{ type: 'system', text: SYSTEM }])
    const t0 = Date.now()
    let out = ''
    try {
      out = String(
        await session.prompt(`${INSTR[c.target]}\n${c.text}`, promptOptions(c.target, c.text))
      ).trim()
    } catch (e) {
      out = ''
      console.error(`  [${label}] ${c.id} 推論失敗:`, e?.message || e)
    }
    ms += Date.now() - t0
    outs.push(out)
  }
  console.log(`[${label}] 30 句共 ${(ms / 1000).toFixed(1)}s（平均 ${(ms / CASES.length).toFixed(0)}ms）`)
  // 刻意不 dispose（Windows dispose llama 可能原生崩潰）
  return { outs, ms }
}

async function main() {
  const extra = process.argv.filter((a) => a.endsWith('.gguf') && fs.existsSync(a))
  const models = require('../src/main/models')
  const q4Path = path.join(models.modelDir('linguaforge08'), models.ggufRelativePath('linguaforge08'))
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
    results.push({ label: t.label, ...(await runModel(llamaMod, t.modelPath, t.label)) })
  }

  // 存原始輸出，之後改指標不必重跑推論
  const dump = path.join(process.env.TEMP || '.', 'linguaforge-quant-outs.json')
  fs.writeFileSync(dump, JSON.stringify({ cases: CASES, results }, null, 2), 'utf8')
  console.log(`原始輸出 → ${dump}`)

  console.log('\n=== 缺陷統計（越低越好）===')
  const summary = results.map((r) => ({
    ...summarize(r.label, r.outs, findRepetitionLoop),
    秒: +(r.ms / 1000).toFixed(1)
  }))
  console.table(summary)

  console.log('\n=== 逐句差異（僅列各版本輸出不同者）===')
  for (let i = 0; i < CASES.length; i++) {
    const outs = results.map((r) => r.outs[i])
    if (new Set(outs).size === 1) continue
    console.log(`\n--- ${CASES[i].id} [${CASES[i].target}] ${CASES[i].text.replace(/\n/g, ' / ')}`)
    for (const r of results) {
      const d = defects(CASES[i], r.outs[i])
      console.log(`${r.label.padEnd(4)}: ${r.outs[i].replace(/\n/g, ' / ')}${d.length ? `   ⚠ ${d.join(',')}` : ''}`)
    }
  }
  process.exit(0)
}

app.whenReady().then(main).catch((e) => {
  console.error(e)
  process.exit(1)
})
