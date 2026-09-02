'use strict'

/**
 * 「HF模型」分頁的服務門面：探索（HF Hub）→ 下載 → 本機模型庫 → router 執行環境。
 *
 * 分工刻意切得很乾淨，因為這一條路上每一段都有自己的失敗方式：
 *   `hub` 只負責跟 HF 講話（唯讀、網址在 main 組）
 *   `catalog` 只負責把檔案歸成變體（純函式）
 *   `gguf` + `hardware` + `plan` 決定參數（純函式 ＋ 一次 `--list-devices`）
 *   `fit` 跑官方的 `llama-fit-params` 拿**實際量出來**的記憶體配置
 *   `download` 只管把位元組搬下來（續傳、大小要對）
 *   `library` 只管磁碟上有什麼（磁碟是唯一真相）
 *   `runtime` 只管 router 的生死
 * 這一支把它們接起來，並且是唯一知道「userData 在哪」「llama-server 在哪」「設定放哪」的地方。
 */

const os = require('os')
const path = require('path')

const models = require('../models')
const hub = require('./hub')
const catalog = require('./catalog')
const gguf = require('./gguf')
const hardware = require('./hardware')
const plan = require('./plan')
const fit = require('./fit')
const download = require('./download')
const library = require('./library')
const presets = require('./presets')
const runtime = require('./runtime')
const bench = require('./bench')

/** Vulkan 那顆（一定有）；CUDA 是可選的加速版 */
const RUNTIME_KEYS = Object.freeze(['llamaruntimecuda', 'llamaruntime'])

let presetPath = ''
let defaultModelsDir = ''
/** @type {import('electron-store') | null} */
let store = null
/** 進行中的下載：id → { controller, received, total } */
const installs = new Map()
/** @type {(event: { type: string, [k: string]: any }) => void} */
let emit = () => {}

/**
 * @param {{ userDataPath: string, store?: object, onEvent?: (event: object) => void }} options
 */
function init(options) {
  defaultModelsDir = path.join(options.userDataPath, 'hf-models')
  presetPath = path.join(options.userDataPath, 'hf-presets.ini')
  if (options.store) setStore(options.store)
  else library.setRoot(defaultModelsDir)
  if (typeof options.onEvent === 'function') emit = options.onEvent
}

/**
 * @param {object} value
 */
function setStore(value) {
  store = /** @type {any} */ (value)
  library.setRoot(readModelsDir())
  // token 只在 main 用；`hub` 自己不碰 store（它是純粹跟 HF 講話的那一層）
  hub.setToken(String(store?.get?.('hfToken', '') || ''))
}

/**
 * 模型資料夾。使用者可以改到大碟（30B MoE 動輒 20GB，C 碟未必塞得下）。
 * @returns {string}
 */
function readModelsDir() {
  const custom = String(store?.get?.('hfModelsDir', '') || '').trim()
  return custom || defaultModelsDir
}

/**
 * 換模型資料夾。**不搬移舊檔**：搬 30GB 會把 UI 卡住好幾分鐘，而且搬到一半失敗更難收拾。
 * 舊的留在原地，使用者要的話自己搬過去（UI 會講）。
 * @returns {Promise<{ dir: string }>}
 */
async function chooseModelsDir() {
  const { dialog } = require('electron')
  const result = await dialog.showOpenDialog({
    title: '選擇本機模型存放資料夾',
    defaultPath: readModelsDir(),
    properties: ['openDirectory', 'createDirectory']
  })
  const picked = result?.filePaths?.[0]
  if (result?.canceled || !picked) return { dir: readModelsDir() }
  store?.set?.('hfModelsDir', picked)
  library.setRoot(picked)
  runtime.stop()
  await writePresets()
  return { dir: picked }
}

/**
 * HF Token（gated repo 用）。**只寫不讀**：回給 renderer 的永遠只有「有沒有設」。
 * @param {string} token
 * @returns {{ hasToken: boolean }}
 */
function setToken(token) {
  const clean = String(token || '').trim().slice(0, 200)
  store?.set?.('hfToken', clean)
  hub.setToken(clean)
  return { hasToken: !!clean }
}

/**
 * @returns {{ hasToken: boolean }}
 */
function tokenStatus() {
  return { hasToken: hub.hasToken() }
}

