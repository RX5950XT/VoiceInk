/**
 * VoiceInk - 簡體→台灣繁體轉換（opencc-js，lazy 單例）
 * ASR 來源與翻譯輸出共用，避免 0.8B 譯文夾簡體字。
 */

/** twp = 字形＋台灣詞彙；tw = 僅字形 */
let toTwp = null
let toTw = null

function ensure() {
  if (toTwp) return
  const OpenCC = require('opencc-js')
  toTwp = OpenCC.Converter({ from: 'cn', to: 'twp' })
  toTw = OpenCC.Converter({ from: 'cn', to: 'tw' })
}

/**
 * 簡體轉繁體（台灣用語）。
 * **已是繁體的文字不套詞彙表**：twp 會把正確的「參數」竄改成「引數」、
 * 「記憶體參數設定」→「記憶體引數設定」，等於竄改譯文內容。
 * 先用純字形轉換探測：無變化＝沒有簡體字 → 原樣回傳。
 * @param {string} text
 * @returns {string}
 */
function s2twp(text) {
  if (!text) return text
  ensure()
  const shaped = toTw(text)
  return shaped === text ? text : toTwp(text)
}

/**
 * 目標語為繁中時，僅對「像中文、非日韓」的來源做 s2twp。
 * 不可只看 lang==='zh-TW'：日文漢字會被 opencc 弄髒（国→國 等）。
 * 兩支本地 ASR（sherpa／llama-server）都要用同一份判斷，所以放在這裡共用。
 * @param {string} text
 * @param {string} lang
 * @returns {boolean}
 */
function shouldS2twpSource(text, lang) {
  if (lang !== 'zh-TW' || !text) return false
  if (/[ぁ-ヿ가-힯]/.test(text)) return false
  const cjkCount = (text.match(/[一-鿿]/g) || []).length
  return cjkCount / Math.max(1, text.length) >= 0.3
}

module.exports = { s2twp, shouldS2twpSource }
