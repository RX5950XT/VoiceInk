/**
 * VoiceInk - 語音輸入的文字處理（純函式，無 electron 依賴，可 `node` 直測）
 *
 * 三件事：
 *   1. 個人字典的套用（ASR 出來先做一次直接取代）
 *   2. 從「ASR 原文 vs LLM 整理後」自動學新詞（詞級 diff 取代區塊）
 *   3. 清理器的 prompt 組裝與輸出清理
 *
 * 學詞刻意保守：只認「兩側都是短詞、都沒有標點」的取代，並且要出現兩次才啟用。
 * 學錯一個詞的代價是之後每一句都被改壞，寧可少學。
 */

const { stripThink } = require('../translate-clean')

/** 字典最多留幾筆（超過丟最少用的） */
const MAX_DICT_ENTRIES = 200
/** prompt 裡最多帶幾筆（帶太多會稀釋指令，也吃 token） */
const PROMPT_DICT_LIMIT = 60
/** 一筆字典的來源／目標長度上限（字元） */
const MAX_TERM_CHARS = 16
/**
 * diff 的 token 上限（LCS 是 O(n·m)，長文直接放棄學詞）。
 * 1200 的 dp 表是 1201² 個 uint16 ≈ 2.9MB、140 萬次迴圈，一次口述跑得完；
 * 訂 400 的話講超過三分鐘就再也學不到詞了。
 */
const MAX_DIFF_TOKENS = 1200
/** 學到幾次才真的啟用 */
const PROMOTE_COUNT = 2
/**
 * 超過這個字數就改用「重寫模式」整理（見 `cleanupMode`）。
 * 一句指令（「開啟設定」）重寫只會變成他沒講過的說法；
 * 講了三五分鐘的一段話不重新組織就只是一坨補了標點的逐字稿。
 */
const REWRITE_MIN_CHARS = 180

/** 語言顯示名（給 prompt 用） */
const LANG_NAMES = Object.freeze({
  'zh-TW': '繁體中文（臺灣用語）',
  'zh-CN': '简体中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어'
})

/**
 * 詞級切分：英數字連成一串，其餘（含中日韓文字、標點、空白）各自一個 token。
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  return String(text || '').match(/[A-Za-z0-9_'']+|[\s\S]/g) || []
}

/**
 * 可以進字典的詞：只有文字與數字（允許中間有連字號／點／撇號），不含標點與空白。
 * @param {string} term
 * @returns {boolean}
 */
function isLearnableTerm(term) {
  const t = String(term || '').trim()
  if (!t || t.length > MAX_TERM_CHARS) return false
  return /^[\p{L}\p{N}][\p{L}\p{N}·''\-. ]*[\p{L}\p{N}]$|^[\p{L}\p{N}]$/u.test(t)
}