/**
 * 裝了哪一顆執行環境。CUDA 版在 NVIDIA 上明顯快，沒裝就用 Vulkan。
 * @returns {{ ready: boolean, key: string, reason: string, backend: string }}
 */
function runtimeReady() {
  for (const key of RUNTIME_KEYS) {
    if (models.isDownloaded(key) && models.filePath(key, 'binary')) {
      return { ready: true, key, reason: '', backend: key === 'llamaruntimecuda' ? 'CUDA' : 'Vulkan' }
    }
  }
  return {
    ready: false,
    key: '',
    backend: '',
    reason: '尚未安裝 llama.cpp 執行環境，請到設定 → 本地模型下載'
  }
}

/**
 * @returns {string}
 */
function runtimeExe() {
  const { ready, key, reason } = runtimeReady()
  if (!ready) throw new Error(reason || 'llama.cpp 執行環境路徑不完整')
  return /** @type {string} */ (models.filePath(key, 'binary'))
}

/**
 * 這台機器現在能拿什麼跑。**每次問一次**，不快取：別的程式可能剛把顯存吃光。
 * @returns {Promise<Array<{ id: string, name: string, totalMiB: number, freeMiB: number }>>}
 */
async function listDevices() {
  if (!runtimeReady().ready) return []
  return hardware.listDevices(runtimeExe())
}

/**
 * @returns {Promise<{ id: string, name: string, totalMiB: number, freeMiB: number } | null>}
 */
async function currentDevice() {
  return hardware.pickDevice(await listDevices())
}

/**
 * CPU 與系統記憶體（`plan.js` 拿來決定執行緒與「放不放得下」）
 * @returns {{ cores: number, totalMemoryMiB: number, freeMemoryMiB: number }}
 */
function cpuInfo() {
  return {
    cores: os.cpus().length,
    totalMemoryMiB: Math.floor(os.totalmem() / (1024 * 1024)),
    freeMemoryMiB: Math.floor(os.freemem() / (1024 * 1024))
  }
}

/**
 * 執行環境＋硬體一次給（UI 的「執行環境」分頁要用）
 * @returns {Promise<object>}
 */
async function hardwareInfo() {
  const ready = runtimeReady()
  const [devices, nvidia] = await Promise.all([listDevices(), hardware.nvidiaDriver()])
  return {
    runtime: ready,
    devices,
    cpu: cpuInfo(),
    nvidia,
    modelsDir: library.root(),
    hasToken: hub.hasToken(),
    modelsMax: Math.max(1, Math.min(8, Number(store?.get?.('hfModelsMax', 2)) || 2)),
    installable: RUNTIME_KEYS.map((key) => ({
      key,
      label: models.MODELS[key]?.label || key,
      totalBytes: models.MODELS[key]?.totalBytes || 0,
      downloaded: models.isDownloaded(key),
      // CUDA 版只在驅動夠新時才建議：驅動太舊裝了也起不來，而錯誤訊息是 DLL 層級的
      recommended: key === 'llamaruntimecuda' ? nvidia.cudaReady : !nvidia.cudaReady
    }))
  }
}

/**
 * 一顆本機模型的主檔（排除 mmproj；分片取第一片）
 * @param {{ id: string, files: string[] }} model
 * @returns {string}
 */
function mainGgufOf(model) {
  const main = model.files.find((name) => !/^mmproj/i.test(name)) || model.files[0] || ''
  return main ? path.join(library.dirFor(model.id), main) : ''
}

/**
 * @param {{ id: string, mmproj: string }} model
 * @returns {string}
 */
function mmprojOf(model) {
  return model.mmproj ? path.join(library.dirFor(model.id), model.mmproj) : ''
}

/**
 * 草稿模型自動配對（投機解碼）。
 *
 * 條件刻意保守：**同一個架構、同一份詞表、而且小很多**。詞表對不上時
 * llama.cpp 會直接拒絕載入；架構不同的話接受率低到不如不開。
 * 配不到就回空字串，改用免草稿的 `ngram-mod`（`plan.js` 的預設）。
 * @param {object} info 主模型的檔頭
 * @param {Array<object>} candidates 其他本機模型 `{ id, info, bytes }`
 * @returns {string} 草稿模型的 gguf 絕對路徑；配不到回空字串
 */
