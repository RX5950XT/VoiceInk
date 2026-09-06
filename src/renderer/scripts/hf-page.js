/**
 * VoiceInk — 「HF模型」分頁（探索／模型庫／執行環境）
 *
 * 這一頁只做三件事：把 main 回來的資料畫出來、把使用者的動作送回去、顯示進度。
 * **所有判斷都在 main**（網址怎麼組、參數怎麼決定、路徑在哪、金鑰是什麼），
 * 這裡連 repo 的網址都拼不出來——只送得出 repoId 與變體 id。
 *
 * DOM 一律 `createElement` + `textContent`（零 innerHTML）：模型名稱、量化標籤、
 * 錯誤訊息都是 HF 上任何人都能填的字串。
 */

import { electronAPI, showToast } from './app.js'
import { renderMarkdown } from './markdown.js'

/** 搜尋輸入防抖：每打一個字就打一次 HF 太粗魯 */
const SEARCH_DEBOUNCE_MS = 400
/** KV 快取檔位（跟 main 的 gguf.KV_ELEM_BYTES 同一組） */
const KV_TYPES = ['f16', 'bf16', 'q8_0', 'q5_1', 'q5_0', 'q4_1', 'q4_0', 'iq4_nl', 'f32']

/** 可行性等級 → 徽章樣式與文字 */
const FEASIBILITY = {
  gpu: { cls: 'is-good', text: '整顆上 GPU' },
  partial: { cls: 'is-warn', text: '部分靠 CPU' },
  cpu: { cls: 'is-warn', text: 'CPU 為主・慢' },
  no: { cls: 'is-bad', text: '放不下' }
}

let started = false
let searchTimer = null
/** repo → 詳情（模型卡＋README＋量化清單）；避免每次點回去都重打一次 HF */
const inspected = new Map()
/** 現在右邊面板顯示的是哪一顆 */
let selectedRepo = ''
/** 下載進度：變體 id → { received, total } */
const progress = new Map()
/** 參數彈窗現在在編哪一顆 */
let editing = null
/** 正在自動調參的模型 id（進度事件要知道往哪一張卡寫） */
let autoTuneTarget = ''
/** @type {Array<object>} */
let libraryRows = []
/** 可安裝的執行環境（`hardware()` 回的那份） */
let installable = []
/** 正在安裝的執行環境 key（一次只裝一顆） */
let installingRuntime = ''
let unsubscribe = null
let unsubscribeModels = null

/** @param {string} id @returns {HTMLElement | null} */
const $ = (id) => document.getElementById(id)

/**
 * IPC 一律回 `{ ok, data }`／`{ ok, error }`；統一在這裡拆，錯誤就地吐 toast。
 * @param {Promise<any>} promise
 * @param {{ quiet?: boolean }} [opt]
 * @returns {Promise<any>} 失敗回 null
 */
async function call(promise, opt = {}) {
  let result
  try {
    result = await promise
  } catch (error) {
    if (!opt.quiet) showError(String(error?.message || '本機模型操作失敗'))
    return null
  }
  if (result?.ok) return result.data
  if (!opt.quiet) showError(String(result?.error?.message || '本機模型操作失敗'))
  return null
}

/** @param {string} message */
function showError(message) {
  const el = $('hfError')
  if (!el) { showToast(message, 'error'); return }
  el.textContent = message
  el.classList.remove('hidden')
}

function clearError() {
  const el = $('hfError')
  if (el) { el.textContent = ''; el.classList.add('hidden') }
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  const n = Number(bytes) || 0
  if (n <= 0) return '—'
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1)} GB`
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`
  return `${Math.round(n / 1024)} KB`
}

/**
 * @param {number} n
 * @returns {string}
 */
function formatParams(n) {
  const v = Number(n) || 0
  if (v <= 0) return ''
  if (v >= 1e12) return `${(v / 1e12).toFixed(2)}T`
  if (v >= 1e9) return `${(v / 1e9).toFixed(v >= 1e10 ? 0 : 1)}B`
  if (v >= 1e6) return `${Math.round(v / 1e6)}M`
  return String(v)
}

/**
 * @param {number} n
 * @returns {string}
 */
function formatCount(n) {
  const v = Number(n) || 0
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (v >= 1e3) return `${Math.round(v / 1e3)}K`
  return String(v)
}

/**
 * @param {string} tag
 * @param {string} [cls]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function el(tag, cls, text) {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

// ===== 探索 =====

function scheduleSearch() {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS)
}

async function runSearch() {
  const box = $('hfSearchResults')
  if (!box) return
  clearError()
  const query = /** @type {HTMLInputElement} */ ($('hfSearchInput'))?.value.trim() || ''
  const sort = /** @type {HTMLSelectElement} */ ($('hfSearchSort'))?.value || 'downloads'
  box.replaceChildren(el('p', 'setting-hint', '搜尋中…'))
  const rows = await call(electronAPI.hfmodels.search(query, sort))
  if (!rows) { box.replaceChildren(); return }
  if (!rows.length) {
    box.replaceChildren(el('p', 'setting-hint', '沒有找到有 GGUF 的 repo。可以直接貼上 owner/repo。'))
    return
  }
  box.replaceChildren(...rows.map(renderResultRow))
  // 直接貼 owner/repo 進來搜的時候通常只有一筆，順手開起來省一次點擊
  if (rows.length === 1) openDetail(rows[0].id)
}

