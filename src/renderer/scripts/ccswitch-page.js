/**
 * Claude Code 工作台頁（renderer）。
 *
 * 三個子分頁：供應商切換／MCP 伺服器／CLI 版本。端點、檔案路徑與 npm 套件名都在
 * main 的固定表；上游／驗證格式由使用者在供應商彈窗選擇，這裡只送受限的格式值。
 *
 * DOM 全程 `createElement` ＋ `textContent`，零 innerHTML（跟 `markdown.js` 同一條規矩）。
 * 刪除是就地二次確認（跟聊天側欄一樣），不用 `window.confirm`——原生彈窗會擋住整個 App。
 */

import { syncCustomSelects } from './custom-select.js'
import { createGridReorder } from './grid-reorder.js'

const electronAPI = window.electronAPI

/** 二次確認的復原時間 */
const DELETE_ARM_MS = 3000

let bound = false
let activeSubtab = 'providers'
/** @type {{ presets: Array<object>, mcpTemplates: Array<object>, gateway: boolean } | null} */
let catalog = null
/** @type {Array<object>} */
let providers = []
let currentId = ''
let activeId = ''
/** @type {Array<object>} */
let mcpServers = []
/** @type {Array<object>} */
let versions = []
/** 目前正在編輯哪一筆（空字串＝新增） */
let editingProviderId = ''
let editingMcpId = ''
/** @type {object | null} */
let gateway = null
/** @type {{ btn: HTMLElement, timer: number } | null} */
let armed = null
/** 在本 App 登入過的 ChatGPT／xAI 帳號（不含 token） */
/** @type {Array<object>} */
let accounts = []
/** 登入輪詢的計時器；開新流程或關彈窗一定要收掉 */
let loginTimer = 0
let loginProvider = ''

// ===== 共用小工具 =====

/**
 * 走一次 IPC。main 回的是 `{ ok, data }`／`{ ok, error }`，錯誤訊息已經過白名單。
 * @template T
 * @param {Promise<{ ok: boolean, data?: T, error?: { message: string } }>} promise
 * @param {string} fallback
 * @returns {Promise<T>}
 */
async function call(promise, fallback) {
  const result = await promise
  if (!result?.ok) {
    const message = result?.error?.message || fallback
    showError(message)
    throw new Error(message)
  }
  hideError()
  return result.data
}

function showError(message) {
  const el = document.getElementById('ccError')
  if (!el) return
  el.textContent = message
  el.classList.remove('hidden')
}

function hideError() {
  document.getElementById('ccError')?.classList.add('hidden')
}

/**
 * @param {string} message
 */
function showStatus(message) {
  const el = document.getElementById('ccStatus')
  if (!el) return
  el.textContent = message
  el.classList.toggle('hidden', !message)
}

/**
 * @param {string} tag
 * @param {string} className
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/**
 * 就地二次確認：第一次按變成待確認，3 秒內再按一次才真的執行。
 * @param {HTMLButtonElement} btn
 * @param {() => void} onConfirm
 */
function armDelete(btn, onConfirm) {
  if (armed?.btn === btn) {
    disarmDelete()
    onConfirm()
    return
  }
  disarmDelete()
  btn.classList.add('is-armed')
  btn.textContent = '✓'
  btn.title = '再按一次確認刪除'
  armed = { btn, timer: window.setTimeout(disarmDelete, DELETE_ARM_MS) }
}

/** 重畫清單前一定要先呼叫，否則計時器會對著已經不存在的節點跑 */
function disarmDelete() {
  if (!armed) return
  window.clearTimeout(armed.timer)
  armed.btn.classList.remove('is-armed')
  armed.btn.textContent = '🗑'
  armed.btn.title = '刪除'
  armed = null
}

/**
 * @param {string} label
 * @param {string} title
 * @param {() => void} onClick
 * @returns {HTMLButtonElement}
 */
function iconButton(label, title, onClick) {
  const btn = /** @type {HTMLButtonElement} */ (el('button', 'cc-icon-btn', label))
  btn.type = 'button'
  btn.title = title
  btn.setAttribute('aria-label', title)
  btn.addEventListener('click', onClick)
  return btn
}

/**
 * @param {unknown} id
 * @returns {object | null}
 */
function presetById(id) {
  return catalog?.presets.find((preset) => preset.id === id) || null
}

// ===== 子分頁 =====

/**
 * @param {'providers'|'mcp'|'version'} name
 */
function showSubtab(name) {
  activeSubtab = name
  document.querySelectorAll('#ccSubtabs .subtab').forEach((btn) => {
    const on = btn.dataset.subtab === name
    btn.classList.toggle('active', on)
    btn.setAttribute('aria-selected', on ? 'true' : 'false')
  })
  document.querySelectorAll('#page-ccswitch .subtab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.subtab === name)
  })
  if (name === 'mcp') void reloadMcp()
  if (name === 'version') void reloadVersions()
}

// ===== 供應商 =====

/** 閘道狀態與單一手動開關。 */
async function reloadGateway() {
  const host = document.getElementById('ccGateway')
  if (!host) return
  host.classList.remove('hidden')

  try {
    gateway = await call(electronAPI.ccswitch.gatewayStatus(), '讀取閘道狀態失敗')
  } catch {
    return
  }
  const text = document.getElementById('ccGatewayText')
  const btn = /** @type {HTMLButtonElement} */ (document.getElementById('ccGatewayToggleBtn'))
  btn?.setAttribute('aria-checked', gateway.running ? 'true' : 'false')
  if (text) {
    const missing = []
    if (!gateway.credentials?.codex) missing.push('Codex')
    if (!gateway.credentials?.grok) missing.push('Grok')
    text.textContent = gateway.running
      ? `已開啟 · ${gateway.baseUrl}${missing.length ? ` · ${missing.join('、')} 尚未登入 CLI` : ''}`
      : '已關閉 · 需要轉換格式時請先手動開啟'
  }
}

async function toggleGateway() {
  const btn = /** @type {HTMLButtonElement} */ (document.getElementById('ccGatewayToggleBtn'))
  if (btn) btn.disabled = true
  try {
    gateway = await call(
      gateway?.running ? electronAPI.ccswitch.stopGateway() : electronAPI.ccswitch.startGateway(),
      '切換閘道失敗'
    )
    await reloadProviders()
  } catch {
    await reloadGateway()
  } finally {
    if (btn) btn.disabled = false
  }
}

