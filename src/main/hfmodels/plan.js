'use strict'

/**
 * 決定一顆模型要用什麼參數跑。純函式（不碰檔案系統、不跑子程序）。
 *
 * **分工要先講清楚，不然會做兩次而且做錯**：
 *   - `fit.js` 跑官方的 `llama-fit-params.exe`，那是**真值**（它會實際載一次模型量記憶體），
 *     產出 `-c/-ngl/-ts/-ot`。有檔案在本機時一律以它為準。
 *   - 這一支是**估算**，用在兩個 fit 到不了的地方：
 *       ① 下載前的預覽（檔案還不在本機，只有 HTTP Range 抓到的檔頭）
 *       ② fit 跑失敗時的退路
 *     以及 fit **不管**的策略決定（KV 量化檔位、投機解碼、執行緒、多模態裝置…），
 *     那些不論有沒有 fit 都要由這裡決定。
 *
 * 估算一律**寧可低估可用空間**：猜太滿的代價是載入到一半 OOM（使用者只看到「載入失敗」），
 * 猜保守的代價只是慢一點。
 */

const { kvCacheBytes } = require('./gguf')

/** 讀不到 `contextTrain` 時的保底 */
const FALLBACK_CTX = 4096
/** 預設不開到訓練上限：一顆 256k context 的模型光 KV 就吃掉整張卡 */
const DEFAULT_CTX = 8192
/** 縮到這裡還塞不下就不再縮，改動別的旋鈕 */
const MIN_CTX = 2048
/** 顯存只用這個比例（其餘留給桌面合成器與其他程式） */
const VRAM_SAFETY = 0.9
/** 固定額外開銷（計算緩衝、CUDA/Vulkan context 等） */
const OVERHEAD_MIB = 384
/** 長對話重跑 prompt 的成本：可重用的最小片段 */
const CACHE_REUSE = 256

const MIB = 1024 * 1024

/**
 * KV 量化檔位，由寬鬆到省。
 *
 * **V 的量化需要 flash attention**（K 不用）：所以只要選到 V 不是 f16 的檔位，
 * 就一定要一起送 `flash-attn = on`。反過來 f16 那一檔刻意**不送** `flash-attn`——
 * 預設的 `auto` 已經會在支援的後端自己打開，硬寫 `on` 在不支援 FA 的後端上會直接載不起來。
 */
const KV_TIERS = Object.freeze([
  { k: 'f16', v: 'f16', flashAttn: false, label: '品質優先' },
  { k: 'q8_0', v: 'q8_0', flashAttn: true, label: '平衡' },
  { k: 'q8_0', v: 'q4_0', flashAttn: true, label: '長上下文優先' }
])

/**
 * @param {number} bytes
 * @returns {number}
 */
function toMiB(bytes) {
  return Math.ceil((Number(bytes) || 0) / MIB)
}

/**
 * KV 快取大小（MiB）。
 *
 * **一定要用 GGUF 寫的 `attention.key_length`／`value_length`**，不能拿
 * `embedding_length ÷ head_count` 推（`gguf.js` 已經處理好這個優先序）：
 * 實測 Qwen3.5-4B 的 `embd/hc` 是 160、但 `key_length` 明寫 256，
 * 用推導值算會低估 1.6 倍（linguaforge 0.8B 是 2 倍），
 * 然後 `gpu-layers` 就會給太多、載入時 OOM。
 *
 * @param {object} info `gguf.readInfo` 的結果
 * @param {number} ctxSize
 * @param {string} [typeK]
 * @param {string} [typeV]
 * @returns {number}
 */
function kvCacheMiB(info, ctxSize, typeK = 'f16', typeV = 'f16') {
  return toMiB(kvCacheBytes(info, ctxSize, typeK, typeV))
}

/**
 * @param {number} value @param {number} min @param {number} max @returns {number}
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/**
 * 執行緒數。
 *
 * @param {number} logicalCores
 * @returns {number}
 * ponytail: 用「邏輯核的一半」當實體核估計（SMT 的普遍情況）。
 * 真的要精確得查 WMI `Win32_Processor.NumberOfCores`，
 * 但那要開 PowerShell，為了一個 ±1 的執行緒數不值得。使用者可以自己覆寫。
 */