/**
 * 搜尋結果只是「一列」，重點都在右邊的詳情面板（比照 LM Studio）。
 * @param {object} repo
 * @returns {HTMLElement}
 */
function renderResultRow(repo) {
  const row = el('button', 'hf-result')
  row.type = 'button'
  row.dataset.repo = repo.id
  row.setAttribute('role', 'option')
  row.setAttribute('aria-selected', String(repo.id === selectedRepo))
  row.classList.toggle('is-active', repo.id === selectedRepo)

  const [owner, name] = String(repo.id).split('/')
  const text = el('span', 'hf-result-text')
  text.appendChild(el('span', 'hf-result-name', name || repo.id))
  text.appendChild(el('span', 'hf-result-owner', owner || ''))
  row.appendChild(text)

  const meta = el('span', 'hf-result-meta')
  meta.appendChild(el('span', 'hf-chip', `↓ ${formatCount(repo.downloads)}`))
  if (repo.gated) meta.appendChild(el('span', 'hf-chip is-warn', '需授權'))
  row.appendChild(meta)

  row.addEventListener('click', () => openDetail(repo.id))
  return row
}

/**
 * 右邊的模型卡：概要 → 下載選項（每個量化的大小與可行性）→ README。
 * @param {string} repoId
 */
async function openDetail(repoId) {
  const pane = $('hfDetail')
  if (!pane) return
  selectedRepo = repoId
  for (const row of document.querySelectorAll('#hfSearchResults .hf-result')) {
    const on = /** @type {HTMLElement} */ (row).dataset.repo === repoId
    row.classList.toggle('is-active', on)
    row.setAttribute('aria-selected', String(on))
  }

  if (!inspected.has(repoId)) {
    pane.replaceChildren(el('p', 'setting-hint', '讀取模型卡與檔案清單…'))
    const data = await call(electronAPI.hfmodels.detail(repoId))
    if (!data) { pane.replaceChildren(el('p', 'setting-hint', '讀不到這個 repo。')); return }
    inspected.set(repoId, data)
  }
  // 讀的時候使用者可能已經點去別顆了
  if (selectedRepo !== repoId) return
  renderDetail(pane, inspected.get(repoId))
}

/**
 * @param {HTMLElement} pane
 * @param {object} detail
 */
function renderDetail(pane, detail) {
  const nodes = [renderDetailHead(detail), renderDownloadOptions(detail)]
  if (detail.readme) {
    const readme = el('section', 'hf-readme')
    readme.appendChild(el('h3', '', 'README'))
    const body = el('div', 'hf-readme-body markdown-body')
    body.appendChild(renderMarkdown(detail.readme))
    readme.appendChild(body)
    nodes.push(readme)
  }
  pane.replaceChildren(...nodes)
  pane.scrollTop = 0
}

/**
 * @param {object} detail
 * @returns {HTMLElement}
 */
function renderDetailHead(detail) {
  const head = el('header', 'hf-detail-head')
  head.appendChild(el('h2', 'hf-detail-title', detail.repoId))

  const stats = el('div', 'hf-card-meta')
  const card = detail.card
  if (card) {
    stats.appendChild(el('span', 'hf-chip', `↓ ${formatCount(card.downloads)}`))
    stats.appendChild(el('span', 'hf-chip', `♥ ${formatCount(card.likes)}`))
    if (card.lastModified) {
      stats.appendChild(el('span', 'hf-chip', `更新於 ${card.lastModified.slice(0, 10)}`))
    }
    if (card.gated) stats.appendChild(el('span', 'hf-chip is-warn', '需授權（要填 HF Token）'))
  }
  head.appendChild(stats)

  // 規格用我們自己讀的檔頭（HF 那份 `gguf` 欄位有時候是空的），讀不到才退回模型卡
  const info = detail.info || {}
  const specs = el('div', 'hf-card-meta')
  const params = info.parameterCount || card?.gguf?.parameterCount || 0
  if (params) {
    const active = info.isMoe && detail.activeParams ? `（激活 ${formatParams(detail.activeParams)}）` : ''
    specs.appendChild(el('span', 'hf-chip', `參數 ${formatParams(params)}${active}`))
  }
  const arch = info.arch || card?.gguf?.architecture || ''
  if (arch) specs.appendChild(el('span', 'hf-chip', arch))
  const ctx = info.contextTrain || card?.gguf?.contextLength || 0
  if (ctx) specs.appendChild(el('span', 'hf-chip', `ctx 上限 ${ctx}`))
  if (info.isMoe) specs.appendChild(el('span', 'hf-chip', `MoE ${info.expertUsedCount}/${info.expertCount}`))
  if (detail.variants?.some((v) => v.multimodal)) specs.appendChild(el('span', 'hf-chip', '多模態'))
  if (specs.childElementCount) head.appendChild(specs)
  return head
}

