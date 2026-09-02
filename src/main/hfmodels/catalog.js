'use strict'

/**
 * 把「一個 repo 底下一堆檔案」歸成「幾個可以跑的變體」。純函式，不碰檔案系統與網路。
 *
 * 三件事要判對，判錯的症狀都是「下載完跑不起來」而不是報錯：
 *   1. **量化等級看檔名不看 metadata**（HF 上的命名就是它，`general.file_type` 的 enum 表會過期）
 *   2. **分片要整組一起算**（`-00001-of-00003.gguf`；少抓一片 llama.cpp 會在載入時才抱怨）
 *   3. **`mmproj-*.gguf` 不是一個模型**，是多模態投影層——router 只要看到它跟模型放在同一個
 *      子資料夾就會自動加 `--mmproj`（實測），所以它必須跟著變體一起下載，但不能自成一列
 */

/** 量化標籤：`…-Q4_K_M.gguf`／`IQ2_XXS`／`F16`／`BF16`／`MXFP4_MOE` */
const QUANT_RE = /(?:^|[-_.\/])((?:I?Q\d+(?:_[A-Z0-9]+)*)|F16|F32|BF16|MXFP4(?:_MOE)?)(?=[-_.\/]|$)/gi
/** 分片：`<base>-00001-of-00009.gguf` */
const SHARD_RE = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i

/**
 * @param {string} name
 * @returns {string}
 */
function baseName(name) {
  const parts = String(name || '').split(/[\\/]/)
  return parts[parts.length - 1] || ''
}

/**
 * 量化等級（找**最後**一個符合的片段：`Qwen3-Q4_K_M` 的模型名裡也可能有像量化的字）
 * @param {string} name 檔名或含資料夾的相對路徑
 * @returns {string} 大寫標籤；認不出來回空字串
 */
function parseQuant(name) {
  const text = String(name || '').replace(/\.gguf$/i, '')
  let found = ''
  QUANT_RE.lastIndex = 0
  for (let m = QUANT_RE.exec(text); m; m = QUANT_RE.exec(text)) found = m[1]
  return found.toUpperCase()
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function isMmproj(name) {
  return /^mmproj/i.test(baseName(name))
}

/**
 * @param {string} name
 * @returns {{ base: string, index: number, total: number } | null}
 */
function parseShard(name) {
  const match = SHARD_RE.exec(baseName(name))
  if (!match) return null
  return { base: match[1], index: Number(match[2]), total: Number(match[3]) }
}

/**
 * 同一個變體的檔案要放進同一個子資料夾，資料夾名就是 router 認的 model id。
 * 只留 `[A-Za-z0-9._-]`，避免 Windows 路徑與 URL 兩邊都出事。
 * @param {string} text
 * @returns {string}
 */
function safeId(text) {
  return String(text || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96)
}

/**
 * @param {{ name: string, size?: number }} file
 * @returns {number}
 */
function sizeOf(file) {
  return typeof file.size === 'number' && file.size > 0 ? file.size : 0
}

/**
 * 把 repo 的檔案清單歸成變體。
 *
 * @param {Array<{ name: string, size?: number }>} files repo 相對路徑（可含子資料夾）
 * @param {{ repoName?: string }} [opts]
 * @returns {Array<{
 *   key: string, id: string, quant: string,
 *   files: Array<{ name: string, size: number }>,
 *   bytes: number, shardCount: number,
 *   mmproj: { name: string, size: number } | null,
 *   multimodal: boolean
 * }>}
 */
function groupVariants(files, opts = {}) {
  const ggufs = (Array.isArray(files) ? files : [])
    .filter((f) => f && typeof f.name === 'string' && /\.gguf$/i.test(f.name))
    .map((f) => ({ name: f.name, size: sizeOf(f) }))

  const mmprojs = ggufs.filter((f) => isMmproj(f.name))
  const models = ggufs.filter((f) => !isMmproj(f.name))

  /** @type {Map<string, { quant: string, files: Array<{name: string, size: number}>, total: number }>} */
  const groups = new Map()
  for (const file of models) {
    const shard = parseShard(file.name)
    const dir = file.name.includes('/') ? file.name.slice(0, file.name.lastIndexOf('/')) : ''
    const stem = shard ? shard.base : baseName(file.name).replace(/\.gguf$/i, '')
    const key = dir ? `${dir}/${stem}` : stem
    const existing = groups.get(key)
    if (existing) {
      existing.files.push(file)
      if (shard) existing.total = Math.max(existing.total, shard.total)
    } else {
      // 量化可能寫在檔名，也可能只寫在資料夾名（HF 上兩種擺法都有）
      groups.set(key, {
        quant: parseQuant(baseName(file.name)) || parseQuant(dir),
        files: [file],
        total: shard ? shard.total : 1
      })
    }
  }

  const repoName = safeId(opts.repoName || '')
  return [...groups.entries()]
    .map(([key, group]) => {
      const sorted = group.files.slice().sort((a, b) => a.name.localeCompare(b.name))
      const mmproj = pickMmproj(mmprojs, group.quant)
      const suffix = group.quant || safeId(baseName(key))
      return {
        key,
        id: safeId(repoName ? `${repoName}-${suffix}` : suffix),
        quant: group.quant,
        files: sorted,
        bytes: sorted.reduce((sum, f) => sum + f.size, 0) + (mmproj ? mmproj.size : 0),
        shardCount: group.total,
        mmproj,
        multimodal: !!mmproj
      }
    })
    .sort((a, b) => a.bytes - b.bytes || a.id.localeCompare(b.id))
}

/**
 * mmproj 通常整個 repo 只有一兩顆（F16／F32），同量化的優先，其次挑最小的那顆。
 * @param {Array<{ name: string, size: number }>} mmprojs
 * @param {string} quant
 * @returns {{ name: string, size: number } | null}
 */
function pickMmproj(mmprojs, quant) {
  if (!mmprojs.length) return null
  if (quant) {
    const same = mmprojs.find((f) => parseQuant(f.name) === quant)
    if (same) return same
  }
  return mmprojs.slice().sort((a, b) => a.size - b.size || a.name.localeCompare(b.name))[0]
}

/**
 * 變體齊不齊（分片有沒有缺）
 * @param {{ files: Array<{ name: string }>, shardCount: number }} variant
 * @returns {boolean}
 */
function isComplete(variant) {
  if (!variant || !Array.isArray(variant.files) || !variant.files.length) return false
  if (variant.shardCount <= 1) return variant.files.length >= 1
  const seen = new Set()
  for (const file of variant.files) {
    const shard = parseShard(file.name)
    if (shard) seen.add(shard.index)
  }
  return seen.size === variant.shardCount
}

module.exports = { parseQuant, isMmproj, parseShard, safeId, groupVariants, isComplete }