/** 純拉丁詞（英文縮寫、程式碼識別字）：比對要看詞界，中日韓文字沒有詞界可言 */
const LATIN_TERM = /^[A-Za-z0-9][A-Za-z0-9'\-. ]*$/
/** 詞界：拉丁詞的左右不可以再接字母或數字 */
const LATIN_CHAR = /[A-Za-z0-9]/

/**
 * `from` 在 `text` 的 `at` 位置算不算一次合法命中。
 * 拉丁詞要卡詞界（`cloud` 不可以吃掉 `clouds`），中日韓詞直接命中。
 * @param {string} text
 * @param {string} from
 * @param {number} at
 * @returns {boolean}
 */
function hitsAt(text, from, at) {
  if (!LATIN_TERM.test(from)) return true
  const before = at > 0 ? text[at - 1] : ''
  const after = at + from.length < text.length ? text[at + from.length] : ''
  return !LATIN_CHAR.test(before) && !LATIN_CHAR.test(after)
}

/**
 * 把個人字典套到 ASR 原文上（純字串比對，不進 regex）。
 *
 * **單趟掃描，換過的位置不再參與後續比對**：以前是每一條各跑一次 `split/join`，
 * 字典裡同時有 `A→B` 與 `B→C` 時，A 會被接力改成 C（使用者只交代了兩件事，
 * 卻拿到第三種結果）。長的詞先試，短詞才不會先吃掉長詞的一部分。
 *
 * 拉丁詞另外卡詞界（`AI→人工智慧` 不該把 `MAIL` 改成 `M人工智慧L`），
 * 而且比對時忽略大小寫——ASR 吐出來的英文大小寫本來就不穩定。
 *
 * @param {string} text
 * @param {Array<{ from: string, to: string }>} entries
 * @returns {string}
 */
function applyDictionary(text, entries) {
  const input = String(text || '')
  if (!input) return input
  const list = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && typeof e.from === 'string' && typeof e.to === 'string' && e.from && e.from !== e.to)
    .sort((a, b) => b.from.length - a.from.length)
  if (!list.length) return input

  const lower = input.toLowerCase()
  let out = ''
  let i = 0
  while (i < input.length) {
    let matched = null
    for (const entry of list) {
      const from = LATIN_TERM.test(entry.from) ? entry.from.toLowerCase() : entry.from
      const hay = LATIN_TERM.test(entry.from) ? lower : input
      if (hay.startsWith(from, i) && hitsAt(input, entry.from, i)) {
        matched = entry
        break
      }
    }
    if (matched) {
      out += matched.to
      i += matched.from.length
    } else {
      out += input[i]
      i++
    }
  }
  return out
}

/**
 * 兩串 token 的 LCS 差異，合併成 keep / replace 區塊。
 * @param {string[]} a
 * @param {string[]} b
 * @returns {Array<{ from: string[], to: string[] }>} 只回取代區塊（純刪除或純插入的 from／to 會是空陣列）
 */
function diffBlocks(a, b) {
  const n = a.length
  const m = b.length
  // dp[i][j] = a[i..] 與 b[j..] 的 LCS 長度
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const blocks = []
  let pending = null
  let i = 0
  let j = 0
  const flush = () => {
    if (pending) blocks.push(pending)
    pending = null
  }
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      flush()
      i++
      j++
      continue
    }
    if (!pending) pending = { from: [], to: [] }
    if (dp[i + 1][j] >= dp[i][j + 1]) pending.from.push(a[i++])
    else pending.to.push(b[j++])
  }
  if (i < n || j < m) {
    if (!pending) pending = { from: [], to: [] }
    while (i < n) pending.from.push(a[i++])
    while (j < m) pending.to.push(b[j++])
  }
  flush()
  return blocks
}

/**
 * 從「ASR 原文 → 整理後文字」學出候選詞對。
 *
 * 只認雙邊都是短詞、都沒有標點的取代；長度差太多（例如刪掉一整句贅詞）不算學詞。
 *
 * `dict` 給了就多擋兩種會讓字典自己打架的學法（兩種都會在每一句上來回改）：
 *   - **反向對**：字典已有 `A→B`，這次卻學到 `B→A`
 *   - **接力對**：這次的 `from` 正好是別條的 `to`（`A→B` 之後再學 `B→C`＝A 被改成 C）
 * 單趟掃描的 `applyDictionary` 擋得住接力的**執行**，但擋不住它被學進來——
 * 學進來就會變成「這一句照 A→B、下一句照 B→C」，看起來像模型隨機。
 *
 * 反向對除了不學，還要**回報**（`demote: true`）：字典先套過了，整理模型看到成品又把它
 * 改回去，代表那一條多半當初就學錯。只是忽略的話，學錯的詞會永遠掛在那裡把每一句改壞，
 * 而使用者根本不知道是字典幹的。
 *
 * @param {string} raw ASR 原文
 * @param {string} cleaned LLM 整理後
 * @param {Array<{ from: string, to: string }>} [dict] 現有字典（含未啟用的）
 * @returns {Array<{ from: string, to: string, demote?: boolean }>}
 */