/**
 * @param {object} detail
 * @returns {HTMLElement}
 */
function renderDownloadOptions(detail) {
  const section = el('details', 'hf-options')
  section.open = true
  const variants = detail.variants || []
  section.appendChild(el('summary', '', variants.length ? `下載選項（${variants.length}）` : '下載選項'))
  const body = el('div', 'hf-options-body')
  section.appendChild(body)
  if (!variants.length) {
    body.appendChild(el('p', 'setting-hint', '這個 repo 裡沒有找到 GGUF 檔。'))
    return section
  }
  if (!detail.info) {
    body.appendChild(el('p', 'setting-hint',
      '讀不到檔頭，算不出可行性；下載後仍會顯示實際參數。'))
  }
  for (const variant of variants) body.appendChild(renderVariantRow(detail.repoId, variant))
  return section
}

/**
 * @param {string} repoId
 * @param {object} variant
 * @returns {HTMLElement}
 */
function renderVariantRow(repoId, variant) {
  const row = el('div', 'hf-variant')
  row.dataset.variant = variant.id

  const info = el('div', 'hf-variant-info')
  info.appendChild(el('span', 'hf-variant-quant', variant.quant || '未知量化'))
  info.appendChild(el('span', 'hf-variant-size', formatBytes(variant.bytes)))
  if (variant.shardCount > 1) info.appendChild(el('span', 'hf-chip', `${variant.shardCount} 分片`))
  if (variant.multimodal) info.appendChild(el('span', 'hf-chip', '多模態'))
  if (variant.plan) {
    const level = FEASIBILITY[variant.plan.feasibility] || FEASIBILITY.no
    const badge = el('span', `hf-chip hf-feasibility ${level.cls}`,
      variant.plan.ctxSize ? `${level.text} · ctx ${variant.plan.ctxSize}` : level.text)
    badge.title = [...(variant.plan.reasons || []), ...(variant.plan.warnings || [])].join('\n') || level.text
    info.appendChild(badge)
  }
  row.appendChild(info)

  const actions = el('div', 'hf-variant-actions')
  const bar = el('div', 'hf-progress hidden')
  const fill = el('div', 'hf-progress-fill')
  bar.appendChild(fill)

  const dl = el('button', 'btn btn-primary btn-sm', variant.installed ? '已安裝' : '下載')
  dl.type = 'button'
  dl.disabled = !!variant.installed
  dl.addEventListener('click', () => startInstall(repoId, variant, dl, bar, fill))
  actions.appendChild(dl)
  row.appendChild(actions)
  row.appendChild(bar)
  return row
}

/**
 * @param {string} repoId @param {object} variant
 * @param {HTMLButtonElement} button @param {HTMLElement} bar @param {HTMLElement} fill
 */
async function startInstall(repoId, variant, button, bar, fill) {
  button.disabled = true
  button.textContent = '下載中…'
  bar.classList.remove('hidden')
  fill.style.width = '0%'
  progress.set(variant.id, { received: 0, total: variant.bytes, fill, button })
  const result = await call(electronAPI.hfmodels.install(repoId, variant.id))
  progress.delete(variant.id)
  if (!result) {
    button.disabled = false
    button.textContent = '重試下載'
    bar.classList.add('hidden')
    return
  }
  button.textContent = '已安裝'
  bar.classList.add('hidden')
  variant.installed = true
  showToast(`已下載 ${variant.id}，正在自動量測最佳參數`, 'success')
  refreshLibrary()
}

// ===== 模型庫 =====

async function refreshLibrary() {
  const box = $('hfLibraryList')
  if (!box) return
  const rows = await call(electronAPI.hfmodels.list())
  if (!rows) return
  libraryRows = rows
  if (!rows.length) {
    box.replaceChildren(el('p', 'setting-hint', '還沒有本機模型。到「探索」下載，或放入 .gguf。'))
    return
  }
  box.replaceChildren(...rows.map(renderModelCard))
}

/**
 * @param {object} model
 * @returns {HTMLElement}
 */
