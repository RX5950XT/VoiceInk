'use strict'

/**
 * Codex／Grok 的 OAuth 登入（Main Process）。
 *
 * 跟 `credential.js` 的差別：那邊是**沿用已安裝 CLI 的登入**（只讀不寫），這邊是
 * **我們自己把使用者登進來**，token 存在自己的 store。兩條路並存——沒有自己的帳號時
 * 照樣退回讀 CLI 的檔案，所以只裝 CLI 不登入這裡也能用。
 *
 * 兩家都走**各自官方支援的流程**，不是逆向出來的：
 * - **Codex**：PKCE ＋ 本機 loopback（`http://localhost:1455/auth/callback`），
 *   跟官方 `codex login` 一模一樣（client id／redirect／scope 都從官方 CLI 執行檔實測取得）。
 *   OpenAI 的 OIDC discovery **沒有** device code grant，所以不做 device code。
 * - **Grok**：device code。xAI 的 discovery 明列 `urn:ietf:params:oauth:grant-type:device_code`
 *   與 `https://auth.x.ai/oauth2/device/code`，是他們官方支援的流程。
 *
 * client id 都是各家**公開的桌面 client**（沒有 secret）。CLAUDE.md 禁的是 client secret。
 */

const http = require('http')
const { createHash, randomBytes, randomUUID } = require('crypto')

/** 登入等多久就放棄（device code 自己會給 expires_in，這是上限） */
const MAX_WAIT_MS = 10 * 60 * 1000
/** 單次 HTTP 逾時 */
const HTTP_TIMEOUT_MS = 20000
/** access token 剩不到這麼久就先換一顆 */
const STALE_MS = 5 * 60 * 1000
/** 最多存幾組帳號 */
const MAX_ACCOUNTS = 10

/**
 * 兩家的固定表。**renderer 只送 provider key**，網址與 client id 一律由這裡決定。
 * @type {Readonly<Record<string, object>>}
 */
const FLOWS = Object.freeze({
  codex: Object.freeze({
    key: 'codex',
    label: 'ChatGPT（Codex）',
    kind: 'pkce',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    authorizeUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    // 這個 redirect 是官方 client 註冊好的，換一個埠對方會直接拒絕
    redirectUri: 'http://localhost:1455/auth/callback',
    port: 1455,
    callbackPath: '/auth/callback',
    scope: 'openid profile email offline_access api.connectors.read api.connectors.invoke',
    extraAuthParams: Object.freeze({
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true'
    })
  }),
  'grok-build': Object.freeze({
    key: 'grok-build',
    label: 'Grok Build（xAI）',
    kind: 'device',
    clientId: 'b1a00492-073a-47ea-816f-4c329264a828',
    deviceUrl: 'https://auth.x.ai/oauth2/device/code',
    tokenUrl: 'https://auth.x.ai/oauth2/token',
    scope: 'openid profile email offline_access'
  })
})

/** @type {{ getStore: (() => Promise<object>) | null, openExternal: ((url: string) => unknown) | null }} */
const deps = { getStore: null, openExternal: null }

/** 每個 provider 同時只能有一個登入流程在跑 */
/** @type {Map<string, object>} */
const sessions = new Map()
/** 換 token 的合併（同一個帳號同時只換一次） */
/** @type {Map<string, Promise<object>>} */
const inflight = new Map()

/**
 * @param {{ getStore?: () => Promise<object>, openExternal?: (url: string) => unknown }} options
 */
function configure(options = {}) {
  if (typeof options.getStore === 'function') deps.getStore = options.getStore
  if (typeof options.openExternal === 'function') deps.openExternal = options.openExternal
}

/**
 * @param {string} code
 * @param {string} message
 * @returns {Error}
 */
function authError(code, message) {
  const error = new Error(code)
  error.code = code
  error.userMessage = message
  return error
}

/**
 * @param {unknown} key
 * @returns {object | null}
 */
function getFlow(key) {
  return (typeof key === 'string' && Object.hasOwn(FLOWS, key) && FLOWS[key]) || null
}

/**
 * 讀 JWT payload。**不驗簽**：我們只想拿 email 與到期時間，簽章由發證方在後續請求驗。
 * @param {string} token
 * @returns {Record<string, any>}
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

// ===== 帳號存放 =====

/**
 * 帳號存在 `cc-providers.json` 的 `oauthAccounts`（跟 MCP 停用清單借同一個實例）。
 * **不進 `STORE_ALLOWLIST`**：裡面是 refresh token，只能走列舉過的 `ccswitch:*` IPC。
 * @returns {Promise<Array<object>>}
 */