function planThreads(logicalCores) {
  const logical = Number(logicalCores) || 0
  if (logical <= 0) return 0
  return clamp(Math.floor(logical / 2), 1, 32)
}

/**
 * 多卡的 `-ts`：照各卡的可用顯存分配。單卡不送（送了反而會關掉 llama.cpp 自己的 fit）。
 * @param {Array<{ freeMiB: number }>} devices
 * @returns {string}
 */
function planTensorSplit(devices) {
  const list = Array.isArray(devices) ? devices.filter((d) => d && d.freeMiB > 0) : []
  if (list.length < 2) return ''
  const total = list.reduce((sum, d) => sum + d.freeMiB, 0)
  if (!total) return ''
  return list.map((d) => (d.freeMiB / total).toFixed(3)).join(',')
}

/**
 * MoE 專用：塞不下時**先把專家丟回 CPU，而不是砍層數**。
 *
 * 每個 token 只會用到 `expert_used_count / expert_count` 的專家，但**所有**專家都要佔顯存。
 * 砍層數等於連注意力一起搬到 CPU（那才是真的慢）；只搬專家的話注意力還留在 GPU 上，
 * 實測（參考 repo 的 30B-A3B 在 8GB 卡上）差距是「跑得動」與「跑不動」。
 *
 * @param {object} info
 * @param {number} deficitMiB 還差多少顯存
 * @returns {number} 要放到 CPU 的前 N 層專家；0 = 不需要
 */
function planCpuMoe(info, deficitMiB) {
  if (!info?.isMoe || deficitMiB <= 0) return 0
  const layers = Number(info.blockCount) || 0
  const embd = Number(info.embeddingLength) || 0
  const expertFfn = Number(info.expertFfnLength) || 0
  const experts = Number(info.expertCount) || 0
  if (!layers || !embd || !expertFfn || !experts) return 0
  // 專家權重是量化過的，用 Q4 的 ~0.5 bytes/參數估（估太小會搬不夠，所以取保守值）
  const perLayerMiB = toMiB(3 * embd * expertFfn * experts * 0.55)
  if (perLayerMiB <= 0) return 0
  return clamp(Math.ceil(deficitMiB / perLayerMiB), 1, layers)
}

/**
 * 可行性等級（下載前就算得出來，顯示在每個量化旁邊）
 * @param {{ fullOffload: boolean, gpuLayers: number, totalMiB: number, ramMiB: number }} state
 * @returns {'gpu' | 'partial' | 'cpu' | 'no'}
 */
function feasibilityOf(state) {
  if (state.fullOffload) return 'gpu'
  if (state.totalMiB > state.ramMiB) return 'no'
  return state.gpuLayers > 0 ? 'partial' : 'cpu'
}

/** 給 UI 用的說明（不是 enum 名字，是講給人聽的） */
const FEASIBILITY_LABEL = Object.freeze({
  gpu: '整顆放得進顯示卡',
  partial: '一部分要靠 CPU（會慢一些）',
  cpu: '幾乎全在 CPU 上跑（很慢）',
  no: '記憶體放不下'
})

/**
 * @param {{
 *   modelBytes: number,
 *   info?: object,
 *   devices?: Array<{ id?: string, name?: string, totalMiB?: number, freeMiB?: number }>,
 *   device?: { id?: string, name?: string, totalMiB?: number, freeMiB?: number } | null,
 *   cpu?: { cores?: number, totalMemoryMiB?: number },
 *   requested?: {
 *     ctxSize?: number | null, gpuLayers?: number | null, cacheTypeK?: string | null,
 *     cacheTypeV?: string | null, threads?: number | null, nCpuMoe?: number | null,
 *     specType?: string | null, draftModel?: string | null, tensorSplit?: string | null
 *   }
 * }} input
 */
