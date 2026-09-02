'use strict'

/**
 * GGUF 檔頭解析（純 Node、零依賴、不載入模型）。
 *
 * 為什麼要自己讀：`plan.js` 要在**載入之前**就決定 `--ctx-size` 與 `--gpu-layers`，
 * 而 router 的 `GET /models` 只有載入後才會給 `meta`。使用者自己拖進資料夾的檔案
 * 也沒有 HF API 可查——本機檔頭是唯一離線也成立的來源。
 *
 * 只解析 metadata KV 區塊（tensor info 在它後面，我們用不到就不走）。
 * 陣列一律**只記型別與長度不存值**：`tokenizer.ggml.tokens` 動輒十幾萬筆字串，
 * 存下來等於把整份詞表搬進記憶體，而我們只需要它的長度當 vocab size。
 *
 * 格式參考：ggml/docs/gguf.md（版本 2／3 的 KV 區塊佈局相同）。
 */

const fs = require('fs')

/** 'GGUF' 的 little-endian uint32 */
const MAGIC = 0x46554747
/** 每次跟磁碟要的量；metadata 通常 < 4MB，chat template 大的才會多讀幾輪 */
const CHUNK = 1 << 20
/** 保險絲：metadata 再誇張也不該到這個量，超過就當檔案不是 GGUF */
const MAX_HEADER = 64 << 20
/** 字串值只留前面這一段（chat template 可以有幾百 KB，我們只需要知道它在不在） */
const MAX_STRING = 2048

const TYPE = {
  UINT8: 0,
  INT8: 1,
  UINT16: 2,
  INT16: 3,
  UINT32: 4,
  INT32: 5,
  FLOAT32: 6,
  BOOL: 7,
  STRING: 8,
  ARRAY: 9,
  UINT64: 10,
  INT64: 11,
  FLOAT64: 12
}

/** 純量型別的位元組數（陣列跳過時要用） */
const SCALAR_SIZE = {
  [TYPE.UINT8]: 1,
  [TYPE.INT8]: 1,
  [TYPE.UINT16]: 2,
  [TYPE.INT16]: 2,
  [TYPE.UINT32]: 4,
  [TYPE.INT32]: 4,
  [TYPE.FLOAT32]: 4,
  [TYPE.BOOL]: 1,
  [TYPE.UINT64]: 8,
  [TYPE.INT64]: 8,
  [TYPE.FLOAT64]: 8
}

/**
 * 邊讀邊長的緩衝區：只在真的要用到那幾個位元組時才去跟磁碟要。
 *
 * 直接 `readFileSync` 一顆 4GB 的 GGUF 顯然不行，而「先讀 1MB 應該夠」在
 * 詞表大的模型上會剛好不夠——不夠的那一次沒有任何徵兆，只會解析到一半噴錯。
 */
class Reader {
  /**
   * @param {number} fd
   * @param {number} size 檔案總長度
   */
  constructor(fd, size) {
    this.fd = fd
    this.size = size
    this.buf = Buffer.alloc(0)
    this.pos = 0
  }

  /**
   * 確保 `this.pos` 之後還有 n 個位元組可讀
   * @param {number} n
   */
  ensure(n) {
    const need = this.pos + n
    if (need <= this.buf.length) return
    if (need > this.size) throw new Error('GGUF 檔頭還沒解析完，檔案就結束了')
    if (need > MAX_HEADER) throw new Error('GGUF metadata 超過上限，可能不是有效的檔案')
    const want = Math.min(this.size, Math.max(need, this.buf.length + CHUNK))
    const next = Buffer.alloc(want)
    this.buf.copy(next)
    let filled = this.buf.length
    while (filled < want) {
      const read = fs.readSync(this.fd, next, filled, want - filled, filled)
      if (read <= 0) throw new Error('GGUF 檔案讀取中斷')
      filled += read
    }
    this.buf = next
  }

  /**
   * @param {number} n
   * @returns {number} 讀之前的位置
   */
  take(n) {
    this.ensure(n)
    const at = this.pos
    this.pos += n
    return at
  }

  // 一律先 `take` 再取 `this.buf`：寫成 `this.buf.readUInt32LE(this.take(4))` 的話，
  // JS 會先算出 `this.buf`（舊的、還沒續讀的那顆）才呼叫 take，讀到的是過期的緩衝區。
  u8() { const at = this.take(1); return this.buf.readUInt8(at) }
  i8() { const at = this.take(1); return this.buf.readInt8(at) }
  u16() { const at = this.take(2); return this.buf.readUInt16LE(at) }
  i16() { const at = this.take(2); return this.buf.readInt16LE(at) }
  u32() { const at = this.take(4); return this.buf.readUInt32LE(at) }
  i32() { const at = this.take(4); return this.buf.readInt32LE(at) }
  f32() { const at = this.take(4); return this.buf.readFloatLE(at) }
  f64() { const at = this.take(8); return this.buf.readDoubleLE(at) }
  /** 參數量／檔案大小這種值都遠小於 2^53，轉 Number 後續才好算 */
  u64() { const at = this.take(8); return Number(this.buf.readBigUInt64LE(at)) }
  i64() { const at = this.take(8); return Number(this.buf.readBigInt64LE(at)) }

