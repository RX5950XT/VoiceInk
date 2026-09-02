'use strict'

/**
 * Claude Code 工作台的門面（Main Process）。
 *
 * 供應商切換／MCP／CLI 版本三塊各自成模組，這裡只負責串起來與注入依賴，
 * 讓 `ipc.js` 有一個扁平的介面可以逐一列舉（比照 `agy/index.js`）。
 */

const path = require('path')
const { randomBytes } = require('crypto')
const claudeSettings = require('./claude-settings')
const presets = require('./presets')
const providers = require('./providers')
const mcp = require('./mcp')
const cliVersion = require('./cli-version')
const gateway = require('./gateway/server')
const gatewayCredential = require('./gateway/credential')
const oauth = require('./gateway/oauth')
const modelsScan = require('./models-scan')

/** 閘道預設監聽埠（0 = 讓系統挑；固定一個比較好填客戶端） */
const DEFAULT_GATEWAY_PORT = 8791

let configured = false

/**
 * @param {{ userDataPath: string, openExternal?: (url: string) => unknown }} options
 */
function configure({ userDataPath, openExternal }) {
  if (configured) return
  configured = true
  claudeSettings.configure({ backupDir: path.join(userDataPath, 'claude-backup') })
  mcp.configure(providers.getStore)
  // 登入要開系統瀏覽器；用注入的而不是在這裡 require electron，模組才 node 直測得動
  oauth.configure({ getStore: providers.getStore, openExternal })
}

/**
 * 本機閘道的連線資訊。Codex／Grok／Ollama Cloud 要靠它把 OpenAI 協議轉成 Anthropic。
 *
 * **沒啟動就回 null**，`resolveEnv` 會拋 `GATEWAY_OFFLINE` 明說「請先啟動閘道」，
 * 而不是寫出一個連不上的 Base URL 讓使用者自己去猜。
 *
 * @returns {{ baseUrl: string, apiKey: string } | null}
 */
function gatewayInfo() {
  const state = gateway.status()
  if (!state.running || !gatewayKey) return null
  return { baseUrl: state.baseUrl, apiKey: gatewayKey }
}

/** @type {string} */
let gatewayKey = ''

/**
 * 讀（必要時產生）閘道金鑰。**每台機器一把**，存在自己的 store，不進 `STORE_ALLOWLIST`。
 * @returns {Promise<string>}
 */
async function ensureGatewayKey() {
  if (gatewayKey) return gatewayKey
  const store = await providers.getStore()
  let key = store.get('gatewayKey', '')
  if (typeof key !== 'string' || key.length < 32) {
    key = randomBytes(24).toString('base64url')
    store.set('gatewayKey', key)
  }
  gatewayKey = key
  return key
}

/**
 * 啟動閘道。只由使用者按下頁面的開關時呼叫。
 * @returns {Promise<object>}
 */
async function startGateway() {
  const store = await providers.getStore()
  const port = Number(store.get('gatewayPort', DEFAULT_GATEWAY_PORT)) || DEFAULT_GATEWAY_PORT
  await gateway.start({
    port,
    apiKey: await ensureGatewayKey(),
    // Ollama Cloud 的金鑰是使用者自己填的，由這裡去取；不進 settings.json
    getProviderKey: (presetId) => providers.keyForPreset(presetId),
    // Codex／Grok 綁了本 App 的登入帳號就用那組，沒綁才退回讀 CLI 憑證
    getAccountId: (presetId) => providers.accountForPreset(presetId),
    // 自訂供應商沒有固定表可查，位址由 main 從 store 取（renderer 與客戶端都指定不了）
    resolveRoute: (routeKey) => providers.resolveRoute(routeKey)
  })
  return gatewayStatus()
}

/** @returns {Promise<object>} */
async function stopGateway() {
  await gateway.stop()
  return gatewayStatus()
}

/**
 * 閘道狀態 ＋ 兩家 CLI 憑證在不在。**不回傳任何 token**。
 * @returns {object}
 */
function gatewayStatus() {
  const state = gateway.status()
  return {
    ...state,
    // 金鑰只在啟動時給一次，讓頁面能顯示「客戶端要填什麼」
    apiKey: state.running ? gatewayKey : '',
    credentials: gatewayCredential.detect()
  }
}

// ===== 供應商 =====