function learnPairs(raw, cleaned, dict = []) {
  const a = tokenize(raw)
  const b = tokenize(cleaned)
  if (!a.length || !b.length || a.length > MAX_DIFF_TOKENS || b.length > MAX_DIFF_TOKENS) return []

  const existing = (Array.isArray(dict) ? dict : []).filter((e) => e?.from && e?.to)
  const targets = new Set(existing.map((e) => e.to))
  const reverse = new Set(existing.map((e) => `${e.to}\u0000${e.from}`))

  const pairs = []
  for (const block of diffBlocks(a, b)) {
    const from = block.from.join('').trim()
    const to = block.to.join('').trim()
    if (!from || !to || from === to) continue
    if (!isLearnableTerm(from) || !isLearnableTerm(to)) continue
    // 字典有 `to → from`，套過之後模型又把它改回去：那一條被推翻了一次
    if (reverse.has(`${from}\u0000${to}`)) {
      pairs.push({ from: to, to: from, demote: true })
      continue
    }
    // 長度差太多多半是「整句改寫」而不是「同一個詞的寫法不同」
    if (Math.abs(from.length - to.length) > Math.max(from.length, to.length)) continue
    if (targets.has(from)) continue
    pairs.push({ from, to })
  }
  return pairs
}

/**
 * 把新學到的詞對併進字典：先累計次數，到門檻才啟用。
 *
 * `demote: true` 的詞對是**反向證據**（字典換過的詞被整理模型改了回去）：扣一次，
 * 扣回門檻以下就停用，扣到零就整條移除。學錯的詞才有機會自己退場——沒有這一條的話，
 * 它會永遠掛在那裡把每一句改壞，而使用者不會知道是字典幹的。
 * **手動加的（`manual`）不扣**：使用者自己打的比模型的意見權威。
 *
 * @param {Array<{ from: string, to: string, count?: number, active?: boolean, manual?: boolean, at?: number }>} dict
 * @param {Array<{ from: string, to: string, demote?: boolean }>} pairs
 * @param {number} now 時間戳（呼叫端給，純函式不自己取時間）
 * @returns {Array<{ from: string, to: string, count: number, active: boolean, manual: boolean, at: number }>}
 */
function mergeLearned(dict, pairs, now) {
  const list = (Array.isArray(dict) ? dict : []).map((e) => ({
    from: String(e?.from || ''),
    to: String(e?.to || ''),
    count: Number.isFinite(e?.count) ? Number(e.count) : 1,
    active: e?.active === true,
    manual: e?.manual === true,
    at: Number.isFinite(e?.at) ? Number(e.at) : now
  })).filter((e) => e.from && e.to && e.from !== e.to)

  for (const pair of Array.isArray(pairs) ? pairs : []) {
    if (!pair?.from || !pair?.to || pair.from === pair.to) continue
    const found = list.find((e) => e.from === pair.from)
    if (pair.demote) {
      // 只扣「現在真的是這個寫法」的那一條，而且不動使用者手動加的
      if (found && !found.manual && found.to === pair.to) {
        found.count -= 1
        found.at = now
        if (found.count < PROMOTE_COUNT) found.active = false
      }
      continue
    }
    if (found) {
      // 同一個聽錯的詞後來被改成別的寫法：以最新的為準，次數重新算
      if (found.to !== pair.to) {
        found.to = pair.to
        found.count = 1
        found.active = false
      } else {
        found.count += 1
      }
      found.at = now
      if (found.count >= PROMOTE_COUNT) found.active = true
    } else {
      list.push({ from: pair.from, to: pair.to, count: 1, active: PROMOTE_COUNT <= 1, manual: false, at: now })
    }
  }

  // 被扣到零的整條移除（學錯的詞退場），其餘超過上限先丟「次數少而且久沒用到」的
  const kept = list.filter((e) => e.count > 0)
  kept.sort((a, b) => (b.count - a.count) || (b.at - a.at))
  return kept.slice(0, MAX_DICT_ENTRIES)
}