  /**
   * @param {number} [limit] 只留前面這幾個位元組（其餘照樣跳過）
   * @returns {string}
   */
  str(limit = MAX_STRING) {
    const len = this.u64()
    const at = this.take(len)
    return this.buf.toString('utf8', at, at + Math.min(len, limit))
  }
}

/**
 * 讀一個 KV 的值。陣列不存內容，只回長度與元素型別。
 * @param {Reader} r
 * @param {number} type
 * @returns {any}
 */
function readValue(r, type) {
  switch (type) {
    case TYPE.UINT8: return r.u8()
    case TYPE.INT8: return r.i8()
    case TYPE.UINT16: return r.u16()
    case TYPE.INT16: return r.i16()
    case TYPE.UINT32: return r.u32()
    case TYPE.INT32: return r.i32()
    case TYPE.FLOAT32: return r.f32()
    case TYPE.FLOAT64: return r.f64()
    case TYPE.UINT64: return r.u64()
    case TYPE.INT64: return r.i64()
    case TYPE.BOOL: return r.u8() !== 0
    case TYPE.STRING: return r.str()
    case TYPE.ARRAY: return readArray(r)
    default: throw new Error(`GGUF 未知的值型別 ${type}`)
  }
}

/**
 * 跳過陣列內容，只留 `{ arrayType, length }`
 * @param {Reader} r
 * @returns {{ arrayType: number, length: number }}
 */
function readArray(r) {
  const arrayType = r.u32()
  const length = r.u64()
  if (arrayType === TYPE.STRING) {
    // 字串陣列每一筆長度不同，只能逐筆走過去
    for (let i = 0; i < length; i += 1) {
      const len = r.u64()
      r.take(len)
    }
  } else if (arrayType === TYPE.ARRAY) {
    for (let i = 0; i < length; i += 1) readArray(r)
  } else {
    const size = SCALAR_SIZE[arrayType]
    if (!size) throw new Error(`GGUF 陣列的未知元素型別 ${arrayType}`)
    r.take(size * length)
  }
  return { arrayType, length }
}

/**
 * 同一套讀法，但來源是「已經在手上的一段位元組」。
 *
 * 給**還沒下載**的檔案用：HF 的 `resolve/main/<file>` 支援 HTTP Range（實測回 206），
 * 抓前面一段就足以回答「這顆在這台跑不跑得動」。抓不夠**不是錯誤**——
 * 我們要的 `<arch>.*` 那幾格排在 `tokenizer.ggml.tokens` 詞表**之前**（實測 1MB 就夠），
 * 走到詞表卡住時前面該讀的都讀完了。用一個認得出來的 code 讓上層決定收手。
 */
class SliceReader {
  /** @param {Buffer} buf */
  constructor(buf) {
    this.buf = buf
    this.size = buf.length
    this.pos = 0
  }

  /** @param {number} n */
  ensure(n) {
    if (this.pos + n <= this.buf.length) return
    const err = new Error('GGUF 檔頭在這一段裡還沒結束')
    err.code = 'GGUF_SHORT'
    throw err
  }

  /** @param {number} n @returns {number} */
  take(n) {
    this.ensure(n)
    const at = this.pos
    this.pos += n
    return at
  }
}
// 取值方法逐字相同，不抄第二份（抄了就是兩套會各自漂移的解析器）
for (const name of ['u8', 'i8', 'u16', 'i16', 'u32', 'i32', 'f32', 'f64', 'u64', 'i64', 'str']) {
  SliceReader.prototype[name] = Reader.prototype[name]
}

/**
 * @param {Reader | SliceReader} r
 * @param {boolean} partial 位元組不夠時當成「讀到這裡為止」而不是錯誤
 * @returns {{ version: number, tensorCount: number, kv: Record<string, any>, truncated: boolean }}
 */
function readHeaderFrom(r, partial) {
  if (r.u32() !== MAGIC) throw new Error('不是 GGUF 檔案（magic 不符）')
  const version = r.u32()
  if (version < 2 || version > 3) throw new Error(`不支援的 GGUF 版本 ${version}`)
  const tensorCount = r.u64()
  const kvCount = r.u64()
  /** @type {Record<string, any>} */
  const kv = {}
  let truncated = false
  for (let i = 0; i < kvCount; i += 1) {
    // 位移先記下來：被截斷的那一格不能只寫進去一半
    const mark = r.pos
    try {
      const key = r.str(256)
      kv[key] = readValue(r, r.u32())
    } catch (error) {
      if (partial && error?.code === 'GGUF_SHORT') {
        r.pos = mark
        truncated = true
        break
      }
      throw error
    }
  }
  return { version, tensorCount, kv, truncated }
}