async function reloadProviders() {
  const data = await call(electronAPI.ccswitch.listProviders(), '讀取供應商清單失敗')
  // 列表要顯示「這一筆綁了誰」，所以帳號清單也要跟著更新
  await reloadAccounts()
  providers = Array.isArray(data?.providers) ? data.providers : []
  currentId = data?.currentId || ''
  activeId = data?.activeId || ''
  const pathEl = document.getElementById('ccLivePath')
  if (pathEl) {
    pathEl.textContent = data?.settingsExists
      ? `設定檔：${data.settingsPath}`
      : `設定檔尚未建立，第一次切換時會產生：${data?.settingsPath || ''}`
  }
  // currentId 有值但 activeId 空＝設定檔被別的工具或使用者手改過
  showStatus(currentId && !activeId
    ? 'settings.json 目前的 Base URL 跟記錄的供應商對不上，可能被其他工具改過。再按一次「切換」就會寫回來。'
    : '')
  renderProviders()
  await reloadGateway()
  // 閘道狀態會影響「需要閘道」那個標記，拿到之後重畫一次
  renderProviders()
}

function renderProviders() {
  const list = document.getElementById('ccProviderList')
  if (!list) return
  disarmDelete()
  list.replaceChildren()

  // 次序就是 store 的陣列順序（拖曳會寫回去），「＋」固定收在最後
  for (const item of providers) list.append(providerTile(item))
  list.append(addTile())
}

/** 拖曳排序：跟額度儀錶板同一套（跟手 overlay ＋ 鬼影，放開才改 DOM） */
const tileReorder = createGridReorder({
  getList: () => document.getElementById('ccProviderList'),
  itemSelector: '.cc-tile:not(.is-add)',
  ignoreSelector: 'button, input, a',
  onCommit: (ids) => {
    if (!ids.length) return
    // 本地先跟上，避免下一次 render 用舊順序把畫面彈回去
    providers = ids.map((id) => providers.find((item) => item.id === id)).filter(Boolean)
    void call(electronAPI.ccswitch.reorderProviders(ids), '儲存供應商順序失敗')
  }
})

/**
 * 這一筆的第二行：走哪條路、憑證從哪來。兩件事都是使用者按下去之前想知道的，
 * 而且**不能只靠 hover 才顯示**（hover 在觸控裝置上不存在）。
 * @param {object} item
 * @param {object | null} preset
 * @returns {{ text: string, warn: boolean }}
 */
function tileMeta(item, preset) {
  if (preset?.auth === 'none') return { text: '不動任何 env · 用你原本的登入', warn: false }
  // 路由是 main 算好的（自訂那筆看協議，內建看表），renderer 不自己推
  const route = item.route === 'gateway' ? '需轉換閘道' : '直連'
  const format = API_FORMAT_LABELS[item.apiFormat]?.label?.replace('（直連）', '') || item.apiFormat
  const auth = preset?.auth === 'cli'
    ? (item.oauthAccountId ? '已登入帳號' : '用 CLI 憑證')
    : item.hasKey ? `金鑰 ····${item.keyTail}` : '尚未填金鑰'
  const warn = (preset?.auth === 'key' && !item.hasKey) ||
    (item.route === 'gateway' && !gateway?.running)
  return { text: `${route} · ${format} · ${auth}`, warn }
}

/**
 * 一張供應商 tile：上面是名稱與狀態，底下一列**常駐**的「啟用／編輯」兩顆實體按鈕
 * （再加一顆刪除，只在刪得掉時出現）。
 *
 * 以前整片卡片是切換鈕、編輯只在 hover 時浮出來——點哪裡會發生什麼事看不出來，
 * 而且觸控裝置根本沒有 hover。現在兩個動作各自有自己的按鈕與可見標籤。
 * @param {object} item
 * @returns {HTMLElement}
 */
function providerTile(item) {
  const preset = presetById(item.presetId)
  const isActive = item.id === activeId
  const tile = el('div', 'cc-tile')
  tile.setAttribute('role', 'listitem')
  tile.dataset.id = item.id
  if (isActive) tile.classList.add('is-active')
  tile.tabIndex = 0
  tile.addEventListener('pointerdown', tileReorder.onPointerDown)
  tile.addEventListener('keydown', tileReorder.onKeydown)

  const body = el('div', 'cc-tile-body')
  const head = el('div', 'cc-tile-head')
  head.append(el('span', 'cc-tile-name', item.name))
  if (isActive) head.append(el('span', 'cc-badge is-active', '使用中'))
  body.append(head)
  const meta = tileMeta(item, preset)
  body.append(el('span', `cc-tile-meta${meta.warn ? ' is-warn' : ''}`, meta.text))
  tile.append(body)

  const actions = el('div', 'cc-tile-actions')
  const missingKey = preset?.auth === 'key' && !item.hasKey
  // 使用中的那張不放按鈕：一顆按不下去的灰色「使用中」只是重複右上角的徽章
  if (!isActive) {
    const use = /** @type {HTMLButtonElement} */ (
      el('button', 'btn btn-sm btn-primary cc-tile-switch', '啟用')
    )
    use.type = 'button'
    use.setAttribute('aria-label', `啟用 ${item.name}`)
    use.title = missingKey ? '還沒填金鑰，按了會先帶你去填' : `切換到 ${item.name}`
    use.addEventListener('click', () => {
      // 缺金鑰的直接帶去填，不要送 IPC 再吃一次 MISSING_API_KEY
      if (missingKey) {
        openProviderDialog(item.id)
        field('ccKeyInput').focus()
        return
      }
      void activateProvider(item.id)
    })
    actions.append(use)
  }

  if (preset?.auth !== 'none') {
    const test = /** @type {HTMLButtonElement} */ (el('button', 'btn btn-secondary btn-sm cc-tile-test', '測試'))
    test.type = 'button'
    test.setAttribute('aria-label', `測試 ${item.name} 上游`)
    test.title = `用${API_FORMAT_LABELS[item.validationFormat]?.label || '驗證格式'}測試上游`
    test.addEventListener('click', () => void testProvider(item.id, test))
    actions.append(test)
  }

  const edit = /** @type {HTMLButtonElement} */ (el('button', 'btn btn-secondary btn-sm cc-tile-edit', '編輯'))
  edit.type = 'button'
  edit.setAttribute('aria-label', `編輯 ${item.name}`)
  edit.addEventListener('click', () => openProviderDialog(item.id))
  actions.append(edit)

  // 內建那幾家刪到剩最後一筆會被 main 擋（守衛在 main）；UI 只在「刪得掉」時放鈕：
  // 自訂一律可刪，內建要同一家有第二筆（舊資料會有）才出現
  const deletable = item.presetId === 'custom' ||
    providers.filter((entry) => entry.presetId === item.presetId).length > 1
  if (deletable) {
    const delBtn = iconButton('🗑', `刪除 ${item.name}`, () => armDelete(delBtn, () => void deleteProvider(item.id)))
    actions.append(delBtn)
  }
  tile.append(actions)
  return tile
}