function renderModelCard(model) {
  const card = el('article', 'hf-model')
  card.dataset.id = model.id

  const head = el('header', 'hf-model-head')
  const title = el('div', 'hf-model-title')
  title.appendChild(el('span', 'hf-model-name', model.id))
  const chips = el('div', 'hf-card-meta')
  if (model.arch) chips.appendChild(el('span', 'hf-chip', model.arch))
  if (model.quant) chips.appendChild(el('span', 'hf-chip', model.quant))
  chips.appendChild(el('span', 'hf-chip', formatBytes(model.bytes)))
  if (model.parameterCount) {
    // MoE 要同時講總參數與激活參數：只講總量會讓人以為它跟同樣大小的 dense 一樣慢
    const total = formatParams(model.parameterCount)
    const active = model.isMoe && model.activeParams ? formatParams(model.activeParams) : ''
    chips.appendChild(el('span', 'hf-chip', active ? `${total}（激活 ${active}）` : total))
  }
  if (model.isMoe) chips.appendChild(el('span', 'hf-chip', `MoE ${model.expertUsedCount}/${model.expertCount}`))
  if (model.multimodal) chips.appendChild(el('span', 'hf-chip', '多模態'))
  if (model.contextTrain) chips.appendChild(el('span', 'hf-chip', `ctx 上限 ${model.contextTrain}`))
  if (model.plan) {
    const level = FEASIBILITY[model.plan.feasibility] || FEASIBILITY.no
    chips.appendChild(el('span', `hf-chip ${level.cls}`, level.text))
  }
  if (model.meta?.hasFit) chips.appendChild(el('span', 'hf-chip', '已實測'))
  title.appendChild(chips)
  head.appendChild(title)

  const status = el('span', `hf-status ${model.loaded ? 'is-on' : ''}`, model.loaded ? '已載入' : '未載入')
  head.appendChild(status)
  card.appendChild(head)

  if (model.plan?.warnings?.length) {
    card.appendChild(el('p', 'hf-warn', model.plan.warnings.join('　')))
  }

  // 常駐按鈕、不用 hover：觸控裝置沒有 hover，hover 才出現的操作等於沒有
  const actions = el('div', 'hf-model-actions')
  const toggle = el('button', 'btn btn-primary btn-sm', model.loaded ? '卸載' : '載入')
  toggle.type = 'button'
  toggle.addEventListener('click', () => toggleLoad(model, toggle))
  actions.appendChild(toggle)

  const params = el('button', 'btn btn-secondary btn-sm', '參數')
  params.type = 'button'
  params.addEventListener('click', () => openParams(model.id))
  actions.appendChild(params)

  const auto = el('button', 'btn btn-secondary btn-sm', '自動調參')
  auto.type = 'button'
  auto.title = '先量記憶體，再實測挑最快參數'
  auto.addEventListener('click', () => runAutoTune(model.id, auto))
  actions.appendChild(auto)

  const del = el('button', 'btn btn-secondary btn-sm', '刪除')
  del.type = 'button'
  del.addEventListener('click', () => armDelete(model, del))
  actions.appendChild(del)
  card.appendChild(actions)
  return card
}

/** 就地二次確認的計時器（每張卡各一個） */
const deleteTimers = new Map()

/**
 * 刪除不用 `window.confirm`（會擋住整個 renderer）：按鈕就地變紅勾，3 秒沒再按就收回。
 * @param {object} model @param {HTMLButtonElement} button
 */
function armDelete(model, button) {
  if (button.dataset.armed === '1') {
    clearTimeout(deleteTimers.get(model.id))
    deleteTimers.delete(model.id)
    doDelete(model)
    return
  }
  button.dataset.armed = '1'
  button.classList.add('btn-danger')
  button.textContent = '確定刪除？'
  deleteTimers.set(model.id, setTimeout(() => {
    button.dataset.armed = ''
    button.classList.remove('btn-danger')
    button.textContent = '刪除'
    deleteTimers.delete(model.id)
  }, 3000))
}

/** @param {object} model */
async function doDelete(model) {
  const done = await call(electronAPI.hfmodels.remove(model.id))
  if (done) showToast(`已刪除 ${model.id}`, 'success')
  refreshLibrary()
}

/**
 * @param {object} model @param {HTMLButtonElement} button
 */
async function toggleLoad(model, button) {
  button.disabled = true
  button.textContent = model.loaded ? '卸載中…' : '載入中…'
  if (!model.loaded) {
    const status = await call(electronAPI.hfmodels.startRuntime())
    if (!status) { button.disabled = false; button.textContent = '載入'; return }
  }
  const done = await call(model.loaded
    ? electronAPI.hfmodels.unloadModel(model.id)
    : electronAPI.hfmodels.loadModel(model.id))
  button.disabled = false
  if (done) showToast(model.loaded ? '已卸載' : '已載入，聊天的模型選單裡就有了', 'success')
  await refreshRuntimeChip()
  refreshLibrary()
}

/**
 * 一鍵自動調參：main 端先跑 fit（實際載一次模型量記憶體）再跑 bench（實測 tok/s），
 * 跑完直接套用並重啟 router。進度走 `tune-progress` 事件。
 * @param {string} id
 * @param {HTMLButtonElement} button
 */
async function runAutoTune(id, button) {
  const label = button.textContent
  button.disabled = true
  button.textContent = '調參中…'
  autoTuneTarget = id
  const result = await call(electronAPI.hfmodels.autoTune(id))
  autoTuneTarget = ''
  button.disabled = false
  button.textContent = label || '自動調參'
  if (!result) return
  showToast(result.best
    ? `已套用最快的一組：${result.best.label}`
    : '量完了，目前這組已經是最快的', 'success')
  refreshLibrary()
}

