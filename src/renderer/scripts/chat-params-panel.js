/**
 * 對話參數面板（Temperature／Top P／Max tokens／Stop）。
 *
 * 只放幾乎每家 OpenAI 相容端點都吃的參數；每一列先勾才生效，沒勾的完全不送。
 * 範圍表只是 UI；main 的 `chat-params.js` 會再夾一次，那邊才是邊界。
 */

import { electronAPI, showToast, cleanIpcError } from './app.js'

/**
 * @typedef {{ key: string, label: string, hint: string, min: number, max: number, step: number,
 *   def: number, sliderMax?: number, noSlider?: boolean }} Row
 * @type {Row[]}
 */
const ROWS = [
  { key: 'temperature', label: 'Temperature', hint: '越高越發散、越低越穩定', min: 0, max: 2, step: 0.05, def: 0.7 },
  { key: 'topP', label: 'Top P', hint: '只從累積機率前 P 的候選字裡挑', min: 0, max: 1, step: 0.01, def: 0.95 },
  { key: 'maxTokens', label: '最大輸出 tokens', hint: '回覆長度上限', min: 1, max: 1_000_000, step: 1, def: 4096, noSlider: true },
  { key: 'contextCount', label: '上下文訊息數', hint: '只帶最近幾則訊息給模型', min: 1, max: 500, sliderMax: 100, step: 1, def: 20 }
]

/**
 * 有幾個參數被打開（composer 那顆按鈕上的數字）
 * @param {Record<string, unknown> | undefined} params
 * @returns {number}
 */
export function countParams(params) {
  return params && typeof params === 'object' ? Object.keys(params).length : 0
}

/**
 * @param {string} conversationId
 * @returns {Promise<Record<string, unknown> | null>} 套用後的參數；取消回 null
 */
export async function openParamsDialog(conversationId) {
  const conv = await electronAPI.chat.get(conversationId)
  if (!conv) return null
  const dialog = document.createElement('dialog')
  dialog.className = 'app-dialog chat-params-dialog'
  dialog.setAttribute('aria-label', '對話參數')

  const head = document.createElement('div')
  head.className = 'dialog-head'
  const title = document.createElement('h2')
  title.className = 'dialog-title'
  title.textContent = '對話參數'
  const desc = document.createElement('p')
  desc.className = 'dialog-desc'
  desc.textContent = '只套用在這個對話；勾選的才會送出。'
  head.append(title, desc)

  const body = document.createElement('div')
  body.className = 'chat-params-body'
  const controls = ROWS.map((row) => buildRow(row, conv.params?.[row.key]))
  body.append(...controls.map((c) => c.el))
  const stop = buildStopRow(conv.params?.stop)
  body.append(stop.el)

  const collect = () => {
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const c of controls) Object.assign(out, c.read())
    Object.assign(out, stop.read())
    return out
  }

  const actions = document.createElement('div')
  actions.className = 'dialog-actions'
  const reset = dialogButton('全部不送', 'btn-secondary', () => {
    for (const c of controls) c.reset()
    stop.reset()
  })
  reset.classList.add('chat-params-left')
  const saveDefault = dialogButton('存為新對話預設', 'btn-secondary', async () => {
    await electronAPI.store.set('chatParams', collect())
    showToast('之後新開的對話會套用這組參數')
  })
  // 按鈕直接結算，不等 `close` 事件：視窗被遮住時 Chromium 會延後派發它（Esc 才走那條）
  let settle = (_ok) => {}
  const confirmed = new Promise((resolve) => {
    settle = (ok) => {
      settle = () => {}
      if (dialog.open) dialog.close()
      resolve(ok)
    }
  })
  const cancel = dialogButton('取消', 'btn-secondary', () => settle(false))
  const apply = dialogButton('套用', 'btn-primary', () => settle(true))
  actions.append(reset, saveDefault, cancel, apply)
  dialog.append(head, body, actions)
  dialog.addEventListener('close', () => settle(false))
  document.body.appendChild(dialog)
  dialog.showModal()
  // 不指定的話焦點會落在可捲動的清單本身，整塊冒出一圈焦點框
  body.querySelector('input')?.focus()
  const ok = await confirmed
  const params = collect()
  dialog.remove()
  if (!ok) return null
  try {
    return (await electronAPI.chat.setParams(conversationId, params)) || null
  } catch (e) {
    showToast(cleanIpcError(e), 'error')
    return null
  }
}