function pickDraftModel(info, candidates) {
  if (!info?.arch || !info?.vocabSize) return ''
  const usable = candidates.filter((c) => (
    c.info
    && c.info.arch === info.arch
    && c.info.vocabSize === info.vocabSize
    && c.bytes > 0
    && c.bytes * 8 <= info.fileBytes
  ))
  if (!usable.length) return ''
  return usable.sort((a, b) => a.bytes - b.bytes)[0].gguf || ''
}

/**
 * 把每顆本機模型的執行參數寫進 `presets.ini`。
 *
 * **router 只在啟動時讀這份檔案**，所以改完要重啟才生效——`applyPresets` 負責那一步。
 * @returns {Promise<Array<{ id: string, plan: object }>>}
 */
async function writePresets() {
  const devices = await listDevices()
  const cpu = cpuInfo()
  const mmprojDevice = hardware.pickDevice(devices)?.id || ''

  // 先把每顆的檔頭讀出來（草稿模型配對要互相比對）
  const rows = []
  for (const model of library.list()) {
    const ggufPath = mainGgufOf(model)
    let info = null
    try { info = gguf.readInfo(ggufPath) } catch { info = null }
    rows.push({ model, gguf: ggufPath, info, bytes: model.bytes, id: model.id })
  }

  const entries = []
  const planned = []
  for (const row of rows) {
    // 讀不到檔頭就整段不寫，讓 llama.cpp 自己決定——硬塞一組猜出來的參數比不寫更糟
    if (!row.info) continue
    const meta = row.model.meta || {}
    const requested = { ...(meta.requested || {}) }
    if (!requested.draftModel && requested.specType === undefined) {
      const draft = pickDraftModel(row.info, rows.filter((r) => r.id !== row.id))
      if (draft) {
        requested.draftModel = draft
        requested.specType = 'draft-simple'
      }
    }
    const decided = plan.planRun({
      modelBytes: row.model.bytes,
      info: { ...row.info, multimodal: row.model.multimodal },
      devices,
      cpu,
      requested
    })
    entries.push({
      id: row.id,
      args: plan.toPresetArgs(decided, {
        fit: meta.fit || null,
        rawArgs: meta.rawArgs || '',
        mmprojDevice: row.model.multimodal ? mmprojDevice : ''
      })
    })
    planned.push({ id: row.id, plan: decided, fit: meta.fit || null })
  }

  presets.write(presetPath, entries, {
    // router 自己的全域設定：同時載入幾顆由使用者決定
    'models-max': String(Math.max(1, Math.min(8, Number(store?.get?.('hfModelsMax', 2)) || 2)))
  })
  return planned
}

/**
 * 重寫參數並讓它生效（router 跑著就重開一次）
 * @returns {Promise<{ running: boolean, port: number }>}
 */
async function applyPresets() {
  await writePresets()
  if (!runtime.status().running) return runtime.status()
  runtime.stop()
  return startRuntime()
}

/**
 * @returns {Promise<{ running: boolean, port: number }>}
 */
async function startRuntime() {
  const exe = runtimeExe()
  if (!presetPath) throw new Error('模型庫尚未初始化')
  return runtime.start({ exe, modelsDir: library.root(), presetPath })
}

/**
 * router 沒在跑就先起來（聊天要用本機模型時會走這條）
 * @returns {Promise<{ running: boolean, port: number }>}
 */
async function ensureRuntime() {
  if (runtime.status().running) return runtime.status()
  return startRuntime()
}

/**
 * 探索：搜尋 HF 上的 GGUF repo
 * @param {{ query?: string, limit?: number, sort?: string }} options
 */
function search(options) {
  return hub.searchModels(options)
}

/**
 * 一個 repo 有哪些變體，哪些已經裝了
 * @param {string} repoId
 * @returns {Promise<{ repoId: string, variants: Array<object> }>}
 */
async function inspect(repoId) {
  const files = await hub.listFiles(repoId)
  const repoName = String(repoId).split('/')[1] || ''
  const variants = catalog.groupVariants(files, { repoName }).map((variant) => ({
    ...variant,
    installed: library.has(variant.id),
    installing: installs.has(variant.id)
  }))
  return { repoId, variants }
}