// ===== 參數彈窗 =====

/** @param {string} id */
function openParams(id) {
  const model = libraryRows.find((m) => m.id === id)
  if (!model) return
  editing = model
  const dialog = /** @type {HTMLDialogElement} */ ($('hfParamsDialog'))
  const requested = model.meta?.requested || {}

  const title = $('hfParamsTitle')
  if (title) title.textContent = `執行參數 · ${model.id}`
  const desc = $('hfParamsDesc')
  if (desc) {
    desc.textContent = model.meta?.hasFit
      ? '記憶體配置由官方 llama-fit-params 實測；留空欄位維持自動。'
      : '下面留空的欄位維持自動決定；填了就以你填的為準。'
  }
  const reasons = $('hfParamsReasons')
  if (reasons) {
    const lines = [...(model.plan?.reasons || []), ...(model.plan?.warnings || [])]
    reasons.textContent = lines.join('　')
    reasons.classList.toggle('hidden', !lines.length)
  }

  fillKvSelect('hfFieldCtk', requested.cacheTypeK, model.plan?.cacheTypeK)
  fillKvSelect('hfFieldCtv', requested.cacheTypeV, model.plan?.cacheTypeV)
  setNum('hfFieldCtx', requested.ctxSize, model.plan?.ctxSize)
  setNum('hfFieldNgl', requested.gpuLayers, model.plan?.gpuLayers)
  setNum('hfFieldThreads', requested.threads, model.plan?.threads)
  setNum('hfFieldMoe', requested.nCpuMoe, model.plan?.nCpuMoe)
  const spec = /** @type {HTMLSelectElement} */ ($('hfFieldSpec'))
  if (spec) spec.value = requested.specType ?? (model.plan?.specType || '')
  const raw = /** @type {HTMLTextAreaElement} */ ($('hfFieldRaw'))
  if (raw) raw.value = model.meta?.rawArgs || ''
  const tuneStatus = $('hfTuneStatus')
  if (tuneStatus) tuneStatus.textContent = ''

  renderArgsPreview(model.args)
  dialog?.showModal()
}

/**
 * @param {string} id @param {unknown} value @param {unknown} auto
 */
function setNum(id, value, auto) {
  const input = /** @type {HTMLInputElement} */ ($(id))
  if (!input) return
  input.value = value === undefined || value === null || value === '' ? '' : String(value)
  input.placeholder = auto === undefined || auto === null ? '自動' : `自動：${auto}`
}

/**
 * @param {string} id @param {unknown} value @param {unknown} auto
 */
function fillKvSelect(id, value, auto) {
  const select = /** @type {HTMLSelectElement} */ ($(id))
  if (!select) return
  select.replaceChildren()
  const autoOption = document.createElement('option')
  autoOption.value = ''
  autoOption.textContent = auto ? `自動（${auto}）` : '自動'
  select.appendChild(autoOption)
  for (const type of KV_TYPES) {
    const option = document.createElement('option')
    option.value = type
    option.textContent = type
    select.appendChild(option)
  }
  select.value = typeof value === 'string' ? value : ''
}

/** @param {Record<string, string>} args */
function renderArgsPreview(args) {
  const pre = $('hfParamsPreview')
  if (!pre) return
  const entries = Object.entries(args || {})
  pre.textContent = entries.length
    ? entries.map(([k, v]) => `--${k} ${v}`).join(' ')
    : '（沒有額外參數，全部交給 llama.cpp 預設）'
}

/**
 * @returns {{ requested: object, rawArgs: string }}
 */
function readParamsForm() {
  /** @type {Record<string, any>} */
  const requested = {}
  const num = (id, key) => {
    const value = /** @type {HTMLInputElement} */ ($(id))?.value.trim()
    if (value) requested[key] = Number(value)
  }
  num('hfFieldCtx', 'ctxSize')
  num('hfFieldNgl', 'gpuLayers')
  num('hfFieldThreads', 'threads')
  num('hfFieldMoe', 'nCpuMoe')
  const ctk = /** @type {HTMLSelectElement} */ ($('hfFieldCtk'))?.value
  const ctv = /** @type {HTMLSelectElement} */ ($('hfFieldCtv'))?.value
  if (ctk) requested.cacheTypeK = ctk
  if (ctv) requested.cacheTypeV = ctv
  const spec = /** @type {HTMLSelectElement} */ ($('hfFieldSpec'))
  // 投機解碼「關閉」是有意義的選擇（不是「沒填」），所以一律送
  if (spec) requested.specType = spec.value
  return {
    requested,
    rawArgs: /** @type {HTMLTextAreaElement} */ ($('hfFieldRaw'))?.value || ''
  }
}

