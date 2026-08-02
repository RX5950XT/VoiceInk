/**
 * 30 句均衡樣本與客觀缺陷樣式（bench-quant-quality / probe-think-prefix /
 * verify-chat-wrapper-fix 共用；LinguaForge 端對應 scripts/bench_defects.py）。
 * 樣本或門檻要改就改這裡，三支腳本才不會量到不同東西。
 */

/** @type {{id:string,text:string,target:'zh-TW'|'en'|'ja',keep?:string[]}[]} */
const CASES = [
  // ── 專名／數字（量化最容易吃掉的東西）
  { id: 'n1', text: 'JPMorgan/Reuters forecast an August release.', target: 'zh-TW', keep: ['JPMorgan'] },
  { id: 'n2', text: 'Im predicting it to beat Kimi k3 and maybe be around Sol level.', target: 'zh-TW', keep: ['Kimi', 'Sol'] },
  { id: 'n3', text: 'GLM 5.5 will launch in August with 1T+ total parameters.', target: 'zh-TW', keep: ['GLM', '1T'] },
  { id: 'n4', text: 'The NVIDIA H200 has 141GB of HBM3e memory.', target: 'zh-TW', keep: ['NVIDIA', 'H200', '141'] },
  { id: 'n5', text: 'Anthropic released Claude Opus 4.5 on November 24, 2025.', target: 'zh-TW', keep: ['Anthropic', 'Claude'] },
  { id: 'n6', text: 'TSMC will start 2nm mass production in Hsinchu next year.', target: 'zh-TW', keep: ['TSMC', '2nm'] },
  { id: 'n7', text: 'The flight from Taipei to Tokyo takes 3 hours and 20 minutes.', target: 'zh-TW', keep: ['3', '20'] },
  { id: 'n8', text: 'Revenue grew 47% to $1.2 billion in Q3.', target: 'zh-TW', keep: ['47', '1.2'] },
  // ── 一般句（散文）
  { id: 'p1', text: 'This is an 80,000-tonne hydraulic forging press, one of the largest metal-forming machines ever built.', target: 'zh-TW', keep: ['80,000'] },
  { id: 'p2', text: 'At this scale, forging is about changing the internal structure of the material itself.', target: 'zh-TW' },
  { id: 'p3', text: 'A pig would break through the fence at night and wander off into the woods.', target: 'zh-TW' },
  { id: 'p4', text: 'The patient should take this medication twice a day after meals.', target: 'zh-TW' },
  { id: 'p5', text: 'She opened the window and listened to the sound of the rain.', target: 'zh-TW' },
  { id: 'p6', text: 'We could not always tell who had already been fed and who had not.', target: 'zh-TW' },
  // ── 短片語（名詞片語；實測會被加「選擇」前綴）
  { id: 's1', text: 'Open weight release', target: 'zh-TW' },
  { id: 's2', text: 'Up to 1M context', target: 'zh-TW', keep: ['1M'] },
  { id: 's3', text: 'Free shipping on all orders', target: 'zh-TW' },
  { id: 's4', text: 'Battery life: 18 hours', target: 'zh-TW', keep: ['18'] },
  // ── 多行（行數保留）
  { id: 'm1', text: 'Total parameters: 1T+\nOpen weight release\nUp to 1M context', target: 'zh-TW', keep: ['1T', '1M'] },
  { id: 'm2', text: 'First, boil the water.\nSecond, add the noodles.\nThird, wait three minutes.', target: 'zh-TW' },
  // ── 口語／不完整句
  { id: 'c1', text: 'I mean, I went to the night market yesterday and it was packed.', target: 'zh-TW' },
  { id: 'c2', text: 'Sounds small-time, but at an average of $200-300 per adult pig, every loss hurts.', target: 'zh-TW', keep: ['200'] },
  { id: 'c3', text: 'What are your predictions for GLM 5.5?', target: 'zh-TW', keep: ['GLM'] },
  // ── zh-TW → en
  { id: 'e1', text: '週末的夜市人聲鼎沸。', target: 'en' },
  { id: 'e2', text: '請把窗戶打開，讓新鮮空氣進來。', target: 'en' },
  { id: 'e3', text: '台積電明年將在新竹量產 2 奈米製程。', target: 'en', keep: ['2'] },
  { id: 'e4', text: '這台機器重達八萬噸，是全球最大的金屬成形設備之一。', target: 'en' },
  // ── ja
  { id: 'j1', text: '週末の夜市はとても賑やかです。', target: 'zh-TW' },
  { id: 'j2', text: 'The night market is crowded on weekends.', target: 'ja' },
  { id: 'j3', text: '明日は友達と映画を見に行きます。', target: 'en' }
]

const INSTR = { 'zh-TW': '翻譯成繁體中文：', en: '翻譯成英文：', ja: '翻譯成日文：' }
const SYSTEM = 'You are a professional translator.'