/**
 * **還沒下載就先知道跑不跑得動**：抓檔頭前 1MB（HTTP Range）算一次參數。
 *
 * 這裡刻意用 `plan.js` 的估算而不是 `fit`——檔案根本還不在本機，fit 沒東西可量。
 * @param {string} repoId
 * @param {string} variantId
 * @returns {Promise<{ info: object, plan: object, devices: Array<object>, activeParams: number | null }>}
 */
async function preview(repoId, variantId) {
  const { variants } = await inspect(repoId)
  const variant = variants.find((v) => v.id === variantId)
  if (!variant) throw new Error('找不到這個模型變體')
  const first = variant.files[0]
  const peek = await hub.peekFile(repoId, first.name)
  const info = gguf.readInfoFromBuffer(peek.buffer, peek.totalBytes)
  const devices = await listDevices()
  return {
    info,
    activeParams: gguf.activeParams(info),
    plan: plan.planRun({
      modelBytes: variant.bytes,
      info: { ...info, multimodal: variant.multimodal },
      devices,
      cpu: cpuInfo()
    }),
    devices
  }
}

/**
 * 探索頁的詳情面板一次要的東西：模型卡、README、每個量化的大小與「跑不跑得動」。
 *
 * **同一顆模型的各量化共用同一份架構**（層數／head 數／KV 長度都寫在檔頭，量化只改權重），
 * 所以檔頭只抓一次（HTTP Range 1MB），其餘變體套自己的檔案大小算——
 * 每個量化各打一次 Range 會讓一個 repo 開出十幾個請求。
 * @param {string} repoId
 * @returns {Promise<object>}
 */
async function detail(repoId) {
  const [{ variants }, card, readme] = await Promise.all([
    inspect(repoId),
    // 模型卡與 README 都只是「有更好」：拿不到照樣要能列量化版本並下載
    hub.modelCard(repoId).catch(() => null),
    hub.readme(repoId)
  ])

  let info = null
  const probe = variants.find((v) => v.files?.[0]?.name)
  if (probe) {
    try {
      const peek = await hub.peekFile(repoId, probe.files[0].name)
      info = gguf.readInfoFromBuffer(peek.buffer, peek.totalBytes)
    } catch {
      info = null
    }
  }

  const devices = await listDevices()
  const cpu = cpuInfo()
  return {
    repoId,
    card,
    readme,
    info,
    // GGUF 常常沒寫 `general.parameter_count`（unsloth 那批就是），HF 自己解出來的
    // `gguf.total` 才有值——不帶進去的話 MoE 的激活參數永遠算不出來
    activeParams: info ? gguf.activeParams(info, card?.gguf?.parameterCount) : null,
    devices,
    variants: variants.map((variant) => ({
      ...variant,
      plan: info
        ? plan.planRun({
          modelBytes: variant.bytes,
          info: { ...info, multimodal: variant.multimodal },
          devices,
          cpu
        })
        : null
    }))
  }
}

/**
 * 下載完之後跑一次官方的 fit，把實測結果存進該模型的 meta。
 *
 * 失敗（跑不起來／逾時／沒印東西）就不存，`plan.js` 的估算會頂上——
 * **不要因為 fit 失敗就讓整顆模型不能用**。
 * @param {string} id
 * @returns {Promise<object | null>}
 */
async function refreshFit(id) {
  const model = library.list().find((m) => m.id === id)
  if (!model) throw new Error('找不到這顆模型')
  if (!runtimeReady().ready) return null
  const meta = model.meta || {}
  const info = (() => { try { return gguf.readInfo(mainGgufOf(model)) } catch { return null } })()
  const devices = await listDevices()
  const decided = plan.planRun({
    modelBytes: model.bytes,
    info: info || {},
    devices,
    cpu: cpuInfo(),
    requested: meta.requested || {}
  })
  emit({ type: 'fit-start', id })
  const result = await fit.runFit({
    exe: runtimeExe(),
    gguf: mainGgufOf(model),
    mmproj: mmprojOf(model),
    ctxSize: decided.ctxSize,
    device: decided.device
  })
  library.writeMeta(id, { ...meta, fit: result, fitAt: new Date().toISOString() })
  emit({ type: 'fit-done', id, fit: result })
  await writePresets()
  return result
}