/**
 * 只有啟用中的詞才會拿去取代／餵給 prompt
 * @param {Array<{ from: string, to: string, active?: boolean }>} dict
 */
function activeEntries(dict) {
  return (Array.isArray(dict) ? dict : []).filter((e) => e?.active === true && e.from && e.to)
}

/**
 * 這一段要用哪一種整理法。長度是唯一的判準：一句指令重寫只會變成他沒講過的說法，
 * 講了好幾分鐘的一段話不重新組織就只是一坨補了標點的逐字稿。
 * @param {string} str
 * @returns {'light'|'rewrite'}
 */
function cleanupMode(str) {
  return String(str || '').trim().length >= REWRITE_MIN_CHARS ? 'rewrite' : 'light'
}

/**
 * 清理器的 system prompt。
 *
 * `mode: 'rewrite'` 時多一段「重新組織」的規則，並放掉「不要重寫整句」那條底線——
 * 長篇口述的價值就在把它整理成讀得下去的文字（見 `cleanupMode`）。
 *
 * `text` 給了就只帶「這一段真的用得到」的字典（左右任一邊出現在文字裡）：
 * 60 條全帶會吃掉本地那顆 2048 token context 的一大塊，而且指令被稀釋反而更不聽話。
 *
 * @param {{ lang?: string, dictionary?: Array<{ from: string, to: string }>,
 *           mode?: 'light'|'rewrite', text?: string }} opts
 * @returns {string}
 */