async function readAccounts() {
  if (!deps.getStore) return []
  const store = await deps.getStore()
  const raw = store.get('oauthAccounts', [])
  if (!Array.isArray(raw)) return []
  const out = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const id = typeof item.id === 'string' ? item.id : ''
    if (!id || !getFlow(item.provider) || !item.refreshToken) continue
    out.push({
      id,
      provider: item.provider,
      label: typeof item.label === 'string' ? item.label : '',
      accountId: typeof item.accountId === 'string' ? item.accountId : '',
      accessToken: typeof item.accessToken === 'string' ? item.accessToken : '',
      refreshToken: String(item.refreshToken),
      expiresAt: Number.isFinite(item.expiresAt) ? item.expiresAt : 0,
      createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now()
    })
    if (out.length >= MAX_ACCOUNTS) break
  }
  return out
}

/**
 * @param {Array<object>} items
 */
async function writeAccounts(items) {
  if (!deps.getStore) return
  const store = await deps.getStore()
  store.set('oauthAccounts', items.slice(0, MAX_ACCOUNTS))
}

/**
 * 給 UI 的清單：**不含任何 token**，只有「是誰、什麼時候過期」。
 * @returns {Promise<Array<{ id: string, provider: string, label: string, expiresAt: number, expired: boolean }>>}
 */
async function list() {
  const items = await readAccounts()
  return items.map((item) => ({
    id: item.id,
    provider: item.provider,
    label: item.label || item.accountId || item.id,
    expiresAt: item.expiresAt,
    // refresh token 還在就救得回來，所以「過期」只是提示，不是壞掉
    expired: item.expiresAt > 0 && item.expiresAt <= Date.now()
  }))
}

/**
 * @param {unknown} id
 * @returns {Promise<boolean>}
 */
async function remove(id) {
  const items = await readAccounts()
  await writeAccounts(items.filter((item) => item.id !== id))
  return true
}

// ===== HTTP 小工具 =====

/**
 * POST form。失敗時**不帶上游回應內容**，只留狀態碼——那是外部字串，
 * 可能夾著我們送出去的東西（跟 `credential.exchange` 同一條規矩）。
 * @param {string} url
 * @param {Record<string, string>} form
 * @param {{ fetchImpl?: Function, allowPending?: boolean }} [options]
 * @returns {Promise<{ ok: boolean, status: number, data: Record<string, any> }>}
 */
async function postForm(url, form, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)
  let response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      signal: controller.signal
    })
  } catch {
    throw authError('OAUTH_NETWORK', '連不上登入伺服器，請檢查網路後再試')
  } finally {
    clearTimeout(timer)
  }
  let data = {}
  try {
    data = await response.json()
  } catch {
    data = {}
  }
  return { ok: Boolean(response?.ok), status: Number(response?.status) || 0, data }
}

/**
 * token 回應 → 帳號記錄。
 * @param {object} flow
 * @param {Record<string, any>} payload
 * @returns {object}
 */
function toAccount(flow, payload) {
  const accessToken = typeof payload.access_token === 'string' ? payload.access_token : ''
  const refreshToken = typeof payload.refresh_token === 'string' ? payload.refresh_token : ''
  if (!accessToken || !refreshToken) {
    throw authError('OAUTH_INCOMPLETE', '登入伺服器沒有給完整的憑證，請再試一次')
  }
  const idClaims = jwtClaims(payload.id_token)
  const accessClaims = jwtClaims(accessToken)
  const expiresIn = Number(payload.expires_in)
  const expiresAt = Number(accessClaims.exp)
    ? Number(accessClaims.exp) * 1000
    : Date.now() + (Number.isFinite(expiresIn) ? expiresIn * 1000 : 3600_000)
  // Codex 的 chatgpt_account_id 在自訂 claim 裡；xAI 用標準的 sub
  const openaiAuth = idClaims['https://api.openai.com/auth'] || accessClaims['https://api.openai.com/auth'] || {}
  const accountId = typeof openaiAuth.chatgpt_account_id === 'string'
    ? openaiAuth.chatgpt_account_id
    : String(idClaims.sub || accessClaims.sub || '')
  return {
    id: randomUUID(),
    provider: flow.key,
    label: String(idClaims.email || idClaims.preferred_username || accountId || flow.label),
    accountId,
    accessToken,
    refreshToken,
    expiresAt,
    createdAt: Date.now()
  }
}