async function saveParams() {
  if (!editing) return
  const button = /** @type {HTMLButtonElement} */ ($('hfParamsSaveBtn'))
  button.disabled = true
  const patch = readParamsForm()
  const done = await call(electronAPI.hfmodels.updateSettings(editing.id, patch))
  button.disabled = false
  if (!done) return
  showToast('已套用（router 已重新啟動）', 'success')
  closeParams()
  refreshLibrary()
}

function closeParams() {
  // cast 一定要先接成變數再用：JSDoc 型別轉換後面接一行以 `(` 開頭的敘述，
  // 會被 ASI 併成「把上一行的值當函式呼叫」（這裡就變成 `null(...)`）。
  const dialog = /** @type {HTMLDialogElement | null} */ ($('hfParamsDialog'))
  editing = null
  dialog?.close()
}

async function resetParams() {
  if (!editing) return
  const done = await call(electronAPI.hfmodels.updateSettings(editing.id, { requested: {}, rawArgs: '' }))
  if (!done) return
  showToast('已還原成自動決定', 'success')
  closeParams()
  refreshLibrary()
}

async function runFit() {
  if (!editing) return
  const status = $('hfTuneStatus')
  const button = /** @type {HTMLButtonElement} */ ($('hfFitBtn'))
  button.disabled = true
  if (status) status.textContent = '正在量記憶體…（一兩分鐘）'
  const result = await call(electronAPI.hfmodels.refreshFit(editing.id))
  button.disabled = false
  if (status) {
    status.textContent = result
      ? `量到了：ctx ${result.ctxSize}、GPU 層數 ${result.gpuLayers}`
      : '偵測不出來，維持原本的估算'
  }
  await refreshLibrary()
  const fresh = libraryRows.find((m) => m.id === editing?.id)
  if (fresh) { editing = fresh; renderArgsPreview(fresh.args) }
}

async function runAutoTuneFromDialog() {
  if (!editing) return
  const button = /** @type {HTMLButtonElement} */ ($('hfAutoTuneBtn'))
  const status = $('hfTuneStatus')
  if (status) status.textContent = '量記憶體＋實測速度…（好幾分鐘）'
  const id = editing.id
  await runAutoTune(id, button)
  const fresh = libraryRows.find((m) => m.id === id)
  if (fresh) { editing = fresh; renderArgsPreview(fresh.args) }
}

async function runTune() {
  if (!editing) return
  const status = $('hfTuneStatus')
  const button = /** @type {HTMLButtonElement} */ ($('hfTuneBtn'))
  button.disabled = true
  if (status) status.textContent = '準備中…'
  const result = await call(electronAPI.hfmodels.tune(editing.id))
  button.disabled = false
  if (!result) { if (status) status.textContent = '調校失敗'; return }
  if (status) {
    const rows = (result.results || []).map((r) => `${r.label} ${r.tps ? r.tps.toFixed(1) : '—'} tok/s`)
    status.textContent = result.best
      ? `最快：${result.best.label}（已套用）　${rows.join('・')}`
      : `目前這組已經是最快的　${rows.join('・')}`
  }
  await refreshLibrary()
  const fresh = libraryRows.find((m) => m.id === editing?.id)
  if (fresh) { editing = fresh; renderArgsPreview(fresh.args) }
}

// ===== 執行環境 =====

async function refreshRuntimeChip() {
  const dot = $('hfRuntimeDot')
  const text = $('hfRuntimeText')
  const toggle = /** @type {HTMLButtonElement} */ ($('hfRuntimeToggle'))
  const status = await call(electronAPI.hfmodels.runtimeStatus(), { quiet: true })
  const running = !!status?.running
  if (dot) dot.classList.toggle('is-on', running)
  if (text) text.textContent = running ? `執行中 · 埠 ${status.port}` : '未啟動'
  if (toggle) toggle.textContent = running ? '停止' : '啟動'
  return running
}

async function toggleRuntime() {
  const toggle = /** @type {HTMLButtonElement} */ ($('hfRuntimeToggle'))
  toggle.disabled = true
  const running = !!(await call(electronAPI.hfmodels.runtimeStatus(), { quiet: true }))?.running
  await call(running ? electronAPI.hfmodels.stopRuntime() : electronAPI.hfmodels.startRuntime())
  toggle.disabled = false
  await refreshRuntimeChip()
  refreshLibrary()
}