/** 「＋」那一格：唯一的新增入口，新增的都是自訂供應商 */
function addTile() {
  const tile = el('div', 'cc-tile is-add')
  tile.setAttribute('role', 'listitem')
  const main = /** @type {HTMLButtonElement} */ (el('button', 'cc-tile-main', '＋'))
  main.type = 'button'
  main.title = '新增自訂供應商'
  main.setAttribute('aria-label', '新增自訂供應商')
  main.addEventListener('click', () => openProviderDialog())
  tile.append(main)
  return tile
}

/**
 * @param {string} id
 */
async function activateProvider(id) {
  try {
    const item = providers.find((entry) => entry.id === id)
    const official = presetById(item?.presetId)?.auth === 'none'
    await call(electronAPI.ccswitch.activateProvider(id), '切換供應商失敗')
    await reloadProviders()
    showStatus(official
      ? '已把本工作台寫進 settings.json 的 env 清掉，回到官方登入（你自己的其他設定沒有動）。已經開著的 Claude Code 要重開才會生效。'
      : item?.route === 'gateway'
        ? '已寫入 settings.json。這一家需要轉換閘道；若閘道尚未開啟，請先按上方開關。已經開著的 Claude Code 要重開才會吃到新設定。'
        : '這一家直連、不需要閘道，已寫入 settings.json。已經開著的 Claude Code 要重開才會吃到新設定。')
  } catch {
    // call() 已經顯示訊息
  }
}

/**
 * 測試已儲存的供應商；只顯示 HTTP 狀態與自家固定摘要，不顯示上游 response body。
 * @param {string} id
 * @param {HTMLButtonElement} btn
 */
async function testProvider(id, btn) {
  const item = providers.find((entry) => entry.id === id)
  const original = btn.textContent
  btn.disabled = true
  btn.textContent = '測試中…'
  try {
    const result = await call(electronAPI.ccswitch.testProvider(id), '測試上游失敗')
    const format = API_FORMAT_LABELS[result?.format]?.label || result?.format || '未知格式'
    if (result?.responded) {
      const state = result.ok ? '連線成功' : (result.error || `已回應 HTTP ${result.status}`)
      showStatus(`${item?.name || '供應商'}：${state} · ${format} · ${result.url || ''}`)
    } else {
      showStatus(`${item?.name || '供應商'}：${result?.error || '沒有收到回應'}`)
    }
  } catch {
    // call() 已經顯示訊息
  } finally {
    btn.disabled = false
    btn.textContent = original
  }
}

/**
 * @param {string} id
 */
async function deleteProvider(id) {
  try {
    await call(electronAPI.ccswitch.deleteProvider(id), '刪除供應商失敗')
    await reloadProviders()
  } catch {
    // call() 已經顯示訊息
  }
}

// ===== 供應商彈窗 =====

/**
 * @param {string} [id] 空＝新增（新增的都是自訂供應商）
 */
function openProviderDialog(id = '') {
  const dialog = /** @type {HTMLDialogElement} */ (document.getElementById('ccProviderDialog'))
  if (!dialog || !catalog) return
  editingProviderId = id
  const item = id ? providers.find((entry) => entry.id === id) : null
  const nameInput = /** @type {HTMLInputElement} */ (document.getElementById('ccNameInput'))
  const keyInput = /** @type {HTMLInputElement} */ (document.getElementById('ccKeyInput'))

  document.getElementById('ccProviderDialogTitle').textContent = item ? '編輯供應商' : '新增自訂供應商'

  nameInput.value = item?.name || ''
  keyInput.value = ''
  field('ccBaseUrlInput').value = item?.baseUrl || ''
  // 每次開都歸位：不重設的話上一次編輯留下的協議會被新的一筆沿用。
  // 一定要先把選項建好——空的 select 設 value 是沒有作用的。
  ensureApiFormatOptions().value = item?.apiFormat || dialogPreset()?.apiFormat || 'anthropic'
  ensureFormatOptions('ccValidationFormatSelect').value =
    item?.validationFormat || dialogPreset()?.validationFormat || item?.apiFormat || 'anthropic'
  // 模型四格歸位成下拉模式；值先進 input，再由 rebuild 建選項
  modelManual = false
  applyModelMode()
  for (const cell of MODEL_FIELDS) field(cell.input).value = item?.[cell.key] || ''
  rebuildModelSelects(null)
  // 上一次沒關乾淨的登入輪詢會對著已經換掉的欄位跑
  stopLoginPoll()
  showLoginWait(false)
  const accountSelect = /** @type {HTMLSelectElement} */ (document.getElementById('ccAccountSelect'))
  accountSelect.value = item?.oauthAccountId || ''
  syncProviderDialogFields()
  dialog.showModal()
  syncCustomSelects()
  void reloadAccounts().then(() => {
    const flow = oauthFlowFor(dialogPreset())
    if (!flow) return
    renderAccounts(flow)
    accountSelect.value = item?.oauthAccountId || ''
    syncCustomSelects()
  })
  // 編輯時順手掃一次模型清單；失敗不吵，手動按鈕會講原因
  void autoScanModels()
}

/** 這次彈窗的對象走哪家 preset（新增＝自訂）。preset 一律由 main 的表決定 */
function dialogPreset() {
  const item = editingProviderId ? providers.find((entry) => entry.id === editingProviderId) : null
  return presetById(item ? item.presetId : 'custom')
}

/** 三種格式的說明；`route` 是選了上游格式之後這一筆會怎麼走 */
const API_FORMAT_LABELS = Object.freeze({
  anthropic: { label: 'Anthropic Messages（直連）', route: 'direct' },
  openai_chat: { label: 'OpenAI Chat Completions', route: 'gateway' },
  openai_responses: { label: 'OpenAI Responses', route: 'gateway' }
})

