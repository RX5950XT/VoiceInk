/**
 * VoiceInk - 譯文清理（純文字，無 electron 依賴 → 可 `node` 直測）
 * 0.8B 模型偶爾把 persona／SFT 指令／列點編號混進譯文，出 UI 前一律剝除。
 */

/** 引號配對（開, 閉） */
const QUOTE_PAIRS = Object.freeze([
  ['「', '」'],
  ['『', '』'],
  ['"', '"'],
  ["'", "'"]
])

/** 行首列點編號（1. / 2、 / 3) ） */
const ENUM_PREFIX = /^[ \t]*\d{1,2}[.、)][ \t]+/gm

/**
 * 模型自行加上的說話者／區段標籤（白名單；原文沒有冒號時才剝）
 * 實測：`· Following trends…` → 「說明：此趨勢…」、`What are your predictions?` → 「問：您對…」
 */
const LABEL_PREFIX =
  /^[ \t]*(?:說明|備註|註解|註|注意|提示|問|答|標題|內容|摘要|總結|結論|原文|Note|Q|A)[：:][ \t]*/gmu

/**
 * @param {string} text
 */
function stripThink(text) {
  const lastClose = text.lastIndexOf('</think>')
  if (lastClose !== -1) return text.slice(lastClose + 8).trim()
  return text.replace(/<think>[\s\S]*/g, '').trim()
}

/**
 * 剝除系統提示／SFT 指令洩漏（不可進 UI 譯文）
 * 常見：複誦 "You are a professional translator."、"翻譯成繁體中文："、`譯者：` 標籤
 * @param {string} raw
 * @returns {string}
 */
function stripPromptLeak(raw) {
  let t = String(raw || '').replace(/^﻿/, '').trim()
  if (!t) return t

  // 多輪剝除前綴（模型有時疊兩層）
  for (let i = 0; i < 6; i++) {
    const before = t
    // system persona（可跨行）
    t = t.replace(/^You are a professional translator\.?[ \t]*(?:\r?\n)*/i, '')
    t = t.replace(/^I am a (?:professional )?translator\.?[ \t]*(?:\r?\n)*/i, '')
    t = t.replace(/^你是(?:一位)?(?:專業)?翻譯(?:引擎|員|助手|AI)?[。．.!！]?[ \t]*(?:\r?\n)*/u, '')
    // SFT 指令前綴（行首；允許後接空白或換行）
    t = t.replace(/^翻譯成(?:繁體中文|簡體中文|英文|日文|韓文|中文)[：:][ \t]*(?:\r?\n)*/u, '')
    t = t.replace(
      /^Translate\s+to\s+(?:English|Japanese|Chinese|Traditional Chinese)[：:.]?[ \t]*(?:\r?\n)*/i,
      ''
    )
    // 括號式 meta
    t = t.replace(/^【(?:系統|指令|前文|本段)】[^\n\r]*(?:\r?\n)?/u, '')
    // 說話者／輸出標籤（persona 自稱：譯者、翻譯員…）
    t = t.replace(
      /^(?:A\.[ \t]+|Answer:[ \t]*|Output:[ \t]*|(?:譯文|譯者|翻譯者|翻譯員|譯員)[：:][ \t]*|Translat(?:ion|or)[：:][ \t]*)/iu,
      ''
    )
    t = t.trim()
    if (t === before) break
  }

  // 若整段仍是 system 句、無實際譯文
  if (/^You are a professional translator\.?$/i.test(t)) return ''
  if (/^你是(?:一位)?(?:專業)?翻譯/.test(t) && t.length < 40) return ''

  return t
}

/**
 * 引號整理：整段包覆剝一層；單側殘留（模型截斷）僅在「找不到配對」時剝除
 * ——`「引言」，某某說。` 的收尾 」 有配對，剝掉會變成不對稱標點
 * @param {string} input
 */
function stripWrappingQuotes(input) {
  let t = input
  for (const [open, close] of QUOTE_PAIRS) {
    if (t.length > 1 && t.startsWith(open) && t.endsWith(close)) {
      t = t.slice(1, -1).trim()
      break
    }
  }
  for (const [open, close] of QUOTE_PAIRS) {
    if (t.startsWith(open) && !t.slice(1).includes(close)) t = t.slice(1).trim()
    if (t.endsWith(close) && !t.slice(0, -1).includes(open)) t = t.slice(0, -1).trim()
  }
  return t
}

/**
 * 譯文後處理：strip 空白／引號包層／系統提示洩漏／憑空列點
 * @param {string} raw
 * @param {string} [source] 原文；用來判斷列點是否為原文本來就有（有就別動）
 */
function stripTranslationNoise(raw, source = '') {
  let t = stripPromptLeak(String(raw || '').trim())
  t = stripWrappingQuotes(t)
  // 引號剝完後可能又露出指令前綴
  t = stripPromptLeak(t)
  // 原文沒有列點，譯文卻自己編號 → 模型把譯文寫成清單，剝掉編號留內容
  if (t.includes('\n') || /^[ \t]*\d{1,2}[.、)][ \t]+/.test(t)) {
    if (!/^[ \t]*\d{1,2}[.、)][ \t]+/m.test(source || '')) {
      t = t.replace(ENUM_PREFIX, '').trim()
    }
  }
  // 原文沒有冒號，譯文卻冒出「說明：」「問：」等標籤 → 模型自己加的，剝掉
  if (!/[：:]/.test(source || '')) {
    t = t.replace(LABEL_PREFIX, '').trim()
  }
  return t
}

/**
 * 是否退化成重複迴圈。
 * zhtw 依出貨規定關閉 repeatPenalty + greedy，條列／多段輸入偶爾整段吐重複片段
 * （實測「…由「大模型」開發者，由「大模型」…」），必須偵測後改參數重跑。
 * @param {string} text
 * @returns {string | null} 命中的重複片段（供 log）
 */
function findRepetitionLoop(text) {
  const t = String(text || '').replace(/\s+/g, '')
  if (t.length < 16) return null
  // 連續重複：ABCDABCD（片段 ≥4 字，正常譯文極少見）
  const back = t.match(/(.{4,24}?)\1+/u)
  if (back) return back[1]
  // 非連續高頻：任一 6 字片段出現 ≥3 次
  const seen = new Map()
  for (let i = 0; i + 6 <= t.length; i++) {
    const seg = t.slice(i, i + 6)
    const n = (seen.get(seg) || 0) + 1
    if (n >= 3) return seg
    seen.set(seg, n)
  }
  return null
}

module.exports = {
  stripThink,
  stripPromptLeak,
  stripTranslationNoise,
  stripWrappingQuotes,
  findRepetitionLoop
}