async function refreshHardware() {
  const specs = $('hfHardwareSpecs')
  const list = $('hfRuntimeList')
  const data = await call(electronAPI.hfmodels.hardware())
  if (!data) return

  if (specs) {
    specs.replaceChildren()
    const rows = [
      ['推論後端', data.runtime?.ready ? data.runtime.backend : '尚未安裝'],
      ['CPU 執行緒', String(data.cpu?.cores || '—')],
      ['系統記憶體', data.cpu?.totalMemoryMiB ? `${Math.round(data.cpu.totalMemoryMiB / 1024)} GB` : '—'],
      ['NVIDIA 驅動', data.nvidia?.driver || '（沒有偵測到）']
    ]
    for (const device of data.devices || []) {
      rows.push([`裝置 ${device.id}`, `${device.name}　${device.freeMiB}／${device.totalMiB} MiB 可用`])
    }
    if (!data.devices?.length) rows.push(['GPU 裝置', '沒有可用的 GPU 後端（會用 CPU 推論）'])
    for (const [label, value] of rows) {
      const group = el('div')
      group.appendChild(el('dt', '', label))
      // 空的 <dd> 沒有 inline content，grid item 高度會是 0、整列在版面上塌掉
      group.appendChild(el('dd', '', value || '—'))
      specs.appendChild(group)
    }
  }

  installable = data.installable || []
  if (list) {
    list.replaceChildren(...installable.map((item) => {
      const row = el('div', 'hf-setting-row')
      const textWrap = el('div', 'hf-setting-text')
      textWrap.appendChild(el('span', 'hf-setting-label', item.label))
      textWrap.appendChild(el('span', 'setting-hint',
        `${formatBytes(item.totalBytes)}${item.recommended ? '　· 這台建議用這個' : ''}`))
      row.appendChild(textWrap)
      const state = el('span', `hf-chip ${item.downloaded ? 'is-good' : ''}`,
        item.downloaded ? '已安裝' : '未安裝')
      row.appendChild(state)
      if (!item.downloaded) {
        const install = el('button', 'btn btn-secondary btn-sm', '安裝')
        install.type = 'button'
        install.dataset.runtime = item.key
        install.addEventListener('click', () => installRuntime(item, install))
        row.appendChild(install)
      }
      return row
    }))
  }

  const autoBtn = /** @type {HTMLButtonElement} */ ($('hfAutoInstallBtn'))
  const autoHint = $('hfAutoInstallHint')
  const best = installable.find((item) => item.recommended) || installable[0]
  if (autoBtn) {
    autoBtn.disabled = !best || !!best.downloaded
    autoBtn.textContent = best?.downloaded ? '已是最佳配置' : '一鍵安裝最佳配置'
  }
  if (autoHint) {
    autoHint.textContent = !best
      ? ''
      : best.downloaded
        ? `目前用的是 ${best.label}`
        : `會裝 ${best.label}（${formatBytes(best.totalBytes)}）：${data.nvidia?.cudaReady
          ? '偵測到夠新的 NVIDIA 驅動，CUDA 版比較快'
          : '沒有偵測到夠新的 NVIDIA 驅動，Vulkan 版任何顯示卡都能跑'}`
  }

  const dirText = $('hfModelsDirText')
  if (dirText) dirText.textContent = data.modelsDir || '—'
  const max = /** @type {HTMLInputElement} */ ($('hfModelsMax'))
  if (max) max.value = String(data.modelsMax || 2)
  const token = /** @type {HTMLInputElement} */ ($('hfTokenInput'))
  if (token) token.placeholder = data.hasToken ? '（已設定，重填會覆蓋）' : 'hf_…'
}

/**
 * 執行環境走既有的 `models:download`（跟設定頁的本地模型同一條下載路徑，
 * 含續傳、解壓縮與取消）；這裡只負責選哪一顆與顯示進度。
 * @param {{ key: string, label: string }} item
 * @param {HTMLButtonElement} button
 */
async function installRuntime(item, button) {
  if (installingRuntime) { showToast('已經有一個執行環境在安裝中', 'error'); return }
  installingRuntime = item.key
  button.disabled = true
  button.textContent = '下載中…'
  try {
    await electronAPI.models.download(item.key)
    showToast(`已安裝 ${item.label}`, 'success')
  } catch (error) {
    showError(String(error?.message || '執行環境下載失敗'))
    button.disabled = false
    button.textContent = '安裝'
  } finally {
    installingRuntime = ''
  }
  await refreshHardware()
  await refreshRuntimeChip()
}

/** 一鍵：挑這台建議的那一顆裝下去 */
async function autoInstallRuntime() {
  const button = /** @type {HTMLButtonElement} */ ($('hfAutoInstallBtn'))
  const best = installable.find((item) => item.recommended) || installable[0]
  if (!best || best.downloaded) return
  await installRuntime(best, button)
}

async function chooseDir() {
  const data = await call(electronAPI.hfmodels.chooseDir())
  if (!data) return
  const dirText = $('hfModelsDirText')
  if (dirText) dirText.textContent = data.dir
  showToast('已換模型資料夾（舊模型留在原地）', 'success')
  await refreshRuntimeChip()
  refreshLibrary()
}

async function saveToken() {
  const input = /** @type {HTMLInputElement} */ ($('hfTokenInput'))
  const data = await call(electronAPI.hfmodels.setToken(input?.value || ''))
  if (!data) return
  if (input) {
    input.value = ''
    input.placeholder = data.hasToken ? '（已設定，重填會覆蓋）' : 'hf_…'
  }
  showToast(data.hasToken ? '已儲存 Token' : '已清除 Token', 'success')
}

