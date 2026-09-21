/**
 * HF 模型儀表板：GPU VRAM、用量、本機端點、llama-server log。
 * 金鑰不出 renderer；端點只顯示 127.0.0.1 與埠。
 */

import { electronAPI, showToast } from './app.js'

const POLL_MS = 2000
const $ = (id) => document.getElementById(id)

/** @type {ReturnType<typeof setTimeout> | null} */
let timer = null
let on = false
let generation = 0

function el(tag, cls, text) {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

function fmtInt(n) {
  return n == null ? '—' : Math.round(Number(n)).toLocaleString('zh-TW')
}

function fmtTps(n) {
  const v = Number(n)
  return v > 0 ? `${v.toFixed(1)} tok/s` : '—'
}

function spec(dl, rows) {
  if (!dl) return
  dl.replaceChildren()
  for (const [label, value] of rows) {
    const group = el('div')
    group.appendChild(el('dt', '', label))
    group.appendChild(el('dd', '', value || '—'))
    dl.appendChild(group)
  }
}

function renderGpus(devices) {
  const box = $('hfGpuMeters')
  if (!box) return
  if (!devices?.length) {
    box.replaceChildren(el('p', 'setting-hint', '沒有可用的 GPU 後端。'))
    return
  }
  box.replaceChildren(...devices.map((d) => {
    const total = Number(d.totalMiB) || 0
    const used = Math.max(0, total - (Number(d.freeMiB) || 0))
    const pct = total ? Math.min(100, (used / total) * 100) : 0
    const card = el('div', 'hf-gpu')
    const head = el('div', 'hf-gpu-head')
    head.appendChild(el('b', '', d.name || d.id || 'GPU'))
    head.appendChild(el('span', '', `${fmtInt(used)} / ${fmtInt(total)} MiB`))
    card.appendChild(head)
    const meter = el('div', 'hf-meter')
    meter.setAttribute('role', 'meter')
    meter.setAttribute('aria-valuemin', '0')
    meter.setAttribute('aria-valuemax', '100')
    meter.setAttribute('aria-valuenow', String(Math.round(pct)))
    const fill = el('i')
    fill.style.width = `${pct.toFixed(1)}%`
    if (pct > 80) fill.dataset.hot = 'true'
    meter.appendChild(fill)
    card.appendChild(meter)
    card.appendChild(el('p', 'setting-hint', `${d.id}　可用 ${fmtInt(d.freeMiB)} MiB`))
    return card
  }))
}

function renderLog(lines) {
  const pre = $('hfServerLog')
  if (!pre) return
  const text = (lines || []).join('\n') || '還沒有 log。'
  if (pre.textContent === text) return
  const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24
  pre.textContent = text
  if (atBottom) pre.scrollTop = pre.scrollHeight
}

async function refresh(seq) {
  let result
  try {
    result = await electronAPI.hfmodels.dashboard()
  } catch {
    return
  }
  const data = result?.ok ? result.data : null
  if (!data || !on || seq !== generation) return

  const hint = $('hfServerHint')
  if (hint) {
    hint.textContent = data.running
      ? `上線中 · 埠 ${data.port}。聊天頁的本機模型會自動連這裡。`
      : '啟動執行環境後，聊天與其他程式可打這個端點。'
  }
  spec($('hfServerSpecs'), [
    ['OpenAI', data.openaiBaseUrl || '—'],
    ['Anthropic', data.anthropicBaseUrl || '—'],
    ['狀態', data.running ? '上線' : '未啟動']
  ])
  const m = data.metrics || {}
  spec($('hfUsageSpecs'), [
    ['處理中 / 排隊', data.metrics
      ? `${fmtInt(m.requestsProcessing)} / ${fmtInt(m.requestsDeferred)}` : '—'],
    ['生成速度', fmtTps(m.predictedTps)],
    ['Prompt 速度', fmtTps(m.promptTps)],
    ['Prompt tokens', fmtInt(m.promptTokens)],
    ['生成 tokens', fmtInt(m.predictedTokens)]
  ])
  renderGpus(data.devices)
  renderLog(data.logTail)
}

function tick() {
  clearTimeout(timer)
  if (!on) return
  const seq = generation
  refresh(seq).finally(() => {
    if (on && seq === generation) timer = setTimeout(tick, POLL_MS)
  })
}

export function startDash() {
  if (on) return // 切回「執行環境」子分頁會再叫一次；不擋就多一條輪詢鏈，停不乾淨
  on = true
  tick()
}

export function stopDash() {
  on = false
  generation++
  clearTimeout(timer)
  timer = null
}

export async function copyEndpoint() {
  const result = await electronAPI.hfmodels.dashboard()
  const url = result?.ok ? result.data?.openaiBaseUrl : ''
  if (!url) { showToast('執行環境尚未啟動', 'error'); return }
  try {
    await navigator.clipboard.writeText(url)
    showToast('已複製 OpenAI 端點', 'success')
  } catch {
    showToast('無法寫入剪貼簿', 'error')
  }
}
