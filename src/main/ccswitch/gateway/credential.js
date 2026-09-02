'use strict'

/**
 * Codex／Grok 的憑證讀取（Main Process）。
 *
 * **只讀不寫**：憑證由各自的 CLI 維護，我們去動它只會把使用者的登入弄壞。
 * access token 過期時就地用 refresh token 換一顆新的，**只留在記憶體**，不寫回檔案——
 * 寫回去等於跟 CLI 搶同一份狀態，兩邊各自 refresh 會互相作廢對方的 refresh token。
 *
 * 用到的 `client_id` 是各家**公開的桌面應用 client**（沒有 secret，CLI 自己也是用同一個）。
 * CLAUDE.md 禁止的是把 client **secret** 寫進原始碼，不是這個。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

/** access token 剩不到這麼久就先去換一顆（提前量，不是「已經不能用了」） */
const STALE_MS = 5 * 60 * 1000
/** 換 token 的逾時 */
const REFRESH_TIMEOUT_MS = 20000

/** OpenAI 的公開桌面 client（Codex CLI 用的同一個，沒有 secret） */
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token'
/** xAI 的 token 端點；client_id 直接從使用者的憑證檔讀，不寫死 */
const XAI_TOKEN_URL = 'https://auth.x.ai/oauth2/token'

/** @type {{ homeDir: string }} */
const paths = { homeDir: '' }

/** @type {Map<string, { token: string, expiresAt: number, accountId: string }>} */
const cache = new Map()
/** @type {Map<string, Promise<object>>} */
const inflight = new Map()

/**
 * @param {{ homeDir?: string }} options
 */
function configure(options = {}) {
  if (typeof options.homeDir === 'string') paths.homeDir = options.homeDir
}

function homeDir() {
  return paths.homeDir || os.homedir()
}

/**
 * 讀 JWT 的 payload。**不驗簽**：來源是本機檔案，我們只想知道什麼時候過期。
 * @param {string} token
 * @returns {Record<string, unknown>}
 */
function jwtClaims(token) {
  const parts = String(token || '').split('.')
  if (parts.length !== 3) return {}
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    return {}
  }
}

/**
 * @param {string} file
 * @returns {Record<string, unknown> | null}
 */
function readJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * @param {string} code
 * @param {string} message
 * @returns {Error}
 */
function credentialError(code, message) {
  const error = new Error(code)
  error.code = code
  error.userMessage = message
  return error
}

// ===== Codex（ChatGPT 訂閱） =====

/** @returns {string} */
function codexAuthPath() {
  return path.join(homeDir(), '.codex', 'auth.json')
}

/**
 * @returns {{ accessToken: string, refreshToken: string, accountId: string, expiresAt: number } | null}
 */
function readCodexFile() {
  const data = readJson(codexAuthPath())
  const tokens = data && typeof data.tokens === 'object' ? data.tokens : null
  const accessToken = typeof tokens?.access_token === 'string' ? tokens.access_token : ''
  if (!accessToken) return null
  const claims = jwtClaims(accessToken)
  return {
    accessToken,
    refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : '',
    accountId: typeof tokens.account_id === 'string' ? tokens.account_id : '',
    expiresAt: Number(claims.exp) ? Number(claims.exp) * 1000 : 0
  }
}

// ===== Grok（xAI 訂閱） =====

/** @returns {string} */
function grokAuthPath() {
  return path.join(homeDir(), '.grok', 'auth.json')
}

/**
 * Grok 的 auth.json 是「`<issuer>::<client_id>` → 帳號」的對照表，
 * 一般只有一組。挑第一組帶 `key` 的。
 * @returns {{ accessToken: string, refreshToken: string, accountId: string, expiresAt: number, clientId: string } | null}
 */
function readGrokFile() {
  const data = readJson(grokAuthPath())
  if (!data) return null
  for (const entry of Object.values(data)) {
    if (!entry || typeof entry !== 'object') continue
    const accessToken = typeof entry.key === 'string' ? entry.key : ''
    if (!accessToken) continue
    const claims = jwtClaims(accessToken)
    const expiresAt = Number(claims.exp)
      ? Number(claims.exp) * 1000
      : Date.parse(String(entry.expires_at || '')) || 0
    return {
      accessToken,
      refreshToken: typeof entry.refresh_token === 'string' ? entry.refresh_token : '',
      accountId: typeof entry.user_id === 'string' ? entry.user_id : '',
      expiresAt,
      clientId: typeof entry.oidc_client_id === 'string' ? entry.oidc_client_id : ''
    }
  }
  return null
}

// ===== 換 token =====

/**
 * 用 refresh token 換一顆新的 access token。
 *
 * 失敗**不拋出上游的回應內容**：那是使用者自填不了的外部字串，只留狀態碼。
 *
 * @param {string} url
 * @param {Record<string, string>} form
 * @param {{ fetchImpl?: Function }} [options]
 * @returns {Promise<{ accessToken: string, expiresAt: number }>}
 */