/**
 * 解析 GGUF 檔頭的 metadata KV 區塊
 * @param {string} filePath
 * @returns {{ version: number, tensorCount: number, kv: Record<string, any>, truncated: boolean }}
 */
function readHeader(filePath) {
  const fd = fs.openSync(filePath, 'r')
  try {
    return readHeaderFrom(new Reader(fd, fs.fstatSync(fd).size), false)
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * @param {any} value
 * @returns {number | null}
 */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 把檔頭整理成後面要用的幾個欄位。
 *
 * **量化等級刻意不從 `general.file_type` 推**：那張 enum 表隨 llama.cpp 版本增修，
 * 抄錯一格就會在 UI 上寫著非常像真的錯誤標籤。量化看檔名（HF 上的命名就是它），
 * 由 `catalog.parseQuant` 負責。
 *
 * @param {{ version: number, tensorCount: number, kv: Record<string, any>, truncated?: boolean }} header
 * @param {number} fileBytes
 * @returns {{
 *   arch: string, name: string, sizeLabel: string, fileType: number | null,
 *   contextTrain: number | null, blockCount: number | null, embeddingLength: number | null,
 *   headCount: number | null, headCountKv: number | null,
 *   keyLength: number | null, valueLength: number | null,
 *   expertCount: number, expertUsedCount: number, expertFfnLength: number, ffnLength: number,
 *   isMoe: boolean, isProjector: boolean, parameterCount: number | null,
 *   vocabSize: number | null, hasChatTemplate: boolean | null,
 *   splitNo: number | null, splitCount: number | null,
 *   version: number, tensorCount: number, fileBytes: number, truncated: boolean
 * }}
 */
function mapInfo(header, fileBytes) {
  const { version, tensorCount, kv } = header
  const arch = typeof kv['general.architecture'] === 'string' ? kv['general.architecture'] : ''
  const tokens = kv['tokenizer.ggml.tokens']
  const headCount = num(kv[`${arch}.attention.head_count`])
  const embeddingLength = num(kv[`${arch}.embedding_length`])
  // key/value_length 省略時才等於 embedding_length ÷ head_count。
  // **有寫就一定要用寫的那個**：Qwen3 系列的 head_dim 跟 embd/heads 無關
  // （實測 Qwen3.5-4B：embd/hc = 160，但 key_length 明寫 256），
  // 拿推導值算 KV 會低估 1.6～2 倍，然後 gpu-layers 給太多、載入時 OOM。
  const perHead = headCount && embeddingLength ? Math.round(embeddingLength / headCount) : null
  const expertCount = num(kv[`${arch}.expert_count`]) || 0

  return {
    arch,
    name: typeof kv['general.name'] === 'string' ? kv['general.name'] : '',
    sizeLabel: typeof kv['general.size_label'] === 'string' ? kv['general.size_label'] : '',
    fileType: num(kv['general.file_type']),
    contextTrain: num(kv[`${arch}.context_length`]),
    blockCount: num(kv[`${arch}.block_count`]),
    embeddingLength,
    headCount,
    // head_count_kv 省略 = 沒有 GQA，等於 head_count
    headCountKv: num(kv[`${arch}.attention.head_count_kv`]) ?? headCount,
    keyLength: num(kv[`${arch}.attention.key_length`]) ?? perHead,
    valueLength: num(kv[`${arch}.attention.value_length`]) ?? perHead,
    // MoE 這幾格 HF API 不給，而「激活參數」與要不要 `--n-cpu-moe` 都得靠它們
    expertCount,
    expertUsedCount: num(kv[`${arch}.expert_used_count`]) || 0,
    expertFfnLength: num(kv[`${arch}.expert_feed_forward_length`]) || 0,
    ffnLength: num(kv[`${arch}.feed_forward_length`]) || 0,
    isMoe: expertCount > 1,
    // mmproj-*.gguf 自己也是 GGUF，但沒有 block_count。掃資料夾時要靠它分開，
    // 否則清單上會多一顆「一載入就失敗」的模型
    isProjector: arch === 'clip' || arch === 'mtmd',
    parameterCount: num(kv['general.parameter_count']),
    vocabSize: tokens && typeof tokens.arrayType === 'number' ? tokens.length : null,
    // 詞表排在 chat_template 之前，Range 預覽多半走不到那裡：
    // 回 null＝「不知道」，不要回 false 讓 UI 印出「沒有內建模板」
    hasChatTemplate: 'tokenizer.chat_template' in kv
      ? typeof kv['tokenizer.chat_template'] === 'string'
      : (header.truncated ? null : false),
    splitNo: num(kv['split.no']),
    splitCount: num(kv['split.count']),
    version,
    tensorCount,
    fileBytes: Number(fileBytes) || 0,
    truncated: !!header.truncated
  }
}

/**
 * 本機檔案
 * @param {string} filePath
 */
function readInfo(filePath) {
  return mapInfo(readHeader(filePath), fs.statSync(filePath).size)
}

/**
 * 只有前面一段（HTTP Range 抓回來的）。讀得到多少算多少，`truncated` 標明有沒有被截斷。
 * @param {Buffer} buf
 * @param {number} [fileBytes] 完整檔案大小（Content-Range 的 total）
 */
function readInfoFromBuffer(buf, fileBytes = 0) {
  return mapInfo(readHeaderFrom(new SliceReader(buf), true), fileBytes)
}

/**
 * 每個 KV cache 元素的位元組數（`-ctk`／`-ctv` 的檔位）。
 * 量化型別每個 block 另外帶 scale，所以不是整數。
 */
const KV_ELEM_BYTES = Object.freeze({
  f32: 4, f16: 2, bf16: 2,
  q8_0: 1.0625, q5_1: 0.75, q5_0: 0.6875, q4_1: 0.625, q4_0: 0.5625, iq4_nl: 0.5625
})

/**
 * KV cache 會吃掉多少位元組。
 *
 * llama.cpp 每層各配一份 K 與 V：`ctx × head_count_kv × key_length`。
 * 這是它實際的配置方式，不是拍腦袋的係數——**KV 常常比想像中大**
 * （Qwen3.5-4B 在 8K 上下文的 f16 KV 就要 1GB，超過 Q4 權重的三分之一），
 * 不把它算準，「放不放得下」一定會估錯。
 * @param {{ blockCount: number|null, headCountKv: number|null, keyLength: number|null, valueLength: number|null }} info
 * @param {number} ctx
 * @param {string} [typeK]
 * @param {string} [typeV]
 * @returns {number} 0 = 資訊不足，算不出來
 */
function kvCacheBytes(info, ctx, typeK = 'f16', typeV = 'f16') {
  const layers = Number(info?.blockCount) || 0
  const heads = Number(info?.headCountKv) || Number(info?.headCount) || 0
  const n = Number(ctx) || 0
  // `mapInfo` 已經填好 key/value_length，但這支是純函式、也會被手建的 info 呼叫：
  // 缺了就在這裡再推導一次。回 0 的話呼叫端會**以為 KV 不佔空間**，
  // 那比估錯更糟（會規劃出一個載不起來的組合，而且完全沒有徵兆）。
  const perHead = Number(info?.embeddingLength) && Number(info?.headCount)
    ? Math.round(Number(info.embeddingLength) / Number(info.headCount))
    : 0
  const kLen = Number(info?.keyLength) || perHead
  const vLen = Number(info?.valueLength) || perHead
  if (!layers || !heads || !kLen || !vLen || !n) return 0
  const bk = KV_ELEM_BYTES[typeK] ?? 2
  const bv = KV_ELEM_BYTES[typeV] ?? 2
  return Math.round(layers * n * heads * (kLen * bk + vLen * bv))
}

/**
 * 激活參數：MoE 每個 token 真的算到的那一部分。
 *
 * GGUF 沒有這一格，只能從結構推：總參數 − 沒被選中的那些專家。
 * 每層每個專家的 FFN ≈ 3 × embedding × expert_ffn（gate／up／down 三個矩陣）。
 * 推出負值或大於總量代表這個家族的結構跟假設不同（例如另有共享專家），
 * 那就**回 null 說「算不出來」**，不要印一個看起來很像真的錯數字。
 * @param {ReturnType<typeof mapInfo>} info
 * @param {number} [totalParams] 沒有 `general.parameter_count` 時由呼叫端帶（HF 的 `gguf.total`）
 * @returns {number | null}
 */
function activeParams(info, totalParams) {
  const total = Number(totalParams ?? info?.parameterCount) || 0
  if (!info?.isMoe) return total || null
  if (!total || !info.blockCount || !info.embeddingLength || !info.expertFfnLength) return null
  if (!info.expertCount || !info.expertUsedCount) return null
  const perExpert = 3 * info.embeddingLength * info.expertFfnLength
  const idle = info.blockCount * (info.expertCount - info.expertUsedCount) * perExpert
  const active = total - idle
  return active > 0 && active <= total ? active : null
}

module.exports = { readHeader, readInfo, readInfoFromBuffer, kvCacheBytes, activeParams, KV_ELEM_BYTES, TYPE }
