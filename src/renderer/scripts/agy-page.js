import { electronAPI, showToast } from './app.js'

/**
 * AGY 反向代理頁。
 *
 * 所有狀態都由 main 給（agy:*）：renderer 沒有憑證、上游 URL、project id，
 * 也不能直接寫 store——連 API key 都只是拿來顯示與複製。
 * 表格與圖表一律 createElement，沿用專案的零 innerHTML 慣例。
 */

const POLL_INTERVAL_MS = 5000
const LOG_LIMIT = 200
const PROTOCOL_LABELS = { openai: 'OpenAI', anthropic: 'Anthropic' }
const RANGE_LABELS = { '6h': '近 6 小時', '24h': '近 24 小時', '7d': '近 7 天', '30d': '近 30 天', all: '全部時間' }

let initialized = false
let pollTimer = null
let pageGen = 0
let statusGen = 0
let busy = false
let keyVisible = false
let status = null
/**
 * 憑證指引的另一個來源：模型查詢失敗。
 *
 * 狀態面板的憑證檢查只在服務執行中才做（見 index.js status()），
 * 但「可用模型」不需要服務跑著也能查——服務停止時憑證壞掉，
 * 頁面上原本一個字都不會提，使用者只會看到一句沒有資訊量的失敗訊息。
 * @type {{ code: string, sources: object } | null}
 */
let credentialHint = null
/** 統計時間範圍。只是個 key，實際的小時數與分桶由 main 的白名單決定 */
let statsRange = '24h'

/** 需要導向 Antigravity CLI／IDE 的錯誤代碼 */
const CREDENTIAL_CODES = new Set(['NO_CREDENTIAL', 'TOKEN_EXPIRED', 'CREDENTIAL_ERROR'])

const byId = (id) => document.getElementById(id)

function createElement(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function formatNumber(value) {
  const n = Number(value) || 0
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 10_000) return `${(n / 1000).toFixed(0)}K`
  return n.toLocaleString('zh-TW')
}

