'use strict'

const path = require('path')
const files = require('./fs')
const paths = require('./paths')
const recycle = require('./recycle')

let emit = () => {}
let collisionPolicy = 'rename'
let sequence = 0
const active = new Map()
const history = new Map()
const MAX_HISTORY = 40

function configure(options) {
  if (options && typeof options.emit === 'function') emit = options.emit
}

function setCollisionPolicy(raw) {
  collisionPolicy = raw && raw.collision === 'skip' ? 'skip' : 'rename'
  return { collision: collisionPolicy }
}

function operationId() {
  sequence += 1
  return `op-${Date.now().toString(36)}-${sequence.toString(36)}`
}

function operationKey(raw) {
  const id = String(raw || '')
  if (!/^op-[A-Za-z0-9-]{4,80}$/.test(id)) throw paths.fail('BAD_PATH', '操作編號不合法')
  return id
}

function safeError(error) {
  const code = /^[A-Z][A-Z0-9_]{1,40}$/.test(String(error && error.code || ''))
    ? String(error.code)
    : 'OPERATION_FAILED'
  const messages = new Set(['CANCELLED', 'NOT_FOUND', 'EXISTS', 'COPY_FAILED', 'MOVE_FAILED', 'DELETE_FAILED'])
  const userMessage = error && typeof error.userMessage === 'string'
    ? error.userMessage.slice(0, 160)
    : messages.has(code) ? ({
      CANCELLED: '操作已取消',
      NOT_FOUND: '找不到來源檔案',
      EXISTS: '目的地已有同名檔案',
      COPY_FAILED: '複製失敗',
      MOVE_FAILED: '搬移失敗',
      DELETE_FAILED: '刪除失敗'
    })[code] : '檔案操作失敗'
  return { code, userMessage }
}

function copyItem(item) {
  const source = typeof item.source === 'string' ? item.source : ''
  return {
    index: item.index,
    source,
    plannedDestination: item.destination,
    destination: '',
    name: path.basename(source),
    status: 'pending',
    bytes: 0,
    totalBytes: null,
    error: null
  }
}

function snapshot(state) {
  return {
    id: state.id,
    type: state.type,
    mode: state.mode,
    collision: state.collision,
    destination: state.destination,
    status: state.status,
    totalItems: state.items.length,
    completedItems: state.items.filter((item) => item.status === 'completed').length,
    skippedItems: state.items.filter((item) => item.status === 'skipped').length,
    failedItems: state.items.filter((item) => item.status === 'failed').length,
    cancelledItems: state.items.filter((item) => item.status === 'cancelled').length,
    bytes: state.items.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0),
    totalBytes: state.items.every((item) => Number.isFinite(item.totalBytes))
      ? state.items.reduce((sum, item) => sum + item.totalBytes, 0)
      : null,
    items: state.items.map((item) => ({ ...item }))
  }
}

function publish(state, type, extra = {}) {
  const event = { ...snapshot(state), type, ...extra }
  try { emit('explorer:operation', event) } catch { /* renderer 關閉時略過通知 */ }
  if (typeof state.onEvent === 'function') {
    try { state.onEvent(event) } catch { /* 測試／觀察者不可影響檔案操作 */ }
  }
}

function makeItems(spec) {
  if (Array.isArray(spec.items)) {
    return spec.items.slice(0, 50).map((item, index) => copyItem({
      index,
      source: item.source,
      destination: item.destination || spec.destination
    }))
  }
  return (Array.isArray(spec.sources) ? spec.sources : []).slice(0, 50).map((source, index) => (
    copyItem({ index, source, destination: spec.destination })
  ))
}

function throwBadSpec(spec) {
  if (!['copy', 'move', 'trash'].includes(spec.mode)) throw paths.fail('BAD_PATH', '操作類型不合法')
  if (!Array.isArray(spec.sources) && !Array.isArray(spec.items)) throw paths.fail('BAD_PATH', '路徑不合法')
}

function markCancelled(state, item) {
  item.status = 'cancelled'
  item.error = { code: 'CANCELLED', userMessage: '操作已取消' }
  publish(state, 'item', { item: { ...item } })
}

