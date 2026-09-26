'use strict'

/**
 * 側欄位置清單：內建資料夾 + 使用者自訂（含 UNC／NAS）。
 */

const paths = require('./paths')

const RECYCLE_CWD = 'recyclebin'
const THIS_PC = 'thispc'
/** 資源回收筒固定在側欄：不能藏、不能移，舊存檔裡藏過的也照樣顯示。 */
const PINNED_ID = 'recycle'
const ID_OK = /^[A-Za-z0-9_-]{1,64}$/
const MAX_PLACES = 40

/**
 * @param {unknown} raw
 * @returns {string} 空字串＝不對應磁碟代號
 */
function sanitizeLetter(raw) {
  const s = String(raw || '').trim().toUpperCase()
  if (!s) return ''
  if (!/^[A-Z]$/.test(s)) throw paths.fail('BAD_PATH', '磁碟代號不合法')
  const sys = String(process.env.SystemDrive || 'C:').replace(':', '').toUpperCase().slice(0, 1)
  if (s === sys) throw paths.fail('BAD_PATH', '磁碟代號不合法')
  return s
}

/**
 * @param {unknown} raw
 * @returns {Array<{ id: string, label: string, path: string, hidden: boolean }>}
 */
function sanitizePlaces(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const item of raw.slice(0, MAX_PLACES)) {
    if (!item || typeof item !== 'object') continue
    const id = String(item.id || '').trim()
    if (!ID_OK.test(id) || seen.has(id)) continue
    const hidden = item.hidden === true
    let label = typeof item.label === 'string' ? item.label.trim().slice(0, 40) : ''
    let placePath = ''
    if (typeof item.path === 'string' && item.path) {
      const compact = item.path.replace(/[\\/]+$/, '').toLowerCase()
      if (compact === RECYCLE_CWD || compact === THIS_PC) {
        placePath = compact
      } else {
        try {
          placePath = paths.resolveAbs(item.path)
        } catch {
          continue
        }
      }
    }
    if (!placePath && !hidden) continue
    seen.add(id)
    out.push({ id, label, path: placePath, hidden })
  }
  return out
}

/**
 * 存檔順序優先；沒存過就用內建。hidden 的內建位置不出現（資源回收筒例外）。
 * @param {unknown} stored
 * @param {Array<{ id: string, label: string, path: string }>} builtins
 */
function mergePlaces(stored, builtins) {
  const list = Array.isArray(builtins) ? builtins.slice() : []
  const byId = new Map(list.map((p) => [p.id, p]))
  const raw = Array.isArray(stored) ? stored : []
  if (!raw.length) return list
  const out = []
  const seen = new Set()
  for (const item of raw) {
    if (!item || !item.id) continue
    seen.add(item.id)
    if (item.hidden && item.id !== PINNED_ID) continue
    if (byId.has(item.id)) {
      // 內建位置的路徑照內建的走，名稱可以被使用者改掉（右鍵「重新命名」）
      const builtin = byId.get(item.id)
      out.push(item.label ? { ...builtin, label: item.label } : builtin)
      continue
    }
    // 自訂的回收筒捷徑跟內建那格重複，內建那格一定在
    if (item.path && item.path !== RECYCLE_CWD) {
      out.push({
        id: item.id,
        label: item.label || item.path,
        path: item.path,
        custom: true
      })
    }
  }
  for (const b of list) {
    if (!seen.has(b.id)) out.push(b)
  }
  return out
}

/**
 * @param {string} unc
 * @returns {string}
 */
function shareLabel(unc) {
  const parts = String(unc || '').replace(/^\\\\/, '').split('\\').filter(Boolean)
  if (parts.length >= 2) return `\\\\${parts[0]}\\${parts[1]}`
  return '網路磁碟'
}

module.exports = {
  RECYCLE_CWD,
  THIS_PC,
  PINNED_ID,
  MAX_PLACES,
  sanitizeLetter,
  sanitizePlaces,
  mergePlaces,
  shareLabel
}
