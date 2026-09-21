'use strict'

const path = require('path')
const { resolveAbs } = require('./paths')

const SEARCH_TYPES = new Set([
  'all', 'file', 'folder', 'image', 'video', 'audio',
  'document', 'archive', 'code', 'other'
])
const TYPE_ALIASES = { dir: 'folder', directory: 'folder', files: 'file', folders: 'folder' }
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'heic', 'tif', 'tiff'])
const VIDEO_EXT = new Set(['mp4', 'mkv', 'avi', 'mov', 'webm', 'wmv', 'm4v'])
const AUDIO_EXT = new Set(['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'wma'])
const ARCHIVE_EXT = new Set(['zip', '7z', 'rar', 'tar', 'gz', 'bz2', 'xz', 'iso'])
const CODE_EXT = new Set([
  'c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'cs', 'go', 'java', 'kt', 'rs',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'php', 'swift',
  'css', 'scss', 'less', 'html', 'htm', 'xml', 'json', 'yaml', 'yml',
  'toml', 'ini', 'cfg', 'ps1', 'bat', 'cmd', 'sh', 'sql'
])
const DOCUMENT_EXT = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'rtf', 'csv', 'epub'
])
const MAX_FILTER_SIZE = Number.MAX_SAFE_INTEGER
const MAX_FILTER_DATE = 8640000000000000

function finiteNumber(raw) {
  const n = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(n) ? n : null
}

function dateMs(raw) {
  const n = finiteNumber(raw)
  if (n !== null) return n > 0 && n <= MAX_FILTER_DATE ? n : null
  if (typeof raw !== 'string' || !raw.trim()) return null
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_FILTER_DATE ? parsed : null
}

function sizeBytes(raw) {
  const n = finiteNumber(raw)
  return n !== null && n >= 0 && n <= MAX_FILTER_SIZE ? n : null
}

function normalizeLocation(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return ''
  try {
    return resolveAbs(raw.trim()).replace(/[\\/]+$/, '')
  } catch {
    return ''
  }
}

/**
 * @param {unknown} raw
 * @returns {{ type: string, minSize: number|null, maxSize: number|null, fromMs: number|null, toMs: number|null, location: string }}
 */
function sanitizeSearchFilters(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const rawType = typeof value.type === 'string' ? value.type.toLowerCase() : ''
  const type = SEARCH_TYPES.has(rawType) ? rawType : (TYPE_ALIASES[rawType] || 'all')
  let minSize = sizeBytes(value.minSize)
  let maxSize = sizeBytes(value.maxSize)
  if (minSize !== null && maxSize !== null && minSize > maxSize) {
    const swap = minSize
    minSize = maxSize
    maxSize = swap
  }
  let fromMs = dateMs(value.fromMs ?? value.from)
  let toMs = dateMs(value.toMs ?? value.to)
  if (fromMs !== null && toMs !== null && fromMs > toMs) {
    const swap = fromMs
    fromMs = toMs
    toMs = swap
  }
  return { type, minSize, maxSize, fromMs, toMs, location: normalizeLocation(value.location) }
}

function extensionOf(hit) {
  const ext = typeof hit.ext === 'string' ? hit.ext : path.extname(String(hit.name || hit.path || '')).slice(1)
  return ext.toLowerCase()
}

/** @param {{ dir?: boolean, name?: string, path?: string, ext?: string }} hit */
function classifySearchType(hit) {
  if (hit && hit.dir) return 'folder'
  const ext = extensionOf(hit)
  if (IMAGE_EXT.has(ext)) return 'image'
  if (VIDEO_EXT.has(ext)) return 'video'
  if (AUDIO_EXT.has(ext)) return 'audio'
  if (ARCHIVE_EXT.has(ext)) return 'archive'
  if (CODE_EXT.has(ext)) return 'code'
  if (DOCUMENT_EXT.has(ext)) return 'document'
  return 'other'
}

function isUnder(location, target) {
  if (!location) return true
  const base = String(location).replace(/[\\/]+$/, '').toLowerCase()
  const full = String(target || '').replace(/[\\/]+$/, '').toLowerCase()
  return full === base || full.startsWith(base + path.sep.toLowerCase())
}

/**
 * @param {{ name?: string, path?: string, dir?: boolean, size?: number, mtimeMs?: number }} hit
 * @param {{ type: string, minSize: number|null, maxSize: number|null, fromMs: number|null, toMs: number|null, location: string }} filters
 */
function matchesSearchFilters(hit, filters) {
  const f = sanitizeSearchFilters(filters)
  if (f.type !== 'all') {
    if (f.type === 'file') {
      if (hit.dir) return false
    } else if (f.type === 'folder') {
      if (!hit.dir) return false
    } else if (classifySearchType(hit) !== f.type) {
      return false
    }
  }
  const size = Number(hit.size) || 0
  if (f.minSize !== null && size < f.minSize) return false
  if (f.maxSize !== null && size > f.maxSize) return false
  const mtime = Number(hit.mtimeMs) || 0
  if (f.fromMs !== null && (!mtime || mtime < f.fromMs)) return false
  if (f.toMs !== null && (!mtime || mtime > f.toMs)) return false
  return isUnder(f.location, hit.path)
}

module.exports = {
  SEARCH_TYPES,
  sanitizeSearchFilters,
  classifySearchType,
  matchesSearchFilters
}
