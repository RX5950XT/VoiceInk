'use strict'

/**
 * Hugging Face Hub 唯讀查詢：搜尋 GGUF repo、列檔案、產下載網址、抓檔頭前一段。
 *
 * 兩條規矩照既有的雲端路徑走：
 *   - **不收 renderer 給的網址**：對外只收 repoId 與檔案相對路徑，網址一律在這裡組。
 *     收網址等於把 App 變成「幫你打任意網址」的代理。
 *   - **錯誤只留狀態碼**：上游 body 不進 console／IPC／UI（`shared.fetchJson` 已經是這個行為，
 *     所以這裡直接借它，不自己寫第二套 fetch）。
 *
 * 端點形狀是實測的（`scripts/probe-hf-hub.js`）：
 *   搜尋 `GET /api/models?search=&filter=gguf` → `[{id, likes, downloads, tags, pipeline_tag, createdAt}]`
 *   檔案 `GET /api/models/<repo>/tree/main?recursive=1` → `[{type:'file'|'directory', size, path}]`
 */

const { fetchJson, UsageError } = require('../usage/shared')

const HOST = 'https://huggingface.co'
const LABEL = 'Hugging Face'
/** 一個 repo 的檔案清單；GGUF repo 通常十幾個檔案，1000 是 HF tree 端點自己的單頁上限 */
const TREE_LIMIT = 1000
const SEARCH_LIMIT_MAX = 50
/** 抓檔頭用：`<arch>.*` 那幾格排在詞表之前，實測 1MB 綽綽有餘 */
const PEEK_BYTES = 1024 * 1024
/** README 只拿來顯示模型卡，200KB 綽綽有餘（LFS 大檔不會是 README） */
const README_BYTES = 200 * 1024
const PEEK_TIMEOUT_MS = 20_000

/** `owner/name`；HF 的命名允許 `-` `_` `.` */
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/
/** repo 內的相對路徑；不吃 `..`、開頭斜線、反斜線與控制字元 */
const PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,255}$/

/**
 * @param {any} id
 * @returns {boolean}
 */
function isRepoId(id) {
  return typeof id === 'string' && REPO_RE.test(id)
}

/**
 * @param {any} filePath
 * @returns {boolean}
 */
function isRepoPath(filePath) {
  return typeof filePath === 'string'
    && PATH_RE.test(filePath)
    && !filePath.includes('..')
    && !filePath.endsWith('/')
}

/**
 * @param {string} id
 * @returns {string}
 */
function assertRepo(id) {
  if (!isRepoId(id)) throw new UsageError('INVALID_REPO', 'Hugging Face 模型代號格式不正確')
  return id
}

/**
 * HF Token（gated／private repo 需要）。
 *
 * 這一層只保管一個字串，**不碰 store**（它是純粹跟 HF 講話的那一層）；
 * 由 `index.setStore` 灌進來。環境變數是給 CLI／測試用的退路。
 * @type {string}
 */
let token = ''

/**
 * @param {unknown} value
 */
function setToken(value) {
  token = String(value || '').trim().slice(0, 200)
}

/**
 * @returns {boolean} 只回「有沒有」——**token 本身不回給任何人**
 */
function hasToken() {
  return !!(token || process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN)
}

/**
 * @returns {Record<string, string>}
 */
function authHeaders() {
  const value = token || process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN || ''
  return value ? { authorization: `Bearer ${value}` } : {}
}

/**
 * 搜尋 GGUF repo
 * @param {{ query?: string, limit?: number, sort?: 'downloads' | 'likes' | 'lastModified' }} options
 * @returns {Promise<Array<{ id: string, downloads: number, likes: number, tags: string[],
 *                           pipelineTag: string, createdAt: string, gated: boolean }>>}
 */
async function searchModels(options = {}) {
  const query = String(options.query || '').trim().slice(0, 120)
  const limit = Math.max(1, Math.min(SEARCH_LIMIT_MAX, Number(options.limit) || 24))
  const sort = ['downloads', 'likes', 'lastModified'].includes(options.sort) ? options.sort : 'downloads'
  const url = new URL('/api/models', HOST)
  url.searchParams.set('filter', 'gguf')
  url.searchParams.set('sort', sort)
  url.searchParams.set('direction', '-1')
  url.searchParams.set('limit', String(limit))
  if (query) url.searchParams.set('search', query)

  const rows = await fetchJson(url.toString(), { label: LABEL, headers: authHeaders(), allowArray: true })
  if (!Array.isArray(rows)) return []
  return rows
    .filter((row) => row && isRepoId(row.id))
    .map((row) => ({
      id: row.id,
      downloads: Number(row.downloads) || 0,
      likes: Number(row.likes) || 0,
      tags: Array.isArray(row.tags) ? row.tags.filter((t) => typeof t === 'string').slice(0, 40) : [],
      pipelineTag: typeof row.pipeline_tag === 'string' ? row.pipeline_tag : '',
      createdAt: typeof row.createdAt === 'string' ? row.createdAt : '',
      gated: row.gated === true || typeof row.gated === 'string'
    }))
}

/**
 * 列出 repo 裡的檔案（只回檔案，不回資料夾）
 * @param {string} repoId
 * @returns {Promise<Array<{ name: string, size: number }>>}
 */
async function listFiles(repoId) {
  assertRepo(repoId)
  const url = new URL(`/api/models/${repoId}/tree/main`, HOST)
  url.searchParams.set('recursive', '1')
  url.searchParams.set('limit', String(TREE_LIMIT))
  // 分片多的 repo 一份清單就好幾百筆，預設的 1MB 上限會剛好不夠（症狀是「這個 repo 是空的」）
  const rows = await fetchJson(url.toString(), {
    label: LABEL,
    headers: authHeaders(),
    allowArray: true,
    maxBytes: 4 * 1024 * 1024
  })
  if (!Array.isArray(rows)) return []
  return rows
    .filter((row) => row && row.type === 'file' && typeof row.path === 'string')
    .map((row) => ({
      name: row.path,
      // LFS 檔案的真實大小在 `lfs.size`；`size` 對 LFS 指標檔也是對的，兩個都看比較保險
      size: Number(row.lfs?.size) || Number(row.size) || 0
    }))
}

