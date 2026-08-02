/**
 * 單元測試：translate-clean（純文字模組，不需 electron）
 * 用法：node scripts/test-strip-prompt-leak.js
 */
const { stripThink, stripTranslationNoise } = require('../src/main/translate-clean')

/** [輸入, 期望, 原文（可選，供列點判斷）] */
const cases = [
  ['You are a professional translator.\n週末夜市人潮擁擠。', '週末夜市人潮擁擠。'],
  ['翻譯成繁體中文：\n藥劑應每天服用兩次。', '藥劑應每天服用兩次。'],
  ['翻譯成英文：The night market', 'The night market'],
  ['你是翻譯引擎。\n你好。', '你好。'],
  ['週末夜市人潮擁擠。', '週末夜市人潮擁擠。'],
  ['A. 好的天氣', '好的天氣'],
  ['「翻譯成繁體中文：\n測試」', '測試'],
  ['You are a professional translator.', ''],
  ['<think>x</think>\n翻譯成英文：\nHello', 'Hello'],
  // persona 標籤（實測 LinguaForge 會冒出「譯者：」）
  ['譯者：這是一臺 80,000 噸的壓鑄機。', '這是一臺 80,000 噸的壓鑄機。'],
  ['翻譯員：測試句。', '測試句。'],
  ['Translator: the press is huge.', 'the press is huge.'],
  // 完整引言不可被剝成不對稱標點
  [
    '「最大的工業機器，往往不是製造成品」，陳國生說。',
    '「最大的工業機器，往往不是製造成品」，陳國生說。'
  ],
  // 單側殘引號（模型截斷）仍要剝
  ['「測試句子。', '測試句子。'],
  ['測試句子。」', '測試句子。'],
  // 原文沒列點 → 譯文自編號要剝
  ['1. 第一句。\n2. 第二句。', '第一句。\n第二句。', 'First sentence. Second sentence.'],
  // 原文本來就有列點 → 保留
  ['1. 第一句。\n2. 第二句。', '1. 第一句。\n2. 第二句。', '1. First. \n2. Second.'],
  // 數字開頭的正常句不可被當列點（無換行、非 "N. " 形式）
  ['80,000 噸的壓鑄機。', '80,000 噸的壓鑄機。'],
  ['2025 年開始生產。', '2025 年開始生產。'],
  // 模型自加標籤（原文無冒號才剝）
  ['說明：此趨勢會將焦點放在程式碼上', '此趨勢會將焦點放在程式碼上', 'Following trends it will focus on coding'],
  ['問：您對 GLM 5.5 的預測是什麼？', '您對 GLM 5.5 的預測是什麼？', 'What are your predictions for GLM 5.5?'],
  // 原文本來就有冒號 → 保留（可能是原文的標籤）
  ['說明：詳情包括', '說明：詳情包括', 'Note: details include'],
  // 白名單外的詞不可誤剝（如人名、對話）
  ['小明：你好嗎', '小明：你好嗎', 'Xiaoming asks how are you']
]

let fail = 0
for (const [inp, exp, src = ''] of cases) {
  const out = stripTranslationNoise(stripThink(inp), src)
  const ok = out === exp
  console.log(
    ok ? 'PASS' : 'FAIL',
    JSON.stringify(inp),
    '->',
    JSON.stringify(out),
    ok ? '' : `(want ${JSON.stringify(exp)})`
  )
  if (!ok) fail++
}
console.log(fail === 0 ? 'ALL PASS' : `${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