async function exchange(url, form, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS)
  let response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal: controller.signal
    })
  } catch {
    throw credentialError('TOKEN_REFRESH_FAILED', '無法連線到登入伺服器，請稍後再試')
  } finally {
    clearTimeout(timer)
  }
  if (!response?.ok) {
    const status = Number(response?.status) || 0
    throw credentialError(
      'TOKEN_REFRESH_FAILED',
      `續期失敗（HTTP ${status}），請重新登入該 CLI`
    )
  }
  let payload
  try {
    payload = await response.json()
  } catch {
    throw credentialError('TOKEN_REFRESH_FAILED', '登入伺服器回應格式錯誤')
  }
  const accessToken = typeof payload?.access_token === 'string' ? payload.access_token : ''
  if (!accessToken) throw credentialError('TOKEN_REFRESH_FAILED', '續期沒有拿到新的 token')
  const expiresIn = Number(payload.expires_in)
  const claims = jwtClaims(accessToken)
  const expiresAt = Number(claims.exp)
    ? Number(claims.exp) * 1000
    : Date.now() + (Number.isFinite(expiresIn) ? expiresIn * 1000 : 3600_000)
  return { accessToken, expiresAt }
}

/**
 * 取一顆可用的 access token。
 *
 * 同一個 provider 同時只會有一個換 token 的請求在跑（`inflight` 合併）：
 * token 尾聲每個請求都會走到這裡，不合併就會連開一堆續期請求。
 *
 * 帶 `oauthAccountId` 就用「使用者在本 App 登入的那組」（`oauth.js` 管，token 存自己的 store）；
 * 沒帶就退回讀已安裝 CLI 的憑證檔。兩條路都走同一個 `inflight` 合併，
 * 但**快取鍵要分開**——不然切換帳號之後還會拿到上一個人的 token。
 *
 * @param {'codex' | 'grok-build'} provider
 * @param {{ fetchImpl?: Function, force?: boolean, oauthAccountId?: string }} [options]
 * @returns {Promise<{ token: string, accountId: string }>}
 */
async function acquire(provider, options = {}) {
  const oauthAccountId = typeof options.oauthAccountId === 'string' ? options.oauthAccountId : ''
  if (oauthAccountId) return require('./oauth').tokenFor(oauthAccountId, options)

  const cached = cache.get(provider)
  if (!options.force && cached && cached.expiresAt - Date.now() > STALE_MS) {
    return { token: cached.token, accountId: cached.accountId }
  }

  const pending = inflight.get(provider)
  if (pending) return pending
  const run = refresh(provider, options).finally(() => inflight.delete(provider))
  inflight.set(provider, run)
  return run
}

/**
 * @param {string} provider
 * @param {{ fetchImpl?: Function, force?: boolean }} options
 */
async function refresh(provider, options) {
  const file = provider === 'codex' ? readCodexFile() : readGrokFile()
  if (!file) {
    throw credentialError(
      'NO_CREDENTIAL',
      provider === 'codex'
        ? '找不到 Codex 登入資訊，請先在終端機跑一次 codex 登入'
        : '找不到 Grok 登入資訊，請先在終端機跑一次 grok 登入'
    )
  }

  // 檔案裡那顆還夠新就直接用（CLI 剛跑過的話多半是新的）
  if (!options.force && file.expiresAt - Date.now() > STALE_MS) {
    cache.set(provider, { token: file.accessToken, expiresAt: file.expiresAt, accountId: file.accountId })
    return { token: file.accessToken, accountId: file.accountId }
  }

  if (!file.refreshToken) {
    throw credentialError(
      'TOKEN_EXPIRED',
      provider === 'codex'
        ? 'Codex 登入已過期，請在終端機重跑一次 codex'
        : 'Grok 登入已過期，請在終端機重跑一次 grok'
    )
  }

  const fresh = provider === 'codex'
    ? await exchange(CODEX_TOKEN_URL, {
      grant_type: 'refresh_token',
      refresh_token: file.refreshToken,
      client_id: CODEX_CLIENT_ID
    }, options)
    : await exchange(XAI_TOKEN_URL, {
      grant_type: 'refresh_token',
      refresh_token: file.refreshToken,
      client_id: file.clientId
    }, options)

  cache.set(provider, {
    token: fresh.accessToken,
    expiresAt: fresh.expiresAt,
    accountId: file.accountId
  })
  return { token: fresh.accessToken, accountId: file.accountId }
}

/**
 * 上游回 401 之後叫這個：清掉記憶體裡那顆，下一次強制重換。
 * @param {string} provider
 */
function invalidate(provider) {
  cache.delete(provider)
}

/**
 * 給 UI 顯示「這一家的憑證在不在」。**不回傳 token 本身**。
 * @returns {{ codex: boolean, grok: boolean }}
 */
function detect() {
  return {
    codex: Boolean(readCodexFile()),
    grok: Boolean(readGrokFile())
  }
}

module.exports = {
  STALE_MS,
  CODEX_CLIENT_ID,
  CODEX_TOKEN_URL,
  XAI_TOKEN_URL,
  configure,
  jwtClaims,
  codexAuthPath,
  grokAuthPath,
  readCodexFile,
  readGrokFile,
  acquire,
  invalidate,
  detect
}