/**
 * 同一個人重登就換掉舊那筆，不要在清單裡疊兩個一樣的 email。
 * @param {object} account
 */
async function saveAccount(account) {
  const items = await readAccounts()
  const kept = items.filter((item) => !(
    item.provider === account.provider &&
    (item.accountId ? item.accountId === account.accountId : item.label === account.label)
  ))
  await writeAccounts([...kept, account])
  return account
}

// ===== PKCE（Codex） =====

/**
 * @returns {{ verifier: string, challenge: string }}
 */
function makePkce() {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/**
 * 開一個只活在登入期間的本機 callback server。
 *
 * **綁 127.0.0.1**（不是 0.0.0.0）：這條路上會收到 authorization code，
 * 對外開等於讓同網段的人有機會攔。埠被佔用多半是使用者正在跑 `codex login`，訊息要講清楚。
 *
 * @param {object} flow
 * @param {string} state
 * @returns {Promise<{ server: import('http').Server, code: Promise<string> }>}
 */
function startCallbackServer(flow, state) {
  return new Promise((resolve, reject) => {
    /** @type {(value: string) => void} */
    let settleCode = () => {}
    /** @type {(error: Error) => void} */
    let failCode = () => {}
    const code = new Promise((res, rej) => { settleCode = res; failCode = rej })

    const server = http.createServer((req, res) => {
      let url
      try {
        url = new URL(req.url || '/', `http://127.0.0.1:${flow.port}`)
      } catch {
        res.writeHead(400).end()
        return
      }
      if (url.pathname !== flow.callbackPath) {
        res.writeHead(404).end()
        return
      }
      const returnedState = url.searchParams.get('state') || ''
      const returnedCode = url.searchParams.get('code') || ''
      const html = (text) =>
        `<!doctype html><meta charset="utf-8"><title>VoiceInk</title>` +
        `<body style="font:16px/1.6 system-ui;padding:48px;text-align:center">${text}</body>`
      // state 對不上就當作不是我們發起的那一次，不可以拿去換 token
      if (!returnedCode || returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html('登入失敗，請回到 VoiceInk 再試一次。'))
        failCode(authError('OAUTH_STATE_MISMATCH', '登入回呼對不上，請再試一次'))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html('登入完成，可以關掉這個分頁回到 VoiceInk。'))
      settleCode(returnedCode)
    })

    server.on('error', (error) => {
      const busy = /** @type {NodeJS.ErrnoException} */ (error).code === 'EADDRINUSE'
      const wrapped = busy
        ? authError('OAUTH_PORT_BUSY', `本機 ${flow.port} 埠被佔用了（多半是正在跑 codex login），關掉再試一次`)
        : authError('OAUTH_SERVER_FAILED', '無法開啟本機登入回呼，請再試一次')
      failCode(wrapped)
      reject(wrapped)
    })

    server.listen(flow.port, '127.0.0.1', () => resolve({ server, code }))
  })
}

/**
 * @param {object} flow
 * @param {object} session
 * @param {{ fetchImpl?: Function }} options
 */
async function runPkce(flow, session, options) {
  const state = randomBytes(16).toString('base64url')
  const { verifier, challenge } = makePkce()
  const { server, code } = await startCallbackServer(flow, state)
  session.server = server

  const authorize = new URL(flow.authorizeUrl)
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: flow.clientId,
    redirect_uri: flow.redirectUri,
    scope: flow.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...flow.extraAuthParams
  }).toString()

  session.verificationUri = authorize.toString()
  session.status = 'waiting'
  deps.openExternal?.(session.verificationUri)

  const granted = await Promise.race([
    code,
    new Promise((_, reject) => {
      session.timer = setTimeout(
        () => reject(authError('OAUTH_TIMEOUT', '等太久了，請重新開始登入')),
        MAX_WAIT_MS
      )
    })
  ])

  const result = await postForm(flow.tokenUrl, {
    grant_type: 'authorization_code',
    client_id: flow.clientId,
    code: String(granted),
    redirect_uri: flow.redirectUri,
    code_verifier: verifier
  }, options)
  if (!result.ok) {
    throw authError('OAUTH_EXCHANGE_FAILED', `換取憑證失敗（HTTP ${result.status}），請再試一次`)
  }
  return toAccount(flow, result.data)
}