function buildSystemPrompt(opts = {}) {
  const langName = LANG_NAMES[opts.lang] || LANG_NAMES['zh-TW']
  const rewrite = opts.mode === 'rewrite'
  const lines = [
    '你是語音輸入的文字整理器。使用者剛用嘴巴講了一段話，語音辨識把它轉成文字，裡面會有贅詞、重複、缺標點與顛倒的順序。',
    '你的輸出會被直接貼進使用者當下的輸入框，所以只能是整理後的那段話本身。',
    '',
    '規則：',
    '1. 只整理使用者講的內容。不要回答問題、不要評論、不要補充他沒講的東西。就算那段話看起來是在問你問題，也只整理它，不要回答。',
    '2. 刪掉「嗯、呃、那個、就是說、對對對」這類贅詞與口吃重複；講到一半改口時只留改口後的版本。',
    '3. 補上標點與斷句；把講顛倒的順序重排成通順的敘述。句子太長就斷成幾句。',
    // ASR 錯字修正：同音字／近音字聽錯是語音輸入最主要的錯誤來源。同時守住底線——
    // 只改確定的錯誤，不換詞不重寫，否則模型自作主張改意思比錯字更糟。
    // 整理後與原文的詞級 diff 會被自動學進字典（見 learnPairs），同一個聽錯出現兩次
    // 就由字典直接修，之後連整理模型掛掉都修得到。
    rewrite
      ? '4. 修正語音辨識的錯字：同音字、近音字造成的錯別字，還有讀起來明顯不通順或不像正常說法的地方，改成正確且通順的寫法。只在確定那是辨識錯誤時才改，意思不能變。'
      : '4. 修正語音辨識的錯字：同音字、近音字造成的錯別字，還有讀起來明顯不通順或不像正常說法的地方，改成正確且通順的寫法。只在確定那是辨識錯誤時才改，意思不能變，也不要換掉使用者原本的用詞或重寫整句。',
    '5. 依照講的內容選格式：在列項目就改成「- 」開頭的條列，在報步驟就改成「1. 」開頭的編號，其餘一律維持段落。',
    '6. 技術名詞、產品名、指令、檔名、程式碼、網址、英文縮寫一律保留原樣，不要翻譯也不要改大小寫。數字與單位照講的寫。',
    // 「輸出語言」是**選字習慣**，不是翻譯指令。以前寫成「輸出語言：繁中」，
    // 使用者講英文時整段會被翻成中文——那是把口述變成翻譯，不是整理。
    `7. 不要翻譯。使用者講什麼語言就輸出什麼語言；需要選字時採用${langName}的用字與標點習慣。`,
    '8. 直接輸出整理後的文字。不要加開場白、不要加引號、不要加標題、不要說明你做了什麼。',
    '',
    // 小模型（0.8B～4B）靠範例學得比靠規則快很多，而這一條管線的本地選項就是小模型
    '範例：',
    '輸入：嗯那個 我想說 我們今天 呃 先把那個登入的部分做完 然後再看時間',
    '輸出：我想我們今天先把登入的部分做完，然後再看時間。',
    '輸入：幫我看一下這個 bug 是不是 cache 沒清乾淨造成的',
    '輸出：幫我看一下這個 bug 是不是 cache 沒清乾淨造成的。'
  ]

  // 長篇：口述講到哪算哪，同一件事會分好幾次講、想到才補充。只補標點的話，
  // 使用者拿到的是一坨沒人讀得下去的逐字稿——這一段就是「整理」跟「加標點」的差別。
  if (rewrite) {
    lines.push(
      '',
      '這段話比較長，除了上面的規則，還要把它重新組織成讀得下去的文字：',
      'A. 同一件事分好幾次講、或講完又回頭補充的，合併成一句，並放回它該在的位置。',
      'B. 可以換句話說：把口語的說法改成寫出來會用的說法，讀起來要像寫的、不像講的。',
      'C. 但資訊只能少不能多——少掉的只能是重複與贅詞，不可以自己補上他沒講的內容、結論或建議。',
      'D. 依主題分段，段落之間空一行；同一個主題不要拆開。',
      '',
      '長篇範例：',
      '輸入：那個我們今天先講一下進度啊 就是那個登入 登入的部分做完了 然後嗯 註冊還沒 註冊那邊卡在簡訊驗證 對 然後我剛剛想到登入那邊還有一個 記住我 的功能沒做',
      '輸出：今天先講進度。登入的部分做完了，但「記住我」的功能還沒做。\n\n註冊還沒完成，卡在簡訊驗證。'
    )
  }

  // 字典已經在送進來之前就套過了，所以文字裡出現的是右邊那個寫法。
  // 帶進 prompt 的目的除了「還沒換到的地方也照著寫」，更重要的是**別給它改回去**。
  const source = typeof opts.text === 'string' ? opts.text : ''
  const all = activeEntries(opts.dictionary)
  const relevant = source ? all.filter((e) => source.includes(e.to) || source.includes(e.from)) : all
  const dict = relevant.slice(0, PROMPT_DICT_LIMIT)
  if (dict.length) {
    lines.push(
      '',
      '使用者的常用詞對照（辨識結果若是左邊那樣就寫成右邊；已經是右邊的不要改回左邊）：',
      dict.map((e) => `${e.from} → ${e.to}`).join('\n')
    )
  }
  return lines.join('\n')
}

/**
 * 整理後的文字合不合理。**不合理就退回原文**——模型自作主張回答問題、加了一段前言、
 * 或整段複誦成迴圈時，長度會明顯偏離原文，而使用者只會看到一段他沒講過的話被貼進去。
 *
 * 只擋「長度離譜」這一種：判斷語意對不對需要另一顆模型，而長度是免費又抓得到
 * 最常見那幾種壞掉方式的指標。
 *
 * @param {string} cleaned
 * @param {string} source 送進模型的原文
 * @returns {boolean}
 */
