'use strict'

/**
 * 三個子分頁各自的模型選擇：`node scripts/test-model-scope.js`
 *
 * 純函式，不需要 Electron。守的是「各存各的」這件事真的成立：
 * 一頁改了不會動到另外兩頁、壞值不會靜默指到別人的端點、
 * 舊版的單一全域設定第一次啟動時搬得過來、供應商刪掉之後三組一起收斂。
 */

const assert = require('assert')
const path = require('path')

const scope = require(path.join(__dirname, '..', 'src', 'main', 'model-scope'))

let passed = 0
const failures = []

function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  PASS  ${name}`)
  } catch (err) {
    failures.push(name)
    console.log(`  FAIL  ${name}\n        ${err?.message || err}`)
  }
}

/**
 * 極簡的 store 假物件（get/set/has）
 * @param {Record<string, unknown>} initial
 */
function makeStore(initial = {}) {
  const data = { ...initial }
  return {
    data,
    get: (key, def) => (Object.prototype.hasOwnProperty.call(data, key) ? data[key] : def),
    set: (key, value) => { data[key] = value },
    has: (key) => Object.prototype.hasOwnProperty.call(data, key)
  }
}

const PROVIDERS = [
  { id: 'p1', name: 'A', apiUrl: 'https://a.example/v1', apiKey: 'k1', models: ['m-1', 'ns/m:extended'] },
  { id: 'p2', name: 'B', apiUrl: '', apiKey: '', models: ['m-2'] }
]

/** readLlm 會去 require('./chat') 讀供應商 → 直接把它換成固定清單 */
function stubChat(providers = PROVIDERS) {
  const chatPath = require.resolve(path.join(__dirname, '..', 'src', 'main', 'chat'))
  require.cache[chatPath] = {
    id: chatPath,
    filename: chatPath,
    loaded: true,
    exports: { sanitizeProviders: () => providers }
  }
}
stubChat()

console.log('\n[A] ASR 值的校驗')
check('local + 已知 key 保留', () => {
  assert.strictEqual(scope.sanitizeAsr('local:qwen3asrgpu'), 'local:qwen3asrgpu')
})
check('cloud 保留', () => {
  assert.strictEqual(scope.sanitizeAsr('cloud'), 'cloud')
})
check('未知模型 key 退回預設', () => {
  assert.strictEqual(scope.sanitizeAsr('local:whisper-large'), 'local:qwen3asr')
})
check('非字串／空值退回預設', () => {
  assert.strictEqual(scope.sanitizeAsr(null), 'local:qwen3asr')
  assert.strictEqual(scope.sanitizeAsr(''), 'local:qwen3asr')
  assert.strictEqual(scope.sanitizeAsr({ toString: () => 'cloud' }), 'local:qwen3asr')
})
// 雲端 ASR 一組設定底下可以放好幾顆轉錄模型，所以值也是 `cloud:<設定 id>:<模型 id>`
const ASR_CLOUDS = [
  { id: 'ac1', name: '主要', apiUrl: 'https://x/v1', apiKey: 'k', models: ['whisper-1', 'gpt-4o-transcribe'] }
]
check('cloud 指到存在的設定與模型才保留', () => {
  assert.strictEqual(scope.sanitizeAsr('cloud:ac1:whisper-1', ASR_CLOUDS), 'cloud:ac1:whisper-1')
})
check('模型被刪掉時退回同一組的第一顆（不要整個掉回本地）', () => {
  assert.strictEqual(scope.sanitizeAsr('cloud:ac1:gone', ASR_CLOUDS), 'cloud:ac1:whisper-1')
})
check('整組設定都不在了就退回通用 cloud', () => {
  assert.strictEqual(scope.sanitizeAsr('cloud:nope:m', ASR_CLOUDS), 'cloud')
})
check('舊的通用 cloud 會升級成第一組的第一顆', () => {
  assert.strictEqual(scope.sanitizeAsr('cloud', ASR_CLOUDS), 'cloud:ac1:whisper-1')
})

console.log('\n[B] LLM 值的校驗')
check('local + 已知 key 保留', () => {
  assert.strictEqual(scope.sanitizeLlm('local:qwen354b', PROVIDERS, true), 'local:qwen354b')
})
check('下架的 key 讀成接替者', () => {
  assert.strictEqual(scope.sanitizeLlm('local:linguaforge08', PROVIDERS, true), 'local:linguaforge08q4')
})
check('cloud 指到存在的供應商與模型才保留', () => {
  assert.strictEqual(scope.sanitizeLlm('cloud:p1:m-1', PROVIDERS, true), 'cloud:p1:m-1')
})
check('模型 id 含冒號不會被切壞', () => {
  assert.strictEqual(
    scope.sanitizeLlm('cloud:p1:ns/m:extended', PROVIDERS, true),
    'cloud:p1:ns/m:extended'
  )
})
check('供應商不存在 → 清掉（不可以拿舊 id 去打別人的端點）', () => {
  assert.strictEqual(scope.sanitizeLlm('cloud:gone:m-1', PROVIDERS, true), '')
})
check('模型不在該供應商清單裡 → 清掉', () => {
  assert.strictEqual(scope.sanitizeLlm('cloud:p1:m-2', PROVIDERS, true), '')
})
check('allowOff=false 時空值退回預設本地模型', () => {
  assert.strictEqual(scope.sanitizeLlm('', PROVIDERS, false), 'local:linguaforge08q4')
  assert.strictEqual(scope.sanitizeLlm('cloud:gone:m-1', PROVIDERS, false), 'local:linguaforge08q4')
})
check('只有語音輸入可以「不使用」', () => {
  assert.strictEqual(scope.LLM_OPTIONAL.dictation, true)
  assert.strictEqual(scope.LLM_OPTIONAL.file, false)
  assert.strictEqual(scope.LLM_OPTIONAL.live, false)
})

console.log('\n[C] 三頁各存各的')
check('key 不重疊', () => {
  const keys = [
    ...Object.values(scope.ASR_STORE_KEYS),
    ...Object.values(scope.LLM_STORE_KEYS)
  ]
  assert.strictEqual(new Set(keys).size, 6, keys.join(','))
})
check('改一頁不會動到另外兩頁', () => {
  const store = makeStore({
    fileAsr: 'local:qwen3asr',
    liveAsr: 'local:qwen3asrgpu',
    dictationAsr: 'cloud'
  })
  assert.strictEqual(scope.readAsr(store, 'file').modelKey, 'qwen3asr')
  assert.strictEqual(scope.readAsr(store, 'live').modelKey, 'qwen3asrgpu')
  assert.strictEqual(scope.readAsr(store, 'dictation').engine, 'cloud')
})
check('readLlm 帶出端點（雲端）', () => {
  const store = makeStore({ liveLlm: 'cloud:p1:m-1' })
  const llm = scope.readLlm(store, 'live')
  assert.strictEqual(llm.mode, 'cloud')
  assert.strictEqual(llm.modelId, 'm-1')
  assert.strictEqual(llm.apiUrl, 'https://a.example/v1')
  assert.strictEqual(llm.apiKey, 'k1')
})
check('readLlm 本地只帶 modelKey、不帶端點', () => {
  const store = makeStore({ fileLlm: 'local:qwen35translate' })
  const llm = scope.readLlm(store, 'file')
  assert.strictEqual(llm.mode, 'local')
  assert.strictEqual(llm.modelKey, 'qwen35translate')
  assert.strictEqual(llm.apiKey, '')
})
check('語音輸入沒設整理模型＝off', () => {
  assert.strictEqual(scope.readLlm(makeStore({}), 'dictation').mode, 'off')
})
check('檔案轉錄沒設＝退回本地預設（不是 off）', () => {
  assert.strictEqual(scope.readLlm(makeStore({}), 'file').mode, 'local')
})
check('指到已刪供應商時標 stale（不可無聲退回「不使用」）', () => {
  const gone = scope.readLlm(makeStore({ dictationLlm: 'cloud:gone:m-1' }), 'dictation')
  assert.strictEqual(gone.mode, 'off')
  assert.strictEqual(gone.stale, true)
  // 使用者自己選「不使用」不算 stale
  assert.strictEqual(scope.readLlm(makeStore({ dictationLlm: '' }), 'dictation').stale, false)
  assert.strictEqual(scope.readLlm(makeStore({ dictationLlm: 'cloud:p1:m-1' }), 'dictation').stale, false)
})
check('未知 scope 不會丟例外', () => {
  assert.strictEqual(scope.isScope('translate'), false)
  assert.strictEqual(scope.readAsr(makeStore({}), 'translate').engine, 'local')
})

console.log('\n[D] 舊版單一全域設定的播種')
check('本地 ASR + 本地翻譯', () => {
  const store = makeStore({
    asrEngine: 'local',
    asrModelKey: 'qwen3asrgpu',
    translator: 'local',
    localTranslateModel: 'qwen354b'
  })
  scope.seedFromLegacy(store)
  assert.strictEqual(store.data.fileAsr, 'local:qwen3asrgpu')
  assert.strictEqual(store.data.liveAsr, 'local:qwen3asrgpu')
  assert.strictEqual(store.data.dictationAsr, 'local:qwen3asrgpu')
  assert.strictEqual(store.data.fileLlm, 'local:qwen354b')
  assert.strictEqual(store.data.liveLlm, 'local:qwen354b')
})
check('雲端 ASR + 雲端翻譯', () => {
  const store = makeStore({
    asrEngine: 'cloud',
    translator: 'cloud',
    translateProviderId: 'p1',
    translateModelId: 'm-1'
  })
  scope.seedFromLegacy(store)
  assert.strictEqual(store.data.liveAsr, 'cloud')
  assert.strictEqual(store.data.liveLlm, 'cloud:p1:m-1')
})
check('播種不可以蓋掉語音輸入的「不整理」', () => {
  const store = makeStore({ translator: 'local', localTranslateModel: 'qwen354b' })
  scope.seedFromLegacy(store)
  assert.strictEqual(store.data.dictationLlm, undefined, '空值就是「不整理」，不該被塞東西進去')
})
check('已經自己選過的不會被舊設定蓋掉', () => {
  const store = makeStore({
    fileAsr: 'cloud',
    fileLlm: 'local:qwen354b',
    asrEngine: 'local',
    asrModelKey: 'qwen3asr',
    translator: 'local',
    localTranslateModel: 'linguaforge08q4'
  })
  scope.seedFromLegacy(store)
  assert.strictEqual(store.data.fileAsr, 'cloud')
  assert.strictEqual(store.data.fileLlm, 'local:qwen354b')
})
check('播種可重入（開機跑第二次不會變）', () => {
  const store = makeStore({ asrEngine: 'cloud', translator: 'local', localTranslateModel: 'qwen354b' })
  scope.seedFromLegacy(store)
  const first = JSON.stringify(store.data)
  scope.seedFromLegacy(store)
  assert.strictEqual(JSON.stringify(store.data), first)
})

console.log('\n[E] 供應商被刪掉時三組一起收斂')
check('三個 scope 的雲端選擇都清掉', () => {
  const store = makeStore({
    fileLlm: 'cloud:gone:m-1',
    liveLlm: 'cloud:gone:m-1',
    dictationLlm: 'cloud:gone:m-1'
  })
  scope.reconcileAll(store)
  // 檔案／即時字幕退回本地預設（那兩頁沒有「不翻譯」這個選項），語音輸入變「不整理」
  assert.strictEqual(store.data.fileLlm, 'local:linguaforge08q4')
  assert.strictEqual(store.data.liveLlm, 'local:linguaforge08q4')
  assert.strictEqual(store.data.dictationLlm, '')
})
check('還在的供應商不受影響', () => {
  const store = makeStore({ fileLlm: 'cloud:p1:m-1', liveLlm: 'local:qwen354b', dictationLlm: '' })
  scope.reconcileAll(store)
  assert.strictEqual(store.data.fileLlm, 'cloud:p1:m-1')
  assert.strictEqual(store.data.liveLlm, 'local:qwen354b')
  assert.strictEqual(store.data.dictationLlm, '')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log('failed:', failures.join(', '))
  process.exit(1)
}