function planRun(input) {
  const info = input?.info || {}
  const requested = input?.requested || {}
  const cpu = input?.cpu || {}
  const devices = Array.isArray(input?.devices) && input.devices.length
    ? input.devices
    : (input?.device ? [input.device] : [])
  const device = devices[0] || null
  const warnings = []
  const reasons = []

  const modelMiB = toMiB(input?.modelBytes)
  const layers = Number(info.blockCount) || 0
  const ctxTrain = Number(info.contextTrain) || 0
  const ramMiB = Number(cpu.totalMemoryMiB) || 0
  if (!layers) warnings.push('讀不到模型層數，顯存估計只能粗抓')

  // ---- 上下文 ----
  const ctxCeiling = ctxTrain > 0 ? ctxTrain : FALLBACK_CTX
  const ctxRequested = Number(requested.ctxSize) > 0
  let ctxSize = ctxRequested ? Math.floor(Number(requested.ctxSize)) : Math.min(ctxCeiling, DEFAULT_CTX)
  if (ctxRequested && ctxTrain > 0 && ctxSize > ctxTrain) {
    warnings.push(`上下文 ${ctxSize} 超過模型訓練長度 ${ctxTrain}，超出的部分品質不保證`)
  }

  const budgetMiB = device ? Math.floor((Number(device.freeMiB) || Number(device.totalMiB) || 0) * VRAM_SAFETY)
    : 0
  const totalBudgetMiB = devices.reduce(
    (sum, d) => sum + Math.floor((Number(d.freeMiB) || Number(d.totalMiB) || 0) * VRAM_SAFETY), 0
  )

  // ---- KV 量化檔位：先挑「放得下的最寬鬆那一檔」 ----
  let tier = KV_TIERS[0]
  if (requested.cacheTypeK || requested.cacheTypeV) {
    tier = {
      k: String(requested.cacheTypeK || 'f16'),
      v: String(requested.cacheTypeV || 'f16'),
      flashAttn: String(requested.cacheTypeV || 'f16') !== 'f16',
      label: '手動指定'
    }
  } else if (totalBudgetMiB > 0) {
    for (const candidate of KV_TIERS) {
      tier = candidate
      if (modelMiB + kvCacheMiB(info, ctxSize, candidate.k, candidate.v) + OVERHEAD_MIB <= totalBudgetMiB) break
    }
    if (tier !== KV_TIERS[0]) {
      reasons.push(`KV 快取用 ${tier.k}/${tier.v}（${tier.label}）才放得進顯示卡`)
    }
  }

  // ---- 還是塞不下就縮上下文（品質影響比砍層數小） ----
  if (!ctxRequested && totalBudgetMiB > 0) {
    while (ctxSize > MIN_CTX
      && modelMiB + kvCacheMiB(info, ctxSize, tier.k, tier.v) + OVERHEAD_MIB > totalBudgetMiB) {
      ctxSize = Math.max(MIN_CTX, Math.floor(ctxSize / 2))
    }
    if (ctxSize < Math.min(ctxCeiling, DEFAULT_CTX)) {
      reasons.push(`上下文收到 ${ctxSize}（再大就放不進顯示卡）`)
    }
  }

  const kvMiB = kvCacheMiB(info, ctxSize, tier.k, tier.v)
  const totalMiB = modelMiB + kvMiB + OVERHEAD_MIB

  // ---- 沒有 GPU：整包跑 CPU ----
  // **不要只給 `--gpu-layers 99` 就當有 GPU**：沒指定 `--device` 時 llama.cpp 會安靜地
  // 整包跑 CPU（`llama-asr.js` 那條實測，差 97 倍）。
  if (!device || !device.id) {
    return finalize({
      ctxSize, gpuLayers: 0, device: '', tensorSplit: '', nCpuMoe: 0,
      tier, info, cpu, requested,
      modelMiB, kvMiB, totalMiB, budgetMiB: 0, ramMiB, fullOffload: false,
      reasons, warnings: warnings.concat('找不到 GPU 後端，會用 CPU 推論（速度慢很多）')
    })
  }

  // ---- GPU 層數 ----
  let gpuLayers
  let nCpuMoe = 0
  const manualLayers = requested.gpuLayers !== null && requested.gpuLayers !== undefined
    && Number.isFinite(Number(requested.gpuLayers))
  if (manualLayers) {
    gpuLayers = clamp(Math.floor(Number(requested.gpuLayers)), 0, layers || 999)
  } else if (totalMiB <= totalBudgetMiB || !layers) {
    gpuLayers = layers || 999
  } else if (info.isMoe) {
    // MoE 先搬專家、不砍層（注意力留在 GPU 上才不會整個掉一個檔次）
    nCpuMoe = planCpuMoe(info, totalMiB - totalBudgetMiB)
    gpuLayers = layers
    reasons.push(`顯存不足，把前 ${nCpuMoe}/${layers} 層的專家權重放到 CPU（注意力仍在 GPU）`)
  } else {
    // 每一層帶自己的權重與 KV；輸出層另外算一份，所以分母用 layers + 1
    const perLayer = modelMiB / (layers + 1) + kvMiB / layers
    gpuLayers = clamp(Math.floor((totalBudgetMiB - OVERHEAD_MIB) / perLayer), 0, layers)
    // 這一條放 warnings 不放 reasons：`reasons` 是「為什麼這樣調」（正常說明），
    // 而「有幾層跑在 CPU 上」是使用者會實際感受到變慢的降級，該用警告的份量講
    warnings.push(`顯存不足以整顆放上 GPU（需要約 ${totalMiB} MiB、可用約 ${totalBudgetMiB} MiB），只放 ${gpuLayers}/${layers} 層`)
  }
  if (requested.nCpuMoe !== null && requested.nCpuMoe !== undefined && Number.isFinite(Number(requested.nCpuMoe))) {
    nCpuMoe = clamp(Math.floor(Number(requested.nCpuMoe)), 0, layers || 999)
  }

  return finalize({
    ctxSize,
    gpuLayers,
    device: device.id || '',
    tensorSplit: requested.tensorSplit ? String(requested.tensorSplit) : planTensorSplit(devices),
    nCpuMoe,
    tier, info, cpu, requested,
    modelMiB, kvMiB, totalMiB, budgetMiB: totalBudgetMiB, ramMiB,
    fullOffload: !!layers && gpuLayers >= layers && nCpuMoe === 0,
    reasons, warnings
  })
}