function looksReasonable(cleaned, source) {
  const out = String(cleaned || '').trim()
  const src = String(source || '').trim()
  if (!out) return false
  // 很短的句子加標點就可能長一截（「好」→「好的。」），比例對它沒有意義
  if (src.length < 12) return out.length <= src.length + 20
  // 整理只會變短或差不多；膨脹一半以上＝模型加料了
  if (out.length > src.length * 1.5) return false
  // 只剩三成＝模型把內容吃掉了（常見於它把整段當成問題來回答「好的」）
  return out.length >= src.length * 0.3
}

/**
 * 依標點把長文切成模型吃得下的段。切點只找句末標點，找不到就硬切。
 *
 * 本地那顆的 context 只有 2048 token，system prompt 加上字典就佔掉一半；
 * 整段送過去會被無聲截掉後半段（看起來像「講的話少了一截」）。
 *
 * @param {string} text
 * @param {number} maxChars
 * @returns {string[]}
 */
function splitForCleanup(text, maxChars) {
  const input = String(text || '').trim()
  const max = Number(maxChars) > 0 ? Math.floor(Number(maxChars)) : 600
  if (!input) return []
  if (input.length <= max) return [input]
  /** @type {string[]} */
  const out = []
  let rest = input
  while (rest.length > max) {
    const head = rest.slice(0, max)
    // 從段尾往回找最後一個句末標點；找不到就整段硬切
    const cut = Math.max(
      head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'),
      head.lastIndexOf('\n'), head.lastIndexOf('. '), head.lastIndexOf('，')
    )
    const at = cut > max * 0.3 ? cut + 1 : max
    out.push(rest.slice(0, at).trim())
    rest = rest.slice(at).trim()
  }
  if (rest) out.push(rest)
  return out.filter(Boolean)
}

/**
 * 模型偶爾會加的開場白。
 * 兩條都要求「後面接標點」才剝——「整理後的文字」本身可能就是使用者講的話，
 * 只比對開頭那幾個字會把正常內容吃掉。
 */
const PREAMBLES = Object.freeze([
  /^(?:好的|當然|沒問題)[，,、：:]\s*/u,
  /^(?:以下是|這是)[^\n：:]{0,14}[：:]\s*/u
])

/**
 * 清理 LLM 輸出：剝 think 區塊、開場白與整段包裹的引號。
 * 清完是空的就回原文——寧可給沒整理過的字，也不要給空白。
 * @param {string} raw
 * @param {string} fallback ASR 原文
 * @returns {string}
 */
function cleanupOutput(raw, fallback) {
  let out = stripThink(String(raw || '')).trim()
  if (!out) return String(fallback || '').trim()
  for (const re of PREAMBLES) {
    const stripped = out.replace(re, '').trim()
    // 剝完變空的代表那句開場白就是全部內容，留著比較好
    if (stripped && stripped !== out) {
      out = stripped
      break
    }
  }
  // 整段被引號包起來（單側殘留不處理：那多半是使用者自己講的引言）
  const pairs = [['「', '」'], ['“', '”'], ['"', '"'], ["'", "'"]]
  for (const [open, close] of pairs) {
    if (out.length >= 2 && out.startsWith(open) && out.endsWith(close) && !out.slice(1, -1).includes(close)) {
      out = out.slice(1, -1).trim()
      break
    }
  }
  return out || String(fallback || '').trim()
}

/** 一次最多貼多少字（防呆：ASR 不可能吐這麼多，真的吐了多半是壞掉的迴圈輸出） */
const MAX_INSERT_CHARS = 24000

// ===== 長錄音切段 =====

/**
 * 一段送進 ASR 的秒數。**本地 sherpa 的硬上限是 30 秒**（`local-asr.MAX_SAMPLES`），
 * 超過直接拋錯，所以長錄音一定要先切開再逐段送。
 */
const SEGMENT_SEC = 20
/** 在段尾往前這個範圍內找最安靜的地方下刀，才不會切在字的中間 */
const SPLIT_SEARCH_SEC = 3
/** 找切點時的取樣視窗（秒） */
const SPLIT_WINDOW_SEC = 0.1

