/**
 * 語音輸入的純函式測試（node 直跑，不需要 electron）
 *
 *   node scripts/test-dictation.js
 *
 * 涵蓋：字典套用／自動學詞的 diff／字典合併與門檻／prompt 組裝／輸出清理／
 * 貼上前的字元過濾／右 Alt 狀態機（短按切換 vs 長按 push-to-talk）。
 */

const text = require('../src/main/dictation/text')
const hotkey = require('../src/main/dictation/hotkey')
const { createMachine } = hotkey

let passed = 0
let failed = 0

function check(name, cond, extra) {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${extra === undefined ? '' : ` → ${JSON.stringify(extra)}`}`)
  }
}

function section(title) {
  console.log(`\n[${title}]`)
}

// ─── A. 字典套用 ──────────────────────────────────────────────────────────
section('A. 字典套用')
{
  const dict = [
    { from: '克勞德', to: 'Claude', active: true },
    { from: '克勞德扣的', to: 'Claude Code', active: true },
    { from: '沒啟用', to: '不該出現', active: false }
  ]
  const active = text.activeEntries(dict)
  check('停用的詞不列入', active.length === 2)
  check(
    '長的詞先換（短詞不會先吃掉長詞的一半）',
    text.applyDictionary('我在用克勞德扣的寫程式', active) === '我在用Claude Code寫程式',
    text.applyDictionary('我在用克勞德扣的寫程式', active)
  )
  check('沒有字典時原樣回傳', text.applyDictionary('原文', []) === '原文')
  check(
    'from 含 regex 特殊字元也只當純字串',
    text.applyDictionary('a.c', [{ from: '.', to: '-', active: true }]) === 'a-c'
  )
  check('非字串輸入回空字串', text.applyDictionary(null, []) === '')
  // 以前每一條各跑一次 split/join，A→B 之後 B→C 會接力把 A 改成 C
  check(
    '不會接力取代（A→B 的產物不再被 B→C 改一次）',
    text.applyDictionary('你好', [
      { from: '你好', to: '您好', active: true },
      { from: '您好', to: '安安', active: true }
    ]) === '您好',
    text.applyDictionary('你好', [
      { from: '你好', to: '您好', active: true },
      { from: '您好', to: '安安', active: true }
    ])
  )
  check(
    '拉丁詞卡詞界（不吃掉別的字裡面的那一段）',
    text.applyDictionary('MAIL 跟 AI 是兩回事', [{ from: 'AI', to: '人工智慧', active: true }]) ===
      'MAIL 跟 人工智慧 是兩回事'
  )
  check(
    '拉丁詞比對忽略大小寫（ASR 的英文大小寫不穩定）',
    text.applyDictionary('用 claude code 寫', [{ from: 'Claude Code', to: 'Claude Code', active: true }]) ===
      '用 claude code 寫' ||
    text.applyDictionary('用 cloud code 寫', [{ from: 'Cloud Code', to: 'Claude Code', active: true }]) ===
      '用 Claude Code 寫'
  )
  check(
    '中文詞沒有詞界問題（照樣換得到）',
    text.applyDictionary('語音輸入很好用', [{ from: '語音輸入', to: 'VoiceInk', active: true }]) ===
      'VoiceInk很好用'
  )
}

// ─── B. 可入字典的詞 ─────────────────────────────────────────────────────
section('B. 可入字典的詞')
{
  check('中文詞可以', text.isLearnableTerm('語音輸入'))
  check('英文加空白可以', text.isLearnableTerm('Claude Code'))
  check('單字可以', text.isLearnableTerm('A'))
  check('帶標點不行', !text.isLearnableTerm('你好，世界'))
  check('整句不行（超長）', !text.isLearnableTerm('這是一段非常長的句子不應該進字典裡面去'))
  check('空字串不行', !text.isLearnableTerm('   '))
  check('換行不行', !text.isLearnableTerm('a\nb'))
}

// ─── C. 自動學詞 ─────────────────────────────────────────────────────────
section('C. 自動學詞（diff）')
{
  const pairs = text.learnPairs('我今天用克勞德扣的寫程式', '我今天用Claude Code寫程式')
  check('學到專名替換', pairs.some((p) => p.from === '克勞德扣的' && p.to === 'Claude Code'), pairs)

  const noise = text.learnPairs('嗯那個我想說我們今天來做這個功能', '我想我們今天來做這個功能')
  check('純刪贅詞不學成詞對', noise.length === 0, noise)

  const punct = text.learnPairs('好我們開始吧', '好，我們開始吧。')
  check('只是補標點不學', punct.length === 0, punct)

  const identical = text.learnPairs('完全一樣', '完全一樣')
  check('沒有差異就沒有詞對', identical.length === 0)

  const long = text.learnPairs('a'.repeat(500), 'b'.repeat(500))
  check('超長輸入直接放棄學詞', long.length === 0)

  const rewrite = text.learnPairs('然後我就說啊那個東西', '接著我表示那個項目要重做而且要今天完成')
  check('整句改寫不學成一個詞', rewrite.every((p) => p.from.length <= 16 && p.to.length <= 16), rewrite)

  // 字典自己打架的兩種學法
  const dict = [{ from: '扣的', to: 'Code' }]
  const back = text.learnPairs('我用 Code 寫程式', '我用扣的寫程式', dict)
  check('不學反向對（字典已有 A→B 就不學 B→A）', !back.some((p) => p.from === 'Code' && p.to === '扣的'), back)
  const relay = text.learnPairs('我用 Code 寫程式', '我用 Codex 寫程式', dict)
  check('不學接力對（from 正好是別條的 to）', !relay.some((p) => p.from === 'Code'), relay)
  const still = text.learnPairs('我今天用克勞德扣的寫程式', '我今天用Claude Code寫程式', dict)
  check('無關的詞照樣學得到', still.length > 0, still)

  // 反向對除了不學，還要回報成扣分：字典先套過了，模型看到成品又改回去＝那條學錯了
  check(
    '反向對回報成扣分（demote）',
    back.some((p) => p.demote === true && p.from === '扣的' && p.to === 'Code'),
    back
  )
  check('一般學到的詞不帶 demote', still.every((p) => !p.demote), still)

  // 講超過三分鐘的一段話，token 數輕鬆破 400；訂太小就再也學不到詞
  const longDoc = '這是一段測試用的句子。'.repeat(40) + '克勞德扣的很好用'
  const longOut = '這是一段測試用的句子。'.repeat(40) + 'Claude Code很好用'
  check(
    '長文（400 token 以上）照樣學得到',
    text.learnPairs(longDoc, longOut).some((p) => p.to === 'Claude Code'),
    String(text.tokenize(longDoc).length)
  )
}

// ─── C2. 整理輸出的合理性與分段 ─────────────────────────────────────────
section('C2. 整理輸出的合理性與分段')
{
  const src = '嗯那個我想說我們今天先把登入的部分做完然後再看時間'
  check('正常整理過得了', text.looksReasonable('我想我們今天先把登入的部分做完，然後再看時間。', src))
  check('模型回答問題（整段被吃掉）擋下來', !text.looksReasonable('好的，沒問題。', src))
  check('模型加料（膨脹一倍）擋下來', !text.looksReasonable(src + src, src))
  check('空輸出擋下來', !text.looksReasonable('   ', src))
  check('很短的句子加標點不算膨脹', text.looksReasonable('好的。', '好'))

  const long = '這是第一句。'.repeat(60)
  const chunks = text.splitForCleanup(long, 100)
  check('長文有切段', chunks.length > 1, chunks.length)
  check('每段不超過上限太多', chunks.every((c) => c.length <= 100), chunks.map((c) => c.length))
  check('切完接回去不掉字', chunks.join('') === long)
  check('短文不切', text.splitForCleanup('短短一句', 100).length === 1)
  check('空字串回空陣列', text.splitForCleanup('', 100).length === 0)
  const nopunct = text.splitForCleanup('a'.repeat(250), 100)
  check('沒有標點也切得動（硬切）', nopunct.length === 3 && nopunct.every((c) => c.length <= 100))
}

// ─── D. 字典合併與啟用門檻 ───────────────────────────────────────────────
section('D. 字典合併')
{
  const now = 1000
  const first = text.mergeLearned([], [{ from: '扣的', to: 'Code' }], now)
  check('第一次學到還不啟用', first.length === 1 && first[0].active === false && first[0].count === 1)

  const second = text.mergeLearned(first, [{ from: '扣的', to: 'Code' }], now + 1)
  check('第二次就啟用', second[0].active === true && second[0].count === 2)

  const changed = text.mergeLearned(second, [{ from: '扣的', to: 'Cord' }], now + 2)
  check('改成別的寫法要重新觀察', changed[0].to === 'Cord' && changed[0].active === false && changed[0].count === 1)

  const many = text.mergeLearned(
    [],
    Array.from({ length: text.MAX_DICT_ENTRIES + 20 }, (_, i) => ({ from: `詞${i}`, to: `T${i}` })),
    now
  )
  check('超過上限會裁掉', many.length === text.MAX_DICT_ENTRIES)

  const junk = text.mergeLearned([{ from: '', to: 'x' }, { from: 'a', to: 'a' }], [], now)
  check('壞資料讀進來會被丟掉', junk.length === 0)

  // 自我修正：學錯的詞被模型推翻兩次就整條消失，不會永遠掛在那裡把每一句改壞
  const demoted = text.mergeLearned(second, [{ from: '扣的', to: 'Code', demote: true }], now + 3)
  check('被推翻一次就停用', demoted[0].active === false && demoted[0].count === 1, JSON.stringify(demoted))
  const gone = text.mergeLearned(demoted, [{ from: '扣的', to: 'Code', demote: true }], now + 4)
  check('扣到零就整條移除', gone.length === 0, JSON.stringify(gone))

  const manual = text.mergeLearned(
    [{ from: '歐印', to: 'All in', count: 2, active: true, manual: true }],
    [{ from: '歐印', to: 'All in', demote: true }],
    now
  )
  check('手動加的不被扣分', manual[0]?.active === true && manual[0].count === 2, JSON.stringify(manual))

  const other = text.mergeLearned(second, [{ from: '扣的', to: '別的寫法', demote: true }], now + 5)
  check('扣分只認現在真的是那個寫法的那一條', other[0].active === true && other[0].count === 2, JSON.stringify(other))
}

// ─── E. prompt 組裝 ──────────────────────────────────────────────────────
section('E. prompt')
{
  const plain = text.buildSystemPrompt({ lang: 'zh-TW' })
  check('預設是繁體中文（臺灣）', plain.includes('繁體中文（臺灣用語）'))
  check('沒有字典時不出現對照表', !plain.includes('常用詞對照'))
  check('有整理規則', plain.includes('贅詞') && plain.includes('條列'))
  check('有 ASR 錯字修正規則（且守住不重寫的底線）',
    plain.includes('錯別字') && plain.includes('意思不能變'))

  const withDict = text.buildSystemPrompt({
    lang: 'en',
    dictionary: [
      { from: '扣的', to: 'Code', active: true },
      { from: '沒啟用', to: 'x', active: false }
    ]
  })
  check('語言跟著設定走', withDict.includes('English'))
  check('字典寫進 prompt', withDict.includes('扣的 → Code'))
  check('停用的詞不進 prompt', !withDict.includes('沒啟用'))

  const unknown = text.buildSystemPrompt({ lang: 'xx' })
  check('未知語言退回繁中', unknown.includes('繁體中文（臺灣用語）'))

  // 只帶這一段用得到的詞：60 條全帶會吃掉本地那顆 2048 token context 的一大塊
  const scoped = text.buildSystemPrompt({
    dictionary: [
      { from: '扣的', to: 'Code', active: true },
      { from: '歐印', to: 'All in', active: true }
    ],
    text: '我用 Code 寫程式'
  })
  check('只帶這段文字用得到的詞', scoped.includes('扣的 → Code') && !scoped.includes('All in'), scoped.slice(-120))
  check('提醒模型不要把字典換過的詞改回去', scoped.includes('不要改回左邊'))
}

// ─── E2. 長篇重寫模式 ────────────────────────────────────────────────────
section('E2. 長篇重寫模式')
{
  check('短句是保守整理', text.cleanupMode('幫我開啟設定') === 'light')
  check('長篇切到重寫', text.cleanupMode('這是一段話。'.repeat(40)) === 'rewrite')
  check('空字串當短句', text.cleanupMode('') === 'light')
  check('門檻就在 REWRITE_MIN_CHARS 上',
    text.cleanupMode('字'.repeat(text.REWRITE_MIN_CHARS)) === 'rewrite' &&
    text.cleanupMode('字'.repeat(text.REWRITE_MIN_CHARS - 1)) === 'light')

  const light = text.buildSystemPrompt({ mode: 'light' })
  const rewrite = text.buildSystemPrompt({ mode: 'rewrite' })
  check('保守模式守住不重寫整句', light.includes('不要換掉使用者原本的用詞或重寫整句'))
  check('重寫模式放掉那條底線', !rewrite.includes('重寫整句'))
  check('重寫模式要求重新組織與分段', rewrite.includes('重新組織') && rewrite.includes('分段'))
  check('重寫模式仍不准加料', rewrite.includes('不可以自己補上他沒講的內容'))
  check('重寫模式有長篇範例', rewrite.includes('長篇範例'))
  check('保守模式不夾帶長篇那一段', !light.includes('長篇範例') && !light.includes('重新組織'))
}

// ─── F. 輸出清理 ─────────────────────────────────────────────────────────
section('F. 輸出清理')
{
  check(
    'think 區塊剝掉',
    text.cleanupOutput('<think>盤算中</think>整理後的文字', 'raw') === '整理後的文字',
    text.cleanupOutput('<think>盤算中</think>整理後的文字', 'raw')
  )
  check('開場白剝掉', text.cleanupOutput('好的，這是整理後的內容', 'raw') === '這是整理後的內容')
  check('整段引號剝掉', text.cleanupOutput('「今天天氣很好」', 'raw') === '今天天氣很好')
  check(
    '句中的引號留著',
    text.cleanupOutput('他說「好」，然後走了', 'raw') === '他說「好」，然後走了'
  )
  check('空輸出退回原文', text.cleanupOutput('   ', '原本的話') === '原本的話')
  check('只有 think 也退回原文', text.cleanupOutput('<think>只想沒講</think>', '原本的話') === '原本的話')
}

// ─── G. 貼上前的字元過濾 ─────────────────────────────────────────────────
section('G. 貼上前過濾')
{
  const withCtrl = `好${String.fromCharCode(7)}的${String.fromCharCode(0)}`
  check('控制字元剝掉', text.sanitizeInsertText(withCtrl) === '好的', text.sanitizeInsertText(withCtrl))
  check('換行與 Tab 留著', text.sanitizeInsertText('- 一\n- 二\t三') === '- 一\n- 二\t三')
  check('超長截斷',
    text.sanitizeInsertText('字'.repeat(text.MAX_INSERT_CHARS + 100)).length === text.MAX_INSERT_CHARS)
  check('非字串回空', text.sanitizeInsertText(undefined) === '')
}

// ─── G2. 長錄音切段 ──────────────────────────────────────────────────────
// 本地 sherpa 的硬上限是 30 秒，整段送過去只會拿到「音訊過長」而不是文字
section('G2. 長錄音切段')
{
  const rate = 16000
  const short = new Float32Array(rate * 5)
  check('短錄音不切也不複製', text.splitSamples(short, rate)[0] === short)
  check('空的回空陣列', text.splitSamples(new Float32Array(0), rate).length === 0)

  // 3 分鐘：全部靜音（找不到「比較安靜」的地方就照硬邊界切）
  const long = new Float32Array(rate * 180)
  const parts = text.splitSamples(long, rate)
  const total = parts.reduce((n, p) => n + p.length, 0)
  check('切出多段', parts.length >= 9, String(parts.length))
  check('每段都在 ASR 上限（30 秒）之內',
    parts.every((p) => p.length <= rate * 30),
    String(Math.max(...parts.map((p) => p.length)) / rate))
  check('切完長度沒少也沒多', total === long.length, `${total} vs ${long.length}`)

  // 有聲音時要切在安靜處：19 秒起有一段靜音，其餘都是滿幅
  const voiced = new Float32Array(rate * 40).fill(0.5)
  voiced.fill(0, rate * 19, Math.floor(rate * 19.5))
  const cut = text.splitSamples(voiced, rate)[0].length / rate
  check('切點落在安靜的那半秒', cut > 18.9 && cut < 19.6, String(cut))

  check('接回去時中文不補空白', text.joinSegments(['今天天氣', '真好']) === '今天天氣真好')
  check('英文交界補一個空白', text.joinSegments(['hello', 'world']) === 'hello world')
  check('空段落跳過', text.joinSegments(['一', '  ', '二']) === '一二')
}

// ─── H. 右 Alt 狀態機 ────────────────────────────────────────────────────
section('H. 右 Alt 狀態機')
{
  const m = createMachine({ longPressMs: 400 })
  check('按下就開始錄', m.down(0) === 'start')
  check('按住期間的重送 keydown 不再觸發', m.down(50) === null)
  check('按住夠久放開就送出', m.up(600) === 'stop')
  check('放開後不在錄音', !m.isRecording())

  const t = createMachine({ longPressMs: 400 })
  check('短按也是先開始錄', t.down(0) === 'start')
  check('短按放開不停（切換模式）', t.up(100) === null)
  check('切換模式下仍在錄音', t.isRecording())
  check('再按一次不會重複 start', t.down(1000) === null)
  check('再放開才停', t.up(1050) === 'stop')

  const e = createMachine({})
  e.down(0)
  check('錄音中 Esc 取消', e.escape() === 'cancel')
  check('取消後不在錄音', !e.isRecording())
  check('沒在錄音時 Esc 不做事', e.escape() === null)
  check('取消後可以重新開始', e.down(2000) === 'start')

  const u = createMachine({})
  check('沒按下就放開不做事', u.up(10) === null)
}

// 這兩段要 await（原生 sidecar 的啟動是非同步的），包成 async IIFE
void (async () => {
  section('I. 右 Alt 不影響其他程式（uiohook 退路）')
  {
    // 這一段測的是**退路**：沒有原生 sidecar 時走 uiohook，它攔不下按鍵，右 Alt 還是會
    // 送到前景程式；Windows 看到「單獨一顆 Alt 按下又放開」就去啟動選單列（瀏覽器的焦點
    // 會跳到工具列）。補一顆沒人綁的鍵化解它。有 sidecar 時那顆鍵直接被吞掉，不必補。
    const taps = []
    /** @type {any[]} */
    const listeners = { keydown: [], keyup: [] }
    const fake = {
      on: (evt, fn) => listeners[evt].push(fn),
      off: () => {},
      start: () => {},
      stop: () => {},
      keyTap: (key) => taps.push(key)
    }
    const actions = []
    const r = await hotkey.start({
      onAction: (a) => actions.push(a),
      native: false,
      load: () => ({ uIOhook: fake })
    })
    check('熱鍵掛得上', r.ok === true)
    check('走的是 uiohook 退路', hotkey.currentMode() === 'uiohook', hotkey.currentMode())
    listeners.keydown.forEach((fn) => fn({ keycode: hotkey.RIGHT_ALT }))
    check('按下右 Alt 會補一顆無害鍵', taps.length === 1 && taps[0] === hotkey.NEUTRALIZER, String(taps))
    check('還是有開始錄音', actions[0] === 'start', String(actions))
    // 按住時 Windows 會一直重送 keydown，不可以每一次都補
    listeners.keydown.forEach((fn) => fn({ keycode: hotkey.RIGHT_ALT }))
    check('按住重送時不重複補鍵', taps.length === 1 && actions.length === 1, `${taps.length}/${actions.length}`)
    listeners.keydown.forEach((fn) => fn({ keycode: 30 }))
    check('別的鍵不補也不動作', taps.length === 1 && actions.length === 1)
    hotkey.stop()
  }

  // ─── J. 原生 sidecar：熱鍵真的被吞掉 ─────────────────────────────────────
  section('J. 原生熱鍵 sidecar')
  {
    const actions = []
    /** @type {(kind: string) => void} */
    let emit = () => {}
    let stopped = false
    const r = await hotkey.start({
      onAction: (a) => actions.push(a),
      startHook: async (deps) => {
        emit = deps.onEvent
        return { ok: true, stop: () => { stopped = true } }
      }
    })
    check('有 sidecar 就走原生路徑', r.ok === true && r.mode === 'native', String(r.mode))
    check('currentMode 回 native', hotkey.currentMode() === 'native')
    emit('down')
    check('sidecar 的按下事件會開始錄音', actions[0] === 'start', String(actions))
    emit('escape')
    check('Esc 取消', actions[1] === 'cancel', String(actions))
    hotkey.stop()
    check('停止時把 sidecar 收掉', stopped === true)
    check('收掉之後 currentMode 是空的', hotkey.currentMode() === '')

    // 起不來時要退回 uiohook，不是整個功能消失
    const fallback = await hotkey.start({
      onAction: () => {},
      startHook: async () => ({ ok: false, error: 'HOOK_EXE_MISSING' }),
      load: () => ({ uIOhook: { on: () => {}, off: () => {}, start: () => {}, stop: () => {} } })
    })
    check('sidecar 起不來就退回 uiohook', fallback.ok === true && fallback.mode === 'uiohook')
    hotkey.stop()
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
})()
