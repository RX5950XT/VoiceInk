/**
 * vad.js 自檢（node 直跑，零依賴）
 *   node scripts/test-vad.js
 *
 * vad.js 是 ESM 而專案 package.json 無 type:module，直接 require 會炸，
 * 沿用 test-markdown.js 的做法：讀原始碼、剝 export、用 vm 執行。
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const src = fs
  .readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'scripts', 'vad.js'), 'utf8')
  .replace(/^export /gm, '')
const sandbox = {}
vm.createContext(sandbox)
vm.runInContext(`${src}\n;globalThis.__createVad = createVad; globalThis.__rms = frameRms;`, sandbox)
const createVad = sandbox.__createVad
const frameRms = sandbox.__rms

// ===== 測試素材（frame = 2048 samples = 128ms @16k，與 renderer 實際用的一致）=====

const SR = 16000
const FRAME = 2048
const FRAME_MS = (FRAME / SR) * 1000

const silentFrame = () => new Float32Array(FRAME)

/** @param {number} amp */
function voiceFrame(amp = 0.2) {
  const f = new Float32Array(FRAME)
  for (let i = 0; i < FRAME; i++) f[i] = Math.sin((2 * Math.PI * 220 * i) / SR) * amp
  return f
}

/**
 * 餵一連串 frame，收集切出的語句
 * @param {ReturnType<createVad>} vad
 * @param {('s'|'v')[]} pattern
 */
function feed(vad, pattern) {
  const out = []
  for (const kind of pattern) {
    const r = vad.push(kind === 'v' ? voiceFrame() : silentFrame())
    if (r.utterance) out.push(r.utterance)
  }
  return out
}

const rep = (kind, n) => Array(n).fill(kind)

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  PASS  ${name}`)
  } catch (e) {
    failed++
    console.log(`  FAIL  ${name}\n        ${e.message}`)
  }
}

// ===== 測試 =====

test('frameRms：靜音 0、正弦波 ≈ amp/√2', () => {
  assert.strictEqual(frameRms(silentFrame()), 0)
  const r = frameRms(voiceFrame(0.2))
  assert.ok(Math.abs(r - 0.2 / Math.SQRT2) < 0.01, `rms=${r}`)
})

test('純靜音不產生任何語句', () => {
  const vad = createVad({ sampleRate: SR })
  assert.strictEqual(feed(vad, rep('s', 50)).length, 0)
  assert.strictEqual(vad.speaking, false)
})

test('語音後停頓 → 切出一句', () => {
  const vad = createVad({ sampleRate: SR })
  const out = feed(vad, [...rep('s', 4), ...rep('v', 8), ...rep('s', 4)])
  assert.strictEqual(out.length, 1, `切出 ${out.length} 句`)
  assert.strictEqual(vad.speaking, false)
})

test('pre-roll：語句開頭補上起音前的音訊（首字不被切掉）', () => {
  const vad = createVad({ sampleRate: SR, preRollMs: 250 })
  const [utt] = feed(vad, [...rep('s', 6), ...rep('v', 8), ...rep('s', 4)])
  // 250ms → 至少 4000 samples 的前導；這段是靜音，用「開頭全 0」驗證它真的被帶上
  const lead = 4000
  assert.ok(utt.length > 8 * FRAME, `語句長度 ${utt.length} 應大於純語音 ${8 * FRAME}`)
  for (let i = 0; i < lead; i++) {
    assert.strictEqual(utt[i], 0, `第 ${i} 個 sample 應為前導靜音`)
  }
  assert.notStrictEqual(utt[lead + FRAME], 0, '前導之後應該是語音')
})

test('太短的爆音被丟棄（pre-roll 與尾端靜音不算進語句長度）', () => {
  const vad = createVad({ sampleRate: SR, minUtteranceMs: 500 })
  // 1 個語音 frame = 128ms < 500ms；若把 pre-roll + hangover 也算進去會誤判成夠長
  const out = feed(vad, [...rep('s', 6), 'v', ...rep('s', 4)])
  assert.strictEqual(out.length, 0, '128ms 的爆音不該成句')
})

test('遲滯：短於 hangover 的停頓不切句', () => {
  const vad = createVad({ sampleRate: SR, hangoverMs: 360 })
  // 2 個靜音 frame = 256ms < 360ms
  const out = feed(vad, [...rep('s', 4), ...rep('v', 5), 's', 's', ...rep('v', 5), ...rep('s', 4)])
  assert.strictEqual(out.length, 1, `應合成一句，實得 ${out.length}`)
})

test('連續講話：到最長長度強制切段，且維持在語音中', () => {
  const vad = createVad({ sampleRate: SR, maxUtteranceMs: 1000 })
  const perCut = Math.ceil((1000 / FRAME_MS))
  const out = feed(vad, [...rep('s', 2), ...rep('v', perCut * 3)])
  assert.ok(out.length >= 2, `連續語音應被切成多段，實得 ${out.length}`)
  assert.strictEqual(vad.speaking, true, '強制切段後應仍在語音中')
  for (const u of out) {
    assert.ok(u.length <= Math.ceil((1000 * SR) / 1000) + FRAME, `段落 ${u.length} 超過上限`)
  }
})

test('強制切段後下一段不含 pre-roll 靜音（不重複送同一段音訊）', () => {
  const vad = createVad({ sampleRate: SR, maxUtteranceMs: 500 })
  const out = feed(vad, [...rep('s', 4), ...rep('v', 20)])
  assert.ok(out.length >= 2)
  // 正弦波起點剛好過零，不能用單一 sample 判斷；改看整段能量
  assert.ok(frameRms(out[1].subarray(0, FRAME)) > 0.1, '第二段開頭應直接是語音')
  // 總長度不得超過輸入（切段之間沒有重疊送出同一段音訊）
  const total = out.reduce((n, u) => n + u.length, 0)
  assert.ok(total <= 24 * FRAME, `切出總長 ${total} 超過輸入 ${24 * FRAME}`)
})

test('reset 清空狀態', () => {
  const vad = createVad({ sampleRate: SR })
  feed(vad, [...rep('s', 2), ...rep('v', 4)])
  assert.strictEqual(vad.speaking, true)
  vad.reset()
  assert.strictEqual(vad.speaking, false)
  assert.strictEqual(feed(vad, rep('s', 10)).length, 0, 'reset 後殘留不該被切出來')
})

test('level 每個 frame 都回傳，供音量條使用', () => {
  const vad = createVad({ sampleRate: SR })
  assert.strictEqual(vad.push(silentFrame()).level, 0)
  assert.ok(vad.push(voiceFrame()).level > 0.1)
})

test('低音量來源（peak 0.02）仍能觸發（門檻按系統音訊調校）', () => {
  const vad = createVad({ sampleRate: SR })
  const quiet = () => {
    const f = new Float32Array(FRAME)
    for (let i = 0; i < FRAME; i++) f[i] = Math.sin((2 * Math.PI * 220 * i) / SR) * 0.02
    return f
  }
  const out = []
  for (const k of [...rep('s', 4), ...rep('q', 8), ...rep('s', 4)]) {
    const r = vad.push(k === 'q' ? quiet() : silentFrame())
    if (r.utterance) out.push(r.utterance)
  }
  assert.strictEqual(out.length, 1, '安靜但可聽的音訊應該要成句')
})

console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILED'}  ${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