/**
 * 下載一個變體到模型庫
 * @param {string} repoId
 * @param {string} variantId
 * @returns {Promise<{ id: string, bytes: number }>}
 */
async function install(repoId, variantId) {
  if (installs.has(variantId)) throw new Error('這個模型正在下載中')
  const { variants } = await inspect(repoId)
  const variant = variants.find((v) => v.id === variantId)
  if (!variant) throw new Error('找不到這個模型變體')
  if (library.has(variant.id)) throw new Error('這個模型已經在模型庫裡了')

  const controller = new AbortController()
  installs.set(variant.id, { controller, received: 0, total: variant.bytes })
  emit({ type: 'install-start', id: variant.id, repoId, total: variant.bytes })

  const files = variant.files.concat(variant.mmproj ? [variant.mmproj] : [])
  try {
    const result = await download.downloadVariant({
      dir: library.dirFor(variant.id),
      // 網址在這裡組（renderer 只給得出 repoId 與 variantId）
      files: files.map((file) => ({
        url: hub.fileUrl(repoId, file.name),
        name: path.basename(file.name),
        size: file.size
      })),
      headers: hub.authHeaders(),
      signal: controller.signal,
      onProgress: (progress) => {
        const state = installs.get(variant.id)
        if (state) Object.assign(state, progress)
        emit({ type: 'install-progress', id: variant.id, ...progress })
      }
    })
    library.writeMeta(variant.id, {
      source: 'huggingface',
      repoId,
      quant: variant.quant,
      multimodal: variant.multimodal,
      installedAt: new Date().toISOString()
    })
    await writePresets()
    emit({ type: 'install-done', id: variant.id, bytes: result.bytes })
    // fit 要載一次模型、可能好幾分鐘：放到「下載完成」之後跑，不要擋住 install 的回傳
    refreshFit(variant.id).catch(() => {})
    if (runtime.status().running) await runtime.listModels({ reload: true }).catch(() => [])
    return { id: variant.id, bytes: result.bytes }
  } catch (error) {
    emit({ type: 'install-failed', id: variant.id, message: error?.message || '下載失敗' })
    throw error
  } finally {
    installs.delete(variant.id)
  }
}

/**
 * @param {string} variantId
 * @returns {boolean}
 */
function cancelInstall(variantId) {
  const state = installs.get(variantId)
  if (!state) return false
  state.controller.abort()
  return true
}

/**
 * 本機模型庫（含每顆的建議參數與最後生效的命令列）
 * @returns {Promise<Array<object>>}
 */
async function listLocal() {
  const devices = await listDevices()
  const cpu = cpuInfo()
  const mmprojDevice = hardware.pickDevice(devices)?.id || ''
  const rows = runtime.status().running ? await runtime.listModels().catch(() => []) : []
  /** @type {Map<string, object>} */
  const routerById = new Map(rows.map((row) => [String(row.id), row]))

  return library.list().map((model) => {
    let info = null
    try { info = gguf.readInfo(mainGgufOf(model)) } catch { /* 讀不到就不給參數 */ }
    const meta = model.meta || {}
    const decided = info
      ? plan.planRun({
        modelBytes: model.bytes,
        info: { ...info, multimodal: model.multimodal },
        devices,
        cpu,
        requested: meta.requested || {}
      })
      : null
    const routerRow = routerById.get(model.id)
    return {
      id: model.id,
      bytes: model.bytes,
      files: model.files,
      multimodal: model.multimodal,
      meta: { ...meta, hasFit: !!meta.fit },
      arch: info?.arch || '',
      quant: meta.quant || catalog.parseQuant(model.files[0] || ''),
      contextTrain: info?.contextTrain || 0,
      parameterCount: info?.parameterCount || 0,
      activeParams: info ? gguf.activeParams(info) : null,
      isMoe: !!info?.isMoe,
      expertCount: info?.expertCount || 0,
      expertUsedCount: info?.expertUsedCount || 0,
      hasChatTemplate: info?.hasChatTemplate ?? null,
      plan: decided,
      // 真正會送出去的那一組（UI 的「參數」彈窗要照著顯示，不要再算一次）
      args: decided
        ? plan.toPresetArgs(decided, {
          fit: meta.fit || null,
          rawArgs: meta.rawArgs || '',
          mmprojDevice: model.multimodal ? mmprojDevice : ''
        })
        : {},
      status: routerRow?.status?.value || 'unloaded',
      loaded: !!routerRow && routerRow.status?.value === 'loaded'
    }
  })
}