function formatDuration(ms) {
  const n = Number(ms) || 0
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`
}

function formatTime(ts) {
  const date = new Date(Number(ts) || 0)
  if (!Number.isFinite(date.getTime())) return '—'
  return date.toLocaleTimeString('zh-TW', { hour12: false })
}

function showError(message) {
  const node = byId('agyError')
  if (!node) return
  node.textContent = message || ''
  node.classList.toggle('hidden', !message)
}

/** 所有 agy:* 呼叫的統一出入口：錯誤只顯示代碼對應的中文訊息 */
async function callAgy(action, ...args) {
  const api = electronAPI?.agy
  if (!api || typeof api[action] !== 'function') return null
  try {
    const result = await api[action](...args)
    if (!result?.ok) {
      showError(result?.error?.message || '反向代理操作失敗')
      return null
    }
    return result.data
  } catch {
    showError('無法與主程序通訊')
    return null
  }
}

// ===== 渲染 =====

function renderStatus() {
  const running = status?.running === true
  const dot = byId('agyStatusDot')
  const text = byId('agyStatusText')
  const toggle = byId('agyToggleBtn')

  if (dot) dot.className = `agy-dot ${running ? 'is-running' : 'is-stopped'}`
  if (text) {
    text.textContent = running
      ? `執行中 · ${status.host}:${status.port}${status.activeRequests ? ` · ${status.activeRequests} 個進行中` : ''}`
      : '已停止'
  }
  if (toggle) {
    toggle.textContent = running ? '停止服務' : '啟動服務'
    toggle.classList.toggle('btn-danger', running)
    toggle.disabled = busy
  }

  const baseUrl = byId('agyBaseUrl')
  if (baseUrl) baseUrl.textContent = status?.baseUrl || '尚未啟動'

  const openaiUrl = byId('agyOpenaiUrl')
  if (openaiUrl) openaiUrl.textContent = status?.baseUrl || '尚未啟動'
  const anthropicUrl = byId('agyAnthropicUrl')
  if (anthropicUrl) anthropicUrl.textContent = status?.anthropicBaseUrl || '尚未啟動'

  const apiKey = byId('agyApiKey')
  if (apiKey) {
    const key = status?.apiKey || ''
    apiKey.textContent = key ? (keyVisible ? key : '•'.repeat(Math.min(key.length, 32))) : '尚未產生'
    apiKey.classList.toggle('agy-secret', !keyVisible)
  }
  const keyToggle = byId('agyKeyToggleBtn')
  if (keyToggle) {
    keyToggle.textContent = keyVisible ? '隱藏' : '顯示'
    keyToggle.setAttribute('aria-pressed', String(keyVisible))
  }

  const credential = byId('agyCredential')
  if (credential) {
    const info = status?.credential
    if (!running) {
      credential.textContent = '服務停止中'
      credential.className = 'agy-credential'
    } else if (info?.connected) {
      credential.textContent = info.tier ? `已連線 · ${info.tier}` : '已連線'
      credential.className = 'agy-credential is-ok'
    } else {
      credential.textContent = info?.message || 'Antigravity 憑證無法使用'
      credential.className = 'agy-credential is-bad'
    }
  }

  // 憑證一旦真的連上就清掉舊提示，否則使用者照做修好了指引還賴在畫面上
  if (running && status?.credential?.connected) credentialHint = null
  renderCredentialHelp(credentialHint || (running ? status?.credential : null))

  const dbHealth = status?.db
  if (dbHealth && !dbHealth.ready) showError('日誌資料庫無法開啟，流量記錄暫時停用。')
}

/** 官方文件（CLI 安裝說明）。取自 agy.exe 內建的字串，非自行推測。 */
const ANTIGRAVITY_DOCS_URL = 'https://antigravity.google/docs'

/**
 * 憑證不可用時要給的下一步。
 *
 * 原本只丟一句「請先在 Antigravity 登入」——對沒裝過的人是死路：
 * 不知道要裝什麼、去哪裝、裝完做什麼。依偵測到的來源給不同指引。
 *
 * 維護 token 的是 Antigravity CLI 或 IDE（誰在跑誰續期），VoiceInk 只讀不寫，
 * 所以這裡能做的就是把使用者導回那兩個工具。
 */
function credentialGuidance(info) {
  const sources = info?.sources || {}
  const installed = Boolean(sources.cli || sources.ide)
  const toolName = sources.cli ? 'Antigravity CLI' : 'Antigravity'

  if (!installed) {
    return {
      title: '這台機器沒有偵測到 Antigravity CLI 或 IDE',
      steps: [
        { text: '安裝 Antigravity CLI：', link: ANTIGRAVITY_DOCS_URL },
        { text: '開終端機執行 ', code: 'agy', tail: '，依指示用 Google 帳號登入一次' },
        { text: '回到這一頁按「重新整理」' }
      ]
    }
  }
  if (info?.code === 'TOKEN_EXPIRED') {
    return {
      title: `已偵測到 ${toolName}，但 token 過期了`,
      steps: [
        { text: '執行任一個 ', code: 'agy', tail: ' 指令，它會自動把 token 續期' },
        { text: '回到這一頁按「重新整理」' }
      ]
    }
  }
  return {
    title: `已偵測到 ${toolName}，但尚未登入`,
    steps: [
      { text: '開終端機執行 ', code: 'agy', tail: '，依指示用 Google 帳號登入' },
      { text: '回到這一頁按「重新整理」' }
    ]
  }
}

/** 全程 createElement + textContent，維持整頁零 innerHTML */
function renderCredentialHelp(info) {
  const box = byId('agyCredentialHelp')
  if (!box) return
  const title = byId('agyCredentialHelpTitle')
  const list = byId('agyCredentialHelpSteps')
  if (!title || !list) return

  if (!info || info.connected) {
    box.hidden = true
    list.replaceChildren()
    title.textContent = ''
    return
  }

  const guidance = credentialGuidance(info)
  title.textContent = guidance.title

  const items = guidance.steps.map((step) => {
    const li = document.createElement('li')
    li.appendChild(document.createTextNode(step.text))
    if (step.code) {
      const code = document.createElement('code')
      code.className = 'agy-code-inline'
      code.textContent = step.code
      li.appendChild(code)
    }
    if (step.link) {
      const anchor = document.createElement('a')
      anchor.href = step.link
      anchor.target = '_blank'
      anchor.rel = 'noopener'
      anchor.textContent = step.link
      li.appendChild(anchor)
    }
    if (step.tail) li.appendChild(document.createTextNode(step.tail))
    return li
  })
  list.replaceChildren(...items)
  box.hidden = false
}

function renderSettingsInputs() {
  const port = byId('agyPortInput')
  const retention = byId('agyRetentionInput')
  const logBodies = byId('agyLogBodiesInput')
  // 使用者正在輸入時不要覆寫掉他打到一半的值
  if (port && document.activeElement !== port) port.value = String(status?.port ?? 8788)
  if (retention && document.activeElement !== retention) retention.value = String(status?.retentionDays ?? 30)
  if (logBodies) logBodies.checked = status?.logBodies === true
}

function statCard(label, value, hint) {
  const card = createElement('div', 'agy-stat-card')
  card.append(
    createElement('span', 'agy-stat-label', label),
    createElement('strong', 'agy-stat-value', value)
  )
  if (hint) card.append(createElement('span', 'agy-stat-hint', hint))
  return card
}

function renderStats(stats) {
  const cards = byId('agyStatCards')
  if (cards) {
    const summary = stats?.summary || {}
    const requests = Number(summary.requests) || 0
    const success = Number(summary.success) || 0
    const rate = requests ? `${((success / requests) * 100).toFixed(1)}%` : '—'
    cards.replaceChildren(
      statCard('請求', formatNumber(requests), `${formatNumber(summary.errors || 0)} 次失敗`),
      statCard('成功率', rate, requests ? `${formatNumber(success)} 次成功` : '尚無資料'),
      statCard('輸入 tokens', formatNumber(summary.input), summary.cached ? `快取 ${formatNumber(summary.cached)}` : ''),
      statCard('輸出 tokens', formatNumber(summary.output), summary.thought ? `思考 ${formatNumber(summary.thought)}` : '')
    )
  }

  renderTrend(stats?.series || [], stats?.bucket === 'day' ? 'day' : 'hour')
  renderModels(stats?.models || [])
}

/** 桶起點 → 長條下方的短標籤（小時桶只印時、天桶印月/日） */
function bucketLabel(start, bucket) {
  const date = new Date(Number(start) || 0)
  if (!Number.isFinite(date.getTime())) return ''
  return bucket === 'day'
    ? `${date.getMonth() + 1}/${date.getDate()}`
    : String(date.getHours()).padStart(2, '0')
}

function bucketTitle(start, bucket) {
  const date = new Date(Number(start) || 0)
  if (!Number.isFinite(date.getTime())) return ''
  const day = `${date.getMonth() + 1}/${date.getDate()}`
  if (bucket === 'day') return day
  return `${day} ${String(date.getHours()).padStart(2, '0')}:00`
}

/** 游標跟著長條走的浮動數值（原本只有原生 title，慢、又看不到 token） */
function showChartTip(column, lines) {
  const tip = byId('agyChartTip')
  const wrap = tip?.parentElement
  if (!tip || !wrap) return
  tip.replaceChildren(...lines.map((line, index) => (
    createElement('span', index ? 'agy-tip-sub' : 'agy-tip-main', line)
  )))
  tip.hidden = false
  // 先顯示才量得到寬度；夾在容器內，免得最邊緣那根把提示推出面板
  const wrapBox = wrap.getBoundingClientRect()
  const colBox = column.getBoundingClientRect()
  const center = colBox.left - wrapBox.left + colBox.width / 2
  const half = tip.offsetWidth / 2
  tip.style.left = `${Math.min(Math.max(center, half + 4), Math.max(half + 4, wrapBox.width - half - 4))}px`
}

function hideChartTip() {
  const tip = byId('agyChartTip')
  if (tip) tip.hidden = true
}

/** 純 CSS 長條：專案不引進圖表套件 */
function renderTrend(series, bucket) {
  const chart = byId('agyHourlyChart')
  const meta = byId('agyTrendMeta')
  if (!chart) return
  hideChartTip()

  if (!series.length) {
    chart.replaceChildren(createElement('p', 'agy-empty-inline', `${RANGE_LABELS[statsRange] || ''}沒有請求`))
    chart.setAttribute('aria-label', '所選範圍內沒有請求')
    if (meta) meta.textContent = ''
    return
  }

  const peak = Math.max(...series.map((row) => Number(row.requests) || 0), 1)
  const total = series.reduce((sum, row) => sum + (Number(row.requests) || 0), 0)
  const bars = series.map((row) => {
    const count = Number(row.requests) || 0
    const tokens = Number(row.tokens) || 0
    const column = createElement('div', count ? 'agy-bar-col' : 'agy-bar-col is-empty')
    const fill = createElement('span', 'agy-bar-fill')
    fill.style.height = count ? `${Math.max(6, Math.round((count / peak) * 100))}%` : '2px'
    column.append(fill, createElement('span', 'agy-bar-label', bucketLabel(row.start, bucket)))
    const lines = [`${count} 次請求`, bucketTitle(row.start, bucket)]
    if (tokens) lines.push(`${formatNumber(tokens)} tokens`)
    column.addEventListener('pointerenter', () => showChartTip(column, lines))
    column.addEventListener('pointerleave', hideChartTip)
    return column
  })
  chart.replaceChildren(...bars)
  // 圖表對讀螢幕軟體只是圖，補一句摘要
  chart.setAttribute('aria-label', `${RANGE_LABELS[statsRange] || ''}共 ${total} 次請求，尖峰單一區間 ${peak} 次`)
  if (meta) meta.textContent = `${RANGE_LABELS[statsRange] || ''} · 共 ${formatNumber(total)} 次 · 尖峰 ${peak}`
}

function renderModels(models) {
  const chart = byId('agyModelChart')
  const meta = byId('agyModelMeta')
  if (!chart) return
  if (!models.length) {
    chart.replaceChildren(createElement('p', 'agy-empty-inline', '尚無模型使用記錄'))
    chart.setAttribute('aria-label', '尚無模型使用記錄')
    if (meta) meta.textContent = ''
    return
  }

  const peak = Math.max(...models.map((row) => Number(row.requests) || 0), 1)
  const rows = models.map((row) => {
    const count = Number(row.requests) || 0
    const item = createElement('div', 'agy-dist-row')
    const head = createElement('div', 'agy-model-head')
    head.append(
      createElement('span', 'agy-model-name', row.model || '未知'),
      createElement('span', 'agy-model-count', `${count}`)
    )
    const track = createElement('div', 'agy-model-track')
    const fill = createElement('span', 'agy-model-fill')
    fill.style.width = `${Math.max(2, Math.round((count / peak) * 100))}%`
    track.append(fill)
    item.append(head, track)
    item.title = `${row.model || '未知'}：${count} 次 · 輸入 ${formatNumber(row.input)} / 輸出 ${formatNumber(row.output)} tokens`
    return item
  })
  chart.replaceChildren(...rows)
  chart.setAttribute('aria-label', `共 ${models.length} 個模型，使用最多的是 ${models[0].model}`)
  if (meta) meta.textContent = `${models.length} 個模型`
}

function renderRangeButtons() {
  document.querySelectorAll('[data-agy-range]').forEach((button) => {
    const active = button.dataset.agyRange === statsRange
    button.classList.toggle('is-active', active)
    button.setAttribute('aria-pressed', active ? 'true' : 'false')
  })
}

function renderLogs(payload) {
  const tbody = byId('agyLogRows')
  const empty = byId('agyLogEmpty')
  if (!tbody) return

  const rows = Array.isArray(payload?.logs) ? payload.logs : []
  if (empty) empty.classList.toggle('hidden', rows.length > 0)

  tbody.replaceChildren(...rows.map((log) => {
    const tr = createElement('tr', log.status >= 400 ? 'is-error' : '')

    tr.append(createElement('td', 'agy-cell-time', formatTime(log.ts)))
    tr.append(createElement('td', '', PROTOCOL_LABELS[log.protocol] || log.protocol))

    const model = createElement('td', 'agy-cell-model')
    model.append(createElement('span', 'agy-model-src', log.model || '—'))
    if (log.mappedModel && log.mappedModel !== log.model) {
      model.append(
        createElement('span', 'agy-model-arrow', '→'),
        createElement('span', 'agy-model-dst', log.mappedModel)
      )
    }
    tr.append(model)

    const statusCell = createElement('td', 'agy-cell-status')
    const badge = createElement('span', `agy-badge ${log.status >= 400 ? 'is-error' : 'is-ok'}`, String(log.status))
    statusCell.append(badge)
    if (log.errorCode) statusCell.append(createElement('span', 'agy-error-code', log.errorCode))
    tr.append(statusCell)

    tr.append(createElement('td', 'agy-cell-num', formatDuration(log.durationMs)))
    tr.append(createElement('td', 'agy-cell-num',
      log.inputTokens || log.outputTokens
        ? `${formatNumber(log.inputTokens)} / ${formatNumber(log.outputTokens)}`
        : '—'))
    return tr
  }))
}

// ===== 資料更新 =====

async function refreshStatus() {
  const gen = ++statusGen
  const nextStatus = await callAgy('status')
  if (!nextStatus || gen !== statusGen) return false
  status = nextStatus
  renderStatus()
  return true
}

async function refreshAll() {
  showError('')
  if (!await refreshStatus()) return
  renderSettingsInputs()
  await refreshData()
}

async function refreshData() {
  const protocol = byId('agyProtocolFilter')?.value || ''
  const onlyErrors = byId('agyErrorsOnly')?.checked === true
  const [logs, stats] = await Promise.all([
    callAgy('logs', { limit: LOG_LIMIT, protocol, onlyErrors }),
    callAgy('stats', { range: statsRange })
  ])
  if (logs) renderLogs(logs)
  if (stats) renderStats(stats)
}

function startPolling() {
  stopPolling()
  pollTimer = setInterval(() => {
    // 視窗縮到系統匣時 document.hidden 為 true。狀態查詢會開 PowerShell 讀
    // Credential Manager，常駐背景後不擋的話就是 5 秒一次、開著整天。
    if (busy || document.hidden) return
    void (async () => {
      if (!await refreshStatus()) return
      showError('')
      await refreshData()
    })()
  }, POLL_INTERVAL_MS)
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}

// ===== 可用模型 =====

/** @type {Array<object>} */
let modelCatalog = []
let modelsLoaded = false

/**
 * 向上游查即時型錄。
 *
 * 不在進頁時自動查：這是一次真實的上游往返，使用者沒要看模型時不該替他打。
 * 進頁只顯示「尚未查詢」，按下按鈕才動作。
 * @param {boolean} force 略過 main 端的 10 分鐘快取
 */
async function loadModels(force = false) {
  const button = byId('agyModelsRefreshBtn')
  const meta = byId('agyModelsMeta')
  if (button) {
    button.disabled = true
    button.textContent = '查詢中…'
  }
  try {
    const result = await electronAPI.agy.models(force)
    if (!result?.ok) {
      const code = result?.error?.code || ''
      if (CREDENTIAL_CODES.has(code)) {
        // 憑證問題不是「查詢壞掉」，而是有明確下一步的狀態：
        // 直接把狀態區那份指引叫出來（服務沒開時它本來不會顯示），
        // 光丟一句失敗訊息等於叫使用者自己猜。
        credentialHint = { code, sources: status?.credential?.sources }
        renderCredentialHelp(credentialHint)
        if (meta) meta.textContent = 'Antigravity 憑證無法使用，請看上方指引'
        showToast(result?.error?.message || 'Antigravity 憑證無法使用', 'error')
        // 不加 smooth：這是被動觸發的視窗跳動，平滑捲動在 reduced motion 下反而是噪音
        byId('agyCredentialHelp')?.scrollIntoView({ block: 'nearest' })
        return
      }
      if (meta) meta.textContent = '查詢失敗，請稍後再試'
      showToast(result?.error?.message || '模型清單查詢失敗', 'error')
      return
    }
    credentialHint = null
    modelCatalog = Array.isArray(result.data?.models) ? result.data.models : []
    modelsLoaded = true
    if (meta) {
      const chat = modelCatalog.filter((m) => m.chatCapable).length
      meta.textContent = result.data?.cached
        ? `共 ${modelCatalog.length} 個（對話可用 ${chat}）・快取`
        : `共 ${modelCatalog.length} 個（對話可用 ${chat}）・剛更新`
    }
    renderModelCatalog()
  } catch (error) {
    if (meta) meta.textContent = '查詢失敗'
    showToast('模型清單查詢失敗', 'error')
  } finally {
    if (button) {
      button.disabled = false
      button.textContent = '重新查詢'
    }
  }
}

/** 全程 createElement + textContent，維持整頁零 innerHTML */
function renderModelCatalog() {
  const list = byId('agyModelsList')
  if (!list) return

  if (!modelsLoaded) {
    const hint = document.createElement('p')
    hint.className = 'agy-models-empty'
    hint.textContent = '按「重新查詢」向上游取得目前可用的模型。'
    list.replaceChildren(hint)
    return
  }

  const showAll = byId('agyModelsShowAll')?.checked === true
  const rows = showAll ? modelCatalog : modelCatalog.filter((m) => m.chatCapable)
  if (!rows.length) {
    const empty = document.createElement('p')
    empty.className = 'agy-models-empty'
    empty.textContent = '沒有可顯示的模型。'
    list.replaceChildren(empty)
    return
  }

  list.replaceChildren(...rows.map(buildModelRow))
}

/**
 * @param {object} model
 * @returns {HTMLElement}
 */
function buildModelRow(model) {
  const row = document.createElement('div')
  row.className = 'agy-model-row'
  if (!model.chatCapable) row.classList.add('is-internal')

  const idButton = document.createElement('button')
  idButton.type = 'button'
  idButton.className = 'agy-model-id'
  idButton.textContent = model.id
  idButton.title = '點一下複製'
  idButton.setAttribute('aria-label', `複製模型 ID ${model.id}`)
  idButton.addEventListener('click', () => copyModelId(model.id))
  row.appendChild(idButton)

  const tags = document.createElement('div')
  tags.className = 'agy-model-tags'

  if (model.provider) {
    const provider = document.createElement('span')
    provider.className = 'agy-model-tag'
    provider.textContent = model.provider.toLowerCase()
    tags.appendChild(provider)
  }

  if (typeof model.remainingFraction === 'number') {
    const quota = document.createElement('span')
    quota.className = 'agy-model-tag is-quota'
    const percent = model.remainingFraction * 100
    // 低於 10% 標紅：claude 系列在這個方案只有 2.7%，選下去很快就撞牆
    if (percent < 10) quota.classList.add('is-low')
    quota.textContent = `剩餘 ${percent >= 10 ? percent.toFixed(0) : percent.toFixed(1)}%`
    tags.appendChild(quota)
  }

  if (model.maxTokens) {
    const context = document.createElement('span')
    context.className = 'agy-model-tag'
    context.textContent = `${Math.round(model.maxTokens / 1000)}k`
    context.title = `輸入上限 ${model.maxTokens} tokens`
    tags.appendChild(context)
  }

  if (model.deprecated) {
    const dep = document.createElement('span')
    dep.className = 'agy-model-tag is-deprecated'
    dep.textContent = model.replacedBy ? `已淘汰 → ${model.replacedBy}` : '已淘汰'
    tags.appendChild(dep)
  }

  if (!model.chatCapable) {
    const internal = document.createElement('span')
    internal.className = 'agy-model-tag'
    internal.textContent = 'IDE 內部'
    tags.appendChild(internal)
  }

  row.appendChild(tags)
  return row
}

/**
 * @param {string} id
 */
async function copyModelId(id) {
  try {
    await navigator.clipboard.writeText(id)
    showToast(`已複製 ${id}`, 'success')
  } catch {
    showToast('複製失敗', 'error')
  }
}

// ===== 連線測試 =====

/**
 * 按下「測試連線」：main 會自動挑一個模型、從本機閘道真的送一則訊息。
 * 成功就把模型回的字直接秀出來——「有沒有回應」用看的最快。
 */
async function runSelfTest() {
  const button = byId('agyTestBtn')
  const box = byId('agyTestResult')
  if (button) {
    button.disabled = true
    button.textContent = '測試中…'
  }
  if (box) {
    box.hidden = false
    box.className = 'agy-test-result is-busy'
    box.textContent = '正在挑選模型並送出測試訊息…'
  }
  try {
    const result = await electronAPI.agy.test()
    if (!result?.ok) {
      const code = result?.error?.code || ''
      if (CREDENTIAL_CODES.has(code)) {
        credentialHint = { code, sources: status?.credential?.sources }
        renderCredentialHelp(credentialHint)
      }
      if (box) {
        box.className = 'agy-test-result is-bad'
        box.textContent = result?.error?.message || '測試失敗'
      }
      showToast('連線測試失敗', 'error')
      return
    }
    const data = result.data || {}
    if (box) {
      box.className = `agy-test-result ${data.ok ? 'is-ok' : 'is-bad'}`
      box.textContent = data.ok
        ? `連線正常 · ${data.model} · ${formatDuration(data.durationMs)} · 回覆「${data.reply || '（空白）'}」`
        : `${data.message || '測試失敗'}${data.model ? ` · ${data.model}` : ''}${data.code ? ` · ${data.code}` : ''}`
    }
    showToast(data.ok ? '連線測試通過' : '連線測試失敗', data.ok ? 'success' : 'error')
    // 測試本身也是一筆流量，讓日誌與統計立刻反映出來
    await refreshData()
  } catch {
    if (box) {
      box.className = 'agy-test-result is-bad'
      box.textContent = '無法與主程序通訊'
    }
    showToast('連線測試失敗', 'error')
  } finally {
    if (button) {
      button.disabled = false
      button.textContent = '測試連線'
    }
  }
}

// ===== 操作 =====

async function withBusy(action) {
  if (busy) return
  busy = true
  showError('')
  renderStatus()
  try {
    await action()
  } finally {
    const actionError = byId('agyError')?.classList.contains('hidden')
      ? ''
      : byId('agyError')?.textContent || ''
    busy = false
    await refreshAll()
    if (actionError) showError(actionError)
  }
}

async function toggleService() {
  const running = status?.running === true
  await withBusy(async () => {
    const next = await callAgy(running ? 'stop' : 'start')
    if (!next) return
    if (!running && next.running === false) {
      showError(next.error === 'PORT_IN_USE'
        ? `連接埠 ${status?.port} 已被占用，請換一個。`
        : '服務啟動失敗。')
      return
    }
    showToast(running ? '反向代理已停止' : '反向代理已啟動', 'success')
  })
}

const COPY_LABELS = { apiKey: 'API Key', baseUrl: 'Base URL', anthropicBaseUrl: 'ANTHROPIC_BASE_URL' }

async function copyValue(kind) {
  const value = COPY_LABELS[kind] ? status?.[kind] : ''
  if (!value) {
    showToast('尚無可複製的內容', 'error')
    return
  }
  try {
    await navigator.clipboard.writeText(value)
    showToast(`${COPY_LABELS[kind]} 已複製`, 'success')
  } catch {
    showToast('複製失敗', 'error')
  }
}

async function regenerateKey() {
  // 換金鑰會讓所有已接上的客戶端立刻失效，先確認
  if (!window.confirm('重新產生 API Key 會讓現有客戶端全部失效，確定要換嗎？')) return
  await withBusy(async () => {
    const next = await callAgy('regenerateKey')
    if (next) showToast('已產生新的 API Key', 'success')
  })
}

async function saveSettings() {
  const port = Number(byId('agyPortInput')?.value)
  const retentionDays = Number(byId('agyRetentionInput')?.value)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    showError('監聽埠必須是 1024–65535 的整數。')
    return
  }
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
    showError('日誌保留天數必須是 1–365 的整數。')
    return
  }
  await withBusy(async () => {
    const next = await callAgy('saveSettings', {
      port,
      retentionDays,
      logBodies: byId('agyLogBodiesInput')?.checked === true
    })
    if (next) showToast('設定已儲存', 'success')
  })
}

async function clearLogs() {
  if (!window.confirm('清空所有流量日誌？此動作無法復原。')) return
  await withBusy(async () => {
    const result = await callAgy('clearLogs')
    if (result?.ok) showToast('流量日誌已清空', 'success')
  })
}

function bindEvents() {
  byId('agyToggleBtn')?.addEventListener('click', () => void toggleService())
  byId('agyRefreshBtn')?.addEventListener('click', () => void refreshAll())
  byId('agyTestBtn')?.addEventListener('click', () => void runSelfTest())
  byId('agyRegenerateBtn')?.addEventListener('click', () => void regenerateKey())
  byId('agySaveSettingsBtn')?.addEventListener('click', () => void saveSettings())
  byId('agyClearLogsBtn')?.addEventListener('click', () => void clearLogs())

  byId('agyKeyToggleBtn')?.addEventListener('click', () => {
    keyVisible = !keyVisible
    renderStatus()
  })

  document.querySelectorAll('[data-agy-copy]').forEach((button) => {
    button.addEventListener('click', () => void copyValue(button.dataset.agyCopy))
  })

  byId('agyProtocolFilter')?.addEventListener('change', () => {
    showError('')
    void refreshData()
  })
  byId('agyErrorsOnly')?.addEventListener('change', () => {
    showError('')
    void refreshData()
  })

  byId('agyRangeGroup')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-agy-range]')
    if (!button || button.dataset.agyRange === statsRange) return
    statsRange = button.dataset.agyRange
    renderRangeButtons()
    showError('')
    void refreshData()
  })

  byId('agyModelsRefreshBtn')?.addEventListener('click', () => void loadModels(true))
  byId('agyModelsShowAll')?.addEventListener('change', renderModelCatalog)
  renderRangeButtons()
  renderModelCatalog()
}

export async function initAgyPage() {
  if (initialized) return
  initialized = true
  bindEvents()
  await refreshAll()
}

export function refreshAgyPage() {
  const gen = ++pageGen
  void (async () => {
    await initAgyPage()
    if (gen !== pageGen) return
    await refreshAll()
    if (gen !== pageGen) return
    if (!byId('page-agy')?.classList.contains('active')) return
    startPolling()
  })()
}

/** 離開頁面就停止輪詢，別讓背景一直查 DB */
export function cooldownAgyPage() {
  pageGen += 1
  statusGen += 1
  stopPolling()
  keyVisible = false
}