/** 四個等級的模型欄位：select（下拉）與 input（手動）各一格，值共用 */
const MODEL_FIELDS = Object.freeze([
  { select: 'ccModelSelect', input: 'ccModelInput', key: 'model' },
  { select: 'ccHaikuSelect', input: 'ccHaikuInput', key: 'haikuModel' },
  { select: 'ccSonnetSelect', input: 'ccSonnetInput', key: 'sonnetModel' },
  { select: 'ccOpusSelect', input: 'ccOpusInput', key: 'opusModel' }
])

/** 模型四格目前用什麼輸入：false＝下拉（掃描結果）、true＝手動輸入 */
let modelManual = false

/** 模型那格現在的值（看目前在哪個模式） */
function modelValue(cell) {
  return (modelManual ? field(cell.input) : field(cell.select)).value
}

/** 只同步顯隱與按鈕文字，不動值 */
function applyModelMode() {
  for (const cell of MODEL_FIELDS) {
    const selectEl = /** @type {HTMLSelectElement} */ (document.getElementById(cell.select))
    // 要收的是 custom-select 包出來的外層，藏原生 select 只會留下一顆孤兒觸發鈕
    ;(selectEl.closest('.custom-select') || selectEl).classList.toggle('hidden', modelManual)
    field(cell.input).classList.toggle('hidden', !modelManual)
  }
  document.getElementById('ccManualModelsBtn').textContent = modelManual ? '改用下拉' : '手動輸入'
}

/** 下拉↔手動切換，值會帶過去 */
function toggleModelMode() {
  for (const cell of MODEL_FIELDS) {
    const selectEl = /** @type {HTMLSelectElement} */ (document.getElementById(cell.select))
    const inputEl = field(cell.input)
    if (modelManual) {
      inputEl.value = selectEl.value
    } else {
      ensureModelOption(selectEl, inputEl.value)
      selectEl.value = inputEl.value
    }
  }
  modelManual = !modelManual
  applyModelMode()
  syncCustomSelects()
}

/** select 沒有這個值的選項就補一個，手動填的字不能因為切回下拉就消失 */
function ensureModelOption(selectEl, value) {
  if (!value) return
  if ([...selectEl.options].some((option) => option.value === value)) return
  const option = document.createElement('option')
  option.value = value
  option.textContent = value
  selectEl.append(option)
}

/**
 * 重建四個模型下拉的選項：現值＋這家的預設＋（掃描後）整份模型清單。
 * @param {string[] | null} models
 */
function rebuildModelSelects(models) {
  const item = editingProviderId ? providers.find((entry) => entry.id === editingProviderId) : null
  const preset = dialogPreset()
  for (const cell of MODEL_FIELDS) {
    const selectEl = /** @type {HTMLSelectElement} */ (document.getElementById(cell.select))
    const current = item?.[cell.key] || ''
    const def = preset?.defaults?.[cell.key] || ''
    selectEl.replaceChildren()
    const empty = document.createElement('option')
    empty.value = ''
    empty.textContent = def ? `（預設：${def}）` : '（沿用上游預設）'
    selectEl.append(empty)
    const seen = new Set([''])
    for (const value of [current, ...(Array.isArray(models) ? models : []), def]) {
      if (!value || seen.has(value)) continue
      seen.add(value)
      const option = document.createElement('option')
      option.value = value
      option.textContent = value
      selectEl.append(option)
    }
    selectEl.value = current
  }
}

/**
 * @param {string} id
 * @returns {HTMLInputElement}
 */
function field(id) {
  return /** @type {HTMLInputElement} */ (document.getElementById(id))
}

/**
 * 格式下拉的選項是固定的，建一次就好。回傳那顆 select 讓呼叫端直接設 value——
 * 選項還沒建之前設 value 是靜默失效的。
 * @param {string} id
 * @returns {HTMLSelectElement}
 */
function ensureFormatOptions(id) {
  const select = /** @type {HTMLSelectElement} */ (document.getElementById(id))
  if (select.options.length) return select
  for (const key of catalog?.apiFormats || []) {
    const option = document.createElement('option')
    option.value = key
    option.textContent = API_FORMAT_LABELS[key]?.label || key
    select.append(option)
  }
  return select
}

function ensureApiFormatOptions() {
  return ensureFormatOptions('ccApiFormatSelect')
}