/**
 * 使用者改了某一顆的參數。
 *
 * `requested` 是「覆寫哪幾項」（沒給的仍然自動決定），`rawArgs` 是原始參數直通。
 * 寫完要 `applyPresets` 才會生效——router 只在啟動時讀 INI。
 * @param {string} id
 * @param {{ requested?: object, rawArgs?: string }} patch
 * @returns {Promise<object>}
 */
async function updateModelSettings(id, patch) {
  const model = library.list().find((m) => m.id === id)
  if (!model) throw new Error('找不到這顆模型')
  const meta = model.meta || {}
  const next = { ...meta }
  if (patch && 'requested' in patch) next.requested = sanitizeRequested(patch.requested)
  if (patch && 'rawArgs' in patch) next.rawArgs = String(patch.rawArgs || '').slice(0, 4000)
  library.writeMeta(id, next)
  await applyPresets()
  return next
}

/** 使用者可以覆寫的欄位（其餘一律忽略——這是 IPC 的信任邊界） */
const REQUESTED_NUMBERS = Object.freeze(['ctxSize', 'gpuLayers', 'threads', 'nCpuMoe'])
const REQUESTED_STRINGS = Object.freeze(['cacheTypeK', 'cacheTypeV', 'specType', 'tensorSplit'])
/** `-ctk`／`-ctv` 只認 llama.cpp 說明列出的那幾種 */
const KV_TYPES = new Set(Object.keys(gguf.KV_ELEM_BYTES))
/** `--spec-type` 的合法值（`''` = 關掉） */
const SPEC_TYPES = new Set([
  '', 'none', 'draft-simple', 'draft-eagle3', 'draft-mtp', 'draft-dflash', 'draft-dspark',
  'ngram-simple', 'ngram-map-k', 'ngram-map-k4v', 'ngram-mod', 'ngram-cache'
])

/**
 * @param {unknown} raw
 * @returns {Record<string, any>}
 */
function sanitizeRequested(raw) {
  if (!raw || typeof raw !== 'object') return {}
  /** @type {Record<string, any>} */
  const out = {}
  for (const key of REQUESTED_NUMBERS) {
    const value = /** @type {any} */ (raw)[key]
    if (value === null || value === undefined || value === '') continue
    const n = Math.floor(Number(value))
    if (Number.isFinite(n) && n >= 0 && n <= 4_000_000) out[key] = n
  }
  for (const key of REQUESTED_STRINGS) {
    const value = /** @type {any} */ (raw)[key]
    if (typeof value !== 'string') continue
    if ((key === 'cacheTypeK' || key === 'cacheTypeV') && !KV_TYPES.has(value)) continue
    if (key === 'specType' && !SPEC_TYPES.has(value)) continue
    if (key === 'tensorSplit' && !/^[\d.,]{0,64}$/.test(value)) continue
    out[key] = value
  }
  return out
}

/**
 * 刪掉一顆本機模型（跑著的話先卸載）
 * @param {string} id
 * @returns {Promise<boolean>}
 */
async function removeLocal(id) {
  if (runtime.status().running) await runtime.unloadModel(id).catch(() => false)
  const removed = library.remove(id)
  if (removed) await writePresets()
  return removed
}

/**
 * 使用者自己選一顆 gguf 進來
 * @param {string} sourcePath
 */
async function importLocal(sourcePath) {
  const result = library.importFile(sourcePath)
  await writePresets()
  refreshFit(result.id).catch(() => {})
  if (runtime.status().running) await runtime.listModels({ reload: true }).catch(() => [])
  return result
}

/**
 * 檔案路徑走系統對話框，**不收 renderer 給的路徑**（收路徑等於把任意檔案讀取當成 API）
 * @returns {Promise<{ id: string, dir: string } | null>}
 */
async function pickAndImport() {
  const { dialog } = require('electron')
  const result = await dialog.showOpenDialog({
    title: '選擇 GGUF 模型檔',
    properties: ['openFile'],
    filters: [{ name: 'GGUF 模型', extensions: ['gguf'] }]
  })
  const picked = result?.filePaths?.[0]
  if (result?.canceled || !picked) return null
  return importLocal(picked)
}