async function executeItem(state, item, controller) {
  item.status = 'running'
  publish(state, 'progress', { item: { ...item } })
  const opts = {
    collision: state.collision,
    signal: controller.signal,
    onTotal: (total) => {
      item.totalBytes = Number.isFinite(total) ? total : null
      publish(state, 'progress', { item: { ...item } })
    },
    onProgress: (bytes) => {
      item.bytes = Number(bytes) || 0
      publish(state, 'progress', { item: { ...item } })
    }
  }
  let result
  if (state.mode === 'copy') result = await files.copyEntry(item.source, item.plannedDestination, opts)
  else if (state.mode === 'move') result = await files.moveEntry(item.source, item.plannedDestination, opts)
  else result = await files.removeEntry(item.source)
  item.destination = result && result.path ? result.path : item.plannedDestination
  if (result && result.skipped) {
    item.status = 'skipped'
  } else {
    item.status = 'completed'
    if (Number.isFinite(item.totalBytes)) item.bytes = item.totalBytes
  }
  item.error = null
  publish(state, 'item', { item: { ...item } })
}

function finalStatus(state, cancelled) {
  const failed = state.items.some((item) => item.status === 'failed')
  const cancelledItem = state.items.some((item) => item.status === 'cancelled')
  if (cancelled || cancelledItem) return 'cancelled'
  if (failed) return state.items.some((item) => item.status === 'completed') ? 'partial' : 'failed'
  return 'completed'
}

async function run(rawSpec) {
  const spec = rawSpec && typeof rawSpec === 'object' ? rawSpec : {}
  throwBadSpec(spec)
  const controller = new AbortController()
  const external = spec.signal
  const abort = () => controller.abort()
  if (external && external.aborted) controller.abort()
  else if (external && typeof external.addEventListener === 'function') external.addEventListener('abort', abort, { once: true })
  const state = {
    id: operationId(),
    type: spec.type || 'file-operation',
    mode: spec.mode,
    collision: spec.collision === 'skip' ? 'skip' : collisionPolicy,
    destination: spec.destination || '',
    items: makeItems(spec),
    status: 'running',
    onEvent: spec.onEvent,
    firstError: null
  }
  active.set(state.id, { controller, state, spec })
  publish(state, 'started')
  let cancelled = false
  for (const item of state.items) {
    if (controller.signal.aborted) {
      cancelled = true
      markCancelled(state, item)
      continue
    }
    try {
      await executeItem(state, item, controller)
    } catch (error) {
      if (controller.signal.aborted || error && error.code === 'CANCELLED') {
        cancelled = true
        markCancelled(state, item)
      } else {
        if (!state.firstError) state.firstError = error
        item.status = 'failed'
        item.error = safeError(error)
        publish(state, 'item', { item: { ...item } })
      }
    }
  }
  state.status = finalStatus(state, cancelled)
  const result = snapshot(state)
  result.paths = state.items.filter((item) => item.status === 'completed').map((item) => item.destination)
  result.canUndo = state.mode === 'copy' || state.mode === 'move'
  if (state.firstError) Object.defineProperty(result, 'errorObject', {
    value: state.firstError,
    enumerable: false
  })
  active.delete(state.id)
  history.set(state.id, {
    spec: { ...spec, collision: state.collision, signal: undefined, onEvent: undefined },
    result
  })
  while (history.size > MAX_HISTORY) history.delete(history.keys().next().value)
  publish(state, 'finished', { result })
  if (external && typeof external.removeEventListener === 'function') external.removeEventListener('abort', abort)
  return result
}

function cancel(id) {
  const op = active.get(operationKey(id))
  if (!op) return false
  op.controller.abort()
  return true
}

async function retry(id) {
  const key = operationKey(id)
  const record = history.get(key)
  if (!record) throw paths.fail('NOT_FOUND', '找不到這筆操作')
  const items = record.result.items
    .filter((item) => item.status === 'failed' || item.status === 'cancelled')
    .map((item) => ({ source: item.source, destination: item.plannedDestination }))
  if (!items.length) return { ...record.result, retried: false }
  return run({ ...record.spec, items, type: 'retry', retryOf: key })
}

async function undo(id) {
  const key = operationKey(id)
  const record = history.get(key)
  if (!record || !record.result.canUndo) throw paths.fail('NOT_FOUND', '這筆操作不能復原')
  const items = record.result.items
    .filter((item) => item.status === 'completed' && item.destination)
    .map((item) => record.spec.mode === 'copy'
      ? { source: item.destination, destination: recycle.RECYCLE_CWD }
      : { source: item.destination, destination: path.dirname(item.source) })
  const mode = record.spec.mode === 'copy' ? 'trash' : 'move'
  return run({ items, mode, collision: 'skip', type: 'undo', destination: mode === 'trash' ? recycle.RECYCLE_CWD : '' })
}

function getState() {
  return {
    collision: collisionPolicy,
    active: [...active.values()].map(({ state }) => snapshot(state)),
    recent: [...history.values()].map(({ result }) => result).slice(-10)
  }
}

module.exports = {
  configure,
  setCollisionPolicy,
  getState,
  run,
  cancel,
  retry,
  undo
}