function catalog() {
  return {
    presets: presets.catalog(),
    authFields: providers.AUTH_FIELDS,
    // 非官方供應商都能選上游格式；Anthropic 直連，其餘經本機閘道轉換
    apiFormats: providers.API_FORMATS,
    // 哪幾家可以在本 App 直接登入，以及各自是哪種流程（UI 的文案不同）
    oauthFlows: Object.values(oauth.FLOWS).map((flow) => ({
      key: flow.key, label: flow.label, kind: flow.kind
    })),
    mcpTemplates: mcp.TEMPLATES,
    gateway: Boolean(gatewayInfo())
  }
}

function listProviders() {
  return providers.list({ gateway: gatewayInfo() || undefined })
}

/** @param {object} req */
function createProvider(req) {
  return providers.create(req)
}

/** @param {string} id @param {object} patch */
function updateProvider(id, patch) {
  return providers.update(id, patch)
}

/** @param {string} id */
function deleteProvider(id) {
  return providers.remove(id)
}

/** @param {string[]} ids */
function reorderProviders(ids) {
  return providers.reorder(ids)
}

/** @param {string} id */
async function activateProvider(id) {
  return providers.activate(id, { gateway: gatewayInfo() || undefined })
}

/**
 * 用這一筆目前儲存的上游格式送最小請求；不經本機閘道、不回傳上游 body。
 * @param {string} id
 */
async function testProvider(id) {
  const provider = await providers.getRaw(id)
  if (!provider) {
    const error = new Error('NOT_FOUND')
    error.code = 'NOT_FOUND'
    error.userMessage = '找不到這個供應商'
    throw error
  }
  return modelsScan.testProvider(provider)
}

/**
 * 從 API 掃這一筆的模型清單（彈窗裡的「從 API 載入模型」）。
 * 只收 providerId，端點與憑證全在 main 決定（跟 `chat:scanModels` 同一條規矩）。
 * @param {string} id
 */
async function scanProviderModels(id) {
  const provider = await providers.getRaw(id)
  if (!provider) {
    const error = new Error('NOT_FOUND')
    error.code = 'NOT_FOUND'
    error.userMessage = '找不到這個供應商'
    throw error
  }
  return modelsScan.scanProviderModels(provider)
}

// ===== MCP =====

function listMcp() {
  return mcp.list()
}

/** @param {string} id @param {object} spec @param {boolean} enabled */
function saveMcp(id, spec, enabled) {
  return mcp.upsert(id, spec, enabled !== false)
}

/** @param {string} id @param {boolean} enabled */
function toggleMcp(id, enabled) {
  return mcp.toggle(id, enabled)
}

/** @param {string} id */
function deleteMcp(id) {
  return mcp.remove(id)
}

// ===== OAuth 登入 =====

/**
 * 登入帳號清單。**不含任何 token**。
 * @returns {Promise<Array<object>>}
 */
function listAccounts() {
  return oauth.list()
}

/** @param {string} providerKey */
function beginLogin(providerKey) {
  return oauth.begin(providerKey)
}

/** @param {string} providerKey */
function loginStatus(providerKey) {
  return oauth.status(providerKey)
}

/** @param {string} providerKey */
function cancelLogin(providerKey) {
  return oauth.cancel(providerKey)
}

/**
 * 刪掉一個登入帳號，並把綁著它的供應商解綁。
 * @param {string} accountId
 */
async function removeAccount(accountId) {
  await oauth.remove(accountId)
  await providers.unbindAccount(accountId)
  return true
}

// ===== CLI 版本 =====

function checkVersions() {
  return cliVersion.checkAll()
}

/** @param {string} key */
function versionUpdateCommand(key) {
  return cliVersion.updateCommand(key)
}

module.exports = {
  DEFAULT_GATEWAY_PORT,
  configure,
  gatewayInfo,
  gatewayStatus,
  startGateway,
  stopGateway,
  catalog,
  listProviders,
  createProvider,
  updateProvider,
  deleteProvider,
  reorderProviders,
  activateProvider,
  testProvider,
  scanProviderModels,
  listMcp,
  saveMcp,
  toggleMcp,
  deleteMcp,
  listAccounts,
  beginLogin,
  loginStatus,
  cancelLogin,
  removeAccount,
  checkVersions,
  versionUpdateCommand
}
