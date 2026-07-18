/**
 * VoiceInk - 簡體→台灣繁體轉換（opencc-js，lazy 單例）
 * ASR 來源與翻譯輸出共用，避免 0.8B 譯文夾簡體字。
 */

let converter = null

/**
 * 簡體轉繁體（台灣用語）
 * @param {string} text
 * @returns {string}
 */
function s2twp(text) {
  if (!text) return text
  if (!converter) {
    const OpenCC = require('opencc-js')
    converter = OpenCC.Converter({ from: 'cn', to: 'twp' })
  }
  return converter(text)
}

module.exports = { s2twp }