/** 依這次編輯的對象決定顯示哪些欄位、以及各欄的預設值提示 */
function syncProviderDialogFields() {
  const item = editingProviderId ? providers.find((entry) => entry.id === editingProviderId) : null
  const preset = dialogPreset()
  const isCustom = preset?.id === 'custom'
  // 官方訂閱那筆沒有上游可言（切過去＝把我們寫的 env 清掉），端點與模型兩組都收起來
  const isOfficial = preset?.auth === 'none'
  const keyInput = field('ccKeyInput')
  const baseUrlInput = field('ccBaseUrlInput')
  const authSelect = /** @type {HTMLSelectElement} */ (document.getElementById('ccAuthFieldSelect'))
  const formatSelect = ensureApiFormatOptions()
  const validationSelect = ensureFormatOptions('ccValidationFormatSelect')

  // 官方訂閱沒有要測的上游；其餘內建與 custom 都能自己選上游／驗證格式。
  document.getElementById('ccApiFormatGroup')?.classList.toggle('hidden', isOfficial)
  const apiFormat = formatSelect.value || preset?.apiFormat || 'anthropic'
  const validationFormat = validationSelect.value || preset?.validationFormat || apiFormat
  const isGateway = API_FORMAT_LABELS[apiFormat]?.route === 'gateway'
  document.getElementById('ccApiFormatHint').textContent = isGateway
    ? `${API_FORMAT_LABELS[apiFormat]?.label || apiFormat} → 需要手動開啟本機轉換閘道。`
    : `${API_FORMAT_LABELS[apiFormat]?.label || apiFormat} → 不經閘道，Claude Code 直連。`
  document.getElementById('ccValidationFormatHint').textContent =
    `測試會用 ${API_FORMAT_LABELS[validationFormat]?.label || validationFormat} 送最小請求。`

  document.getElementById('ccProviderDialogDesc').textContent = preset?.hint || ''

  // **內建預設一律不顯示端點**：那幾個位址是實測查證過的事實（走閘道的更是在閘道固定表裡，
  // 還帶專屬標頭），多一個輸入格只多一種「填錯了但看不出來」的失敗方式。
  // 自訂則是相反——它沒有預設端點，一定要填。
  document.getElementById('ccBaseUrlGroup')?.classList.toggle('hidden', !isCustom)
  document.getElementById('ccModelGroup')?.classList.toggle('hidden', isOfficial)
  baseUrlInput.placeholder = isCustom ? 'https://…（必填）' : ''
  // 兩種協議接在後面的路徑不一樣，講錯的話使用者會多填或少填一段 /v1
  document.getElementById('ccBaseUrlHint').textContent = !isCustom
    ? ''
    : isGateway
      ? '填到 /v1 為止（例：https://api.example.com/v1），後面的 /chat/completions 會自己接。只收 http(s)。'
      : '填 /v1/messages 前面那一段（例：https://api.example.com/anthropic），/v1/messages 由 Claude Code 自己接。只收 http(s)。'

  document.getElementById('ccKeyGroup')?.classList.toggle('hidden', preset?.auth !== 'key')
  keyInput.placeholder = item?.hasKey ? '已儲存，留空表示不變更' : ''
  document.getElementById('ccKeyHint').textContent = isGateway
    ? '這把金鑰交給本機閘道去用，不會寫進 settings.json。'
    : '右邊選金鑰要寫進哪個環境變數。有些端點只認 x-api-key、有些只認 Bearer，填錯會靜默 401；不確定就用預設。'

  // 閘道路由的金鑰不進 settings.json，選寫哪個 env 鍵沒有意義。
  // 要收的是 custom-select 包出來的外層，藏原生 select 只會留下一顆孤兒觸發鈕。
  ;(authSelect.closest('.custom-select') || authSelect).classList.toggle('hidden', isGateway)
  authSelect.replaceChildren()
  for (const name of catalog?.authFields || []) {
    const option = document.createElement('option')
    option.value = name
    // 只顯示去掉 ANTHROPIC_ 前綴的部分，不然這一格會被截字（完整名稱在下面那行提示）
    const short = name.replace(/^ANTHROPIC_/, '')
    option.textContent = name === preset?.keyField ? `${short}（預設）` : short
    authSelect.append(option)
  }
  authSelect.value = item?.authField || preset?.keyField || ''

  // 走 CLI 憑證那兩家改成顯示登入區：可以在這裡直接登入，也可以沿用終端機 CLI 的憑證
  const flow = oauthFlowFor(preset)
  document.getElementById('ccOauthGroup')?.classList.toggle('hidden', !flow)
  if (flow) renderAccounts(flow)

  for (const cell of MODEL_FIELDS) {
    field(cell.input).placeholder = preset?.defaults?.[cell.key] || '（沿用上游預設）'
  }
  field('ccNameInput').placeholder = preset?.name || ''
}

// ===== OAuth 登入 =====

/**
 * 這個預設支援在本 App 直接登入嗎？
 * @param {object | null} preset
 * @returns {object | null}
 */
function oauthFlowFor(preset) {
  if (!preset || preset.auth !== 'cli') return null
  return (catalog?.oauthFlows || []).find((flow) => flow.key === preset.id) || null
}

async function reloadAccounts() {
  try {
    accounts = await call(electronAPI.ccswitch.listAccounts(), '讀取登入帳號失敗')
  } catch {
    accounts = []
  }
}

/**
 * 帳號下拉 ＋ 下面那份可刪除的清單。
 * @param {object} flow
 */
function renderAccounts(flow) {
  const select = /** @type {HTMLSelectElement} */ (document.getElementById('ccAccountSelect'))
  const list = document.getElementById('ccAccountList')
  const item = editingProviderId ? providers.find((entry) => entry.id === editingProviderId) : null
  const mine = accounts.filter((account) => account.provider === flow.key)
  const previous = select.value || item?.oauthAccountId || ''

  select.replaceChildren()
  const fallback = document.createElement('option')
  fallback.value = ''
  // 沒有自己的帳號時也留這一項：只裝 CLI 不在這裡登入本來就是合法用法
  fallback.textContent = '使用已登入的 CLI 憑證'
  select.append(fallback)
  for (const account of mine) {
    const option = document.createElement('option')
    option.value = account.id
    option.textContent = account.expired ? `${account.label}（需要續期）` : account.label
    select.append(option)
  }
  select.value = mine.some((account) => account.id === previous) ? previous : ''

  list.replaceChildren()
  for (const account of mine) {
    const row = el('div', 'cc-account-row')
    row.setAttribute('role', 'listitem')
    row.dataset.id = account.id
    row.append(el('span', 'cc-account-name', account.label))
    const delBtn = iconButton('🗑', '移除這個登入帳號', () => armDelete(delBtn, () => void dropAccount(flow, account.id)))
    row.append(delBtn)
    list.append(row)
  }
  list.classList.toggle('hidden', mine.length === 0)

  document.getElementById('ccOauthHint').textContent = mine.length
    ? '切換供應商時就用選中的這個帳號；選「使用已登入的 CLI 憑證」則沿用終端機裡登入的那份。'
    : `還沒在這裡登入過。按「登入」會用 ${flow.label} 官方支援的流程；不登也可以，會沿用你終端機 CLI 的憑證。`
}

/**
 * @param {object} flow
 * @param {string} accountId
 */
async function dropAccount(flow, accountId) {
  try {
    await call(electronAPI.ccswitch.removeAccount(accountId), '移除登入帳號失敗')
    await reloadAccounts()
    renderAccounts(flow)
  } catch {
    // call() 已經顯示訊息
  }
}

/** 收掉輪詢；開新流程、關彈窗、離開頁面都要叫 */
function stopLoginPoll() {
  if (loginTimer) window.clearInterval(loginTimer)
  loginTimer = 0
}

/**
 * @param {boolean} on
 */
function showLoginWait(on) {
  document.getElementById('ccOauthWait')?.classList.toggle('hidden', !on)
}