/**
 * @param {Row} row
 * @param {unknown} value 目前的值（沒設＝undefined）
 */
function buildRow(row, value) {
  const on = typeof value === 'number'
  const el = document.createElement('div')
  el.className = 'chat-param-row'
  const check = document.createElement('input')
  check.type = 'checkbox'
  check.checked = on
  check.id = `chatParam-${row.key}`
  check.setAttribute('aria-label', `送出 ${row.label}`)
  const label = document.createElement('label')
  label.className = 'chat-param-label'
  label.htmlFor = check.id
  const name = document.createElement('span')
  name.className = 'chat-param-name'
  name.textContent = row.label
  const hint = document.createElement('span')
  hint.className = 'chat-param-hint'
  hint.textContent = row.hint
  label.append(name, hint)

  const number = document.createElement('input')
  number.type = 'number'
  number.className = 'input input-sm chat-param-number'
  Object.assign(number, { min: String(row.min), max: String(row.max), step: String(row.step) })
  number.value = String(on ? value : row.def)
  number.setAttribute('aria-label', row.label)

  /** @type {HTMLInputElement | null} */
  let range = null
  if (!row.noSlider) {
    range = document.createElement('input')
    range.type = 'range'
    range.className = 'chat-param-range'
    Object.assign(range, { min: String(row.min), max: String(row.sliderMax ?? row.max), step: String(row.step) })
    range.value = number.value
    range.setAttribute('aria-label', row.label)
    range.addEventListener('input', () => { number.value = range.value })
    number.addEventListener('input', () => { range.value = number.value })
  }
  const sync = () => {
    number.disabled = !check.checked
    if (range) range.disabled = !check.checked
    el.classList.toggle('is-off', !check.checked)
  }
  check.addEventListener('change', sync)
  sync()
  el.append(check, label)
  if (range) el.appendChild(range)
  el.appendChild(number)

  return {
    el,
    read: () => {
      const n = Number(number.value)
      return check.checked && Number.isFinite(n) ? { [row.key]: n } : {}
    },
    reset: () => {
      check.checked = false
      sync()
    }
  }
}

/** @param {unknown} value */
function buildStopRow(value) {
  const el = document.createElement('div')
  el.className = 'chat-param-row chat-param-row-wide'
  const label = document.createElement('label')
  label.className = 'chat-param-label'
  label.htmlFor = 'chatParamStop'
  const name = document.createElement('span')
  name.className = 'chat-param-name'
  name.textContent = '停止字串'
  const hint = document.createElement('span')
  hint.className = 'chat-param-hint'
  hint.textContent = '一行一個，最多 4 個；留空＝不送'
  label.append(name, hint)
  const input = document.createElement('textarea')
  input.id = 'chatParamStop'
  input.className = 'input chat-param-stop'
  input.rows = 2
  input.value = Array.isArray(value) ? value.join('\n') : ''
  el.append(label, input)
  return {
    el,
    read: () => {
      const stop = input.value.split('\n').filter((s) => s.length).slice(0, 4)
      return stop.length ? { stop } : {}
    },
    reset: () => { input.value = '' }
  }
}

/**
 * @param {string} text
 * @param {string} variant
 * @param {() => void} onClick
 */
function dialogButton(text, variant, onClick) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = `btn ${variant} btn-sm`
  btn.textContent = text
  btn.addEventListener('click', onClick)
  return btn
}