// ===== Device Code（Grok） =====

/**
 * @param {object} flow
 * @param {object} session
 * @param {{ fetchImpl?: Function }} options
 */
async function runDevice(flow, session, options) {
  const start = await postForm(flow.deviceUrl, {
    client_id: flow.clientId,
    scope: flow.scope
  }, options)
  if (!start.ok || !start.data.device_code) {
    throw authError('OAUTH_DEVICE_FAILED', `無法開始登入（HTTP ${start.status}），請稍後再試`)
  }

  const deviceCode = String(start.data.device_code)
  const intervalMs = Math.max(2, Number(start.data.interval) || 5) * 1000
  const expiresInMs = Math.min(MAX_WAIT_MS, (Number(start.data.expires_in) || 900) * 1000)
  const deadline = Date.now() + expiresInMs

  session.userCode = String(start.data.user_code || '')
  session.verificationUri = String(start.data.verification_uri_complete || start.data.verification_uri || '')
  session.expiresAt = deadline
  session.status = 'waiting'
  if (session.verificationUri) deps.openExternal?.(session.verificationUri)

  let wait = intervalMs
  while (Date.now() < deadline) {
    if (session.cancelled) throw authError('OAUTH_CANCELLED', '已取消登入')
    await new Promise((resolve) => { session.timer = setTimeout(resolve, wait) })
    if (session.cancelled) throw authError('OAUTH_CANCELLED', '已取消登入')

    const poll = await postForm(flow.tokenUrl, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: flow.clientId,
      device_code: deviceCode
    }, options)
    if (poll.ok) return toAccount(flow, poll.data)

    const reason = String(poll.data?.error || '')
    // 這兩個是「還沒好」，其餘一律當成失敗。slow_down 要真的把間隔拉長，
    // 不然對方會一路回 slow_down 直到逾時
    if (reason === 'authorization_pending') continue
    if (reason === 'slow_down') { wait += 5000; continue }
    if (reason === 'expired_token') throw authError('OAUTH_TIMEOUT', '驗證碼過期了，請重新開始登入')
    if (reason === 'access_denied') throw authError('OAUTH_DENIED', '登入被拒絕')
    throw authError('OAUTH_DEVICE_FAILED', `登入失敗（HTTP ${poll.status}），請再試一次`)
  }
  throw authError('OAUTH_TIMEOUT', '驗證碼過期了，請重新開始登入')
}

// ===== 對外流程 =====

/**
 * 開始登入。回傳「使用者現在該做什麼」，實際完成與否要輪詢 `status()`——
 * IPC 不適合掛一個等好幾分鐘的 promise。
 *
 * @param {unknown} providerKey
 * @param {{ fetchImpl?: Function }} [options]
 * @returns {Promise<{ kind: string, verificationUri: string, userCode: string, expiresAt: number }>}
 */
async function begin(providerKey, options = {}) {
  const flow = getFlow(providerKey)
  if (!flow) throw authError('UNKNOWN_PROVIDER', '這一家不支援登入')
  cancel(flow.key)

  const session = {
    provider: flow.key,
    kind: flow.kind,
    status: 'starting',
    userCode: '',
    verificationUri: '',
    expiresAt: 0,
    message: '',
    cancelled: false,
    server: null,
    timer: null
  }
  sessions.set(flow.key, session)

  const run = flow.kind === 'pkce' ? runPkce(flow, session, options) : runDevice(flow, session, options)
  run.then(
    async (account) => {
      await saveAccount(account)
      session.status = 'done'
      session.accountLabel = account.label
    },
    (error) => {
      session.status = session.cancelled ? 'idle' : 'error'
      session.message = error?.userMessage || '登入失敗，請再試一次'
    }
  ).finally(() => closeSession(session))

  // 等流程把「該給使用者看的東西」填好；PKCE 是網址、device 是驗證碼
  const readyAt = Date.now() + HTTP_TIMEOUT_MS
  while (session.status === 'starting' && Date.now() < readyAt) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (session.status === 'error') throw authError('OAUTH_FAILED', session.message)
  return {
    kind: flow.kind,
    verificationUri: session.verificationUri,
    userCode: session.userCode,
    expiresAt: session.expiresAt
  }
}

