import { electronAPI, showToast } from './app.js'
import { openBrowserTab } from './ws-tabs.js'
import { scanLine, logicalLine } from './term-link-scan.js'

/**
 * 終端機畫面上的連結：網址點了開內建瀏覽器分頁，路徑點了開檔案總管。
 *
 * 走 xterm 自己的 `registerLinkProvider`（不裝 addon-web-links：路徑那半本來就得自己寫，
 * 網址那半一條 regex 就夠）。滑到哪一列才掃哪一列，掃出來的路徑候選先問主行程
 * 「這個真的存在嗎」，不存在就不畫底線——不然畫面上每個含斜線的字都會變成假連結。
 *
 * 掃描與折行的處理在 `term-link-scan.js`（純字串，單獨回歸）。
 */

/** hover 結果的快取上限，滿了整批倒掉 */
const MAX_CACHE = 200

/** @type {Map<string, Promise<Set<string>>>} */
const cache = new Map()

/**
 * 問主行程哪些候選字真的存在。
 * ponytail: 結果整批快取，之後才被建出來的檔案要等快取滿了才認得。
 * @param {string} id
 * @param {string[]} texts
 * @returns {Promise<Set<string>>}
 */
function verifyPaths(id, texts) {
  const key = `${id} ${texts.join(' ')}`
  let hit = cache.get(key)
  if (!hit) {
    hit = electronAPI.terminal.resolveLinks(id, texts)
      .then((result) => new Set((result?.ok ? result.data : []).map((row) => row.text)))
      .catch(() => new Set())
    if (cache.size >= MAX_CACHE) cache.clear()
    cache.set(key, hit)
  }
  return hit
}

/**
 * 把終端機的連結掛上去。回傳的 disposable 由 `term.dispose()` 一起收。
 * @param {import('@xterm/xterm').Terminal} term
 * @param {string} id 工作階段 id
 */
export function registerTermLinks(term, id) {
  return term.registerLinkProvider({
    provideLinks(lineNumber, callback) {
      const info = logicalLine(term.buffer.active, lineNumber)
      const hits = info ? scanLine(info.text) : []
      if (!hits.length) { callback(undefined); return }

      const cols = term.cols || 1
      /** @param {number} offset */
      const at = (offset) => ({ x: (offset % cols) + 1, y: info.startY + Math.floor(offset / cols) })
      /** @param {Set<string>} exists */
      const finish = (exists) => {
        const links = hits
          .filter((hit) => hit.url || exists.has(hit.text))
          .map((hit) => ({
            range: { start: at(hit.start), end: at(hit.end - 1) },
            text: hit.text,
            activate: (event) => {
              event.preventDefault()
              if (hit.url) { void openBrowserTab(hit.url); return }
              void electronAPI.terminal.revealLink(id, hit.text).then((result) => {
                if (!result?.ok) showToast(result?.error?.message || '找不到這個路徑', 'error')
              })
            }
          }))
        callback(links.length ? links : undefined)
      }

      const paths = hits.filter((hit) => !hit.url).map((hit) => hit.text)
      if (!paths.length) { finish(new Set()); return }
      void verifyPaths(id, paths).then(finish)
    }
  })
}
