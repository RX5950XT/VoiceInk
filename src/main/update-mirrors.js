'use strict'

/**
 * GitHub Releases 的安裝檔在 APAC 常被 CDN 限速到幾十 KB/s（實測 ~50KB/s → 406MB 要一小時），
 * 同一支檔經公開反向代理可到 ~25MB/s。版本清單 latest.yml 仍只從 GitHub 讀（sha512 是信任根）；
 * 這裡只改寫 httpExecutor.download 拿到的 .exe 網址，下完仍由 electron-updater 對雜湊。
 */

const fs = require('fs')

const OWNER = 'RX5950XT'
const REPO = 'VoiceInk'
/** 先代理、官方放最後。官方慢但會成功，排前面就永遠輪不到代理。 */
const MIRRORS = [
  'https://ghfast.top/',
  'https://gh-proxy.com/'
]
const ASSET_EXE = new RegExp(
  `^https://github\\.com/${OWNER}/${REPO}/releases/download/[^/]+/[^/]+\\.exe$`,
  'i'
)

function hrefOf(url) {
  if (url == null) return ''
  if (typeof url === 'string') return url
  if (typeof url.href === 'string') return url.href
  return String(url)
}

function toUrl(url) {
  return url instanceof URL ? url : new URL(hrefOf(url))
}

/**
 * @param {string | URL} url
 * @returns {URL[]}
 */
function downloadUrls(url) {
  const href = hrefOf(url)
  if (!ASSET_EXE.test(href.split('?')[0])) return [toUrl(href || url)]
  return [...MIRRORS.map((prefix) => new URL(prefix + href)), new URL(href)]
}

/** 包住 electron-updater 的 download：前一跳失敗就刪半截檔再試下一個。 */
function downloadWithFallback(executor) {
  if (!executor || typeof executor.download !== 'function') return executor
  const orig = executor.download.bind(executor)
  executor.download = async (url, destination, options) => {
    const urls = downloadUrls(url)
    let lastErr
    for (const next of urls) {
      try {
        return await orig(next, destination, options)
      } catch (err) {
        lastErr = err
        try { fs.unlinkSync(destination) } catch { /* 還沒寫出檔 */ }
      }
    }
    throw lastErr
  }
  return executor
}

module.exports = { OWNER, REPO, MIRRORS, downloadUrls, downloadWithFallback }