/**
 * 補上「不論有沒有 GPU 都一樣」的那幾項，並算出可行性等級
 * @param {object} state
 */
function finalize(state) {
  const { tier, info, cpu, requested } = state
  const threads = requested.threads !== null && requested.threads !== undefined
    && Number.isFinite(Number(requested.threads))
    ? clamp(Math.floor(Number(requested.threads)), 1, 64)
    : planThreads(cpu.cores)

  // 免草稿模型的投機解碼：不必多載一顆模型就能加速，所以預設就開。
  // 有配對到草稿模型時由呼叫端改成 `draft-simple` ＋ `model-draft`。
  const specType = requested.specType === null || requested.specType === undefined
    ? 'ngram-mod'
    : String(requested.specType || '')

  const plan = {
    ctxSize: state.ctxSize,
    gpuLayers: state.gpuLayers,
    device: state.device,
    tensorSplit: state.tensorSplit,
    nCpuMoe: state.nCpuMoe,
    cacheTypeK: tier.k,
    cacheTypeV: tier.v,
    flashAttn: !!tier.flashAttn,
    kvTier: tier.label,
    threads,
    specType,
    draftModel: requested.draftModel ? String(requested.draftModel) : '',
    cacheReuse: CACHE_REUSE,
    multimodal: !!info.multimodal,
    modelMiB: state.modelMiB,
    kvMiB: state.kvMiB,
    totalMiB: state.totalMiB,
    budgetMiB: state.budgetMiB,
    ramMiB: state.ramMiB,
    fullOffload: state.fullOffload,
    reasons: state.reasons,
    warnings: state.warnings
  }
  plan.feasibility = feasibilityOf(plan)
  plan.feasibilityLabel = FEASIBILITY_LABEL[plan.feasibility]
  return plan
}

/** 使用者可以在「原始參數」欄位裡寫的 key（值原樣接到命令列，所以 key 要收斂） */
const RAW_KEY_RE = /^[a-z][a-z0-9-]{0,40}$/

/**
 * 「進階：原始參數」文字框 → INI 的 key/value。
 *
 * 一行一個 `key = value`，key 走 allowlist 字元、值交給 `presets.safeValue` 清換行與括號。
 * 這是「比 LM Studio 自由」的地方：llama-server 有幾百個旗標，我們不可能每個都做一顆按鈕，
 * 但也**不能讓它變成任意命令列注入**——所以 key 收斂、值不許換行。
 * @param {unknown} text
 * @returns {{ args: Record<string, string>, rejected: string[] }}
 */