// ===== 事件 =====

/**
 * @param {{ type: string, [k: string]: any }} payload
 */
function onEvent(payload) {
  if (payload?.type === 'install-progress') {
    const state = progress.get(payload.id)
    if (state && payload.total > 0) {
      const pct = Math.min(100, Math.round((payload.received / payload.total) * 100))
      state.fill.style.width = `${pct}%`
      state.button.textContent = `下載中 ${pct}%`
    }
    return
  }
  if (payload?.type === 'install-failed') showError(String(payload.message || '下載失敗'))
  if (payload?.type === 'tune-progress') {
    const status = $('hfTuneStatus')
    if (status) {
      status.textContent = payload.tps === undefined
        ? `量測中（${payload.index + 1}/${payload.total}）：${payload.label}`
        : `${payload.label} → ${payload.tps ? payload.tps.toFixed(1) : '—'} tok/s`
    }
  }
}

function bindSubtabs() {
  const tabs = document.querySelectorAll('#hfSubtabs .subtab')
  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      const key = /** @type {HTMLElement} */ (tab).dataset.subtab
      for (const other of tabs) {
        const on = other === tab
        other.classList.toggle('active', on)
        other.setAttribute('aria-selected', String(on))
      }
      for (const panel of document.querySelectorAll('#page-hfmodels .subtab-panel')) {
        panel.classList.toggle('active', /** @type {HTMLElement} */ (panel).dataset.subtab === key)
      }
      if (key === 'library') refreshLibrary()
      if (key === 'runtime') refreshHardware()
    })
  }
}

/**
 * 進頁時呼叫（`app.js` 的 switchPage）
 */
export function start() {
  if (!started) {
    started = true
    bindSubtabs()
    $('hfSearchBtn')?.addEventListener('click', runSearch)
    $('hfSearchInput')?.addEventListener('input', scheduleSearch)
    $('hfSearchInput')?.addEventListener('keydown', (event) => {
      if (/** @type {KeyboardEvent} */ (event).key === 'Enter') { clearTimeout(searchTimer); runSearch() }
    })
    $('hfSearchSort')?.addEventListener('change', runSearch)
    $('hfRuntimeToggle')?.addEventListener('click', toggleRuntime)
    $('hfRescanBtn')?.addEventListener('click', async () => {
      const rows = await call(electronAPI.hfmodels.rescan())
      if (rows) { libraryRows = rows; refreshLibrary(); showToast('已重新掃描', 'success') }
    })
    $('hfOpenFolderBtn')?.addEventListener('click', () => call(electronAPI.hfmodels.openFolder()))
    $('hfImportBtn')?.addEventListener('click', async () => {
      const result = await call(electronAPI.hfmodels.import())
      if (result) { showToast(`已匯入 ${result.id}`, 'success'); refreshLibrary() }
    })
    $('hfChooseDirBtn')?.addEventListener('click', chooseDir)
    $('hfTokenSaveBtn')?.addEventListener('click', saveToken)
    $('hfModelsMax')?.addEventListener('change', async (event) => {
      const value = Number(/** @type {HTMLInputElement} */ (event.target).value) || 2
      await electronAPI.store.set('hfModelsMax', Math.max(1, Math.min(8, value)))
      await call(electronAPI.hfmodels.applyPresets(), { quiet: true })
    })
    $('hfParamsSaveBtn')?.addEventListener('click', saveParams)
    $('hfParamsCancelBtn')?.addEventListener('click', closeParams)
    $('hfParamsResetBtn')?.addEventListener('click', resetParams)
    $('hfAutoInstallBtn')?.addEventListener('click', autoInstallRuntime)
    $('hfAutoTuneBtn')?.addEventListener('click', runAutoTuneFromDialog)
    $('hfFitBtn')?.addEventListener('click', runFit)
    $('hfTuneBtn')?.addEventListener('click', runTune)
    unsubscribe = electronAPI.hfmodels.onEvent(onEvent)
    unsubscribeModels = electronAPI.models.onProgress((payload) => {
      if (!installingRuntime || payload?.key !== installingRuntime) return
      const button = document.querySelector(`#hfRuntimeList [data-runtime="${installingRuntime}"]`)
      const pct = payload.totalBytes > 0
        ? Math.round((payload.receivedBytes / payload.totalBytes) * 100)
        : 0
      if (button) button.textContent = payload.stage || `下載中 ${pct}%`
    })
    runSearch()
  }
  refreshRuntimeChip()
  refreshLibrary()
}

/**
 * 離頁時呼叫。**不關 router**：聊天要用它，關掉等於每次切頁都把模型卸載一次。
 */
export function stop() {
  clearTimeout(searchTimer)
}

/** 視窗要關了才真的收（`app.js` 沒有這個時機時就不呼叫） */
export function dispose() {
  unsubscribe?.()
  unsubscribe = null
  unsubscribeModels?.()
  unsubscribeModels = null
}
