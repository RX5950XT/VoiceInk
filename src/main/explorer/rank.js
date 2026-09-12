'use strict'

/**
 * UFFS 命中的相關度排序。完全符合檔名 > 開頭 > 檔名含關鍵字 > 路徑命中。
 */

/**
 * @param {string} query
 * @param {{ name?: string, path?: string }} hit
 * @returns {number} 越小越相關
 */
function scoreHit(query, hit) {
  const raw = String(query || '').trim().toLowerCase().replace(/\*/g, '')
  if (!raw) return 50
  const name = String(hit && hit.name || '').toLowerCase()
  const filePath = String(hit && hit.path || '').toLowerCase()
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  if (name === raw || stem === raw) return 0
  if (name.startsWith(raw) || stem.startsWith(raw)) return 1
  if (name.includes(raw)) return 2
  if (filePath.includes(raw)) return 4
  return 50
}

/**
 * @param {string} query
 * @param {Array<{ name?: string, path?: string, dir?: boolean }>} hits
 */
function rankHits(query, hits) {
  const list = Array.isArray(hits) ? hits.slice() : []
  list.sort((a, b) => {
    const sa = scoreHit(query, a)
    const sb = scoreHit(query, b)
    if (sa !== sb) return sa - sb
    if (Boolean(a.dir) !== Boolean(b.dir)) return a.dir ? -1 : 1
    return String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hant', {
      numeric: true,
      sensitivity: 'base'
    })
  })
  return list
}

module.exports = { scoreHit, rankHits }