async function startLogin() {
  const flow = oauthFlowFor(dialogPreset())
  if (!flow) return

  stopLoginPoll()
  loginProvider = flow.key
  const step = document.getElementById('ccOauthStep')
  const code = document.getElementById('ccOauthCode')
  step.textContent = '正在開始登入…'
  code.classList.add('hidden')
  showLoginWait(true)

  let started
  try {
    started = await call(electronAPI.ccswitch.beginLogin(flow.key), '開始登入失敗')
  } catch {
    showLoginWait(false)
    return
  }

  if (started.kind === 'device') {
    step.textContent = `瀏覽器已開啟 ${started.verificationUri || 'xAI 登入頁'}，請在上面輸入這組驗證碼：`
    code.textContent = started.userCode
    code.classList.remove('hidden')
  } else {
    step.textContent = '瀏覽器已開啟 ChatGPT 登入頁，登入完成後這裡會自動更新。'
    code.classList.add('hidden')
  }

  loginTimer = window.setInterval(() => void pollLogin(flow), 1500)
}

/**
 * @param {object} flow
 */
async function pollLogin(flow) {
  let state
  try {
    state = await call(electronAPI.ccswitch.loginStatus(flow.key), '查詢登入狀態失敗')
  } catch {
    stopLoginPoll()
    showLoginWait(false)
    return
  }
  if (state.status === 'waiting' || state.status === 'starting') return

  stopLoginPoll()
  if (state.status === 'done') {
    showLoginWait(false)
    await reloadAccounts()
    renderAccounts(flow)
    const select = /** @type {HTMLSelectElement} */ (document.getElementById('ccAccountSelect'))
    // 剛登進來的那個直接選起來，不要再讓使用者自己去下拉找
    const fresh = accounts.filter((account) => account.provider === flow.key).at(-1)
    if (fresh) {
      select.value = fresh.id
      select.dispatchEvent(new Event('change', { bubbles: true }))
    }
    showStatus(`已登入 ${state.accountLabel || flow.label}。記得按「儲存」把這一筆綁定起來。`)
    return
  }
  document.getElementById('ccOauthStep').textContent = state.message || '登入失敗，請再試一次。'
  document.getElementById('ccOauthCode')?.classList.add('hidden')
}

async function cancelLogin() {
  stopLoginPoll()
  showLoginWait(false)
  if (!loginProvider) return
  try {
    await electronAPI.ccswitch.cancelLogin(loginProvider)
  } catch {
    // 取消失敗不影響使用者，流程自己也會逾時
  }
}

/**
 * 把表單寫進 store（新增＝create、編輯＝update），回那一筆的 id；失敗回空字串。
 * 「從 API 載入模型」也走這裡先落地——main 只認 store 裡的，不收畫面上的草稿。
 * @returns {Promise<string>}
 */
async function persistProvider() {
  const authSelect = /** @type {HTMLSelectElement} */ (document.getElementById('ccAuthFieldSelect'))
  const accountSelect = /** @type {HTMLSelectElement} */ (document.getElementById('ccAccountSelect'))
  const formatSelect = /** @type {HTMLSelectElement} */ (document.getElementById('ccApiFormatSelect'))
  const validationSelect = /** @type {HTMLSelectElement} */ (document.getElementById('ccValidationFormatSelect'))
  /** @type {Record<string, string>} */
  const payload = {
    name: field('ccNameInput').value,
    baseUrl: field('ccBaseUrlInput').value,
    apiFormat: formatSelect.value,
    validationFormat: validationSelect.value,
    authField: authSelect.value,
    oauthAccountId: accountSelect.value
  }
  for (const cell of MODEL_FIELDS) payload[cell.key] = modelValue(cell)
  const apiKey = field('ccKeyInput').value

  // 自訂沒有預設端點，空著存下去只會在「切換」時才報錯，離填錯的地方太遠
  const editing = editingProviderId ? providers.find((entry) => entry.id === editingProviderId) : null
  const presetId = editing ? editing.presetId : 'custom'
  if (presetId === 'custom' && !payload.baseUrl.trim()) {
    showStatus('自訂供應商要先填 Base URL')
    field('ccBaseUrlInput').focus()
    return ''
  }

  try {
    if (editingProviderId) {
      // 金鑰留空＝不變更（畫面上本來就看不到完整金鑰，不能拿空字串去覆蓋）
      if (apiKey) payload.apiKey = apiKey
      await call(electronAPI.ccswitch.updateProvider(editingProviderId, payload), '儲存供應商失敗')
      return editingProviderId
    }
    const created = await call(
      electronAPI.ccswitch.createProvider({ ...payload, presetId, apiKey }),
      '新增供應商失敗'
    )
    return created?.id || ''
  } catch {
    // call() 已經顯示訊息
    return ''
  }
}

async function saveProvider() {
  const dialog = /** @type {HTMLDialogElement} */ (document.getElementById('ccProviderDialog'))
  const id = await persistProvider()
  if (!id) return
  dialog.close()
  await reloadProviders()
}

/**
 * 「從 API 載入模型」：先落地再掃（編輯＝update、新增＝create 之後接著掃那一筆）。
 * 掃描結果填滿四個下拉；失敗把原因講在 hint，彈窗不關。
 */
async function loadModels() {
  const btn = /** @type {HTMLButtonElement} */ (document.getElementById('ccScanModelsBtn'))
  const hint = document.getElementById('ccScanHint')
  if (!btn || !hint) return
  const preset = dialogPreset()
  if (preset?.id === 'custom' && !field('ccBaseUrlInput').value.trim()) {
    hint.textContent = '自訂供應商要先填 Base URL 才掃得到模型。'
    field('ccBaseUrlInput').focus()
    return
  }
  btn.disabled = true
  const label = btn.textContent
  btn.textContent = '載入中…'
  try {
    const id = await persistProvider()
    if (!id) return
    // 新增模式落地之後，接下來的掃描與儲存都對著這一筆
    editingProviderId = id
    document.getElementById('ccProviderDialogTitle').textContent = '編輯供應商'
    await reloadProviders()
    const result = await electronAPI.ccswitch.scanModels(id)
    const scan = result?.ok ? result.data : null
    if (scan?.ok) {
      rebuildModelSelects(scan.models)
      hint.textContent = `已載入 ${scan.models.length} 個模型，直接從下拉挑。`
    } else {
      hint.textContent = scan?.error || '掃描失敗，稍後再試或改用手動輸入。'
    }
  } finally {
    btn.disabled = false
    btn.textContent = label
  }
}