/**
 * 下載網址（網址在 main 組，renderer 只給 repoId 與檔名）
 * @param {string} repoId
 * @param {string} filePath
 * @returns {string}
 */
function fileUrl(repoId, filePath) {
  assertRepo(repoId)
  if (!isRepoPath(filePath)) throw new UsageError('INVALID_PATH', '檔案路徑格式不正確')
  const encoded = filePath.split('/').map(encodeURIComponent).join('/')
  return `${HOST}/${repoId}/resolve/main/${encoded}`
}

/**
 * 抓檔案開頭一段（HTTP Range）給 `gguf.readInfoFromBuffer` 用：
 * **還沒下載就先知道跑不跑得動**，不必先花 5GB 頻寬。
 *
 * @param {string} repoId
 * @param {string} filePath
 * @param {{ bytes?: number, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{ buffer: Buffer, totalBytes: number }>}
 */
async function peekFile(repoId, filePath, options = {}) {
  const url = fileUrl(repoId, filePath)
  const bytes = Math.max(1024, Math.min(PEEK_BYTES, Number(options.bytes) || PEEK_BYTES))
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PEEK_TIMEOUT_MS)
  try {
    const response = await fetchImpl(url, {
      headers: { ...authHeaders(), range: `bytes=0-${bytes - 1}` },
      signal: controller.signal
    })
    if (!response?.ok) {
      throw new UsageError('HTTP_ERROR', `Hugging Face 暫時無法使用（HTTP ${Number(response?.status) || 0}）`,
        Number(response?.status) || 0)
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    // 206 才有 Content-Range；上游不支援 Range 時會回 200 整包，這裡照樣只留前面那一段
    const range = String(response.headers?.get?.('content-range') || '')
    const total = Number(range.split('/')[1]) || buffer.length
    return { buffer: buffer.subarray(0, bytes), totalBytes: total }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * repo 詳情（`gguf` 那格是 HF 自己解出來的，跟我們讀檔頭是兩個來源，這裡只拿來顯示）
 * @param {string} repoId
 * @returns {Promise<object>}
 */
async function modelCard(repoId) {
  assertRepo(repoId)
  const row = await fetchJson(new URL(`/api/models/${repoId}`, HOST).toString(), {
    label: LABEL,
    headers: authHeaders()
  })
  return {
    id: repoId,
    downloads: Number(row?.downloads) || 0,
    likes: Number(row?.likes) || 0,
    lastModified: typeof row?.lastModified === 'string' ? row.lastModified : '',
    pipelineTag: typeof row?.pipeline_tag === 'string' ? row.pipeline_tag : '',
    gated: row?.gated === true || typeof row?.gated === 'string',
    tags: Array.isArray(row?.tags) ? row.tags.filter((t) => typeof t === 'string').slice(0, 40) : [],
    gguf: {
      parameterCount: Number(row?.gguf?.total) || 0,
      architecture: typeof row?.gguf?.architecture === 'string' ? row.gguf.architecture : '',
      contextLength: Number(row?.gguf?.context_length) || 0
    }
  }
}

/**
 * README.md（模型卡內文）。**沒有 README 不是錯誤**——很多 GGUF repo 就是沒有，
 * 那時候詳情面板照樣要能開，所以這裡吞掉失敗回空字串。
 * @param {string} repoId
 * @returns {Promise<string>}
 */
async function readme(repoId) {
  let text = ''
  try {
    const { buffer } = await peekFile(repoId, 'README.md', { bytes: README_BYTES })
    text = buffer.toString('utf8')
  } catch {
    return ''
  }
  // 截在最後一個換行：Range 剛好切在多位元組字元中間會留下亂碼
  if (Buffer.byteLength(text, 'utf8') >= README_BYTES) {
    text = text.slice(0, text.lastIndexOf('\n') + 1 || text.length)
  }
  return stripHtml(stripFrontMatter(text))
}

/**
 * HF 的 README 很常以一整塊 HTML 橫幅開頭（`<div style=...><img ...>`）。
 * `markdown.js` 是零 innerHTML 的，標籤會原樣變成文字印在模型卡最上面，
 * 所以在這裡先剝掉——**圍籬程式碼區塊裡的不動**（那裡的 `<` 是內容不是標籤）。
 * @param {string} text
 * @returns {string}
 */
function stripHtml(text) {
  let fenced = false
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return line }
      if (fenced) return line
      return line.replace(/<!--[\s\S]*?-->/g, '').replace(/<\/?[A-Za-z][^>]*>/g, '')
    })
    .join('\n')
}

/**
 * HF 的 README 開頭是一段 YAML front matter（授權、tags、base_model…），
 * 原樣顯示等於在模型卡最上面印一串設定檔。
 * @param {string} text
 * @returns {string}
 */
function stripFrontMatter(text) {
  if (!text.startsWith('---')) return text
  const end = text.indexOf('\n---', 3)
  if (end < 0) return text
  const after = text.indexOf('\n', end + 1)
  return after < 0 ? '' : text.slice(after + 1).replace(/^\s+/, '')
}

module.exports = {
  isRepoId, isRepoPath, searchModels, listFiles, fileUrl, peekFile, modelCard, readme,
  stripFrontMatter, stripHtml, setToken, hasToken, authHeaders, HOST, PEEK_BYTES
}