function parseRawArgs(text) {
  /** @type {Record<string, string>} */
  const args = {}
  const rejected = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue
    const at = trimmed.indexOf('=')
    if (at < 0) { rejected.push(trimmed.slice(0, 60)); continue }
    const key = trimmed.slice(0, at).trim().replace(/^-+/, '')
    const value = trimmed.slice(at + 1).trim()
    if (!RAW_KEY_RE.test(key)) { rejected.push(trimmed.slice(0, 60)); continue }
    args[key] = value
  }
  return { args, rejected }
}

/**
 * 決策 → `--models-preset` 的 INI 區段內容。
 *
 * **`gpu-layers` 只在「我們真的算過」時才寫**：llama.cpp 的 `-fit on` 是預設值，
 * 它會自己精算 `-ngl`／`-ts`／`-ot`，但**只調整使用者沒設的參數**——
 * 主動寫死 `gpu-layers` 等於把官方那套（會實際載一次量記憶體、MoE 還會產出手寫不出來的 `-ot`）
 * 換成我們的估算。所以有 `fit` 的結果就用 fit 的，沒有才退回估算值。
 *
 * @param {ReturnType<typeof planRun>} plan
 * @param {{ fit?: { ctxSize?: number, gpuLayers?: number, tensorSplit?: string, overrideTensor?: string } | null,
 *           rawArgs?: string, mmprojDevice?: string }} [extra]
 * @returns {Record<string, string>}
 */
function toPresetArgs(plan, extra = {}) {
  const fit = extra.fit || null
  /** @type {Record<string, string>} */
  const args = { 'ctx-size': String(fit?.ctxSize || plan.ctxSize) }

  if (plan.device) args.device = plan.device

  if (fit) {
    // fit 是實際量出來的，整組照用（`-ot` 尤其手寫不出來）。
    // `gpuLayers` 是字串：整顆放得下時 fit 印 `-ngl -1`，已在 fit.js 轉成 `all`
    if (fit.gpuLayers) args['gpu-layers'] = String(fit.gpuLayers)
    if (fit.tensorSplit) args['tensor-split'] = fit.tensorSplit
    if (fit.overrideTensor) args['override-tensor'] = fit.overrideTensor
  } else {
    if (Number.isFinite(Number(plan.gpuLayers))) args['gpu-layers'] = String(plan.gpuLayers)
    if (plan.tensorSplit) args['tensor-split'] = plan.tensorSplit
    if (plan.nCpuMoe > 0) args['n-cpu-moe'] = String(plan.nCpuMoe)
  }

  // KV 量化：V 不是 f16 就一定要一起開 flash attention，否則載不起來
  if (plan.cacheTypeK && plan.cacheTypeK !== 'f16') args['cache-type-k'] = plan.cacheTypeK
  if (plan.cacheTypeV && plan.cacheTypeV !== 'f16') args['cache-type-v'] = plan.cacheTypeV
  if (plan.flashAttn) args['flash-attn'] = 'on'

  if (plan.threads > 0) args.threads = String(plan.threads)
  if (plan.specType) args['spec-type'] = plan.specType
  if (plan.draftModel) args['model-draft'] = plan.draftModel
  if (plan.cacheReuse > 0) args['cache-reuse'] = String(plan.cacheReuse)
  if (extra.mmprojDevice) args['mmproj-device'] = extra.mmprojDevice

  // 使用者的原始參數放最後：同名就蓋掉我們的決定（「比 LM Studio 自由」的意思就是這個）
  if (extra.rawArgs) Object.assign(args, parseRawArgs(extra.rawArgs).args)
  return args
}

module.exports = {
  planRun,
  kvCacheMiB,
  planThreads,
  planTensorSplit,
  planCpuMoe,
  parseRawArgs,
  toPresetArgs,
  feasibilityOf,
  KV_TIERS,
  FEASIBILITY_LABEL,
  DEFAULT_CTX,
  MIN_CTX,
  VRAM_SAFETY,
  OVERHEAD_MIB,
  CACHE_REUSE
}