/**
 * 在檔案總管開啟模型資料夾（使用者要手動把 gguf 拖進去）
 * @returns {Promise<string>}
 */
async function openModelsDir() {
  const { shell } = require('electron')
  const fs = require('fs')
  const dir = library.root()
  fs.mkdirSync(dir, { recursive: true })
  await shell.openPath(dir)
  return dir
}

/**
 * 手動拖檔進資料夾之後重新掃描
 * @returns {Promise<Array<object>>}
 */
async function rescan() {
  await writePresets()
  if (runtime.status().running) await runtime.listModels({ reload: true }).catch(() => [])
  return listLocal()
}

/**
 * 實測調校：真的跑 `llama-bench` 比幾組候選參數，挑最快的寫回。
 *
 * **估算不能代替實測**（參考 repo 那三個專案都是這樣調出來的）：
 * KV 檔位與投機解碼對速度的影響跟模型、量化、卡都有關，算不出來。
 * @param {string} id
 * @returns {Promise<object>}
 */
async function tune(id) {
  const model = library.list().find((m) => m.id === id)
  if (!model) throw new Error('找不到這顆模型')
  const info = gguf.readInfo(mainGgufOf(model))
  const devices = await listDevices()
  const decided = plan.planRun({
    modelBytes: model.bytes,
    info,
    devices,
    cpu: cpuInfo(),
    requested: model.meta?.requested || {}
  })
  const result = await bench.tune({
    exe: models.filePath(runtimeReady().key, 'binary') || '',
    benchExe: benchExePath(),
    gguf: mainGgufOf(model),
    plan: decided,
    onProgress: (progress) => emit({ type: 'tune-progress', id, ...progress })
  })
  if (result.best) {
    const meta = model.meta || {}
    library.writeMeta(id, {
      ...meta,
      requested: { ...(meta.requested || {}), ...result.best.requested },
      tune: { at: new Date().toISOString(), results: result.results }
    })
    await applyPresets()
  }
  emit({ type: 'tune-done', id, ...result })
  return result
}

/**
 * 一鍵自動調參：先跑官方 `llama-fit-params` 量實際記憶體配置，再跑 `llama-bench` 實測挑最快的。
 *
 * 兩步順序不能顛倒：fit 決定「放得下的配置」，bench 只在那個配置上比 KV 檔位與投機解碼。
 * fit 失敗不算失敗（`plan.js` 的估算會頂上），bench 失敗才往外拋。
 * @param {string} id
 * @returns {Promise<object>}
 */
async function autoTune(id) {
  const fitResult = await refreshFit(id).catch(() => null)
  const tuned = await tune(id)
  return { fit: fitResult, ...tuned }
}

/**
 * `llama-bench.exe` 跟 `llama-server.exe` 放在同一個資料夾
 * @returns {string}
 */
function benchExePath() {
  return path.join(path.dirname(runtimeExe()), 'llama-bench.exe')
}

function cancelTune() {
  return bench.cancel()
}

/**
 * 關 App 時要收掉（router 一走，它底下跑模型的子程序也會一起走）
 */
function shutdown() {
  for (const state of installs.values()) {
    try { state.controller.abort() } catch { /* 已經結束了 */ }
  }
  installs.clear()
  bench.cancel()
  runtime.stop()
}

module.exports = {
  init,
  setStore,
  runtimeReady,
  hardwareInfo,
  currentDevice,
  listDevices,
  readModelsDir,
  chooseModelsDir,
  setToken,
  tokenStatus,
  search,
  inspect,
  preview,
  detail,
  install,
  cancelInstall,
  listLocal,
  updateModelSettings,
  refreshFit,
  removeLocal,
  importLocal,
  pickAndImport,
  openModelsDir,
  rescan,
  tune,
  autoTune,
  cancelTune,
  writePresets,
  applyPresets,
  startRuntime,
  ensureRuntime,
  stopRuntime: runtime.stop,
  runtimeStatus: runtime.status,
  endpoint: runtime.endpoint,
  loadModel: runtime.loadModel,
  unloadModel: runtime.unloadModel,
  refreshModels: () => runtime.listModels({ reload: true }),
  shutdown
}