/** 開彈窗時順手掃一次；失敗不吵——手動按鈕會講原因 */
async function autoScanModels() {
  if (!editingProviderId) return
  const preset = dialogPreset()
  // 內建沒有 modelsUrl 的家（現在沒有，留著守）與沒填端點的自訂都跳過
  if (preset?.id !== 'custom' && !preset?.modelsUrl) return
  try {
    const result = await electronAPI.ccswitch.scanModels(editingProviderId)
    const scan = result?.ok ? result.data : null
    if (scan?.ok) {
      rebuildModelSelects(scan.models)
      document.getElementById('ccScanHint').textContent = `已載入 ${scan.models.length} 個模型，直接從下拉挑。`
    }
  } catch {
    // 靜默：自動掃描失敗不算錯
  }
}

// ===== MCP =====

async function reloadMcp() {
  try {
    const data = await call(electronAPI.ccswitch.listMcp(), '讀取 MCP 清單失敗')
    mcpServers = Array.isArray(data?.servers) ? data.servers : []
    const pathEl = document.getElementById('ccMcpPath')
    if (pathEl) pathEl.textContent = `設定檔：${data?.path || ''}`
    renderMcp()
  } catch {
    // call() 已經顯示訊息
  }
}

function renderMcp() {
  const list = document.getElementById('ccMcpList')
  const empty = document.getElementById('ccMcpEmpty')
  if (!list) return
  disarmDelete()
  list.replaceChildren()
  empty?.classList.toggle('hidden', mcpServers.length > 0)

  for (const item of mcpServers) {
    const row = el('div', 'cc-row')
    row.setAttribute('role', 'listitem')
    row.dataset.id = item.id

    const main = el('div', 'cc-row-main')
    const title = el('div', 'cc-row-title')
    title.append(el('span', 'cc-row-name', item.id))
    title.append(el('span', 'cc-badge', item.spec?.type || 'stdio'))
    if (!item.enabled) title.append(el('span', 'cc-badge is-warn', '已停用'))
    main.append(title)

    const spec = item.spec || {}
    const summary = spec.url
      ? spec.url
      : [spec.command, ...(Array.isArray(spec.args) ? spec.args : [])].join(' ')
    main.append(el('div', 'cc-row-sub', summary))
    row.append(main)

    const actions = el('div', 'cc-row-actions')
    const toggleBtn = /** @type {HTMLButtonElement} */ (
      el('button', 'btn btn-secondary btn-sm', item.enabled ? '停用' : '啟用')
    )
    toggleBtn.type = 'button'
    toggleBtn.addEventListener('click', () => void toggleMcp(item.id, !item.enabled))
    actions.append(toggleBtn)
    actions.append(iconButton('✎', '編輯', () => openMcpDialog(item.id)))
    const delBtn = iconButton('🗑', '刪除', () => armDelete(delBtn, () => void deleteMcp(item.id)))
    actions.append(delBtn)
    row.append(actions)

    list.append(row)
  }
}

/**
 * @param {string} id
 * @param {boolean} enabled
 */
async function toggleMcp(id, enabled) {
  try {
    await call(electronAPI.ccswitch.toggleMcp(id, enabled), '切換 MCP 狀態失敗')
    await reloadMcp()
  } catch {
    // call() 已經顯示訊息
  }
}

/**
 * @param {string} id
 */
async function deleteMcp(id) {
  try {
    await call(electronAPI.ccswitch.deleteMcp(id), '刪除 MCP 伺服器失敗')
    await reloadMcp()
  } catch {
    // call() 已經顯示訊息
  }
}

/**
 * @param {string} [id] 空＝新增
 */
function openMcpDialog(id = '') {
  const dialog = /** @type {HTMLDialogElement} */ (document.getElementById('ccMcpDialog'))
  if (!dialog || !catalog) return
  editingMcpId = id
  const item = id ? mcpServers.find((entry) => entry.id === id) : null
  const templateGroup = document.getElementById('ccMcpTemplateGroup')
  const templateSelect = /** @type {HTMLSelectElement} */ (document.getElementById('ccMcpTemplate'))
  const idInput = /** @type {HTMLInputElement} */ (document.getElementById('ccMcpIdInput'))
  const specInput = /** @type {HTMLTextAreaElement} */ (document.getElementById('ccMcpSpecInput'))

  document.getElementById('ccMcpDialogTitle').textContent = item ? '編輯 MCP 伺服器' : '新增 MCP 伺服器'
  templateGroup?.classList.toggle('hidden', Boolean(item))
  if (!item) {
    templateSelect.replaceChildren()
    const blank = document.createElement('option')
    blank.value = ''
    blank.textContent = '自己填'
    templateSelect.append(blank)
    for (const template of catalog.mcpTemplates || []) {
      const option = document.createElement('option')
      option.value = template.id
      option.textContent = template.label
      templateSelect.append(option)
    }
    templateSelect.value = ''
  }

  idInput.value = item?.id || ''
  idInput.readOnly = Boolean(item)
  specInput.value = item ? JSON.stringify(item.spec, null, 2) : '{\n  "type": "stdio",\n  "command": "npx",\n  "args": ["-y", ""]\n}'
  dialog.showModal()
  syncCustomSelects()
}

/** 選了範本就把名稱與定義填進去（使用者還可以改） */
function applyMcpTemplate() {
  const templateSelect = /** @type {HTMLSelectElement} */ (document.getElementById('ccMcpTemplate'))
  const template = (catalog?.mcpTemplates || []).find((entry) => entry.id === templateSelect.value)
  if (!template) return
  // 兩行都要先接成變數：`(expr).value = x` 後面接一行以 `(` 開頭的敘述，
  // ASI 會把它當成上一行的函式呼叫（`template.id(...)`），實際踩過
  const idInput = /** @type {HTMLInputElement} */ (document.getElementById('ccMcpIdInput'))
  const specInput = /** @type {HTMLTextAreaElement} */ (document.getElementById('ccMcpSpecInput'))
  idInput.value = template.id
  specInput.value = JSON.stringify(template.spec, null, 2)
}

async function saveMcp() {
  const dialog = /** @type {HTMLDialogElement} */ (document.getElementById('ccMcpDialog'))
  const id = /** @type {HTMLInputElement} */ (document.getElementById('ccMcpIdInput')).value
  const raw = /** @type {HTMLTextAreaElement} */ (document.getElementById('ccMcpSpecInput')).value
  const hint = document.getElementById('ccMcpSpecHint')

  let spec
  try {
    spec = JSON.parse(raw)
  } catch {
    if (hint) hint.textContent = '這段不是合法 JSON，請檢查括號與逗號。'
    return
  }

  const previous = editingMcpId ? mcpServers.find((entry) => entry.id === editingMcpId) : null
  try {
    await call(
      electronAPI.ccswitch.saveMcp(id, spec, previous ? previous.enabled : true),
      '儲存 MCP 伺服器失敗'
    )
    dialog.close()
    await reloadMcp()
  } catch {
    // call() 已經顯示訊息
  }
}