/**
 * @param {object} session
 */
function closeSession(session) {
  if (session.timer) clearTimeout(session.timer)
  session.timer = null
  try {
    session.server?.close()
  } catch {
    // 已經關了
  }
  session.server = null
}

/**
 * @param {unknown} providerKey
 * @returns {{ status: string, kind: string, userCode: string, verificationUri: string, expiresAt: number, message: string, accountLabel: string }}
 */
function status(providerKey) {
  const session = typeof providerKey === 'string' ? sessions.get(providerKey) : null
  if (!session) return { status: 'idle', kind: '', userCode: '', verificationUri: '', expiresAt: 0, message: '', accountLabel: '' }
  return {
    status: session.status,
    kind: session.kind,
    userCode: session.userCode,
    verificationUri: session.verificationUri,
    expiresAt: session.expiresAt,
    message: session.message,
    accountLabel: session.accountLabel || ''
  }
}

/**
 * @param {unknown} providerKey
 * @returns {boolean}
 */
function cancel(providerKey) {
  const session = typeof providerKey === 'string' ? sessions.get(providerKey) : null
  if (!session) return true
  session.cancelled = true
  session.status = 'idle'
  closeSession(session)
  sessions.delete(session.provider)
  return true
}

/**
 * 取一顆可用的 access token。過期就用 refresh token 換一顆，**並寫回自己的 store**——
 * 這份是我們自己的帳號，不是 CLI 的，寫回去不會跟誰搶狀態。
 *
 * @param {string} accountId 我們自己的帳號 id（不是上游的）
 * @param {{ fetchImpl?: Function, force?: boolean }} [options]
 * @returns {Promise<{ token: string, accountId: string }>}
 */
function tokenFor(accountId, options = {}) {
  const pending = inflight.get(accountId)
  if (pending && !options.force) return pending
  const run = resolveToken(accountId, options).finally(() => inflight.delete(accountId))
  inflight.set(accountId, run)
  return run
}

/**
 * @param {string} id
 * @param {{ fetchImpl?: Function, force?: boolean }} options
 */
async function resolveToken(id, options) {
  const items = await readAccounts()
  const account = items.find((item) => item.id === id)
  if (!account) throw authError('NO_ACCOUNT', '找不到這個登入帳號，請重新登入')
  const flow = getFlow(account.provider)
  if (!flow) throw authError('UNKNOWN_PROVIDER', '這一家不支援登入')

  if (!options.force && account.accessToken && account.expiresAt - Date.now() > STALE_MS) {
    return { token: account.accessToken, accountId: account.accountId }
  }

  const result = await postForm(flow.tokenUrl, {
    grant_type: 'refresh_token',
    client_id: flow.clientId,
    refresh_token: account.refreshToken
  }, options)
  if (!result.ok) {
    throw authError('OAUTH_REFRESH_FAILED', `登入已失效（HTTP ${result.status}），請重新登入`)
  }
  const accessToken = typeof result.data.access_token === 'string' ? result.data.access_token : ''
  if (!accessToken) throw authError('OAUTH_REFRESH_FAILED', '續期沒有拿到新的憑證，請重新登入')
  const claims = jwtClaims(accessToken)
  const expiresIn = Number(result.data.expires_in)
  const next = {
    ...account,
    accessToken,
    // 有些發證方每次 refresh 都給新的 refresh token（rotation），有給就要換掉
    refreshToken: typeof result.data.refresh_token === 'string' ? result.data.refresh_token : account.refreshToken,
    expiresAt: Number(claims.exp)
      ? Number(claims.exp) * 1000
      : Date.now() + (Number.isFinite(expiresIn) ? expiresIn * 1000 : 3600_000)
  }
  await writeAccounts(items.map((item) => (item.id === id ? next : item)))
  return { token: accessToken, accountId: account.accountId }
}

module.exports = {
  FLOWS,
  MAX_ACCOUNTS,
  STALE_MS,
  configure,
  getFlow,
  jwtClaims,
  toAccount,
  makePkce,
  list,
  remove,
  begin,
  status,
  cancel,
  tokenFor,
  readAccounts,
  writeAccounts
}