/**
 * 在 [from, to) 之間找音量最小的位置當切點。
 * @param {Float32Array} samples
 * @param {number} from
 * @param {number} to
 * @param {number} window 視窗長度（樣本數）
 * @returns {number}
 */
function quietestCut(samples, from, to, window) {
  let best = to
  let bestEnergy = Infinity
  for (let start = Math.max(0, from); start + window <= to; start += window) {
    let energy = 0
    for (let i = start; i < start + window; i++) energy += Math.abs(samples[i])
    if (energy < bestEnergy) {
      bestEnergy = energy
      best = start + Math.floor(window / 2)
    }
  }
  return best
}

/**
 * 把一整段錄音切成 ASR 吃得下的小段。短錄音原樣回傳（不複製）。
 *
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @param {number} [segmentSec]
 * @returns {Float32Array[]}
 */
function splitSamples(samples, sampleRate, segmentSec = SEGMENT_SEC) {
  if (!samples || !samples.length) return []
  const rate = Number(sampleRate) > 0 ? Number(sampleRate) : 16000
  const max = Math.floor(rate * segmentSec)
  if (max <= 0 || samples.length <= max) return [samples]
  const window = Math.max(1, Math.floor(rate * SPLIT_WINDOW_SEC))
  const search = Math.floor(rate * SPLIT_SEARCH_SEC)
  /** @type {Float32Array[]} */
  const out = []
  let start = 0
  while (start < samples.length) {
    const hardEnd = start + max
    if (hardEnd >= samples.length) {
      // slice 而不是 subarray：native ASR 綁定不一定尊重 view 的 byteOffset，
      // 給它一段獨立的緩衝最保險（只有長錄音會走到這裡，複製成本無所謂）
      out.push(samples.slice(start))
      break
    }
    const cut = quietestCut(samples, hardEnd - search, hardEnd, window)
    // 找不到比 start 更後面的切點時退回硬切，否則會原地打轉
    const end = cut > start ? cut : hardEnd
    out.push(samples.slice(start, end))
    start = end
  }
  return out
}

/**
 * 把逐段的辨識結果接回一整句。中文之間不補空白（補了很醜），
 * 拉丁字母交界才補一個。
 * @param {string[]} parts
 * @returns {string}
 */
function joinSegments(parts) {
  let out = ''
  for (const part of parts) {
    const piece = String(part || '').trim()
    if (!piece) continue
    if (!out) {
      out = piece
      continue
    }
    const needSpace = /[A-Za-z0-9]$/.test(out) && /^[A-Za-z0-9]/.test(piece)
    out += needSpace ? ` ${piece}` : piece
  }
  return out
}

/**
 * 貼上前先過一次：控制字元（換行、Tab、CR 以外）會讓終端機做出奇怪的事。
 * @param {unknown} raw
 * @returns {string}
 */
function sanitizeInsertText(raw) {
  const input = typeof raw === 'string' ? raw : ''
  let out = ''
  for (const ch of input) {
    if (ch === '\n' || ch === '\r' || ch === '\t') {
      out += ch
    } else {
      const code = ch.codePointAt(0)
      if (code < 0x20 || code === 0x7f) continue
      out += ch
    }
    if (out.length >= MAX_INSERT_CHARS) break
  }
  return out.slice(0, MAX_INSERT_CHARS)
}

module.exports = {
  sanitizeInsertText,
  MAX_INSERT_CHARS,
  tokenize,
  isLearnableTerm,
  applyDictionary,
  diffBlocks,
  learnPairs,
  mergeLearned,
  activeEntries,
  cleanupMode,
  buildSystemPrompt,
  cleanupOutput,
  looksReasonable,
  splitForCleanup,
  splitSamples,
  joinSegments,
  SEGMENT_SEC,
  LANG_NAMES,
  MAX_DICT_ENTRIES,
  PROMOTE_COUNT,
  REWRITE_MIN_CHARS
}