// ===== CLI 版本 =====

async function reloadVersions() {
  const list = document.getElementById('ccVersionList')
  if (list && !versions.length) {
    list.replaceChildren(el('p', 'cc-empty', '檢查中…'))
  }
  try {
    versions = await call(electronAPI.ccswitch.checkVersions(), '檢查 CLI 版本失敗')
    renderVersions()
  } catch {
    // call() 已經顯示訊息
  }
}

function renderVersions() {
  const list = document.getElementById('ccVersionList')
  if (!list) return
  list.replaceChildren()

  for (const tool of versions) {
    const row = el('div', 'cc-row')
    row.setAttribute('role', 'listitem')
    row.dataset.tool = tool.key

    const main = el('div', 'cc-row-main')
    const title = el('div', 'cc-row-title')
    title.append(el('span', 'cc-row-name', tool.label))
    if (!tool.installed) title.append(el('span', 'cc-badge is-warn', '未安裝'))
    else if (tool.outdated) title.append(el('span', 'cc-badge is-warn', '有新版'))
    else if (tool.latest) title.append(el('span', 'cc-badge', '已是最新'))
    main.append(title)

    const bits = []
    if (!tool.installed) bits.push('本機找不到，請先安裝這個 CLI')
    else {
      bits.push(`本機 ${tool.local}`)
      if (tool.latest) bits.push(`最新 ${tool.latest}`)
      else if (tool.pkg) bits.push('最新版查詢失敗，按「更新」讓 CLI 自己檢查')
      else bits.push('沒有版本清單，按「更新」讓 CLI 自己檢查')
      if (tool.updateCommand) bits.push(tool.updateCommand)
    }
    main.append(el('div', 'cc-row-sub', bits.join(' · ')))
    row.append(main)

    const actions = el('div', 'cc-row-actions')
    if (tool.installed && tool.updateCommand) {
      const btn = /** @type {HTMLButtonElement} */ (
        el('button', 'btn btn-sm ' + (tool.outdated ? 'btn-primary' : 'btn-secondary'), '更新')
      )
      btn.type = 'button'
      btn.addEventListener('click', () => void runUpdate(tool))
      actions.append(btn)
    }
    row.append(actions)
    list.append(row)
  }
}

/**
 * 更新＝在終端機分頁開一個工作階段跑 npm 指令，整個過程使用者看得到。
 * @param {{ key: string, label: string }} tool
 */
async function runUpdate(tool) {
  try {
    const command = await call(electronAPI.ccswitch.updateCommand(tool.key), '取得更新指令失敗')
    const [{ switchPage, setChatPaneMode }, terminal] = await Promise.all([
      import('./app.js'),
      import('./terminal-page.js')
    ])
    // 終端機跟聊天共用一頁：切過去並把主區換成終端機
    switchPage('chat')
    setChatPaneMode('terminal')
    await terminal.runInNewTerminal(`更新 ${tool.label}`, command)
  } catch {
    // call() 已經顯示訊息
  }
}

// ===== 生命週期 =====

function bindOnce() {
  if (bound) return
  bound = true

  document.querySelectorAll('#ccSubtabs .subtab').forEach((btn) => {
    btn.addEventListener('click', () => showSubtab(
      /** @type {'providers'|'mcp'|'version'} */ (btn.dataset.subtab)
    ))
  })

  document.getElementById('ccRefreshBtn')?.addEventListener('click', () => {
    if (activeSubtab === 'mcp') void reloadMcp()
    else if (activeSubtab === 'version') void reloadVersions()
    else void reloadProviders()
  })

  document.getElementById('ccGatewayToggleBtn')?.addEventListener('click', () => void toggleGateway())
  // 換協議＝換路由，下面那行「會不會走閘道」與 Base URL 的說明都要跟著改
  document.getElementById('ccApiFormatSelect')?.addEventListener('change', syncProviderDialogFields)
  // 模型：從 API 掃這家的清單填下拉；掃不到或要填清單外的就手動輸入
  document.getElementById('ccScanModelsBtn')?.addEventListener('click', () => void loadModels())
  document.getElementById('ccManualModelsBtn')?.addEventListener('click', toggleModelMode)
  document.getElementById('ccProviderCancelBtn')?.addEventListener('click', () => {
    /** @type {HTMLDialogElement} */ (document.getElementById('ccProviderDialog')).close()
  })
  document.getElementById('ccProviderSaveBtn')?.addEventListener('click', () => void saveProvider())
  // 彈窗用 Esc 關掉也要收輪詢與那條還開著的登入流程（PKCE 會佔著本機 1455 埠）
  document.getElementById('ccProviderDialog')?.addEventListener('close', () => void cancelLogin())
  document.getElementById('ccLoginBtn')?.addEventListener('click', () => void startLogin())
  document.getElementById('ccOauthCancelBtn')?.addEventListener('click', () => void cancelLogin())
  document.getElementById('ccOauthOpenBtn')?.addEventListener('click', () => void startLogin())

  document.getElementById('ccAddMcpBtn')?.addEventListener('click', () => openMcpDialog())
  document.getElementById('ccMcpTemplate')?.addEventListener('change', applyMcpTemplate)
  document.getElementById('ccMcpCancelBtn')?.addEventListener('click', () => {
    /** @type {HTMLDialogElement} */ (document.getElementById('ccMcpDialog')).close()
  })
  document.getElementById('ccMcpSaveBtn')?.addEventListener('click', () => void saveMcp())

  document.getElementById('ccCheckVersionBtn')?.addEventListener('click', () => void reloadVersions())
}

export function initCcSwitchPage() {
  bindOnce()
}

export function refreshCcSwitchPage() {
  bindOnce()
  void (async () => {
    try {
      if (!catalog) catalog = await call(electronAPI.ccswitch.catalog(), '讀取供應商預設失敗')
      await reloadProviders()
    } catch {
      // call() 已經顯示訊息
    }
  })()
}