/** A 類：模型自行加上、原文沒有的標籤前綴（偵測用，剝除是下游止血不是修復） */
const TAG_PATTERNS = [
  ['label', /^[ \t]*(?:說明|備註|註解|註|注意|提示|問|答|標題|內容|摘要|總結|結論|原文|譯者|譯文|翻譯|Note|Q|A)[：:]/u],
  ['enum', /^[ \t]*\d{1,2}[.、)]\s/u],
  ['figure', /^[ \t]*(?:圖\s*\d*\s*[.號：:]|圖為|照片為|圖片為)/u],
  ['select', /^[ \t]*選擇[：:]?/u],
  ['narrate', /^[ \t]*(?:故事說|據報導|據報道|根據報導|根據報道|報導說|報道稱)/u]
]

/** C 類：四位數年份 */
const YEAR = /(?:19|20)\d{2}/g

const CJK = /[一-鿿぀-ゟ゠-ヿ]/

/**
 * 長度比的合理區間必須看語系：中日文一個字承載的資訊量遠高於一個拉丁字母，
 * 英→中正常就落在 0.2~0.3，用固定的 0.3~3 會把「翻得好」判成缺陷
 * （實測 30 句裡 12 句誤報，佔缺陷總數三分之二，門檻等於量不到東西）。
 * @param {string} src
 * @param {string} out
 */
function lengthRatioBounds(src, out) {
  const srcCjk = CJK.test(src)
  const outCjk = CJK.test(out)
  if (!srcCjk && outCjk) return [0.12, 1.0]   // 拉丁 → CJK
  if (srcCjk && !outCjk) return [1.0, 8.0]    // CJK → 拉丁
  return [0.3, 3.0]                            // 同語系
}

/**
 * 客觀缺陷計數（三支腳本共用；有任何門檻要調就調這裡）
 * @param {typeof CASES[number]} c
 * @param {string} out
 * @param {(s:string)=>unknown} findRepetitionLoop
 */
function defects(c, out, findRepetitionLoop) {
  const bad = []
  if (!out) return ['empty']
  for (const k of c.keep || []) if (!out.includes(k)) bad.push(`keep:${k}`)
  const srcLines = c.text.split('\n').length
  if (srcLines > 1 && out.split('\n').filter((l) => l.trim()).length < srcLines) bad.push('lines')
  if (findRepetitionLoop(out)) bad.push('loop')
  if (out === c.text.trim()) bad.push('echo')
  for (const [name, pat] of TAG_PATTERNS) {
    if (pat.test(out) && !pat.test(c.text)) { bad.push(`tag:${name}`); break }
  }
  const srcYears = new Set(c.text.match(YEAR) || [])
  const ghost = [...new Set(out.match(YEAR) || [])].filter((y) => !srcYears.has(y))
  if (ghost.length) bad.push('year:' + ghost.join(','))
  const ratio = out.length / c.text.length
  const [lo, hi] = lengthRatioBounds(c.text, out)
  if (ratio < lo || ratio > hi) bad.push(`len:${ratio.toFixed(1)}`)
  return bad
}

/**
 * 缺陷彙總。專名保留率只算拉丁字串：`1.2 billion`→「12億」、`80,000`→「8萬」
 * 是正確的在地化，把純數字算進遺失會量到翻譯風格而不是專名保留。
 * @param {string} label
 * @param {string[]} outs
 * @param {(s:string)=>unknown} findRepetitionLoop
 */
function summarize(label, outs, findRepetitionLoop) {
  const all = CASES.map((c, i) => defects(c, outs[i], findRepetitionLoop))
  const latin = (k) => /[A-Za-z]/.test(k)
  let latinTotal = 0
  let latinLost = 0
  CASES.forEach((c, i) => {
    for (const k of (c.keep || []).filter(latin)) {
      latinTotal++
      if (!outs[i].includes(k)) latinLost++
    }
  })
  return {
    label,
    有缺陷句: all.filter((d) => d.length).length,
    缺陷總數: all.reduce((n, d) => n + d.length, 0),
    A_標籤前綴: all.filter((d) => d.some((x) => x.startsWith('tag'))).length,
    B_拉丁專名保留率: +(((latinTotal - latinLost) / latinTotal) * 100).toFixed(1),
    C_憑空年份: all.filter((d) => d.some((x) => x.startsWith('year'))).length,
    D_行數遺失: all.filter((d) => d.includes('lines')).length,
    退化迴圈: all.filter((d) => d.includes('loop')).length,
    長度異常: all.filter((d) => d.some((x) => x.startsWith('len'))).length
  }
}

module.exports = { CASES, INSTR, SYSTEM, TAG_PATTERNS, YEAR, defects, summarize }
