/**
 * hasLinguisticContent 同構邏輯單元測試（不需 Electron / 模型）
 * 用法：node scripts/test-linguistic-gate.js
 */

const MIN = 2

/** @param {string} text */
function hasLinguisticContent(text) {
  return (text || '').replace(/[^\p{L}]/gu, '').length >= MIN
}

/** 舊 guard：只去空白+標點，漏 So/Cf */
function oldGuardPasses(text) {
  return (text || '').replace(/[\s\p{P}]/gu, '').length >= MIN
}

const cases = [
  // 應丟棄（新 gate false）
  { text: '♪♪♪', drop: true, label: 'music notes' },
  { text: '……', drop: true, label: 'ellipsis' },
  { text: '>>', drop: true, label: 'chevrons' },
  { text: '​​', drop: true, label: 'zero-width' }, // U+200B x2
  { text: '  ', drop: true, label: 'nbsp' },
  { text: '3', drop: true, label: 'digit only' },
  { text: '- ...', drop: true, label: 'punct only' },
  { text: '', drop: true, label: 'empty' },
  { text: '   ', drop: true, label: 'spaces' },
  // 應保留（新 gate true）
  { text: 'Hello', drop: false, label: 'english' },
  { text: '你好', drop: false, label: 'chinese 2 chars' },
  { text: 'これは', drop: false, label: 'japanese' },
  { text: '안녕', drop: false, label: 'korean' },
  { text: 'um', drop: false, label: 'filler (known residual)' },
  { text: '[Music]', drop: false, label: 'bracket Music has letters' }
]

let fail = 0
console.log('=== hasLinguisticContent ===')
for (const c of cases) {
  const pass = hasLinguisticContent(c.text)
  const expectPass = !c.drop
  const ok = pass === expectPass
  if (!ok) fail++
  const old = oldGuardPasses(c.text)
  const note = c.drop && old ? ' (old guard would LET THROUGH)' : ''
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${c.label}: ${JSON.stringify(c.text)} → gate=${pass} expect=${expectPass}${note}`
  )
}

// 證明舊 guard 對 ♪ 失效
const musicOld = oldGuardPasses('♪♪♪')
const musicNew = hasLinguisticContent('♪♪♪')
const proof = musicOld === true && musicNew === false
console.log(`\n=== regression proof: ♪♪♪ old=${musicOld} new=${musicNew} ${proof ? 'PASS' : 'FAIL'} ===`)
if (!proof) fail++

console.log(`\nsummary: ${fail === 0 ? 'ALL PASS' : fail + ' FAIL'}`)
process.exit(fail ? 1 : 0)
